/**
 * The follower's transport watchdog: if beats have stopped, rejoin the room.
 *
 * This also runs while the page is HIDDEN. Android Doze throttles the network
 * a few minutes into a screen-off, and WebRTC drops the peer connection when
 * its consent-freshness checks fail — so the listener silently disappears from
 * the screen's peer count and stops receiving beats even though audio keeps
 * free-running. The keep-alive tap means the page itself is still alive and can
 * retry, so we do, just far less often than when visible (battery, and Doze
 * will refuse most attempts anyway — but it recovers on Doze's maintenance
 * windows instead of waiting for the user to wake the phone).
 *
 * The decision itself is {@link reconnectCooldownMs} and
 * {@link transportIsStale}, which are pure and unit-tested; this is only the
 * timer around them.
 */
import { networkLooksUp } from '../diagnostics/reachability'
import type { SyncController } from '../transport/sync-controller'
import { sessionConfig } from './config'
import { reconnectCooldownMs, transportIsStale } from './reconnect-policy'
import { isPageVisible } from './visibility'

/** What the watchdog needs to run. */
export interface TransportWatchdogOptions {
  /** The transport to watch, read fresh on every tick. */
  transport: () => SyncController | null
  /** Live rejoin bookkeeping, shared with whatever performs the rejoin. */
  rejoins: {
    /** Whether a rejoin is already under way. */
    inFlight: boolean
    /** Epoch ms of the last rejoin attempt, or of the join that started it all. */
    lastAttemptAt: number
    /** Consecutive rejoins that never produced a peer; drives the backoff. */
    failures: number
  }
  /** Rebuild the transport. */
  reconnect: () => void
}

/** Start the watchdog. Call the returned function to stop it. */
export function startTransportWatchdog({
  transport,
  rejoins,
  reconnect,
}: TransportWatchdogOptions): () => void {
  const timer = setInterval(() => {
    const controller = transport()

    if (!controller || rejoins.inFlight) {
      return
    }

    const hidden = !isPageVisible()

    // While hidden, only spend a rejoin when a probe has just shown the
    // network is actually usable. On the Android sleep test the watchdog
    // rebuilt the room every 45 s, seven times, and never once peered — pure
    // battery and signalling-relay churn against a radio that was not
    // listening.
    if (hidden && !networkLooksUp()) {
      return
    }

    const syncState = controller.getState()

    // Beats flowing again means the last rejoin worked; start the backoff over
    // so the next outage gets a prompt retry rather than a stale delay.
    if (syncState.screenOnline) {
      rejoins.failures = 0
    }

    const cooldown = reconnectCooldownMs(rejoins.failures, hidden)
    const stale = transportIsStale(syncState.lastBeatAt, Date.now())
    const cooledDown = Date.now() - rejoins.lastAttemptAt > cooldown

    if ((stale || !syncState.screenOnline) && cooledDown) {
      reconnect()
    }
  }, sessionConfig().timing.watchdogMs) as unknown as number

  return () => clearInterval(timer)
}
