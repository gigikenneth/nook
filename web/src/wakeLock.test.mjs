// Self-check for the retrying screen wake lock (#17). Run:
//   node web/src/wakeLock.test.mjs
import assert from 'node:assert';
import { keepAwake } from './wakeLock.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

function fakeDoc() {
  const ls = new Map();
  return {
    visibilityState: 'visible',
    addEventListener(t, f) { if (!ls.has(t)) ls.set(t, new Set()); ls.get(t).add(f); },
    removeEventListener(t, f) { ls.get(t)?.delete(f); },
    fire(t) { for (const f of [...(ls.get(t) || [])]) f(); },
    count() { let n = 0; for (const s of ls.values()) n += s.size; return n; },
  };
}

function fakeLock() {
  const onRelease = [];
  return {
    released: false,
    addEventListener(t, f) { if (t === 'release') onRelease.push(f); },
    release() { this.released = true; onRelease.forEach((f) => f()); return Promise.resolve(); },
    drop() { onRelease.forEach((f) => f()); }, // system releases it
  };
}

// Native API: refuses until a tap, then holds; re-takes after the system drops it.
{
  const doc = fakeDoc();
  let refuse = true;
  let calls = 0;
  const locks = [];
  const nav = { wakeLock: { request() {
    calls++;
    if (refuse) return Promise.reject(new Error('NotAllowedError'));
    const l = fakeLock(); locks.push(l); return Promise.resolve(l);
  } } };
  const stop = keepAwake({ nav, doc });
  await tick();
  assert.equal(calls, 1, 'asks on start');
  assert.equal(locks.length, 0, 'first ask refused');

  refuse = false;
  doc.fire('touchend');
  await tick();
  assert.equal(locks.length, 1, 'a tap retries and gets the lock');

  doc.fire('click');
  await tick();
  assert.equal(calls, 2, 'no extra requests while holding');

  doc.visibilityState = 'hidden';
  locks[0].drop();
  await tick();
  assert.equal(calls, 2, "doesn't ask while hidden");
  doc.visibilityState = 'visible';
  doc.fire('visibilitychange');
  await tick();
  assert.equal(locks.length, 2, 're-takes it when visible again');

  stop();
  assert.ok(locks[1].released, 'stop releases the lock');
  assert.equal(doc.count(), 0, 'stop removes every listener');
  doc.fire('click');
  await tick();
  assert.equal(calls, 3, 'nothing after stop');
}

// A lock that arrives after stop is released straight away.
{
  const doc = fakeDoc();
  let resolve;
  const nav = { wakeLock: { request: () => new Promise((r) => { resolve = r; }) } };
  const stop = keepAwake({ nav, doc });
  stop();
  const l = fakeLock();
  resolve(l);
  await tick();
  assert.ok(l.released, 'late lock released');
}

// No native API: NoSleep video, retried on a tap when play() is blocked.
{
  const doc = fakeDoc();
  let blocked = true;
  class FakeNoSleep {
    constructor() { this.noSleepVideo = {}; this.isEnabled = false; }
    enable() { if (blocked) return Promise.reject(new Error('autoplay')); this.isEnabled = true; return Promise.resolve(); }
    disable() { this.isEnabled = false; FakeNoSleep.disabled = true; }
  }
  const stop = keepAwake({ nav: {}, doc, NoSleep: FakeNoSleep });
  await tick();
  blocked = false;
  doc.fire('keydown');
  await tick();
  stop();
  assert.ok(FakeNoSleep.disabled, 'video fallback enabled on tap, disabled on stop');
}

// NoSleep's page-reload path (no video): do nothing at all.
{
  const doc = fakeDoc();
  class ReloadNoSleep { enable() { throw new Error('must not enable'); } }
  const stop = keepAwake({ nav: {}, doc, NoSleep: ReloadNoSleep });
  assert.equal(doc.count(), 0, 'no listeners on the reload path');
  stop();
}

console.log('wakeLock: ok');
