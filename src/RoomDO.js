// One Durable Object per room. Holds live WebSocket sessions, runs the session
// timer, relays WebRTC signaling + chat between the (max 4) peers.
//
// Per-person state (goals, camera prefs, ready/shared) is ephemeral and dies
// when people leave. The SESSION itself (phase + timer + config) is persisted to
// DO storage and PAUSED while the room is empty, so a rejoin — even both people
// returning much later, or after an eviction/deploy — resumes from exactly where
// it stopped instead of restarting at greet.
//
// Public rooms also report their occupants to the LobbyDO so they show up on the
// landing-page directory. Private (invite-link) rooms never report.

const MAX = 4;
const HEARTBEAT_MS = 12000;
const SESSION_KEY = 'sess'; // persisted session blob (survives eviction/deploy)
// A room left empty this long is genuinely abandoned — wipe its stored session
// so storage doesn't accumulate ghost rooms forever.
const ABANDON_MS = 6 * 60 * 60 * 1000; // 6h

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
    this.camPrefs = new Map(); // id -> 'on' | 'off' — stated camera preference (signal only)
    this.ready = new Set();
    this.shared = new Set(); // ids who confirmed they shared their goal (greet turn-taking)
    this.locked = false; // host can close the room to newcomers (mid-session join off)
    this.phase = 'greet'; // greet | focus | regroup
    this.endsAt = null; // absolute ms while the timer runs; null when paused/greet
    this.paused = false; // true while the room is empty — timer frozen
    this.remainingMs = null; // ms left on the timer when it was paused
    this.abandonAt = null; // wipe the stored session after this if still empty
    this.configured = false; // has the session config (lengths/visibility) been set?
    this.focusMin = 50;
    this.regroupMin = 5;
    this.hostId = null;
    this.roomId = null; // path segment, for lobby registration
    this.isPublic = false;

    // Restore the persisted session before any request or alarm is handled, so an
    // evicted/redeployed room resumes instead of starting fresh at greet.
    this._restore = state.blockConcurrencyWhile(async () => {
      const s = await state.storage.get(SESSION_KEY);
      if (!s) return;
      this.phase = s.phase; this.endsAt = s.endsAt ?? null;
      this.paused = !!s.paused; this.remainingMs = s.remainingMs ?? null;
      this.abandonAt = s.abandonAt ?? null;
      this.focusMin = s.focusMin; this.regroupMin = s.regroupMin;
      this.isPublic = s.isPublic; this.locked = !!s.locked;
      this.configured = true;
    });
  }

  persist() {
    return this.state.storage.put(SESSION_KEY, {
      phase: this.phase, endsAt: this.endsAt, paused: this.paused, remainingMs: this.remainingMs,
      abandonAt: this.abandonAt, focusMin: this.focusMin, regroupMin: this.regroupMin,
      isPublic: this.isPublic, locked: this.locked,
    });
  }

  // Everyone left: freeze the timer where it is and mark the room abandonable.
  pauseSession() {
    if (this.endsAt) { this.remainingMs = Math.max(0, this.endsAt - Date.now()); this.endsAt = null; }
    this.paused = true;
    this.hostId = null;
    this.abandonAt = Date.now() + ABANDON_MS;
    this.persist();
    this.state.storage.setAlarm(this.abandonAt);
  }

  // Someone came back: un-freeze the timer from exactly where it stopped.
  resumeSession() {
    if (!this.paused) return;
    this.endsAt = this.remainingMs != null ? Date.now() + this.remainingMs : null;
    this.paused = false; this.remainingMs = null; this.abandonAt = null;
    this.persist();
  }

  // A room sat empty past the abandon window — clear it for good.
  wipe() {
    this.phase = 'greet'; this.endsAt = null; this.paused = false; this.remainingMs = null;
    this.abandonAt = null; this.hostId = null; this.locked = false; this.configured = false;
    this.state.storage.delete(SESSION_KEY);
    this.state.storage.deleteAlarm();
    this.syncLobby();
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
    // Only on a brand-new room — never on a resume, which would clobber the
    // config with the rejoiner's URL defaults.
    if (!this.configured) {
      this.focusMin = clampInt(url.searchParams.get('focus'), 50, 1, 180);
      this.regroupMin = clampInt(url.searchParams.get('regroup'), 5, 0, 60);
      this.isPublic = url.searchParams.get('public') === '1';
      this.configured = true;
      this.persist();
    }
    const name = (url.searchParams.get('name') || 'Guest').slice(0, 32);
    const id = crypto.randomUUID();

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    if (this.hostId === null) this.hostId = id;
    this.resumeSession(); // someone's back — un-freeze the timer where it stopped
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
      camPrefs: Object.fromEntries(this.camPrefs),
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
      case 'campref': { // stated camera preference (signal only — never touches tracks)
        const pref = m.pref === 'on' || m.pref === 'off' ? m.pref : null;
        if (pref) this.camPrefs.set(id, pref); else this.camPrefs.delete(id);
        this.broadcast({ type: 'campref', id, pref });
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
          this.persist();
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
    this.persist();
    this.broadcastPhase();
    this.syncLobby();
    this.scheduleTick();
  }

  async alarm() {
    // The alarm ticks every HEARTBEAT_MS while occupied (to keep the room fresh in
    // the directory and fire phase transitions), and once far in the future while
    // empty (to wipe a genuinely abandoned room).
    const now = Date.now();
    if (this.sessions.size === 0) {
      // Empty. If the DO was evicted while occupied (e.g. a deploy) and this alarm
      // fired before anyone reconnected, the session isn't paused yet — pause it
      // now so it resumes intact. Only wipe once the abandon window has passed.
      if (!this.paused) { this.pauseSession(); return; }
      if (this.abandonAt && now >= this.abandonAt - 500) this.wipe();
      else this.state.storage.setAlarm(this.abandonAt || now + ABANDON_MS);
      return;
    }
    if (this.endsAt && now >= this.endsAt - 500) {
      if (this.phase === 'focus') {
        this.phase = 'regroup';
        this.endsAt = Date.now() + this.regroupMin * 60000;
        this.persist();
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
    // While empty the room is paused; onClose/pauseSession owns the abandon alarm.
    if (this.sessions.size === 0) return;
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
    this.persist();
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
      ? [...this.sessions].map(([pid, s]) => ({ name: s.name, goal: this.goals.get(pid) || '', pref: this.camPrefs.get(pid) || null }))
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
    this.camPrefs.delete(id);
    this.broadcast({ type: 'peer-leave', id });
    this.broadcast({ type: 'ready-state', ready: [...this.ready] });
    this.broadcast({ type: 'shared-state', shared: [...this.shared] });
    this.broadcast({ type: 'order', order: [...this.sessions.keys()] });
    if (this.sessions.size === 0) {
      // Last person left: freeze the session where it is and persist it. A rejoin
      // (a refresh, or both people returning much later, or after an eviction /
      // deploy) resumes from exactly here instead of restarting at greet.
      this.pauseSession();
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
