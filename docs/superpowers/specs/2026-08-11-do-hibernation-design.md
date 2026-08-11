# Durable Object WebSocket Hibernation — design

Date: 2026-08-11
Status: approved, pre-implementation

## Problem

On 2026-08-11 Nook went fully down: every `/room/:id/ws` upgrade and every
`/rooms` request returned HTTP 500. The Worker's own exception log (`wrangler
tail`) showed 19/19 identical exceptions:

```
Exceeded allowed duration in Durable Objects free tier.
```

The Workers Free plan includes **13,000 GB-s/day** of Durable Object compute
duration. A Durable Object with a **non-hibernating** open WebSocket is billed
for duration continuously the whole time the socket is connected (DO active
memory ≈ 0.128 GB, so 13,000 GB-s ≈ ~28 object-hours/day of active time). Nook
holds one WebSocket per room member for the entire ~50-minute session, and the
single `global` LobbyDO holds presence sockets open effectively all day, plus a
12s heartbeat wakes every occupied room. Real usage exhausts the daily budget,
after which every DO invocation throws and the whole app is dead — chat, media,
presence, timer alike, because they all ride the same DO WebSocket.

This started with the WebRTC-mesh → Cloudflare Realtime SFU migration
(2026-08-10): the SFU model holds one long-lived WebSocket for the whole
session, where the mesh era's connections were shorter-lived.

## Goal

Move both Durable Objects to the **WebSocket Hibernation API** so idle
rooms/lobby bill ~0 duration and Nook stays within the free tier. No behavior,
UI, or feature change. Preserve the hard "free forever" requirement — do not
move to Workers Paid.

Non-goals: any UI change, new features, a storage-backend migration (both DOs
are already `new_sqlite_classes`, so hibernation is available), the iPhone
WebKit publish fix (already shipped), the "temporarily down" client banner
(already shipped on `fix/outage-banner`).

## Why hibernation is the right fix

Cloudflare bills DO duration only while the object is *active*. With the
Hibernation API, an idle DO with open WebSockets is evicted from memory; the
sockets stay connected at the edge and an incoming message or alarm wakes the
object. Nook is almost entirely idle — people cowork silently; chat, timer
events, roster changes and presence are sparse bursts — so hibernation drops
duration by orders of magnitude. Even Workers Paid (400,000 GB-s/mo then
usage-based) would keep billing non-hibernating sockets and trend toward
overages as Nook grows, so hibernation is correct regardless of plan.

## Core architecture change: sockets are the source of truth

Today `RoomDO.sessions` and `LobbyDO.people` are in-memory `Map`s. Under
hibernation the DO is evicted between messages, so those maps vanish and are
rebuilt (empty) by the constructor when the next message wakes the object. The
fix is to stop keeping authoritative state in instance fields and instead
**derive it from the live sockets on each wake.**

### WebSocket lifecycle

- Accept with `this.ctx.acceptWebSocket(server)` (was `server.accept()`).
  `this.ctx` is the `state`/`DurableObjectState` already stored in the
  constructor.
- Replace `server.addEventListener('message'|'close'|'error', …)` with the
  runtime-invoked DO methods:
  - `webSocketMessage(ws, data)`
  - `webSocketClose(ws, code, reason, wasClean)`
  - `webSocketError(ws, err)`
- Per-connection identity/state lives in `ws.serializeAttachment(obj)` (survives
  hibernation; ~2 KB/socket cap — far more than we need). Read back with
  `ws.deserializeAttachment()`.
- Enumerate connections with `this.ctx.getWebSockets()`. There is no longer an
  `id -> ws` map; to address one member, scan the sockets for the matching
  attachment `id`.

### RoomDO per-socket attachment

```
{ id, name, rkey, joinedAt, ready, shared, goal, list, cam: { session, audio, video }, camPref }
```

Derived on demand from `getWebSockets()`:

- **roster / order** — sockets sorted by `joinedAt`, mapped to `id`.
- **count** — `getWebSockets().length`.
- **ready / shared** — ids whose attachment flag is set.
- **track roster** (for `welcome` and `tracks`) — each socket's `cam` entry.
- **host** — the oldest live socket by `joinedAt`. This makes the current
  "promote the next member when the host leaves" logic automatic: when the host
  disconnects, the new oldest socket is host. Broadcast a `host` message when
  the derived host changes across a close.
- **goals / camPrefs / lists maps** (for `welcome` payloads) — folded from
  attachments.

A message handler reads the sender socket's attachment, mutates the relevant
field, `serializeAttachment`s it back, then broadcasts derived state. Example
(`goal`): set `attachment.goal`, reserialize, `broadcast({type:'goal', id, text})`,
`syncLobby()`.

`send(id, obj)` / `broadcast(obj)` / `broadcastExcept(id, obj)` iterate
`getWebSockets()` instead of the old `sessions` map.

### LobbyDO per-socket attachment

```
{ name, did, pref, watching }
```

`people` map is removed; `onPresence` becomes `webSocketMessage`, deriving the
roster from `getWebSockets()` attachments. `rosterFor(viewerDid)` filters out
`watching` sockets and blocked dids exactly as today. `broadcastRoster()` sends
each socket its own filtered roster. `leave` logic moves into `webSocketClose`.

## State that has no socket

- **`recentLeavers`** (RoomDO, 60s reconnect detection): keep in-memory, accept
  rare loss if an eviction lands inside that 60s window. Worst case: a
  fast-returning tab is treated as a new join and loses its goal/camera-pref
  restore. The join chime was already removed (#32), so there is no audible
  cost. Not worth persisting.
- **`LobbyDO.rooms`** directory (in-memory, fed by RoomDO `/update` pushes):
  keep in-memory. After a lobby eviction it refills from the next room push (see
  heartbeat below). `blocks` is already persisted to storage and is unaffected.
- **`LobbyDO.lastPing`** debounce: in-memory, ephemeral, fine to lose.
- **Session state** (phase/endsAt/config/paused/remainingMs/abandonAt): already
  persisted to DO storage under `SESSION_KEY` and restored in the constructor —
  unchanged.

## Heartbeat / cost knob

The 12s heartbeat (`HEARTBEAT_MS`) exists only to keep rooms fresh in the lobby
directory; phase transitions already fire on an exact `endsAt` alarm. Frequent
wakes work against hibernation. Change:

- `HEARTBEAT_MS`: 12s → **60s**.
- `LobbyDO.STALE_MS`: 30s → **150s**.

Idle rooms then wake ~once a minute for a few milliseconds (negligible
duration) instead of billing continuously, the directory stays correct, and the
60s push doubles as the mechanism that refills the lobby's in-memory `rooms`
map after a lobby eviction. Phase-end alarms are unchanged.

Accepted tradeoff: a room that dies *uncleanly* (DO evicted without sending
`count:0`) can linger in the directory up to ~150s. Clicking such a room simply
resumes it from persisted session state, so it is a briefly-wrong occupant
count, not a broken link.

## Alarms

`alarm()` is unchanged in intent (heartbeat tick while occupied, phase
transitions, pause/wipe while empty) and already the only timer mechanism —
there is no server-side `setTimeout` anywhere (the mid-session check-in timer is
client-side, driven by `endsAt`). Alarms survive hibernation and wake the object
briefly, which is exactly the desired cheap behavior.

## Testing

Current tests call `onMessage(id, {data})` / `onPresence(id, ws, {data})`
directly with a caller-supplied id and fake ws. The hibernation shape moves
identity into the socket attachment, so tests change to:

- A `fakeWs()` helper: an object with `serializeAttachment(v)` /
  `deserializeAttachment()` backed by a field, a `send` spy capturing sent
  JSON, `close` spy, and `readyState`.
- A `connect(do, attachmentSeed)` helper that registers a fake ws (pushed onto a
  fake `getWebSockets()` backing array) and seeds its attachment, mirroring what
  `fetch()` does on a real upgrade.
- Drive `webSocketMessage(ws, JSON.stringify(msg))` and
  `webSocketClose(ws, …)`; assert on the `send` spies and derived state.
- Pure logic (`diffRoster`, `clampInt`, chat/list/campref validation,
  `rosterFor` filtering, block graph) is unchanged and stays directly tested.

Plain `node --test` + `assert`, no framework — consistent with the existing
`.test.mjs` files. Both `RoomDO.test.mjs` and `LobbyDO.test.mjs` are reworked to
the new harness; assertions about behavior (validation, roster filtering,
host promotion, reconnect detection, tracks roster) are preserved.

## Verification

1. `node --test src/*.test.mjs` green.
2. `cd web && npm run build` clean.
3. Local `wrangler dev`: two browser tabs join a room — presence, chat, timer,
   camera publish/pull all work; a tab refresh reconnects.
4. Deploy; confirm `/rooms` returns 200 and a real 2–3 person session runs.
5. Watch `wrangler tail` under load: no `Exceeded allowed duration` exceptions;
   confirm idle rooms are not continuously active.

## Risks & ceilings

- **State-derivation correctness** is the main risk: every place that read
  `this.sessions`/`this.people` must now read from `getWebSockets()` +
  attachments, and every mutation must `serializeAttachment` back or it is lost
  on the next eviction. This is the bulk of the review surface.
- **Attachment size**: RoomDO's `list` (shared to-do, up to 20 items × 200
  chars) is the largest field; well under the 2 KB attachment cap, but if the
  cap were ever hit the list would move to DO storage. `ponytail:` not needed
  now.
- Residual duration from 60s heartbeat wakes and message bursts is expected to
  be a small fraction of the free-tier budget for Nook's scale; if it ever
  isn't, the heartbeat can go event-driven (push-on-change only).
