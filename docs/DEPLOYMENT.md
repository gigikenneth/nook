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

## Setting up video (JaaS)

Video is an embedded **Jitsi** call via **JaaS** (Jitsi as a Service, 8x8.vc),
login-free. There's no STUN/TURN/ICE to configure — 8x8 runs the media. Video
needs three Worker secrets from a free JaaS account; without them `/jitsi-token`
returns a friendly 503 and video is disabled (the rest of Nook still works).

1. Create a free account at **jaas.8x8.vc** (free up to 25,000 monthly active
   users). It provisions an app — copy the **App ID** (looks like
   `vpaas-magic-cookie-...`).
2. In the console go to **API Keys → Add API key → Generate key pair**. Download
   the **private key** (`.pem`) and note the **Key ID**.
3. Set the three secrets. `JAAS_APP_ID` is also sent to the browser (not really
   secret, but stored as one); `JAAS_PRIVATE_KEY` is the RSA private key (PKCS8
   PEM) that signs the JWTs — keep it secret:

   ```bash
   printf 'vpaas-magic-cookie-XXXX' | npx wrangler secret put JAAS_APP_ID
   printf 'YOUR_KEY_ID'             | npx wrangler secret put JAAS_KID
   npx wrangler secret put JAAS_PRIVATE_KEY < path/to/your-private-key.pem
   ```

   (The signer strips whitespace, so the multi-line PEM is fine piped as-is.)

4. Redeploy: `npx wrangler deploy`. Verify with
   `curl "https://<your-worker>/jitsi-token?room=test&name=x"` — you should get
   JSON `{ jwt, appId, roomName }`.

For **local dev**, put the same three keys in a gitignored `.dev.vars` at the
repo root so `wrangler dev` can sign tokens:

```
JAAS_APP_ID=vpaas-magic-cookie-XXXX
JAAS_KID=YOUR_KEY_ID
JAAS_PRIVATE_KEY="...single-line PEM..."
```

There's also a helper `scripts/jaas-jwt.mjs` (local, zero-dependency) that mints
a JaaS JWT from your App ID + Key ID + PEM for manual testing:

```bash
node scripts/jaas-jwt.mjs <APP_ID> <KEY_ID> path/to/key.pem
```

### Dead secrets

The old Cloudflare Realtime SFU / WebRTC-mesh setup is gone. If any of these
secrets are still set, they're unused and safe to delete: `REALTIME_APP_ID`,
`REALTIME_APP_TOKEN`, `TURN_KEY_ID`, `TURN_API_TOKEN`, `METERED_DOMAIN`,
`METERED_SECRET_KEY`.

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
- **Video** — runs on 8x8's JaaS (free up to 25,000 monthly active users), so it
  uses zero of your server bandwidth.

A sustained spike past the free tier would need a paid Cloudflare plan, which is
unlikely for a niche four-person tool.

## Troubleshooting

| Symptom | Cause / fix |
|:--|:--|
| `You need a workers.dev subdomain` (code 10063) | First-time account. Open **Workers & Pages** in the dashboard once (see First-time setup). |
| "Can't reach the server" in the app | The Worker isn't reachable. In local dev, make sure the Worker is running on :8787 (`npm run dev`). |
| Video is disabled / no call appears | The `JAAS_*` secrets aren't set, so `/jitsi-token` returns 503. Set up video (above). |
| Directory is empty | Only **public** rooms are listed, and only while occupied. Invite-only rooms never appear. |
