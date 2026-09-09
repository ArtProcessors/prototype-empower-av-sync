import { useEffect, useId, useState } from 'react'

import { isRoomCodeAcceptable, maxRoomCodeLength } from '../../core/room-code'
import type { SyncSessionState } from '../../core/session-state'
import type { CorrectionMode } from '../../media/audio-sync-controller'
import { classNames } from '../class-names'
import type { ViewProps } from '../view-props'
import styles from './demo.module.css'
import { followerStatus } from './demo-status'
import { DemoStatusDisplay } from './DemoStatusDisplay'
import { DemoTranscript } from './DemoTranscript'
import { readTranscriptPref, writeTranscriptPref } from './transcript-pref'
import { transcriptExists, useTranscript } from './useTranscript'

/**
 * How long a recoverable problem may persist before the refresh button is
 * promoted from a quiet footer link to the obvious thing to do.
 *
 * Long enough that the watchdog's own rejoin — which usually lands inside a
 * few seconds — gets to fix things without anyone being told to intervene,
 * short enough that a listener is not left holding a dead phone.
 */
const STUCK_AFTER_MS = 20_000

/**
 * Whether a problem has been going on long enough to stop looking transient.
 *
 * Resets whenever the trouble clears, so a link that flaps and recovers never
 * escalates — only one that stays broken does.
 */
function useStuckFor(troubled: boolean): boolean {
  const [stuck, setStuck] = useState(false)

  useEffect(() => {
    if (!troubled) {
      setStuck(false)

      return
    }

    const timer = setTimeout(() => setStuck(true), STUCK_AFTER_MS)

    return () => clearTimeout(timer)
  }, [troubled])

  return stuck
}

/**
 * Whether this device's audio is actually moving, and so has a position the
 * words can be read off.
 *
 * `idle` and `syncing` both mean there is no soundtrack running yet — one
 * before the first target arrives, the other while it is still being fetched —
 * and the position they report is either stale or zero. Every other mode is
 * the corrector steering audio that is playing, however hard it is having to
 * work at it.
 */
function isPlaying(mode: CorrectionMode): boolean {
  return mode === 'locked' || mode === 'nudge' || mode === 'seek'
}

/**
 * Whether the screen has been heard from at all since this device started
 * listening.
 *
 * Latched here rather than read off the transport because a watchdog rejoin
 * swaps in a fresh one, whose `lastBeatAt` starts back at 0 — see the note in
 * `demo-status.ts`. Cleared when the session ends, so a later join that never
 * connects is described as a first attempt rather than a lost one.
 */
function useScreenContact(state: SyncSessionState): boolean {
  const [hadContact, setHadContact] = useState(false)
  const screenOnline = state.transport?.screenOnline ?? false

  useEffect(() => {
    if (state.phase === 'landing') {
      setHadContact(false)
    } else if (screenOnline) {
      setHadContact(true)
    }
  }, [state.phase, screenOnline])

  return hadContact
}

type Props = ViewProps & {
  /**
   * Room this device was invited to, from the scanned link or the room it was
   * in before a reload. `null` when it arrived with no invitation at all, and
   * `''` when the link carried an explicitly empty room; both mean the code
   * has to be typed.
   */
  invitedRoom: string | null
  /** Called when this device should lead as the screen instead. */
  onSetUpScreen: () => void
}

/**
 * The listener's screen: one ring to press, then one line of status.
 *
 * Starting has to happen inside a tap — that gesture is what unlocks audio on
 * iOS — so the status ring is a button until it is pressed, and the same ring
 * reports whatever the session is doing afterwards. It is the fixed point of
 * the view, which is why everything else hangs above or below it rather than
 * sharing a column with it.
 */
export function DemoFollowerView({
  state,
  session,
  invitedRoom,
  onSetUpScreen,
}: Props) {
  const [code, setCode] = useState(invitedRoom ?? '')
  const [captions, setCaptions] = useState(readTranscriptPref)
  const hintId = useId()
  const hadContact = useScreenContact(state)
  const status = followerStatus(state, hadContact)
  const stuck = useStuckFor(status.recoverable)
  const started = state.phase !== 'landing'
  const roomCode = state.transport?.roomCode ?? null

  // What the screen says it is playing, which is what decides whether there
  // are words to offer at all — not what this device once chose, and not the
  // catalogue's default.
  const mediaId = state.transport?.latestBeat?.mediaId ?? null
  const transcript = useTranscript(mediaId, captions)

  const toggleCaptions = () => {
    const next = !captions

    setCaptions(next)
    writeTranscriptPref(next)
  }

  const display = (
    <DemoStatusDisplay status={status} waveform={session.waveform} />
  )

  return (
    <main className={classNames(styles.shell, styles.view)}>
      <div className={classNames(styles.centre, styles.anchored)}>
        <div className={styles.above}></div>

        {/* The same panel the rest of the session is read from, made tappable
            until it is started: "Ready" is a state, so the ring showing it is
            the thing to press, and a failed join reports itself in the same
            place rather than in a box above it.

            Named from the headline it is already showing, because the live
            region carrying that headline is not a role a name can be taken
            from — left to itself the button would have no name at all. What
            pressing it does is the hint below. */}
        {started ? (
          display
        ) : (
          <button
            className={styles.start}
            disabled={!isRoomCodeAcceptable(code)}
            aria-label={status.headline}
            aria-describedby={hintId}
            onClick={() => session.join(code)}
          >
            {display}
          </button>
        )}

        <div className={styles.below}>
          {/* Under the status, so the sentence saying whether this is working
              still comes first: the words are the thing you settle into once
              you know the audio is good. */}
          {captions && transcript && (
            <DemoTranscript
              transcript={transcript}
              timeMs={
                isPlaying(state.correction.mode)
                  ? state.localTime * 1000
                  : null
              }
            />
          )}

          {!started && (
            <p className={styles.hint} id={hintId}>
              Put your headphones on, then tap to start.
            </p>
          )}

          {!started && !invitedRoom && (
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Room code</span>
              <input
                value={code}
                // Upper-casing only, deliberately not the full normalisation:
                // trimming as someone types fights the cursor. The session
                // normalises on the way in.
                onChange={event => setCode(event.target.value.toUpperCase())}
                placeholder="e.g. K7QF"
                maxLength={maxRoomCodeLength()}
                autoCapitalize="characters"
                autoCorrect="off"
              />
            </label>
          )}

          {stuck && (
            <p className={classNames(styles.hint, styles.hintUrgent)}>
              Still stuck? Refresh to start over.
            </p>
          )}
        </div>
      </div>

      <footer
        className={classNames(styles.footer, roomCode && styles.hugSides)}
      >
        {roomCode && <span className={styles.room}>Room {roomCode}</span>}

        {/* Named on the button, not the picture: an icon-only control still
            has to say what it does, and the glyph is decoration. Offered
            only where there is something to show — a switch that silently
            does nothing on the videos with no transcript would be worse
            than not having one. */}
        {started && transcriptExists(mediaId) && (
          <button
            className={classNames(
              styles.ghost,
              styles.ghostIcon,
              captions && styles.ghostOn,
            )}
            aria-label="Transcript"
            aria-pressed={captions}
            onClick={toggleCaptions}
          >
            <svg
              className={styles.ghostArt}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect width="18" height="14" x="3" y="5" rx="2" />
              <path d="M7 15h4" />
              <path d="M15 15h2" />
              <path d="M7 11h2" />
              <path d="M13 11h4" />
            </svg>
          </button>
        )}

        <div className={styles.footerActions}>
          <button
            className={classNames(
              styles.ghost,
              styles.ghostIcon,
              stuck && styles.ghostUrgent,
            )}
            aria-label="Refresh"
            onClick={() => window.location.reload()}
          >
            <svg
              className={styles.ghostArt}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
              <path d="M21 3v5h-5" />
            </svg>
          </button>

          {started && (
            <button
              className={classNames(styles.ghost, styles.ghostIcon)}
              aria-label="Stop"
              onClick={() => session.leave()}
            >
              <svg
                className={styles.ghostArt}
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <rect
                  x="6"
                  y="6"
                  width="12"
                  height="12"
                  rx="1.5"
                  fill="currentColor"
                />
              </svg>
            </button>
          )}

          {!started && !invitedRoom && (
            <button className={styles.ghost} onClick={onSetUpScreen}>
              Set up the screen
            </button>
          )}
        </div>
      </footer>
    </main>
  )
}
