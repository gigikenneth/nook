import { useCallback, useEffect, useRef, useState } from 'react';
import { apiBase, wsBase } from './config';
import { liveTrackOf, mediaErrorMessage } from './media';
import { diffRoster, newSession, pushTracks, pullTracks, renegotiate } from './sfu';
import { getDid } from './device';

// Cloudflare Realtime (SFU) transport. Each client keeps ONE PeerConnection to
// the Cloudflare edge: it PUSHES its mic/cam tracks up and PULLS each roommate's
// tracks down. The Durable Object is the track-ID registry — it broadcasts who
// publishes which tracks, and diffRoster turns roster changes into pull/drop
// work. This replaces the old <=4 WebRTC mesh, which was fragile on phones and
// >2 people (#68/#72).
const CF_STUN = { iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] };

export function useRoom(roomId, name, opts) {
  const [selfId, setSelfId] = useState(null);
  const [hostId, setHostId] = useState(null);
  const [peers, setPeers] = useState({}); // id -> { name, stream, camLive }
  const [phase, setPhase] = useState('greet');
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
  const [local, setLocal] = useState(null);

  useEffect(() => {
    try { sessionStorage.setItem(`nook.chat.${roomId}`, JSON.stringify(chat)); } catch { /* full/blocked */ }
  }, [chat, roomId]);

  const ws = useRef(null);
  const pc = useRef(null); // the single PeerConnection to the Cloudflare edge
  const sessionId = useRef(null); // our Realtime session id
  const iceRef = useRef(CF_STUN);
  const localStream = useRef(null);
  // Track names we've published, by kind (the SFU addresses a track by
  // (sessionId, trackName); trackName is the local MediaStreamTrack id).
  const published = useRef({ audio: null, video: null });
  const senders = useRef({ audio: null, video: null }); // RTCRtpSender per kind, reused across on/off
  const roster = useRef({}); // last applied roster: peerId -> { session, audio, video }
  const midToPeer = useRef(new Map()); // incoming transceiver mid -> { peerId, kind }
  const negotiating = useRef(Promise.resolve()); // serialize PC signaling ops

  const camOn = useRef(false);
  const micOn = useRef(false);
  const [media, setMedia] = useState({ cam: false, mic: false });
  const [mediaError, setMediaError] = useState(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
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

  // Run a PC signaling operation with no other op interleaving (the single PC's
  // signalingState can't handle concurrent offer/answer cycles).
  const serialize = useCallback((fn) => {
    const next = negotiating.current.then(fn, fn);
    negotiating.current = next.catch(() => {});
    return next;
  }, []);

  // Audio mutes via `enabled` (instant); video off actually releases the camera
  // so its light goes off (#46). Focus forces all media off.
  const applyTracks = useCallback((phOverride) => {
    const s = localStream.current;
    if (!s) return;
    const mediaOn = (phOverride || phaseRef.current) !== 'focus';
    s.getAudioTracks().forEach((t) => { t.enabled = mediaOn && micOn.current; });
    s.getVideoTracks().forEach((t) => { t.enabled = mediaOn && camOn.current; });
  }, []);

  // Tell the DO which tracks we currently publish so roommates can pull them.
  const announce = useCallback(() => {
    sendWs({ type: 'publish', session: sessionId.current, audio: published.current.audio, video: published.current.video });
  }, [sendWs]);

  // Publish (or re-publish) a local track of `kind` to the SFU, reusing the same
  // sender across camera off/on so we don't pile up transceivers.
  const publishTrack = useCallback((kind, track) => serialize(async () => {
    const conn = pc.current;
    if (!conn || conn.signalingState === 'closed') return;
    let sender = senders.current[kind];
    if (sender) {
      await sender.replaceTrack(track);
    } else {
      const tx = conn.addTransceiver(track, { direction: 'sendonly' });
      sender = tx.sender;
      senders.current[kind] = sender;
    }
    // Renegotiate: offer -> pushTracks -> answer. trackName = the track id.
    await conn.setLocalDescription(await conn.createOffer());
    const mid = conn.getTransceivers().find((t) => t.sender === sender)?.mid;
    const res = await pushTracks(apiBase, sessionId.current,
      [{ location: 'local', mid, trackName: track.id }], conn.localDescription.sdp);
    await conn.setRemoteDescription(res.sessionDescription);
    published.current[kind] = track.id;
    announce();
  }), [serialize, announce]);

  // Stop publishing a kind (camera off): drop the track from its sender and tell
  // the room. The transceiver/sender is kept for a seamless re-publish later.
  const unpublishTrack = useCallback((kind) => serialize(async () => {
    const sender = senders.current[kind];
    if (sender) { try { await sender.replaceTrack(null); } catch { /* closing */ } }
    published.current[kind] = null;
    announce();
  }), [announce]);

  const releaseVideo = useCallback(() => {
    const s = localStream.current;
    const track = s && s.getVideoTracks()[0];
    if (track) {
      try { track.stop(); } catch {}
      s.removeTrack(track);
      setLocal(new MediaStream(s.getTracks()));
    }
    unpublishTrack('video');
  }, [unpublishTrack]);

  const onTrackEnded = useCallback((kind) => {
    if (kind === 'video') { camOn.current = false; setMedia((m) => ({ ...m, cam: false })); releaseVideo(); }
    else { micOn.current = false; setMedia((m) => ({ ...m, mic: false })); unpublishTrack('audio'); }
  }, [releaseVideo, unpublishTrack]);

  // Lazily acquire mic/camera only when the user turns it on, then publish it.
  const ensureMedia = useCallback(async (kind) => {
    const cur = localStream.current;
    if (liveTrackOf(cur, kind)) return true;
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
    await publishTrack(kind, track);
    setMediaError(null);
    return true;
  }, [onTrackEnded, publishTrack]);

  useEffect(() => {
    let dead = false;

    // Attach an incoming remote track to the right peer tile. midToPeer is filled
    // by pullRemote *before* setRemoteDescription triggers ontrack.
    function onTrack(e) {
      const mid = e.transceiver && e.transceiver.mid;
      const info = midToPeer.current.get(mid);
      if (!info) return; // not a pull we initiated
      const { peerId, kind } = info;
      setPeers((p) => {
        const prev = p[peerId] || {};
        const stream = prev.stream || new MediaStream();
        // Replace any existing track of this kind, then add the new one.
        (kind === 'video' ? stream.getVideoTracks() : stream.getAudioTracks()).forEach((t) => stream.removeTrack(t));
        stream.addTrack(e.track);
        const next = { ...prev, stream };
        if (kind === 'video') {
          next.camLive = !e.track.muted;
          e.track.onmute = () => setPeers((q) => (q[peerId] ? { ...q, [peerId]: { ...q[peerId], camLive: false } } : q));
          e.track.onunmute = () => setPeers((q) => (q[peerId] ? { ...q, [peerId]: { ...q[peerId], camLive: true } } : q));
        }
        return { ...p, [peerId]: next };
      });
    }

    function makePc() {
      const conn = new RTCPeerConnection(iceRef.current);
      conn.ontrack = onTrack;
      conn.oniceconnectionstatechange = () => {
        if (conn.iceConnectionState === 'failed') setStatus('media-offline');
      };
      pc.current = conn;
      return conn;
    }

    // Establish the Realtime session. A data channel gives the initial offer
    // content so the PC connects even before any media is published (Nook joins
    // muted / camera-off).
    async function establishSession() {
      const conn = pc.current;
      conn.createDataChannel('nook');
      await conn.setLocalDescription(await conn.createOffer());
      const res = await newSession(apiBase, conn.localDescription.sdp);
      sessionId.current = res.sessionId;
      await conn.setRemoteDescription(res.sessionDescription);
      announce(); // publish our (empty) track set so the roster has our session id
    }

    // Pull one remote track and wire it to its peer tile.
    function pullRemote(peerId, kind, trackName, ownerSession) {
      return serialize(async () => {
        const conn = pc.current;
        if (!conn || conn.signalingState === 'closed') return;
        const res = await pullTracks(apiBase, sessionId.current,
          [{ location: 'remote', sessionId: ownerSession, trackName }]);
        // Map the assigned transceiver mid to this peer/kind before applying the
        // remote description, so ontrack can route it.
        for (const t of res.tracks || []) {
          if (t.mid != null) midToPeer.current.set(String(t.mid), { peerId, kind });
        }
        if (res.requiresImmediateRenegotiation && res.sessionDescription) {
          await conn.setRemoteDescription(res.sessionDescription);
          await conn.setLocalDescription(await conn.createAnswer());
          await renegotiate(apiBase, sessionId.current, conn.localDescription.sdp);
        }
      });
    }

    function dropRemote(peerId, kind) {
      setPeers((p) => {
        const prev = p[peerId];
        if (!prev || !prev.stream) return p;
        const stream = prev.stream;
        (kind === 'video' ? stream.getVideoTracks() : stream.getAudioTracks()).forEach((t) => stream.removeTrack(t));
        const next = { ...prev, stream };
        if (kind === 'video') next.camLive = false;
        return { ...p, [peerId]: next };
      });
    }

    // Apply the DO's published-tracks roster: pull what's new, drop what's gone.
    function reconcile(next) {
      const { toPull, toDrop } = diffRoster(roster.current, next, selfIdRef.current);
      roster.current = next;
      for (const d of toDrop) dropRemote(d.peerId, d.kind);
      for (const pl of toPull) pullRemote(pl.peerId, pl.kind, pl.trackId, pl.session);
    }

    const applyPhaseToTracks = (ph) => { if (ph === 'focus') releaseVideo(); applyTracks(ph); };

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
          setCheckinSeed(m.checkinSeed ?? null);
          if (m.goals) setGoals(m.goals);
          if (m.camPrefs) setCamPrefs(m.camPrefs);
          applyPhaseToTracks(m.phase);
          setPeers((p) => {
            const n = { ...p };
            for (const pe of m.peers) n[pe.id] = { ...(n[pe.id] || {}), name: pe.name };
            for (const [pid, tasks] of Object.entries(m.lists || {})) n[pid] = { ...(n[pid] || {}), list: tasks };
            return n;
          });
          // Bring up our session, then pull whatever the room already publishes.
          try {
            await establishSession();
            if (m.tracks) reconcile(m.tracks);
          } catch { setStatus('media-offline'); }
          break;
        case 'peer-join':
          setPeers((p) => ({ ...p, [m.id]: { ...(p[m.id] || {}), name: m.name } }));
          break;
        case 'peer-leave': {
          midToPeer.current.forEach((v, k) => { if (v.peerId === m.id) midToPeer.current.delete(k); });
          const nextRoster = { ...roster.current }; delete nextRoster[m.id]; roster.current = nextRoster;
          setPeers((p) => { const n = { ...p }; delete n[m.id]; return n; });
          setGoals((g) => { const n = { ...g }; delete n[m.id]; return n; });
          setCamPrefs((c) => { const n = { ...c }; delete n[m.id]; return n; });
          break;
        }
        case 'tracks': { // roster change: someone published/unpublished a track
          const { id, session, audio, video } = m;
          reconcile({ ...roster.current, [id]: { session, audio: audio || null, video: video || null } });
          break;
        }
        case 'phase':
          setPhase(m.phase);
          setEndsAt(m.endsAt);
          setCheckinSeed(m.checkinSeed ?? null);
          if (m.phase === 'focus') {
            camOn.current = false; micOn.current = false;
            setMedia({ cam: false, mic: false });
          }
          applyPhaseToTracks(m.phase);
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
        case 'host': setHostId(m.id); break;
        case 'peer-list':
          setPeers((p) => (p[m.id] ? { ...p, [m.id]: { ...p[m.id], list: m.tasks } } : p));
          break;
      }
    }

    async function run() {
      try {
        const res = await fetch(`${apiBase}/ice`);
        const data = await res.json();
        if (!dead && data.iceServers) iceRef.current = { iceServers: data.iceServers };
      } catch { /* keep Cloudflare STUN default */ }
      if (dead) return;

      const qs = `name=${encodeURIComponent(name)}&focus=${opts.focusMin}&regroup=${opts.regroupMin}&public=${opts.isPublic ? 1 : 0}&cid=${encodeURIComponent(cidRef.current)}&did=${encodeURIComponent(didRef.current)}`;
      let attempts = 0;
      const MAX_RETRIES = 10;

      function connect() {
        makePc();
        const socket = new WebSocket(`${wsBase}/room/${encodeURIComponent(roomId)}/ws?${qs}`);
        ws.current = socket;
        socket.onopen = () => { attempts = 0; setStatus('connected'); };
        socket.onmessage = (ev) => handle(JSON.parse(ev.data));
        socket.onclose = (e) => {
          if (dead) return;
          if (e.code === 4000) return setStatus('kicked');
          if (e.code === 4001) return setStatus('full');
          if (e.code === 4002) return setStatus('locked');
          if (e.code === 1000 || e.code === 1005) return setStatus('closed');
          // Tear down the media connection; a fresh welcome rebuilds it.
          try { pc.current && pc.current.close(); } catch {}
          senders.current = { audio: null, video: null };
          published.current = { audio: null, video: null };
          midToPeer.current.clear();
          roster.current = {};
          setPeers({});
          if (attempts >= MAX_RETRIES) return setStatus('offline');
          attempts += 1;
          setStatus('reconnecting');
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
      cleanup.push(() => {
        window.removeEventListener('online', reconnectNow);
        document.removeEventListener('visibilitychange', onVisible);
      });

      connect();
    }

    const cleanup = [];
    run();

    return () => {
      dead = true;
      cleanup.forEach((fn) => fn());
      try { ws.current && ws.current.close(); } catch {}
      try { pc.current && pc.current.close(); } catch {}
      if (localStream.current) localStream.current.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  return {
    selfId, hostId, peers, phase, endsAt, checkinSeed, ready, shared, order, locked, goals, camPrefs, chat, config, status, local, media,
    mediaError, dismissMediaError: () => setMediaError(null),
    shareGoal: () => sendWs({ type: 'shared' }),
    toggleLock: () => sendWs({ type: 'lock', locked: !locked }),
    toggleCam: async () => {
      const on = !camOn.current;
      if (on && !(await ensureMedia('video'))) return;
      camOn.current = on; setMedia((m) => ({ ...m, cam: on }));
      if (!on) releaseVideo();
      applyTracks();
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
    shareList: (tasks) => sendWs({ type: 'list', tasks }),
    setCamPref: (pref) => sendWs({ type: 'campref', pref }),
    sendChat: (text) => sendWs({ type: 'chat', text }),
    react: (mid, emoji, on) => sendWs({ type: 'react', mid, emoji, on }),
  };
}
