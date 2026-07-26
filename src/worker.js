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

    // Room signaling websocket: /room/:id/ws
    const m = url.pathname.match(/^\/room\/([^/]+)\/ws$/);
    if (m) {
      const room = env.ROOM.get(env.ROOM.idFromName(m[1]));
      return room.fetch(req);
    }

    return new Response('nook signaling server', { headers: cors });
  },
};
