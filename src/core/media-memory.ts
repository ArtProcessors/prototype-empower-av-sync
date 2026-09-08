/**
 * The video this device last led with, so a screen that reboots comes back on
 * the same content without anyone touching it.
 *
 * Sibling of `rejoin-memory.ts` and deliberately the weaker of the two: that
 * one remembers a room for one page load (`sessionStorage`), because a room
 * dies with the screen that made it. A permanently installed display outlives
 * its power cut, so this is `localStorage` — the point is a device that is set
 * up once and then only ever switched on.
 *
 * Written when a screen actually starts leading, not when the picker moves: a
 * browse that never became a session should not decide what the next boot
 * plays.
 *
 * This is the lowest-priority answer to "what plays". A launch URL naming a
 * video (see `ui/launch-intent.ts`) overrides it, because a link someone typed
 * today beats a memory from whenever.
 */
import { sessionConfig } from './config'
import { readStored, writeStored } from './storage'

/** The video this device last led with, or `null` if it never has. */
export function readLedVideo(): string | null {
  return readStored('local', sessionConfig().storage.ledVideo)
}

/** Remember `id` as what this device leads with from now on. */
export function writeLedVideo(id: string): void {
  writeStored('local', sessionConfig().storage.ledVideo, id)
}
