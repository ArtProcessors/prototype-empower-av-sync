/**
 * The caption block, played against the video it belongs to.
 *
 * Captions are the one part of the listener's view that cannot be judged from
 * a still: what matters is how long a line stays up, whether it can be read
 * before it is replaced, whether the highlight keeps up with a voice, and —
 * the thing only a picture can settle — whether the words are on the right
 * shot at all. In the real app that takes a screen, a room and a phone. Here
 * it takes a play button.
 *
 * The video is the clock, sampled at the corrector's own cadence rather than
 * the display's: the smoothness of the highlight is a property of that rate
 * and would flatter itself at 60 Hz. In the app the position comes from the
 * audio the corrector is steering instead, which is the same media timeline
 * the transcript is written against — so a caption that lands right here
 * lands right there.
 *
 * Which video it plays comes from `?video=`, the same parameter the screen
 * takes, so `/dev/captions?video=agent327` is the whole of switching content.
 * With none named it picks the first video that has a transcript at all.
 *
 * Not a session host: it never joins anything, and is routed in `index.tsx`
 * before `useSync` for that reason.
 */
import { useEffect, useRef, useState, type RefObject } from 'react'

import { VIDEOS, videoById, type VideoOption } from '../../content'
import { hasTranscript, loadTranscript } from '../../content/transcripts'
import { sessionConfig } from '../../core/config'
import {
  DEFAULT_HOLD_MS,
  DEFAULT_LEAD_MS,
  type Transcript,
} from '../../core/transcript'
import { classNames } from '../class-names'
import { currentLaunchIntent } from '../launch-intent'
import demo from './demo.module.css'
import { DemoTranscript } from './DemoTranscript'
import styles from './DemoTranscriptGallery.module.css'

/** Where the clock starts: a few seconds before the first word. */
const LEAD_IN_MS = 3_000

/** Every video this build has words for, in catalogue order. */
const CAPTIONED: readonly VideoOption[] = VIDEOS.filter(video =>
  hasTranscript(video.id),
)

/**
 * The video this page plays.
 *
 * Read once, at module scope, for the same reason `App` reads the debug flag
 * there: the intent is frozen at load, and a value that could change between
 * renders would be a second source of truth about what this page is. An
 * unknown `?video=` resolves the way it does everywhere else — to the
 * catalogue's first entry — and this page then says it has no words rather
 * than pretending otherwise.
 */
const ASKED: string | null = currentLaunchIntent().video

const VIDEO: VideoOption =
  ASKED === null ? (CAPTIONED[0] ?? VIDEOS[0]) : videoById(ASKED)

/**
 * When two speakers first share the block, or `null` if they never do.
 *
 * A hand-over close enough that the first voice is still being held when the
 * second starts is the one thing on this page that cannot be found by
 * scrubbing: in the SOH file it happens once, twelve minutes in, and lasts
 * about a second. Worth a button.
 */
function firstHandover(transcript: Transcript): number | null {
  const { lines } = transcript
  const index = lines.findIndex(
    (line, at) =>
      at > 0 &&
      line.speaker !== lines[at - 1].speaker &&
      line.startMs <= lines[at - 1].endMs + DEFAULT_HOLD_MS,
  )

  return index < 0 ? null : lines[index].startMs
}

/** Format a playhead as `m:ss`, the way anyone reads a media position. */
function timecode(timeMs: number): string {
  const total = Math.max(0, Math.round(timeMs / 1000))
  const seconds = total % 60

  return `${Math.floor(total / 60)}:${seconds.toString().padStart(2, '0')}`
}

/**
 * The playing video's position, in ms, sampled at the corrector's cadence.
 *
 * Polled rather than taken from `timeupdate`, which browsers fire about four
 * times a second — enough to move a scrub bar, nowhere near enough to light a
 * word as it is said.
 */
function useMediaTime(video: RefObject<HTMLVideoElement>): number {
  const [timeMs, setTimeMs] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => {
      const element = video.current

      if (element) {
        setTimeMs(element.currentTime * 1000)
      }
    }, sessionConfig().timing.correctMs)

    return () => clearInterval(timer)
  }, [video])

  return timeMs
}

/** The caption block, playing under the picture it belongs to. */
export function DemoTranscriptGallery() {
  const video = useRef<HTMLVideoElement>(null)
  const [transcript, setTranscript] = useState<Transcript | null>(null)
  const [seekable, setSeekable] = useState(false)
  const timeMs = useMediaTime(video)
  // Spent once: after the opening seek the playhead belongs to whoever is
  // driving the video, and re-running it would drag them back to the top.
  const seeded = useRef(false)

  useEffect(() => {
    let live = true

    // Resolves to `null` rather than rejecting when the chunk cannot be
    // fetched, so there is nothing to catch here.
    loadTranscript(VIDEO.id).then(loaded => {
      if (live) {
        setTranscript(loaded)
      }
    })

    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    const element = video.current
    const lines = transcript?.lines ?? []

    if (seeded.current || !seekable || !element || lines.length === 0) {
      return
    }

    seeded.current = true
    // Start just before the first word rather than at zero: SOH opens with
    // half a minute of music, and a page that spends its first half minute
    // blank looks broken rather than faithful. Waits for metadata, because a
    // seek before that has nothing to seek in.
    element.currentTime = Math.max(0, lines[0].startMs - LEAD_IN_MS) / 1000
  }, [seekable, transcript])

  const handover = transcript && firstHandover(transcript)

  /** Move the video to `atMs`, clamped to the top of the clip. */
  const seek = (atMs: number) => {
    if (video.current) {
      video.current.currentTime = Math.max(0, atMs) / 1000
    }
  }

  /** Jump to the line `step` away from the one showing, if there is one. */
  const skip = (step: number) => {
    if (!transcript) {
      return
    }

    const { lines } = transcript
    // The last line that has come up, which is not the same as the last one
    // still showing: in a long silence nothing is on screen, and stepping
    // forward from there should go to the next line rather than back to the
    // one the hold expired on.
    const showing = lines.reduce(
      (found, line, index) =>
        line.startMs <= timeMs + DEFAULT_LEAD_MS ? index : found,
      -1,
    )
    const next = showing + step

    if (next >= 0 && next < lines.length) {
      // Landing exactly on the lead-in puts the line up with none of it lit,
      // which is where a line starts in the app too.
      seek(lines[next].startMs - DEFAULT_LEAD_MS)
    }
  }

  return (
    <main className={classNames(demo.shell, styles.page)}>
      <header className={styles.intro}>
        <h1 className={styles.title}>Follower captions</h1>
        {/* Deliberately not "the transcript for X": the same page has to read
            straight when `?video=` names one that has no words, and the stage
            below says so plainly enough without the lede having promised
            otherwise first. */}
        <p className={styles.lede}>
          Real transcripts, cut into lines by <code>core/transcript.ts</code>{' '}
          and drawn by the component a listener sees, at the column width they
          see it in. One row per speaker, so a voice coming in over another
          takes the row below rather than its place. The video is the clock, so
          the words should land on the shot they belong to; in the app that
          position comes from the audio the corrector is steering, on the same
          timeline. Playing <code>{VIDEO.id}</code> — switch with{' '}
          <code>?video=</code>.
        </p>
      </header>

      <div className={styles.stage}>
        {/* Deliberately not muted and not autoplaying: hearing the line while
            watching it light up is half of what this page is for, and no URL
            can unmute a video nobody has pressed play on. Native controls
            because scrubbing is the fastest way to find a moment, and only
            the element itself can offer it. */}
        <video
          className={styles.video}
          ref={video}
          src={VIDEO.videoUrl}
          controls
          playsInline
          preload="metadata"
          onLoadedMetadata={() => setSeekable(true)}
        />

        <div className={styles.captions}>
          {transcript ? (
            <DemoTranscript transcript={transcript} timeMs={timeMs} />
          ) : (
            <p className={styles.lede}>
              {hasTranscript(VIDEO.id)
                ? 'Loading the transcript…'
                : `No transcript for ${VIDEO.id}. Try ${CAPTIONED.map(
                    option => `?video=${option.id}`,
                  ).join(' or ')}.`}
            </p>
          )}
        </div>
      </div>

      <div className={styles.controls}>
        <button className={demo.ghost} onClick={() => skip(-1)}>
          ← Line
        </button>
        <button className={demo.ghost} onClick={() => skip(1)}>
          Line →
        </button>
        {handover !== null && (
          <button className={demo.ghost} onClick={() => seek(handover)}>
            Two speakers
          </button>
        )}
        <span className={styles.clock}>{timecode(timeMs)}</span>
      </div>
    </main>
  )
}
