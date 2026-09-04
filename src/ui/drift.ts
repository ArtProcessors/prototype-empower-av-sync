import { driftBand } from '../core/drift'

/**
 * CSS class banding a drift reading as good / warning / bad, so the hero
 * number and the debug row always agree on what "good" looks like. The
 * thresholds themselves are session policy — see `core/drift.ts`.
 */
export function driftClassName(driftMs: number): string {
  return `drift-${driftBand(driftMs)}`
}

/**
 * A drift reading with its sign always shown, so the number does not jump
 * sideways as it crosses zero. The unit is deliberately left off: the hero
 * readout wraps it in its own element and the debug row does not.
 */
export function formatSignedDrift(driftMs: number): string {
  return `${driftMs >= 0 ? '+' : ''}${driftMs.toFixed(0)}`
}
