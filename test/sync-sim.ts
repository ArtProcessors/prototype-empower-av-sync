/**
 * Unit checks for the pure sync math and the pure session policy.
 *
 * The session half exists because the reconnect backoff and the staleness rule
 * were paid for by field testing — a ten-minute Android sleep is the only other
 * way to find out they moved. Asserting the exact numbers here means a refactor
 * that shifts them fails in a second rather than in a venue.
 *
 * Run: `node test/sync-sim.ts` (Node 24 type-strip).
 */
import {
  reconnectCooldownMs,
  transportIsStale,
} from '../src/core/reconnect-policy.ts'
import { assert, close, report } from './assert.ts'
import { summariseDiagnostics } from '../src/diagnostics/summary.ts'
import type { DiagnosticEvent } from '../src/diagnostics/session-log.ts'
import { joinUrl, roomCodeFromSearch } from '../src/core/join-link.ts'
import { sessionConfig } from '../src/core/config.ts'
import {
  isRoomCodeAcceptable,
  makeRoomCode,
  maxRoomCodeLength,
  normaliseRoomCode,
} from '../src/core/room-code.ts'
import {
  estimateOffset,
  bestOffset,
  computeTarget,
  signedDrift,
  correctionRate,
  type Beat,
} from '../src/sync/sync-math.ts'

console.log('\n[1] estimateOffset (Cristian) + bestOffset')
{
  const sample = estimateOffset(1000, 5000, 1040)
  assert(close(sample.rtt, 40), `rtt = 40 (got ${sample.rtt})`)
  assert(close(sample.offset, 3980), `offset = 3980 (got ${sample.offset})`)

  const best = bestOffset([
    { rtt: 120, offset: 900 },
    { rtt: 30, offset: 1000 },
    { rtt: 80, offset: 950 },
  ])
  assert(
    best!.rtt === 30 && best!.offset === 1000,
    'bestOffset picks lowest-RTT sample',
  )
  assert(bestOffset([]) === null, 'bestOffset([]) === null')
}

console.log('\n[2] computeTarget (extrapolation + loop wrap)')
{
  const beat: Beat = {
    mediaId: 'test',
    videoTime: 5,
    wall: 1000,
    playing: true,
    duration: 20,
  }
  assert(close(computeTarget(beat, 0, 1700), 5.7), 'linear: 5 + 0.7s = 5.7')

  const nearEnd: Beat = { ...beat, videoTime: 19.5 }
  assert(
    close(computeTarget(nearEnd, 0, 1700), 0.2, 1e-6),
    'wrap: 19.5 + 0.7 = 0.2',
  )
  assert(
    close(computeTarget(nearEnd, 300, 1700), 0.5, 1e-6),
    'clock offset applied (+0.3s)',
  )

  const paused: Beat = { ...beat, videoTime: 12.3, playing: false }
  assert(
    close(computeTarget(paused, 0, 9999), 12.3),
    'paused: stays at videoTime',
  )
}

console.log('\n[3] signedDrift (loop-aware, sign = local relative to target)')
{
  assert(close(signedDrift(5.0, 4.7, 20), 0.3), 'ahead by 0.3 → +0.3')
  assert(close(signedDrift(4.7, 5.0, 20), -0.3), 'behind by 0.3 → -0.3')

  // Local just before the wrap, target just after → local is BEHIND by 0.2
  // (not ahead by 19.8).
  const acrossSeam = signedDrift(19.9, 0.1, 20)
  assert(
    close(acrossSeam, -0.2, 1e-6),
    `loop seam: 19.9 vs 0.1 → -0.2 (got ${acrossSeam.toFixed(3)})`,
  )

  const backAcrossSeam = signedDrift(0.1, 19.9, 20)
  assert(
    close(backAcrossSeam, 0.2, 1e-6),
    `loop seam other way: 0.1 vs 19.9 → +0.2 (got ${backAcrossSeam.toFixed(3)})`,
  )
}

console.log('\n[4] correctionRate (sign + clamp)')
{
  assert(close(correctionRate(0), 1), 'no drift → rate 1')
  assert(correctionRate(0.05) < 1, 'ahead → slow down (<1)')
  assert(correctionRate(-0.05) > 1, 'behind → speed up (>1)')
  assert(close(correctionRate(0.05), 0.96), 'small ahead: 1 - 0.05*0.8 = 0.96')
  assert(correctionRate(5) === 0.94, 'large ahead clamps to 0.94')
  assert(correctionRate(-5) === 1.06, 'large behind clamps to 1.06')
}

console.log('\n[5] reconnectCooldownMs (watchdog backoff)')
{
  assert(reconnectCooldownMs(0, false) === 10000, 'visible, 0 failures = 10s')
  assert(reconnectCooldownMs(1, false) === 20000, 'visible, 1 failure = 20s')
  assert(reconnectCooldownMs(2, false) === 40000, 'visible, 2 failures = 40s')
  assert(reconnectCooldownMs(3, false) === 60000, 'visible clamps to 60s')
  assert(reconnectCooldownMs(9, false) === 60000, 'visible stays at 60s')

  assert(reconnectCooldownMs(0, true) === 45000, 'hidden, 0 failures = 45s')
  assert(reconnectCooldownMs(1, true) === 90000, 'hidden, 1 failure = 90s')
  assert(reconnectCooldownMs(2, true) === 180000, 'hidden, 2 failures = 180s')
  assert(reconnectCooldownMs(3, true) === 300000, 'hidden clamps to 300s')
  assert(reconnectCooldownMs(9, true) === 300000, 'hidden stays at 300s')

  assert(
    reconnectCooldownMs(0, true) > reconnectCooldownMs(0, false),
    'hidden is always the more patient of the two',
  )
}

console.log('\n[6] transportIsStale')
{
  const now = 1_000_000

  assert(
    transportIsStale(0, now) === false,
    'no beat yet (0) is a join in progress, not staleness',
  )
  assert(transportIsStale(now - 5999, now) === false, '5.999s is not stale')
  assert(transportIsStale(now - 6000, now) === false, '6.000s is not stale')
  assert(transportIsStale(now - 6001, now) === true, '6.001s is stale')
}

console.log('\n[7] room codes')
{
  assert(normaliseRoomCode(' k7qf ') === 'K7QF', 'trimmed and upper-cased')
  assert(normaliseRoomCode('') === '', 'empty stays empty')

  assert(isRoomCodeAcceptable('ab') === false, '2 chars is too short')
  assert(isRoomCodeAcceptable('abc') === true, '3 chars is the minimum')
  assert(isRoomCodeAcceptable('  abc  ') === true, 'padding does not count')
  assert(isRoomCodeAcceptable('abcdefgh') === true, '8 chars is accepted')

  assert(
    isRoomCodeAcceptable('abcdefghi') === true,
    "over-length is the input field's business, not the policy's",
  )
  assert(maxRoomCodeLength() === 8, 'the input field caps at 8')

  const { length } = sessionConfig().roomCode
  const generated = Array.from({ length: 200 }, () => makeRoomCode())

  assert(
    generated.every(code => code.length === length),
    `generated codes are ${length} chars`,
  )
  assert(
    generated.every(code => !/[01OI]/.test(code)),
    'generated codes avoid the ambiguous glyphs 0 O 1 I',
  )
  assert(
    generated.every(code => normaliseRoomCode(code) === code),
    'generated codes are already in canonical form',
  )
}

console.log('\n[8] join links (build ↔ parse are inverses)')
{
  const at = { origin: 'https://sync.example', pathname: '/app/' }

  assert(
    joinUrl('K7QF', at) === 'https://sync.example/app/?room=K7QF',
    'built from origin + pathname only',
  )
  assert(
    roomCodeFromSearch(new URL(joinUrl('K7QF', at)).search) === 'K7QF',
    'round-trips through the query string',
  )

  // A screen that itself arrived through a join link must not put that older
  // code into its own QR — hence origin + pathname, never the live query.
  assert(
    joinUrl('NEW9', at) === 'https://sync.example/app/?room=NEW9',
    'the current query is not carried over',
  )

  assert(roomCodeFromSearch('') === null, 'no ?room= at all is null')
  assert(roomCodeFromSearch('?other=1') === null, 'a different param is null')
  assert(
    roomCodeFromSearch('?room=') === '',
    'an explicit but blank ?room= is empty, NOT null — so it still wins ' +
      'over a remembered room instead of falling back to it',
  )
  assert(
    roomCodeFromSearch('?room=k7qf') === 'K7QF',
    'parsed code is normalised',
  )
}

console.log('\n[9] diagnostics summary (tags, and the wording fallback)')
{
  const at = (over: Partial<DiagnosticEvent>): DiagnosticEvent => ({
    at: 0,
    category: 'page',
    message: '',
    hidden: false,
    ...over,
  })

  const tagged = summariseDiagnostics([
    at({
      category: 'page',
      message: 'FROZEN by the browser',
      tag: 'page-frozen',
    }),
    at({ category: 'peer', message: 'LEAVE abc123', tag: 'peer-leave' }),
    at({ category: 'peer', message: 'LEAVE def456', tag: 'peer-leave' }),
    at({
      category: 'transport',
      message: 'rejoining room K7QF… (attempt 1)',
      tag: 'transport-rejoin',
    }),
    at({
      category: 'timer',
      message: 'liveness gap 3.4s — timers stalled',
      tag: 'timer-stall',
      value: 3.4,
    }),
    at({
      category: 'timer',
      message: 'liveness gap 1.2s — timers stalled',
      tag: 'timer-stall',
      value: 1.2,
    }),
  ])

  assert(tagged.freezes === 1, 'counts a tagged freeze')
  assert(tagged.peerLeaves === 2, 'counts tagged peer leaves')
  assert(tagged.rejoins === 1, 'counts a tagged rejoin')
  assert(close(tagged.longestStallSec, 3.4), 'keeps the longest tagged stall')

  // Events restored from sessionStorage after a deploy carry no tag; the
  // wording fallback is what stops a sleep test spanning one summarising as
  // zero.
  const legacy = summariseDiagnostics([
    at({ category: 'page', message: 'FROZEN by the browser' }),
    at({ category: 'peer', message: 'LEAVE abc123' }),
    at({ category: 'transport', message: 'rejoining room K7QF… (attempt 1)' }),
    at({ category: 'timer', message: 'liveness gap 7.5s — timers stalled' }),
  ])

  assert(legacy.freezes === 1, 'falls back to wording for an untagged freeze')
  assert(legacy.peerLeaves === 1, 'falls back for an untagged peer leave')
  assert(legacy.rejoins === 1, 'falls back for an untagged rejoin')
  assert(
    close(legacy.longestStallSec, 7.5),
    'falls back for an untagged stall',
  )

  // The outcome line each rejoin also emits must not double the count.
  const withOutcomes = summariseDiagnostics([
    at({
      category: 'transport',
      message: 'rejoining room K7QF… (attempt 1)',
      tag: 'transport-rejoin',
    }),
    at({
      category: 'transport',
      message: 'room rebuilt in 1.2s — awaiting peers',
    }),
    at({ category: 'transport', message: 'rejoin FAILED after 8.0s — nope' }),
  ])

  assert(
    withOutcomes.rejoins === 1,
    'outcome lines are not counted as attempts',
  )
  assert(
    summariseDiagnostics([]).longestStallSec === 0,
    'an empty log summarises as zeroes',
  )
}

report()
