import { useState } from 'react';
import { getTheme, toggleTheme } from './theme';

// Small light/dark switch. Manual only — flips + persists via theme.js. Shows the
// theme you'd switch TO (🌙 when light, ☀️ when dark). Self-styled with inline
// styles that reference the theme vars, so it adapts to dark without depending on
// styles.css. `on-hero` places it on the Home hero slab (light text, no bg chip).
export function ThemeToggle({ className = '' }) {
  const [theme, setThemeState] = useState(getTheme);
  const flip = () => setThemeState(toggleTheme());
  const dark = theme === 'dark';
  const onHero = className.includes('on-hero');

  const base = {
    padding: '6px 10px', fontSize: '15px', lineHeight: 1,
    borderRadius: 'var(--r-pill)', cursor: 'pointer', overflow: 'visible',
  };
  const style = onHero
    ? { ...base, position: 'absolute', top: '16px', right: '64px', zIndex: 2,
        background: 'rgba(255,255,255,.14)', color: 'var(--on-slab)', border: 'none' }
    : { ...base, background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--line)' };

  return (
    <button
      type="button"
      className={`theme-toggle ${className}`}
      style={style}
      onClick={flip}
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      title={dark ? 'Light mode' : 'Dark mode'}
    >
      {dark ? '☀️' : '🌙'}
    </button>
  );
}
