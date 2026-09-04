import type { ViewProps } from './view-props'

/**
 * Opt-in checkbox for the Screen Wake Lock. Renders nothing on browsers
 * without the API.
 */
export function KeepAwakeOption({ state, session }: ViewProps) {
  const { enabled, supported, held } = state.keepAwake

  if (!supported) {
    return null
  }

  return (
    <label className="check">
      <input
        type="checkbox"
        checked={enabled}
        onChange={event => session.setKeepAwake(event.target.checked)}
      />
      <span>
        Keep screen awake
        {held && <span className="muted"> (active)</span>}
      </span>
    </label>
  )
}
