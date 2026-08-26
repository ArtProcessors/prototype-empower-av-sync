/**
 * Reports an `RTCPeerConnection`'s health into the session log.
 *
 * Two questions this exists to answer:
 *
 *  1. **Is the link being closed prematurely?** Trystero tears a peer down 5 s
 *     after ICE reports `disconnected` (`@trystero-p2p/core`, `peer.mjs`),
 *     where the spec's own give-up point is `failed` at ~30 s of consent
 *     freshness failure. `disconnected` routinely self-heals on a phone — Wi-Fi
 *     power-save, a cellular handover or a Doze gap can all produce a stall
 *     longer than 5 s. If the log shows `disconnected` followed ~5 s later by a
 *     peer leave, the teardown is ours and not the network's.
 *  2. **Which candidate path are we on?** A relayed (TURN) path behaves very
 *     differently from a server-reflexive one when a phone's NAT rebinds, so
 *     the selected pair is recorded once the connection comes up.
 */
import { recordDiagnostic } from './session-log'

/** Short peer id used in log lines, to keep them readable on a phone. */
function shortPeerId(peerId: string): string {
  return peerId.slice(0, 6)
}

/**
 * Look up the candidate pair ICE actually selected and describe it, so the log
 * records whether this session is direct, reflexive or relayed.
 */
async function reportSelectedCandidatePair(
  peerId: string,
  connection: RTCPeerConnection,
): Promise<void> {
  try {
    const stats = await connection.getStats()
    let selectedPair: RTCIceCandidatePairStats | null = null

    stats.forEach(report => {
      if (report.type !== 'candidate-pair') {
        return
      }

      const pair = report as RTCIceCandidatePairStats

      // `selected` is Firefox's marker; Chromium nominates the succeeded pair.
      const isSelected =
        (pair as { selected?: boolean }).selected === true ||
        (pair.state === 'succeeded' && pair.nominated === true)

      if (isSelected) {
        selectedPair = pair
      }
    })

    if (!selectedPair) {
      return
    }

    const pair: RTCIceCandidatePairStats = selectedPair
    const local = stats.get(pair.localCandidateId ?? '')
    const remote = stats.get(pair.remoteCandidateId ?? '')
    const localType = local?.candidateType ?? '?'
    const remoteType = remote?.candidateType ?? '?'
    const protocol = local?.protocol ?? '?'
    const networkType = local?.networkType ?? '?'

    // This build relays everything through Cloudflare, so anything other than
    // a relay pair means the pinning has been defeated and the test would be
    // measuring a direct connection instead of the service.
    const relayed = localType === 'relay'

    recordDiagnostic(
      'ice',
      `${shortPeerId(peerId)} path ${localType}→${remoteType}` +
        ` over ${protocol} (${networkType})` +
        `${relayed ? '' : ' — NOT RELAYED'}`,
    )
  } catch {
    /* stats are best-effort — never let diagnostics break the session */
  }
}

/**
 * Start logging `connection`'s state transitions on behalf of `peerId`. Call
 * the returned function to stop listening (on peer leave, or when the room is
 * left).
 */
export function monitorPeerConnection(
  peerId: string,
  connection: RTCPeerConnection,
): () => void {
  const label = shortPeerId(peerId)

  recordDiagnostic(
    'peer',
    `${label} monitored (conn ${connection.connectionState},` +
      ` ice ${connection.iceConnectionState})`,
  )

  const onConnectionStateChange = () => {
    recordDiagnostic('ice', `${label} conn → ${connection.connectionState}`)

    if (connection.connectionState === 'connected') {
      reportSelectedCandidatePair(peerId, connection)
    }
  }

  const onIceConnectionStateChange = () => {
    recordDiagnostic('ice', `${label} ice → ${connection.iceConnectionState}`)
  }

  connection.addEventListener('connectionstatechange', onConnectionStateChange)
  connection.addEventListener(
    'iceconnectionstatechange',
    onIceConnectionStateChange,
  )

  if (connection.connectionState === 'connected') {
    reportSelectedCandidatePair(peerId, connection)
  }

  return () => {
    connection.removeEventListener(
      'connectionstatechange',
      onConnectionStateChange,
    )
    connection.removeEventListener(
      'iceconnectionstatechange',
      onIceConnectionStateChange,
    )
  }
}
