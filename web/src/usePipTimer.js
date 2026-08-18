import { useEffect, useRef, useState } from 'react';

// A pop-out timer showing just the countdown, so it stays visible when you
// switch tabs or minimise on desktop (#34, #48). Two backends:
//   - Document Picture-in-Picture (Chrome/Edge): a true always-on-top mini window.
//   - A plain popup window (everyone else, incl. Safari, which has no Document-PiP):
//     a separate window that stays visible across tabs, just not always-on-top.
// Both need a user gesture, so this is wired to a button (not auto-on-minimise).
const PHASE_LABEL = { greet: 'Greet', focus: 'Focus', regroup: 'Regroup' };

export function usePipTimer() {
  const hasDocPip = typeof window !== 'undefined' && 'documentPictureInPicture' in window;
  // Pop-out works everywhere now: Document-PiP where present, a popup window
  // otherwise. window.open is universal, so the button always shows.
  const supported = typeof window !== 'undefined';
  const [isOpen, setIsOpen] = useState(false);
  const winRef = useRef(null);
  const pollRef = useRef(null); // parent-side watchdog interval id
  const dataRef = useRef({ endsAt: null, phase: 'greet' }); // latest values for the redraw loop

  const draw = () => {
    const w = winRef.current;
    if (!w || !w.document) return;
    const clock = w.document.getElementById('pip-clock');
    const label = w.document.getElementById('pip-label');
    if (!clock || !label) return;
    const { endsAt, phase } = dataRef.current;
    if (endsAt) {
      const rem = Math.max(0, endsAt - Date.now());
      clock.textContent = `${String(Math.floor(rem / 60000)).padStart(2, '0')}:${String(Math.floor((rem % 60000) / 1000)).padStart(2, '0')}`;
    } else {
      clock.textContent = '--:--';
    }
    label.textContent = PHASE_LABEL[phase] || '';
  };

  // Push the latest phase/timer in from the component and redraw immediately.
  const setData = (endsAt, phase) => { dataRef.current = { endsAt, phase }; draw(); };

  const stopPoll = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };

  // The window went away — closed by the user, the OS, or the browser reclaiming
  // it (or a single PiP slot being taken elsewhere). Sync our state so the button
  // flips back to "Pop out timer" and a fresh click can reopen it.
  const handleClosed = () => { stopPoll(); winRef.current = null; setIsOpen(false); };

  const close = () => {
    stopPoll();
    const w = winRef.current;
    winRef.current = null;
    setIsOpen(false);
    if (w) { try { w.close(); } catch { /* already closed */ } }
  };

  const open = async () => {
    if (winRef.current) return;
    let w;
    if (hasDocPip) {
      try { w = await window.documentPictureInPicture.requestWindow({ width: 200, height: 112 }); }
      catch { return; } // denied / no gesture
    } else {
      // Popup fallback (Safari et al.): a small separate window. Opened from a
      // click, so it isn't popup-blocked. Returns null if the browser blocks it.
      w = window.open('', 'nook-timer', 'width=220,height=132,menubar=no,toolbar=no,location=no,status=no,resizable=yes');
      if (!w) return;
      w.document.title = 'Nook timer';
    }
    winRef.current = w;
    w.document.body.style.cssText = 'margin:0;height:100vh;display:grid;place-items:center;background:#10124e;color:#fff;font-family:system-ui,sans-serif;';
    w.document.body.innerHTML =
      '<div style="text-align:center">' +
      '<div id="pip-label" style="font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;opacity:.65;margin-bottom:4px"></div>' +
      '<div id="pip-clock" style="font-family:ui-monospace,monospace;font-size:46px;font-weight:800;letter-spacing:2px">--:--</div>' +
      '</div>';
    draw();
    w.setInterval(draw, 500); // tied to the pop-out window; dies when it closes
    // Detect the window closing from the PARENT, robustly. A one-shot `pagehide`
    // could misfire (marking us closed while the window lives) or be missed; a
    // watchdog polling `.closed` covers both Document-PiP and popup windows and
    // never permanently disarms. pagehide stays as an immediate fast path.
    stopPoll();
    pollRef.current = setInterval(() => { if (!winRef.current || winRef.current.closed) handleClosed(); }, 1000);
    w.addEventListener('pagehide', handleClosed);
    setIsOpen(true);
  };

  // Close the pop-out if you leave the room.
  useEffect(() => () => { stopPoll(); const w = winRef.current; if (w) { try { w.close(); } catch {} } }, []);

  return { supported, isOpen, open, close, setData };
}
