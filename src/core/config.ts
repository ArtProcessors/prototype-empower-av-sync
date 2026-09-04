/**
 * Session policy: the timings, the room-code rules, the storage keys and the
 * drift bands.
 *
 * These are process-wide rather than per-session — there is one app per page —
 * so they are a write-once override read at call time, the same shape as
 * `transport/transport-config.ts`. Nothing in this repo calls
 * {@link configureSession}, so the defaults below are what runs; a host
 * embedding the core changes them once at start-up.
 */
import {
  BEAT_FRESH_MS,
  CORRECT_MS,
  HIDDEN_RECONNECT_COOLDOWN_MS,
  MAX_HIDDEN_RECONNECT_COOLDOWN_MS,
  MAX_RECONNECT_COOLDOWN_MS,
  RECONNECT_COOLDOWN_MS,
  TRANSPORT_STALE_MS,
  WATCHDOG_MS,
} from './timing'

/** How often the session does things, and how long it waits before giving up. */
export interface SessionTiming {
  /** Correction loop period, in ms. */
  correctMs: number
  /** Ignore beats older than this when steering, in ms. */
  beatFreshMs: number
  /** How often the transport watchdog checks for beats, in ms. */
  watchdogMs: number
  /** No beats for this long and the WebRTC link is presumed dead, in ms. */
  transportStaleMs: number
  /** First gap between rejoin attempts while visible, in ms. */
  reconnectCooldownMs: number
  /** First gap between rejoin attempts while hidden, in ms. */
  hiddenReconnectCooldownMs: number
  /** Ceiling on the rejoin backoff while visible, in ms. */
  maxReconnectCooldownMs: number
  /** Ceiling on the rejoin backoff while hidden, in ms. */
  maxHiddenReconnectCooldownMs: number
}

/** What a room code is made of and what counts as one. */
export interface RoomCodePolicy {
  /** Characters codes are generated from. */
  alphabet: string
  /** How many characters a generated code has. */
  length: number
  /** Shortest code worth attempting a join with. */
  minLength: number
  /** Longest code accepted from a text field. */
  maxLength: number
}

/** Where the session's small persisted values live. */
export interface SessionStorageKeys {
  /** `sessionStorage` key for the room to re-offer after a reload. */
  rejoinRoom: string
  /** `localStorage` key for the keep-awake preference. */
  keepAwake: string
}

/**
 * Where a drift reading stops being good and starts being a problem, in ms.
 * Policy rather than styling: a host picks its own colours, but "how far out is
 * too far" is the same question whatever it looks like.
 */
export interface DriftBands {
  /** Below this magnitude, drift reads as good. */
  goodMs: number
  /** Below this magnitude, drift reads as a warning; above it, as bad. */
  warnMs: number
}

/** Everything a session's behaviour can be tuned by. */
export interface SessionConfig {
  /** How often the session does things, and how long it waits. */
  timing: SessionTiming
  /** What a room code is made of and what counts as one. */
  roomCode: RoomCodePolicy
  /** Where the session's small persisted values live. */
  storage: SessionStorageKeys
  /** Where drift stops being good and starts being a problem. */
  drift: DriftBands
}

/** Some or all of the policy, for {@link configureSession}. */
export interface SessionConfigOverrides {
  /** Timing overrides, merged over the defaults. */
  timing?: Partial<SessionTiming>
  /** Room-code overrides, merged over the defaults. */
  roomCode?: Partial<RoomCodePolicy>
  /** Storage-key overrides, merged over the defaults. */
  storage?: Partial<SessionStorageKeys>
  /** Drift-band overrides, merged over the defaults. */
  drift?: Partial<DriftBands>
}

const defaults: SessionConfig = {
  timing: {
    correctMs: CORRECT_MS,
    beatFreshMs: BEAT_FRESH_MS,
    watchdogMs: WATCHDOG_MS,
    transportStaleMs: TRANSPORT_STALE_MS,
    reconnectCooldownMs: RECONNECT_COOLDOWN_MS,
    hiddenReconnectCooldownMs: HIDDEN_RECONNECT_COOLDOWN_MS,
    maxReconnectCooldownMs: MAX_RECONNECT_COOLDOWN_MS,
    maxHiddenReconnectCooldownMs: MAX_HIDDEN_RECONNECT_COOLDOWN_MS,
  },
  roomCode: {
    // Ambiguous glyphs (0/O, 1/I) are left out so a room code read off a
    // screen can't be mistyped.
    alphabet: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
    length: 4,
    minLength: 3,
    maxLength: 8,
  },
  storage: {
    rejoinRoom: 'empower.rejoinRoom',
    keepAwake: 'empower-keep-awake',
  },
  drift: {
    goodMs: 50,
    warnMs: 150,
  },
}

let current: SessionConfig = defaults

/**
 * Override some or all of the session policy. Call before starting a session —
 * values are read when they are used, not cached at import, but a change
 * mid-session would move the ground under a running loop.
 */
export function configureSession(overrides: SessionConfigOverrides): void {
  current = {
    timing: { ...current.timing, ...overrides.timing },
    roomCode: { ...current.roomCode, ...overrides.roomCode },
    storage: { ...current.storage, ...overrides.storage },
    drift: { ...current.drift, ...overrides.drift },
  }
}

/** The session policy in force right now. */
export function sessionConfig(): SessionConfig {
  return current
}
