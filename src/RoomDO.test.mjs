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
  const ws = { _att: null, _open: true, sent: [] };
  ws.serializeAttachment = (v) => { ws._att = v; };
  ws.deserializeAttachment = () => ws._att;
  ws.send = (s) => ws.sent.push(JSON.parse(s));
  ws.close = () => { ws._open = false; }; // leaves state.getWebSockets(), like the runtime
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

// 1) Last person leaves mid-focus: session pauses (not reset), and is persisted.
const store = new Map();
{
  const st = makeState(store);
  const { r, ws } = await soloFocusRoom(st);
  disconnect(r, ws);
  assert.equal(r.phase, 'focus', 'phase kept on empty');
  assert.equal(r.endsAt, null, 'timer frozen (no absolute end while paused)');
  assert.equal(r.paused, true, 'session paused');
  assert.equal(r.remainingMs, 50 * 60000, 'full 50 min frozen');
  assert.equal(r.hostId(), null, 'no host while empty');
  assert.equal(st.alarm, NOW + ABANDON_MS, 'abandon alarm armed');
  const saved = store.get('sess');
  assert.equal(saved.phase, 'focus', 'persisted phase');
  assert.equal(saved.paused, true, 'persisted paused');
  assert.equal(saved.remainingMs, 50 * 60000, 'persisted remaining');
  assert.equal(saved.roomId, 'test', 'roomId persisted so alarms can sync the lobby after eviction');
}

// 2) Eviction / deploy: a fresh DO over the same storage restores the paused
//    session; rejoining resumes it in focus, NOT greet.
{
  const st2 = makeState(store); // SAME store => simulates a rebuilt DO instance
  const r2 = new RoomDO(st2, null);
  await r2._restore;
  assert.equal(r2.phase, 'focus', 'restored phase after eviction');
  assert.equal(r2.paused, true, 'restored paused');
  assert.equal(r2.remainingMs, 50 * 60000, 'restored remaining');
  assert.equal(r2.configured, true, 'config restored (no URL clobber)');
  assert.equal(r2.roomId, 'test', 'roomId restored');

  NOW += 30_000; // they come back 30s later
  r2.resumeSession();
  assert.equal(r2.paused, false, 'resumed');
  assert.equal(r2.phase, 'focus', 'still focus — did NOT restart at greet');
  assert.equal(r2.endsAt, NOW + 50 * 60000, 're-anchored with the same time left');
}

// 3) Genuinely abandoned: paused past the abandon window, the alarm wipes it.
{
  const st = makeState();
  const { r, ws } = await soloFocusRoom(st);
  disconnect(r, ws); // pause
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

Date.now = realNow;
console.log('RoomDO hibernation self-check (#9 #30 #47 #55 #53 #57 #68 + session continuity): all passed');
