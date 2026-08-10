// Self-check for the SFU roster-diff logic (mesh -> Cloudflare Realtime, #68/#72).
// Run: node web/src/sfu.test.mjs
import assert from 'node:assert';
import { diffRoster } from './sfu.js';

const sortP = (a) => [...a].sort((x, y) => (x.peerId + x.kind).localeCompare(y.peerId + y.kind));

// Someone joins publishing audio + video -> pull both.
{
  const next = { bob: { audio: 'a1', video: 'v1', session: 's-bob' } };
  const { toPull, toDrop } = diffRoster({}, next, 'me');
  assert.equal(toDrop.length, 0, 'nothing to drop on a fresh join');
  assert.deepEqual(sortP(toPull), [
    { peerId: 'bob', kind: 'audio', trackId: 'a1', session: 's-bob' },
    { peerId: 'bob', kind: 'video', trackId: 'v1', session: 's-bob' },
  ], 'pull both tracks of the joiner');
}

// Never pull our own tracks.
{
  const next = { me: { audio: 'a0', video: 'v0', session: 's-me' }, bob: { audio: 'a1', session: 's-bob' } };
  const { toPull } = diffRoster({}, next, 'me');
  assert.ok(!toPull.some((t) => t.peerId === 'me'), 'self is skipped');
  assert.equal(toPull.length, 1, 'only bob audio pulled');
}

// Camera turns OFF: video track disappears -> drop video only, audio untouched.
{
  const prev = { bob: { audio: 'a1', video: 'v1', session: 's-bob' } };
  const next = { bob: { audio: 'a1', session: 's-bob' } };
  const { toPull, toDrop } = diffRoster(prev, next, 'me');
  assert.deepEqual(toDrop, [{ peerId: 'bob', kind: 'video' }], 'drop bob video');
  assert.equal(toPull.length, 0, 'audio unchanged -> no pull');
}

// Camera turns ON later: video appears -> pull video only.
{
  const prev = { bob: { audio: 'a1', session: 's-bob' } };
  const next = { bob: { audio: 'a1', video: 'v2', session: 's-bob' } };
  const { toPull, toDrop } = diffRoster(prev, next, 'me');
  assert.equal(toDrop.length, 0, 'nothing dropped');
  assert.deepEqual(toPull, [{ peerId: 'bob', kind: 'video', trackId: 'v2', session: 's-bob' }], 'pull new video');
}

// Track REPLACED (re-acquired camera -> new id): drop old, pull new.
{
  const prev = { bob: { video: 'v1', session: 's-bob' } };
  const next = { bob: { video: 'v9', session: 's-bob' } };
  const { toPull, toDrop } = diffRoster(prev, next, 'me');
  assert.deepEqual(toDrop, [{ peerId: 'bob', kind: 'video' }], 'drop stale video sub');
  assert.deepEqual(toPull, [{ peerId: 'bob', kind: 'video', trackId: 'v9', session: 's-bob' }], 'pull replacement');
}

// Peer LEAVES: gone from roster -> drop all their tracks, pull nothing.
{
  const prev = { bob: { audio: 'a1', video: 'v1', session: 's-bob' }, cara: { audio: 'a2', session: 's-cara' } };
  const next = { cara: { audio: 'a2', session: 's-cara' } };
  const { toPull, toDrop } = diffRoster(prev, next, 'me');
  assert.deepEqual(sortP(toDrop), [
    { peerId: 'bob', kind: 'audio' },
    { peerId: 'bob', kind: 'video' },
  ], 'drop both of the leaver');
  assert.equal(toPull.length, 0, 'nothing new to pull');
}

// No change -> no work.
{
  const same = { bob: { audio: 'a1', video: 'v1', session: 's-bob' } };
  const { toPull, toDrop } = diffRoster(same, same, 'me');
  assert.equal(toPull.length + toDrop.length, 0, 'stable roster is a no-op');
}

console.log('sfu roster-diff (#68/#72) self-check: all passed');
