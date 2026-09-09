import type { DomScreenVideoOptions } from '../core/screen-output'
import { useSync } from '../hooks/useSync'
import { DebugOverlay } from './debug/DebugOverlay'
import { DemoApp } from './demo/DemoApp'
import { currentLaunchIntent } from './launch-intent'

/**
 * Root view: binds the page's session, renders the UI, and — under
 * `?debug=1` — hangs the instruments over the top of it.
 *
 * There is one set of views. `?debug=1` used to select a second set, which
 * meant every state worth looking at was built twice and only one of the two
 * was ever kept honest; now it adds {@link DebugOverlay} to the same views a
 * visitor sees. The mode is read once, at module evaluation, because the
 * session and its `<video>` element are built on the first render and cannot
 * be rebuilt (see `core/screen-output.ts`). It comes from the same frozen read
 * of the URL as everything else a launch link can say — see
 * `launch-intent.ts`.
 */
const DEBUG = currentLaunchIntent().ui === 'debug'

/**
 * How the screen's video element is set up.
 *
 * This is the whole reason `useSync` takes options: the decision belongs to
 * whoever knows how the page is being run, which is this module and nothing
 * below it. The core builds a bare, muted, looping, inline `<video>` carrying
 * `SCREEN_VIDEO_CLASS`; everything past that is decided here.
 *
 * Nothing over the picture in the ordinary case — a room full of people is
 * looking at this, and the only overlay it should have is the QR code the
 * screen view draws. Under `?debug=1` it gets native controls, to scrub and
 * pause with while testing, which is the one part of the instrument that
 * cannot be an overlay: it belongs to the element itself, and the element is
 * built before the first render.
 */
const SCREEN_VIDEO: DomScreenVideoOptions = DEBUG
  ? {
      configure: element => {
        element.controls = true
      },
    }
  : {}

/** Root view: the app, plus the debug instruments when the URL asks for them. */
export function App() {
  const { state, session, mountScreenVideo } = useSync({
    screenVideo: SCREEN_VIDEO,
  })

  return (
    <>
      <DemoApp
        state={state}
        session={session}
        mountScreenVideo={mountScreenVideo}
      />
      {DEBUG && <DebugOverlay state={state} session={session} />}
    </>
  )
}
