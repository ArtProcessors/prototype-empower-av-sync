import { useCallback, useEffect, useRef, useState } from 'react'

const STORAGE_KEY = 'empower-keep-awake'

/** Read the user's persisted "keep screen awake" preference. */
export function readKeepAwakePref(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

/** Persist the user's "keep screen awake" preference. */
export function writeKeepAwakePref(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? '1' : '0')
  } catch {
    /* private mode */
  }
}

/** Whether this browser exposes the Screen Wake Lock API. */
export function isWakeLockSupported(): boolean {
  return typeof navigator !== 'undefined' && 'wakeLock' in navigator
}

/** What {@link useWakeLock} reports back to the UI. */
export interface WakeLockStatus {
  /** Whether this browser exposes the Screen Wake Lock API at all. */
  supported: boolean
  /** Whether a wake lock is held right now. */
  held: boolean
}

/**
 * Keep the display awake for the duration of an active session (Screen Wake
 * Lock API).
 *
 * @param active whether a session is running
 * @param enabled whether the user has opted in to keeping the screen awake
 */
export function useWakeLock(
  active: boolean,
  enabled: boolean,
): WakeLockStatus {
  const sentinelRef = useRef<WakeLockSentinel | null>(null)
  const [held, setHeld] = useState(false)
  const supported = isWakeLockSupported()

  const release = useCallback(async () => {
    const sentinel = sentinelRef.current

    if (!sentinel) {
      return
    }

    sentinelRef.current = null
    setHeld(false)

    try {
      await sentinel.release()
    } catch {
      /* already released */
    }
  }, [])

  const acquire = useCallback(async () => {
    const canAcquire =
      supported && active && enabled && document.visibilityState === 'visible'

    if (!canAcquire || sentinelRef.current) {
      return
    }

    try {
      const sentinel = await navigator.wakeLock.request('screen')
      sentinelRef.current = sentinel
      setHeld(true)

      sentinel.addEventListener('release', () => {
        if (sentinelRef.current === sentinel) {
          sentinelRef.current = null
          setHeld(false)
        }
      })
    } catch {
      setHeld(false)
    }
  }, [supported, active, enabled])

  useEffect(() => {
    acquire()

    return () => {
      release()
    }
  }, [active, enabled, acquire, release])

  // Browsers release the lock when the tab is hidden — re-acquire on return.
  useEffect(() => {
    if (!active || !enabled) {
      return
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        acquire()
      }
    }

    document.addEventListener('visibilitychange', onVisibilityChange)

    return () =>
      document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [active, enabled, acquire])

  return { supported, held }
}
