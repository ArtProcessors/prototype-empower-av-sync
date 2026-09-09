import type { ReactNode } from 'react'

import { joinUrl } from '../../core/join-link'
import { classNames } from '../class-names'
import { driftClassName, formatSignedDrift } from '../drift'
import { appLocation } from '../launch-intent'
import { withUiMode } from '../ui-mode'
import styles from './debug.module.css'
import type { ViewProps } from '../view-props'

type RowProps = {
  /** What the reading is called; the left column. */
  label: string
  /** The reading itself. */
  value: ReactNode
}

function DebugRow({ label, value }: RowProps) {
  return (
    <div className={styles.row}>
      <span className={styles.rowKey}>{label}</span>
      <span className={styles.rowValue}>{value}</span>
    </div>
  )
}

/**
 * The instrument for this exploration: live drift, clock offset, RTT and
 * correction mode.
 *
 * Takes the whole snapshot rather than a narrowed transport, because the
 * overlay it lives in is up before anything is joined — a page sitting on the
 * start button still has a phase, a selected video and a keep-awake state
 * worth reading, and a row that has nothing to say is better than a panel that
 * is not there.
 */
export function DebugPanel({ state }: ViewProps) {
  const { correction, audio, transport } = state
  const mediaId =
    transport === null || transport.role === 'screen'
      ? state.media.selectedId
      : (transport.latestBeat?.mediaId ?? '—')
  // A follower whose screen has not been heard from, or whose soundtrack is
  // still downloading, has a `driftMs` of 0 — and 0 is what a perfectly synced
  // listener reads, in the same green. The rows below still carry every raw
  // value; this is the one place where a number that means nothing yet would
  // be read from across a room as one that does.
  const hasReading =
    transport?.role === 'follower' &&
    transport.screenOnline &&
    correction.mode !== 'syncing'

  return (
    <>
      {hasReading && (
        // The one number worth reading at arm's length: with the demo's ring
        // saying only whether this is working, this is where "how well" lives.
        <div
          className={classNames(
            styles.drift,
            driftClassName(correction.driftMs),
          )}
        >
          <span className={styles.driftNumber}>
            {formatSignedDrift(correction.driftMs)}
          </span>
          <span className={styles.driftUnit}>ms</span>
        </div>
      )}

      <section className={styles.section}>
        <h3 className={styles.sectionName}>Sync state</h3>

        <DebugRow label="phase" value={<code>{state.phase}</code>} />
        <DebugRow
          label="role"
          value={<b>{transport ? transport.role : '—'}</b>}
        />
        <DebugRow
          label="room"
          value={transport ? <code>{transport.roomCode}</code> : '—'}
        />
        <DebugRow
          label="my id"
          value={transport ? <code>{transport.selfId.slice(0, 6)}</code> : '—'}
        />
        <DebugRow
          label="peers"
          value={transport ? String(transport.peerCount) : '—'}
        />
        <DebugRow
          label="signalling"
          value={
            transport
              ? transport.signallingOnline
                ? '🟢 online'
                : '🔴 reconnecting'
              : '—'
          }
        />
        <DebugRow label="media" value={<code>{mediaId}</code>} />
        <DebugRow
          label="keep awake"
          value={
            state.keepAwake.supported
              ? state.keepAwake.held
                ? '🔒 held'
                : state.keepAwake.enabled
                  ? 'enabled (not held)'
                  : 'off'
              : 'unsupported'
          }
        />

        {transport?.role === 'screen' && (
          // The link the QR encodes, in text: a display with no camera
          // pointed at it is still joinable if the URL can be read off it.
          <DebugRow
            label="join url"
            value={
              <code className={styles.url}>
                {withUiMode(
                  joinUrl(transport.roomCode, appLocation()),
                  'debug',
                )}
              </code>
            }
          />
        )}

        {transport?.role === 'follower' && (
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
            <DebugRow
              label="playbackRate"
              value={correction.rate.toFixed(3)}
            />
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
    </>
  )
}
