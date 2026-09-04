import { joinUrl } from '../../core/join-link'
import { withUiMode } from '../ui-mode'
import { DebugPanel } from './DebugPanel'
import { DiagnosticsPanel } from './DiagnosticsPanel'
import { KeepAwakeOption } from './KeepAwakeOption'
import { QRCode } from '../QRCode'
import { SessionTopBar } from './SessionTopBar'
import type { SessionViewProps } from '../view-props'

/** The leader's screen: the looping video plus the code listeners join with. */
export function ScreenView({
  state,
  session,
  transport,
  mountScreenVideo,
}: SessionViewProps & {
  /** Ref callback that mounts the persistent screen video into a container. */
  mountScreenVideo: (container: HTMLElement | null) => void
}) {
  // Marked as debug so a phone scanning this QR lands in the debug follower
  // rather than the consumer demo — the two are different pixels over the
  // same session, and a sleep test wants the instrumented one.
  const listenerUrl = withUiMode(joinUrl(transport.roomCode), 'debug')

  return (
    <main className="wrap">
      <SessionTopBar
        role={transport.role}
        roomCode={transport.roomCode}
        onLeave={() => session.leave()}
      />

      <p className="muted small">Playing: {state.media.selected.label}</p>
      <KeepAwakeOption state={state} session={session} />

      {/* The persistent looping video is mounted here. */}
      <div className="video-wrap" ref={mountScreenVideo} />

      <div className="share">
        <QRCode value={listenerUrl} size={240} />
        <div>
          <p className="muted small">
            Scan to join as a listener (audio syncs to this video):
          </p>
          <p className="muted small">{listenerUrl}</p>
          <p>
            Listeners: <b>{transport.peerCount}</b>
          </p>
          {!transport.signallingOnline && (
            <p className="connecting">
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
