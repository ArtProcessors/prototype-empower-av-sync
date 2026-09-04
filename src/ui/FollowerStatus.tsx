import type { CorrectionInfo } from '../media/audio-sync-controller'
import { driftClassName, formatSignedDrift } from './drift'

/**
 * What a listener is shown in place of the drift readout while there is
 * nothing to read yet: waiting for the screen, then loading the soundtrack,
 * then the live number.
 */
export function FollowerStatus({
  screenOnline,
  correction,
}: {
  /** Whether beats are still arriving from the screen. */
  screenOnline: boolean
  /** How the audio is currently being corrected. */
  correction: CorrectionInfo
}) {
  if (!screenOnline) {
    return (
      <div className="connecting">
        Waiting for the screen… (no sync beats yet)
      </div>
    )
  }

  if (correction.mode === 'syncing') {
    return (
      <div className="connecting">
        Syncing audio… (downloading the soundtrack)
      </div>
    )
  }

  return (
    <div className={`drift-hero ${driftClassName(correction.driftMs)}`}>
      <div className="drift-num">
        {formatSignedDrift(correction.driftMs)}
        <span className="drift-unit"> ms</span>
      </div>
      <div className="muted small">
        {correction.mode} · rate {correction.rate.toFixed(3)}
      </div>
    </div>
  )
}
