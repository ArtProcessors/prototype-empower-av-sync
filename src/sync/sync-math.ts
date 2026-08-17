/**
 * Pure, unit-testable sync helpers. No DOM, no transport.
 *
 * The screen (leader) periodically emits a {@link Beat} carrying where its
 * looping video is and the screen wall-clock at that instant. A follower
 * estimates the screen↔follower clock offset (Cristian's algorithm),
 * extrapolates the screen's current video position, and computes a signed,
 * loop-aware drift for its local audio — then either hard-seeks or nudges
 * playbackRate to close it.
 */

/** One position broadcast from the screen to every follower. */
export interface Beat {
  /** Video the screen is playing; followers load the matching soundtrack. */
  mediaId: string
  /** The screen's `video.currentTime`, captured at {@link Beat.wall}. */
  videoTime: number
  /** The screen's `Date.now()` when the beat was emitted, in ms. */
  wall: number
  /** Whether the screen's video was playing (rather than paused). */
  playing: boolean
  /** Loop length — the video's duration, in seconds. */
  duration: number
}

/** One round-trip measurement of the screen's clock, seen from a follower. */
export interface ClockSample {
  /** Round-trip time of the measurement, in ms. */
  rtt: number
  /** Add to a follower `Date.now()` to get the screen's clock, in ms. */
  offset: number
}

/**
 * Estimate the screen's clock offset with Cristian's algorithm.
 *
 * @param requestedAt follower-clock ms at which the request was sent
 * @param screenTime screen-clock ms stamped when the screen replied
 * @param respondedAt follower-clock ms at which the reply arrived
 */
export function estimateOffset(
  requestedAt: number,
  screenTime: number,
  respondedAt: number,
): ClockSample {
  const rtt = Math.max(0, respondedAt - requestedAt)
  const offset = screenTime - (requestedAt + respondedAt) / 2

  return { rtt, offset }
}

/**
 * Pick the least-jittered estimate from a window of samples: the one with the
 * smallest round-trip time. Returns `null` for an empty window.
 */
export function bestOffset(
  samples: readonly ClockSample[],
): ClockSample | null {
  if (samples.length === 0) {
    return null
  }

  return samples.reduce((best, sample) =>
    sample.rtt < best.rtt ? sample : best,
  )
}

/**
 * Work out where the screen's video is *right now*, wrapped into
 * `[0, beat.duration)`.
 *
 * @param beat the most recent beat received from the screen
 * @param offsetMs screen↔follower clock offset (see {@link estimateOffset})
 * @param now the current follower-clock time, in ms
 */
export function computeTarget(
  beat: Beat,
  offsetMs: number,
  now: number,
): number {
  const elapsedSec = (now + offsetMs - beat.wall) / 1000
  const extrapolated =
    beat.videoTime + (beat.playing ? Math.max(0, elapsedSec) : 0)
  const duration = beat.duration

  if (!isFinite(duration) || duration <= 0) {
    return Math.max(0, extrapolated)
  }

  return ((extrapolated % duration) + duration) % duration
}

/**
 * Signed shortest distance from `local` to `target` around a loop of
 * `duration`.
 *
 * Positive ⇒ local is AHEAD of target (audio should slow down to let the
 * target catch up). Handles the loop seam, so local 19.9 against target 0.1
 * over a 20 s loop reads as -0.2, not +19.8.
 */
export function signedDrift(
  local: number,
  target: number,
  duration: number,
): number {
  if (!isFinite(duration) || duration <= 0) {
    return local - target
  }

  const half = duration / 2

  return ((((local - target + half) % duration) + duration) % duration) - half
}

/**
 * Playback rate that gently closes a small drift.
 *
 * `driftSec` > 0 (ahead) ⇒ rate < 1 (slow down); < 0 (behind) ⇒ rate > 1
 * (speed up). The result is clamped to `[min, max]`.
 */
export function correctionRate(
  driftSec: number,
  gain = 0.8,
  min = 0.94,
  max = 1.06,
): number {
  const rate = 1 - driftSec * gain

  return Math.min(max, Math.max(min, rate))
}
