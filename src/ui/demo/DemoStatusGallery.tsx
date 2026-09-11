/**
 * Every status a listener can be shown, on one page.
 *
 * The rings are the point. Each tone draws the same circle at the same radius
 * — see `DemoStatusDisplay.module.css` and `REST_RADIUS` in DemoWaveformRing —
 * and the one way to be sure of that is to see them side by side. The panels
 * are equal-sized and hold the rings on a shared baseline, so a ring drawn a
 * few pixels out, or one that sits lower because its sentence is shorter,
 * shows up against its neighbours without anything having to measure it.
 *
 * Nothing here restates the copy. Each panel is a real
 * {@link followerStatus} reading of a session snapshot that would produce it,
 * so wording, tone and detail follow `demo-status.ts` rather than drifting
 * from it, and a status added there without a scenario here is a visible gap.
 *
 * Not a session host: it never joins anything, and is routed in `index.tsx`
 * before `useSync` for that reason.
 */
import { useMemo } from 'react'

import { sessionConfig } from '../../core/config'
import type { MediaOption } from '../../core/media-catalogue'
import type { SyncSessionState } from '../../core/session-state'
import type { AudioWaveform } from '../../media/audio-waveform'
import type { SyncState } from '../../transport/sync-controller'
import { classNames } from '../class-names'
import demo from './demo.module.css'
import { followerStatus } from './demo-status'
import { DemoStatusDisplay } from './DemoStatusDisplay'
import styles from './DemoStatusGallery.module.css'

/**
 * Wave shape of the stand-in waveform, in samples.
 *
 * The ring plots roughly 490 samples of the window, so a period near this puts
 * a couple of cycles round the circle — which is also what a real mid-range
 * note does at 48 kHz, the case the ring was drawn for.
 */
const SAMPLE_PERIOD = 196

/** Nothing the gallery plays, but `SyncSessionState` insists on an option. */
const NO_MEDIA: MediaOption = {
  id: 'gallery',
  label: 'None — the gallery plays nothing',
  videoUrl: '',
  soundtrackUrl: '',
}

/** A follower with a live link to the screen, for the scenarios to patch. */
const LINKED: SyncState = {
  role: 'follower',
  roomCode: 'RING',
  selfId: 'gallery',
  screenId: 'screen',
  offsetMs: 0,
  rttMs: 20,
  latestBeat: null,
  lastBeatAt: 1,
  peerCount: 1,
  screenOnline: true,
  clockReady: true,
  syncEpoch: 1,
  signallingOnline: true,
}

/**
 * A snapshot of a healthy, in-sync follower, for the scenarios below to patch.
 *
 * Only six fields of this are ever read — `followerStatus` looks at the error,
 * the phase, the transport's `screenOnline`, the correction's mode and drift,
 * and the audio engine. The rest is here to complete the type, and is
 * deliberately dull so a scenario's patch is the only interesting thing about
 * it.
 */
const HEALTHY: SyncSessionState = {
  phase: 'active',
  error: null,
  transport: LINKED,
  correction: { mode: 'locked', driftMs: 0, rate: 1 },
  localTime: 0,
  targetTime: 0,
  audio: {
    routed: true,
    autoLatencyMs: 0,
    backgroundKeepAlive: false,
    engine: 'buffer',
  },
  media: {
    options: [NO_MEDIA],
    offered: [NO_MEDIA],
    selectedId: NO_MEDIA.id,
    selected: NO_MEDIA,
  },
  keepAwake: { enabled: true, supported: true, held: true },
}

/** One thing that can happen to a listener, and the snapshot it happens in. */
interface Scenario {
  /** What the session is doing, for the caption under the panel. */
  name: string
  /** Fields of {@link HEALTHY} this scenario changes. */
  patch: Partial<SyncSessionState>
  /** Whether the screen has been heard from at all — see `demo-status.ts`. */
  hadContact?: boolean
}

/**
 * Every branch of `followerStatus`, in the order that function tests them.
 *
 * The two spellings of "the soundtrack is not here yet" — a `syncing`
 * corrector and a `syncing` engine — produce the same status and appear once.
 */
const SCENARIOS: readonly Scenario[] = [
  {
    name: 'Join failed',
    patch: { error: 'Could not reach the room.' },
  },
  {
    name: 'Joining',
    patch: { phase: 'connecting', transport: null },
  },
  {
    name: 'Before the tap',
    patch: { phase: 'landing', transport: null },
  },
  {
    name: 'Screen not started',
    patch: { transport: { ...LINKED, screenOnline: false } },
  },
  {
    name: 'Screen dropped out',
    patch: { transport: { ...LINKED, screenOnline: false } },
    hadContact: true,
  },
  {
    name: 'Fetching the soundtrack',
    patch: { correction: { mode: 'syncing', driftMs: 0, rate: 1 } },
  },
  {
    name: 'Corrector not running yet',
    patch: { correction: { mode: 'idle', driftMs: 0, rate: 1 } },
  },
  {
    name: 'Drift past the bad band',
    patch: {
      correction: {
        mode: 'nudge',
        // Twice the threshold, read from policy rather than typed in, so the
        // scenario stays "bad" if the bands are ever retuned.
        driftMs: sessionConfig().drift.warnMs * 2,
        rate: 1.02,
      },
    },
  },
  {
    name: 'Locked',
    patch: {},
  },
]

/**
 * A stand-in for the session's waveform: a two-harmonic tone under a slow
 * swell, so the live ring both ripples and breathes with nothing playing.
 *
 * Synthetic rather than a microphone or a looped file because the ring is the
 * subject — a signal that always covers the full swing is the one that shows
 * whether the peaks still clear the box.
 */
function createGalleryWaveform(): AudioWaveform {
  return {
    windowSize: 2048,

    read(into) {
      const seconds = performance.now() / 1000
      const swell = 0.25 + 0.35 * (0.5 + 0.5 * Math.sin(seconds * 0.55))

      for (let index = 0; index < into.length; index += 1) {
        const phase = (index / SAMPLE_PERIOD + seconds * 1.7) * Math.PI * 2

        into[index] = swell * (Math.sin(phase) + 0.35 * Math.sin(phase * 3))
      }

      return true
    },

    dispose() {},
  }
}

/** The status each scenario produces. */
function statusesOf(scenarios: readonly Scenario[]) {
  return scenarios.map(scenario => ({
    name: scenario.name,
    status: followerStatus(
      { ...HEALTHY, ...scenario.patch },
      scenario.hadContact ?? false,
    ),
  }))
}

/** Every listener status, one per panel. */
export function DemoStatusGallery() {
  const waveform = useMemo(createGalleryWaveform, [])
  const panels = useMemo(() => statusesOf(SCENARIOS), [])

  return (
    <main className={classNames(demo.shell, styles.page)}>
      <header className={styles.intro}>
        <h1 className={styles.title}>Follower status rings</h1>
        <p className={styles.lede}>
          Every state <code>demo-status.ts</code> can produce, drawn by the
          component a listener sees. Same ring, same size, same place in the
          panel — moving between states should change the words and nothing
          else. Turn on reduced motion to swap the live ring for the still
          check mark it falls back to.
        </p>
      </header>

      <ol className={styles.grid}>
        {panels.map(({ name, status }) => (
          <li className={styles.panel} key={name}>
            <DemoStatusDisplay status={status} waveform={waveform} />
            <p className={styles.caption}>
              {name} <span className={styles.tone}>{status.tone}</span>
            </p>
          </li>
        ))}
      </ol>
    </main>
  )
}
