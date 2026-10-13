// Self-check for the pop-out timer's water level. Run: node web/src/duckTimer.test.mjs
import assert from 'node:assert';
import { fillOf, clock } from './duckTimer.js';

const T = 50 * 60000, now = 1_000_000;
assert.equal(fillOf(now + T, T, now), 0, 'empty at the start of a phase');
assert.equal(fillOf(now + T / 2, T, now), 0.5, 'half full halfway');
assert.equal(fillOf(now, T, now), 1, 'full when the timer runs out');
assert.equal(fillOf(now - 5000, T, now), 1, 'stays full past zero');
assert.equal(fillOf(now + 2 * T, T, now), 0, 'never below empty (clock skew)');
assert.equal(fillOf(null, T, now), 0, 'no timer (greet): empty');
assert.equal(fillOf(now + T, null, now), 0, 'unknown length: empty');
assert.equal(clock(now + 90_500, now), '01:30', 'clock');
assert.equal(clock(null), '--:--', 'no timer');
console.log('duckTimer: ok');
