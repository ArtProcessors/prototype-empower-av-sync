import type { ReactNode } from 'react'

import type { SyncApi } from '../hooks/useSync'
import { driftClassName } from './drift'

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
export function DebugPanel({ api }: { api: SyncApi }) {
  const syncState = api.state

  if (!syncState) {
    return null
  }

  const { correction } = api
  const mediaId =
    syncState.role === 'screen'
      ? api.videoId
      : (syncState.latestBeat?.mediaId ?? '—')

  return (
    <section className="debug">
      <h2>Debug — sync state</h2>
      <DebugRow label="role" value={<b>{syncState.role}</b>} />
      <DebugRow label="room" value={<code>{syncState.roomCode}</code>} />
      <DebugRow
        label="my id"
        value={<code>{syncState.selfId.slice(0, 6)}</code>}
      />
      <DebugRow label="peers" value={String(syncState.peerCount)} />
      <DebugRow label="media" value={<code>{mediaId}</code>} />

      {syncState.role === 'follower' && (
        <>
          <DebugRow
            label="screen id"
            value={
              <code>
                {syncState.screenId ? syncState.screenId.slice(0, 6) : '—'}
              </code>
            }
          />
          <DebugRow
            label="screen"
            value={syncState.screenOnline ? '🟢 online' : '🔴 offline'}
          />
          <DebugRow
            label="clock offset"
            value={`${syncState.offsetMs.toFixed(0)} ms`}
          />
          <DebugRow label="rtt" value={`${syncState.rttMs.toFixed(0)} ms`} />
          <DebugRow
            label="drift"
            value={
              <b className={driftClassName(correction.driftMs)}>
                {correction.driftMs >= 0 ? '+' : ''}
                {correction.driftMs.toFixed(0)} ms
              </b>
            }
          />
          <DebugRow label="mode" value={<code>{correction.mode}</code>} />
          <DebugRow label="playbackRate" value={correction.rate.toFixed(3)} />
          <DebugRow
            label="audio out"
            value={
              api.audioRouted ? 'web-audio (mute-switch safe)' : 'element'
            }
          />
          <DebugRow label="engine" value={<code>{api.audioEngine}</code>} />
          {api.audioBgKeepAlive && (
            <DebugRow
              label="bg keep-alive"
              value="🔒 stream sink (locks OK)"
            />
          )}
          <DebugRow
            label="latency comp"
            value={`auto ${api.audioAutoLatencyMs.toFixed(0)} ms`}
          />
          <DebugRow
            label="local / target"
            value={
              <code>
                {api.localTime.toFixed(2)}s /{' '}
                {api.targetTime != null
                  ? `${api.targetTime.toFixed(2)}s`
                  : '—'}
              </code>
            }
          />
        </>
      )}
    </section>
  )
}
