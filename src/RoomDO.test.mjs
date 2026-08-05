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

// 7) Shared to-do list (#47): opt-in, relayed + sanitised, held in memory,
//    cleared on unshare, and never sent back to the sharer.
{
  const st = makeState();
  const r = new RoomDO(st, null);
  await r._restore;
  r.roomId = 'test'; r.configured = true;
  const aSent = []; const bSent = [];
  r.sessions.set('A', { ws: { send: (s) => aSent.push(JSON.parse(s)) }, name: 'A', rkey: 'a' });
  r.sessions.set('B', { ws: { send: (s) => bSent.push(JSON.parse(s)) }, name: 'B', rkey: 'b' });
  r.onMessage('A', { data: JSON.stringify({ type: 'list', tasks: [{ text: 'ship', done: true }, { text: 'x'.repeat(300), done: 'y' }, { bad: 1 }] }) });
  assert.equal(r.lists.get('A')[0].done, true, 'done preserved');
  assert.equal(r.lists.get('A')[1].text.length, 200, 'task text capped at 200');
  assert.equal(r.lists.get('A')[2].text, '', 'missing text becomes empty string');
  const relay = bSent.find((m) => m.type === 'peer-list');
  assert.ok(relay && relay.id === 'A' && relay.tasks.length === 3, 'B received the relayed list');
  assert.ok(!aSent.find((m) => m.type === 'peer-list'), 'sharer does not get their own list back');
  r.onMessage('A', { data: JSON.stringify({ type: 'list', tasks: null }) });
  assert.ok(!r.lists.has('A'), 'unshare clears the stored list');
  assert.equal(bSent.filter((m) => m.type === 'peer-list').pop().tasks, null, 'B told sharing stopped');
  r.onMessage('A', { data: JSON.stringify({ type: 'list', tasks: Array.from({ length: 30 }, (_, i) => ({ text: 't' + i, done: false })) }) });
  assert.equal(r.lists.get('A').length, 20, 'list capped at 20 items');
  r.onClose('A');
  assert.ok(!r.lists.has('A'), 'leaving clears the shared list');
}

// 8) Restart is for everyone (#55): a non-host can start the next round from
//    regroup, but nobody can restart out from under a live focus block.
{
  const st = makeState();
  const r = new RoomDO(st, null);
  await r._restore;
  r.roomId = 'test'; r.configured = true;
  r.hostId = 'host';
  r.sessions.set('host', { ws: { send() {} }, name: 'Host', rkey: 'h' });
  r.sessions.set('guest', { ws: { send() {} }, name: 'Guest', rkey: 'g' });
  // Non-host restart during regroup -> back to greet.
  r.phase = 'regroup';
  r.onMessage('guest', { data: JSON.stringify({ type: 'restart' }) });
  assert.equal(r.phase, 'greet', 'a non-host can run the next session from regroup');
  // Restart during focus is ignored (no resetting a live session).
  r.phase = 'focus';
  r.onMessage('guest', { data: JSON.stringify({ type: 'restart' }) });
  assert.equal(r.phase, 'focus', 'restart is ignored mid-focus');
}

// 9) Chat carries a stable mid, and emoji reactions relay (#53). Unknown emoji
//    is rejected so only the allowed set travels.
{
  const st = makeState();
  const r = new RoomDO(st, null);
  await r._restore;
  r.roomId = 'test'; r.configured = true;
  const sent = [];
  r.sessions.set('A', { ws: { send: (s) => sent.push(JSON.parse(s)) }, name: 'A', rkey: 'a' });
  r.sessions.set('B', { ws: { send() {} }, name: 'B', rkey: 'b' });
  r.onMessage('B', { data: JSON.stringify({ type: 'chat', text: 'hi' }) });
  const chat = sent.find((m) => m.type === 'chat');
  assert.ok(chat && chat.mid, 'chat message carries a stable mid');
  r.onMessage('A', { data: JSON.stringify({ type: 'react', mid: chat.mid, emoji: '👍', on: true }) });
  const react = sent.find((m) => m.type === 'react');
  assert.ok(react && react.mid === chat.mid && react.emoji === '👍' && react.on === true && react.id === 'A', 'reaction relayed with reactor + on flag');
  sent.length = 0;
  r.onMessage('A', { data: JSON.stringify({ type: 'react', mid: chat.mid, emoji: '💩', on: true }) });
  assert.ok(!sent.find((m) => m.type === 'react'), 'reaction outside the allowed set is dropped');
}

Date.now = realNow;
console.log('RoomDO session-continuity + #9 + #30 + #47 + #55 + #53 self-check: all passed');
