import type { ViewProps } from '../view-props'

/**
 * The one setup step before the demo screen goes full-bleed: pick the video
 * and tap.
 *
 * The tap is not decoration — it is the gesture iOS grants autoplay against,
 * and `becomeScreen` spends it on `video.play()` before it touches the
 * network. This is the only operator-facing surface in the demo UI; from the
 * moment it is pressed, nothing but the video and the QR is on screen.
 */
export function DemoScreenStart({
  state,
  session,
  onListen,
}: ViewProps & {
  /** Called when this device should join as a listener instead. */
  onListen: () => void
}) {
  const connecting = state.phase === 'connecting'

  return (
    <main className="demo demo-start">
      <div className="demo-center">
        <p className="demo-lede">
          Start the screen, then let people scan the code to hear it.
        </p>

        {state.error && (
          <p className="demo-error" role="alert">
            ⚠ {state.error}
          </p>
        )}

        <label className="demo-field">
          <span className="demo-field-label">Video</span>
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

        <button
          className="demo-action"
          disabled={connecting}
          onClick={() => session.becomeScreen()}
        >
          {connecting ? 'Starting…' : 'Start'}
        </button>
      </div>

      <footer className="demo-footer">
        <button className="demo-ghost" onClick={onListen}>
          Listen on this device instead
        </button>
      </footer>
    </main>
  )
}
