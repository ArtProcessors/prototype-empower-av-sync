import { useState } from 'react'

import { readRejoinRoom } from '../../core/rejoin-memory'
import { isRoomCodeAcceptable, maxRoomCodeLength } from '../../core/room-code'
import { classNames } from '../class-names'
import { roomToJoin } from '../launch-intent'
import styles from './debug.module.css'
import { DiagnosticsPanel } from './DiagnosticsPanel'
import { KeepAwakeOption } from './KeepAwakeOption'
import type { ViewProps } from '../view-props'

type Props = ViewProps & {
  /** Why the launch URL's video was not honoured, if it named one. */
  launchError: string | null
}

/**
 * The entry screen: lead a room as the screen, or join an existing one as a
 * listener.
 */
export function Landing({ state, session, launchError }: Props) {
  // Read fresh on every render, not frozen at mount: a deliberate leave clears
  // it, and this screen is exactly where that lands.
  const rejoinRoom = readRejoinRoom()
  // Prefill from ?room=, else the room we were in before a reload/tab-discard
  // — `roomToJoin` holds that precedence, including the blank-`?room=` case.
  const [code, setCode] = useState(() => roomToJoin() ?? '')
  const connecting = state.phase === 'connecting'

  return (
    <main className={styles.wrap}>
      <h1>Empower — A/V Sync</h1>
      <p className={styles.muted}>
        Fixed screen leader · followers' audio synced to the video clock · over
        WebRTC
      </p>

      {state.error && <p className={styles.error}>⚠ {state.error}</p>}

      {launchError && <p className={styles.error}>⚠ {launchError}</p>}

      {rejoinRoom && !state.error && (
        <div className={styles.card}>
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

      <div className={styles.card}>
        <h2>Be the screen</h2>
        <p className={styles.muted}>
          Plays the looping video and drives everyone's audio. Use one device
          as the display.
        </p>
        <label className={styles.field}>
          <span className={classNames(styles.muted, styles.small)}>Video</span>
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

      <div className={styles.card}>
        <h2>Join as listener</h2>
        <p className={styles.muted}>
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
        <p className={styles.hint}>
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
