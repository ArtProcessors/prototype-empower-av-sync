/**
 * Selectable leader videos. Each option pairs a video (played by the SCREEN)
 * with its extracted audio (played by FOLLOWERS) — followers only ever
 * download the audio, never the video.
 *
 * Two lists, because two different things are in here. {@link CONTENT_VIDEOS}
 * is what a room is put in front of. {@link DIAGNOSTIC_VIDEOS} are
 * instruments — the flash+click clip you can check a sync against by eye, and
 * a 45-minute run for watching drift over a length of time no real clip here
 * reaches — and a page only gets them under `?debug=1`. Splitting the array is
 * the whole mechanism: the session is built from one list or both (see
 * {@link contentCatalogue}), so nothing downstream needs a rule about which
 * clip is which.
 *
 * That does mean a plain page cannot play a diagnostic clip at all, not even
 * from `?video=test` — it is not in that page's catalogue to name. Which is
 * the reason the join QR carries the debug flag (see `ui/ui-mode.ts`): a phone
 * scanning a screen that is being tested lands in the same mode, so it has the
 * clip the beats are about to name.
 *
 * Delivery differs too, and along a different line. The two files in this
 * directory are ES-module imports → fingerprinted into dist/static/ and served
 * from the app's own origin; the other three clips are H.264 video and
 * stream-copied AAC audio served by URL. Everything is runtime-cached by the
 * service worker as it is fetched, and exactly one file is *pre*cached:
 * {@link PRIMER_SOUNDTRACK_URL}, which has to be local before the gesture that
 * needs it, not after. `screen.mp4` is not — it is wanted only by an
 * instrumented page, and a page that never raises the instruments should not
 * pay for it on first load.
 *
 * Regenerate the remote clips with ffmpeg — see README.
 *
 * The screen tags each `beat` with the chosen `mediaId`, so followers load the
 * matching soundtrack.
 */
import type { MediaCatalogue, MediaOption } from '../core/media-catalogue'
import brandSoundtrack from './brand.m4a'
import brandVideo from './brand.mp4'
import primer from './primer.m4a'
import screenVideo from './screen.mp4'

/**
 * The primer: a few seconds of audio every follower loads into its `<audio>`
 * element inside the unlock gesture, before any real soundtrack is known. It
 * is never heard — see `media/audio-sync-controller.ts`.
 *
 * Named for that job rather than for its contents, because that is the job
 * that makes it load-bearing: without something already local to point the
 * element at, the one gesture iOS gives us is spent on a file that has not
 * arrived. It doubles as the `test` clip's soundtrack, which is where it came
 * from, but a build with no test clip would still need this file.
 */
export const PRIMER_SOUNDTRACK_URL: string = primer

/** Selectable video ids broadcast on every beat as `mediaId`. */
export type VideoId = 'brand' | 'agent327' | 'soh' | 'test' | 'sync45'

/**
 * One video the screen can lead with. The shape is the core's
 * {@link MediaOption}; this app only narrows the id to the four it ships.
 */
export interface VideoOption extends MediaOption {
  /** Stable id broadcast on every beat as `mediaId`. */
  id: VideoId
}

const LONG_FORM_BASE_URL =
  'https://content.dev.pladia.live/assets/playground/james'

/**
 * The fallback, and the only entry that is never in the picker.
 *
 * A screen that was not told what to lead with leads with this, and an id
 * nothing recognises resolves to it — which is why it is first in `options`,
 * the slot {@link mediaById} falls back to. It is deliberately not something
 * an operator selects: it is what "nothing was selected" looks like, and a
 * menu entry saying so would be a contradiction.
 *
 * It is silent by design. The follower's ring reads the live waveform, so a
 * room listening to the fallback shows a flat ring — correct, if unexciting:
 * there is nothing to hear yet.
 */
export const BRAND_VIDEO: VideoOption = {
  id: 'brand',
  label: 'Pladia — brand loop (20s)',
  videoUrl: brandVideo,
  soundtrackUrl: brandSoundtrack,
}

/** What a room is put in front of. Every page has these, in picker order. */
export const CONTENT_VIDEOS: VideoOption[] = [
  {
    id: 'agent327',
    label: 'Agent 327 — Blender short (4m)',
    videoUrl: `${LONG_FORM_BASE_URL}/agent-327.mp4`,
    soundtrackUrl: `${LONG_FORM_BASE_URL}/agent-327.m4a`,
    streaming: true,
  },
  {
    id: 'soh',
    label: 'SOH Sync — Long clip (15m)',
    videoUrl: `${LONG_FORM_BASE_URL}/soh.mp4`,
    soundtrackUrl: `${LONG_FORM_BASE_URL}/soh.m4a`,
    streaming: true,
  },
]

/**
 * Clips for testing the sync rather than watching. Appended to the picker
 * under `?debug=1` and absent from every other page.
 */
export const DIAGNOSTIC_VIDEOS: VideoOption[] = [
  {
    id: 'test',
    label: 'Test clip — flash+click cues (20s)',
    videoUrl: screenVideo,
    // The primer is this clip's own soundtrack; they are the same recording.
    soundtrackUrl: primer,
  },
  {
    id: 'sync45',
    label: 'Sync test — long run (45m)',
    videoUrl: `${LONG_FORM_BASE_URL}/sync-test-45mins.mp4`,
    soundtrackUrl: `${LONG_FORM_BASE_URL}/sync-test-45mins.m4a`,
    streaming: true,
  },
]

/**
 * Every video this build ships, whichever page is asking.
 *
 * Not what a session plays — that is {@link contentCatalogue}, and on a plain
 * page it is the shorter list. This is for the things that are about the
 * content itself rather than about one page's session: the captions gallery,
 * and {@link videoById}.
 */
export const VIDEOS: VideoOption[] = [
  BRAND_VIDEO,
  ...CONTENT_VIDEOS,
  ...DIAGNOSTIC_VIDEOS,
]

/**
 * Video the screen leads with until the user picks another.
 *
 * The brand loop, so a display that comes up unattended comes up as itself
 * rather than part-way into somebody's short film. It also has to be something
 * every page can pick its way back to, which rules out the diagnostic clips.
 */
export const DEFAULT_VIDEO_ID: VideoId = 'brand'

/**
 * Look up a video option by id, falling back to the first option when the id
 * is unknown (e.g. a beat from a screen running a newer build).
 */
export function videoById(id: string): VideoOption {
  return VIDEOS.find(video => video.id === id) ?? VIDEOS[0]
}

/** Whether `id` is a known selectable video id. */
export function isVideoId(id: string): id is VideoId {
  return VIDEOS.some(video => video.id === id)
}

/**
 * This app's content, in the shape {@link createSyncSession} expects.
 *
 * @param withDiagnostics whether this page is instrumented, and so gets the
 *   testing clips as well as the content
 */
export function contentCatalogue(withDiagnostics: boolean): MediaCatalogue {
  const offered = withDiagnostics
    ? [...CONTENT_VIDEOS, ...DIAGNOSTIC_VIDEOS]
    : CONTENT_VIDEOS

  return {
    // The fallback leads the list it is resolved from, and appears in no
    // picker at all.
    options: [BRAND_VIDEO, ...offered],
    offered,
    defaultId: DEFAULT_VIDEO_ID,
    primerSoundtrackUrl: PRIMER_SOUNDTRACK_URL,
  }
}
