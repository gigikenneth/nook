// On-device identity + remembered prefs, both in localStorage (survives tab
// close and future visits — the persistent sibling of the per-tab `cid`).
// See docs/superpowers/specs/2026-08-02-on-device-id-design.md.
//
// `did` is a random, anonymous per-browser id. It never leaves for other
// clients — it goes only to our own server on join, to recognise a returning
// browser (a full tab close, not just a refresh). No account, no PII.
//
// Honest ceiling: clearing storage / incognito / another browser = a fresh
// `did`. Stops casual repeat friction; not a hard wall. ponytail: that's the
// whole point of the "cheap wins" scope — no server-stored relational state.

const DID_KEY = 'nook.did';
const PREFS_KEY = 'nook.prefs';

// Create-once. Falls back to a per-call random id if localStorage is blocked
// (private mode) — the app still works, it just won't remember across visits.
export function getDid() {
  try {
    let d = localStorage.getItem(DID_KEY);
    if (!d) { d = crypto.randomUUID(); localStorage.setItem(DID_KEY, d); }
    return d;
  } catch { return crypto.randomUUID(); }
}

// Remembered name + camera preference so a regular doesn't re-type on return.
export function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null');
    if (p && typeof p === 'object') return { name: p.name || '', camPref: p.camPref ?? null };
  } catch { /* ignore */ }
  return { name: '', camPref: null };
}

export function savePrefs({ name, camPref }) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ name: (name || '').trim(), camPref: camPref ?? null }));
  } catch { /* ignore */ }
}

// Your ignore list, as [{ did, name }]. The server is authoritative for
// enforcement (it holds the mutual, durable block graph); this local cache just
// keeps names for the un-ignore UI. did = the one id per blocked person the
// server hands back when you block them.
const BLOCKS_KEY = 'nook.blocks';

export function loadBlocks() {
  try {
    const b = JSON.parse(localStorage.getItem(BLOCKS_KEY) || '[]');
    return Array.isArray(b) ? b.filter((x) => x && x.did) : [];
  } catch { return []; }
}

export function addBlock(did, name) {
  const list = loadBlocks();
  if (did && !list.some((x) => x.did === did)) list.push({ did, name: name || 'Someone' });
  try { localStorage.setItem(BLOCKS_KEY, JSON.stringify(list)); } catch { /* ignore */ }
  return list;
}

export function removeBlock(did) {
  const list = loadBlocks().filter((x) => x.did !== did);
  try { localStorage.setItem(BLOCKS_KEY, JSON.stringify(list)); } catch { /* ignore */ }
  return list;
}
