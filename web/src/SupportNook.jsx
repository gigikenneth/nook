import { useState } from 'react';

// Three low-key ways to support Nook, opened from a footer link. No tiers, no
// gate: Nook stays login-free and free. Mirrors ReportBug's link + overlay.
export function SupportNook({ label = 'Support Nook' }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  function close() { setOpen(false); setCopied(false); }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.origin);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard blocked; the link is on screen anyway */ }
  }

  return (
    <>
      <button className="link-btn inline" onClick={() => setOpen(true)}>{label}</button>
      {open && (
        <div className="report-overlay" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
          <div className="report-card" role="dialog" aria-label="Support Nook">
            <h3 className="panel-title">Support Nook 🌙</h3>
            <p className="hint">Nook is free and stays that way. If it's useful to you, here are three ways to help, all optional:</p>
            <div className="support-ways">
              <p>⭐ <strong><a href="https://github.com/gigikenneth/nook" target="_blank" rel="noopener noreferrer">Star the repo</a></strong> so more people find Nook.</p>
              <p>👋 <strong>Bring someone.</strong> Nook is better with company. <button className="link-btn inline" onClick={copyLink}>{copied ? 'Link copied' : 'Copy the link'}</button> and cowork together.</p>
              <p>☕ <strong><a href="https://ko-fi.com/gigikenneth" target="_blank" rel="noopener noreferrer">Buy me a coffee</a></strong> if you'd like to chip in toward the time behind it.</p>
            </div>
            <button className="primary block" onClick={close}>Close</button>
          </div>
        </div>
      )}
    </>
  );
}
