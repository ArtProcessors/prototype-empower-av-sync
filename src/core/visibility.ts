/**
 * The page-visibility signal, in one place.
 *
 * Half a dozen unrelated things in this app care whether the page is hidden —
 * the corrector, the watchdog, the wake lock, the signalling socket, the
 * diagnostics log — and each had grown its own listener and its own
 * `document.visibilityState !== 'visible'` spelling.
 */

/** Whether the page is in the foreground right now. */
export function isPageVisible(): boolean {
  return document.visibilityState === 'visible'
}

/**
 * Call `listener` whenever the page is shown or hidden. Call the returned
 * function to stop listening.
 */
export function onVisibilityChange(
  listener: (visible: boolean) => void,
): () => void {
  const handler = () => listener(isPageVisible())

  document.addEventListener('visibilitychange', handler)

  return () => document.removeEventListener('visibilitychange', handler)
}
