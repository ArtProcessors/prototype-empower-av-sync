/**
 * Which page a URL's path asks for, and where the app itself is served from.
 *
 * The query string had grown two kinds of parameter that look identical and
 * mean nothing like the same thing. `?room=`, `?video=`, `?autostart=` and the
 * engine knobs configure a session; `?rings=`, `?screens=` and `?captions=`
 * selected a different page altogether — a development gallery that never
 * joins a room and cannot use a single one of the others. Three of eleven
 * parameters were page selectors wearing the costume of a flag, which is what
 * made a link hard to read at a glance. Those three are paths now:
 *
 *     /                the app
 *     /dev/rings       gallery of every follower ring state
 *     /dev/screens     gallery of every screen state
 *     /dev/captions    captions played under the video itself
 *
 * leaving the query string as configuration and nothing else.
 *
 * Still deliberately not a router — see `launch-intent.ts`, which reads this
 * once per page load along with the rest of the URL. Nothing here navigates:
 * there is no link between these pages, and a reload is the only way between
 * them, because the session builds its `<video>` element before the first
 * render and can never rebuild it.
 *
 * Serving them costs nothing, in all four places the app runs. The Worker
 * returns `index.html` for anything unmatched (`not_found_handling` in
 * `wrangler.toml`), the service worker's `NavigationRoute` does the same
 * offline (`service-worker/sw.ts`), and Vite's dev server and `preview` both
 * fall back the same way by default.
 */

/** Which page a URL's path asks for. */
export type LaunchPage = 'app' | 'rings' | 'screens' | 'captions'

/**
 * The development pages, by the path that opens each.
 *
 * Under `dev/` so that a URL says for itself that the page is no part of
 * either UI, and so the app keeps the root — and any path below it that is
 * not this list — to itself.
 */
const DEV_PAGES: ReadonlyArray<readonly [string, LaunchPage]> = [
  ['dev/rings', 'rings'],
  ['dev/screens', 'screens'],
  ['dev/captions', 'captions'],
]

/** What a URL's path says about this page load. */
export interface LaunchPath {
  /** The page to render. */
  page: LaunchPage
  /**
   * The path the app itself is served from, always ending in a slash — which
   * is to say where a join link has to point.
   *
   * Matched as a suffix rather than assumed to be the root, so that the app
   * stays movable: `/dev/rings` leaves `/`, and a build served under `/app/`
   * leaves `/app/`. It matters because the screen state gallery renders the
   * real `DemoScreenView`, QR and all, and a code scanned off that page has
   * to open the app rather than the gallery it was drawn on.
   */
  appPath: string
}

/**
 * What `pathname` asks this page load to be.
 *
 * A trailing slash is not a distinction: `/dev/rings` and `/dev/rings/` are
 * the same page, since which of the two a host or a hand-typed URL produces
 * is not something a page should be able to notice.
 */
export function launchPathFrom(pathname: string): LaunchPath {
  const trimmed = pathname.replace(/\/+$/, '')

  for (const [path, page] of DEV_PAGES) {
    if (trimmed.endsWith(`/${path}`)) {
      // Slicing the page off rather than the prefix on keeps the separating
      // slash, so the app path ends in one without having to add it.
      return { page, appPath: trimmed.slice(0, -path.length) }
    }
  }

  // Verbatim, not normalised: for the app itself this is the path the page was
  // actually served from, and a join link should carry exactly that.
  return { page: 'app', appPath: pathname }
}
