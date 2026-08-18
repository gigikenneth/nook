// Local JaaS JWT minter for the spike. Signs an RS256 token so we can test an
// 8x8.vc embed with NO user login. Your private key never leaves this machine.
//
// Usage:
//   node scripts/jaas-jwt.mjs <APP_ID> <KEY_ID> <path/to/private-key.pem>
//
// APP_ID  = your JaaS AppID (starts "vpaas-magic-cookie-...")
// KEY_ID  = the Key ID shown next to the API key you generated
// PEM     = the private key file you downloaded from the JaaS console
//
// Prints a JWT valid for 2h, moderator, any room (room: '*'). Paste the printed
// token + your APP_ID back to me for the embed test.
import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';

const [appId, keyId, pemPath] = process.argv.slice(2);
if (!appId || !keyId || !pemPath) {
  console.error('usage: node scripts/jaas-jwt.mjs <APP_ID> <KEY_ID> <private-key.pem>');
  process.exit(1);
}
const key = readFileSync(pemPath, 'utf8');

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = Math.floor(Date.now() / 1000);

const header = { alg: 'RS256', kid: `${appId}/${keyId}`, typ: 'JWT' };
const payload = {
  aud: 'jitsi',
  iss: 'chat',
  sub: appId,
  room: '*',
  exp: now + 7200,
  nbf: now - 10,
  context: {
    user: { name: 'spike-tester', moderator: 'true' },
    features: { livestreaming: 'false', recording: 'false', transcription: 'false', 'outbound-call': 'false' },
  },
};

const signingInput = `${b64(header)}.${b64(payload)}`;
const sig = createSign('RSA-SHA256').update(signingInput).sign(key).toString('base64url');
console.log(`${signingInput}.${sig}`);
