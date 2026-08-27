/**
 * Polls a trivial Worker endpoint while the page is hidden, to find out
 * whether the phone still has a usable network during a screen-off.
 *
 * This exists to settle a question the rest of the log cannot. On an Android
 * sleep test the renderer stayed fully awake — no freeze, no timer stall, the
 * watchdog ticking on schedule — yet seven room rejoins over four and a half
 * minutes produced not one peer connection, and peering succeeded within
 * seconds every time the screen came back on. Two very different explanations
 * fit that:
 *
 *  - **The radio is asleep.** Nothing at the application layer can help, and
 *    the answer is to make waking fast and inaudible rather than to keep
 *    fighting for a connection.
 *  - **The radio is fine, but WebRTC cannot complete a handshake in the
 *    background.** Then a plain WebSocket — one TCP connection, no ICE, no
 *    signalling round trip — has a real chance where a peer connection does
 *    not, and is worth building.
 *
 * A 204 from `/api/ping` while hidden picks the second; a failure picks the
 * first.
 *
 * The result is also load-bearing, not just diagnostic: {@link networkLooksUp}
 * gates the transport watchdog's rejoin attempts, so an expensive WebRTC
 * rebuild is only tried when a cheap fetch has just proved the network is
 * there.
 */
import { recordDiagnostic } from './session-log'

/** Worker route that answers 204 and nothing else. */
const PING_PATH = '/api/ping'

/** How often to probe while the page is hidden. */
const PROBE_INTERVAL_MS = 30000

/**
 * Give up on a probe after this long. Deliberately short: a probe that takes
 * ten seconds has already told us the network is in no state to carry a
 * WebRTC handshake.
 */
const PROBE_TIMEOUT_MS = 5000

/** How long a successful probe is taken as evidence the network is usable. */
const PROBE_FRESH_MS = 60000

let lastSuccessAt = 0
let consecutiveFailures = 0
let probing = false
let started = false

/**
 * Whether a probe has recently succeeded. The watchdog uses this to avoid
 * rebuilding the transport into a network that is not there — on the sleep
 * test that pattern burned seven full rejoins for nothing.
 *
 * Returns `true` while the page is visible: the probe only runs when hidden,
 * and a visible page has the on-visibility rejoin path, which does work.
 */
export function networkLooksUp(): boolean {
  if (document.visibilityState === 'visible') {
    return true
  }

  return Date.now() - lastSuccessAt < PROBE_FRESH_MS
}

async function probe(): Promise<void> {
  if (probing || document.visibilityState === 'visible') {
    return
  }

  probing = true

  const startedAt = Date.now()

  try {
    const response = await fetch(`${PING_PATH}?t=${startedAt}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    const elapsed = Date.now() - startedAt

    if (!response.ok) {
      throw new Error(`status ${response.status}`)
    }

    // Only log the transition back, not every quiet success — a five-minute
    // sleep would otherwise bury the interesting lines under ten identical ones.
    if (consecutiveFailures > 0) {
      recordDiagnostic(
        'net',
        `probe OK after ${consecutiveFailures} failures (${elapsed}ms)` +
          ' — network is back',
      )
    } else if (!lastSuccessAt) {
      recordDiagnostic('net', `probe OK (${elapsed}ms) — network usable`)
    }

    lastSuccessAt = Date.now()
    consecutiveFailures = 0
  } catch (caught) {
    consecutiveFailures += 1

    const message = caught instanceof Error ? caught.message : String(caught)

    recordDiagnostic(
      'net',
      `probe FAILED #${consecutiveFailures} after ` +
        `${Date.now() - startedAt}ms — ${message}`,
    )
  } finally {
    probing = false
  }
}

/**
 * Start probing. Runs only while the page is hidden, and fires immediately on
 * hide so the first data point lands before the radio has had time to settle.
 * Safe to call more than once.
 */
export function startReachabilityProbe(): void {
  if (started) {
    return
  }

  started = true

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      probe()
    }
  })

  setInterval(probe, PROBE_INTERVAL_MS)
}
