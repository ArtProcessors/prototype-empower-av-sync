import { execFileSync } from 'node:child_process'

import { sentryVitePlugin } from '@sentry/vite-plugin'
import { defineConfig, type PluginOption } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

import { ROOM_PATH } from './shared/api-routes'

/**
 * The commit this bundle was built from, as a Sentry release name, or
 * `undefined` when that cannot be known.
 *
 * Deploys run `yarn build && wrangler deploy` from a checkout, so git is
 * there in the case that matters. When it is not — a tarball, a CI runner
 * with no history — we return `undefined` rather than a placeholder, because
 * an honest missing release groups better in Sentry than every build of every
 * commit sharing one made-up name.
 */
function appRelease(): string | undefined {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim()
    return sha ? `empower-av-sync@${sha}` : undefined
  } catch {
    return undefined
  }
}

const RELEASE = appRelease()

/**
 * Pull `.env.sentry-build-plugin` into `process.env`, if it is there.
 *
 * `@sentry/vite-plugin` reads that file by itself, but too late to be useful:
 * the decisions below — whether to emit source maps at all, whether to add
 * the plugin — are made while this config is being evaluated, before the
 * plugin exists. Without this the documented setup silently does nothing,
 * warning that the credentials are unset while they sit in the file.
 *
 * Anything already in the environment wins, so `SENTRY_AUTH_TOKEN=… yarn
 * build` and CI secrets still override the file.
 */
function loadSentryBuildEnv(): void {
  try {
    process.loadEnvFile('.env.sentry-build-plugin')
  } catch {
    // Not there: the ordinary case for a checkout that never uploads maps.
  }
}

loadSentryBuildEnv()

/**
 * Whether this build can upload source maps: all three of `SENTRY_AUTH_TOKEN`,
 * `SENTRY_ORG` and `SENTRY_PROJECT` are set. See `.env.example`.
 *
 * This gates whether maps are emitted at all, not just whether they are sent.
 * `wrangler.toml` publishes the whole of `dist/` as static assets, so a `.map`
 * left behind there is served to anyone who guesses the URL — which is this
 * app's entire source. Maps are therefore generated only when something is
 * going to upload and then delete them.
 */
const CAN_UPLOAD_SOURCE_MAPS = Boolean(
  process.env.SENTRY_AUTH_TOKEN &&
  process.env.SENTRY_ORG &&
  process.env.SENTRY_PROJECT,
)

/**
 * Source-map upload, so production stack traces name real functions and lines
 * instead of `OP` at column 14588.
 *
 * The plugin stamps a Debug ID into each chunk and its map, which is what
 * Sentry matches on — the release name is set too, to the same value the SDK
 * tags events with, but only so the Sentry UI groups by deploy. Matching does
 * not depend on it.
 *
 * Upload failures throw rather than warn. A silent skip ships a build whose
 * traces are unreadable, and the whole point of the step is that you find out
 * before the deploy rather than during the next incident.
 */
function sentrySourceMaps(): PluginOption[] {
  if (!CAN_UPLOAD_SOURCE_MAPS) {
    return [
      {
        name: 'sentry-sourcemaps-absent',
        apply: 'build',
        buildStart() {
          this.warn(
            'SENTRY_AUTH_TOKEN / SENTRY_ORG / SENTRY_PROJECT are not all ' +
              'set, so no source maps are being uploaded and production ' +
              'stack traces from this build will be minified. ' +
              'See .env.example.',
          )
        },
      },
    ]
  }
  return sentryVitePlugin({
    org: process.env.SENTRY_ORG,
    project: process.env.SENTRY_PROJECT,
    authToken: process.env.SENTRY_AUTH_TOKEN,
    release: RELEASE ? { name: RELEASE } : undefined,
    sourcemaps: {
      // Emitted, uploaded, then removed before `wrangler deploy` can publish
      // them. `dist/sw.js` and its map are built by vite-plugin-pwa in a
      // second pass; the glob covers both passes' output.
      filesToDeleteAfterUpload: ['dist/**/*.map'],
    },
    errorHandler: error => {
      throw error
    },
  })
}

// `/api/ice` is served by the Cloudflare Worker (worker/index.ts). In production
// the Worker serves the app too, so the call is same-origin; locally we proxy to
// `wrangler dev` to keep it that way — no CORS in either mode. Both the dev
// server and `vite preview` need this: without it, joining a room fails at the
// TURN-credential fetch, since this build has no direct-path fallback.
const apiProxy = {
  '/api': {
    target: 'http://127.0.0.1:8787',
    changeOrigin: true,
  },
  // Peer signalling upgrades to a WebSocket, so this leg needs `ws: true`.
  [ROOM_PATH]: {
    target: 'ws://127.0.0.1:8787',
    ws: true,
    changeOrigin: true,
  },
}

// Sibling of empower-peer-to-peer: Vite 7 + React + vite-plugin-pwa (injectManifest,
// hand-written SW). Bundles the brand loop, the test clip and the audio primer.
export default defineConfig({
  base: '/',
  // Read at config time, not per request: the commit cannot change under a
  // build. `src/instrument.ts` hands this straight to Sentry.
  define: {
    __APP_RELEASE__: JSON.stringify(RELEASE) ?? 'undefined',
  },
  plugins: [
    react(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src/service-worker',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      injectRegister: false,
      injectManifest: {
        // The service worker runs in its own global scope with no
        // `Sentry.init` in it, so a map for it would upload nothing Sentry
        // can use — and this build is otherwise the one place a `.map` can
        // outlive the plugin's delete step, since vite-plugin-pwa compiles
        // the worker in a second pass of its own (see its index.js:867,
        // where this defaults to the main `build.sourcemap`).
        sourcemap: false,
        globPatterns: [
          '**/*.{js,css,html,webmanifest}',
          // Audio but not video. The only media that has to be precached is
          // the primer (`src/content/primer.m4a`), which a follower needs
          // already local inside the unlock gesture. Video is either remote,
          // or — in `screen.mp4`'s case — wanted only by an instrumented page,
          // and neither should be on a visitor's first load. Both are still
          // runtime-cached by the media route in `src/service-worker/sw.ts`.
          'static/**/*.{svg,png,jpg,jpeg,gif,webp,ttf,woff2,mp3,m4a,ico}',
        ],
      },
      manifest: {
        name: 'Empower — A/V Sync (spike)',
        short_name: 'AV Sync',
        description:
          'Fixed-screen video leader keeps followers’ audio in sync over WebRTC.',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#111111',
        theme_color: '#111111',
        start_url: '/',
        icons: [
          {
            src: 'icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
      },
    }),
    // Last: it reads the finished bundle.
    ...sentrySourceMaps(),
  ],
  server: {
    port: 3100,
    strictPort: true,
    host: true,
    proxy: apiProxy,
    allowedHosts: [
      'localhost',
      '127.0.0.1',
      '.trycloudflare.com',
      'bs-local.com',
    ],
  },
  preview: {
    port: 4273,
    strictPort: true,
    host: true,
    allowedHosts: true,
    proxy: apiProxy,
  },
  build: {
    // `hidden`: maps are generated and uploaded, but no `sourceMappingURL`
    // comment points a browser at them. See CAN_UPLOAD_SOURCE_MAPS.
    sourcemap: CAN_UPLOAD_SOURCE_MAPS ? 'hidden' : false,
    assetsDir: 'static',
    rollupOptions: {
      output: {
        assetFileNames: 'static/[name].[hash][extname]',
        entryFileNames: 'static/js/[name].[hash].js',
        chunkFileNames: 'static/js/[name].[hash].js',
      },
    },
  },
})
