import type { ReactElement } from 'react'

import styles from './RenderFailure.module.css'

/**
 * What a visitor sees when a render throws past every boundary below it —
 * the fallback for the error boundary in `src/index.tsx`.
 *
 * Deliberately plain, and deliberately not a retry: the failures that reach
 * here are the ones that got past the session's own recovery, and a session
 * cannot be rebuilt in place — the screen's `<video>` element is built before
 * the first render and never again (see `core/screen-output.ts`). A fresh
 * page load is the only honest way out, which is what the button does.
 *
 * The button is there because the manifest asks for `display: standalone`.
 * Installed to a home screen, this app has no address bar and so no reload
 * control of its own; telling someone to reload without giving them the means
 * would be advice they cannot take.
 *
 * Imports nothing from the app. Whatever just failed, this still has to draw.
 */
export function RenderFailure(): ReactElement {
  return (
    <div className={styles.shell} role="alert">
      <p className={styles.title}>Something went wrong</p>
      <p className={styles.detail}>
        Reload the page to start again. Nothing is lost — the screen keeps
        playing, and a phone rejoins the same room.
      </p>
      <button
        type="button"
        className={styles.reload}
        onClick={() => window.location.reload()}
      >
        Reload
      </button>
    </div>
  )
}
