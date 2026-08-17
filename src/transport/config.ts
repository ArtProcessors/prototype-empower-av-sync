/**
 * Transport configuration: Trystero matchmaking strategy + ICE servers.
 *
 * Defaults to Nostr (public-internet signaling, not same-LAN discovery). Swap
 * via the `VITE_TRYSTERO_STRATEGY` environment variable.
 */

/** Trystero matchmaking backend used to find peers in a room. */
export type Strategy = 'nostr' | 'mqtt' | 'torrent'

/** Matchmaking backend this build joins rooms with. */
export const STRATEGY: Strategy =
  (import.meta.env.VITE_TRYSTERO_STRATEGY as Strategy) || 'nostr'

/** Trystero namespace — peers only meet other peers using the same id. */
export const APP_ID = 'empower-av-sync-v1'

/**
 * Public STUN servers, plus the optional TURN relay from the environment for
 * networks that block direct peer connections.
 */
function buildIceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [
    {
      urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'],
    },
  ]

  const turnUrl = import.meta.env.VITE_TURN_URL

  if (turnUrl) {
    servers.push({
      urls: turnUrl,
      username: import.meta.env.VITE_TURN_USERNAME,
      credential: import.meta.env.VITE_TURN_CREDENTIAL,
    })
  }

  return servers
}

/** ICE configuration handed to every peer connection. */
export const RTC_CONFIG: RTCConfiguration = { iceServers: buildIceServers() }

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
  joinRoom: typeof import('trystero/nostr').joinRoom
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
