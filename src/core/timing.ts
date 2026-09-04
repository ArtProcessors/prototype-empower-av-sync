/**
 * Every timing constant the session runs on, in one place.
 *
 * These are not arbitrary: each was arrived at by watching a phone fail. The
 * comments are the reasoning, and are worth more than the numbers — a value
 * changed without reading them is a regression waiting for a venue.
 */

/** Correction loop period — ~15 Hz. */
export const CORRECT_MS = 66

/** Ignore beats older than this when steering. */
export const BEAT_FRESH_MS = 3000

/** How often the transport watchdog checks for beats. */
export const WATCHDOG_MS = 1000

/** No beats for this long → the WebRTC link is presumed dead. */
export const TRANSPORT_STALE_MS = 6000

/** First gap between transport rejoin attempts, while visible. */
export const RECONNECT_COOLDOWN_MS = 10000

/** Slower retries while asleep — the radio is usually off. */
export const HIDDEN_RECONNECT_COOLDOWN_MS = 45000

/**
 * Each failed rejoin doubles the wait, up to these ceilings. A flat retry
 * hammers the public signalling relays — which rate-limit, and then cause the
 * very failure being retried against. Visible stays responsive because someone
 * is watching the screen; hidden can afford to be patient.
 */
export const MAX_RECONNECT_COOLDOWN_MS = 60000

/** Ceiling on the rejoin backoff while the page is hidden. */
export const MAX_HIDDEN_RECONNECT_COOLDOWN_MS = 300000
