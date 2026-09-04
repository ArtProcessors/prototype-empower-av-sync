/**
 * Unit checks for the headless keep-awake controller.
 *
 * A wake lock cannot be acquired while a page is hidden, and the browsers that
 * matter here are phones — so the interesting transitions (opt in mid-session,
 * lose the lock to a background, get it back on return) are awkward to drive
 * and easy to get subtly wrong. Stubbing the three platform APIs it touches
 * makes the state machine assertable instead.
 *
 * Run: `node --import ./test/resolve-ts.mjs test/keep-awake-sim.ts`.
 */
import { assert, report } from './assert.ts'

/** A stand-in for the platform bits `createKeepAwakeController` reaches for. */
interface Platform {
  /** Pretend the page became visible or hidden, firing the listener. */
  setVisible(visible: boolean): void
  /** Wake locks handed out so far, newest last. */
  granted: FakeSentinel[]
  /** Locks that have not been released. */
  heldCount(): number
  /** Make the next `request('screen')` reject. */
  failNext(): void
  /** Fire a sentinel's `release` event, as a browser does on backgrounding. */
  revoke(sentinel: FakeSentinel): void
  /** Wipe the stored opt-in, so each block starts from a known preference. */
  forgetPreference(): void
}

interface FakeSentinel {
  released: boolean
  release(): Promise<void>
  addEventListener(type: string, listener: () => void): void
}

function installPlatform(): Platform {
  const store = new Map<string, string>()
  const visibilityListeners = new Set<() => void>()
  const granted: FakeSentinel[] = []

  let visible = true
  let failNext = false

  const document = {
    get visibilityState() {
      return visible ? 'visible' : 'hidden'
    },
    addEventListener(type: string, listener: () => void) {
      if (type === 'visibilitychange') {
        visibilityListeners.add(listener)
      }
    },
    removeEventListener(type: string, listener: () => void) {
      if (type === 'visibilitychange') {
        visibilityListeners.delete(listener)
      }
    },
  }

  const navigator = {
    wakeLock: {
      async request(): Promise<FakeSentinel> {
        if (failNext) {
          failNext = false

          throw new Error('denied')
        }

        const releaseListeners = new Set<() => void>()
        const sentinel: FakeSentinel = {
          released: false,
          async release() {
            sentinel.released = true
          },
          addEventListener(type, listener) {
            if (type === 'release') {
              releaseListeners.add(listener)
            }
          },
        }

        Object.defineProperty(sentinel, 'fire', {
          value: () => releaseListeners.forEach(listener => listener()),
        })
        granted.push(sentinel)

        return sentinel
      },
    },
  }

  const localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  }

  // Node exposes its own `navigator` as a getter-only property, so a plain
  // assignment throws; each global is defined rather than assigned.
  for (const [name, value] of Object.entries({
    document,
    navigator,
    localStorage,
  })) {
    Object.defineProperty(globalThis, name, {
      value,
      configurable: true,
      writable: true,
    })
  }

  return {
    setVisible(next) {
      visible = next
      visibilityListeners.forEach(listener => listener())
    },
    granted,
    heldCount: () => granted.filter(sentinel => !sentinel.released).length,
    failNext() {
      failNext = true
    },
    revoke(sentinel) {
      // A browser handing the lock back both marks it released and fires the
      // event; the fake has to do the same or later counts are wrong.
      sentinel.released = true
      ;(sentinel as unknown as { fire(): void }).fire()
    },

    forgetPreference() {
      store.clear()
    },
  }
}

const platform = installPlatform()

// Imported after the globals exist: the module reads `navigator` for its
// support check as soon as a controller is built.
const { createKeepAwakeController } = await import('../src/core/keep-awake.ts')

/** Let the controller's floating acquire/release promises settle. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

console.log('\n[1] nothing is held until a session wants one')
{
  const wake = createKeepAwakeController()

  assert(wake.getState().supported === true, 'reports the API as supported')
  assert(wake.getState().enabled === false, 'defaults to opted out')

  wake.setEnabled(true)
  await settle()
  assert(
    platform.heldCount() === 0,
    'opting in with no session acquires nothing',
  )

  wake.setSessionActive(true)
  await settle()
  assert(platform.heldCount() === 1, 'a session with opt-in takes the lock')
  assert(wake.getState().held === true, 'and reports it as held')

  wake.dispose()
}

console.log('\n[2] the preference outlives a controller')
{
  const remembered = createKeepAwakeController()

  assert(
    remembered.getState().enabled === true,
    'a fresh controller picks up the opt-in stored in [1]',
  )

  remembered.dispose()
  platform.forgetPreference()

  const wake = createKeepAwakeController()

  wake.setSessionActive(true)
  await settle()
  assert(
    platform.heldCount() === 0,
    'a session without opt-in acquires nothing',
  )

  wake.dispose()
}

console.log('\n[3] opting out mid-session releases')
{
  const wake = createKeepAwakeController()

  wake.setEnabled(true)
  wake.setSessionActive(true)
  await settle()
  assert(platform.heldCount() === 1, 'held while opted in')

  wake.setEnabled(false)
  await settle()
  assert(platform.heldCount() === 0, 'released on opting out')
  assert(wake.getState().held === false, 'and reported as not held')

  wake.dispose()
}

console.log('\n[4] leaving the session releases')
{
  const wake = createKeepAwakeController()

  wake.setEnabled(true)
  wake.setSessionActive(true)
  await settle()
  assert(platform.heldCount() === 1, 'held during the session')

  wake.setSessionActive(false)
  await settle()
  assert(platform.heldCount() === 0, 'released when the session ends')

  wake.dispose()
}

console.log('\n[5] hidden pages cannot hold a lock, and get it back on return')
{
  platform.setVisible(false)

  const wake = createKeepAwakeController()

  wake.setEnabled(true)
  wake.setSessionActive(true)
  await settle()
  assert(
    platform.heldCount() === 0,
    'nothing is acquired while the page is hidden',
  )

  platform.setVisible(true)
  await settle()
  assert(platform.heldCount() === 1, 're-acquired on becoming visible')

  // Browsers hand the lock back on their own when a tab is backgrounded.
  platform.revoke(platform.granted[platform.granted.length - 1])
  assert(
    wake.getState().held === false,
    'a browser-initiated release is reflected in the state',
  )

  platform.setVisible(true)
  await settle()
  assert(platform.heldCount() === 1, 'and re-acquired on the next return')

  wake.dispose()
}

console.log('\n[6] never more than one lock at a time')
{
  const wake = createKeepAwakeController()

  wake.setEnabled(true)
  wake.setSessionActive(true)
  await settle()

  // Repeated reconciles must not stack sentinels — each one releases first.
  for (const active of [false, true, false, true]) {
    wake.setSessionActive(active)
    await settle()
  }

  assert(platform.heldCount() === 1, 'churn leaves exactly one lock held')

  wake.dispose()
  await settle()
  assert(platform.heldCount() === 0, 'dispose releases it')
}

console.log('\n[7] a refused request is not reported as held')
{
  const wake = createKeepAwakeController()

  platform.failNext()
  wake.setEnabled(true)
  wake.setSessionActive(true)
  await settle()

  assert(
    wake.getState().held === false,
    'a rejected request leaves held false',
  )
  assert(wake.getState().enabled === true, 'but the preference still stands')

  wake.dispose()
}

console.log('\n[8] the snapshot is reference-stable between changes')
{
  const wake = createKeepAwakeController()
  const first = wake.getState()

  assert(wake.getState() === first, 'repeated reads return the same object')

  wake.setEnabled(!first.enabled)
  assert(wake.getState() !== first, 'a real change produces a new object')

  const second = wake.getState()
  wake.setEnabled(second.enabled)
  assert(wake.getState() === second, 'a no-op change does not churn it')

  wake.dispose()
}

report()
