/**
 * What a listener is told, in one line, derived from the session snapshot.
 *
 * The debug UI shows the raw instrument — drift in ms, correction mode,
 * playback rate — and expects a developer to read it. A visitor holding a
 * phone needs the opposite: one sentence saying whether this is working, and
 * whether they should do anything about it. Deriving that in a pure function
 * keeps the decision in one readable place rather than smeared through JSX,
 * and keeps the wording out of reach of a re-render.
 *
 * The bands themselves are not re-invented here: `core/drift.ts` owns "how far
 * out is too far", and this module only names it.
 */
import { driftBand } from '../../core/drift'
import type { SyncSessionState } from '../../core/session-state'

/**
 * How a status should read, calmest first. Maps to a colour and, for `busy`,
 * a spinner — see the `.demo-indicator` rules in `styles.css`.
 */
export type DemoTone = 'idle' | 'busy' | 'good' | 'warn' | 'error'

/** One line of consumer-facing status. */
export interface DemoStatus {
  /** How it should read: picks the colour and whether to spin. */
  tone: DemoTone
  /** Short headline, shown large. */
  headline: string
  /** Supporting sentence, or `null` when the headline says it all. */
  detail: string | null
  /**
   * Whether this is a state the listener may need to escape by hand. The view
   * uses it to start the "still stuck?" timer that promotes the refresh
   * button — a transient reconnect should not shout, a permanent one should.
   */
  recoverable: boolean
}

/**
 * The status a listener sees for `state`.
 *
 * Ordered by what most needs saying: a hard error first, then whether we are
 * even connected, then whether the audio has arrived, and only then how well
 * it is tracking.
 *
 * @param state the session snapshot to describe
 * @param hadContact whether the screen has been heard from at all this visit
 */
export function followerStatus(
  state: SyncSessionState,
  hadContact: boolean,
): DemoStatus {
  if (state.error) {
    return {
      tone: 'error',
      headline: 'Something went wrong',
      detail: state.error,
      recoverable: true,
    }
  }

  if (state.phase === 'connecting') {
    return {
      tone: 'busy',
      headline: 'Connecting…',
      detail: 'Looking for the screen.',
      recoverable: false,
    }
  }

  const { transport } = state

  if (state.phase !== 'active' || !transport) {
    return {
      tone: 'idle',
      headline: 'Ready',
      detail: null,
      recoverable: false,
    }
  }

  if (!transport.screenOnline) {
    // "Waiting" and "reconnecting" are different promises to the person
    // holding the phone: one says the screen has not started yet, the other
    // that a working link dropped. `transport.lastBeatAt` cannot tell them
    // apart — the watchdog installs a *fresh* transport to rejoin with, and a
    // fresh one starts at 0, so the very reconnect this describes would reset
    // it. Hence the latch, which the caller holds across those swaps.
    return {
      tone: 'warn',
      headline: hadContact ? 'Reconnecting…' : 'Waiting for the screen…',
      detail: hadContact
        ? 'Lost contact with the screen. Trying again automatically.'
        : 'Make sure the video on the big screen is playing.',
      recoverable: true,
    }
  }

  // Both spellings of "the soundtrack is not here yet": the corrector reports
  // `syncing` while it waits, and the engine reports it while a long clip's
  // first window is still being fetched and decoded.
  if (
    state.correction.mode === 'syncing' ||
    state.audio.engine === 'syncing'
  ) {
    return {
      tone: 'busy',
      headline: 'Loading audio…',
      detail: 'Downloading the soundtrack for this video.',
      recoverable: false,
    }
  }

  if (state.correction.mode === 'idle') {
    return {
      tone: 'busy',
      headline: 'Starting audio…',
      detail: null,
      recoverable: false,
    }
  }

  // A `warn` band is the corrector doing its job and is deliberately not
  // surfaced: a message that flickers every time drift crosses 50 ms teaches
  // people to distrust the one that matters.
  if (driftBand(state.correction.driftMs) === 'bad') {
    return {
      tone: 'warn',
      headline: 'Re-syncing…',
      detail: 'Pulling your audio back in line with the screen.',
      recoverable: true,
    }
  }

  return {
    tone: 'good',
    headline: 'In sync',
    detail: 'Your audio is locked to the screen.',
    recoverable: false,
  }
}
