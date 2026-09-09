import { joinUrl } from '../../core/join-link'
import { classNames } from '../class-names'
import { currentLaunchIntent } from '../launch-intent'
import { QRCode } from '../QRCode'
import { withUiMode } from '../ui-mode'
import type { SessionViewProps } from '../view-props'
import demo from './demo.module.css'
import styles from './DemoScreenView.module.css'

/**
 * The mode a scanned join link should open in.
 *
 * A phone scanning a screen that is being debugged wants the same instruments
 * the screen has, so the marker is carried through the QR — see
 * {@link withUiMode}, which adds nothing at all in the ordinary case. Read at
 * module scope from the same frozen launch intent everything else uses, so the
 * code in the QR cannot change under a phone that is part-way through reading
 * it.
 */
const UI_MODE = currentLaunchIntent().ui

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
 * people is looking at, so the only permanent overlay is the QR card, and the
 * only other one is the alert that says nobody new can join. Whoever set the
 * display up has the URL and a reload; anything more than that belongs to
 * `?debug=1`, which puts its instruments over this view rather than in it.
 */
export function DemoScreenView({ transport, mountScreenVideo }: Props) {
  const listenerUrl = withUiMode(joinUrl(transport.roomCode), UI_MODE)

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
