import { useCallback, useEffect, useRef, useState } from 'react';
import { wsBase } from './config';

// STUN only — no TURN in v1. ~10-15% of users behind strict NAT won't connect.
const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// Mesh WebRTC over a Durable Object WebSocket. The newcomer offers to every
// existing peer; existing peers only answer. That one-directional rule avoids
// glare, which is fine at <=4 people.
export function useRoom(roomId, name, opts) {
  const [selfId, setSelfId] = useState(null);
  const [hostId, setHostId] = useState(null);
  const [peers, setPeers] = useState({}); // id -> { name, stream }
  const [phase, setPhase] = useState('greet');
  const [endsAt, setEndsAt] = useState(null);
  const [ready, setReady] = useState([]);
  const [shared, setShared] = useState([]); // ids who confirmed sharing their goal
  const [order, setOrder] = useState([]); // join order — drives the greet turn frame
  const [locked, setLocked] = useState(false); // host closed the room to newcomers
  const [goals, setGoals] = useState({}); // id -> text
  const [chat, setChat] = useState([]); // { id, name, text, t } — never persisted
  const [config, setConfig] = useState({ focusMin: opts.focusMin, regroupMin: opts.regroupMin });
  const [status, setStatus] = useState('connecting');
  const [local, setLocal] = useState(null);

  const ws = useRef(null);
  const pcs = useRef(new Map()); // peerId -> RTCPeerConnection
  const localStream = useRef(null);

  // Manual mic/cam intent. Effective track state = intent AND the phase allows
  // media at all (focus forces everything off). `media` mirrors intent for the UI.
  const camOn = useRef(true);
  const micOn = useRef(true);
  const [media, setMedia] = useState({ cam: true, mic: true });
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const applyTracks = useCallback((phOverride) => {
    const s = localStream.current;
    if (!s) return;
    const mediaOn = (phOverride || phaseRef.current) !== 'focus';
    s.getVideoTracks().forEach((t) => { t.enabled = mediaOn && camOn.current; });
    s.getAudioTracks().forEach((t) => { t.enabled = mediaOn && micOn.current; });
  }, []);

  const sendWs = useCallback((obj) => {
    const s = ws.current;
    if (s && s.readyState === 1) s.send(JSON.stringify(obj));
  }, []);

  useEffect(() => {
    let dead = false;
    const pcMap = pcs.current;

    function makePc(peerId) {
      const pc = new RTCPeerConnection(ICE);
      if (localStream.current) {
        localStream.current.getTracks().forEach((t) => pc.addTrack(t, localStream.current));
      }
      pc.onicecandidate = (e) => {
        if (e.candidate) sendWs({ type: 'signal', to: peerId, data: { candidate: e.candidate } });
      };
      pc.ontrack = (e) => {
        const [stream] = e.streams;
        setPeers((p) => ({ ...p, [peerId]: { ...(p[peerId] || {}), stream } }));
      };
      pcMap.set(peerId, pc);
      return pc;
    }

    // Reconcile tracks whenever the phase changes (focus forces media off);
    // manual mic/cam intent is honored via applyTracks.
    const applyPhaseToTracks = (ph) => applyTracks(ph);

    async function onSignal(from, data) {
      let pc = pcMap.get(from);
      if (data.sdp) {
        if (data.sdp.type === 'offer') {
          if (!pc) pc = makePc(from);
          await pc.setRemoteDescription(data.sdp);
          const ans = await pc.createAnswer();
          await pc.setLocalDescription(ans);
          sendWs({ type: 'signal', to: from, data: { sdp: pc.localDescription } });
        } else if (data.sdp.type === 'answer' && pc) {
          await pc.setRemoteDescription(data.sdp);
        }
      } else if (data.candidate && pc) {
        try { await pc.addIceCandidate(data.candidate); } catch {}
      }
    }

    async function handle(m) {
      switch (m.type) {
        case 'welcome':
          setSelfId(m.selfId);
          setHostId(m.hostId);
          setPhase(m.phase);
          setEndsAt(m.endsAt);
          setReady(m.ready || []);
          setShared(m.shared || []);
          setOrder(m.order || []);
          setLocked(m.locked || false);
          setConfig({ focusMin: m.focusMin, regroupMin: m.regroupMin });
          if (m.goals) setGoals(m.goals);
          applyPhaseToTracks(m.phase);
          setPeers((p) => {
            const n = { ...p };
            for (const pe of m.peers) n[pe.id] = { ...(n[pe.id] || {}), name: pe.name };
            return n;
          });
          for (const pe of m.peers) {
            const pc = makePc(pe.id);
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            sendWs({ type: 'signal', to: pe.id, data: { sdp: pc.localDescription } });
          }
          break;
        case 'peer-join':
          setPeers((p) => ({ ...p, [m.id]: { ...(p[m.id] || {}), name: m.name } }));
          break;
        case 'peer-leave': {
          const pc = pcMap.get(m.id);
          if (pc) { pc.close(); pcMap.delete(m.id); }
          setPeers((p) => { const n = { ...p }; delete n[m.id]; return n; });
          setGoals((g) => { const n = { ...g }; delete n[m.id]; return n; });
          break;
        }
        case 'signal':
          await onSignal(m.from, m.data);
          break;
        case 'phase':
          setPhase(m.phase);
          setEndsAt(m.endsAt);
          applyPhaseToTracks(m.phase);
          break;
        case 'ready-state':
          setReady(m.ready);
          break;
        case 'shared-state':
          setShared(m.shared);
          break;
        case 'order':
          setOrder(m.order);
          break;
        case 'locked-state':
          setLocked(m.locked);
          break;
        case 'goal':
          setGoals((g) => ({ ...g, [m.id]: m.text }));
          break;
        case 'chat':
          setChat((c) => [...c, { id: m.id, name: m.name, text: m.text, t: m.t }]);
          break;
        case 'host':
          setHostId(m.id);
          break;
      }
    }

    async function acquireMedia() {
      try { return await navigator.mediaDevices.getUserMedia({ video: true, audio: true }); }
      catch {
        try { return await navigator.mediaDevices.getUserMedia({ audio: true }); }
        catch { return null; }
      }
    }

    async function run() {
      // Never let an unanswered camera prompt block joining the room. If the user
      // hasn't decided within the window, join without media (avatar tile).
      let timedOut = false;
      const mediaP = acquireMedia();
      mediaP.then((s) => { if (timedOut && s) s.getTracks().forEach((t) => t.stop()); });
      const stream = await Promise.race([
        mediaP,
        new Promise((r) => setTimeout(() => { timedOut = true; r(null); }, 8000)),
      ]);
      if (dead) { stream && stream.getTracks().forEach((t) => t.stop()); return; }
      localStream.current = stream;
      setLocal(stream);

      const qs = `name=${encodeURIComponent(name)}&focus=${opts.focusMin}&regroup=${opts.regroupMin}&public=${opts.isPublic ? 1 : 0}`;
      const socket = new WebSocket(`${wsBase}/room/${encodeURIComponent(roomId)}/ws?${qs}`);
      ws.current = socket;
      socket.onopen = () => setStatus('connected');
      // 4000 kicked, 4001 room full (both sent by the server). 1006 is an abnormal
      // close — handshake never completed, i.e. the server is unreachable, NOT full.
      socket.onclose = (e) =>
        setStatus(
          e.code === 4000 ? 'kicked'
          : e.code === 4001 ? 'full'
          : e.code === 4002 ? 'locked'
          : e.code === 1006 ? 'offline'
          : 'closed');
      socket.onmessage = (ev) => handle(JSON.parse(ev.data));
    }

    run();

    return () => {
      dead = true;
      try { ws.current && ws.current.close(); } catch {}
      pcMap.forEach((pc) => pc.close());
      pcMap.clear();
      if (localStream.current) localStream.current.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  return {
    selfId, hostId, peers, phase, endsAt, ready, shared, order, locked, goals, chat, config, status, local, media,
    shareGoal: () => sendWs({ type: 'shared' }),
    toggleLock: () => sendWs({ type: 'lock', locked: !locked }),
    toggleCam: () => { camOn.current = !camOn.current; setMedia((m) => ({ ...m, cam: camOn.current })); applyTracks(); },
    toggleMic: () => { micOn.current = !micOn.current; setMedia((m) => ({ ...m, mic: micOn.current })); applyTracks(); },
    setReady: (r) => sendWs({ type: r ? 'ready' : 'unready' }),
    start: () => sendWs({ type: 'start' }),
    kick: (id) => sendWs({ type: 'kick', id }),
    restart: () => sendWs({ type: 'restart' }),
    sendGoal: (text) => sendWs({ type: 'goal', text }),
    sendChat: (text) => sendWs({ type: 'chat', text }),
  };
}
