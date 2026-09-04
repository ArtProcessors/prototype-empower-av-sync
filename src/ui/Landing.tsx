import { useState } from 'react'

import { roomCodeFromSearch } from '../core/join-link'
import { readRejoinRoom } from '../core/rejoin-memory'
import { isRoomCodeAcceptable, maxRoomCodeLength } from '../core/room-code'
import { STRATEGY } from '../transport/config'
import { DiagnosticsPanel } from './DiagnosticsPanel'
import { KeepAwakeOption } from './KeepAwakeOption'
import type { ViewProps } from './view-props'

/**
 * The entry screen: lead a room as the screen, or join an existing one as a
 * listener.
 */
export function Landing({ state, session }: ViewProps) {
  // Prefill from ?room=, else the room we were in before a reload/tab-discard.
  // An explicit but blank `?room=` still wins over the remembered room.
  const rejoinRoom = readRejoinRoom()
  const [code, setCode] = useState(
    roomCodeFromSearch(window.location.search) ?? rejoinRoom ?? '',
  )
  const connecting = state.phase === 'connecting'

  return (
    <main className="wrap">
      <h1>Empower — A/V Sync</h1>
      <p className="muted">
        Fixed screen leader · followers' audio synced to the video clock · over
        WebRTC ({STRATEGY})
      </p>

      {state.error && <p className="error">⚠ {state.error}</p>}

      {rejoinRoom && !state.error && (
        <div className="card">
          <p>
            🎧 You were listening in room <code>{rejoinRoom}</code>. Reconnect
            to resume synced audio.
          </p>
          <button
            disabled={connecting}
            onClick={() => session.join(rejoinRoom)}
          >
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
            value={state.media.selectedId}
            onChange={event => session.selectVideo(event.target.value)}
          >
            {state.media.options.map(video => (
              <option key={video.id} value={video.id}>
                {video.label}
              </option>
            ))}
          </select>
        </label>
        <KeepAwakeOption state={state} session={session} />
        <button disabled={connecting} onClick={() => session.becomeScreen()}>
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
          // Upper-case only, deliberately not the full normalisation: trimming
          // as the user types would fight the cursor. Trimming is
          // `isRoomCodeAcceptable`'s and the session's job.
          onChange={event => setCode(event.target.value.toUpperCase())}
          placeholder="e.g. K7QF"
          maxLength={maxRoomCodeLength()}
          autoCapitalize="characters"
          autoCorrect="off"
        />
        <KeepAwakeOption state={state} session={session} />
        <button
          disabled={connecting || !isRoomCodeAcceptable(code)}
          onClick={() => session.join(code)}
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
