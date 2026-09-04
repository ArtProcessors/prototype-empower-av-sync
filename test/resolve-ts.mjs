/**
 * Let the sims import the app's modules the way the app writes them.
 *
 * `src/` uses extensionless relative imports, which Vite resolves and Node's
 * ESM loader does not. Rather than litter the app with `.ts` extensions to suit
 * a test runner it never sees, this hook retries a failed relative specifier
 * with `.ts` appended.
 *
 * Registered via `node --import ./test/resolve-ts.mjs` — see the `sim` script.
 */
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (!specifier.startsWith('.') || !context.parentURL) {
        throw error
      }

      const candidate = new URL(`${specifier}.ts`, context.parentURL)

      if (!existsSync(fileURLToPath(candidate))) {
        throw error
      }

      // No `format` — Node infers it from the `.ts` extension, which is what
      // enables its type-stripping. Forcing 'module' here skips that and the
      // first type annotation becomes a syntax error.
      return { url: candidate.href, shortCircuit: true }
    }
  },
})
