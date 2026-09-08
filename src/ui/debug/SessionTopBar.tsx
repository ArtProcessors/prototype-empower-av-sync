import type { Role } from '../../transport/sync-controller'
import { classNames } from '../class-names'
import styles from './debug.module.css'

type Props = {
  /** Which end of the star this device is; picks the label and code size. */
  role: Role
  /** Room code peers meet in. */
  roomCode: string
  /** Called when the user asks to leave the session. */
  onLeave: () => void
}

/** The room banner and Leave button shown at the top of an active session. */
export function SessionTopBar({ role, roomCode, onLeave }: Props) {
  const screen = role === 'screen'

  return (
    <header className={styles.topbar}>
      <div>
        <b>{screen ? '📺 Screen' : '🎧 Listener'}</b>{' '}
        <span className={styles.muted}>· room </span>
        <code
          className={classNames(styles.roomcode, screen && styles.roomcodeBig)}
        >
          {roomCode}
        </code>
      </div>
      <button className={styles.ghost} onClick={onLeave}>
        Leave
      </button>
    </header>
  )
}
