import type { SyncBinding } from '../../hooks/useSync'
import { FollowerView } from './FollowerView'
import { Landing } from './Landing'
import { ScreenView } from './ScreenView'

/**
 * The instrumented UI the spike was built with: video picker, room code entry,
 * live drift readout, sync-state rows and the connection log.
 *
 * Kept as the development instrument now that `DemoApp` covers the
 * consumer-facing case — reached with `?debug=1`. Everything diagnostic lives
 * here, so the demo can stay free of it.
 */
export function DebugApp({ state, session, mountScreenVideo }: SyncBinding) {
  // Narrowed once here so the session views can take a non-null transport
  // rather than each re-asserting what this branch already established.
  if (state.phase === 'active' && state.transport) {
    return state.transport.role === 'screen' ? (
      <ScreenView
        state={state}
        session={session}
        transport={state.transport}
        mountScreenVideo={mountScreenVideo}
      />
    ) : (
      <FollowerView
        state={state}
        session={session}
        transport={state.transport}
      />
    )
  }

  return <Landing state={state} session={session} />
}
