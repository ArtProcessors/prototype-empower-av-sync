/**
 * The `/api/ice` contract: what the Worker mints and the client pins every peer
 * connection to.
 *
 * The two ends previously declared this shape independently — `IceConfigResponse`
 * in the Worker and `IceGrant` on the client — with identical members and no
 * compiler link between them. Since the client re-fetches a grant on every join
 * *and* every watchdog rejoin, a silent divergence here shows up as a rejoin
 * that gathers no candidates: indistinguishable from the Android disconnection
 * bug the relay exists to fix.
 */

/** One ICE server entry as Cloudflare returns it. */
export interface IceServerPayload {
  /** STUN/TURN endpoints this credential is valid for. */
  urls: string[]
  /** TURN username; absent on the STUN-only entry. */
  username?: string
  /** TURN credential; absent on the STUN-only entry. */
  credential?: string
}

/** What {@link ICE_PATH} returns to the client. */
export interface IceConfigResponse {
  /** ICE servers, complete with the freshly minted credentials. */
  iceServers: IceServerPayload[]
  /** Epoch milliseconds at which these credentials stop working. */
  expiresAt: number
  /** Lifetime the credentials were minted with, in seconds. */
  ttlSeconds: number
}
