/**
 * React binding for the headless session in `src/core`.
 *
 * Everything this file used to do — the video element, the audio controller,
 * the correction loop, the watchdog, the reconnects, the page-lifecycle
 * handling — now lives in {@link createSyncSession}. What is left is
 * subscribing the component tree to that session's snapshot.
 */
import { useEffect, useSyncExternalStore } from 'react'

import { CONTENT_CATALOGUE } from '../content'
import {
  createDomScreenVideo,
  type DomScreenVideoOptions,
  type DomScreenVideoOutput,
} from '../core/screen-output'
import { createSyncSession, type SyncSession } from '../core/session'
import type { SyncSessionState } from '../core/session-state'

/**
 * What a host supplies when it binds the page's session.
 *
 * This is the configuration seam for a React host: the parts of the session
 * that depend on which UI is rendering, gathered where the UI can reach them.
 * A host that is not React — or not a DOM at all — skips this file and calls
 * {@link createSyncSession} directly, handing it its own `ScreenVideoOutput`.
 */
export interface UseSyncOptions {
  /**
   * How to set up the persistent `<video>` the screen plays through. The one
   * hook a UI needs to make that element its own — see
   * {@link DomScreenVideoOptions.configure}.
   */
  screenVideo?: DomScreenVideoOptions
}

/** The session, its current state, and the one DOM detail React has to place. */
export interface SyncBinding {
  /** Current session state; a new object on every emit. */
  state: SyncSessionState
  /** The session's actions. Stable for the page's lifetime. */
  session: SyncSession
  /**
   * Ref callback that mounts the persistent screen video into a container.
   * Stable, so React never detaches and re-attaches the element.
   */
  mountScreenVideo: (container: HTMLElement | null) => void
}

/**
 * One session per page. Built at module scope rather than in a ref because it
 * owns the `<video>` element and the `AudioSyncController`, both of which must
 * exist — and stay the same objects — from before the first user gesture until
 * the page goes away. StrictMode's double-invocation cannot touch it, and it
 * is deliberately never disposed: the page's lifetime *is* its lifetime.
 *
 * The DOM video output is built here rather than inside the session because
 * knowing how to parent an `HTMLVideoElement` is this host's job, not the
 * core's — the core only needs something it can play and read a clock from.
 *
 * Its setup arrives with the first call and is spent there: the element cannot
 * be rebuilt, so it cannot be reconfigured either. Anything a UI wants to say
 * about that element, it says once, up front — which is what makes the caller
 * a single root, not any component that fancies a video.
 */
let page: { session: SyncSession; video: DomScreenVideoOutput } | null = null

function sessionForPage(options: UseSyncOptions) {
  if (!page) {
    const video = createDomScreenVideo(options.screenVideo)

    page = {
      session: createSyncSession({
        media: CONTENT_CATALOGUE,
        screenVideo: video,
        nowPlaying: { title: 'Live audio', artist: 'Empower A/V sync' },
      }),
      video,
    }
  }

  return page
}

/**
 * Subscribe the component tree to the A/V sync session, building it on the
 * first call.
 *
 * `options` are consumed by that first call and ignored by every one after
 * it — there is one session and one video element per page, and neither can be
 * replaced once a gesture may have landed on them. In practice that means one
 * caller, at the root, passing values it worked out before rendering.
 *
 * @param options how this host wants the page's session built
 */
export function useSync(options: UseSyncOptions = {}): SyncBinding {
  const { session, video } = sessionForPage(options)
  // `subscribe` and `getState` are properties of one long-lived object, so
  // their identities never change and React never re-subscribes. `getState`
  // returns the same snapshot until the session replaces it, which is what
  // keeps this from looping.
  const state = useSyncExternalStore(session.subscribe, session.getState)

  // Page-lifecycle, network and renderer-liveness logging runs for the whole
  // page, not just while a session is up — a freeze or a discard is exactly
  // what we are trying to catch, and it can land before or after joining.
  useEffect(() => session.start(), [session])

  return { state, session, mountScreenVideo: video.mountInto }
}
