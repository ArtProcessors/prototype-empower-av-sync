import type { SyncApi } from '../hooks/useSync'

/**
 * Opt-in checkbox for the Screen Wake Lock. Renders nothing on browsers
 * without the API.
 */
export function KeepAwakeOption({ api }: { api: SyncApi }) {
  if (!api.wakeLockSupported) {
    return null
  }

  return (
    <label className="check">
      <input
        type="checkbox"
        checked={api.keepAwake}
        onChange={event => api.setKeepAwake(event.target.checked)}
      />
      <span>
        Keep screen awake
        {api.wakeLockActive && <span className="muted"> (active)</span>}
      </span>
    </label>
  )
}
