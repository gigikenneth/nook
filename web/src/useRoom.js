import { useCallback, useEffect, useRef, useState } from 'react';
import { wsBase } from './config';
import { getDid } from './device';

// Nook's room transport. A single WebSocket to the room's Durable Object carries
// ALL the coworking state — presence, phases, timer, chat, tasks, goals — and is
// the reliable core that survives reconnects and hibernation. Video is separate:
// it lives entirely in the embedded JaaS (Jitsi) call (see JitsiStage), so there
// is no WebRTC/SFU here anymore.
export function useRoom(roomId, name, opts) {
  const [selfId, setSelfId] = useState(null);
  const [hostId, setHostId] = useState(null);
  const [peers, setPeers] = useState({}); // id -> { name, list }
  const [phase, setPhase] = useState('greet');
  const [startingAt, setStartingAt] = useState(null); // ms when the pre-focus countdown lands; null when not counting
  const [endsAt, setEndsAt] = useState(null);
  const [checkinSeed, setCheckinSeed] = useState(null);
  const [ready, setReady] = useState([]);
  const [shared, setShared] = useState([]);
  const [order, setOrder] = useState([]);
  const [locked, setLocked] = useState(false);
  const [goals, setGoals] = useState({});
  const [camPrefs, setCamPrefs] = useState({});
  const [chat, setChat] = useState(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(`nook.chat.${roomId}`) || 'null');
      if (Array.isArray(saved)) return saved;
    } catch { /* ignore */ }
    return [];
  });
  const [config, setConfig] = useState({ focusMin: opts.focusMin, regroupMin: opts.regroupMin });
  const [status, setStatus] = useState('connecting');

  useEffect(() => {
    try { sessionStorage.setItem(`nook.chat.${roomId}`, JSON.stringify(chat)); } catch { /* full/blocked */ }
  }, [chat, roomId]);

  const ws = useRef(null);
  const everConnected = useRef(false); // did the room socket ever open? distinguishes a brief mid-session drop from "never reached the server" (outage / offline)

  const selfIdRef = useRef(null);
  const cidRef = useRef(null);
  if (!cidRef.current) {
    try {
      let c = sessionStorage.getItem('nook.cid');
      if (!c) { c = crypto.randomUUID(); sessionStorage.setItem('nook.cid', c); }
      cidRef.current = c;
    } catch { cidRef.current = crypto.randomUUID(); }
  }
  const didRef = useRef(null);
  if (!didRef.current) didRef.current = getDid();

  const sendWs = useCallback((obj) => {
    const s = ws.current;
    if (s && s.readyState === 1) s.send(JSON.stringify(obj));
  }, []);

  useEffect(() => {
    let dead = false;

    function handle(m) {
      switch (m.type) {
        case 'welcome':
          setSelfId(m.selfId);
          selfIdRef.current = m.selfId;
          setHostId(m.hostId);
          setPhase(m.phase);
          setEndsAt(m.endsAt);
          setReady(m.ready || []);
          setShared(m.shared || []);
          setOrder(m.order || []);
          setLocked(m.locked || false);
          setConfig({ focusMin: m.focusMin, regroupMin: m.regroupMin });
          setCheckinSeed(m.checkinSeed ?? null);
          if (m.goals) setGoals(m.goals);
          if (m.camPrefs) setCamPrefs(m.camPrefs);
          setPeers((p) => {
            const n = { ...p };
            for (const pe of m.peers) n[pe.id] = { ...(n[pe.id] || {}), name: pe.name };
            for (const [pid, tasks] of Object.entries(m.lists || {})) n[pid] = { ...(n[pid] || {}), list: tasks };
            return n;
          });
          break;
        case 'peer-join':
          setPeers((p) => ({ ...p, [m.id]: { ...(p[m.id] || {}), name: m.name } }));
          break;
        case 'peer-leave': {
          setPeers((p) => { const n = { ...p }; delete n[m.id]; return n; });
          setGoals((g) => { const n = { ...g }; delete n[m.id]; return n; });
          setCamPrefs((c) => { const n = { ...c }; delete n[m.id]; return n; });
          break;
        }
        case 'starting':
          // Land the countdown on a local target, cancelling out server clock skew.
          setStartingAt(Date.now() + (m.startAt - m.serverNow));
          break;
        case 'phase':
          setStartingAt(null); // countdown's done (or was cancelled) once the phase actually moves
          setPhase(m.phase);
          setEndsAt(m.endsAt);
          setCheckinSeed(m.checkinSeed ?? null);
          // The host can change the length for the next round; keep config in step.
          if (m.focusMin) setConfig({ focusMin: m.focusMin, regroupMin: m.regroupMin });
          break;
        case 'ready-state': setReady(m.ready); break;
        case 'shared-state': setShared(m.shared); break;
        case 'order': setOrder(m.order); break;
        case 'locked-state': setLocked(m.locked); break;
        case 'goal': setGoals((g) => ({ ...g, [m.id]: m.text })); break;
        case 'campref':
          setCamPrefs((c) => { const n = { ...c }; if (m.pref) n[m.id] = m.pref; else delete n[m.id]; return n; });
          break;
        case 'chat':
          setChat((c) => [...c, { mid: m.mid, id: m.id, name: m.name, text: m.text, t: m.t, mine: m.id === selfIdRef.current, reactions: {} }]);
          break;
        case 'react':
          setChat((c) => c.map((msg) => {
            if (msg.mid !== m.mid) return msg;
            const reactions = { ...(msg.reactions || {}) };
            const who = new Set(reactions[m.emoji] || []);
            if (m.on) who.add(m.id); else who.delete(m.id);
            if (who.size) reactions[m.emoji] = [...who]; else delete reactions[m.emoji];
            return { ...msg, reactions };
          }));
          break;
        case 'edited': // someone edited their message (#70)
          setChat((c) => c.map((msg) => (msg.mid === m.mid ? { ...msg, text: m.text, edited: true } : msg)));
          break;
        case 'host': setHostId(m.id); break;
        case 'peer-list':
          setPeers((p) => (p[m.id] ? { ...p, [m.id]: { ...p[m.id], list: m.tasks } } : p));
          break;
      }
    }

    const qs = `name=${encodeURIComponent(name)}&focus=${opts.focusMin}&regroup=${opts.regroupMin}&public=${opts.isPublic ? 1 : 0}&cid=${encodeURIComponent(cidRef.current)}&did=${encodeURIComponent(didRef.current)}`;
    let attempts = 0;
    const MAX_RETRIES = 10;

    function connect() {
      const socket = new WebSocket(`${wsBase}/room/${encodeURIComponent(roomId)}/ws?${qs}`);
      ws.current = socket;
      socket.onopen = () => { attempts = 0; everConnected.current = true; setStatus('connected'); };
      socket.onmessage = (ev) => handle(JSON.parse(ev.data));
      socket.onclose = (e) => {
        if (dead) return;
        if (e.code === 4000) return setStatus('kicked');
        if (e.code === 4001) return setStatus('full');
        if (e.code === 4002) return setStatus('locked');
        if (e.code === 1000 || e.code === 1005) return setStatus('closed');
        setPeers({});
        // A socket that never opened means the server is unreachable (Nook down,
        // or the user is offline). Don't give up — keep retrying at the capped
        // backoff so the tab self-heals the moment the room service is back; show
        // a distinct 'down' banner instead of the terminal 'offline' screen.
        const neverUp = !everConnected.current;
        if (attempts >= MAX_RETRIES && !neverUp) return setStatus('offline');
        attempts += 1;
        setStatus(neverUp && attempts >= 2 ? 'down' : 'reconnecting');
        setTimeout(() => { if (!dead) connect(); }, Math.min(1000 * 2 ** (attempts - 1), 8000));
      };
    }

    function reconnectNow() {
      if (dead) return;
      const s = ws.current;
      if (s && (s.readyState === 0 || s.readyState === 1)) return;
      attempts = 0;
      connect();
    }
    const onVisible = () => { if (document.visibilityState === 'visible') reconnectNow(); };
    window.addEventListener('online', reconnectNow);
    document.addEventListener('visibilitychange', onVisible);

    connect();

    return () => {
      dead = true;
      window.removeEventListener('online', reconnectNow);
      document.removeEventListener('visibilitychange', onVisible);
      try { ws.current && ws.current.close(); } catch { /* already closed */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  return {
    selfId, hostId, peers, phase, startingAt, endsAt, checkinSeed, ready, shared, order, locked, goals, camPrefs, chat, config, status,
    shareGoal: () => sendWs({ type: 'shared' }),
    toggleLock: () => sendWs({ type: 'lock', locked: !locked }),
    setReady: (r) => sendWs({ type: r ? 'ready' : 'unready' }),
    start: () => sendWs({ type: 'start' }),
    kick: (id) => sendWs({ type: 'kick', id }),
    restart: (opts) => sendWs({ type: 'restart', ...(opts || {}) }),
    sendGoal: (text) => sendWs({ type: 'goal', text }),
    shareList: (tasks) => sendWs({ type: 'list', tasks }),
    setCamPref: (pref) => sendWs({ type: 'campref', pref }),
    sendChat: (text) => sendWs({ type: 'chat', text }),
    editChat: (mid, text) => sendWs({ type: 'edit', mid, text }),
    react: (mid, emoji, on) => sendWs({ type: 'react', mid, emoji, on }),
  };
}
