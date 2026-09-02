// Mint a JaaS (8x8.vc) JWT so a Nook visitor joins the embedded Jitsi call with
// NO login. The token is signed server-side with the app's RSA private key
// (Worker secret); the visitor authenticates via the token, never an account.
//
// Secrets (set with `wrangler secret put`):
//   JAAS_APP_ID       vpaas-magic-cookie-...   (also public; sent to the client)
//   JAAS_KID          the API key id
//   JAAS_PRIVATE_KEY  the downloaded PKCS8 PEM private key
//
// moderator:'true' for everyone — a <=4 coworking room has no host/guest split
// in Jitsi; Nook does its own room gating (max-4, kick) over the WebSocket.

function pemToArrayBuffer(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

function b64url(bytes) {
  let bin = '';
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const b64urlStr = (s) => b64url(new TextEncoder().encode(s));

// Stable, collision-free Jitsi room name from Nook's room id (any characters).
export async function jitsiRoomName(roomId) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(roomId)));
  const hex = [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `nook-${hex.slice(0, 40)}`;
}

export async function signJaasToken(env, { room, name, id }) {
  const appId = env.JAAS_APP_ID;
  const key = await crypto.subtle.importKey(
    'pkcs8', pemToArrayBuffer(env.JAAS_PRIVATE_KEY),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'],
  );
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', kid: `${appId}/${env.JAAS_KID}`, typ: 'JWT' };
  const payload = {
    aud: 'jitsi', iss: 'chat', sub: appId, room,
    exp: now + 7200, nbf: now - 10,
    context: {
      // Stable per-visitor id (Nook's localStorage device id) so JaaS counts a
      // recurring human as ONE monthly-active user across reconnects/hibernation
      // wakes, instead of a fresh endpoint (= fresh MAU) every rejoin.
      user: { id: (id || undefined), name: (name || 'Guest').slice(0, 50), moderator: 'true' },
      features: { livestreaming: 'false', recording: 'false', transcription: 'false', 'outbound-call': 'false' },
    },
  };
  const signingInput = `${b64urlStr(JSON.stringify(header))}.${b64urlStr(JSON.stringify(payload))}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64url(sig)}`;
}
