import type { SyncBinding } from '../../hooks/useSync'
import { useLaunchVideo } from '../useLaunchVideo'
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
  // The launch link works here too: adding `&debug=1` to a kiosk URL to see
  // what a display is doing should not quietly change which video it plays.
  // Only the error is passed on — the landing's picker stays, since being
  // able to override the link is what this UI is for.
  const launch = useLaunchVideo({ state, session })

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

  return <Landing state={state} session={session} launchError={launch.error} />
}
