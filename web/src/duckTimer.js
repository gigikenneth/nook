// The pop-out timer's scene: the countdown on top and a little clawfoot bathtub
// below that fills to the rim as the phase runs out, with a rubber duck riding
// the water up. Pure canvas drawing, shared by all three pop-out backends
// (Document PiP, video PiP, popup).

const PHASE_LABEL = { greet: 'Greet', focus: 'Focus', regroup: 'Regroup' };

export const clock = (endsAt, now = Date.now()) => {
  if (!endsAt) return '--:--';
  const rem = Math.max(0, endsAt - now);
  return `${String(Math.floor(rem / 60000)).padStart(2, '0')}:${String(Math.floor((rem % 60000) / 1000)).padStart(2, '0')}`;
};

// How full the tub is: 0 at the start of a phase, 1 (brim) when the timer hits
// zero. No timer running (greet) or no known length = empty.
export const fillOf = (endsAt, totalMs, now = Date.now()) => {
  if (!endsAt || !totalMs) return 0;
  return Math.min(1, Math.max(0, 1 - (endsAt - now) / totalMs));
};

const TUB = '#e8ebf4'; // enamel, Nook's pale blue-white

// Height of the water surface at x (x0..x0+w is the tub), for time t (seconds).
const waveY = (x, x0, w, top, amp, t, speed, phase) => top + Math.sin(((x - x0) / w) * Math.PI * 2 + t * speed + phase) * amp;

function wave(g, x0, w, bottom, top, amp, t, speed, phase, fill) {
  g.beginPath();
  g.moveTo(x0, bottom);
  for (let x = x0; x <= x0 + w; x += 2) g.lineTo(x, waveY(x, x0, w, top, amp, t, speed, phase));
  g.lineTo(x0 + w, bottom);
  g.closePath();
  g.fillStyle = fill;
  g.fill();
}

// The tub's inside: flat rim along the top, round-cornered bottom. Appends to
// the current path (no beginPath) so it can be combined into a clip.
function tubPath(g, x, y, w, h, r) {
  g.moveTo(x, y);
  g.lineTo(x, y + h - r);
  g.quadraticCurveTo(x, y + h, x + r, y + h);
  g.lineTo(x + w - r, y + h);
  g.quadraticCurveTo(x + w, y + h, x + w, y + h - r);
  g.lineTo(x + w, y);
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

  g.fillStyle = '#10124e';
  g.fillRect(0, 0, W, H);

  // Countdown up top.
  g.textAlign = 'center';
  g.fillStyle = 'rgba(255,255,255,.75)';
  g.font = `700 ${Math.round(H * 0.1)}px system-ui,sans-serif`;
  g.fillText(PHASE_LABEL[phase] || '', W / 2, H * 0.17);
  g.fillStyle = '#fff';
  g.font = `800 ${Math.round(H * 0.26)}px ui-monospace,monospace`;
  g.fillText(clock(endsAt, now), W / 2, H * 0.42);

  // The tub along the bottom. The water starts as a puddle and reaches the rim
  // exactly when the timer does.
  const x = W * 0.14, y = H * 0.6, w = W * 0.72, h = H * 0.27, r = h * 0.6;
  const level = y + h - h * 0.06 - fillOf(endsAt, totalMs, now) * h * 0.92;
  const amp = H * 0.01;

  g.fillStyle = TUB; // clawfeet
  for (const fx of [x + w * 0.14, x + w * 0.86]) { g.beginPath(); g.ellipse(fx, y + h + H * 0.03, W * 0.025, H * 0.035, 0, 0, Math.PI * 2); g.fill(); }
  g.fillStyle = 'rgba(255,255,255,.08)'; // inside of the tub
  g.beginPath(); tubPath(g, x, y, w, h, r); g.closePath(); g.fill();

  // Water clipped to the tub, plus the open air above the rim so the duck can
  // sit up out of a full tub.
  g.save();
  g.beginPath(); g.rect(0, 0, W, y); tubPath(g, x, y, w, h, r); g.closePath(); g.clip();
  wave(g, x, w, y + h, level, amp, t, 1.3, 1.6, 'rgba(41,188,238,.55)'); // back wave, cyan
  // The duck drifts end to end, turns to face where it's going, and bobs and
  // tilts with the front wave under it.
  const s = H * 0.15;
  const cx = x + w / 2 + Math.sin(t * 0.4) * (w / 2 - s * 1.1);
  const yy = waveY(cx, x, w, level, amp, t, 1.8, 0);
  const slope = (waveY(cx + 2, x, w, level, amp, t, 1.8, 0) - waveY(cx - 2, x, w, level, amp, t, 1.8, 0)) / 4;
  g.save();
  g.translate(cx, yy + s * 0.12);
  g.rotate(Math.atan(slope) * 0.8);
  g.scale(Math.cos(t * 0.4) >= 0 ? 1 : -1, 1);
  duck(g, s);
  g.restore();
  wave(g, x, w, y + h, level, amp, t, 1.8, 0, '#3e5ad5'); // front wave, Nook blue, solid so the duck sits in the water
  g.restore();

  // Enamel rim and sides on top, so the water reads as inside the tub.
  g.strokeStyle = TUB;
  g.lineWidth = H * 0.025;
  g.beginPath(); tubPath(g, x, y, w, h, r); g.stroke();
  g.lineCap = 'round';
  g.beginPath(); g.moveTo(x - W * 0.03, y); g.lineTo(x + w + W * 0.03, y); g.stroke();
  g.lineCap = 'butt';
}
