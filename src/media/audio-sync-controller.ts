/**
 * Follower-side audio: plays the local soundtrack and continuously corrects it toward the
 * screen's video position.
 *
 * Engines:
 *  - Element (Android/desktop): <audio> routed through Web Audio. Small drifts are closed
 *    by nudging `playbackRate` (pitch preserved, no audible jump); large drifts hard-seek.
 *  - Buffer (iOS): Safari's media-element pipeline stalls >1s on seeks and spontaneously
 *    mid-playback, and it ignores fine playbackRate adjustments — element-side correction
 *    is unworkable there. Followers play a decoded AudioBuffer on the AudioContext clock
 *    instead (see BufferAudioEngine). While the soundtrack downloads/decodes the follower
 *    reports a 'syncing' state (silent — cleaner than the element's stuttery streaming
 *    playback); the element remains primed only as a fallback if fetch/decode fails.
 *
 * Autoplay gate: unlock() must run inside the join tap (fires play() before any await).
 */
import { SYNTH_SOUNDTRACK_URL } from '../content'
import { signedDrift, correctionRate } from '../sync/sync-math'
import { BufferAudioEngine } from './buffer-audio-engine'
import { StreamingBufferEngine } from './streaming-buffer-engine'

/** WebCodecs (iOS 16.4+) — required by the streaming engine; else long content falls back. */
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
    (/Macintosh/.test(navigator.userAgent) && (navigator.maxTouchPoints ?? 0) > 1))

export type CorrectionMode = 'idle' | 'syncing' | 'seek' | 'nudge' | 'locked'
export interface CorrectionInfo {
  mode: CorrectionMode
  driftMs: number // signed: + = local audio is AHEAD of the screen
  rate: number
}

/**
 * An AudioContext-clock output engine the controller can steer toward the screen's position.
 * BufferAudioEngine (whole-file decode) and StreamingBufferEngine (windowed WebCodecs decode)
 * both implement this, so the controller can pick per source without caring which is running.
 */
export interface FollowerAudioEngine {
  unlock(): Promise<void>
  resume(): void
  setSource(url: string): void
  hasBufferFor(url: string): boolean
  correct(targetSec: number | null, playing: boolean): CorrectionInfo
  resync(): void
  stop(): void
  readonly currentTimeSec: number
  readonly duration: number
  readonly autoLatencyMs: number
  readonly backgroundKeepAlive: boolean
  /**
   * Called when the page is backgrounded / about to lock. Engines whose playback needs the
   * (soon-to-be-throttled) correction timer to keep going should schedule enough audio ahead
   * to survive the lock; those that free-run natively (whole-file loop) can ignore it.
   */
  enterBackground?(): void
  exitBackground?(): void
}

export class AudioSyncController {
  private el: HTMLAudioElement
  private currentUrl: string
  private ctx: AudioContext | null = null
  private srcNode: MediaElementAudioSourceNode | null = null
  private routed = false
  private hardStopped = false
  private smoothedDriftSec = 0
  private lastSeekAt = 0
  private lastAppliedRate = 1
  private trackedSec = 0
  private lastTrackAt = 0
  private lastObservedSec = -1
  private seekSettleUntil = 0
  private needsInitialSync = true // snap to the live target on join/resync, however small the drift
  private measuredLatencySec = 0 // auto-measured output latency (see sampleOutputLatency)
  // Advanced (AudioContext-clock) engines: buffer = whole-file decode (iOS, short content);
  // stream = windowed WebCodecs decode (any platform, long content). `engine` points at the
  // one selected for the current source, or null when the element path is the live output.
  private bufferEngine: BufferAudioEngine | null = null
  private streamEngine: StreamingBufferEngine | null = null
  private engine: FollowerAudioEngine | null = null
  private mediaSessionReady = false // lock-screen now-playing session wired (all platforms)
  private engineActive = false // the selected engine is the live output (once loaded)
  private enginePending = false // engine is loading; element/silent meanwhile
  unlocked = false

  constructor() {
    const el = new Audio()
    // Must be set BEFORE the src loads: the element is routed through Web Audio
    // (createMediaElementSource), and a cross-origin soundtrack loaded in no-CORS mode taints
    // the graph → silent output. 'anonymous' makes it a CORS request (the media host sends
    // Access-Control-Allow-Origin); harmless for same-origin sources.
    el.crossOrigin = 'anonymous'
    el.loop = true
    el.preload = 'auto'
    el.preservesPitch = true
    el.src = SYNTH_SOUNDTRACK_URL
    const anyEl = el as unknown as Record<string, unknown>
    anyEl.mozPreservesPitch = true
    anyEl.webkitPreservesPitch = true
    this.el = el
    this.currentUrl = SYNTH_SOUNDTRACK_URL
    if (WEBCODECS_OK) this.streamEngine = new StreamingBufferEngine(() => this.fallbackToElement())
    if (IS_IOS) this.bufferEngine = new BufferAudioEngine(() => this.fallbackToElement())
  }

  private get engineWanted(): boolean {
    return this.engine != null && (this.engineActive || this.enginePending)
  }

  /** Which engine should own a source: stream for long content, buffer on iOS, else element. */
  private engineFor(streaming: boolean): FollowerAudioEngine | null {
    if (streaming && this.streamEngine) return this.streamEngine
    return IS_IOS ? this.bufferEngine : null
  }

  private fallbackToElement(): void {
    // Bail only if the element is ALREADY the live output (no engine engaged) — otherwise we're
    // falling back from an engine (mid-playback OR while it was still loading), and must repoint
    // the element from the constructor's primer clip to the current soundtrack. Skipping that
    // repoint on a load failure during the pending phase would leave it playing the TEST CLIP.
    if (!this.engineActive && !this.enginePending) return
    this.engine = null
    this.engineActive = false
    this.enginePending = false
    this.el.src = this.currentUrl // the live soundtrack, not the primer's test clip
    this.el.muted = false
    this.resetAfterSourceChange()
  }

  setSource(url: string, streaming = false): void {
    if (!url) return
    const changed = url !== this.currentUrl
    this.currentUrl = url
    const want = this.engineFor(streaming)
    if (want !== this.engine) {
      this.engine?.correct(null, false) // stop the outgoing engine's playback
      this.engine = want
      this.engineActive = false
      this.enginePending = want != null
      if (!want) {
        this.el.src = url // element becomes the live output
        this.el.muted = false
        this.resetAfterSourceChange()
      }
    }
    if (this.engine) this.engine.setSource(url) // kicks download/decode
    else if (changed) {
      this.el.src = url
      this.resetAfterSourceChange()
    }
  }

  private resetAfterSourceChange(): void {
    this.trackedSec = 0
    this.lastTrackAt = 0
    this.lastObservedSec = -1
    this.smoothedDriftSec = 0
    this.needsInitialSync = true
  }

  get currentTimeSec(): number {
    if (this.engineActive) return this.engine!.currentTimeSec
    return this.trackedSec || this.el.currentTime
  }
  get duration(): number {
    if (this.engineActive) return this.engine!.duration
    return this.el.duration
  }
  get routedThroughWebAudio(): boolean {
    return this.engineActive || this.routed
  }
  get autoLatencyMs(): number {
    if (this.engineActive) return this.engine!.autoLatencyMs
    return this.outputLatencySec() * 1000
  }
  get backgroundKeepAlive(): boolean {
    return this.engineActive && (this.engine?.backgroundKeepAlive ?? false)
  }
  /** Which output path is live — for the debug panel. */
  get engineKind(): 'element' | 'buffer' | 'stream' | 'syncing' {
    if (this.enginePending) return 'syncing'
    if (this.engineActive) return this.engine === this.streamEngine ? 'stream' : 'buffer'
    return 'element'
  }

  async unlock(): Promise<void> {
    this.hardStopped = false
    this.smoothedDriftSec = 0
    this.lastAppliedRate = 1
    this.trackedSec = 0
    this.lastTrackAt = 0
    this.seekSettleUntil = 0
    this.needsInitialSync = true
    this.setupMediaSession() // lock-screen now-playing card (all platforms; must be in-gesture)
    // Unlock BOTH engines inside this gesture (context creation + resume + sink play must be
    // gesture-initiated on iOS), since which one we need isn't known until the first beat picks
    // a source. Whichever is later selected is then already warm. Failures are non-fatal — the
    // per-engine load path falls back to the element.
    const engineUnlocks = [
      this.streamEngine?.unlock().catch(() => {}),
      this.bufferEngine?.unlock().catch(() => {}),
    ].filter(Boolean) as Promise<void>[]
    if (this.unlocked) {
      await Promise.allSettled(engineUnlocks)
      return
    }
    try {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      // On iOS the element is only the fallback and plays directly (no Web Audio routing:
      // Safari's MediaElementSource pipeline is the thing we're avoiding).
      if (Ctx && !this.ctx && !IS_IOS) {
        this.ctx = new Ctx()
        try {
          // Create the source but DON'T connect to the destination yet — priming the
          // element (below) then makes no sound, so the listener never hears the test
          // soundtrack blip during the join tap. We connect after priming.
          this.srcNode = this.ctx.createMediaElementSource(this.el)
          this.routed = true
        } catch {
          this.routed = false
        }
      }

      // Prime inside the gesture to unlock the element + resume the context. Muted, and
      // (when routed) not yet connected to output → silent.
      this.el.muted = true
      const playPromise = this.el.play()
      const resumePromise =
        this.ctx && this.ctx.state === 'suspended' ? this.ctx.resume() : Promise.resolve()
      await Promise.allSettled([playPromise, resumePromise])

      this.el.pause()
      this.el.currentTime = 0
      // On iOS the element is ONLY a fallback and is never routed through Web Audio, so keep
      // it muted until we actually fall back (fallbackToElement unmutes). iOS doesn't reliably
      // honor the pause() above, so the primed test clip would otherwise keep looping audibly
      // alongside the buffer engine once useBuffer takes over (correct() never re-pauses it).
      if (!IS_IOS) this.el.muted = false
      // Now route to the output for real, audible playback.
      if (this.srcNode && this.ctx) this.srcNode.connect(this.ctx.destination)
      this.unlocked = true
    } catch {
      this.unlocked = true
    }
    await Promise.allSettled(engineUnlocks)
  }

  resume(): void {
    if (this.engineWanted) this.engine!.resume()
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {})
  }

  /** Page hidden / about to lock: let the active engine schedule audio ahead to survive it. */
  enterBackground(): void {
    if (this.engineActive) this.engine?.enterBackground?.()
  }
  /** Page visible again: tear down any free-run scheduling; the caller then resyncs. */
  exitBackground(): void {
    if (this.engineActive) this.engine?.exitBackground?.()
  }

  /**
   * Register a lock-screen / now-playing MediaSession. Cross-platform: on iOS it also
   * anchors the background keep-alive (BufferAudioEngine's stream-sink element is the thing
   * iOS keeps alive); on Android/desktop it's the now-playing card. Idempotent, and must be
   * called inside the join gesture so the action handlers stick.
   */
  private setupMediaSession(): void {
    if (this.mediaSessionReady) return
    const ms = navigator.mediaSession
    if (!ms) return
    this.mediaSessionReady = true
    try {
      if ('MediaMetadata' in window) {
        ms.metadata = new MediaMetadata({ title: 'Live audio', artist: 'Empower A/V sync' })
      }
      ms.playbackState = 'playing'
      // A synced room shouldn't be pausable from one follower's lock screen (it would just
      // desync and go silent), so both handlers re-warm playback rather than stop it.
      ms.setActionHandler('play', () => this.resume())
      ms.setActionHandler('pause', () => this.resume())
    } catch {
      /* MediaSession is best-effort */
    }
  }

  private teardownMediaSession(): void {
    this.mediaSessionReady = false
    const ms = navigator.mediaSession
    if (!ms) return
    ms.playbackState = 'none'
    try {
      ms.setActionHandler('play', null)
      ms.setActionHandler('pause', null)
    } catch {
      /* ignore */
    }
  }

  /**
   * Auto-measure the device's true output latency (element position → what's actually
   * heard) so we can steer the element ahead by exactly that much — fully automatic, no
   * user calibration (this is BYOD).
   *
   * Primary signal: getOutputTimestamp() — (currentTime − contextTime) is the full
   * scheduling→output delay and reflects the REAL output path, INCLUDING Bluetooth
   * (which varies 100–300 ms and no fixed constant could cover). Fallback: outputLatency
   * (flaky — reads 0 until warmup even on Chrome).
   */
  private sampleOutputLatency(): void {
    const ctx = this.ctx
    if (!ctx) return
    let L: number | null = null
    const g = ctx.getOutputTimestamp?.()
    if (g && typeof g.contextTime === 'number' && g.contextTime > 0) {
      const d = ctx.currentTime - g.contextTime
      if (d > 0.001 && d < 1) L = d
    }
    if (L == null && typeof ctx.outputLatency === 'number' && ctx.outputLatency > 0) {
      L = ctx.outputLatency + (ctx.baseLatency ?? 0)
    }
    if (L == null) return
    L = Math.min(MAX_LATENCY_SEC, Math.max(0, L))
    this.measuredLatencySec = this.measuredLatencySec
      ? this.measuredLatencySec * (1 - LATENCY_EMA_ALPHA) + L * LATENCY_EMA_ALPHA
      : L
  }

  private outputLatencySec(): number {
    if (this.routed) return this.measuredLatencySec
    // Plain element output (the iOS fallback) has real device latency we can't measure.
    return IS_IOS ? IOS_FALLBACK_LATENCY_SEC : 0
  }

  private steerTarget(targetSec: number, dur: number): number {
    const shift = this.outputLatencySec()
    if (shift <= 0) return targetSec
    return (((targetSec + shift) % dur) + dur) % dur
  }

  private setPlaybackRate(rate: number): void {
    // Compare against the element's ACTUAL rate, not a cache of what we last wrote —
    // engines may silently reset playbackRate to 1 after seeks/stalls/interruptions,
    // and trusting a cache would leave the nudge corrector permanently inert.
    this.lastAppliedRate = rate
    const actual = this.el.playbackRate
    if (Math.abs(rate - actual) <= RATE_EPS) return
    try {
      this.el.playbackRate = rate
    } catch {
      /* some engines reject rates mid-load */
    }
  }

  /**
   * Honest local clock: trust any fresh element reading — even one BEHIND the previous
   * value — and advance an internal clock ONLY while the element clock is genuinely
   * frozen (e.g. briefly around seeks). A forward-only ratchet here once let the
   * synthetic clock detach from real playback and measure drift against its own
   * assumption, hiding genuine desync.
   */
  private sampleLocalSec(): number {
    const observed = this.el.currentTime
    const now = Date.now()
    const alive = observed !== this.lastObservedSec
    this.lastObservedSec = observed
    if (alive || this.el.paused || this.lastTrackAt === 0) {
      this.trackedSec = observed
      this.lastTrackAt = now
      return observed
    }
    const dt = (now - this.lastTrackAt) / 1000
    this.trackedSec += dt * (this.el.playbackRate || 1)
    this.lastTrackAt = now
    return this.trackedSec
  }

  correct(targetSec: number | null, playing: boolean): CorrectionInfo {
    if (this.enginePending) {
      if (this.engine!.hasBufferFor(this.currentUrl)) {
        // Decoded/demuxed soundtrack just became available — the engine takes over
        // (it snaps straight onto the live target on its first tick).
        this.enginePending = false
        this.engineActive = true
      } else {
        // Stay silent while downloading/decoding rather than limping along on the
        // stuttery element pipeline; the UI shows this as "syncing".
        if (!this.el.paused) this.el.pause()
        return { mode: 'syncing', driftMs: 0, rate: 1 }
      }
    }
    if (this.engineActive) return this.engine!.correct(targetSec, playing)
    if (this.hardStopped) {
      if (!this.el.paused) this.el.pause()
      return { mode: 'idle', driftMs: 0, rate: 1 }
    }

    if (targetSec == null || !playing) {
      if (!this.el.paused) this.el.pause()
      this.setPlaybackRate(1)
      return { mode: 'idle', driftMs: 0, rate: 1 }
    }

    const dur = this.el.duration
    if (!isFinite(dur) || dur <= 0) {
      void this.el.play().catch(() => {})
      return { mode: 'idle', driftMs: 0, rate: this.lastAppliedRate }
    }

    if (this.el.paused) void this.el.play().catch(() => {})

    this.sampleOutputLatency() // keep the auto latency estimate fresh
    const localSec = this.sampleLocalSec()
    const aim = this.steerTarget(targetSec, dur)
    const rawDrift = signedDrift(localSec, aim, dur)
    this.smoothedDriftSec =
      DRIFT_EMA_ALPHA * rawDrift + (1 - DRIFT_EMA_ALPHA) * this.smoothedDriftSec
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
        this.el.currentTime = aim
      } catch {
        /* not seekable yet — the next tick retries via drift */
      }
      this.trackedSec = aim
      this.lastTrackAt = now
      this.lastObservedSec = this.el.currentTime
      this.smoothedDriftSec = 0
      this.lastSeekAt = now
      this.seekSettleUntil = now + SEEK_SETTLE_MS
      this.setPlaybackRate(1)
      return { mode: 'seek', driftMs: rawDrift * 1000, rate: 1 }
    }

    if (now < this.seekSettleUntil) {
      return { mode: 'nudge', driftMs: rawDrift * 1000, rate: this.lastAppliedRate }
    }

    if (Math.abs(drift) < LOCK_DEADBAND_SEC) {
      this.setPlaybackRate(1)
      return {
        mode: (Math.abs(rawDrift) < LOCKED_SEC ? 'locked' : 'nudge') as CorrectionMode,
        driftMs: rawDrift * 1000,
        rate: 1,
      }
    }

    const rate = correctionRate(drift, RATE_GAIN, RATE_MIN, RATE_MAX)
    this.setPlaybackRate(rate)
    return {
      mode: (Math.abs(rawDrift) < LOCKED_SEC ? 'locked' : 'nudge') as CorrectionMode,
      driftMs: rawDrift * 1000,
      rate: this.lastAppliedRate,
    }
  }

  resync(): void {
    if (this.engineActive) {
      this.engine!.resync()
      return
    }
    this.smoothedDriftSec = 0
    this.lastSeekAt = 0
    this.seekSettleUntil = 0
    this.needsInitialSync = true
    this.trackedSec = this.el.currentTime
    this.lastTrackAt = Date.now()
  }

  stop(): void {
    this.bufferEngine?.stop()
    this.streamEngine?.stop()
    this.teardownMediaSession()
    this.hardStopped = true
    this.el.pause()
    this.el.playbackRate = 1
    this.lastAppliedRate = 1
    this.trackedSec = 0
    this.lastTrackAt = 0
    this.seekSettleUntil = 0
    this.needsInitialSync = true
  }
}
