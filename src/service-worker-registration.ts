import { registerSW } from 'virtual:pwa-register'

/**
 * Register the service worker (production only), honouring the
 * `registerType: 'autoUpdate'` configured in vite.config.ts.
 */
export function registerServiceWorker(): void {
  registerSW({ immediate: true })
}
