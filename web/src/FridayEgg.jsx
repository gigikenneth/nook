import { useEffect, useState } from 'react';

// Easter egg: on Fridays (visitor's local day) a banner pops up with a burst of
// confetti and a link to the song. Minimize tucks it into a corner bubble that
// pops it back out; × hides it until next Friday.
// Also pops up live when the clock ticks over into Friday with the tab open.
// ?friday in the URL forces it on, for previewing on other days.
const SONG = 'https://youtu.be/U6n2NcJ7rLc?t=53';
const COLORS = ['var(--pink)', 'var(--orange)', 'var(--purple)', 'var(--gold)', 'var(--pink-deep)'];

function todayKey() {
  const d = new Date();
  return `nook.friday.${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

// Today's state: 'open' (banner), 'min' (confetti bubble in the corner) or
// 'closed'. Saved per date so it resets next Friday.
function fridayState() {
  if (new Date().getDay() !== 5) return 'closed';
  try {
    const v = localStorage.getItem(todayKey());
    // Old '1' (closed before minimize existed) counts as unseen, so they get the new choice.
    return v === 'closed' || v === 'min' ? v : 'open';
  } catch { return 'open'; }
}

function initialState() {
  return new URLSearchParams(window.location.search).has('friday') ? 'open' : fridayState();
}

export function FridayEgg() {
  const [state, setState] = useState(initialState);
  // ponytail: a once-a-minute check, not a midnight setTimeout, so laptop sleep
  // and background-tab throttling can't make it miss the rollover.
  useEffect(() => {
    if (state !== 'closed') return;
    const id = setInterval(() => { const s = fridayState(); if (s !== 'closed') setState(s); }, 60_000);
    return () => clearInterval(id);
  }, [state]);
  function set(next) {
    try { localStorage.setItem(todayKey(), next); } catch { /* private window: resets next load */ }
    setState(next);
  }
  if (state === 'closed') return null;
  if (state === 'min') {
    return (
      <button className="friday-bubble" onClick={() => set('open')} aria-label="It's Friday! Show the banner" title="It's Friday!">
        🎉
      </button>
    );
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
        <button className="ghost x" onClick={() => set('min')} aria-label="Minimize" title="Minimize">–</button>
        <button className="ghost x" onClick={() => set('closed')} aria-label="Close until next Friday" title="Close until next Friday">×</button>
      </div>
    </>
  );
}
