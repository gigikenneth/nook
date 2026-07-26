// Phase chimes, synthesized with the Web Audio API — no audio files to ship or license.
// First call happens after a user gesture (ready/start), so the context can start.
let ctx;

const TUNES = {
  start: [523.25, 659.25, 783.99], // C5 E5 G5, rising — a session begins
  end: [783.99, 587.33, 392.0],    // G5 D5 G4, falling — focus timer done
  regroup: [587.33, 880.0],         // D5 A5, two-note ping — come back
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
