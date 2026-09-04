/**
 * The follower's corrector: a ~15 Hz loop that works out where the screen is
 * right now and steers the local audio towards it.
 *
 * Everything it needs is read fresh on every tick, deliberately. The transport
 * is handed in as a getter rather than a value because a watchdog rejoin
 * replaces it mid-session, and a loop holding the old one would steer off a
 * dead room's last known beat forever.
 */
import type {
  AudioSyncController,
  CorrectionInfo,
} from '../media/audio-sync-controller'
import { computeTarget } from '../sync/sync-math'
import type { SyncController } from '../transport/sync-controller'
import { sessionConfig } from './config'
import type { MediaOption } from './media-catalogue'

/** One tick's worth of readings, for the caller to publish. */
export interface CorrectionTick {
  /** How the audio was corrected on this tick. */
  correction: CorrectionInfo
  /** Local audio position, in seconds. */
  localTime: number
  /** The screen's extrapolated position, or `null` if there is nothing to aim at. */
  targetTime: number | null
}

/** What the loop needs to run. */
export interface CorrectionLoopOptions {
  /** The transport to steer from, read fresh on every tick. */
  transport: () => SyncController | null
  /** The audio being steered. */
  audio: AudioSyncController
  /** Resolve the `mediaId` a beat carries to the soundtrack to load. */
  resolveMedia: (mediaId: string) => MediaOption
  /**
   * Read the epoch/clock-ready pair the loop compares against to spot a
   * resync, and write it back when it moves. Shared with the session because
   * a rejoin and a return from background reseed it too.
   */
  syncMarker: {
    /** Last `syncEpoch` this loop acted on. */
    epoch: number
    /** Whether a clock offset was available last tick. */
    clockReady: boolean
  }
  /** Called once per tick with the readings. */
  onTick: (tick: CorrectionTick) => void
}

/** Start the corrector. Call the returned function to stop it. */
export function startCorrectionLoop({
  transport,
  audio,
  resolveMedia,
  syncMarker,
  onTick,
}: CorrectionLoopOptions): () => void {
  const { correctMs, beatFreshMs } = sessionConfig().timing

  const timer = setInterval(() => {
    const controller = transport()

    if (!controller) {
      return
    }

    // Recover the Web Audio context if iOS suspended it (backgrounding).
    audio.resume()

    const syncState = controller.getState()

    if (syncState.syncEpoch !== syncMarker.epoch) {
      syncMarker.epoch = syncState.syncEpoch
      audio.resync()
    }

    if (syncState.clockReady && !syncMarker.clockReady) {
      syncMarker.clockReady = true
      audio.resync()
      syncMarker.epoch = syncState.syncEpoch
    } else if (!syncState.clockReady) {
      syncMarker.clockReady = false
    }

    const beat = syncState.latestBeat
    const now = Date.now()
    let target: number | null = null
    let playing = false

    const beatUsable =
      beat != null &&
      syncState.screenOnline &&
      syncState.clockReady &&
      now - syncState.lastBeatAt < beatFreshMs

    if (beatUsable) {
      const media = resolveMedia(beat.mediaId)
      // Load the audio that matches the video the screen is playing.
      audio.setSource(media.soundtrackUrl, media.streaming)
      target = computeTarget(beat, syncState.offsetMs, now)
      playing = beat.playing
    }

    onTick({
      correction: audio.correct(target, playing),
      localTime: audio.currentTimeSec,
      targetTime: target,
    })
  }, correctMs) as unknown as number

  return () => clearInterval(timer)
}
