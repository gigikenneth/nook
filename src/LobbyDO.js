// Live directory of open (public) rooms for the landing page. Rooms push their
// occupants here; entries that stop reporting are pruned. Nothing persisted.
//
// Also the presence hub: opted-in people on the home screen hold a WebSocket
// here so they can see who else is around and ping each other to cowork.

const STALE_MS = 30000;
const PING_COOLDOWN_MS = 4000; // ignore repeat pings to the same person

export class LobbyDO {
  constructor() {
    this.rooms = new Map(); // roomId -> { count, phase, occupants, updated }
    this.people = new Map(); // personId -> { ws, name }
    this.lastPing = new Map(); // `${fromId}:${toId}` -> timestamp
  }

  async fetch(req) {
    // Presence WebSocket: opted-in home-screen users.
    if (req.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      const id = crypto.randomUUID();
      server.addEventListener('message', (e) => this.onPresence(id, server, e));
      const drop = () => this.leave(id);
      server.addEventListener('close', drop);
      server.addEventListener('error', drop);
      server.send(JSON.stringify({ type: 'welcome', id }));
      return new Response(null, { status: 101, webSocket: client });
    }

    const url = new URL(req.url);

    if (req.method === 'POST' && url.pathname.endsWith('/update')) {
      const { roomId, count, phase, endsAt, locked, isPublic, occupants } = await req.json();
      if (!roomId) return new Response('bad', { status: 400 });
      if (!count || count <= 0) this.rooms.delete(roomId);
      else this.rooms.set(roomId, { count, phase, endsAt: endsAt || null, locked: !!locked, isPublic: isPublic !== false, occupants: occupants || [], updated: Date.now() });
      return new Response('ok');
    }

    // GET /rooms — prune stale, return joinable-first list.
    const now = Date.now();
    const list = [];
    for (const [roomId, r] of this.rooms) {
      if (now - r.updated > STALE_MS) { this.rooms.delete(roomId); continue; }
      list.push({ roomId, count: r.count, phase: r.phase, endsAt: r.endsAt, locked: r.locked, isPublic: r.isPublic, occupants: r.occupants });
    }
    // Actually-joinable rooms (public, unlocked, greeting, with space) float up.
    const joinable = (r) => (r.isPublic && !r.locked && r.phase === 'greet' && r.count < 4 ? 0 : 1);
    list.sort((a, b) => joinable(a) - joinable(b));
    return Response.json({ rooms: list });
  }

  onPresence(id, ws, e) {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    switch (m.type) {
      case 'hello': // opt in: announce yourself and appear in the roster
        this.people.set(id, { ws, name: String(m.name || 'Someone').slice(0, 32) });
        this.broadcastRoster();
        break;
      case 'watch': // peeking from inside a session: see the roster + able to ping,
        // but stay off everyone else's list (you're busy, not available).
        this.people.set(id, { ws, name: String(m.name || 'Someone').slice(0, 32), watching: true });
        try { ws.send(JSON.stringify(this.rosterMsg())); } catch { /* dropped */ }
        break;
      case 'rename': {
        const p = this.people.get(id);
        if (p) { p.name = String(m.name || 'Someone').slice(0, 32); this.broadcastRoster(); }
        break;
      }
      case 'ping': { // "come cowork with me" -> deliver an invite to one person
        const from = this.people.get(id);
        const target = this.people.get(m.toId);
        if (!from || !target || !m.roomId) break;
        const key = `${id}:${m.toId}`;
        const now = Date.now();
        if (now - (this.lastPing.get(key) || 0) < PING_COOLDOWN_MS) break; // debounce
        this.lastPing.set(key, now);
        try {
          target.ws.send(JSON.stringify({
            type: 'invite', fromId: id, fromName: from.name, roomId: String(m.roomId).slice(0, 64),
          }));
        } catch { /* target gone; roster will catch up */ }
        break;
      }
    }
  }

  leave(id) {
    if (this.people.delete(id)) this.broadcastRoster();
  }

  // Visible roster excludes watchers (people peeking from a session), but the
  // message still goes out to everyone connected — watchers included, so they
  // see who's around.
  rosterMsg() {
    const people = [...this.people]
      .filter(([, p]) => !p.watching)
      .map(([id, p]) => ({ id, name: p.name }));
    return { type: 'roster', people };
  }
  broadcastRoster() {
    const msg = JSON.stringify(this.rosterMsg());
    for (const p of this.people.values()) {
      try { p.ws.send(msg); } catch { /* dropped socket; its close handler prunes it */ }
    }
  }
}
