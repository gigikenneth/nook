// Self-check for the in-room "Around now" watch mode. Run: `node src/LobbyDO.test.mjs`.
// A watcher (peeking from a session) must stay off the visible roster but still
// be able to ping someone into their room.
import assert from 'node:assert';
import { LobbyDO } from './LobbyDO.js';

const fakeWs = () => { const sent = []; return { send: (s) => sent.push(JSON.parse(s)), sent }; };
const feed = (lobby, id, ws, msg) => lobby.onPresence(id, ws, { data: JSON.stringify(msg) });

// 1) Watcher is excluded from the visible roster; a normal 'hello' is listed.
{
  const lobby = new LobbyDO();
  feed(lobby, 'alice', fakeWs(), { type: 'hello', name: 'Alice' });
  feed(lobby, 'bob', fakeWs(), { type: 'watch', name: 'Bob' });
  const names = lobby.rosterMsg().people.map((p) => p.name);
  assert.deepEqual(names, ['Alice'], 'watcher Bob hidden, Alice visible');
}

// 2) A watcher can still ping someone into their room.
{
  const lobby = new LobbyDO();
  const aliceWs = fakeWs();
  feed(lobby, 'alice', aliceWs, { type: 'hello', name: 'Alice' });
  feed(lobby, 'bob', fakeWs(), { type: 'watch', name: 'Bob' });
  feed(lobby, 'bob', null, { type: 'ping', toId: 'alice', roomId: 'room-xyz' });
  const invite = aliceWs.sent.find((m) => m.type === 'invite');
  assert.ok(invite, 'Alice received an invite');
  assert.equal(invite.roomId, 'room-xyz', 'invite carries the watcher\'s room');
  assert.equal(invite.fromName, 'Bob', 'invite names the watcher');
}

// 3) Camera preference travels in the roster; garbage is dropped; live updates apply.
{
  const lobby = new LobbyDO();
  feed(lobby, 'alice', fakeWs(), { type: 'hello', name: 'Alice', pref: 'off' });
  feed(lobby, 'bob', fakeWs(), { type: 'hello', name: 'Bob', pref: 'bogus' });
  const roster = lobby.rosterMsg().people;
  assert.equal(roster.find((p) => p.name === 'Alice').pref, 'off', 'Alice pref in roster');
  assert.equal(roster.find((p) => p.name === 'Bob').pref, null, 'garbage pref dropped');
  feed(lobby, 'alice', null, { type: 'pref', pref: 'on' });
  assert.equal(lobby.rosterMsg().people.find((p) => p.name === 'Alice').pref, 'on', 'live pref update');
}

console.log('LobbyDO watch-mode + camera-pref self-check: all passed');
