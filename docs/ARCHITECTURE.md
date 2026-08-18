# Architecture

Nook is a login-free, serverless coworking app — no accounts, no always-on box,
and no database to provision. The only server-side state is two small,
anonymous things in Durable Object storage: a per-room session blob, and the
ignore/block graph (pairs of opaque per-browser ids). This document explains how
the whole thing fits together: the pieces, the session state machine, the
signaling protocol, and the data model.

## Design goals

1. **Free to run forever.** No always-on server, no video server, no database.
   Everything lives inside free tiers.
2. **No personal data stored.** Names, to-do lists, chat, and video are ephemeral
   — never written to disk. Video/audio run through an embedded Jitsi call (JaaS),
   which Nook never records: recording and transcription are disabled in the token.
   No accounts, no analytics. Two things *are* persisted, and neither identifies a
   person: the room's **session state** (phase + countdown + lengths), kept in that
   room's Durable Object storage so a session survives reconnects and deploys; and
   the **block graph** for ignore (#28), kept in the singleton lobby's storage as
   pairs of anonymous per-browser `did`s — no names, no accounts. See
   [Session persistence](#session-persistence) and [On-device id + blocking](#on-device-id--blocking).
3. **Small rooms.** Four people maximum. This is a product choice — a nook is
   meant to feel like a small table, not a webinar — and it also keeps the call
   well inside JaaS's free tier.

## The pieces

```
        Browser (React + Vite)                     Cloudflare
  ┌────────────────────────────┐        ┌──────────────────────────────┐
  │  Home  ─ live directory     │  HTTP  │  Worker (src/worker.js)       │
  │        ─ create / join      │ ─────► │   • serves the built app      │
  │                             │        │   • GET  /rooms   → LobbyDO   │
  │  Room  ─ Jitsi call (JaaS)  │  WS    │   • WS   /room/:id/ws → RoomDO│
  │        ─ timer / phases     │ ◄────► │   • GET  /jitsi-token → JaaS  │
  │        ─ tasks / chat       │        │  RoomDO   (one per room)      │
  │                             │        │  LobbyDO  (one, global)       │
  └──────────┬──────────────────┘        └──────────────────────────────┘
             │  embedded call to 8x8.vc (JaaS SFU handles media + NAT)
             ▼
        8x8.vc (Jitsi as a Service)
```

| Component | File | Responsibility |
|:--|:--|:--|
| **Worker** | `src/worker.js` | HTTP entrypoint. Serves the static app, exposes the room directory (`/rooms`), signs Jitsi tokens (`/jitsi-token`), and upgrades the room WebSocket (`/room/:id/ws`). |
| **JaaS signer** | `src/jaas.js` | WebCrypto RS256 signer. Builds a short-lived JaaS JWT (`signJaasToken`) and derives a stable Jitsi room name from a Nook room id (`jitsiRoomName`). |
| **RoomDO** | `src/RoomDO.js` | One [Durable Object](https://developers.cloudflare.com/durable-objects/) per room. Holds live WebSocket sessions in memory, runs the phase timer via DO alarms, carries all coworking state, and enforces the cap of 4. Never touches media. |
| **LobbyDO** | `src/LobbyDO.js` | A single global Durable Object. A live registry of open (public) rooms for the landing page, and the presence hub for the "who's around" list and cowork invites. |
| **Web app** | `web/` | React + Vite front end. `useRoom.js` owns the WebSocket and coworking state (WS-only, no media); `JitsiStage.jsx` embeds the JaaS call. |

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
> plain in-memory JavaScript. `LobbyDO` persists one small thing too — the ignore
> **block graph** (see [On-device id + blocking](#on-device-id--blocking)); its
> room directory and presence roster stay in memory.

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

**Camera/mic rule:** the Jitsi call joins **muted** (`startWithAudioMuted` /
`startWithVideoMuted`), so camera and mic default **off** and there is no
`getUserMedia` prompt on join — you appear as an avatar until you toggle. Nook's
own "Camera on" / "Mic on" buttons drive Jitsi through
`executeCommand('toggleVideo' | 'toggleAudio')` rather than owning any tracks
themselves. Device errors (permission denied, no device, device in use) and
track loss (the OS or another app grabbing the camera, a phone backgrounding the
tab) are Jitsi's problem now — the old `ensureMedia` / dead-track recovery /
`mediaErrorMessage` logic is gone.

**Camera preference (a social signal).** Separate from the actual camera, each
person can flag how they'd rather be seen — `on` ("up for camera"), `off`
("camera-shy"), or unset. It's purely a hint carried over the WebSocket
(`campref` message; carried in `welcome`, `syncLobby` occupants, and the lobby
roster) and shown in directory rows and the "around now" list. It is **no longer
rendered on video tiles** — those are now Jitsi's own grid — and it never touches
the real track.

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

The client opens one WebSocket to `/room/:id/ws?name=…&focus=…&regroup=…&public=…&cid=…&did=…`
(`cid` is a stable per-tab id; `did` is a persistent per-browser id that survives
a full tab close. The room uses whichever is present to recognise a reconnecting
connection — see [On-device id + blocking](#on-device-id--blocking)).
The Worker routes it to the room's Durable Object, which relays JSON messages.
Video and audio never go over this socket — it carries only coworking state
(presence, phases, timer, chat, tasks, goals, camera preference). The actual
media runs in a separate embedded Jitsi call (see [Video](#video-embedded-jitsi-jaas)).

### Client → server

| `type` | Payload | Effect |
|:--|:--|:--|
| `goal` | `text` | Set your shared "what I'm working on" text. |
| `campref` | `pref` | Set your camera preference (`'on'` / `'off'`, anything else clears it). |
| `shared` | — | "I've shared my goal" — advances the greet turn frame. |
| `ready` / `unready` | — | Toggle your ready state. All ready → focus starts. |
| `chat` | `text` | Send a chat message (relayed, never stored). |
| `start` | — | Host only: skip the wait and start focus now. |
| `lock` | `locked` | Host only: open/close the room to newcomers. |
| `kick` | `id` | Host only: remove a participant. |
| `restart` | — | Host only: from regroup, run another session. |

> **Legacy, inert.** `RoomDO` still contains `publish` / `tracks` message
> handlers and a tracks roster from the SFU era. The client no longer publishes,
> so these are dead code — wired to nothing, left in place, not removed.

### Server → client

| `type` | Payload | Meaning |
|:--|:--|:--|
| `welcome` | `selfId`, `hostId`, `peers`, `phase`, `endsAt`, `serverNow`, `focusMin`, `regroupMin`, `ready`, `shared`, `order`, `goals`, `camPrefs`, `locked` | Sent once on join: your id and the full room snapshot. On a resumed session `phase`/`endsAt` reflect where it left off. |
| `peer-join` | `id`, `name`, `reconnect` | Someone joined. `reconnect: true` means a returning browser (matched by `did`, or `cid` for a same-tab refresh) — the client skips the join chime and the server restores their goal/camera pref. |
| `peer-leave` | `id` | Someone left (kick, disconnect, or refresh). |
| `order` | `order` | The join-order list of ids (drives the greet turn frame). |
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

## Video: embedded Jitsi (JaaS)

Media is handled entirely by an embedded [Jitsi](https://jitsi.org/) call, hosted
on [JaaS](https://jaas.8x8.vc/) (Jitsi as a Service, 8x8.vc). Nook owns no tracks,
no peer connections, and no ICE — 8x8's SFU carries all media and does its own NAT
traversal. Nook migrated to this from an earlier Cloudflare Realtime SFU (and,
before that, a WebRTC mesh); both are gone from the code.

- **`web/src/JitsiStage.jsx`** loads `https://8x8.vc/<appId>/external_api.js` and
  embeds the call with `JitsiMeetExternalAPI`. It fetches a token from the Worker
  and joins room `<appId>/<roomName>`. Nook hides Jitsi's own chrome —
  `toolbarButtons: []`, prejoin skipped (`prejoinConfig.enabled: false` +
  legacy `prejoinPageEnabled: false`) — and joins muted, so the only visible
  controls are Nook's own Camera/Mic buttons, which drive Jitsi via
  `executeCommand('toggleVideo' | 'toggleAudio')`. The stage is mounted **only
  during greet and regroup**; in focus it unmounts entirely (cameras are off then).
- **`src/jaas.js`** is a WebCrypto RS256 signer. `signJaasToken(env, {room, name})`
  builds a JaaS JWT — header `kid: <appId>/<keyId>`; payload `aud: 'jitsi'`,
  `iss: 'chat'`, `sub: <appId>`, the room, `exp` two hours out,
  `context.user.{name, moderator: 'true'}`, and `context.features` with
  recording, transcription, livestreaming, and outbound-call all `'false'`.
  `jitsiRoomName(roomId)` returns `nook-<first 40 hex of SHA-256(roomId)>` — a
  stable, collision-free, valid Jitsi room name derived from any Nook room id.
- **Worker endpoint.** `GET /jitsi-token?room=<id>&name=<name>` returns
  `{ jwt, appId, roomName }` (400 if no room; 503 if the `JAAS_*` secrets are
  unset — see [DEPLOYMENT.md](DEPLOYMENT.md)).

**Security model.** The visitor never authenticates; the Worker's server-side
signature *is* the auth. Because the Jitsi room name is a hash of the Nook room
id, only someone already admitted to the (max-4, WebSocket-gated) Nook room can
obtain a valid token — Nook's WebSocket gate is the room's access control. And
because recording and transcription are disabled in the token, no participant can
record the call.

## The lobby / live directory

Public rooms report themselves to the single global `LobbyDO`:

- On any change, a room POSTs `/update` with `{ roomId, count, phase, endsAt,
  locked, focusMin, occupants }`. A room reporting `count <= 0` is deleted from
  the registry.
- The home page GETs `/rooms`, which prunes entries older than `STALE_MS = 30s`
  (so a room that dies without cleanly reporting still ages out) and returns the
  list sorted so that **greeting rooms with a free seat float to the top** — the
  most joinable rooms first. Each room's `focusMin` rides along and is shown as a
  badge on the directory card, so people see the session length before joining.
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
- **Ignore (#28).** Ignoring someone hides you both from each other's "around
  now" and blocks pings between you. Durable and mutual — see
  [On-device id + blocking](#on-device-id--blocking).

### Presence protocol (`/lobby/ws`)

Client → lobby:

| `type` | Payload | Effect |
|:--|:--|:--|
| `hello` | `name`, `pref`, `did` | Appear in the roster (home screen). `did` is client→server only, never re-broadcast. |
| `watch` | `name`, `did` | Receive the roster + ping, but stay off it (in-room overlay). |
| `rename` | `name` | Update your displayed name. |
| `pref` | `pref` | Update your camera preference shown in the roster. |
| `ping` | `toId`, `roomId` | Invite one person to cowork in `roomId` (dropped if you've blocked each other). |
| `block` | `toId` | Ignore that person: server resolves their `did` and records a mutual, durable block. |
| `unblock` | `did` | Un-ignore (by the `did` your client cached). |

Lobby → client:

| `type` | Payload | Meaning |
|:--|:--|:--|
| `welcome` | `id` | Your presence id (so you can exclude yourself from the roster). |
| `roster` | `people: [{id, name, pref}]` | Available people, **filtered for you** (watchers and anyone you've blocked excluded). Re-sent on every change. `did`s are never included. |
| `invite` | `fromId`, `fromName`, `roomId` | Someone pinged you to cowork. |
| `blocked` | `did`, `name` | Ack of a `block` — your client caches `{did, name}` for the un-ignore list. |
| `blocked-list` | `dids` | On connect, the authoritative list of `did`s you've blocked, so un-ignore survives a cleared localStorage. |
| `unblocked` | `did` | Ack of an `unblock`. |

> **Scale ceiling:** a single global `LobbyDO` holds every presence socket. That's
> fine for dozens of concurrent people; scaling to thousands would need sharding
> the lobby. Noted, not built — Nook is a niche tool.

## On-device id + blocking

Nook has no accounts, so to let someone **ignore** a person durably (issue #28)
it needs a stable way to recognise a returning browser. That's the `did`.

- **`did` — an anonymous per-browser id.** A `crypto.randomUUID()` created once
  and kept in `localStorage` (`nook.did`). It's the persistent sibling of the
  per-tab `cid`. Sent to the server on the room join query and the lobby `hello`,
  **client→server only** — it never appears in a roster or any peer-facing
  message, so blocking never makes an id visible to other people.
- **Smoother return.** Because `did` outlives a full tab close (where `cid`, in
  `sessionStorage`, does not), the room's reconnect logic keys on `did || cid`,
  so "pick up where you left off" survives a close, not just a refresh.
- **Block graph.** Blocking is **mutual** and **durable** (Level 3). The lobby
  stores a symmetric graph keyed by `did` (`block:<did>` → set of `did`s) in DO
  storage under the `blocks` key. When A ignores B, the client sends B's
  ephemeral presence id; the server resolves it to B's `did` and records the pair
  both ways. Enforcement: the roster is built **per viewer** (`rosterFor(did)`
  drops anyone in the viewer's block set), and pings across a blocked pair are
  dropped. All filtering happens server-side on the *other* person's `did`.
- **Scope.** Blocking governs lobby discovery only — "around now" visibility and
  pings. It is not offered inside a room and never ejects a live session.
- **Honest ceiling.** A `did` is per-browser. Incognito, cleared storage, another
  browser, or another device yields a fresh `did`, so a determined person
  reappears. It stops casual and repeat encounters; it is not a hard wall — the
  limit every account-free system hits.

See `docs/superpowers/specs/2026-08-02-on-device-id-design.md` for the full
decision record.

## Data model

Most state is in memory and dies with the live socket; the room's **session**
(the fields marked *persisted* below) is written to DO storage and survives — see
[Session persistence](#session-persistence).

**Per room (`RoomDO`):**

| Field | Type | Notes |
|:--|:--|:--|
| `sessions` | `Map<id, {ws, name, rkey}>` | Live WebSocket connections. Insertion order = turn order. `rkey` (= `did` or `cid`) is the reconnect key. In-memory. |
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

**Per lobby (`LobbyDO`):** in memory — `rooms: Map<roomId, {count, phase,
endsAt, locked, isPublic, occupants, updated}>` (occupants carry `{name, goal,
pref}`) and `people: Map<id, {ws, name, pref, watching, did}>`. **Persisted** under
the `blocks` key — the block graph, `Map<did, Set<did>>`, symmetric (see
[On-device id + blocking](#on-device-id--blocking)).

**Client-only (localStorage, never sent to peers):** `nook.did` (persistent
per-browser id), `nook.prefs` (remembered name + camera preference), and
`nook.blocks` (`[{did, name}]`, your ignore list's display cache). Your to-do
list is React-only — `{id, text, done}` objects personal to you.

## Trade-offs and known limits

- **Refresh keeps your seat.** A refresh (or a mobile lock/background) reconnects
  via `sessionStorage`, and the server-side session is paused and persisted, so
  you land back in the same phase with the timer intact.
- **Media is off-loaded to JaaS.** 8x8 carries all media and NAT traversal, so
  strict-NAT users connect without any STUN/TURN of Nook's own. JaaS's free tier
  covers up to 25,000 monthly active users; everything else stays on free
  Cloudflare tiers.
- **Four-person rooms.** The cap is a product choice — a nook should feel like a
  small table — and it keeps the call comfortably inside the JaaS free tier.
- **Ephemeral *personal* data.** No accounts, no history of who was there, no chat
  archive — names, lists, chat, and video are never stored. Two anonymous things
  persist: the room's session state (so you can resume it), wiped after 6h empty;
  and the ignore block graph, pairs of opaque per-browser ids with no names
  attached (see [On-device id + blocking](#on-device-id--blocking)).
- **One global lobby.** Every presence socket lands on a single `LobbyDO`; fine
  for dozens of concurrent people, would need sharding for thousands.
