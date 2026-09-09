/**
 * Whether this device wants the words on screen, remembered between visits.
 *
 * Captions are opt-in and stay opt-in: a room full of people looking at one
 * video does not need every phone lit up with text, and the listener who does
 * want it should not have to ask twice. The preference is this device's alone
 * — nothing about it goes on the wire — which is why it lives here rather than
 * in the session's own state.
 */
import { readStored, writeStored } from '../../core/storage'

/**
 * `localStorage` key holding the preference.
 *
 * Not in `core/config.ts` with the session's keys, because the session neither
 * sets nor reads it: showing captions is a property of this view, and the core
 * runs the same with them on or off.
 */
const STORAGE_KEY = 'empower.transcript'

/** Whether this device asked for captions last time it listened. */
export function readTranscriptPref(): boolean {
  return readStored('local', STORAGE_KEY) === '1'
}

/** Remember whether this device wants captions. */
export function writeTranscriptPref(on: boolean): void {
  writeStored('local', STORAGE_KEY, on ? '1' : '0')
}
