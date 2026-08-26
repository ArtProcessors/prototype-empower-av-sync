/**
 * Cloudflare Worker backing the A/V sync app: mints short-lived TURN
 * credentials, and serves the built SPA.
 *
 * Why this exists at all: the app relays every WebRTC connection through
 * Cloudflare TURN, and Cloudflare's TURN credentials expire. Baking a pair into
 * the client bundle at build time therefore ties the app's working life to a
 * token's TTL — and it fails in the worst possible place. The recovery path for
 * a dropped connection is the follower's watchdog rejoin, which builds a fresh
 * `RTCPeerConnection`; with an expired credential that rejoin gathers no
 * candidates and fails silently, looking exactly like the Android disconnection
 * bug the relay was introduced to fix.
 *
 * So the long-lived TURN key stays here, server-side, and clients fetch a
 * short-lived pair at join time (and again whenever theirs is near expiry).
 * Anyone holding {@link Env.TURN_KEY_API_TOKEN} can mint unlimited credentials
 * billed to the account, which is precisely why it must never reach a browser.
 *
 * Serving the SPA from the same Worker keeps `/api/ice` same-origin, so there
 * is no CORS surface to get wrong in production.
 */

/** Bindings and secrets this Worker expects; see `wrangler.toml`. */
export interface Env {
  /** Cloudflare Realtime TURN key id. Set with `wrangler secret put`. */
  TURN_KEY_ID: string
  /**
   * API token for the TURN key. A secret in the strict sense: it mints
   * credentials that relay traffic billed to the account.
   */
  TURN_KEY_API_TOKEN: string
  /**
   * Lifetime of an issued credential, in seconds. Should comfortably exceed a
   * single visitor session — a credential that expires mid-session forces a
   * refetch at exactly the moment the network is least reliable.
   */
  TURN_TTL_SECONDS?: string
  /**
   * Comma-separated origins allowed to request credentials. This deters casual
   * cross-site use of the endpoint; it is NOT authentication, since `Origin`
   * is trivially forged outside a browser. Rate limiting at the Cloudflare edge
   * is the real control on abuse. Leave unset to allow any origin (dev).
   */
  ALLOWED_ORIGINS?: string
  /** Static assets binding — the built SPA in `dist/`. */
  ASSETS: { fetch: (request: Request) => Promise<Response> }
}

/** Path the client fetches its ICE configuration from. */
const ICE_PATH = '/api/ice'

/** Fallback credential lifetime when `TURN_TTL_SECONDS` is unset. */
const DEFAULT_TTL_SECONDS = 7200

/** Cloudflare's credential-minting endpoint. */
const TURN_API_BASE = 'https://rtc.live.cloudflare.com/v1/turn/keys'

/** What {@link ICE_PATH} returns to the client. */
interface IceConfigResponse {
  /** ICE servers, complete with the freshly minted credentials. */
  iceServers: RTCIceServerPayload[]
  /** Epoch milliseconds at which these credentials stop working. */
  expiresAt: number
  /** Lifetime the credentials were minted with, in seconds. */
  ttlSeconds: number
}

/** One ICE server entry as Cloudflare returns it. */
interface RTCIceServerPayload {
  /** STUN/TURN endpoints this credential is valid for. */
  urls: string[]
  /** TURN username; absent on the STUN-only entry. */
  username?: string
  /** TURN credential; absent on the STUN-only entry. */
  credential?: string
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      // Credentials are per-client and time-limited; nothing should hold on to
      // them, least of all a shared cache.
      'cache-control': 'no-store',
    },
  })
}

/**
 * Reject requests from origins the deployment does not recognise. Returns an
 * error response to send, or `null` when the request may proceed.
 */
function checkOrigin(request: Request, env: Env): Response | null {
  const allowed = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean)

  if (!allowed.length) {
    return null
  }

  const origin = request.headers.get('origin')

  // Same-origin navigations from the SPA send no `Origin` header, which is the
  // normal case once this Worker is also serving the app.
  if (!origin || allowed.includes(origin)) {
    return null
  }

  return jsonResponse({ error: 'origin not allowed' }, 403)
}

/** Mint a credential pair and return it with the expiry the client needs. */
async function issueIceConfig(env: Env): Promise<Response> {
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) {
    return jsonResponse(
      {
        error:
          'Worker is missing TURN_KEY_ID or TURN_KEY_API_TOKEN. Set them ' +
          'with `wrangler secret put`.',
      },
      500,
    )
  }

  const ttlSeconds = Number(env.TURN_TTL_SECONDS) || DEFAULT_TTL_SECONDS
  const requestedAt = Date.now()

  const upstream = await fetch(
    `${TURN_API_BASE}/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ttl: ttlSeconds }),
    },
  )

  if (!upstream.ok) {
    // Surface Cloudflare's own message: a revoked key or a malformed TTL both
    // land here, and the difference matters when debugging from a phone.
    const detail = await upstream.text()

    return jsonResponse(
      {
        error: `TURN credential request failed (${upstream.status})`,
        detail: detail.slice(0, 500),
      },
      502,
    )
  }

  const payload = (await upstream.json()) as {
    iceServers?: RTCIceServerPayload[]
  }
  const iceServers = payload.iceServers

  if (!Array.isArray(iceServers) || !iceServers.length) {
    return jsonResponse(
      { error: 'TURN credential response had no iceServers' },
      502,
    )
  }

  const body: IceConfigResponse = {
    iceServers,
    // Derived rather than reported: Cloudflare returns no expiry field, so the
    // client's refresh logic depends on us dating the TTL we asked for.
    expiresAt: requestedAt + ttlSeconds * 1000,
    ttlSeconds,
  }

  return jsonResponse(body, 200)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === ICE_PATH) {
      const rejected = checkOrigin(request, env)

      if (rejected) {
        return rejected
      }

      return issueIceConfig(env)
    }

    return env.ASSETS.fetch(request)
  },
}
