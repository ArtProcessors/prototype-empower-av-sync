import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// First, deliberately: Vite emits CSS in module-graph order, and the reset and
// element defaults are the layer every CSS Module is written to sit on top of.
import './global.css'
import { App } from './ui/App'
import { DemoStatusGallery } from './ui/demo/DemoStatusGallery'
import { currentLaunchIntent } from './ui/launch-intent'

// Service worker registration is production-only; use
// `yarn build && yarn preview` for offline testing.
if (import.meta.env.PROD) {
  import('./service-worker-registration').then(module =>
    module.registerServiceWorker(),
  )
}

// The ring gallery is routed here rather than inside `App` because it is not
// a host: `App` binds a session on its first render, and building one — with
// the screen's `<video>` element and everything it drags in — for a page of
// static rings would be waste with side effects.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {currentLaunchIntent().rings ? <DemoStatusGallery /> : <App />}
  </StrictMode>,
)
