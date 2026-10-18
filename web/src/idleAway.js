// Away from the computer. Two ways in: you tap "Be right back", or (Chrome/Edge,
// with permission) the Idle Detection API sees no keyboard/mouse anywhere on the
// computer for IDLE_MS, or a locked screen. The room also marks a socket that
// stops pinging (a laptop asleep in the room) on the server side; see sweepQuiet
// in RoomDO.js. Safari/Firefox get the button and the server check.

export const IDLE_MS = 5 * 60000;

// Away state: null (here) or { at: local ms you went away, manual }. A manual
// BRB only clears on "I'm back" (the mouse moves when you tap it); an idle away
// clears as soon as you're active again.
export function nextAway(s, ev, now) {
  if (ev.type === 'brb') return { at: s ? s.at : now, manual: true };
  if (ev.type === 'back') return null;
  if (ev.type === 'idle') {
    if (ev.away) return s || { at: now - (ev.ago || 0), manual: false };
    return s && s.manual ? s : null;
  }
  return s;
}

// "away", "away 12 min", "away 1 hr".
export function awayLabel(since, now) {
  const min = Math.max(0, Math.floor((now - since) / 60000));
  if (min < 1) return 'away';
  if (min < 60) return `away ${min} min`;
  return `away ${Math.floor(min / 60)} hr`;
}

const PREF_KEY = 'nook.autoAway';
export const idleSupported = () => typeof window !== 'undefined' && 'IdleDetector' in window;
export function autoAwayPref() { try { return localStorage.getItem(PREF_KEY) === 'on'; } catch { return false; } }
export function setAutoAwayPref(on) { try { localStorage.setItem(PREF_KEY, on ? 'on' : 'off'); } catch { /* ignore */ } }

// Must run from a click: the browser only shows the permission prompt for a user gesture.
export async function askIdlePermission() {
  try { return (await window.IdleDetector.requestPermission()) === 'granted'; } catch { return false; }
}
export async function idleGranted() {
  try { return (await navigator.permissions.query({ name: 'idle-detection' })).state === 'granted'; } catch { return false; }
}

// Calls onChange({ away, ago }) on every idle/active or lock/unlock flip.
// Returns a stop function.
export function watchIdle(onChange) {
  const ctrl = new AbortController();
  const d = new window.IdleDetector();
  d.addEventListener('change', () => {
    const idle = d.userState === 'idle';
    onChange({ away: idle || d.screenState === 'locked', ago: idle ? IDLE_MS : 0 });
  });
  d.start({ threshold: IDLE_MS, signal: ctrl.signal }).catch(() => { /* denied or unsupported: button only */ });
  return () => ctrl.abort();
}
