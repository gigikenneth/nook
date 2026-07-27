// Self-check for the camera/mic helpers behind issue #6. Run:
//   node web/src/media.test.mjs
import assert from 'node:assert';
import { liveTrackOf, mediaErrorMessage } from './media.js';

const streamWith = (kind, readyState) => ({
  getVideoTracks: () => (kind === 'video' && readyState ? [{ kind: 'video', readyState }] : []),
  getAudioTracks: () => (kind === 'audio' && readyState ? [{ kind: 'audio', readyState }] : []),
});

// liveTrackOf: only a *live* track counts as present.
assert.ok(liveTrackOf(streamWith('video', 'live'), 'video'), 'live video track is present');
assert.equal(liveTrackOf(streamWith('video', 'ended'), 'video'), null, 'ended track is NOT reused (the #6 bug)');
assert.equal(liveTrackOf(streamWith('video', null), 'video'), null, 'no track => null');
assert.equal(liveTrackOf(null, 'video'), null, 'no stream => null');
assert.equal(liveTrackOf(streamWith('audio', 'live'), 'video'), null, 'wrong kind => null');

// mediaErrorMessage: actionable text per failure, keyed by DOMException name.
assert.match(mediaErrorMessage('video', { name: 'NotAllowedError' }), /blocked/, 'permission denied -> blocked');
assert.match(mediaErrorMessage('video', { name: 'NotFoundError' }), /No camera/, 'no device');
assert.match(mediaErrorMessage('audio', { name: 'NotReadableError' }), /in use/, 'device busy');
assert.match(mediaErrorMessage('video', {}), /Couldn't start/, 'unknown -> generic');

console.log('media (#6) self-check: all passed');
