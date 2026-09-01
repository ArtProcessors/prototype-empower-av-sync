/**
 * Selectable leader videos. Each option pairs a video (played by the SCREEN)
 * with its extracted audio (played by FOLLOWERS) — followers only ever
 * download the audio, never the video.
 *
 *  - `test` — the tiny synthetic clip (per-second flash+click). Imported as
 *    ES-module URLs → fingerprinted into dist/static/ and PRECACHED (works
 *    fully offline). Default while prototyping.
 *  - `soh` / `sync45` — real long clips. Their H.264 video and stream-copied
 *    AAC audio are served by URL and are NOT precached: the screen fetches the
 *    video on demand and each follower fetches only the small audio (both then
 *    runtime-cached by the service worker). Regenerate with ffmpeg — see
 *    README.
 *
 * The screen tags each `beat` with the chosen `mediaId`, so followers load the
 * matching soundtrack.
 */
import screenVideo from './screen.mp4'
import soundtrack from './soundtrack.m4a'

/** Default/primer soundtrack (also the `test` option's audio). */
export const SYNTH_SOUNDTRACK_URL: string = soundtrack

/** Selectable video ids broadcast on every beat as `mediaId`. */
export type VideoId = 'test' | 'soh' | 'sync45'

/** One video the screen can lead with, plus the audio followers play. */
export interface VideoOption {
  /** Stable id broadcast on every beat as `mediaId`. */
  id: VideoId
  /** Human-readable name shown in the screen's video picker. */
  label: string
  /** Video file played by the screen. */
  videoUrl: string
  /** Extracted audio played by followers, on the same timeline as the video. */
  soundtrackUrl: string
  /**
   * Long-form audio: followers stream-decode a sliding window (WebCodecs)
   * instead of decoding the whole file into one AudioBuffer. Whole-file decode
   * costs ~21 MB/min, so anything past a few minutes must use this to keep
   * memory flat. See StreamingBufferEngine.
   */
  streaming?: boolean
}

const LONG_FORM_BASE_URL =
  'https://content.dev.pladia.live/assets/playground/james'

/** Every video the screen can lead with, in picker order. */
export const VIDEOS: VideoOption[] = [
  {
    id: 'test',
    label: 'Test clip — sync cues (20s, offline)',
    videoUrl: screenVideo,
    soundtrackUrl: soundtrack,
  },
  {
    id: 'soh',
    label: 'SOH Sync — Long (~15m, real content)',
    videoUrl: `${LONG_FORM_BASE_URL}/soh.mp4`,
    soundtrackUrl: `${LONG_FORM_BASE_URL}/soh.m4a`,
    streaming: true,
  },
  {
    id: 'sync45',
    label: 'Sync test — Long (45m, streaming)',
    videoUrl: `${LONG_FORM_BASE_URL}/sync-test-45mins.mp4`,
    soundtrackUrl: `${LONG_FORM_BASE_URL}/sync-test-45mins.m4a`,
    streaming: true,
  },
]

/** Video the screen leads with until the user picks another. */
export const DEFAULT_VIDEO_ID: VideoId = 'test'

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
