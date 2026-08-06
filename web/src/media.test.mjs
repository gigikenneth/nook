// Self-check for the camera/mic helpers behind issue #6. Run:
//   node web/src/media.test.mjs
import assert from 'node:assert';
import { liveTrackOf, mediaErrorMessage, mediaConstraints } from './media.js';

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

// mediaConstraints: audio and video are requested separately, never together —
// so a broken/blocked camera can't reject the mic request with it (#38). If
// anyone "optimizes" this into one getUserMedia({video,audio}) call, this fails.
assert.deepEqual(mediaConstraints('video'), { video: true }, 'video request carries no audio');
assert.deepEqual(mediaConstraints('audio'), { audio: true }, 'audio request carries no video');
assert.ok(!('audio' in mediaConstraints('video')), 'a video failure never rejects the audio request');
assert.ok(!('video' in mediaConstraints('audio')), 'an audio failure never rejects the video request');

console.log('media (#6 + #38) self-check: all passed');
