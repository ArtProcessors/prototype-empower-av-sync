import { useEffect, useState } from 'react'

import { isRoomCodeAcceptable, maxRoomCodeLength } from '../../core/room-code'
import type { SyncSessionState } from '../../core/session-state'
import type { ViewProps } from '../view-props'
import { followerStatus } from './demo-status'
import { DemoStatusDisplay } from './DemoStatusDisplay'

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

/**
 * The listener's screen: one button to start, then one line of status.
 *
 * Starting has to happen inside a tap — that gesture is what unlocks audio on
 * iOS — so the button is the whole interface until it is pressed, and after
 * that the interface is whatever the session is currently doing.
 */
export function DemoFollowerView({
  state,
  session,
  invitedRoom,
  onSetUpScreen,
}: ViewProps & {
  /**
   * Room this device was invited to, from the scanned link or the room it was
   * in before a reload. `null` when it arrived with no invitation at all, and
   * `''` when the link carried an explicitly empty room; both mean the code
   * has to be typed.
   */
  invitedRoom: string | null
  /** Called when this device should lead as the screen instead. */
  onSetUpScreen: () => void
}) {
  const [code, setCode] = useState(invitedRoom ?? '')
  const hadContact = useScreenContact(state)
  const status = followerStatus(state, hadContact)
  const stuck = useStuckFor(status.recoverable)
  const started = state.phase !== 'landing'
  const roomCode = state.transport?.roomCode ?? null

  return (
    <main className="demo demo-follower">
      <div className="demo-center">
        {started ? (
          <DemoStatusDisplay status={status} />
        ) : (
          <>
            {status.tone === 'error' && (
              <p className="demo-error" role="alert">
                {status.headline}
                {status.detail && ` — ${status.detail}`}
              </p>
            )}

            {!invitedRoom && (
              <label className="demo-field">
                <span className="demo-field-label">Room code</span>
                <input
                  value={code}
                  // Upper-casing only, deliberately not the full
                  // normalisation: trimming as someone types fights the
                  // cursor. The session normalises on the way in.
                  onChange={event => setCode(event.target.value.toUpperCase())}
                  placeholder="e.g. K7QF"
                  maxLength={maxRoomCodeLength()}
                  autoCapitalize="characters"
                  autoCorrect="off"
                />
              </label>
            )}

            <button
              className="demo-action"
              disabled={!isRoomCodeAcceptable(code)}
              onClick={() => session.join(code)}
            >
              Listen
            </button>

            <p className="demo-hint">
              Put your headphones on, then tap to start.
            </p>
          </>
        )}

        {stuck && (
          <p className="demo-hint demo-hint-urgent">
            Still stuck? Refresh to start over.
          </p>
        )}
      </div>

      <footer className="demo-footer">
        {roomCode && <span className="demo-room">Room {roomCode}</span>}

        <button
          className={stuck ? 'demo-ghost demo-ghost-urgent' : 'demo-ghost'}
          onClick={() => window.location.reload()}
        >
          Refresh
        </button>

        {started && (
          <button className="demo-ghost" onClick={() => session.leave()}>
            Stop
          </button>
        )}

        {!started && !invitedRoom && (
          <button className="demo-ghost" onClick={onSetUpScreen}>
            Set up the screen
          </button>
        )}
      </footer>
    </main>
  )
}
