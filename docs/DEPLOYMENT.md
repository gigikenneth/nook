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

## Adding a TURN server (needed across networks)

Video/audio is peer-to-peer. With only STUN (the default), people on **different
networks** where one side is behind a strict/symmetric NAT can't form a direct
connection — they see each other's names and the timer (that's the server), but
no camera or mic comes through. A **TURN relay** fixes this by relaying the media.

The Worker's `/ice` endpoint returns STUN plus a TURN relay when credentials are
set (STUN-only otherwise, so video still works for same-network / permissive-NAT
users). It supports two providers, in order: **Metered** (no credit card) and
**Cloudflare** (needs a card, larger free tier).

### Option A: Metered (no credit card)

Free tier is 500 MB/month of relayed traffic (only strict-NAT peers use the
relay, so it stretches, but it's small — fine for testing and light use).

1. Sign up at **dashboard.metered.ca** (email, no card). Under **Developers**,
   copy your **Metered domain** (`yourname.metered.live`) and **Secret Key**.
2. Set them as Worker secrets (the secret key stays server-side — the `/ice`
   endpoint uses it to mint short-lived TURN credentials, never sending it to the
   browser):

   ```bash
   printf 'yourname.metered.live' | npx wrangler secret put METERED_DOMAIN
   printf 'YOUR_SECRET_KEY'        | npx wrangler secret put METERED_SECRET_KEY
   ```

3. Redeploy: `npx wrangler deploy`. Verify with `curl https://<your-worker>/ice`
   — you should see `turn:global.relay.metered.ca` entries.

### Option B: Cloudflare TURN (needs a card, 1,000 GB free)

Requires a payment method on file (no charge at Nook's scale). Dashboard →
**Realtime → TURN Keys → Create**, then:

```bash
npx wrangler secret put TURN_KEY_ID       # the Turn Token ID
npx wrangler secret put TURN_API_TOKEN    # the API Token
npx wrangler deploy
```

Any standard TURN server works too — point the `/ice` endpoint in
`src/worker.js` at it instead.

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
