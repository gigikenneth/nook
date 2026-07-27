import { useEffect } from 'react';

// Keep the screen awake while the tab is active (#17), so a phone left open on a
// session doesn't sleep and drop you out of sight. The lock is released whenever
// the tab is hidden, so re-acquire on visibilitychange. Silently does nothing
// where the Screen Wake Lock API is unsupported (some iOS/Firefox).
export function useWakeLock(active) {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return;
    let lock = null;
    let released = false;

    const acquire = async () => {
      if (released || document.visibilityState !== 'visible') return;
      try { lock = await navigator.wakeLock.request('screen'); } catch { /* denied/unsupported */ }
    };
    const onVisible = () => { if (document.visibilityState === 'visible') acquire(); };

    acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      released = true;
      document.removeEventListener('visibilitychange', onVisible);
      try { lock && lock.release(); } catch { /* already gone */ }
    };
  }, [active]);
}
