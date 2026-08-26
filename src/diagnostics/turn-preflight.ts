/**
 * Checks that Cloudflare's TURN service is actually usable, once per page load.
 *
 * This build relays every connection, which makes TURN a single point of
 * failure — and its most likely failure mode is silent. Cloudflare's
 * credentials are short-lived, and an expired pair does not produce an obvious
 * authentication error anywhere the user can see: ICE simply gathers no
 * candidates and peers sit in `checking` until something times out. The
 * per-peer monitor cannot report it either, since it only attaches once a peer
 * has connected — which, in this failure, never happens.
 *
 * So we allocate a relay candidate up front and write the verdict to the log.
 * On a phone after a failed session that one line is the difference between
 * "the credentials expired" and an afternoon of guessing.
 */
import { describeIceConfig, getRtcConfig } from '../transport/ice-config'
import { recordDiagnostic } from './session-log'

/** How long to wait for candidates before reporting what was gathered. */
const PREFLIGHT_TIMEOUT_MS = 5000

/** Ensures the preflight runs once per page load, not once per React effect. */
let started = false

/**
 * Allocate a TURN relay candidate and record whether it worked. Fire-and-forget:
 * it never throws and never blocks joining a room.
 */
export async function preflightTurn(): Promise<void> {
  if (started) {
    return
  }

  started = true

  let rtcConfig: RTCConfiguration

  try {
    rtcConfig = await getRtcConfig()
  } catch (caught) {
    // No credentials means no candidates at all in this build, so say so here
    // rather than leaving a join to fail with nothing in the log.
    recordDiagnostic(
      'ice',
      'turn preflight FAILED — no credentials: ' +
        `${caught instanceof Error ? caught.message : String(caught)}`,
    )

    return
  }

  const connection = new RTCPeerConnection(rtcConfig)
  const relayProtocols = new Set<string>()
  const errors = new Set<string>()

  connection.addEventListener('icecandidate', event => {
    const candidate = event.candidate

    if (candidate?.candidate && candidate.type === 'relay') {
      relayProtocols.add(candidate.protocol ?? '?')
    }
  })

  connection.addEventListener('icecandidateerror', event => {
    const error = event as RTCPeerConnectionIceErrorEvent

    errors.add(`${error.errorCode} ${error.errorText ?? ''}`.trim())
  })

  try {
    // A data channel gives the offer something to gather candidates for.
    connection.createDataChannel('turn-preflight')
    await connection.setLocalDescription(await connection.createOffer())
    await new Promise(resolve => setTimeout(resolve, PREFLIGHT_TIMEOUT_MS))

    if (relayProtocols.size) {
      recordDiagnostic(
        'ice',
        `turn preflight OK — relay via ` +
          `${[...relayProtocols].sort().join(', ')} · ${describeIceConfig()}`,
      )

      return
    }

    // No relay candidate means no connection is possible at all in this build.
    // `401`/`400` here is an expired or wrong credential pair; a timeout with no
    // error at all points at the network blocking TURN outright.
    recordDiagnostic(
      'ice',
      `turn preflight FAILED — no relay candidate` +
        `${errors.size ? ` (${[...errors].join('; ')})` : ' (no response)'}`,
    )
  } catch (caught) {
    recordDiagnostic(
      'ice',
      `turn preflight ERROR — ` +
        `${caught instanceof Error ? caught.message : String(caught)}`,
    )
  } finally {
    connection.close()
  }
}
