import { useEffect, useRef, useState } from 'react';
import { apiBase } from './config';

// Login-free video via a PUBLIC Daily.co room. No account, no moderator gate:
// the room name is a stable hash of Nook's room id (server-minted at
// /daily-room), so only people already in this Nook room reach the call. Nook's
// own Camera/Mic buttons drive mute via a small adapter; Daily's own UI is left
// as-is (a rare-path polish we skip).
//
// JaaS (8x8) is deliberately OUT of rotation for now (it was capped). Its mount
// path lived here previously — re-add an attemptJitsi + failover if we bring it
// back. Mounted only during greet/regroup (the phases with cameras).

export function JitsiStage({ roomId, name }) { // eslint-disable-line no-unused-vars
  const frameRef = useRef(null);
  const apiRef = useRef(null);
  const [status, setStatus] = useState('loading'); // loading | ready | error
  const [cam, setCam] = useState(false);
  const [mic, setMic] = useState(false);

  useEffect(() => {
    let disposed = false;
    let adapter = null; // uniform { toggleVideo, toggleAudio, dispose }
    let joinTimer = null;

    async function mountDaily(url) {
      const { default: DailyIframe } = await import('@daily-co/daily-js');
      const frame = DailyIframe.createFrame(frameRef.current, {
        showLeaveButton: false,
        iframeStyle: { width: '100%', height: '100%', border: '0' },
      });
      frame.on('participant-updated', (e) => {
        if (e?.participant?.local) { setCam(!!e.participant.video); setMic(!!e.participant.audio); }
      });
      // join() resolves only once actually in the call — the authoritative
      // "joined" signal. A hung join rejects at 15s.
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
      try {
        const r = await fetch(`${apiBase}/daily-room?room=${encodeURIComponent(roomId)}`);
        if (!r.ok) throw new Error('daily room');
        const { url } = await r.json();
        if (disposed || !frameRef.current) return;
        adapter = await mountDaily(url);
        if (disposed) { adapter.dispose(); return; }
        apiRef.current = adapter;
        setStatus('ready');
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
