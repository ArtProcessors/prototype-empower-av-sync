import type { SyncSession } from '../core/session'
import type { SyncSessionState } from '../core/session-state'
import type { SyncState } from '../transport/sync-controller'

/** What every view needs: the current snapshot, and the actions on it. */
export interface ViewProps {
  /** Current session state. */
  state: SyncSessionState
  /** The session's actions. Stable for the page's lifetime. */
  session: SyncSession
}

/**
 * A view that only renders inside an active session, so the transport is
 * narrowed once by the router rather than re-asserted in each view.
 */
export interface SessionViewProps extends ViewProps {
  /** Live transport state; non-null by construction. */
  transport: SyncState
}
