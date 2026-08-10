# Cloudflare Realtime (SFU) migration — design

## Problem
Nook's audio/video is a **WebRTC mesh**: every participant connects directly to
every other. At 3–4 people each device uploads N−1 streams, which is fragile on
phones, weak uplinks, and strict NATs. Result: recurring "mic/cam not working"
and one-directional audio (issues #68, #72). Mesh is the wrong topology past ~2
people; the fix is an SFU.

## Decision (locked with the user)
- **Pure SFU always** via **Cloudflare Realtime**. The mesh is deleted entirely —
  one code path for all room sizes.
- Media flows through Cloudflare, encrypted in transit, **never recorded or
  stored**. The pitch changes from "peer-to-peer, no server sees it" to "media
  flows through Cloudflare encrypted, never recorded or stored."
- Reliability for strict NATs comes from **Cloudflare Realtime TURN** (free
  alongside the SFU). No mesh fallback.

## Why Cloudflare Realtime (not Jitsi)
- Same stack we already run on (Workers + Durable Objects); Cloudflare's own
  reference app **Orange Meets** is Worker + DO + SFU — our exact shape.
- Free at our scale: billed on egress at $0.05/GB with 1,000 GB/month free;
  ingress free; TURN free alongside the SFU. A max-4 coworking app realistically
  costs $0.
- Keeps Nook's UI, phases, and a privacy story we control. Jitsi's free public
  instance is not shippable (25 endpoints/month, forced branding); JaaS puts
  media on 8x8 and costs per-MAU; self-host needs an always-on VM.

## Prerequisite (manual, user)
Create a **Realtime app** in the Cloudflare dashboard → obtain **App ID** +
**App Token**. App Token is set as a Worker **secret** (`REALTIME_APP_TOKEN`),
App ID as a var (`REALTIME_APP_ID`). Nothing secret is committed.

## Architecture

One WebRTC PeerConnection per client, to the Cloudflare edge (anycast). Each
client **pushes** its local mic/cam tracks up and **pulls** each roommate's
tracks down. Mesh's O(n²) peer connections collapse to O(n) edge uplinks.

Cloudflare Realtime model: **App → Session → Tracks**. Our app is one Realtime
App. Each client gets one Session. Each published local track has a unique track
ID that the app layer (our DO) stores and distributes.

### Components

**1. Worker (`src/worker.js`) — signaling proxy.**
The App Token is a secret, so all Realtime HTTPS API calls go through the Worker.
New endpoints (thin proxies, add the `Authorization: Bearer <APP_TOKEN>` header,
pass JSON through):
- `POST /realtime/sessions/new` → create a Session, return its `sessionId`.
- `POST /realtime/sessions/:id/tracks/new` → push (local offer SDP) or pull
  (remote track refs); returns the answer SDP + track metadata.
- `PUT /realtime/sessions/:id/renegotiate` → apply an SDP answer after a pull
  changes the remote description.
These mirror the Cloudflare Realtime SFU API 1:1; the Worker adds auth and CORS
only, holds no state.

**2. RoomDO (`src/RoomDO.js`) — track-ID registry.**
Stops relaying peer SDP/ICE (the `signal` case goes away). New role: hold and
broadcast the **published-tracks roster**. New/changed message types over the
existing WebSocket:
- client → DO `publish { audio?: trackId, video?: trackId }` — my current
  published track IDs (video may be absent when camera is off).
- DO → clients `tracks { id, audio?, video? }` on any change, and the full
  roster in `welcome` (a `tracks` map alongside the existing `peers`).
- On `peer-leave`, drop that peer's tracks from the roster and tell everyone so
  they stop pulling.
Chat, goals, lists, camera-pref, ready/shared, phases, presence, reconnect
detection, session persistence — all **unchanged**.

**3. Client SFU layer (`web/src/sfu.js`, new) — pure-ish helpers.**
- `newSession(apiBase)` → POST via Worker, returns `{ sessionId }`.
- `pushTracks(apiBase, sessionId, pc, tracks)` → add transceivers, create offer,
  POST, apply answer; returns the assigned track IDs.
- `pullTracks(apiBase, sessionId, pc, remoteRefs)` → POST to subscribe, apply the
  returned offer, answer back via renegotiate; resolves the incoming
  MediaStreamTracks.
- Pure reconciliation helper `diffRoster(prev, next)` (→ toPull / toDrop) is
  fully unit-testable with no browser.

**4. `web/src/useRoom.js` — mesh → SFU rewrite.**
Remove: `pcs` Map, per-peer `makePc`, offer/answer glare handling, the
renegotiation watchdog (#68), ICE-restart-on-failed. Replace with:
- one `pc` (RTCPeerConnection to CF) created on join;
- on media on/off, push/replace the local track and send `publish` to the DO;
- subscribe to the DO roster; on change, `diffRoster` → pull new tracks, drop
  gone ones; render pulled tracks into `peers[id].stream` (same shape the UI
  already consumes, so `Room.jsx` barely changes).
Camera/mic intent (`camOn`/`micOn`, `ensureMedia`, `toggleCam`/`toggleMic`,
`releaseVideo`, phase-forces-off) is kept — it now retargets the single PC.

**5. Config (`web/src/config.js`, `wrangler.toml`).**
`REALTIME_APP_ID` var + `REALTIME_APP_TOKEN` secret on the Worker. Client learns
nothing secret; it only calls the Worker proxy.

**6. Copy (`README.md`, `web/src/HelpModal.jsx`).**
Privacy wording updated per the decision above.

## Data flow (join)
1. Client `getUserMedia` (only when the user turns mic/cam on — unchanged
   lazy-acquire).
2. Client → Worker `sessions/new` → `sessionId`.
3. Client pushes local track(s) → gets track IDs → sends `publish` to the DO.
4. DO broadcasts the roster. Each client `diffRoster` → pulls roommates' tracks
   from CF via the Worker → renders.
5. Mic/cam toggle: push/replace or stop the local track, update `publish`; peers
   see the roster change and pull/drop accordingly.

## Error handling
- **Local mic/cam** (permission denied, device busy): unchanged — existing
  `mediaError` UX. No SFU fixes these; only messaging helps (out of scope here).
- **CF unreachable / push fails**: new `status: 'media-offline'` with a retry;
  the WebSocket/room stays usable (chat still works) while media retries.
- **Reconnect**: on WS reconnect, recreate the Session and re-push tracks; the DO
  roster repopulates. Track inactivity GC on CF is 30s, which covers brief drops.

## Rollout safety (users are live)
- All work on branch `feat/sfu-migration`; **production stays on the mesh**.
- Verify on localhost (dev hits the real CF Realtime API with the app creds) and
  via `wrangler versions upload` (a preview version that does **not** take prod
  traffic).
- Deploy only after verification. Instant revert path: `wrangler rollback` to the
  last mesh version if anything regresses.

## Testing
- `web/src/sfu.test.mjs` — `diffRoster` (add/remove/replace, camera on↔off
  transitions) with plain node asserts (matches `media.test.mjs`/`theme.test.mjs`
  style).
- Existing `RoomDO.test.mjs` — extend for the new `publish`/roster messages;
  keep all current session/chat/reconnect assertions green.
- Playwright 3-client localhost run (like the dark-chat test) — confirm each
  client pulls the others' tracks and audio/video elements receive media.
- Manual preview verification (real devices/phones) before deploy.

## Files touched
- `src/worker.js` — Realtime proxy endpoints
- `src/RoomDO.js` — signal relay → track-ID roster
- `web/src/useRoom.js` — mesh client → SFU client (largest change)
- `web/src/sfu.js` (new) + `web/src/sfu.test.mjs` (new)
- `web/src/config.js`, `wrangler.toml` — app id / secret wiring
- `README.md`, `web/src/HelpModal.jsx` — privacy copy
- `web/src/Room.jsx` — minimal (stream shape preserved)

## Out of scope / follow-ups
- Clearer local mic/cam permission messaging (helps the residual non-network
  complaints) — separate quick pass.
- #71 dark-chat `color-mix` fallback, #70 multi-line/editable chat — separate.
- End-to-end encryption through the SFU (insertable streams) — not needed for
  coworking; note as a future option if the privacy bar rises.
