import { useEffect, useState } from 'react';
import { Moon } from './graphics.jsx';

// Easter egg: the moon hides a bit of extra motivation to start the day.
// Lives on the homepage hero and next to the Nook title inside a session.
// The sun stays up while the video plays and sets back into the moon on close.
export function MoonEgg({ size = 40, className = '' }) {
  const [videoOpen, setVideoOpen] = useState(false);
  const [sunrise, setSunrise] = useState(false); // moon turning into the sun, just before the video
  function riseAndShine() {
    if (sunrise || videoOpen) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { setVideoOpen(true); return; }
    setSunrise(true);
    setTimeout(() => { setVideoOpen(true); setSunrise(false); }, 700); // let the sun come up first
  }
  return (
    <>
      <button className={`moon-egg ${className} ${sunrise || videoOpen ? 'up' : ''}`} style={{ width: size, height: size }}
        onClick={riseAndShine} aria-label="A little motivation to start the day" title="Rise and shine">
        <Moon size={size} />
        <img src="/twemoji/2600.svg" width={size} height={size} className="sun" alt="" />
      </button>
      {videoOpen && <MorningVideo onClose={() => setVideoOpen(false)} />}
    </>
  );
}

// youtube-nocookie and only mounted after the click, so no visitor loads
// anything from YouTube unless they go looking for it.
const MORNING_VIDEO = 'enYdAxVcNZA';
function MorningVideo({ onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="report-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="help-card video-card" role="dialog" aria-label="Rise and shine">
        <div className="help-head">
          <h3 className="panel-title">Rise and shine</h3>
          <button className="ghost x" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="video-frame">
          <iframe src={`https://www.youtube-nocookie.com/embed/${MORNING_VIDEO}?autoplay=1&rel=0`}
            title="Rise and shine" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen />
        </div>
      </div>
    </div>
  );
}
