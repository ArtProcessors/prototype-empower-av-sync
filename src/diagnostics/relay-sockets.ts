/**
 * Reports the state of the signalling relay sockets.
 *
 * Peering failures are ambiguous without this. A follower that rejoins a room
 * nine times and never finds a peer looks identical whether the `/signal`
 * socket is down — a Worker redeploy, a dropped connection mid-reconnect — or
 * whether the room is simply empty because the screen has gone. One is a
 * signalling problem; the other is not a problem with this code at all.
 *
 * Logging socket readiness at the moment a rejoin is decided separates them.
 */
import {
  getSignalSockets,
  takeSignalTraffic,
} from '../transport/signal-socket'
import { recordDiagnostic } from './session-log'

/** `WebSocket.readyState` values, named for the log. */
const READY_STATE_NAMES = ['connecting', 'open', 'closing', 'closed'] as const

type WebSocketReadyStateName = (typeof READY_STATE_NAMES)[number]

function describeReadyState(
  socket: WebSocket,
): WebSocketReadyStateName | `unknown(${number})` {
  return (
    READY_STATE_NAMES[socket.readyState] ?? `unknown(${socket.readyState})`
  )
}

/** Shorten a relay URL to its host, so a line of them fits on a phone. */
function relayHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** Why relay health was sampled — extend as new call sites appear. */
type RelayReportContext = 'rejoin'

/**
 * One line describing the signalling traffic since the last report.
 *
 * Read against the socket state beside it, this says which half of a failed
 * join broke. No presence frames at all means the relay never answered the
 * join; presence but no signals means the room was introduced and the
 * negotiation went nowhere. `readyState` alone could never tell those apart —
 * an open socket carrying nothing looks exactly like an open socket in an
 * empty room.
 *
 * Abbreviated hard, because it shares a line with the socket counts and is
 * read on a phone.
 */
function describeTraffic(): string {
  const seen = takeSignalTraffic()

  return (
    ` · ${seen.joins} join, ${seen.presenceIn} presence` +
    ` · sig ${seen.signalsIn} in / ${seen.signalsOut} out` +
    `${seen.drops ? ` · ${seen.drops} drop` : ''}`
  )
}

/**
 * Record how many signalling relays are connected, naming any that are not.
 * Best-effort: never throws.
 */
export function reportRelaySockets(context: RelayReportContext): void {
  try {
    const sockets = Object.entries(getSignalSockets() ?? {})

    if (!sockets.length) {
      recordDiagnostic(
        'net',
        `relays (${context}): none connected${describeTraffic()}`,
      )

      return
    }

    const open = sockets.filter(([, socket]) => socket.readyState === 1)
    const unhealthy = sockets
      .filter(([, socket]) => socket.readyState !== 1)
      .map(
        ([url, socket]) => `${relayHost(url)}:${describeReadyState(socket)}`,
      )

    recordDiagnostic(
      'net',
      `relays (${context}): ${open.length}/${sockets.length} open` +
        `${unhealthy.length ? ` — ${unhealthy.join(' ')}` : ''}` +
        describeTraffic(),
    )
  } catch {
    /* diagnostics must never break a session */
  }
}
