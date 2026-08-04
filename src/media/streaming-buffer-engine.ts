/**
 * Long-form follower audio engine. Whole-file decode (BufferAudioEngine) costs ~21 MB/min,
 * so a 45-min track would need ~950 MB of RAM — untenable on a phone. This engine keeps that
 * flat by decoding only a sliding WINDOW of the timeline with WebCodecs:
 *
 *   fetch compressed file (small) → demux (mp4box) into encoded AAC frames kept in memory →
 *   decode a ~60 s PCM window around the playhead → play it EXACTLY like BufferAudioEngine
 *   (AudioContext-clock scheduling, sample-accurate source-node repositioning, playbackRate
 *   nudges, mute-switch-bypassing stream-sink keep-alive) → refill/slide the window before it
 *   runs out. Memory stays ~85 MB regardless of track length.
 *
 * Within a window it IS BufferAudioEngine — same correction math, gain de-click, and the iOS
 * lock-screen stream sink. The only added machinery is window bookkeeping: decode the next
 * window ahead of the playhead and swap to it (a de-clicked reposition into the overlapping
 * region, so it's seamless), and decode a fresh window on a large seek / loop wrap.
 *
 * Falls back (via onLoadFailed) when WebCodecs is unavailable (iOS < 16.4), demux fails, or
 * the codec isn't AAC-LC — the controller then routes to the element path.
 */
import { signedDrift, correctionRate } from '../sync/sync-math'
import type { CorrectionInfo, CorrectionMode, FollowerAudioEngine } from './audio-sync-controller'

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
// When we switch to the keep-alive sink on backgrounding, the <audio> element adds output
// latency that ctx.destination (the foreground path) didn't have, so the audio would lag the
// screen by that much. We can't measure the element's buffer from JS, so skip content forward
// by this estimate at the switch to keep sleep audio aligned (bigger = audio pulled earlier).
// Device-dependent (Bluetooth adds more) — override on-device with `?sinklat=0.25` to tune,
// then bake the winning value in here.
const SINK_SWITCH_LATENCY_SEC = (() => {
  if (typeof location !== 'undefined') {
    const m = /[?&]sinklat=([0-9.]+)/.exec(location.search)
    if (m) {
      const v = parseFloat(m[1])
      if (isFinite(v) && v >= 0 && v < 1) return v
    }
  }
  return 0.15
})()

// Seconds of audio pre-scheduled ahead when backgrounded so playback survives the throttled
// correction timer. Each ~60 s window is ~21 MB of PCM held at once, so a long runway is a big
// memory spike right as Android is trying to freeze the tab — a prime trigger for the OS to
// discard (reload) the tab. Trade runway vs. discard-risk; override on-device with `?runway=90`.
const BACKGROUND_RUNWAY_SEC = (() => {
  if (typeof location !== 'undefined') {
    const m = /[?&]runway=([0-9.]+)/.exec(location.search)
    if (m) {
      const v = parseFloat(m[1])
      if (isFinite(v) && v >= 30 && v <= 600) return v
    }
  }
  return 120
})()

// iOS needs the MediaStream sink for foreground output too (mute-switch bypass + lock-screen
// keep-alive), and it's smooth there. Android/desktop route straight to the speakers in the
// foreground — the sink's extra buffering there causes latency/jitter/rough swaps — and only
// switch to the sink while backgrounded (for the free-run chain to survive the lock).
const IS_IOS =
  typeof navigator !== 'undefined' &&
  (/iP(hone|ad|od)/.test(navigator.userAgent) ||
    (/Macintosh/.test(navigator.userAgent) && (navigator.maxTouchPoints ?? 0) > 1))

const AAC_FREQ_TABLE = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
]

// Clock-ratio estimation (screen clock vs this device's audio clock) used for background
// free-run: play at the measured ratio rather than a blind 1.0, which drifts by the clocks'
// ppm difference for as long as the screen is asleep.
const RATIO_WINDOW_SEC = 90 // regression window of recent samples
const RATIO_MIN_SPAN_SEC = 20 // need this much span before trusting the estimate
const RATIO_MAX_DEV = 0.005 // clamp to ±0.5% — a bigger "ratio" is noise/seek, not a real clock

const HEAD_CHUNK_BYTES = 2 * 1024 * 1024 // grow the moov fetch in 2 MB steps
const MAX_HEAD_BYTES = 24 * 1024 * 1024 // cap the moov search (covers many hours of audio)

/**
 * Per-sample metadata parsed from the moov (byte offset/size in the file + timing), stored as
 * parallel typed arrays so we can range-fetch just the bytes a window needs instead of holding
 * the whole compressed file in memory. This is what keeps the tab under Android's discard line.
 */
interface SampleTable {
  offset: Float64Array // byte offset of each sample in the file
  size: Float64Array
  start: Float64Array // sample start time (seconds)
  dur: Float64Array // sample duration (seconds)
  n: number
}

interface DecodedWindow {
  buffer: AudioBuffer
  startSec: number // track-second at buffer offset 0
}

/** AAC-LC AudioSpecificConfig (2 bytes) built from the track params — the WebCodecs `description`. */
function buildAacLcAsc(sampleRate: number, channels: number): Uint8Array | null {
  const freqIdx = AAC_FREQ_TABLE.indexOf(sampleRate)
  if (freqIdx < 0) return null
  const objectType = 2 // AAC-LC
  const b0 = (objectType << 3) | (freqIdx >> 1)
  const b1 = ((freqIdx & 1) << 7) | (channels << 3)
  return new Uint8Array([b0, b1])
}

export class StreamingBufferEngine implements FollowerAudioEngine {
  private ctx: AudioContext | null = null
  private streamDest: MediaStreamAudioDestinationNode | null = null
  private sinkEl: HTMLAudioElement | null = null
  private masterGain: GainNode | null = null
  private audible = false

  // Demux state: only the sample table (byte offsets/timing) is kept; sample DATA is
  // range-fetched per window on demand.
  private table: SampleTable | null = null
  private demuxedUrl: string | null = null
  private loadingUrl: string | null = null
  private desiredUrl: string | null = null
  private codec = ''
  private asc: Uint8Array | null = null
  private sampleRate = 44100
  private channels = 2
  private totalSec = 0

  // Window / playback state.
  private curWindow: DecodedWindow | null = null
  private srcWindow: DecodedWindow | null = null
  private pendingStart: number | null = null // track-sec a decode is in flight for (null = none)
  private src: AudioBufferSourceNode | null = null
  private startCtxTime = 0
  private startOffset = 0 // track-sec at startCtxTime
  private rate = 1
  private smoothedDriftSec = 0
  private lastRestartAt = 0
  // Measured output latency for the DIRECT (ctx.destination) path. The sink path's latency is this
  // plus SINK_SWITCH_LATENCY_SEC — see activeLatencySec. Keeping them separate matters because the
  // physical latency changes the instant we switch paths, while an EMA can only crawl.
  private measuredLatencySec = 0
  private hardStopped = false
  // Bumped on every graph transition (background enter/exit, resync, stop). Async decodes and
  // the chain builder capture it and bail if it changed — so work started before a transition
  // (e.g. an in-flight decode during sleep) can't schedule onto the graph as it's being reset,
  // which was crashing the renderer a moment after waking.
  private gen = 0
  // Background free-run: extra sources chained ahead on the audio thread so playback survives
  // the correction timer being throttled while the screen is locked.
  private backgrounded = false
  private chained: AudioBufferSourceNode[] = []
  private chainEndsAtCtx = 0 // context time the scheduled chain runs out (0 = no chain)
  private freeRunRate = 1 // rate the chain was scheduled at (measured clock ratio)
  // Steady-state rate to hold when locked: the measured screen:device clock ratio. Persists across
  // sleeps and estimator resets, so we never snap back to a 1.0 we know to be wrong.
  private holdRate = 1
  // Clock-ratio estimator state (see recordClockRatioSample).
  private ratioSamples: { x: number; y: number }[] = []
  private ratioAccum = -1 // unwrapped target seconds (-1 = not started)
  private lastRatioTarget = 0
  private usingSink = false // master gain currently routed to the keep-alive sink vs the speakers

  private readonly onLoadFailed: (url: string) => void
  unlocked = false

  constructor(onLoadFailed: (url: string) => void) {
    this.onLoadFailed = onLoadFailed
  }

  // ─── Output stage (mirrors BufferAudioEngine: context + keep-alive sink + master gain) ───

  unlock(): Promise<void> {
    this.hardStopped = false
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return Promise.reject(new Error('Web Audio unavailable'))
    if (typeof AudioDecoder === 'undefined') return Promise.reject(new Error('WebCodecs unavailable'))
    if (!this.ctx) this.ctx = new Ctx()
    if (!this.streamDest) {
      try {
        this.streamDest = this.ctx.createMediaStreamDestination()
        const el = new Audio()
        el.autoplay = true
        ;(el as HTMLAudioElement & { playsInline?: boolean }).playsInline = true
        el.setAttribute('playsinline', '')
        el.srcObject = this.streamDest.stream
        this.sinkEl = el
        void el.play().catch(() => {})
      } catch {
        this.streamDest = null
      }
    }
    if (!this.masterGain) {
      this.masterGain = this.ctx.createGain()
      this.masterGain.gain.value = 0
      this.connectOutput(IS_IOS) // iOS → sink; Android/desktop → straight to the speakers
    }
    try {
      const silent = this.ctx.createBuffer(1, 1, this.ctx.sampleRate)
      const s = this.ctx.createBufferSource()
      s.buffer = silent
      s.connect(this.ctx.destination)
      s.start()
    } catch {
      /* priming is best-effort */
    }
    const resume = this.ctx.state !== 'running' ? this.ctx.resume() : Promise.resolve()
    this.unlocked = true
    return resume.catch(() => {})
  }

  resume(): void {
    if (this.ctx && this.ctx.state !== 'running') this.ctx.resume().catch(() => {})
    if (this.sinkEl && this.sinkEl.paused) {
      if (navigator.mediaSession) navigator.mediaSession.playbackState = 'playing'
      void this.sinkEl.play().catch(() => {})
    }
  }

  get backgroundKeepAlive(): boolean {
    return this.streamDest != null
  }

  private outputNode(): AudioNode {
    return this.usingSink ? (this.streamDest ?? this.ctx!.destination) : this.ctx!.destination
  }

  /** Point the master gain at the speakers (foreground) or the keep-alive sink (background). */
  private connectOutput(useSink: boolean): void {
    if (!this.masterGain || !this.ctx) return
    const target = useSink && this.streamDest ? this.streamDest : this.ctx.destination
    try {
      this.masterGain.disconnect()
    } catch {
      /* not connected */
    }
    this.masterGain.connect(target)
    this.usingSink = useSink && this.streamDest != null
  }

  // ─── Load: fetch ONLY the moov and build the sample table (data is range-fetched per window) ───

  setSource(url: string): void {
    if (!url) return
    this.desiredUrl = url
    if (this.demuxedUrl !== url && this.loadingUrl !== url && this.ctx) void this.loadMetadata(url)
  }

  hasBufferFor(url: string): boolean {
    return this.demuxedUrl === url && this.table != null
  }

  private async loadMetadata(url: string): Promise<void> {
    this.loadingUrl = url
    try {
      const { createFile } = await import('mp4box')
      const file = createFile()
      let info: import('mp4box').Movie | null = null
      file.onError = () => {}
      file.onReady = (i) => {
        info = i
      }
      // Fetch the file head in chunks until the moov is parsed (faststart puts it up front).
      let headEnd = 0
      while (!info && headEnd < MAX_HEAD_BYTES) {
        const res = await fetch(url, { headers: { Range: `bytes=${headEnd}-${headEnd + HEAD_CHUNK_BYTES - 1}` } })
        if (!res.ok) throw new Error(`fetch ${res.status}`)
        if (this.desiredUrl !== url) return
        const part = await res.arrayBuffer()
        const mp4buf = part as ArrayBuffer & { fileStart: number }
        mp4buf.fileStart = headEnd
        file.appendBuffer(mp4buf) // onReady fires synchronously once the moov is complete
        headEnd += part.byteLength
        if (part.byteLength < HEAD_CHUNK_BYTES) break // reached EOF
      }
      if (!info) throw new Error('moov not found')
      const track = (info as import('mp4box').Movie).audioTracks?.[0]
      if (!track || !track.audio) throw new Error('no audio track')
      if (!track.codec.startsWith('mp4a.40')) throw new Error(`unsupported codec ${track.codec}`)
      const asc = buildAacLcAsc(track.audio.sample_rate, track.audio.channel_count)
      if (!asc) throw new Error(`unsupported sample rate ${track.audio.sample_rate}`)

      // Build the sample table from the moov (offsets/sizes/timing) — no sample DATA needed.
      file.setExtractionOptions(track.id, null, { nbSamples: 1 })
      file.start()
      const samples = file.getTrackById(track.id).samples
      const n = samples.length
      const offset = new Float64Array(n)
      const size = new Float64Array(n)
      const start = new Float64Array(n)
      const dur = new Float64Array(n)
      for (let i = 0; i < n; i++) {
        const s = samples[i]
        offset[i] = s.offset
        size[i] = s.size
        start[i] = s.cts / s.timescale
        dur[i] = s.duration / s.timescale
      }
      file.stop()
      if (this.desiredUrl !== url) return

      this.codec = track.codec
      this.sampleRate = track.audio.sample_rate
      this.channels = track.audio.channel_count
      this.asc = asc
      this.totalSec = n ? start[n - 1] + dur[n - 1] : 0
      this.table = { offset, size, start, dur, n }
      this.demuxedUrl = url
      // mp4box's file (with its own copy of the sample structures) can now be dropped.
    } catch {
      if (this.desiredUrl === url) this.onLoadFailed(url)
    } finally {
      if (this.loadingUrl === url) this.loadingUrl = null
    }
  }

  /** First sample index whose start time is >= sec (binary search over the sorted table). */
  private lowerBound(sec: number): number {
    const t = this.table!
    let lo = 0
    let hi = t.n
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (t.start[mid] < sec) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  /** Decode a PCM window covering [startSec, startSec+WINDOW_SEC], range-fetching just its bytes. */
  private async decodeWindow(startSec: number): Promise<DecodedWindow | null> {
    const ctx = this.ctx
    const t = this.table
    const url = this.demuxedUrl
    if (!ctx || !t || !url || !this.asc) return null
    const gen = this.gen // bail if a background/resync/stop transition happens mid-decode
    const winStart = Math.max(0, Math.min(startSec, Math.max(0, this.totalSec - WINDOW_SEC)))
    const winLen = Math.min(WINDOW_SEC, this.totalSec - winStart)
    if (winLen <= 0) return null

    // Sample index range covering [winStart - preroll, winStart + winLen].
    const decodeFrom = Math.max(0, winStart - PREROLL_SEC)
    const decodeTo = winStart + winLen
    let i0 = this.lowerBound(decodeFrom)
    if (i0 > 0) i0-- // include the sample straddling the start
    let i1 = this.lowerBound(decodeTo) - 1
    if (i1 < i0) i1 = i0
    if (i1 >= t.n) i1 = t.n - 1

    // Range-fetch exactly the compressed bytes for those samples (contiguous in the mdat).
    const lo = t.offset[i0]
    const hi = t.offset[i1] + t.size[i1]
    const res = await fetch(url, { headers: { Range: `bytes=${lo}-${hi - 1}` } })
    if (!res.ok) throw new Error(`range ${res.status}`)
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (this.desiredUrl !== this.demuxedUrl || this.gen !== gen || !this.ctx) return null

    const sr = this.sampleRate
    const ch = this.channels
    const frameCount = Math.ceil(winLen * sr)
    const channelData = Array.from({ length: ch }, () => new Float32Array(frameCount))

    await new Promise<void>((resolve, reject) => {
      let decoder: AudioDecoder
      try {
        decoder = new AudioDecoder({
          output: (ad) => {
            const base = Math.round((ad.timestamp / 1e6 - winStart) * sr)
            const n = ad.numberOfFrames
            const destStart = Math.max(0, base)
            const destEnd = Math.min(frameCount, base + n)
            if (destEnd <= destStart) {
              ad.close()
              return
            }
            const srcStart = destStart - base
            const copyLen = destEnd - destStart
            const tmp = new Float32Array(n)
            for (let c = 0; c < ch; c++) {
              try {
                ad.copyTo(tmp, { planeIndex: c, format: 'f32-planar' })
              } catch {
                ad.close()
                return
              }
              channelData[c].set(tmp.subarray(srcStart, srcStart + copyLen), destStart)
            }
            ad.close()
          },
          error: (e) => {
            closeDecoder()
            reject(e)
          },
        })
        const closeDecoder = () => {
          try {
            if (decoder.state !== 'closed') decoder.close()
          } catch {
            /* already closed */
          }
        }
        decoder.configure({
          codec: this.codec,
          sampleRate: sr,
          numberOfChannels: ch,
          description: this.asc!,
        })
        for (let i = i0; i <= i1; i++) {
          const view = bytes.subarray(t.offset[i] - lo, t.offset[i] - lo + t.size[i])
          decoder.decode(
            new EncodedAudioChunk({
              type: 'key',
              timestamp: t.start[i] * 1e6,
              duration: t.dur[i] * 1e6,
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
          .catch((e) => {
            closeDecoder()
            reject(e)
          })
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })

    if (this.desiredUrl !== this.demuxedUrl || this.gen !== gen || !this.ctx) return null
    const buffer = ctx.createBuffer(ch, frameCount, sr)
    for (let c = 0; c < ch; c++) buffer.copyToChannel(channelData[c], c)
    return { buffer, startSec: winStart }
  }

  /** Kick a window decode for `aim` if nothing covers it and none is already in flight. */
  private ensureDecode(aim: number): void {
    if (this.pendingStart != null) return
    if (this.curWindow && this.covers(this.curWindow, aim, 0)) return
    this.decodeInto(Math.max(0, aim - PREROLL_SEC))
  }

  /**
   * Prefetch the NEXT window by start position. Unlike ensureDecode this must NOT gate on the
   * current window "covering" that point — the current window overlaps the next one's start, so
   * a coverage check would always skip and the next window would never decode until the current
   * ran out (the ~1 s swap gap). Only skip if we already have/are fetching that exact window.
   */
  private prefetchAt(startSec: number): void {
    if (this.pendingStart != null) return
    if (this.curWindow && Math.abs(this.curWindow.startSec - startSec) < 1) return
    this.decodeInto(startSec)
  }

  private decodeInto(start: number): void {
    this.pendingStart = start
    void this.decodeWindow(start)
      .then((w) => {
        if (w) this.curWindow = w
      })
      .catch(() => {})
      .finally(() => {
        if (this.pendingStart === start) this.pendingStart = null
      })
  }

  private covers(w: DecodedWindow, trackSec: number, margin: number): boolean {
    return trackSec >= w.startSec + margin && trackSec <= w.startSec + w.buffer.duration - margin
  }

  // ─── Gain helpers (identical model to BufferAudioEngine) ───

  private mute(): void {
    this.audible = false
    const g = this.masterGain?.gain
    if (!g || !this.ctx) return
    const now = this.ctx.currentTime
    g.cancelScheduledValues(now)
    g.setValueAtTime(g.value, now)
    g.linearRampToValueAtTime(0, now + DECLICK_SEC)
  }

  private unmute(): void {
    if (this.audible) return
    this.audible = true
    const g = this.masterGain?.gain
    if (!g || !this.ctx) return
    const now = this.ctx.currentTime
    g.cancelScheduledValues(now)
    g.setValueAtTime(g.value, now)
    g.linearRampToValueAtTime(1, now + UNMUTE_SEC)
  }

  private declickSwap(when: number): void {
    const g = this.masterGain?.gain
    if (!g || !this.audible || !this.ctx) return
    const now = this.ctx.currentTime
    g.cancelScheduledValues(now)
    g.setValueAtTime(1, Math.max(now, when - DECLICK_SEC))
    g.linearRampToValueAtTime(0, when)
    g.linearRampToValueAtTime(1, when + DECLICK_SEC)
  }

  private stopSource(): void {
    const src = this.src
    this.src = null
    this.srcWindow = null
    if (!src) return
    const g = this.masterGain?.gain
    if (this.ctx && g) {
      const now = this.ctx.currentTime
      g.cancelScheduledValues(now)
      g.setValueAtTime(g.value, now)
      g.linearRampToValueAtTime(0, now + DECLICK_SEC)
      this.audible = false
      try {
        src.stop(now + DECLICK_SEC)
      } catch {
        /* already stopped */
      }
      src.onended = () => {
        try {
          src.disconnect()
        } catch {
          /* ignore */
        }
      }
    } else {
      try {
        src.stop()
      } catch {
        /* already stopped */
      }
      src.disconnect()
    }
  }

  private positionSec(ctxNow: number): number {
    return this.startOffset + (ctxNow - this.startCtxTime) * this.rate
  }

  /**
   * Start a source from window `w` at track position `aimTrackSec`, scheduled slightly ahead.
   * `continuation` = a seamless slide into the next window (not a seek): the current rate and
   * drift EMA are carried over so the nudge corrector keeps its state instead of resetting to
   * 1 every ~45 s — otherwise steady drift never gets corrected and grows between slides.
   */
  private startAt(aimTrackSec: number, w: DecodedWindow, ctxNow: number, continuation = false): void {
    const ctx = this.ctx!
    const dur = w.buffer.duration
    const rate = continuation ? this.rate : 1
    const bufOffset = Math.min(Math.max(aimTrackSec - w.startSec, 0), Math.max(0, dur - 0.02))
    const src = ctx.createBufferSource()
    src.buffer = w.buffer
    src.playbackRate.value = rate
    src.connect(this.masterGain ?? this.outputNode())
    const when = ctxNow + SCHEDULE_AHEAD_SEC
    const startBufOffset = Math.min(bufOffset + SCHEDULE_AHEAD_SEC * rate, Math.max(0, dur - 0.001))
    src.start(when, startBufOffset)
    this.declickSwap(when)
    const old = this.src
    if (old) {
      try {
        old.stop(when + DECLICK_SEC)
      } catch {
        /* already stopped */
      }
      old.onended = () => {
        try {
          old.disconnect()
        } catch {
          /* ignore */
        }
      }
    }
    this.src = src
    this.srcWindow = w
    this.startCtxTime = when
    this.startOffset = w.startSec + startBufOffset
    this.rate = rate
    if (!continuation) this.smoothedDriftSec = 0
    this.lastRestartAt = Date.now()
  }

  private setRate(rate: number, ctxNow: number): void {
    if (!this.src || Math.abs(rate - this.rate) <= RATE_EPS) return
    this.forceRate(rate, ctxNow)
  }

  /**
   * Set an EXACT rate, bypassing the RATE_EPS deadband. Free-run needs this: setRate(1) would
   * early-return while the source still ran at up to 1±RATE_EPS (0.2% = ~120 ms drift per
   * minute), and the chained sources — which are always created at exactly 1.0 — would then be
   * scheduled against a primary running at a different speed, misaligning every seam.
   */
  private forceRate(rate: number, ctxNow: number): void {
    if (!this.src) return
    this.startOffset = this.positionSec(ctxNow)
    this.startCtxTime = ctxNow
    this.rate = rate
    this.src.playbackRate.value = rate
  }

  /**
   * Record (screen target, context time) pairs so we can estimate the ratio between the screen's
   * clock and this device's audio clock. Crystals differ by tens of ppm, so free-running at
   * exactly 1.0 drifts steadily; free-running at the measured ratio tracks far better. Target is
   * unwrapped (loop wraps / seeks are dropped) so the regression sees a monotone line.
   */
  private recordClockRatioSample(targetSec: number, ctxNow: number): void {
    const d = targetSec - this.lastRatioTarget
    this.lastRatioTarget = targetSec
    // Only smooth forward advances feed the regression. A loop wrap, seek, or throttled gap would
    // otherwise leave a flat spot that biases the slope, so those RESTART the window instead of
    // being merely skipped (the estimate then falls back to 1 until clean span rebuilds).
    if (this.ratioAccum >= 0 && d > 0 && d < 1) {
      this.ratioAccum += d
      this.ratioSamples.push({ x: ctxNow, y: this.ratioAccum })
      const cutoff = ctxNow - RATIO_WINDOW_SEC
      while (this.ratioSamples.length > 2 && this.ratioSamples[0].x < cutoff) this.ratioSamples.shift()
    } else {
      if (this.ratioAccum < 0) this.ratioAccum = 0
      this.ratioSamples.length = 0
    }
  }

  /**
   * Least-squares slope of target-seconds per context-second (1 = clocks agree). Returns null when
   * there isn't enough clean data to trust — callers then keep the last good value (`holdRate`)
   * rather than snapping to 1.0, which would re-introduce drift.
   */
  private estimateClockRatio(): number | null {
    const s = this.ratioSamples
    if (s.length < 20) return null
    const span = s[s.length - 1].x - s[0].x
    if (span < RATIO_MIN_SPAN_SEC) return null
    let sx = 0
    let sy = 0
    for (const p of s) {
      sx += p.x
      sy += p.y
    }
    const mx = sx / s.length
    const my = sy / s.length
    let num = 0
    let den = 0
    for (const p of s) {
      num += (p.x - mx) * (p.y - my)
      den += (p.x - mx) * (p.x - mx)
    }
    if (den <= 0) return null
    const slope = num / den
    if (!isFinite(slope)) return null
    return Math.min(1 + RATIO_MAX_DEV, Math.max(1 - RATIO_MAX_DEV, slope))
  }

  private sampleOutputLatency(): void {
    const ctx = this.ctx
    if (!ctx) return
    // Non-iOS only samples while on the DIRECT path. getOutputTimestamp can't see the <audio>
    // element's own buffering, so readings taken while on the sink describe the direct path
    // anyway — folding them in would just add noise to the base we add the sink offset to.
    if (!IS_IOS && this.usingSink) return
    let L: number | null = null
    const g = ctx.getOutputTimestamp?.()
    if (g && typeof g.contextTime === 'number' && g.contextTime > 0) {
      const d = ctx.currentTime - g.contextTime
      if (d > 0.001 && d < 1) L = d
    }
    if (L == null && typeof ctx.outputLatency === 'number' && ctx.outputLatency > 0) {
      L = ctx.outputLatency + (ctx.baseLatency ?? 0)
    }
    if (L == null && this.measuredLatencySec < 0.02) L = FALLBACK_LATENCY_SEC
    if (L == null) return
    L = Math.min(MAX_LATENCY_SEC, Math.max(0, L))
    this.measuredLatencySec = this.measuredLatencySec
      ? this.measuredLatencySec * (1 - LATENCY_EMA_ALPHA) + L * LATENCY_EMA_ALPHA
      : L
  }

  /**
   * Output latency for the path that is live RIGHT NOW. This must step the instant we re-route,
   * because the physical delay does: the sink adds the <audio> element's buffering on top of the
   * direct path. Feeding the corrector a slow EMA across a switch made `aim` crawl while the
   * position skip jumped, so drift built up, got nudged hard, overshot, and only then settled —
   * the "too slow, then too fast, then correct" handover. iOS is always on the sink and measures
   * it directly, so it keeps the single measured value unchanged.
   */
  private get activeLatencySec(): number {
    if (IS_IOS) return this.measuredLatencySec
    return this.usingSink ? this.measuredLatencySec + SINK_SWITCH_LATENCY_SEC : this.measuredLatencySec
  }

  get autoLatencyMs(): number {
    return this.activeLatencySec * 1000
  }

  get currentTimeSec(): number {
    if (!this.ctx || !this.src || this.totalSec <= 0) return 0
    const pos = this.positionSec(this.ctx.currentTime)
    return ((pos % this.totalSec) + this.totalSec) % this.totalSec
  }

  get duration(): number {
    return this.totalSec || NaN
  }

  correct(targetSec: number | null, playing: boolean): CorrectionInfo {
    if (this.hardStopped) {
      this.stopChain()
      this.stopSource()
      return { mode: 'idle', driftMs: 0, rate: 1 }
    }
    if (this.backgrounded) {
      // Free-running on the pre-scheduled chain — don't touch sources (a throttled tick that
      // reached us must not restart/stop them). Just report position vs target for the readout.
      this.resume()
      if (!this.ctx || !this.src || targetSec == null || this.totalSec <= 0) {
        return { mode: 'locked', driftMs: 0, rate: 1 }
      }
      const total = this.totalSec
      const pos = ((this.positionSec(this.ctx.currentTime) % total) + total) % total
      const aim = (((targetSec + this.activeLatencySec) % total) + total) % total
      return { mode: 'locked', driftMs: signedDrift(pos, aim, total) * 1000, rate: this.freeRunRate }
    }
    if (!this.ctx || !this.table || this.totalSec <= 0) {
      if (this.desiredUrl) this.setSource(this.desiredUrl)
      return { mode: 'idle', driftMs: 0, rate: 1 }
    }
    if (targetSec == null || !playing) {
      // No target (typically: WebRTC still reconnecting after the sleep). If chain audio is still
      // sounding, keep free-running on it rather than cutting to silence.
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
    this.recordClockRatioSample(targetSec, ctxNow) // keep the clock-ratio estimate fresh
    const ratio = this.estimateClockRatio()
    if (ratio != null) this.holdRate = ratio

    // Install a freshly decoded window if one arrived, then make sure a decode is in flight
    // if nothing covers the aim yet.
    this.ensureDecode(aim)

    // Pick the window to play. Keep the CURRENT source's window until its audio truly runs out
    // (margin ~0) — abandoning it early just to switch windows is what caused mid-playback
    // `syncing` gaps. Only a fresh START needs the EDGE margin (don't begin right at the end).
    let w: DecodedWindow | null = null
    let slide = false
    if (this.src && this.srcWindow && this.covers(this.srcWindow, aim, 0.05)) {
      w = this.srcWindow
    } else if (this.curWindow && this.covers(this.curWindow, aim, WINDOW_EDGE_SEC)) {
      w = this.curWindow
      slide = this.src != null && this.srcWindow != null // seamless slide from a playing source
    }

    if (!w) {
      // No decoded audio at the target yet (cold start, big seek, loop wrap, or decode behind).
      // While free-run chain audio is still sounding, keep it rather than cutting to silence.
      if (this.chainPlaying()) return { mode: 'locked', driftMs: 0, rate: this.freeRunRate }
      this.stopChain()
      this.stopSource()
      return { mode: 'syncing', driftMs: 0, rate: 1 }
    }

    // Handing back from the free-run chain (post-wake, target just returned): start a properly
    // synced source and cut the chain at the same instant, so the transition is de-clicked and
    // there's no silence and no two-sources-at-once overlap.
    if (this.chained.length > 0) {
      const when = ctxNow + SCHEDULE_AHEAD_SEC
      this.startAt(aim, w, ctxNow, false)
      this.stopChain(when + DECLICK_SEC)
      // Resume at the last known-good clock ratio rather than a blind 1.0. The estimator's window
      // was reset by the sleep gap, so it reports 1.0 for the next ~20 s — starting at 1.0 would
      // re-introduce the very drift the corrector then has to chase out (slow, nudge, overshoot).
      this.forceRate(this.freeRunRate, ctxNow)
      return { mode: 'seek', driftMs: 0, rate: this.freeRunRate }
    }

    if (!this.src) {
      this.mute() // cold start: converge silently, fade in on first lock
      this.startAt(aim, w, ctxNow, false)
      return { mode: 'seek', driftMs: 0, rate: 1 }
    }
    if (this.srcWindow !== w) {
      // Slide into the next window — carry rate/drift and fall through to normal correction so
      // the nudge corrector isn't reset every ~45 s.
      this.startAt(aim, w, ctxNow, slide)
    }

    const pos = this.positionSec(ctxNow)
    const posWrapped = ((pos % total) + total) % total
    const rawDrift = signedDrift(posWrapped, aim, total)
    this.smoothedDriftSec = DRIFT_EMA_ALPHA * rawDrift + (1 - DRIFT_EMA_ALPHA) * this.smoothedDriftSec
    const drift = this.smoothedDriftSec
    const now = Date.now()

    // Slide ahead: prefetch the next window once the playhead nears this window's end.
    if (pos > w.startSec + w.buffer.duration - PREFETCH_MARGIN_SEC) {
      this.prefetchAt(w.startSec + WINDOW_STEP_SEC)
    }

    if (
      Math.abs(rawDrift) > HARD_RESTART_SEC &&
      now - this.lastRestartAt >= RESTART_COOLDOWN_MS &&
      this.covers(w, aim, WINDOW_EDGE_SEC)
    ) {
      this.startAt(aim, w, ctxNow)
      return { mode: 'seek', driftMs: rawDrift * 1000, rate: 1 }
    }

    if (Math.abs(drift) < LOCK_DEADBAND_SEC) {
      this.unmute()
      // Hold the measured clock ratio, not 1.0. Snapping to 1.0 inside the deadband guaranteed
      // drift re-accumulated at the clocks' ppm difference until it escaped the band and got
      // nudged — a slow sawtooth that reads as "settles, drifts, gets bumped, settles".
      this.setRate(this.holdRate, ctxNow)
      return {
        mode: (Math.abs(rawDrift) < LOCKED_SEC ? 'locked' : 'nudge') as CorrectionMode,
        driftMs: rawDrift * 1000,
        rate: this.rate,
      }
    }

    const rate = correctionRate(drift, RATE_GAIN, RATE_MIN, RATE_MAX)
    this.setRate(rate, ctxNow)
    return {
      mode: (Math.abs(rawDrift) < LOCKED_SEC ? 'locked' : 'nudge') as CorrectionMode,
      driftMs: rawDrift * 1000,
      rate: this.rate,
    }
  }

  /**
   * Schedule a contiguous chain of upcoming windows (rate 1) directly on the audio thread so
   * playback keeps going while the correction timer is throttled (screen locked). Decoding
   * races the browser suspending us, so whatever windows land extend the runway; the current
   * window alone already buys up to WINDOW_SEC.
   */
  enterBackground(lookaheadSec = BACKGROUND_RUNWAY_SEC): void {
    if (this.backgrounded || !this.ctx || !this.src || !this.srcWindow) return
    const ctxNow = this.ctx.currentTime
    // Where playback actually is now. After a previous free-run the chain will have moved PAST
    // srcWindow, so pick a window that genuinely covers this position — reusing a stale srcWindow
    // would clamp to its end and jump the audio.
    const pos = this.positionSec(ctxNow)
    const from = IS_IOS || this.usingSink ? pos : pos + SINK_SWITCH_LATENCY_SEC
    let w: DecodedWindow | null = null
    if (this.covers(this.srcWindow, from, 0.05)) w = this.srcWindow
    else if (this.curWindow && this.covers(this.curWindow, from, 0.05)) w = this.curWindow
    if (!w) {
      // Nothing decoded covers the playhead (long free-run). Fetch it and leave everything already
      // scheduled alone — bailing without tearing anything down is the safe choice here.
      this.ensureDecode(from)
      return
    }
    // Drop any chain left over from a previous sleep. It survives on purpose when the wake found no
    // target (WebRTC still down), but the fresh chain below re-covers the same timeline — keeping
    // the old one would leave two overlapping chains sounding at once, and every further sleep
    // would stack another. This is the audio-stacking fix.
    this.stopChain()
    this.gen++ // invalidate any decode still in flight for the old chain
    this.backgrounded = true
    // Free-run at the MEASURED screen:device clock ratio, not a blind 1.0 — and force it exactly
    // (setRate's deadband would otherwise leave up to 0.2% of residual nudge rate in place).
    this.freeRunRate = this.holdRate
    this.forceRate(this.freeRunRate, ctxNow)
    // Android/desktop play through the speakers in the foreground; route to the keep-alive sink
    // now so audio survives the lock (iOS is always on the sink already), and skip content
    // forward by the sink's added latency so the (delayed) sink output stays aligned to the
    // still-playing screen instead of stepping behind it.
    if (!IS_IOS && !this.usingSink) {
      this.connectOutput(true)
      this.startAt(from, w, ctxNow, true)
    }
    void this.buildChain(w.startSec + w.buffer.duration, ctxNow + lookaheadSec)
  }

  private async buildChain(fromTrackSec: number, untilCtxTime: number): Promise<void> {
    const gen = this.gen
    const rate = this.freeRunRate
    let trackCursor = fromTrackSec
    // Context time the playing source reaches `fromTrackSec` — content advances at `rate` per
    // context second, so the elapsed CONTEXT time is the content delta divided by the rate.
    let ctxCursor = this.startCtxTime + (fromTrackSec - this.startOffset) / rate
    this.chainEndsAtCtx = ctxCursor
    while (this.backgrounded && this.gen === gen && ctxCursor < untilCtxTime && trackCursor < this.totalSec - 0.05) {
      const w = await this.decodeWindow(trackCursor)
      if (!w || !this.backgrounded || this.gen !== gen || !this.ctx || this.desiredUrl !== this.demuxedUrl) break
      const offset = Math.max(0, trackCursor - w.startSec)
      const playSec = w.buffer.duration - offset
      if (playSec <= 0) break
      const src = this.ctx.createBufferSource()
      src.buffer = w.buffer
      src.playbackRate.value = rate // must match the primary, or every seam misaligns
      src.connect(this.masterGain ?? this.outputNode())
      src.start(ctxCursor, offset)
      src.onended = () => {
        try {
          src.disconnect()
        } catch {
          /* ignore */
        }
      }
      this.chained.push(src)
      trackCursor += playSec
      ctxCursor += playSec / rate
      this.chainEndsAtCtx = ctxCursor
    }
  }

  /**
   * Leaving the background. Deliberately does NOT tear the chain down: the WebRTC link is usually
   * dropped by the sleep and takes seconds to re-establish, so killing the chain here would cut
   * audio to silence while we wait for a target. Instead the chain keeps free-running and the
   * next correct() with a live target hands over to a synced source (then stops the chain).
   */
  exitBackground(): void {
    if (!this.backgrounded) return
    this.backgrounded = false
    this.gen++ // invalidate any in-flight chain decode so it can't schedule after we reset
    // Back to the speakers for clean foreground output (iOS stays on the sink). The chain and the
    // primary source follow the master gain, so they move with it.
    if (!IS_IOS && this.usingSink) this.connectOutput(false)
  }

  /**
   * Stop the free-run chain (at `when` if given, so a handover can be de-clicked). Deliberately
   * does NOT bump `gen`: this runs on the hot no-window path every tick, and decodeWindow aborts
   * when `gen` moves — bumping here would cancel the very decode we're waiting for. Callers that
   * genuinely invalidate in-flight work (enter/exitBackground, resync, stop) bump `gen` themselves.
   */
  private stopChain(when?: number): void {
    if (this.chained.length === 0) {
      this.chainEndsAtCtx = 0
      return
    }
    for (const s of this.chained) {
      try {
        if (when != null) s.stop(when)
        else s.stop()
      } catch {
        /* already stopped */
      }
    }
    this.chained = []
    this.chainEndsAtCtx = 0
  }

  /** Is pre-scheduled chain audio still sounding right now? */
  private chainPlaying(): boolean {
    return this.chained.length > 0 && this.ctx != null && this.ctx.currentTime < this.chainEndsAtCtx
  }

  resync(): void {
    if (this.backgrounded) return // don't disturb the free-run chain while locked
    this.gen++
    this.smoothedDriftSec = 0
    this.lastRestartAt = 0
    // If chain audio is still sounding (post-wake, WebRTC not back yet), leave it playing —
    // correct() hands over once there's a live target. Otherwise cold-start as usual.
    if (!this.chainPlaying()) this.stopSource()
  }

  stop(): void {
    this.hardStopped = true
    this.gen++
    this.exitBackground() // leaves the chain playing by design — kill it explicitly below
    this.stopChain()
    this.stopSource()
    this.curWindow = null
    if (this.sinkEl) {
      this.sinkEl.pause()
      this.sinkEl.srcObject = null
      this.sinkEl = null
    }
    this.streamDest = null
  }
}
