// The pop-out timer's scene: water fills the whole window from the bottom and
// reaches the top edge exactly when the phase runs out. A rubber duck rides the
// surface, then fades away as the water nears the top. Pure canvas drawing,
// shared by all three pop-out backends (Document PiP, video PiP, popup).

const PHASE_LABEL = { greet: 'Greet', focus: 'Focus', regroup: 'Regroup' };

export const clock = (endsAt, now = Date.now()) => {
  if (!endsAt) return '--:--';
  const rem = Math.max(0, endsAt - now);
  return `${String(Math.floor(rem / 60000)).padStart(2, '0')}:${String(Math.floor((rem % 60000) / 1000)).padStart(2, '0')}`;
};

// How full the window is: 0 at the start of a phase, 1 (top edge) when the timer
// hits zero. No timer running (greet) or no known length = empty.
export const fillOf = (endsAt, totalMs, now = Date.now()) => {
  if (!endsAt || !totalMs) return 0;
  return Math.min(1, Math.max(0, 1 - (endsAt - now) / totalMs));
};

// Height of the water surface at x, for time t (seconds).
const waveY = (x, W, top, amp, t, speed, phase) => top + Math.sin((x / W) * Math.PI * 2 + t * speed + phase) * amp;

function wave(g, W, H, top, amp, t, speed, phase, fill) {
  g.beginPath();
  g.moveTo(0, H);
  for (let x = 0; x <= W; x += 3) g.lineTo(x, waveY(x, W, top, amp, t, speed, phase));
  g.lineTo(W, H);
  g.closePath();
  g.fillStyle = fill;
  g.fill();
}

function duck(g, s) {
  // Drawn facing right around (0, 0) = the waterline under its middle.
  g.fillStyle = '#ffd23f';
  g.beginPath(); g.ellipse(0, -s * 0.18, s * 0.58, s * 0.34, 0, 0, Math.PI * 2); g.fill(); // body
  g.beginPath(); g.moveTo(-s * 0.5, -s * 0.28); g.lineTo(-s * 0.72, -s * 0.52); g.lineTo(-s * 0.36, -s * 0.4); g.closePath(); g.fill(); // tail
  g.beginPath(); g.arc(s * 0.26, -s * 0.6, s * 0.28, 0, Math.PI * 2); g.fill(); // head
  g.fillStyle = '#f2b51c';
  g.beginPath(); g.ellipse(-s * 0.06, -s * 0.2, s * 0.26, s * 0.13, -0.25, 0, Math.PI * 2); g.fill(); // wing
  g.fillStyle = '#ff8a3d';
  g.beginPath(); g.ellipse(s * 0.56, -s * 0.54, s * 0.17, s * 0.08, 0.1, 0, Math.PI * 2); g.fill(); // beak
  g.fillStyle = '#171717';
  g.beginPath(); g.arc(s * 0.33, -s * 0.66, s * 0.05, 0, Math.PI * 2); g.fill(); // eye
  g.fillStyle = '#fff';
  g.beginPath(); g.arc(s * 0.345, -s * 0.675, s * 0.017, 0, Math.PI * 2); g.fill(); // eye glint
}

// How visible the duck is: fully there until the water gets close to the top,
// then it fades out, gone for the last stretch (just water rising to the brim).
export const duckOpacity = (fill) => Math.min(1, Math.max(0, (0.92 - fill) / 0.12));

// Paint one frame. `still` freezes the motion (reduced-motion users) but keeps the
// water level and the duck.
export function drawDuckTimer(g, W, H, { endsAt, phase, totalMs, now = Date.now(), still = false }) {
  const t = still ? 0 : now / 1000;
  const fill = fillOf(endsAt, totalMs, now);
  const amp = H * 0.02;
  // A puddle at the start; the top edge of the window at zero. The window is the glass.
  const top = H - (H * 0.06 + fill * H * 0.94) + (fill >= 1 ? amp : 0);

  g.fillStyle = '#10124e';
  g.fillRect(0, 0, W, H);
  wave(g, W, H, top, amp, t, 1.3, 1.6, 'rgba(41,188,238,.55)'); // back wave, cyan
  wave(g, W, H, top, amp, t, 1.8, 0, '#3e5ad5'); // front wave, Nook blue

  // Countdown, readable over the dark sky and the blue water alike.
  g.textAlign = 'center';
  g.shadowColor = 'rgba(16,18,78,.55)';
  g.shadowBlur = H * 0.04;
  g.fillStyle = 'rgba(255,255,255,.75)';
  g.font = `700 ${Math.round(H * 0.1)}px system-ui,sans-serif`;
  g.fillText(PHASE_LABEL[phase] || '', W / 2, H * 0.3);
  g.fillStyle = '#fff';
  g.font = `800 ${Math.round(H * 0.34)}px ui-monospace,monospace`;
  g.fillText(clock(endsAt, now), W / 2, H * 0.62);
  g.shadowBlur = 0;

  // The duck rides the surface in front of the clock, drifting side to side,
  // facing where it's going and tilting with the waves.
  const alpha = duckOpacity(fill);
  if (alpha > 0) {
    const s = H * 0.17;
    const cx = W / 2 + Math.sin(t * 0.35) * (W / 2 - s);
    const y = waveY(cx, W, top, amp, t, 1.8, 0);
    const slope = (waveY(cx + 2, W, top, amp, t, 1.8, 0) - waveY(cx - 2, W, top, amp, t, 1.8, 0)) / 4;
    g.save();
    g.globalAlpha = alpha;
    g.translate(cx, y + s * 0.12);
    g.rotate(Math.atan(slope) * 0.8);
    g.scale(Math.cos(t * 0.35) >= 0 ? 1 : -1, 1);
    duck(g, s);
    g.restore();
  }
}
