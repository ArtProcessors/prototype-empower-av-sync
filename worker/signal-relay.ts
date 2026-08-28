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
 * The protocol is the one Trystero's `createTopicStrategy` documents:
 *
 *   client → {type: "subscribe" | "unsubscribe" | "publish", topic, payload}
 *   server → {topic, payload}   to every *other* subscriber of that topic
 *
 * One instance serves every room: Trystero already namespaces topics by
 * app and room id, so rooms cannot see each other's traffic. Sharding by room
 * is a later optimisation, not a correctness requirement.
 */

/** A message arriving from a client. */
interface ClientMessage {
  /** What the client wants done. */
  type?: string
  /** Topic being subscribed to, unsubscribed from, or published to. */
  topic?: unknown
  /** Opaque signalling payload; only `publish` carries one. */
  payload?: unknown
}

/**
 * Per-connection state kept across hibernation. The Durable Object may be
 * evicted from memory between messages, so a socket's subscriptions have to
 * live on the socket itself rather than in a field.
 */
interface SocketState {
  /** Topics this socket currently subscribes to. */
  topics: string[]
}

/** Cap on topics per connection, so a bad client cannot grow state forever. */
const MAX_TOPICS_PER_SOCKET = 64

function readState(socket: WebSocket): SocketState {
  try {
    const attachment = socket.deserializeAttachment() as SocketState | null

    return attachment && Array.isArray(attachment.topics)
      ? attachment
      : { topics: [] }
  } catch {
    return { topics: [] }
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
    writeState(server, { topics: [] })

    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(
    socket: WebSocket,
    raw: ArrayBuffer | string,
  ): Promise<void> {
    if (typeof raw !== 'string') {
      return
    }

    let message: ClientMessage

    try {
      message = JSON.parse(raw) as ClientMessage
    } catch {
      return
    }

    const topic = typeof message.topic === 'string' ? message.topic : null

    if (!topic) {
      return
    }

    if (message.type === 'subscribe') {
      const state = readState(socket)

      if (
        !state.topics.includes(topic) &&
        state.topics.length < MAX_TOPICS_PER_SOCKET
      ) {
        writeState(socket, { topics: [...state.topics, topic] })
      }

      return
    }

    if (message.type === 'unsubscribe') {
      const state = readState(socket)

      writeState(socket, {
        topics: state.topics.filter(existing => existing !== topic),
      })

      return
    }

    if (message.type === 'publish') {
      this.broadcast(socket, topic, message.payload)
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
