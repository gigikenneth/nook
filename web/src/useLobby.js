import { useEffect, useRef, useState } from 'react';
import { wsBase } from './config';

// Presence for the home screen: while you're opted in, hold a WebSocket to the
// LobbyDO so you appear in "who's around" and can be pinged to cowork. Closing
// the socket (leaving home, opting out) drops you from everyone's roster.
//
// mode 'watch' (used by the in-room Home overlay) still receives the roster and
// can ping, but stays off everyone else's list — you're in a session, not
// available to be pulled elsewhere.
export function useLobby(enabled, name, mode = 'here', pref = null) {
  const [roster, setRoster] = useState([]);
  const [selfId, setSelfId] = useState(null);
  const [invite, setInvite] = useState(null); // { fromName, roomId }
  const ws = useRef(null);
  const nameRef = useRef(name);
  nameRef.current = name;
  const prefRef = useRef(pref);
  prefRef.current = pref;

  useEffect(() => {
    if (!enabled) return;
    const socket = new WebSocket(`${wsBase}/lobby/ws`);
    ws.current = socket;
    socket.onopen = () => socket.send(JSON.stringify({ type: mode === 'watch' ? 'watch' : 'hello', name: nameRef.current, pref: prefRef.current }));
    socket.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === 'welcome') setSelfId(m.id);
      else if (m.type === 'roster') setRoster(m.people);
      else if (m.type === 'invite') setInvite({ fromName: m.fromName, roomId: m.roomId });
    };
    return () => {
      try { socket.close(); } catch { /* already closed */ }
      ws.current = null;
      setRoster([]);
      setSelfId(null);
    };
  }, [enabled, mode]);

  // Push name edits to the roster while connected.
  useEffect(() => {
    const s = ws.current;
    if (enabled && s && s.readyState === 1) s.send(JSON.stringify({ type: 'rename', name }));
  }, [name, enabled]);

  // Push camera-preference changes to the roster while connected.
  useEffect(() => {
    const s = ws.current;
    if (enabled && s && s.readyState === 1) s.send(JSON.stringify({ type: 'pref', pref }));
  }, [pref, enabled]);

  const ping = (toId, roomId) => {
    const s = ws.current;
    if (s && s.readyState === 1) s.send(JSON.stringify({ type: 'ping', toId, roomId }));
  };

  return { roster, selfId, invite, dismissInvite: () => setInvite(null), ping };
}
