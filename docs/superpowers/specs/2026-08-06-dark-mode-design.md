# Dark mode (#69) — design

## Problem
App report #69: "maybe have a dark mode?" Nook is light-only today. Add a dark
theme the user can turn on.

## Decisions (locked with the user)
- **Trigger:** manual toggle only. Default stays light (today's look) — no risk to
  current users. Does **not** follow the OS `prefers-color-scheme`.
- **Palette:** neutral charcoal (not the on-brand indigo variant).
  - `bg #101114`, `surface #1a1c20`, `surface-2 #24272c`
  - text `#ececef`, muted `#9aa0aa`, line `rgba(255,255,255,.09)`
  - primary `#4f7cff`; brand accents kept (they pop on dark): mint `#7ff0a6`,
    green `#57e08a`, cyan `#35bff0`, lime `#b6e88a`
- **Persistence:** `localStorage['nook.theme']` = `'light' | 'dark'`.
- **Toggle placement:** a small ☀️/🌙 button in both headers — Home (next to
  "? How it works") and in-room (`room-head` actions).

## Scope cuts (YAGNI)
- No OS auto-detect.
- No per-room theme, no system "auto" third state.
- No theme transition animation.

## Mechanism
`<html data-theme="dark">` drives everything. Light = **no attribute** (current
CSS untouched as the default). A single `[data-theme="dark"]` block in
`styles.css` overrides the color custom properties.

### No-flash boot
An inline `<script>` in `web/index.html` reads `localStorage['nook.theme']` and
sets `document.documentElement.dataset.theme` **before first paint**, so a dark
user never sees a white flash. Must run before the CSS/app loads.

## Components / units

### 1. `web/src/theme.js` (new, small, pure-testable)
- `getTheme()` → `'light' | 'dark'` (reads localStorage, default `'light'`).
- `applyTheme(t)` → sets/removes `data-theme` on `documentElement`.
- `setTheme(t)` → persist + apply.
- `nextTheme(t)` → the opposite theme (pure; the piece under test).
- `toggleTheme()` → `setTheme(nextTheme(getTheme()))`, returns the new theme.
- Guards: all localStorage access wrapped in try/catch (matches `device.js`
  pattern — localStorage may be blocked).

### 2. `web/index.html` — inline boot script
```html
<script>
  try {
    var t = localStorage.getItem('nook.theme');
    if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  } catch (e) {}
</script>
```
Placed in `<head>` before the module script.

### 3. `web/src/styles.css`
- **Var pass first:** route the ~46 raw color literals (`#fff` ×25,
  `rgba(...)` ×18, `#eef0f6`, `#c0392b`, `#9b9885`) through semantic vars so the
  dark override reaches them. Introduce `--surface`, `--surface-2`, `--text`,
  `--on-accent` (the white text sitting on colored buttons stays `#fff` and does
  NOT get themed). Existing `--cream`/`--ink`/`--muted`/`--line`/`--shadow`
  become the light values of those semantics where they already fit.
- **Dark override:** one `[data-theme="dark"]` block re-declaring the color vars
  to the charcoal palette above. Radii/fonts/spacing untouched.

### 4. Toggle button (small inline component, reused)
`ThemeToggle` in a shared spot (e.g. exported from `theme.js`'s consumer or a
tiny component). Renders ☀️ when dark (click → light) / 🌙 when light
(click → dark), `aria-label` reflects the action. Wired into `Home.jsx` header
and `Room.jsx` `room-head`.

## Data flow
1. Page load → inline boot script applies `data-theme` from localStorage (no flash).
2. React mounts; `theme.js` is the source of truth for the toggle's rendered state.
3. User clicks toggle → `toggleTheme()` → localStorage updated + `data-theme`
   flipped → CSS repaints instantly. No reload, no server involvement (theme is
   purely client/device-local; never sent to peers or the Worker).

## Error handling
- localStorage blocked → try/catch everywhere; falls back to light, toggle still
  flips the attribute for the session (just doesn't persist).
- Unknown/garbage stored value → treated as light.

## Testing
- **`web/src/theme.test.mjs`** (node, plain asserts — matches `media.test.mjs`
  style): `nextTheme` flips both ways; `getTheme` defaults to light on
  empty/garbage/blocked storage; `setTheme` persists and `applyTheme` toggles the
  attribute (mock a minimal `localStorage` + `documentElement`).
- **Palette / visual:** verified on localhost via `wrangler dev` (same flow used
  for #53), toggling in both headers and checking every phase (greet / focus /
  regroup), chat, tiles, modals, error states.

## Files touched
- `web/src/theme.js` (new)
- `web/src/theme.test.mjs` (new)
- `web/index.html` (boot script)
- `web/src/styles.css` (var pass + dark block)
- `web/src/Home.jsx` (toggle in header)
- `web/src/Room.jsx` (toggle in room-head)

## Out of scope / follow-ups
- OS auto-detect + an "Auto" third state — could revisit if requested.
- Theming the marketing/landing visuals beyond the app shell if any exist.
