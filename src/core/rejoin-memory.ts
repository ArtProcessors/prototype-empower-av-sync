/**
 * The room a listener was in before a reload or a background tab-discard.
 *
 * Chrome discards backgrounded tabs during a long sleep; the reload lands on
 * the entry screen with the session gone. Remembering the room turns that into
 * one tap rather than a hunt for the code — and it is only a memory, not a
 * resumption: audio still needs a gesture, so a rejoin cannot be automatic.
 */
import { sessionConfig } from './config'
import { readStored, removeStored, writeStored } from './storage'

/** The room to offer a one-tap rejoin to, if any. */
export function readRejoinRoom(): string | null {
  return readStored('session', sessionConfig().storage.rejoinRoom)
}

/** Remember `roomCode` so a reload can offer to rejoin it. */
export function writeRejoinRoom(roomCode: string): void {
  writeStored('session', sessionConfig().storage.rejoinRoom, roomCode)
}

/** Forget the remembered room — a deliberate leave should not be re-offered. */
export function clearRejoinRoom(): void {
  removeStored('session', sessionConfig().storage.rejoinRoom)
}
