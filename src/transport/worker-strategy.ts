/**
 * Trystero strategy that meets peers over this app's own Durable Object
 * (`worker/signal-relay.ts`) instead of public Nostr relays.
 *
 * The public relays rate-limit — one answered "you are noting too much" during
 * testing while a follower was retrying a join — and they sit in the critical
 * path of every join and every recovery from a dropped connection. Since the
 * app already deploys a Worker for TURN credentials, signalling can live there
 * too, leaving no third party in the join path at all.
 *
 * `createTopicStrategy` is Trystero's own helper for a pub/sub relay: it owns
 * the room lifecycle (announce scheduling, passive mode, peer-specific topics)
 * and asks this adapter only to move opaque messages between named topics.
 *
 * Two things this adapter adds on top of that:
 *
 *  - **A `retain` flag on announces**, which the relay keeps and replays to
 *    later subscribers. Followers join `passive` (see `sync-controller.ts`) and
 *    so stay dormant until they hear the screen; without retention that means
 *    waiting out the screen's announce interval on every join and every
 *    rejoin. Trystero tells us which publishes are announces via the publish
 *    context, so the payload itself stays opaque to us.
 *  - **A connection that outlives its socket.** Trystero asks for a relay once
 *    per room and holds that reference for the room's life, so a dropped
 *    WebSocket used to end signalling for good. What that looked like: a
 *    Worker redeploy dropped every socket, the screen carried on with the peer
 *    connections it already had — video playing, listener count unchanged —
 *    and was invisible to every join from then until its tab was reloaded.
 *    Followers only recovered by accident, because their watchdog rejoins the
 *    room when beats stop and a rejoin opened a fresh socket; the screen has no
 *    such trigger, since from where it stands nothing has gone wrong. So
 *    {@link createRelayConnection} reconnects underneath Trystero and puts the
 *    room back the way it was.
 */
import { createTopicStrategy, toJson } from '@trystero-p2p/core'

import { recordDiagnostic } from '../diagnostics/session-log'

/** Path the Worker upgrades to the signalling Durable Object. */
const SIGNAL_PATH = '/signal'

/** How long to wait for the relay socket before giving up on a join. */
const CONNECT_TIMEOUT_MS = 8000

/** Delay before the first reconnect attempt; doubles from here. */
const RECONNECT_BASE_MS = 500

/** Ceiling on the reconnect backoff while the page is visible. */
const RECONNECT_MAX_MS = 15000

/**
 * Ceiling while the page is hidden, matching the slower cadence the transport
 * watchdog uses there. A backgrounded Android phone has taken its Wi-Fi down
 * (see FEASIBILITY, "Screen-off kills the radio"), so retrying briskly only
 * spends battery against a radio that is not listening. Becoming visible
 * retries immediately, so the slower ceiling costs nothing on wake.
 */
const RECONNECT_MAX_HIDDEN_MS = 45000

/**
 * Fraction of the backoff to scatter attempts across. A Worker redeploy drops
 * every socket in the venue at once, and without this they would all come back
 * on the same schedule and arrive together.
 */
const RECONNECT_JITTER = 0.3

/** Receives payloads published to a subscribed topic. */
type TopicHandler = (topic: string, payload: unknown) => void

/** A message broadcast back by the relay. */
interface RelayMessage {
  /** Topic the payload was published to. */
  topic?: unknown
  /** The opaque signalling payload. */
  payload?: unknown
}

/** Client → relay verbs (mirrors the Durable Object protocol). */
type OutboundRelayMessage =
  | { type: 'subscribe' | 'unsubscribe' | 'unpublish'; topic: string }
  | { type: 'publish'; topic: string; payload?: unknown; retain?: boolean }

/**
 * A relay connection that survives losing its socket: it remembers what it is
 * subscribed to and what it last announced, and restores both on reconnect.
 * This — not a `WebSocket` — is what Trystero holds for the life of a room.
 */
interface RelayConnection {
  /** Route `onMessage` to `topic`; call the result to stop listening. */
  subscribe(topic: string, onMessage: TopicHandler): () => void
  /**
   * Publish to `topic`. An announce is kept, so it can be re-sent after a
   * reconnect — the relay drops a socket's retained announce when it closes.
   */
  publish(topic: string, payload: unknown, announce: boolean): void
  /** Withdraw this connection's retained announce on `topic`. */
  unpublish(topic: string): void
  /** The socket in use right now, or `null` while between sockets. */
  currentSocket(): WebSocket | null
}

/**
 * WebSocket URL for the relay, derived from wherever the app is served. In
 * production the Worker serves both, so this is same-origin; in development
 * Vite proxies it. Either way there is no host to configure.
 */
function relayUrl(): string {
  const url = new URL(SIGNAL_PATH, window.location.href)

  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'

  return url.toString()
}

/**
 * Live connections, so {@link getRelaySockets} can report signalling health
 * the same way the Nostr and MQTT strategies do. Without this the diagnostics
 * would report "none connected" on every join and quietly lose the ability to
 * tell a broken relay from an empty room.
 */
const liveConnections = new Set<RelayConnection>()

function openSocket(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(relayUrl())
    const timer = setTimeout(() => {
      socket.close()
      reject(
        new Error(`signalling relay did not open in ${CONNECT_TIMEOUT_MS}ms`),
      )
    }, CONNECT_TIMEOUT_MS)

    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timer)
        resolve(socket)
      },
      { once: true },
    )

    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timer)
        reject(new Error('signalling relay connection failed'))
      },
      { once: true },
    )
  })
}

/**
 * Wrap an open socket in a connection that reopens it if it drops, and puts
 * the room's subscriptions and announce back afterwards.
 */
function createRelayConnection(initial: WebSocket): RelayConnection {
  const handlers = new Map<string, Set<TopicHandler>>()
  const announces = new Map<string, unknown>()

  let socket: WebSocket | null = initial
  let released = false
  let attempts = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * Send if there is a socket to send on. A message dropped mid-outage is not
   * worth queueing: Trystero re-announces on its own schedule, and an offer
   * whose answer never came is retried by the room. What does have to survive
   * is the subscription and announce state, which {@link restore} replays.
   */
  const send = (message: OutboundRelayMessage): void => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(toJson(message))
    }
  }

  const onMessage = (event: MessageEvent): void => {
    let message: RelayMessage

    try {
      message = JSON.parse(String(event.data)) as RelayMessage
    } catch {
      return
    }

    if (typeof message.topic !== 'string') {
      return
    }

    const topic = message.topic

    handlers.get(topic)?.forEach(handler => handler(topic, message.payload))
  }

  const onClose = (event: Event): void => {
    const dead = event.target as WebSocket

    dead.removeEventListener('message', onMessage)

    if (released || dead !== socket) {
      return
    }

    socket = null
    recordDiagnostic('net', 'signalling relay dropped — reconnecting')
    scheduleReconnect()
  }

  /**
   * Coming back to the foreground is the moment to stop waiting out a backoff.
   * It matters most on the screen, which has no watchdog of its own: a
   * follower rebuilds its room when beats stop, but a screen with a dead
   * socket sees nothing wrong and would otherwise sit out the full delay.
   */
  const onVisibility = (): void => {
    if (released || socket || document.visibilityState !== 'visible') {
      return
    }

    clearTimeout(reconnectTimer)
    reconnectTimer = undefined
    attempts = 0
    scheduleReconnect()
  }

  const attach = (next: WebSocket): void => {
    socket = next
    next.addEventListener('message', onMessage)
    next.addEventListener('close', onClose, { once: true })
  }

  /**
   * Put the room back on a fresh socket: every live subscription, then every
   * announce. Order matters — the announce is what other peers discover us by,
   * and it is worth nothing if we are not yet listening for their reply.
   */
  const restore = (): void => {
    for (const topic of handlers.keys()) {
      send({ type: 'subscribe', topic })
    }

    for (const [topic, payload] of announces) {
      send({ type: 'publish', topic, payload, retain: true })
    }
  }

  function scheduleReconnect(): void {
    if (released || reconnectTimer) {
      return
    }

    const ceiling =
      document.visibilityState === 'hidden'
        ? RECONNECT_MAX_HIDDEN_MS
        : RECONNECT_MAX_MS
    const backoff = Math.min(ceiling, RECONNECT_BASE_MS * 2 ** attempts)
    const delay = backoff * (1 - RECONNECT_JITTER * Math.random())

    attempts += 1
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined

      if (released) {
        return
      }

      openSocket().then(
        next => {
          if (released) {
            next.close()

            return
          }

          attach(next)
          attempts = 0
          restore()
          recordDiagnostic(
            'net',
            `signalling relay reconnected — ${handlers.size} topics restored`,
          )
        },
        () => scheduleReconnect(),
      )
    }, delay)
  }

  /** Leaving for good: stop reconnecting and let the socket go. */
  const release = (): void => {
    released = true
    clearTimeout(reconnectTimer)
    document.removeEventListener('visibilitychange', onVisibility)
    liveConnections.delete(connection)

    if (socket) {
      socket.removeEventListener('message', onMessage)
      socket.removeEventListener('close', onClose)

      try {
        socket.close()
      } catch {
        /* already closing */
      }
    }
  }

  const connection: RelayConnection = {
    subscribe(topic, handler) {
      const existing = handlers.get(topic)
      const topicHandlers = existing ?? new Set<TopicHandler>()

      if (!existing) {
        handlers.set(topic, topicHandlers)
      }

      topicHandlers.add(handler)
      send({ type: 'subscribe', topic })

      return () => {
        topicHandlers.delete(handler)

        if (topicHandlers.size === 0) {
          handlers.delete(topic)
          // A courtesy to the relay rather than a correctness requirement: a
          // subscription dies with its socket anyway.
          send({ type: 'unsubscribe', topic })
        }

        // Trystero drops every subscription when a room is left, and this
        // connection serves exactly one room, so an empty handler map means
        // there is nothing left to reconnect for.
        if (handlers.size === 0) {
          release()
        }
      }
    },

    publish(topic, payload, announce) {
      if (announce) {
        announces.set(topic, payload)
      }

      send({
        type: 'publish',
        topic,
        payload,
        ...(announce ? { retain: true } : {}),
      })
    },

    unpublish(topic) {
      announces.delete(topic)
      send({ type: 'unpublish', topic })
    },

    currentSocket() {
      return socket
    },
  }

  attach(initial)
  document.addEventListener('visibilitychange', onVisibility)
  liveConnections.add(connection)

  return connection
}

async function openConnection(): Promise<RelayConnection> {
  return createRelayConnection(await openSocket())
}

/** Join a room, meeting peers through this app's own signalling relay. */
export const joinRoom = createTopicStrategy<RelayConnection>({
  init: openConnection,

  subscribeTopic: (relay, topic, onMessage) =>
    relay.subscribe(topic, (subscribed, payload) =>
      onMessage(subscribed, payload as Parameters<typeof onMessage>[1]),
    ),

  publishTopic: (relay, topic, payload, context) =>
    relay.publish(topic, payload, context.kind === 'announce'),

  // Called when a passive peer goes dormant. The relay drops the retained
  // announce so the next subscriber is not handed a peer that has stopped
  // listening; a peer that leaves outright is covered by its socket closing.
  unpublishTopic: (relay, topic) => relay.unpublish(topic),
})

/**
 * Relay sockets, in the shape the other strategies expose, so the diagnostics
 * report signalling health the same way regardless of backend. Keys are
 * suffixed when a session holds more than one — a rejoin opens a fresh socket
 * before the old one has finished closing.
 */
export function getRelaySockets(): Record<string, WebSocket> {
  const url = relayUrl()
  const sockets: Record<string, WebSocket> = {}

  let index = 0

  for (const connection of liveConnections) {
    const socket = connection.currentSocket()

    // No socket means a reconnect is in flight. Reporting nothing for it is
    // the honest answer: signalling is down for this connection right now.
    if (!socket || socket.readyState === WebSocket.CLOSED) {
      continue
    }

    sockets[index === 0 ? url : `${url}#${index}`] = socket
    index += 1
  }

  return sockets
}
