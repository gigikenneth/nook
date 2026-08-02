// Self-check for the session-continuity behavior (issues #5 + the "random restart
// to greeting" follow-up). Run: `node src/RoomDO.test.mjs`.
//
// The session (phase + timer + config) is persisted to DO storage and PAUSED
// while the room is empty, so a rejoin — even after an eviction/deploy or both
// people returning much later — resumes from exactly where it stopped instead of
// restarting at greet. No framework: plain asserts against the DO logic.
import assert from 'node:assert';
import { RoomDO } from './RoomDO.js';

const HOUR = 3600_000;
const ABANDON_MS = 6 * HOUR; // mirror of the constant in RoomDO.js

// Fake DO state: a shared storage Map (so we can simulate eviction by making a
// fresh RoomDO over the same store), a single alarm slot, and a synchronous
// blockConcurrencyWhile.
function makeState(store = new Map()) {
  const s = { alarm: null, store };
  s.storage = {
    get: async (k) => store.get(k),
    put: async (k, v) => { store.set(k, v); },
    delete: async (k) => { store.delete(k); },
    setAlarm: (t) => { s.alarm = t; },
    deleteAlarm: () => { s.alarm = null; },
  };
  s.blockConcurrencyWhile = (fn) => fn();
  return s;
}

let NOW = 1_000_000_000;
const realNow = Date.now;
Date.now = () => NOW;

async function soloFocusRoom(state) {
  const r = new RoomDO(state, null); // env null => syncLobby is a no-op
  await r._restore;
  r.roomId = 'test';
  r.configured = true;
  r.phase = 'focus';
  r.endsAt = NOW + 50 * 60000; // 50 min left
  r.hostId = 'solo';
  r.sessions.set('solo', { ws: { send() {} }, name: 'Gigi' });
  return { r, id: 'solo' };
}

// 1) Last person leaves mid-focus: session pauses (not reset), and is persisted.
const store = new Map();
{
  const st = makeState(store);
  const { r, id } = await soloFocusRoom(st);
  r.onClose(id);
  assert.equal(r.phase, 'focus', 'phase kept on empty');
  assert.equal(r.endsAt, null, 'timer frozen (no absolute end while paused)');
  assert.equal(r.paused, true, 'session paused');
  assert.equal(r.remainingMs, 50 * 60000, 'full 50 min frozen');
  assert.equal(r.hostId, null, 'host handed off for the rejoiner');
  assert.equal(st.alarm, NOW + ABANDON_MS, 'abandon alarm armed');
  const saved = store.get('sess');
  assert.equal(saved.phase, 'focus', 'persisted phase');
  assert.equal(saved.paused, true, 'persisted paused');
  assert.equal(saved.remainingMs, 50 * 60000, 'persisted remaining');
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

  NOW += 30_000; // they come back 30s later
  r2.resumeSession();
  assert.equal(r2.paused, false, 'resumed');
  assert.equal(r2.phase, 'focus', 'still focus — did NOT restart at greet');
  assert.equal(r2.endsAt, NOW + 50 * 60000, 're-anchored with the same time left');
}

// 3) Genuinely abandoned: paused past the abandon window, the alarm wipes it.
{
  const st = makeState();
  const { r, id } = await soloFocusRoom(st);
  r.onClose(id); // pause
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
  r.phase = 'focus'; r.endsAt = NOW + 10 * 60000; // running, paused=false, no sessions
  await r.alarm();
  assert.equal(r.paused, true, 'empty+running alarm pauses the session');
  assert.equal(r.remainingMs, 10 * 60000, 'remaining captured');
  assert.ok(st.store.get('sess'), 'still persisted (not wiped)');
}

// 5) Camera preference (#9): valid sticks + broadcasts, garbage clears, cleared on leave.
{
  const st = makeState();
  const { r, id } = await soloFocusRoom(st);
  const sent = [];
  r.sessions.set(id, { ws: { send: (s) => sent.push(JSON.parse(s)) }, name: 'Gigi' });
  r.isPublic = true;
  r.onMessage(id, { data: JSON.stringify({ type: 'campref', pref: 'off' }) });
  assert.equal(r.camPrefs.get(id), 'off', 'valid pref stored');
  assert.ok(sent.find((m) => m.type === 'campref' && m.pref === 'off'), 'pref broadcast');
  r.onMessage(id, { data: JSON.stringify({ type: 'campref', pref: 'bogus' }) });
  assert.equal(r.camPrefs.has(id), false, 'garbage pref clears it');
  r.onClose(id);
  assert.equal(r.camPrefs.has(id), false, 'pref cleared on leave');
}

// 6) Reconnect detection (#30): a leaver's client id, goal, and camera pref are
//    stashed briefly so a quick return is recognised (no join chime) and restored.
{
  const st = makeState();
  const r = new RoomDO(st, null);
  await r._restore;
  r.roomId = 'test'; r.configured = true; r.isPublic = true;
  const id = 'p1';
  // rkey = the durable reconnect key (did if present, else cid). Survives a
  // full tab close so "pick up where you left off" works past a close, not
  // just a refresh.
  r.sessions.set(id, { ws: { send() {} }, name: 'Gigi', rkey: 'dev-abc' });
  r.goals.set(id, 'ship the fix');
  r.camPrefs.set(id, 'off');
  r.onClose(id);
  const stash = r.recentLeavers.get('dev-abc');
  assert.ok(stash, 'leaver remembered by reconnect key');
  assert.equal(stash.goal, 'ship the fix', 'goal kept for the return');
  assert.equal(stash.pref, 'off', 'camera pref kept for the return');
}

Date.now = realNow;
console.log('RoomDO session-continuity + #9 + #30 self-check: all passed');
