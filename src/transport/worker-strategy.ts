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
 * The one thing this adapter adds is a `retain` flag on announces, which the
 * relay uses to replay them to later subscribers. Followers join `passive`
 * (see `sync-controller.ts`) and so stay dormant until they hear the screen;
 * without retention that means waiting out the screen's announce interval on
 * every join and every rejoin. Trystero tells us which publishes are announces
 * via the publish context, so the payload itself stays opaque to us.
 */
import { createTopicStrategy, toJson } from '@trystero-p2p/core'

/** Path the Worker upgrades to the signalling Durable Object. */
const SIGNAL_PATH = '/signal'

/** How long to wait for the relay socket before giving up on a join. */
const CONNECT_TIMEOUT_MS = 8000

/** A message broadcast back by the relay. */
interface RelayMessage {
  /** Topic the payload was published to. */
  topic?: unknown
  /** The opaque signalling payload. */
  payload?: unknown
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
 * Live relay sockets, so {@link getRelaySockets} can report signalling health
 * the same way the Nostr and MQTT strategies do. Without this the diagnostics
 * would report "none connected" on every join and quietly lose the ability to
 * tell a broken relay from an empty room.
 */
const liveSockets = new Set<WebSocket>()

function openSocket(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(relayUrl())

    liveSockets.add(socket)
    socket.addEventListener('close', () => liveSockets.delete(socket), {
      once: true,
    })
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

/** Join a room, meeting peers through this app's own signalling relay. */
export const joinRoom = createTopicStrategy<WebSocket>({
  init: openSocket,

  subscribeTopic: (socket, topic, onMessage) => {
    const onSocketMessage = (event: MessageEvent) => {
      let message: RelayMessage

      try {
        message = JSON.parse(String(event.data)) as RelayMessage
      } catch {
        return
      }

      if (message.topic !== topic) {
        return
      }

      onMessage(topic, message.payload as Parameters<typeof onMessage>[1])
    }

    socket.addEventListener('message', onSocketMessage)
    socket.send(toJson({ type: 'subscribe', topic }))

    return () => {
      // The socket may already be closing as a room is left; unsubscribing is
      // a courtesy to the relay, not a correctness requirement, since the
      // subscription dies with the connection anyway.
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(toJson({ type: 'unsubscribe', topic }))
      }

      socket.removeEventListener('message', onSocketMessage)
    }
  },

  publishTopic: (socket, topic, payload, context) => {
    socket.send(
      toJson({
        type: 'publish',
        topic,
        payload,
        ...(context.kind === 'announce' ? { retain: true } : {}),
      }),
    )
  },

  // Called when a passive peer goes dormant. The relay drops the retained
  // announce so the next subscriber is not handed a peer that has stopped
  // listening; a peer that leaves outright is covered by its socket closing.
  unpublishTopic: (socket, topic) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(toJson({ type: 'unpublish', topic }))
    }
  },
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

  for (const socket of liveSockets) {
    if (socket.readyState === WebSocket.CLOSED) {
      liveSockets.delete(socket)

      continue
    }

    sockets[index === 0 ? url : `${url}#${index}`] = socket
    index += 1
  }

  return sockets
}
