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
    let adapter = null; // uniform { toggleVideo, toggleAudio, dispose } for whichever provider is live
    let joinTimer = null;
    let usingFallback = false;

    // Mount the JaaS (8x8) call and wrap it in the uniform adapter so Nook's own
    // Camera/Mic buttons drive mute regardless of provider.
    function mountJitsi(room, jwt) {
      const a = new window.JitsiMeetExternalAPI('8x8.vc', {
        roomName: room,
        jwt,
        parentNode: frameRef.current,
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
      });
      a.addListener('videoConferenceJoined', () => {
        if (disposed) return;
        clearTimeout(joinTimer); // joined for real — no failover needed
        setStatus('ready');
      });
      a.addListener('audioMuteStatusChanged', (e) => setMic(!e.muted));
      a.addListener('videoMuteStatusChanged', (e) => setCam(!e.muted));
      return {
        toggleVideo: () => a.executeCommand('toggleVideo'),
        toggleAudio: () => a.executeCommand('toggleAudio'),
        dispose: () => { try { a.dispose(); } catch { /* already gone */ } },
      };
    }

    // Mount a PUBLIC Daily.co room as the backup, in the same iframe slot. Daily's
    // client lib is loaded on demand (only when we actually fail over) so it never
    // weighs down the primary JaaS path.
    async function mountDaily(url) {
      const { default: DailyIframe } = await import('@daily-co/daily-js');
      const frame = DailyIframe.createFrame(frameRef.current, {
        showLeaveButton: false,
        iframeStyle: { width: '100%', height: '100%', border: '0' },
      });
      frame.on('participant-updated', (e) => {
        if (e?.participant?.local) { setCam(!!e.participant.video); setMic(!!e.participant.audio); }
      });
      // join() resolves only once we're actually in the call — that's our
      // authoritative "joined" signal. We deliberately don't lean on the
      // 'joined-meeting' event: it fires mid-await, which raced the give-up timer.
      await frame.join({ url, startVideoOff: true, startAudioOff: true });
      const local = () => frame.participants().local || {};
      return {
        toggleVideo: () => frame.setLocalVideo(!local().video),
        toggleAudio: () => frame.setLocalAudio(!local().audio),
        dispose: () => { try { frame.destroy(); } catch { /* already gone */ } },
      };
    }

    // JaaS over its free cap never fires a join event — it swaps the iframe for
    // 8x8's "limit reached" page — so a stalled join is our only signal. Silently
    // re-mount on a public Daily room (no login, no JaaS cap) so video degrades to
    // a backup instead of dying. Falls through to the error state if Daily won't
    // join either, or isn't configured.
    async function failover() {
      if (disposed || usingFallback) return;
      usingFallback = true;
      try { adapter && adapter.dispose(); } catch { /* already gone */ }
      if (disposed || !frameRef.current) return;
      try {
        const r = await fetch(`${apiBase}/daily-room?room=${encodeURIComponent(roomId)}`);
        if (!r.ok) throw new Error('daily');
        const { url } = await r.json();
        if (disposed || !frameRef.current) return;
        // Arm the give-up timer BEFORE the join await — it only guards a join
        // that hangs. A successful join resolves below and clears it; it must
        // never fire against a call that already connected.
        joinTimer = setTimeout(() => { if (!disposed) setStatus('error'); }, 15000);
        adapter = await mountDaily(url); // resolves once actually joined
        clearTimeout(joinTimer);
        if (disposed) { adapter.dispose(); return; }
        apiRef.current = adapter;
        setStatus('ready');
      } catch {
        clearTimeout(joinTimer);
        if (!disposed) setStatus('error');
      }
    }

    (async () => {
      try {
        const r = await fetch(`${apiBase}/jitsi-token?room=${encodeURIComponent(roomId)}&name=${encodeURIComponent(name || 'Guest')}&did=${encodeURIComponent(getDid())}`);
        if (!r.ok) throw new Error('token');
        const { jwt, appId, roomName } = await r.json();
        await loadExternalApi(appId);
        if (disposed || !frameRef.current) return;
        adapter = mountJitsi(`${appId}/${roomName}`, jwt);
        apiRef.current = adapter;
        // No join within 10s = the JaaS cap (or a hard block). Fall back to Daily.
        joinTimer = setTimeout(failover, 10000);
      } catch {
        if (!disposed) setStatus('error');
      }
    })();
    return () => {
      disposed = true;
      clearTimeout(joinTimer);
      try { adapter && adapter.dispose(); } catch { /* already gone */ }
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
        <button className={`mediabtn ${cam ? '' : 'off'}`} onClick={() => apiRef.current?.toggleVideo()}
          aria-pressed={!cam} aria-label={cam ? 'Camera on' : 'Camera off'} disabled={status !== 'ready'}>
          <span aria-hidden="true">{cam ? '📷' : '🚫'}</span>
          <span className="mb-label">{cam ? 'Camera on' : 'Camera off'}</span>
        </button>
        <button className={`mediabtn ${mic ? '' : 'off'}`} onClick={() => apiRef.current?.toggleAudio()}
          aria-pressed={!mic} aria-label={mic ? 'Mic on' : 'Mic off'} disabled={status !== 'ready'}>
          <span aria-hidden="true">{mic ? '🎙' : '🔇'}</span>
          <span className="mb-label">{mic ? 'Mic on' : 'Mic off'}</span>
        </button>
      </div>
    </div>
  );
}
