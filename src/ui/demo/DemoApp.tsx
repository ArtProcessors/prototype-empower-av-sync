import { useEffect, useState } from 'react'

import type { SyncBinding } from '../../hooks/useSync'
import { roomToJoin } from '../launch-intent'
import { useLaunchVideo } from '../useLaunchVideo'
import { DemoFollowerView } from './DemoFollowerView'
import { DemoScreenStart } from './DemoScreenStart'
import { DemoScreenView } from './DemoScreenView'

/** Which half of the demo this device is here to be. */
type DemoIntent = 'screen' | 'listen'

/**
 * The consumer-facing UI: a video wall on one device, a single button on
 * everyone else's phone.
 *
 * It is the same session the debug UI drives — see `hooks/useSync` — with the
 * instrument panel taken away. Which half a device gets is decided by how it
 * arrived: scanning the screen's QR carries a room code, so that device is
 * here to listen; opening the bare URL means it is the display. Both are
 * overridable, because a phone with no camera-scanned link still has to be
 * able to join.
 *
 * The display's own setup can arrive the same way. A link naming a video, and
 * optionally asking it to start, takes this UI down to nothing an operator has
 * to touch — see `ui/launch-intent.ts`.
 */
export function DemoApp({ state, session, mountScreenVideo }: SyncBinding) {
  // Read once, at mount, so a later re-render cannot change what this device
  // thinks it is. `roomToJoin` holds the precedence — an explicit `?room=`
  // beats a remembered one, and `?autostart=` beats both.
  const [invitedRoom] = useState(() => roomToJoin())
  const [intent, setIntent] = useState<DemoIntent>(() =>
    invitedRoom !== null ? 'listen' : 'screen',
  )
  const launch = useLaunchVideo({ state, session })
  // Set only by the start button's own animation, so it defaults to "go
  // straight there" — an `?autostart=1` display, which never renders a button
  // to press, must not be held up waiting for a sequence that cannot play.
  const [held, setHeld] = useState(false)

  // Both halves of a demo want the display lit: an unattended screen for
  // obvious reasons, and a phone because a locked one drops its audio far
  // more readily than a woken one. Set rather than offered — a checkbox here
  // would be one more thing between a visitor and the sound.
  useEffect(() => session.setKeepAwake(true), [session])

  // The transport this device is leading on, or `null` when it is not the
  // screen. Kept as the narrowed value rather than a boolean so both branches
  // below can test it and one of them can pass it on.
  const asScreen =
    state.phase === 'active' && state.transport?.role === 'screen'
      ? state.transport
      : null

  // Held back only by the start button's own animation, and only as far as
  // the start screen — never into one of the other two branches, which is
  // what a plain `&& !held` on this test would have done to a screen whose
  // room opened before the lap closed.
  if (asScreen && !held) {
    return (
      <DemoScreenView
        state={state}
        session={session}
        transport={asScreen}
        mountScreenVideo={mountScreenVideo}
      />
    )
  }

  // Anything active that is not the screen is a listener; anything inactive
  // follows the intent, so a failed join lands back on its own start button
  // rather than on the screen's.
  if (!asScreen && (state.phase === 'active' || intent === 'listen')) {
    return (
      <DemoFollowerView
        state={state}
        session={session}
        invitedRoom={invitedRoom}
        onSetUpScreen={() => setIntent('screen')}
      />
    )
  }

  return (
    <DemoScreenStart
      state={state}
      session={session}
      launch={launch}
      onListen={() => setIntent('listen')}
      onHold={setHeld}
    />
  )
}
