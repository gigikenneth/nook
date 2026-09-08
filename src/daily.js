// Create-or-return a PUBLIC Daily.co room for a Nook room. Used only as the
// backup when JaaS is over its free cap. No token: public rooms join by URL,
// which keeps Nook login-free — and the name is the same unguessable SHA-256
// hash we use for the JaaS room, so only people already in this Nook room know
// it. Rooms self-expire so we don't accumulate them.
//
// Secret (wrangler secret put):  DAILY_API_KEY
// Var (wrangler.toml):           DAILY_DOMAIN   e.g. nook.daily.co
import { jitsiRoomName } from './jaas.js';

export const dailyUrl = (domain, roomName) => `https://${domain}/${roomName}`;

export async function dailyRoomUrl(env, roomId) {
  const name = await jitsiRoomName(roomId); // same stable hash as the JaaS room
  const url = dailyUrl(env.DAILY_DOMAIN, name);
  const exp = Math.floor(Date.now() / 1000) + 2 * 3600; // auto-clean after 2h
  const r = await fetch('https://api.daily.co/v1/rooms', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.DAILY_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name,
      privacy: 'public',
      properties: { exp, enable_prejoin_ui: false, start_video_off: true, start_audio_off: true },
    }),
  });
  if (r.ok) return url; // 200 = created
  // A name collision means the room already exists (not expired yet) — reuse it.
  if (r.status === 400) {
    const body = await r.json().catch(() => ({}));
    if (String(body.info || body.error || '').includes('already exists')) return url;
  }
  throw new Error(`daily ${r.status}`);
}
