import { useState } from 'react';
import Home from './Home.jsx';
import Room from './Room.jsx';

// Invite links are #room/<id>. No router lib — one hash check is enough.
function roomFromHash() {
  const m = window.location.hash.match(/^#room\/(.+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

// Remember the session for this tab so an accidental refresh rejoins the room
// instead of kicking you back to the name screen. sessionStorage is per-tab and
// clears when the tab closes — nothing is persisted beyond the tab's life.
const KEY = 'nook.session';
function restoreSession() {
  const room = roomFromHash();
  if (!room) return null;
  try {
    const s = JSON.parse(sessionStorage.getItem(KEY) || 'null');
    if (s && s.roomId === room && s.name) return s; // only if it matches this room
  } catch { /* ignore */ }
  return null;
}

export default function App() {
  const [session, setSession] = useState(restoreSession); // { roomId, name, todos, focusMin, regroupMin }
  const [browsing, setBrowsing] = useState(false); // peeking Home while in a session
  const pendingRoom = roomFromHash();

  function enter(s) {
    sessionStorage.setItem(KEY, JSON.stringify(s));
    window.location.hash = `room/${encodeURIComponent(s.roomId)}`;
    setSession(s);
    setBrowsing(false);
  }

  function leave() {
    sessionStorage.removeItem(KEY);
    window.location.hash = '';
    setSession(null);
    setBrowsing(false);
  }

  // From the in-room Home overlay: joining/opening another room leaves the
  // current one, so confirm first.
  function switchRoom(s) {
    if (!window.confirm('Leave your current room and join this one?')) return;
    enter(s);
  }

  if (session) {
    return (
      <>
        <Room {...session} onLeave={leave} onBrowse={() => setBrowsing(true)} />
        {browsing && (
          <Home embedded initialName={session.name} initialCamPref={session.camPref} currentRoomId={session.roomId} onClose={() => setBrowsing(false)} onEnter={switchRoom} />
        )}
      </>
    );
  }
  return <Home pendingRoom={pendingRoom} onEnter={enter} />;
}
