/**
 * The signalling protocol spoken between the client's Trystero strategy
 * (`src/transport/worker-strategy.ts`) and the relay Durable Object
 * (`worker/signal-relay.ts`).
 *
 * It is Trystero's own `createTopicStrategy` protocol plus announce retention:
 *
 *   client → {type: "subscribe" | "unsubscribe" | "publish", topic, payload}
 *   client → {type: "publish", topic, payload, retain: true}   an announce
 *   client → {type: "unpublish", topic}                        drop an announce
 *   server → {topic, payload}   to every *other* subscriber of that topic
 *
 * Note the asymmetry, which is deliberate rather than an oversight: the client
 * builds messages from these types, but the relay does **not** parse incoming
 * frames as {@link ClientMessage}. It keeps its own `unknown`-typed shape and
 * narrows each field, because anything arriving on a socket is untrusted. These
 * types describe what a well-behaved client sends, not what the relay may
 * assume it received.
 */

/** Client → relay verbs. Unknown values are ignored by the relay. */
export type ClientMessageType =
  'subscribe' | 'unsubscribe' | 'publish' | 'unpublish'

/** A message sent from a client to the relay. */
export type ClientMessage =
  | {
      /** Topic subscription changes and announce withdrawals. */
      type: 'subscribe' | 'unsubscribe' | 'unpublish'
      /** Topic being acted on. */
      topic: string
    }
  | {
      /** Send an opaque signalling payload to a topic's other subscribers. */
      type: 'publish'
      /** Topic being published to. */
      topic: string
      /** Opaque signalling payload. */
      payload?: unknown
      /**
       * Whether this publish is an announce, and so should be kept and
       * replayed to later subscribers. Set from Trystero's own publish context
       * (`kind: 'announce'`), which keeps the payload opaque to the relay.
       */
      retain?: boolean
    }

/** A payload the relay broadcast back to a topic's subscribers. */
export interface RelayFrame {
  /** Topic the payload was published to. */
  topic?: unknown
  /** The opaque signalling payload. */
  payload?: unknown
}
