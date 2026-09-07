/**
 * A live read of what a follower is actually playing, for a host that wants to
 * draw it.
 *
 * Pull-based, deliberately. Audio moves at 48 kHz and a visualiser redraws at
 * the display's refresh rate; neither belongs in the session snapshot, which
 * exists to be diffed and re-rendered. So this is a stable handle a host reads
 * from inside its own animation loop, and the session never emits because of
 * it.
 *
 * It attaches to whichever node the live output path passes through, and
 * re-attaches on its own when that path changes — a follower can start on the
 * `<audio>` element, move to a decoded buffer, then to the streaming engine,
 * all within the first few seconds of a join.
 */

/** Samples the analyser's window holds. */
const FFT_SIZE = 2048

/** Resolves the node the audio currently passes through, or `null` if none. */
export type WaveformTap = () => AudioNode | null

/** A pull-based read of the follower's audio output. */
export interface AudioWaveform {
  /**
   * Length of the analyser's window. A shorter array passed to
   * {@link AudioWaveform.read} is filled from the start of that window, which
   * is both cheaper and a tighter — so better looking — slice of the wave.
   */
  readonly windowSize: number
  /**
   * Fill `into` with the most recent time-domain samples, nominally -1..1.
   *
   * Returns `false` and leaves `into` untouched when there is nothing to
   * read: before the audio graph is built, or on an output path that never
   * goes through Web Audio at all (an iOS `<audio>` fallback plays straight
   * out of the element, where there is no graph to tap).
   */
  read(into: Float32Array): boolean
  /** Detach the analyser and drop its connections. */
  dispose(): void
}

/**
 * Build a waveform reader over `tap`.
 *
 * Nothing is created until the first {@link AudioWaveform.read} — a UI that
 * never draws the audio costs a closure.
 *
 * @param tap resolves the node the audio currently passes through
 */
export function createAudioWaveform(tap: WaveformTap): AudioWaveform {
  let analyser: AnalyserNode | null = null
  let silence: GainNode | null = null
  let tapped: AudioNode | null = null

  const detach = () => {
    // Only ever the one connection we made: a bare `tapped.disconnect()`
    // would cut the master gain off from the speakers and the keep-alive sink
    // with it, which is the whole session's audio.
    if (tapped && analyser) {
      tapped.disconnect(analyser)
    }

    analyser?.disconnect()
    silence?.disconnect()
    analyser = null
    silence = null
    tapped = null
  }

  const attach = (node: AudioNode) => {
    const context = node.context

    analyser = context.createAnalyser()
    analyser.fftSize = FFT_SIZE

    // Chrome renders a dead-end analyser (it keeps an automatic-pull list for
    // exactly this), but the spec's rendering rules only promise to process
    // what reaches a destination — so it gets one, at zero gain. Silent by
    // construction, and it cannot affect the timing of the legs that matter:
    // this hangs off the master gain rather than sitting in the path
    // everything already flows through.
    silence = context.createGain()
    silence.gain.value = 0

    node.connect(analyser)
    analyser.connect(silence)
    silence.connect(context.destination)

    tapped = node
  }

  return {
    windowSize: FFT_SIZE,

    read(into) {
      const node = tap()

      if (!node) {
        detach()

        return false
      }

      if (node !== tapped) {
        detach()
        attach(node)
      }

      // `getFloatTimeDomainData` insists on a view over a plain ArrayBuffer;
      // the public parameter stays the broader `Float32Array` so callers can
      // pass one straight from `new Float32Array(n)` without the generic.
      analyser!.getFloatTimeDomainData(into as Float32Array<ArrayBuffer>)

      return true
    },

    dispose: detach,
  }
}
