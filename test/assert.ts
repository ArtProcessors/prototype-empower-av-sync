/**
 * The sims' shared assertion helpers.
 *
 * Deliberately a dozen lines rather than a test runner: these run under
 * `node <file>` with nothing installed, which is what keeps them cheap enough
 * to actually run between refactor stages.
 */

let failures = 0

/** Record a check. Prints a tick or a failure line. */
export function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`)

    return
  }

  console.error(`  ✗ FAIL: ${label}`)
  failures++
}

/** Whether two floats agree to within `tolerance`. */
export function close(
  actual: number,
  expected: number,
  tolerance = 1e-6,
): boolean {
  return Math.abs(actual - expected) <= tolerance
}

/** Print the tally and exit non-zero if anything failed. */
export function report(): never {
  console.log(
    `\n${failures === 0 ? '✅ ALL PASSED' : `❌ ${failures} FAILURE(S)`}\n`,
  )

  return process.exit(failures === 0 ? 0 : 1)
}
