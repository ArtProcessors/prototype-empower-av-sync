import { StrictMode, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'

// First, deliberately: Vite emits CSS in module-graph order, and the reset and
// element defaults are the layer every CSS Module is written to sit on top of.
import './global.css'
import { App } from './ui/App'
import { DemoScreenGallery } from './ui/demo/DemoScreenGallery'
import { DemoStatusGallery } from './ui/demo/DemoStatusGallery'
import { DemoTranscriptGallery } from './ui/demo/DemoTranscriptGallery'
import { currentLaunchIntent } from './ui/launch-intent'

// Service worker registration is production-only; use
// `yarn build && yarn preview` for offline testing.
if (import.meta.env.PROD) {
  import('./service-worker-registration').then(module =>
    module.registerServiceWorker(),
  )
}

/**
 * What this page load is: the app at `/`, or one of the three development
 * galleries under `/dev/` — see `ui/launch-path.ts` for the paths.
 *
 * The galleries are chosen here rather than inside `App` because none of them
 * is a host: `App` binds a session on its first render, and building one — with
 * the screen's `<video>` element and everything it drags in — for a page of
 * states that never joins a room would be waste with side effects.
 */
function pageForLaunch(): ReactElement {
  switch (currentLaunchIntent().page) {
    case 'rings':
      return <DemoStatusGallery />
    case 'screens':
      return <DemoScreenGallery />
    case 'captions':
      return <DemoTranscriptGallery />
    case 'app':
      return <App />
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>{pageForLaunch()}</StrictMode>,
)
