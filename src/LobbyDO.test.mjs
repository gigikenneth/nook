// Self-check for the LobbyDO presence hub under the WebSocket Hibernation model.
// Run: `node src/LobbyDO.test.mjs`. Per-person state rides in each socket's
// attachment; the roster is derived from state.getWebSockets(). A watcher
// (peeking from a session) must stay off the visible roster but still be able to
// ping someone into their room.
import assert from 'node:assert';
import { LobbyDO } from './LobbyDO.js';

function makeState() {
  const store = new Map();
  const s = { _sockets: [] };
  s.storage = {
    get: async (k) => store.get(k),
    put: async (k, v) => { store.set(k, v); },
    delete: async (k) => { store.delete(k); },
  };
  s.blockConcurrencyWhile = (fn) => fn();
  s.getWebSockets = () => s._sockets.filter((w) => w._open);
  s.acceptWebSocket = (ws) => { ws._open = true; s._sockets.push(ws); };
  return s;
}
function fakeWs() {
  const ws = { _att: null, _open: true, sent: [] };
  ws.serializeAttachment = (v) => { ws._att = v; };
  ws.deserializeAttachment = () => ws._att;
  ws.send = (s) => ws.sent.push(JSON.parse(s));
  ws.close = () => { ws._open = false; };
  return ws;
}
// Register a presence socket the way fetch() does: accept + seed the id.
function conn(st, id) { const ws = fakeWs(); st.acceptWebSocket(ws); ws.serializeAttachment({ id, announced: false }); return ws; }
const feed = (lobby, ws, m) => lobby.webSocketMessage(ws, JSON.stringify(m));
async function newLobby() { const st = makeState(); const lobby = new LobbyDO(st, null); await lobby._restore; return { st, lobby }; }

// 1) Watcher is excluded from the visible roster; a normal 'hello' is listed.
{
  const { st, lobby } = await newLobby();
  feed(lobby, conn(st, 'alice'), { type: 'hello', name: 'Alice' });
  feed(lobby, conn(st, 'bob'), { type: 'watch', name: 'Bob' });
  const names = lobby.rosterFor(null).people.map((p) => p.name);
  assert.deepEqual(names, ['Alice'], 'watcher Bob hidden, Alice visible');
}

// 2) A watcher can still ping someone into their room.
{
  const { st, lobby } = await newLobby();
  const aliceWs = conn(st, 'alice');
  feed(lobby, aliceWs, { type: 'hello', name: 'Alice' });
  const bobWs = conn(st, 'bob');
  feed(lobby, bobWs, { type: 'watch', name: 'Bob' });
  feed(lobby, bobWs, { type: 'ping', toId: 'alice', roomId: 'room-xyz' });
  const invite = aliceWs.sent.find((m) => m.type === 'invite');
  assert.ok(invite, 'Alice received an invite');
  assert.equal(invite.roomId, 'room-xyz', 'invite carries the watcher\'s room');
  assert.equal(invite.fromName, 'Bob', 'invite names the watcher');
}

// 3) Camera preference travels in the roster; garbage is dropped; live updates apply.
{
  const { st, lobby } = await newLobby();
  feed(lobby, conn(st, 'alice'), { type: 'hello', name: 'Alice', pref: 'off' });
  feed(lobby, conn(st, 'bob'), { type: 'hello', name: 'Bob', pref: 'bogus' });
  const roster = lobby.rosterFor(null).people;
  assert.equal(roster.find((p) => p.name === 'Alice').pref, 'off', 'Alice pref in roster');
  assert.equal(roster.find((p) => p.name === 'Bob').pref, null, 'garbage pref dropped');
  const aliceWs = st.getWebSockets().find((w) => w.deserializeAttachment().id === 'alice');
  feed(lobby, aliceWs, { type: 'pref', pref: 'on' });
  assert.equal(lobby.rosterFor(null).people.find((p) => p.name === 'Alice').pref, 'on', 'live pref update');
}

// 4) Block (#28): mutual + hidden both ways in the per-viewer roster; unblock restores.
{
  const { st, lobby } = await newLobby();
  const aliceWs = conn(st, 'alice');
  feed(lobby, aliceWs, { type: 'hello', name: 'Alice', did: 'da' });
  feed(lobby, conn(st, 'bob'), { type: 'hello', name: 'Bob', did: 'db' });
  // Alice ignores Bob.
  feed(lobby, aliceWs, { type: 'block', toId: 'bob' });
  assert.ok(lobby.isBlocked('da', 'db') && lobby.isBlocked('db', 'da'), 'block is symmetric');
  const ack = aliceWs.sent.find((m) => m.type === 'blocked');
  assert.equal(ack.did, 'db', 'ack returns the blocked did so the client can cache the name');
  assert.deepEqual(lobby.rosterFor('da').people.map((p) => p.name), ['Alice'], 'Alice no longer sees Bob');
  assert.deepEqual(lobby.rosterFor('db').people.map((p) => p.name), ['Bob'], 'Bob no longer sees Alice (mutual)');
  // Unblock restores both.
  feed(lobby, aliceWs, { type: 'unblock', did: 'db' });
  assert.ok(!lobby.isBlocked('da', 'db'), 'unblock clears the pair');
  assert.equal(lobby.rosterFor('da').people.length, 2, 'Alice sees Bob again');
}

// 5) A blocked pair can't ping/pull each other into a room.
{
  const { st, lobby } = await newLobby();
  const aliceWs = conn(st, 'alice');
  feed(lobby, aliceWs, { type: 'hello', name: 'Alice', did: 'da' });
  const bobWs = conn(st, 'bob');
  feed(lobby, bobWs, { type: 'hello', name: 'Bob', did: 'db' });
  feed(lobby, aliceWs, { type: 'block', toId: 'bob' });
  bobWs.sent.length = 0; // ignore the roster refresh
  feed(lobby, aliceWs, { type: 'ping', toId: 'bob', roomId: 'room-1' });
  assert.ok(!bobWs.sent.find((m) => m.type === 'invite'), 'blocked pair ping is dropped');
}

// 6) Leaving (socket close) drops a person from the roster.
{
  const { st, lobby } = await newLobby();
  const aliceWs = conn(st, 'alice');
  feed(lobby, aliceWs, { type: 'hello', name: 'Alice' });
  feed(lobby, conn(st, 'bob'), { type: 'hello', name: 'Bob' });
  assert.equal(lobby.rosterFor(null).people.length, 2, 'both listed');
  aliceWs._open = false; lobby.webSocketClose(aliceWs);
  assert.deepEqual(lobby.rosterFor(null).people.map((p) => p.name), ['Bob'], 'Alice dropped on close');
}

console.log('LobbyDO hibernation self-check (watch + camera-pref + block(#28) + leave): all passed');
