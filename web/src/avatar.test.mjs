// Self-check for avatar picks. Run: node web/src/avatar.test.mjs
import assert from 'node:assert';
import { avatarOf, validAv, AVATAR_COUNT } from './avatar.js';

assert.equal(avatarOf(5, 'Gigi'), 5, 'a pick wins');
assert.equal(avatarOf(0, 'Gigi'), 0, 'zero is a real pick');
for (const junk of [null, undefined, -1, AVATAR_COUNT, 2.5, '3', NaN]) assert.equal(validAv(junk), false, `${junk} is not a pick`);
assert.equal(avatarOf(null, 'Gigi'), avatarOf(undefined, 'Gigi'), 'same seed, same stand-in');
const s = avatarOf(null, 'some-device-id');
assert.ok(s >= 0 && s < AVATAR_COUNT, 'stand-in is in range');
assert.ok(avatarOf(null, '') >= 0, 'empty seed still works');
console.log('avatar: ok');
