/**
 * Selectable leader videos. Each option pairs a video (played by the SCREEN) with its
 * extracted audio (played by FOLLOWERS) — followers only ever download the audio, never
 * the video.
 *
 *  - `test`  — the tiny synthetic clip (per-second flash+click). Imported as ES-module URLs
 *    → fingerprinted into dist/static/ and PRECACHED (works fully offline). Default while
 *    prototyping.
 *  - `soh`   — a real long clip. The 127 MB H.264 video + its ~14 MB stream-copied AAC live
 *    in `public/media/` (git-ignored, served by path). They are NOT precached — the screen
 *    fetches the video on demand and each follower fetches only the small audio (both then
 *    runtime-cached by the service worker). Regenerate with ffmpeg — see README.
 *
 * The screen tags each `beat` with the chosen `mediaId`, so followers load the matching
 * soundtrack.
 */
import screenVideo from './screen.mp4'
import soundtrack from './soundtrack.m4a'

/** Default/primer soundtrack (also the `test` option's audio). */
export const SYNTH_SOUNDTRACK_URL: string = soundtrack

export interface VideoOption {
  id: string
  label: string
  videoUrl: string // played by the screen
  soundtrackUrl: string // played by followers (extracted audio, same timeline)
  /**
   * Long-form audio: followers stream-decode a sliding window (WebCodecs) instead of
   * decoding the whole file into one AudioBuffer. Whole-file decode is ~21 MB/min, so
   * anything past a few minutes must use this to keep memory flat. See StreamingBufferEngine.
   */
  streaming?: boolean
}

export const VIDEOS: VideoOption[] = [
  {
    id: "test",
    label: "Test clip — sync cues (20s, offline)",
    videoUrl: screenVideo,
    soundtrackUrl: soundtrack,
  },
  {
    id: "soh",
    label: "SOH Sync — Long (~15m, real content)",
    videoUrl: "https://content.dev.pladia.live/assets/playground/james/soh.mp4",
    soundtrackUrl:
      "https://content.dev.pladia.live/assets/playground/james/soh.m4a",
      streaming: true,
  },
  {
    id: "sync45",
    label: "Sync test — Long (45m, streaming)",
    videoUrl:
      "https://content.dev.pladia.live/assets/playground/james/sync-test-45mins.mp4",
    soundtrackUrl:
      "https://content.dev.pladia.live/assets/playground/james/sync-test-45mins.m4a",
    streaming: true,
  },
]

export const DEFAULT_VIDEO_ID = 'test'

export function videoById(id: string): VideoOption {
  return VIDEOS.find((v) => v.id === id) ?? VIDEOS[0]
}
