/**
 * The signalling protocol spoken between the client (`src/transport`) and the
 * room relay Durable Object (`worker/room-relay.ts`).
 *
 * It replaces a topic pub/sub protocol built for finding peers over relays
 * that cannot address one — public broadcast relays, where the only way to be
 * found is to shout into a topic. Ours can address a peer. So instead of
 * announcing and hoping the right listener is there, a client says who it is
 * and the relay says who else is in the room.
 *
 * Six frames, and the whole of peer discovery:
 *
 *     client → {t: "join", room, role}
 *     relay  → {t: "joined", self, peers}      the id we were given, and who
 *     relay  → {t: "peer", id, role, present}  someone arrived or left
 *     client → {t: "signal", to, data}         sdp or candidate, addressed
 *     relay  → {t: "signal", from, data}       the same, routed
 *     relay  → {t: "error", reason}            a refused join
 *
 * Four properties fall out of the relay knowing its own membership, none of
 * which the topic protocol could offer:
 *
 *  - **Peer ids are assigned by the relay**, so a client cannot name itself
 *    into another peer's place, nor collide with the id of a page that has
 *    just reloaded.
 *  - **A follower is told only about the screen.** The star stops being a flag
 *    a client sets on itself and becomes a shape the relay enforces — followers
 *    never learn of each other, so they cannot mesh even by accident.
 *  - **One screen per room.** A second claim is refused rather than quietly
 *    forming a second star inside the same room code.
 *  - **A closed socket is a departure.** There is nothing to retain, withdraw,
 *    or time out: membership is whatever is currently connected.
 *
 * As with the protocol it replaces, the asymmetry is deliberate. These types
 * describe what a well-behaved client *sends*; the relay narrows every field
 * of every incoming frame itself, because anything arriving on a socket is
 * untrusted. Deliberately plain data and nothing else: this module is compiled
 * by the app's tsconfig *and* the Worker's, which has no DOM lib.
 */

/** Which end of the star a peer is. */
export type PeerRole = 'screen' | 'follower'

/** Client → relay verbs. Anything else is ignored by the relay. */
export type ClientFrameType = 'join' | 'signal'

/** Longest room code the relay will accept, before it stops reading. */
export const MAX_ROOM_LENGTH = 64

/** Longest signalling payload the relay will route, in JSON characters. */
export const MAX_SIGNAL_CHARS = 64 * 1024

/** A peer already in the room when we joined, or one that has since arrived. */
export interface PeerPresence {
  /** Relay-assigned id, used to address signalling frames. */
  id: string
  /** Which end of the star that peer is. */
  role: PeerRole
}

/** A frame sent from a client to the relay. */
export type ClientFrame =
  | {
      /** Enter a room. Sent once, on a freshly opened socket. */
      t: 'join'
      /** Room code to enter. Opaque to the relay beyond its shape. */
      room: string
      /** Which end of the star this client intends to be. */
      role: PeerRole
    }
  | {
      /** Pass an opaque signalling payload to one other peer. */
      t: 'signal'
      /** Relay-assigned id of the peer to route this to. */
      to: string
      /** Offer, answer or ICE candidate. Never inspected by the relay. */
      data: unknown
    }

/** A frame sent from the relay to a client. */
export type ServerFrame =
  | {
      /** The join succeeded. */
      t: 'joined'
      /** The id the relay assigned to this connection. */
      self: string
      /**
       * Peers already in the room and visible to this one: every follower for
       * a screen, and the screen alone for a follower.
       */
      peers: PeerPresence[]
    }
  | {
      /** A visible peer arrived or left. */
      t: 'peer'
      /** Relay-assigned id of the peer whose presence changed. */
      id: string
      /** Which end of the star that peer is. */
      role: PeerRole
      /** Whether it is now present; `false` means its socket closed. */
      present: boolean
    }
  | {
      /** A signalling payload from another peer. */
      t: 'signal'
      /** Relay-assigned id of the peer that sent it. */
      from: string
      /** Offer, answer or ICE candidate, exactly as it was sent. */
      data: unknown
    }
  | {
      /** The frame could not be honoured. */
      t: 'error'
      /** Why, in terms a diagnostics log can carry. */
      reason: string
    }
