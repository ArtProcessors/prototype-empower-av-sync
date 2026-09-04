import type { ReactNode } from 'react'

import { driftClassName, formatSignedDrift } from './drift'
import type { SessionViewProps } from './view-props'

function DebugRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="dbg-row">
      <span className="dbg-key">{label}</span>
      <span className="dbg-val">{value}</span>
    </div>
  )
}

/**
 * The instrument for this exploration: live drift, clock offset, RTT and
 * correction mode.
 */
export function DebugPanel({ state, transport }: SessionViewProps) {
  const { correction, audio } = state
  const mediaId =
    transport.role === 'screen'
      ? state.media.selectedId
      : (transport.latestBeat?.mediaId ?? '—')

  return (
    <section className="debug">
      <h2>Debug — sync state</h2>
      <DebugRow label="role" value={<b>{transport.role}</b>} />
      <DebugRow label="room" value={<code>{transport.roomCode}</code>} />
      <DebugRow
        label="my id"
        value={<code>{transport.selfId.slice(0, 6)}</code>}
      />
      <DebugRow label="peers" value={String(transport.peerCount)} />
      <DebugRow
        label="signalling"
        value={transport.signallingOnline ? '🟢 online' : '🔴 reconnecting'}
      />
      <DebugRow label="media" value={<code>{mediaId}</code>} />

      {transport.role === 'follower' && (
        <>
          <DebugRow
            label="screen id"
            value={
              <code>
                {transport.screenId ? transport.screenId.slice(0, 6) : '—'}
              </code>
            }
          />
          <DebugRow
            label="screen"
            value={transport.screenOnline ? '🟢 online' : '🔴 offline'}
          />
          <DebugRow
            label="clock offset"
            value={`${transport.offsetMs.toFixed(0)} ms`}
          />
          <DebugRow label="rtt" value={`${transport.rttMs.toFixed(0)} ms`} />
          <DebugRow
            label="drift"
            value={
              <b className={driftClassName(correction.driftMs)}>
                {formatSignedDrift(correction.driftMs)} ms
              </b>
            }
          />
          <DebugRow label="mode" value={<code>{correction.mode}</code>} />
          <DebugRow label="playbackRate" value={correction.rate.toFixed(3)} />
          <DebugRow
            label="audio out"
            value={audio.routed ? 'web-audio (mute-switch safe)' : 'element'}
          />
          <DebugRow label="engine" value={<code>{audio.engine}</code>} />
          {audio.backgroundKeepAlive && (
            <DebugRow
              label="bg keep-alive"
              value="🔒 stream sink (locks OK)"
            />
          )}
          <DebugRow
            label="latency comp"
            value={`auto ${audio.autoLatencyMs.toFixed(0)} ms`}
          />
          <DebugRow
            label="local / target"
            value={
              <code>
                {state.localTime.toFixed(2)}s /{' '}
                {state.targetTime != null
                  ? `${state.targetTime.toFixed(2)}s`
                  : '—'}
              </code>
            }
          />
        </>
      )}
    </section>
  )
}
