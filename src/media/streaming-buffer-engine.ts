/**
 * Long-form follower audio engine. Whole-file decode (BufferAudioEngine) costs
 * ~21 MB/min, so a 45-min track would need ~950 MB of RAM — untenable on a
 * phone. This engine keeps that flat by decoding only a sliding WINDOW of the
 * timeline with WebCodecs:
 *
 *   fetch compressed file (small) → demux (mp4box) into encoded AAC frames
 *   kept in memory → decode a ~60 s PCM window around the playhead → play it
 *   EXACTLY like BufferAudioEngine (AudioContext-clock scheduling,
 *   sample-accurate source-node repositioning, playbackRate nudges,
 *   mute-switch-bypassing stream-sink keep-alive) → refill/slide the window
 *   before it runs out. Memory stays ~85 MB regardless of track length.
 *
 * Within a window it IS BufferAudioEngine — same correction math, gain
 * de-click, and the iOS lock-screen stream sink. The only added machinery is
 * window bookkeeping: decode the next window ahead of the playhead and swap to
 * it (a de-clicked reposition into the overlapping region, so it's seamless),
 * and decode a fresh window on a large seek / loop wrap.
 *
 * Falls back (via onLoadFailed) when WebCodecs is unavailable (iOS < 16.4),
 * demux fails, or the codec isn't AAC-LC — the controller then routes to the
 * element path.
 */
import { signedDrift, correctionRate } from '../sync/sync-math'
import type {
  CorrectionInfo,
  CorrectionMode,
  FollowerAudioEngine,
} from './audio-sync-controller'

const WINDOW_SEC = 60 // decoded PCM window length (~21 MB stereo)
const WINDOW_STEP_SEC = 45 // how far each slide advances the window start (=> 15 s overlap)
const PREFETCH_MARGIN_SEC = 30 // start decoding the next window this far before the current ends
const PREROLL_SEC = 0.5 // decode slightly before the window start (decoder warm-up / gapless seam)
const WINDOW_EDGE_SEC = 1.5 // don't START playback within this of a window's very end

// Correction constants mirror BufferAudioEngine (see there for rationale).
const HARD_RESTART_SEC = 0.25
const RESTART_COOLDOWN_MS = 800
const SCHEDULE_AHEAD_SEC = 0.03
const LOCK_DEADBAND_SEC = 0.04
const LOCKED_SEC = 0.02
const DRIFT_EMA_ALPHA = 0.25
const RATE_EPS = 0.002
const RATE_GAIN = 0.5
const RATE_MIN = 0.98
const RATE_MAX = 1.02
const MAX_LATENCY_SEC = 0.5
const LATENCY_EMA_ALPHA = 0.2
const FALLBACK_LATENCY_SEC = 0.12
const DECLICK_SEC = 0.006
const UNMUTE_SEC = 0.03

/**
 * Read a numeric on-device tuning override from the query string, e.g.
 * `?sinklat=0.25`. Values that don't parse or fail `isValid` fall back.
 */
function readNumberFromQuery(
  param: string,
  fallback: number,
  isValid: (value: number) => boolean,
): number {
  if (typeof location === 'undefined') {
    return fallback
  }

  const match = new RegExp(`[?&]${param}=([0-9.]+)`).exec(location.search)

  if (!match) {
    return fallback
  }

  const value = parseFloat(match[1])

  return isFinite(value) && isValid(value) ? value : fallback
}

// When we switch to the keep-alive sink on backgrounding, the <audio> element
// adds output latency that ctx.destination (the foreground path) didn't have,
// so the audio would lag the screen by that much. We can't measure the
// element's buffer from JS, so skip content forward by this estimate at the
// switch to keep sleep audio aligned (bigger = audio pulled earlier).
// Device-dependent (Bluetooth adds more) — override on-device with
// `?sinklat=0.25` to tune, then bake the winning value in here.
const SINK_SWITCH_LATENCY_SEC = readNumberFromQuery(
  'sinklat',
  0.15,
  value => value >= 0 && value < 1,
)

// Seconds of audio pre-scheduled ahead when backgrounded so playback survives
// the throttled correction timer. Each ~60 s window is ~21 MB of PCM held at
// once, so a long runway is a big memory spike right as Android is trying to
// freeze the tab — a prime trigger for the OS to discard (reload) the tab.
// Trade runway vs. discard-risk; override on-device with `?runway=90`.
const BACKGROUND_RUNWAY_SEC = readNumberFromQuery(
  'runway',
  180,
  value => value >= 30 && value <= 900,
)

/**
 * After a wake the platform's reported output latency is unreliable for a few
 * seconds (buffers refill, the context has just resumed). Feeding those
 * readings into `aim` makes the target crawl, and the corrector chases it —
 * the "too slow, then bumped up, then too fast" handover. So hold the
 * pre-sleep estimate, measured under stable conditions, until things settle.
 */
const LATENCY_SETTLE_SEC = 4

/**
 * Gain of the always-on tap feeding the keep-alive <audio> element while the
 * audible output is the direct path (non-iOS foreground).
 *
 * Chrome on Android does not freeze a page that is actively playing audio. On
 * the whole-file path the <audio> element IS the output, so it plays unbroken
 * across a screen sleep and the page — with its timers and its WebRTC
 * connection — stays alive. Routing straight to ctx.destination gave us clean
 * foreground audio but left no playing element, so the page froze and the peer
 * connection died with it. Feeding the element a continuous, far-below-audible
 * copy keeps Chrome's "playing audio" state true for the whole session without
 * putting the sink's buffering in the audible path. Must stay above Chrome's
 * silence threshold to count, hence not simply 0. Tune on-device with
 * `?kagain=0.01` (0 disables the tap entirely).
 */
const KEEPALIVE_GAIN = readNumberFromQuery(
  'kagain',
  0.005,
  value => value >= 0 && value <= 1,
)

// iOS needs the MediaStream sink for foreground output too (mute-switch bypass
// + lock-screen keep-alive), and it's smooth there. Android/desktop route
// straight to the speakers in the foreground — the sink's extra buffering
// there causes latency/jitter/rough swaps — and only switch to the sink while
// backgrounded (for the free-run chain to survive the lock).
const IS_IOS =
  typeof navigator !== 'undefined' &&
  (/iP(hone|ad|od)/.test(navigator.userAgent) ||
    (/Macintosh/.test(navigator.userAgent) &&
      (navigator.maxTouchPoints ?? 0) > 1))

/** Sample rates addressable by an AAC sampling-frequency index. */
const AAC_SAMPLE_RATE_TABLE = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025,
  8000, 7350,
]

// Clock-ratio estimation (screen clock vs this device's audio clock) used for
// background free-run: play at the measured ratio rather than a blind 1.0,
// which drifts by the clocks' ppm difference for as long as the screen is
// asleep.
const RATIO_WINDOW_SEC = 90 // regression window of recent samples
const RATIO_MIN_SPAN_SEC = 20 // need this much span before trusting the estimate
const RATIO_MIN_SAMPLES = 20 // …and at least this many samples
const RATIO_MAX_DEV = 0.005 // clamp to ±0.5% — a bigger "ratio" is noise/seek, not a real clock

const HEAD_CHUNK_BYTES = 2 * 1024 * 1024 // grow the moov fetch in 2 MB steps
const MAX_HEAD_BYTES = 24 * 1024 * 1024 // cap the moov search (covers many hours of audio)

/**
 * Per-sample metadata parsed from the moov (byte offset/size in the file +
 * timing), stored as parallel typed arrays so we can range-fetch just the
 * bytes a window needs instead of holding the whole compressed file in memory.
 * This is what keeps the tab under Android's discard line.
 */
interface SampleTable {
  /** Byte offset of each sample within the file. */
  offset: Float64Array
  /** Byte length of each sample. */
  size: Float64Array
  /** Start time of each sample, in seconds. */
  start: Float64Array
  /** Duration of each sample, in seconds. */
  duration: Float64Array
  /** How many samples the table holds. */
  count: number
}

/** A decoded slice of PCM covering one window of the timeline. */
interface DecodedWindow {
  /** Decoded PCM for this window. */
  buffer: AudioBuffer
  /** Track-second that sits at buffer offset 0. */
  startSec: number
}

/** One (audio-clock, screen-target) pair feeding the clock-ratio regression. */
interface ClockRatioSample {
  /** AudioContext time when the sample was taken, in seconds. */
  contextSec: number
  /** Unwrapped screen target time at that instant, in seconds. */
  targetSec: number
}

/**
 * Build the AAC-LC AudioSpecificConfig (2 bytes) from the track params — the
 * WebCodecs `description`. Returns `null` for a sample rate AAC can't index.
 */
function buildAacLcAsc(
  sampleRate: number,
  channelCount: number,
): Uint8Array | null {
  const frequencyIndex = AAC_SAMPLE_RATE_TABLE.indexOf(sampleRate)

  if (frequencyIndex < 0) {
    return null
  }

  const objectType = 2 // AAC-LC
  const firstByte = (objectType << 3) | (frequencyIndex >> 1)
  const secondByte = ((frequencyIndex & 1) << 7) | (channelCount << 3)

  return new Uint8Array([firstByte, secondByte])
}

/**
 * Long-form follower audio engine: decodes a sliding WebCodecs window of the
 * soundtrack and plays it on the AudioContext clock, so memory stays flat
 * however long the track is.
 */
export class StreamingBufferEngine implements FollowerAudioEngine {
  // ── Output stage ──

  /** The context every source is scheduled on; created inside the join tap. */
  private ctx: AudioContext | null = null
  /**
   * Background keep-alive sink: the graph feeds this stream and
   * {@link sinkElement} plays it, which is what keeps a locked/backgrounded
   * page (and its WebRTC link) alive.
   */
  private streamDest: MediaStreamAudioDestinationNode | null = null
  /** The <audio> element playing {@link streamDest}'s stream. */
  private sinkElement: HTMLAudioElement | null = null
  /** Master gain every source routes through, so swaps can be de-clicked. */
  private masterGain: GainNode | null = null
  /**
   * Speaker leg of the output mix. {@link masterGain} feeds BOTH legs
   * permanently and {@link connectOutput} cross-fades between them, rather
   * than disconnecting/reconnecting.
   */
  private directGain: GainNode | null = null
  /**
   * Keep-alive-sink leg of the output mix. Never taken fully to zero (see
   * {@link KEEPALIVE_GAIN}) so its <audio> element keeps playing for the whole
   * session and Chrome never freezes the page.
   */
  private sinkGain: GainNode | null = null
  /** Whether the current segment has reached lock and faded in. */
  private audible = false

  // ── Demux state: only the sample table (byte offsets/timing) is kept;
  //    sample DATA is range-fetched per window on demand. ──

  /** Per-sample offsets and timing parsed from the moov. */
  private table: SampleTable | null = null
  /** URL {@link table} was demuxed from. */
  private demuxedUrl: string | null = null
  /** URL currently being demuxed, so loads aren't duplicated. */
  private loadingUrl: string | null = null
  /** URL we want playing; work whose URL no longer matches is discarded. */
  private desiredUrl: string | null = null
  /** WebCodecs codec string for the track, e.g. `mp4a.40.2`. */
  private codec = ''
  /** AAC-LC AudioSpecificConfig handed to the decoder as its `description`. */
  private audioSpecificConfig: Uint8Array | null = null
  /** Track sample rate, in Hz. */
  private sampleRate = 44100
  /** Track channel count. */
  private channelCount = 2
  /** Full track length in seconds (the loop length followers wrap against). */
  private totalSec = 0

  // ── Window / playback state ──

  /** Most recently decoded window, whether or not it is playing yet. */
  private latestWindow: DecodedWindow | null = null
  /** The window {@link source} is currently playing from. */
  private sourceWindow: DecodedWindow | null = null
  /** Track-second a decode is in flight for (`null` = none). */
  private pendingStartSec: number | null = null
  /** The source node currently sounding. */
  private source: AudioBufferSourceNode | null = null
  /**
   * Context time the current segment started at. Together with
   * {@link startOffset} and {@link rate} this maps context time to track
   * position: `position = startOffset + (ctxNow - startCtxTime) * rate`.
   */
  private startCtxTime = 0
  /** Track position at {@link startCtxTime}, in seconds. */
  private startOffset = 0
  /** Playback rate the current segment was last set to. */
  private rate = 1
  /** EMA of the raw drift, so steering isn't driven by per-tick noise. */
  private smoothedDriftSec = 0
  /** `Date.now()` of the last reposition, for the restart cooldown. */
  private lastRestartAt = 0
  /**
   * Measured output latency for the DIRECT (`ctx.destination`) path. The sink
   * path's latency is this plus {@link SINK_SWITCH_LATENCY_SEC} — see
   * {@link activeLatencySec}. Keeping them separate matters because the
   * physical latency changes the instant we switch paths, while an EMA can
   * only crawl.
   */
  private measuredLatencySec = 0
  /** Set by {@link stop}; keeps playback down until the next unlock. */
  private hardStopped = false
  /**
   * Bumped on every graph transition (background enter/exit, resync, stop).
   * Async decodes and the chain builder capture it and bail if it changed — so
   * work started before a transition (e.g. an in-flight decode during sleep)
   * can't schedule onto the graph as it's being reset, which was crashing the
   * renderer a moment after waking.
   */
  private generation = 0

  // ── Background free-run: extra sources chained ahead on the audio thread so
  //    playback survives the correction timer being throttled while the screen
  //    is locked. ──

  /** Whether the page is currently backgrounded and free-running. */
  private backgrounded = false
  /** Sources pre-scheduled ahead of {@link source} to cover the lock. */
  private chainedSources: AudioBufferSourceNode[] = []
  /** Context time the scheduled chain runs out (0 = no chain). */
  private chainEndsAtCtx = 0
  /** Track-second the chain covers up to, so top-ups resume from there. */
  private chainTrackEnd = 0
  /** Guards {@link buildChain} against overlapping runs. */
  private chainBuilding = false
  /** Suppress latency re-estimation until this context time (post-wake). */
  private latencyHoldUntilCtx = 0
  /** Rate the chain was scheduled at — the measured clock ratio. */
  private freeRunRate = 1
  /**
   * Steady-state rate to hold when locked: the measured screen:device clock
   * ratio. Persists across sleeps and estimator resets, so we never snap back
   * to a 1.0 we know to be wrong.
   */
  private holdRate = 1

  // ── Clock-ratio estimator (see recordClockRatioSample) ──

  /** Recent (context time, unwrapped target) pairs feeding the regression. */
  private ratioSamples: ClockRatioSample[] = []
  /** Running unwrapped target seconds (-1 = not started). */
  private ratioAccumSec = -1
  /** Previous target, so only smooth forward advances are accumulated. */
  private lastRatioTargetSec = 0
  /** Whether the master gain is on the keep-alive sink vs the speakers. */
  private usingSink = false

  /** Called when demux/decode is impossible, so the controller can fall back. */
  private readonly onLoadFailed: (url: string) => void

  /** Whether {@link unlock} has run inside a user gesture. */
  unlocked = false

  /**
   * @param onLoadFailed called with the URL when demux/decode is impossible,
   *   so the controller can fall back to the <audio> element path
   */
  constructor(onLoadFailed: (url: string) => void) {
    this.onLoadFailed = onLoadFailed
  }

  // ─── Output stage (mirrors BufferAudioEngine: context + keep-alive sink +
  //     master gain) ───

  /**
   * Prepare the audio graph. Must be called inside the join tap: context
   * creation, resume and the sink's `play()` all need the gesture.
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

    if (typeof AudioDecoder === 'undefined') {
      return Promise.reject(new Error('WebCodecs unavailable'))
    }

    if (!this.ctx) {
      this.ctx = new AudioContextCtor()
    }

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
        this.streamDest = null
      }
    }

    if (!this.masterGain) {
      const ctx = this.ctx
      this.masterGain = ctx.createGain()
      this.masterGain.gain.value = 0

      // Wire both output legs once and keep them wired; connectOutput only
      // changes their gains.
      this.directGain = ctx.createGain()
      this.masterGain.connect(this.directGain)
      this.directGain.connect(ctx.destination)

      if (this.streamDest) {
        this.sinkGain = ctx.createGain()
        this.masterGain.connect(this.sinkGain)
        this.sinkGain.connect(this.streamDest)
      }

      // iOS → sink; Android/desktop → speakers + keep-alive tap.
      this.connectOutput(IS_IOS)
    }

    try {
      const silence = this.ctx.createBuffer(1, 1, this.ctx.sampleRate)
      const primer = this.ctx.createBufferSource()
      primer.buffer = silence
      primer.connect(this.ctx.destination)
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

  /** Where sources connect: the master gain, else the speakers directly. */
  private outputNode(): AudioNode {
    return this.masterGain ?? this.ctx!.destination
  }

  /**
   * Choose which leg is *audible*: the speakers (foreground) or the keep-alive
   * sink (background).
   *
   * The sink leg is never taken to zero — it stays at KEEPALIVE_GAIN so its
   * <audio> element keeps playing continuously, which is what stops Chrome
   * freezing the page (and killing WebRTC with it). Cross-fading gains rather
   * than re-connecting also avoids a click at the switch.
   */
  private connectOutput(useSink: boolean): void {
    if (!this.ctx || !this.directGain) {
      return
    }

    const sink = useSink && this.streamDest != null
    const now = this.ctx.currentTime

    const ramp = (gainNode: GainNode | null, to: number) => {
      if (!gainNode) {
        return
      }

      gainNode.gain.cancelScheduledValues(now)
      gainNode.gain.setValueAtTime(gainNode.gain.value, now)
      gainNode.gain.linearRampToValueAtTime(to, now + DECLICK_SEC)
    }

    ramp(this.directGain, sink ? 0 : 1)
    ramp(this.sinkGain, sink ? 1 : KEEPALIVE_GAIN)
    this.usingSink = sink
  }

  // ─── Load: fetch ONLY the moov and build the sample table (data is
  //     range-fetched per window) ───

  /** Point the engine at a soundtrack and start demuxing its sample table. */
  setSource(url: string): void {
    if (!url) {
      return
    }

    this.desiredUrl = url

    if (this.demuxedUrl !== url && this.loadingUrl !== url && this.ctx) {
      this.loadMetadata(url)
    }
  }

  /** Whether the sample table for `url` is demuxed and ready to decode from. */
  hasBufferFor(url: string): boolean {
    return this.demuxedUrl === url && this.table != null
  }

  /**
   * Fetch only the moov and build {@link table} from it — no sample data, so
   * memory stays flat however long the track is.
   */
  private async loadMetadata(url: string): Promise<void> {
    this.loadingUrl = url

    try {
      const { createFile } = await import('mp4box')
      const file = createFile()
      let info: import('mp4box').Movie | null = null
      file.onError = () => {}
      file.onReady = ready => {
        info = ready
      }

      // Fetch the file head in chunks until the moov is parsed (faststart puts
      // it up front).
      let headEnd = 0

      while (!info && headEnd < MAX_HEAD_BYTES) {
        const response = await fetch(url, {
          headers: {
            Range: `bytes=${headEnd}-${headEnd + HEAD_CHUNK_BYTES - 1}`,
          },
        })

        if (!response.ok) {
          throw new Error(`fetch ${response.status}`)
        }

        if (this.desiredUrl !== url) {
          return
        }

        const part = await response.arrayBuffer()
        const mp4Buffer = part as ArrayBuffer & { fileStart: number }
        mp4Buffer.fileStart = headEnd
        // onReady fires synchronously once the moov is complete.
        file.appendBuffer(mp4Buffer)
        headEnd += part.byteLength

        if (part.byteLength < HEAD_CHUNK_BYTES) {
          break // reached EOF
        }
      }

      if (!info) {
        throw new Error('moov not found')
      }

      const track = (info as import('mp4box').Movie).audioTracks?.[0]

      if (!track || !track.audio) {
        throw new Error('no audio track')
      }

      if (!track.codec.startsWith('mp4a.40')) {
        throw new Error(`unsupported codec ${track.codec}`)
      }

      const audioSpecificConfig = buildAacLcAsc(
        track.audio.sample_rate,
        track.audio.channel_count,
      )

      if (!audioSpecificConfig) {
        throw new Error(`unsupported sample rate ${track.audio.sample_rate}`)
      }

      // Build the sample table from the moov (offsets/sizes/timing) — no
      // sample DATA needed.
      file.setExtractionOptions(track.id, null, { nbSamples: 1 })
      file.start()

      const samples = file.getTrackById(track.id).samples
      const count = samples.length
      const offset = new Float64Array(count)
      const size = new Float64Array(count)
      const start = new Float64Array(count)
      const duration = new Float64Array(count)

      for (let index = 0; index < count; index++) {
        const sample = samples[index]
        offset[index] = sample.offset
        size[index] = sample.size
        start[index] = sample.cts / sample.timescale
        duration[index] = sample.duration / sample.timescale
      }

      file.stop()

      if (this.desiredUrl !== url) {
        return
      }

      this.codec = track.codec
      this.sampleRate = track.audio.sample_rate
      this.channelCount = track.audio.channel_count
      this.audioSpecificConfig = audioSpecificConfig
      this.totalSec = count ? start[count - 1] + duration[count - 1] : 0
      this.table = { offset, size, start, duration, count }
      this.demuxedUrl = url
      // mp4box's file (with its own copy of the sample structures) can now be
      // dropped.
    } catch {
      if (this.desiredUrl === url) {
        this.onLoadFailed(url)
      }
    } finally {
      if (this.loadingUrl === url) {
        this.loadingUrl = null
      }
    }
  }

  /**
   * First sample index whose start time is >= `sec` (binary search over the
   * sorted table).
   */
  private lowerBound(sec: number): number {
    const table = this.table!
    let low = 0
    let high = table.count

    while (low < high) {
      const mid = (low + high) >> 1

      if (table.start[mid] < sec) {
        low = mid + 1
      } else {
        high = mid
      }
    }

    return low
  }

  /**
   * Decode a PCM window covering `[startSec, startSec + WINDOW_SEC]`,
   * range-fetching just the compressed bytes it needs.
   */
  private async decodeWindow(startSec: number): Promise<DecodedWindow | null> {
    const ctx = this.ctx
    const table = this.table
    const url = this.demuxedUrl

    if (!ctx || !table || !url || !this.audioSpecificConfig) {
      return null
    }

    // Captured so the decode can bail if a background/resync/stop transition
    // happens while it is in flight.
    const generation = this.generation

    const windowStart = Math.max(
      0,
      Math.min(startSec, Math.max(0, this.totalSec - WINDOW_SEC)),
    )
    const windowLength = Math.min(WINDOW_SEC, this.totalSec - windowStart)

    if (windowLength <= 0) {
      return null
    }

    // Sample index range covering [windowStart - preroll, windowStart + len].
    const decodeFrom = Math.max(0, windowStart - PREROLL_SEC)
    const decodeTo = windowStart + windowLength
    let firstSample = this.lowerBound(decodeFrom)

    if (firstSample > 0) {
      firstSample-- // include the sample straddling the start
    }

    let lastSample = this.lowerBound(decodeTo) - 1

    if (lastSample < firstSample) {
      lastSample = firstSample
    }

    if (lastSample >= table.count) {
      lastSample = table.count - 1
    }

    // Range-fetch exactly the compressed bytes for those samples (contiguous
    // in the mdat).
    const byteStart = table.offset[firstSample]
    const byteEnd = table.offset[lastSample] + table.size[lastSample]
    const response = await fetch(url, {
      headers: { Range: `bytes=${byteStart}-${byteEnd - 1}` },
    })

    if (!response.ok) {
      throw new Error(`range ${response.status}`)
    }

    const bytes = new Uint8Array(await response.arrayBuffer())

    if (this.isStale(generation)) {
      return null
    }

    const sampleRate = this.sampleRate
    const channelCount = this.channelCount
    const frameCount = Math.ceil(windowLength * sampleRate)
    const channelData = Array.from(
      { length: channelCount },
      () => new Float32Array(frameCount),
    )

    await new Promise<void>((resolve, reject) => {
      let decoder: AudioDecoder

      const closeDecoder = () => {
        try {
          if (decoder.state !== 'closed') {
            decoder.close()
          }
        } catch {
          /* already closed */
        }
      }

      try {
        decoder = new AudioDecoder({
          output: audioData => {
            // Where this decoded frame lands within the window's PCM.
            const base = Math.round(
              (audioData.timestamp / 1e6 - windowStart) * sampleRate,
            )
            const frames = audioData.numberOfFrames
            const destStart = Math.max(0, base)
            const destEnd = Math.min(frameCount, base + frames)

            if (destEnd <= destStart) {
              audioData.close()

              return
            }

            const srcStart = destStart - base
            const copyLength = destEnd - destStart
            const plane = new Float32Array(frames)

            for (let channel = 0; channel < channelCount; channel++) {
              try {
                audioData.copyTo(plane, {
                  planeIndex: channel,
                  format: 'f32-planar',
                })
              } catch {
                audioData.close()

                return
              }

              channelData[channel].set(
                plane.subarray(srcStart, srcStart + copyLength),
                destStart,
              )
            }

            audioData.close()
          },
          error: error => {
            closeDecoder()
            reject(error)
          },
        })

        decoder.configure({
          codec: this.codec,
          sampleRate,
          numberOfChannels: channelCount,
          description: this.audioSpecificConfig!,
        })

        for (let index = firstSample; index <= lastSample; index++) {
          const sampleStart = table.offset[index] - byteStart
          const view = bytes.subarray(
            sampleStart,
            sampleStart + table.size[index],
          )

          decoder.decode(
            new EncodedAudioChunk({
              type: 'key',
              timestamp: table.start[index] * 1e6,
              duration: table.duration[index] * 1e6,
              data: view,
            }),
          )
        }

        decoder
          .flush()
          .then(() => {
            closeDecoder()
            resolve()
          })
          .catch(error => {
            closeDecoder()
            reject(error)
          })
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })

    if (this.isStale(generation)) {
      return null
    }

    const buffer = ctx.createBuffer(channelCount, frameCount, sampleRate)

    for (let channel = 0; channel < channelCount; channel++) {
      buffer.copyToChannel(channelData[channel], channel)
    }

    return { buffer, startSec: windowStart }
  }

  /**
   * Whether work started at `generation` has been invalidated — by a graph
   * transition or by the desired source moving on.
   */
  private isStale(generation: number): boolean {
    return (
      this.desiredUrl !== this.demuxedUrl ||
      this.generation !== generation ||
      !this.ctx
    )
  }

  /**
   * Kick a window decode for `aim` if nothing covers it and none is already in
   * flight.
   */
  private ensureDecode(aim: number): void {
    if (this.pendingStartSec != null) {
      return
    }

    if (this.latestWindow && this.covers(this.latestWindow, aim, 0)) {
      return
    }

    this.decodeInto(Math.max(0, aim - PREROLL_SEC))
  }

  /**
   * Prefetch the NEXT window by start position. Unlike {@link ensureDecode}
   * this must NOT gate on the current window "covering" that point — the
   * current window overlaps the next one's start, so a coverage check would
   * always skip and the next window would never decode until the current ran
   * out (the ~1 s swap gap). Only skip if we already have (or are fetching)
   * that exact window.
   */
  private prefetchAt(startSec: number): void {
    if (this.pendingStartSec != null) {
      return
    }

    if (
      this.latestWindow &&
      Math.abs(this.latestWindow.startSec - startSec) < 1
    ) {
      return
    }

    this.decodeInto(startSec)
  }

  /** Decode the window at `startSec` and install it once it lands. */
  private decodeInto(startSec: number): void {
    this.pendingStartSec = startSec

    this.decodeWindow(startSec)
      .then(decoded => {
        if (decoded) {
          this.latestWindow = decoded
        }
      })
      .catch(() => {})
      .finally(() => {
        if (this.pendingStartSec === startSec) {
          this.pendingStartSec = null
        }
      })
  }

  /** Whether `trackSec` sits inside `decoded`, `margin` clear of both edges. */
  private covers(
    decoded: DecodedWindow,
    trackSec: number,
    margin: number,
  ): boolean {
    return (
      trackSec >= decoded.startSec + margin &&
      trackSec <= decoded.startSec + decoded.buffer.duration - margin
    )
  }

  // ─── Gain helpers (identical model to BufferAudioEngine) ───

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
      return
    }

    const now = this.ctx.currentTime
    gain.cancelScheduledValues(now)
    gain.setValueAtTime(1, Math.max(now, when - DECLICK_SEC))
    gain.linearRampToValueAtTime(0, when)
    gain.linearRampToValueAtTime(1, when + DECLICK_SEC)
  }

  /** Fade the output down, then stop and retire the current source. */
  private stopSource(): void {
    const source = this.source
    this.source = null
    this.sourceWindow = null

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

  /** Track position at context time `ctxNow`, unwrapped (may exceed the loop). */
  private positionSec(ctxNow: number): number {
    return this.startOffset + (ctxNow - this.startCtxTime) * this.rate
  }

  /**
   * Start a source from `decoded` at track position `aimTrackSec`, scheduled
   * slightly ahead.
   *
   * @param continuation a seamless slide into the next window (not a seek):
   *   the current rate and drift EMA are carried over so the nudge corrector
   *   keeps its state instead of resetting to 1 every ~45 s — otherwise steady
   *   drift never gets corrected and grows between slides.
   */
  private startAt(
    aimTrackSec: number,
    decoded: DecodedWindow,
    ctxNow: number,
    continuation = false,
  ): void {
    const ctx = this.ctx!
    const duration = decoded.buffer.duration
    const rate = continuation ? this.rate : 1
    const bufferOffset = Math.min(
      Math.max(aimTrackSec - decoded.startSec, 0),
      Math.max(0, duration - 0.02),
    )

    const source = ctx.createBufferSource()
    source.buffer = decoded.buffer
    source.playbackRate.value = rate
    source.connect(this.masterGain ?? this.outputNode())

    const when = ctxNow + SCHEDULE_AHEAD_SEC
    const startBufferOffset = Math.min(
      bufferOffset + SCHEDULE_AHEAD_SEC * rate,
      Math.max(0, duration - 0.001),
    )
    source.start(when, startBufferOffset)
    this.declickSwap(when)

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
    this.sourceWindow = decoded
    this.startCtxTime = when
    this.startOffset = decoded.startSec + startBufferOffset
    this.rate = rate

    if (!continuation) {
      this.smoothedDriftSec = 0
    }

    this.lastRestartAt = Date.now()
  }

  /** Apply a playback rate, unless it is within {@link RATE_EPS} of the current one. */
  private setRate(rate: number, ctxNow: number): void {
    if (!this.source || Math.abs(rate - this.rate) <= RATE_EPS) {
      return
    }

    this.forceRate(rate, ctxNow)
  }

  /**
   * Set an EXACT rate, bypassing the RATE_EPS deadband. Free-run needs this:
   * setRate(1) would early-return while the source still ran at up to
   * 1±RATE_EPS (0.2% = ~120 ms drift per minute), and the chained sources —
   * which are always created at exactly 1.0 — would then be scheduled against
   * a primary running at a different speed, misaligning every seam.
   */
  private forceRate(rate: number, ctxNow: number): void {
    if (!this.source) {
      return
    }

    this.startOffset = this.positionSec(ctxNow)
    this.startCtxTime = ctxNow
    this.rate = rate
    this.source.playbackRate.value = rate
  }

  /**
   * Record (screen target, context time) pairs so we can estimate the ratio
   * between the screen's clock and this device's audio clock. Crystals differ
   * by tens of ppm, so free-running at exactly 1.0 drifts steadily; free-running
   * at the measured ratio tracks far better. Target is unwrapped (loop wraps /
   * seeks are dropped) so the regression sees a monotone line.
   */
  private recordClockRatioSample(targetSec: number, ctxNow: number): void {
    const advance = targetSec - this.lastRatioTargetSec
    this.lastRatioTargetSec = targetSec

    // Only smooth forward advances feed the regression. A loop wrap, seek, or
    // throttled gap would otherwise leave a flat spot that biases the slope,
    // so those RESTART the window instead of being merely skipped (the
    // estimate then falls back to 1 until clean span rebuilds).
    if (this.ratioAccumSec >= 0 && advance > 0 && advance < 1) {
      this.ratioAccumSec += advance
      this.ratioSamples.push({
        contextSec: ctxNow,
        targetSec: this.ratioAccumSec,
      })

      const cutoff = ctxNow - RATIO_WINDOW_SEC

      while (
        this.ratioSamples.length > 2 &&
        this.ratioSamples[0].contextSec < cutoff
      ) {
        this.ratioSamples.shift()
      }

      return
    }

    if (this.ratioAccumSec < 0) {
      this.ratioAccumSec = 0
    }

    this.ratioSamples.length = 0
  }

  /**
   * Least-squares slope of target-seconds per context-second (1 = clocks
   * agree). Returns `null` when there isn't enough clean data to trust —
   * callers then keep the last good value (`holdRate`) rather than snapping to
   * 1.0, which would re-introduce drift.
   */
  private estimateClockRatio(): number | null {
    const samples = this.ratioSamples

    if (samples.length < RATIO_MIN_SAMPLES) {
      return null
    }

    const span = samples[samples.length - 1].contextSec - samples[0].contextSec

    if (span < RATIO_MIN_SPAN_SEC) {
      return null
    }

    let sumX = 0
    let sumY = 0

    for (const sample of samples) {
      sumX += sample.contextSec
      sumY += sample.targetSec
    }

    const meanX = sumX / samples.length
    const meanY = sumY / samples.length
    let numerator = 0
    let denominator = 0

    for (const sample of samples) {
      numerator += (sample.contextSec - meanX) * (sample.targetSec - meanY)
      denominator += (sample.contextSec - meanX) ** 2
    }

    if (denominator <= 0) {
      return null
    }

    const slope = numerator / denominator

    if (!isFinite(slope)) {
      return null
    }

    return Math.min(1 + RATIO_MAX_DEV, Math.max(1 - RATIO_MAX_DEV, slope))
  }

  /**
   * Refresh {@link measuredLatencySec} for the direct path, skipping readings
   * taken while on the sink or during the post-wake settling window.
   */
  private sampleOutputLatency(): void {
    const ctx = this.ctx

    if (!ctx) {
      return
    }

    // Non-iOS only samples while on the DIRECT path. getOutputTimestamp can't
    // see the <audio> element's own buffering, so readings taken while on the
    // sink describe the direct path anyway — folding them in would just add
    // noise to the base we add the sink offset to.
    if (!IS_IOS && this.usingSink) {
      return
    }

    // Post-wake: keep the pre-sleep estimate rather than tracking unreliable
    // readings (see LATENCY_SETTLE_SEC). A moving `aim` is indistinguishable
    // from real drift to the corrector.
    if (ctx.currentTime < this.latencyHoldUntilCtx) {
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

  /**
   * Output latency for the path that is live RIGHT NOW. This must step the
   * instant we re-route, because the physical delay does: the sink adds the
   * <audio> element's buffering on top of the direct path. Feeding the
   * corrector a slow EMA across a switch made `aim` crawl while the position
   * skip jumped, so drift built up, got nudged hard, overshot, and only then
   * settled — the "too slow, then too fast, then correct" handover. iOS is
   * always on the sink and measures it directly, so it keeps the single
   * measured value unchanged.
   */
  private get activeLatencySec(): number {
    if (IS_IOS) {
      return this.measuredLatencySec
    }

    return this.usingSink
      ? this.measuredLatencySec + SINK_SWITCH_LATENCY_SEC
      : this.measuredLatencySec
  }

  /** Auto-measured output latency being compensated for, in ms. */
  get autoLatencyMs(): number {
    return this.activeLatencySec * 1000
  }

  /** Current playback position within the soundtrack, in seconds. */
  get currentTimeSec(): number {
    if (!this.ctx || !this.source || this.totalSec <= 0) {
      return 0
    }

    const position = this.positionSec(this.ctx.currentTime)

    return ((position % this.totalSec) + this.totalSec) % this.totalSec
  }

  /** Soundtrack length in seconds, or `NaN` before the moov is parsed. */
  get duration(): number {
    return this.totalSec || NaN
  }

  /**
   * Steer playback one tick toward the screen's position: slide windows,
   * reposition on large drift, otherwise nudge `playbackRate`.
   *
   * @param targetSec the screen's position, or `null` when it is unknown
   * @param playing whether the screen's video is playing
   */
  correct(targetSec: number | null, playing: boolean): CorrectionInfo {
    if (this.hardStopped) {
      this.stopChain()
      this.stopSource()

      return { mode: 'idle', driftMs: 0, rate: 1 }
    }

    if (this.backgrounded) {
      // Free-running on the pre-scheduled chain — don't touch sources (a
      // throttled tick that reached us must not restart/stop them). Just
      // report position vs target for the readout.
      this.resume()

      if (
        !this.ctx ||
        !this.source ||
        targetSec == null ||
        this.totalSec <= 0
      ) {
        return { mode: 'locked', driftMs: 0, rate: 1 }
      }

      const total = this.totalSec
      const position =
        ((this.positionSec(this.ctx.currentTime) % total) + total) % total
      const aim =
        (((targetSec + this.activeLatencySec) % total) + total) % total

      return {
        mode: 'locked',
        driftMs: signedDrift(position, aim, total) * 1000,
        rate: this.freeRunRate,
      }
    }

    if (!this.ctx || !this.table || this.totalSec <= 0) {
      if (this.desiredUrl) {
        this.setSource(this.desiredUrl)
      }

      return { mode: 'idle', driftMs: 0, rate: 1 }
    }

    if (targetSec == null || !playing) {
      // No target (typically: WebRTC still reconnecting after the sleep). If
      // chain audio is still sounding, keep free-running on it rather than
      // cutting to silence.
      if (this.chainPlaying()) {
        this.resume()

        return { mode: 'locked', driftMs: 0, rate: this.freeRunRate }
      }

      this.stopChain()
      this.stopSource()

      return { mode: 'idle', driftMs: 0, rate: 1 }
    }

    this.resume()
    this.sampleOutputLatency()

    const total = this.totalSec
    const ctxNow = this.ctx.currentTime
    const aim = (((targetSec + this.activeLatencySec) % total) + total) % total

    // Keep the clock-ratio estimate fresh.
    this.recordClockRatioSample(targetSec, ctxNow)

    const ratio = this.estimateClockRatio()

    if (ratio != null) {
      this.holdRate = ratio
    }

    // Install a freshly decoded window if one arrived, then make sure a decode
    // is in flight if nothing covers the aim yet.
    this.ensureDecode(aim)

    // Pick the window to play. Keep the CURRENT source's window until its
    // audio truly runs out (margin ~0) — abandoning it early just to switch
    // windows is what caused mid-playback `syncing` gaps. Only a fresh START
    // needs the EDGE margin (don't begin right at the end).
    let playWindow: DecodedWindow | null = null
    let slide = false

    if (
      this.source &&
      this.sourceWindow &&
      this.covers(this.sourceWindow, aim, 0.05)
    ) {
      playWindow = this.sourceWindow
    } else if (
      this.latestWindow &&
      this.covers(this.latestWindow, aim, WINDOW_EDGE_SEC)
    ) {
      playWindow = this.latestWindow
      // Seamless slide from a playing source.
      slide = this.source != null && this.sourceWindow != null
    }

    if (!playWindow) {
      // No decoded audio at the target yet (cold start, big seek, loop wrap,
      // or decode behind). While free-run chain audio is still sounding, keep
      // it rather than cutting to silence.
      if (this.chainPlaying()) {
        return { mode: 'locked', driftMs: 0, rate: this.freeRunRate }
      }

      this.stopChain()
      this.stopSource()

      return { mode: 'syncing', driftMs: 0, rate: 1 }
    }

    // Handing back from the free-run chain (post-wake, target just returned):
    // start a properly synced source and cut the chain at the same instant, so
    // the transition is de-clicked and there's no silence and no
    // two-sources-at-once overlap.
    if (this.chainedSources.length > 0) {
      const when = ctxNow + SCHEDULE_AHEAD_SEC
      this.startAt(aim, playWindow, ctxNow, false)
      this.stopChain(when + DECLICK_SEC)
      // Resume at the last known-good clock ratio rather than a blind 1.0. The
      // estimator's window was reset by the sleep gap, so it reports 1.0 for
      // the next ~20 s — starting at 1.0 would re-introduce the very drift the
      // corrector then has to chase out (slow, nudge, overshoot).
      this.forceRate(this.freeRunRate, ctxNow)

      return { mode: 'seek', driftMs: 0, rate: this.freeRunRate }
    }

    if (!this.source) {
      this.mute() // cold start: converge silently, fade in on first lock
      this.startAt(aim, playWindow, ctxNow, false)

      return { mode: 'seek', driftMs: 0, rate: 1 }
    }

    if (this.sourceWindow !== playWindow) {
      // Slide into the next window — carry rate/drift and fall through to
      // normal correction so the nudge corrector isn't reset every ~45 s.
      this.startAt(aim, playWindow, ctxNow, slide)
    }

    const position = this.positionSec(ctxNow)
    const positionWrapped = ((position % total) + total) % total
    const rawDrift = signedDrift(positionWrapped, aim, total)
    this.smoothedDriftSec =
      DRIFT_EMA_ALPHA * rawDrift +
      (1 - DRIFT_EMA_ALPHA) * this.smoothedDriftSec
    const drift = this.smoothedDriftSec
    const now = Date.now()
    const windowEnd = playWindow.startSec + playWindow.buffer.duration

    // Slide ahead: prefetch the next window once the playhead nears this
    // window's end.
    if (position > windowEnd - PREFETCH_MARGIN_SEC) {
      this.prefetchAt(playWindow.startSec + WINDOW_STEP_SEC)
    }

    if (
      Math.abs(rawDrift) > HARD_RESTART_SEC &&
      now - this.lastRestartAt >= RESTART_COOLDOWN_MS &&
      this.covers(playWindow, aim, WINDOW_EDGE_SEC)
    ) {
      this.startAt(aim, playWindow, ctxNow)

      return { mode: 'seek', driftMs: rawDrift * 1000, rate: 1 }
    }

    const mode: CorrectionMode =
      Math.abs(rawDrift) < LOCKED_SEC ? 'locked' : 'nudge'

    if (Math.abs(drift) < LOCK_DEADBAND_SEC) {
      this.unmute()
      // Hold the measured clock ratio, not 1.0. Snapping to 1.0 inside the
      // deadband guaranteed drift re-accumulated at the clocks' ppm difference
      // until it escaped the band and got nudged — a slow sawtooth that reads
      // as "settles, drifts, gets bumped, settles".
      this.setRate(this.holdRate, ctxNow)

      return { mode, driftMs: rawDrift * 1000, rate: this.rate }
    }

    const rate = correctionRate(drift, RATE_GAIN, RATE_MIN, RATE_MAX)
    this.setRate(rate, ctxNow)

    return { mode, driftMs: rawDrift * 1000, rate: this.rate }
  }

  /**
   * Schedule a contiguous chain of upcoming windows directly on the audio
   * thread so playback keeps going while the correction timer is throttled
   * (screen locked). Decoding races the browser suspending us, so whatever
   * windows land extend the runway; the current window alone already buys up
   * to WINDOW_SEC.
   */
  enterBackground(lookaheadSec = BACKGROUND_RUNWAY_SEC): void {
    if (this.backgrounded || !this.ctx || !this.source || !this.sourceWindow) {
      return
    }

    const ctxNow = this.ctx.currentTime
    // Where playback actually is now. After a previous free-run the chain will
    // have moved PAST sourceWindow, so pick a window that genuinely covers
    // this position — reusing a stale sourceWindow would clamp to its end and
    // jump the audio.
    const position = this.positionSec(ctxNow)
    const from =
      IS_IOS || this.usingSink ? position : position + SINK_SWITCH_LATENCY_SEC

    let fromWindow: DecodedWindow | null = null

    if (this.covers(this.sourceWindow, from, 0.05)) {
      fromWindow = this.sourceWindow
    } else if (
      this.latestWindow &&
      this.covers(this.latestWindow, from, 0.05)
    ) {
      fromWindow = this.latestWindow
    }

    if (!fromWindow) {
      // Nothing decoded covers the playhead (long free-run). Fetch it and
      // leave everything already scheduled alone — bailing without tearing
      // anything down is the safe choice here.
      this.ensureDecode(from)

      return
    }

    // Drop any chain left over from a previous sleep. It survives on purpose
    // when the wake found no target (WebRTC still down), but the fresh chain
    // below re-covers the same timeline — keeping the old one would leave two
    // overlapping chains sounding at once, and every further sleep would stack
    // another. This is the audio-stacking fix.
    this.stopChain()
    this.generation++ // invalidate any decode still in flight for the old chain
    this.backgrounded = true
    // Free-run at the MEASURED screen:device clock ratio, not a blind 1.0 —
    // and force it exactly (setRate's deadband would otherwise leave up to
    // 0.2% of residual nudge rate in place).
    this.freeRunRate = this.holdRate
    this.forceRate(this.freeRunRate, ctxNow)

    // Android/desktop play through the speakers in the foreground; route to
    // the keep-alive sink now so audio survives the lock (iOS is always on the
    // sink already), and skip content forward by the sink's added latency so
    // the (delayed) sink output stays aligned to the still-playing screen
    // instead of stepping behind it.
    if (!IS_IOS && !this.usingSink) {
      this.connectOutput(true)
      this.startAt(from, fromWindow, ctxNow, true)
    }

    this.buildChain(
      fromWindow.startSec + fromWindow.buffer.duration,
      ctxNow + lookaheadSec,
    )
  }

  /** Serialised entry point to {@link buildChainInner}. */
  private async buildChain(
    fromTrackSec: number,
    untilCtxTime: number,
  ): Promise<void> {
    if (this.chainBuilding) {
      return
    }

    this.chainBuilding = true

    try {
      await this.buildChainInner(fromTrackSec, untilCtxTime)
    } finally {
      this.chainBuilding = false
    }
  }

  /**
   * Top up the runway when a chained source finishes. `onended` is delivered
   * from the audio thread rather than a timer, so it can still arrive on a
   * throttled page — best-effort, but when it does fire the chain extends
   * itself and sleep playback continues past the initial runway.
   */
  private extendChain(): void {
    if (!this.backgrounded || !this.ctx || this.chainBuilding) {
      return
    }

    this.buildChain(
      this.chainTrackEnd,
      this.ctx.currentTime + BACKGROUND_RUNWAY_SEC,
    )
  }

  /**
   * Schedule windows from `fromTrackSec` onto the audio thread until the chain
   * reaches `untilCtxTime`, bailing if the graph transitions mid-build.
   */
  private async buildChainInner(
    fromTrackSec: number,
    untilCtxTime: number,
  ): Promise<void> {
    const generation = this.generation
    const rate = this.freeRunRate
    let trackCursor = fromTrackSec
    // Context time the playing source reaches `fromTrackSec` — content
    // advances at `rate` per context second, so the elapsed CONTEXT time is
    // the content delta divided by the rate.
    let ctxCursor =
      this.startCtxTime + (fromTrackSec - this.startOffset) / rate

    if (this.chainedSources.length === 0) {
      this.chainEndsAtCtx = ctxCursor
    }

    if (this.chainTrackEnd < trackCursor) {
      this.chainTrackEnd = trackCursor
    }

    while (
      this.backgrounded &&
      this.generation === generation &&
      ctxCursor < untilCtxTime &&
      trackCursor < this.totalSec - 0.05
    ) {
      const decoded = await this.decodeWindow(trackCursor)

      if (
        !decoded ||
        !this.backgrounded ||
        this.generation !== generation ||
        !this.ctx ||
        this.desiredUrl !== this.demuxedUrl
      ) {
        break
      }

      const offset = Math.max(0, trackCursor - decoded.startSec)
      const playSec = decoded.buffer.duration - offset

      if (playSec <= 0) {
        break
      }

      const source = this.ctx.createBufferSource()
      source.buffer = decoded.buffer
      source.playbackRate.value = rate // must match the primary, or every seam misaligns
      source.connect(this.masterGain ?? this.outputNode())
      source.start(ctxCursor, offset)

      source.onended = () => {
        try {
          source.disconnect()
        } catch {
          /* ignore */
        }

        const index = this.chainedSources.indexOf(source)

        if (index >= 0) {
          this.chainedSources.splice(index, 1)
        }

        this.extendChain() // keep the runway ahead of the playhead while still asleep
      }

      this.chainedSources.push(source)
      trackCursor += playSec
      ctxCursor += playSec / rate
      this.chainEndsAtCtx = ctxCursor
      // Must advance with the loop: extendChain() resumes from here, and
      // leaving it at the initial value made a top-up re-schedule the SAME
      // windows on top of the existing ones.
      this.chainTrackEnd = trackCursor
    }
  }

  /**
   * Leaving the background. Deliberately does NOT tear the chain down: the
   * WebRTC link is usually dropped by the sleep and takes seconds to
   * re-establish, so killing the chain here would cut audio to silence while
   * we wait for a target. Instead the chain keeps free-running and the next
   * correct() with a live target hands over to a synced source (then stops the
   * chain).
   */
  exitBackground(): void {
    if (!this.backgrounded) {
      return
    }

    this.backgrounded = false
    this.generation++ // invalidate in-flight chain decodes so they can't schedule after the reset

    // Hold the latency estimate: readings are unreliable for a few seconds
    // after a wake, and a moving `aim` reads as drift to the corrector (the
    // rough handover). See LATENCY_SETTLE_SEC.
    if (this.ctx) {
      this.latencyHoldUntilCtx = this.ctx.currentTime + LATENCY_SETTLE_SEC
    }

    // Back to the speakers for clean foreground output (iOS stays on the
    // sink). The chain and the primary source follow the master gain, so they
    // move with it.
    if (!IS_IOS && this.usingSink) {
      this.connectOutput(false)
    }
  }

  /**
   * Stop the free-run chain (at `when` if given, so a handover can be
   * de-clicked). Deliberately does NOT bump `generation`: this runs on the hot
   * no-window path every tick, and decodeWindow aborts when `generation` moves
   * — bumping here would cancel the very decode we're waiting for. Callers
   * that genuinely invalidate in-flight work (enter/exitBackground, resync,
   * stop) bump `generation` themselves.
   */
  private stopChain(when?: number): void {
    if (this.chainedSources.length === 0) {
      this.chainEndsAtCtx = 0
      this.chainTrackEnd = 0

      return
    }

    const doomed = this.chainedSources
    // Clear first so the sources' onended can't re-extend a chain we're
    // killing.
    this.chainedSources = []

    for (const source of doomed) {
      source.onended = null

      try {
        if (when != null) {
          source.stop(when)
        } else {
          source.stop()
        }
      } catch {
        /* already stopped */
      }

      try {
        if (when == null) {
          source.disconnect()
        }
      } catch {
        /* ignore */
      }
    }

    this.chainEndsAtCtx = 0
    this.chainTrackEnd = 0
  }

  /** Is pre-scheduled chain audio still sounding right now? */
  private chainPlaying(): boolean {
    return (
      this.chainedSources.length > 0 &&
      this.ctx != null &&
      this.ctx.currentTime < this.chainEndsAtCtx
    )
  }

  /** Drop the current segment so the next tick re-converges from scratch. */
  resync(): void {
    if (this.backgrounded) {
      return // don't disturb the free-run chain while locked
    }

    this.generation++
    this.smoothedDriftSec = 0
    this.lastRestartAt = 0

    // If chain audio is still sounding (post-wake, WebRTC not back yet), leave
    // it playing — correct() hands over once there's a live target. Otherwise
    // cold-start as usual.
    if (!this.chainPlaying()) {
      this.stopSource()
    }
  }

  /** Stop playback for good and tear down the keep-alive sink. */
  stop(): void {
    this.hardStopped = true
    this.generation++
    this.exitBackground() // leaves the chain playing by design — killed explicitly below
    this.stopChain()
    this.stopSource()
    this.latestWindow = null

    if (this.sinkElement) {
      this.sinkElement.pause()
      this.sinkElement.srcObject = null
      this.sinkElement = null
    }

    this.streamDest = null
  }
}
