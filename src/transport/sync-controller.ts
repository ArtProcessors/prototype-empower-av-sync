/**
 * Transport binding for the A/V sync spike (a simpler sibling of the gallery's
 * session-controller: fixed leader, no epoch/migration/gossip — a star around
 * the screen).
 *
 *  - SCREEN broadcasts a `beat` (video position + screen wall-clock) ~4×/sec,
 *    and answers a `clk` RPC with its current `Date.now()` so followers can
 *    estimate the clock offset.
 *  - FOLLOWER stores the latest beat and periodically samples the clock offset
 *    (Cristian's algorithm, keeping the lowest-RTT sample). The actual audio
 *    correction lives in the media layer, driven from this controller's state.
 */
import type { Room } from 'trystero'

import {
  estimateOffset,
  bestOffset,
  type Beat,
  type ClockSample,
} from '../sync/sync-math'
import {
  APP_ID,
  RTC_CONFIG,
  RELAY_URLS,
  STRATEGY,
  loadStrategy,
} from './config'

/** Which end of the star topology this device is. */
export type Role = 'screen' | 'follower'

const BEAT_MS = 250 // screen broadcasts 4×/sec
const CLOCK_INTERVAL_MS = 3000 // follower re-samples clock offset every 3s
const CLOCK_TIMEOUT_MS = 2000
const CLOCK_WINDOW = 8 // rolling clock-sample window
const FIRST_CLOCK_SAMPLE_MS = 800 // first sample, once beats should have landed
const SCREEN_STALE_MS = 3000 // no beat for this long → screen considered offline
const RESYNC_GAP_MS = 4000 // beat gap longer than this ⇒ treat as reconnect / wake

/** Everything the UI and the media layer need to know about the session. */
export interface SyncState {
  /** Which end of the star topology this device is. */
  role: Role
  /** Room code peers meet in. */
  roomCode: string
  /** This device's Trystero peer id. */
  selfId: string
  /** Peer id of the screen, or `null` before the first beat arrives. */
  screenId: string | null
  /** Add to a follower `Date.now()` to get the screen's clock, in ms. */
  offsetMs: number
  /** Round-trip time of the clock sample currently in use, in ms. */
  rttMs: number
  /** Most recent beat received from the screen. */
  latestBeat: Beat | null
  /** Follower-clock ms at which the last beat arrived (0 = none yet). */
  lastBeatAt: number
  /** How many other peers are connected. */
  peerCount: number
  /** Whether beats are still arriving from the screen. */
  screenOnline: boolean
  /** Follower: true once a fresh clock offset sample is available. */
  clockReady: boolean
  /** Bumps on reconnect / resume — followers should resync their audio. */
  syncEpoch: number
}

/** Notified after every state change; read the new state via `getState()`. */
type Listener = () => void

/** Supplies the screen's live playback position for the next beat. */
type BeatSource = () => {
  /** Id of the video the screen is playing. */
  mediaId: string
  /** The screen's `video.currentTime`, in seconds. */
  videoTime: number
  /** Whether the video is playing rather than paused. */
  playing: boolean
  /** The video's duration (loop length), in seconds. */
  duration: number
}

/** A joined session: a snapshot store plus the room's lifecycle. */
export interface SyncController {
  /** Which end of the star topology this device is. */
  readonly role: Role
  /** Room code peers meet in. */
  readonly roomCode: string
  /** This device's Trystero peer id. */
  readonly selfId: string
  /** Current session state. */
  getState(): SyncState
  /** Subscribe to state changes; call the returned function to unsubscribe. */
  subscribe(listener: Listener): () => void
  /** Screen only: supply the playback position broadcast on each beat. */
  setBeatSource(source: BeatSource): void
  /** Stop all timers and leave the room. */
  leave(): Promise<void>
}

/** Join `roomCode` as the leader, broadcasting beats for followers to lock to. */
export async function startScreen(roomCode: string): Promise<SyncController> {
  return create(roomCode, 'screen')
}

/** Join `roomCode` as a listener, tracking the screen's beats and clock. */
export async function joinAsFollower(
  roomCode: string,
): Promise<SyncController> {
  return create(roomCode, 'follower')
}

async function create(roomCode: string, role: Role): Promise<SyncController> {
  const { joinRoom, selfId } = await loadStrategy()

  const room: Room = joinRoom(
    {
      appId: APP_ID,
      password: roomCode,
      rtcConfig: RTC_CONFIG,
      ...(STRATEGY === 'nostr' && RELAY_URLS.length
        ? { relayConfig: { urls: RELAY_URLS } }
        : {}),
    },
    roomCode,
  )

  let state: SyncState = {
    role,
    roomCode,
    selfId,
    screenId: role === 'screen' ? selfId : null,
    offsetMs: 0,
    rttMs: 0,
    latestBeat: null,
    lastBeatAt: 0,
    peerCount: 0,
    screenOnline: role === 'screen',
    clockReady: role === 'screen',
    syncEpoch: 0,
  }

  const listeners = new Set<Listener>()
  const notify = () => listeners.forEach(listener => listener())

  const set = (patch: Partial<SyncState>) => {
    state = { ...state, ...patch }
    notify()
  }

  const refreshPeers = () =>
    set({ peerCount: Object.keys(room.getPeers()).length })

  room.onPeerJoin = () => refreshPeers()
  room.onPeerLeave = peerId => {
    if (peerId === state.screenId && role === 'follower') {
      set({ screenOnline: false })
    }

    refreshPeers()
  }

  // ── beat channel (screen → all) ──
  const beatAction = room.makeAction('beat')
  const sendBeat = beatAction.send as (beat: unknown) => Promise<void>

  // ── clock RPC (follower → screen) ──
  const clockAction = room.makeAction('clk', {
    kind: 'request',
    onRequest: () => Date.now(),
  })
  const requestScreenClock = (
    clockAction as unknown as {
      request: (
        payload: unknown,
        options: { target: string; timeoutMs?: number },
      ) => Promise<number>
    }
  ).request

  const timers: number[] = []
  let clockSamples: ClockSample[] = []
  let beatSource: BeatSource | null = null

  if (role === 'screen') {
    timers.push(
      setInterval(() => {
        if (!beatSource) {
          return
        }

        const position = beatSource()
        const beat: Beat = {
          mediaId: position.mediaId,
          videoTime: position.videoTime,
          wall: Date.now(),
          playing: position.playing,
          duration: position.duration,
        }

        sendBeat(beat)
      }, BEAT_MS) as unknown as number,
    )
  } else {
    const sampleClock = async () => {
      const screenId = state.screenId

      if (!screenId) {
        return
      }

      const requestedAt = Date.now()

      try {
        const screenTime = await requestScreenClock(
          {},
          { target: screenId, timeoutMs: CLOCK_TIMEOUT_MS },
        )
        const respondedAt = Date.now()

        clockSamples = [
          ...clockSamples,
          estimateOffset(requestedAt, screenTime, respondedAt),
        ].slice(-CLOCK_WINDOW)

        const best = bestOffset(clockSamples)!

        set({ offsetMs: best.offset, rttMs: best.rtt, clockReady: true })
      } catch {
        /* timed out — retry next tick */
      }
    }

    beatAction.onMessage = (data, context) => {
      const now = Date.now()
      const gap = state.lastBeatAt ? now - state.lastBeatAt : 0
      const needsResync = !state.screenOnline || gap > RESYNC_GAP_MS

      if (needsResync) {
        clockSamples = []
        set({ offsetMs: 0, rttMs: 0, clockReady: false })
        sampleClock()
      }

      set({
        latestBeat: data as unknown as Beat,
        lastBeatAt: now,
        screenId: context.peerId,
        screenOnline: true,
        ...(needsResync ? { syncEpoch: state.syncEpoch + 1 } : {}),
      })
    }

    timers.push(
      setInterval(() => {
        sampleClock()

        const beatAge = Date.now() - state.lastBeatAt

        if (
          state.lastBeatAt &&
          beatAge > SCREEN_STALE_MS &&
          state.screenOnline
        ) {
          clockSamples = []
          set({
            screenOnline: false,
            clockReady: false,
            offsetMs: 0,
            rttMs: 0,
          })
        }
      }, CLOCK_INTERVAL_MS) as unknown as number,
    )

    // Kick an early clock sample shortly after the first beats should have
    // arrived, rather than waiting a full interval.
    timers.push(
      setTimeout(sampleClock, FIRST_CLOCK_SAMPLE_MS) as unknown as number,
    )
  }

  refreshPeers()

  return {
    role,
    roomCode,
    selfId,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)

      return () => listeners.delete(listener)
    },
    setBeatSource(source) {
      beatSource = source
    },
    async leave() {
      // `timers` mixes interval and timeout handles; clearing both is cheap
      // and avoids tracking which is which.
      for (const timer of timers) {
        clearInterval(timer)
        clearTimeout(timer)
      }

      listeners.clear()
      await room.leave()
    },
  }
}
