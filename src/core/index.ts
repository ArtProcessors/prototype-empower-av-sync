/**
 * The headless A/V sync core: everything a UI needs, and nothing that assumes
 * what that UI is.
 *
 * A host supplies a media catalogue, calls {@link createSyncSession}, binds to
 * the snapshot, and renders. `src/ui` is one such host; there is nothing in
 * here that makes it the only possible one.
 *
 * What is deliberately NOT abstracted, on a prototype this size: `AudioContext`,
 * WebCodecs, `RTCPeerConnection`, `fetch` and timers. A non-browser host swaps
 * a `FollowerAudioEngine` or a {@link ScreenVideoOutput}, not an AudioContext
 * factory. The seams that do exist are the ones a second UI actually hits.
 */

// The session itself.
export {
  createSyncSession,
  type SyncSession,
  type SyncSessionOptions,
} from './session'
export type {
  AudioOutputState,
  MediaSelectionState,
  SessionPhase,
  SyncSessionState,
} from './session-state'

// What a session plays.
export {
  isKnownMedia,
  mediaById,
  type MediaCatalogue,
  type MediaOption,
} from './media-catalogue'

// Where the screen's video goes.
export {
  createDomScreenVideo,
  SCREEN_VIDEO_CLASS,
  type DomScreenVideoOptions,
  type DomScreenVideoOutput,
  type ScreenVideoOutput,
} from './screen-output'

// Policy: timings, room-code rules, storage keys, drift bands.
export {
  configureSession,
  sessionConfig,
  type DriftBands,
  type RoomCodePolicy,
  type SessionConfig,
  type SessionConfigOverrides,
  type SessionStorageKeys,
  type SessionTiming,
} from './config'

// Room identity and the links that carry it.
export {
  isRoomCodeAcceptable,
  makeRoomCode,
  maxRoomCodeLength,
  normaliseRoomCode,
} from './room-code'
export { joinUrl, roomCodeFromSearch, ROOM_QUERY_PARAM } from './join-link'
export {
  clearRejoinRoom,
  readRejoinRoom,
  writeRejoinRoom,
} from './rejoin-memory'

// Readouts a UI presents but should not have to define.
export { driftBand, type DriftBand } from './drift'
export { reconnectCooldownMs, transportIsStale } from './reconnect-policy'

// The keep-awake controller, for a host that wants it outside a session.
export {
  createKeepAwakeController,
  isWakeLockSupported,
  type KeepAwakeController,
  type KeepAwakeState,
} from './keep-awake'

// Transport and correction types a UI renders directly.
export type { Role, SyncState } from '../transport/sync-controller'
export type {
  AudioEngineKind,
  CorrectionInfo,
  CorrectionMode,
  NowPlayingInfo,
} from '../media/audio-sync-controller'
export type { Beat } from '../sync/sync-math'

// The diagnostics log, which is already a framework-agnostic store.
export {
  clearDiagnostics,
  diagnosticEvents,
  formatDiagnostics,
  subscribeDiagnostics,
  type DiagnosticCategory,
  type DiagnosticEvent,
} from '../diagnostics/session-log'
export {
  summariseDiagnostics,
  type DiagnosticSummary,
} from '../diagnostics/summary'
