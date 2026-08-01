// Phase chimes, synthesized with the Web Audio API — no audio files to ship or license.
// First call happens after a user gesture (ready/start), so the context can start.
let ctx;

const TUNES = {
  start: [523.25, 659.25, 783.99], // C5 E5 G5, rising — a session begins
  // Focus is over ("the groove has ended") — a longer 5-note descending resolve,
  // deliberately more noticeable than the short chimes so it catches attention.
  end: [783.99, 659.25, 523.25, 392.0, 261.63], // G5 E5 C5 G4 C4
  regroup: [587.33, 880.0],         // D5 A5, two-note ping — come back
  warn: [698.46, 587.33],           // F5 D5, soft two-note — 5 min left, wrap up
};

export function chime(kind) {
  const notes = TUNES[kind];
  if (!notes) return;
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime;
    notes.forEach((f, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = f;
      const t0 = now + i * 0.16;
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(0.22, t0 + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.5);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.55);
    });
  } catch {
    // Audio not available — silent is fine.
  }
}
