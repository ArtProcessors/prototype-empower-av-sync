/**
 * Routes the client and the Worker have to agree on, in one place.
 *
 * These were previously declared twice or three times each — once in
 * `worker/index.ts`, once at each client call site, and once more in Vite's dev
 * proxy — with nothing tying the copies together. A path that drifts here fails
 * at runtime in the one environment (production, same-origin) that the dev
 * proxy hides.
 *
 * Deliberately plain strings and nothing else: this module is compiled by the
 * app's tsconfig *and* the Worker's, and the Worker's has no DOM lib.
 */

/** Path the client fetches its short-lived ICE configuration from. */
export const ICE_PATH = '/api/ice'

/**
 * Cheap liveness endpoint. The client polls it while the page is hidden to find
 * out whether the phone still has a usable network at all.
 */
export const PING_PATH = '/api/ping'

/** WebSocket endpoint peers meet on; upgraded straight into the Durable Object. */
export const SIGNAL_PATH = '/signal'
