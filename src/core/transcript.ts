/**
 * Word-timed transcripts, and where a playhead sits in one.
 *
 * A follower already knows, to within a few milliseconds, where the screen's
 * media is — that is the whole point of the sync engine. Given a transcript on
 * the same timeline, that same reading says which word is being spoken right
 * now, so captions come free: no second stream, no extra beat, nothing on the
 * wire at all.
 *
 * The source shape is whatever the transcription pipeline emits — utterances
 * of timed words, with speaker labels — and is deliberately read loosely: only
 * the fields below are touched, so a file carrying confidences, alternatives
 * or a top-level `text` drops in unedited.
 *
 * Everything here is pure and platform-free. Turning a reading into something
 * readable is the view's job; this only answers "which words, and how far
 * through them".
 */

/** One word, and the window it is spoken in. */
export interface TranscriptWord {
  /** The word as transcribed, trailing punctuation included. */
  text: string
  /** When it starts, in ms from the top of the media. */
  startMs: number
  /** When it ends, in ms from the top of the media. */
  endMs: number
}

/**
 * One line as it will be shown: a short run of words from a single speaker,
 * cut to something a phone can hold without wrapping into a paragraph.
 */
export interface TranscriptLine {
  /** Speaker label the source diarised this run to, e.g. `'A'`. */
  speaker: string
  /** The line's words, in order. Never empty. */
  words: readonly TranscriptWord[]
  /** When the first word starts, in ms. */
  startMs: number
  /** When the last word ends, in ms. */
  endMs: number
}

/** A whole transcript, already cut into displayable lines. */
export interface Transcript {
  /** Lines in time order. Never overlapping, and never empty of words. */
  lines: readonly TranscriptLine[]
}

/** One word as the transcription pipeline emits it. */
export interface SourceWord {
  /** The word as transcribed. */
  text: string
  /** When it starts, in ms from the top of the media. */
  start: number
  /** When it ends, in ms from the top of the media. */
  end: number
  /** Speaker label, when the pipeline diarised. */
  speaker?: string | null
}

/** One run of speech from a single speaker, as the pipeline emits it. */
export interface SourceUtterance {
  /** Speaker label, when the pipeline diarised. */
  speaker?: string | null
  /** The utterance's words, in order. */
  words: readonly SourceWord[]
}

/** A transcription file, narrowed to the parts that are read. */
export interface TranscriptSource {
  /** Runs of speech, in time order. */
  utterances?: readonly SourceUtterance[]
}

/**
 * Where a line is allowed to be broken.
 *
 * An utterance can run for half a minute — far too much to put on a phone at
 * once — so it is cut into lines that can be read at a glance and replaced as
 * the speech moves on. The limits are what "at a glance" means here.
 */
export interface LineLimits {
  /**
   * Longest a line may get, in characters. Sized so two of these fit the
   * caption column on a narrow phone without a third wrap.
   */
  maxChars: number
  /** Most words a line may hold, whatever their length. */
  maxWords: number
  /**
   * Silence between two words that ends the line, in ms. A pause this long
   * reads as a new thought, and holding the words either side of it on one
   * line makes the second half arrive late.
   */
  gapMs: number
}

/** Line limits used unless a caller says otherwise. */
export const DEFAULT_LINE_LIMITS: LineLimits = {
  maxChars: 38,
  maxWords: 10,
  gapMs: 1_200,
}

/**
 * How long a line stays up after its last word, in ms.
 *
 * Long enough to finish reading a line that lands just before a pause, short
 * enough that a quiet stretch is not spent staring at a stale caption. A line
 * followed closely by another is replaced rather than held, so this only ever
 * applies to the last line before a gap.
 */
export const DEFAULT_HOLD_MS = 2_500

/**
 * How long before its first word a line appears, in ms.
 *
 * Captions that arrive exactly on the word are read a beat behind the audio,
 * because reading takes time; showing the line a moment early — with none of
 * it highlighted yet — puts the reader level with the speaker instead.
 */
export const DEFAULT_LEAD_MS = 400

/** Whether a word ends a sentence, and so is a natural place to break. */
function endsSentence(text: string): boolean {
  return /[.!?…]["')\]]?$/.test(text)
}

/**
 * Cut one utterance into displayable lines.
 *
 * Breaks are taken at the first opportunity that keeps a line readable: a
 * pause, a finished sentence, or simply running out of room. Sentence ends
 * only break once there is something worth leaving behind, so "What?" does not
 * become a line of its own between two long ones.
 */
function linesFromUtterance(
  utterance: SourceUtterance,
  limits: LineLimits,
): TranscriptLine[] {
  const speaker = utterance.speaker ?? ''
  const lines: TranscriptLine[] = []

  let current: TranscriptWord[] = []
  let chars = 0

  const flush = () => {
    if (current.length === 0) {
      return
    }

    lines.push({
      speaker,
      words: current,
      startMs: current[0].startMs,
      endMs: current[current.length - 1].endMs,
    })
    current = []
    chars = 0
  }

  utterance.words.forEach(source => {
    const word: TranscriptWord = {
      text: source.text,
      startMs: source.start,
      endMs: source.end,
    }
    const previous = current[current.length - 1]

    if (previous) {
      const wouldOverflow =
        chars + 1 + word.text.length > limits.maxChars ||
        current.length >= limits.maxWords
      const paused = word.startMs - previous.endMs >= limits.gapMs
      // Two words is the shortest fragment worth stranding on its own line;
      // below that a break costs more than it buys.
      const settled = endsSentence(previous.text) && current.length >= 2

      if (wouldOverflow || paused || settled) {
        flush()
      }
    }

    chars += current.length === 0 ? word.text.length : word.text.length + 1
    current.push(word)
  })

  flush()

  return lines
}

/**
 * Build a displayable transcript from a transcription file.
 *
 * Utterances always break — a new speaker is a new line however short the last
 * one was — and each is then cut by {@link LineLimits}. Words with no text and
 * utterances with no words are dropped rather than producing empty lines the
 * view would have to guard against.
 *
 * @param source the pipeline's output
 * @param limits where lines may be broken, defaulting to
 *   {@link DEFAULT_LINE_LIMITS}
 */
export function buildTranscript(
  source: TranscriptSource,
  limits: LineLimits = DEFAULT_LINE_LIMITS,
): Transcript {
  const lines: TranscriptLine[] = []

  ;(source.utterances ?? []).forEach(utterance => {
    const words = (utterance.words ?? []).filter(
      word => word.text.trim().length > 0,
    )

    if (words.length === 0) {
      return
    }

    lines.push(...linesFromUtterance({ ...utterance, words }, limits))
  })

  // Sorted rather than trusted: nothing downstream re-checks the order, and
  // the search below is a binary one, so a file whose utterances arrive out
  // of sequence would silently show the wrong words.
  lines.sort((first, second) => first.startMs - second.startMs)

  return { lines }
}

/** One line on screen, and how far through it the speech has got. */
export interface ActiveLine {
  /**
   * Index into {@link Transcript.lines}. Unique and stable, so a view can key
   * a row on it and keep that row in place while the one under it changes.
   */
  index: number
  /** The line itself. */
  line: TranscriptLine
  /**
   * How many of its words have started, `0` through `words.length`. `0` while
   * the line is showing early — see {@link DEFAULT_LEAD_MS}.
   */
  spoken: number
}

/**
 * How many speakers may hold the block at once.
 *
 * Two, because two is what a hand-over sounds like: one voice finishing as the
 * next starts, both worth reading. A third would push the block deep enough to
 * matter on a phone and would be gone before it was read, so the oldest row
 * drops off instead.
 */
export const MAX_SPEAKER_ROWS = 2

/** Index of the last line starting at or before `timeMs`, or `-1`. */
function lastLineStartedBy(
  lines: readonly TranscriptLine[],
  timeMs: number,
): number {
  let low = 0
  let high = lines.length - 1
  let found = -1

  while (low <= high) {
    const middle = (low + high) >> 1

    if (lines[middle].startMs <= timeMs) {
      found = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }

  return found
}

/** How many of `line`'s words have started by `timeMs`. */
function spokenBy(line: TranscriptLine, timeMs: number): number {
  let spoken = 0

  while (spoken < line.words.length && line.words[spoken].startMs <= timeMs) {
    spoken += 1
  }

  return spoken
}

/** How a reading is timed around the words themselves. */
export interface CursorTiming {
  /** How long a line stays up past its last word, in ms. */
  holdMs: number
  /** How long before its first word a line appears, in ms. */
  leadMs: number
}

/** Cursor timing used unless a caller says otherwise. */
export const DEFAULT_CURSOR_TIMING: CursorTiming = {
  holdMs: DEFAULT_HOLD_MS,
  leadMs: DEFAULT_LEAD_MS,
}

/**
 * The lines on screen at `timeMs`, oldest first, and how much of each has been
 * spoken.
 *
 * One row per speaker, never more than {@link MAX_SPEAKER_ROWS}. A speaker's
 * next line replaces their last on the row they already have; a *different*
 * speaker coming in while the first is still up gets a row of their own under
 * it. Ordering by start time is what makes that stable — the voice already on
 * screen stays where it is and the new one appears beneath, rather than the
 * two swapping places every time the turn changes.
 *
 * Binary search rather than a scan or a remembered position, because the
 * playhead does not only move forward: a resync repositions the audio, and a
 * looping video sends it back to the top. A reading derived from the time
 * alone cannot be left stale by either.
 *
 * @param transcript the lines to look in
 * @param timeMs the media position, in ms from the top
 * @param timing how the reading is timed around the words, defaulting to
 *   {@link DEFAULT_CURSOR_TIMING}
 */
export function activeLines(
  transcript: Transcript,
  timeMs: number,
  timing: CursorTiming = DEFAULT_CURSOR_TIMING,
): ActiveLine[] {
  const { lines } = transcript

  if (lines.length === 0 || !Number.isFinite(timeMs)) {
    return []
  }

  // The lead is spent on the search, not on the highlight: it decides which
  // line is up, while `spoken` still counts against the real playhead, so a
  // line that arrives early arrives with nothing lit.
  const newest = lastLineStartedBy(lines, timeMs + timing.leadMs)

  if (newest < 0) {
    return []
  }

  const rows: ActiveLine[] = []
  const speakers = new Set<string>()

  for (let index = newest; index >= 0; index -= 1) {
    const line = lines[index]

    // Walking back ends at the first line whose time is up — everything
    // before it is older still. On the newest line this is the plain "nothing
    // is being said" case, and the loop stops before its first row.
    if (timeMs > line.endMs + timing.holdMs) {
      break
    }

    if (speakers.has(line.speaker)) {
      continue
    }

    speakers.add(line.speaker)
    rows.push({ index, line, spoken: spokenBy(line, timeMs) })

    if (rows.length === MAX_SPEAKER_ROWS) {
      break
    }
  }

  return rows.reverse()
}
