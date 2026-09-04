import { joinUrl } from '../../core/join-link'
import { QRCode } from '../QRCode'
import type { SessionViewProps } from '../view-props'

/**
 * Resolution the join QR is generated at.
 *
 * Deliberately far larger than it is ever displayed: CSS sizes the image to
 * the viewport, and rendering small then upscaling gives a soft code that
 * phones hunt for. Generating large and scaling down stays crisp at any size.
 */
const QR_RESOLUTION = 512

/**
 * The demo screen: the video, edge to edge, and the code to scan.
 *
 * Everything else is deliberately absent. This is the thing a room full of
 * people is looking at, so the only permanent overlay is the QR card; the
 * operator's controls sit in a corner at low opacity and come up on hover or
 * focus, reachable without ever being part of the picture.
 */
export function DemoScreenView({
  session,
  transport,
  mountScreenVideo,
}: SessionViewProps & {
  /** Ref callback that mounts the persistent screen video into a container. */
  mountScreenVideo: (container: HTMLElement | null) => void
}) {
  // No UI-mode marker: a demo screen's QR should send phones to the demo
  // follower, which is what a plain join link already does.
  const listenerUrl = joinUrl(transport.roomCode)

  return (
    <main className="demo demo-screen">
      {/* The persistent looping video is mounted here. */}
      <div className="demo-stage" ref={mountScreenVideo} />

      <div className="demo-qr">
        <QRCode value={listenerUrl} size={QR_RESOLUTION} />
        <p className="demo-qr-caption">Scan for audio</p>
        <p className="demo-qr-code">{transport.roomCode}</p>
      </div>

      {!transport.signallingOnline && (
        <p className="demo-screen-alert" role="status">
          Reconnecting — nobody new can join for a moment. Listeners already
          connected are unaffected.
        </p>
      )}

      <div className="demo-screen-controls">
        <span className="demo-room">{transport.peerCount} listening</span>

        <button
          className="demo-ghost"
          onClick={() => window.location.reload()}
        >
          Refresh
        </button>

        <button className="demo-ghost" onClick={() => session.leave()}>
          Stop
        </button>
      </div>
    </main>
  )
}
