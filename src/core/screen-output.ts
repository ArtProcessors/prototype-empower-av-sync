/**
 * Where the screen's video plays, and the source of every beat's position.
 *
 * This exists as a port rather than an `HTMLVideoElement` for two reasons. The
 * obvious one is that a host on another platform needs somewhere to plug its
 * own output in. The load-bearing one is that the DOM implementation carries a
 * contract that is easy to break and impossible to notice from a desktop
 * browser: **one element, built before the tap, moved and never recreated.**
 *
 * iOS grants autoplay permission to the specific element that `play()` was
 * called on inside a user gesture. Rendering `<video>` in JSX would hand React
 * a fresh element on every remount — one that has never been played in a
 * gesture — and the screen would silently stop playing on exactly the devices
 * this app is for. So the element is created up front, outside the component
 * tree, and {@link DomScreenVideoOutput.mountInto} re-parents that same element
 * into whatever container the view offers.
 */
import type { MediaOption } from './media-catalogue'

/** The screen's video output: the source of every beat's position. */
export interface ScreenVideoOutput {
  /**
   * Point the output at `option` and start playback. Must be called inside the
   * user gesture that grants autoplay permission.
   */
  play(option: MediaOption): Promise<void>
  /**
   * Resume whatever is already loaded, without touching the source. Used on
   * returning from a background, where the media has not changed and the
   * gesture's permission still stands.
   */
  resume(): void
  /** Stop playback — the session ending, not a user pause. */
  pause(): void
  /** Whether output is playing rather than paused. */
  readonly playing: boolean
  /** Current playback position, in seconds. */
  readonly currentTimeSec: number
  /** Loop length in seconds, or 0 while still unknown. */
  readonly durationSec: number
}

/** A {@link ScreenVideoOutput} backed by a persistent `<video>` element. */
export interface DomScreenVideoOutput extends ScreenVideoOutput {
  /** The element itself, for hosts that place it by hand. */
  readonly element: HTMLVideoElement
  /**
   * Re-parent the element into `container`, or detach it when `null`. The
   * *same* element is moved every time — see this module's header for why.
   */
  mountInto(container: HTMLElement | null): void
}

/**
 * Build the screen's persistent video element. Call once, before any gesture:
 * the element has to exist and be reusable by the time someone taps.
 */
export function createDomScreenVideo(): DomScreenVideoOutput {
  const element = document.createElement('video')

  element.loop = true
  element.playsInline = true
  element.setAttribute('playsinline', '')
  element.setAttribute('webkit-playsinline', '')
  element.controls = true
  // The leader (local video) is muted. Only followers can hear the sound.
  element.muted = true
  element.style.width = '100%'
  element.style.height = 'auto'
  element.style.background = '#000'
  element.style.display = 'block'

  return {
    element,

    async play(option) {
      if (
        !element.src.endsWith(option.videoUrl) &&
        element.getAttribute('src') !== option.videoUrl
      ) {
        element.src = option.videoUrl
      }

      // Start playback inside the gesture. The first play() can reject while
      // the freshly assigned src is still loading, so retry once — by then the
      // element has the gesture's autoplay permission either way.
      try {
        await element.play()
      } catch {
        await element.play().catch(() => {})
      }
    },

    resume() {
      element.play().catch(() => {})
    },

    pause() {
      element.pause()
    },

    get playing() {
      return !element.paused
    },

    get currentTimeSec() {
      return element.currentTime
    },

    get durationSec() {
      return element.duration || 0
    },

    mountInto(container) {
      if (container) {
        if (element.parentElement !== container) {
          container.appendChild(element)
        }
      } else if (element.parentElement) {
        element.parentElement.removeChild(element)
      }
    },
  }
}
