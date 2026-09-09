import { activeLines, type Transcript } from '../../core/transcript'
import styles from './DemoTranscript.module.css'

type Props = {
  /** The words for whatever is playing. */
  transcript: Transcript
  /**
   * This device's audio position, in ms from the top of the media, or `null`
   * when nothing is playing — a paused or not-yet-started clip has no current
   * word, and showing the last one it had would be a lie.
   */
  timeMs: number | null
}

/**
 * The lines being spoken right now, one row per speaker, lighting up word by
 * word.
 *
 * It needs nothing from the wire. The screen already broadcasts where its
 * video is, and the corrector already puts this device's audio on that same
 * timeline to within a few milliseconds — so the local playhead, which is all
 * this reads, is as good a cue as a caption track would be and costs a beat no
 * extra bytes.
 *
 * A whole line arrives at once and dim, so a reader can see where the sentence
 * is going, and each word lifts to full strength as the voice reaches it. When
 * a second voice comes in over the first, it takes the row underneath rather
 * than the first one's place, and both rows are marked with the dash that
 * subtitles have always used to say "different person". The block holds a
 * fixed height whether one row is showing, two, or none, because the status
 * ring above it is the one thing on this view that must not move.
 */
export function DemoTranscript({ transcript, timeMs }: Props) {
  const rows = timeMs === null ? [] : activeLines(transcript, timeMs)
  // Only worth marking when there is something to tell apart: a lone speaker
  // with a dash in front of them reads as a list item, not as a voice.
  const marked = rows.length > 1

  return (
    /* A region rather than a live one, deliberately. The words are already
       being spoken into the listener's headphones, so a screen reader
       announcing each one as it lit would talk over the thing it is
       describing; labelled and reachable is what this owes. */
    <div className={styles.transcript} role="region" aria-label="Transcript">
      {rows.map(({ index, line, spoken }) => (
        // Keyed on the line's own index, so a row that is already up keeps its
        // element — and its place — when another speaker arrives under it, and
        // only the new row fades in.
        <p className={styles.line} key={index}>
          {marked && <span className={styles.dash}>– </span>}
          {line.words.map((word, position) => (
            <span
              className={styles.word}
              key={position}
              data-spoken={position < spoken || undefined}
            >
              {position > 0 ? ' ' : ''}
              {word.text}
            </span>
          ))}
        </p>
      ))}
    </div>
  )
}
