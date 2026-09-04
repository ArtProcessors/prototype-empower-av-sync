/**
 * A live A/V sync session, independent of any UI framework.
 *
 * This is the whole application, minus the pixels: it owns the screen's video
 * output, the follower's audio, the transport and its watchdog, the correction
 * loop, the wake lock, and the page-lifecycle handling that ties them
 * together. A host binds to {@link SyncSession.getState} and calls the actions;
 * nothing here knows what a component is.
 *
 * Two rules run through it, both learned the hard way:
 *
 *  - **The transport is read fresh, never captured.** A watchdog rejoin
 *    replaces it mid-session, and a timer holding the old one reads
 *    `screenOnline: false` off a dead room forever — which is a rejoin every
 *    cooldown, on a session that is actually healthy.
 *  - **Gestures are spent immediately.** `becomeScreen` plays the video and
 *    `join` unlocks the audio before anything that touches the network, because
 *    iOS grants autoplay to the call that happens inside the tap and to nothing
 *    after it.
 */
import { startLifecycleMonitoring } from '../diagnostics/lifecycle-monitor'
import { startReachabilityProbe } from '../diagnostics/reachability'
import { reportRelaySockets } from '../diagnostics/relay-sockets'
import { recordDiagnostic } from '../diagnostics/session-log'
import { preflightTurn } from '../diagnostics/turn-preflight'
import {
  AudioSyncController,
  type NowPlayingInfo,
} from '../media/audio-sync-controller'
import {
  joinAsFollower,
  startScreen,
  type SyncController,
} from '../transport/sync-controller'
import { startCorrectionLoop } from './correction-loop'
import {
  isKnownMedia,
  mediaById,
  type MediaCatalogue,
} from './media-catalogue'
import {
  createKeepAwakeController,
  type KeepAwakeController,
} from './keep-awake'
import { transportIsStale } from './reconnect-policy'
import { clearRejoinRoom, writeRejoinRoom } from './rejoin-memory'
import { makeRoomCode, normaliseRoomCode } from './room-code'
import { createDomScreenVideo, type ScreenVideoOutput } from './screen-output'
import type {
  AudioOutputState,
  MediaSelectionState,
  SyncSessionState,
} from './session-state'
import { startTransportWatchdog } from './transport-watchdog'
import { onVisibilityChange } from './visibility'

/** Host-supplied parts of a session. */
export interface SyncSessionOptions {
  /** Everything the screen can lead with, and what it starts on. */
  media: MediaCatalogue
  /**
   * Where the screen's looping video plays. Defaults to a persistent `<video>`
   * element built up front — see `screen-output.ts` for why that matters.
   */
  screenVideo?: ScreenVideoOutput
  /** What followers' lock screens show while audio is playing. */
  nowPlaying?: NowPlayingInfo
}

/** A live A/V sync session: a snapshot store plus the actions on it. */
export interface SyncSession {
  /** Current session state. The same object until something changes. */
  getState(): SyncSessionState
  /** Subscribe to state changes; call the returned function to unsubscribe. */
  subscribe(listener: () => void): () => void
  /**
   * Begin page-lifetime monitoring: page lifecycle, network reachability and a
   * TURN preflight. Idempotent, and deliberately never stopped — a freeze or a
   * discard is exactly what is being caught, and it can land before or after
   * joining.
   */
  start(): void
  /** Lead a fresh room as the screen. Must run inside a user gesture. */
  becomeScreen(): Promise<void>
  /** Join `code` as a listener. Must run inside a user gesture. */
  join(code: string): Promise<void>
  /** Leave the session and return to the landing phase. */
  leave(): Promise<void>
  /** Choose the video the screen will lead with. */
  selectVideo(id: string): void
  /** Opt in or out of keeping the display awake. */
  setKeepAwake(on: boolean): void
  /** The screen's video output, for a host that needs to display it. */
  readonly screenVideo: ScreenVideoOutput
  /**
   * Release everything this session holds. The browser host never calls it —
   * the page outlives the session — but a host that mounts and unmounts one
   * needs it, and leaving the page-lifetime monitors running is deliberate:
   * see {@link SyncSession.start}.
   */
  dispose(): void
}

/** Build an A/V sync session. Joins no room until asked to. */
export function createSyncSession(options: SyncSessionOptions): SyncSession {
  const catalogue = options.media
  const screenVideo = options.screenVideo ?? createDomScreenVideo()
  const audio = new AudioSyncController({
    primerSoundtrackUrl: catalogue.primerSoundtrackUrl,
    nowPlaying: options.nowPlaying,
  })
  const keepAwake: KeepAwakeController = createKeepAwakeController()

  const listeners = new Set<() => void>()

  let controller: SyncController | null = null
  let unsubscribeTransport: (() => void) | null = null
  let stopCorrecting: (() => void) | null = null
  let stopWatchdog: (() => void) | null = null

  let phase: SyncSessionState['phase'] = 'landing'
  let error: string | null = null
  let selectedVideoId: string = catalogue.defaultId
  let monitoring = false
  let screenWasPlaying = false

  /** Room we are in, so the watchdog knows what to rejoin. */
  let room: string | null = null

  /** Shared with the corrector: the last resync marker it acted on. */
  const syncMarker = { epoch: 0, clockReady: false }

  /** Shared with the watchdog: rejoin bookkeeping and the backoff counter. */
  const rejoins = { inFlight: false, lastAttemptAt: 0, failures: 0 }

  const readAudio = (): AudioOutputState => ({
    routed: audio.routedThroughWebAudio,
    autoLatencyMs: audio.autoLatencyMs,
    backgroundKeepAlive: audio.backgroundKeepAlive,
    engine: audio.engineKind,
  })

  const resolveMedia = (id: string) => mediaById(catalogue, id)

  const readMedia = (): MediaSelectionState => ({
    options: catalogue.options,
    selectedId: selectedVideoId,
    selected: resolveMedia(selectedVideoId),
  })

  let state: SyncSessionState = {
    phase,
    error,
    transport: null,
    correction: { mode: 'idle', driftMs: 0, rate: 1 },
    localTime: 0,
    targetTime: null,
    audio: readAudio(),
    media: readMedia(),
    keepAwake: keepAwake.getState(),
  }

  /**
   * Replace the snapshot and notify.
   *
   * A new object every time, which is what makes a host re-render at the
   * corrector's cadence — the audio readings above are live getters, not
   * stored values, so they only ever refresh when a snapshot is rebuilt. The
   * old object stays valid until then, which is what keeps `getState`
   * reference-stable between changes.
   */
  const set = (patch: Partial<SyncSessionState>) => {
    state = { ...state, ...patch }
    listeners.forEach(listener => listener())
  }

  const publishPhase = () => set({ phase, error, media: readMedia() })

  /** Re-arm the corrector's resync marker from a freshly installed transport. */
  const reseedFrom = (next: SyncController) => {
    const syncState = next.getState()

    syncMarker.epoch = syncState.syncEpoch
    syncMarker.clockReady = syncState.clockReady
  }

  const detachTransport = () => {
    stopCorrecting?.()
    stopWatchdog?.()
    unsubscribeTransport?.()
    stopCorrecting = null
    stopWatchdog = null
    unsubscribeTransport = null
  }

  /**
   * Install a transport and re-arm everything hanging off it. Timers are torn
   * down and rebuilt per transport, so nothing outlives the room it was
   * watching.
   */
  const attachTransport = (next: SyncController | null) => {
    detachTransport()
    controller = next
    screenWasPlaying = false

    if (!next) {
      set({ transport: null })

      return
    }

    unsubscribeTransport = next.subscribe(() =>
      set({ transport: next.getState(), audio: readAudio() }),
    )

    if (next.role === 'follower') {
      stopCorrecting = startCorrectionLoop({
        transport: () => controller,
        audio,
        resolveMedia,
        syncMarker,
        onTick: tick => set({ ...tick, audio: readAudio() }),
      })
      stopWatchdog = startTransportWatchdog({
        transport: () => controller,
        rejoins,
        reconnect: () => void reconnectTransport(),
      })
    }

    set({ transport: next.getState(), audio: readAudio() })
  }

  const setSessionActive = () =>
    keepAwake.setSessionActive(phase === 'active' && controller != null)

  /**
   * Rebuild the transport in place, keeping audio running. Android tears the
   * WebRTC peer connection (and its signaling socket) down during sleep and it
   * does not always come back — the follower then sits on a stale room
   * receiving no beats. Rejoining is the only reliable recovery.
   *
   * This deliberately does NOT touch the audio engine: no gesture is needed
   * (the AudioContext is already unlocked) and the streaming engine free-runs
   * on its pre-scheduled chain, so playback continues across the reconnect.
   */
  const reconnectTransport = async () => {
    const code = room

    if (!code || rejoins.inFlight) {
      return
    }

    rejoins.inFlight = true
    rejoins.lastAttemptAt = Date.now()

    const startedAt = Date.now()

    rejoins.failures += 1
    recordDiagnostic(
      'transport',
      `rejoining room ${code}… (attempt ${rejoins.failures})`,
      { tag: 'transport-rejoin' },
    )
    // Captured at the moment things are going wrong, which is the only time
    // relay health is worth knowing.
    reportRelaySockets('rejoin')

    try {
      // Leave first — rejoining the same room while the dead session lingers
      // can collide.
      await controller?.leave().catch(() => {})

      const rejoined = await joinAsFollower(code)

      reseedFrom(rejoined)
      attachTransport(rejoined)

      // Deliberately not "rejoined": all that has happened is that a room
      // object exists. Whether a peer connects is a separate event, and
      // conflating the two made an Android sleep log read as seven successful
      // recoveries when in fact none of them ever peered.
      recordDiagnostic(
        'transport',
        `room rebuilt in ${((Date.now() - startedAt) / 1000).toFixed(1)}s` +
          ' — awaiting peers',
      )
    } catch (caught) {
      // Worth logging rather than swallowing: a rejoin that fails because the
      // signalling relay is unreachable is a different problem from one the
      // peer connection caused.
      recordDiagnostic(
        'transport',
        `rejoin FAILED after ${((Date.now() - startedAt) / 1000).toFixed(1)}s` +
          ` — ${caught instanceof Error ? caught.message : String(caught)}`,
      )
    } finally {
      rejoins.inFlight = false
    }
  }

  // Resume media after sleep / tab backgrounding (iOS suspends Web Audio and
  // the video element).
  const stopWatchingVisibility = onVisibilityChange(visible => {
    if (!controller) {
      return
    }

    if (!visible) {
      if (controller.role === 'screen') {
        screenWasPlaying = screenVideo.playing
      } else {
        // Follower: schedule audio ahead so a streaming engine survives the
        // lock/throttle.
        audio.enterBackground()
      }

      return
    }

    if (controller.role !== 'follower') {
      if (screenWasPlaying) {
        screenVideo.resume()
      }

      return
    }

    audio.exitBackground()
    audio.resume()
    audio.resync()

    const syncState = controller.getState()
    syncMarker.epoch = syncState.syncEpoch

    // Rejoin straight away if the link died during the sleep, instead of
    // waiting out the watchdog's staleness window — the user is looking at the
    // screen now.
    if (
      transportIsStale(syncState.lastBeatAt, Date.now()) ||
      !syncState.screenOnline
    ) {
      reconnectTransport()
    }
  })

  const stopWatchingKeepAwake = keepAwake.subscribe(() =>
    set({ keepAwake: keepAwake.getState() }),
  )

  return {
    screenVideo,

    getState: () => state,

    subscribe(listener) {
      listeners.add(listener)

      return () => {
        listeners.delete(listener)
      }
    },

    start() {
      if (monitoring) {
        return
      }

      monitoring = true
      startLifecycleMonitoring()
      startReachabilityProbe()
      // Fire-and-forget: records whether Cloudflare TURN is reachable and the
      // credentials are still valid, before anyone tries to join.
      preflightTurn()
    },

    async becomeScreen() {
      error = null
      phase = 'connecting'
      publishPhase()

      try {
        const option = resolveMedia(selectedVideoId)

        // Inside the gesture, and before the network round trip that follows.
        await screenVideo.play(option)

        const screen = await startScreen(makeRoomCode())

        screen.setBeatSource(() => ({
          mediaId: option.id,
          videoTime: screenVideo.currentTimeSec,
          playing: screenVideo.playing,
          duration: screenVideo.durationSec,
        }))

        attachTransport(screen)
        phase = 'active'
        publishPhase()
        setSessionActive()
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught)
        phase = 'landing'
        publishPhase()
        setSessionActive()
      }
    },

    async join(code) {
      error = null
      phase = 'connecting'
      publishPhase()

      try {
        await audio.unlock() // play() fired inside the gesture

        const joining = normaliseRoomCode(code)

        room = joining // enables the watchdog to rejoin after a sleep

        const follower = await joinAsFollower(joining)

        reseedFrom(follower)

        // Start the watchdog's cooldown now, so a fresh join gets the same
        // grace period a rejoin does. A follower begins with
        // `screenOnline: false` and stays that way until the first beat lands,
        // which takes a couple of seconds of peering — with the cooldown still
        // sitting at 0 the watchdog read that as a dead link and tore the
        // connection down about a second after it was made, on every single
        // join.
        rejoins.lastAttemptAt = Date.now()

        // Remember the room so a background tab-discard + reload can offer a
        // one-tap rejoin (audio still needs the tap, so we can't fully
        // auto-rejoin).
        writeRejoinRoom(joining)

        attachTransport(follower)
        phase = 'active'
        publishPhase()
        setSessionActive()
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught)
        phase = 'landing'
        publishPhase()
        setSessionActive()
      }
    },

    async leave() {
      const leaving = controller

      room = null // stop the watchdog from resurrecting the session
      clearRejoinRoom() // deliberate leave — don't offer rejoin

      audio.stop()
      screenVideo.pause()

      // Torn down after the await, not before: the corrector kept ticking
      // across `leave()` when this was a React effect, and shortening that
      // window is a behaviour change, not a tidy-up.
      await leaving?.leave()
      attachTransport(null)

      phase = 'landing'
      publishPhase()
      setSessionActive()
    },

    selectVideo(id) {
      // Unknown ids are dropped rather than stored: the lookup would fall
      // back to the first option, and the selection would then disagree with
      // what is actually playing.
      if (!isKnownMedia(catalogue, id)) {
        return
      }

      selectedVideoId = id
      set({ media: readMedia() })
    },

    setKeepAwake(on) {
      keepAwake.setEnabled(on)
    },

    dispose() {
      stopWatchingVisibility()
      stopWatchingKeepAwake()
      detachTransport()
      keepAwake.dispose()
      audio.stop()
      screenVideo.pause()
      listeners.clear()
    },
  }
}
