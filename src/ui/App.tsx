import type { DomScreenVideoOptions } from '../core/screen-output'
import { useSync } from '../hooks/useSync'
import { DebugApp } from './debug/DebugApp'
import { DemoApp } from './demo/DemoApp'
import { currentUiMode, type UiMode } from './ui-mode'

/**
 * Root view: binds the page's session and hands it to one of the two UIs.
 *
 * Both are hosts over the same `src/core` session — the demo for consumers,
 * the debug UI (`?debug=1`) for development. The mode is read once, at module
 * evaluation, because the session and its `<video>` element are built on the
 * first render and cannot be rebuilt (see `core/screen-output.ts`).
 */
const UI_MODE = currentUiMode()

/**
 * How each UI wants the screen's video element.
 *
 * This is the whole reason `useSync` takes options: the decision belongs to
 * whoever knows which UI is rendering, which is this module and nothing below
 * it. The core builds a bare, muted, looping, inline `<video>` carrying
 * `SCREEN_VIDEO_CLASS`; everything past that is decided here.
 */
const SCREEN_VIDEO: Record<UiMode, DomScreenVideoOptions> = {
  // Nothing over the picture. A room full of people is looking at this, and
  // the only overlay it should have is the QR code the demo view draws.
  demo: {
    configure: element => {
      element.controls = true
    },
  },

  // Native controls, to scrub and pause with while testing. The debug screen
  // renders the element letterboxed in a card, where chrome costs nothing.
  debug: {
    configure: element => {
      element.controls = true
    },
  },
}

/** Root view: routes the page's session to the demo or debug UI. */
export function App() {
  const binding = useSync({ screenVideo: SCREEN_VIDEO[UI_MODE] })

  return UI_MODE === 'debug' ? (
    <DebugApp {...binding} />
  ) : (
    <DemoApp {...binding} />
  )
}
