import { useState } from 'react'

import { readRejoinRoom, type SyncApi } from '../hooks/useSync'
import { STRATEGY } from '../transport/config'
import { DiagnosticsPanel } from './DiagnosticsPanel'
import { KeepAwakeOption } from './KeepAwakeOption'

const MIN_ROOM_CODE_LENGTH = 3
const MAX_ROOM_CODE_LENGTH = 8

/**
 * The entry screen: lead a room as the screen, or join an existing one as a
 * listener.
 */
export function Landing({ api }: { api: SyncApi }) {
  const params = new URLSearchParams(window.location.search)
  // Prefill from ?room=, else the room we were in before a reload/tab-discard.
  const rejoinRoom = readRejoinRoom()
  const [code, setCode] = useState(
    params.get('room')?.toUpperCase() ?? rejoinRoom ?? '',
  )
  const connecting = api.phase === 'connecting'

  return (
    <main className="wrap">
      <h1>Empower — A/V Sync</h1>
      <p className="muted">
        Fixed screen leader · followers' audio synced to the video clock · over
        WebRTC ({STRATEGY})
      </p>

      {api.error && <p className="error">⚠ {api.error}</p>}

      {rejoinRoom && !api.error && (
        <div className="card">
          <p>
            🎧 You were listening in room <code>{rejoinRoom}</code>. Reconnect
            to resume synced audio.
          </p>
          <button disabled={connecting} onClick={() => api.join(rejoinRoom)}>
            {connecting ? 'Reconnecting…' : `🎧 Rejoin ${rejoinRoom}`}
          </button>
        </div>
      )}

      <div className="card">
        <h2>Be the screen</h2>
        <p className="muted">
          Plays the looping video and drives everyone's audio. Use one device
          as the display.
        </p>
        <label className="field">
          <span className="muted small">Video</span>
          <select
            value={api.videoId}
            onChange={event => api.setVideoId(event.target.value)}
          >
            {api.videos.map(video => (
              <option key={video.id} value={video.id}>
                {video.label}
              </option>
            ))}
          </select>
        </label>
        <KeepAwakeOption api={api} />
        <button disabled={connecting} onClick={() => api.becomeScreen()}>
          {connecting ? 'Starting…' : '📺 Be the screen'}
        </button>
      </div>

      <div className="card">
        <h2>Join as listener</h2>
        <p className="muted">
          Enter the screen's room code; your audio locks to the video.
        </p>
        <input
          value={code}
          onChange={event => setCode(event.target.value.toUpperCase())}
          placeholder="e.g. K7QF"
          maxLength={MAX_ROOM_CODE_LENGTH}
          autoCapitalize="characters"
          autoCorrect="off"
        />
        <KeepAwakeOption api={api} />
        <button
          disabled={connecting || code.trim().length < MIN_ROOM_CODE_LENGTH}
          onClick={() => api.join(code)}
        >
          {connecting ? 'Connecting…' : '🎧 Join (tap to enable audio)'}
        </button>
        <p className="hint">
          The tap unlocks audio for this device (needed on iOS).
        </p>
      </div>

      {/*
        Also shown here so a log survives the round trip: if Chrome discards the
        tab mid-sleep, the reload lands on this screen and the log — restored
        from sessionStorage — is still readable.
      */}
      <DiagnosticsPanel />
    </main>
  )
}
