import { useState, useSyncExternalStore } from 'react'

import {
  clearDiagnostics,
  diagnosticEvents,
  formatDiagnostics,
  subscribeDiagnostics,
  type DiagnosticEvent,
} from '../diagnostics/session-log'

/** How many of the most recent events the panel renders. */
const VISIBLE_EVENTS = 60

function formatClockTime(at: number): string {
  const time = new Date(at)
  const minutes = String(time.getMinutes()).padStart(2, '0')
  const seconds = String(time.getSeconds()).padStart(2, '0')

  return `${String(time.getHours()).padStart(2, '0')}:${minutes}:${seconds}`
}

/**
 * The headline numbers from a sleep test, so the outcome can be read without
 * scrolling the log on a phone.
 */
interface DiagnosticSummary {
  /** Times Chrome reported freezing the page. */
  freezes: number
  /** Longest stall observed between liveness-timer ticks, in seconds. */
  longestStallSec: number
  /** Times a peer was torn down. */
  peerLeaves: number
  /** Times the follower rebuilt its transport. */
  rejoins: number
}

function summarise(events: DiagnosticEvent[]): DiagnosticSummary {
  let freezes = 0
  let longestStallSec = 0
  let peerLeaves = 0
  let rejoins = 0

  for (const event of events) {
    if (event.category === 'page' && event.message.includes('FROZEN')) {
      freezes += 1
    }

    if (event.category === 'peer' && event.message.startsWith('LEAVE')) {
      peerLeaves += 1
    }

    // Count attempts only — each one also logs its outcome, which would
    // otherwise double the total.
    if (
      event.category === 'transport' &&
      event.message.startsWith('rejoining')
    ) {
      rejoins += 1
    }

    if (event.category === 'timer') {
      const stall = Number(/gap ([\d.]+)s/.exec(event.message)?.[1] ?? 0)
      longestStallSec = Math.max(longestStallSec, stall)
    }
  }

  return { freezes, longestStallSec, peerLeaves, rejoins }
}

/**
 * The connection-stability instrument: a live event log of ICE transitions,
 * page freezes, timer stalls and rejoin attempts, with a one-tap copy so a log
 * can be taken off a phone after a sleep test.
 */
export function DiagnosticsPanel() {
  const events = useSyncExternalStore(subscribeDiagnostics, diagnosticEvents)
  const [copied, setCopied] = useState(false)
  const summary = summarise(events)
  const recent = events.slice(-VISIBLE_EVENTS).reverse()

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(formatDiagnostics())
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* clipboard needs a secure context — the log is still on screen */
    }
  }

  return (
    <section className="debug diag">
      <h2>Debug — connection log</h2>

      <div className="dbg-row">
        <span className="dbg-key">summary</span>
        <span className="dbg-val">
          {summary.freezes} freezes · {summary.peerLeaves} peer leaves ·{' '}
          {summary.rejoins} rejoins · longest stall{' '}
          {summary.longestStallSec.toFixed(1)}s
        </span>
      </div>

      <div className="diag-actions">
        <button className="ghost" onClick={copy}>
          {copied ? '✓ Copied' : `Copy log (${events.length})`}
        </button>
        <button className="ghost" onClick={clearDiagnostics}>
          Clear
        </button>
      </div>

      <ol className="diag-log">
        {recent.map(event => (
          <li key={`${event.at}-${event.message}`}>
            <span className="diag-time">{formatClockTime(event.at)}</span>
            <span className={`diag-cat diag-cat-${event.category}`}>
              {event.category}
            </span>
            <span className="diag-msg">
              {event.message}
              {event.hidden && <span className="muted"> · hidden</span>}
            </span>
          </li>
        ))}
        {!recent.length && <li className="muted">No events recorded yet.</li>}
      </ol>
    </section>
  )
}
