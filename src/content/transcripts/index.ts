/**
 * Which videos have a transcript, and how to get one.
 *
 * The catalogue in `../index.ts` pairs a video with the audio followers play;
 * this pairs it with the words, for the followers that want them shown. It is
 * a separate map rather than another field on `MediaOption` because a
 * transcript is not part of playing anything: nothing in the sync path loads
 * one, and a build that never turns captions on never fetches a byte of this.
 *
 * Each entry is a dynamic `import()`, so the file lands in its own chunk and
 * is fetched the first time a listener asks for captions — not on start-up,
 * and never on the screen. The chunk is precached with the rest of the build,
 * so a transcript that has been fetched once is a cache hit from then on.
 *
 * Adding one is two lines: drop the pipeline's JSON in beside this file and
 * name it here under the same id the beat carries.
 */
import { buildTranscript, type Transcript } from '../../core/transcript'
import type { TranscriptSource } from '../../core/transcript'

/** Transcript files, keyed by the `mediaId` a beat carries. */
const SOURCES: Record<string, () => Promise<{ default: TranscriptSource }>> = {
  soh: () => import('./soh.json'),
  agent327: () => import('./agent327.json'),
}

/**
 * Built transcripts, keyed by media id.
 *
 * The promise is cached rather than the result, so two views asking at once
 * share one fetch and one parse. Nothing is ever evicted: a transcript is a
 * few tens of kilobytes, and a session plays a handful of videos at most.
 */
const built = new Map<string, Promise<Transcript | null>>()

/** Whether captions can be shown for `mediaId` at all. */
export function hasTranscript(mediaId: string): boolean {
  return mediaId in SOURCES
}

/**
 * The transcript for `mediaId`, or `null` when there is none.
 *
 * Resolves to `null` rather than rejecting when the chunk cannot be fetched —
 * captions are an extra, and a listener whose audio is fine should not be told
 * anything went wrong because the words did not arrive.
 *
 * @param mediaId the id the screen's beat carries
 */
export function loadTranscript(mediaId: string): Promise<Transcript | null> {
  const cached = built.get(mediaId)

  if (cached) {
    return cached
  }

  const load = SOURCES[mediaId]

  if (!load) {
    return Promise.resolve(null)
  }

  const pending = load()
    .then(module => buildTranscript(module.default))
    .catch(() => null)

  built.set(mediaId, pending)

  return pending
}
