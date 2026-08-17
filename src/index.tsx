import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './ui/App'
import './styles.css'

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
