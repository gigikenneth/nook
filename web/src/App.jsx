import { useState } from 'react';
import Home from './Home.jsx';
import Room from './Room.jsx';

// Invite links are #room/<id>. No router lib — one hash check is enough.
function roomFromHash() {
  const m = window.location.hash.match(/^#room\/(.+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

export default function App() {
  const [session, setSession] = useState(null); // { roomId, name, todos, focusMin, regroupMin }
  const pendingRoom = roomFromHash();

  function enter(s) {
    window.location.hash = `room/${encodeURIComponent(s.roomId)}`;
    setSession(s);
  }

  function leave() {
    window.location.hash = '';
    setSession(null);
  }

  if (session) return <Room {...session} onLeave={leave} />;
  return <Home pendingRoom={pendingRoom} onEnter={enter} />;
}
