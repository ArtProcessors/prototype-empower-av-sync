import { joinUrl } from '../../core/join-link'
import { classNames } from '../class-names'
import { QRCode } from '../QRCode'
import type { SessionViewProps } from '../view-props'
import demo from './demo.module.css'
import styles from './DemoScreenView.module.css'

/**
 * Resolution the join QR is generated at.
 *
 * Deliberately far larger than it is ever displayed: CSS sizes the image to
 * the viewport, and rendering small then upscaling gives a soft code that
 * phones hunt for. Generating large and scaling down stays crisp at any size.
 */
const QR_RESOLUTION = 512

type Props = SessionViewProps & {
  /** Ref callback that mounts the persistent screen video into a container. */
  mountScreenVideo: (container: HTMLElement | null) => void
}

/**
 * The demo screen: the video, edge to edge, and the code to scan.
 *
 * Everything else is deliberately absent. This is the thing a room full of
 * people is looking at, so the only permanent overlay is the QR card; the
 * operator's controls sit in a corner at low opacity and come up on hover or
 * focus, reachable without ever being part of the picture.
 */
export function DemoScreenView({
  transport,
  mountScreenVideo,
}: Props) {
  // No UI-mode marker: a demo screen's QR should send phones to the demo
  // follower, which is what a plain join link already does.
  const listenerUrl = joinUrl(transport.roomCode)

  return (
    <main className={classNames(demo.shell, styles.screen)}>
      {/* The persistent looping video is mounted here. */}
      <div className={styles.stage} ref={mountScreenVideo} />

      <div className={styles.qr}>
        <QRCode value={listenerUrl} size={QR_RESOLUTION} />
        <p className={styles.qrCaption}>Scan for audio</p>
        <p className={styles.qrCode}>{transport.roomCode}</p>
      </div>

      {!transport.signallingOnline && (
        <p className={styles.alert} role="status">
          Reconnecting — nobody new can join for a moment. Listeners already
          connected are unaffected.
        </p>
      )}
    </main>
  )
}
