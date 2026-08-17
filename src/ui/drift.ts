const DRIFT_GOOD_MS = 50
const DRIFT_WARN_MS = 150

/**
 * CSS class banding a drift reading as good / warning / bad, so the hero
 * number and the debug row always agree on what "good" looks like.
 */
export function driftClassName(driftMs: number): string {
  const magnitude = Math.abs(driftMs)

  if (magnitude < DRIFT_GOOD_MS) {
    return 'drift-good'
  }

  if (magnitude < DRIFT_WARN_MS) {
    return 'drift-warn'
  }

  return 'drift-bad'
}
