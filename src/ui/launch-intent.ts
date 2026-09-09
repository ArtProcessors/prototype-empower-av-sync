/**
 * What the URL a device arrived on is asking this page to be.
 *
 * Three things already read the query string independently — the UI mode in
 * `ui-mode.ts`, the room code in `core/join-link.ts`, and the engine knobs in
 * `media/streaming-buffer-engine.ts` — and the precedence between the first
 * two was settled ad hoc, twice, in the two landing views. This is the one
 * place that turns a URL into an intent, which is what lets a display be set
 * up entirely by the link it is switched on with:
 *
 *     /?video=soh&autostart=1
 *
 * Both halves of the URL are read here, and they answer different questions.
 * The path says which page this load is — the app, or one of the development
 * galleries — and lives in `launch-path.ts`. The query string configures the
 * page the path chose, and nothing in it selects a page any more.
 *
 * Deliberately not a router, and the difference matters. A router exists to
 * react to the URL changing; this is read once and frozen, because the session
 * builds its `<video>` element before the first render and can never rebuild
 * it (see `core/screen-output.ts`). Views route on session phase — the one
 * thing that does move — and nothing here ever contradicts it.
 *
 * What the screen's half notably does not need is a tap. Its element is muted
 * and inline, which browsers allow to autoplay unprompted; `?autostart=` is
 * that permission spent deliberately. Followers are unaffected — audio needs
 * a real gesture, so no URL can join one for them.
 */
import { roomCodeFromSearch } from '../core/join-link'
import { readRejoinRoom } from '../core/rejoin-memory'
import { launchPathFrom, type LaunchPage } from './launch-path'
import { uiModeFromSearch, type UiMode } from './ui-mode'

/** Query parameter naming the video the screen leads with, e.g. `?video=soh`. */
export const VIDEO_QUERY_PARAM = 'video'

/** Query parameter asking the screen to start itself, e.g. `?autostart=1`. */
export const AUTOSTART_QUERY_PARAM = 'autostart'

/** What the page's URL asks this device to be. */
export interface LaunchIntent {
  /**
   * Which page this load is, from the path. Everything below it configures
   * that page; nothing below it can change which one it is.
   */
  page: LaunchPage
  /**
   * The path the app is served from — where a join link points. From the
   * path too, and the reason it is here rather than derived at the QR: a
   * development page that draws the real screen view must still hand out a
   * link to the app. See {@link appLocation}.
   */
  appPath: string
  /** Which UI to render. */
  ui: UiMode
  /**
   * Room code from `?room=`, or `null` when the parameter is absent. Blank is
   * not absent: `?room=` present but empty is someone explicitly saying "no
   * room", and {@link roomToJoin} lets it win over a remembered one.
   */
  room: string | null
  /**
   * Id of the video the screen should lead with, or `null` when the URL names
   * none. Deliberately unvalidated here — the catalogue belongs to the host,
   * and this module only reads the URL.
   */
  video: string | null
  /** Whether the screen should start without waiting for a tap. */
  autostart: boolean
}

/**
 * Whether a flag-shaped parameter is present and not switched off — the same
 * reading `?debug=` gets. Anything but absent, `0` or `false` is on, so a flag
 * is hard to set by accident and can be turned off without editing the URL
 * down to nothing.
 */
function flagFromParams(params: URLSearchParams, name: string): boolean {
  const value = params.get(name)

  return value !== null && value !== '0' && value !== 'false'
}

/** The intent a path and query string carry together. */
export function launchIntentFrom(
  pathname: string,
  search: string,
): LaunchIntent {
  const params = new URLSearchParams(search)
  const video = params.get(VIDEO_QUERY_PARAM)
  const path = launchPathFrom(pathname)

  return {
    page: path.page,
    appPath: path.appPath,
    ui: uiModeFromSearch(search),
    room: roomCodeFromSearch(search),
    // A blank `?video=` names nothing, unlike a blank `?room=`: there is no
    // "deliberately no video" to express — the catalogue always has a default.
    video: video === null || video === '' ? null : video,
    autostart: flagFromParams(params, AUTOSTART_QUERY_PARAM),
  }
}

let current: LaunchIntent | null = null

/**
 * The intent this page load arrived on, read once.
 *
 * Cached rather than re-read because everything downstream — which UI renders,
 * which half of the demo a device is, whether the screen starts itself — has
 * to give the same answer every time it is asked, including on a re-render
 * that happens long after the tap it describes.
 */
export function currentLaunchIntent(): LaunchIntent {
  current ??= launchIntentFrom(
    window.location.pathname,
    window.location.search,
  )

  return current
}

/**
 * Where the app is, for building a join link off — the shape
 * `core/join-link.ts` takes.
 *
 * Not `window.location`, which is what the QR used to be built from. That was
 * correct only for as long as the app was the sole page: the screen state
 * gallery renders the real `DemoScreenView`, so a code drawn there would
 * otherwise send a phone to `/dev/screens?room=…` and a second gallery.
 */
export function appLocation(intent: LaunchIntent = currentLaunchIntent()): {
  origin: string
  pathname: string
} {
  return { origin: window.location.origin, pathname: intent.appPath }
}

/**
 * The room this device should join, or `null` if it is here to be the screen.
 *
 * Two rules, in one place because both landing views need them and used to
 * spell them out separately:
 *
 *  - An explicit `?room=` wins, even blank. A link that says "no room" is
 *    still someone saying something, and it should not fall through to a
 *    memory.
 *  - `?autostart=` beats the remembered room. A device asked to come up
 *    unattended was set up to be the screen, and a room it happened to listen
 *    in last week should not quietly pull it back into listening.
 */
export function roomToJoin(
  intent: LaunchIntent = currentLaunchIntent(),
): string | null {
  if (intent.room !== null) {
    return intent.room
  }

  return intent.autostart ? null : readRejoinRoom()
}
