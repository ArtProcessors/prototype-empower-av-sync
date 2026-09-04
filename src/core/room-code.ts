/**
 * Room-code identity: how one is generated, how typed input is canonicalised,
 * and what counts as long enough to try.
 *
 * The length bounds used to live in the landing view, which meant the session
 * would happily join a code the UI would have refused — and any second UI
 * would have had to rediscover them. The alphabet and the bounds are now
 * policy; see `config.ts`.
 */
import { sessionConfig } from './config'

/** Generate a fresh room code for a screen to lead with. */
export function makeRoomCode(
  length = sessionConfig().roomCode.length,
): string {
  const { alphabet } = sessionConfig().roomCode
  const values = new Uint32Array(length)

  crypto.getRandomValues(values)

  return Array.from(values, value => alphabet[value % alphabet.length]).join(
    '',
  )
}

/** Canonical form of a code typed, pasted or read out of a link. */
export function normaliseRoomCode(code: string): string {
  return code.trim().toUpperCase()
}

/** Whether a code is worth attempting a join with. */
export function isRoomCodeAcceptable(code: string): boolean {
  return normaliseRoomCode(code).length >= sessionConfig().roomCode.minLength
}

/** Longest code a text field should accept. */
export function maxRoomCodeLength(): number {
  return sessionConfig().roomCode.maxLength
}
