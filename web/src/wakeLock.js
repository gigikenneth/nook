// Screen wake lock that keeps trying until it holds (#17, #94).
//
// A single request on room entry isn't enough on phones: Safari and installed
// (home-screen) PWAs can refuse a lock that isn't asked for from a tap, and the
// system drops it whenever the app goes to the background. So we ask again on
// every tap/keypress, whenever the page becomes visible, and when the lock is
// released under us, until we hold one.
//
// Where there's no Wake Lock API (older iOS, older Firefox) we fall back to
// NoSleep's muted looping video, retried on taps the same way, since play() can
// need a gesture too.

// Events that grant user activation (HTML spec), so a request made in them is
// allowed even where a request on page load isn't. pointerdown doesn't count for
// touch, touchend does.
const GESTURES = ['click', 'touchend', 'keydown'];

// Start keeping the screen awake. Returns stop(). nav/doc/NoSleep are passed in
// so this runs under node tests with fakes.
export function keepAwake({ nav, doc, NoSleep }) {
  let stopped = false;
  let acquire;
  let release;

  if (nav && nav.wakeLock) {
    let lock = null;
    let pending = false;
    acquire = () => {
      if (stopped || lock || pending || doc.visibilityState !== 'visible') return;
      pending = true;
      nav.wakeLock.request('screen').then((l) => {
        pending = false;
        if (stopped) { l.release().catch(() => {}); return; }
        lock = l;
        // The system lets go when the page hides (or for its own reasons); try
        // straight away, and the next visibility change or tap covers the rest.
        l.addEventListener('release', () => { if (lock === l) { lock = null; acquire(); } });
      }).catch(() => { pending = false; }); // refused: the next tap or visibility change retries
    };
    release = () => { if (lock) { const l = lock; lock = null; l.release().catch(() => {}); } };
  } else {
    let ns;
    try { ns = new NoSleep(); } catch { return () => {}; } // no DOM video support: let it sleep
    // NoSleep's pre-iOS-10 path keeps the screen alive by reloading the page every
    // 15 seconds, and its UA sniff can land an ordinary iPad there. A reload loop
    // would tear down a live session, so on that path we let the screen sleep.
    if (!ns.noSleepVideo) return () => {};
    let pending = false;
    acquire = () => {
      if (stopped || pending || ns.isEnabled) return;
      pending = true;
      ns.enable().then(() => {
        pending = false;
        if (stopped) { try { ns.disable(); } catch { /* already gone */ } }
      }, () => { pending = false; }); // autoplay blocked: the next tap retries
    };
    release = () => { try { ns.disable(); } catch { /* already gone */ } };
  }

  const opts = { capture: true, passive: true };
  for (const g of GESTURES) doc.addEventListener(g, acquire, opts);
  doc.addEventListener('visibilitychange', acquire);
  acquire();

  return () => {
    stopped = true;
    for (const g of GESTURES) doc.removeEventListener(g, acquire, opts);
    doc.removeEventListener('visibilitychange', acquire);
    release();
  };
}
