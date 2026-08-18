import { RoomDO } from './RoomDO.js';
import { LobbyDO } from './LobbyDO.js';
import { signJaasToken, jitsiRoomName } from './jaas.js';

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

    // Login-free video: mint a JaaS (8x8.vc) JWT so the visitor joins the
    // embedded Jitsi call without an account. The RSA key stays a Worker secret;
    // the room name is a stable hash of Nook's room id, so only people already in
    // this Nook room (gated max-4 over the WebSocket) get a token for it.
    if (url.pathname === '/jitsi-token') {
      if (!env.JAAS_APP_ID || !env.JAAS_KID || !env.JAAS_PRIVATE_KEY) {
        return json({ error: 'Video isn\'t configured yet.' }, 503);
      }
      const roomId = url.searchParams.get('room');
      if (!roomId) return json({ error: 'room required' }, 400);
      const name = (url.searchParams.get('name') || 'Guest').slice(0, 50);
      try {
        const roomName = await jitsiRoomName(roomId);
        const jwt = await signJaasToken(env, { room: roomName, name });
        return json({ jwt, appId: env.JAAS_APP_ID, roomName });
      } catch {
        return json({ error: 'Could not start video right now.' }, 500);
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
