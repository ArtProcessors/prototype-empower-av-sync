import { classNames } from '../class-names'
import type { LaunchVideoState } from '../useLaunchVideo'
import type { ViewProps } from '../view-props'
import styles from './demo.module.css'

type Props = ViewProps & {
  /** How the launch URL was honoured — see {@link useLaunchVideo}. */
  launch: LaunchVideoState
  /** Called when this device should join as a listener instead. */
  onListen: () => void
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
export function DemoScreenStart({ state, session, launch, onListen }: Props) {
  const connecting = state.phase === 'connecting'

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
              {state.media.options.map(video => (
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
          disabled={connecting}
          onClick={() => session.becomeScreen()}
        >
          {connecting ? 'Starting…' : 'Start'}
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
