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

  // Both halves of a demo want the display lit: an unattended screen for
  // obvious reasons, and a phone because a locked one drops its audio far
  // more readily than a woken one. Set rather than offered — a checkbox here
  // would be one more thing between a visitor and the sound.
  useEffect(() => session.setKeepAwake(true), [session])

  if (state.phase === 'active' && state.transport?.role === 'screen') {
    return (
      <DemoScreenView
        state={state}
        session={session}
        transport={state.transport}
        mountScreenVideo={mountScreenVideo}
      />
    )
  }

  // Anything active that is not the screen is a listener; anything inactive
  // follows the intent, so a failed join lands back on its own start button
  // rather than on the screen's.
  if (state.phase === 'active' || intent === 'listen') {
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
    />
  )
}
