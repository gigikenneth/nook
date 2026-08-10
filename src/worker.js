import { RoomDO } from './RoomDO.js';
import { LobbyDO } from './LobbyDO.js';

export { RoomDO, LobbyDO };

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': '*',
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

    // In-app bug report -> files a GitHub issue via a token, so reporters need no
    // GitHub account. Configure with GH_TOKEN (fine-grained PAT, Issues: write).
    if (url.pathname === '/report' && req.method === 'POST') {
      if (!env.GH_TOKEN) return json({ error: 'Bug reporting isn\'t set up yet.' }, 503);
      let body;
      try { body = await req.json(); } catch { return json({ error: 'bad request' }, 400); }
      if (body.hp) return json({ ok: true }); // honeypot filled -> silently drop bots
      const message = String(body.message || '').trim().slice(0, 4000);
      const email = String(body.email || '').trim().slice(0, 120);
      if (message.length < 5) return json({ error: 'Please add a bit more detail.' }, 400);
      const repo = env.GH_REPO || 'gigikenneth/nook';
      const title = `App report: ${message.slice(0, 60).replace(/\s+/g, ' ')}`;
      const issueBody = `${message}\n\n---\n_Reported from the app${email ? ` — reply to ${email}` : ''}._`;
      try {
        const r = await fetch(`https://api.github.com/repos/${repo}/issues`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.GH_TOKEN}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'nook-app',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ title, body: issueBody, labels: ['bug', 'from-app'] }),
        });
        if (!r.ok) return json({ error: 'Could not submit right now. Try again later.' }, 502);
        return json({ ok: true });
      } catch {
        return json({ error: 'Could not submit right now. Try again later.' }, 502);
      }
    }

    // Live directory of open rooms for the landing page.
    if (url.pathname === '/rooms') {
      const lobby = env.LOBBY.get(env.LOBBY.idFromName('global'));
      const res = await lobby.fetch(new Request('https://lobby/rooms'));
      return new Response(await res.text(), {
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    // ICE servers for WebRTC. Cloudflare Realtime TURN is the primary relay —
    // free alongside the SFU and co-located with the same edge the media goes
    // through, so strict-NAT clients (phones on cellular, locked-down wifi) can
    // still reach it. The TURN token stays server-side; we mint short-lived
    // creds per request. STUN-only is the last-resort fallback if TURN is down.
    if (url.pathname === '/ice') {
      const iceServers = [{ urls: 'stun:stun.cloudflare.com:3478' }];
      if (env.TURN_KEY_ID && env.TURN_API_TOKEN) {
        try {
          const r = await fetch(
            `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
            {
              method: 'POST',
              headers: { Authorization: `Bearer ${env.TURN_API_TOKEN}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ ttl: 86400 }),
            },
          );
          if (r.ok) {
            const data = await r.json();
            // Cloudflare returns iceServers as an array of one {urls,username,
            // credential} object; spread it in (pushing the array nests it and
            // browsers silently ignore the malformed entry -> no TURN).
            if (Array.isArray(data.iceServers)) iceServers.push(...data.iceServers);
            else if (data.iceServers) iceServers.push(data.iceServers);
          }
        } catch { /* fall back to STUN-only */ }
      }
      return Response.json({ iceServers }, { headers: cors });
    }

    // Cloudflare Realtime (SFU) signaling proxy. The client hits our Worker so
    // the app token stays server-side; we forward to the Realtime Connection API
    // 1:1 (sessions/new, sessions/:id/tracks/new, sessions/:id/renegotiate),
    // injecting Authorization. Path after /realtime/ maps straight onto the API.
    if (url.pathname.startsWith('/realtime/')) {
      if (!env.REALTIME_APP_ID || !env.REALTIME_APP_TOKEN) {
        return json({ error: 'Realtime is not configured.' }, 503);
      }
      const rest = url.pathname.slice('/realtime/'.length);
      const target = `https://rtc.live.cloudflare.com/v1/apps/${env.REALTIME_APP_ID}/${rest}`;
      try {
        const r = await fetch(target, {
          method: req.method,
          headers: {
            Authorization: `Bearer ${env.REALTIME_APP_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.text(),
        });
        return new Response(await r.text(), {
          status: r.status,
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      } catch {
        return json({ error: 'Realtime upstream unavailable.' }, 502);
      }
    }

    // Presence websocket for the "who's around" list + cowork invites.
    if (url.pathname === '/lobby/ws') {
      const lobby = env.LOBBY.get(env.LOBBY.idFromName('global'));
      return lobby.fetch(req);
    }

    // Room signaling websocket: /room/:id/ws
    const m = url.pathname.match(/^\/room\/([^/]+)\/ws$/);
    if (m) {
      const room = env.ROOM.get(env.ROOM.idFromName(m[1]));
      return room.fetch(req);
    }

    return new Response('nook signaling server', { headers: cors });
  },
};
