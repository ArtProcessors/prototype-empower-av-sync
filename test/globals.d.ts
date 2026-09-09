/**
 * The sims run under Node's type-stripping (`node test/sync-sim.ts`), but the
 * repo has no Node type package — the app itself never touches Node globals.
 * Declaring just the members the sims use keeps them type-checked without
 * pulling `@types/node` into the dependency tree.
 */
declare const process: {
  /** End the run with `code`; non-zero marks the sim as failed. */
  exit(code: number): never
}

declare module 'node:fs' {
  /**
   * Read a file as text. Used by the transcript sim to load the real
   * transcript, which cannot be imported: these run with no bundler and so no
   * JSON module resolution.
   */
  export function readFileSync(path: string, encoding: 'utf8'): string
}
