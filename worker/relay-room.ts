/**
 * Room bookkeeping for the signalling relay, as decisions over data.
 *
 * The Durable Object around this owns sockets, hibernation and I/O; everything
 * here is "given who is in the room, what should be sent to whom". Keeping the
 * two apart is what makes the rules — who may join, who learns about whom,
 * what a departure notifies — assertable in `test/relay-sim.ts` rather than
 * only observable by putting two phones in a room.
 *
 * Nothing here holds state. Membership is derived from the live sockets on
 * every call, because the Durable Object may be evicted between messages and a
 * socket's identity therefore lives on the socket itself (see
 * {@link MemberState}), not in a field that hibernation would erase.
 *
 * The socket type is a parameter, so the tests can pass strings where the
 * runtime passes `WebSocket`. This module never calls a method on one; it only
 * ever hands them back as the address of a delivery.
 */
import {
  MAX_ROOM_LENGTH,
  MAX_SIGNAL_CHARS,
  type ClientFrame,
  type PeerPresence,
  type PeerRole,
  type ServerFrame,
} from '../shared/room-protocol'

/**
 * What a joined socket is, kept on the socket so it survives hibernation.
 *
 * A socket with no state has connected but not yet joined, and is party to
 * nothing: it receives no presence, routes no signal, and its departure is
 * nobody's business.
 */
export interface MemberState {
  /** Room code this socket joined. */
  room: string
  /** Relay-assigned id for this socket, unique within the room. */
  id: string
  /** Which end of the star this socket is. */
  role: PeerRole
}

/** A live socket paired with its state, as the room logic sees it. */
export interface Member<Socket> {
  /** The connection itself; opaque here. */
  socket: Socket
  /** Who it is, or `null` before it has joined. */
  state: MemberState | null
}

/** One frame, and the socket it should be sent to. */
export interface Delivery<Socket> {
  /** Where to send it. */
  to: Socket
  /** What to send. */
  frame: ServerFrame
}

/** The outcome of a join attempt. */
export interface JoinOutcome<Socket> {
  /**
   * State to record on the joining socket, or `null` when the join was
   * refused — in which case {@link deliveries} carries the reason and the
   * caller should close the socket after sending it.
   */
  state: MemberState | null
  /** Frames to send, joiner first. */
  deliveries: Delivery<Socket>[]
}

/**
 * Whether `role` may be told about a peer holding `otherRole`.
 *
 * The star, expressed once: a screen sees every follower, a follower sees the
 * screen and no other follower. This is why a follower cannot mesh even if its
 * client is buggy or hostile — it is never given another follower's id, and
 * the relay refuses to route to one it was not told about.
 */
function visibleTo(role: PeerRole, otherRole: PeerRole): boolean {
  return role !== otherRole
}

/** Members of `room` that have joined, excluding `exclude` if given. */
function membersOf<Socket>(
  members: Member<Socket>[],
  room: string,
  exclude?: Socket,
): { socket: Socket; state: MemberState }[] {
  const joined: { socket: Socket; state: MemberState }[] = []

  for (const member of members) {
    if (
      member.state &&
      member.state.room === room &&
      member.socket !== exclude
    ) {
      joined.push({ socket: member.socket, state: member.state })
    }
  }

  return joined
}

/** Whether `value` is a room code this relay is willing to carry. */
function isRoomCode(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ROOM_LENGTH &&
    // Control characters would make the code unloggable and unprintable, and
    // nothing that generates one legitimately produces them.
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}

/** Whether `value` is one of the two roles. */
function isRole(value: unknown): value is PeerRole {
  return value === 'screen' || value === 'follower'
}

/**
 * Decide a `join`.
 *
 * @param socket the joining connection
 * @param frame the frame it sent, untrusted
 * @param members every live socket, including the joiner
 * @param mintId supplies a candidate id; called again on the rare collision
 */
export function join<Socket>(
  socket: Socket,
  frame: ClientFrame & { t: 'join' },
  members: Member<Socket>[],
  mintId: () => string,
): JoinOutcome<Socket> {
  const refuse = (reason: string): JoinOutcome<Socket> => ({
    state: null,
    deliveries: [{ to: socket, frame: { t: 'error', reason } }],
  })

  if (!isRoomCode(frame.room)) {
    return refuse('malformed room code')
  }

  if (!isRole(frame.role)) {
    return refuse('unknown role')
  }

  const already = members.find(member => member.socket === socket)

  // A socket joins once. Letting it re-join would strand the presence its
  // first identity had already been announced under.
  if (already?.state) {
    return refuse('already joined')
  }

  const present = membersOf(members, frame.room, socket)

  if (
    frame.role === 'screen' &&
    present.some(m => m.state.role === 'screen')
  ) {
    return refuse('room already has a screen')
  }

  const taken = new Set(present.map(m => m.state.id))

  let id = mintId()

  while (taken.has(id)) {
    id = mintId()
  }

  const state: MemberState = { room: frame.room, id, role: frame.role }
  const visible = present.filter(m => visibleTo(state.role, m.state.role))
  const peers: PeerPresence[] = visible.map(m => ({
    id: m.state.id,
    role: m.state.role,
  }))

  return {
    state,
    deliveries: [
      { to: socket, frame: { t: 'joined', self: id, peers } },
      // Only to the peers that can see this one, and only after the joiner
      // knows its own id: a dial that arrived first would name a peer that
      // does not yet know it is being dialled.
      ...visible.map(member => ({
        to: member.socket,
        frame: {
          t: 'peer' as const,
          id,
          role: state.role,
          present: true,
        },
      })),
    ],
  }
}

/**
 * Route a `signal` from `sender` to the peer it names.
 *
 * A frame addressed to a peer the sender cannot see is dropped rather than
 * answered with an error: the only way to send one is to have invented the id,
 * and telling an inventor whether it guessed right is a probe this relay need
 * not answer.
 *
 * @param sender who is sending, already joined
 * @param frame the frame it sent, untrusted
 * @param members every live socket
 */
export function signal<Socket>(
  sender: MemberState,
  frame: ClientFrame & { t: 'signal' },
  members: Member<Socket>[],
): Delivery<Socket>[] {
  if (typeof frame.to !== 'string' || !frame.to) {
    return []
  }

  if (frame.data === undefined) {
    return []
  }

  // Bounded so one client cannot make the relay fan an unbounded payload. An
  // SDP for a two-channel connection is a few kilobytes; the cap is generous
  // enough that only abuse reaches it.
  if (JSON.stringify(frame.data).length > MAX_SIGNAL_CHARS) {
    return []
  }

  const target = membersOf(members, sender.room).find(
    member =>
      member.state.id === frame.to &&
      visibleTo(sender.role, member.state.role),
  )

  if (!target) {
    return []
  }

  return [
    {
      to: target.socket,
      frame: { t: 'signal', from: sender.id, data: frame.data },
    },
  ]
}

/**
 * Announce that `leaving` has gone, to the peers that could see it.
 *
 * @param leaving the departing socket's state
 * @param members every live socket, with the departing one already removed
 */
export function departure<Socket>(
  leaving: MemberState,
  members: Member<Socket>[],
): Delivery<Socket>[] {
  return membersOf(members, leaving.room)
    .filter(member => visibleTo(leaving.role, member.state.role))
    .map(member => ({
      to: member.socket,
      frame: {
        t: 'peer' as const,
        id: leaving.id,
        role: leaving.role,
        present: false,
      },
    }))
}
