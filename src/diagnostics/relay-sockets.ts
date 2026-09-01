/**
 * Reports the state of the signalling relay sockets.
 *
 * Peering failures are ambiguous without this. A follower that rejoins a room
 * nine times and never finds a peer looks identical whether the relays are
 * throttling it — public Nostr relays do, and one answered
 * "rate-limited: you are noting too much" during testing — or whether the room
 * is simply empty because the screen has gone. One is a signalling problem
 * worth self-hosting a relay to fix; the other is not a problem with this code
 * at all.
 *
 * Logging socket readiness at the moment a rejoin is decided separates them.
 */
import { loadStrategy } from '../transport/config'
import { recordDiagnostic } from './session-log'

/** `WebSocket.readyState` values, named for the log. */
const READY_STATE_NAMES = [
  'connecting',
  'open',
  'closing',
  'closed',
] as const

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
export type RelayReportContext = 'rejoin'

/**
 * Record how many signalling relays are connected, naming any that are not.
 * Best-effort: never throws, and never blocks the caller's own work.
 */
export async function reportRelaySockets(
  context: RelayReportContext,
): Promise<void> {
  try {
    const { getRelaySockets } = await loadStrategy()
    const sockets = Object.entries(getRelaySockets() ?? {})

    if (!sockets.length) {
      recordDiagnostic('net', `relays (${context}): none connected`)

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
        `${unhealthy.length ? ` — ${unhealthy.join(' ')}` : ''}`,
    )
  } catch {
    /* diagnostics must never break a session */
  }
}
