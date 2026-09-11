/**
 * What the screen can lead with, as a contract rather than a fixed list.
 *
 * The catalogue used to be a module in `src/content` that the core imported
 * directly — which meant the core also imported that app's video files, its
 * CDN host and its Vite asset pipeline. Inverting it leaves the core knowing
 * only the shape, and the host supplying the content.
 */

/** One thing the screen can lead with, plus the audio followers play. */
export interface MediaOption {
  /** Stable id broadcast on every beat as `mediaId`. */
  id: string
  /** Human-readable name shown in the screen's picker. */
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

/** Everything a session can play, and what it starts on. */
export interface MediaCatalogue {
  /**
   * Every option a session can play, in picker order. Must not be empty.
   *
   * This is the resolution list: a beat naming an id gets looked up here, so
   * anything a screen might lead with has to be in it — including whatever a
   * host keeps out of {@link MediaCatalogue.offered}.
   */
  options: readonly MediaOption[]
  /**
   * The subset a picker should list. A host that offers everything it can play
   * sets this to {@link MediaCatalogue.options}.
   *
   * Separate from `options` because "playable" and "choosable" are not the
   * same question. A fallback the session leans on when nothing else is named
   * has to be playable by every device in the room, and has no business in a
   * menu — putting it in one invites an operator to select the thing that is
   * meant to mean *nothing was selected*.
   */
  offered: readonly MediaOption[]
  /** Which option the screen leads with until the user picks another. */
  defaultId: string
  /**
   * A short clip used only to prime the follower's audio element inside the
   * unlock gesture, before any real soundtrack is known. Never heard.
   */
  primerSoundtrackUrl: string
}

/**
 * Look up an option by id, falling back to the first when the id is unknown —
 * e.g. a beat from a screen running a newer build.
 */
export function mediaById(catalogue: MediaCatalogue, id: string): MediaOption {
  return (
    catalogue.options.find(option => option.id === id) ?? catalogue.options[0]
  )
}

/** Whether `id` names an option this catalogue actually has. */
export function isKnownMedia(catalogue: MediaCatalogue, id: string): boolean {
  return catalogue.options.some(option => option.id === id)
}
