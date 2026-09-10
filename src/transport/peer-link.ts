/**
 * One WebRTC connection to one peer: negotiation, and the two data channels
 * the sync session speaks over.
 *
 * **Negotiation is one-directional here, and that is the point.** In a strict
 * star the screen always offers and the follower always answers, so two
 * offers can never cross. That removes the whole of perfect negotiation —
 * politeness, rollback, `signalingState` bookkeeping — which is the subtle,
 * failure-prone half of WebRTC and the half that is only exercised in a mesh.
 * If a future topology ever needs both ends to offer, this is where that
 * decision has to be reopened; nothing else assumes it.
 *
 * **Two channels, because the traffic wants opposite guarantees.** Beats are a
 * clock signal at 4 Hz: a late one is worse than useless, since the corrector
 * has already steered past the moment it describes. So the beat channel is
 * unreliable and unordered — a lost beat is skipped rather than retransmitted
 * ahead of the next, and a congested link cannot head-of-line block the clock
 * behind a packet nobody wants any more. The clock RPC behind Cristian's
 * algorithm does want delivery, so it gets its own ordered channel.
 *
 * Candidates are trickled both ways and buffered until the remote description
 * lands, which is the one ordering hazard the star does not remove: the relay
 * delivers in order, but a candidate generated immediately after an offer can
 * still arrive before the answerer has finished applying it.
 */
import { recordDiagnostic } from '../diagnostics/session-log'
import type { PeerRole } from '../../shared/room-protocol'

/** Data-channel label carrying the screen's beats. */
const BEAT_CHANNEL = 'beat'

/** Data-channel label carrying the clock request and its answer. */
const RPC_CHANNEL = 'rpc'

/**
 * How long a link may sit half-built before it is given up on.
 *
 * A relay-only connection between two peers that can both reach Cloudflare
 * settles in about a second; the generous multiple of that is for a phone
 * whose radio is still waking. What it is really for is the link that never
 * settles at all — a dial to a peer whose signalling socket has already gone
 * without the relay noticing. Those used to sit for fifteen to thirty-five
 * seconds until ICE gave up, and every one of them was a listener on the
 * screen's peer count that was not in the room.
 */
const OPEN_TIMEOUT_MS = 12000

/**
 * What travels inside a relay `signal` frame's opaque `data`.
 *
 * Deliberately one of two shapes rather than a tagged union with a `t`: the
 * relay never reads it, and the two WebRTC primitives are already distinct.
 */
type PeerSignal =
  | { sdp: RTCSessionDescriptionInit; candidate?: undefined }
  | { candidate: RTCIceCandidateInit; sdp?: undefined }

/** A clock request, and the answer to one, as they cross the RPC channel. */
interface ClockFrame {
  /** Request id, echoed in the answer so replies can be matched. */
  i: number
  /** Present on an answer only: the responder's `Date.now()`. */
  r?: number
}

/** What the owner of a link is told about. */
export interface PeerLinkHandlers {
  /** A beat arrived from the screen. Follower only. */
  onBeat(beat: unknown): void
  /** Answer a clock request with this device's wall clock. Screen only. */
  answerClock(): number
  /** Both channels are open and the link is usable. */
  onOpen(): void
  /** The link is gone and will not come back; the owner should drop it. */
  onClosed(): void
}

/** What the caller passes to build one. */
export interface PeerLinkOptions extends PeerLinkHandlers {
  /** Which end of the star this device is. */
  role: PeerRole
  /** Relay-assigned id of the peer at the other end. */
  peerId: string
  /** ICE configuration, fetched fresh per connection. */
  rtcConfig: RTCConfiguration
  /** Send an opaque signalling payload to {@link peerId}. */
  sendSignal(data: unknown): void
}

/** A live WebRTC link to one peer. */
export interface PeerLink {
  /** Relay-assigned id of the peer at the other end. */
  readonly peerId: string
  /** The underlying connection, for the ICE diagnostics to monitor. */
  readonly connection: RTCPeerConnection
  /** Whether both channels are open. */
  open(): boolean
  /** Screen: send a beat. Dropped silently until the channel opens. */
  sendBeat(beat: unknown): void
  /** Follower: ask the screen for its clock, in ms since the epoch. */
  requestClock(timeoutMs: number): Promise<number>
  /** Feed a signalling payload that arrived from this peer. */
  accept(data: unknown): Promise<void>
  /** Tear the link down. Does not call {@link PeerLinkHandlers.onClosed}. */
  close(): void
}

/** Whether `data` is a signalling payload this link knows what to do with. */
function readSignal(data: unknown): PeerSignal | null {
  if (!data || typeof data !== 'object') {
    return null
  }

  const signal = data as PeerSignal

  if (signal.sdp && typeof signal.sdp === 'object') {
    return { sdp: signal.sdp }
  }

  if (signal.candidate && typeof signal.candidate === 'object') {
    return { candidate: signal.candidate }
  }

  return null
}

/**
 * Build a link to `peerId` and start negotiating it.
 *
 * The screen creates both channels and sends its offer immediately — before
 * any `negotiationneeded` event, which for a connection built this way would
 * only say what we already know. The follower waits, collects the channels off
 * `ondatachannel`, and answers.
 */
export function createPeerLink(options: PeerLinkOptions): PeerLink {
  const connection = new RTCPeerConnection(options.rtcConfig)
  const pending = new Map<
    number,
    { resolve: (now: number) => void; reject: (error: Error) => void }
  >()
  const earlyCandidates: RTCIceCandidateInit[] = []

  let beatChannel: RTCDataChannel | null = null
  let rpcChannel: RTCDataChannel | null = null
  let opened = false
  let closed = false
  let nextRequestId = 1
  let openTimer: ReturnType<typeof setTimeout> | undefined

  const isOpen = () =>
    beatChannel?.readyState === 'open' && rpcChannel?.readyState === 'open'

  /** Fire `onOpen` the first time both channels are up, and only then. */
  const checkOpen = () => {
    if (opened || closed || !isOpen()) {
      return
    }

    opened = true
    clearTimeout(openTimer)
    options.onOpen()
  }

  const fail = (error: Error) => {
    for (const waiter of pending.values()) {
      waiter.reject(error)
    }

    pending.clear()
  }

  const teardown = (notify: boolean) => {
    if (closed) {
      return
    }

    closed = true
    clearTimeout(openTimer)
    fail(new Error('peer link closed'))

    // Channels first: closing the connection alone leaves them in a state
    // where a send throws rather than being dropped.
    try {
      beatChannel?.close()
      rpcChannel?.close()
      connection.close()
    } catch {
      /* already torn down */
    }

    if (notify) {
      options.onClosed()
    }
  }

  const onRpcMessage = (event: MessageEvent) => {
    let frame: ClockFrame

    try {
      frame = JSON.parse(String(event.data)) as ClockFrame
    } catch {
      return
    }

    if (typeof frame?.i !== 'number') {
      return
    }

    // An answer to something we asked.
    if (typeof frame.r === 'number') {
      pending.get(frame.i)?.resolve(frame.r)
      pending.delete(frame.i)

      return
    }

    // A request to answer. Read at the last possible moment, so the reading
    // describes when the screen replied rather than when the frame arrived.
    if (rpcChannel?.readyState === 'open') {
      rpcChannel.send(JSON.stringify({ i: frame.i, r: options.answerClock() }))
    }
  }

  const wireChannel = (channel: RTCDataChannel) => {
    channel.addEventListener('open', checkOpen)
    // A channel closing is the link ending: neither side reopens one, and the
    // owner rebuilds the whole link rather than half of it.
    channel.addEventListener('close', () => teardown(true))

    if (channel.label === BEAT_CHANNEL) {
      beatChannel = channel
      channel.addEventListener('message', event => {
        try {
          options.onBeat(JSON.parse(String(event.data)))
        } catch {
          /* a malformed beat is skipped; the next one is 250ms away */
        }
      })

      return
    }

    rpcChannel = channel
    channel.addEventListener('message', onRpcMessage)
  }

  connection.addEventListener('icecandidate', event => {
    // The null candidate marks the end of gathering and carries nothing the
    // other end needs — trickling stops on its own.
    if (event.candidate) {
      options.sendSignal({ candidate: event.candidate.toJSON() })
    }
  })

  connection.addEventListener('connectionstatechange', () => {
    if (
      connection.connectionState === 'failed' ||
      connection.connectionState === 'closed'
    ) {
      teardown(true)
    }
  })

  /** Apply candidates that arrived before there was a description to hang them on. */
  const drainCandidates = async () => {
    while (earlyCandidates.length) {
      const candidate = earlyCandidates.shift()!

      await connection.addIceCandidate(candidate).catch(() => {
        /* a candidate the connection has moved past is not an error */
      })
    }
  }

  if (options.role === 'screen') {
    wireChannel(
      connection.createDataChannel(BEAT_CHANNEL, {
        ordered: false,
        maxRetransmits: 0,
      }),
    )
    wireChannel(connection.createDataChannel(RPC_CHANNEL, { ordered: true }))

    connection
      .createOffer()
      .then(async offer => {
        await connection.setLocalDescription(offer)
        options.sendSignal({ sdp: offer })
      })
      .catch(() => teardown(true))
  } else {
    connection.addEventListener('datachannel', event => {
      wireChannel(event.channel)
      checkOpen()
    })
  }

  // Armed last, so it covers the whole of negotiation rather than starting
  // part-way through it.
  openTimer = setTimeout(() => {
    if (opened || closed) {
      return
    }

    recordDiagnostic(
      'peer',
      `${options.peerId.slice(0, 6)} never opened in ` +
        `${(OPEN_TIMEOUT_MS / 1000).toFixed(0)}s — dropping`,
    )
    teardown(true)
  }, OPEN_TIMEOUT_MS)

  return {
    peerId: options.peerId,
    connection,
    open: isOpen,

    sendBeat(beat) {
      if (beatChannel?.readyState !== 'open') {
        return
      }

      try {
        beatChannel.send(JSON.stringify(beat))
      } catch {
        /* the channel went away mid-send; its close event handles it */
      }
    },

    requestClock(timeoutMs) {
      if (rpcChannel?.readyState !== 'open') {
        return Promise.reject(new Error('rpc channel is not open'))
      }

      const id = nextRequestId++

      return new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error('clock request timed out'))
        }, timeoutMs)

        pending.set(id, {
          resolve: now => {
            clearTimeout(timer)
            resolve(now)
          },
          reject: error => {
            clearTimeout(timer)
            reject(error)
          },
        })

        try {
          rpcChannel!.send(JSON.stringify({ i: id } satisfies ClockFrame))
        } catch (caught) {
          clearTimeout(timer)
          pending.delete(id)
          reject(caught instanceof Error ? caught : new Error(String(caught)))
        }
      })
    },

    async accept(data) {
      const signal = readSignal(data)

      if (!signal || closed) {
        return
      }

      if (signal.candidate) {
        // Before a remote description there is nothing to attach a candidate
        // to, and adding one throws rather than queueing.
        if (!connection.remoteDescription) {
          earlyCandidates.push(signal.candidate)

          return
        }

        await connection.addIceCandidate(signal.candidate).catch(() => {
          /* a candidate the connection has moved past is not an error */
        })

        return
      }

      await connection.setRemoteDescription(signal.sdp)
      await drainCandidates()

      // Only the follower answers; a screen reaching here has received the
      // answer it was waiting for and has nothing more to send.
      if (options.role === 'follower') {
        const answer = await connection.createAnswer()

        await connection.setLocalDescription(answer)
        options.sendSignal({ sdp: answer })
      }
    },

    close: () => teardown(false),
  }
}
