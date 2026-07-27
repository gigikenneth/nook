import { useState } from 'react';
import { apiBase } from './config';

// In-app bug report. Files a GitHub issue via the Worker, so the reporter needs
// no account. `hp` is a honeypot: bots fill it, humans never see it.
export function ReportBug({ label = 'Report a bug' }) {
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState('');
  const [email, setEmail] = useState('');
  const [hp, setHp] = useState('');
  const [state, setState] = useState('idle'); // idle | sending | done | error

  function close() { setOpen(false); setState('idle'); setMsg(''); setEmail(''); }

  async function submit(e) {
    e.preventDefault();
    if (msg.trim().length < 5) return;
    setState('sending');
    try {
      const r = await fetch(`${apiBase}/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg, email, hp }),
      });
      setState(r.ok ? 'done' : 'error');
    } catch { setState('error'); }
  }

  return (
    <>
      <button className="link-btn inline" onClick={() => setOpen(true)}>{label}</button>
      {open && (
        <div className="report-overlay" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
          <div className="report-card">
            {state === 'done' ? (
              <>
                <h3 className="panel-title">Thanks 🙌</h3>
                <p className="hint">Your report went straight to the bug list. I'll take a look.</p>
                <button className="primary block" onClick={close}>Close</button>
              </>
            ) : (
              <form onSubmit={submit}>
                <h3 className="panel-title">Report a bug</h3>
                <p className="hint">What went wrong? No account needed.</p>
                <textarea value={msg} onChange={(e) => setMsg(e.target.value)} rows={4}
                  placeholder="Describe the bug — what you did and what happened…" maxLength={4000} autoFocus />
                <input value={email} onChange={(e) => setEmail(e.target.value)} maxLength={120}
                  placeholder="Your email (optional, only if you want a reply)" />
                <input className="hp-field" tabIndex={-1} autoComplete="off" aria-hidden="true"
                  value={hp} onChange={(e) => setHp(e.target.value)} />
                {state === 'error' && <p className="hint err">Couldn't send. Try again in a moment.</p>}
                <div className="report-actions">
                  <button type="button" className="ghost sm" onClick={close}>Cancel</button>
                  <button type="submit" className="primary sm" disabled={state === 'sending' || msg.trim().length < 5}>
                    {state === 'sending' ? 'Sending…' : 'Send report'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </>
  );
}
