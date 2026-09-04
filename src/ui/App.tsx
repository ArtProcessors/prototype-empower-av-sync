import { useSync } from '../hooks/useSync'
import { FollowerView } from './FollowerView'
import { Landing } from './Landing'
import { ScreenView } from './ScreenView'

/** Root view: routes to the screen, listener, or landing view by phase. */
export function App() {
  const { state, session, mountScreenVideo } = useSync()

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
