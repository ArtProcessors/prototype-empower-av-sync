/// <reference lib="webworker" />
/**
 * Hand-written service worker (injectManifest). Precaches the app shell and one media
 * file — the primer (`content/primer.m4a`) — and runtime-caches every other video and
 * audio as it is fetched, cache-first with Range support.
 *
 * Not an offline mode, and it never was one worth claiming: a screen cannot open a
 * room and a follower cannot join one without signalling and TURN, so a page with no
 * network has nothing to be in sync with. What this buys is a cold start that does
 * not re-download the shell, long-form media that survives a reload without being
 * pulled again, and the one thing that genuinely cannot be fetched late: the primer
 * has to be local *before* the unlock gesture points the `<audio>` element at it
 * (see `media/audio-sync-controller.ts`), which is why it is the one media file in
 * the manifest. Everything else can afford to arrive when it is asked for.
 */
import { clientsClaim } from 'workbox-core'
import { precacheAndRoute, createHandlerBoundToURL } from 'workbox-precaching'
import { registerRoute, NavigationRoute } from 'workbox-routing'
import { CacheFirst } from 'workbox-strategies'
import { ExpirationPlugin } from 'workbox-expiration'
import {
  RangeRequestsPlugin,
  createPartialResponse,
} from 'workbox-range-requests'

declare let self: ServiceWorkerGlobalScope & {
  /** Precache manifest injected at build time by vite-plugin-pwa. */
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>
}

self.skipWaiting()
clientsClaim()

precacheAndRoute(self.__WB_MANIFEST)

registerRoute(
  new NavigationRoute(createHandlerBoundToURL('index.html'), {
    denylist: [/\/[^/?]+\.[^/]+$/],
  }),
)

/** Cache holding whole copies of this origin's bundled media. */
const STATIC_MEDIA_CACHE = 'static-media-cache'

/**
 * This origin's bundled media — in practice `screen.mp4`, since the primer is
 * precached and served by the route above.
 *
 * Hand-rolled rather than a `CacheFirst`, because a media element never asks
 * for a whole file: it sends `Range`, and the answer is a 206, which Workbox
 * will not put in a cache. A `CacheFirst` + `RangeRequestsPlugin` pair only
 * works when something else already put a *whole* 200 in there — which, before
 * `screen.mp4` left the precache, was the precache's doing. Left as it was, it
 * would have cached nothing at all and re-fetched the file on every load.
 *
 * So: fetch the whole thing once, keep that, and slice every later range out of
 * it. Worth doing here and nowhere else — these files are tens of kilobytes and
 * a display will play all of them. The remote clips run to hundreds of
 * megabytes and are handled below, deliberately differently.
 */
registerRoute(
  ({ request, url, sameOrigin }) =>
    sameOrigin &&
    url.pathname.startsWith('/static/') &&
    (request.destination === 'audio' || request.destination === 'video'),
  async ({ request }) => {
    const cache = await caches.open(STATIC_MEDIA_CACHE)
    // Keyed without the Range header, so every range shares one entry.
    const whole = new Request(request.url)
    let cached = await cache.match(whole)

    if (!cached) {
      const response = await fetch(whole)

      // Nothing to cache and nothing to slice — hand the failure back and let
      // the element report it.
      if (!response.ok) {
        return response
      }

      await cache.put(whole, response.clone())
      cached = await cache.match(whole)
    }

    if (!cached) {
      return fetch(request)
    }

    return request.headers.has('range')
      ? createPartialResponse(request, cached)
      : cached
  },
)

// The remote long-form clips. Cache-first with Range support, which for the
// reasons above means it rarely stores anything — and that is the right
// outcome here: `sync45` alone is ~860 MB, far past what Cache Storage should
// be asked to hold, and the streaming engine's own `fetch` windows (destination
// `empty`) never reach this route anyway. It stays for the small-file case —
// a follower's `<audio>` fetching a soundtrack in one piece.
registerRoute(
  ({ request }) =>
    request.destination === 'audio' || request.destination === 'video',
  new CacheFirst({
    cacheName: 'media-cache',
    plugins: [
      new RangeRequestsPlugin(),
      new ExpirationPlugin({
        maxEntries: 20,
        maxAgeSeconds: 7 * 24 * 60 * 60,
      }),
    ],
  }),
)
