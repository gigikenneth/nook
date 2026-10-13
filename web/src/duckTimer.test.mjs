// Self-check for the pop-out timer's water level. Run: node web/src/duckTimer.test.mjs
import assert from 'node:assert';
import { fillOf, clock, duckOpacity } from './duckTimer.js';

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
assert.equal(duckOpacity(0.5), 1, 'duck fully there halfway');
assert.ok(duckOpacity(0.86) > 0 && duckOpacity(0.86) < 1, 'fading as the water nears the top');
assert.equal(duckOpacity(0.95), 0, 'gone for the last stretch');
assert.equal(duckOpacity(1), 0, 'gone at zero');
console.log('duckTimer: ok');
