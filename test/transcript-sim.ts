/**
 * Unit checks for the transcript model: how a pipeline's file is cut into
 * lines, and which of those lines is on screen at a given moment.
 *
 * Both halves are pure, and both are easy to get subtly wrong in ways nobody
 * notices in a venue — a dropped word, a line that clears a beat too early, a
 * cursor that goes backwards over a loop. The real files are loaded rather
 * than fixtures, so the checks are against the shape the pipeline actually
 * emits: SOH for its long silences and its one late hand-over, Agent 327 for
 * the interruption sitting inside an utterance labelled with somebody else's
 * name.
 *
 * Read with `fs` rather than imported, because these run through Node's
 * type-stripping with no bundler and no JSON module resolution.
 *
 * Run: `node test/transcript-sim.ts` (Node 24 type-strip).
 */
import { readFileSync } from 'node:fs'

import {
  activeLines,
  buildTranscript,
  DEFAULT_CURSOR_TIMING,
  DEFAULT_LINE_LIMITS,
  MAX_SPEAKER_ROWS,
  type Transcript,
  type TranscriptSource,
} from '../src/core/transcript.ts'
import { assert, report } from './assert.ts'

/** Read one of the shipped transcripts straight off disk. */
function shipped(id: string): TranscriptSource {
  return JSON.parse(
    readFileSync(`src/content/transcripts/${id}.json`, 'utf8'),
  ) as TranscriptSource
}

const source = shipped('soh')
const transcript = buildTranscript(source)
const { lines } = transcript

/** Every word in the source, in order, as one string. */
const sourceWords = (source.utterances ?? []).flatMap(utterance =>
  utterance.words.map(word => word.text),
)

console.log('\n[1] buildTranscript — the real SOH file')
{
  assert(lines.length > 0, `cut into lines (got ${lines.length})`)

  const cutWords = lines.flatMap(line => line.words.map(word => word.text))

  assert(
    cutWords.join(' ') === sourceWords.join(' '),
    `every word survives the cut (${cutWords.length} of ${sourceWords.length})`,
  )

  const ordered = lines.every(
    (line, index) => index === 0 || lines[index - 1].startMs <= line.startMs,
  )

  assert(ordered, 'lines are in time order')

  const bounded = lines.every(
    line =>
      line.words.length > 0 &&
      line.startMs === line.words[0].startMs &&
      line.endMs === line.words[line.words.length - 1].endMs,
  )

  assert(bounded, "each line's span is its own first and last word")

  const short = lines.every(
    line =>
      line.words.length <= DEFAULT_LINE_LIMITS.maxWords &&
      // One word longer than the limit is still one line: there is nowhere
      // else to put it.
      (line.words.length === 1 ||
        line.words.map(word => word.text).join(' ').length <=
          DEFAULT_LINE_LIMITS.maxChars),
  )

  assert(short, 'no line exceeds the word or character limits')

  const unpaused = lines.every(line =>
    line.words.every(
      (word, index) =>
        index === 0 ||
        word.startMs - line.words[index - 1].endMs < DEFAULT_LINE_LIMITS.gapMs,
    ),
  )

  assert(unpaused, 'no line spans a pause long enough to break it')

  const speakers = new Set(lines.map(line => line.speaker))

  assert(
    speakers.size === 5,
    `speaker labels are kept (got ${[...speakers].sort().join('')})`,
  )
}

console.log('\n[2] buildTranscript — a speaker changing mid-utterance')
{
  // A pipeline groups words into an utterance by turn but diarises them one at
  // a time, so the utterance's own label is not a promise that one person said
  // all of it. This is the exact shape that used to come out as a single line
  // reading "Haircut? But please." under one name.
  const interrupted = buildTranscript({
    utterances: [
      {
        speaker: 'A',
        words: [
          { text: 'Haircut?', start: 55880, end: 56269, speaker: 'B' },
          { text: 'But', start: 56318, end: 56545, speaker: 'A' },
          { text: 'please.', start: 56545, end: 56935, speaker: 'A' },
        ],
      },
    ],
  })
  const said = (line: { words: readonly { text: string }[] }) =>
    line.words.map(word => word.text).join(' ')

  assert(
    interrupted.lines.length === 2,
    `the hand-over breaks the line (got ${interrupted.lines.length})`,
  )
  assert(
    interrupted.lines[0].speaker === 'B' &&
      said(interrupted.lines[0]) === 'Haircut?',
    'the interrupting word is a line of its own, under the name that said it',
  )
  assert(
    interrupted.lines[1].speaker === 'A' &&
      said(interrupted.lines[1]) === 'But please.',
    "and the reply keeps the utterance's own label",
  )
  assert(
    activeLines(interrupted, 56400).length === 2,
    'both are on screen together, a row each',
  )

  // A break with no minimum: every other rule holds a fragment back until it
  // is worth stranding, but two voices never share a line however short one
  // of them is.
  assert(
    interrupted.lines[0].words.length === 1,
    'a one-word interruption still gets its own line',
  )

  const undiarised = buildTranscript({
    utterances: [
      {
        speaker: 'A',
        words: [
          { text: 'One', start: 0, end: 100 },
          { text: 'two.', start: 100, end: 200 },
        ],
      },
    ],
  })

  assert(
    undiarised.lines.length === 1 && undiarised.lines[0].speaker === 'A',
    "a word carrying no label of its own takes the utterance's",
  )

  // The same rule over the real files, word by word: whoever the source says
  // said a word, that is the name on the line it lands in.
  const attributed = (id: string) => {
    const file = shipped(id)
    const voices = (file.utterances ?? []).flatMap(utterance =>
      utterance.words
        .filter(word => word.text.trim().length > 0)
        .map(word => word.speaker ?? utterance.speaker ?? ''),
    )

    let at = 0

    for (const line of buildTranscript(file).lines) {
      for (const word of line.words) {
        if (voices[at] !== line.speaker) {
          console.log(
            `    ${id}: "${word.text}" is ${voices[at]}, not ${line.speaker}`,
          )

          return false
        }

        at += 1
      }
    }

    return at === voices.length
  }

  assert(attributed('soh'), 'no line in SOH mixes two speakers')
  assert(attributed('agent327'), 'no line in Agent 327 mixes two speakers')
}

console.log('\n[3] activeLines — before, during and after the words')
{
  const first = lines[0]
  const { leadMs, holdMs } = DEFAULT_CURSOR_TIMING

  /** The one row `timeMs` should be showing, or `null` for none. */
  const only = (timeMs: number) => {
    const rows = activeLines(transcript, timeMs)

    return rows.length === 1 ? rows[0] : null
  }

  assert(
    activeLines(transcript, 0).length === 0,
    'nothing shows over the silence before the first word',
  )
  assert(
    activeLines(transcript, first.startMs - leadMs - 1).length === 0,
    'and nothing shows a moment before the lead-in',
  )

  const early = only(first.startMs - leadMs + 1)

  assert(
    early?.index === 0 && early.spoken === 0,
    'the first line arrives early, with none of it lit',
  )

  const opening = only(first.startMs)

  assert(
    opening?.index === 0 && opening.spoken === 1,
    'its first word lights as it is spoken',
  )

  const midway = only(first.words[2].startMs)

  assert(
    midway?.index === 0 && midway.spoken === 3,
    `three words in, three are lit (got ${midway?.spoken})`,
  )

  const last = lines[lines.length - 1]

  assert(
    only(last.endMs + holdMs - 1)?.index === lines.length - 1,
    'the last line is held after its final word',
  )
  assert(
    activeLines(transcript, last.endMs + holdMs + 1).length === 0,
    'and clears once the hold is up',
  )
}

console.log('\n[4] activeLines — one row per speaker, oldest on top')
{
  const { holdMs } = DEFAULT_CURSOR_TIMING

  // The SOH file hands over once inside the hold: E's "Excuse me." at 736939
  // and B's "What?" at 737343, about four tenths of a second apart.
  const handover = lines.findIndex(
    (line, index) =>
      index > 0 &&
      line.speaker !== lines[index - 1].speaker &&
      line.startMs <= lines[index - 1].endMs + holdMs,
  )

  assert(
    handover > 0,
    `the file hands over inside the hold (line ${handover})`,
  )

  const rows = activeLines(transcript, lines[handover].startMs)

  assert(rows.length === 2, `both voices are up (got ${rows.length} row(s))`)
  assert(
    rows[0].index === handover - 1 && rows[1].index === handover,
    'the voice already showing keeps the top row, the new one takes the next',
  )
  assert(
    rows[0].line.speaker !== rows[1].line.speaker,
    'the two rows are different speakers',
  )
  assert(
    rows[0].spoken === rows[0].line.words.length && rows[1].spoken === 1,
    'the finished line is fully lit while the arriving one has just started',
  )

  // Once the outgoing voice's hold is up it drops away, leaving one row.
  const alone = activeLines(transcript, lines[handover - 1].endMs + holdMs + 1)

  assert(
    alone.length === 1 && alone[0].index === handover,
    'and the first row falls away when its hold expires, not before',
  )

  const stacked = lines.reduce(
    (most, _, index) =>
      Math.max(most, activeLines(transcript, lines[index].startMs).length),
    0,
  )

  assert(
    stacked <= MAX_SPEAKER_ROWS,
    `never more than ${MAX_SPEAKER_ROWS} rows at once (most was ${stacked})`,
  )

  const oneEach = lines.every(line => {
    const speakers = activeLines(transcript, line.startMs).map(
      row => row.line.speaker,
    )

    return new Set(speakers).size === speakers.length
  })

  assert(oneEach, 'a speaker never holds two rows at once')
}

console.log('\n[5] activeLines — over a long silence, and over a loop')
{
  // The SOH file has minutes of music between utterances; the gap either side
  // of the second line's start is the one this leans on.
  const gap = lines.findIndex(
    (line, index) =>
      index > 0 && line.startMs - lines[index - 1].endMs > 30_000,
  )

  assert(gap > 0, `the file has a long silence to test (line ${gap})`)

  const before = lines[gap - 1]

  assert(
    activeLines(transcript, before.endMs + DEFAULT_CURSOR_TIMING.holdMs + 1)
      .length === 0,
    'a line before a long silence clears rather than sitting there for minutes',
  )

  const resumed = activeLines(transcript, lines[gap].startMs)

  assert(
    resumed.length === 1 && resumed[0].index === gap,
    'and the next line takes over, alone, when its own words arrive',
  )

  // A looping video sends the playhead back to the top, and a resync can move
  // it either way. The reading is derived from the time alone, so both are
  // simply a smaller number — nothing to reset, nothing to go stale.
  assert(
    activeLines(transcript, 0).length === 0 &&
      activeLines(transcript, lines[0].startMs)[0]?.index === 0,
    'the reading follows the playhead backwards, over a loop or a resync',
  )
}

console.log('\n[6] buildTranscript — degenerate input')
{
  const empty: Transcript = buildTranscript({})

  assert(empty.lines.length === 0, 'a file with no utterances yields no lines')
  assert(
    activeLines(empty, 1000).length === 0,
    'and asking an empty transcript for a line is not an error',
  )
  assert(
    buildTranscript({ utterances: [{ speaker: 'A', words: [] }] }).lines
      .length === 0,
    'an utterance with no words yields no line to render',
  )
  assert(
    activeLines(transcript, Number.NaN).length === 0,
    'an unreadable playhead shows nothing rather than the first line',
  )
}

report()
