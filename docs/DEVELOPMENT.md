# Development

How to run Nook locally, how the code is laid out, and how to contribute.

For how the system works conceptually (phases, protocol, data model), read
[ARCHITECTURE.md](ARCHITECTURE.md) first. This document is about the code.

## Prerequisites

- Node.js 18+ and npm.
- A modern browser. For testing multiplayer locally, use two browser profiles or
  an incognito window (each tab is a separate participant).

## Running locally

Nook is two processes: the signaling **Worker** and the **web app**. Run both.

```bash
# From the repo root — terminal 1: the Worker (http://localhost:8787)
npm install
npm run dev

# terminal 2: the web app (http://localhost:5173)
cd web
npm install
npm run dev
```

Open <http://localhost:5173>.

**Both must be running.** The app talks to the Worker on `:8787`; if the Worker
is down, the app shows "Can't reach the server" rather than a misleading error.
In dev, `web/src/config.js` points the app at `http://localhost:8787` explicitly;
in production it uses the same origin as the page.

### Video (JaaS) in local dev

Video is an embedded Jitsi call via JaaS (8x8.vc). To turn it on locally, put your
JaaS credentials in a gitignored `.dev.vars` at the repo root (`wrangler dev` reads
it):

```
JAAS_APP_ID=vpaas-magic-cookie-…
JAAS_KID=vpaas-magic-cookie-…/abc123
JAAS_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----
```

The PEM can be a single line (escaped newlines are fine). Without these,
`GET /jitsi-token` returns `503` and video is simply off — the rest of the app
(presence, rooms, chat, timer) still works under `wrangler dev`. To sanity-check a
token by hand, `scripts/jaas-jwt.mjs` mints a test JWT from an App ID, Key ID, and
PEM.

### Testing a multi-person session

1. Open <http://localhost:5173>, enter a name, and **Open room**.
2. Copy the invite link (or the `#room/<id>` URL).
3. Open it in a second browser profile / incognito window, enter a different name,
   and join. You'll see the embedded Jitsi call, the shared timer, the goal-sharing
   turns, chat, and kick all working across the two.

## Project structure

```
nook/
├── wrangler.toml            # Cloudflare config: Worker entry, assets, DO bindings
├── package.json             # root: wrangler dev/deploy scripts
├── src/                     # the Cloudflare Worker (server side)
│   ├── worker.js            #   HTTP router: serves app, /rooms, /jitsi-token, /report, WS routes
│   ├── jaas.js              #   JaaS JWT signer (WebCrypto RS256) + jitsiRoomName()
│   ├── RoomDO.js            #   Durable Object — one per room (state, persistence, timer, signaling)
│   ├── LobbyDO.js           #   Durable Object — global directory + presence hub
│   ├── RoomDO.test.mjs      #   node self-check: session persist/pause/resume + camera pref
│   └── LobbyDO.test.mjs     #   node self-check: watch-mode roster + camera pref
└── web/                     # the React + Vite front end
    ├── index.html           #   fonts + root
    ├── vite.config.js
    ├── .env.example         #   VITE_API_BASE (optional, for split-origin hosting)
    └── src/
        ├── main.jsx         #   React entry
        ├── App.jsx          #   top level: shows Home or Room based on session
        ├── Home.jsx         #   landing: live directory + "around now" + create/join form
        ├── Room.jsx         #   the session UI: phases, tasks, chat, check-in
        ├── JitsiStage.jsx   #   embeds the Jitsi call (8x8.vc external_api.js), Nook mic/cam buttons drive it
        ├── useRoom.js       #   the WebSocket + coworking-state hook (video is the embedded Jitsi call in JitsiStage.jsx)
        ├── useLobby.js      #   presence socket: roster, ping, watch mode, camera pref
        ├── useWakeLock.js   #   Screen Wake Lock while in a room
        ├── config.js        #   resolves the API / WebSocket origin
        ├── graphics.jsx     #   Twemoji decorations + CamBadge / CamPrefPicker
        ├── sound.js         #   chimes: phases, join, 5-min warning (Web Audio, no files)
        ├── ReportBug.jsx    #   in-app bug report form (POSTs /report)
        └── styles.css       #   all styling
```

### Where things live

- **Client state & networking:** `web/src/useRoom.js`. It owns the room WebSocket
  and all coworking state (presence, phases, timer, chat, tasks, goals, the
  camera-pref signal) and handles every server message. It's WebSocket-only —
  video lives entirely in the embedded Jitsi call. If you're touching presence,
  phases, or reconnection, it's here.
- **Video:** `web/src/JitsiStage.jsx`. Embeds the JaaS (8x8.vc) Jitsi call,
  login-free — Nook's own mic/cam buttons drive it, the Jitsi toolbar and prejoin
  are hidden, and it's mounted only in greet/regroup. The Worker mints the JaaS
  JWT (`src/jaas.js`, served at `GET /jitsi-token`).
- **Session UI:** `web/src/Room.jsx`. Phase panels (greet/focus/regroup), the
  editable task list, mic/cam toggles, chat.
- **Directory & entry:** `web/src/Home.jsx`. The live room list and the
  create/join form.
- **Server room logic:** `src/RoomDO.js`. The authoritative per-room state
  machine and message relay.
- **Directory server:** `src/LobbyDO.js`. The public-room registry.

## Scripts

Root (`package.json`):

| Command | What it does |
|:--|:--|
| `npm run dev` | Run the Worker locally via `wrangler dev` (:8787). |
| `npm run deploy` | Deploy to Cloudflare (`wrangler deploy`). |

Web (`web/package.json`):

| Command | What it does |
|:--|:--|
| `npm run dev` | Vite dev server (:5173). |
| `npm run build` | Production build to `web/dist`. |
| `npm run preview` | Preview the production build. |

## Configuration

- **`VITE_API_BASE`** (build-time env, see `web/.env.example`): the Worker origin.
  Leave unset for the standard same-origin deploy and for local dev defaults. Set
  it only when hosting the app and Worker on separate origins.
- **Session lengths** are per room, chosen by whoever creates it (the "Session
  length" fields on the home screen), not global config.
- **Room constants** live in `src/RoomDO.js`: `MAX = 4` (people per room),
  `HEARTBEAT_MS` (lobby refresh cadence), `SESSION_KEY` (persisted-session storage
  key), `ABANDON_MS` (empty-room wipe delay, 6h). `STALE_MS` (directory pruning)
  and `PING_COOLDOWN_MS` are in `src/LobbyDO.js`.

## Testing

There's no test framework. A few pieces of pure server/client logic have plain
`node`-runnable self-checks (Node's `assert`, no deps) — run them directly:

```bash
node src/RoomDO.test.mjs     # session persist / pause / resume / abandon + camera pref
node src/LobbyDO.test.mjs    # presence watch-mode roster + camera pref
node web/src/theme.test.mjs  # theme (dark mode) helper
```

Everything else relies on manual, multi-tab testing (open a room in two profiles
and exercise the flow). When adding non-trivial logic, verify at minimum:

- Two people can join and see each other in the embedded Jitsi call in greet.
- The full phase cycle runs: greet → focus (timer counts) → regroup → greet.
- Goal-sharing turns advance and the ready flow gates focus correctly.
- Leaving/kicking updates everyone's view and migrates the host if needed.
- A room disappears from the directory shortly after it empties.

## Contributing

1. Branch off `main`.
2. Keep the ethos: **no database, no accounts, no personal-data persistence,
   four-person rooms.** Two things persist, and neither identifies a person: a
   room's session state (so it can resume — no names, goals, or messages) and the
   anonymous ignore block graph (pairs of opaque per-browser ids). Features that
   break those are out of scope by design.
3. Match the existing style — small, plain modules; comments that explain *why*,
   not *what*.
4. Test the multi-tab flow above before opening a PR.
5. Use `gigikenneth7@gmail.com`-linked commits if you're deploying to the shared
   Vercel/Cloudflare setup; otherwise your own identity is fine.

## Conventions

- **Plain JavaScript**, no TypeScript, no build step for the Worker.
- **No new dependencies** for something a few lines can do. The whole client is
  React + the platform (WebSocket, Web Audio) plus the embedded Jitsi call (the
  JaaS SDK, loaded from 8x8.vc) for video — keep it that way.
- **Comments name the reason.** e.g. why the call joins muted, why a full
  room closes with `4001` instead of rejecting the upgrade.
