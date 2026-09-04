/**
 * Durable Object backing Trystero's signalling: a small WebSocket pub/sub hub.
 *
 * Signalling is the last uncontrolled third party in this app. Peers currently
 * meet over public Nostr relays, which rate-limit ("you are noting too much"),
 * go offline, and sit in the critical path of every join *and* every recovery
 * from a dropped connection. Fine for a spike; not something to run a venue
 * installation on.
 *
 * A stateless Worker cannot do this job — requests land in different isolates
 * with no shared state, so there is nowhere for one peer's offer to meet
 * another peer's subscription. A Durable Object is that single coordination
 * point.
 *
 * The wire format is Trystero's `createTopicStrategy` protocol plus announce
 * retention, and is written down once in `shared/relay-protocol.ts`. What
 * follows is why the retention is there.
 *
 * **Announce retention** is the one thing this relay does that a plain pub/sub
 * hub would not, and it is what makes a star topology affordable. Trystero's
 * `passive` peers do not announce until they have heard an active peer, so a
 * follower joining a pure fan-out relay waits for the screen's next announce —
 * up to 5.3 s, on the join and rejoin paths that matter most. Retaining each
 * socket's last announce per topic and replaying it to whoever subscribes next
 * removes that wait: a follower hears the screen the instant it subscribes.
 *
 * Only announces are retained, and only the most recent per socket. They are
 * presence beacons (`{peerId}` — the encrypted offer/answer traffic goes to
 * peer-specific topics), so a stale one costs at most one dial at a peer that
 * has gone, and it is dropped the moment its socket closes.
 *
 * One instance serves every room: Trystero already namespaces topics by
 * app and room id, so rooms cannot see each other's traffic. Sharding by room
 * is a later optimisation, not a correctness requirement.
 */

import type { ClientMessageType } from '../shared/relay-protocol'

/**
 * A frame as it actually arrives: every field optional and untyped, because
 * anything on a socket is untrusted. `ClientMessage` in `shared/relay-protocol`
 * describes what a well-behaved client *sends*; this describes what this relay
 * is willing to *assume*, which is deliberately much less. Each field is
 * narrowed at the point of use.
 */
interface IncomingMessage {
  /** What the client wants done; anything else is ignored. */
  type?: ClientMessageType
  /** Topic being subscribed to, unsubscribed from, or published to. */
  topic?: unknown
  /** Opaque signalling payload; only `publish` carries one. */
  payload?: unknown
  /**
   * Whether this publish is an announce, and so should be kept and replayed to
   * later subscribers. The client sets it from Trystero's own publish context
   * (`kind: 'announce'`), which keeps the payload opaque to this relay.
   */
  retain?: unknown
}

/**
 * Per-connection state kept across hibernation. The Durable Object may be
 * evicted from memory between messages, so a socket's subscriptions have to
 * live on the socket itself rather than in a field.
 */
interface SocketState {
  /** Topics this socket currently subscribes to. */
  topics: string[]
  /**
   * The most recent announce this socket published, per topic, replayed to
   * whoever subscribes to that topic next. Kept on the socket rather than in
   * the object so it survives hibernation — and so it disappears with the
   * connection, which is all the cleanup a departed peer needs.
   */
  announces: Record<string, unknown>
}

/** Cap on topics per connection, so a bad client cannot grow state forever. */
const MAX_TOPICS_PER_SOCKET = 64

/**
 * Cap on retained announces per connection. A socket serves one room and so
 * announces on one topic; the headroom is for a client that rejoins without
 * dropping its socket, and the cap keeps the attachment well inside its size
 * limit.
 */
const MAX_ANNOUNCES_PER_SOCKET = 4

/** Cap on announces replayed into a single subscribe, bounding the fan-out. */
const MAX_REPLAYED_ANNOUNCES = 64

/** A socket with nothing recorded against it yet. */
function emptyState(): SocketState {
  return { topics: [], announces: {} }
}

function readState(socket: WebSocket): SocketState {
  try {
    const attachment = socket.deserializeAttachment() as SocketState | null

    if (!attachment || !Array.isArray(attachment.topics)) {
      return emptyState()
    }

    // `announces` post-dates the first version of this state, so a socket that
    // connected before a deploy can be missing it.
    return attachment.announces ? attachment : { ...attachment, announces: {} }
  } catch {
    return emptyState()
  }
}

function writeState(socket: WebSocket, state: SocketState): void {
  socket.serializeAttachment(state)
}

/** WebSocket pub/sub hub for Trystero peer discovery. */
export class SignalRelay implements DurableObject {
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

    // Hibernation, not `server.accept()`: an idle relay connection costs
    // nothing while it waits, which matters when every listener holds one open
    // for the length of a session.
    this.state.acceptWebSocket(server)
    writeState(server, emptyState())

    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(
    socket: WebSocket,
    raw: ArrayBuffer | string,
  ): Promise<void> {
    if (typeof raw !== 'string') {
      return
    }

    let message: IncomingMessage

    try {
      message = JSON.parse(raw) as IncomingMessage
    } catch {
      return
    }

    const topic = typeof message.topic === 'string' ? message.topic : null

    if (!topic) {
      return
    }

    switch (message.type) {
      case 'subscribe': {
        const state = readState(socket)

        if (
          !state.topics.includes(topic) &&
          state.topics.length < MAX_TOPICS_PER_SOCKET
        ) {
          writeState(socket, { ...state, topics: [...state.topics, topic] })
        }

        this.replayAnnounces(socket, topic)

        return
      }

      case 'unsubscribe': {
        const state = readState(socket)

        writeState(socket, {
          ...state,
          topics: state.topics.filter(existing => existing !== topic),
        })

        return
      }

      // A passive peer that has gone dormant withdraws its announce, so nobody
      // subscribing later is told to dial a peer that has stopped listening.
      case 'unpublish': {
        const state = readState(socket)

        if (topic in state.announces) {
          const announces = { ...state.announces }

          delete announces[topic]
          writeState(socket, { ...state, announces })
        }

        return
      }

      case 'publish': {
        if (message.retain === true) {
          this.retainAnnounce(socket, topic, message.payload)
        }

        this.broadcast(socket, topic, message.payload)

        return
      }

      default:
        // Unknown or missing type — ignore (untrusted JSON).
        return
    }
  }

  /**
   * Keep `payload` as this socket's announce on `topic`, replacing whatever it
   * announced there before — only the latest is of any use.
   */
  private retainAnnounce(
    socket: WebSocket,
    topic: string,
    payload: unknown,
  ): void {
    const state = readState(socket)

    if (
      !(topic in state.announces) &&
      Object.keys(state.announces).length >= MAX_ANNOUNCES_PER_SOCKET
    ) {
      return
    }

    writeState(socket, {
      ...state,
      announces: { ...state.announces, [topic]: payload },
    })
  }

  /**
   * Send `subscriber` every other socket's retained announce for `topic`, so a
   * peer joining an established room learns who is already there without
   * waiting for the next announce to come round.
   */
  private replayAnnounces(subscriber: WebSocket, topic: string): void {
    let sent = 0

    for (const socket of this.state.getWebSockets()) {
      if (sent >= MAX_REPLAYED_ANNOUNCES) {
        break
      }

      if (socket === subscriber) {
        continue
      }

      const announce = readState(socket).announces[topic]

      if (announce === undefined) {
        continue
      }

      try {
        subscriber.send(JSON.stringify({ topic, payload: announce }))
        sent += 1
      } catch {
        /* the subscriber going away mid-replay is not this loop's problem */
      }
    }
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    // Subscriptions live on the socket, so a close cleans itself up. Closing
    // explicitly keeps the runtime from holding a half-open connection.
    try {
      socket.close()
    } catch {
      /* already closed */
    }
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    try {
      socket.close()
    } catch {
      /* already closed */
    }
  }

  /**
   * Send `payload` to every socket subscribed to `topic`, except the sender —
   * a peer has no use for its own announcements, and echoing them back doubles
   * the message count that Durable Object requests are billed on.
   */
  private broadcast(sender: WebSocket, topic: string, payload: unknown): void {
    const body = JSON.stringify({ topic, payload })

    for (const socket of this.state.getWebSockets()) {
      if (socket === sender) {
        continue
      }

      if (!readState(socket).topics.includes(topic)) {
        continue
      }

      try {
        socket.send(body)
      } catch {
        /* a socket that has gone away is not this loop's problem */
      }
    }
  }
}
