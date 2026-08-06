// Self-check for the light/dark theme helper (#69). Run:
//   node web/src/theme.test.mjs
import assert from 'node:assert';

// Minimal fakes so the module runs in node (no browser).
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const fakeRoot = {
  attrs: {},
  setAttribute(k, v) { this.attrs[k] = v; },
  removeAttribute(k) { delete this.attrs[k]; },
};
globalThis.document = { documentElement: fakeRoot };

const { nextTheme, getTheme, setTheme, toggleTheme, applyTheme } = await import('./theme.js');

// nextTheme: pure flip both ways.
assert.equal(nextTheme('light'), 'dark', 'light -> dark');
assert.equal(nextTheme('dark'), 'light', 'dark -> light');

// Default is light on empty storage.
assert.equal(getTheme(), 'light', 'defaults to light');

// setTheme persists + applies the attribute; light removes it (keeps default styles).
setTheme('dark');
assert.equal(getTheme(), 'dark', 'dark persisted');
assert.equal(fakeRoot.attrs['data-theme'], 'dark', 'dark sets data-theme');
setTheme('light');
assert.equal(fakeRoot.attrs['data-theme'], undefined, 'light removes data-theme');

// toggleTheme flips from current and returns the new value.
assert.equal(toggleTheme(), 'dark', 'toggle light -> dark');
assert.equal(toggleTheme(), 'light', 'toggle dark -> light');

// Garbage stored value is treated as light.
store.set('nook.theme', 'weird');
assert.equal(getTheme(), 'light', 'unknown value -> light');

// Blocked storage: getTheme falls back to light, setTheme still applies for the session.
const realLS = globalThis.localStorage;
globalThis.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
assert.equal(getTheme(), 'light', 'blocked storage -> light');
applyTheme('dark');
assert.equal(fakeRoot.attrs['data-theme'], 'dark', 'applyTheme still works without storage');
applyTheme('light');
globalThis.localStorage = realLS;

console.log('theme (#69) self-check: all passed');
