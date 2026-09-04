/**
 * The handful of values a host embedding this transport might need to repoint:
 * the Trystero namespace and the three Worker routes.
 *
 * They were module constants, which is fine for one app and useless for a
 * second. This is deliberately the smallest seam that fixes that — a
 * write-once override read at call time, not a dependency-injection layer.
 * Nothing in this repo calls {@link configureTransport}, so the defaults below
 * are what runs.
 */
import { ICE_PATH, PING_PATH, SIGNAL_PATH } from '../../shared/api-routes'

/** Endpoints and identifiers the transport resolves at call time. */
export interface TransportConfig {
  /** Trystero namespace — peers only meet other peers using the same id. */
  appId: string
  /** Worker route that mints a credential pair for this client. */
  icePath: string
  /** Worker route used as a cheap network-liveness probe. */
  pingPath: string
  /** Worker route the signalling WebSocket upgrades on. */
  signalPath: string
}

const defaults: TransportConfig = {
  appId: 'empower-av-sync-v1',
  icePath: ICE_PATH,
  pingPath: PING_PATH,
  signalPath: SIGNAL_PATH,
}

let current: TransportConfig = defaults

/**
 * Override some or all of the transport's endpoints. Call before joining a
 * room — values are read when a connection is opened, not cached at import.
 */
export function configureTransport(overrides: Partial<TransportConfig>): void {
  current = { ...current, ...overrides }
}

/** The endpoints in force right now. */
export function transportConfig(): TransportConfig {
  return current
}
