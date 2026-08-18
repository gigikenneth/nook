// One Durable Object per room. Holds live WebSocket sessions, runs the session
// timer, relays WebRTC signaling + chat between the (max 4) peers.
//
// HIBERNATION: sockets are accepted with state.acceptWebSocket and handled via
// the webSocketMessage/Close/Error methods, so an idle room is evicted from
// memory (billing ~0 duration on the DO free tier) while its sockets stay open
// at the edge. Because the instance is thrown away between messages, per-person
// state is NOT kept in instance fields — it lives in each socket's attachment
// (serializeAttachment) and the room's roster/host/ready/tracks are DERIVED from
// state.getWebSockets() on demand. See docs/superpowers/specs/
// 2026-08-11-do-hibernation-design.md.
//
// The SESSION itself (phase + timer + config + roomId) is persisted to DO
// storage and PAUSED while the room is empty, so a rejoin — even both people
// returning much later, or after an eviction/deploy — resumes from exactly where
// it stopped instead of restarting at greet.
//
// Public rooms also report their occupants to the LobbyDO so they show up on the
// landing-page directory. Private (invite-link) rooms never report.

const MAX = 4;
const HEARTBEAT_MS = 60000; // slow tick just to keep the directory fresh; phase ends fire on their own exact alarm. Longer = fewer wakes = cheaper under hibernation.
const SESSION_KEY = 'sess'; // persisted session blob (survives eviction/deploy)
const REACTIONS = new Set(['👍', '❤️', '🎉', '😂', '👀']); // allowed chat reactions (#53)
// A tab that returns within this window (matched by its stable client id) is a
// reconnect, not a new arrival — so we restore their goal/camera pref instead of
// rebuilding from scratch (#30). Kept in memory; a rare eviction inside the
// window just downgrades a return to a plain join (acceptable — no chime since #32).
const RECONNECT_TTL_MS = 60000;
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
    // Reconnect memory: rkey -> { at, goal, pref } for tabs whose socket already
    // closed. In-memory (see RECONNECT_TTL_MS) — the only per-person state without
    // a live socket to hang off of.
    this.recentLeavers = new Map();
    this.locked = false; // host can close the room to newcomers (mid-session join off)
    this.phase = 'greet'; // greet | focus | regroup
    this.endsAt = null; // absolute ms while the timer runs; null when paused/greet
    this.checkinSeed = null; // 0..1, picked per focus so everyone gets the same mid-session check-in
    this.paused = false; // true while the room is empty — timer frozen
    this.remainingMs = null; // ms left on the timer when it was paused
    this.abandonAt = null; // wipe the stored session after this if still empty
    this.configured = false; // has the session config (lengths/visibility) been set?
    this.focusMin = 50;
    this.regroupMin = 5;
    this.roomId = null; // path segment, for lobby registration (persisted so alarms can sync after eviction)
    this.isPublic = false;

    // Restore the persisted session before any request/alarm/message is handled,
    // so an evicted/redeployed room resumes instead of starting fresh at greet.
    this._restore = state.blockConcurrencyWhile(async () => {
      const s = await state.storage.get(SESSION_KEY);
      if (!s) return;
      this.phase = s.phase; this.endsAt = s.endsAt ?? null;
      this.checkinSeed = s.checkinSeed ?? null;
      this.paused = !!s.paused; this.remainingMs = s.remainingMs ?? null;
      this.abandonAt = s.abandonAt ?? null;
      this.focusMin = s.focusMin; this.regroupMin = s.regroupMin;
      this.isPublic = s.isPublic; this.locked = !!s.locked;
      this.roomId = s.roomId ?? null;
      this.configured = true;
    });
  }

  persist() {
    return this.state.storage.put(SESSION_KEY, {
      phase: this.phase, endsAt: this.endsAt, checkinSeed: this.checkinSeed, paused: this.paused, remainingMs: this.remainingMs,
      abandonAt: this.abandonAt, focusMin: this.focusMin, regroupMin: this.regroupMin,
      isPublic: this.isPublic, locked: this.locked, roomId: this.roomId,
    });
  }

  // Everyone left: freeze the timer where it is and mark the room abandonable.
  pauseSession() {
    if (this.endsAt) { this.remainingMs = Math.max(0, this.endsAt - Date.now()); this.endsAt = null; }
    this.paused = true;
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
    this.abandonAt = null; this.locked = false; this.configured = false;
    this.state.storage.delete(SESSION_KEY);
    this.state.storage.deleteAlarm();
    this.syncLobby();
  }

  // --- Derive-from-sockets helpers ------------------------------------------
  // The room roster IS the set of accepted hibernatable sockets; per-person data
  // rides in each socket's attachment { id, name, rkey, joinedAt, ready, shared,
  // goal, list, cam:{session,audio,video}, camPref }.

  sockets() { return this.state.getWebSockets(); }

  // Live members, oldest first (join order). Skips any socket missing its
  // attachment defensively.
  roster() {
    return this.sockets()
      .map((ws) => ({ ws, a: ws.deserializeAttachment() }))
      .filter((x) => x.a)
      .sort((x, y) => x.a.joinedAt - y.a.joinedAt);
  }

  count() { return this.sockets().length; }

  // Host = the oldest live member. Makes host-promotion on leave automatic.
  hostId() { const r = this.roster(); return r.length ? r[0].a.id : null; }

  socketOf(id) { return this.sockets().find((ws) => ws.deserializeAttachment()?.id === id); }

  // Read-modify-write a socket's attachment.
  patch(ws, fn) { const a = ws.deserializeAttachment() || {}; fn(a); ws.serializeAttachment(a); return a; }

  async fetch(req) {
    if (req.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    const count = this.count();
    if (count >= MAX) {
      // Signal "full" over the socket (code 4001) — a 403 on the upgrade just
      // surfaces to the browser as a generic 1006, indistinguishable from the
      // server being down. Accept, then close with a code the client can read.
      return this.rejectWs(4001, 'full');
    }
    if (this.locked && count > 0) {
      // Host closed the room to newcomers. (Never lock out the very first joiner,
      // who creates the room.) Signal with 4002 so the client can explain it.
      return this.rejectWs(4002, 'locked');
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
    }
    this.persist(); // capture roomId (and any fresh config) so alarms can sync the lobby after an eviction

    const name = (url.searchParams.get('name') || 'Guest').slice(0, 32);
    const id = crypto.randomUUID();
    // A stable per-tab client id lets us recognise a returning connection.
    // Reconnect key: prefer the persistent `did` (survives a full tab close),
    // fall back to the per-tab `cid` (covers a refresh when localStorage is
    // blocked). Either way it's an opaque, anonymous id — nothing relational.
    const rkey = (url.searchParams.get('did') || url.searchParams.get('cid')) || null;

    // Restore a returning tab's goal/pref, evicting any live zombie socket that
    // shares this rkey (#57) so the person never appears twice.
    const { reconnecting, goal: restoredGoal, pref: restoredPref } = this.supersedeStale(rkey);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    server.serializeAttachment({
      id, name, rkey, joinedAt: Date.now(),
      ready: false, shared: false, goal: restoredGoal, list: null,
      cam: { session: null, audio: null, video: null }, camPref: restoredPref,
    });

    this.resumeSession(); // someone's back — un-freeze the timer where it stopped

    const peers = this.roster()
      .filter((x) => x.a.id !== id)
      .map((x) => ({ id: x.a.id, name: x.a.name }));

    this.send(id, {
      type: 'welcome',
      selfId: id,
      hostId: this.hostId(),
      peers,
      phase: this.phase,
      endsAt: this.endsAt,
      checkinSeed: this.checkinSeed,
      serverNow: Date.now(),
      focusMin: this.focusMin,
      regroupMin: this.regroupMin,
      ready: this.readyIds(),
      shared: this.sharedIds(),
      order: this.order(),
      goals: this.goalsMap(),
      lists: this.listsMap(),
      camPrefs: this.camPrefsMap(),
      tracks: this.tracksMap(), // Realtime roster: who publishes which tracks
      locked: this.locked,
    });
    this.broadcast({ type: 'order', order: this.order() });
    this.broadcastExcept(id, { type: 'peer-join', id, name, reconnect: reconnecting });
    // On a reconnect, replay the restored goal/pref so peers see them again.
    if (reconnecting) {
      if (restoredGoal) this.broadcast({ type: 'goal', id, text: restoredGoal });
      if (restoredPref) this.broadcast({ type: 'campref', id, pref: restoredPref });
    }

    this.syncLobby();
    this.scheduleTick();

    return new Response(null, { status: 101, webSocket: client });
  }

  // Accept-then-close for a rejected upgrade (full/locked), so the client can
  // read the reason code. Non-hibernatable is fine — it closes immediately.
  rejectWs(code, reason) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    server.close(code, reason);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, data) {
    let m;
    try { m = JSON.parse(data); } catch { return; }
    const a = ws.deserializeAttachment();
    if (!a) return;
    const id = a.id;

    switch (m.type) {
      case 'publish': { // client reports its Cloudflare Realtime session + track ids
        // so roommates can pull them. video is absent when the camera is off.
        const cam = {
          session: typeof m.session === 'string' ? m.session : null,
          audio: typeof m.audio === 'string' ? m.audio : null,
          video: typeof m.video === 'string' ? m.video : null,
        };
        this.patch(ws, (x) => { x.cam = cam; });
        this.broadcast({ type: 'tracks', id, ...cam });
        break;
      }
      case 'goal': {
        const text = String(m.text || '').slice(0, 200);
        this.patch(ws, (x) => { x.goal = text; });
        this.broadcast({ type: 'goal', id, text });
        this.syncLobby();
        break;
      }
      case 'list': { // opt-in shared to-do list (#47): relayed to the room, held in
        // the socket attachment only, never persisted — same as goals and chat.
        if (Array.isArray(m.tasks)) {
          const tasks = m.tasks.slice(0, 20).map((t) => ({ text: String(t && t.text || '').slice(0, 200), done: !!(t && t.done) }));
          this.patch(ws, (x) => { x.list = tasks; });
          this.broadcastExcept(id, { type: 'peer-list', id, tasks });
        } else { // null/absent = stopped sharing
          this.patch(ws, (x) => { x.list = null; });
          this.broadcastExcept(id, { type: 'peer-list', id, tasks: null });
        }
        break;
      }
      case 'campref': { // stated camera preference (signal only — never touches tracks)
        const pref = m.pref === 'on' || m.pref === 'off' ? m.pref : null;
        this.patch(ws, (x) => { x.camPref = pref; });
        this.broadcast({ type: 'campref', id, pref });
        this.syncLobby();
        break;
      }
      case 'chat': { // relayed live, never stored — history dies with the room
        const text = String(m.text || '').slice(0, 500).trim();
        // `mid` gives each message a stable id so reactions can attach to it.
        if (text) this.broadcast({ type: 'chat', mid: crypto.randomUUID(), id, name: a.name || 'Guest', text, t: Date.now() });
        break;
      }
      case 'react': { // emoji reaction on a chat message (#53) — relayed, not stored
        if (m.mid && REACTIONS.has(m.emoji)) {
          this.broadcast({ type: 'react', mid: String(m.mid), emoji: m.emoji, id, on: !!m.on });
        }
        break;
      }
      case 'ready':
        this.patch(ws, (x) => { x.ready = true; });
        this.broadcast({ type: 'ready-state', ready: this.readyIds() });
        if (this.phase === 'greet' && this.readyIds().length === this.count()) {
          this.startFocus();
        }
        break;
      case 'unready':
        this.patch(ws, (x) => { x.ready = false; });
        this.broadcast({ type: 'ready-state', ready: this.readyIds() });
        break;
      case 'shared': // "I've shared my goal" — advances the greet turn frame
        this.patch(ws, (x) => { x.shared = true; });
        this.broadcast({ type: 'shared-state', shared: this.sharedIds() });
        break;
      case 'start': // anyone can skip the wait-for-everyone (resilient if the host drops)
        if (this.phase === 'greet') this.startFocus();
        break;
      case 'lock': // host opens/closes the room to newcomers
        if (id === this.hostId()) {
          this.locked = !!m.locked;
          this.persist();
          this.broadcast({ type: 'locked-state', locked: this.locked });
          this.syncLobby();
        }
        break;
      case 'kick':
        if (id === this.hostId()) {
          const t = this.socketOf(m.id);
          if (t) { try { t.close(4000, 'kicked'); } catch {} this.handleLeave(t); }
        }
        break;
      case 'restart': {
        // Anyone can start the next round (#55), like 'start' — so it doesn't
        // stall if the host dropped. Only from regroup, so no one can reset the
        // room out from under a live focus block. The HOST may also set a new
        // length for the next round (clamped); everyone else just restarts at
        // the current length.
        if (this.phase !== 'regroup') break;
        if (id === this.hostId()) {
          if (m.focusMin != null) this.focusMin = clampInt(m.focusMin, this.focusMin, 1, 180);
          if (m.regroupMin != null) this.regroupMin = clampInt(m.regroupMin, this.regroupMin, 0, 60);
        }
        this.toGreet(); // persists the (possibly new) length + broadcasts it via broadcastPhase
        break;
      }
    }
  }

  // A returning tab (matched by rkey): report what goal/pref to restore, and
  // evict any still-open zombie socket sharing that key — a reconnect whose old
  // socket hasn't fired its close event yet (#57). The zombie's leave runs
  // synchronously here (peers get a peer-leave now, not whenever the async close
  // lands); handleLeave is idempotent, so the later close event is a no-op.
  supersedeStale(rkey) {
    if (!rkey) return { reconnecting: false, goal: '', pref: null };
    const zombie = this.sockets().find((ws) => ws.deserializeAttachment()?.rkey === rkey);
    if (zombie) {
      const za = zombie.deserializeAttachment();
      const goal = za.goal || '', pref = za.camPref || null;
      try { zombie.close(1000, 'superseded'); } catch { /* already gone */ }
      this.handleLeave(zombie);
      return { reconnecting: true, goal, pref };
    }
    const prev = this.recentLeavers.get(rkey);
    if (prev && Date.now() - prev.at < RECONNECT_TTL_MS) {
      this.recentLeavers.delete(rkey);
      return { reconnecting: true, goal: prev.goal || '', pref: prev.pref || null };
    }
    return { reconnecting: false, goal: '', pref: null };
  }

  webSocketClose(ws) { this.handleLeave(ws); }
  webSocketError(ws) { this.handleLeave(ws); }

  // A member's socket is gone (closed, errored, kicked, or superseded). Broadcast
  // the departure and, if the room is now empty, freeze the session. Idempotent:
  // a socket already dropped from the roster is ignored, so an explicit close()
  // followed by the runtime's close event only leaves once.
  handleLeave(ws) {
    const a = ws.deserializeAttachment();
    if (!a) return;
    ws.serializeAttachment(null); // mark handled — a second call sees no attachment
    const id = a.id;
    // Remember this tab briefly so a quick return restores its goal + camera pref.
    if (a.rkey) {
      this.recentLeavers.set(a.rkey, { at: Date.now(), goal: a.goal || '', pref: a.camPref || null });
      for (const [k, v] of this.recentLeavers) if (Date.now() - v.at > RECONNECT_TTL_MS) this.recentLeavers.delete(k);
    }
    // Remaining members = everyone still holding a socket, minus this one. (During
    // a close the runtime may or may not still list this socket; filter by id to
    // be safe — we just nulled our own attachment so it's excluded either way.)
    const remaining = this.roster().filter((x) => x.a.id !== id);
    this.broadcast({ type: 'peer-leave', id });
    this.broadcast({ type: 'ready-state', ready: this.readyIds() });
    this.broadcast({ type: 'shared-state', shared: this.sharedIds() });
    this.broadcast({ type: 'order', order: remaining.map((x) => x.a.id) });
    if (remaining.length === 0) {
      // Last person left: freeze the session where it is and persist it. A rejoin
      // (a refresh, or both people returning much later, or after an eviction /
      // deploy) resumes from exactly here instead of restarting at greet.
      this.pauseSession();
    } else if (a.joinedAt <= remaining[0].a.joinedAt) {
      // The host (oldest) left — the new oldest becomes host.
      this.broadcast({ type: 'host', id: remaining[0].a.id });
    }
    this.syncLobby();
  }

  async startFocus() {
    this.phase = 'focus';
    this.endsAt = Date.now() + this.focusMin * 60000;
    this.checkinSeed = Math.random(); // one shared question for this focus block's mid-session check-in
    for (const x of this.roster()) this.patch(x.ws, (r) => { r.ready = false; }); // clear ready
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
    if (this.count() === 0) {
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
    // While empty the room is paused; handleLeave/pauseSession owns the abandon alarm.
    if (this.count() === 0) return;
    const now = Date.now();
    let next = now + HEARTBEAT_MS;
    if (this.endsAt && this.endsAt < next) next = this.endsAt;
    this.state.storage.setAlarm(next);
  }

  toGreet() {
    this.phase = 'greet';
    this.endsAt = null;
    for (const x of this.roster()) this.patch(x.ws, (r) => { r.ready = false; r.shared = false; });
    this.persist();
    this.broadcastPhase();
    this.broadcast({ type: 'ready-state', ready: [] });
    this.broadcast({ type: 'shared-state', shared: [] });
    this.syncLobby();
    this.scheduleTick();
  }

  broadcastPhase() {
    this.broadcast({ type: 'phase', phase: this.phase, endsAt: this.endsAt, checkinSeed: this.checkinSeed,
      focusMin: this.focusMin, regroupMin: this.regroupMin, serverNow: Date.now() });
  }

  // Tell the lobby who's here (or that we're gone). Private rooms are reported
  // too, but anonymously — the directory shows "a private session" + time-left,
  // never names or goals.
  syncLobby() {
    if (!this.env || !this.roomId) return;
    const lobby = this.env.LOBBY.get(this.env.LOBBY.idFromName('global'));
    const occupants = this.isPublic
      ? this.roster().map((x) => ({ name: x.a.name, goal: x.a.goal || '', pref: x.a.camPref || null }))
      : [];
    lobby.fetch('https://lobby/update', {
      method: 'POST',
      body: JSON.stringify({
        roomId: this.roomId,
        count: this.count(),
        phase: this.phase,
        endsAt: this.endsAt,
        focusMin: this.focusMin, // session's focus length, so the directory can show it before you join
        locked: this.locked,
        isPublic: this.isPublic,
        occupants,
      }),
    }).catch(() => {});
  }

  // --- Derived roster projections (for welcome / broadcasts) ----------------
  order() { return this.roster().map((x) => x.a.id); }
  readyIds() { return this.roster().filter((x) => x.a.ready).map((x) => x.a.id); }
  sharedIds() { return this.roster().filter((x) => x.a.shared).map((x) => x.a.id); }
  goalsMap() { const o = {}; for (const x of this.roster()) if (x.a.goal) o[x.a.id] = x.a.goal; return o; }
  listsMap() { const o = {}; for (const x of this.roster()) if (x.a.list) o[x.a.id] = x.a.list; return o; }
  camPrefsMap() { const o = {}; for (const x of this.roster()) if (x.a.camPref) o[x.a.id] = x.a.camPref; return o; }
  tracksMap() {
    const o = {};
    for (const x of this.roster()) {
      const c = x.a.cam;
      if (c && (c.audio || c.video)) o[x.a.id] = { session: c.session, audio: c.audio, video: c.video };
    }
    return o;
  }

  // --- Send helpers (iterate the live sockets) ------------------------------
  send(id, obj) {
    const ws = this.socketOf(id);
    if (ws) { try { ws.send(JSON.stringify(obj)); } catch {} }
  }
  broadcast(obj) {
    const d = JSON.stringify(obj);
    for (const ws of this.sockets()) { try { ws.send(d); } catch {} }
  }
  broadcastExcept(id, obj) {
    const d = JSON.stringify(obj);
    for (const ws of this.sockets()) {
      if (ws.deserializeAttachment()?.id !== id) { try { ws.send(d); } catch {} }
    }
  }
}
