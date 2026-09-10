# Empower — A/V Sync (feasibility spike)

A **fixed screen plays a looping video** and acts as a permanent leader,
broadcasting its playback clock over WebRTC so **joining phones keep their own
local audio locked to that video** — shared picture, personal headphones. The
wire carries only tiny sync beats, never media.

Measured drift is single-digit milliseconds, on iOS Safari as well as Android
Chrome, with no per-device calibration step.

> **Looking for the analysis?** What was proven, what is still open, the
> trade-offs and the recommendations all live in
> [FEASIBILITY.md](FEASIBILITY.md). This file is for getting the thing running
> and knowing your way around it.

Sibling of `empower-peer-to-peer` — it reuses that project's Trystero transport
and PWA/offline patterns, but with a continuous sync engine in place of the
gallery's event model.

**Stack:** Vite 7 · React 18 · TypeScript · `vite-plugin-pwa` · Trystero
(WebRTC data channels) · Cloudflare Worker + Durable Object (signalling, TURN
credentials, hosting) · `mp4box` + WebCodecs · Yarn 4 · Node 24.13.0.

## The 30-second version

```
  SCREEN (leader)                              FOLLOWER (phone)
  ┌────────────────┐   beat 4×/s (WebRTC)   ┌────────────────────┐
  │ <video> loops  │ ─────────────────────► │ corrector @ ~15 Hz │
  │ mediaId, time  │ ◄───── clk RPC ─────── │ nudges playbackRate│
  └────────────────┘      (every 3 s)       │ on its own audio   │
         ▲                                  └────────────────────┘
         │ signalling + TURN creds                    ▲
         └───────── Cloudflare Worker ────────────────┘
```

- The screen sends a **`beat`** ~4×/sec — `mediaId`, `videoTime`, `wall`,
  `playing`, `duration`.
- Each follower runs a **`clk`** RPC every 3 s to estimate the clock offset
  between the two devices (Cristian's algorithm, lowest-RTT sample wins).
- A **~15 Hz corrector** on the follower extrapolates where the screen is now,
  measures loop-aware drift, and steers its local audio onto it — small drifts
  by nudging playback rate, large ones by repositioning.
- Every peer connection is **relayed through Cloudflare TURN** (relay-only
  ICE); peers find each other through the app's **own signalling Durable
  Object**. Both come from the same Worker that serves the app.

## Quick start

**You need two processes.** The Worker carries both halves of joining a room —
peer signalling (`/signal`) and the TURN credentials every connection is
relayed through (`/api/ice`) — so without it the app cannot find a peer or
connect to one.

```bash
nvm use && corepack enable
yarn install
```

Put your Cloudflare TURN key in `.dev.vars` first (see [.env.example](.env.example)
for the two values). No Cloudflare login is needed for local work.

```bash
yarn worker:dev   # :8787 — /signal, /api/ice, /api/ping
yarn dev          # :3100 — open THIS one
```

Vite proxies `/api` and `/signal` (the latter with `ws: true`, since signalling
upgrades to a WebSocket) to the Worker, so both are same-origin locally exactly
as they are in production.

### Scripts

| Command           | What it does                                                      |
| ----------------- | ----------------------------------------------------------------- |
| `yarn dev`        | Dev server on :3100 (HMR, no service worker) — **open this one**  |
| `yarn worker:dev` | Signalling + TURN Worker on :8787, proxied from Vite              |
| `yarn build`      | Type-checks app + Worker + sims, then production build (incl. SW) |
| `yarn preview`    | Prod build on :4273 (SW active — offline testing)                 |
| `yarn sim`        | Unit checks: sync math, session policy, transcript model          |
| `yarn format`     | Prettier over the repo (`format:check` to verify)                 |
| `yarn deploy`     | Build, then deploy Worker + SPA to Cloudflare                     |

### Which local mode to use

| Mode                                               | Use it for                                                             |
| -------------------------------------------------- | ---------------------------------------------------------------------- |
| `yarn dev` + `yarn worker:dev`, open **:3100**     | Everyday work. HMR, no service worker in the way.                      |
| `yarn preview` + `yarn worker:dev`, open **:4273** | Offline / service-worker behaviour.                                    |
| `yarn build` + `yarn worker:dev`, open **:8787**   | Production topology: one origin serving app, `/signal` and `/api/ice`. |

## Try it

1. **On the display**, open the app, pick a video and tap **Start** — or open
   `/?video=test&autostart=1`, which does both. The video goes full-bleed and a
   QR card sits in the bottom-right.
2. **On a phone**, scan the QR and tap **Listen** (the tap is what unlocks audio
   on iOS). Put on headphones. The ring reports what the session is doing —
   downloading, reconnecting, in sync.

The `test` clip has a **per-second flash + click** and a sweeping bar, so drift
is instantly visible and audible: the click in your headphones should land on
the flash on screen.

Add `?debug=1` to either half for the instruments (see
[Debugging](#debugging--diagnostics)). A QR scanned off an instrumented screen
carries `&debug=1`, so the phone lands instrumented too.

## Features

**Fixed-leader sync protocol** ([sync-controller.ts](src/transport/sync-controller.ts))
— star topology, roles never migrate. Followers join Trystero `passive`, so
they dial only the screen and never each other. The pure offset/target/drift
math is isolated and unit-tested in [sync-math.ts](src/sync/sync-math.ts).

**Three audio engines**, chosen per source and per platform
([audio-sync-controller.ts](src/media/audio-sync-controller.ts)). `engineFor()`
resolves: streaming source → stream engine (if `AudioDecoder` exists), else iOS
→ buffer, else element. The element path is also the universal fallback.

| Engine    | Where it runs                            | How it corrects                                                                                            | Cost / constraints                                                          |
| --------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `element` | Android/desktop, short content           | `<audio>` via Web Audio; ±70 ms deadband, rate 0.97–1.03 (pitch preserved), hard seek > 0.6 s              | Cheapest; also the fallback if another engine fails                         |
| `buffer`  | iOS (any length, pre-Safari 26)          | Whole file decoded to an `AudioBuffer`, played on the AudioContext clock; source-node swap to reposition   | ~21–23 MB PCM per minute of audio                                           |
| `stream`  | Long content where `AudioDecoder` exists | 60 s window range-fetched + WebCodecs-decoded, sliding in 45 s steps (15 s overlap, prefetched 30 s early) | Flat memory in track length; needs AAC-LC, faststart MP4, HTTP Range + CORS |

> `AudioDecoder` is **not** "iOS 16.4+". Safari 16.4 shipped WebCodecs' _video_
> interfaces only; audio arrived in **Safari 26.0**. On most iPhones in use the
> buffer engine is the only engine there is, whatever the length.

**Automatic output-latency compensation** — what you _hear_ trails the audio
clock by the device's output latency (~100–300 ms on iOS, more over Bluetooth).
It is measured live from `AudioContext.getOutputTimestamp()`, smoothed, and the
audio is steered _ahead_ by that amount. This is what makes BYOD headphones work
without a calibration step.

**Playback survives screen lock** ([streaming-buffer-engine.ts](src/media/streaming-buffer-engine.ts))
— on `visibilitychange` the engine pre-schedules a chain of buffer sources
directly on the audio thread (~180 s runway, topped up from each `onended`), so
audio free-runs without a timer. It runs at the _measured_ screen:device clock
ratio rather than a blind 1.0. On wake the chain keeps playing until a synced
source can take over at a de-clicked instant.

**The page stays alive on Android** — the output stage is permanently split into
a direct leg (`ctx.destination`) and a sink leg (`MediaStreamAudioDestinationNode`
→ `<audio>`, registered as the MediaSession). The sink leg is _never_ silent: it
idles at `KEEPALIVE_GAIN` (0.005, ~46 dB down) because Chrome won't freeze a page
that is playing audio, and a frozen page takes the WebRTC connection with it.
Backgrounding cross-fades between legs over 6 ms rather than re-wiring nodes.

**Auto-reconnect** ([transport-watchdog.ts](src/core/transport-watchdog.ts),
policy in [reconnect-policy.ts](src/core/reconnect-policy.ts)) — if beats have
been absent > 6 s the follower rejoins the room without touching the audio
engine, so the free-run chain keeps sounding across it. While hidden, a rejoin is
gated on the `/api/ping` reachability probe. Signalling also reconnects
underneath Trystero and re-announces ([worker-strategy.ts](src/transport/worker-strategy.ts)).

**Zero-touch screens** — a display can be told what to be entirely by the link it
is switched on with (`/?video=soh&autostart=1`), so an installed screen needs
nobody standing at it. With no `?video=`, it comes back on whatever it last led
with. See [Paths & URL parameters](#paths--url-parameters).

**Live captions, off the same clock** ([transcript.ts](src/core/transcript.ts))
— a follower can show the words as they are spoken, opt-in per device from the
listener's footer. Nothing extra goes on the wire: the corrector already puts
this device's audio on the screen's timeline to within a few milliseconds, so
the local playhead is itself the cue. A word-timed transcript is cut into short
lines, and the line on screen lights up word by word. One row per speaker: a
voice coming in over another takes the row below rather than its place, both
marked with the subtitle dash. Offered only for media that has one
([src/content/transcripts/](src/content/transcripts/)); see
[Content & adding your own](#content--adding-your-own).

**PWA / offline** — the app shell and the `test` clip are precached, so they work
fully offline after one load. Long-form content is **not** offline: its audio is
range-fetched throughout playback.

**Headless core** — `src/core` composes the whole session with no React and no
JSX; `src/ui` is one host on top of it. See [Reusing the core](#reusing-the-core).

## Paths & URL parameters

The whole URL is read once per page load, and frozen, in
[launch-intent.ts](src/ui/launch-intent.ts) — deliberately not a router. The two
halves answer different questions, which is the only reason a launch link is
readable at a glance: **the path picks the page, the query configures it.**

| Path            | Page                                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `/`             | The app — screen or listener, decided by how the device arrived                                                           |
| `/dev/rings`    | **Dev page:** gallery of every follower ring state ([DemoStatusGallery.tsx](src/ui/demo/DemoStatusGallery.tsx))           |
| `/dev/screens`  | **Dev page:** gallery of every screen state ([DemoScreenGallery.tsx](src/ui/demo/DemoScreenGallery.tsx))                  |
| `/dev/captions` | **Dev page:** captions played under the video itself ([DemoTranscriptGallery.tsx](src/ui/demo/DemoTranscriptGallery.tsx)) |

The paths are matched as a suffix in [launch-path.ts](src/ui/launch-path.ts), so
the app can be served under a base path and still hand out a join link to
itself rather than to the page the QR was drawn on — which the screen gallery,
rendering the real `DemoScreenView`, otherwise would. Nothing navigates between
these pages: a reload is the only way between them, because the session builds
its `<video>` element before the first render and can never rebuild it. Serving
them needs no config — the Worker (`not_found_handling`), the service worker's
`NavigationRoute`, and Vite's dev server and `preview` all fall back to
`index.html` already.

Everything in the query string configures the page the path chose. Flags follow
the `?debug=` reading: present and not `0`/`false` means on.

| Parameter        | Effect                                                                         |
| ---------------- | ------------------------------------------------------------------------------ |
| `?debug=1`       | Raise the debug overlay over the normal views                                  |
| `?video=<id>`    | Lead with that video (`test`, `agent327`, `soh`, `sync45`) and drop the picker |
| `?autostart=1`   | Screen starts itself, no tap (works because the leader's `<video>` is muted)   |
| `?room=<code>`   | Join as a listener — what the screen's QR carries                              |
| `?runway=<sec>`  | Background free-run runway (default 180)                                       |
| `?sinklat=<sec>` | Assumed added latency of the sink leg (default 0.15)                           |
| `?kagain=<0–1>`  | Keep-alive tap gain (default 0.005; `0` disables it)                           |

**Precedence**, decided once in `roomToJoin`: an explicit `?room=` wins even when
blank (a listener's audio is not something a URL can unlock), then `?autostart=`
beats the room this device happens to remember — a device set up to come up
unattended was set up to be the screen.

```
/?video=soh&autostart=1     a wall display, set up once
/?video=soh                 the same, one tap to start
/?debug=1&video=soh         the same video, with the instruments over it
/dev/captions?video=soh     a dev page, configured the same way
```

## Debugging & diagnostics

There is **one set of views** (`src/ui/demo/`). `?debug=1` does not swap them for
a second set — it hangs [DebugOverlay](src/ui/debug/DebugOverlay.tsx) over the top
of whatever is showing, as a fixed panel in the top-left that collapses to a chip
(which is how it starts on a phone). Three things it can't do from out there are
settled where the launch intent is already read: native `<video>` controls on the
screen, the picker staying put when the link named a video, and the `&debug=1`
the QR carries. Nothing in `src/core` knows the overlay exists.

**Sync-state rows** — `phase`, `role`, `room`, `peers`, `signalling`, `media`,
`clock offset`, `rtt`, `drift`, `mode`, `playbackRate`, `engine`, `audio out`,
`latency comp`, `local / target`, plus a live **drift meter** (held back until the
screen is actually being heard from — a drift of 0 reads the same whether it is
right or absent). The **join url** row is the QR's link in text, for a display no
camera is pointed at. **Keep screen awake** is a switch here and nowhere else.

**Connection log** ([DiagnosticsPanel.tsx](src/ui/debug/DiagnosticsPanel.tsx)) —
the instrument the connection-stability work was done with. A summary line
(freezes · peer leaves · rejoins · longest timer stall), one-tap **Copy log**, and
the buffer is mirrored to `sessionStorage` so a log survives the browser
discarding the tab. Events are tagged `audio`, `beat`, `ice`, `net`, `page`,
`peer`, `timer` or `transport`.

Lines worth recognising:

| Line                                      | Means                                                                                                                                    |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `turn preflight OK — relay via …`         | Credentials minted and a relay candidate allocated, checked before anyone joins ([turn-preflight.ts](src/diagnostics/turn-preflight.ts)) |
| `ab12cd path relay→relay over tls (wifi)` | The selected candidate pair. Transport comes from `relayProtocol`, not `protocol`                                                        |
| `… — NOT RELAYED`                         | ICE pinning has been defeated; the session is no longer testing the service                                                              |
| `probe OK (142ms) — network usable`       | The `/api/ping` probe that gates hidden rejoins ([reachability.ts](src/diagnostics/reachability.ts))                                     |
| `relays (rejoin): none connected`         | Signalling socket health — separates a dead relay from an empty room ([relay-sockets.ts](src/diagnostics/relay-sockets.ts))              |
| `signalling relay dropped — reconnecting` | Relay socket died; recovery logs `N topics restored` with the announce replayed                                                          |
| `FROZEN by the browser` / `gap 41.2s`     | Chrome froze the page, or the 1 Hz liveness timer stalled — Android power-save killing it                                                |

**Deployed sessions:** Worker Logs are on in `wrangler.toml`, so stream them while
testing from a phone:

```bash
yarn wrangler tail
```

## Verification

**Automated** — `yarn sim` runs two suites: the sync math (offset/RTT, target
extrapolation incl. loop wrap, signed seam drift, correction-rate clamping) and
session policy (rejoin backoff, staleness, room codes, join-link round-trip,
keep-awake state machine, diagnostics summary). `yarn build` type-checks app,
Worker and sims as one gate.

The streaming engine's own machinery — window bookkeeping, chain scheduling,
clock-ratio regression — and the follower's correction state machine have **no
automated coverage**. They are device-verified only.

### Regression checklist

Everything that made this app hard is device behaviour, so run this after any
change to the session, the transport or the audio path. **Capture a baseline
sleep log first**, so step 3 has something to compare against.

1. **iOS, join:** tap the ring → audible within a few seconds; rows show
   `engine: buffer` or `stream` and `audio out: web-audio`. Flick the ringer
   switch off — still audible.
2. **iOS, lock:** lock mid-session → audio continues; unlock → no audible jump.
3. **Android, sleep:** 10 minutes screen-off, then copy the connection log.
   Compare freezes / peer leaves / rejoins / longest stall against the baseline.
4. **Rejoin:** reload a follower → comes back on the Ready ring for its room, one
   tap rejoins. Scan the QR from a second device → joins that room.
5. **Two clients, 5 min foreground:** `mode: locked`, single-digit-ms drift,
   `rate ≈ 1`, still tracking across a loop wrap; listener count is right.
6. **Leave:** stop from both roles → listener lands on its Ready ring, screen on
   Start. Reload after a deliberate leave: the room is **not** offered again.
7. **Offline:** `yarn build && yarn preview`, load once, go offline, reload — app
   and `test` clip play from cache.

## Content & adding your own

The leader picks the video; the choice rides every beat as `mediaId` so followers
load the matching audio. Four options ship ([src/content/index.ts](src/content/index.ts)):

| id         | Video (screen)                         | Audio (followers)               | Delivery                                 |
| ---------- | -------------------------------------- | ------------------------------- | ---------------------------------------- |
| `test`     | synthetic clip, flash+click cues (20s) | `soundtrack.m4a`                | committed, **precached** (fully offline) |
| `agent327` | `agent-327.mp4` (~38 MB, 3m52s)        | `agent-327.m4a` (~3.6 MB)       | remote, `streaming: true`                |
| `soh`      | `soh.mp4` (~127 MB)                    | `soh.m4a` (~14 MB)              | remote, `streaming: true`                |
| `sync45`   | `sync-test-45mins.mp4` (~860 MB)       | `sync-test-45mins.m4a` (~43 MB) | remote, `streaming: true`                |

**Followers only ever download the audio** — ~14 MB against the screen's 127 MB
for `soh`. With `streaming: true` a follower doesn't even fetch the whole
soundtrack: it pulls ~60 s of compressed audio at a time, roughly 1.3× the audio
bitrate sustained (~20 KB/s at ~128 kbps), for as long as it is listening.

A `videoUrl`/`soundtrackUrl` can be a bundled import (precached), a
`public/media/` path (runtime-cached), or an absolute URL on static hosting.
Absolute URLs used by a `streaming` entry **must** serve `Accept-Ranges: bytes`
and permissive CORS, and the MP4's `moov` must be in the first 24 MB.

To add your own, produce a browser-friendly **H.264 + AAC-LC** MP4 and its
extracted audio, then add an entry to `VIDEOS`:

```bash
# audio the followers play — stream-copy the AAC so the timeline is identical
ffmpeg -i source.mov -vn -c:a copy -movflags +faststart mine.m4a

# video the screen plays — transcode if the source is HEVC (Chrome can't decode
# it) or AV1 (Safari needs M3/A17-class hardware)
ffmpeg -i source.mov -c:v libx264 -preset veryfast -crf 26 -pix_fmt yuv420p \
  -c:a copy -movflags +faststart mine.mp4

# already H.264/AAC? remux instead
ffmpeg -i source.mp4 -c copy -movflags +faststart mine.mp4
```

Keep the audio a stream-copy of the video's own track — that is what makes the
two timelines bit-identical, with no encoder-delay offset to compensate for.

### Captions for a video

Drop the transcription pipeline's JSON into
[src/content/transcripts/](src/content/transcripts/) and name it in that
folder's `SOURCES` map under the same id the beat carries — two lines, no other
change. `soh.json` is the shape it expects: utterances of `{ text, start, end }`
words, in ms on the media's own timeline, each tagged with the `speaker` the
pipeline diarised it to. The **word's** label is the one that counts — a
pipeline groups words into an utterance by turn but diarises them one at a
time, so an utterance labelled `A` routinely holds the `B` who cut in, and a
line breaks wherever that changes. A word with no label of its own falls back
to the utterance's, and a file with no labels at all simply never stacks a
second row. Extra fields (confidences, the top-level `text`) are carried along
and ignored, so the file goes in unedited.

Each file is a dynamic `import()`, so it lands in its own chunk, is fetched only
when a listener switches captions on, and never loads on the screen at all. A
video with no entry simply gets no toggle. Judge the line lengths, the reading
pace and whether the words land on the right shot on `/dev/captions`, which
plays the video itself with the captions under it and takes its clock from it —
rather than by sitting through a session. It reads `?video=` like the screen
does (`/dev/captions?video=soh`), defaulting to the first video that has words,
and its **Two speakers** button jumps to the first hand-over close enough to
stack two rows.

```ts
// src/content/transcripts/index.ts
const SOURCES = {
  soh: () => import('./soh.json'),
  agent327: () => import('./agent-327.json'), // ← the whole change
}
```

## Deploy

One Worker serves the built SPA, `/api/ice` and the `/signal` WebSocket, so
everything is same-origin in production and there is no CORS surface. `yarn
deploy` runs `yarn build` first, and the `SignalRelay` Durable Object migration
in `wrangler.toml` applies on the first deploy.

**Authenticating.** `wrangler login` works but grants a broad OAuth scope set.
Prefer a scoped API token from the dashboard's **"Edit Cloudflare Workers"**
template:

```bash
export CLOUDFLARE_API_TOKEN=...   # add CLOUDFLARE_ACCOUNT_ID if it sees several
yarn deploy
```

The token belongs to you, not the repo. Keep it out of `.env` (Vite reads that)
and out of `.dev.vars` (that populates the _Worker's_ runtime env, so a
account-level token there is handed to Worker code rather than to the CLI). For
repeat deploys, the macOS Keychain or `--env-file ~/.cloudflare.env` both work.

**First deploy, in order.** The `workers.dev` subdomain isn't knowable until the
Worker exists, so locking it down takes two passes:

1. `yarn deploy` — creates the Worker and prints its URL. The app loads, but
   `/api/ice` returns 500 and diagnostics report `turn preflight FAILED`.
   Expected.
2. `yarn wrangler secret put TURN_KEY_ID`, then `TURN_KEY_API_TOKEN`. These apply
   immediately — no redeploy. Reload; the panel should report
   `turn preflight OK — relay via …`.
3. Set `ALLOWED_ORIGINS` in `wrangler.toml` to that URL, then `yarn deploy` again.

`ALLOWED_ORIGINS` deters casual cross-site use; it is **not** authentication,
since `Origin` is trivially forged outside a browser. Anyone who finds an open
`/api/ice` can mint credentials that relay traffic billed to the account, so put
a Cloudflare rate-limiting rule in front of it before this is public.

**Assets.** Workers cap a single asset at 25 MiB. `public/.assetsignore` excludes
`public/media/` (large local-only screen videos); deployed builds serve the real
content from remote hosting.

## Where things live

| Layer                   | What's in it                                                                                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/`             | The session: `createSyncSession()` composes transport, corrector, watchdog, wake lock and screen video into one snapshot store. No React. `core/index.ts` is the whole public surface. |
| `src/sync/sync-math.ts` | Pure, unit-tested offset/target/drift/rate math                                                                                                                                        |
| `src/transport/`        | Trystero rooms, beats, clock RPC, ICE config, Worker signalling strategy                                                                                                               |
| `src/media/`            | The follower's corrector and its three output engines                                                                                                                                  |
| `src/diagnostics/`      | The session log and the monitors that feed it                                                                                                                                          |
| `src/content/`          | _This app's_ media — the catalogue is handed to the core, never imported by it. `transcripts/` holds the word-timed files, lazily imported                                             |
| `src/ui/`, `src/hooks/` | The React host. `useSync()` subscribes to the snapshot; `ui/demo/` is the views, `ui/debug/` the overlay                                                                               |
| `shared/`               | Types and route literals compiled by both the app's and the Worker's tsconfig                                                                                                          |
| `worker/`               | Worker entry (`/api/ice`, `/api/ping`, SPA) and the `SignalRelay` Durable Object                                                                                                       |

### Reusing the core

```ts
import { createSyncSession, configureSession } from './core'

configureSession({ timing: { transportStaleMs: 8000 } }) // optional
const session = createSyncSession({ media: myCatalogue })

session.start()
session.subscribe(() => render(session.getState()))
await session.join('K7QF') // inside a user gesture
```

`createSyncSession` needs a `MediaCatalogue` and nothing else; browser defaults
cover the rest.

- The screen's video is a **port** — pass your own `ScreenVideoOutput` to play
  through something that isn't a DOM element. A React host configures the
  built-in one via `useSync({ screenVideo: { configure } })`, which hands over the
  `<video>` once, before any gesture. `loop`, `muted` and `playsInline` are
  load-bearing; everything else is the host's.
- `session.waveform` is a pull-based read of the samples actually leaving the
  device, for a host that wants to draw them. Deliberately _not_ part of the
  snapshot, so redrawing at display rate never re-renders anything. The listener's
  ring is built on it.
- Timings, room-code rules, storage keys and drift bands are `configureSession()`;
  the Trystero app id and Worker routes are `configureTransport()`. Both default
  to what this app uses, and nothing here calls either.

## Gotchas worth knowing up front

- **The Worker is not optional locally.** No Worker means no peer discovery and
  no TURN credentials, and joining fails outright — at discovery or at
  connection.
- **iOS silences bare `<audio>`** with the physical mute switch (playback still
  advances, so drift moves but you hear nothing). All follower audio therefore
  routes through Web Audio, resumed inside the join tap.
- **Screen-off kills the radio, not the page.** Android powers Wi-Fi down at
  screen-off: audio free-runs and the page stays alive, but the connection dies
  within ~10 s and only returns when the screen does. The **Keep screen awake**
  option is the only lever a web page has. Long-form content, which range-fetches
  a window every 45 s, goes silent in that state.
- **The keep-alive tap is load-bearing and undocumented.** Chrome not freezing an
  audio-playing page is a heuristic, not a spec. If it tightens, the symptom is a
  silent death minutes into a sleep.
- **Loop wrap on multi-window sources** briefly shows `syncing` while a fresh
  window fetches. Tracks that fit one window loop on the audio thread with no
  seam (measured 1–7 ms across a wrap).
- **Room codes are the only access control.** The 4-character code is also the
  room password.
- **Rate nudges aren't pitch-preserved on the buffer/stream engines** —
  `AudioBufferSourceNode.playbackRate` shifts pitch, hence the tight ±2 % clamp.

The reasoning behind each of these, and what is still unmeasured, is in
[FEASIBILITY.md](FEASIBILITY.md).
