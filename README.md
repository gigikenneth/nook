# Nook

Quiet virtual coworking for up to four people. Show up, say what you're working
on, work heads-down alongside each other, then regroup. Inspired by Groove.

**Login-free. No database. Free to run.** Nothing about you is stored. Your name
and to-do list live only in your browser and in a room's memory, and the room
disappears when everyone leaves.

## How a session works

1. **Greet** (cameras on). Type your name and what you're working on. Everyone
   shares in turn: a frame moves from person to person, and each taps "I've
   shared my goal" to pass it along. Toggle your own mic or camera whenever you
   like. Mark yourself ready when you're set.
2. **Focus** (cameras off). Once everyone's ready, all you see is your to-do list
   and a shared countdown (50 minutes by default). Add, edit, check off, or
   delete tasks at any point during the session.
3. **Regroup** (cameras on). See what got done, then run another round.

The landing page shows a **live directory** of open rooms: who's around and what
they're working on, so you can join someone. Or start your own:

- **Open room**: listed in the directory, anyone can join (max 4).
- **Invite only**: private, not listed. Share the link yourself.

There's an ephemeral **chat** (never stored, history dies with the room) and
one-click **Download list** / **Download chat** to keep a copy. Soft chimes mark
the start of focus, the end of the timer, and the regroup.

## Design

Flat and retro-playful. The palette is the exact hue-complement of Groove's warm
one (every hue rotated 180 degrees on the wheel): a pale-blue ground with deep
indigo, mint, cyan, and lime accents. Type is Bricolage Grotesque for the
wordmark, Archivo for headings, Hanken Grotesk for body, and IBM Plex Mono for
the timer. Emoji art is [Twemoji](https://github.com/jdecked/twemoji).

## Architecture

No always-on server, no video server, no database.

| Piece | What it does |
|---|---|
| **Cloudflare Worker** (`src/worker.js`) | Serves the built web app, exposes the room directory at `/rooms`, and upgrades the room WebSocket at `/room/:id/ws`. |
| **RoomDO** (`src/RoomDO.js`) | One Durable Object per room. In-memory members, runs the session timer (via DO alarms), relays WebRTC signaling, enforces the cap of 4. |
| **LobbyDO** (`src/LobbyDO.js`) | Live directory of open rooms. Public rooms report their occupants; stale entries are pruned. |
| **Web app** (`web/`) | React + Vite. Video is a WebRTC **mesh** (peer-to-peer): at four or fewer people no SFU is needed, so it costs no server bandwidth. |

Video uses Google's public STUN server. There is **no TURN in v1**, so roughly
10 to 15 percent of users behind strict NAT won't connect video (presence and
the timer still work). Add a TURN server if that becomes a problem.

## Run locally

Two processes. From the repo root:

```bash
# 1. Signaling Worker (http://localhost:8787)
npm install
npm run dev

# 2. Web app (http://localhost:5173), in a second terminal
cd web
npm install
npm run dev
```

Open http://localhost:5173. Both processes must run: the app talks to the Worker
on :8787, and a missing Worker shows up as "Can't reach the server," not a fake
error. To test with others, share the invite link or open a second browser
profile.

## Deploy (free tier)

The Worker serves both the API and the built app, so it's one command and one
URL. You need a free Cloudflare account.

```bash
npm --prefix web install
npm --prefix web run build   # produces web/dist, which the Worker serves
npx wrangler login           # once, opens your browser
npx wrangler deploy          # deploys the Worker + app to https://nook.<you>.workers.dev
```

That's it. The app and the signaling server share an origin, so there's no CORS
or environment wiring to do.

Hosting the app and Worker on separate origins is still supported: build the app
with `VITE_API_BASE=https://your-worker.workers.dev` and deploy `web/dist`
anywhere static.

### Cost

Everything fits inside free tiers: Durable Objects (about 100k requests/day),
static asset serving, and peer-to-peer video that costs no server bandwidth. No
card required. A spike past the free tier would need a paid Cloudflare plan,
unlikely for a niche four-person tool.

## Configuration

- `VITE_API_BASE` (build-time): the Worker origin. Leave it unset for the
  single-origin deploy above, or when developing locally. Set it only if you
  host the app and Worker on separate origins.
- Session lengths (focus and regroup minutes) are set per room by whoever creates
  it, in the "Session length" fields on the home screen.

## License

MIT (Nook's own code). See [LICENSE](LICENSE). Third-party assets keep their own
licenses: Twemoji graphics are CC-BY 4.0, vendored in `web/public/twemoji/` with
their `ATTRIBUTION.txt`.
