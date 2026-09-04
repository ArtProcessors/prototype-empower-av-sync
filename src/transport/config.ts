/**
 * Transport configuration: the ICE endpoints every peer connection is pinned
 * to.
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
 *
 * Matchmaking has no such switch. Peers meet through this app's own signalling
 * relay (`worker-strategy.ts`, backed by the Durable Object in
 * `worker/signal-relay.ts`) and through nothing else. Trystero's public
 * backends were measured against it and lost — they rate-limit, they are
 * roughly twice as slow to peer, and they sit in the critical path of every
 * join and every recovery — but the deciding factor is announce retention:
 * only the app's own relay replays a peer's last announce to whoever
 * subscribes next, which is what lets a `passive` follower activate on connect
 * instead of waiting out the screen's 5.3 s announce interval. A public
 * backend would not be a like-for-like fallback, it would be a quietly slower
 * join path, so the choice is not offered.
 */

/**
 * The only ICE endpoints this build will use — every Cloudflare transport and
 * port, deliberately.
 *
 * A TCP/TLS-only set was measured against a UDP-only set on Android to test
 * whether power-save discards UDP flows first. It made no difference: both
 * died within seconds of screen-off, because the device takes its Wi-Fi down
 * entirely rather than degrading it (see FEASIBILITY, "Screen-off kills the
 * radio"). The `?ice=` switch that comparison needed has been removed.
 *
 * What survives is breadth: ports 53, 80 and 443 get through networks that
 * block 3478/5349 outright — a real concern for venue Wi-Fi, even though it
 * was not the cause here. `ice-config.ts` logs anything Cloudflare offers that
 * is not listed, so drift stays visible.
 */
export const CLOUDFLARE_ICE_URLS = [
  'stun:stun.cloudflare.com:3478',
  'turns:turn.cloudflare.com:443?transport=tcp',
  'turns:turn.cloudflare.com:5349?transport=tcp',
  'turn:turn.cloudflare.com:80?transport=tcp',
  'turn:turn.cloudflare.com:3478?transport=tcp',
  'turn:turn.cloudflare.com:3478?transport=udp',
  'turn:turn.cloudflare.com:53?transport=udp',
]

/**
 * Relay-only: no host or server-reflexive candidates, so there is no direct
 * path for a connection to quietly fall back to.
 */
export const ICE_TRANSPORT_POLICY: RTCIceTransportPolicy = 'relay'
