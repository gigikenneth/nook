// Your most recent to-do list, kept on this device so closing the tab by
// mistake doesn't lose it (#129). The room's own copy is per-tab (sessionStorage);
// this one outlives the tab and is offered back next time you join. Never sent
// anywhere. ponytail: one list, last write wins across tabs.
const LAST_LIST_KEY = 'nook.lastList';

export function loadLastList() {
  try {
    const l = JSON.parse(localStorage.getItem(LAST_LIST_KEY) || '[]');
    return Array.isArray(l) ? l.filter((t) => t && typeof t.text === 'string' && t.text.trim()) : [];
  } catch { return []; }
}

export function saveLastList(tasks) {
  try { localStorage.setItem(LAST_LIST_KEY, JSON.stringify(tasks.map((t) => ({ text: t.text, done: !!t.done })))); } catch { /* ignore */ }
}
