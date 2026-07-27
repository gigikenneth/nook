// Self-check for issue #5: a sole occupant who drops must resume the SAME
// running timer, not restart in greet. Run: `node src/RoomDO.test.mjs`.
// No framework on purpose — plain asserts against the DO's leave/alarm logic.
import assert from 'node:assert';
import { RoomDO } from './RoomDO.js';

let alarmAt = null;
const fakeState = {
  storage: {
    setAlarm: (t) => { alarmAt = t; },
    deleteAlarm: () => { alarmAt = null; },
  },
};

// Freeze/advance the clock so we can drive the grace window deterministically.
let NOW = 1_000_000;
const realNow = Date.now;
Date.now = () => NOW;

function soloFocusRoom() {
  const r = new RoomDO(fakeState, null); // env null => syncLobby is a no-op
  r.roomId = 'test';
  r.phase = 'focus';
  r.endsAt = NOW + 50 * 60000; // 50 min left
  const id = 'solo';
  r.hostId = id;
  r.sessions.set(id, { ws: { send() {} }, name: 'Gigi' });
  return { r, id };
}

// 1) Last person drops mid-focus: timer must survive, grace alarm armed.
{
  const { r, id } = soloFocusRoom();
  const endsAt = r.endsAt;
  r.onClose(id);
  assert.equal(r.phase, 'focus', 'phase kept on drop');
  assert.equal(r.endsAt, endsAt, 'endsAt kept on drop (no restart)');
  assert.equal(r.emptyAt, NOW, 'grace window started');
  assert.equal(r.hostId, null, 'host handed off for rejoiner');
  assert.equal(alarmAt, NOW + 90000, 'grace alarm armed');
}

// 2) Rejoin within grace: welcome would read the still-running timer.
{
  const { r, id } = soloFocusRoom();
  const endsAt = r.endsAt;
  r.onClose(id);
  NOW += 5000; // 5s later, they reconnect — mimic fetch()'s join bookkeeping
  if (r.hostId === null) r.hostId = 'solo2';
  r.emptyAt = null;
  r.sessions.set('solo2', { ws: { send() {} }, name: 'Gigi' });
  assert.equal(r.phase, 'focus', 'resumed in focus');
  assert.equal(r.endsAt, endsAt, 'resumed timer unchanged');
}

// 3) Grace lapses empty: alarm tears the room down.
{
  const { r, id } = soloFocusRoom();
  r.onClose(id);
  NOW += 90000 + 1; // past the grace window
  r.alarm();
  assert.equal(r.phase, 'greet', 'torn down to greet');
  assert.equal(r.endsAt, null, 'timer cleared');
  assert.equal(r.emptyAt, null, 'grace cleared');
  assert.equal(r.hostId, null, 'host cleared');
  assert.equal(alarmAt, null, 'alarm deleted');
}

Date.now = realNow;
console.log('RoomDO #5 self-check: all passed');
