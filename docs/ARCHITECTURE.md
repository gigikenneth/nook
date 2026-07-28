# Architecture

Nook is a login-free, serverless coworking app — no accounts, no always-on box,
and no database to provision (the only stored state is a tiny per-room session
blob in Durable Object storage). This document explains how the whole thing fits
together: the pieces, the session state machine, the signaling protocol, and the
data model.

## Design goals

1. **Free to run forever.** No always-on server, no video server, no database.
   Everything lives inside free tiers.
2. **No personal data stored.** Names, to-do lists, chat, and video are ephemeral
   — never written to disk, never passed through a server (video is peer-to-peer).
   No accounts, no analytics. The one thing that *is* persisted is the room's
   **session state** (phase + countdown + lengths), kept in that room's Durable
   Object storage so a session survives reconnects and deploys and you can pick up
   exactly where you left off. See [Session persistence](#session-persistence).
3. **Small rooms.** Four people maximum, which keeps video peer-to-peer (a mesh)
   and avoids the need for a media server.

## The pieces

```
        Browser (React + Vite)                     Cloudflare
  ┌────────────────────────────┐        ┌──────────────────────────────┐
  │  Home  ─ live directory     │  HTTP  │  Worker (src/worker.js)       │
  │        ─ create / join      │ ─────► │   • serves the built app      │
  │                             │        │   • GET  /rooms   → LobbyDO   │
  │  Room  ─ video tiles (mesh) │  WS    │   • WS   /room/:id/ws → RoomDO│
  │        ─ timer / phases     │ ◄────► │                              │
  │        ─ tasks / chat       │        │  RoomDO   (one per room)      │
  │                             │        │  LobbyDO  (one, global)       │
  └──────────┬──────────────────┘        └──────────────────────────────┘
             │  WebRTC (peer-to-peer video/audio, via STUN)
             ▼
        Other browsers in the room
```

| Component | File | Responsibility |
|:--|:--|:--|
| **Worker** | `src/worker.js` | HTTP entrypoint. Serves the static app, exposes the room directory (`/rooms`), and upgrades the room WebSocket (`/room/:id/ws`). |
| **RoomDO** | `src/RoomDO.js` | One [Durable Object](https://developers.cloudflare.com/durable-objects/) per room. Holds live WebSocket sessions in memory, runs the phase timer via DO alarms, relays WebRTC signaling, and enforces the cap of 4. |
| **LobbyDO** | `src/LobbyDO.js` | A single global Durable Object. A live registry of open (public) rooms for the landing page, and the presence hub for the "who's around" list and cowork invites. |
| **Web app** | `web/` | React + Vite front end. `useRoom.js` owns the WebSocket and the WebRTC mesh. |

### Why Durable Objects

A room needs a single, consistent, in-memory place that every participant's
WebSocket connects to — but only for as long as the room is alive, with no
database. That is exactly what a Durable Object is: a single-threaded, stateful
object addressed by name (`idFromName(roomId)`), spun up on demand and torn down
when idle. One DO instance per room means all of a room's sockets land in the
same place and can be relayed to each other directly.

> **Free-plan note:** Durable Objects on the free plan must be SQLite-backed
> (`new_sqlite_classes` in `wrangler.toml`). `RoomDO` uses that storage for one
> small thing — the persisted session blob (see [Session persistence](#session-persistence)).
> All live per-person state (sockets, goals, ready/shared, camera prefs) stays in
> plain in-memory JavaScript; `LobbyDO` persists nothing.

## The session state machine

Every room is always in one of three phases. Transitions are driven by the host,
by everyone being ready, or by the DO alarm firing.

```
                 ┌──────────────────────────────────────────┐
                 ▼                                          │
  ┌────────┐  everyone ready / host "Start now"   ┌────────┐│ host "Run another"
  │ GREET  │ ───────────────────────────────────► │ FOCUS  ││ or regroup timer ends
  │ cams on│                                       │cams off││
  └────────┘                                       └───┬────┘│
       ▲                                                │    │
       │              focus timer ends (DO alarm)       │    │
       │                                                ▼    │
       │                                          ┌──────────┴─┐
       └──────────────────────────────────────── │  REGROUP   │
                  regroup timer ends              │  cams on   │
                                                  └────────────┘
```

- **Greet → Focus:** when every connected session has marked ready, or the host
  taps "Start now". `startFocus()` sets `endsAt = now + focusMin` and schedules a
  DO alarm.
- **Focus → Regroup:** the DO `alarm()` fires at `endsAt`. If `regroupMin > 0` it
  moves to regroup with a new alarm; otherwise it loops back to greet.
- **Regroup → Greet:** the regroup alarm fires (or the host restarts), calling
  `toGreet()`, which clears the ready and shared sets and broadcasts the reset.

### Session persistence

The phase and timer used to live only in memory, so a Durable Object eviction —
which happens on idle, under memory pressure, and on **every deploy** — reset an
in-progress session back to greet. Now the session is durable:

- **Persisted.** `RoomDO` writes a small blob to DO storage (key `sess`:
  `phase`, `endsAt`/`remainingMs`, `paused`, `abandonAt`, `focusMin`,
  `regroupMin`, `isPublic`, `locked`) on every change, and restores it in the
  constructor via `state.blockConcurrencyWhile` before any request or alarm runs.
- **Paused while empty.** When the last person leaves, `pauseSession()` freezes
  the remaining time (`remainingMs`) instead of resetting. When someone rejoins,
  `resumeSession()` re-anchors `endsAt = now + remainingMs`, so you continue from
  exactly where the session stopped — whether that's a refresh, both people
  returning much later, or the app redeploying mid-session.
- **Abandoned after 6h.** A paused room arms a far-future alarm (`ABANDON_MS =
  6h`); if it's still empty when that fires, `wipe()` clears the stored session so
  storage doesn't accumulate ghost rooms. (If the DO is evicted while occupied and
  the alarm fires before anyone reconnects, `alarm()` pauses rather than wipes.)

Per-person state (goals, ready/shared, camera prefs) is **not** persisted — it
belongs to a live socket and is rebuilt when people (re)join.

**Camera/mic rule:** camera and mic default **off**, and are acquired **lazily** —
there is no `getUserMedia` prompt on join. You appear as an avatar until you tap
"Camera on" / "Mic on", at which point the track is acquired, added to every peer
connection, and negotiated over. The effective track state is *(manual intent)
AND (phase allows media)*, and focus always forces media off. Because a track
toggled on mid-call wasn't in the original offer, adding it triggers a fresh
offer/answer; simultaneous toggles are resolved with the perfect-negotiation
pattern (the lower-id peer is impolite and ignores a colliding offer).

**Dead-track recovery.** A camera/mic track can end out from under you — the OS
or another app grabs the device, or a phone backgrounds the tab. `ensureMedia`
treats only a `readyState === 'live'` track as present (`liveTrackOf` in
`web/src/media.js`); a dead one is dropped and re-acquired, then swapped onto the
existing `RTCRtpSender` with `replaceTrack` so it reaches peers without piling up
dead senders. `track.onended` flips the tile back to "off" so the next toggle
re-acquires cleanly, and a failed `getUserMedia` (permission denied, no device,
device in use) shows an actionable message (`mediaErrorMessage`) over your tile
instead of failing silently.

**Camera preference (a social signal).** Separate from the actual camera, each
person can flag how they'd rather be seen — `on` ("up for camera"), `off`
("camera-shy"), or unset. It's purely a hint shown on tiles, directory rows, and
the "around now" list (`campref` message; carried in `welcome`, `syncLobby`
occupants, and the lobby roster). It never touches the real track.

**Greet heartbeat:** while a public room sits in greet waiting for people, the DO
re-arms a short alarm (`HEARTBEAT_MS = 12s`) purely to re-report itself to the
lobby so it stays fresh in the directory.

### Client-side session touches

Small ambient helpers that live entirely in the browser (no server involvement):

- **Chimes** (`web/src/sound.js`, Web Audio, no files): phase transitions, a
  light rise when someone new joins, and a soft two-note warning when focus has
  **5 minutes left**.
- **Mid-session check-in:** one optional, dismissible card at the focus midpoint
  with a rotating question; "Share" posts your answer to the room chat.
- **Screen Wake Lock** (`web/src/useWakeLock.js`): holds a screen lock while
  you're in a room (re-acquired on `visibilitychange`) so a phone left open
  doesn't sleep. No-op where the API is unsupported.
- **Tab-title countdown:** the live timer is mirrored into `document.title`
  (`⏳ MM:SS · Nook`) so a glance at the tab shows the time left.

## The signaling protocol

The client opens one WebSocket to `/room/:id/ws?name=…&focus=…&regroup=…&public=…&cid=…`
(`cid` is a stable per-tab id used to recognise a reconnecting connection).
The Worker routes it to the room's Durable Object, which relays JSON messages.
Video and audio never go over this socket — it carries only WebRTC signaling and
room state. The actual media flows peer-to-peer over WebRTC.

### Client → server

| `type` | Payload | Effect |
|:--|:--|:--|
| `signal` | `to`, `data` | Relay a WebRTC offer/answer/ICE candidate to one peer. |
| `goal` | `text` | Set your shared "what I'm working on" text. |
| `campref` | `pref` | Set your camera preference (`'on'` / `'off'`, anything else clears it). |
| `shared` | — | "I've shared my goal" — advances the greet turn frame. |
| `ready` / `unready` | — | Toggle your ready state. All ready → focus starts. |
| `chat` | `text` | Send a chat message (relayed, never stored). |
| `start` | — | Host only: skip the wait and start focus now. |
| `lock` | `locked` | Host only: open/close the room to newcomers. |
| `kick` | `id` | Host only: remove a participant. |
| `restart` | — | Host only: from regroup, run another session. |

### Server → client

| `type` | Payload | Meaning |
|:--|:--|:--|
| `welcome` | `selfId`, `hostId`, `peers`, `phase`, `endsAt`, `serverNow`, `focusMin`, `regroupMin`, `ready`, `shared`, `order`, `goals`, `camPrefs`, `locked` | Sent once on join: your id and the full room snapshot. On a resumed session `phase`/`endsAt` reflect where it left off. |
| `peer-join` | `id`, `name`, `reconnect` | Someone joined. `reconnect: true` means a returning tab (matched by `cid`) — the client skips the join chime and the server restores their goal/camera pref. |
| `peer-leave` | `id` | Someone left (kick, disconnect, or refresh). |
| `order` | `order` | The join-order list of ids (drives the greet turn frame). |
| `signal` | `from`, `data` | A relayed WebRTC signal from a peer. |
| `phase` | `phase`, `endsAt`, `serverNow` | The phase changed. |
| `ready-state` | `ready` | The set of ready ids changed. |
| `locked-state` | `locked` | The room was opened/closed to newcomers. |
| `shared-state` | `shared` | The set of ids who've shared their goal changed. |
| `goal` | `id`, `text` | A peer updated their goal. |
| `campref` | `id`, `pref` | A peer set/cleared their camera preference. |
| `chat` | `id`, `name`, `text`, `t` | A chat message. |
| `host` | `id` | The host changed (e.g. the old host left). |

### WebSocket close codes

The client maps close codes to distinct states so failures aren't misreported:

| Code | Meaning | UI |
|:--|:--|:--|
| `4000` | Kicked by host | "You were removed from this room." (terminal) |
| `4001` | Room is full | "That room is full. Four is the max." (terminal) |
| `4002` | Locked by the host | "This room is locked." (terminal) |
| `1000` / `1005` | Clean close (you left) | "You left the room." |
| other (e.g. `1006`) | Abnormal drop | **Reconnect** with backoff — a transient blip, not a dead end. |

> A full room is signaled by *accepting* the socket and closing it with `4001`,
> not by rejecting the HTTP upgrade — a rejected upgrade only surfaces to the
> browser as a generic `1006`, indistinguishable from the server being down.

**Reconnect (the mobile fix).** An abnormal close (`1006`) reconnects with
exponential backoff (capped at 8s) rather than dead-ending. Phones suspend the
tab on lock/app-switch, which drops the socket *and* freezes the backoff timer,
so the client also reconnects immediately on `visibilitychange` (tab
foregrounded) and the `online` event, with a fresh retry budget. Because the
session is persisted and paused server-side, a reconnect resumes the same
session — timer and phase intact — instead of restarting.

## Video: the WebRTC mesh

With four people or fewer, Nook uses a full mesh: every participant holds a direct
`RTCPeerConnection` to every other participant. At most that's 3 connections per
person — cheap, and it needs no media server.

- The newcomer creates an offer to each existing peer; answers and ICE candidates
  are relayed through the room's WebSocket (`signal` messages).
- ICE config comes from the Worker's `/ice` endpoint (fetched before connecting):
  always Google's public STUN (`stun:stun.l.google.com:19302`), plus a **TURN**
  relay when credentials are set — Metered or Cloudflare Realtime (see
  [DEPLOYMENT.md](DEPLOYMENT.md)). TURN relays media for peers behind
  strict/symmetric NAT who can't connect directly.
- **STUN-only fallback.** With no TURN configured, roughly 10–15% of users behind
  strict NAT won't get a video connection; everything non-video still works for
  them. Adding TURN closes that gap.

## The lobby / live directory

Public rooms report themselves to the single global `LobbyDO`:

- On any change, a room POSTs `/update` with `{ roomId, count, phase, endsAt,
  locked, occupants }`. A room reporting `count <= 0` is deleted from the registry.
- The home page GETs `/rooms`, which prunes entries older than `STALE_MS = 30s`
  (so a room that dies without cleanly reporting still ages out) and returns the
  list sorted so that **greeting rooms with a free seat float to the top** — the
  most joinable rooms first.
- Invite-only rooms never report, so they never appear.

**Joining ongoing sessions.** Because `endsAt` and `locked` are in the directory,
each row shows how long a live session has left (`~N min left`, refreshed each
poll) and whether it's locked. Joining works in **any** phase, not just greet: an
open room with a free seat can be joined mid-focus, and the newcomer lands in the
current phase to wrap up with the group. The **host** can flip a room's `locked`
state at any time; a locked room stays visible in the directory (with a lock
badge and a disabled Join) but rejects new sockets with close code `4002`.

## Presence and cowork invites

Beyond the room directory, `LobbyDO` is also a **presence hub**. Anyone on the
home screen with a name holds a WebSocket to `/lobby/ws`, so they can see who
else is around ("around now") and ping each other to start a session.

- **Automatic and home-only.** The presence socket opens as soon as you have a
  name (no separate opt-in toggle). Leaving the home screen for a room closes it
  and drops you from everyone's roster, so people mid-session aren't listed as
  available.
- **Watchers (the in-room overlay).** Tap **Home** during a session and you
  connect as a *watcher* (`watch` message): you receive the roster and can ping,
  but you're excluded from everyone else's visible roster — you're busy, not
  available. A watcher's ping invites the person into the room you're **already
  in** (not a new one). That in-room overlay is trimmed to just the two things
  that matter mid-session: "Who's coworking now" and "Around now".
- **Ping into a room you open.** From the home screen, pinging someone generates a
  room id, sends them an `invite`, and drops you into that (public) room. They get
  a toast with a Join button that takes them straight in.
- **Camera preference in the roster.** Your camera preference (above) rides along
  in `hello`/`pref` and shows next to your name in "Around now".
- **Spam guard.** Repeat pings to the same person within `PING_COOLDOWN_MS` (4s)
  are dropped server-side.

### Presence protocol (`/lobby/ws`)

Client → lobby:

| `type` | Payload | Effect |
|:--|:--|:--|
| `hello` | `name`, `pref` | Appear in the roster (home screen). |
| `watch` | `name` | Receive the roster + ping, but stay off it (in-room overlay). |
| `rename` | `name` | Update your displayed name. |
| `pref` | `pref` | Update your camera preference shown in the roster. |
| `ping` | `toId`, `roomId` | Invite one person to cowork in `roomId`. |

Lobby → client:

| `type` | Payload | Meaning |
|:--|:--|:--|
| `welcome` | `id` | Your presence id (so you can exclude yourself from the roster). |
| `roster` | `people: [{id, name, pref}]` | The current set of available people (watchers excluded). Re-sent on every change. |
| `invite` | `fromId`, `fromName`, `roomId` | Someone pinged you to cowork. |

> **Scale ceiling:** a single global `LobbyDO` holds every presence socket. That's
> fine for dozens of concurrent people; scaling to thousands would need sharding
> the lobby. Noted, not built — Nook is a niche tool.

## Data model

Most state is in memory and dies with the live socket; the room's **session**
(the fields marked *persisted* below) is written to DO storage and survives — see
[Session persistence](#session-persistence).

**Per room (`RoomDO`):**

| Field | Type | Notes |
|:--|:--|:--|
| `sessions` | `Map<id, {ws, name}>` | Live WebSocket connections. Insertion order = turn order. In-memory. |
| `goals` | `Map<id, text>` | Each person's "what I'm working on". In-memory. |
| `camPrefs` | `Map<id, 'on' \| 'off'>` | Each person's camera preference (signal only). In-memory. |
| `ready` | `Set<id>` | Who has marked ready. In-memory. |
| `shared` | `Set<id>` | Who has confirmed sharing their goal. In-memory. |
| `phase` | `'greet' \| 'focus' \| 'regroup'` | Current phase. **Persisted.** |
| `endsAt` | `number \| null` | Timer end (epoch ms); `null` while paused/greet. **Persisted.** |
| `paused` / `remainingMs` | `boolean` / `number \| null` | Frozen-timer state while the room is empty. **Persisted.** |
| `abandonAt` | `number \| null` | Wipe-after time for an empty room. **Persisted.** |
| `focusMin` / `regroupMin` | `number` | Session lengths, set by the creator. **Persisted.** |
| `isPublic` | `boolean` | Whether it's listed in the directory. **Persisted.** |
| `locked` | `boolean` | Host closed the room to newcomers. **Persisted.** |
| `hostId` | `id` | First to join; migrates if they leave. In-memory (cleared while empty). |

The persisted fields are stored together under the `sess` key.

**Per lobby (`LobbyDO`, all in memory):** `rooms: Map<roomId, {count, phase,
endsAt, locked, isPublic, occupants, updated}>` (occupants carry `{name, goal,
pref}`) and `people: Map<id, {ws, name, pref, watching}>`.

**Client-only (never sent to the server):** your to-do list. Tasks are
`{id, text, done}` objects held in React state and are personal to you.

## Trade-offs and known limits

- **Refresh keeps your seat.** A refresh (or a mobile lock/background) reconnects
  via `sessionStorage`, and the server-side session is paused and persisted, so
  you land back in the same phase with the timer intact.
- **TURN is optional.** With STUN only, strict-NAT users don't get video; add a
  TURN relay to close that gap (see above).
- **Mesh caps at 4.** The four-person limit is what keeps video serverless; going
  higher would require an SFU and change the cost model entirely.
- **Ephemeral *personal* data.** No accounts, no history of who was there, no chat
  archive — names, lists, chat, and video are never stored. Only the room's
  session state persists (so you can resume it), and it's wiped after 6h empty.
- **One global lobby.** Every presence socket lands on a single `LobbyDO`; fine
  for dozens of concurrent people, would need sharding for thousands.
