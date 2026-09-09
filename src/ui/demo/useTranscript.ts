/**
 * The transcript for whatever the screen is currently playing.
 *
 * Keyed on the media id the beat carries rather than on anything this device
 * chose, so a screen that switches video switches the words with it. Nothing
 * is fetched until a listener actually asks for captions — the `enabled` flag
 * is what spends the request — and the loader below memoises, so turning them
 * off and on again costs nothing.
 */
import { useEffect, useState } from 'react'

import { hasTranscript, loadTranscript } from '../../content/transcripts'
import type { Transcript } from '../../core/transcript'

/**
 * Load the transcript for `mediaId`, or `null` while there is nothing to show.
 *
 * @param mediaId id from the screen's latest beat, or `null` before one lands
 * @param enabled whether captions are switched on; `false` fetches nothing
 */
export function useTranscript(
  mediaId: string | null,
  enabled: boolean,
): Transcript | null {
  const [transcript, setTranscript] = useState<Transcript | null>(null)

  useEffect(() => {
    if (!enabled || !mediaId) {
      setTranscript(null)

      return
    }

    // Cleared first: the previous video's words must not stay up over a new
    // one while its file is in flight.
    setTranscript(null)

    let live = true

    // No rejection to handle: `loadTranscript` resolves to `null` when it
    // cannot fetch, because a listener whose audio is fine should not be told
    // that the words did not arrive.
    loadTranscript(mediaId).then(loaded => {
      if (live) {
        setTranscript(loaded)
      }
    })

    return () => {
      live = false
    }
  }, [mediaId, enabled])

  return transcript
}

/** Whether captions are worth offering for `mediaId` — i.e. one exists. */
export function transcriptExists(mediaId: string | null): boolean {
  return mediaId !== null && hasTranscript(mediaId)
}
