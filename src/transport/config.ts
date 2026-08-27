/**
 * Transport configuration: Trystero matchmaking strategy + the ICE endpoints
 * every peer connection is pinned to.
 *
 * Defaults to Nostr (public-internet signaling, not same-LAN discovery). Swap
 * via the `VITE_TRYSTERO_STRATEGY` environment variable.
 *
 * **This build is pinned to Cloudflare's TURN service and nothing else.** The
 * point of the exercise is to find out whether a managed relay fixes the
 * Android connection drops, and that question is only answerable if every peer
 * actually goes through the relay. So:
 *
 *  - The ICE server list is exactly {@link CLOUDFLARE_ICE_URLS}. Trystero
 *    otherwise contributes three Google STUN servers of its own; passing
 *    `iceServers` inside `rtcConfig` replaces that list rather than adding to
 *    it (`@trystero-p2p/core`, `peer.mjs`), which is why the config is built
 *    this way and not via Trystero's `turnConfig` option — that one *appends*
 *    to the defaults.
 *  - {@link ICE_TRANSPORT_POLICY} is `relay`, so host and server-reflexive
 *    candidates are never gathered. Without it ICE would happily pick a direct
 *    path on the venue LAN and the relay would go untested.
 *
 * Credentials are NOT here: they are short-lived and fetched at join time from
 * the Worker (see `ice-config.ts`). Relaying costs a round trip, which for this
 * app is close to free — the clock offset is measured with Cristian's algorithm
 * and the lowest-RTT sample wins, so the extra hop is compensated rather than
 * showing up as drift.
 */

/** Trystero matchmaking backend used to find peers in a room. */
export type Strategy = 'nostr' | 'mqtt' | 'torrent'

/** Matchmaking backend this build joins rooms with. */
export const STRATEGY: Strategy =
  (import.meta.env.VITE_TRYSTERO_STRATEGY as Strategy) || 'nostr'

/** Trystero namespace — peers only meet other peers using the same id. */
export const APP_ID = 'empower-av-sync-v1'

/**
 * Which TURN transports to offer, selected with `?ice=` at runtime so the
 * choice can be A/B-tested on a phone without a rebuild.
 *
 * Defaults to `tcp`. On an Android sleep test the follower's beats stopped
 * roughly five seconds after screen-off while the page itself stayed fully
 * awake — far too fast for Doze, and the classic signature of power-save
 * dropping UDP flows. The selected pair at the time was `relay→relay over udp`.
 * A TCP relay leg has kernel-level retransmission behind it and survives stalls
 * that kill UDP outright, so it is the standing hypothesis until measured
 * otherwise.
 *
 * Use `?ice=udp` or `?ice=all` to compare against the previous behaviour.
 */
export type IceTransportSet = 'all' | 'tcp' | 'udp'

/** STUN, always offered; inert under a relay-only transport policy. */
const STUN_URLS = ['stun:stun.cloudflare.com:3478']

/**
 * TURN over TCP, TLS first. Port 443 leads because it looks like ordinary
 * HTTPS and gets through the most hostile networks; 80 and the standard ports
 * follow as fallbacks.
 */
const TCP_URLS = [
  'turns:turn.cloudflare.com:443?transport=tcp',
  'turns:turn.cloudflare.com:5349?transport=tcp',
  'turn:turn.cloudflare.com:80?transport=tcp',
  'turn:turn.cloudflare.com:3478?transport=tcp',
]

/** TURN over UDP — lowest latency, and the first thing power-save discards. */
const UDP_URLS = [
  'turn:turn.cloudflare.com:3478?transport=udp',
  'turn:turn.cloudflare.com:53?transport=udp',
]

function readIceTransportSet(): IceTransportSet {
  if (typeof location === 'undefined') {
    return 'tcp'
  }

  const match = /[?&]ice=(all|tcp|udp)\b/.exec(location.search)

  return match ? (match[1] as IceTransportSet) : 'tcp'
}

/** TURN transports this session will offer; see {@link IceTransportSet}. */
export const ICE_TRANSPORT_SET: IceTransportSet = readIceTransportSet()

/**
 * The only ICE endpoints this build will use. `ice-config.ts` logs anything
 * Cloudflare offers that is not listed here, so drift stays visible.
 */
export const CLOUDFLARE_ICE_URLS = [
  ...STUN_URLS,
  ...(ICE_TRANSPORT_SET === 'udp' ? [] : TCP_URLS),
  ...(ICE_TRANSPORT_SET === 'tcp' ? [] : UDP_URLS),
]

export const ICE_TRANSPORT_POLICY: RTCIceTransportPolicy = 'relay'

/**
 * Optional relay override (see empower-peer-to-peer notes). Leave unset for
 * Trystero's defaults.
 */
export const RELAY_URLS: string[] = (import.meta.env.VITE_NOSTR_RELAYS || '')
  .split(',')
  .map(url => url.trim())
  .filter(Boolean)

/**
 * Dynamically import the Trystero strategy named by {@link STRATEGY}, so only
 * the selected backend ends up in the bundle.
 */
export async function loadStrategy(): Promise<{
  /** Trystero's room-joining entry point for the selected backend. */
  joinRoom: typeof import('trystero/nostr').joinRoom
  /** This device's peer id, stable for the page's lifetime. */
  selfId: string
}> {
  switch (STRATEGY) {
    case 'mqtt': {
      const mqtt = await import('@trystero-p2p/mqtt')

      return { joinRoom: mqtt.joinRoom, selfId: mqtt.selfId }
    }
    case 'torrent': {
      const torrent = await import('@trystero-p2p/torrent')

      return { joinRoom: torrent.joinRoom, selfId: torrent.selfId }
    }
    case 'nostr':
    default: {
      const nostr = await import('trystero/nostr')

      return { joinRoom: nostr.joinRoom, selfId: nostr.selfId }
    }
  }
}
