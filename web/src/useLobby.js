import { useEffect, useRef, useState } from 'react';
import { wsBase } from './config';
import { getDid, loadBlocks, addBlock, removeBlock } from './device';

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
  const [blocks, setBlocks] = useState(loadBlocks); // [{ did, name }] — your ignore list
  const ws = useRef(null);
  const nameRef = useRef(name);
  nameRef.current = name;
  const prefRef = useRef(pref);
  prefRef.current = pref;

  useEffect(() => {
    if (!enabled) return;
    const socket = new WebSocket(`${wsBase}/lobby/ws`);
    ws.current = socket;
    socket.onopen = () => socket.send(JSON.stringify({ type: mode === 'watch' ? 'watch' : 'hello', name: nameRef.current, pref: prefRef.current, did: getDid() }));
    socket.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === 'welcome') setSelfId(m.id);
      else if (m.type === 'roster') setRoster(m.people);
      else if (m.type === 'invite') setInvite({ fromName: m.fromName, roomId: m.roomId });
      else if (m.type === 'blocked') setBlocks(addBlock(m.did, m.name)); // ack: remember locally for the un-ignore list
      else if (m.type === 'unblocked') setBlocks(removeBlock(m.did));
      else if (m.type === 'blocked-list') {
        // Server is authoritative for which dids are blocked; keep our cached
        // names, drop stale entries, fill unknowns as "Someone".
        const local = loadBlocks();
        const reconciled = m.dids.map((did) => local.find((x) => x.did === did) || { did, name: 'Someone' });
        try { localStorage.setItem('nook.blocks', JSON.stringify(reconciled)); } catch { /* ignore */ }
        setBlocks(reconciled);
      }
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
  const block = (toId) => {
    const s = ws.current;
    if (s && s.readyState === 1) s.send(JSON.stringify({ type: 'block', toId }));
  };
  const unblock = (did) => {
    const s = ws.current;
    if (s && s.readyState === 1) s.send(JSON.stringify({ type: 'unblock', did }));
    else setBlocks(removeBlock(did)); // offline: at least update the local list
  };

  return { roster, selfId, invite, dismissInvite: () => setInvite(null), ping, blocks, block, unblock };
}
