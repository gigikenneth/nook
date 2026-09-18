import { useEffect, useRef, useState } from 'react';

// A pop-out timer showing just the countdown, so it stays visible when you
// switch tabs or minimise. Three backends, best-first:
//   - Document Picture-in-Picture (Chrome/Edge): a true always-on-top mini window.
//   - Video Picture-in-Picture (Safari, Firefox): the countdown is drawn onto a
//     canvas and streamed into a <video> put into the OS PiP tile. Unlike a plain
//     popup, the macOS PiP tile floats above *other apps*, not just other tabs —
//     which is what makes it stay put on Safari (#48).
//   - A plain popup window (last resort): visible across tabs, not always-on-top.
// All three need a user gesture, so this is wired to a button.
const PHASE_LABEL = { greet: 'Greet', focus: 'Focus', regroup: 'Regroup' };

const clock = (endsAt) => {
  if (!endsAt) return '--:--';
  const rem = Math.max(0, endsAt - Date.now());
  return `${String(Math.floor(rem / 60000)).padStart(2, '0')}:${String(Math.floor((rem % 60000) / 1000)).padStart(2, '0')}`;
};

export function usePipTimer() {
  const hasDocPip = typeof window !== 'undefined' && 'documentPictureInPicture' in window;
  // Element PiP (Safari/Firefox): the standard API, or Safari's webkit presentation
  // mode. Probe a throwaway <video> for the prefixed method.
  const hasVideoPip = typeof document !== 'undefined' && (
    document.pictureInPictureEnabled ||
    typeof document.createElement('video').webkitSetPresentationMode === 'function'
  );
  const supported = typeof window !== 'undefined';
  const [isOpen, setIsOpen] = useState(false);

  const modeRef = useRef(null);       // 'docpip' | 'popup' | 'video' | null
  const winRef = useRef(null);        // child window (docpip/popup backends)
  const vidRef = useRef(null);        // <video> in the PiP tile (video backend)
  const canvasRef = useRef(null);     // canvas we draw the timer onto (video backend)
  const streamRef = useRef(null);     // canvas capture stream (video backend)
  const drawRef = useRef(null);       // parent-side redraw interval (video backend)
  const pollRef = useRef(null);       // parent-side close watchdog (window backends)
  const dataRef = useRef({ endsAt: null, phase: 'greet' });

  const draw = () => {
    const { endsAt, phase } = dataRef.current;
    if (modeRef.current === 'video') {
      const c = canvasRef.current;
      if (!c) return;
      const g = c.getContext('2d');
      g.fillStyle = '#10124e';
      g.fillRect(0, 0, c.width, c.height);
      g.textAlign = 'center';
      g.fillStyle = 'rgba(255,255,255,.65)';
      g.font = '700 20px system-ui,sans-serif';
      g.fillText((PHASE_LABEL[phase] || '').toUpperCase(), c.width / 2, 56);
      g.fillStyle = '#fff';
      g.font = '800 78px ui-monospace,monospace';
      g.fillText(clock(endsAt), c.width / 2, 138);
      return;
    }
    const w = winRef.current;
    if (!w || !w.document) return;
    const clk = w.document.getElementById('pip-clock');
    const label = w.document.getElementById('pip-label');
    if (!clk || !label) return;
    clk.textContent = clock(endsAt);
    label.textContent = PHASE_LABEL[phase] || '';
  };

  // Push the latest phase/timer in from the component and redraw immediately.
  const setData = (endsAt, phase) => { dataRef.current = { endsAt, phase }; draw(); };

  const stopPoll = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  const stopDraw = () => { if (drawRef.current) { clearInterval(drawRef.current); drawRef.current = null; } };

  const teardown = () => {
    stopPoll();
    stopDraw();
    streamRef.current?.getTracks().forEach((t) => { try { t.stop(); } catch { /* ignore */ } });
    const v = vidRef.current;
    if (v) { try { v.remove(); } catch { /* ignore */ } }
    modeRef.current = null;
    winRef.current = null;
    vidRef.current = null;
    canvasRef.current = null;
    streamRef.current = null;
  };

  // The pop-out went away — closed by the user, the OS, or PiP being taken
  // elsewhere. Sync state so the button flips back and a fresh click can reopen.
  const handleClosed = () => { teardown(); setIsOpen(false); };

  const close = () => {
    const mode = modeRef.current;
    const w = winRef.current;
    const v = vidRef.current;
    teardown();
    setIsOpen(false);
    if (mode === 'video') {
      try {
        if (document.pictureInPictureElement) document.exitPictureInPicture();
        else if (v && v.webkitSetPresentationMode) v.webkitSetPresentationMode('inline');
      } catch { /* already out */ }
    } else if (w) {
      try { w.close(); } catch { /* already closed */ }
    }
  };

  const openWindow = (w, mode) => {
    winRef.current = w;
    modeRef.current = mode;
    w.document.body.style.cssText = 'margin:0;height:100vh;display:grid;place-items:center;background:#10124e;color:#fff;font-family:system-ui,sans-serif;';
    w.document.body.innerHTML =
      '<div style="text-align:center">' +
      '<div id="pip-label" style="font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;opacity:.65;margin-bottom:4px"></div>' +
      '<div id="pip-clock" style="font-family:ui-monospace,monospace;font-size:46px;font-weight:800;letter-spacing:2px">--:--</div>' +
      '</div>';
    draw();
    w.setInterval(draw, 500); // tied to the pop-out window; dies when it closes
    // Detect close from the PARENT: a watchdog polling `.closed` never misfires
    // or permanently disarms; pagehide is an immediate fast path.
    stopPoll();
    pollRef.current = setInterval(() => { if (!winRef.current || winRef.current.closed) handleClosed(); }, 1000);
    w.addEventListener('pagehide', handleClosed);
    setIsOpen(true);
  };

  // Draw the timer onto a canvas, stream it into a <video>, and hand that to the
  // OS PiP tile. Returns false if this browser can't do it (fall back to a popup).
  const openVideo = async () => {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 320; canvas.height = 180;
      canvasRef.current = canvas;
      modeRef.current = 'video';
      draw(); // paint a frame before capture so the tile isn't blank

      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      // Present but invisible; display:none would stop some browsers entering PiP.
      video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:-10px;bottom:-10px;';
      const stream = canvas.captureStream(2); // 2fps is plenty for a clock
      streamRef.current = stream;
      video.srcObject = stream;
      document.body.appendChild(video);
      vidRef.current = video;
      await video.play();

      if (document.pictureInPictureEnabled && video.requestPictureInPicture) {
        await video.requestPictureInPicture();
        video.addEventListener('leavepictureinpicture', handleClosed);
      } else if (video.webkitSetPresentationMode) {
        video.webkitSetPresentationMode('picture-in-picture');
        video.addEventListener('webkitpresentationmodechanged', () => {
          if (video.webkitPresentationMode !== 'picture-in-picture') handleClosed();
        });
      } else {
        teardown();
        return false;
      }
      drawRef.current = setInterval(draw, 500); // redraw the canvas; the stream picks it up
      setIsOpen(true);
      return true;
    } catch {
      teardown();
      return false; // denied / unsupported — caller falls back to a popup
    }
  };

  const open = async () => {
    if (modeRef.current) return;
    if (hasDocPip) {
      try {
        const w = await window.documentPictureInPicture.requestWindow({ width: 200, height: 112 });
        return openWindow(w, 'docpip');
      } catch { return; } // denied / no gesture
    }
    if (hasVideoPip && await openVideo()) return;
    // Popup fallback: a small separate window. Opened from a click, so not blocked.
    const w = window.open('', 'nook-timer', 'width=220,height=132,menubar=no,toolbar=no,location=no,status=no,resizable=yes');
    if (!w) return;
    w.document.title = 'Nook timer';
    openWindow(w, 'popup');
  };

  // Close the pop-out if you leave the room.
  useEffect(() => () => {
    const mode = modeRef.current;
    const w = winRef.current;
    teardown();
    if (mode === 'video') { try { if (document.pictureInPictureElement) document.exitPictureInPicture(); } catch { /* ignore */ } }
    else if (w) { try { w.close(); } catch { /* ignore */ } }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return { supported, isOpen, open, close, setData };
}
