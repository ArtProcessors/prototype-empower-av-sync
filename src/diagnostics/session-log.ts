/**
 * A small in-page event log for diagnosing why a follower's WebRTC link dies
 * during an Android sleep.
 *
 * The failure we are chasing is invisible from the outside: the follower stops
 * receiving beats and vanishes from the screen's peer count, minutes into a
 * screen-off, with no user present to watch a console. So every interesting
 * transition — ICE state, page freeze, timer stalls, network changes, rejoin
 * attempts — is timestamped into a ring buffer that survives the sleep and can
 * be read (or copied out) on the phone afterwards.
 *
 * The buffer is a module singleton rather than React state: it is written to
 * from the transport, the hooks and the page-lifecycle listeners, all of which
 * sit outside the component tree, and it must keep recording while the UI is
 * unmounted or the page is hidden.
 */

/** Most recent events kept in memory; older ones are dropped. */
const MAX_EVENTS = 500

/** `sessionStorage` key the buffer is mirrored to, to survive a tab discard. */
const STORAGE_KEY = 'empower.diagnostics'

/** How often a dirty buffer is written back to `sessionStorage`. */
const FLUSH_INTERVAL_MS = 10000

/** Which subsystem a diagnostic event came from. */
export type DiagnosticCategory =
  /** Beat flow from the screen: gaps, staleness, resyncs. */
  | 'beat'
  /** `RTCPeerConnection` connection/ICE state transitions. */
  | 'ice'
  /** Network reachability and connection-type changes. */
  | 'net'
  /** Page lifecycle: visibility, freeze, resume, discard. */
  | 'page'
  /** Trystero peer lifecycle: joins and leaves. */
  | 'peer'
  /** Renderer liveness: gaps between ticks of a 1 Hz timer. */
  | 'timer'
  /** Transport rejoin attempts and their outcomes. */
  | 'transport'

/**
 * Events the summary counts, marked at the point they are emitted.
 *
 * The panel used to recover these by matching the log's own wording, which
 * made a reworded message a silent change to the numbers. A tag says what an
 * event *is* rather than what it reads like.
 */
export type DiagnosticTag =
  /** The browser froze the page. */
  | 'page-frozen'
  /** A peer connection was torn down. */
  | 'peer-leave'
  /** The follower started rebuilding its transport. */
  | 'transport-rejoin'
  /** A gap between liveness-timer ticks. */
  | 'timer-stall'

/** Anything extra worth recording alongside a message. */
export interface DiagnosticDetail {
  /** What kind of event this is, for the summary. */
  tag?: DiagnosticTag
  /** A number the tag carries — a stall length in seconds, say. */
  value?: number
}

/** One timestamped observation about the session's health. */
export interface DiagnosticEvent {
  /** Wall-clock time the event was recorded, in ms since the epoch. */
  at: number
  /** Which subsystem produced the event. */
  category: DiagnosticCategory
  /** Human-readable description, kept short enough to read on a phone. */
  message: string
  /** Whether the page was hidden at the moment the event was recorded. */
  hidden: boolean
  /**
   * What kind of event this is, for the summary. Absent on events restored
   * from `sessionStorage` that were written by an older build.
   */
  tag?: DiagnosticTag
  /** A number the tag carries — a stall length in seconds, say. */
  value?: number
}

/** Notified after every append; read the new events via `diagnosticEvents()`. */
type Listener = () => void

let events: DiagnosticEvent[] = restoreEvents()
const listeners = new Set<Listener>()
let flushTimer: number | null = null

function restoreEvents(): DiagnosticEvent[] {
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY)

    if (!stored) {
      return []
    }

    const parsed: unknown = JSON.parse(stored)

    if (!Array.isArray(parsed)) {
      return []
    }

    return parsed as DiagnosticEvent[]
  } catch {
    return []
  }
}

/**
 * Write the buffer back to `sessionStorage` so it survives a reload or a
 * background tab-discard. Called on a timer while events are arriving, and
 * eagerly on `freeze`/`pagehide` — the last chance to persist before Chrome
 * stops running the page.
 */
export function flushDiagnostics(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }

  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(events))
  } catch {
    /* storage may be full or unavailable — the in-memory log still works */
  }
}

function scheduleFlush(): void {
  if (flushTimer !== null) {
    return
  }

  flushTimer = setTimeout(
    flushDiagnostics,
    FLUSH_INTERVAL_MS,
  ) as unknown as number
}

/**
 * Append an observation to the log. Also mirrored to the console so the events
 * can be watched live over `chrome://inspect` while a phone is tethered.
 */
export function recordDiagnostic(
  category: DiagnosticCategory,
  message: string,
  detail: DiagnosticDetail = {},
): void {
  const event: DiagnosticEvent = {
    at: Date.now(),
    category,
    message,
    hidden: document.visibilityState !== 'visible',
    ...detail,
  }

  events = [...events, event].slice(-MAX_EVENTS)

  console.info(
    `[diag ${category}]${event.hidden ? ' (hidden)' : ''} ${message}`,
  )

  scheduleFlush()
  listeners.forEach(listener => listener())
}

/** Current log contents, oldest first. Stable between appends. */
export function diagnosticEvents(): DiagnosticEvent[] {
  return events
}

/** Subscribe to appends; call the returned function to unsubscribe. */
export function subscribeDiagnostics(listener: Listener): () => void {
  listeners.add(listener)

  return () => {
    listeners.delete(listener)
  }
}

/** Empty the log, in memory and in storage. */
export function clearDiagnostics(): void {
  events = []
  flushDiagnostics()
  listeners.forEach(listener => listener())
}

function formatClockTime(at: number): string {
  const time = new Date(at)
  const hours = String(time.getHours()).padStart(2, '0')
  const minutes = String(time.getMinutes()).padStart(2, '0')
  const seconds = String(time.getSeconds()).padStart(2, '0')
  const millis = String(time.getMilliseconds()).padStart(3, '0')

  return `${hours}:${minutes}:${seconds}.${millis}`
}

/**
 * Gap between an event and the one before it, as a `+1.2s` string. The gaps
 * are the point of the log: a peer leaving ~5 s after an ICE `disconnected` is
 * Trystero's teardown timer, not a network failure.
 */
function formatGap(at: number, previousAt: number | null): string {
  if (previousAt === null) {
    return ''
  }

  return ` +${((at - previousAt) / 1000).toFixed(1)}s`
}

/** Render the log as plain text, for copying off a phone. */
export function formatDiagnostics(): string {
  let previousAt: number | null = null

  const lines = events.map(event => {
    const line =
      `${formatClockTime(event.at)}${formatGap(event.at, previousAt)}` +
      ` [${event.category}]${event.hidden ? ' (hidden)' : ''}` +
      ` ${event.message}`

    previousAt = event.at

    return line
  })

  return [
    `# empower-av-sync diagnostics (${events.length} events)`,
    `# ua: ${navigator.userAgent}`,
    ...lines,
  ].join('\n')
}
