import { DebugPanel } from './DebugPanel'
import { DiagnosticsPanel } from './DiagnosticsPanel'
import { FollowerStatus } from './FollowerStatus'
import { KeepAwakeOption } from './KeepAwakeOption'
import { SessionTopBar } from './SessionTopBar'
import type { SessionViewProps } from '../view-props'

/** The listener's screen: live drift from the screen, plus session controls. */
export function FollowerView({ state, session, transport }: SessionViewProps) {
  return (
    <main className="wrap">
      <SessionTopBar
        role={transport.role}
        roomCode={transport.roomCode}
        onLeave={() => session.leave()}
      />

      <KeepAwakeOption state={state} session={session} />

      <p className="muted">
        Put on headphones — your audio is kept in sync with the screen's video.
        The big number is your live drift from the screen.
      </p>

      <FollowerStatus
        screenOnline={transport.screenOnline}
        correction={state.correction}
      />

      <DebugPanel state={state} session={session} transport={transport} />
      <DiagnosticsPanel />
    </main>
  )
}
