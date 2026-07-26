# Architecture

Nook is a login-free, database-free coworking app. This document explains how
the whole thing fits together: the pieces, the session state machine, the
signaling protocol, and the data model.

## Design goals

1. **Free to run forever.** No always-on server, no video server, no database.
   Everything lives inside free tiers.
2. **Nothing stored.** All state is in memory and disappears when a room empties.
   No accounts, no persistence, no analytics.
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
> (`new_sqlite_classes` in `wrangler.toml`). Nook declares them that way but
> never touches SQL storage — all room state is plain in-memory JavaScript.

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

**Camera/mic rule:** media is enabled during greet and regroup, and disabled
during focus. Each client also has manual mic/camera toggles; the effective track
state is *(manual intent) AND (phase allows media)*, so focus always forces media
off regardless of the toggles.

**Greet heartbeat:** while a public room sits in greet waiting for people, the DO
re-arms a short alarm (`HEARTBEAT_MS = 12s`) purely to re-report itself to the
lobby so it stays fresh in the directory.

## The signaling protocol

The client opens one WebSocket to `/room/:id/ws?name=…&focus=…&regroup=…&public=…`.
The Worker routes it to the room's Durable Object, which relays JSON messages.
Video and audio never go over this socket — it carries only WebRTC signaling and
room state. The actual media flows peer-to-peer over WebRTC.

### Client → server

| `type` | Payload | Effect |
|:--|:--|:--|
| `signal` | `to`, `data` | Relay a WebRTC offer/answer/ICE candidate to one peer. |
| `goal` | `text` | Set your shared "what I'm working on" text. |
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
| `welcome` | `selfId`, `hostId`, `peers`, `phase`, `endsAt`, `serverNow`, `focusMin`, `regroupMin`, `ready`, `shared`, `order`, `goals` | Sent once on join: your id and the full room snapshot. |
| `peer-join` | `id`, `name` | Someone joined. |
| `peer-leave` | `id` | Someone left (kick, disconnect, or refresh). |
| `order` | `order` | The join-order list of ids (drives the greet turn frame). |
| `signal` | `from`, `data` | A relayed WebRTC signal from a peer. |
| `phase` | `phase`, `endsAt`, `serverNow` | The phase changed. |
| `ready-state` | `ready` | The set of ready ids changed. |
| `locked-state` | `locked` | The room was opened/closed to newcomers. |
| `shared-state` | `shared` | The set of ids who've shared their goal changed. |
| `goal` | `id`, `text` | A peer updated their goal. |
| `chat` | `id`, `name`, `text`, `t` | A chat message. |
| `host` | `id` | The host changed (e.g. the old host left). |

### WebSocket close codes

The client maps close codes to distinct states so failures aren't misreported:

| Code | Meaning | UI |
|:--|:--|:--|
| `4000` | Kicked by host | "You were removed from this room." |
| `4001` | Room is full | "That room is full. Four is the max." |
| `4002` | Locked by the host | "This room is locked." |
| `1006` | Abnormal close (server unreachable) | "Can't reach the server." |
| other | Normal close | "You left the room." |

> A full room is signaled by *accepting* the socket and closing it with `4001`,
> not by rejecting the HTTP upgrade — a rejected upgrade only surfaces to the
> browser as a generic `1006`, indistinguishable from the server being down.

## Video: the WebRTC mesh

With four people or fewer, Nook uses a full mesh: every participant holds a direct
`RTCPeerConnection` to every other participant. At most that's 3 connections per
person — cheap, and it needs no media server.

- The newcomer creates an offer to each existing peer; answers and ICE candidates
  are relayed through the room's WebSocket (`signal` messages).
- ICE uses Google's public STUN server (`stun:stun.l.google.com:19302`).
- **No TURN in v1.** Roughly 10–15% of users behind strict/symmetric NAT won't be
  able to establish a video connection. Everything non-video still works for them.
  See [DEPLOYMENT.md](DEPLOYMENT.md) for adding a TURN server.

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

Beyond the room directory, `LobbyDO` is also a **presence hub**. People on the
home screen who opt in ("I'm around to cowork") hold a WebSocket to
`/lobby/ws`, so they can see who else is around and ping each other to start a
session.

- **Opt-in and home-only.** The presence socket opens only when you toggle
  availability *and* have a name. Entering a room unmounts the home screen, which
  closes the socket and drops you from everyone's roster. So only opted-in,
  browsing people are ever listed or pingable — never anyone mid-session.
- **Ping into a room you open.** Pinging someone generates a room id, sends them
  an `invite`, and drops you into that (public) room. They get a toast with a
  Join button that takes them straight in.
- **Spam guard.** Repeat pings to the same person within `PING_COOLDOWN_MS` (4s)
  are dropped server-side.

### Presence protocol (`/lobby/ws`)

Client → lobby:

| `type` | Payload | Effect |
|:--|:--|:--|
| `hello` | `name` | Opt in and appear in the roster. |
| `rename` | `name` | Update your displayed name. |
| `ping` | `toId`, `roomId` | Invite one person to cowork in `roomId`. |

Lobby → client:

| `type` | Payload | Meaning |
|:--|:--|:--|
| `welcome` | `id` | Your presence id (so you can exclude yourself from the roster). |
| `roster` | `people: [{id, name}]` | The current set of opted-in people. Re-sent on every change. |
| `invite` | `fromId`, `fromName`, `roomId` | Someone pinged you to cowork. |

> **Scale ceiling:** a single global `LobbyDO` holds every presence socket. That's
> fine for dozens of concurrent people; scaling to thousands would need sharding
> the lobby. Noted, not built — Nook is a niche tool.

## Data model (all in memory)

Nothing here is persisted; it exists only while the room's DO is alive.

**Per room (`RoomDO`):**

| Field | Type | Notes |
|:--|:--|:--|
| `sessions` | `Map<id, {ws, name}>` | Live WebSocket connections. Insertion order = turn order. |
| `goals` | `Map<id, text>` | Each person's "what I'm working on". |
| `ready` | `Set<id>` | Who has marked ready. |
| `shared` | `Set<id>` | Who has confirmed sharing their goal (greet turn-taking). |
| `phase` | `'greet' \| 'focus' \| 'regroup'` | Current phase. |
| `endsAt` | `number \| null` | Timer end (epoch ms) for the current phase. |
| `hostId` | `id` | First to join; migrates if they leave. |
| `focusMin` / `regroupMin` | `number` | Session lengths, set by the creator. |
| `isPublic` | `boolean` | Whether it's listed in the directory. |
| `locked` | `boolean` | Host closed the room to newcomers (mid-session join off). |

**Per lobby (`LobbyDO`):** `rooms: Map<roomId, {count, phase, occupants, updated}>`.

**Client-only (never sent to the server):** your to-do list. Tasks are
`{id, text, done}` objects held in React state and are personal to you.

## Trade-offs and known limits

- **Refresh drops you.** A page refresh closes your WebSocket, so you leave the
  room and must rejoin. (An auto-rejoin via `sessionStorage` is a natural
  improvement.)
- **No TURN.** Strict-NAT users don't get video (see above).
- **Mesh caps at 4.** The four-person limit is what keeps video serverless; going
  higher would require an SFU and change the cost model entirely.
- **Ephemeral by design.** There is no history, no "my rooms", no reconnect
  window. Close the tab and it's gone. That's the point.
