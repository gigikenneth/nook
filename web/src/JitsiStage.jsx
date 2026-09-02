import { useEffect, useRef, useState } from 'react';
import { apiBase } from './config';
import { getDid } from './device';

// Login-free video via JaaS (8x8.vc). We fetch a server-signed JWT, load 8x8's
// external_api.js for our app, and embed the call — no account, no moderator
// gate. Nook's own buttons drive mute (executeCommand); Jitsi's toolbar is
// hidden so the room still looks like Nook.
//
// Mounted only during greet/regroup (the phases with cameras). Focus unmounts it
// — nobody's on camera then — so there's no in-call state to manage across phases.

const scriptPromises = {};
function loadExternalApi(appId) {
  if (window.JitsiMeetExternalAPI) return Promise.resolve();
  const src = `https://8x8.vc/${appId}/external_api.js`;
  if (!scriptPromises[src]) {
    scriptPromises[src] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = resolve;
      s.onerror = () => { delete scriptPromises[src]; reject(new Error('video api failed to load')); };
      document.head.appendChild(s);
    });
  }
  return scriptPromises[src];
}

export function JitsiStage({ roomId, name }) {
  const frameRef = useRef(null);
  const apiRef = useRef(null);
  const [status, setStatus] = useState('loading'); // loading | ready | error
  const [cam, setCam] = useState(false);
  const [mic, setMic] = useState(false);

  useEffect(() => {
    let disposed = false;
    let api = null;
    let joinTimer = null;
    let usingFallback = false;

    // Same look/behaviour on either provider — Nook's own buttons drive mute.
    const common = {
      configOverwrite: {
        prejoinPageEnabled: false, // legacy flag
        prejoinConfig: { enabled: false }, // current flag — skip the "Join meeting" step
        startWithAudioMuted: true,
        startWithVideoMuted: true,
        disableDeepLinking: true,
        toolbarButtons: [], // Nook's own buttons drive mute; hide Jitsi's bar
      },
      interfaceConfigOverwrite: {
        MOBILE_APP_PROMO: false,
        SHOW_JITSI_WATERMARK: false,
        SHOW_CHROME_EXTENSION_BANNER: false,
      },
    };

    function mount(domain, room, jwt) {
      const a = new window.JitsiMeetExternalAPI(domain, {
        roomName: room,
        ...(jwt ? { jwt } : {}),
        parentNode: frameRef.current,
        ...common,
      });
      a.addListener('videoConferenceJoined', () => {
        if (disposed) return;
        clearTimeout(joinTimer); // joined for real — no failover needed
        setStatus('ready');
      });
      a.addListener('audioMuteStatusChanged', (e) => setMic(!e.muted));
      a.addListener('videoMuteStatusChanged', (e) => setCam(!e.muted));
      return a;
    }

    // JaaS over its free MAU cap never fires a join event — it swaps the iframe
    // for 8x8's "limit reached" page — so a stalled join is our only signal.
    // Silently re-mount on the free public Jitsi (no JWT, no cap) so video
    // degrades to a backup instead of dying. Lower-reliability than JaaS, fine
    // for a few minutes of talking.
    // ponytail: reuse the already-loaded external_api.js against a second domain
    // (the lib is host-agnostic). If meet.jit.si ever needs its own copy, load
    // it here — that's the upgrade path.
    function failover(room) {
      if (disposed || usingFallback) return;
      usingFallback = true;
      try { api && api.dispose(); } catch { /* already gone */ }
      if (disposed || !frameRef.current) return;
      api = mount('meet.jit.si', room, null);
      apiRef.current = api;
      // If the free instance won't join either, surface the error.
      joinTimer = setTimeout(() => { if (!disposed) setStatus('error'); }, 12000);
    }

    (async () => {
      try {
        const r = await fetch(`${apiBase}/jitsi-token?room=${encodeURIComponent(roomId)}&name=${encodeURIComponent(name || 'Guest')}&did=${encodeURIComponent(getDid())}`);
        if (!r.ok) throw new Error('token');
        const { jwt, appId, roomName } = await r.json();
        await loadExternalApi(appId);
        if (disposed || !frameRef.current) return;
        api = mount('8x8.vc', `${appId}/${roomName}`, jwt);
        apiRef.current = api;
        // No join within 10s = the JaaS cap (or a hard block). Fall back.
        joinTimer = setTimeout(() => failover(roomName), 10000);
      } catch {
        if (!disposed) setStatus('error');
      }
    })();
    return () => {
      disposed = true;
      clearTimeout(joinTimer);
      try { api && api.dispose(); } catch { /* already gone */ }
      apiRef.current = null;
    };
    // Re-join only when the room changes; a name edit mid-session doesn't remount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  return (
    <div className="jitsi-stage">
      <div className="jitsi-frame" ref={frameRef}>
        {status !== 'ready' && (
          <div className="jitsi-overlay">
            {status === 'error'
              ? <span>Video couldn’t start. <button className="link-btn" onClick={() => window.location.reload()}>Reload</button></span>
              : <span>Starting video…</span>}
          </div>
        )}
      </div>
      <div className="jitsi-controls">
        <button className={`mediabtn ${cam ? '' : 'off'}`} onClick={() => apiRef.current?.executeCommand('toggleVideo')}
          aria-pressed={!cam} aria-label={cam ? 'Camera on' : 'Camera off'} disabled={status !== 'ready'}>
          <span aria-hidden="true">{cam ? '📷' : '🚫'}</span>
          <span className="mb-label">{cam ? 'Camera on' : 'Camera off'}</span>
        </button>
        <button className={`mediabtn ${mic ? '' : 'off'}`} onClick={() => apiRef.current?.executeCommand('toggleAudio')}
          aria-pressed={!mic} aria-label={mic ? 'Mic on' : 'Mic off'} disabled={status !== 'ready'}>
          <span aria-hidden="true">{mic ? '🎙' : '🔇'}</span>
          <span className="mb-label">{mic ? 'Mic on' : 'Mic off'}</span>
        </button>
      </div>
    </div>
  );
}
