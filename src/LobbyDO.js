// Live directory of open (public) rooms for the landing page. Rooms push their
// occupants here; entries that stop reporting are pruned. Nothing persisted.
//
// Also the presence hub: opted-in people on the home screen hold a WebSocket
// here so they can see who else is around and ping each other to cowork.

const STALE_MS = 30000;
const PING_COOLDOWN_MS = 4000; // ignore repeat pings to the same person
const BLOCKS_KEY = 'blocks'; // persisted block graph (survives eviction/deploy)
const prefOf = (v) => (v === 'on' || v === 'off' ? v : null); // camera preference, else unset

export class LobbyDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.rooms = new Map(); // roomId -> { count, phase, occupants, updated }
    this.people = new Map(); // personId -> { ws, name, did }
    this.lastPing = new Map(); // `${fromId}:${toId}` -> timestamp
    // Durable, symmetric block graph keyed by did: did -> Set(dids they can't
    // see and who can't see them). Anonymous ids, no PII, but relational and
    // persisted — the deliberate Level 3 departure from "nothing stored" for
    // issue #28. See docs/superpowers/specs/2026-08-02-on-device-id-design.md.
    // ponytail: per-did adjacency, no index; Nook's graph is tiny. Shard if it
    // ever isn't.
    this.blocks = new Map();
    this._restore = state && state.blockConcurrencyWhile(async () => {
      const raw = await state.storage.get(BLOCKS_KEY);
      if (raw) for (const [d, list] of Object.entries(raw)) this.blocks.set(d, new Set(list));
    });
  }

  persistBlocks() {
    if (!this.state) return;
    const obj = {};
    for (const [d, set] of this.blocks) if (set.size) obj[d] = [...set];
    return this.state.storage.put(BLOCKS_KEY, obj);
  }

  isBlocked(a, b) {
    return !!(a && b && this.blocks.get(a)?.has(b));
  }
  addBlock(a, b) {
    if (!a || !b || a === b) return;
    if (!this.blocks.has(a)) this.blocks.set(a, new Set());
    if (!this.blocks.has(b)) this.blocks.set(b, new Set());
    this.blocks.get(a).add(b);
    this.blocks.get(b).add(a);
    this.persistBlocks();
  }
  removeBlock(a, b) {
    this.blocks.get(a)?.delete(b);
    this.blocks.get(b)?.delete(a);
    this.persistBlocks();
  }

  async fetch(req) {
    await this._restore; // block graph loaded before any request touches it

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
        this.people.set(id, { ws, name: String(m.name || 'Someone').slice(0, 32), pref: prefOf(m.pref), did: m.did || null });
        this.sendBlocked(id); // let the client reconcile its ignore list
        this.broadcastRoster();
        break;
      case 'watch': // peeking from inside a session: see the roster + able to ping,
        // but stay off everyone else's list (you're busy, not available).
        this.people.set(id, { ws, name: String(m.name || 'Someone').slice(0, 32), watching: true, did: m.did || null });
        this.sendBlocked(id);
        try { ws.send(JSON.stringify(this.rosterFor(m.did || null))); } catch { /* dropped */ }
        break;
      case 'block': { // ignore someone in Around-now: mutual, durable
        const from = this.people.get(id);
        const target = this.people.get(m.toId);
        if (from?.did && target?.did) {
          this.addBlock(from.did, target.did);
          try { ws.send(JSON.stringify({ type: 'blocked', did: target.did, name: target.name })); } catch { /* dropped */ }
          this.broadcastRoster();
        }
        break;
      }
      case 'unblock': { // un-ignore, by the did the client kept locally
        const from = this.people.get(id);
        if (from?.did && m.did) {
          this.removeBlock(from.did, m.did);
          try { ws.send(JSON.stringify({ type: 'unblocked', did: m.did })); } catch { /* dropped */ }
          this.broadcastRoster();
        }
        break;
      }
      case 'rename': {
        const p = this.people.get(id);
        if (p) { p.name = String(m.name || 'Someone').slice(0, 32); this.broadcastRoster(); }
        break;
      }
      case 'pref': { // camera-preference signal, shown next to the name in "Around now"
        const p = this.people.get(id);
        if (p) { p.pref = prefOf(m.pref); this.broadcastRoster(); }
        break;
      }
      case 'ping': { // "come cowork with me" -> deliver an invite to one person
        const from = this.people.get(id);
        const target = this.people.get(m.toId);
        if (!from || !target || !m.roomId) break;
        if (this.isBlocked(from.did, target.did)) break; // blocked pair can't pull each other in
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

  // Roster for one viewer: excludes watchers (people peeking from a session)
  // and anyone the viewer has blocked. Filtering by the other person's did is
  // done here on the server — dids never go out to clients, so blocking never
  // makes an id peer-visible.
  rosterFor(viewerDid) {
    const hidden = (viewerDid && this.blocks.get(viewerDid)) || null;
    const people = [...this.people]
      .filter(([, p]) => !p.watching && !(hidden && p.did && hidden.has(p.did)))
      .map(([id, p]) => ({ id, name: p.name, pref: p.pref || null }));
    return { type: 'roster', people };
  }
  // Roster is per-viewer now, so send each connected person their own filtered
  // copy rather than one broadcast. Around-now is a handful of people.
  broadcastRoster() {
    for (const p of this.people.values()) {
      try { p.ws.send(JSON.stringify(this.rosterFor(p.did))); } catch { /* dropped socket; its close handler prunes it */ }
    }
  }
  // Tell one client which dids it has blocked, so its un-ignore list survives a
  // cleared localStorage (names are cached client-side; dids are authoritative
  // here).
  sendBlocked(id) {
    const p = this.people.get(id);
    if (!p) return;
    const dids = (p.did && this.blocks.get(p.did)) ? [...this.blocks.get(p.did)] : [];
    try { p.ws.send(JSON.stringify({ type: 'blocked-list', dids })); } catch { /* dropped */ }
  }
}
