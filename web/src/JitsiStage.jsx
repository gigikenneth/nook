import { useEffect, useRef, useState } from 'react';
import { apiBase } from './config';
import { getDid } from './device';

// Login-free video with two interchangeable providers, tried in an order the
// server picks (/video-config -> primary): JaaS (8x8.vc, signed JWT) and a
// public Daily.co room. Whichever we lead with, a stalled join falls over to the
// other; Nook's own Camera/Mic buttons drive mute on either via a uniform adapter.
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
    let adapter = null; // uniform { toggleVideo, toggleAudio, dispose } for whichever provider joined

    // Attempt JaaS (8x8). Resolves with an adapter once actually joined; rejects
    // (and cleans up its iframe) if no join lands within 10s — the only signal we
    // get when JaaS is over its free cap (it shows a "limit reached" page instead).
    async function attemptJitsi() {
      const r = await fetch(`${apiBase}/jitsi-token?room=${encodeURIComponent(roomId)}&name=${encodeURIComponent(name || 'Guest')}&did=${encodeURIComponent(getDid())}`);
      if (!r.ok) throw new Error('jaas token');
      const { jwt, appId, roomName } = await r.json();
      await loadExternalApi(appId);
      if (disposed || !frameRef.current) throw new Error('gone');
      return await new Promise((resolve, reject) => {
        const a = new window.JitsiMeetExternalAPI('8x8.vc', {
          roomName: `${appId}/${roomName}`,
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
        const stall = setTimeout(() => { try { a.dispose(); } catch { /* gone */ } reject(new Error('jaas stall')); }, 10000);
        a.addListener('videoConferenceJoined', () => {
          clearTimeout(stall);
          resolve({
            toggleVideo: () => a.executeCommand('toggleVideo'),
            toggleAudio: () => a.executeCommand('toggleAudio'),
            dispose: () => { try { a.dispose(); } catch { /* gone */ } },
          });
        });
        a.addListener('audioMuteStatusChanged', (e) => setMic(!e.muted));
        a.addListener('videoMuteStatusChanged', (e) => setCam(!e.muted));
      });
    }

    // Attempt a PUBLIC Daily.co room. Daily's lib is loaded on demand. join()
    // resolving is the authoritative "joined" signal; a hung join rejects at 15s.
    async function attemptDaily() {
      const r = await fetch(`${apiBase}/daily-room?room=${encodeURIComponent(roomId)}`);
      if (!r.ok) throw new Error('daily room');
      const { url } = await r.json();
      if (disposed || !frameRef.current) throw new Error('gone');
      const { default: DailyIframe } = await import('@daily-co/daily-js');
      const frame = DailyIframe.createFrame(frameRef.current, {
        showLeaveButton: false,
        iframeStyle: { width: '100%', height: '100%', border: '0' },
      });
      frame.on('participant-updated', (e) => {
        if (e?.participant?.local) { setCam(!!e.participant.video); setMic(!!e.participant.audio); }
      });
      const stall = new Promise((_, rej) => setTimeout(() => rej(new Error('daily stall')), 15000));
      try {
        await Promise.race([frame.join({ url, startVideoOff: true, startAudioOff: true }), stall]);
      } catch (e) {
        try { frame.destroy(); } catch { /* gone */ }
        throw e;
      }
      const local = () => frame.participants().local || {};
      return {
        toggleVideo: () => frame.setLocalVideo(!local().video),
        toggleAudio: () => frame.setLocalAudio(!local().audio),
        dispose: () => { try { frame.destroy(); } catch { /* gone */ } },
      };
    }

    (async () => {
      // Server decides which provider leads (config flip, no rebuild). Default
      // daily while JaaS is capped, so newcomers never see the "limit" page.
      let primary = 'daily';
      try {
        const cfg = await fetch(`${apiBase}/video-config`);
        if (cfg.ok) primary = (await cfg.json()).primary === 'jaas' ? 'jaas' : 'daily';
      } catch { /* fall back to the default order */ }
      if (disposed) return;
      const order = primary === 'jaas' ? [attemptJitsi, attemptDaily] : [attemptDaily, attemptJitsi];
      for (const attempt of order) {
        if (disposed) return;
        try {
          adapter = await attempt();
          if (disposed) { adapter.dispose(); return; }
          apiRef.current = adapter;
          setStatus('ready');
          return;
        } catch { /* stalled/failed — try the other provider */ }
      }
      if (!disposed) setStatus('error'); // both providers failed
    })();

    return () => {
      disposed = true;
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
