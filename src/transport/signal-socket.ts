/**
 * The client end of the room signalling protocol: one socket, one identity,
 * and a connection that outlives the socket carrying it.
 *
 * The reconnect behaviour — the backoff, the jitter, the slower ceiling while
 * hidden, the immediate retry on becoming visible — is carried over verbatim
 * from the adapter this replaced. All of it was paid for in the field, and
 * none of that reasoning changes with the protocol above it.
 *
 * What did change is what a reconnect means. The old strategy restored a
 * room's subscriptions and its retained announce onto the new socket, so the
 * room carried on as though nothing had happened. Here the relay assigns the
 * identity, so a fresh socket is a fresh peer: reconnecting re-joins, and the
 * relay hands back a new id.
 *
 * That is a deliberate trade. The screen sees the old id leave and a new one
 * arrive, and redials — roughly a second of missed beats, comfortably inside
 * the corrector's `beatFreshMs` window, so a listener hears nothing. What it
 * buys is the absence of resumption: no identity tokens, no grace period
 * before a departure is believed, no way for the relay's idea of the room to
 * disagree with the sockets it actually holds. Membership is exactly what is
 * connected, which is the property this whole protocol exists to have.
 */
import { recordDiagnostic } from '../diagnostics/session-log'
import type {
  ClientFrame,
  PeerPresence,
  PeerRole,
  ServerFrame,
} from '../../shared/room-protocol'
import { isPageVisible, onVisibilityChange } from '../core/visibility'
import { transportConfig } from './transport-config'

/** How long to wait for the socket and the join before giving up. */
const CONNECT_TIMEOUT_MS = 8000

/** Delay before the first reconnect attempt; doubles from here. */
const RECONNECT_BASE_MS = 500

/** Ceiling on the reconnect backoff while the page is visible. */
const RECONNECT_MAX_MS = 15000

/**
 * Ceiling while the page is hidden, matching the slower cadence the transport
 * watchdog uses there. A backgrounded Android phone has taken its Wi-Fi down
 * (see FEASIBILITY, "Screen-off kills the radio"), so retrying briskly only
 * spends battery against a radio that is not listening. Becoming visible
 * retries immediately, so the slower ceiling costs nothing on wake.
 */
const RECONNECT_MAX_HIDDEN_MS = 45000

/**
 * Fraction of the backoff to scatter attempts across. A Worker redeploy drops
 * every socket in the venue at once, and without this they would all come back
 * on the same schedule and arrive together.
 */
const RECONNECT_JITTER = 0.3

/** What the owner of a signalling socket is told about. */
export interface SignalSocketHandlers {
  /**
   * A join succeeded and this connection has an identity.
   *
   * Called again after every reconnect, with a *different* `self` — the owner
   * should treat it as "everything you knew is stale, here is the room again"
   * and drop any peer connections keyed to the previous identity.
   */
  onJoined(self: string, peers: PeerPresence[]): void
  /** A visible peer arrived or left. */
  onPeer(peer: PeerPresence, present: boolean): void
  /** A signalling payload arrived from `from`. */
  onSignal(from: string, data: unknown): void
}

/** What the caller passes to open one. */
export interface SignalSocketOptions extends SignalSocketHandlers {
  /** Room code to join. */
  room: string
  /** Which end of the star this client is. */
  role: PeerRole
}

/** A joined signalling connection that reconnects underneath its owner. */
export interface SignalSocket {
  /** Id the relay last assigned, or `null` while between sockets. */
  self(): string | null
  /** Whether a socket is open and joined right now. */
  online(): boolean
  /** Send an opaque signalling payload to one peer. Dropped when offline. */
  signal(to: string, data: unknown): void
  /** Close for good; stops reconnecting. */
  close(): void
}

/** Signalling frames sent and received since the last {@link takeSignalTraffic}. */
export interface SignalTraffic {
  /** Presence frames received: joins, arrivals and departures. */
  presenceIn: number
  /** Signalling payloads received. */
  signalsIn: number
  /** Signalling payloads sent. */
  signalsOut: number
  /** Joins sent, including those replayed after a reconnect. */
  joins: number
  /** Sockets that dropped and had to be reopened. */
  drops: number
}

function emptyTraffic(): SignalTraffic {
  return { presenceIn: 0, signalsIn: 0, signalsOut: 0, joins: 0, drops: 0 }
}

let traffic: SignalTraffic = emptyTraffic()

/**
 * The signalling traffic since the last call, and reset the counters.
 *
 * Read where relay health is already reported, so a follower that never peers
 * can be told apart from one whose signalling never arrived — the distinction
 * the socket's `readyState` alone could never make.
 */
export function takeSignalTraffic(): SignalTraffic {
  const seen = traffic

  traffic = emptyTraffic()

  return seen
}

/**
 * Every signalling connection this page has open, which should never be more
 * than one.
 *
 * That invariant is enforced rather than assumed: {@link connectSignalSocket}
 * releases whatever is still here before it opens anything. A page runs one
 * session, a session holds one transport, and a transport holds one socket —
 * so a second live connection is always a leak, never a legitimate state.
 *
 * It is worth enforcing because the failure is silent and expensive. A socket
 * that outlives its owner keeps reconnecting, and every reconnect re-joins the
 * room; the relay assigns a fresh peer id each time, and the screen dutifully
 * dials every one of them. One orphan is one phantom listener on the screen's
 * peer count, holding a relayed connection that carries nothing, and it lasts
 * as long as the tab is open. Rather than chase each way an owner can drop its
 * socket, nothing is allowed to keep one it no longer owns.
 */
const liveSockets = new Set<SocketHandle>()

/** A live connection, as the registry holds it. */
interface SocketHandle {
  /** Sequence number, so the log can name which connection did what. */
  seq: number
  /** The socket in use right now, or `null` while between sockets. */
  read(): WebSocket | null
  /** Release it for good. Idempotent. */
  release(): void
}

/** Counts connections opened this page load, for {@link SocketHandle.seq}. */
let socketSeq = 0

/**
 * The open signalling sockets, keyed by url. Keys are suffixed when more than
 * one is live — a rejoin opens a fresh socket before the old has finished
 * closing.
 */
export function getSignalSockets(): Record<string, WebSocket> {
  const url = roomUrl()
  const sockets: Record<string, WebSocket> = {}

  let index = 0

  for (const handle of liveSockets) {
    const socket = handle.read()

    // No socket means a reconnect is in flight. Reporting nothing for it is
    // the honest answer: signalling is down for this connection right now.
    if (!socket || socket.readyState === WebSocket.CLOSED) {
      continue
    }

    sockets[index === 0 ? url : `${url}#${index}`] = socket
    index += 1
  }

  return sockets
}

/**
 * WebSocket URL for the room relay, derived from wherever the app is served.
 * In production the Worker serves both, so this is same-origin; in development
 * Vite proxies it. Either way there is no host to configure.
 */
function roomUrl(): string {
  const url = new URL(transportConfig().roomPath, window.location.href)

  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'

  return url.toString()
}

function openSocket(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(roomUrl())
    const timer = setTimeout(() => {
      socket.close()
      reject(
        new Error(`signalling relay did not open in ${CONNECT_TIMEOUT_MS}ms`),
      )
    }, CONNECT_TIMEOUT_MS)

    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timer)
        resolve(socket)
      },
      { once: true },
    )

    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timer)
        reject(new Error('signalling relay connection failed'))
      },
      { once: true },
    )
  })
}

/** Narrow an incoming frame, which is untrusted however friendly the relay. */
function readFrame(raw: unknown): ServerFrame | null {
  if (typeof raw !== 'string') {
    return null
  }

  try {
    const parsed: unknown = JSON.parse(raw)

    if (!parsed || typeof parsed !== 'object') {
      return null
    }

    const frame = parsed as ServerFrame

    return frame.t === 'joined' ||
      frame.t === 'peer' ||
      frame.t === 'signal' ||
      frame.t === 'error'
      ? frame
      : null
  } catch {
    return null
  }
}

/**
 * Open a signalling connection and join `room`.
 *
 * Resolves once the relay has admitted this client and named it, so a caller
 * that awaits this knows the room exists and who it is in it. Rejects if the
 * socket will not open, the join is refused, or neither happens in time —
 * a refusal (a second screen, say) carries the relay's reason.
 */
export async function connectSignalSocket(
  options: SignalSocketOptions,
): Promise<SignalSocket> {
  let socket: WebSocket | null = null
  let self: string | null = null
  let released = false
  let attempts = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined

  const seq = ++socketSeq
  const handle: SocketHandle = {
    seq,
    read: () => socket,
    release: () => release(),
  }

  /** Prefix every line with the connection it came from. */
  const label = (message: string) => `[sig ${seq}] ${message}`

  const send = (frame: ClientFrame): void => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(frame))
    }
  }

  /**
   * Join on the socket that is open now. Every connection begins with this,
   * and so does every reconnect — there is nothing else to restore.
   */
  const sendJoin = (): void => {
    traffic.joins += 1
    send({ t: 'join', room: options.room, role: options.role })
  }

  const onMessage = (event: MessageEvent): void => {
    const frame = readFrame(event.data)

    if (!frame) {
      return
    }

    switch (frame.t) {
      case 'joined':
        traffic.presenceIn += 1
        self = frame.self
        options.onJoined(frame.self, frame.peers)

        return

      case 'peer':
        traffic.presenceIn += 1
        options.onPeer({ id: frame.id, role: frame.role }, frame.present)

        return

      case 'signal':
        traffic.signalsIn += 1
        options.onSignal(frame.from, frame.data)

        return

      case 'error':
        // A refusal is about this client's claim on the room, not about the
        // socket, so reconnecting would only be refused again.
        recordDiagnostic('net', label(`join refused — ${frame.reason}`))
        release()
    }
  }

  const onClose = (event: Event): void => {
    const dead = event.target as WebSocket

    dead.removeEventListener('message', onMessage)

    if (released || dead !== socket) {
      return
    }

    socket = null
    self = null
    traffic.drops += 1
    recordDiagnostic('net', label('dropped — reconnecting'))
    scheduleReconnect()
  }

  /**
   * Coming back to the foreground is the moment to stop waiting out a backoff.
   * It matters most on the screen, which has no watchdog of its own: a
   * follower rebuilds its room when beats stop, but a screen with a dead
   * socket sees nothing wrong and would otherwise sit out the full delay.
   */
  const stopWatchingVisibility = onVisibilityChange(visible => {
    if (released || socket || !visible) {
      return
    }

    clearTimeout(reconnectTimer)
    reconnectTimer = undefined
    attempts = 0
    scheduleReconnect()
  })

  const attach = (next: WebSocket): void => {
    socket = next
    next.addEventListener('message', onMessage)
    next.addEventListener('close', onClose, { once: true })
  }

  function scheduleReconnect(): void {
    if (released || reconnectTimer) {
      return
    }

    const ceiling = isPageVisible()
      ? RECONNECT_MAX_MS
      : RECONNECT_MAX_HIDDEN_MS
    const backoff = Math.min(ceiling, RECONNECT_BASE_MS * 2 ** attempts)
    const delay = backoff * (1 - RECONNECT_JITTER * Math.random())

    attempts += 1
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined

      if (released) {
        return
      }

      openSocket().then(
        next => {
          if (released) {
            next.close()

            return
          }

          attach(next)
          attempts = 0
          sendJoin()
          recordDiagnostic('net', label('reconnected — rejoining'))
        },
        () => scheduleReconnect(),
      )
    }, delay)
  }

  function release(): void {
    if (released) {
      return
    }

    released = true
    clearTimeout(reconnectTimer)
    stopWatchingVisibility()
    liveSockets.delete(handle)

    if (socket) {
      socket.removeEventListener('message', onMessage)
      socket.removeEventListener('close', onClose)

      try {
        socket.close()
      } catch {
        /* already closing */
      }
    }

    socket = null
    self = null
  }

  // Nothing may keep a connection it no longer owns. Whatever is still here
  // belongs to an owner that has gone without closing it, and leaving it alive
  // is what puts phantom listeners on the screen's peer count — see the note
  // on `liveSockets`. Released before this one opens, so the room never sees
  // two identities for one device.
  for (const stale of [...liveSockets]) {
    recordDiagnostic(
      'net',
      label(`releasing orphaned connection [sig ${stale.seq}]`),
      { tag: 'signal-orphan' },
    )
    stale.release()
  }

  let first: WebSocket

  try {
    first = await openSocket()
  } catch (caught) {
    // Nothing is open, but this connection is already dangerous. The
    // visibility listener above is registered and sees `released` false and
    // `socket` null — which is precisely the state it acts on — so without
    // this the next time the phone is unlocked it reconnects a connection its
    // owner gave up on minutes ago, joins the room under a fresh id, and gets
    // dialled. Every failed open left one more of those behind.
    release()

    throw caught
  }

  liveSockets.add(handle)
  attach(first)

  // The join is awaited separately from the socket: an open socket that is
  // then refused the room is a different failure from one that never opened,
  // and only the first has a reason worth reporting to the caller.
  //
  // Released on *any* failure from here on, which is the whole point of the
  // try. By this line the socket is reconnecting, re-joining and holding the
  // caller's handlers — everything it needs to keep running on behalf of a
  // caller that has given up. A rejection that left it alive did exactly
  // that: it re-joined on every reconnect, was assigned a fresh peer id each
  // time, and the screen dutifully dialled every one of them. Three ids from
  // one phone in half a second, and a peer count of four for two devices.
  try {
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>

      const settle = (finish: () => void) => {
        clearTimeout(timer)
        first.removeEventListener('message', watchJoin)
        finish()
      }

      const watchJoin = (event: MessageEvent) => {
        const frame = readFrame(event.data)

        if (frame?.t === 'joined') {
          settle(resolve)
        } else if (frame?.t === 'error') {
          settle(() =>
            reject(new Error(`signalling join refused — ${frame.reason}`)),
          )
        }
      }

      timer = setTimeout(() => {
        settle(() => reject(new Error('signalling join timed out')))
      }, CONNECT_TIMEOUT_MS)

      // Behind `onMessage` in registration order, and both run: this one only
      // watches for the outcome, and the handler attached above does the work.
      first.addEventListener('message', watchJoin)
      sendJoin()
    })
  } catch (caught) {
    release()

    throw caught
  }

  return {
    self: () => self,
    online: () => socket?.readyState === WebSocket.OPEN && self !== null,
    signal(to, data) {
      traffic.signalsOut += 1
      send({ t: 'signal', to, data })
    },
    close: release,
  }
}
