import { useCallback, useEffect, useRef, useState } from 'react';
import { apiBase, wsBase } from './config';
import { liveTrackOf, mediaErrorMessage } from './media';
import { chime } from './sound';

// STUN by default; the /ice endpoint adds a TURN relay when configured so peers
// behind strict NAT (different networks) can still connect.
const DEFAULT_ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
// A join within this long of a leave is treated as a reconnect, not a new
// arrival — so a flapping peer doesn't spam the join chime (#30).
const RECONNECT_WINDOW_MS = 6000;

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
  const [camPrefs, setCamPrefs] = useState({}); // id -> 'on' | 'off' (stated camera preference)
  const [chat, setChat] = useState([]); // { id, name, text, t } — never persisted
  const [config, setConfig] = useState({ focusMin: opts.focusMin, regroupMin: opts.regroupMin });
  const [status, setStatus] = useState('connecting');
  const [local, setLocal] = useState(null);

  const ws = useRef(null);
  const pcs = useRef(new Map()); // peerId -> RTCPeerConnection
  const localStream = useRef(null);
  const iceRef = useRef(DEFAULT_ICE); // RTCPeerConnection config; filled from /ice on join

  // Manual mic/cam intent. Effective track state = intent AND the phase allows
  // media at all (focus forces everything off). `media` mirrors intent for the UI.
  // Default OFF: you join muted with your camera off and turn them on if you want.
  const camOn = useRef(false);
  const micOn = useRef(false);
  const [media, setMedia] = useState({ cam: false, mic: false });
  const [mediaError, setMediaError] = useState(null); // last camera/mic problem, shown to the user
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const selfIdRef = useRef(null); // for renegotiation glare handling
  const lastLeaveRef = useRef(0); // when a peer last left — fallback reconnect signal (#30)
  // Stable per-tab id so the server can recognise a returning connection (a
  // refresh or phone-lock reconnect keeps it; a new tab gets a fresh one).
  const cidRef = useRef(null);
  if (!cidRef.current) {
    try {
      let c = sessionStorage.getItem('nook.cid');
      if (!c) { c = crypto.randomUUID(); sessionStorage.setItem('nook.cid', c); }
      cidRef.current = c;
    } catch { cidRef.current = crypto.randomUUID(); }
  }

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

  // Toggling media on mid-call adds a track the original offer didn't have, so
  // the peer needs a fresh offer/answer.
  const renegotiate = useCallback(async (peerId, pc, iceRestart = false) => {
    try {
      const offer = await pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
      await pc.setLocalDescription(offer);
      sendWs({ type: 'signal', to: peerId, data: { sdp: pc.localDescription } });
    } catch { /* negotiation raced; the next signal recovers */ }
  }, [sendWs]);

  // A live track died (device reclaimed, tab backgrounded): reflect it in the UI
  // so the tile shows "off" and the next toggle re-acquires a fresh one (#6).
  const onTrackEnded = useCallback((kind) => {
    if (kind === 'video') { camOn.current = false; setMedia((m) => ({ ...m, cam: false })); }
    else { micOn.current = false; setMedia((m) => ({ ...m, mic: false })); }
  }, []);

  // Lazily acquire mic/camera only when the user turns it on — no permission
  // prompt on join. Returns false (and surfaces why) if it can't. Wires the track
  // to every peer, reusing an existing sender so a re-acquired track actually
  // reaches them instead of piling up dead senders.
  const ensureMedia = useCallback(async (kind) => {
    const cur = localStream.current;
    if (liveTrackOf(cur, kind)) return true;
    // Drop a dead track (ended camera/mic) so we get a fresh one.
    if (cur) {
      const dead = (kind === 'video' ? cur.getVideoTracks() : cur.getAudioTracks())[0];
      if (dead) { try { dead.stop(); } catch {} cur.removeTrack(dead); }
    }
    let got;
    try { got = await navigator.mediaDevices.getUserMedia(kind === 'video' ? { video: true } : { audio: true }); }
    catch (e) { setMediaError(mediaErrorMessage(kind, e)); return false; }
    const track = got.getTracks()[0];
    track.onended = () => onTrackEnded(kind);
    let stream = localStream.current;
    if (!stream) { stream = new MediaStream(); localStream.current = stream; }
    stream.addTrack(track);
    setLocal(stream);
    for (const [peerId, pc] of pcs.current) {
      // Reuse the existing sender for this kind (seamless, no renegotiation);
      // only a brand-new sender needs an offer/answer.
      const sender = pc.getSenders().find((s) => (s.track ? s.track.kind : null) === track.kind);
      if (sender) { try { await sender.replaceTrack(track); continue; } catch { /* fall through to addTrack */ } }
      pc.addTrack(track, stream);
      await renegotiate(peerId, pc);
    }
    setMediaError(null);
    return true;
  }, [renegotiate, onTrackEnded]);

  useEffect(() => {
    let dead = false;
    const pcMap = pcs.current;
    const cleanups = []; // listeners to remove on unmount

    function makePc(peerId) {
      const pc = new RTCPeerConnection(iceRef.current);
      pc._pendingCands = []; // ICE candidates that arrive before the remote description
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
      // Recover from a dropped connection: one side (deterministic by id) restarts
      // ICE. Without this, an intermittent first-attempt failure never recovers.
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' && (selfIdRef.current || '') > peerId) {
          renegotiate(peerId, pc, true);
        }
      };
      pcMap.set(peerId, pc);
      return pc;
    }

    // Add any ICE candidates that arrived before the remote description was set.
    async function flushCands(pc) {
      const pend = pc._pendingCands || [];
      pc._pendingCands = [];
      for (const c of pend) { try { await pc.addIceCandidate(c); } catch {} }
    }

    // Reconcile tracks whenever the phase changes (focus forces media off);
    // manual mic/cam intent is honored via applyTracks.
    const applyPhaseToTracks = (ph) => applyTracks(ph);

    async function onSignal(from, data) {
      let pc = pcMap.get(from);
      if (data.sdp) {
        if (data.sdp.type === 'offer') {
          if (!pc) pc = makePc(from);
          // Perfect-negotiation glare handling: if both sides offer at once, the
          // "impolite" peer (lower id) ignores the colliding offer; the polite
          // one rolls back and accepts it.
          const collision = pc.signalingState !== 'stable';
          const polite = (selfIdRef.current || '') > from;
          if (collision && !polite) return;
          try {
            if (collision) await pc.setLocalDescription({ type: 'rollback' });
            await pc.setRemoteDescription(data.sdp);
            await flushCands(pc);
            const ans = await pc.createAnswer();
            await pc.setLocalDescription(ans);
            sendWs({ type: 'signal', to: from, data: { sdp: pc.localDescription } });
            // We rolled back our own offer to accept theirs — re-send it so our
            // just-added track (e.g. camera) reaches them too, not just one way.
            if (collision) renegotiate(from, pc);
          } catch { /* raced negotiation; a later signal recovers */ }
        } else if (data.sdp.type === 'answer' && pc) {
          try { await pc.setRemoteDescription(data.sdp); await flushCands(pc); } catch {}
        }
      } else if (data.candidate && pc) {
        // Buffer candidates that arrive before the remote description is set,
        // otherwise addIceCandidate throws and the candidate is lost.
        if (pc.remoteDescription && pc.remoteDescription.type) {
          try { await pc.addIceCandidate(data.candidate); } catch {}
        } else {
          pc._pendingCands.push(data.candidate);
        }
      }
    }

    async function handle(m) {
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
          if (m.goals) setGoals(m.goals);
          if (m.camPrefs) setCamPrefs(m.camPrefs);
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
          // Only chime for a genuinely new arrival, not a reconnecting peer whose
          // flaky internet flaps them in and out (#30). Trust the server's
          // reconnect flag (it matches the returning tab by its stable client id);
          // fall back to a timing guess only if an older server didn't send one.
          {
            const isReconnect = m.reconnect !== undefined
              ? m.reconnect
              : Date.now() - lastLeaveRef.current <= RECONNECT_WINDOW_MS;
            if (!isReconnect) chime('join');
          }
          break;
        case 'peer-leave': {
          const pc = pcMap.get(m.id);
          if (pc) { pc.close(); pcMap.delete(m.id); }
          lastLeaveRef.current = Date.now();
          setPeers((p) => { const n = { ...p }; delete n[m.id]; return n; });
          setGoals((g) => { const n = { ...g }; delete n[m.id]; return n; });
          setCamPrefs((c) => { const n = { ...c }; delete n[m.id]; return n; });
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
        case 'campref':
          setCamPrefs((c) => { const n = { ...c }; if (m.pref) n[m.id] = m.pref; else delete n[m.id]; return n; });
          break;
        case 'chat':
          // Freeze whether this is my own message now, against the selfId that's
          // current at receive time. selfId is per-connection and changes on every
          // reconnect, so comparing m.id === selfId at render time would flip all
          // my past messages to "not mine" (grey, left-aligned) after a reconnect.
          setChat((c) => [...c, { id: m.id, name: m.name, text: m.text, t: m.t, mine: m.id === selfIdRef.current }]);
          break;
        case 'host':
          setHostId(m.id);
          break;
      }
    }

    async function run() {
      // Pull ICE servers (STUN + TURN if configured) before any peer connects.
      try {
        const res = await fetch(`${apiBase}/ice`);
        const data = await res.json();
        if (!dead && data.iceServers) iceRef.current = { iceServers: data.iceServers };
      } catch { /* keep STUN-only default */ }
      if (dead) return;

      // No camera/mic prompt on join — you appear as an avatar and acquire media
      // only when you turn it on (see ensureMedia). This avoids a confusing
      // upfront permission prompt and a dead toggle if you decline it.
      const qs = `name=${encodeURIComponent(name)}&focus=${opts.focusMin}&regroup=${opts.regroupMin}&public=${opts.isPublic ? 1 : 0}&cid=${encodeURIComponent(cidRef.current)}`;
      let attempts = 0;
      const MAX_RETRIES = 10;

      function connect() {
        const socket = new WebSocket(`${wsBase}/room/${encodeURIComponent(roomId)}/ws?${qs}`);
        ws.current = socket;
        socket.onopen = () => { attempts = 0; setStatus('connected'); };
        socket.onmessage = (ev) => handle(JSON.parse(ev.data));
        // 4000 kicked, 4001 full, 4002 locked (server-sent, terminal). 1000/1005
        // are clean closes. Anything else (1006 abnormal drop) is a transient
        // network blip — reconnect with backoff instead of dead-ending.
        socket.onclose = (e) => {
          if (dead) return;
          if (e.code === 4000) return setStatus('kicked');
          if (e.code === 4001) return setStatus('full');
          if (e.code === 4002) return setStatus('locked');
          if (e.code === 1000 || e.code === 1005) return setStatus('closed');
          // Tear down stale peer connections; a fresh welcome rebuilds them.
          pcMap.forEach((pc) => pc.close());
          pcMap.clear();
          setPeers({});
          if (attempts >= MAX_RETRIES) return setStatus('offline');
          attempts += 1;
          setStatus('reconnecting');
          setTimeout(() => { if (!dead) connect(); }, Math.min(1000 * 2 ** (attempts - 1), 8000));
        };
      }

      // Phones suspend the tab (lock / app-switch / sleep), which drops the socket
      // AND freezes the backoff timer. Reconnect the moment the tab is visible or
      // the network returns, with a fresh retry budget — this is the main mobile fix.
      function reconnectNow() {
        if (dead) return;
        const s = ws.current;
        if (s && (s.readyState === 0 || s.readyState === 1)) return; // connecting/open
        attempts = 0;
        connect();
      }
      const onVisible = () => { if (document.visibilityState === 'visible') reconnectNow(); };
      window.addEventListener('online', reconnectNow);
      document.addEventListener('visibilitychange', onVisible);
      cleanups.push(() => {
        window.removeEventListener('online', reconnectNow);
        document.removeEventListener('visibilitychange', onVisible);
      });

      connect();
    }

    run();

    return () => {
      dead = true;
      cleanups.forEach((fn) => fn());
      try { ws.current && ws.current.close(); } catch {}
      pcMap.forEach((pc) => pc.close());
      pcMap.clear();
      if (localStream.current) localStream.current.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  return {
    selfId, hostId, peers, phase, endsAt, ready, shared, order, locked, goals, camPrefs, chat, config, status, local, media,
    mediaError, dismissMediaError: () => setMediaError(null),
    shareGoal: () => sendWs({ type: 'shared' }),
    toggleLock: () => sendWs({ type: 'lock', locked: !locked }),
    toggleCam: async () => {
      const on = !camOn.current;
      if (on && !(await ensureMedia('video'))) return; // denied/no device — stay off
      camOn.current = on; setMedia((m) => ({ ...m, cam: on })); applyTracks();
    },
    toggleMic: async () => {
      const on = !micOn.current;
      if (on && !(await ensureMedia('audio'))) return;
      micOn.current = on; setMedia((m) => ({ ...m, mic: on })); applyTracks();
    },
    setReady: (r) => sendWs({ type: r ? 'ready' : 'unready' }),
    start: () => sendWs({ type: 'start' }),
    kick: (id) => sendWs({ type: 'kick', id }),
    restart: () => sendWs({ type: 'restart' }),
    sendGoal: (text) => sendWs({ type: 'goal', text }),
    setCamPref: (pref) => sendWs({ type: 'campref', pref }),
    sendChat: (text) => sendWs({ type: 'chat', text }),
  };
}
