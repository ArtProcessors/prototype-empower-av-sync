import type { CorrectionInfo } from '../../media/audio-sync-controller'
import { classNames } from '../class-names'
import { driftClassName, formatSignedDrift } from '../drift'
import styles from './debug.module.css'

type Props = {
  /** Whether beats are still arriving from the screen. */
  screenOnline: boolean
  /** How the audio is currently being corrected. */
  correction: CorrectionInfo
}

/**
 * What a listener is shown in place of the drift readout while there is
 * nothing to read yet: waiting for the screen, then loading the soundtrack,
 * then the live number.
 */
export function FollowerStatus({ screenOnline, correction }: Props) {
  if (!screenOnline) {
    return (
      <div className={styles.connecting}>
        Waiting for the screen… (no sync beats yet)
      </div>
    )
  }

  if (correction.mode === 'syncing') {
    return (
      <div className={styles.connecting}>
        Syncing audio… (downloading the soundtrack)
      </div>
    )
  }

  return (
    <div
      className={classNames(
        styles.driftHero,
        driftClassName(correction.driftMs),
      )}
    >
      <div className={styles.driftNumber}>
        {formatSignedDrift(correction.driftMs)}
        <span className={styles.driftUnit}> ms</span>
      </div>
      <div className={classNames(styles.muted, styles.small)}>
        {correction.mode} · rate {correction.rate.toFixed(3)}
      </div>
    </div>
  )
}
