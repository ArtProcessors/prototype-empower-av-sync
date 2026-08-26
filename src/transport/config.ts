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
 * The only ICE endpoints this build will use. Both TURN transports are offered
 * so a network that blocks UDP can still relay over TCP, and `turns:` on 5349
 * covers networks that only allow TLS.
 *
 * Cloudflare also issues endpoints on ports 53, 80 and 443, which get through
 * networks that block 3478/5349 outright; `ice-config.ts` logs any it offers
 * that are not listed here, so widening this list is a one-line change once the
 * relay itself is proven.
 */
export const CLOUDFLARE_ICE_URLS = [
  'stun:stun.cloudflare.com:3478',
  'turn:turn.cloudflare.com:3478?transport=udp',
  'turn:turn.cloudflare.com:3478?transport=tcp',
  'turns:turn.cloudflare.com:5349?transport=tcp',
  'turn:turn.cloudflare.com:80?transport=tcp',
  'turns:turn.cloudflare.com:443?transport=tcp',
]

/**
 * Relay-only: no host or server-reflexive candidates, so there is no direct
 * path for a connection to quietly fall back to.
 */
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
