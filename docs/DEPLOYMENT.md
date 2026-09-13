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

## Setting up video (Daily.co)

Video is an embedded **Daily.co** call, login-free. There's no STUN/TURN/ICE to
configure — Daily runs the media and NAT traversal. Video needs one Worker secret
(your Daily API key) plus the `DAILY_DOMAIN` var; without them `/daily-room`
returns a friendly 503 and video is disabled (the rest of Nook still works).

1. Create a free account at **daily.co**. Your account gets a domain like
   `your-team.daily.co`.
2. In the dashboard open **Developers** and copy your **API key**.
3. Set the domain (a plain var in `wrangler.toml`) and the API key (a secret):

   ```bash
   # In wrangler.toml, point DAILY_DOMAIN at your own subdomain:
   #   [vars]
   #   DAILY_DOMAIN = "your-team.daily.co"
   npx wrangler secret put DAILY_API_KEY
   ```

4. Redeploy: `npx wrangler deploy`. Verify with
   `curl "https://<your-worker>/daily-room?room=test"` — you should get JSON
   `{ url }`.

For **local dev**, put the API key in a gitignored `.dev.vars` at the repo root
(`DAILY_DOMAIN` comes from `wrangler.toml`):

```
DAILY_API_KEY=your-daily-api-key
```

Nook creates one **public** Daily room per Nook room, named by an unguessable
SHA-256 hash of the room id, and lets it self-expire after 2h — so rooms don't
accumulate, and only people already in the Nook room ever learn the URL.

### Dead secrets

JaaS (8x8) and the earlier Cloudflare Realtime SFU / WebRTC-mesh setups are gone.
If any of these secrets are still set, they're unused and safe to delete:
`JAAS_APP_ID`, `JAAS_KID`, `JAAS_PRIVATE_KEY`, `REALTIME_APP_ID`,
`REALTIME_APP_TOKEN`, `TURN_KEY_ID`, `TURN_API_TOKEN`, `METERED_DOMAIN`,
`METERED_SECRET_KEY`. (`src/jaas.js` and `scripts/jaas-jwt.mjs` linger only for
the room-name hash and legacy reference — the JaaS token path is no longer wired
up.)

## In-app bug reports (optional)

The app has a "Report a bug" form that POSTs `/report`; the Worker files a GitHub
issue so reporters need no GitHub account. It's off until you set a token:

```bash
npx wrangler secret put GH_TOKEN   # fine-grained PAT with Issues: write on your repo
# optional: which repo the issues land in (default gigikenneth/nook)
printf 'you/your-repo' | npx wrangler secret put GH_REPO
```

Without `GH_TOKEN`, `/report` returns a friendly 503 and the form says bug
reporting isn't set up. A honeypot field and a minimum-length check keep out bots.

## Cost

Everything fits inside free tiers:

- **Durable Objects** — roughly 100k requests/day on the free plan. Each room and
  the lobby are DOs; signaling messages are cheap.
- **Static asset serving** — free with the Worker.
- **Video** — runs on Daily.co's free tier, so it uses zero of your server
  bandwidth.

A sustained spike past the free tier would need a paid Cloudflare plan, which is
unlikely for a niche four-person tool.

## Troubleshooting

| Symptom | Cause / fix |
|:--|:--|
| `You need a workers.dev subdomain` (code 10063) | First-time account. Open **Workers & Pages** in the dashboard once (see First-time setup). |
| "Can't reach the server" in the app | The Worker isn't reachable. In local dev, make sure the Worker is running on :8787 (`npm run dev`). |
| Video is disabled / no call appears | `DAILY_API_KEY` or `DAILY_DOMAIN` isn't set, so `/daily-room` returns 503. Set up video (above). |
| Directory is empty | Only **public** rooms are listed, and only while occupied. Invite-only rooms never appear. |
