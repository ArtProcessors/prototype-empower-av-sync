# Empower — A/V Sync (feasibility spike)

A **fixed screen plays a looping video** and acts as a permanent leader, continuously
broadcasting its playback clock over WebRTC so **joining phones keep their local audio
tightly locked to the video** ("shared screen + personal headphone audio"). The wire carries
only tiny sync beats — never audio/video. Short content is device-local (PWA-cached); long
content streams its audio from static hosting, window by window.

Sibling of `empower-peer-to-peer` (reuses its Trystero transport + PWA/offline patterns),
but with a purpose-built continuous sync engine instead of the gallery's event model.

**Stack:** Vite 7 · React 18 · TypeScript · `vite-plugin-pwa` (offline) · `trystero`
(serverless WebRTC) · `mp4box` + WebCodecs (windowed audio decode) · Yarn 4 · Node 24.13.0.

## Run

```bash
nvm use && corepack enable
yarn install
yarn dev          # → http://localhost:3100
```

| Command | What it does |
|---|---|
| `yarn dev` | Dev server on :3100 (no service worker) |
| `yarn build` | Type-check + production build (builds the SW) |
| `yarn preview` | Serve the prod build on :4273 (SW active — for offline testing) |
| `yarn sim` | Unit checks for the sync math (`test/sync-sim.ts`) |

## Try it

1. On the display device, open the app, **pick a video** from the dropdown, and tap
   **📺 Be the screen** (starts the looping video and shows a room code + QR).
2. On phones, scan the QR / enter the code and tap **🎧 Join** (the tap unlocks audio on iOS).
   Put on headphones — the phone's audio locks to the video, and a live **drift meter**
   shows how far off it is (ms).

The test clip has a **per-second flash + click** and a sweeping bar, so drift is instantly
visible and audible: the click in your headphones should land on the flash on screen.

The debug panel's `engine` row shows which output path is live (`element`, `buffer`, `stream`,
or `syncing` while a long soundtrack's first window loads).

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

Pure, tested logic is in `src/sync/sync-math.ts`; transport in
`src/transport/sync-controller.ts`; the follower audio corrector + engine selection in
`src/media/audio-sync-controller.ts`, with the two AudioContext engines in
`src/media/buffer-audio-engine.ts` and `src/media/streaming-buffer-engine.ts`.

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
  with flashes; drift stays small on WiFi and cellular (enable TURN via `VITE_TURN_*` if a
  direct connection can't form).
- **Sleep/lock (manual, iterative):** lock the phone mid-session — audio keeps playing, and on
  wake the follower re-establishes its connection and hands back to a synced source. Verified
  by device testing rather than measurement; see FEASIBILITY.md for what's still open.

## Videos & adding your own

The leader picks the video from a dropdown; the choice is broadcast in each beat (`mediaId`)
so followers load the matching audio. Three options ship (`src/content/index.ts`):

| id | Video (screen) | Audio (followers) | Delivery |
|---|---|---|---|
| `test` | synthetic clip, flash+click cues (20s) | `soundtrack.m4a` | committed, **precached** (fully offline) |
| `soh` | `soh.mp4` (~127 MB H.264) | `soh.m4a` (~14 MB) | remote (`content.dev.pladia.live`), **`streaming: true`** |
| `sync45` | `sync-test-45mins.mp4` (~860 MB) | `sync-test-45mins.m4a` (~43 MB) | remote, **`streaming: true`** |

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
  hidden. On `visibilitychange` the follower therefore:
  1. routes output through a `MediaStreamAudioDestinationNode` played by an `<audio>` element
     registered as the **MediaSession** (iOS keeps that element, and the graph feeding it,
     alive; Android/desktop only switch to this sink while backgrounded, and skip content
     forward by the sink's added buffering so the audio doesn't fall behind the screen), and
  2. pre-schedules a **chain of buffer sources directly on the audio thread** (~180 s runway,
     topped up from each source's `onended`), so playback free-runs without needing a timer.
  The chain runs at the **measured screen:device clock ratio** — a least-squares fit of target
  seconds against context seconds, clamped to ±0.5 % — rather than a blind 1.0, so a locked
  phone drifts far less than the crystals' ppm difference would imply. On wake the chain is
  deliberately left playing (WebRTC takes seconds to return) until a live target arrives, at
  which point a properly synced source starts and the chain is cut at the same de-clicked
  instant. Tuning knobs for on-device work: `?runway=<sec>` (background runway) and
  `?sinklat=<sec>` (the sink's assumed added latency, default 0.15).
- **Reconnect after sleep:** Android tears the peer connection down during sleep and it does
  not reliably come back. A watchdog in `useSync.ts` rejoins the room if beats have been absent
  > 6 s (10 s cooldown), without touching the audio engine — no gesture needed, and the
  free-run chain keeps sounding across the reconnect. If the tab is discarded outright, the
  room code is kept in `sessionStorage` and the landing page offers a one-tap **Rejoin**
  (re-unlocking audio needs a real gesture, so that part can't be automatic).
- **Automatic output-latency compensation (BYOD — no manual calibration):** what you *hear*
  trails the element/context clock by the device's output latency (~100–300 ms on iOS;
  Bluetooth adds even more). We measure it at runtime from
  `AudioContext.getOutputTimestamp()` (`currentTime − contextTime` = the true
  scheduling→output delay, and it reflects the real output path *including Bluetooth*),
  smoothed, with `outputLatency` as a fallback and a conservative default only if both read 0.
  Audio is steered ahead by that amount so the *audible* audio lands on the video. The debug
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
- Fixed leader (no migration); star topology (no gossip relay). Swap the Trystero strategy
  with `VITE_TRYSTERO_STRATEGY`; STUN is on, TURN is a `VITE_TURN_*` seam.
- Same-network tests show ~0 ms clock offset; across real devices the offset estimate
  (NTP-class clocks + RTT compensation) is what keeps drift small — the instrument to watch
  is the follower's drift meter.
- Add or swap videos via the dropdown + `VIDEOS` in `src/content/index.ts` — see
  "Videos & adding your own" above.
- The large real assets live on remote static hosting (local copies in git-ignored
  `public/media/` for regeneration). The committed `test` clip is what stays
  offline-guaranteed.
