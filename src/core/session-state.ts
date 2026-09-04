/**
 * The one snapshot a UI renders a session from.
 *
 * Everything here is a plain value, replaced wholesale on change, so a host
 * can bind to it with whatever its framework offers — `useSyncExternalStore`,
 * a signal, a store subscription, or a render loop that just reads it.
 */
import type { MediaOption } from './media-catalogue'
import type {
  AudioEngineKind,
  CorrectionInfo,
} from '../media/audio-sync-controller'
import type { SyncState } from '../transport/sync-controller'
import type { KeepAwakeState } from './keep-awake'

/** Where the session is in the join/lead flow. */
export type SessionPhase = 'landing' | 'connecting' | 'active'

/** How a follower's audio output is wired right now. */
export interface AudioOutputState {
  /** Audio routed through Web Audio, so it ignores the iOS mute switch. */
  routed: boolean
  /** Auto-measured output latency being compensated for, in ms. */
  autoLatencyMs: number
  /** Whether the lock-screen keep-alive sink is active. */
  backgroundKeepAlive: boolean
  /** Which follower output path is live. */
  engine: AudioEngineKind
}

/** Which video the screen leads with. */
export interface MediaSelectionState {
  /** Videos the screen can lead with, in picker order. */
  options: readonly MediaOption[]
  /** Id of the currently selected video. */
  selectedId: string
  /** The selected option itself. */
  selected: MediaOption
}

/** Everything a UI needs to render a session. */
export interface SyncSessionState {
  /** Where the session is in the join/lead flow. */
  phase: SessionPhase
  /** Last error raised while becoming the screen or joining, if any. */
  error: string | null
  /**
   * Live transport state, or `null` before a session starts. Nullable rather
   * than an idle placeholder: "there is no session" is a distinct thing for a
   * host to route on, and an idle snapshot would blur it.
   */
  transport: SyncState | null
  /** Follower: how the audio is currently being corrected. */
  correction: CorrectionInfo
  /** Follower: local audio position, in seconds. */
  localTime: number
  /** Follower: the screen's extrapolated position, in seconds. */
  targetTime: number | null
  /** Follower: how the audio output is wired right now. */
  audio: AudioOutputState
  /** Screen: which video is being led with. */
  media: MediaSelectionState
  /** Keep-awake preference and the wake lock's status. */
  keepAwake: KeepAwakeState
}
