/**
 * Every state the screen can be in, one at a time, without opening a room.
 *
 * The follower's rings tile into a grid because `DemoStatusDisplay` is a
 * leaf: no shell, no fixed positioning, no viewport units, so a panel is a
 * faithful copy of it. Neither screen surface is like that. `DemoScreenStart`
 * sizes itself to `100dvh`, and `DemoScreenView` is `position: fixed` with a
 * QR measured in `vmin` and an alert capped in `vw` — none of which a
 * `transform: scale()` shrinks along with the panel it is in. A thumbnail of
 * either would be confidently wrong about the one thing worth checking, which
 * is where the overlays land. So this shows one scenario at a time, at the
 * size a display actually renders it, and offers a switcher instead of a
 * grid.
 *
 * Only the session is stood in for: the transport the screen would have
 * joined, and the actions it would have called. The catalogue the picker
 * lists, the persistent `<video>` element the live view mounts, and both view
 * components are the real ones, so a change to any of them shows up here
 * without this file being touched — and a state added to either without a
 * scenario here is a visible gap.
 *
 * The handover is why the start scenarios keep a working button. Pressing
 * Start runs the real lap-and-mark sequence, and this holds the same `held`
 * flag `DemoApp` does, so the cut from the start screen to the video happens
 * here exactly as it does in the app. That cut is the one part of the
 * screen's behaviour that is a sequence rather than a state, and the only
 * part that otherwise needs a room to see; {@link ROOM_OPEN_PRESETS} exists
 * to run it on both sides of the lap.
 *
 * The start screen's "Listen on this device instead" is inert here. This is a
 * preview of the screen's own views, and the listener's states are a page of
 * their own — see `/dev/rings` and `ui/demo/DemoStatusGallery.tsx`.
 *
 * Not a session host: it never joins anything, and is routed in `index.tsx`
 * before `useSync` for that reason.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { contentCatalogue } from '../../content'
import { mediaById } from '../../core/media-catalogue'
import {
  createDomScreenVideo,
  type DomScreenVideoOutput,
} from '../../core/screen-output'
import type { SyncSession } from '../../core/session'
import type { SyncSessionState } from '../../core/session-state'
import type { AudioWaveform } from '../../media/audio-waveform'
import type { SyncState } from '../../transport/sync-controller'
import { classNames } from '../class-names'
import { currentLaunchIntent } from '../launch-intent'
import type { LaunchVideoState } from '../useLaunchVideo'
import styles from './DemoScreenGallery.module.css'
import { DemoScreenStart } from './DemoScreenStart'
import { DemoScreenView } from './DemoScreenView'

/**
 * What a browser says when it refuses to play, quoted rather than paraphrased.
 *
 * The start screen surfaces the rejection verbatim, so the point of the
 * scenario using it is to see a real one wrap: this is Safari's
 * `NotAllowedError`, which is both the longest of them and the one an iOS
 * display in Low Power Mode actually produces.
 */
const REFUSED_MESSAGE =
  'The request is not allowed by the user agent or the platform in the ' +
  'current context, possibly because the user denied permission.'

/**
 * How long the stand-in `becomeScreen` takes to "open a room", in ms.
 *
 * Two presets because the lap is 900 ms and the mark lands 500 ms after it —
 * see `demo.module.css` — and the interesting question is which of the two
 * finishes first. `fast` has the room open a third of the way round, so the
 * view is held until the mark lands; `slow` lets the whole sequence play and
 * hold, so the cut is the room's to make. Both orderings are ordinary in the
 * field, and only one of them is what a developer happens to get.
 */
const ROOM_OPEN_PRESETS = [
  { id: 'fast', label: 'Fast room', ms: 300 },
  { id: 'slow', label: 'Slow room', ms: 2600 },
] as const

/**
 * What the picker in a setup scenario lists.
 *
 * Read from this page's own URL, the same way the app reads it, so
 * `/dev/screens?debug=1` shows the longer list an instrumented screen offers
 * and a bare `/dev/screens` shows the one a visitor's link would.
 */
const CATALOGUE = contentCatalogue(currentLaunchIntent().ui === 'debug')

/** Which of the screen's two views a scenario renders. */
type ScreenSurface = 'setup' | 'live'

/** The launch reading a scenario gets when it says nothing about one. */
const OPEN_PICKER: LaunchVideoState = { error: null, canSelectVideo: true }

/**
 * The transport a screen holds once it is leading, for scenarios to patch.
 *
 * Only two fields of this reach the view — the room code it puts in the QR,
 * and `signallingOnline` — so the rest is here to complete the type and is
 * deliberately dull, leaving a scenario's patch the only interesting thing
 * about it.
 */
const LEADING: SyncState = {
  role: 'screen',
  roomCode: 'K7QF',
  selfId: 'gallery',
  screenId: 'gallery',
  offsetMs: 0,
  rttMs: 0,
  latestBeat: null,
  lastBeatAt: 0,
  peerCount: 3,
  screenOnline: true,
  clockReady: true,
  syncEpoch: 1,
  signallingOnline: true,
}

/**
 * A session that has not started anything, for the scenarios to patch.
 *
 * `media` is deliberately absent: which video is selected is the gallery's to
 * hold, since the picker in a setup scenario has to actually work.
 */
const BEFORE_START: Omit<SyncSessionState, 'media'> = {
  phase: 'landing',
  error: null,
  transport: null,
  correction: { mode: 'idle', driftMs: 0, rate: 1 },
  localTime: 0,
  targetTime: null,
  audio: {
    routed: false,
    autoLatencyMs: 0,
    backgroundKeepAlive: false,
    engine: 'element',
  },
  keepAwake: { enabled: true, supported: true, held: true },
}

/** One thing the screen can be showing, and the session it shows it in. */
interface ScreenScenario {
  /** Fragment identifier, so a state survives a reload and can be linked. */
  id: string
  /** What the screen is doing, for the switcher. */
  name: string
  /** Which of the two views renders it. */
  surface: ScreenSurface
  /** Why this state is worth looking at, shown under the switcher. */
  note: string
  /** Fields of {@link BEFORE_START} this scenario changes. */
  patch?: Partial<SyncSessionState>
  /** How the launch URL was honoured. Defaults to {@link OPEN_PICKER}. */
  launch?: LaunchVideoState
  /** Video this scenario leads with, when the link named one. */
  video?: string
}

/** Every state either screen view can render, setup first. */
const SCENARIOS: readonly ScreenScenario[] = [
  {
    id: 'picker',
    name: 'Picker',
    surface: 'setup',
    note: 'A bare URL: the operator picks the video, then taps.',
  },
  {
    id: 'named',
    name: 'Named by the link',
    surface: 'setup',
    note:
      '?video=soh — the picker is gone and the name stands in for it, so a ' +
      'link that worked can be told from one that was ignored without ' +
      'starting it and watching.',
    video: 'soh',
    launch: { error: null, canSelectVideo: false },
  },
  {
    id: 'unknown-video',
    name: 'Unknown video',
    surface: 'setup',
    note:
      '?video=matinee, which this build does not ship. The autostart is ' +
      'suppressed and the picker comes back as the way on.',
    launch: {
      error:
        'This link asks for a video called “matinee”, which this page ' +
        'cannot play.',
      canSelectVideo: true,
    },
  },
  {
    id: 'refused',
    name: 'Playback refused',
    surface: 'setup',
    note:
      'Where ?autostart=1 lands when the browser will not play unprompted — ' +
      'iOS Low Power Mode refuses even a muted video. The wording is the ' +
      'browser’s own, so it is long and it is not ours.',
    video: 'soh',
    launch: { error: null, canSelectVideo: false },
    patch: { error: REFUSED_MESSAGE },
  },
  {
    id: 'both-errors',
    name: 'Both errors',
    surface: 'setup',
    note:
      'A mistyped link and a refusal at once: the only frame where two ' +
      'panels stack, and the tallest the start screen gets.',
    launch: {
      error:
        'This link asks for a video called “matinee”, which this page ' +
        'cannot play.',
      canSelectVideo: true,
    },
    patch: { error: REFUSED_MESSAGE },
  },
  {
    id: 'leading',
    name: 'Leading',
    surface: 'live',
    note:
      'The wall itself: video edge to edge, and the QR card as the only ' +
      'permanent overlay.',
    patch: { phase: 'active', transport: LEADING },
  },
  {
    id: 'signalling-offline',
    name: 'Signalling offline',
    surface: 'live',
    note:
      'No relay socket, so nobody new can join. The listeners already ' +
      'connected are unaffected, which is why the QR stays lit and the ' +
      'alert has to say so.',
    patch: {
      phase: 'active',
      transport: { ...LEADING, signallingOnline: false },
    },
  },
]

/** Nothing to read: the gallery plays a picture, never a soundtrack. */
const SILENT_WAVEFORM: AudioWaveform = {
  windowSize: 2048,
  read: () => false,
  dispose() {},
}

/**
 * The screen's video element, built on first use rather than at import.
 *
 * Memoised at module scope for the same reason `useSync` builds the real one
 * there: StrictMode invokes a component body twice, and two elements would
 * mean the one being played is not the one that got mounted. Lazy because
 * `index.tsx` imports this module on every page load and only routes to it on
 * `/dev/screens` — a `<video>` built for a page nobody opened is waste.
 */
let galleryVideoOutput: DomScreenVideoOutput | null = null

function galleryVideo(): DomScreenVideoOutput {
  galleryVideoOutput ??= createDomScreenVideo()

  return galleryVideoOutput
}

/** What the gallery needs a stand-in session to actually do. */
interface GallerySessionActions {
  /** Called by the picker; the gallery holds the selection. */
  selectVideo(id: string): void
  /** Called by the start button; resolves once the "room" is open. */
  becomeScreen(): Promise<void>
}

/**
 * A {@link SyncSession} that joins nothing.
 *
 * The two views take the whole session rather than the handful of actions
 * they call, so a stand-in has to satisfy all of it. Everything the screen
 * does not reach for is a no-op, and `getState` returns a snapshot nobody
 * reads — the gallery passes the state it wants as a prop, precisely so a
 * scenario is a value rather than a session to be driven into place.
 *
 * @param actions the two calls the screen's views actually make
 */
function createGallerySession(actions: GallerySessionActions): SyncSession {
  const video = galleryVideo()
  const state: SyncSessionState = {
    ...BEFORE_START,
    media: {
      options: CATALOGUE.options,
      offered: CATALOGUE.offered,
      selectedId: CATALOGUE.defaultId,
      selected: mediaById(CATALOGUE, CATALOGUE.defaultId),
    },
  }

  return {
    screenVideo: video,
    waveform: SILENT_WAVEFORM,
    getState: () => state,
    subscribe: () => () => {},
    start() {},
    becomeScreen: actions.becomeScreen,
    async join() {},
    async leave() {},
    selectVideo: actions.selectVideo,
    setKeepAwake() {},
    dispose() {},
  }
}

/** The scenario named by the page's fragment, or the first one. */
function initialScenarioId(): string {
  const fromHash = window.location.hash.slice(1)

  return SCENARIOS.some(scenario => scenario.id === fromHash)
    ? fromHash
    : SCENARIOS[0].id
}

/** Every state the screen can be in, one at a time. */
export function DemoScreenGallery() {
  const [scenarioId, setScenarioId] = useState(initialScenarioId)
  const [selectedId, setSelectedId] = useState(CATALOGUE.defaultId)
  const [roomOpenMs, setRoomOpenMs] = useState<number>(ROOM_OPEN_PRESETS[0].ms)
  const [held, setHeld] = useState(false)
  const [leading, setLeading] = useState(false)
  const [switcherHidden, setSwitcherHidden] = useState(false)

  // Read inside the stand-in `becomeScreen`, which is built once and would
  // otherwise close over whichever preset was selected at mount.
  const roomOpen = useRef(roomOpenMs)
  const openTimer = useRef(0)

  useEffect(() => {
    roomOpen.current = roomOpenMs
  }, [roomOpenMs])

  const session = useMemo(
    () =>
      createGallerySession({
        selectVideo: setSelectedId,
        becomeScreen: () =>
          new Promise(resolve => {
            openTimer.current = window.setTimeout(() => {
              setLeading(true)
              resolve()
            }, roomOpen.current)
          }),
      }),
    [],
  )

  // A scenario is a fresh page as far as the screen is concerned, so a
  // handover part-way through one must not follow you into the next.
  useEffect(() => {
    setHeld(false)
    setLeading(false)

    return () => window.clearTimeout(openTimer.current)
  }, [scenarioId])

  useEffect(() => {
    window.location.hash = scenarioId
  }, [scenarioId])

  // A hash-only change does not reload the page, so pasting a link to a state
  // into a gallery that is already open would otherwise do nothing at all —
  // and the write above would put the old scenario's fragment straight back.
  useEffect(() => {
    const onHashChange = () => setScenarioId(initialScenarioId())

    window.addEventListener('hashchange', onHashChange)

    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const step = useCallback((delta: number) => {
    setScenarioId(current => {
      const index = SCENARIOS.findIndex(scenario => scenario.id === current)
      const next = (index + delta + SCENARIOS.length) % SCENARIOS.length

      return SCENARIOS[next].id
    })
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null

      // The picker is a real control in two of these scenarios, and arrow
      // keys belong to it while it has focus.
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        target?.tagName === 'SELECT' ||
        target?.tagName === 'INPUT'
      ) {
        return
      }

      if (event.key === 'ArrowRight') {
        step(1)
      } else if (event.key === 'ArrowLeft') {
        step(-1)
      } else if (event.key === 'h') {
        setSwitcherHidden(hidden => !hidden)
      }
    }

    window.addEventListener('keydown', onKeyDown)

    return () => window.removeEventListener('keydown', onKeyDown)
  }, [step])

  const scenario =
    SCENARIOS.find(candidate => candidate.id === scenarioId) ?? SCENARIOS[0]
  const shownVideoId = scenario.video ?? selectedId
  const state: SyncSessionState = {
    ...BEFORE_START,
    ...scenario.patch,
    media: {
      options: CATALOGUE.options,
      offered: CATALOGUE.offered,
      selectedId: shownVideoId,
      selected: mediaById(CATALOGUE, shownVideoId),
    },
  }

  // The same test `DemoApp` makes, so the handover is held back here for
  // exactly as long as it would be in the app.
  const showsLive = scenario.surface === 'live' || (leading && !held)

  useEffect(() => {
    if (showsLive) {
      // Muted and inline, so this is allowed to start with no gesture behind
      // it — the same permission an `?autostart=1` display comes up on, and
      // the path whose retry `createDomScreenVideo` has to get right. A
      // refusal here is the browser's, and there is nowhere in a gallery to
      // report it.
      galleryVideo()
        .play(mediaById(CATALOGUE, shownVideoId))
        .catch(() => {})
    }
  }, [showsLive, shownVideoId])

  return (
    <>
      {showsLive ? (
        <DemoScreenView
          state={state}
          session={session}
          transport={state.transport ?? LEADING}
          mountScreenVideo={galleryVideo().mountInto}
        />
      ) : (
        <DemoScreenStart
          state={state}
          session={session}
          launch={scenario.launch ?? OPEN_PICKER}
          onListen={() => {}}
          onHold={setHeld}
        />
      )}

      {!switcherHidden && (
        <aside className={styles.switcher} aria-label="Screen states">
          <header className={styles.head}>
            <h1 className={styles.title}>Screen states</h1>
            <button
              className={styles.hide}
              onClick={() => setSwitcherHidden(true)}
            >
              Hide
            </button>
          </header>

          {(['setup', 'live'] as const).map(surface => (
            <section className={styles.group} key={surface}>
              <h2 className={styles.groupName}>
                {surface === 'setup' ? 'Setup' : 'Live'}
              </h2>

              <ul className={styles.list}>
                {SCENARIOS.filter(
                  candidate => candidate.surface === surface,
                ).map(candidate => (
                  <li key={candidate.id}>
                    <button
                      className={classNames(
                        styles.item,
                        candidate.id === scenario.id && styles.itemOn,
                      )}
                      aria-current={
                        candidate.id === scenario.id ? 'true' : undefined
                      }
                      onClick={() => setScenarioId(candidate.id)}
                    >
                      {candidate.name}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}

          <p className={styles.note}>{scenario.note}</p>

          {scenario.surface === 'setup' && (
            <section className={styles.group}>
              <h2 className={styles.groupName}>Room opens</h2>

              <div className={styles.presets}>
                {ROOM_OPEN_PRESETS.map(preset => (
                  <button
                    key={preset.id}
                    className={classNames(
                      styles.preset,
                      preset.ms === roomOpenMs && styles.itemOn,
                    )}
                    onClick={() => setRoomOpenMs(preset.ms)}
                  >
                    {preset.label}
                    <span className={styles.presetMs}>{preset.ms}ms</span>
                  </button>
                ))}
              </div>

              {/* A handover is one-way, exactly as it is in the app, so the
                  only way back to the button is to put the scenario back
                  where it started. */}
              {leading && (
                <button
                  className={styles.preset}
                  onClick={() => {
                    window.clearTimeout(openTimer.current)
                    setLeading(false)
                    setHeld(false)
                  }}
                >
                  Replay the start
                </button>
              )}
            </section>
          )}

          <p className={styles.keys}>
            <kbd>←</kbd> <kbd>→</kbd> step · <kbd>h</kbd> hide
          </p>
        </aside>
      )}
    </>
  )
}
