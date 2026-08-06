// Pure mesh-negotiation helpers, kept out of useRoom.js so they're testable
// without a browser (no RTCPeerConnection).

// Should we re-send a renegotiation offer? Only when we're still waiting for the
// answer — stuck in 'have-local-offer' — and under the retry cap. Once the
// answer applied (back to 'stable'), or a colliding offer moved us elsewhere, or
// the connection closed, we stop. This is the recovery path for an offer that
// was lost: a glare collision the peer dropped, or a signal that never arrived,
// which otherwise leaves a live connection silently missing its audio track
// (#68). The cap also stops it from becoming an offer storm.
export function shouldReoffer(signalingState, attempt, max) {
  return signalingState === 'have-local-offer' && attempt < max;
}
