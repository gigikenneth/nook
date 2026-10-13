// The pop-out timer's scene: water fills the window from the bottom as the phase
// runs out, with a rubber duck bobbing on top. Pure canvas drawing, shared by all
// three pop-out backends (Document PiP, video PiP, popup).

const PHASE_LABEL = { greet: 'Greet', focus: 'Focus', regroup: 'Regroup' };

export const clock = (endsAt, now = Date.now()) => {
  if (!endsAt) return '--:--';
  const rem = Math.max(0, endsAt - now);
  return `${String(Math.floor(rem / 60000)).padStart(2, '0')}:${String(Math.floor((rem % 60000) / 1000)).padStart(2, '0')}`;
};

// How full the tub is: 0 at the start of a phase, 1 when the timer hits zero.
// No timer running (greet) or no known length = empty.
export const fillOf = (endsAt, totalMs, now = Date.now()) => {
  if (!endsAt || !totalMs) return 0;
  return Math.min(1, Math.max(0, 1 - (endsAt - now) / totalMs));
};

const MIN_LEVEL = 0.1;  // a puddle, so the duck has somewhere to sit at the start
const MAX_LEVEL = 0.74; // full: as high as it goes with the duck's head still in the window

// Height of the water surface at x, for time t (seconds).
const waveY = (x, W, top, amp, t, speed, phase) => top + Math.sin((x / W) * Math.PI * 2 + t * speed + phase) * amp;

function wave(g, W, H, top, amp, t, speed, phase, fill) {
  g.beginPath();
  g.moveTo(0, H);
  for (let x = 0; x <= W; x += 4) g.lineTo(x, waveY(x, W, top, amp, t, speed, phase));
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

// Paint one frame. `still` freezes the motion (reduced-motion users) but keeps the
// water level and the duck.
export function drawDuckTimer(g, W, H, { endsAt, phase, totalMs, now = Date.now(), still = false }) {
  const t = still ? 0 : now / 1000;
  const level = MIN_LEVEL + fillOf(endsAt, totalMs, now) * (MAX_LEVEL - MIN_LEVEL);
  const top = H * (1 - level);
  const amp = H * 0.025;

  g.fillStyle = '#10124e';
  g.fillRect(0, 0, W, H);

  wave(g, W, H, top, amp, t, 1.3, 1.6, 'rgba(41,188,238,.45)'); // back wave, cyan

  // The duck drifts side to side, turns to face where it's going, and bobs and
  // tilts with the front wave under it.
  const s = Math.min(W, H) * 0.24;
  const drift = Math.sin(t * 0.35);
  const cx = W / 2 + drift * (W / 2 - s);
  const facing = Math.cos(t * 0.35) >= 0 ? 1 : -1;
  const y = waveY(cx, W, top, amp, t, 1.8, 0);
  const slope = (waveY(cx + 4, W, top, amp, t, 1.8, 0) - waveY(cx - 4, W, top, amp, t, 1.8, 0)) / 8;
  g.save();
  g.translate(cx, y + s * 0.12);
  g.rotate(Math.atan(slope) * 0.8);
  g.scale(facing, 1);
  duck(g, s);
  g.restore();

  wave(g, W, H, top, amp, t, 1.8, 0, '#3e5ad5'); // front wave, Nook blue, solid so the duck sits in the water

  // Text on top of everything, readable over the dark sky and the blue water alike.
  g.textAlign = 'center';
  g.shadowColor = 'rgba(16,18,78,.6)';
  g.shadowBlur = H * 0.04;
  g.fillStyle = 'rgba(255,255,255,.75)';
  g.font = `700 ${Math.round(H * 0.11)}px system-ui,sans-serif`;
  g.fillText(PHASE_LABEL[phase] || '', W / 2, H * 0.24);
  g.fillStyle = '#fff';
  g.font = `800 ${Math.round(H * 0.34)}px ui-monospace,monospace`;
  g.fillText(clock(endsAt, now), W / 2, H * 0.56);
  g.shadowBlur = 0;
}
