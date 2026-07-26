// Live directory of open (public) rooms for the landing page. Rooms push their
// occupants here; entries that stop reporting are pruned. Nothing persisted.

const STALE_MS = 30000;

export class LobbyDO {
  constructor() {
    this.rooms = new Map(); // roomId -> { count, phase, occupants, updated }
  }

  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === 'POST' && url.pathname.endsWith('/update')) {
      const { roomId, count, phase, occupants } = await req.json();
      if (!roomId) return new Response('bad', { status: 400 });
      if (!count || count <= 0) this.rooms.delete(roomId);
      else this.rooms.set(roomId, { count, phase, occupants: occupants || [], updated: Date.now() });
      return new Response('ok');
    }

    // GET /rooms — prune stale, return joinable-first list.
    const now = Date.now();
    const list = [];
    for (const [roomId, r] of this.rooms) {
      if (now - r.updated > STALE_MS) { this.rooms.delete(roomId); continue; }
      list.push({ roomId, count: r.count, phase: r.phase, occupants: r.occupants });
    }
    // Greeting rooms with space float to the top.
    list.sort((a, b) => {
      const openA = a.phase === 'greet' && a.count < 4 ? 0 : 1;
      const openB = b.phase === 'greet' && b.count < 4 ? 0 : 1;
      return openA - openB;
    });
    return Response.json({ rooms: list });
  }
}
