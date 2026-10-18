// Self-check for the away rules. Run:
//   node web/src/idleAway.test.mjs
import assert from 'node:assert';
import { nextAway, awayLabel } from './idleAway.js';

const T = 1_000_000;
let s = null;
s = nextAway(s, { type: 'brb' }, T);
assert.deepEqual(s, { at: T, manual: true }, 'BRB marks you away now');
s = nextAway(s, { type: 'idle', away: false }, T + 5);
assert.deepEqual(s, { at: T, manual: true }, 'moving the mouse never clears a BRB');
s = nextAway(s, { type: 'idle', away: true, ago: 300_000 }, T + 9);
assert.deepEqual(s, { at: T, manual: true }, 'going idle while BRB keeps the original time');
s = nextAway(s, { type: 'back' }, T + 10);
assert.equal(s, null, 'I am back clears it');

s = nextAway(null, { type: 'idle', away: true, ago: 300_000 }, T);
assert.deepEqual(s, { at: T - 300_000, manual: false }, 'idle away is backdated to when idle began');
assert.deepEqual(nextAway(s, { type: 'brb' }, T + 1), { at: T - 300_000, manual: true }, 'BRB while idle-away pins it');
assert.equal(nextAway(s, { type: 'idle', away: false }, T + 1), null, 'activity clears an idle away');
assert.equal(nextAway(null, { type: 'idle', away: false }, T), null, 'already here stays here');

assert.equal(awayLabel(T, T + 30_000), 'away');
assert.equal(awayLabel(T, T + 60_000), 'away 1 min');
assert.equal(awayLabel(T, T + 12 * 60_000 + 59_000), 'away 12 min');
assert.equal(awayLabel(T, T + 75 * 60_000), 'away 1 hr');
assert.equal(awayLabel(T, T - 5_000), 'away', 'clock skew never shows negative');

console.log('idleAway ok');
