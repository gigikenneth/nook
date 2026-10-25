// Self-check for saved lists. Run:
//   node web/src/savedLists.test.mjs
import assert from 'node:assert';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const { loadSavedLists, saveList, deleteList, markUsed, usedLabel } = await import('./savedLists.js');

assert.deepStrictEqual(loadSavedLists(), [], 'nothing saved yet');

// Save trims, drops blanks and duplicates; newest first.
saveList(' Start of day ', ['Check calendar', ' ', 'Clear Slack', 'Check calendar']);
saveList('Wrap-up', ['Log hours']);
assert.deepStrictEqual(loadSavedLists().map((s) => s.name), ['Wrap-up', 'Start of day']);
assert.deepStrictEqual(loadSavedLists()[1].items, ['Check calendar', 'Clear Slack']);

// Same name (any case) overwrites instead of duplicating.
saveList('start OF day', ['Triage inbox']);
assert.strictEqual(loadSavedLists().length, 2);
assert.deepStrictEqual(loadSavedLists()[0], { name: 'start OF day', items: ['Triage inbox'], usedAt: 0 });

// Mark used, delete.
markUsed('Wrap-up', 1000);
assert.strictEqual(loadSavedLists().find((s) => s.name === 'Wrap-up').usedAt, 1000);
deleteList('Wrap-up');
assert.deepStrictEqual(loadSavedLists().map((s) => s.name), ['start OF day']);

// Junk in storage never crashes.
store.set('nook.savedLists', '{oops');
assert.deepStrictEqual(loadSavedLists(), []);
store.set('nook.savedLists', JSON.stringify([null, { name: '' , items: [] }, { name: 'ok', items: ['a', 3, ''] }]));
assert.deepStrictEqual(loadSavedLists(), [{ name: 'ok', items: ['a'], usedAt: 0 }]);

// Labels.
const now = new Date(2026, 9, 25, 12).getTime();
assert.strictEqual(usedLabel(0, now), 'not used yet');
assert.strictEqual(usedLabel(new Date(2026, 9, 25, 1).getTime(), now), 'used today');
assert.strictEqual(usedLabel(new Date(2026, 9, 24, 23).getTime(), now), 'used yesterday');
assert.strictEqual(usedLabel(new Date(2026, 9, 21, 9).getTime(), now), 'used 4 days ago');

console.log('savedLists ok');
