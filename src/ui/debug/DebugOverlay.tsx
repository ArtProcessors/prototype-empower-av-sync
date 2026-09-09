import { useState } from 'react'

import styles from './debug.module.css'
import { DebugPanel } from './DebugPanel'
import { DiagnosticsPanel } from './DiagnosticsPanel'
import type { ViewProps } from '../view-props'

/**
 * Viewport width, in px, below which the overlay comes up collapsed.
 *
 * A display has room for the instruments and the picture at once; a phone does
 * not, and the thing the panel would be covering there is the ring a listener
 * has to tap. So a phone gets the chip and opens the panel when it is actually
 * wanted. Read once, at mount — this decides an initial state, not a layout,
 * and re-deciding it on a rotation would throw away whatever the user chose.
 */
const NARROW_PX = 700

/** Whether the overlay starts open, i.e. whether there is room for it. */
function startsOpen(): boolean {
  return window.innerWidth >= NARROW_PX
}

/**
 * Everything `?debug=1` adds, over the top of the one UI.
 *
 * There used to be two UIs — the demo's views and a separate instrumented set
 * of them — which meant every state worth looking at existed twice and drifted
 * apart. This is the other half of collapsing that: the demo views are now the
 * only views, and the instrument is an overlay on whatever they are showing.
 * Nothing here renders session state a visitor would see; it renders the
 * readings underneath it.
 *
 * A sibling of the app rather than a component inside it, mounted by
 * `ui/App.tsx`, because it is `position: fixed` over whichever view happens to
 * be up — the start button, the wall, or a listener's ring — and none of those
 * should have to know it exists. The three things it cannot do from out here
 * are settled at the seams that already read the launch intent: native
 * controls on the screen's `<video>` (`ui/App.tsx`), the picker staying on the
 * start screen when the link named a video (`ui/useLaunchVideo.ts`), and the
 * `&debug=1` the screen's QR carries (`demo/DemoScreenView.tsx`).
 *
 * Collapsible because on a phone it is not merely in the way, it is in the way
 * of the one control there is: the listener's ring is centred and is the
 * button until it is tapped, and a panel this dense covers it. Collapsed it is
 * a chip in the same corner, so opening and closing it is one target that does
 * not move.
 */
export function DebugOverlay({ state, session }: ViewProps) {
  const [open, setOpen] = useState(startsOpen)
  const active = state.phase === 'active'

  if (!open) {
    return (
      <button
        className={styles.chip}
        aria-expanded={false}
        onClick={() => setOpen(true)}
      >
        Debug
      </button>
    )
  }

  return (
    <aside className={styles.panel} aria-label="Debug instruments">
      <header className={styles.head}>
        <h2 className={styles.title}>Debug</h2>
        <button
          className={styles.ghost}
          aria-expanded={true}
          onClick={() => setOpen(false)}
        >
          Hide
        </button>
      </header>

      {/* The demo views say their own piece about an error — the start screen
          in a panel, the listener's ring in its headline — but neither is
          necessarily on screen when one lands, and a message that scrolled
          past is worse than one repeated. */}
      {state.error && <p className={styles.error}>⚠ {state.error}</p>}

      <div className={styles.controls}>
        {/*
          The demo turns the wake lock on for everyone and never offers it
          back — see `DemoApp`. Testing what a sleeping phone does to a
          session needs it off again, so the switch lives here, which is the
          one place that can afford a checkbox.
        */}
        {state.keepAwake.supported && (
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={state.keepAwake.enabled}
              onChange={event => session.setKeepAwake(event.target.checked)}
            />
            <span>Keep screen awake</span>
          </label>
        )}

        {active && (
          <button className={styles.ghost} onClick={() => session.leave()}>
            Leave
          </button>
        )}
      </div>

      <DebugPanel state={state} session={session} />
      <DiagnosticsPanel />
    </aside>
  )
}
