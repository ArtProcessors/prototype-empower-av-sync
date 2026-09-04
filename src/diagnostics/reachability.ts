/**
 * Polls a trivial Worker endpoint while the page is hidden, to tell whether the
 * phone still has a usable network.
 *
 * It was written to settle whether Android sleep kills the radio or merely
 * stops WebRTC re-peering in the background. It settled it: on test, a plain
 * `GET` to Cloudflare timed out sixteen times running, then began failing
 * outright in under 100 ms, while the renderer stayed perfectly awake and the
 * probe timer kept 30 s intervals to within 100 ms. The device takes its Wi-Fi
 * down at screen-off. Nothing at the application layer reaches past that — a
 * WebSocket transport would fail exactly as hard, which is why one was not
 * built.
 *
 * It stays because the answer is load-bearing: {@link networkLooksUp} gates the
 * transport watchdog, so an expensive WebRTC rebuild is only attempted once a
 * cheap fetch has shown the network is actually there. Before that gate, a
 * five-minute sleep burned seven full room rebuilds against a radio that was
 * not listening.
 */
import { transportConfig } from '../transport/transport-config'
import { recordDiagnostic } from './session-log'

/** How often to probe while the page is hidden and the network looks healthy. */
const PROBE_INTERVAL_MS = 30000

/**
 * Ceiling for the backoff applied while probes keep failing. A sleeping radio
 * stays asleep, so re-asking every 30 s for nineteen rounds — as the first test
 * did — only spends battery to learn the same thing.
 */
const PROBE_MAX_INTERVAL_MS = 300000

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
    const response = await fetch(
      `${transportConfig().pingPath}?t=${startedAt}`,
      {
        cache: 'no-store',
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      },
    )
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
 * Delay before the next probe: the base interval while things are healthy,
 * doubling per consecutive failure up to {@link PROBE_MAX_INTERVAL_MS}.
 */
function nextDelayMs(): number {
  if (consecutiveFailures === 0) {
    return PROBE_INTERVAL_MS
  }

  return Math.min(
    PROBE_INTERVAL_MS * 2 ** (consecutiveFailures - 1),
    PROBE_MAX_INTERVAL_MS,
  )
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

  const scheduleNext = () => {
    setTimeout(async () => {
      await probe()
      scheduleNext()
    }, nextDelayMs())
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      // Probe straight away rather than waiting out any accumulated backoff —
      // the failure count is left alone so a recovery still logs as one.
      probe()
    }
  })

  scheduleNext()
}
