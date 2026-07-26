// Real assets: Twemoji (© Twitter, CC-BY 4.0), downloaded into public/twemoji.
// See public/twemoji/ATTRIBUTION.txt. Used as <img>, no generated art.
const A = '/twemoji';

export function Moon({ size = 44, className = '' }) {
  return <img src={`${A}/1f319.svg`} width={size} height={size} className={`moon ${className}`} alt="" />;
}

export function ChatDoodle() {
  return <img src={`${A}/1f4ac.svg`} className="doodle" alt="" />;
}

// Fun decorations scattered around the hero: sparkles and stars.
const DECOR = [
  { icon: '2728', top: '9%', left: '13%', size: 26, delay: '0s' },
  { icon: '2b50', top: '20%', left: '85%', size: 20, delay: '0.6s' },
  { icon: '2728', top: '32%', left: '92%', size: 18, delay: '0.4s' },
  { icon: '2b50', top: '82%', left: '9%', size: 16, delay: '2s' },
];

export function Sparkles() {
  return (
    <div className="sparkles" aria-hidden="true">
      {DECOR.map((d, i) => (
        <img key={i} src={`${A}/${d.icon}.svg`} className="sparkle"
          style={{ top: d.top, left: d.left, width: d.size, height: d.size, animationDelay: d.delay }} alt="" />
      ))}
    </div>
  );
}
