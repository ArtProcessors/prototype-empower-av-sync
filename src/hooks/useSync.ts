/**
 * React binding for the A/V sync spike.
 *
 *  - Screen: owns a persistent looping <video> (unlocked in the "Be the
 *    screen" tap), mounts it into the view, and feeds its clock to the
 *    controller's beat source.
 *  - Follower: unlocks a local audio element in the join tap, then runs a
 *    ~15 Hz corrector that computes the screen's current position (latest beat
 *    + clock offset) and steers the audio via AudioSyncController.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import {
  VIDEOS,
  DEFAULT_VIDEO_ID,
  videoById,
  type VideoOption,
} from '../content'
import { startLifecycleMonitoring } from '../diagnostics/lifecycle-monitor'
import {
  networkLooksUp,
  startReachabilityProbe,
} from '../diagnostics/reachability'
import { recordDiagnostic } from '../diagnostics/session-log'
import { preflightTurn } from '../diagnostics/turn-preflight'
import {
  AudioSyncController,
  type CorrectionInfo,
} from '../media/audio-sync-controller'
import { computeTarget } from '../sync/sync-math'
import {
  startScreen,
  joinAsFollower,
  type SyncController,
  type SyncState,
} from '../transport/sync-controller'
import {
  readKeepAwakePref,
  useWakeLock,
  writeKeepAwakePref,
} from './useWakeLock'

const CORRECT_MS = 66 // ~15 Hz correction loop
const BEAT_FRESH_MS = 3000 // ignore beats older than this when steering
const WATCHDOG_MS = 1000 // how often the transport watchdog checks for beats
const REJOIN_KEY = 'empower.rejoinRoom' // sessionStorage: room to re-offer after a reload
const TRANSPORT_STALE_MS = 6000 // no beats for this long → the WebRTC link is presumed dead
const RECONNECT_COOLDOWN_MS = 10000 // min gap between transport rejoin attempts (visible)
const HIDDEN_RECONNECT_COOLDOWN_MS = 45000 // slower retries while asleep (Doze refuses most anyway)

/**
 * The room a listener was in before a reload/tab-discard, if any — for a
 * one-tap rejoin.
 */
export function readRejoinRoom(): string | null {
  try {
    return sessionStorage.getItem(REJOIN_KEY)
  } catch {
    return null
  }
}

// Ambiguous glyphs (0/O, 1/I) are left out so a room code read off a screen
// can't be mistyped.
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function makeRoomCode(length = 4): string {
  const values = new Uint32Array(length)
  crypto.getRandomValues(values)

  return Array.from(
    values,
    value => ROOM_ALPHABET[value % ROOM_ALPHABET.length],
  ).join('')
}

/** Where the UI is in the join/lead flow. */
export type Phase = 'landing' | 'connecting' | 'active'

/** Everything the views need: live session state plus the actions on it. */
export interface SyncApi {
  /** Where the UI is in the join/lead flow. */
  phase: Phase
  /** Last error raised while becoming the screen or joining, if any. */
  error: string | null
  /** Live transport state, or `null` before a session starts. */
  state: SyncState | null

  /** Follower: how the audio is currently being corrected. */
  correction: CorrectionInfo
  /** Follower: local audio position, in seconds. */
  localTime: number
  /** Follower: the screen's extrapolated position, in seconds. */
  targetTime: number | null
  /** Audio routed through Web Audio (so it ignores the iOS mute switch). */
  audioRouted: boolean
  /** Auto-measured output latency being compensated for, in ms. */
  audioAutoLatencyMs: number
  /** Lock-screen keep-alive sink is active. */
  audioBgKeepAlive: boolean
  /** Which follower output path is live. */
  audioEngine: 'element' | 'buffer' | 'stream' | 'syncing'

  /** Videos the screen can lead with. */
  videos: VideoOption[]
  /** Id of the currently selected video. */
  videoId: string
  /** Select the video the screen will lead with. */
  setVideoId: (id: string) => void

  /** Whether the user has opted in to keeping the screen awake. */
  keepAwake: boolean
  /** Opt in or out of keeping the screen awake. */
  setKeepAwake: (on: boolean) => void
  /** Whether this browser exposes the Screen Wake Lock API. */
  wakeLockSupported: boolean
  /** Whether a wake lock is held right now. */
  wakeLockActive: boolean

  /** Start a room as the screen (must run inside a user gesture). */
  becomeScreen: () => Promise<void>
  /** Join a room as a listener (must run inside a user gesture). */
  join: (code: string) => Promise<void>
  /** Leave the session and return to the landing screen. */
  leave: () => Promise<void>

  /** Ref callback that mounts the persistent screen video into a container. */
  mountScreenVideo: (container: HTMLElement | null) => void
}

/** Drive an A/V sync session and expose it to the views as a {@link SyncApi}. */
export function useSync(): SyncApi {
  const [controller, setController] = useState<SyncController | null>(null)
  const [state, setState] = useState<SyncState | null>(null)
  const [phase, setPhase] = useState<Phase>('landing')
  const [error, setError] = useState<string | null>(null)

  const [correction, setCorrection] = useState<CorrectionInfo>({
    mode: 'idle',
    driftMs: 0,
    rate: 1,
  })
  const [localTime, setLocalTime] = useState(0)
  const [targetTime, setTargetTime] = useState<number | null>(null)
  const [videoId, setVideoId] = useState<string>(DEFAULT_VIDEO_ID)
  const [keepAwake, setKeepAwakeState] = useState(readKeepAwakePref)

  const setKeepAwake = useCallback((on: boolean) => {
    writeKeepAwakePref(on)
    setKeepAwakeState(on)
  }, [])

  const sessionActive = phase === 'active' && controller != null
  const { supported: wakeLockSupported, held: wakeLockActive } = useWakeLock(
    sessionActive,
    keepAwake,
  )

  // Persistent screen video element (created once → survives being moved into
  // the view, preserving the iOS autoplay permission granted in the gesture).
  // Its src is set when becoming the screen, from the selected video option.
  const videoRef = useRef<HTMLVideoElement | null>(null)

  if (!videoRef.current) {
    const video = document.createElement('video')
    video.loop = true
    video.playsInline = true
    video.setAttribute('playsinline', '')
    video.setAttribute('webkit-playsinline', '')
    video.controls = true
    // The leader (local video) is muted. Only followers can hear the sound.
    video.muted = true
    video.style.width = '100%'
    video.style.height = 'auto'
    video.style.background = '#000'
    video.style.display = 'block'
    videoRef.current = video
  }

  const audioRef = useRef<AudioSyncController | null>(null)

  if (!audioRef.current) {
    audioRef.current = new AudioSyncController()
  }

  const syncEpochRef = useRef(0)
  const clockReadyRef = useRef(false)
  const roomRef = useRef<string | null>(null) // room we're in, for transport reconnects
  const reconnectingRef = useRef(false)
  const lastReconnectAtRef = useRef(0)

  // Page-lifecycle, network and renderer-liveness logging runs for the whole
  // page, not just while a session is up — a freeze or a discard is exactly
  // what we are trying to catch, and it can land before or after joining.
  useEffect(() => {
    startLifecycleMonitoring()
    startReachabilityProbe()
    // Fire-and-forget: records whether Cloudflare TURN is reachable and the
    // credentials are still valid, before anyone tries to join.
    preflightTurn()
  }, [])

  useEffect(() => {
    if (!controller) {
      return
    }

    setState(controller.getState())

    return controller.subscribe(() => setState(controller.getState()))
  }, [controller])

  // Follower correction loop.
  useEffect(() => {
    if (!controller || controller.role !== 'follower') {
      return
    }

    const audio = audioRef.current!

    const timer = setInterval(() => {
      // Recover the Web Audio context if iOS suspended it (backgrounding).
      audio.resume()

      const syncState = controller.getState()

      if (syncState.syncEpoch !== syncEpochRef.current) {
        syncEpochRef.current = syncState.syncEpoch
        audio.resync()
      }

      if (syncState.clockReady && !clockReadyRef.current) {
        clockReadyRef.current = true
        audio.resync()
        syncEpochRef.current = syncState.syncEpoch
      } else if (!syncState.clockReady) {
        clockReadyRef.current = false
      }

      const beat = syncState.latestBeat
      const now = Date.now()
      let target: number | null = null
      let playing = false

      const beatUsable =
        beat != null &&
        syncState.screenOnline &&
        syncState.clockReady &&
        now - syncState.lastBeatAt < BEAT_FRESH_MS

      if (beatUsable) {
        const media = videoById(beat.mediaId)
        // Load the audio that matches the video the screen is playing.
        audio.setSource(media.soundtrackUrl, media.streaming)
        target = computeTarget(beat, syncState.offsetMs, now)
        playing = beat.playing
      }

      setCorrection(audio.correct(target, playing))
      setLocalTime(audio.currentTimeSec)
      setTargetTime(target)
    }, CORRECT_MS) as unknown as number

    return () => clearInterval(timer)
  }, [controller])

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
  const reconnectTransport = useCallback(async () => {
    const code = roomRef.current

    if (!code || reconnectingRef.current) {
      return
    }

    reconnectingRef.current = true
    lastReconnectAtRef.current = Date.now()

    const startedAt = Date.now()
    recordDiagnostic('transport', `rejoining room ${code}…`)

    try {
      // Leave first — rejoining the same room while the dead session lingers
      // can collide.
      await controller?.leave().catch(() => {})

      const rejoined = await joinAsFollower(code)
      syncEpochRef.current = rejoined.getState().syncEpoch
      clockReadyRef.current = rejoined.getState().clockReady
      setController(rejoined)

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
      reconnectingRef.current = false
    }
  }, [controller])

  /**
   * Transport watchdog (follower): if beats have stopped, rejoin the room.
   *
   * This also runs while the page is HIDDEN. Android Doze throttles the
   * network a few minutes into a screen-off, and WebRTC drops the peer
   * connection when its consent-freshness checks fail — so the listener
   * silently disappears from the screen's peer count and stops receiving beats
   * even though audio keeps free-running. The keep-alive tap means the page
   * itself is still alive and can retry, so we do, just far less often than
   * when visible (battery, and Doze will refuse most attempts anyway — but it
   * recovers on Doze's maintenance windows instead of waiting for the user to
   * wake the phone).
   */
  useEffect(() => {
    if (!controller || controller.role !== 'follower') {
      return
    }

    const timer = setInterval(() => {
      if (reconnectingRef.current) {
        return
      }

      const hidden = document.visibilityState !== 'visible'

      // While hidden, only spend a rejoin when a probe has just shown the
      // network is actually usable. On the Android sleep test the watchdog
      // rebuilt the room every 45 s, seven times, and never once peered —
      // pure battery and signalling-relay churn against a radio that was not
      // listening.
      if (hidden && !networkLooksUp()) {
        return
      }

      const cooldown = hidden
        ? HIDDEN_RECONNECT_COOLDOWN_MS
        : RECONNECT_COOLDOWN_MS
      const syncState = controller.getState()
      const stale =
        syncState.lastBeatAt > 0 &&
        Date.now() - syncState.lastBeatAt > TRANSPORT_STALE_MS
      const cooledDown = Date.now() - lastReconnectAtRef.current > cooldown

      if ((stale || !syncState.screenOnline) && cooledDown) {
        reconnectTransport()
      }
    }, WATCHDOG_MS) as unknown as number

    return () => clearInterval(timer)
  }, [controller, reconnectTransport])

  // Resume media after sleep / tab backgrounding (iOS suspends Web Audio and
  // the video element).
  useEffect(() => {
    if (!controller) {
      return
    }

    const audio = audioRef.current!
    const video = videoRef.current!
    let screenWasPlaying = false

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        if (controller.role === 'screen') {
          screenWasPlaying = !video.paused
        } else {
          // Follower: schedule audio ahead so a streaming engine survives the
          // lock/throttle.
          audio.enterBackground()
        }

        return
      }

      if (controller.role !== 'follower') {
        if (screenWasPlaying) {
          video.play().catch(() => {})
        }

        return
      }

      audio.exitBackground()
      audio.resume()
      audio.resync()

      const syncState = controller.getState()
      syncEpochRef.current = syncState.syncEpoch

      // Rejoin straight away if the link died during the sleep, instead of
      // waiting out the watchdog's staleness window — the user is looking at
      // the screen now.
      const stale =
        syncState.lastBeatAt > 0 &&
        Date.now() - syncState.lastBeatAt > TRANSPORT_STALE_MS

      if (stale || !syncState.screenOnline) {
        reconnectTransport()
      }
    }

    document.addEventListener('visibilitychange', onVisibilityChange)

    return () =>
      document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [controller, reconnectTransport])

  const becomeScreen = useCallback(async () => {
    setError(null)
    setPhase('connecting')

    try {
      const video = videoRef.current!
      const option = videoById(videoId)

      if (
        !video.src.endsWith(option.videoUrl) &&
        video.getAttribute('src') !== option.videoUrl
      ) {
        video.src = option.videoUrl
      }

      // Start playback inside the gesture. The first play() can reject while
      // the freshly assigned src is still loading, so retry once — by then the
      // element has the gesture's autoplay permission either way.
      try {
        await video.play()
      } catch {
        await video.play().catch(() => {})
      }

      const screen = await startScreen(makeRoomCode())
      screen.setBeatSource(() => ({
        mediaId: option.id,
        videoTime: video.currentTime,
        playing: !video.paused,
        duration: video.duration || 0,
      }))

      setController(screen)
      setPhase('active')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setPhase('landing')
    }
  }, [videoId])

  const join = useCallback(async (code: string) => {
    setError(null)
    setPhase('connecting')

    try {
      await audioRef.current!.unlock() // play() fired inside the gesture

      const room = code.trim().toUpperCase()
      roomRef.current = room // enables the transport watchdog to rejoin after a sleep

      const follower = await joinAsFollower(room)
      syncEpochRef.current = follower.getState().syncEpoch
      clockReadyRef.current = follower.getState().clockReady

      // Start the watchdog's cooldown now, so a fresh join gets the same grace
      // period a rejoin does. A follower begins with `screenOnline: false` and
      // stays that way until the first beat lands, which takes a couple of
      // seconds of peering — with the cooldown still sitting at 0 the watchdog
      // read that as a dead link and tore the connection down about a second
      // after it was made, on every single join.
      lastReconnectAtRef.current = Date.now()

      // Remember the room so a background tab-discard + reload can offer a
      // one-tap rejoin (audio still needs the tap, so we can't fully
      // auto-rejoin).
      try {
        sessionStorage.setItem(REJOIN_KEY, room)
      } catch {
        /* storage may be unavailable */
      }

      setController(follower)
      setPhase('active')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setPhase('landing')
    }
  }, [])

  const leave = useCallback(async () => {
    roomRef.current = null // stop the watchdog from resurrecting the session

    try {
      sessionStorage.removeItem(REJOIN_KEY) // deliberate leave — don't offer rejoin
    } catch {
      /* ignore */
    }

    audioRef.current?.stop()
    videoRef.current?.pause()
    await controller?.leave()

    setController(null)
    setState(null)
    setPhase('landing')
  }, [controller])

  const mountScreenVideo = useCallback((container: HTMLElement | null) => {
    const video = videoRef.current!

    if (container) {
      if (video.parentElement !== container) {
        container.appendChild(video)
      }
    } else if (video.parentElement) {
      video.parentElement.removeChild(video)
    }
  }, [])

  return {
    phase,
    error,
    state,
    correction,
    localTime,
    targetTime,
    audioRouted: audioRef.current?.routedThroughWebAudio ?? false,
    audioAutoLatencyMs: audioRef.current?.autoLatencyMs ?? 0,
    audioBgKeepAlive: audioRef.current?.backgroundKeepAlive ?? false,
    audioEngine: audioRef.current?.engineKind ?? 'element',
    videos: VIDEOS,
    videoId,
    setVideoId,
    keepAwake,
    setKeepAwake,
    wakeLockSupported,
    wakeLockActive,
    becomeScreen,
    join,
    leave,
    mountScreenVideo,
  }
}
