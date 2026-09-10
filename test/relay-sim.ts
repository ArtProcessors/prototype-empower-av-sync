/**
 * Unit checks for the signalling relay's room rules.
 *
 * These are the rules the whole transport rests on — who may join, who is told
 * about whom, where a signalling frame is allowed to go — and every one of
 * them used to be a property of a third-party library's topic protocol, only
 * observable by putting two phones in a room and watching. `relay-room.ts`
 * takes sockets as an opaque type precisely so they can be strings here.
 *
 * Run: `node --import ./test/resolve-ts.mjs test/relay-sim.ts`.
 */
import { assert, report } from './assert.ts'
import {
  departure,
  join,
  signal,
  type Delivery,
  type Member,
  type MemberState,
} from '../worker/relay-room.ts'
import type { PeerRole, ServerFrame } from '../shared/room-protocol.ts'

/** A room under test: sockets are strings, state is held for us. */
class FakeRoom {
  private members: Member<string>[] = []
  private minted = 0

  /** Ids are sequential so assertions can name them. */
  private mint = (): string => `p${++this.minted}`

  /** Connect a socket without joining. */
  connect(socket: string): void {
    this.members.push({ socket, state: null })
  }

  /** Connect and join, returning what the relay sent. */
  join(socket: string, room: string, role: PeerRole): Delivery<string>[] {
    this.connect(socket)

    const outcome = join(
      socket,
      { t: 'join', room, role },
      this.members,
      this.mint,
    )
    const member = this.members.find(entry => entry.socket === socket)!

    member.state = outcome.state

    return outcome.deliveries
  }

  /** Send a signalling frame from a joined socket. */
  signal(from: string, to: string, data: unknown): Delivery<string>[] {
    const sender = this.stateOf(from)

    return sender
      ? signal(sender, { t: 'signal', to, data }, this.members)
      : []
  }

  /** Drop a socket, returning the departure notices. */
  close(socket: string): Delivery<string>[] {
    const leaving = this.stateOf(socket)

    this.members = this.members.filter(entry => entry.socket !== socket)

    return leaving ? departure(leaving, this.members) : []
  }

  /** The id the relay assigned to `socket`, if it joined. */
  idOf(socket: string): string | null {
    return this.stateOf(socket)?.id ?? null
  }

  private stateOf(socket: string): MemberState | null {
    return this.members.find(entry => entry.socket === socket)?.state ?? null
  }
}

/** The frames delivered to one socket, in order. */
function framesTo(
  deliveries: Delivery<string>[],
  socket: string,
): ServerFrame[] {
  return deliveries
    .filter(delivery => delivery.to === socket)
    .map(delivery => delivery.frame)
}

/** The single frame delivered to `socket`, or null if there was not exactly one. */
function frameTo(
  deliveries: Delivery<string>[],
  socket: string,
): ServerFrame | null {
  const frames = framesTo(deliveries, socket)

  return frames.length === 1 ? frames[0]! : null
}

console.log('\n[1] join — the screen arrives first')
{
  const room = new FakeRoom()
  const joined = frameTo(room.join('screen', 'EXTE', 'screen'), 'screen')

  assert(joined?.t === 'joined', 'the screen is admitted')
  assert(
    joined?.t === 'joined' && joined.self === 'p1',
    'and is told the id the relay assigned it',
  )
  assert(
    joined?.t === 'joined' && joined.peers.length === 0,
    'an empty room has nobody to report',
  )
}

console.log(
  '\n[2] join — a follower is introduced to the screen, and vice versa',
)
{
  const room = new FakeRoom()

  room.join('screen', 'EXTE', 'screen')

  const deliveries = room.join('phone', 'EXTE', 'follower')
  const joined = frameTo(deliveries, 'phone')
  const told = frameTo(deliveries, 'screen')

  assert(
    joined?.t === 'joined' && joined.peers.length === 1,
    'the follower is told about the screen',
  )
  assert(
    joined?.t === 'joined' && joined.peers[0]?.role === 'screen',
    'and told which end of the star it is',
  )
  assert(
    told?.t === 'peer' && told.present && told.id === room.idOf('phone'),
    'the screen is told the follower arrived, by id',
  )
  assert(
    deliveries.indexOf(deliveries.find(d => d.to === 'phone')!) === 0,
    'the joiner learns its own id before anyone is told to dial it',
  )
}

console.log('\n[3] join — the star is enforced, not requested')
{
  const room = new FakeRoom()

  room.join('screen', 'EXTE', 'screen')
  room.join('phoneA', 'EXTE', 'follower')

  const deliveries = room.join('phoneB', 'EXTE', 'follower')
  const joined = frameTo(deliveries, 'phoneB')

  assert(
    joined?.t === 'joined' && joined.peers.length === 1,
    'a second follower hears only about the screen',
  )
  assert(
    framesTo(deliveries, 'phoneA').length === 0,
    'and the first follower is never told about it',
  )
  assert(
    room.signal('phoneA', room.idOf('phoneB')!, { sdp: 'x' }).length === 0,
    'a follower cannot signal another follower even knowing its id',
  )
}

console.log('\n[4] join — refusals')
{
  const room = new FakeRoom()

  room.join('screen', 'EXTE', 'screen')

  const second = frameTo(room.join('other', 'EXTE', 'screen'), 'other')

  assert(
    second?.t === 'error' && second.reason === 'room already has a screen',
    'a second screen is refused rather than forming a second star',
  )
  assert(
    room.idOf('other') === null,
    'and the refused socket is left unjoined',
  )

  const elsewhere = frameTo(room.join('far', 'OTHR', 'screen'), 'far')

  assert(
    elsewhere?.t === 'joined',
    'the same claim in a different room is fine',
  )

  const bogus = frameTo(
    room.join('bad', 'EXTE', 'listener' as PeerRole),
    'bad',
  )

  assert(bogus?.t === 'error', 'an unknown role is refused')

  const empty = frameTo(room.join('blank', '', 'follower'), 'blank')

  assert(empty?.t === 'error', 'an empty room code is refused')
}

console.log('\n[5] signal — routing')
{
  const room = new FakeRoom()

  room.join('screen', 'EXTE', 'screen')
  room.join('phone', 'EXTE', 'follower')

  const offer = room.signal('screen', room.idOf('phone')!, { sdp: 'offer' })
  const routed = frameTo(offer, 'phone')

  assert(
    routed?.t === 'signal' && routed.from === room.idOf('screen'),
    'the offer reaches the follower, named by the sender the relay knows',
  )
  assert(
    routed?.t === 'signal' && (routed.data as { sdp: string }).sdp === 'offer',
    'and the payload is passed through untouched',
  )
  assert(
    room.signal('screen', 'p99', { sdp: 'offer' }).length === 0,
    'a frame for an id that is not here is dropped, not answered',
  )

  room.join('faraway', 'OTHR', 'follower')

  assert(
    room.signal('screen', room.idOf('faraway')!, { sdp: 'x' }).length === 0,
    'and one addressed across rooms goes nowhere',
  )
}

console.log('\n[6] departure — a closed socket is the whole story')
{
  const room = new FakeRoom()

  room.join('screen', 'EXTE', 'screen')
  room.join('phoneA', 'EXTE', 'follower')
  room.join('phoneB', 'EXTE', 'follower')

  const phoneAId = room.idOf('phoneA')
  const gone = room.close('phoneA')
  const told = frameTo(gone, 'screen')

  assert(
    told?.t === 'peer' && !told.present && told.id === phoneAId,
    'the screen is told which follower left',
  )
  assert(
    framesTo(gone, 'phoneB').length === 0,
    'and the other follower, which never knew of it, is not',
  )

  const screenGone = room.close('screen')

  assert(
    framesTo(screenGone, 'phoneB').length === 1,
    'a screen leaving is told to every follower',
  )
  assert(room.close('phoneB').length === 0, 'the last peer out tells nobody')
}

console.log('\n[7] departure — a socket that never joined')
{
  const room = new FakeRoom()

  room.join('screen', 'EXTE', 'screen')
  room.connect('lurker')

  assert(
    room.close('lurker').length === 0,
    'a socket that never joined leaves without notifying anyone',
  )
  assert(
    room.signal('lurker', room.idOf('screen')!, { sdp: 'x' }).length === 0,
    'and cannot signal while unjoined',
  )
}

report()
