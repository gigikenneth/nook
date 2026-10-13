// Big Smile avatars (Ashley Seo, CC BY 4.0, via DiceBear), pre-rendered into
// public/avatars/0..23.svg. See public/avatars/ATTRIBUTION.txt.
export const AVATAR_COUNT = 24;

const hash = (s) => { let h = 0; for (const c of String(s || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };

// Is this a real pick? Anything else (old clients, junk) is treated as no pick.
export const validAv = (av) => Number.isInteger(av) && av >= 0 && av < AVATAR_COUNT;

// The avatar to draw: their pick, or a stable stand-in from a seed (the device
// id for your own default, the name for someone on an older client).
export const avatarOf = (av, seed) => (validAv(av) ? av : hash(seed) % AVATAR_COUNT);
export const avatarSrc = (av, seed) => `/avatars/${avatarOf(av, seed)}.svg`;
