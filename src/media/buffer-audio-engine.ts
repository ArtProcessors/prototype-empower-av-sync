/**
 * iOS follower audio engine: plays the soundtrack from a decoded AudioBuffer
 * scheduled on the AudioContext clock instead of an <audio> element. Safari's
 * media-element pipeline stalls for >1s on every seek and spontaneously
 * mid-playback, which defeated every element-side compensation strategy.
 * Buffer playback has no such pipeline:
 *  - repositioning = swapping in a new AudioBufferSourceNode at an exact
 *    offset (cheap, sample-accurate, no stall),
 *  - rate nudges are honored (playbackRate is an AudioParam Safari respects),
 *  - output ignores the hardware mute switch, same as the element+WebAudio
 *    routing did.
 *
 * Background keep-alive (iOS): iOS suspends the AudioContext the moment the
 * screen locks, which would kill buffer playback on lock. The graph is
 * therefore routed through a MediaStreamAudioDestinationNode played by a real
 * <audio> element that iOS registers as the active MediaSession — the element
 * is the thing iOS keeps alive in the background, giving the
 * (otherwise-suspendable) graph a reason to keep running. Seeks are still
 * upstream source-node swaps (the <audio> sink is never seeked), so the
 * pipeline stall we fled the element for doesn't come back. Trade-offs: the
 * element adds output latency we can't measure via getOutputTimestamp, and
 * while locked the corrector's timer + WebRTC beats are throttled, so playback
 * free-runs on the context clock until wake/resync. (MediaSession metadata
 * itself is owned by AudioSyncController — it's cross-platform.)
 */
import { signedDrift, correctionRate } from '../sync/sync-math'
import type {
  CorrectionInfo,
  CorrectionMode,
  FollowerAudioEngine,
} from './audio-sync-controller'

const HARD_RESTART_SEC = 0.25 // reposition instead of nudging beyond this drift
const RESTART_COOLDOWN_MS = 800 // keep repositions from thrashing
const SCHEDULE_AHEAD_SEC = 0.03 // start new sources slightly ahead so the clock mapping is exact
const LOCK_DEADBAND_SEC = 0.04
const LOCKED_SEC = 0.02
const DRIFT_EMA_ALPHA = 0.25
const RATE_EPS = 0.002
const RATE_GAIN = 0.5
const RATE_MIN = 0.98 // buffer sources don't preserve pitch — keep nudges subtle
const RATE_MAX = 1.02
const MAX_LATENCY_SEC = 0.5
const LATENCY_EMA_ALPHA = 0.2
const FALLBACK_LATENCY_SEC = 0.12 // iOS often reports no latency at all
const DECLICK_SEC = 0.006 // gain dip around a source swap so the stop/start edge can't pop
const UNMUTE_SEC = 0.03 // fade-in once we first reach lock (converge silently before that)

/**
 * Whole-file follower audio engine: decodes the entire soundtrack into one
 * AudioBuffer and plays it on the AudioContext clock. Used on iOS for short
 * content; see StreamingBufferEngine for long-form audio.
 */
export class BufferAudioEngine implements FollowerAudioEngine {
  private ctx: AudioContext | null = null
  // Background keep-alive sink: the graph feeds this stream, an <audio>
  // element plays it, and iOS keeps that element (and thus the graph) alive
  // when the screen locks.
  private streamDest: MediaStreamAudioDestinationNode | null = null
  private sinkElement: HTMLAudioElement | null = null
  // Master gain: sources route through this so swaps can be de-clicked, and so
  // a cold (from-idle) convergence plays silently until it first locks — no
  // audible seek thrash.
  private masterGain: GainNode | null = null
  private audible = false // has the current segment reached lock and faded in?
  private buffer: AudioBuffer | null = null
  private bufferUrl: string | null = null // url the decoded buffer belongs to
  private loadingUrl: string | null = null
  private desiredUrl: string | null = null
  private source: AudioBufferSourceNode | null = null
  // Clock mapping for the current source segment:
  // position = startOffset + (ctxNow - startCtxTime) * rate
  private startCtxTime = 0
  private startOffset = 0
  private rate = 1
  private smoothedDriftSec = 0
  private lastRestartAt = 0
  private measuredLatencySec = 0
  private hardStopped = false
  private readonly onLoadFailed: (url: string) => void

  /** Whether {@link unlock} has run inside a user gesture. */
  unlocked = false

  /**
   * @param onLoadFailed called with the URL when fetch/decode fails, so the
   *   controller can fall back to the <audio> element path
   */
  constructor(onLoadFailed: (url: string) => void) {
    this.onLoadFailed = onLoadFailed
  }

  /**
   * Prepare the audio graph. Must be called inside the join tap: everything
   * that needs the gesture (context creation, resume, priming a silent source)
   * happens synchronously before any await.
   */
  unlock(): Promise<void> {
    this.hardStopped = false

    const AudioContextCtor =
      window.AudioContext ||
      (
        window as unknown as {
          webkitAudioContext?: typeof AudioContext
        }
      ).webkitAudioContext

    if (!AudioContextCtor) {
      return Promise.reject(new Error('Web Audio unavailable'))
    }

    if (!this.ctx) {
      this.ctx = new AudioContextCtor()
    }

    // Background keep-alive: build the stream sink + start its <audio> element
    // inside the gesture (iOS requires the play() to be gesture-initiated).
    // The stream is always live — it carries silence until a source connects —
    // so the element stays "playing".
    if (!this.streamDest) {
      try {
        this.streamDest = this.ctx.createMediaStreamDestination()

        const element = new Audio()
        element.autoplay = true
        ;(
          element as HTMLAudioElement & { playsInline?: boolean }
        ).playsInline = true
        element.setAttribute('playsinline', '')
        element.srcObject = this.streamDest.stream
        this.sinkElement = element
        element.play().catch(() => {})
      } catch {
        this.streamDest = null // fall back to ctx.destination
      }
    }

    // Master gain all playback routes through (starts muted — first lock fades
    // it in).
    if (!this.masterGain) {
      this.masterGain = this.ctx.createGain()
      this.masterGain.gain.value = 0
      this.masterGain.connect(this.outputNode())
    }

    // Prime output inside the gesture with a one-frame silent buffer.
    try {
      const silence = this.ctx.createBuffer(1, 1, this.ctx.sampleRate)
      const primer = this.ctx.createBufferSource()
      primer.buffer = silence
      primer.connect(this.outputNode())
      primer.start()
    } catch {
      /* priming is best-effort */
    }

    const resumed =
      this.ctx.state !== 'running' ? this.ctx.resume() : Promise.resolve()
    this.unlocked = true

    return resumed.catch(() => {})
  }

  /** Nudge the context and keep-alive element back to life after a suspend. */
  resume(): void {
    if (this.ctx && this.ctx.state !== 'running') {
      this.ctx.resume().catch(() => {})
    }

    // The keep-alive element can be paused by iOS on interruption — nudge it
    // back.
    if (this.sinkElement && this.sinkElement.paused) {
      if (navigator.mediaSession) {
        navigator.mediaSession.playbackState = 'playing'
      }

      this.sinkElement.play().catch(() => {})
    }
  }

  /** Whether the lock-screen keep-alive sink is wired up. */
  get backgroundKeepAlive(): boolean {
    return this.streamDest != null
  }

  /** Where the graph's audio goes: the keep-alive stream, else the speakers. */
  private outputNode(): AudioNode {
    return this.streamDest ?? this.ctx!.destination
  }

  /** Point the engine at a soundtrack and start fetching/decoding it. */
  setSource(url: string): void {
    if (!url) {
      return
    }

    this.desiredUrl = url
    this.load(url) // dedupes internally; retries if the context wasn't ready yet
  }

  /** Whether the decoded buffer for `url` is ready to play. */
  hasBufferFor(url: string): boolean {
    return this.buffer != null && this.bufferUrl === url
  }

  private load(url: string): void {
    if (this.bufferUrl === url || this.loadingUrl === url || !this.ctx) {
      return
    }

    this.loadingUrl = url

    fetch(url)
      .then(response => {
        if (!response.ok) {
          throw new Error(`fetch ${response.status}`)
        }

        return response.arrayBuffer()
      })
      .then(encoded => this.ctx!.decodeAudioData(encoded))
      .then(decoded => {
        if (this.desiredUrl !== url) {
          return
        }

        this.buffer = decoded
        this.bufferUrl = url
        this.stopSource() // next correct() starts playback at the live target
      })
      .catch(() => {
        if (this.desiredUrl === url) {
          this.onLoadFailed(url)
        }
      })
      .finally(() => {
        if (this.loadingUrl === url) {
          this.loadingUrl = null
        }
      })
  }

  private stopSource(): void {
    const source = this.source
    this.source = null

    if (!source) {
      return
    }

    const gain = this.masterGain?.gain

    if (!this.ctx || !gain) {
      try {
        source.stop()
      } catch {
        /* already stopped */
      }

      source.disconnect()

      return
    }

    // Fade the output down before stopping so the cut can't pop, then retire
    // the node.
    const now = this.ctx.currentTime
    gain.cancelScheduledValues(now)
    gain.setValueAtTime(gain.value, now)
    gain.linearRampToValueAtTime(0, now + DECLICK_SEC)
    this.audible = false

    try {
      source.stop(now + DECLICK_SEC)
    } catch {
      /* already stopped */
    }

    source.onended = () => {
      try {
        source.disconnect()
      } catch {
        /* ignore */
      }
    }
  }

  private positionSec(ctxNow: number): number {
    const duration = this.buffer!.duration
    const raw = this.startOffset + (ctxNow - this.startCtxTime) * this.rate

    return ((raw % duration) + duration) % duration
  }

  /** Silence output immediately (cold starts converge silently until lock). */
  private mute(): void {
    this.audible = false

    const gain = this.masterGain?.gain

    if (!gain || !this.ctx) {
      return
    }

    const now = this.ctx.currentTime
    gain.cancelScheduledValues(now)
    gain.setValueAtTime(gain.value, now)
    // Short ramp so muting can't pop either.
    gain.linearRampToValueAtTime(0, now + DECLICK_SEC)
  }

  /** Fade in on the first lock — called once drift is inside the deadband. */
  private unmute(): void {
    if (this.audible) {
      return
    }

    this.audible = true

    const gain = this.masterGain?.gain

    if (!gain || !this.ctx) {
      return
    }

    const now = this.ctx.currentTime
    gain.cancelScheduledValues(now)
    gain.setValueAtTime(gain.value, now)
    gain.linearRampToValueAtTime(1, now + UNMUTE_SEC)
  }

  /** Dip the master gain to 0 across a source swap so the edge can't pop. */
  private declickSwap(when: number): void {
    const gain = this.masterGain?.gain

    if (!gain || !this.audible || !this.ctx) {
      return // muted pre-lock: already at 0
    }

    const now = this.ctx.currentTime
    gain.cancelScheduledValues(now)
    gain.setValueAtTime(1, Math.max(now, when - DECLICK_SEC))
    gain.linearRampToValueAtTime(0, when)
    gain.linearRampToValueAtTime(1, when + DECLICK_SEC)
  }

  /**
   * Swap in a fresh source node starting at `offset`, scheduled slightly ahead
   * so the context-time → track-time mapping is exact.
   */
  private startAt(offset: number, ctxNow: number): void {
    const ctx = this.ctx!
    const buffer = this.buffer!
    const duration = buffer.duration

    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.loop = true
    source.loopStart = 0
    source.loopEnd = duration
    source.connect(this.masterGain ?? this.outputNode())

    const when = ctxNow + SCHEDULE_AHEAD_SEC
    const startOffset =
      (((offset + SCHEDULE_AHEAD_SEC) % duration) + duration) % duration
    source.start(when, startOffset)
    this.declickSwap(when)

    // Retire the outgoing source at the swap point — its tail is already
    // gain-dipped to 0.
    const previous = this.source

    if (previous) {
      try {
        previous.stop(when + DECLICK_SEC)
      } catch {
        /* already stopped */
      }

      previous.onended = () => {
        try {
          previous.disconnect()
        } catch {
          /* ignore */
        }
      }
    }

    this.source = source
    this.startCtxTime = when
    this.startOffset = startOffset
    this.rate = 1
    this.smoothedDriftSec = 0
    this.lastRestartAt = Date.now()
  }

  private setRate(rate: number, ctxNow: number): void {
    if (!this.source || Math.abs(rate - this.rate) <= RATE_EPS) {
      return
    }

    // Re-anchor the clock mapping at the moment the rate changes.
    this.startOffset = this.positionSec(ctxNow)
    this.startCtxTime = ctxNow
    this.rate = rate
    this.source.playbackRate.value = rate
  }

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

    if (latencySec == null && this.measuredLatencySec < 0.02) {
      latencySec = FALLBACK_LATENCY_SEC
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

  /** Auto-measured output latency being compensated for, in ms. */
  get autoLatencyMs(): number {
    return this.measuredLatencySec * 1000
  }

  /** Current playback position within the soundtrack, in seconds. */
  get currentTimeSec(): number {
    if (!this.ctx || !this.buffer || !this.source) {
      return 0
    }

    return this.positionSec(this.ctx.currentTime)
  }

  /** Soundtrack length in seconds, or `NaN` before it is decoded. */
  get duration(): number {
    return this.buffer?.duration ?? NaN
  }

  /**
   * Steer playback one tick toward the screen's position: reposition on large
   * drift, otherwise nudge `playbackRate`.
   *
   * @param targetSec the screen's position, or `null` when it is unknown
   * @param playing whether the screen's video is playing
   */
  correct(targetSec: number | null, playing: boolean): CorrectionInfo {
    if (this.hardStopped) {
      this.stopSource()

      return { mode: 'idle', driftMs: 0, rate: 1 }
    }

    if (!this.ctx || !this.buffer) {
      if (this.desiredUrl) {
        this.load(this.desiredUrl)
      }

      return { mode: 'idle', driftMs: 0, rate: 1 }
    }

    if (targetSec == null || !playing) {
      this.stopSource()

      return { mode: 'idle', driftMs: 0, rate: 1 }
    }

    this.resume()
    this.sampleOutputLatency()

    const duration = this.buffer.duration
    const ctxNow = this.ctx.currentTime
    const aim =
      (((targetSec + this.measuredLatencySec) % duration) + duration) %
      duration

    if (!this.source) {
      // Cold start: converge silently, then fade in on the first lock (see
      // below) — this is what keeps the join/first-sync seek thrash from
      // popping out as a "beeping" loop.
      this.mute()
      this.startAt(aim, ctxNow)

      return { mode: 'seek', driftMs: 0, rate: 1 }
    }

    const position = this.positionSec(ctxNow)
    const rawDrift = signedDrift(position, aim, duration)
    this.smoothedDriftSec =
      DRIFT_EMA_ALPHA * rawDrift +
      (1 - DRIFT_EMA_ALPHA) * this.smoothedDriftSec
    const drift = this.smoothedDriftSec
    const now = Date.now()
    const mode: CorrectionMode =
      Math.abs(rawDrift) < LOCKED_SEC ? 'locked' : 'nudge'

    if (
      Math.abs(rawDrift) > HARD_RESTART_SEC &&
      now - this.lastRestartAt >= RESTART_COOLDOWN_MS
    ) {
      this.startAt(aim, ctxNow)

      return { mode: 'seek', driftMs: rawDrift * 1000, rate: 1 }
    }

    if (Math.abs(drift) < LOCK_DEADBAND_SEC) {
      // In the deadband → locked; audible from here (no-op once already up).
      this.unmute()
      this.setRate(1, ctxNow)

      return { mode, driftMs: rawDrift * 1000, rate: 1 }
    }

    const rate = correctionRate(drift, RATE_GAIN, RATE_MIN, RATE_MAX)
    this.setRate(rate, ctxNow)

    return { mode, driftMs: rawDrift * 1000, rate: this.rate }
  }

  /** Drop the current segment so the next tick re-converges from scratch. */
  resync(): void {
    this.smoothedDriftSec = 0
    this.lastRestartAt = 0
    // Fades out and drops audible; next correct() cold-starts and stays silent
    // until re-lock, so a wake/resync re-converges without popping back in.
    this.stopSource()
  }

  /** Stop playback for good and tear down the keep-alive sink. */
  stop(): void {
    this.hardStopped = true
    this.stopSource()

    if (this.sinkElement) {
      this.sinkElement.pause()
      this.sinkElement.srcObject = null
      this.sinkElement = null
    }

    this.streamDest = null
  }
}
