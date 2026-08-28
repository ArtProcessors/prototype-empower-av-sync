import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

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
  '/signal': {
    target: 'ws://127.0.0.1:8787',
    ws: true,
    changeOrigin: true,
  },
}

// Sibling of empower-peer-to-peer: Vite 7 + React + vite-plugin-pwa (injectManifest,
// hand-written SW). Offline-first bundling of the looping video + soundtrack.
export default defineConfig({
  base: '/',
  plugins: [
    react(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src/service-worker',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      injectRegister: false,
      injectManifest: {
        globPatterns: [
          '**/*.{js,css,html,webmanifest}',
          'static/**/*.{svg,png,jpg,jpeg,gif,webp,ttf,woff2,mp3,m4a,mp4,ico}',
        ],
        // screen.mp4 can be a few MB; keep the precache ceiling generous.
        maximumFileSizeToCacheInBytes: 16 * 1024 * 1024,
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
