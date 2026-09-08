import type { AudioWaveform } from '../../media/audio-waveform'
import type { DemoStatus } from './demo-status'
import { DemoWaveformRing } from './DemoWaveformRing'
import styles from './DemoStatusDisplay.module.css'

type Props = {
  /** What to say, and how it should read. */
  status: DemoStatus
  /** Live samples of this device's audio output, for the `good` state's ring. */
  waveform: AudioWaveform
}

/**
 * The listener's whole instrument panel: one ring and one sentence.
 *
 * Once the audio is locked, the ring stops being a symbol and becomes a
 * reading — it is deflected by the samples actually leaving this device, so a
 * listener can see their own audio moving. That is a better answer to "is this
 * working?" than a check mark, which looks identical whether or not any sound
 * is coming out. Every other state keeps the static ring: nothing is playing
 * yet, so there is nothing honest to draw.
 *
 * The ring is decorative either way, and hidden from assistive tech, because
 * the live region beside it already says everything it does.
 */
export function DemoStatusDisplay({ status, waveform }: Props) {
  return (
    <div className={styles.status}>
      <div
        className={styles.indicator}
        data-tone={status.tone}
        aria-hidden="true"
      >
        {status.tone === 'good' && (
          <DemoWaveformRing waveform={waveform} className={styles.ring} />
        )}
      </div>
      <div role="status" aria-live="polite">
        <p className={styles.headline}>{status.headline}</p>
        {status.detail && <p className={styles.detail}>{status.detail}</p>}
      </div>
    </div>
  )
}
