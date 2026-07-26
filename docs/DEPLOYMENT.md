# Deployment

Nook deploys to Cloudflare as a **single Worker that serves both the app and the
signaling API**. One command, one URL, no CORS, no card required.

## Prerequisites

- A free [Cloudflare account](https://dash.cloudflare.com/sign-up).
- Node.js 18+ and npm.
- The repo cloned locally.

## First-time setup

If this is the very first Worker on your Cloudflare account, open the dashboard
once so Cloudflare creates your `workers.dev` subdomain:

1. Go to <https://dash.cloudflare.com>.
2. Click **Workers & Pages** in the sidebar. Opening it once provisions your
   `<name>.workers.dev` subdomain (you may be asked to pick the name).

Skip this if you already have Workers on the account.

## Deploy

From the repo root:

```bash
npm --prefix web install
npm --prefix web run build   # builds web/dist, which the Worker serves
npx wrangler login           # once, opens your browser to authorize
npx wrangler deploy          # deploys Worker + app
```

Wrangler prints your live URL, e.g. `https://nook.<you>.workers.dev`. That's it —
the app and the signaling server share an origin, so there is no environment
wiring to do.

### What gets deployed

`wrangler.toml` declares:

- `main = "src/worker.js"` — the Worker entrypoint.
- `[assets] directory = "./web/dist"` — the built app. Static files are served
  directly; unmatched paths (`/rooms`, `/room/:id/ws`) fall through to the
  Worker. Routing is hash-based, so every real page path is `/` → `index.html`;
  no SPA fallback config is needed.
- Two Durable Object bindings (`ROOM`, `LOBBY`) and a `v1` migration declaring
  them as SQLite-backed classes (required on the free plan).

## Redeploying

After any change, rebuild the app and deploy again:

```bash
npm --prefix web run build && npx wrangler deploy
```

The Worker code and the static assets are uploaded together; unchanged assets are
skipped.

## Custom domain

To serve Nook from your own domain instead of `*.workers.dev`:

1. Add the domain to Cloudflare (it must use Cloudflare DNS).
2. In the dashboard: **Workers & Pages → nook → Settings → Domains & Routes →
   Add custom domain**, or add a `route` to `wrangler.toml`.

No app changes are needed — the client derives its API/WebSocket origin from
`window.location`, so it works on any domain automatically.

## Hosting the app and API separately (optional)

The default is one origin. If you'd rather host the static app elsewhere (GitHub
Pages, Cloudflare Pages, a CDN) and keep only the Worker for signaling:

```bash
# Build the app pointed at the Worker origin:
VITE_API_BASE=https://nook.<you>.workers.dev npm --prefix web run build
# Deploy web/dist/ wherever you like.
```

`VITE_API_BASE` sets the API/WebSocket origin at build time. Unset (the default)
means "same origin as the page". The Worker already sends permissive CORS headers
for the cross-origin case.

## Adding a TURN server (better connectivity)

By default Nook uses only Google's public STUN server and no TURN relay, so
~10–15% of users behind strict NAT can't establish video. To fix that, add a TURN
server to the ICE configuration in `web/src/useRoom.js`:

```js
const ICE = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    {
      urls: 'turn:your-turn-host:3478',
      username: 'user',
      credential: 'pass',
    },
  ],
};
```

Cloudflare offers a TURN service on its free plan; any standard TURN server works.
Then rebuild and redeploy.

## Cost

Everything fits inside free tiers:

- **Durable Objects** — roughly 100k requests/day on the free plan. Each room and
  the lobby are DOs; signaling messages are cheap.
- **Static asset serving** — free with the Worker.
- **Video** — peer-to-peer, so it uses zero server bandwidth.

A sustained spike past the free tier would need a paid Cloudflare plan, which is
unlikely for a niche four-person tool.

## Troubleshooting

| Symptom | Cause / fix |
|:--|:--|
| `You need a workers.dev subdomain` (code 10063) | First-time account. Open **Workers & Pages** in the dashboard once (see First-time setup). |
| "Can't reach the server" in the app | The Worker isn't reachable. In local dev, make sure the Worker is running on :8787 (`npm run dev`). |
| Video never connects for some users | Strict NAT with no TURN. Add a TURN server (above). |
| Directory is empty | Only **public** rooms are listed, and only while occupied. Invite-only rooms never appear. |
