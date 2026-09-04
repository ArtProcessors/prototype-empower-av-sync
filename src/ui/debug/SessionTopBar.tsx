import type { Role } from '../../transport/sync-controller'

/** The room banner and Leave button shown at the top of an active session. */
export function SessionTopBar({
  role,
  roomCode,
  onLeave,
}: {
  /** Which end of the star this device is; picks the label and code size. */
  role: Role
  /** Room code peers meet in. */
  roomCode: string
  /** Called when the user asks to leave the session. */
  onLeave: () => void
}) {
  const screen = role === 'screen'

  return (
    <header className="topbar">
      <div>
        <b>{screen ? '📺 Screen' : '🎧 Listener'}</b>{' '}
        <span className="muted">· room </span>
        <code className={screen ? 'roomcode big' : 'roomcode'}>
          {roomCode}
        </code>
      </div>
      <button className="ghost" onClick={onLeave}>
        Leave
      </button>
    </header>
  )
}
