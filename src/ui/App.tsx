import { useSync } from '../hooks/useSync'
import { FollowerView } from './FollowerView'
import { Landing } from './Landing'
import { ScreenView } from './ScreenView'

/** Root view: routes to the screen, listener, or landing view by phase. */
export function App() {
  const api = useSync()

  if (api.phase === 'active' && api.state) {
    return api.state.role === 'screen' ? (
      <ScreenView api={api} />
    ) : (
      <FollowerView api={api} />
    )
  }

  return <Landing api={api} />
}
