/**
 * The listener join link: built by the screen for its QR code, and read back
 * by the landing view when someone arrives through it.
 *
 * The two halves were previously written independently in two views, with no
 * shared name for the query parameter and no test that they were inverses.
 *
 * Scope note: this covers the *room code* only. The engine tuning knobs
 * (`?sinklat=`, `?runway=`, `?kagain=` in `streaming-buffer-engine.ts`) are
 * read once at module-evaluation time and stay there deliberately — reading
 * them lazily would let a value change underneath a running session.
 */
import { normaliseRoomCode } from './room-code'

/** Query parameter carrying the room code in a listener join link. */
export const ROOM_QUERY_PARAM = 'room'

/**
 * The URL a listener scans to join `roomCode`.
 *
 * Deliberately `origin + pathname` only: dropping the current query means a
 * screen that itself arrived through a join link does not put that older code
 * into its own QR.
 */
export function joinUrl(
  roomCode: string,
  from: { origin: string; pathname: string } = window.location,
): string {
  return `${from.origin}${from.pathname}?${ROOM_QUERY_PARAM}=${roomCode}`
}

/**
 * The room code a join link carries, or `null` if there is no `?room=` at all.
 *
 * Note the distinction between absent and empty: `?room=` present but blank
 * returns `''`, not `null`, so an explicit empty link still wins over a
 * remembered room rather than silently falling back to it.
 */
export function roomCodeFromSearch(search: string): string | null {
  const value = new URLSearchParams(search).get(ROOM_QUERY_PARAM)

  return value === null ? null : normaliseRoomCode(value)
}
