import type { SyncApi } from '../hooks/useSync'
import { DebugPanel } from './DebugPanel'
import { DiagnosticsPanel } from './DiagnosticsPanel'
import { driftClassName } from './drift'
import { KeepAwakeOption } from './KeepAwakeOption'

/** The listener's screen: live drift from the screen, plus session controls. */
export function FollowerView({ api }: { api: SyncApi }) {
  const syncState = api.state!
  const driftMs = api.correction.driftMs

  return (
    <main className="wrap">
      <header className="topbar">
        <div>
          <b>🎧 Listener</b> <span className="muted">· room </span>
          <code className="roomcode">{syncState.roomCode}</code>
        </div>
        <button className="ghost" onClick={() => api.leave()}>
          Leave
        </button>
      </header>

      <KeepAwakeOption api={api} />

      <p className="muted">
        Put on headphones — your audio is kept in sync with the screen's video.
        The big number is your live drift from the screen.
      </p>

      {!syncState.screenOnline ? (
        <div className="connecting">
          Waiting for the screen… (no sync beats yet)
        </div>
      ) : api.correction.mode === 'syncing' ? (
        <div className="connecting">
          Syncing audio… (downloading the soundtrack)
        </div>
      ) : (
        <div className={`drift-hero ${driftClassName(driftMs)}`}>
          <div className="drift-num">
            {driftMs >= 0 ? '+' : ''}
            {driftMs.toFixed(0)}
            <span className="drift-unit"> ms</span>
          </div>
          <div className="muted small">
            {api.correction.mode} · rate {api.correction.rate.toFixed(3)}
          </div>
        </div>
      )}

      <DebugPanel api={api} />
      <DiagnosticsPanel />
    </main>
  )
}
