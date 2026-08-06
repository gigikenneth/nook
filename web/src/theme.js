// Manual light/dark theme, remembered per-device. Default light (today's look).
// The theme is a `data-theme` attribute on <html>; styles.css keys the dark
// palette off `html[data-theme="dark"]`. An inline script in index.html applies
// the saved value before first paint (no flash) — this module owns changes after
// the app mounts. Theme is device-local: never sent to peers or the server.
const KEY = 'nook.theme';

// Pure: the opposite theme. The one bit of logic worth a test.
export function nextTheme(t) {
  return t === 'dark' ? 'light' : 'dark';
}

export function getTheme() {
  try {
    return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light'; // storage blocked → light
  }
}

// Reflect the theme onto <html>. Light = no attribute (keeps the default styles).
export function applyTheme(t, root = document.documentElement) {
  if (t === 'dark') root.setAttribute('data-theme', 'dark');
  else root.removeAttribute('data-theme');
}

export function setTheme(t) {
  try { localStorage.setItem(KEY, t); } catch { /* blocked — applies for the session only */ }
  applyTheme(t);
  return t;
}

export function toggleTheme() {
  return setTheme(nextTheme(getTheme()));
}
