/**
 * Which of the two UIs this page is running: the consumer-facing demo, or the
 * instrumented debug UI the spike was built with.
 *
 * The two are the same session behind different pixels — `src/core` does not
 * know either exists — so the choice is a page-load-time reading of the URL
 * rather than session state. Nothing switches mode mid-session, which is what
 * lets `useSync` bake the mode into the screen's `<video>` element.
 *
 * The mode has to survive the join link as well: a QR scanned off a *debug*
 * screen should land the phone in the debug follower, not the demo one. See
 * {@link withUiMode}, which the debug screen wraps its join URL in.
 */

/** Which UI is rendering: bare-bones demo, or instrumented debug. */
export type UiMode = 'demo' | 'debug'

/** Query parameter selecting the debug UI, e.g. `?debug=1`. */
export const UI_MODE_QUERY_PARAM = 'debug'

/**
 * The UI a URL's query string asks for. Anything but a truthy `?debug=` is the
 * demo, so a plain link — which is what a consumer ever sees — is never the
 * debug UI by accident.
 */
export function uiModeFromSearch(search: string): UiMode {
  const value = new URLSearchParams(search).get(UI_MODE_QUERY_PARAM)

  if (value === null || value === '0' || value === 'false') {
    return 'demo'
  }

  return 'debug'
}

/** The UI this page load is running. */
export function currentUiMode(): UiMode {
  return uiModeFromSearch(window.location.search)
}

/**
 * `url` with the mode marker added, so a link built for one UI opens in that
 * same UI. Demo is the default and gets no marker — the QR a consumer scans
 * should carry nothing but the room.
 */
export function withUiMode(url: string, mode: UiMode): string {
  if (mode !== 'debug') {
    return url
  }

  const separator = url.includes('?') ? '&' : '?'

  return `${url}${separator}${UI_MODE_QUERY_PARAM}=1`
}
