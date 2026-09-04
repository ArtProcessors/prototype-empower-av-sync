/**
 * The sims run under Node's type-stripping (`node test/sync-sim.ts`), but the
 * repo has no Node type package — the app itself never touches Node globals.
 * Declaring just the one member the sims use keeps them type-checked without
 * pulling `@types/node` into the dependency tree.
 */
declare const process: {
  /** End the run with `code`; non-zero marks the sim as failed. */
  exit(code: number): never
}
