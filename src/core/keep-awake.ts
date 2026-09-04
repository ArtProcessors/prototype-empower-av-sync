/**
 * Keeps the display awake for the duration of an active session (Screen Wake
 * Lock API), and remembers whether the user asked for that.
 *
 * It is a controller rather than a hook because a wake lock outlives any one
 * view: it is held against a *session*, and the browser hands it back
 * unprompted whenever the tab is hidden, so something has to re-acquire it on
 * return regardless of what is on screen.
 */
import { sessionConfig } from './config'
import { readStored, writeStored } from './storage'
import { isPageVisible, onVisibilityChange } from './visibility'

/** The keep-awake preference and what the platform has done with it. */
export interface KeepAwakeState {
  /** Whether the user has opted in to keeping the screen awake. */
  enabled: boolean
  /** Whether this browser exposes the Screen Wake Lock API at all. */
  supported: boolean
  /** Whether a wake lock is held right now. */
  held: boolean
}

/** Holds a wake lock for as long as a session wants one. */
export interface KeepAwakeController {
  /** Current preference and lock status. Stable between changes. */
  getState(): KeepAwakeState
  /** Subscribe to changes; call the returned function to unsubscribe. */
  subscribe(listener: () => void): () => void
  /** Opt in or out. The preference is persisted across page loads. */
  setEnabled(on: boolean): void
  /** Tell the controller whether a session is running. */
  setSessionActive(active: boolean): void
  /** Release the lock and stop listening. */
  dispose(): void
}

/** Read the user's persisted "keep screen awake" preference. */
export function readKeepAwakePref(): boolean {
  return readStored('local', sessionConfig().storage.keepAwake) === '1'
}

/** Persist the user's "keep screen awake" preference. */
export function writeKeepAwakePref(on: boolean): void {
  writeStored('local', sessionConfig().storage.keepAwake, on ? '1' : '0')
}

/** Whether this browser exposes the Screen Wake Lock API. */
export function isWakeLockSupported(): boolean {
  return typeof navigator !== 'undefined' && 'wakeLock' in navigator
}

/** Build a keep-awake controller. Acquires nothing until a session is active. */
export function createKeepAwakeController(): KeepAwakeController {
  const supported = isWakeLockSupported()
  const listeners = new Set<() => void>()

  let sentinel: WakeLockSentinel | null = null
  let enabled = readKeepAwakePref()
  let active = false
  let held = false
  let state: KeepAwakeState = { enabled, supported, held }

  /**
   * Rebuild the snapshot only when something actually moved, so `getState`
   * keeps returning the same reference between changes.
   */
  const publish = () => {
    if (
      state.enabled === enabled &&
      state.supported === supported &&
      state.held === held
    ) {
      return
    }

    state = { enabled, supported, held }
    listeners.forEach(listener => listener())
  }

  const release = async () => {
    const releasing = sentinel

    if (!releasing) {
      return
    }

    // Cleared before awaiting, so an acquire that follows immediately sees no
    // lock and proceeds rather than short-circuiting on a stale sentinel.
    sentinel = null
    held = false
    publish()

    try {
      await releasing.release()
    } catch {
      /* already released */
    }
  }

  const acquire = async () => {
    const canAcquire = supported && active && enabled && isPageVisible()

    if (!canAcquire || sentinel) {
      return
    }

    try {
      // Known wart, carried over verbatim rather than quietly changed here: if
      // `release()` runs while this request is still in flight, the assignment
      // below lands after it and the lock is held with nothing tracking it.
      // Reachable by toggling the option quickly. Worth its own fix, separately
      // — folding it in here would muddy what this refactor changed.
      const acquired = await navigator.wakeLock.request('screen')

      sentinel = acquired
      held = true
      publish()

      acquired.addEventListener('release', () => {
        if (sentinel === acquired) {
          sentinel = null
          held = false
          publish()
        }
      })
    } catch {
      held = false
      publish()
    }
  }

  /**
   * Re-evaluate after anything the decision depends on changes: drop the lock,
   * then take it again if it is still wanted. Release-then-acquire, in that
   * order, because that is what a React effect's cleanup-before-rerun did.
   */
  const reconcile = () => {
    release()
    acquire()
  }

  // Browsers release the lock when the tab is hidden — re-acquire on return.
  const stopWatchingVisibility = onVisibilityChange(visible => {
    if (visible && active && enabled) {
      acquire()
    }
  })

  return {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener)

      return () => {
        listeners.delete(listener)
      }
    },

    setEnabled(on) {
      if (on === enabled) {
        return
      }

      writeKeepAwakePref(on)
      enabled = on
      publish()
      reconcile()
    },

    setSessionActive(nowActive) {
      if (nowActive === active) {
        return
      }

      active = nowActive
      reconcile()
    },

    dispose() {
      stopWatchingVisibility()
      release()
      listeners.clear()
    },
  }
}
