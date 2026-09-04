import type { DemoStatus } from './demo-status'

/**
 * The listener's whole instrument panel: one coloured ring and one sentence.
 *
 * The ring is decorative — its colour, spinner and glyph are CSS driven off
 * `data-tone`, and it is hidden from assistive tech because the text beside it
 * already says everything it does. That text is a live region, so a change
 * from "Loading audio…" to "In sync" is announced without stealing focus from
 * whatever the listener is doing.
 */
export function DemoStatusDisplay({ status }: { status: DemoStatus }) {
  return (
    <div className="demo-status">
      <div
        className="demo-indicator"
        data-tone={status.tone}
        aria-hidden="true"
      />
      <div className="demo-status-text" role="status" aria-live="polite">
        <p className="demo-headline">{status.headline}</p>
        {status.detail && <p className="demo-detail">{status.detail}</p>}
      </div>
    </div>
  )
}
