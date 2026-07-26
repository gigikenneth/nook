import { RoomDO } from './RoomDO.js';
import { LobbyDO } from './LobbyDO.js';

export { RoomDO, LobbyDO };

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

    // Live directory of open rooms for the landing page.
    if (url.pathname === '/rooms') {
      const lobby = env.LOBBY.get(env.LOBBY.idFromName('global'));
      const res = await lobby.fetch(new Request('https://lobby/rooms'));
      return new Response(await res.text(), {
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    // ICE servers for WebRTC. Always STUN; add a Cloudflare TURN relay (for peers
    // behind strict NAT that can't connect directly) when credentials are set.
    if (url.pathname === '/ice') {
      const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
      // Metered TURN (secret key stays server-side; never sent to the browser).
      // Mint a short-lived credential with the secret, then fetch the ready
      // iceServers for that credential's apiKey.
      if (env.METERED_DOMAIN && env.METERED_SECRET_KEY) {
        try {
          const mint = await fetch(
            `https://${env.METERED_DOMAIN}/api/v1/turn/credential?secretKey=${env.METERED_SECRET_KEY}`,
            { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expiryInSeconds: 86400 }) },
          );
          if (mint.ok) {
            const { apiKey } = await mint.json();
            if (apiKey) {
              const cr = await fetch(`https://${env.METERED_DOMAIN}/api/v1/turn/credentials?apiKey=${apiKey}`);
              if (cr.ok) {
                const arr = await cr.json();
                if (Array.isArray(arr) && arr.length) {
                  return Response.json({ iceServers: [...iceServers, ...arr] }, { headers: cors });
                }
              }
            }
          }
        } catch { /* fall through to STUN */ }
      }
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
            if (data.iceServers) iceServers.push(data.iceServers);
          }
        } catch { /* fall back to STUN-only */ }
      }
      return Response.json({ iceServers }, { headers: cors });
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
