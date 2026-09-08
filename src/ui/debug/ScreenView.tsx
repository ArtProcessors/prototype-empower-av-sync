import { joinUrl } from '../../core/join-link'
import { classNames } from '../class-names'
import { withUiMode } from '../ui-mode'
import styles from './debug.module.css'
import { DebugPanel } from './DebugPanel'
import { DiagnosticsPanel } from './DiagnosticsPanel'
import { KeepAwakeOption } from './KeepAwakeOption'
import { QRCode } from '../QRCode'
import { SessionTopBar } from './SessionTopBar'
import type { SessionViewProps } from '../view-props'

type Props = SessionViewProps & {
  /** Ref callback that mounts the persistent screen video into a container. */
  mountScreenVideo: (container: HTMLElement | null) => void
}

/** The leader's screen: the looping video plus the code listeners join with. */
export function ScreenView({
  state,
  session,
  transport,
  mountScreenVideo,
}: Props) {
  // Marked as debug so a phone scanning this QR lands in the debug follower
  // rather than the consumer demo — the two are different pixels over the
  // same session, and a sleep test wants the instrumented one.
  const listenerUrl = withUiMode(joinUrl(transport.roomCode), 'debug')

  return (
    <main className={styles.wrap}>
      <SessionTopBar
        role={transport.role}
        roomCode={transport.roomCode}
        onLeave={() => session.leave()}
      />

      <p className={classNames(styles.muted, styles.small)}>
        Playing: {state.media.selected.label}
      </p>
      <KeepAwakeOption state={state} session={session} />

      {/* The persistent looping video is mounted here. */}
      <div className={styles.videoWrap} ref={mountScreenVideo} />

      <div className={styles.share}>
        <QRCode value={listenerUrl} size={240} />
        <div>
          <p className={classNames(styles.muted, styles.small)}>
            Scan to join as a listener (audio syncs to this video):
          </p>
          <p className={classNames(styles.muted, styles.small)}>
            {listenerUrl}
          </p>
          <p>
            Listeners: <b>{transport.peerCount}</b>
          </p>
          {!transport.signallingOnline && (
            <p className={styles.connecting}>
              ⚠️ Signalling is down — reconnecting. Listeners already connected
              are unaffected, but nobody new can join until this clears.
            </p>
          )}
        </div>
      </div>

      <DebugPanel state={state} session={session} transport={transport} />
      <DiagnosticsPanel />
    </main>
  )
}
