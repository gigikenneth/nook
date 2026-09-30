import { useEffect, useRef, useState } from 'react';
import { wsBase } from './config';
import { getDid, loadBlocks, addBlock, removeBlock } from './device';
import { chime } from './sound';

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
    let dead = false;
    let attempts = 0;

    function handle(m) {
      if (m.type === 'welcome') setSelfId(m.id);
      else if (m.type === 'roster') setRoster(m.people);
      else if (m.type === 'invite') { setInvite({ fromName: m.fromName, roomId: m.roomId }); chime('join'); } // ping so you notice the invite
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
    }

    function connect() {
      const socket = new WebSocket(`${wsBase}/lobby/ws`);
      ws.current = socket;
      socket.onopen = () => {
        attempts = 0;
        socket.send(JSON.stringify({ type: mode === 'watch' ? 'watch' : 'hello', name: nameRef.current, pref: prefRef.current, did: getDid() }));
      };
      socket.onmessage = (ev) => { clearLive(); handle(JSON.parse(ev.data)); };
      socket.onclose = () => {
        // Presence has no UI for being disconnected, so it just keeps retrying:
        // a dropped lobby socket means nobody can see you're around (#79), and
        // silently staying dropped is the bug. Ignore a stale socket we already
        // replaced, so a raced reconnect doesn't kill the live one.
        if (dead || socket !== ws.current) return;
        setRoster([]);
        attempts += 1;
        setTimeout(() => { if (!dead) connect(); }, Math.min(1000 * 2 ** (attempts - 1), 15000));
      };
    }

    function replace(s) {
      s.onclose = null; // deliberate replace, don't let it schedule its own retry
      try { s.close(); } catch { /* already closed */ }
      attempts = 0;
      connect();
    }

    function reconnectNow() {
      if (dead) return;
      const s = ws.current;
      if (s && (s.readyState === 0 || s.readyState === 1)) return;
      attempts = 0;
      connect();
    }

    // Keepalive + zombie watchdog, the same shape useRoom uses. An idle presence
    // socket gets dropped by proxies and frozen backgrounded tabs can leave one
    // reporting OPEN while no frames flow — either way the server drops you from
    // everyone's roster and, without this, you never come back (#79). Any reply
    // clears the probe (clearLive in onmessage); silence forces a reconnect.
    let liveTimeout = null;
    const clearLive = () => { if (liveTimeout) { clearTimeout(liveTimeout); liveTimeout = null; } };
    const probe = () => {
      if (dead) return;
      const s = ws.current;
      if (!s || s.readyState !== 1) return reconnectNow();
      if (liveTimeout) return; // a probe is already in flight
      try { s.send(JSON.stringify({ type: 'keepalive' })); } catch { return reconnectNow(); }
      liveTimeout = setTimeout(() => {
        liveTimeout = null;
        if (dead || ws.current !== s) return; // answered, or we already moved on
        replace(s);
      }, 5000);
    };
    const beat = setInterval(probe, 30000); // well inside the ~100s idle cutoff
    const onVisible = () => { if (document.visibilityState === 'visible') probe(); };
    window.addEventListener('online', reconnectNow);
    document.addEventListener('visibilitychange', onVisible);

    connect();

    return () => {
      dead = true;
      clearLive();
      clearInterval(beat);
      window.removeEventListener('online', reconnectNow);
      document.removeEventListener('visibilitychange', onVisible);
      try { ws.current && ws.current.close(); } catch { /* already closed */ }
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
