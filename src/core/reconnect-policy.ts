/**
 * When the follower's transport watchdog is allowed to spend a rejoin.
 *
 * Deliberately free of timers and transports: this is the part of the watchdog
 * that field testing paid for, and keeping it to arithmetic over the configured
 * timings is what makes it assertable in `test/sync-sim.ts` rather than only
 * observable on a phone after a ten-minute sleep.
 */
import { sessionConfig } from './config'

/**
 * Wait before the next rejoin attempt: the base interval doubled once per
 * consecutive failure, capped.
 *
 * Zero failures gives the plain base interval, which doubles as the grace
 * period a fresh join gets — a follower starts with `screenOnline: false` and
 * stays that way until the first beat lands, and without that grace the
 * watchdog read it as a dead link and tore the connection down about a second
 * after it was made, on every single join.
 *
 * @param failures consecutive rejoins that never produced a peer
 * @param hidden whether the page is hidden right now
 */
export function reconnectCooldownMs(
  failures: number,
  hidden: boolean,
): number {
  const timing = sessionConfig().timing
  const base = hidden
    ? timing.hiddenReconnectCooldownMs
    : timing.reconnectCooldownMs
  const ceiling = hidden
    ? timing.maxHiddenReconnectCooldownMs
    : timing.maxReconnectCooldownMs

  return Math.min(base * 2 ** failures, ceiling)
}

/**
 * Whether beats have stopped for long enough to presume the WebRTC link dead.
 *
 * A `lastBeatAt` of 0 means no beat has ever arrived, which is not staleness —
 * it is a join still in progress, and treating it as staleness is exactly how
 * a fresh session tears itself down.
 *
 * @param lastBeatAt follower-clock ms the last beat arrived (0 = none yet)
 * @param now current follower-clock ms
 */
export function transportIsStale(lastBeatAt: number, now: number): boolean {
  return (
    lastBeatAt > 0 &&
    now - lastBeatAt > sessionConfig().timing.transportStaleMs
  )
}
