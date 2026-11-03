// Self-check for RoomDO behavior under the WebSocket Hibernation model. Run:
// `node src/RoomDO.test.mjs`.
//
// Sockets are the source of truth: per-person state rides in each socket's
// attachment and the roster/host/ready/tracks are derived from
// state.getWebSockets(). The session (phase + timer + config) is persisted to DO
// storage and PAUSED while empty, so a rejoin resumes where it stopped. No
// framework: plain asserts against the DO logic.
import assert from 'node:assert';
import { RoomDO } from './RoomDO.js';

const HOUR = 3600_000;
const ABANDON_MS = 6 * HOUR; // mirror of the constant in RoomDO.js
const EMPTY_GRACE_MS = 90_000; // mirror: how long an empty room's clock keeps running (#92)

// Fake DO state: a shared storage Map (so we can simulate eviction by making a
// fresh RoomDO over the same store), one alarm slot, a synchronous
// blockConcurrencyWhile, and the hibernation socket registry.
function makeState(store = new Map()) {
  const s = { alarm: null, store, _sockets: [] };
  s.storage = {
    get: async (k) => store.get(k),
    put: async (k, v) => { store.set(k, v); },
    delete: async (k) => { store.delete(k); },
    setAlarm: (t) => { s.alarm = t; },
    deleteAlarm: () => { s.alarm = null; },
  };
  s.blockConcurrencyWhile = (fn) => fn();
  s.getWebSockets = () => s._sockets.filter((w) => w._open);
  s.acceptWebSocket = (ws) => { ws._open = true; s._sockets.push(ws); };
  return s;
}

// A stand-in for a hibernatable WebSocket: attachment get/set + spies.
function fakeWs() {
  const ws = { _att: null, _open: true, sent: [], readyState: 1 }; // 1 = OPEN, like the runtime
  ws.serializeAttachment = (v) => { ws._att = v; };
  ws.deserializeAttachment = () => ws._att;
  ws.send = (s) => ws.sent.push(JSON.parse(s));
  ws.close = () => { ws._open = false; ws.readyState = 3; }; // leaves state.getWebSockets(), like the runtime
  return ws;
}

let NOW = 1_000_000_000;
let SEQ = 0;
const realNow = Date.now;
Date.now = () => NOW;

// Register a member the way fetch() does: accept the socket, seed its attachment.
function join(r, state, over = {}) {
  const ws = fakeWs();
  state.acceptWebSocket(ws);
  ws.serializeAttachment({
    id: over.id || `p${SEQ}`, name: over.name || 'Guest', rkey: over.rkey || null,
    joinedAt: over.joinedAt ?? (NOW + SEQ), ready: false, shared: false,
    goal: over.goal || '', list: null, cam: over.cam || { session: null, audio: null, video: null },
    camPref: over.camPref || null,
  });
  SEQ += 1;
  return ws;
}
// Simulate the runtime delivering a close: the socket is already gone from the registry.
function disconnect(r, ws) { ws._open = false; r.webSocketClose(ws); }
const msg = (r, ws, m) => r.webSocketMessage(ws, JSON.stringify(m));

async function soloFocusRoom(state) {
  const r = new RoomDO(state, null); // env null => syncLobby is a no-op
  await r._restore;
  r.roomId = 'test';
  r.configured = true;
  r.phase = 'focus';
  r.endsAt = NOW + 50 * 60000; // 50 min left
  const ws = join(r, state, { id: 'solo', name: 'Gigi' });
  return { r, ws, id: 'solo' };
}

// 1) Last person leaves mid-focus: the clock keeps running through the grace
//    window (#92), then the alarm freezes the session (not reset) and persists it.
const store = new Map();
{
  const st = makeState(store);
  const { r, ws } = await soloFocusRoom(st);
  const endsAt = r.endsAt;
  disconnect(r, ws);
  assert.equal(r.phase, 'focus', 'phase kept on empty');
  assert.equal(r.paused, false, 'not frozen yet — a blip must not extend the session');
  assert.equal(r.endsAt, endsAt, 'end time untouched during the grace window');
  assert.equal(r.hostId(), null, 'no host while empty');
  assert.equal(st.alarm, NOW + EMPTY_GRACE_MS, 'grace alarm armed');

  NOW += EMPTY_GRACE_MS; // nobody came back
  await r.alarm();
  assert.equal(r.endsAt, null, 'timer frozen (no absolute end while paused)');
  assert.equal(r.paused, true, 'session paused');
  assert.equal(r.remainingMs, 50 * 60000 - EMPTY_GRACE_MS, 'frozen at what was actually left');
  assert.equal(st.alarm, NOW + ABANDON_MS, 'abandon alarm armed');
  const saved = store.get('sess');
  assert.equal(saved.phase, 'focus', 'persisted phase');
  assert.equal(saved.paused, true, 'persisted paused');
  assert.equal(saved.remainingMs, 50 * 60000 - EMPTY_GRACE_MS, 'persisted remaining');
  assert.equal(saved.roomId, 'test', 'roomId persisted so alarms can sync the lobby after eviction');
}

// 1b) A blip inside the grace window costs nothing: the tab drops and comes back,
//     and the session still ends at exactly the same moment (#92).
{
  const st = makeState();
  const { r, ws } = await soloFocusRoom(st);
  const endsAt = r.endsAt;
  disconnect(r, ws);
  NOW += 20_000; // wifi drop / tab reopened 20s later
  join(r, st, { id: 'solo-again', name: 'Gigi' });
  r.resumeSession(); // what the join path calls
  assert.equal(r.paused, false, 'never froze');
  assert.equal(r.endsAt, endsAt, 'end time unchanged by the reconnect');
  await r.alarm(); // occupied again: normal heartbeat, no pause
  assert.equal(r.paused, false, 'still running with someone here');
}

// 2) Eviction / deploy: a fresh DO over the same storage restores the paused
//    session; rejoining resumes it in focus, NOT greet.
{
  const st2 = makeState(store); // SAME store => simulates a rebuilt DO instance
  const r2 = new RoomDO(st2, null);
  await r2._restore;
  assert.equal(r2.phase, 'focus', 'restored phase after eviction');
  assert.equal(r2.paused, true, 'restored paused');
  assert.equal(r2.remainingMs, 50 * 60000 - EMPTY_GRACE_MS, 'restored remaining');
  assert.equal(r2.configured, true, 'config restored (no URL clobber)');
  assert.equal(r2.roomId, 'test', 'roomId restored');

  NOW += 30_000; // they come back 30s later
  r2.resumeSession();
  assert.equal(r2.paused, false, 'resumed');
  assert.equal(r2.phase, 'focus', 'still focus — did NOT restart at greet');
  assert.equal(r2.endsAt, NOW + 50 * 60000 - EMPTY_GRACE_MS, 're-anchored with the same time left');
}

// 3) Genuinely abandoned: paused past the abandon window, the alarm wipes it.
{
  const st = makeState();
  const { r, ws } = await soloFocusRoom(st);
  disconnect(r, ws);
  NOW += EMPTY_GRACE_MS;
  await r.alarm(); // grace expired: freeze
  NOW += ABANDON_MS + 1; // 6h+ pass with nobody back
  await r.alarm();
  assert.equal(r.phase, 'greet', 'wiped to greet');
  assert.equal(r.paused, false, 'no longer paused');
  assert.equal(st.store.get('sess'), undefined, 'stored session cleared');
  assert.equal(st.alarm, null, 'alarm cleared');
}

// 4) Evicted while occupied (e.g. a deploy) then the alarm fires before anyone
//    reconnects: it pauses rather than wiping.
{
  const st = makeState();
  const r = new RoomDO(st, null);
  await r._restore;
  r.roomId = 'test'; r.configured = true;
  r.phase = 'focus'; r.endsAt = NOW + 10 * 60000; // running, paused=false, no sockets
  await r.alarm();
  assert.equal(r.paused, true, 'empty+running alarm pauses the session');
  assert.equal(r.remainingMs, 10 * 60000, 'remaining captured');
  assert.ok(st.store.get('sess'), 'still persisted (not wiped)');
}

// 5) Camera preference (#9): valid sticks + broadcasts, garbage clears, cleared on leave.
{
  const st = makeState();
  const { r, ws } = await soloFocusRoom(st);
  r.isPublic = true;
  msg(r, ws, { type: 'campref', pref: 'off' });
  assert.equal(r.camPrefsMap().solo, 'off', 'valid pref stored');
  assert.ok(ws.sent.find((m) => m.type === 'campref' && m.pref === 'off'), 'pref broadcast');
  msg(r, ws, { type: 'campref', pref: 'bogus' });
  assert.equal(r.camPrefsMap().solo, undefined, 'garbage pref clears it');
  disconnect(r, ws);
  assert.equal(r.camPrefsMap().solo, undefined, 'pref cleared on leave');
}

// 6) Reconnect detection (#30): a leaver's client id, goal, and camera pref are
//    stashed briefly so a quick return is recognised and restored.
{
  const st = makeState();
  const r = new RoomDO(st, null);
  await r._restore;
  r.roomId = 'test'; r.configured = true; r.isPublic = true;
  // rkey = the durable reconnect key (did if present, else cid).
  const ws = join(r, st, { id: 'p1', name: 'Gigi', rkey: 'dev-abc' });
  msg(r, ws, { type: 'goal', text: 'ship the fix' });
  msg(r, ws, { type: 'campref', pref: 'off' });
  disconnect(r, ws);
  const stash = r.recentLeavers.get('dev-abc');
  assert.ok(stash, 'leaver remembered by reconnect key');
  assert.equal(stash.goal, 'ship the fix', 'goal kept for the return');
  assert.equal(stash.pref, 'off', 'camera pref kept for the return');
}

// 7) Shared to-do list (#47): opt-in, relayed + sanitised, held in the attachment,
//    cleared on unshare, and never sent back to the sharer.
{
  const st = makeState();
  const r = new RoomDO(st, null);
  await r._restore;
  r.roomId = 'test'; r.configured = true;
  const a = join(r, st, { id: 'A', name: 'A', rkey: 'a' });
  const b = join(r, st, { id: 'B', name: 'B', rkey: 'b' });
  msg(r, a, { type: 'list', tasks: [{ text: 'ship', done: true }, { text: 'x'.repeat(300), done: 'y' }, { bad: 1 }] });
  assert.equal(r.listsMap().A[0].done, true, 'done preserved');
  assert.equal(r.listsMap().A[1].text.length, 200, 'task text capped at 200');
  assert.equal(r.listsMap().A[2].text, '', 'missing text becomes empty string');
  const relay = b.sent.find((m) => m.type === 'peer-list');
  assert.ok(relay && relay.id === 'A' && relay.tasks.length === 3, 'B received the relayed list');
  assert.ok(!a.sent.find((m) => m.type === 'peer-list'), 'sharer does not get their own list back');
  msg(r, a, { type: 'list', tasks: null });
  assert.ok(!r.listsMap().A, 'unshare clears the stored list');
  assert.equal(b.sent.filter((m) => m.type === 'peer-list').pop().tasks, null, 'B told sharing stopped');
  msg(r, a, { type: 'list', tasks: Array.from({ length: 30 }, (_, i) => ({ text: 't' + i, done: false })) });
  assert.equal(r.listsMap().A.length, 20, 'list capped at 20 items');
  disconnect(r, a);
  assert.ok(!r.listsMap().A, 'leaving clears the shared list');
}

// 8) Restart is for everyone (#55): a non-host can start the next round from
//    regroup, but nobody can restart out from under a live focus block.
{
  const st = makeState();
  const r = new RoomDO(st, null);
  await r._restore;
  r.roomId = 'test'; r.configured = true;
  join(r, st, { id: 'host', name: 'Host', rkey: 'h', joinedAt: NOW });
  const guest = join(r, st, { id: 'guest', name: 'Guest', rkey: 'g', joinedAt: NOW + 1 });
  assert.equal(r.hostId(), 'host', 'oldest socket is host');
  r.phase = 'regroup';
  msg(r, guest, { type: 'restart' });
  assert.equal(r.phase, 'greet', 'a non-host can run the next session from regroup');
  r.phase = 'focus';
  msg(r, guest, { type: 'restart' });
  assert.equal(r.phase, 'focus', 'restart is ignored mid-focus');
}

// 9) Chat carries a stable mid, and emoji reactions relay (#53). Unknown emoji
//    is rejected so only the allowed set travels.
{
  const st = makeState();
  const r = new RoomDO(st, null);
  await r._restore;
  r.roomId = 'test'; r.configured = true;
  const a = join(r, st, { id: 'A', name: 'A', rkey: 'a' });
  const b = join(r, st, { id: 'B', name: 'B', rkey: 'b' });
  msg(r, b, { type: 'chat', text: 'hi' });
  const chat = a.sent.find((m) => m.type === 'chat');
  assert.ok(chat && chat.mid, 'chat message carries a stable mid');
  assert.equal(chat.name, 'B', 'chat uses the sender attachment name');
  msg(r, a, { type: 'react', mid: chat.mid, emoji: '👍', on: true });
  const react = a.sent.find((m) => m.type === 'react');
  assert.ok(react && react.mid === chat.mid && react.emoji === '👍' && react.on === true && react.id === 'A', 'reaction relayed with reactor + on flag');
  a.sent.length = 0;
  msg(r, a, { type: 'react', mid: chat.mid, emoji: '💩', on: true });
  assert.ok(!a.sent.find((m) => m.type === 'react'), 'reaction outside the allowed set is dropped');
}

// 10) Duplicate self (#57): a second live connection sharing the same reconnect
//     key supersedes the stale one, so the returning person doesn't appear twice.
//     The evicted copy's goal/pref is returned for the rejoin, peers are told it
//     left, and it's stashed for reconnect.
{
  const st = makeState();
  const r = new RoomDO(st, null);
  await r._restore;
  r.roomId = 'test'; r.configured = true; r.isPublic = true;
  // A live observer (different key) that should be told the stale copy left.
  const mags = join(r, st, { id: 'mags', name: 'Mags', rkey: 'dev-mags' });
  // The zombie: same tab as the reconnecting person, socket not yet closed.
  const zombie = join(r, st, { id: 'zombie', name: 'Jeff', rkey: 'dev-jeff', goal: 'write the report' });

  const res = r.supersedeStale('dev-jeff');

  assert.equal(res.reconnecting, true, 'return flagged as a reconnect');
  assert.equal(res.goal, 'write the report', 'evicted goal returned for the rejoin');
  assert.equal(zombie._open, false, 'stale socket closed');
  assert.ok(!r.order().includes('zombie'), 'stale same-key session evicted from the roster');
  assert.ok(r.order().includes('mags'), 'unrelated session untouched');
  assert.ok(mags.sent.find((m) => m.type === 'peer-leave' && m.id === 'zombie'), 'peers told the stale copy left');
  const stash = r.recentLeavers.get('dev-jeff');
  assert.ok(stash && stash.goal === 'write the report', 'evicted goal kept for the rejoin');
  // No matching key => no-op (doesn't evict anyone), reports not-a-reconnect.
  assert.equal(r.supersedeStale('nobody').reconnecting, false, 'no match => not a reconnect');
  assert.ok(r.order().includes('mags'), 'supersedeStale with no match is a no-op');
  assert.equal(r.supersedeStale(null).reconnecting, false, 'supersedeStale(null) is a no-op');
}

// 11) Media roster (#68/#72): a published track shows in tracksMap; camera-off
//     (video null, audio kept) updates it; leaving drops it.
{
  const st = makeState();
  const r = new RoomDO(st, null);
  await r._restore;
  r.roomId = 'test'; r.configured = true;
  const a = join(r, st, { id: 'A', name: 'A', rkey: 'a' });
  const b = join(r, st, { id: 'B', name: 'B', rkey: 'b' });
  msg(r, a, { type: 'publish', session: 'sessA', audio: 'au', video: 'vid' });
  assert.deepEqual(r.tracksMap().A, { session: 'sessA', audio: 'au', video: 'vid' }, 'published tracks in roster');
  assert.ok(b.sent.find((m) => m.type === 'tracks' && m.id === 'A' && m.video === 'vid'), 'peers told of the publish');
  msg(r, a, { type: 'publish', session: 'sessA', audio: 'au', video: null }); // camera off
  assert.equal(r.tracksMap().A.video, null, 'camera-off clears the video track, keeps audio');
  disconnect(r, a);
  assert.ok(!r.tracksMap().A, 'leaving drops the track roster entry');
}

// 12) Host adjusts the next round's length from regroup. The host's restart with
//     a new length updates + persists the config and broadcasts it; a non-host's
//     restart still starts the round but can't change the length.
{
  const st = makeState();
  const r = new RoomDO(st, null);
  await r._restore;
  r.roomId = 'test'; r.configured = true;
  r.focusMin = 50; r.regroupMin = 5;
  r.phase = 'regroup'; r.endsAt = NOW + 5 * 60000;
  const host = join(r, st, { id: 'H', name: 'Host', joinedAt: NOW });      // oldest = host
  const guest = join(r, st, { id: 'G', name: 'Guest', joinedAt: NOW + 1 });
  assert.equal(r.hostId(), 'H', 'oldest socket is host');

  // Non-host can't change the length, but still restarts the round.
  msg(r, guest, { type: 'restart', focusMin: 99, regroupMin: 42 });
  assert.equal(r.phase, 'greet', 'guest restart still starts a new round');
  assert.equal(r.focusMin, 50, 'guest cannot change focus length');
  assert.equal(r.regroupMin, 5, 'guest cannot change regroup length');

  // Back to regroup, then the host shortens the next round (clamped).
  r.phase = 'regroup';
  msg(r, host, { type: 'restart', focusMin: 25, regroupMin: 3 });
  assert.equal(r.phase, 'greet', 'host restart starts a new round');
  assert.equal(r.focusMin, 25, 'host sets a shorter focus length');
  assert.equal(r.regroupMin, 3, 'host sets a shorter regroup length');
  assert.equal(st.store.get('sess').focusMin, 25, 'new length persisted');
  assert.ok(host.sent.find((m) => m.type === 'phase' && m.focusMin === 25), 'new length broadcast to the room');

  // Out-of-range values are clamped, not rejected.
  r.phase = 'regroup';
  msg(r, host, { type: 'restart', focusMin: 9999, regroupMin: -5 });
  assert.equal(r.focusMin, 180, 'focus clamped to max 180');
  assert.equal(r.regroupMin, 0, 'regroup clamped to min 0');
}

// Someone joins/reconnects during the pre-focus countdown: the alarm must stay
// on startAt, not get pushed to the next 60s heartbeat (focus stalled on "go").
{
  const st = makeState();
  const r = new RoomDO(st, null);
  await r._restore;
  r.roomId = 'cd'; r.configured = true;
  const a = join(r, st, { id: 'a' });
  msg(r, a, { type: 'start' });
  const startAt = r.startAt;
  assert.equal(st.alarm, startAt, 'countdown alarm armed');
  join(r, st, { id: 'b' });
  r.scheduleTick(); // what fetch() does after a join
  assert.equal(st.alarm, startAt, 'join during countdown keeps the countdown alarm');
  NOW = startAt;
  await r.alarm();
  assert.equal(r.phase, 'focus', 'focus begins on time');
}

Date.now = realNow;
// 13) Orphan sockets don't hold seats or block the room (#89 follow-up). A
//     superseded socket whose close() frame never reached the client stays in
//     getWebSockets() with a nulled attachment, so anything counting raw sockets
//     saw a phantom occupant.
{
  const st = makeState();
  const r = new RoomDO(st, null);
  await r._restore;
  r.roomId = 'test'; r.configured = true;
  const live = join(r, st, { id: 'live', name: 'Mags', rkey: 'dev-mags' });
  const orphan = join(r, st, { id: 'orphan', name: 'Jeff', rkey: 'dev-jeff' });
  orphan.serializeAttachment(null); // handleLeave ran; the close never landed
  assert.equal(r.sockets().length, 2, 'the orphan socket is still connected');
  assert.equal(r.count(), 1, 'but it is not counted as a member');

  // The all-ready auto-start compares readyIds() with count(): with the phantom
  // in the count it could never match, so a ready room never started.
  r.phase = 'greet';
  msg(r, live, { type: 'ready' });
  assert.equal(r.phase, 'greet', 'no auto-start yet (countdown flag instead)');
  assert.equal(r.starting, true, 'ready room starts once everyone real is ready');

  // Empty-but-orphaned: the alarm must still treat the room as empty.
  live.serializeAttachment(null);
  assert.equal(r.count(), 0, 'a room holding only orphans is empty');
}

// 14) A member whose socket dropped can get back into a locked room (#89). The
//     lock is for newcomers; their own zombie must not turn them away, and
//     neither must the count it inflated.
{
  const realPair = globalThis.WebSocketPair, realResponse = globalThis.Response;
  let lastPair = null; // the pair fetch/rejectWs just built, so we can read its close code
  globalThis.WebSocketPair = function () {
    const mk = () => {
      const w = fakeWs();
      w.accept = () => {};
      w.close = (code) => { w._open = false; w.closedWith = code; };
      return w;
    };
    const client = mk(), server = mk();
    lastPair = { client, server };
    return { 0: client, 1: server };
  };
  globalThis.Response = class { constructor(body, init = {}) { this.body = body; Object.assign(this, init); } };
  try {
    const st = makeState();
    const r = new RoomDO(st, null);
    await r._restore;
    r.roomId = 'test'; r.configured = true; r.locked = true;
    join(r, st, { id: 'host', name: 'Gigi', rkey: 'dev-gigi' });
    const zombie = join(r, st, { id: 'jeff-old', name: 'Jeff', rkey: 'dev-jeff' });

    const req = (key) => new Request(`https://room/room/test/ws?name=Jeff&did=${key}`, { headers: { Upgrade: 'websocket' } });
    const back = await r.fetch(req('dev-jeff'));
    assert.equal(back.status, 101, 'the returning member is let in');
    assert.equal(zombie._open, false, 'their zombie was superseded, not counted');
    assert.equal(r.count(), 2, 'host + the one Jeff, no duplicate');

    const stranger = await r.fetch(req('dev-stranger'));
    assert.equal(stranger.status, 101, 'stranger is accepted at the socket level');
    assert.equal(lastPair.server.closedWith, 4002, 'then closed as locked out');
    assert.equal(r.count(), 2, 'the locked-out stranger never joined the roster');
  } finally {
    globalThis.WebSocketPair = realPair;
    globalThis.Response = realResponse;
  }
}

// 15) Anyone in the room can close it to newcomers, not just the host, and the
//     room never decides that for them: starting focus leaves the lock alone.
{
  const st = makeState();
  const r = new RoomDO(st, null);
  await r._restore;
  r.roomId = 'test'; r.configured = true; r.isPublic = true;
  const a = join(r, st, { id: 'a', name: 'Gigi' });
  const b = join(r, st, { id: 'b', name: 'Jeff' });

  await r.beginFocus();
  assert.equal(r.locked, false, 'focus leaves the room open');

  b.sent.length = 0;
  msg(r, b, { type: 'lock', locked: true }); // b is not the host
  assert.equal(r.locked, true, 'a non-host can close the room');
  assert.ok(b.sent.find((m) => m.type === 'locked-state' && m.locked === true), 'everyone told');
  assert.equal(st.store.get('sess').locked, true, 'persisted, so an eviction keeps it closed');

  r.toGreet();
  assert.equal(r.locked, true, 'their lock survives the next round');

  msg(r, a, { type: 'lock', locked: false });
  assert.equal(r.locked, false, 'and anyone can open it again');
}

// 16) Regroup takes turns too (#90): the flip out of focus clears the greet
//     round's "I've shared" flags and tells everyone, so the reporting order
//     starts from the top of the join order instead of reading as all-done.
{
  const st = makeState();
  const r = new RoomDO(st, null);
  await r._restore;
  r.roomId = 'test'; r.configured = true;
  const a = join(r, st, { id: 'a', name: 'Gigi' });
  const b = join(r, st, { id: 'b', name: 'Jeff' });
  r.phase = 'greet';
  msg(r, a, { type: 'shared' });
  msg(r, b, { type: 'shared' });
  assert.deepEqual(r.sharedIds(), ['a', 'b'], 'both shared during greet');

  r.phase = 'focus';
  r.endsAt = NOW - 1; // focus is over
  a.sent.length = 0; b.sent.length = 0;
  await r.alarm();
  assert.equal(r.phase, 'regroup', 'flipped to regroup');
  assert.deepEqual(r.sharedIds(), [], 'turn flags cleared for the report round');
  const told = a.sent.find((m) => m.type === 'shared-state');
  assert.ok(told && told.shared.length === 0, 'clients told the order restarted');
  assert.deepEqual(r.order(), ['a', 'b'], 'reporting order is join order');

  msg(r, a, { type: 'shared' });
  assert.deepEqual(r.sharedIds(), ['a'], 'first reporter advances the frame');
}

// 17) A closed socket must not hold its seat. The runtime's close event can lag
//     (under hibernation, forever), so the person is gone while the room still
//     counts them: it reads as full and turns them away when they come back with
//     a reconnect key that doesn't match the one they left with.
{
  const realPair = globalThis.WebSocketPair, realResponse = globalThis.Response;
  let lastPair = null; // 'full' is signalled by closing the accepted socket, not by the status
  globalThis.WebSocketPair = function () {
    const mk = () => { const w = fakeWs(); w.accept = () => {}; w.close = (code) => { w._open = false; w.readyState = 3; w.closedWith = code; }; return w; };
    const client = mk(), server = mk();
    lastPair = { client, server };
    return { 0: client, 1: server };
  };
  globalThis.Response = class { constructor(body, init = {}) { this.body = body; Object.assign(this, init); } };
  try {
    const st = makeState();
    const r = new RoomDO(st, null);
    await r._restore;
    r.roomId = 'test'; r.configured = true;
    const live = join(r, st, { id: 'live', name: 'Mags', rkey: 'dev-mags' });
    join(r, st, { id: 'b', name: 'Jeff', rkey: 'dev-jeff' });
    join(r, st, { id: 'c', name: 'Pat', rkey: 'dev-pat' });
    const gone = join(r, st, { id: 'gone', name: 'Sam', rkey: 'dev-sam-old' });
    assert.equal(r.count(), 4, 'room is full');

    // Sam's connection died: the runtime marks the socket closed, but no close
    // event ever reaches us, and the attachment is still intact.
    gone.readyState = 3;

    // Sam comes back in a fresh tab with no stored device id, so their reconnect
    // key is new and supersedeStale can't match them to the seat they left.
    live.sent.length = 0;
    const back = await r.fetch(new Request('https://room/room/test/ws?name=Sam&cid=dev-sam-new', { headers: { Upgrade: 'websocket' } }));
    assert.equal(back.status, 101, 'socket accepted');
    assert.equal(lastPair.server.closedWith, undefined, 'let back in, not closed with 4001 full');
    assert.equal(r.count(), 4, 'their old seat was released, not doubled up');
    assert.ok(!r.order().includes('gone'), 'the dead socket left the roster');
    assert.ok(live.sent.find((m) => m.type === 'peer-leave' && m.id === 'gone'), 'peers were told they left');

    // The heartbeat frees seats too, without waiting for someone to try the door.
    const alsoGone = r.socketOf('c');
    alsoGone.readyState = 3;
    await r.alarm();
    assert.equal(r.count(), 3, 'the alarm swept the closed socket');

    // A live member is never swept.
    assert.ok(r.order().includes('live'), 'open sockets are left alone');
  } finally {
    globalThis.WebSocketPair = realPair;
    globalThis.Response = realResponse;
  }
}

// 18) The liveness probe is answered (#89). Normally the runtime's auto-response
//     handles it without waking the room, but on a runtime without that, or for a
//     frame that doesn't match it exactly, the message handler must still reply:
//     an unanswered probe makes the client tear down a healthy socket.
{
  const st = makeState();
  const r = new RoomDO(st, null);
  await r._restore;
  r.roomId = 'test'; r.configured = true;
  const ws = join(r, st, { id: 'a', name: 'Gigi' });
  ws.sent.length = 0;
  msg(r, ws, { type: 'ping' });
  assert.deepEqual(ws.sent, [{ type: 'pong' }], 'probe answered');
  assert.equal(r.count(), 1, 'and it changes nothing else');
}

// 19) Shared pictures: relayed like chat, never stored, and bounded. The cap and
//     the type check are the backstop for a client that lies; the gap keeps one
//     person from filling the room.
{
  Date.now = () => NOW; // this block needs the frozen clock back, for the rate-limit gap
  const st = makeState();
  const r = new RoomDO(st, null);
  await r._restore;
  r.roomId = 'test'; r.configured = true;
  const a = join(r, st, { id: 'a', name: 'Gigi' });
  const b = join(r, st, { id: 'b', name: 'Jeff' });
  const tiny = (mime) => `data:${mime};base64,AAAA`;

  b.sent.length = 0;
  msg(r, a, { type: 'image', mime: 'image/webp', data: tiny('image/webp') });
  const got = b.sent.find((m) => m.type === 'chat');
  assert.ok(got, 'relayed as a chat message, so reactions and ordering still work');
  assert.equal(got.img, tiny('image/webp'), 'payload passed through untouched');
  assert.equal(got.mime, 'image/webp', 'type carried for the GIF tag');
  assert.ok(got.mid, 'carries a mid to react to');
  assert.equal(st.store.get('sess'), undefined, 'handling a picture writes nothing to storage at all');

  // Same person again straight away: dropped.
  b.sent.length = 0;
  msg(r, a, { type: 'image', mime: 'image/webp', data: tiny('image/webp') });
  assert.equal(b.sent.filter((m) => m.type === 'chat').length, 0, 'rate limited');

  NOW += 5000; // past the gap
  b.sent.length = 0;
  msg(r, a, { type: 'image', mime: 'image/webp', data: tiny('image/webp') });
  assert.equal(b.sent.filter((m) => m.type === 'chat').length, 1, 'allowed again after the gap');

  // Things a well-behaved client would never send.
  NOW += 5000;
  b.sent.length = 0;
  msg(r, a, { type: 'image', mime: 'image/svg+xml', data: tiny('image/svg+xml') });
  msg(r, a, { type: 'image', mime: 'image/png', data: 'https://example.com/cat.png' });
  msg(r, a, { type: 'image', mime: 'image/png', data: `data:image/png;base64,${'A'.repeat(900000)}` });
  assert.equal(b.sent.filter((m) => m.type === 'chat').length, 0, 'svg, a bare URL and an oversize payload all refused');

  // Unsending carries the sender's real id, so a client can't remove someone else's picture.
  b.sent.length = 0;
  msg(r, a, { type: 'unsend', mid: got.mid });
  const un = b.sent.find((m) => m.type === 'unsent');
  assert.equal(un.mid, got.mid, 'unsend relayed with the mid');
  assert.equal(un.id, 'a', 'stamped with the sender, not whatever the client claims');
  Date.now = realNow;
}

// A removed person stays removed: their tab auto-reconnecting (a laptop waking
// from sleep never heard the close) is turned away, even after an eviction.
{
  const realPair = globalThis.WebSocketPair, realResponse = globalThis.Response;
  let lastPair = null;
  globalThis.WebSocketPair = function () {
    const mk = () => { const w = fakeWs(); w.accept = () => {}; w.close = (code) => { w._open = false; w.closedWith = code; }; return w; };
    const client = mk(), server = mk();
    lastPair = { client, server };
    return { 0: client, 1: server };
  };
  globalThis.Response = class { constructor(body, init = {}) { this.body = body; Object.assign(this, init); } };
  try {
    const st = makeState();
    const r = new RoomDO(st, null);
    await r._restore;
    r.roomId = 'test'; r.configured = true;
    const host = join(r, st, { id: 'host', name: 'Gigi', rkey: 'dev-gigi' });
    join(r, st, { id: 'byron', name: 'Byron', rkey: 'dev-byron' });
    msg(r, host, { type: 'kick', id: 'byron' });
    assert.equal(r.count(), 1, 'removed');

    const req = (key) => new Request(`https://room/room/test/ws?name=Byron&did=${key}`, { headers: { Upgrade: 'websocket' } });
    await r.fetch(req('dev-byron'));
    assert.equal(lastPair.server.closedWith, 4000, 'auto-reconnect turned away as removed');
    assert.equal(r.count(), 1, 'never rejoined');

    const r2 = new RoomDO(st, null); // evicted and restored from storage
    await r2._restore;
    st._sockets.forEach((w) => { if (w._att?.id === 'host') w._open = true; });
    await r2.fetch(req('dev-byron'));
    assert.equal(lastPair.server.closedWith, 4000, 'still turned away after an eviction');

    await r2.fetch(req('dev-someone-else'));
    assert.equal(lastPair.server.closedWith, undefined, 'other people can still join');
  } finally {
    globalThis.WebSocketPair = realPair;
    globalThis.Response = realResponse;
  }
}

// Changing your avatar mid-session reaches everyone; junk is ignored.
{
  const st = makeState();
  const r = new RoomDO(st, null);
  await r._restore;
  r.roomId = 'test'; r.configured = true;
  const a = join(r, st, { id: 'a', name: 'Gigi' });
  const b = join(r, st, { id: 'b', name: 'Ineke' });
  msg(r, a, { type: 'avatar', av: 7 });
  assert.deepEqual(b.sent.find((m) => m.type === 'avatar'), { type: 'avatar', id: 'a', av: 7 }, 'peers hear the new avatar');
  assert.equal(a.deserializeAttachment().av, 7, 'kept on the socket for anyone who joins later');
  b.sent.length = 0;
  for (const junk of [24, -1, 2.5, '3', null]) msg(r, a, { type: 'avatar', av: junk });
  assert.equal(b.sent.filter((m) => m.type === 'avatar').length, 0, 'out-of-range or non-integer picks ignored');
  assert.equal(a.deserializeAttachment().av, 7, 'and the old pick stands');
}

// Away status: relayed to everyone (including the sender, so all clocks agree),
// backdated by a capped `ago`, kept for late joiners, cleared on return.
{
  const st = makeState();
  const r = new RoomDO(st, null);
  await r._restore;
  r.roomId = 'test'; r.configured = true;
  const a = join(r, st, { id: 'a', name: 'Gigi' });
  const b = join(r, st, { id: 'b', name: 'Ada' });
  msg(r, a, { type: 'away', away: true, ago: 5 * 60_000 });
  const got = b.sent.find((m) => m.type === 'away');
  assert.ok(got && got.id === 'a' && got.serverNow - got.since === 5 * 60_000, 'peers hear away, backdated by ago');
  assert.ok(a.sent.find((m) => m.type === 'away'), 'sender hears it too');
  assert.equal(r.awayMap().a, got.since, 'kept for anyone who joins later');
  msg(r, a, { type: 'away', away: true, ago: 99 * HOUR });
  assert.ok(Math.abs(Date.now() - HOUR - r.awayMap().a) < 1000, 'ago capped at an hour');
  msg(r, a, { type: 'away', away: true, ago: 'junk' });
  assert.ok(Math.abs(Date.now() - r.awayMap().a) < 1000, 'junk ago means now');
  msg(r, a, { type: 'away', away: false });
  assert.deepEqual(r.awayMap(), {}, 'back clears it');
  assert.equal(b.sent.filter((m) => m.type === 'away').pop().since, null, 'peers told they are back');
}

// A laptop that falls asleep in the room (the #123 situation) stops pinging, so
// the room marks it away by itself, and clears it once pings resume.
{
  const st = makeState();
  const last = new Map();
  st.getWebSocketAutoResponseTimestamp = (ws) => last.get(ws) || null;
  const r = new RoomDO(st, null);
  await r._restore;
  r.roomId = 'test'; r.configured = true;
  const now = Date.now();
  const byron = join(r, st, { id: 'byron', name: 'Byron', joinedAt: now - 10 * 60_000 });
  const freya = join(r, st, { id: 'freya', name: 'Freya', joinedAt: now - 10 * 60_000 });
  last.set(freya, new Date(now - 20_000));
  last.set(byron, new Date(now - 4 * 60_000)); // asleep for 4 min
  r.sweepQuiet();
  const got = freya.sent.filter((m) => m.type === 'away');
  assert.equal(got.length, 1, 'only the quiet one is announced');
  assert.equal(got[0].id, 'byron');
  assert.ok(Math.abs(got[0].since - (now - 4 * 60_000)) < 1000, 'away since they were last heard');
  r.sweepQuiet();
  assert.equal(freya.sent.filter((m) => m.type === 'away').length, 1, 'no repeat while still quiet');
  msg(r, byron, { type: 'away', away: false }); // client's own "back" can't clear a quiet socket
  assert.ok(r.awayMap().byron, 'still away while the socket is quiet');
  last.set(byron, new Date(Date.now())); // laptop wakes, pings again
  r.sweepQuiet();
  assert.equal(freya.sent.filter((m) => m.type === 'away').pop().since, null, 'back once pings resume');
  const fresh = join(r, st, { id: 'new', name: 'New', joinedAt: Date.now() });
  r.sweepQuiet();
  assert.ok(!r.awayMap().new, 'a just-joined socket with no ping yet is not quiet');
}

console.log('RoomDO hibernation self-check (#9 #30 #47 #55 #53 #57 #68 #89 #90 + dead-socket seats + session continuity + away): all passed');
