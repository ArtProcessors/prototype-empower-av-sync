import { useState, useSyncExternalStore } from 'react'

import {
  clearDiagnostics,
  diagnosticEvents,
  formatDiagnostics,
  subscribeDiagnostics,
} from '../../diagnostics/session-log'
import { summariseDiagnostics } from '../../diagnostics/summary'

/** How many of the most recent events the panel renders. */
const VISIBLE_EVENTS = 60

function formatClockTime(at: number): string {
  const time = new Date(at)
  const minutes = String(time.getMinutes()).padStart(2, '0')
  const seconds = String(time.getSeconds()).padStart(2, '0')

  return `${String(time.getHours()).padStart(2, '0')}:${minutes}:${seconds}`
}

/**
 * The connection-stability instrument: a live event log of ICE transitions,
 * page freezes, timer stalls and rejoin attempts, with a one-tap copy so a log
 * can be taken off a phone after a sleep test.
 */
export function DiagnosticsPanel() {
  const events = useSyncExternalStore(subscribeDiagnostics, diagnosticEvents)
  const [copied, setCopied] = useState(false)
  const summary = summariseDiagnostics(events)
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
