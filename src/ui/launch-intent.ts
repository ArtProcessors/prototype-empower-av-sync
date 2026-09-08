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
import { uiModeFromSearch, type UiMode } from './ui-mode'

/** Query parameter naming the video the screen leads with, e.g. `?video=soh`. */
export const VIDEO_QUERY_PARAM = 'video'

/** Query parameter asking the screen to start itself, e.g. `?autostart=1`. */
export const AUTOSTART_QUERY_PARAM = 'autostart'

/**
 * Query parameter opening the follower's ring gallery instead of the app, e.g.
 * `?rings=1`. A development page and no part of either UI — see
 * `ui/demo/DemoStatusGallery.tsx`.
 */
export const RINGS_QUERY_PARAM = 'rings'

/** What the page's URL asks this device to be. */
export interface LaunchIntent {
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
  /**
   * Whether to open the ring gallery rather than a session at all. Sits with
   * the rest of the intent because it is still the URL saying what this page
   * is; unlike the others, nothing downstream of it ever joins a room.
   */
  rings: boolean
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

/** The intent a query string carries. */
export function launchIntentFromSearch(search: string): LaunchIntent {
  const params = new URLSearchParams(search)
  const video = params.get(VIDEO_QUERY_PARAM)

  return {
    ui: uiModeFromSearch(search),
    room: roomCodeFromSearch(search),
    // A blank `?video=` names nothing, unlike a blank `?room=`: there is no
    // "deliberately no video" to express — the catalogue always has a default.
    video: video === null || video === '' ? null : video,
    autostart: flagFromParams(params, AUTOSTART_QUERY_PARAM),
    rings: flagFromParams(params, RINGS_QUERY_PARAM),
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
  current ??= launchIntentFromSearch(window.location.search)

  return current
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
