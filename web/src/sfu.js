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
// These hit our Worker, which adds the Realtime app token server-side (the token
// is never in the browser). Bodies/paths mirror the Cloudflare Realtime
// Connection API 1:1; the Worker maps /realtime/<x> -> apps/<appId>/<x>.

async function post(apiBase, path, body) {
  const res = await fetch(`${apiBase}/realtime/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const out = await res.json();
  if (!res.ok || out.errorCode) throw new Error(out.errorDescription || `realtime ${path} ${res.status}`);
  return out;
}

// Create a session by sending our initial offer. Returns { sessionId,
// sessionDescription: <answer> }.
export function newSession(apiBase, offerSdp) {
  return post(apiBase, 'sessions/new', { sessionDescription: { type: 'offer', sdp: offerSdp } });
}

// Publish local tracks: tracks are [{ location:'local', mid, trackName }] plus
// our new offer. Returns { sessionDescription: <answer>, tracks }.
export function pushTracks(apiBase, sessionId, tracks, offerSdp) {
  return post(apiBase, `sessions/${sessionId}/tracks/new`,
    { sessionDescription: { type: 'offer', sdp: offerSdp }, tracks });
}

// Subscribe to remote tracks: [{ location:'remote', sessionId:<owner>, trackName }].
// No local offer — the SFU answers with an offer if renegotiation is needed
// (requiresImmediateRenegotiation + sessionDescription:<offer>).
export function pullTracks(apiBase, sessionId, tracks) {
  return post(apiBase, `sessions/${sessionId}/tracks/new`, { tracks });
}

// Answer the SFU's renegotiation offer (after a pull).
export async function renegotiate(apiBase, sessionId, answerSdp) {
  const res = await fetch(`${apiBase}/realtime/sessions/${sessionId}/renegotiate`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionDescription: { type: 'answer', sdp: answerSdp } }),
  });
  const out = await res.json();
  if (!res.ok || out.errorCode) throw new Error(out.errorDescription || `renegotiate ${res.status}`);
  return out;
}
