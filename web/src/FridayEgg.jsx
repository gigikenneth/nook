import { useEffect, useState } from 'react';

// Easter egg: on Fridays (visitor's local day) a banner pops up with a burst of
// confetti and a link to the song. Dismissing hides it until next Friday.
// Also pops up live when the clock ticks over into Friday with the tab open.
// ?friday in the URL forces it on, for previewing on other days.
const SONG = 'https://youtu.be/U6n2NcJ7rLc?t=53';
const COLORS = ['var(--pink)', 'var(--orange)', 'var(--purple)', 'var(--gold)', 'var(--pink-deep)'];

function todayKey() {
  const d = new Date();
  return `nook.friday.${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function fridayNotDismissed() {
  if (new Date().getDay() !== 5) return false;
  try { return !localStorage.getItem(todayKey()); } catch { return true; }
}

function shouldShow() {
  return new URLSearchParams(window.location.search).has('friday') || fridayNotDismissed();
}

export function FridayEgg() {
  const [open, setOpen] = useState(shouldShow);
  // ponytail: a once-a-minute check, not a midnight setTimeout, so laptop sleep
  // and background-tab throttling can't make it miss the rollover.
  useEffect(() => {
    if (open) return;
    const id = setInterval(() => { if (fridayNotDismissed()) setOpen(true); }, 60_000);
    return () => clearInterval(id);
  }, [open]);
  if (!open) return null;
  function close() {
    try { localStorage.setItem(todayKey(), '1'); } catch { /* private window: shows again next load */ }
    setOpen(false);
  }
  return (
    <>
      <div className="confetti" aria-hidden="true">
        {Array.from({ length: 40 }, (_, i) => (
          <span key={i} style={{
            left: `${(i * 37) % 100}%`,
            background: COLORS[i % COLORS.length],
            animationDelay: `${(i % 10) * 0.12}s`,
            animationDuration: `${2.4 + (i % 5) * 0.4}s`,
          }} />
        ))}
      </div>
      <div className="friday-toast" role="status">
        <span>🎉 It's Friday! Gotta get down on Friday</span>
        <a className="primary sm" href={SONG} target="_blank" rel="noopener noreferrer">Play the song</a>
        <button className="ghost x" onClick={close} aria-label="Dismiss">×</button>
      </div>
    </>
  );
}
