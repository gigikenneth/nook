// Pure camera/mic helpers, kept dependency-free so they're unit-testable in node
// (useRoom.js pulls in React). See useRoom.js for how they're used.

// A camera/mic track can die out from under us — the OS or another app grabs the
// device, or a phone backgrounds the tab (lock). A dead track reused looks "on"
// but sends nothing, so treat only a *live* track as present (#6).
export function liveTrackOf(stream, kind) {
  if (!stream) return null;
  const t = (kind === 'video' ? stream.getVideoTracks() : stream.getAudioTracks())[0];
  return t && t.readyState === 'live' ? t : null;
}

// Turn a getUserMedia rejection into something the user can act on, instead of
// the camera silently doing nothing.
export function mediaErrorMessage(kind, e) {
  const dev = kind === 'video' ? 'camera' : 'microphone';
  const name = e && e.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return `Your ${dev} is blocked. Allow it in your browser's site settings, then try again.`;
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return `No ${dev} found on this device.`;
  if (name === 'NotReadableError' || name === 'AbortError') return `Your ${dev} is in use by another app. Close it and try again.`;
  return `Couldn't start your ${dev}. Try again.`;
}
