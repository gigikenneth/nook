// One Durable Object per room. Holds live WebSocket sessions, runs the session
// timer, relays WebRTC signaling + chat between the (max 4) peers. Nothing is
// persisted: state lives in memory and dies when the room empties.
//
// Public rooms also report their occupants to the LobbyDO so they show up on the
// landing-page directory. Private (invite-link) rooms never report.

const MAX = 4;
const HEARTBEAT_MS = 12000;
// Grace window after the last person leaves before the running timer is torn
// down. Lets a sole occupant who refreshes / locks their phone / blips offline
// rejoin the SAME session instead of a fresh greet (issue #5).
const GRACE_MS = 90000;

function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return def;
  return Math.max(min, Math.min(max, n));
}

export class RoomDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map(); // id -> { ws, name }
    this.goals = new Map(); // id -> goal text
    this.ready = new Set();
    this.shared = new Set(); // ids who confirmed they shared their goal (greet turn-taking)
    this.locked = false; // host can close the room to newcomers (mid-session join off)
    this.phase = 'greet'; // greet | focus | regroup
    this.endsAt = null;
    this.emptyAt = null; // set when the room drains; grace window before teardown
    this.focusMin = 50;
    this.regroupMin = 5;
    this.hostId = null;
    this.roomId = null; // path segment, for lobby registration
    this.isPublic = false;
  }

  async fetch(req) {
    if (req.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    if (this.sessions.size >= MAX) {
      // Signal "full" over the socket (code 4001) — a 403 on the upgrade just
      // surfaces to the browser as a generic 1006, indistinguishable from the
      // server being down. Accept, then close with a code the client can read.
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      server.close(4001, 'full');
      return new Response(null, { status: 101, webSocket: client });
    }
    if (this.locked && this.sessions.size > 0) {
      // Host closed the room to newcomers. (Never lock out the very first joiner,
      // who creates the room.) Signal with 4002 so the client can explain it.
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      server.close(4002, 'locked');
      return new Response(null, { status: 101, webSocket: client });
    }

    const url = new URL(req.url);
    const pathId = url.pathname.match(/^\/room\/([^/]+)\/ws$/);
    if (pathId) this.roomId = decodeURIComponent(pathId[1]);

    // First person in sets the session lengths and whether the room is listed.
    // Only on a brand-new room, never on a resume within the grace window (that
    // would clobber the config with the rejoiner's URL defaults).
    if (this.hostId === null && this.endsAt === null && this.emptyAt === null) {
      this.focusMin = clampInt(url.searchParams.get('focus'), 50, 1, 180);
      this.regroupMin = clampInt(url.searchParams.get('regroup'), 5, 0, 60);
      this.isPublic = url.searchParams.get('public') === '1';
    }
    const name = (url.searchParams.get('name') || 'Guest').slice(0, 32);
    const id = crypto.randomUUID();

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    if (this.hostId === null) this.hostId = id;
    this.emptyAt = null; // someone's back — cancel any pending grace teardown
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
      shared: [...this.shared],
      order: [...this.sessions.keys()],
      goals: Object.fromEntries(this.goals),
      locked: this.locked,
    });
    this.broadcast({ type: 'order', order: [...this.sessions.keys()] });
    this.broadcastExcept(id, { type: 'peer-join', id, name });

    this.syncLobby();
    this.scheduleTick();

    return new Response(null, { status: 101, webSocket: client });
  }

  onMessage(id, e) {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }

    switch (m.type) {
      case 'signal': // relay a WebRTC offer/answer/candidate to one peer
        this.send(m.to, { type: 'signal', from: id, data: m.data });
        break;
      case 'goal': {
        const text = String(m.text || '').slice(0, 200);
        this.goals.set(id, text);
        this.broadcast({ type: 'goal', id, text });
        this.syncLobby();
        break;
      }
      case 'chat': { // relayed live, never stored — history dies with the room
        const s = this.sessions.get(id);
        const text = String(m.text || '').slice(0, 500).trim();
        if (text) this.broadcast({ type: 'chat', id, name: s ? s.name : 'Guest', text, t: Date.now() });
        break;
      }
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
      case 'shared': // "I've shared my goal" — advances the greet turn frame
        this.shared.add(id);
        this.broadcast({ type: 'shared-state', shared: [...this.shared] });
        break;
      case 'start': // host skips the wait-for-everyone
        if (id === this.hostId && this.phase === 'greet') this.startFocus();
        break;
      case 'lock': // host opens/closes the room to newcomers
        if (id === this.hostId) {
          this.locked = !!m.locked;
          this.broadcast({ type: 'locked-state', locked: this.locked });
          this.syncLobby();
        }
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
    this.broadcastPhase();
    this.syncLobby();
    this.scheduleTick();
  }

  async alarm() {
    // The alarm ticks every HEARTBEAT_MS to keep the room fresh in the directory
    // (all phases, not just greet), and fires the phase transition when the timer
    // elapses. Without the tick, a focus room stops reporting and gets pruned
    // from the lobby after ~30s, so ongoing sessions would vanish.
    const now = Date.now();
    if (this.sessions.size === 0) {
      // Draining: the grace window has elapsed with nobody back — tear down now.
      // (If someone rejoined, emptyAt was cleared and this alarm is a no-op.)
      if (this.emptyAt && now >= this.emptyAt + GRACE_MS - 500) {
        this.phase = 'greet';
        this.endsAt = null;
        this.emptyAt = null;
        this.hostId = null;
        this.state.storage.deleteAlarm();
        this.syncLobby();
      }
      return;
    }
    if (this.endsAt && now >= this.endsAt - 500) {
      if (this.phase === 'focus') {
        this.phase = 'regroup';
        this.endsAt = Date.now() + this.regroupMin * 60000;
        this.broadcastPhase();
      } else if (this.phase === 'regroup') {
        this.toGreet();
      }
    }
    this.syncLobby();
    this.scheduleTick();
  }

  // Re-arm the alarm: the sooner of the next heartbeat and the phase-end, while
  // anyone is still here.
  scheduleTick() {
    if (this.sessions.size === 0) {
      // Draining: arm a single alarm at the end of the grace window so the
      // teardown in alarm() runs if nobody comes back.
      if (this.emptyAt) this.state.storage.setAlarm(this.emptyAt + GRACE_MS);
      return;
    }
    const now = Date.now();
    let next = now + HEARTBEAT_MS;
    if (this.endsAt && this.endsAt < next) next = this.endsAt;
    this.state.storage.setAlarm(next);
  }

  toGreet() {
    this.phase = 'greet';
    this.endsAt = null;
    this.ready.clear();
    this.shared.clear();
    this.broadcastPhase();
    this.broadcast({ type: 'ready-state', ready: [] });
    this.broadcast({ type: 'shared-state', shared: [] });
    this.syncLobby();
    this.scheduleTick();
  }

  broadcastPhase() {
    this.broadcast({ type: 'phase', phase: this.phase, endsAt: this.endsAt, serverNow: Date.now() });
  }

  // Tell the lobby who's here (or that we're gone). Private rooms are reported
  // too, but anonymously — the directory shows "a private session" + time-left,
  // never names or goals.
  syncLobby() {
    if (!this.env || !this.roomId) return;
    const lobby = this.env.LOBBY.get(this.env.LOBBY.idFromName('global'));
    const occupants = this.isPublic
      ? [...this.sessions].map(([pid, s]) => ({ name: s.name, goal: this.goals.get(pid) || '' }))
      : [];
    lobby.fetch('https://lobby/update', {
      method: 'POST',
      body: JSON.stringify({
        roomId: this.roomId,
        count: this.sessions.size,
        phase: this.phase,
        endsAt: this.endsAt,
        locked: this.locked,
        isPublic: this.isPublic,
        occupants,
      }),
    }).catch(() => {});
  }

  onClose(id) {
    if (!this.sessions.has(id)) return;
    this.sessions.delete(id);
    this.ready.delete(id);
    this.shared.delete(id);
    this.goals.delete(id);
    this.broadcast({ type: 'peer-leave', id });
    this.broadcast({ type: 'ready-state', ready: [...this.ready] });
    this.broadcast({ type: 'shared-state', shared: [...this.shared] });
    this.broadcast({ type: 'order', order: [...this.sessions.keys()] });
    if (this.sessions.size === 0) {
      // Don't nuke a running timer on the last leave — a sole occupant who
      // refreshed / locked their phone / blipped offline should resume the same
      // session. Keep phase/endsAt; start the grace window; hand host to whoever
      // rejoins. Real teardown happens in alarm() if the window lapses empty.
      // ponytail: phase/endsAt live in DO memory only. A DO eviction during the
      // 90s grace loses them and the timer restarts (rare). Persist them to
      // this.state.storage if that edge ever proves flaky.
      this.emptyAt = Date.now();
      this.hostId = null;
      this.scheduleTick();
    } else if (id === this.hostId) {
      this.hostId = [...this.sessions.keys()][0];
      this.broadcast({ type: 'host', id: this.hostId });
    }
    this.syncLobby();
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
