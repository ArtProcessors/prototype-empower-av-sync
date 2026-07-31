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

interface EncodedFrame {
  data: Uint8Array
  timestampUs: number
  durationUs: number
  startSec: number
  endSec: number
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

  // Demux state (compressed frames kept in memory — small).
  private encoded: EncodedFrame[] | null = null
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
  private measuredLatencySec = 0
  private hardStopped = false
  // Background free-run: extra sources chained ahead on the audio thread so playback survives
  // the correction timer being throttled while the screen is locked.
  private backgrounded = false
  private chained: AudioBufferSourceNode[] = []
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

  // ─── Fetch + demux (compressed frames only; decode happens per window) ───

  setSource(url: string): void {
    if (!url) return
    this.desiredUrl = url
    if (this.demuxedUrl !== url && this.loadingUrl !== url && this.ctx) void this.loadAndDemux(url)
  }

  hasBufferFor(url: string): boolean {
    return this.demuxedUrl === url && this.encoded != null
  }

  private async loadAndDemux(url: string): Promise<void> {
    this.loadingUrl = url
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`fetch ${res.status}`)
      const ab = await res.arrayBuffer()
      if (this.desiredUrl !== url) return
      const { createFile } = await import('mp4box')
      const file = createFile()
      const frames: EncodedFrame[] = []
      let nbSamples = Infinity
      let sampleRate = 44100
      let channels = 2
      let codec = ''

      const done = new Promise<void>((resolve, reject) => {
        file.onError = (e: string) => reject(new Error(String(e)))
        file.onReady = (info) => {
          const track = info.audioTracks?.[0]
          if (!track || !track.audio) {
            reject(new Error('no audio track'))
            return
          }
          nbSamples = track.nb_samples
          sampleRate = track.audio.sample_rate
          channels = track.audio.channel_count
          codec = track.codec
          file.setExtractionOptions(track.id, null, { nbSamples: 2000 })
          file.start()
        }
        file.onSamples = (_id, _user, samples) => {
          for (const s of samples) {
            if (!s.data) continue
            const startSec = s.cts / s.timescale
            const durSec = s.duration / s.timescale
            frames.push({
              data: s.data.slice(),
              timestampUs: startSec * 1e6,
              durationUs: durSec * 1e6,
              startSec,
              endSec: startSec + durSec,
            })
          }
          if (frames.length >= nbSamples) resolve()
        }
      })

      const mp4buf = ab as ArrayBuffer & { fileStart: number }
      mp4buf.fileStart = 0
      file.appendBuffer(mp4buf)
      file.flush()
      await done
      file.stop()
      if (this.desiredUrl !== url) return

      if (!codec.startsWith('mp4a.40')) throw new Error(`unsupported codec ${codec}`)
      const asc = buildAacLcAsc(sampleRate, channels)
      if (!asc) throw new Error(`unsupported sample rate ${sampleRate}`)

      this.codec = codec
      this.sampleRate = sampleRate
      this.channels = channels
      this.asc = asc
      this.totalSec = frames.length ? frames[frames.length - 1].endSec : 0
      this.encoded = frames
      this.demuxedUrl = url
    } catch {
      if (this.desiredUrl === url) this.onLoadFailed(url)
    } finally {
      if (this.loadingUrl === url) this.loadingUrl = null
    }
  }

  /** Decode a PCM window covering [startSec, startSec+WINDOW_SEC] (clamped to the track). */
  private async decodeWindow(startSec: number): Promise<DecodedWindow | null> {
    const ctx = this.ctx
    const enc = this.encoded
    if (!ctx || !enc || !this.asc) return null
    const winStart = Math.max(0, Math.min(startSec, Math.max(0, this.totalSec - WINDOW_SEC)))
    const winLen = Math.min(WINDOW_SEC, this.totalSec - winStart)
    if (winLen <= 0) return null
    const sr = this.sampleRate
    const ch = this.channels
    const frameCount = Math.ceil(winLen * sr)
    const channelData = Array.from({ length: ch }, () => new Float32Array(frameCount))
    const decodeFrom = Math.max(0, winStart - PREROLL_SEC)
    const decodeTo = winStart + winLen

    await new Promise<void>((resolve, reject) => {
      let decoder: AudioDecoder
      try {
        decoder = new AudioDecoder({
          output: (ad) => {
            const base = Math.round((ad.timestamp / 1e6 - winStart) * sr)
            const n = ad.numberOfFrames
            // Clip [base, base+n) to the window and copy with a native memcpy (not a JS loop).
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
          error: (e) => reject(e),
        })
        decoder.configure({
          codec: this.codec,
          sampleRate: sr,
          numberOfChannels: ch,
          description: this.asc!,
        })
        for (const f of enc) {
          if (f.endSec <= decodeFrom || f.startSec >= decodeTo) continue
          decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: f.timestampUs, duration: f.durationUs, data: f.data }))
        }
        decoder
          .flush()
          .then(() => {
            decoder.close()
            resolve()
          })
          .catch(reject)
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })

    if (this.desiredUrl !== this.demuxedUrl) return null
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
    this.startOffset = this.positionSec(ctxNow)
    this.startCtxTime = ctxNow
    this.rate = rate
    this.src.playbackRate.value = rate
  }

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
    if (L == null && this.measuredLatencySec < 0.02) L = FALLBACK_LATENCY_SEC
    if (L == null) return
    L = Math.min(MAX_LATENCY_SEC, Math.max(0, L))
    this.measuredLatencySec = this.measuredLatencySec
      ? this.measuredLatencySec * (1 - LATENCY_EMA_ALPHA) + L * LATENCY_EMA_ALPHA
      : L
  }

  get autoLatencyMs(): number {
    return this.measuredLatencySec * 1000
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
      const aim = (((targetSec + this.measuredLatencySec) % total) + total) % total
      return { mode: 'locked', driftMs: signedDrift(pos, aim, total) * 1000, rate: 1 }
    }
    if (!this.ctx || !this.encoded || this.totalSec <= 0) {
      if (this.desiredUrl) this.setSource(this.desiredUrl)
      return { mode: 'idle', driftMs: 0, rate: 1 }
    }
    if (targetSec == null || !playing) {
      this.stopSource()
      return { mode: 'idle', driftMs: 0, rate: 1 }
    }

    this.resume()
    this.sampleOutputLatency()
    const total = this.totalSec
    const ctxNow = this.ctx.currentTime
    const aim = (((targetSec + this.measuredLatencySec) % total) + total) % total

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
      this.stopSource()
      return { mode: 'syncing', driftMs: 0, rate: 1 }
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
      this.setRate(1, ctxNow)
      return {
        mode: (Math.abs(rawDrift) < LOCKED_SEC ? 'locked' : 'nudge') as CorrectionMode,
        driftMs: rawDrift * 1000,
        rate: 1,
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
   * window alone already buys up to WINDOW_SEC. On return, exitBackground() tears it down.
   */
  enterBackground(lookaheadSec = 180): void {
    if (this.backgrounded || !this.ctx || !this.src || !this.srcWindow) return
    this.backgrounded = true
    // Android/desktop play through the speakers in the foreground; route to the keep-alive sink
    // now so audio survives the lock (iOS is always on the sink already).
    if (!IS_IOS && !this.usingSink) this.connectOutput(true)
    const ctxNow = this.ctx.currentTime
    this.setRate(1, ctxNow) // rate 1 makes the chain's start times exact and gapless
    void this.buildChain(this.srcWindow.startSec + this.srcWindow.buffer.duration, ctxNow + lookaheadSec)
  }

  private async buildChain(fromTrackSec: number, untilCtxTime: number): Promise<void> {
    let trackCursor = fromTrackSec
    // Context time the currently-playing source reaches `fromTrackSec` (its buffer end), at rate 1.
    let ctxCursor = this.startCtxTime + (fromTrackSec - this.startOffset)
    while (this.backgrounded && ctxCursor < untilCtxTime && trackCursor < this.totalSec - 0.05) {
      const w = await this.decodeWindow(trackCursor)
      if (!w || !this.backgrounded || !this.ctx || this.desiredUrl !== this.demuxedUrl) break
      const offset = Math.max(0, trackCursor - w.startSec)
      const playSec = w.buffer.duration - offset
      if (playSec <= 0) break
      const src = this.ctx.createBufferSource()
      src.buffer = w.buffer
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
      ctxCursor += playSec
    }
  }

  exitBackground(): void {
    if (!this.backgrounded) return
    this.backgrounded = false
    for (const s of this.chained) {
      try {
        s.stop()
        s.disconnect()
      } catch {
        /* already stopped */
      }
    }
    this.chained = []
    // Back to the speakers for clean foreground output (iOS stays on the sink).
    if (!IS_IOS && this.usingSink) this.connectOutput(false)
    // The controller resyncs on return, which cold-restarts the primary source and re-locks.
  }

  resync(): void {
    if (this.backgrounded) return // don't disturb the free-run chain while locked
    this.smoothedDriftSec = 0
    this.lastRestartAt = 0
    this.stopSource() // next correct() cold-starts at the live target (silent until re-lock)
  }

  stop(): void {
    this.hardStopped = true
    this.exitBackground()
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
