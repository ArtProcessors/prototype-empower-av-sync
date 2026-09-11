import * as Sentry from '@sentry/react'

/**
 * Sentry initialisation, in a sidecar module so it can be the first import in
 * `index.tsx` and therefore run before any application code. The SDK patches
 * globals — `fetch`, `XMLHttpRequest`, `window.onerror` — and anything that
 * captures a reference to one of those before the patch lands is invisible to
 * it. This module imports nothing from the app for that reason.
 *
 * With no `VITE_SENTRY_DSN` set the SDK initialises disabled and sends
 * nothing, so a checkout without the variable behaves exactly as it did before
 * Sentry existed. See `.env.example` for where the DSN goes.
 */
Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  environment: import.meta.env.MODE,

  // Production builds only. Vite reads `.env.local` for `yarn dev` just as it
  // does for `yarn build`, so the DSN alone would have every reload, every
  // hot update and every half-finished edit reporting as a real session —
  // noise in the issue list and quota spent on nobody's problem.
  //
  // This is the build mode, not the deployment: `yarn build && yarn preview`
  // is a production build and does send, which is what makes it possible to
  // check Sentry locally before shipping. To report from `yarn dev` for a
  // moment, change this to `true` rather than adding a flag for it.
  enabled: import.meta.env.PROD,

  // Set by `vite.config.ts` from the commit being built; see the `define`
  // block there for what happens outside a git checkout.
  release: __APP_RELEASE__,

  integrations: [Sentry.browserTracingIntegration()],

  // Every trace. This is a feasibility spike run by a handful of devices in
  // one room, and a partial sample of that is a partial sample of the whole
  // population — the guidance to drop to 0.1–0.2 in production is about
  // volume this build will not see. Revisit before it carries real traffic.
  tracesSampleRate: 1,

  // `tracePropagationTargets` is deliberately unset. Left alone, the browser
  // SDK attaches trace headers to same-origin requests only, and every call
  // this app makes — `/api/ice`, the room WebSocket — is same-origin in both
  // modes: proxied to `wrangler dev` locally, served by the Worker in
  // production. Naming a host here could only narrow that, or leak the
  // headers to a third party.
})
