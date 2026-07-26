// One Durable Object per room. Holds live WebSocket sessions, runs the session
// timer, relays WebRTC signaling between the (max 4) peers. Nothing is persisted:
// state lives in memory and dies when the room empties.

const MAX = 4;

function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return def;
  return Math.max(min, Math.min(max, n));
}

export class RoomDO {
  constructor(state) {
    this.state = state;
    this.sessions = new Map(); // id -> { ws, name }
    this.ready = new Set();
    this.phase = 'greet'; // greet | focus | regroup
    this.endsAt = null;
    this.focusMin = 50;
    this.regroupMin = 5;
    this.hostId = null;
  }

  async fetch(req) {
    if (req.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    if (this.sessions.size >= MAX) {
      return new Response('room full', { status: 403 });
    }

    const url = new URL(req.url);
    // First person in sets the session lengths.
    if (this.hostId === null) {
      this.focusMin = clampInt(url.searchParams.get('focus'), 50, 1, 180);
      this.regroupMin = clampInt(url.searchParams.get('regroup'), 5, 0, 60);
    }
    const name = (url.searchParams.get('name') || 'Guest').slice(0, 32);
    const id = crypto.randomUUID();

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    if (this.hostId === null) this.hostId = id;
    this.sessions.set(id, { ws: server, name });
    server.addEventListener('message', (e) => this.onMessage(id, e));
    server.addEventListener('close', () => this.onClose(id));
    server.addEventListener('error', () => this.onClose(id));

    const peers = [...this.sessions]
      .filter(([pid]) => pid !== id)
      .map(([pid, s]) => ({ id: pid, name: s.name }));

    this.send(id, {
      type: 'welcome',
      selfId: id,
      hostId: this.hostId,
      peers,
      phase: this.phase,
      endsAt: this.endsAt,
      serverNow: Date.now(),
      focusMin: this.focusMin,
      regroupMin: this.regroupMin,
      ready: [...this.ready],
    });
    this.broadcastExcept(id, { type: 'peer-join', id, name });

    return new Response(null, { status: 101, webSocket: client });
  }

  onMessage(id, e) {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }

    switch (m.type) {
      case 'signal': // relay a WebRTC offer/answer/candidate to one peer
        this.send(m.to, { type: 'signal', from: id, data: m.data });
        break;
      case 'goal':
        this.broadcast({ type: 'goal', id, text: String(m.text || '').slice(0, 200) });
        break;
      case 'ready':
        this.ready.add(id);
        this.broadcast({ type: 'ready-state', ready: [...this.ready] });
        if (this.phase === 'greet' && this.ready.size === this.sessions.size) {
          this.startFocus();
        }
        break;
      case 'unready':
        this.ready.delete(id);
        this.broadcast({ type: 'ready-state', ready: [...this.ready] });
        break;
      case 'start': // host skips the wait-for-everyone
        if (id === this.hostId && this.phase === 'greet') this.startFocus();
        break;
      case 'kick':
        if (id === this.hostId) {
          const t = this.sessions.get(m.id);
          if (t) { try { t.ws.close(4000, 'kicked'); } catch {} this.onClose(m.id); }
        }
        break;
      case 'restart':
        if (id === this.hostId) this.toGreet();
        break;
    }
  }

  async startFocus() {
    this.phase = 'focus';
    this.endsAt = Date.now() + this.focusMin * 60000;
    this.ready.clear();
    await this.state.storage.setAlarm(this.endsAt);
    this.broadcastPhase();
  }

  async alarm() {
    if (this.phase === 'focus') {
      this.phase = 'regroup';
      this.endsAt = Date.now() + this.regroupMin * 60000;
      await this.state.storage.setAlarm(this.endsAt);
      this.broadcastPhase();
    } else if (this.phase === 'regroup') {
      this.toGreet();
    }
  }

  toGreet() {
    this.phase = 'greet';
    this.endsAt = null;
    this.ready.clear();
    this.broadcastPhase();
    this.broadcast({ type: 'ready-state', ready: [] });
  }

  broadcastPhase() {
    this.broadcast({ type: 'phase', phase: this.phase, endsAt: this.endsAt, serverNow: Date.now() });
  }

  onClose(id) {
    if (!this.sessions.has(id)) return;
    this.sessions.delete(id);
    this.ready.delete(id);
    this.broadcast({ type: 'peer-leave', id });
    this.broadcast({ type: 'ready-state', ready: [...this.ready] });
    if (this.sessions.size === 0) {
      this.phase = 'greet';
      this.endsAt = null;
      this.hostId = null;
      this.state.storage.deleteAlarm();
    } else if (id === this.hostId) {
      this.hostId = [...this.sessions.keys()][0];
      this.broadcast({ type: 'host', id: this.hostId });
    }
  }

  send(id, obj) {
    const s = this.sessions.get(id);
    if (s) { try { s.ws.send(JSON.stringify(obj)); } catch {} }
  }
  broadcast(obj) {
    const d = JSON.stringify(obj);
    for (const s of this.sessions.values()) { try { s.ws.send(d); } catch {} }
  }
  broadcastExcept(id, obj) {
    const d = JSON.stringify(obj);
    for (const [pid, s] of this.sessions) {
      if (pid !== id) { try { s.ws.send(d); } catch {} }
    }
  }
}
