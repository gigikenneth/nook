// Saved lists: name a to-do list you repeat (start of day, weekly review) and pull
// it back into any session later. Kept on this device only, like nook.lastList;
// never sent anywhere. ponytail: whole array rewritten on every change, fine for a
// handful of short lists.
const SAVED_KEY = 'nook.savedLists';
const MAX_LISTS = 30;

export function loadSavedLists() {
  try {
    const l = JSON.parse(localStorage.getItem(SAVED_KEY) || '[]');
    if (!Array.isArray(l)) return [];
    return l
      .filter((s) => s && typeof s.name === 'string' && s.name.trim() && Array.isArray(s.items))
      .map((s) => ({
        name: s.name.trim(),
        items: s.items.filter((t) => typeof t === 'string' && t.trim()),
        usedAt: Number(s.usedAt) || 0,
      }));
  } catch { return []; }
}

function write(lists) {
  try { localStorage.setItem(SAVED_KEY, JSON.stringify(lists.slice(0, MAX_LISTS))); } catch { /* full/blocked */ }
  return lists.slice(0, MAX_LISTS);
}

// Save under a name; the same name (any case) overwrites that list. Newest first.
export function saveList(name, texts) {
  const n = name.trim();
  const items = [...new Set(texts.map((t) => t.trim()).filter(Boolean))];
  const rest = loadSavedLists().filter((s) => s.name.toLowerCase() !== n.toLowerCase());
  return write([{ name: n, items, usedAt: 0 }, ...rest]);
}

export function deleteList(name) {
  return write(loadSavedLists().filter((s) => s.name !== name));
}

export function markUsed(name, now = Date.now()) {
  return write(loadSavedLists().map((s) => (s.name === name ? { ...s, usedAt: now } : s)));
}

// "used today" / "used yesterday" / "used 4 days ago" / "not used yet"
export function usedLabel(usedAt, now = Date.now()) {
  if (!usedAt) return 'not used yet';
  const day = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const days = Math.round((day(now) - day(usedAt)) / 86400000);
  if (days <= 0) return 'used today';
  if (days === 1) return 'used yesterday';
  return `used ${days} days ago`;
}
