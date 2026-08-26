import type { SyncApi } from '../hooks/useSync'
import { DebugPanel } from './DebugPanel'
import { DiagnosticsPanel } from './DiagnosticsPanel'
import { KeepAwakeOption } from './KeepAwakeOption'
import { QRCode } from './QRCode'

/** The leader's screen: the looping video plus the code listeners join with. */
export function ScreenView({ api }: { api: SyncApi }) {
  const syncState = api.state!
  const joinUrl = `${window.location.origin}${window.location.pathname}?room=${syncState.roomCode}`
  const nowPlaying =
    api.videos.find(video => video.id === api.videoId)?.label ?? api.videoId

  return (
    <main className="wrap">
      <header className="topbar">
        <div>
          <b>📺 Screen</b> <span className="muted">· room </span>
          <code className="roomcode big">{syncState.roomCode}</code>
        </div>
        <button className="ghost" onClick={() => api.leave()}>
          Leave
        </button>
      </header>

      <p className="muted small">Playing: {nowPlaying}</p>
      <KeepAwakeOption api={api} />

      {/* The persistent looping video is mounted here. */}
      <div className="video-wrap" ref={api.mountScreenVideo} />

      <div className="share">
        <QRCode value={joinUrl} size={240} />
        <div>
          <p className="muted small">
            Scan to join as a listener (audio syncs to this video):
          </p>
          <p className="muted small">{joinUrl}</p>
          <p>
            Listeners: <b>{syncState.peerCount}</b>
          </p>
        </div>
      </div>

      <DebugPanel api={api} />
      <DiagnosticsPanel />
    </main>
  )
}
