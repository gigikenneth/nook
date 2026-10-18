// Self-check for the device copy of your last to-do list (#129). Run:
//   node web/src/lastList.test.mjs
import assert from 'node:assert';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const { loadLastList, saveLastList } = await import('./lastList.js');

assert.deepStrictEqual(loadLastList(), [], 'nothing saved yet');

// Round trip keeps text + done, drops ids.
saveLastList([{ id: 'a', text: 'Write intro', done: true }, { id: 'b', text: 'Email Sam', done: false }]);
assert.deepStrictEqual(loadLastList(), [{ text: 'Write intro', done: true }, { text: 'Email Sam', done: false }]);

// Junk in storage never crashes and blank items are skipped.
store.set('nook.lastList', '{oops');
assert.deepStrictEqual(loadLastList(), []);
store.set('nook.lastList', JSON.stringify([{ text: '  ' }, null, { text: 'Keep me' }]));
assert.deepStrictEqual(loadLastList(), [{ text: 'Keep me' }]);

// Blocked storage (private mode) degrades quietly.
globalThis.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
assert.deepStrictEqual(loadLastList(), []);
saveLastList([{ text: 'x', done: false }]);

console.log('lastList ok');
