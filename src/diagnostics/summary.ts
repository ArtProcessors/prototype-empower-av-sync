/**
 * The headline numbers from a sleep test, so the outcome can be read without
 * scrolling the log on a phone.
 *
 * It lives next to the modules that emit these events rather than in the panel
 * that renders them, and it counts {@link DiagnosticEvent.tag} rather than
 * message wording — the coupling between "what happened" and "what it reads
 * like" is what made the old version fragile.
 *
 * The wording fallback is not belt-and-braces: the log is restored from
 * `sessionStorage` after a tab discard, which is *the* scenario this panel
 * exists for, and events written by a previous build carry no tag. Without the
 * fallback a sleep test that spans a deploy would quietly summarise as zero.
 */
import type { DiagnosticEvent } from './session-log'

/** What a run of the log adds up to. */
export interface DiagnosticSummary {
  /** Times Chrome reported freezing the page. */
  freezes: number
  /** Longest stall observed between liveness-timer ticks, in seconds. */
  longestStallSec: number
  /** Times a peer was torn down. */
  peerLeaves: number
  /** Times the follower rebuilt its transport. */
  rejoins: number
}

/** Reduce a log to its headline numbers. */
export function summariseDiagnostics(
  events: readonly DiagnosticEvent[],
): DiagnosticSummary {
  let freezes = 0
  let longestStallSec = 0
  let peerLeaves = 0
  let rejoins = 0

  for (const event of events) {
    const untagged = event.tag === undefined

    if (
      event.tag === 'page-frozen' ||
      (untagged &&
        event.category === 'page' &&
        event.message.includes('FROZEN'))
    ) {
      freezes += 1
    }

    if (
      event.tag === 'peer-leave' ||
      (untagged &&
        event.category === 'peer' &&
        event.message.startsWith('LEAVE'))
    ) {
      peerLeaves += 1
    }

    // Count attempts only — each one also logs its outcome, which would
    // otherwise double the total.
    if (
      event.tag === 'transport-rejoin' ||
      (untagged &&
        event.category === 'transport' &&
        event.message.startsWith('rejoining'))
    ) {
      rejoins += 1
    }

    if (event.tag === 'timer-stall') {
      longestStallSec = Math.max(longestStallSec, event.value ?? 0)
    } else if (untagged && event.category === 'timer') {
      const stall = Number(/gap ([\d.]+)s/.exec(event.message)?.[1] ?? 0)

      longestStallSec = Math.max(longestStallSec, stall)
    }
  }

  return { freezes, longestStallSec, peerLeaves, rejoins }
}
