import { useEffect } from 'react';
import NoSleep from 'nosleep.js';

// Keep the screen awake while you're in a room (#17), so a phone left open on a
// session doesn't sleep and drop you out of sight.
//
// NoSleep uses the Screen Wake Lock API where it exists and falls back to a muted
// looping inline video where it doesn't (#94: Firefox, iOS before 16.4), and
// re-acquires the lock itself when the tab becomes visible again.
export function useWakeLock(active) {
  useEffect(() => {
    if (!active) return;
    let ns;
    try { ns = new NoSleep(); } catch { return; } // no DOM video support: let it sleep
    // NoSleep's pre-iOS-10 path keeps the screen alive by reloading the page every
    // 15 seconds, and its UA sniff can land an ordinary iPad there. A reload loop
    // would tear down a live session, so if we're on that path (no native lock and
    // no video element) we do nothing and let the screen sleep as before.
    if (!('wakeLock' in navigator) && !ns.noSleepVideo) return;
    // Rejects when the browser refuses (lock denied, autoplay blocked). Nothing to
    // recover: the screen just sleeps as it would have without us.
    ns.enable().catch(() => {});
    return () => { try { ns.disable(); } catch { /* already gone */ } };
  }, [active]);
}
