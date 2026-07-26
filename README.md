# Nook

Quiet virtual coworking for up to four people. Show up, say what you're working
on, work heads-down alongside each other, then regroup. Inspired by Groove.

**Login-free. No database. Free to run.** Nothing about you is stored — your name
and to-do list live only in your browser and in a room's memory, and the room
disappears when everyone leaves.

## How a session works

1. **Greet** — cameras on. Type your name and what you're working on, then mark
   yourself ready.
2. **Focus** — once everyone's ready, cameras turn off. All you see is your list
   and a shared countdown (50 min by default).
3. **Regroup** — cameras come back on. See what got done, then run another round.

The landing page shows a **live directory** of open rooms — who's around and what
they're working on — so you can join someone. Or start your own:
- **Open room** → listed in the directory, anyone can join (max 4).
- **Invite only** → private, not listed; share the link yourself.

There's also an ephemeral **chat** (never stored — history dies with the room), and
one-click **Download list** / **Download chat** to keep a copy. Soft chimes mark the
start of focus, the end of the timer, and the regroup.

## Architecture

No always-on server, no video server, no database.

| Piece | What it does |
|---|---|
| **Cloudflare Worker** (`src/worker.js`) | Routes `/match` and the room WebSocket. |
| **RoomDO** (`src/RoomDO.js`) | One Durable Object per room. In-memory members, runs the session timer (via DO alarms), relays WebRTC signaling, enforces the cap of 4. |
| **LobbyDO** (`src/LobbyDO.js`) | Live directory of open rooms. Public rooms report their occupants; stale entries are pruned. |
| **Web app** (`web/`) | React + Vite. WebRTC **mesh** (peer-to-peer) video — at ≤4 people no SFU is needed. |

Design: Material 3 Expressive + Liquid Glass, green palette, Fredoka display type.

Video uses Google's public STUN server. There's **no TURN in v1**, so roughly
10–15% of users behind strict NAT won't be able to connect video (presence and
the timer still work). Add a TURN server if that becomes a problem.

## Run locally

Two processes. From the repo root:

```bash
# 1. Signaling Worker (http://localhost:8787)
npm install
npm run dev

# 2. Web app (http://localhost:5173) — in a second terminal
cd web
npm install
npm run dev
```

Open http://localhost:5173. To test with others, share the invite link or open a
second browser profile.

## Deploy (free tier)

**Worker** — needs a free Cloudflare account:

```bash
npx wrangler deploy
```

Note the deployed URL (e.g. `https://nook.<you>.workers.dev`).

**Web app** — build with the Worker URL, deploy the static output anywhere
(Cloudflare Pages, GitHub Pages, etc.):

```bash
cd web
VITE_API_BASE=https://nook.<you>.workers.dev npm run build
# deploy web/dist/
```

### Cost

Everything fits inside free tiers: Durable Objects (~100k requests/day), static
hosting, and peer-to-peer video that costs no server bandwidth. No card required.
A spike past the free tier would need a paid Cloudflare plan — unlikely for a
niche four-person tool.

## Configuration

- `web/.env` → `VITE_API_BASE` — the deployed Worker URL. Unset = local dev.
- Session lengths (focus / regroup minutes) are set per room by whoever creates
  it, via "Set session length" on the home screen.

## Design

Full design rationale: [docs/superpowers/specs/2026-07-26-nook-design.md](docs/superpowers/specs/2026-07-26-nook-design.md).

## Assets

Emoji graphics are [Twemoji](https://github.com/jdecked/twemoji) (© Twitter),
code MIT, graphics CC-BY 4.0. Vendored in `web/public/twemoji/` — see its
`ATTRIBUTION.txt`.

## License

MIT (Nook's own code). See [LICENSE](LICENSE). Third-party assets keep their own
licenses, noted above.
