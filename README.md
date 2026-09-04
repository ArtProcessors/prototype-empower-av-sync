# Empower — A/V Sync (feasibility spike)

A **fixed screen plays a looping video** and acts as a permanent leader, continuously
broadcasting its playback clock over WebRTC so **joining phones keep their local audio
tightly locked to the video** ("shared screen + personal headphone audio"). The wire carries
only tiny sync beats — never audio/video. Short content is device-local (PWA-cached); long
content streams its audio from static hosting, window by window.

Sibling of `empower-peer-to-peer` (reuses its Trystero transport + PWA/offline patterns),
but with a purpose-built continuous sync engine instead of the gallery's event model — and
with peer signalling and TURN credentials served by the app's own Cloudflare Worker rather
than by public relays.

**Stack:** Vite 7 · React 18 · TypeScript · `vite-plugin-pwa` (offline) · `trystero`
(WebRTC data channels) · Cloudflare Worker + Durable Object (signalling, TURN credentials,
static hosting) · `mp4box` + WebCodecs (windowed audio decode) · Yarn 4 · Node 24.13.0.

## Run

**Two processes, always.** The Worker carries both halves of joining a room — peer
signalling (`/signal`) and the TURN credentials every connection is relayed through
(`/api/ice`) — so without it the app cannot find a peer or connect to one. Run both in
separate terminals and open **Vite's** URL, not Wrangler's:

```bash
nvm use && corepack enable
yarn install

yarn worker:dev   # :8787 — /signal, /api/ice, /api/ping
yarn dev          # :3100 — open this one
```

Vite proxies `/api` and `/signal` (the latter with `ws: true`, since signalling upgrades to a
WebSocket) to the Worker, so both are same-origin locally just as they are in production. Put
the TURN key in `.dev.vars` first (see `.env.example`); no Cloudflare login is needed for
local work.

| Command           | What it does                                                              |
| ----------------- | ------------------------------------------------------------------------- |
| `yarn dev`        | Dev server on :3100 (HMR, no service worker) — **open this one**          |
| `yarn worker:dev` | Signalling + TURN-credential Worker on :8787, proxied from Vite           |
| `yarn build`      | Type-check app + Worker, production build (builds the SW)                 |
| `yarn preview`    | Prod build on :4273 (SW active — offline testing; still needs the Worker) |
| `yarn deploy`     | Build, then deploy the Worker + SPA to Cloudflare                         |
| `yarn sim`        | Unit checks for the sync math and session policy (`test/sync-sim.ts`)     |
| `yarn test:check` | Type-check the sims (they sit outside the app's tsconfig)                 |

To rehearse exactly what deploys — **one origin** serving the app, `/signal` and `/api/ice`,
service worker active — run `yarn build` then `yarn worker:dev` and open **:8787**. That is
the only local mode with production's topology.

## Two UIs

The same session, `src/core`, is rendered by two hosts. Which one you get is a query
parameter, read once per page load:

| URL         | UI                                                                                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/`         | **Demo** (`src/ui/demo/`) — what a visitor sees. Video edge to edge with the join QR over it; on a phone, one button and one line of status.                       |
| `/?debug=1` | **Debug** (`src/ui/debug/`) — the instrument this spike was built with: video picker, room-code entry, live drift readout, sync-state rows and the connection log. |

A debug screen's QR carries `&debug=1`, so a phone scanning it lands in the debug follower;
a demo screen's QR carries only the room. Nothing in `src/core` knows either exists.

## Try it — demo

1. On the display device, open the app, **pick a video**, and tap **Start**. The video goes
   full-bleed and a QR card sits in the bottom-right corner. The operator controls (listener
   count, Refresh, Stop) sit top-right at low opacity and come up on hover or focus.
2. On phones, scan the QR and tap **Listen** (the tap unlocks audio on iOS). Put on
   headphones. The ring reports what the session is doing — downloading the soundtrack,
   reconnecting, in sync — and **Refresh** is always in the footer, promoted after 20 seconds
   of unresolved trouble.

The test clip has a **per-second flash + click** and a sweeping bar, so drift is instantly
visible and audible: the click in your headphones should land on the flash on screen.

## Try it — debug

1. Open `/?debug=1` on the display device, **pick a video** from the dropdown, and tap
   **📺 Be the screen** (starts the looping video and shows a room code + QR).
2. On phones, scan the QR / enter the code and tap **🎧 Join**. Put on headphones — a live
   **drift meter** shows how far off the phone is (ms).

The debug panel's `engine` row shows which output path is live (`element`, `buffer`, `stream`,
or `syncing` while a long soundtrack's first window loads).

## Deploy

One Cloudflare Worker serves the built SPA, `/api/ice` and the `/signal` WebSocket, so both
the TURN-credential fetch and peer signalling are same-origin in production and there is no
CORS surface. `yarn deploy` runs `yarn build` first, so the `dist/` it uploads is always
current, and the `SignalRelay` Durable Object migration in `wrangler.toml` applies on the
first deploy.

**Authenticating.** `wrangler login` works but grants a broad OAuth scope set
(`workers:write`, `workers_kv:write`, `d1:write`, `pages:write`, `zone:read`, …). Prefer a
scoped API token — create one from the dashboard's **"Edit Cloudflare Workers"** template
and export it for the deploy:

```bash
export CLOUDFLARE_API_TOKEN=...      # add CLOUDFLARE_ACCOUNT_ID if the token sees several
yarn deploy
```

The same variable works for `wrangler secret put`, so the whole flow needs no browser login.

The token belongs to you, not to the repo, so keep it out of the project. For a one-off,
`read -rs CLOUDFLARE_API_TOKEN && export CLOUDFLARE_API_TOKEN` avoids leaving it in shell
history; for repeat deploys, the macOS Keychain
(`security add-generic-password -a "$USER" -s cloudflare-api-token -w`, read back with
`security find-generic-password … -w`) keeps it encrypted at rest. A file outside the repo
also works via `yarn wrangler deploy --env-file ~/.cloudflare.env`.

Do **not** put it in `.env` (Wrangler reads it, but so does Vite — see `.env.example`), and
do **not** put it in `.dev.vars`: that file populates the _Worker's_ `env` bindings, so an
account-level token there would be handed to Worker code at runtime rather than
authenticating the CLI.

**First deploy, in order.** The `workers.dev` subdomain is not knowable until the Worker
exists, so locking the endpoint down takes two passes:

1. `yarn deploy` — creates the Worker and prints
   `https://empower-av-sync.<subdomain>.workers.dev`. The app loads, but `/api/ice` returns
   500 and the diagnostics panel reports `turn preflight FAILED — no credentials`. Expected.
2. `yarn wrangler secret put TURN_KEY_ID`, then the same for `TURN_KEY_API_TOKEN`. These
   apply immediately — no redeploy needed. Reload and the panel should report
   `turn preflight OK — relay via …` (which transports appear depends on the network).
3. Set `ALLOWED_ORIGINS` in `wrangler.toml` to the URL from step 1, then `yarn deploy` again.

`ALLOWED_ORIGINS` deters casual cross-site use of the credential endpoint; it is **not**
authentication, since `Origin` is trivially forged outside a browser. Anyone who finds an
open endpoint can mint credentials that relay traffic billed to the account, so put a
Cloudflare rate-limiting rule in front of `/api/ice` before this is public. Same-origin
requests from the SPA send no `Origin` header, so the check never interferes with normal use.

**Watching it.** Worker Logs are enabled in `wrangler.toml`, so a deployed session can be
diagnosed from the dashboard or streamed while testing from a phone:

```bash
yarn wrangler tail
```

**Assets.** Workers cap a single asset at 25 MiB. `public/.assetsignore` excludes
`public/media/`, which holds the large local-only screen videos; deployed builds serve the
real content from remote hosting instead (see [Videos](#videos--adding-your-own)).

## How the sync works

- **`beat`** (screen → all, ~4×/sec): `{ mediaId, videoTime, wall, playing, duration }` —
  which video is selected, where it is, and the screen's wall-clock at that instant.
- **`clk`** (follower → screen RPC): estimates the **clock offset** between devices via
  Cristian's algorithm (`offset = tScreen − (t0+t2)/2`), keeping the lowest-RTT sample.
- **Corrector** (~15 Hz on each follower): computes the screen's current position
  `target = videoTime + (now + offset − wall)`, wrapped to the loop, and measures loop-aware
  `signedDrift(local, target)`. It then steers **one of three output engines** onto that
  target — chosen per source (`streaming` flag) and per platform:
  - **Element (Android/desktop, short content):** an `<audio>` element routed through Web
    Audio — small drifts close by **nudging `playbackRate`** (pitch preserved, 0.97–1.03),
    large drifts hard-seek. Also the fallback if either engine below fails to load.
  - **Buffer (iOS, short content):** Safari's media-element pipeline stalls >1 s on every
    seek, so the follower decodes the **whole** soundtrack and plays the `AudioBuffer` on the
    AudioContext clock instead — repositioning is a sample-accurate source-node swap (no
    stall) and rate nudges are subtler (0.98–1.02).
  - **Stream (any platform, long content):** whole-file decode costs **~21 MB of PCM per
    minute**, so a 45-minute track would need ~950 MB. This engine parses only the `moov`
    (via `mp4box`), keeps a sample table of byte offsets/timing, then range-fetches and
    **WebCodecs-decodes a 60 s window** around the playhead, sliding it in 45 s steps
    (prefetched 30 s early, swapped seamlessly inside the 15 s overlap). Memory stays flat in
    track length. Inside a window it behaves exactly like the buffer engine. Needs
    **WebCodecs** (iOS 16.4+), AAC-LC, a faststart MP4, and HTTP Range + CORS.

### Where things live

The app is split into a **headless core** and a **React host**, so the sync logic can carry a
different UI in another project without being rewritten.

| Layer                   | What's in it                                                                                                                                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/`             | The session: `createSyncSession()` composes the transport, the corrector, the watchdog, the wake lock and the screen's video output, and exposes one snapshot store. No React, no JSX. `src/core/index.ts` is the whole public surface. |
| `src/sync/sync-math.ts` | Pure, unit-tested offset/target/drift/rate math.                                                                                                                                                                                        |
| `src/transport/`        | Trystero rooms, beats, the clock RPC, ICE config and the Worker signalling strategy.                                                                                                                                                    |
| `src/media/`            | The follower's corrector and its three output paths (`audio-sync-controller.ts`, `buffer-audio-engine.ts`, `streaming-buffer-engine.ts`).                                                                                               |
| `src/diagnostics/`      | The session log and the monitors that feed it.                                                                                                                                                                                          |
| `src/content/`          | _This app's_ media — the catalogue is handed to the core, not imported by it.                                                                                                                                                           |
| `src/ui/`, `src/hooks/` | The React host. `useSync()` subscribes to the session's snapshot; `ui/demo/` and `ui/debug/` are two sets of views over it, picked by `ui/ui-mode.ts`.                                                                                  |
| `shared/`               | Types and route literals compiled by both the app's and the Worker's tsconfig.                                                                                                                                                          |

### Reusing the core

```ts
import { createSyncSession, configureSession } from './core'

configureSession({ timing: { transportStaleMs: 8000 } }) // optional
const session = createSyncSession({ media: myCatalogue })

session.start()
session.subscribe(() => render(session.getState()))
await session.join('K7QF') // inside a user gesture
```

`createSyncSession` needs a `MediaCatalogue` and nothing else; the browser defaults cover the
rest. The screen's video is a port — pass your own `ScreenVideoOutput` to play through
something that is not a DOM element. A React host instead configures the built-in one through
`useSync({ screenVideo: { configure } })`, which hands over the `<video>` once, before any
gesture; `loop`, `muted` and `playsInline` are load-bearing and everything else is the
host's. Timings, room-code rules, storage keys and drift bands are `configureSession()`; the
Trystero app id and the Worker routes are `configureTransport()` in `src/transport/`. Both
default to what this app uses, and nothing here calls either.

## Diagnostics

Both roles render a **Debug — connection log** below the main UI in the debug UI
([DiagnosticsPanel.tsx](src/ui/debug/DiagnosticsPanel.tsx)) — the instrument the connection-stability
work was done with. It carries a summary line (freezes · peer leaves · rejoins · longest timer
stall) and a one-tap **Copy log**, and the buffer is mirrored to `sessionStorage` so a log
survives the browser discarding the tab. Events are tagged `beat`, `ice`, `net`, `page`,
`peer`, `timer` or `transport`.

The lines worth knowing:

- **`turn preflight OK — relay via …`** — credentials minted and a relay candidate actually
  allocated, checked at startup before anyone joins
  ([turn-preflight.ts](src/diagnostics/turn-preflight.ts)).
- **`ab12cd path relay→relay over tls (wifi)`** — the _selected_ candidate pair once a peer
  connects. The transport comes from Chromium's `relayProtocol`, not `protocol`: the latter
  always reads `udp` on a relay candidate, describing the relay's far leg rather than the link
  this phone is holding. A pair that is not `relay→relay` is logged **`— NOT RELAYED`**, which
  means the ICE pinning has been defeated and the session is no longer testing the service.
- **`probe OK (142ms) — network usable`** — the `/api/ping` reachability probe that gates
  rejoin attempts while the page is hidden ([reachability.ts](src/diagnostics/reachability.ts)).
  Without that gate a five-minute sleep burned seven room rebuilds against a radio that was off.
- **`relays (rejoin): none connected`** — signalling socket health, which is what separates a
  throttled or dead relay from a room that is simply empty
  ([relay-sockets.ts](src/diagnostics/relay-sockets.ts)).
- **`signalling relay dropped — reconnecting`** / **`signalling relay reconnected — 2 topics
restored`** — the relay socket died and came back, with the room's subscriptions and
  announce replayed onto the new socket. The screen also shows a banner while this is
  outstanding, since its listener count no longer reflects whether anyone can still join.
- **`FROZEN by the browser`** and **`gap 41.2s`** — Chrome froze the page, or the 1 Hz liveness
  timer stalled. The two symptoms of Android power-save killing a session.

The separate audio debug panel above it shows the live `engine`, `audio out` and
`latency comp` rows.

## Verification

- **`yarn sim`** — offset/target/drift/rate math incl. the loop seam. All pass. (The streaming
  engine's window/chain/clock-ratio machinery has no automated coverage — it only shares the
  pure helpers the sim exercises.)
- **Live (two clients in-browser):** follower locks to the screen's video at **single-digit-ms
  drift**, `mode: locked`, `playbackRate ≈ 1`, tracking correctly across a loop wrap; the
  screen shows the listener count.
- **Offline:** `yarn build && yarn preview`, load once, go offline, reload — the app and the
  **`test` clip** play from cache (precache includes `screen.mp4` + `soundtrack.m4a`). The
  long options are **not** offline: their audio is range-fetched throughout playback.
- **Two-device (manual):** laptop = screen, phone (headphones) = follower — clicks line up
  with flashes; drift stays small on WiFi and cellular. Peers meet over the Worker's `/signal`
  relay and every connection is relayed through Cloudflare TURN, so the Worker must be running
  (`yarn worker:dev`) or joining fails outright — at discovery or at connection, respectively.
- **Sleep/lock (manual, iterative):** lock the phone mid-session — audio keeps playing and the
  page stays alive (keep-alive tap), but the **network does not**: Android powers its Wi-Fi down
  at screen-off, so the link dies within ~10 s and only returns when the screen does. Hold the
  "Keep screen awake" option to keep a session connected. On wake the follower hands back to a
  synced source. Worth watching the screen's listener count as well as the phone: a follower that
  has silently lost its connection still plays. Verified by
  device testing rather than measurement; see [FEASIBILITY.md](FEASIBILITY.md) for what's open.

### Regression checklist

The automated checks cover the pure math and the type surface; everything that made this app
hard is device behaviour. Run this list after any change to the session, the transport or the
audio path — and **capture a baseline sleep log first**, so step 3 has something to compare
against. `yarn build` runs the app, Worker and sim type-checks; `yarn sim` runs the unit
checks; `yarn format:check` runs Prettier.

1. **iOS, join:** tap Join → audible within a few seconds, debug panel shows
   `engine: buffer` or `stream` and `audio out: web-audio`. Flick the ringer switch off —
   still audible.
2. **iOS, lock:** lock the screen mid-session → audio continues; unlock → no audible jump.
3. **Android, sleep:** 10 minutes screen-off, then copy the connection log. Compare
   **freezes / peer leaves / rejoins / longest stall** against the baseline — the summary line
   at the top of the log is the regression signal.
4. **Rejoin:** reload a follower → the rejoin card offers the right room code. Scan the
   screen's QR from a second device → joins that room.
5. **Two clients, 5 minutes foreground:** `mode: locked`, single-digit-ms drift, `rate ≈ 1`,
   still tracking across a loop wrap; the screen's listener count is right.
6. **Leave:** leave from both roles → both land on the entry screen, and the rejoin card does
   **not** appear after a deliberate leave.

## Videos & adding your own

The leader picks the video from a dropdown; the choice is broadcast in each beat (`mediaId`)
so followers load the matching audio. Three options ship (`src/content/index.ts`):

| id       | Video (screen)                         | Audio (followers)               | Delivery                                                  |
| -------- | -------------------------------------- | ------------------------------- | --------------------------------------------------------- |
| `test`   | synthetic clip, flash+click cues (20s) | `soundtrack.m4a`                | committed, **precached** (fully offline)                  |
| `soh`    | `soh.mp4` (~127 MB H.264)              | `soh.m4a` (~14 MB)              | remote (`content.dev.pladia.live`), **`streaming: true`** |
| `sync45` | `sync-test-45mins.mp4` (~860 MB)       | `sync-test-45mins.m4a` (~43 MB) | remote, **`streaming: true`**                             |

**Followers only ever download the audio** — the screen fetches the video, each follower only
the soundtrack (e.g. ~14 MB vs ~127 MB for `soh`). With `streaming: true` the follower doesn't
even fetch the whole soundtrack up front: it pulls ~60 s of compressed audio at a time, roughly
1.3× the audio bitrate sustained (~20 KB/s at ~128 kbps), for as long as it's listening.

A `videoUrl`/`soundtrackUrl` can be a bundled import (precached), a `public/media/` path
(served by path, runtime-cached), or an absolute URL on static hosting — the two long options
use the last. Absolute URLs used by a `streaming` entry **must** serve `Accept-Ranges: bytes`
and permissive CORS.

To add your own, produce a browser-friendly **H.264 + AAC-LC** MP4 and its extracted audio,
then add an entry to `VIDEOS`. From a source file:

```bash
# audio the followers play (stream-copy the AAC → identical timeline, tiny download):
ffmpeg -i source.mov -vn -c:a copy -movflags +faststart mine.m4a
# video the screen plays — transcode to H.264 if the source is HEVC/H.265 (Chrome can't decode HEVC):
ffmpeg -i source.mov -c:v libx264 -preset veryfast -crf 26 -pix_fmt yuv420p -c:a copy -movflags +faststart mine.mp4
```

(If the source is already H.264/AAC, remux instead: `ffmpeg -i source.mp4 -c copy -movflags +faststart mine.mp4`.)
Keep the audio a stream-copy of the video's own track so their timelines match exactly, and
keep `+faststart` on the audio — the streaming engine needs the `moov` in the first 24 MB.

## Notes & limits

- **iOS audio / the ringer switch:** a bare `<audio>` element is "ambient" audio on iOS and
  is silenced by the physical mute switch and silent mode (playback still advances — you'd
  see the drift move but hear nothing). Follower audio is therefore always routed through the
  **Web Audio API** (context resumed in the join tap), which plays regardless of the mute
  switch. The debug panel's `audio out` row shows `web-audio (mute-switch safe)` when this is
  active. AAC/m4a itself is natively supported on iOS — format is not the issue.
- **Background / lock-screen playback:** iOS suspends the AudioContext when the screen locks,
  and both platforms throttle the ~15 Hz corrector and the WebRTC beats when the page is
  hidden. The follower's output stage is therefore permanently split into two legs from a shared
  master gain — a **direct leg** (`ctx.destination`) and a **sink leg**
  (`MediaStreamAudioDestinationNode` → `<audio>` element registered as the **MediaSession**) —
  and `visibilitychange` cross-fades between them over 6 ms rather than re-wiring nodes:
  1. iOS keeps the sink leg audible throughout (it's what survives the lock, and it bypasses
     the mute switch). Android/desktop keep the direct leg audible in the foreground and swap
     to the sink when backgrounding, skipping content forward by the sink's added buffering so
     the audio doesn't fall behind the screen.
  2. **The sink leg is never silent.** Chrome on Android won't freeze a page that is playing
     audio, and freezing kills the WebRTC connection with it — so even in the foreground the
     sink element is fed a far-below-audible copy (`KEEPALIVE_GAIN`, 0.005 ≈ 46 dB down) to keep
     the page alive for the whole session. Tune or disable with `?kagain=<0–1>`.
  3. On hide, the streaming engine also pre-schedules a **chain of buffer sources directly on
     the audio thread** (~180 s runway, topped up from each source's `onended`), so playback
     free-runs without needing a timer.
     The chain runs at the **measured screen:device clock ratio** — a least-squares fit of target
     seconds against context seconds, clamped to ±0.5 % — rather than a blind 1.0, so a locked
     phone drifts far less than the crystals' ppm difference would imply. On wake the chain is
     deliberately left playing (WebRTC takes seconds to return) until a live target arrives, at
     which point a properly synced source starts and the chain is cut at the same de-clicked
     instant. Tuning knobs for on-device work: `?runway=<sec>` (background runway),
     `?sinklat=<sec>` (the sink's assumed added latency, default 0.15) and `?kagain=<gain>`.
- **Reconnect after sleep:** Android takes its Wi-Fi down at screen-off — measured, with plain
  HTTPS fetches timing out sixteen times running while the page itself stayed fully awake — so
  the listener vanishes from the screen's count while its audio keeps free-running. A watchdog in
  the session (`src/core/transport-watchdog.ts`) rejoins the room if beats have been absent
  > 6 s, without touching the audio
  > engine — no gesture needed, and the free-run chain keeps sounding across the reconnect. While
  > hidden it only attempts a rejoin once a `/api/ping` probe has shown the network is back, since
  > otherwise it is rebuilding rooms against a radio that is not listening; on becoming visible it
  > rejoins straight away if the link is stale. If the tab is discarded outright, the room code is kept in
  > `sessionStorage` and the landing page offers a one-tap **Rejoin** (re-unlocking audio needs a
  > real gesture, so that part can't be automatic).
- **Automatic output-latency compensation (BYOD — no manual calibration):** what you _hear_
  trails the element/context clock by the device's output latency (~100–300 ms on iOS;
  Bluetooth adds even more). We measure it at runtime from
  `AudioContext.getOutputTimestamp()` (`currentTime − contextTime` = the true
  scheduling→output delay, and it reflects the real output path _including Bluetooth_),
  smoothed, with `outputLatency` as a fallback and a conservative default only if both read 0.
  Audio is steered ahead by that amount so the _audible_ audio lands on the video. The debug
  `latency comp: auto N ms` shows the live estimate (≈220 ms on the test Chrome). Note:
  `outputLatency` is unreliable (0 on iOS Safari and 0-until-warmup on Chrome), which is why
  `getOutputTimestamp` is the primary signal. The estimate is **held for 4 s after a wake**,
  when platform readings are noisy enough to look like real drift.
- **Loop wrap on streaming sources:** nothing is decoded across the seam, so when the target
  wraps to 0 the follower briefly shows `syncing` while a fresh window fetches and decodes.
  Fine on a 45-minute loop, conspicuous on a short one.
- **WebCodecs is required for long content.** Without `AudioDecoder` (iOS < 16.4) a
  `streaming` source falls back to the whole-file buffer engine on iOS — which is exactly the
  unbounded decode the streaming engine exists to avoid. Known gap; see FEASIBILITY.md.
- The follower's soundtrack is a **stream-copy of the video's own AAC**, so their timelines
  are bit-identical (no encoder-delay offset).
- Fixed leader (no migration); star topology, in the transport as well as the protocol.
  Trystero meshes a room by default — every peer dials every other — which for this app is
  pure cost, since nothing is ever sent follower to follower: at 30 phones, 435 of the 465
  connections would carry nothing while each phone held 30 relayed connections instead of
  one. **Followers therefore join `passive`**, which makes them refuse each other and dial
  only the screen. Verified with one screen and two followers: each follower reports one
  peer, the screen reports two.
- **Peer signalling is the app's own Durable Object**
  ([signal-relay.ts](worker/signal-relay.ts)) at `/signal`, served by the same Worker as the
  SPA and `/api/ice` — a stateless Worker cannot hold the WebSockets, hence the DO. It
  replaced free Nostr relays, which rate-limited peer discovery and sat in the path of every
  join and every reconnect; peering measured 0.8 s against their 1.4–2.2 s. Trystero's public
  backends have been removed rather than kept as a switch: only the app's own relay retains
  announces, so selecting one would not be a like-for-like fallback but a quietly slower join
  path for passive followers. ICE is **pinned to Cloudflare TURN, relay-only**
  (`iceTransportPolicy: 'relay'`, Trystero's default Google STUN servers replaced): the
  Android connection-stability work needs every peer on the relay, so there is deliberately
  no direct-path or public-STUN fallback to hide behind.
- **The signalling connection outlives its socket.** Trystero asks for a relay once per room
  and holds that reference for the room's life, so a dropped `/signal` socket used to end
  discovery for good — a Worker redeploy left the screen playing happily to the listeners it
  already had, listener count unchanged, and invisible to every join until its tab was
  reloaded. Followers recovered only by accident, via the watchdog's room rebuild; a screen
  has no such trigger, because from where it stands nothing went wrong. The connection in
  [worker-strategy.ts](src/transport/worker-strategy.ts) now reconnects underneath Trystero
  with jittered backoff (500 ms doubling to 15 s, 45 s while hidden, retried at once on
  becoming visible), re-subscribes the room's topics and **re-announces** — the relay drops a
  socket's retained announce when it closes, so without that last step the room would come
  back silent to new joiners. Peer connections are untouched throughout; the room is never
  rebuilt. Verified by killing the Worker mid-session: drop seen in 1 s, recovery logged with
  `2 topics restored`, and the next listener peered in under a second.
- **TURN credentials are minted per client, not built in.** A Cloudflare Worker
  ([worker/index.ts](worker/index.ts)) holds the long-lived TURN key and issues a short-lived
  pair from `/api/ice`; the client re-fetches whenever its grant is within 5 minutes of
  expiry, **including on the watchdog's rejoin**. A baked-in credential would expire
  mid-session and make every reconnect fail silently — indistinguishable from the bug the
  relay was added to fix.
- Same-network tests show ~0 ms clock offset; across real devices the offset estimate
  (NTP-class clocks + RTT compensation) is what keeps drift small — the instrument to watch
  is the follower's drift meter.
- Add or swap videos via the dropdown + `VIDEOS` in `src/content/index.ts` — see
  "Videos & adding your own" above.
- The large real assets live on remote static hosting (local copies in git-ignored
  `public/media/` for regeneration). The committed `test` clip is what stays
  offline-guaranteed.
