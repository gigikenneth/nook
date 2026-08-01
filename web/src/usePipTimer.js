import { useEffect, useRef, useState } from 'react';

// A pop-out timer using the Document Picture-in-Picture API (#34): a tiny
// always-on-top window showing just the countdown, so it stays visible when you
// switch tabs or minimise on desktop. Desktop Chrome/Edge only; browsers require
// a user gesture to open it, so this is wired to a button (not auto-on-minimise).
const PHASE_LABEL = { greet: 'Greet', focus: 'Focus', regroup: 'Regroup' };

export function usePipTimer() {
  const supported = typeof window !== 'undefined' && 'documentPictureInPicture' in window;
  const [isOpen, setIsOpen] = useState(false);
  const winRef = useRef(null);
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

  const close = () => {
    const w = winRef.current;
    winRef.current = null;
    setIsOpen(false);
    if (w) { try { w.close(); } catch { /* already closed */ } }
  };

  const open = async () => {
    if (!supported || winRef.current) return;
    let w;
    try { w = await window.documentPictureInPicture.requestWindow({ width: 200, height: 112 }); }
    catch { return; } // denied / no gesture
    winRef.current = w;
    w.document.body.style.cssText = 'margin:0;height:100vh;display:grid;place-items:center;background:#10124e;color:#fff;font-family:system-ui,sans-serif;';
    w.document.body.innerHTML =
      '<div style="text-align:center">' +
      '<div id="pip-label" style="font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;opacity:.65;margin-bottom:4px"></div>' +
      '<div id="pip-clock" style="font-family:ui-monospace,monospace;font-size:46px;font-weight:800;letter-spacing:2px">--:--</div>' +
      '</div>';
    draw();
    w.setInterval(draw, 500); // tied to the PiP window; dies when it closes
    // The user closing the PiP window (or the browser reclaiming it) fires pagehide.
    w.addEventListener('pagehide', () => { winRef.current = null; setIsOpen(false); }, { once: true });
    setIsOpen(true);
  };

  // Close the pop-out if you leave the room.
  useEffect(() => () => { const w = winRef.current; if (w) { try { w.close(); } catch {} } }, []);

  return { supported, isOpen, open, close, setData };
}
