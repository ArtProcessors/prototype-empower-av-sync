import { useEffect, useRef } from 'react'

import { currentLaunchIntent, roomToJoin } from './launch-intent'
import type { ViewProps } from './view-props'

/**
 * Apply the launch URL's `?video=` and `?autostart=` to the page's session.
 *
 * Lives beside `launch-intent.ts` rather than in `src/hooks` because that is
 * the React binding for the *core*; this is one UI decision — what an operator
 * can set up from a link — expressed against the session's public actions.
 *
 * A kiosk URL is honoured the same way under `&debug=1` — one that silently
 * did nothing there would send whoever was debugging it hunting for a fault
 * that was never there. What debug does change is that the picker stays: being
 * able to override the link without editing it is most of the point of the
 * flag.
 */

/** What applying the launch intent left for a start screen to say. */
export interface LaunchVideoState {
  /**
   * Why the URL's video could not be honoured, or `null`. Surfaced rather
   * than swallowed: `selectVideo` drops an unknown id by design, which on an
   * operator's mistyped link would quietly put the 20-second test clip on a
   * wall.
   */
  error: string | null
  /**
   * Whether the operator still picks the video. False once the URL named a
   * real one — removing that step is the point of naming it — and true again
   * when the name was wrong, so there is a way on without editing the link.
   * Always true under `?debug=1`, where overriding the link is the job.
   */
  canSelectVideo: boolean
}

/**
 * Spend the launch intent on `session`, once per page load.
 *
 * @param props the session and its current snapshot
 */
export function useLaunchVideo({
  state,
  session,
}: ViewProps): LaunchVideoState {
  const intent = currentLaunchIntent()
  const requested = intent.video
  // True when the URL named a video this build has — or named none at all.
  // Checked against the session's own catalogue rather than `src/content`, so
  // it stays honest for a host that supplies a different one.
  const known =
    requested === null ||
    state.media.options.some(option => option.id === requested)
  // Latched rather than keyed on phase: the intent is spent once, so stopping
  // an autostarted screen lands on the start screen instead of immediately
  // being restarted by the URL it was opened on.
  const spent = useRef(false)

  useEffect(() => {
    if (spent.current) {
      return
    }

    spent.current = true

    if (requested !== null && known) {
      session.selectVideo(requested)
    }

    // An unknown name stops the autostart: a display coming up on the wrong
    // content is worse than one that comes up asking. `roomToJoin` is the
    // other guard — a device invited to a room is here to listen, and no URL
    // can unlock its audio for it.
    if (intent.autostart && known && roomToJoin(intent) === null) {
      void session.becomeScreen()
    }
  }, [intent, known, requested, session])

  return {
    // `known` already covers "named nothing", so a message here means the URL
    // named something and got it wrong.
    error: known
      ? null
      : `This link asks for a video called “${requested}”, which this build ` +
        `does not have.`,
    canSelectVideo: intent.ui === 'debug' || requested === null || !known,
  }
}
