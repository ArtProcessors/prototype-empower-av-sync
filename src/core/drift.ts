/**
 * How far out of sync counts as a problem.
 *
 * The thresholds are policy and live in the core; naming a colour for each band
 * is the view's job. Splitting them that way is what lets a second UI band
 * drift the same way while looking nothing like this one.
 */
import { sessionConfig } from './config'

/** How a drift reading should be presented, worst-case last. */
export type DriftBand = 'good' | 'warn' | 'bad'

/** Band a drift reading, in ms, by magnitude. */
export function driftBand(driftMs: number): DriftBand {
  const { goodMs, warnMs } = sessionConfig().drift
  const magnitude = Math.abs(driftMs)

  if (magnitude < goodMs) {
    return 'good'
  }

  if (magnitude < warnMs) {
    return 'warn'
  }

  return 'bad'
}
