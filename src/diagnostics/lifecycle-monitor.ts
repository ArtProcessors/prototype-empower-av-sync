/**
 * Watches the page itself — visibility, freezing, network reachability and
 * whether our timers are still running — and reports it all into the session
 * log.
 *
 * This is the half of the instrumentation that separates the two competing
 * explanations for a follower going silent during an Android sleep:
 *
 *  - **The renderer was stopped.** Chrome froze or discarded the page, so
 *    nothing of ours ran and the peer connection died with it. Evidence: a
 *    `freeze` event, or the liveness timer simply stopping.
 *  - **The renderer kept running and the link died anyway.** Evidence: the
 *    liveness timer ticking right through the sleep while the ICE log shows the
 *    connection dropping.
 *
 * Reading the liveness gaps needs Chrome's throttling tiers in mind:
 *
 *  | Gap between ticks | What it means                                     |
 *  | ----------------- | ------------------------------------------------- |
 *  | ~1 s              | Running normally, not throttled                   |
 *  | ~60 s             | Intensive throttling — which a page *playing audio*|
 *  |                   | is meant to be exempt from, so the keep-alive tap  |
 *  |                   | is not doing its job                              |
 *  | Ticks stop, then  | Frozen (a `freeze` event should accompany it)     |
 *  | resume on wake    |                                                   |
 */
import { flushDiagnostics, recordDiagnostic } from './session-log'

/** How often the liveness timer fires while the session is up. */
const LIVENESS_TICK_MS = 1000

/**
 * Gap between liveness ticks worth reporting. Comfortably above the ~1 s
 * throttle Chrome applies to any hidden page, so ordinary backgrounding is not
 * logged as a stall.
 */
const LIVENESS_GAP_MS = 3000

/**
 * The subset of the Network Information API we read. It is not in TypeScript's
 * DOM library and is Chromium-only, which is fine — Android Chrome is exactly
 * the platform under investigation.
 */
interface NetworkInformation extends EventTarget {
  /** Coarse connection quality, e.g. `4g` or `2g`. */
  effectiveType?: string
  /** Physical connection type, e.g. `wifi` or `cellular`. */
  type?: string
}

function networkInformation(): NetworkInformation | null {
  return (
    (navigator as Navigator & { connection?: NetworkInformation })
      .connection ?? null
  )
}

function describeNetwork(): string {
  const connection = networkInformation()

  if (!connection) {
    return navigator.onLine ? 'online' : 'offline'
  }

  return (
    `${navigator.onLine ? 'online' : 'offline'}` +
    ` ${connection.type ?? '?'}/${connection.effectiveType ?? '?'}`
  )
}

/** Guards against starting a second set of listeners and timers. */
let monitoring = false

/**
 * Begin recording page-lifecycle, network and renderer-liveness events.
 *
 * Monitoring deliberately lasts for the page's whole life rather than a
 * session's: a freeze or a discard is the thing being hunted, and it can land
 * before a room is joined or after one is left. Repeat calls are no-ops, so
 * React's development-mode double-invocation of effects cannot produce two
 * liveness timers (which would halve the apparent stall durations) or a
 * duplicate start marker in the log.
 */
export function startLifecycleMonitoring(): void {
  if (monitoring) {
    return
  }

  monitoring = true

  recordDiagnostic('page', `monitoring started — net ${describeNetwork()}`)

  // `wasDiscarded` is part of the Page Lifecycle API and Chromium-only, so it
  // is not in TypeScript's DOM library.
  const wasDiscarded = (document as Document & { wasDiscarded?: boolean })
    .wasDiscarded

  if (wasDiscarded) {
    recordDiagnostic('page', 'page was discarded and restored by the browser')
  }

  const onVisibilityChange = () => {
    recordDiagnostic('page', `visibility → ${document.visibilityState}`)

    if (document.visibilityState !== 'visible') {
      flushDiagnostics()
    }
  }

  // `freeze` is the definitive signal that Chrome stopped the renderer; it is
  // also our last chance to persist the log before that happens.
  const onFreeze = () => {
    recordDiagnostic('page', 'FROZEN by the browser', { tag: 'page-frozen' })
    flushDiagnostics()
  }

  const onResume = () => {
    recordDiagnostic('page', 'resumed from frozen')
  }

  const onPageHide = () => {
    recordDiagnostic('page', 'pagehide')
    flushDiagnostics()
  }

  const onOnline = () => {
    recordDiagnostic('net', `online — ${describeNetwork()}`)
  }

  const onOffline = () => {
    recordDiagnostic('net', `offline — ${describeNetwork()}`)
  }

  // A Wi-Fi ↔ cellular handover rebinds the phone's NAT, which kills a
  // server-reflexive candidate pair outright.
  const onConnectionChange = () => {
    recordDiagnostic('net', `connection → ${describeNetwork()}`)
  }

  document.addEventListener('visibilitychange', onVisibilityChange)
  document.addEventListener('freeze', onFreeze)
  document.addEventListener('resume', onResume)
  window.addEventListener('pagehide', onPageHide)
  window.addEventListener('online', onOnline)
  window.addEventListener('offline', onOffline)

  const connection = networkInformation()
  connection?.addEventListener('change', onConnectionChange)

  let lastTickAt = Date.now()

  setInterval(() => {
    const now = Date.now()
    const gap = now - lastTickAt
    lastTickAt = now

    if (gap > LIVENESS_GAP_MS) {
      recordDiagnostic(
        'timer',
        `liveness gap ${(gap / 1000).toFixed(1)}s — timers stalled`,
        { tag: 'timer-stall', value: gap / 1000 },
      )
    }
  }, LIVENESS_TICK_MS)
}
