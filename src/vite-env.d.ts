/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

// Ensure .m4a imports resolve to a URL string even if not in vite/client's
// default list.
declare module '*.m4a' {
  const src: string
  export default src
}

/**
 * The Sentry release name for this bundle — the commit it was built from —
 * substituted at build time by the `define` block in `vite.config.ts`.
 * `undefined` when the build had no git checkout to read.
 */
declare const __APP_RELEASE__: string | undefined

interface ImportMetaEnv {
  /**
   * Sentry DSN for the browser SDK, consumed by `src/instrument.ts`. Absent
   * in a checkout that has not been pointed at a Sentry project, which
   * leaves the SDK initialised but disabled.
   */
  readonly VITE_SENTRY_DSN?: string
}
