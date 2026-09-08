import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// First, deliberately: Vite emits CSS in module-graph order, and the reset and
// element defaults are the layer every CSS Module is written to sit on top of.
import './global.css'
import { App } from './ui/App'

// Service worker registration is production-only; use
// `yarn build && yarn preview` for offline testing.
if (import.meta.env.PROD) {
  import('./service-worker-registration').then(module =>
    module.registerServiceWorker(),
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
