import { useState, useSyncExternalStore } from 'react'

import type { DiagnosticCategory } from '../../diagnostics/session-log'
import {
  clearDiagnostics,
  diagnosticEvents,
  formatDiagnostics,
  subscribeDiagnostics,
} from '../../diagnostics/session-log'
import { summariseDiagnostics } from '../../diagnostics/summary'
import { classNames } from '../class-names'
import debug from './debug.module.css'
import styles from './DiagnosticsPanel.module.css'

/** How many of the most recent events the panel renders. */
const VISIBLE_EVENTS = 60

/**
 * Colour for the categories worth picking out of a long log at a glance.
 *
 * Deliberately partial: `audio`, `beat` and `net` keep the column's default
 * grey, because a sleep test is read by scanning for the transport and page
 * lifecycle events between them. Spelled out rather than built from the
 * category name so an added category is a compile-time decision, not a silently
 * missing class.
 */
const CATEGORY_TONE: Partial<Record<DiagnosticCategory, string>> = {
  ice: styles.categoryIce,
  page: styles.categoryPage,
  peer: styles.categoryPeer,
  timer: styles.categoryTimer,
  transport: styles.categoryTransport,
}

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
 *
 * A section of the debug overlay rather than a panel of its own, so it is
 * up wherever the overlay is — including on the start screen, which is where a
 * discarded tab's reload lands with a log restored from `sessionStorage`.
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
    <section className={debug.section}>
      <h3 className={debug.sectionName}>Connection log</h3>

      <div className={debug.row}>
        <span className={debug.rowKey}>summary</span>
        <span className={debug.rowValue}>
          {summary.freezes} freezes · {summary.peerLeaves} peer leaves ·{' '}
          {summary.rejoins} rejoins · longest stall{' '}
          {summary.longestStallSec.toFixed(1)}s
          {/* Only when it has happened: a standing "0 orphans" would train
              the eye to skip the one number that means a socket got away. */}
          {summary.orphans > 0 && ` · ${summary.orphans} orphaned sockets`}
        </span>
      </div>

      <div className={styles.actions}>
        <button className={debug.ghost} onClick={copy}>
          {copied ? '✓ Copied' : `Copy log (${events.length})`}
        </button>
        <button className={debug.ghost} onClick={clearDiagnostics}>
          Clear
        </button>
      </div>

      <ol className={styles.log}>
        {recent.map(event => (
          <li key={`${event.at}-${event.message}`}>
            <span className={styles.time}>{formatClockTime(event.at)}</span>
            <span
              className={classNames(
                styles.category,
                CATEGORY_TONE[event.category],
              )}
            >
              {event.category}
            </span>
            <span className={styles.message}>
              {event.message}
              {event.hidden && <span className={debug.muted}> · hidden</span>}
            </span>
          </li>
        ))}
        {!recent.length && (
          <li className={debug.muted}>No events recorded yet.</li>
        )}
      </ol>
    </section>
  )
}
