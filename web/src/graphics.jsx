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

// Camera-preference signal (issue #9): a stated, social hint — it never touches
// the real camera. Native emoji, matching the in-tile media buttons.
export const CAM_PREFS = {
  on: { emoji: '📷', label: 'up for camera' },
  off: { emoji: '🙈', label: 'camera-shy' },
};

// A read-only badge. `compact` shows just the emoji (for tight rows), with the
// label as a tooltip.
export function CamBadge({ pref, compact = false }) {
  const p = CAM_PREFS[pref];
  if (!p) return null;
  return (
    <span className={`cam-badge ${pref}`} title={p.label}>
      <span aria-hidden="true">{p.emoji}</span>{!compact && <span>{p.label}</span>}
    </span>
  );
}

// Three-way picker: on / off / unset. Clicking the selected option clears it.
export function CamPrefPicker({ value, onChange }) {
  return (
    <div className="field">
      <span>Camera preference</span>
      <div className="cam-picker" role="group" aria-label="Camera preference">
        {['on', 'off'].map((k) => (
          <button key={k} type="button" className={`cam-opt ${value === k ? 'sel' : ''}`}
            aria-pressed={value === k} onClick={() => onChange(value === k ? null : k)}>
            <span aria-hidden="true">{CAM_PREFS[k].emoji}</span> {CAM_PREFS[k].label}
          </button>
        ))}
      </div>
    </div>
  );
}
