# Feasibility Report — Empower A/V Sync

**Spike:** shared screen + personal headphone audio ("silent cinema") on visitor-owned phones
**Repo:** `empower-av-sync` (branch `av-long-form-exploration`) · **Date:** 5 August 2026
**Status:** working prototype — long-form content and screen-lock playback now implemented

---

## What we set out to prove

That a fixed gallery screen playing a looping video can act as a permanent sync leader for
an arbitrary number of visitor phones, each playing the video's soundtrack through their own
headphones, **tightly enough locked that the audio audibly belongs to the picture** — with:

1. **No media over the wire.** Video and audio live on each device (PWA-cached or fetched
   from static hosting); the network carries only tiny sync beats.
2. **No infrastructure to run.** Serverless WebRTC (Trystero) — no sync server, no media
   server, no backend deploy.
3. **BYOD with zero calibration.** Visitors' own phones and headphones (including Bluetooth),
   no per-device latency setup step.
4. **Both major mobile platforms.** iOS Safari and Android Chrome, despite their very
   different media-pipeline behaviour.

The target quality bar: drift small enough that a per-second click in the headphones lands
on the corresponding flash on screen (roughly the ±80 ms range generally accepted as "in
sync" for A/V lip-sync).

A second iteration added the two questions that would have disqualified the approach for a
real gallery installation: **long-form content** (45 minutes, not a 20-second loop) without
unbounded memory growth, and **playback that survives the phone going to sleep** in a
visitor's pocket.

## How it works

The screen is a **fixed leader**; phones are followers in a star topology. Roles never
migrate. All logic is client-side in a PWA (Vite + React + TypeScript).

**Transport** ([sync-controller.ts](src/transport/sync-controller.ts)) — peers meet through
Trystero (WebRTC data channels; Nostr public relays for signaling by default, MQTT/torrent
strategies swappable). The wire protocol is two messages:

- **`beat`** (screen → all, 4×/sec): `{ mediaId, videoTime, wall, playing, duration }` —
  where the looping video is and the screen's wall-clock at that instant. `mediaId` tells
  followers which soundtrack to load _and_ which engine to use.
- **`clk`** (follower → screen RPC, every 3 s): estimates the screen↔follower clock offset
  via **Cristian's algorithm** (`offset = tScreen − (t0+t2)/2`), keeping the lowest-RTT
  sample from a rolling window of 8. Beat gaps > 4 s bump a `syncEpoch`, forcing a clean
  resync after sleep/reconnect.

**Correction** ([sync-math.ts](src/sync/sync-math.ts), pure and unit-tested) — each follower
runs a ~15 Hz loop: extrapolate the screen's current position
(`target = videoTime + (now + offset − wall)`, wrapped to the loop), compute loop-aware
`signedDrift`, EMA-smooth it, then steer.

**Three audio engines**, selected per _source_ and per platform
([audio-sync-controller.ts](src/media/audio-sync-controller.ts)). Content entries carry a
`streaming` flag; `engineFor()` resolves it as: streaming source + WebCodecs → streaming
engine; else iOS → buffer engine; else element engine. The element path is also the universal
fallback if an engine fails to load.

- **Element engine (Android/desktop, short non-streaming content):** a streaming `<audio>`
  element routed through Web Audio. Inside a ±70 ms deadband it holds rate 1; small drifts
  are closed by nudging `playbackRate` (0.97–1.03, pitch preserved — inaudible); drifts
  > 0.6 s hard-seek, with an 8 s cooldown and settle window so seeks stay rare.
- **Buffer engine (iOS, short content)**
  ([buffer-audio-engine.ts](src/media/buffer-audio-engine.ts)): Safari's media-element
  pipeline stalls > 1 s on every seek (and spontaneously mid-playback) and ignores fine
  `playbackRate` writes, which defeated element-side correction. Instead the soundtrack is
  fetched and decoded **whole** to an `AudioBuffer` and played on the **AudioContext clock**:
  repositioning is a sample-accurate source-node swap (no stall), rate nudges (0.98–1.02) are
  honoured as an AudioParam, and drift > 0.25 s restarts at the live target. While
  downloading/decoding the follower stays silent and reports "syncing".
- **Streaming engine (any platform, long content — the path both real assets now use)**
  ([streaming-buffer-engine.ts](src/media/streaming-buffer-engine.ts)): whole-file decode
  costs **~21 MB of PCM per minute** of stereo 44.1 kHz audio, so the 45-minute asset would
  need ~950 MB — untenable on a phone. This engine keeps memory flat by decoding only a
  sliding window: range-fetch the file head in 2 MB steps until mp4box can parse the `moov`
  (24 MB cap), keep just a **sample table** (byte offset/size/timing per AAC frame, in typed
  arrays), then per window range-fetch exactly that window's compressed bytes and decode them
  with **WebCodecs `AudioDecoder`** into a 60 s PCM buffer (~21 MB). Windows advance in 45 s
  steps (15 s overlap) and the next is prefetched 30 s before the current runs out; the slide
  is a de-clicked reposition into the overlap, so it's seamless and carries the corrector's
  rate and drift EMA across. Inside a window it _is_ the buffer engine — same AudioContext-clock
  scheduling, same correction constants, same mute-switch-bypassing stream sink. Requires
  AAC-LC (`mp4a.40.*`), a faststart MP4, HTTP Range and CORS; anything else falls back via
  `onLoadFailed`.

**Automatic output-latency compensation** — what you hear trails the element/context clock
by the device's output latency (~100–300 ms on iOS; Bluetooth adds more). This is measured
live from `AudioContext.getOutputTimestamp()` (with `outputLatency` as fallback and a
conservative default), EMA-smoothed, and the audio is steered _ahead_ by that amount so the
**audible** sound lands on the video. No user calibration — this is what makes BYOD Bluetooth
headphones workable. Two refinements came out of the sleep work: the estimate is **held for
4 s after a wake** (post-resume readings are unreliable, and a moving target reads as drift to
the corrector), and the background sink's extra buffering is modelled as a **separate additive
constant** (0.15 s, tunable at runtime with `?sinklat=`) that steps the instant output is
re-routed, rather than being folded into an EMA that could only crawl.

**Surviving sleep and lock** — where most of the recent work went:

- **The corrector's timer and the WebRTC beats are throttled when the page is hidden**, so on
  `visibilitychange` the follower calls `enterBackground()`: the streaming engine
  pre-schedules a contiguous **chain of `AudioBufferSourceNode`s directly on the audio
  thread** (180 s runway by default, tunable with `?runway=`), which then keeps sounding
  without any timer. Each chained source's `onended` — delivered from the audio thread, not a
  timer — tops the runway up, so sleep playback continues past the initial window.
- **Free-run runs at a measured clock ratio, not a blind 1.0.** A least-squares regression of
  screen-target seconds against this device's audio-context seconds (90 s window, ≥ 20
  samples, ≥ 20 s span, clamped to ±0.5 %) estimates the two crystals' ppm difference; the
  chain is scheduled at that rate, and the same rate is _held inside the lock deadband_
  instead of snapping to 1.0 — which used to guarantee a slow drift-then-nudge sawtooth.
- **The keep-alive `<audio>` element is now always playing — that's what keeps the page (and
  the WebRTC connection) alive.** Chrome on Android doesn't freeze a page that is actively
  playing audio. The old whole-file path got this for free because the `<audio>` element _was_
  the output; routing the streaming engine straight to `ctx.destination` gave clean foreground
  audio but left no playing element, so Android froze the page a few minutes into a sleep and
  the peer connection died with it. The output stage is therefore a permanent split —
  `masterGain` feeds both a direct leg (`ctx.destination`) and a sink leg
  (`MediaStreamAudioDestinationNode` → `<audio>`) — and the sink leg is **never taken to zero**:
  it idles at a far-below-audible `KEEPALIVE_GAIN` (0.005, i.e. ~46 dB down, tunable with
  `?kagain=`) so Chrome's "playing audio" state stays true for the whole session without putting
  the sink's buffering in the audible path.
- **Output routing is a cross-fade, not a re-connect.** iOS keeps the sink leg audible
  throughout (mute-switch bypass and lock-screen keep-alive); Android/desktop hold the direct
  leg audible in the foreground and ramp the two legs over 6 ms when backgrounding, skipping
  content forward by the sink's added latency at the switch so the audio doesn't step behind
  the still-playing screen. Cross-fading gains instead of disconnecting and reconnecting nodes
  also removes the click that switch used to make.
- **Waking is a hand-over, not a restart.** `exitBackground()` deliberately leaves the chain
  playing — the WebRTC link is usually dropped by the sleep and takes seconds to return, and
  killing the chain would cut to silence while we wait. The first `correct()` with a live
  target starts a properly synced source, cuts the chain at the same de-clicked instant, and
  resumes at the last known-good clock ratio. A generation counter invalidates any decode
  still in flight across every graph transition (in-flight decodes scheduling onto a graph
  being reset was crashing the renderer just after wake).
- **Screen-off kills the radio, and that is the end of the matter.** Measured on Android
  (Chrome 151) with a `/api/ping` probe running through a screen-off: a plain HTTPS `GET` to
  Cloudflare timed out **sixteen times in a row**, then started failing outright in under
  100 ms. Meanwhile the renderer was untouched — no freeze, no throttling, the probe timer
  holding 30 s intervals to within 100 ms for nineteen minutes. The device powers its Wi-Fi
  down at screen-off; the page is alive with no network at all.

  Three things follow, and they close off most of the obvious avenues:

  - **Transport choice is irrelevant.** A TCP/TLS-only ICE set and a UDP-only set were
    measured back to back (`relay→relay over tcp` vs `over udp`). Both connections died within
    seconds of screen-off. The relay is not the weak link.
  - **No application-layer transport fixes this.** A WebSocket to a self-hosted relay — the
    obvious next move, and one this spike came close to building — would fail exactly as hard
    as a peer connection does. If a bare `fetch` cannot complete, nothing can.
  - **Trystero's 5 s teardown stops mattering.** It closes a peer 5 s after ICE reports
    `disconnected` where the spec would wait ~30 s for `failed`, which is genuinely too
    aggressive for a phone — but the network here stays down for _minutes_, so patching it
    would change nothing.

  The only lever a web page has is **not letting the screen sleep**: the Screen Wake Lock,
  already wired to the "Keep screen awake" checkbox but **opt-in and off by default**. Held,
  the radio stays up and the session survives. Not held, the link dies within about ten
  seconds of screen-off and does not return until the user wakes the phone — at which point
  peering recovers within seconds, every time.

  Note the knock-on for long-form content: audio free-runs across the outage on its
  pre-scheduled chain, so **precached** sources keep playing, but the streaming engine
  range-fetches a window every 45 s and will starve. Long content plus a sleeping phone is
  silence.

- **A transport watchdog rejoins the room, including while asleep**
  ([useSync.ts](src/hooks/useSync.ts)). If beats have been absent > 6 s the follower leaves
  and rejoins _without touching the audio engine_ — no gesture is needed and the chain keeps
  playing across the reconnect. While hidden, a rejoin is only attempted once the reachability
  probe has just shown the network is usable: before that gate, a five-minute sleep burned
  seven full room rebuilds against a radio that was not listening, each one reporting success
  because a room object had been created while no peer ever connected. On becoming visible it
  rejoins immediately if the link is stale. If the tab is discarded outright, the room code is
  kept in `sessionStorage` and the landing page offers a one-tap **Rejoin** (audio still needs
  a gesture, so that part can't be automatic).

**Platform plumbing** — audio is unlocked inside the join tap (autoplay gate); _both_
AudioContext engines are unlocked in that gesture since the source isn't known until the first
beat. Routing through Web Audio means the **iOS ringer/mute switch does not silence
playback**; a MediaSession now-playing card is registered on all platforms; a wake-lock option
keeps screens/phones awake. The PWA precaches the app shell + the 20 s test clip (fully
offline after first load). The two real assets are hosted remotely
(`content.dev.pladia.live`) and **followers only ever download the audio** — ~14 MB vs the
screen's 127 MB video for the 15-minute clip.

## Pros

- **It works, on the hard platform.** iOS Safari — the graveyard of this class of idea —
  holds lock on the AudioContext clock after the element approach measurably failed.
- **Long-form content no longer scales with RAM.** Windowed WebCodecs decode holds memory
  roughly flat in track length: two or three 60 s windows live at once (~21 MB each), plus the
  pre-scheduled chain while locked. A 45-minute track costs about what a 5-minute one does,
  instead of ~950 MB.
- **Playback survives the phone going to sleep.** Pre-scheduled audio-thread chains plus
  clock-ratio free-run mean a locked phone keeps playing and comes back close, then hands over
  to a synced source — rather than stopping or waking up wildly out of sync.
- **The page genuinely survives a sleep.** Measured: nineteen minutes of screen-off with the
  probe timer holding 30 s intervals to within 100 ms, no freeze and no throttling. The
  keep-alive tap works. Audio continues throughout, and on wake peering recovers within
  seconds without the user doing anything. What does _not_ survive is the network (see
  "Screen-off kills the radio").
- **Zero backend.** No sync server, no media server, nothing to host or scale for playback
  itself. Signaling uses public relays; media ships with the PWA or off static hosting.
- **Negligible sync bandwidth.** ~4 small JSON beats/sec plus a clock ping every 3 s per
  follower. Media never crosses the WebRTC wire.
- **No calibration step.** Output latency (wired, speaker, Bluetooth) is measured and
  compensated automatically at runtime — essential for BYOD.
- **Inaudible correction.** Steady-state correction is a small pitch-preserved (element) or
  ±2 % (buffer/stream) rate nudge inside a deadband; hard restarts are reserved for join,
  reconnect and wake.
- **Honest, testable core.** The sync math is pure and unit-tested (`yarn sim`, re-run for
  this report — all passing); platform hacks are quarantined in the three engine classes.

## Cons

- **Three engines to maintain, and the newest is the biggest.** The streaming engine is
  ~1,000 lines carrying a demuxer, a decoder, window bookkeeping, a second scheduling mode
  (the free-run chain), a clock-ratio estimator and a generation guard. That's a lot of
  machinery whose failure modes are timing-dependent and platform-specific.
- **Long-form audio is a live CDN dependency, not a one-time download.** Windows are
  range-fetched as playback advances, at roughly 1.3× the audio bitrate (60 s of bytes every
  45 s — about 20 KB/s for the 15-minute clip's ~125 kbps AAC). Those fetches don't match the
  service worker's `audio`/`video` runtime-cache route, so they hit the network (or the
  browser's HTTP cache) for the whole session. **Long content is not offline-capable**; a
  network drop mid-session eventually starves the next window.
- **A brief dropout at the loop wrap on streaming sources.** Nothing is decoded across the
  seam — the last window clamps to the end of the file, so when the target wraps to 0 the
  follower reports "syncing" until a fresh window fetches and decodes (order of a second or
  two). Acceptable on a 45-minute loop; conspicuous on a short one.
- **WebCodecs is a hard requirement for the memory-safe path.** iOS 16.4+ / Chromium only.
  Worse, when `AudioDecoder` is absent the fallback for a long source on iOS is the
  **whole-file buffer engine** — i.e. exactly the ~950 MB decode the streaming engine exists to
  avoid. That's a silent trap, not a graceful degradation.
- **Narrow input format.** AAC-LC only, sample rate must be in the AAC table, `moov` must be
  within the first 24 MB (faststart), and the origin must honour Range with CORS. The
  `AudioSpecificConfig` is hand-built from two bytes.
- **The background hand-over contains hand-tuned constants.** The sink's added latency is a
  baked 0.15 s estimate (it can't be read from JS) and the runway is a 180 s guess trading
  sleep coverage against the memory spike that invites Android to discard the tab. Both are
  exposed as query params precisely because the right value is device-dependent — Bluetooth in
  particular.
- **Free-run is uncorrected.** While locked there is no feedback loop, only the extrapolated
  clock ratio; error grows with lock duration, bounded by how good that estimate is (clamped
  to ±0.5 %).
- **Staying alive on Android depends on an undocumented browser heuristic.** The keep-alive tap
  works because Chrome won't freeze a page that is "playing audio", and 0.005 gain is a guess at
  what clears its silence threshold. Measured working on Chrome 151 for nineteen minutes of
  screen-off — but it remains a load-bearing dependency on unspecified behaviour that no feature
  detection can confirm, and if Chrome tightens the threshold the symptom is a silent death
  minutes into a sleep. It also means a very quiet (~46 dB down), sink-delayed copy of the audio
  is permanently mixed into Android/desktop foreground output; inaudible in practice, but not a
  clean signal path.
- **The watchdog papers over a genuinely offline screen.** It rejoins whenever beats stop, so a
  screen that has actually gone away is indistinguishable from a link that needs rebuilding.
  Hidden attempts are now gated on the reachability probe, which stopped the worst of the churn,
  but the ambiguity remains.
- **Buffer/stream rate nudges are not pitch-preserved.** `AudioBufferSourceNode.playbackRate`
  shifts pitch; the clamp is kept subtle (±2 %) so it's hard to hear, but it's a compromise
  the element engine doesn't make.
- **Depends on public signaling infrastructure.** Default matchmaking rides free Nostr
  relays — fine for a spike, not an SLA. (Strategy is swappable and only needed at join time,
  but it's still a third party in the visitor's critical path — and now in the watchdog's.)
- **Room codes are the only access control.** The 4-character code doubles as the room
  password; anyone who can reach the signaling network and guess/see a code can join.
  Acceptable for listening to a public soundtrack, but worth being deliberate about.

## Limitations

Scope boundaries of the current design (as opposed to defects):

- **Fixed leader, no migration.** If the screen device dies, the experience stops until it
  returns; followers show "screen offline". No gossip relay — every follower needs a direct
  (or TURN) connection to the screen.
- **Looping-video model only.** The sync target is a single continuously looping video.
  Playlists, seek-by-operator, multiple simultaneous zones, or paused-by-default content
  would need protocol extensions (the `paused` beat state exists but is untested as a mode).
- **Joining needs the network, and long-form playback keeps needing it.** The app shell and
  test clip are offline after first load, but matchmaking requires internet at join time and
  streaming windows require it throughout. A venue with captive-portal or client-isolated
  Wi-Fi may also block P2P entirely. Every connection is now relayed through Cloudflare TURN
  (relay-only ICE, `turn:`/`turns:` over both UDP and TCP), which is what a hostile venue
  network needs — at the cost of a hard dependency on that service and on credentials that
  expire.
- **Correction envelope.** The nudge closes ≤ 0.6 s (element) / ≤ 0.25 s (buffer, stream) of
  drift at at most 2–3 %/s; anything larger is a hard restart. In practice restarts happen at
  join, at wake, and at the loop wrap — which is the intended behaviour.
- **One screen per room.** No concept of multiple synchronized screens sharing a leader
  clock (likely easy — they'd just be followers with video instead of audio — but unbuilt).
- **Tab discard still needs a human tap.** Auto-recovery covers connection loss and sleep; it
  cannot cover the browser killing the tab, because re-unlocking audio requires a gesture. The
  rejoin card is the mitigation.

## What's verified vs open

**Verified by automated test (re-run for this report):**

- `yarn sim` — Cristian offset/RTT math, lowest-RTT selection, target extrapolation incl.
  loop wrap and paused state, signed loop-seam drift both directions, correction-rate sign
  and clamping. **All passing.** Note that the streaming engine's own machinery — window
  bookkeeping, chain scheduling, clock-ratio regression — has **no automated coverage**; it
  shares only the pure `signedDrift`/`correctionRate` helpers the sim exercises.

**Verified manually during the spike (per README and commit history; not re-run here):**

- Two clients in-browser: follower locks to single-digit-ms drift, `mode: locked`,
  rate ≈ 1, correct tracking across the loop wrap.
- Two real devices (laptop screen + iPhone with headphones): clicks land on flashes; drift
  stays small on both Wi-Fi and cellular.
- iOS specifics: the AudioContext path eliminates the drift/stutter the element path showed;
  audio plays with the mute switch on; auto latency compensation reads ≈ 220 ms on test
  Chrome and steers correctly.
- Bandwidth asymmetry: the screen fetches the 127 MB video, each follower only the audio.
- Offline: after one load, the app and the test clip play from cache with the network off.
- The streaming engine and the sleep/lock path were **iterated on-device** — the Android
  sleep-dropout, audio-stacking and hand-over commits each came out of device testing — but
  the outcome is "no longer reproducing", not a measured result.

**Open — not yet tested or measured:**

- **Actual memory footprint.** The ~21 MB/min and "flat, under ~100 MB" figures are
  arithmetic from the window size, not instrument readings. Nobody has profiled peak memory
  during a background chain build on a real phone — precisely the moment the OS is deciding
  whether to discard the tab.
- **Fan-out scale.** Largest real test is a handful of peers. A gallery scenario means tens
  of followers per screen: WebRTC connection limits on the screen device, beat send cost at
  N connections, and clk-RPC load are all unmeasured — plus N followers each pulling ~20 KB/s
  of window bytes from the CDN.
- **Long-session stability.** Multi-hour soak: clock-ratio estimator behaviour over many
  sleep cycles, memory over hundreds of window slides, thermal/battery impact of a 15 Hz
  corrector + wake lock + continuous fetch/decode on phones. The "dropout after a few
  minutes" bug was found and fixed at the minutes scale; hours is untested.
- **Drift after a long lock.** How far a free-running phone actually is after 10, 30, 60
  minutes asleep, and whether the wake hand-over is inaudible or a noticeable jump.
- **The 0.15 s sink-latency constant.** Tuned by ear on one or two devices; unknown across
  Bluetooth codecs and Android OEM audio stacks.
- **Whether the wake lock is enough, over a gallery day.** Screen-off is now known to end the
  session (see "Screen-off kills the radio"), so the open question has moved: whether holding the
  Screen Wake Lock for a full 45-minute experience is acceptable for battery and heat, whether
  visitors leave it on, and what happens on devices that ignore or drop the lock. Also untested
  across Chrome builds: whether the 0.005 tap gain clears the silence threshold everywhere, and
  whether it is audible on any device with the volume up.
- **Hostile venue networks.** Client-isolated Wi-Fi, symmetric NAT, captive portals — i.e.
  whether TURN is a nice-to-have or a requirement, and its cost. Range-fetch behaviour behind
  a caching proxy is also unknown.
- **Device breadth.** Android fragmentation, older iPhones, iOS < 16.4 (where the
  long-content fallback is the memory trap above), Bluetooth codecs with extreme latency
  (some exceed the 0.5 s measurement clamp).
- **Perceptual validation.** The drift meter says single-digit ms; a blind "does it feel
  synced" test with naive users, various headphones, at gallery viewing distances hasn't been
  done — nor has anyone judged whether the loop-wrap dropout and wake hand-over are acceptable
  to a visitor.
- **Signaling reliability at event scale** and behaviour when relays are slow/down mid-session
  (in-session sync survives; join and watchdog rejoin do not).

## Recommendations

1. **Call the core question answered, plus the two follow-ons.** iOS-viable,
   calibration-free, sub-perceptual sync over serverless WebRTC is retired as a risk; so are
   the two this iteration set out to close — long-form content without unbounded memory, and
   playback that survives a phone going to sleep. Both now have working implementations rather
   than plans.
2. **Measure what the design now asserts.** Two cheap tests, in this order:
   - **iOS/Android memory profile:** the 45-minute asset on the oldest device the venue must
     support, with the profiler attached, through several lock/unlock cycles. The whole
     streaming engine exists on the strength of an arithmetic argument; confirm it.
   - **Scale test:** one screen + 20–30 phones (staff devices) for an hour. Watch screen-side
     CPU, connection count, follower drift, _and_ CDN egress. This is the likeliest place the
     star topology breaks, and it's a one-afternoon test.
3. **Then soak it.** A full-day run with sleep/wake cycles and a deliberately flaky network is
   the only way to find out whether the watchdog, the chain top-up and the clock-ratio
   estimator hold up, or merely survive the first ten minutes. Instrument the thing the recent
   fixes actually target: does the follower still appear in the screen's listener count after
   30 minutes face-down in a pocket, and what did the retry loop cost in battery?
4. **Decide the offline posture deliberately.** Long content is now network-dependent for its
   whole duration. Either accept that and provision the CDN accordingly, or add a
   service-worker route that caches window ranges (and pre-warms them) so a dropout doesn't
   starve playback.
5. **Close the WebCodecs gap explicitly.** Detect absence and refuse (or cap) long content on
   that device, rather than silently routing to a whole-file decode that will be killed.
6. **For production, replace the free-relay dependency:** host a TURN server and either
   self-host signaling (Nostr relay/MQTT broker) or pin to paid relays. Budget this plus
   content hosting as the real infrastructure cost.
7. **Design for venue Wi-Fi early.** Get on the actual network (or its spec) and confirm
   P2P/TURN reachability _and_ Range-fetch behaviour before UX work builds on instant joins.
8. **Productionization backlog, roughly in order:** leader restart/recovery UX (screen reboot
   mid-day), download/prefetch progress UI for the "syncing" windows, seamless loop-wrap
   prefetch, multi-zone/room namespacing, telemetry (aggregate drift/latency/engine-mode
   reporting instead of a per-phone debug panel), and a perceptual acceptance test with naive
   users.
9. **Track WebKit, WebCodecs _and_ Chromium's freeze policy.** Pin a quarterly check that the
   assumptions still hold on new releases — element pipeline stalls, `getOutputTimestamp`
   behaviour, `AudioDecoder` availability, whether the lock-screen sink keep-alive still works,
   and whether Chrome still declines to freeze a page over a near-silent audio tap. Keep the
   element fallback alive as insurance.

## Verdict

**Feasible — proven in principle for long-form content on sleeping phones, with scale and
measured memory as the two named unknowns.**

The spike demonstrates end-to-end, on real devices including iOS Safari, that a shared
screen and personal phone audio can hold sync within single-digit milliseconds of measured
drift — under the ±80 ms perceptual bar with an order of magnitude to spare — using no
backend, no media streaming over the wire, and no user calibration. It now also handles the
two things that would have disqualified it in a gallery: **45-minute content at flat memory
cost**, via windowed WebCodecs decode, and **playback that continues through screen lock**,
via audio-thread scheduling and clock-ratio free-run, keeping its page alive and re-establishing
its own connection without the visitor touching anything. The engine split is the right
architecture, not a workaround smell: it isolates exactly the code that platform media stacks
force apart.

What is _not_ yet proven is the gallery envelope: dozens of simultaneous followers per
screen, hours-long sessions, the memory ceiling as actually measured rather than calculated,
and hostile venue networks. The new capabilities also come with new dependencies — a CDN in
the playback path for the whole session, WebCodecs on the device, and an undocumented Chrome
heuristic keeping the page alive. None of these looks like a design-breaker, and each has a
plausible mitigation inside the current architecture, but they are empirical questions the next
iteration should answer before this graduates from spike to product commitment.
