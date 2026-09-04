/**
 * Follower-side audio: plays the local soundtrack and continuously corrects it
 * toward the screen's video position.
 *
 * Engines:
 *  - Element (Android/desktop): <audio> routed through Web Audio. Small drifts
 *    are closed by nudging `playbackRate` (pitch preserved, no audible jump);
 *    large drifts hard-seek.
 *  - Buffer (iOS): Safari's media-element pipeline stalls >1s on seeks and
 *    spontaneously mid-playback, and it ignores fine playbackRate adjustments
 *    — element-side correction is unworkable there. Followers play a decoded
 *    AudioBuffer on the AudioContext clock instead (see BufferAudioEngine).
 *    While the soundtrack downloads/decodes the follower reports a 'syncing'
 *    state (silent — cleaner than the element's stuttery streaming playback);
 *    the element remains primed only as a fallback if fetch/decode fails.
 *
 * Autoplay gate: unlock() must run inside the join tap (fires play() before
 * any await).
 */
import { signedDrift, correctionRate } from '../sync/sync-math'
import { BufferAudioEngine } from './buffer-audio-engine'
import { StreamingBufferEngine } from './streaming-buffer-engine'

/** WebCodecs (iOS 16.4+) — required by the streaming engine, else long content
 * falls back to the element path. */
const WEBCODECS_OK = typeof AudioDecoder !== 'undefined'

const HARD_SEEK_SEC = 0.6 // only snap on large drift; the nudge closes anything smaller
const SEEK_COOLDOWN_MS = 8000 // keep hard seeks rare
const SEEK_SETTLE_MS = 400 // after a hard seek, let playback resume before re-steering
const LOCK_DEADBAND_SEC = 0.07 // hold rate=1 inside this band (±70ms — within the "good" A/V-sync range)
const LOCKED_SEC = 0.02 // UI "locked" threshold (tighter than the correction deadband)
const DRIFT_EMA_ALPHA = 0.25 // smooth noisy drift samples before steering
const RATE_EPS = 0.003 // skip playbackRate writes that wouldn't audibly change
const RATE_GAIN = 0.5
const RATE_MIN = 0.97
const RATE_MAX = 1.03
const MAX_LATENCY_SEC = 0.5 // clamp auto-measured output latency to something sane
const LATENCY_EMA_ALPHA = 0.2 // smooth the latency estimate
const IOS_FALLBACK_LATENCY_SEC = 0.12 // last resort when nothing reports (iOS)

const IS_IOS =
  typeof navigator !== 'undefined' &&
  (/iP(hone|ad|od)/.test(navigator.userAgent) ||
    (/Macintosh/.test(navigator.userAgent) &&
      (navigator.maxTouchPoints ?? 0) > 1))

/** What the corrector did on the latest tick. */
export type CorrectionMode = 'idle' | 'syncing' | 'seek' | 'nudge' | 'locked'

/** Which follower output path is live. */
export type AudioEngineKind = 'element' | 'buffer' | 'stream' | 'syncing'

/** What a follower's lock screen shows while audio is playing. */
export interface NowPlayingInfo {
  /** Title shown on the lock screen. */
  title: string
  /** Artist line shown under the title. */
  artist: string
}

/** How to build an {@link AudioSyncController}. */
export interface AudioSyncOptions {
  /**
   * A short clip used only to prime the `<audio>` element inside the unlock
   * gesture, before any real soundtrack is known. Never heard.
   */
  primerSoundtrackUrl: string
  /** What a follower's lock screen shows. Defaults to a generic label. */
  nowPlaying?: NowPlayingInfo
}

/** One tick's correction result, for the UI readout. */
export interface CorrectionInfo {
  /** What the corrector did on this tick. */
  mode: CorrectionMode
  /** Signed drift: positive ⇒ local audio is AHEAD of the screen, in ms. */
  driftMs: number
  /** Playback rate currently applied to close the drift. */
  rate: number
}

/**
 * An AudioContext-clock output engine the controller can steer toward the
 * screen's position. BufferAudioEngine (whole-file decode) and
 * StreamingBufferEngine (windowed WebCodecs decode) both implement this, so
 * the controller can pick per source without caring which is running.
 */
export interface FollowerAudioEngine {
  /** Prepare the audio graph; must be called inside a user gesture. */
  unlock(): Promise<void>
  /** Nudge the context and keep-alive element back to life after a suspend. */
  resume(): void
  /** Point the engine at a soundtrack and start fetching/decoding it. */
  setSource(url: string): void
  /** Whether audio for `url` is decoded and ready to play. */
  hasBufferFor(url: string): boolean
  /** Steer playback one tick toward `targetSec`. */
  correct(targetSec: number | null, playing: boolean): CorrectionInfo
  /** Drop the current segment so the next tick re-converges from scratch. */
  resync(): void
  /** Stop playback for good and tear down the keep-alive sink. */
  stop(): void
  /** Current playback position within the soundtrack, in seconds. */
  readonly currentTimeSec: number
  /** Soundtrack length in seconds, or `NaN` before it is loaded. */
  readonly duration: number
  /** Auto-measured output latency being compensated for, in ms. */
  readonly autoLatencyMs: number
  /** Whether the lock-screen keep-alive sink is wired up. */
  readonly backgroundKeepAlive: boolean
  /**
   * Called when the page is backgrounded / about to lock. Engines whose
   * playback needs the (soon-to-be-throttled) correction timer to keep going
   * should schedule enough audio ahead to survive the lock; those that free-run
   * natively (whole-file loop) can ignore it.
   */
  enterBackground?(): void
  /** Called when the page becomes visible again. */
  exitBackground?(): void
}

/**
 * Owns the follower's audio output: picks the right engine for each
 * soundtrack, keeps the <audio> element primed as a fallback, and corrects
 * whichever path is live toward the screen's position.
 */
export class AudioSyncController {
  /** The <audio> element: the live output whenever no engine is selected. */
  private element: HTMLAudioElement
  /** Soundtrack the follower should be playing right now. */
  private currentUrl: string
  /**
   * Web Audio context the element is routed through. Never created on iOS,
   * where the element plays directly as a bare fallback.
   */
  private ctx: AudioContext | null = null
  /** {@link element} wrapped as a Web Audio node, once routing succeeded. */
  private sourceNode: MediaElementAudioSourceNode | null = null
  /** Whether the element's output goes through Web Audio (mute-switch safe). */
  private routed = false
  /** Set by {@link stop}; keeps the element paused until the next unlock. */
  private hardStopped = false
  /** EMA of the raw drift, so steering isn't driven by per-tick noise. */
  private smoothedDriftSec = 0
  /** `Date.now()` of the last hard seek, for the seek cooldown. */
  private lastSeekAt = 0
  /** Last rate we asked the element for; reported back to the UI. */
  private lastAppliedRate = 1
  /**
   * Local playback position in seconds, advanced internally while the element
   * clock is frozen. See {@link sampleLocalSec}.
   */
  private trackedSec = 0
  /** `Date.now()` at which {@link trackedSec} was last updated (0 = never). */
  private lastTrackAt = 0
  /** Previous `element.currentTime`, used to spot a frozen element clock. */
  private lastObservedSec = -1
  /** `Date.now()` until which steering pauses after a hard seek. */
  private seekSettleUntil = 0
  /** Snap to the live target on join/resync, however small the drift. */
  private needsInitialSync = true
  /** Auto-measured output latency. See {@link sampleOutputLatency}. */
  private measuredLatencySec = 0
  /**
   * Whole-file decode engine — iOS, short content. `null` off iOS, where the
   * element path handles short content.
   */
  private bufferEngine: BufferAudioEngine | null = null
  /**
   * Windowed WebCodecs decode engine — any platform, long content. `null`
   * where WebCodecs is unavailable (iOS < 16.4).
   */
  private streamEngine: StreamingBufferEngine | null = null
  /**
   * The engine selected for {@link currentUrl}, or `null` when the element
   * path is the live output.
   */
  private engine: FollowerAudioEngine | null = null
  /** Whether the lock-screen now-playing session is wired (all platforms). */
  private mediaSessionReady = false
  /** The selected engine has loaded and is now the live output. */
  private engineActive = false
  /** The selected engine is still loading; the element stays silent. */
  private enginePending = false

  /** Whether {@link unlock} has run inside a user gesture. */
  unlocked = false

  /** What this device shows on its lock screen while audio is playing. */
  private readonly nowPlaying: NowPlayingInfo

  /**
   * Build the fallback <audio> element and the engines this platform can
   * use. Nothing here touches the AudioContext — that waits for the join tap
   * (see {@link unlock}).
   */
  constructor(options: AudioSyncOptions) {
    const primerUrl = options.primerSoundtrackUrl

    this.nowPlaying = options.nowPlaying ?? {
      title: 'Live audio',
      artist: 'Live audio session',
    }

    const element = new Audio()
    // Must be set BEFORE the src loads: the element is routed through Web
    // Audio (createMediaElementSource), and a cross-origin soundtrack loaded
    // in no-CORS mode taints the graph → silent output. 'anonymous' makes it a
    // CORS request (the media host sends Access-Control-Allow-Origin);
    // harmless for same-origin sources.
    element.crossOrigin = 'anonymous'
    element.loop = true
    element.preload = 'auto'
    element.preservesPitch = true
    element.src = primerUrl

    const vendorProps = element as unknown as Record<string, unknown>
    vendorProps.mozPreservesPitch = true
    vendorProps.webkitPreservesPitch = true

    this.element = element
    this.currentUrl = primerUrl

    if (WEBCODECS_OK) {
      this.streamEngine = new StreamingBufferEngine(() =>
        this.fallbackToElement(),
      )
    }

    if (IS_IOS) {
      this.bufferEngine = new BufferAudioEngine(() => this.fallbackToElement())
    }
  }

  /** Whether an engine owns the current source, loaded or still loading. */
  private get engineWanted(): boolean {
    return this.engine != null && (this.engineActive || this.enginePending)
  }

  /**
   * Which engine should own a source: stream for long content, buffer on iOS,
   * else `null` for the element path.
   */
  private engineFor(streaming: boolean): FollowerAudioEngine | null {
    if (streaming && this.streamEngine) {
      return this.streamEngine
    }

    return IS_IOS ? this.bufferEngine : null
  }

  /**
   * Abandon the selected engine and make the <audio> element the live output,
   * repointing it at the current soundtrack.
   */
  private fallbackToElement(): void {
    // Bail only if the element is ALREADY the live output (no engine engaged)
    // — otherwise we're falling back from an engine (mid-playback OR while it
    // was still loading), and must repoint the element from the constructor's
    // primer clip to the current soundtrack. Skipping that repoint on a load
    // failure during the pending phase would leave it playing the TEST CLIP.
    if (!this.engineActive && !this.enginePending) {
      return
    }

    this.engine = null
    this.engineActive = false
    this.enginePending = false
    this.element.src = this.currentUrl // the live soundtrack, not the primer's test clip
    this.element.muted = false
    this.resetAfterSourceChange()
  }

  /**
   * Point the follower at a soundtrack, selecting the output engine for it.
   *
   * @param url the soundtrack to play
   * @param streaming long-form audio → windowed WebCodecs decode
   */
  setSource(url: string, streaming = false): void {
    if (!url) {
      return
    }

    const changed = url !== this.currentUrl
    this.currentUrl = url

    const wanted = this.engineFor(streaming)

    if (wanted !== this.engine) {
      this.engine?.correct(null, false) // stop the outgoing engine's playback
      this.engine = wanted
      this.engineActive = false
      this.enginePending = wanted != null

      if (!wanted) {
        this.element.src = url // element becomes the live output
        this.element.muted = false
        this.resetAfterSourceChange()
      }
    }

    if (this.engine) {
      this.engine.setSource(url) // kicks download/decode
    } else if (changed) {
      this.element.src = url
      this.resetAfterSourceChange()
    }
  }

  /** Clear the element path's clock and drift state after a source change. */
  private resetAfterSourceChange(): void {
    this.trackedSec = 0
    this.lastTrackAt = 0
    this.lastObservedSec = -1
    this.smoothedDriftSec = 0
    this.needsInitialSync = true
  }

  /** Current playback position of the live output path, in seconds. */
  get currentTimeSec(): number {
    if (this.engineActive) {
      return this.engine!.currentTimeSec
    }

    return this.trackedSec || this.element.currentTime
  }

  /** Soundtrack length in seconds, or `NaN` before it is known. */
  get duration(): number {
    if (this.engineActive) {
      return this.engine!.duration
    }

    return this.element.duration
  }

  /** Whether output goes through Web Audio (so it ignores the mute switch). */
  get routedThroughWebAudio(): boolean {
    return this.engineActive || this.routed
  }

  /** Auto-measured output latency being compensated for, in ms. */
  get autoLatencyMs(): number {
    if (this.engineActive) {
      return this.engine!.autoLatencyMs
    }

    return this.outputLatencySec() * 1000
  }

  /** Whether the lock-screen keep-alive sink is active. */
  get backgroundKeepAlive(): boolean {
    return this.engineActive && (this.engine?.backgroundKeepAlive ?? false)
  }

  /** Which output path is live — for the debug panel. */
  get engineKind(): AudioEngineKind {
    if (this.enginePending) {
      return 'syncing'
    }

    if (this.engineActive) {
      return this.engine === this.streamEngine ? 'stream' : 'buffer'
    }

    return 'element'
  }

  /**
   * Unlock audio output. Must be called inside the join tap: the element's
   * `play()` and the context resume both need the gesture.
   */
  async unlock(): Promise<void> {
    this.hardStopped = false
    this.smoothedDriftSec = 0
    this.lastAppliedRate = 1
    this.trackedSec = 0
    this.lastTrackAt = 0
    this.seekSettleUntil = 0
    this.needsInitialSync = true
    this.setupMediaSession() // lock-screen now-playing card (all platforms; must be in-gesture)

    // Unlock BOTH engines inside this gesture (context creation + resume +
    // sink play must be gesture-initiated on iOS), since which one we need
    // isn't known until the first beat picks a source. Whichever is later
    // selected is then already warm. Failures are non-fatal — the per-engine
    // load path falls back to the element.
    const engineUnlocks = [
      this.streamEngine?.unlock().catch(() => {}),
      this.bufferEngine?.unlock().catch(() => {}),
    ].filter(Boolean) as Promise<void>[]

    if (this.unlocked) {
      await Promise.allSettled(engineUnlocks)

      return
    }

    try {
      const AudioContextCtor =
        window.AudioContext ||
        (
          window as unknown as {
            webkitAudioContext?: typeof AudioContext
          }
        ).webkitAudioContext

      // On iOS the element is only the fallback and plays directly (no Web
      // Audio routing: Safari's MediaElementSource pipeline is the thing we're
      // avoiding).
      if (AudioContextCtor && !this.ctx && !IS_IOS) {
        this.ctx = new AudioContextCtor()

        try {
          // Create the source but DON'T connect to the destination yet —
          // priming the element (below) then makes no sound, so the listener
          // never hears the test soundtrack blip during the join tap. We
          // connect after priming.
          this.sourceNode = this.ctx.createMediaElementSource(this.element)
          this.routed = true
        } catch {
          this.routed = false
        }
      }

      // Prime inside the gesture to unlock the element + resume the context.
      // Muted, and (when routed) not yet connected to output → silent.
      this.element.muted = true
      const played = this.element.play()
      const resumed =
        this.ctx && this.ctx.state === 'suspended'
          ? this.ctx.resume()
          : Promise.resolve()
      await Promise.allSettled([played, resumed])

      this.element.pause()
      this.element.currentTime = 0

      // On iOS the element is ONLY a fallback and is never routed through Web
      // Audio, so keep it muted until we actually fall back
      // (fallbackToElement unmutes). iOS doesn't reliably honor the pause()
      // above, so the primed test clip would otherwise keep looping audibly
      // alongside the buffer engine once the engine takes over (correct()
      // never re-pauses it).
      if (!IS_IOS) {
        this.element.muted = false
      }

      // Now route to the output for real, audible playback.
      if (this.sourceNode && this.ctx) {
        this.sourceNode.connect(this.ctx.destination)
      }

      this.unlocked = true
    } catch {
      this.unlocked = true
    }

    await Promise.allSettled(engineUnlocks)
  }

  /** Recover the live output path after a suspend (iOS backgrounding). */
  resume(): void {
    if (this.engineWanted) {
      this.engine!.resume()
    }

    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {})
    }
  }

  /**
   * Page hidden / about to lock: let the active engine schedule audio ahead to
   * survive it.
   */
  enterBackground(): void {
    if (this.engineActive) {
      this.engine?.enterBackground?.()
    }
  }

  /**
   * Page visible again: tear down any free-run scheduling; the caller then
   * resyncs.
   */
  exitBackground(): void {
    if (this.engineActive) {
      this.engine?.exitBackground?.()
    }
  }

  /**
   * Register a lock-screen / now-playing MediaSession. Cross-platform: on iOS
   * it also anchors the background keep-alive (BufferAudioEngine's stream-sink
   * element is the thing iOS keeps alive); on Android/desktop it's the
   * now-playing card. Idempotent, and must be called inside the join gesture
   * so the action handlers stick.
   */
  private setupMediaSession(): void {
    if (this.mediaSessionReady) {
      return
    }

    const mediaSession = navigator.mediaSession

    if (!mediaSession) {
      return
    }

    this.mediaSessionReady = true

    try {
      if ('MediaMetadata' in window) {
        mediaSession.metadata = new MediaMetadata(this.nowPlaying)
      }

      mediaSession.playbackState = 'playing'
      // A synced room shouldn't be pausable from one follower's lock screen
      // (it would just desync and go silent), so both handlers re-warm
      // playback rather than stop it.
      mediaSession.setActionHandler('play', () => this.resume())
      mediaSession.setActionHandler('pause', () => this.resume())
    } catch {
      /* MediaSession is best-effort */
    }
  }

  /** Release the now-playing session and its action handlers. */
  private teardownMediaSession(): void {
    this.mediaSessionReady = false

    const mediaSession = navigator.mediaSession

    if (!mediaSession) {
      return
    }

    mediaSession.playbackState = 'none'

    try {
      mediaSession.setActionHandler('play', null)
      mediaSession.setActionHandler('pause', null)
    } catch {
      /* ignore */
    }
  }

  /**
   * Auto-measure the device's true output latency (element position → what's
   * actually heard) so we can steer the element ahead by exactly that much —
   * fully automatic, no user calibration (this is BYOD).
   *
   * Primary signal: getOutputTimestamp() — (currentTime − contextTime) is the
   * full scheduling→output delay and reflects the REAL output path, INCLUDING
   * Bluetooth (which varies 100–300 ms and no fixed constant could cover).
   * Fallback: outputLatency (flaky — reads 0 until warmup even on Chrome).
   */
  private sampleOutputLatency(): void {
    const ctx = this.ctx

    if (!ctx) {
      return
    }

    let latencySec: number | null = null
    const timestamp = ctx.getOutputTimestamp?.()

    if (
      timestamp &&
      typeof timestamp.contextTime === 'number' &&
      timestamp.contextTime > 0
    ) {
      const delta = ctx.currentTime - timestamp.contextTime

      if (delta > 0.001 && delta < 1) {
        latencySec = delta
      }
    }

    if (
      latencySec == null &&
      typeof ctx.outputLatency === 'number' &&
      ctx.outputLatency > 0
    ) {
      latencySec = ctx.outputLatency + (ctx.baseLatency ?? 0)
    }

    if (latencySec == null) {
      return
    }

    latencySec = Math.min(MAX_LATENCY_SEC, Math.max(0, latencySec))
    this.measuredLatencySec = this.measuredLatencySec
      ? this.measuredLatencySec * (1 - LATENCY_EMA_ALPHA) +
        latencySec * LATENCY_EMA_ALPHA
      : latencySec
  }

  /** Output latency to compensate for on the element path, in seconds. */
  private outputLatencySec(): number {
    if (this.routed) {
      return this.measuredLatencySec
    }

    // Plain element output (the iOS fallback) has real device latency we can't
    // measure.
    return IS_IOS ? IOS_FALLBACK_LATENCY_SEC : 0
  }

  /** Shift the target forward by the output latency, wrapped into the loop. */
  private steerTarget(targetSec: number, duration: number): number {
    const shift = this.outputLatencySec()

    if (shift <= 0) {
      return targetSec
    }

    return (((targetSec + shift) % duration) + duration) % duration
  }

  /** Apply a playback rate to the element, skipping inaudible changes. */
  private setPlaybackRate(rate: number): void {
    // Compare against the element's ACTUAL rate, not a cache of what we last
    // wrote — engines may silently reset playbackRate to 1 after
    // seeks/stalls/interruptions, and trusting a cache would leave the nudge
    // corrector permanently inert.
    this.lastAppliedRate = rate

    if (Math.abs(rate - this.element.playbackRate) <= RATE_EPS) {
      return
    }

    try {
      this.element.playbackRate = rate
    } catch {
      /* some engines reject rates mid-load */
    }
  }

  /**
   * Honest local clock: trust any fresh element reading — even one BEHIND the
   * previous value — and advance an internal clock ONLY while the element
   * clock is genuinely frozen (e.g. briefly around seeks). A forward-only
   * ratchet here once let the synthetic clock detach from real playback and
   * measure drift against its own assumption, hiding genuine desync.
   */
  private sampleLocalSec(): number {
    const observed = this.element.currentTime
    const now = Date.now()
    const alive = observed !== this.lastObservedSec
    this.lastObservedSec = observed

    if (alive || this.element.paused || this.lastTrackAt === 0) {
      this.trackedSec = observed
      this.lastTrackAt = now

      return observed
    }

    const elapsedSec = (now - this.lastTrackAt) / 1000
    this.trackedSec += elapsedSec * (this.element.playbackRate || 1)
    this.lastTrackAt = now

    return this.trackedSec
  }

  /**
   * Steer the live output path one tick toward the screen's position.
   *
   * @param targetSec the screen's position, or `null` when it is unknown
   * @param playing whether the screen's video is playing
   */
  correct(targetSec: number | null, playing: boolean): CorrectionInfo {
    if (this.enginePending) {
      if (this.engine!.hasBufferFor(this.currentUrl)) {
        // Decoded/demuxed soundtrack just became available — the engine takes
        // over (it snaps straight onto the live target on its first tick).
        this.enginePending = false
        this.engineActive = true
      } else {
        // Stay silent while downloading/decoding rather than limping along on
        // the stuttery element pipeline; the UI shows this as "syncing".
        if (!this.element.paused) {
          this.element.pause()
        }

        return { mode: 'syncing', driftMs: 0, rate: 1 }
      }
    }

    if (this.engineActive) {
      return this.engine!.correct(targetSec, playing)
    }

    if (this.hardStopped) {
      if (!this.element.paused) {
        this.element.pause()
      }

      return { mode: 'idle', driftMs: 0, rate: 1 }
    }

    if (targetSec == null || !playing) {
      if (!this.element.paused) {
        this.element.pause()
      }

      this.setPlaybackRate(1)

      return { mode: 'idle', driftMs: 0, rate: 1 }
    }

    const duration = this.element.duration

    if (!isFinite(duration) || duration <= 0) {
      this.element.play().catch(() => {})

      return { mode: 'idle', driftMs: 0, rate: this.lastAppliedRate }
    }

    if (this.element.paused) {
      this.element.play().catch(() => {})
    }

    this.sampleOutputLatency() // keep the auto latency estimate fresh

    const localSec = this.sampleLocalSec()
    const aim = this.steerTarget(targetSec, duration)
    const rawDrift = signedDrift(localSec, aim, duration)
    this.smoothedDriftSec =
      DRIFT_EMA_ALPHA * rawDrift +
      (1 - DRIFT_EMA_ALPHA) * this.smoothedDriftSec
    const drift = this.smoothedDriftSec

    const now = Date.now()
    const cooldownElapsed = now - this.lastSeekAt >= SEEK_COOLDOWN_MS
    const settled = now >= this.seekSettleUntil

    const needsSnap =
      this.needsInitialSync ||
      (settled &&
        cooldownElapsed &&
        Math.abs(rawDrift) > HARD_SEEK_SEC &&
        Math.abs(drift) > HARD_SEEK_SEC * 0.75)

    if (needsSnap) {
      this.needsInitialSync = false

      try {
        this.element.currentTime = aim
      } catch {
        /* not seekable yet — the next tick retries via drift */
      }

      this.trackedSec = aim
      this.lastTrackAt = now
      this.lastObservedSec = this.element.currentTime
      this.smoothedDriftSec = 0
      this.lastSeekAt = now
      this.seekSettleUntil = now + SEEK_SETTLE_MS
      this.setPlaybackRate(1)

      return { mode: 'seek', driftMs: rawDrift * 1000, rate: 1 }
    }

    if (now < this.seekSettleUntil) {
      return {
        mode: 'nudge',
        driftMs: rawDrift * 1000,
        rate: this.lastAppliedRate,
      }
    }

    const mode: CorrectionMode =
      Math.abs(rawDrift) < LOCKED_SEC ? 'locked' : 'nudge'

    if (Math.abs(drift) < LOCK_DEADBAND_SEC) {
      this.setPlaybackRate(1)

      return { mode, driftMs: rawDrift * 1000, rate: 1 }
    }

    const rate = correctionRate(drift, RATE_GAIN, RATE_MIN, RATE_MAX)
    this.setPlaybackRate(rate)

    return {
      mode,
      driftMs: rawDrift * 1000,
      rate: this.lastAppliedRate,
    }
  }

  /** Re-snap to the live target on the next tick, however small the drift. */
  resync(): void {
    if (this.engineActive) {
      this.engine!.resync()

      return
    }

    this.smoothedDriftSec = 0
    this.lastSeekAt = 0
    this.seekSettleUntil = 0
    this.needsInitialSync = true
    this.trackedSec = this.element.currentTime
    this.lastTrackAt = Date.now()
  }

  /** Stop all output paths and release the now-playing session. */
  stop(): void {
    this.bufferEngine?.stop()
    this.streamEngine?.stop()
    this.teardownMediaSession()
    this.hardStopped = true
    this.element.pause()
    this.element.playbackRate = 1
    this.lastAppliedRate = 1
    this.trackedSec = 0
    this.lastTrackAt = 0
    this.seekSettleUntil = 0
    this.needsInitialSync = true
  }
}
