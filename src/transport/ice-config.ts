/**
 * Fetches ICE configuration — including live Cloudflare TURN credentials — from
 * the Worker's ICE route, and caches it until shortly before it expires.
 *
 * Credentials are deliberately not baked into the bundle. Cloudflare's expire,
 * and the failure lands in the worst place: a follower's watchdog rejoin builds
 * a fresh `RTCPeerConnection`, and with a stale credential that connection
 * gathers no candidates at all. The follower then retries forever, silently —
 * indistinguishable from the Android disconnection this relay exists to fix.
 *
 * So every join and every rejoin goes through {@link getRtcConfig}, which hands
 * back the cached grant while it has comfortable life left and re-fetches once
 * it does not.
 */
import type { IceConfigResponse } from '../../shared/ice'
import { recordDiagnostic } from '../diagnostics/session-log'
import { CLOUDFLARE_ICE_URLS, ICE_TRANSPORT_POLICY } from './config'
import { transportConfig } from './transport-config'

/**
 * Re-fetch once a grant has less than this left. Generous on purpose: the
 * refresh should happen while the network is healthy, not at the moment a
 * reconnect is already struggling.
 */
const REFRESH_MARGIN_MS = 5 * 60 * 1000

/** Give up on a credential fetch after this long. */
const FETCH_TIMEOUT_MS = 8000

/**
 * One issued set of ICE servers and the moment it stops working — the Worker's
 * response, verbatim. Declared once in `shared/ice.ts` so the two ends cannot
 * drift.
 */
type IceGrant = IceConfigResponse

let cached: IceGrant | null = null
let inFlight: Promise<IceGrant> | null = null

/** Whether a grant has enough life left to start a connection with. */
function isFresh(grant: IceGrant | null): boolean {
  return grant !== null && grant.expiresAt - Date.now() > REFRESH_MARGIN_MS
}

/**
 * Note any endpoint Cloudflare offered that the pinned list leaves unused.
 * Cloudflare also hands out ports 53, 80 and 443, which get through networks
 * that block 3478/5349 — so a mismatch here is a lead, not just noise.
 */
function reportUnusedUrls(grant: IceGrant): void {
  const offered = new Set(grant.iceServers.flatMap(server => server.urls))
  const unused = [...offered].filter(url => !CLOUDFLARE_ICE_URLS.includes(url))

  if (unused.length) {
    recordDiagnostic(
      'ice',
      `${unused.length} cloudflare urls offered but not pinned: ` +
        unused.join(' '),
    )
  }
}

async function fetchGrant(): Promise<IceGrant> {
  const response = await fetch(transportConfig().icePath, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')

    throw new Error(
      `ICE config request failed (${response.status})` +
        `${detail ? `: ${detail.slice(0, 200)}` : ''}`,
    )
  }

  const grant = (await response.json()) as IceGrant

  if (!Array.isArray(grant.iceServers) || !grant.iceServers.length) {
    throw new Error('ICE config response contained no iceServers')
  }

  const lifetime = Math.round((grant.expiresAt - Date.now()) / 1000)

  recordDiagnostic('ice', `ice credentials issued — valid ${lifetime}s`)
  reportUnusedUrls(grant)

  return grant
}

async function getGrant(): Promise<IceGrant> {
  // Read through a local each time: `cached` is reassigned from an async
  // callback below, so narrowing it directly would go stale.
  const current = cached

  if (current && isFresh(current)) {
    return current
  }

  // Joining and the TURN preflight can both ask at once; one fetch serves both.
  if (!inFlight) {
    inFlight = fetchGrant()
      .then(grant => {
        cached = grant

        return grant
      })
      .finally(() => {
        inFlight = null
      })
  }

  try {
    return await inFlight
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught)

    // A failed refresh is survivable while the old grant is merely *near*
    // expiry rather than past it — better a short-lived connection than none.
    const fallback = cached

    if (fallback && fallback.expiresAt > Date.now()) {
      recordDiagnostic(
        'ice',
        `ice credential refresh failed (${message}) — reusing existing grant`,
      )

      return fallback
    }

    throw new Error(
      `Could not get TURN credentials from ${transportConfig().icePath}: ` +
        `${message}. ` +
        'This build relays every connection and has no direct-path fallback, ' +
        'so joining is not possible until the Worker responds.',
    )
  }
}

/**
 * ICE configuration for a new `RTCPeerConnection`: the pinned Cloudflare
 * endpoints, credentials fresh enough to outlive the connection, and relay-only
 * transport so nothing can quietly take a direct path instead.
 */
export async function getRtcConfig(): Promise<RTCConfiguration> {
  const grant = await getGrant()
  const credentialed = grant.iceServers.find(
    server => server.username && server.credential,
  )

  if (!credentialed) {
    throw new Error('ICE config contained no TURN credentials')
  }

  return {
    iceServers: [
      {
        urls: CLOUDFLARE_ICE_URLS,
        username: credentialed.username,
        credential: credentialed.credential,
      },
    ],
    iceTransportPolicy: ICE_TRANSPORT_POLICY,
  }
}

/** One-line description of the current grant, for the diagnostics log. */
export function describeIceConfig(): string {
  const remaining = cached
    ? `${Math.max(0, Math.round((cached.expiresAt - Date.now()) / 1000))}s left`
    : 'not yet fetched'

  return (
    `cloudflare ${ICE_TRANSPORT_POLICY}-only · ` +
    `${CLOUDFLARE_ICE_URLS.length} urls · credentials ${remaining}`
  )
}
