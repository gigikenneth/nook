// Client-side helpers for the Cloudflare Realtime SFU. The media path is a single
// PeerConnection to the Cloudflare edge: we PUSH our local mic/cam tracks up and
// PULL each roommate's tracks down. The Durable Object is the track-ID registry —
// it tells us the current roster of who-publishes-what; diffRoster turns two
// rosters into the concrete pull/drop work.
//
// A roster is a map: peerId -> { audio?: trackId, video?: trackId, name }.
// video is absent when that person's camera is off. The SFU session id that owns
// a track is needed to pull it, so entries also carry `session`.

// Pure: given the previous and next roster (excluding ourselves), return the
// tracks to start pulling and the ones to drop. A track counts as a single unit
// keyed by (peerId, kind) so a camera toggle only moves the video track, not
// audio. No browser APIs — fully unit-testable.
export function diffRoster(prev, next, selfId) {
  const toPull = []; // { peerId, kind, trackId, session }
  const toDrop = []; // { peerId, kind }
  const kinds = ['audio', 'video'];

  const ids = new Set([...Object.keys(prev || {}), ...Object.keys(next || {})]);
  for (const peerId of ids) {
    if (peerId === selfId) continue; // never pull our own tracks
    const p = (prev && prev[peerId]) || {};
    const n = (next && next[peerId]) || {};
    for (const kind of kinds) {
      const before = p[kind] || null;
      const after = n[kind] || null;
      if (before === after) continue;
      // A changed/removed track must be dropped first (the old subscription is
      // stale); a changed/new track must then be pulled.
      if (before) toDrop.push({ peerId, kind });
      if (after) toPull.push({ peerId, kind, trackId: after, session: n.session });
    }
  }
  return { toPull, toDrop };
}

// --- Live SFU calls (thin wrappers over the Worker proxy) --------------------
// These hit our Worker, which adds the Realtime app token server-side. Built and
// verified against real Cloudflare Realtime once app credentials are available.

export async function newSession(apiBase) {
  const res = await fetch(`${apiBase}/realtime/sessions/new`, { method: 'POST' });
  if (!res.ok) throw new Error(`session create failed: ${res.status}`);
  return res.json(); // { sessionId }
}
