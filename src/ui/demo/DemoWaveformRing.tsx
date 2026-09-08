import { useEffect, useRef, useState } from 'react'

import type { AudioWaveform } from '../../media/audio-waveform'

/**
 * Points around the ring. Half are measured and half are mirrored, so the
 * shape closes on itself instead of showing a seam where the buffer ends.
 */
const POINTS = 96

/**
 * Samples pulled per frame.
 *
 * A short slice on purpose: the analyser's window is 2048 samples, some 45 ms,
 * long enough to hold twenty cycles of a mid-range note — plotted round a
 * circle that reads as noise. A few milliseconds is a couple of cycles, which
 * is what actually looks like a wave.
 */
const SAMPLES = 512

/**
 * How far a point travels toward its new sample each frame, 0..1.
 *
 * Responsive on purpose. The wave is signed, and a slow follower would average
 * successive frames toward zero and flatten the ring on exactly the busy
 * material that should move it most — smoothing a waveform is smoothing it
 * away. This is just enough to take the hard edge off 60 Hz shimmer.
 */
const SMOOTHING = 0.5

/** How fast the ring's overall size follows loudness, 0..1. Slow: it breathes. */
const LOUDNESS_SMOOTHING = 0.12

/** Applied to samples, so ordinary material uses the full swing. */
const GAIN = 1.2

/**
 * Ring geometry, as fractions of the canvas's half-size.
 *
 * `REST + BREATH + SWING` stays under 1 so the loudest peak still clears the
 * stroke, and `REST + BREATH` lands near where the static tones draw their
 * border — so the indicator does not appear to change size when the status
 * moves from "loading" to "in sync".
 */
const REST_RADIUS = 0.7
const BREATH = 0.08
const SWING = 0.16
const STROKE = 0.035

/** Alpha of the resting circle drawn under the wave. */
const REST_ALPHA = 0.22

/** Whether the viewer has asked for less animation. */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReduced(query.matches)

    query.addEventListener('change', update)

    return () => query.removeEventListener('change', update)
  }, [])

  return reduced
}

/**
 * Draw the ring for one frame.
 *
 * Two readings, not one: the wave sets the ring's *shape*, deflecting in and
 * out about its resting circle, and smoothed loudness sets its *size*, so the
 * whole ring swells on a loud passage and settles on a quiet one.
 *
 * The outline is stroked twice — wide and faint, then narrow and solid — which
 * reads as a glow for a fraction of what `shadowBlur` costs per frame on a
 * phone. Points are joined with quadratic curves through their midpoints, the
 * cheap way to get a smooth closed loop out of a modest number of samples.
 *
 * @param context the ring's canvas
 * @param size the canvas's device-pixel width, which is also its height
 * @param levels signed deflection per point, -1..1
 * @param loudness smoothed output level, 0..1
 * @param colour stroke colour, taken from the tone's CSS
 */
function paint(
  context: CanvasRenderingContext2D,
  size: number,
  levels: Float32Array,
  loudness: number,
  colour: string,
) {
  const centre = size / 2
  const rest = centre * (REST_RADIUS + loudness * BREATH)
  const swing = centre * SWING

  context.clearRect(0, 0, size, size)
  context.strokeStyle = colour
  context.lineJoin = 'round'

  // The circle the wave sits on, so the ring still reads as a ring in silence.
  context.globalAlpha = REST_ALPHA
  context.lineWidth = centre * STROKE
  context.beginPath()
  context.arc(centre, centre, rest, 0, Math.PI * 2)
  context.stroke()

  const pointAt = (index: number) => {
    const angle = (index / POINTS) * Math.PI * 2 - Math.PI / 2
    const radius = rest + levels[index % POINTS] * swing

    return {
      x: centre + Math.cos(angle) * radius,
      y: centre + Math.sin(angle) * radius,
    }
  }

  context.beginPath()

  const first = pointAt(0)
  const last = pointAt(POINTS - 1)

  context.moveTo((last.x + first.x) / 2, (last.y + first.y) / 2)

  for (let index = 0; index < POINTS; index += 1) {
    const current = pointAt(index)
    const next = pointAt(index + 1)

    context.quadraticCurveTo(
      current.x,
      current.y,
      (current.x + next.x) / 2,
      (current.y + next.y) / 2,
    )
  }

  context.closePath()

  context.globalAlpha = 0.28
  context.lineWidth = centre * STROKE * 3.5
  context.stroke()

  context.globalAlpha = 1
  context.lineWidth = centre * STROKE
  context.stroke()
}

type Props = {
  /** Live samples of this device's audio output. */
  waveform: AudioWaveform
  /** Class positioning and sizing the canvas, from the containing indicator. */
  className: string
}

/**
 * The listener's "in sync" ring: a circle deflected by the audio actually
 * coming out of this device.
 *
 * It reads the session's waveform in its own animation loop rather than
 * through React — see {@link AudioWaveform} — so a redraw at display rate
 * never touches the component tree. `requestAnimationFrame` stops while the
 * page is hidden, which is exactly when a phone in a pocket should not be
 * drawing.
 *
 * Renders nothing when the viewer has asked for reduced motion; the status
 * display falls back to its still check mark. It also survives having nothing
 * to read — an iOS `<audio>` fallback has no graph to tap — by resting at the
 * base circle, which looks deliberate rather than broken.
 *
 * Carries no styling of its own: where the canvas sits, how large it is and
 * what colour it inherits are the indicator's decisions, so the class comes in
 * from `DemoStatusDisplay.module.css`.
 */
export function DemoWaveformRing({ waveform, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const reducedMotion = useReducedMotion()

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')

    if (!canvas || !context) {
      return
    }

    const samples = new Float32Array(SAMPLES)
    const levels = new Float32Array(POINTS)
    // Inclusive of both ends of the arc: point 0 (top) and point POINTS/2
    // (bottom) sit *on* the mirror axis and are their own reflections, so
    // measuring only POINTS/2 of them would leave the bottom point never
    // written — a permanent notch — and put the axis half a point off vertical.
    const measured = POINTS / 2 + 1
    const perPoint = Math.floor(SAMPLES / measured)

    let loudness = 0

    let frame = 0
    // Read from CSS so the ring is whatever colour the tone is, and re-read on
    // resize rather than per frame: a computed-style read is not free, and the
    // colour cannot change while this is mounted (only the `good` tone draws).
    let colour = getComputedStyle(canvas).color

    const resize = () => {
      const ratio = window.devicePixelRatio || 1
      const size = Math.round(canvas.clientWidth * ratio)

      if (size > 0 && canvas.width !== size) {
        canvas.width = size
        canvas.height = size
      }

      colour = getComputedStyle(canvas).color
    }

    const observer = new ResizeObserver(resize)

    observer.observe(canvas)
    resize()

    const draw = () => {
      frame = requestAnimationFrame(draw)

      const live = waveform.read(samples)
      let energy = 0

      for (let point = 0; point < measured; point += 1) {
        // One sample per point, signed: at this window length that is not a
        // summary of the wave, it *is* the wave, plotted round a circle. One
        // side is measured and the other mirrors it about the vertical, which
        // both closes the shape and makes it read as a form rather than a scan.
        const sample = live ? samples[point * perPoint] : 0
        const target = Math.max(-1, Math.min(1, sample * GAIN))
        const next = levels[point] + (target - levels[point]) * SMOOTHING

        levels[point] = next
        energy += sample * sample

        if (point > 0 && point < POINTS / 2) {
          levels[POINTS - point] = next
        }
      }

      const rms = Math.min(1, Math.sqrt(energy / measured) * GAIN)

      loudness += (rms - loudness) * LOUDNESS_SMOOTHING

      paint(context, canvas.width, levels, loudness, colour)
    }

    frame = requestAnimationFrame(draw)

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
    // `reducedMotion` is a dependency because it decides whether the canvas is
    // in the tree at all: without it, a viewer turning the preference off mid
    // session would get a canvas that never starts drawing.
  }, [waveform, reducedMotion])

  if (reducedMotion) {
    return null
  }

  return <canvas ref={canvasRef} className={className} />
}
