/**
 * Durable Object backing the room signalling protocol: sockets, hibernation
 * and I/O around the rules in `relay-room.ts`.
 *
 * Nothing here announces. The relay this replaced was a topic pub/sub hub, so
 * a peer became discoverable by publishing into a topic and hoping the right
 * subscriber was listening — which meant retaining the last announce per
 * socket, withdrawing it when a peer went dormant, and a class of failure
 * where a peer sat in a room nobody could see it in. A client now says who it
 * is, this object records that on the socket, and everyone who can see it is
 * told once, immediately, and never again until the socket closes.
 *
 * A stateless Worker cannot do this job: requests land in different isolates
 * with no shared state, so there is nowhere for a screen's offer to meet a
 * follower's connection. A Durable Object is that single coordination point.
 *
 * **Hibernation.** The object may be evicted from memory between messages, so
 * a socket's identity is stored on the socket via `serializeAttachment` rather
 * than in a field, and the room is reconstructed by reading every live socket
 * on each message. That also means a departure needs no cleanup: the socket
 * goes, and with it everything the room knew about that peer.
 *
 * One instance serves every room. Room codes are namespaced within it, and
 * peers are only ever shown members of their own room. Sharding by room is a
 * scale optimisation, not a correctness requirement.
 */
import type { ServerFrame } from '../shared/room-protocol'
import {
  departure,
  join,
  signal,
  type Delivery,
  type Member,
  type MemberState,
} from './relay-room'

/** Length of a minted peer id, in hex characters. */
const PEER_ID_CHARS = 12

/**
 * Longest frame the relay will parse, in characters. Anything larger is
 * dropped unread — a signalling frame is a few kilobytes, and the cap keeps a
 * hostile client from making the object parse megabytes.
 */
const MAX_FRAME_CHARS = 96 * 1024

/**
 * A frame as it actually arrives: every field optional and untyped, because
 * anything on a socket is untrusted. `ClientFrame` in `shared/room-protocol`
 * describes what a well-behaved client *sends*; this is what the relay is
 * willing to assume it received, which is deliberately much less.
 */
interface IncomingFrame {
  /** What the client wants; anything else is ignored. */
  t?: unknown
  /** Room code, on a `join`. */
  room?: unknown
  /** Requested role, on a `join`. */
  role?: unknown
  /** Target peer id, on a `signal`. */
  to?: unknown
  /** Opaque signalling payload, on a `signal`. */
  data?: unknown
}

/** Signalling relay: a room the peers in it are known to. */
export class RoomRelay implements DurableObject {
  private readonly state: DurableObjectState

  constructor(state: DurableObjectState) {
    this.state = state
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade') !== 'websocket') {
      return new Response('expected a websocket upgrade', { status: 426 })
    }

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)

    // Hibernation, not `server.accept()`: an idle connection costs nothing
    // while it waits, which matters when every listener in a venue holds one
    // open for the length of a session.
    this.state.acceptWebSocket(server)

    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(
    socket: WebSocket,
    raw: ArrayBuffer | string,
  ): Promise<void> {
    if (typeof raw !== 'string' || raw.length > MAX_FRAME_CHARS) {
      return
    }

    let incoming: IncomingFrame

    try {
      incoming = JSON.parse(raw) as IncomingFrame
    } catch {
      return
    }

    if (!incoming || typeof incoming !== 'object') {
      return
    }

    if (incoming.t === 'join') {
      this.handleJoin(socket, incoming)

      return
    }

    if (incoming.t === 'signal') {
      this.handleSignal(socket, incoming)
    }
  }

  /**
   * Record who a socket is and tell the room, or refuse it and close.
   *
   * The refusal is sent before the close so the client can say why it failed
   * rather than reporting a bare disconnect — a second screen claiming a room
   * that already has one is a configuration mistake worth naming.
   */
  private handleJoin(socket: WebSocket, incoming: IncomingFrame): void {
    const members = this.members()
    const outcome = join(
      socket,
      {
        t: 'join',
        room: incoming.room as string,
        role: incoming.role as 'screen' | 'follower',
      },
      members,
      mintPeerId,
    )

    if (outcome.state) {
      writeState(socket, outcome.state)
    }

    this.deliver(outcome.deliveries)

    if (!outcome.state) {
      try {
        socket.close(1008, 'join refused')
      } catch {
        /* already closing */
      }
    }
  }

  /** Route a signalling frame, if its sender has joined and may send it. */
  private handleSignal(socket: WebSocket, incoming: IncomingFrame): void {
    const sender = readState(socket)

    // Signalling before joining is not an error worth answering: the client
    // has nothing to address a frame with yet, so it cannot have meant it.
    if (!sender) {
      return
    }

    this.deliver(
      signal(
        sender,
        { t: 'signal', to: incoming.to as string, data: incoming.data },
        this.members(),
      ),
    )
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    this.handleDeparture(socket)
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    this.handleDeparture(socket)
  }

  /**
   * Tell the room a socket has gone.
   *
   * Read before closing, because `getWebSockets()` may still include the
   * departing socket and it must not be told about its own departure.
   */
  private handleDeparture(socket: WebSocket): void {
    const leaving = readState(socket)

    try {
      socket.close()
    } catch {
      /* already closed */
    }

    if (!leaving) {
      return
    }

    const remaining = this.members().filter(member => member.socket !== socket)

    this.deliver(departure(leaving, remaining))
  }

  /** Every live socket, paired with whatever it has told us about itself. */
  private members(): Member<WebSocket>[] {
    return this.state
      .getWebSockets()
      .map(socket => ({ socket, state: readState(socket) }))
  }

  /**
   * Send each frame, skipping any socket that has gone in the meantime. A
   * peer disappearing mid-fan is ordinary and not this loop's problem.
   */
  private deliver(deliveries: Delivery<WebSocket>[]): void {
    for (const { to, frame } of deliveries) {
      try {
        to.send(JSON.stringify(frame satisfies ServerFrame))
      } catch {
        /* the socket went away; its close will clean up after it */
      }
    }
  }
}

/** A fresh peer id. Assigned here so a client cannot name itself. */
function mintPeerId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, PEER_ID_CHARS)
}

function readState(socket: WebSocket): MemberState | null {
  try {
    const attachment = socket.deserializeAttachment() as MemberState | null

    return attachment && typeof attachment.id === 'string' ? attachment : null
  } catch {
    return null
  }
}

function writeState(socket: WebSocket, state: MemberState): void {
  socket.serializeAttachment(state)
}
