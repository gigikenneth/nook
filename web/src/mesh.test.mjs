// Self-check for the renegotiation-recovery guard behind issue #68. Run:
//   node web/src/mesh.test.mjs
import assert from 'node:assert';
import { shouldReoffer } from './mesh.js';

const MAX = 4;

// Still waiting for the answer, under the cap => re-offer (the #68 recovery).
assert.equal(shouldReoffer('have-local-offer', 0, MAX), true, 'stuck waiting, first retry -> re-offer');
assert.equal(shouldReoffer('have-local-offer', 3, MAX), true, 'stuck waiting, under cap -> re-offer');

// Answer applied (or never offered) => nothing to recover.
assert.equal(shouldReoffer('stable', 0, MAX), false, 'answer applied -> stop');
assert.equal(shouldReoffer('have-remote-offer', 0, MAX), false, 'their offer in flight -> not ours to re-send');
assert.equal(shouldReoffer('closed', 0, MAX), false, 'closed connection -> stop');

// Cap reached => stop (no offer storm).
assert.equal(shouldReoffer('have-local-offer', MAX, MAX), false, 'at the cap -> stop');
assert.equal(shouldReoffer('have-local-offer', MAX + 1, MAX), false, 'past the cap -> stop');

console.log('mesh renegotiation-recovery (#68) self-check: all passed');
