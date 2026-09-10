/**
 * Transport binding for the A/V sync spike: a star around the screen, over
 * this app's own signalling relay and nothing else.
 *
 *  - SCREEN broadcasts a `beat` (video position + screen wall-clock) ~4×/sec
 *    to every follower, and answers a clock request with its `Date.now()` so
 *    followers can estimate the offset.
 *  - FOLLOWER stores the latest beat and periodically samples the clock offset
 *    (Cristian's algorithm, keeping the lowest-RTT sample). The actual audio
 *    correction lives in the media layer, driven from this controller's state.
 *
 * Peers meet through {@link connectSignalSocket}: the relay knows who is in a
 * room and says so, which is why there is no discovery code here — nothing
 * announces, nothing waits out an interval, and no state machine decides
 * whether this device is allowed to be heard yet. A follower is told about the
 * screen when it joins, the screen is told about the follower, and the screen
 * dials.
 *
 * The negotiation and the two data channels are {@link createPeerLink}. What
 * is left here is the star's bookkeeping and the sync state the media layer
 * reads.
 */
import { monitorPeerConnection } from '../diagnostics/peer-monitor'
import { recordDiagnostic } from '../diagnostics/session-log'
import {
  estimateOffset,
  bestOffset,
  type Beat,
  type ClockSample,
} from '../sync/sync-math'
import { describeIceConfig, getRtcConfig } from './ice-config'
import { createPeerLink, type PeerLink } from './peer-link'
import { connectSignalSocket, type SignalSocket } from './signal-socket'

/** Which end of the star topology this device is. */
export type Role = 'screen' | 'follower'

const BEAT_MS = 250 // screen broadcasts 4×/sec
const CLOCK_INTERVAL_MS = 3000 // follower re-samples clock offset every 3s
const CLOCK_TIMEOUT_MS = 2000
const CLOCK_WINDOW = 8 // rolling clock-sample window
const FIRST_CLOCK_SAMPLE_MS = 800 // first sample, once beats should have landed
const SCREEN_STALE_MS = 3000 // no beat for this long → screen considered offline
const RESYNC_GAP_MS = 4000 // beat gap longer than this ⇒ treat as reconnect / wake
const SIGNALLING_CHECK_MS = 2000 // how often signalling health is re-read

/** Everything the UI and the media layer need to know about the session. */
export interface SyncState {
  /** Which end of the star topology this device is. */
  role: Role
  /** Room code peers meet in. */
  roomCode: string
  /**
   * This device's peer id, assigned by the relay. Changes if the signalling
   * socket reconnects — a fresh socket is a fresh peer.
   */
  selfId: string
  /** Peer id of the screen, or `null` before the relay names one. */
  screenId: string | null
  /** Add to a follower `Date.now()` to get the screen's clock, in ms. */
  offsetMs: number
  /** Round-trip time of the clock sample currently in use, in ms. */
  rttMs: number
  /** Most recent beat received from the screen. */
  latestBeat: Beat | null
  /** Follower-clock ms at which the last beat arrived (0 = none yet). */
  lastBeatAt: number
  /** How many other peers are connected. */
  peerCount: number
  /** Whether beats are still arriving from the screen. */
  screenOnline: boolean
  /** Follower: true once a fresh clock offset sample is available. */
  clockReady: boolean
  /** Bumps on reconnect / resume — followers should resync their audio. */
  syncEpoch: number
  /**
   * Whether the signalling socket is joined, i.e. whether peers can still find
   * this room. Existing peer connections are unaffected when this goes false,
   * which is exactly why it is worth showing: a screen with no signalling
   * keeps playing to the listeners it has and silently accepts no new ones.
   */
  signallingOnline: boolean
}

/** Notified after every state change; read the new state via `getState()`. */
type Listener = () => void

/** Supplies the screen's live playback position for the next beat. */
type BeatSource = () => {
  /**
   * Id of the media the screen is playing, echoed on every beat. Opaque here —
   * resolving it to a soundtrack is the follower's business, not the
   * transport's.
   */
  mediaId: string
  /** The screen's `video.currentTime`, in seconds. */
  videoTime: number
  /** Whether the video is playing rather than paused. */
  playing: boolean
  /** The video's duration (loop length), in seconds. */
  duration: number
}

/** A joined session: a snapshot store plus the room's lifecycle. */
export interface SyncController {
  /** Which end of the star topology this device is. */
  readonly role: Role
  /** Room code peers meet in. */
  readonly roomCode: string
  /** This device's relay-assigned peer id, as of the current socket. */
  readonly selfId: string
  /** Current session state. */
  getState(): SyncState
  /** Subscribe to state changes; call the returned function to unsubscribe. */
  subscribe(listener: Listener): () => void
  /** Screen only: supply the playback position broadcast on each beat. */
  setBeatSource(source: BeatSource): void
  /** Stop all timers and leave the room. */
  leave(): Promise<void>
}

/** Join `roomCode` as the leader, broadcasting beats for followers to lock to. */
export async function startScreen(roomCode: string): Promise<SyncController> {
  return create(roomCode, 'screen')
}

/** Join `roomCode` as a listener, tracking the screen's beats and clock. */
export async function joinAsFollower(
  roomCode: string,
): Promise<SyncController> {
  return create(roomCode, 'follower')
}

async function create(roomCode: string, role: Role): Promise<SyncController> {
  // Fetched per join, and therefore per *rejoin* too: a credential that expired
  // during a sleep would otherwise let the watchdog reconnect forever against
  // an ICE config that can no longer allocate a relay candidate.
  const rtcConfig = await getRtcConfig()

  recordDiagnostic('ice', `joining as ${role} — ${describeIceConfig()}`)

  let state: SyncState = {
    role,
    roomCode,
    selfId: '',
    screenId: null,
    offsetMs: 0,
    rttMs: 0,
    latestBeat: null,
    lastBeatAt: 0,
    peerCount: 0,
    screenOnline: role === 'screen',
    clockReady: role === 'screen',
    syncEpoch: 0,
    // True by definition: the room was only reached through a joined socket.
    signallingOnline: true,
  }

  const listeners = new Set<Listener>()
  const notify = () => listeners.forEach(listener => listener())

  const set = (patch: Partial<SyncState>) => {
    state = { ...state, ...patch }
    notify()
  }

  /** Links by peer id, with the diagnostics monitor detached alongside each. */
  const links = new Map<string, PeerLink>()
  const monitors = new Map<string, () => void>()

  const timers: number[] = []
  let clockSamples: ClockSample[] = []
  let beatSource: BeatSource | null = null
  let socket: SignalSocket | null = null

  const refreshPeers = () => set({ peerCount: links.size })

  const dropLink = (peerId: string) => {
    links.get(peerId)?.close()
    links.delete(peerId)
    monitors.get(peerId)?.()
    monitors.delete(peerId)
  }

  /** Follower: take a clock sample from the screen, keeping the best RTT. */
  const sampleClock = async () => {
    const screenId = state.screenId
    const link = screenId === null ? null : links.get(screenId)

    if (!link?.open()) {
      return
    }

    const requestedAt = Date.now()

    try {
      const screenTime = await link.requestClock(CLOCK_TIMEOUT_MS)
      const respondedAt = Date.now()

      clockSamples = [
        ...clockSamples,
        estimateOffset(requestedAt, screenTime, respondedAt),
      ].slice(-CLOCK_WINDOW)

      const best = bestOffset(clockSamples)!

      set({ offsetMs: best.offset, rttMs: best.rtt, clockReady: true })
    } catch {
      /* timed out — retry next tick */
    }
  }

  /** Follower: a beat landed. */
  const acceptBeat = (peerId: string, beat: unknown) => {
    const now = Date.now()
    const gap = state.lastBeatAt ? now - state.lastBeatAt : 0
    const needsResync = !state.screenOnline || gap > RESYNC_GAP_MS

    if (needsResync) {
      recordDiagnostic(
        'beat',
        `beats resumed after ${(gap / 1000).toFixed(1)}s — resyncing`,
      )

      clockSamples = []
      set({ offsetMs: 0, rttMs: 0, clockReady: false })
      sampleClock()
    }

    set({
      latestBeat: beat as Beat,
      lastBeatAt: now,
      screenId: peerId,
      screenOnline: true,
      ...(needsResync ? { syncEpoch: state.syncEpoch + 1 } : {}),
    })
  }

  /** Note that a peer has gone, however we found out. */
  const notePeerGone = (peerId: string) => {
    if (!links.has(peerId)) {
      return
    }

    recordDiagnostic('peer', `LEAVE ${peerId.slice(0, 6)}`, {
      tag: 'peer-leave',
    })
    dropLink(peerId)

    if (peerId === state.screenId && role === 'follower') {
      set({ screenOnline: false })
    }

    refreshPeers()
  }

  /**
   * Build the link to `peerId`. A screen's link offers as soon as it exists; a
   * follower's waits to be offered to, which is what keeps the star a star.
   */
  const addLink = (peerId: string) => {
    if (links.has(peerId)) {
      return
    }

    const link = createPeerLink({
      role,
      peerId,
      rtcConfig,
      sendSignal: data => socket?.signal(peerId, data),
      onBeat: beat => acceptBeat(peerId, beat),
      answerClock: () => Date.now(),
      onOpen: () => {
        recordDiagnostic('peer', `join ${peerId.slice(0, 6)}`)
        refreshPeers()
      },
      onClosed: () => notePeerGone(peerId),
    })

    links.set(peerId, link)
    monitors.set(peerId, monitorPeerConnection(peerId, link.connection))

    // The follower learns which peer is the screen from the relay rather than
    // from the first beat, so the clock sampler has a target before any beat
    // has arrived.
    if (role === 'follower') {
      set({ screenId: peerId })
    }
  }

  socket = await connectSignalSocket({
    room: roomCode,
    role,

    onJoined(self, peers) {
      // A reconnect mints a new identity, so every link keyed to the old one
      // is stale. Dropping them here rather than trying to carry them across
      // is what keeps our idea of the room and the relay's in agreement — see
      // the note in `signal-socket.ts`.
      for (const peerId of [...links.keys()]) {
        dropLink(peerId)
      }

      set({ selfId: self, peerCount: 0 })

      for (const peer of peers) {
        addLink(peer.id)
      }
    },

    onPeer(peer, present) {
      if (present) {
        addLink(peer.id)

        return
      }

      notePeerGone(peer.id)
    },

    onSignal(from, data) {
      // A signal from a peer we have not been told about cannot be answered:
      // with no link there is nowhere to put the description. The relay only
      // routes between peers it has introduced, so this is a dead frame.
      links.get(from)?.accept(data)
    },
  })

  set({ selfId: socket.self() ?? '' })

  if (role === 'screen') {
    timers.push(
      setInterval(() => {
        if (!beatSource) {
          return
        }

        const position = beatSource()
        const beat: Beat = {
          mediaId: position.mediaId,
          videoTime: position.videoTime,
          wall: Date.now(),
          playing: position.playing,
          duration: position.duration,
        }

        for (const link of links.values()) {
          link.sendBeat(beat)
        }
      }, BEAT_MS) as unknown as number,
    )
  } else {
    timers.push(
      setInterval(() => {
        sampleClock()

        const beatAge = Date.now() - state.lastBeatAt

        if (
          state.lastBeatAt &&
          beatAge > SCREEN_STALE_MS &&
          state.screenOnline
        ) {
          recordDiagnostic(
            'beat',
            `no beat for ${(beatAge / 1000).toFixed(1)}s — screen offline`,
          )
          clockSamples = []
          set({
            screenOnline: false,
            clockReady: false,
            offsetMs: 0,
            rttMs: 0,
          })
        }
      }, CLOCK_INTERVAL_MS) as unknown as number,
    )

    // Kick an early clock sample shortly after the first beats should have
    // arrived, rather than waiting a full interval.
    timers.push(
      setTimeout(sampleClock, FIRST_CLOCK_SAMPLE_MS) as unknown as number,
    )
  }

  // Signalling health, polled rather than pushed: the socket reconnects
  // underneath us, so what matters is whether it is joined right now.
  timers.push(
    setInterval(() => {
      const online = socket?.online() ?? false

      if (online !== state.signallingOnline) {
        recordDiagnostic(
          'net',
          online
            ? 'signalling online'
            : 'signalling OFFLINE — no relay socket',
        )
        set({ signallingOnline: online })
      }
    }, SIGNALLING_CHECK_MS) as unknown as number,
  )

  return {
    role,
    roomCode,
    get selfId() {
      return state.selfId
    },
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)

      return () => {
        listeners.delete(listener)
      }
    },
    setBeatSource(source) {
      beatSource = source
    },
    async leave() {
      // `timers` mixes interval and timeout handles; clearing both is cheap
      // and avoids tracking which is which.
      for (const timer of timers) {
        clearInterval(timer)
        clearTimeout(timer)
      }

      for (const peerId of [...links.keys()]) {
        dropLink(peerId)
      }

      listeners.clear()
      socket?.close()
      socket = null
    },
  }
}
