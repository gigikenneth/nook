import { useEffect } from 'react';
import NoSleep from 'nosleep.js';
import { keepAwake } from './wakeLock';

// Keep the screen awake while you're in a room (#17), so a phone left open on a
// session doesn't sleep and drop you out of sight. See wakeLock.js for why this
// retries instead of asking once.
export function useWakeLock(active) {
  useEffect(() => {
    if (!active) return;
    return keepAwake({ nav: navigator, doc: document, NoSleep });
  }, [active]);
}
