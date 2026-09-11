/**
 * Whether this page is running with the instruments up.
 *
 * There is one set of views. `?debug=1` does not select a second UI — it used
 * to, and keeping two sets of views honest about the same session turned out
 * to be work nobody was doing — it adds `ui/debug/DebugOverlay` over the top of
 * the one that exists, plus the things an overlay cannot do for itself: native
 * controls on the screen's `<video>`, the picker staying on the start screen
 * when the link already named a video, and the diagnostic clips being in the
 * page's catalogue at all (see `content/index.ts`).
 *
 * The choice is a page-load-time reading of the URL rather than session state,
 * because both of those are spent before the first render — which is also what
 * lets `useSync` bake the mode into the screen's `<video>` element. Nothing
 * switches mode mid-session.
 *
 * The mode is one of several things a URL can say, and it is not read from
 * here directly: `launch-intent.ts` does that once for all of them, so a page
 * cannot end up half-agreeing with its own link.
 *
 * The mode has to survive the join link as well: a QR scanned off a screen
 * that is being debugged should land the phone in the same instrumented page.
 * That is a correctness requirement, not a convenience, since the diagnostic
 * clips are only in an instrumented page's catalogue: a follower that lost the
 * flag could not resolve a beat naming one, and would quietly play the wrong
 * soundtrack. See {@link withUiMode}, which `DemoScreenView` wraps its join
 * URL in.
 */

/** Whether the debug instruments are up over the app's views. */
export type UiMode = 'demo' | 'debug'

/** Query parameter raising the debug instruments, e.g. `?debug=1`. */
export const UI_MODE_QUERY_PARAM = 'debug'

/**
 * The mode a URL's query string asks for. Anything but a truthy `?debug=` is
 * the plain app, so a link — which is what a visitor ever sees — never comes
 * up instrumented by accident.
 */
export function uiModeFromSearch(search: string): UiMode {
  const value = new URLSearchParams(search).get(UI_MODE_QUERY_PARAM)

  if (value === null || value === '0' || value === 'false') {
    return 'demo'
  }

  return 'debug'
}

/**
 * `url` with the mode marker added, so a link built on an instrumented page
 * opens instrumented too. The plain app is the default and gets no marker —
 * the QR a visitor scans should carry nothing but the room.
 */
export function withUiMode(url: string, mode: UiMode): string {
  if (mode !== 'debug') {
    return url
  }

  const separator = url.includes('?') ? '&' : '?'

  return `${url}${separator}${UI_MODE_QUERY_PARAM}=1`
}
