import { useEffect, useState } from 'react'

import { classNames } from '../class-names'
import type { LaunchVideoState } from '../useLaunchVideo'
import type { ViewProps } from '../view-props'
import styles from './demo.module.css'

/**
 * Where the start sequence has got to.
 *
 * `tracing` is the only state the view is held up for: the lap has to finish
 * before the video is worth cutting to. `landed` keeps the mark turning until
 * the session is actually leading, which is the honest thing to show while
 * the room is still being opened.
 */
type Sequence = 'idle' | 'tracing' | 'landed'

type Props = ViewProps & {
  /** How the launch URL was honoured — see {@link useLaunchVideo}. */
  launch: LaunchVideoState
  /** Called when this device should join as a listener instead. */
  onListen: () => void
  /**
   * Whether the start sequence still needs the view. The app keeps this
   * screen up while it is true, rather than swapping to the video the moment
   * the session goes active — which, on a fast room, is part-way round the
   * lap.
   */
  onHold: (holding: boolean) => void
}

/**
 * The pladia mark: a large arc above a smaller one, interlocking.
 *
 * It ships as a single path holding both, which cannot be animated in halves
 * — so the two subpaths are one element each here, and arrive separately.
 */
function PladiaMark() {
  return (
    <svg className={styles.markArt} viewBox="0 0 48 48" aria-hidden="true">
      <path
        className={styles.markUpper}
        d="M22.1495 33.9884C25.9222 33.9876 29.5401 32.4602 32.2077 29.742C34.8753 27.0239 36.3741 23.3376 36.3747 19.4937C36.3739 15.65 34.8749 11.9639 32.2073 9.246C29.5398 6.52808 25.922 5.00081 22.1495 5"
        fill="currentColor"
      />
      <path
        className={styles.markLower}
        d="M20.6237 43.7938C18.0718 43.7925 15.6247 42.759 13.8202 40.9204C12.0157 39.0818 11.0013 36.5885 11 33.9884C11.0013 31.3882 12.0157 28.895 13.8202 27.0564C15.6247 25.2178 18.0718 24.1843 20.6237 24.183"
        fill="currentColor"
      />
    </svg>
  )
}

/**
 * The one setup step before the demo screen goes full-bleed: pick the video
 * and tap.
 *
 * How much of that is left depends on the link the device was opened with. A
 * URL naming a video takes the picker away and leaves the tap; one that also
 * says `?autostart=1` skips this screen entirely, and only comes back to it
 * when the browser refuses to play unprompted — which is why the tap has to
 * stay on offer here.
 *
 * That tap is not decoration. The screen's element is muted, so a browser will
 * usually autoplay it unasked, but "usually" is doing real work in that
 * sentence — iOS Low Power Mode refuses — and a gesture is the one permission
 * nothing turns down. `becomeScreen` spends it on `video.play()` before it
 * touches the network. This is the only operator-facing surface in the demo
 * UI; from the moment it is pressed, nothing but the video and the QR is on
 * screen.
 */
export function DemoScreenStart({
  state,
  session,
  launch,
  onListen,
  onHold,
}: Props) {
  const [sequence, setSequence] = useState<Sequence>('idle')
  // Whether the session is on something the picker does not list.
  const onFallback = !state.media.offered.some(
    video => video.id === state.media.selectedId,
  )

  // A start that came back with an error has nothing to hand over to, so the
  // sequence is abandoned and the button offered again. `becomeScreen` clears
  // the error on the way in, so this only ever fires on the way out.
  useEffect(() => {
    if (state.error) {
      setSequence('idle')
    }
  }, [state.error])

  useEffect(() => onHold(sequence === 'tracing'), [onHold, sequence])

  return (
    <main className={classNames(styles.shell, styles.view)}>
      <div className={styles.centre}>
        <p className={styles.lede}>
          Start the screen, then let people scan the code to hear it.
        </p>

        {state.error && (
          <p className={styles.error} role="alert">
            ⚠ {state.error}
          </p>
        )}

        {launch.error && (
          <p className={styles.error} role="alert">
            ⚠ {launch.error}
          </p>
        )}

        {launch.canSelectVideo ? (
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Video</span>
            <select
              value={state.media.selectedId}
              onChange={event => session.selectVideo(event.target.value)}
            >
              {/* The session can sit on something no picker offers — the
                  fallback it starts on before anyone chooses. Without an
                  entry for it the browser would show the first real option
                  instead, which is a select claiming a choice was made and
                  naming the wrong film. Disabled, because saying what is on
                  is not the same as offering it. */}
              {onFallback && (
                <option value={state.media.selectedId} disabled>
                  {state.media.selected.label}
                </option>
              )}
              {state.media.offered.map(video => (
                <option key={video.id} value={video.id}>
                  {video.label}
                </option>
              ))}
            </select>
          </label>
        ) : (
          // Named by the link, so the picker is gone — but say which one, or
          // there is no way to tell a link that worked from one that was
          // ignored without starting it and watching.
          <p className={styles.hint}>{state.media.selected.label}</p>
        )}

        <button
          className={styles.action}
          data-starting={sequence === 'idle' ? undefined : ''}
          disabled={sequence !== 'idle'}
          // The word is gone once the lap starts, and the mark that
          // replaces it is decorative, so the name has to be carried here.
          aria-label={sequence === 'idle' ? 'Start' : 'Starting…'}
          onClick={() => {
            // Set first and awaited by nobody: `becomeScreen` has to run
            // inside this call for the gesture to still be worth anything.
            setSequence('tracing')
            session.becomeScreen()
          }}
        >
          {sequence === 'idle' ? (
            'Start'
          ) : (
            <>
              <svg
                className={styles.trace}
                viewBox="0 0 100 100"
                aria-hidden="true"
              >
                <circle
                  className={styles.traceLine}
                  cx="50"
                  cy="50"
                  r="49.5"
                  pathLength="100"
                />
              </svg>

              <span
                className={styles.mark}
                // Each half's arrival bubbles through here too; only this
                // wrapper's own fade marks the end of the sequence.
                onAnimationEnd={event => {
                  if (event.target === event.currentTarget) {
                    setSequence('landed')
                  }
                }}
              >
                <PladiaMark />
              </span>
            </>
          )}
        </button>
      </div>

      <footer className={styles.footer}>
        <button className={styles.ghost} onClick={onListen}>
          Listen on this device instead
        </button>
      </footer>
    </main>
  )
}
