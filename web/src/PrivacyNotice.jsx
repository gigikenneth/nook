import { useState } from 'react';

// Plain-language "what's kept where" panel (#140). Mirrors ReportBug's link +
// overlay. Keep it in step with what the Worker, the DOs and the browser
// storage keys hold. (No em dashes, per house style.)
export function PrivacyNotice({ label = 'Privacy' }) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <>
      <button className="link-btn inline" onClick={() => setOpen(true)}>{label}</button>
      {open && (
        <div className="report-overlay" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
          <div className="help-card privacy-card" role="dialog" aria-label="Privacy notice">
            <div className="help-head">
              <h3 className="panel-title" style={{ marginLeft: 10 }}>Privacy notice</h3>
              <button className="ghost x" onClick={close} aria-label="Close">×</button>
            </div>
            <div className="help-body">
              <p className="hint">Nook has no accounts and no database of people. Here is what is kept, and where.</p>
              <h4 className="help-subhead">Never saved</h4>
              <ul className="help-tips">
                <li><strong>Chat and pictures:</strong> passed straight to the people in your room and never saved on a server. A copy stays in your browser tab so a refresh can restore it, and it is gone when you close the tab. Photos are shrunk and their location data removed before they leave your device.</li>
                <li><strong>Video and audio:</strong> live only, never recorded. Calls run through our video provider, Daily, and your camera and mic stay off until you turn them on.</li>
              </ul>
              <h4 className="help-subhead">Kept in your browser</h4>
              <ul className="help-tips">
                <li>Your name, character, camera preference, theme and Auto away setting.</li>
                <li>Your to-do lists and saved lists, so you can bring them back next time.</li>
                <li>A random device ID, used only so people you block stay blocked. It is not linked to who you are.</li>
              </ul>
              <h4 className="help-subhead">Kept briefly on our servers</h4>
              <ul className="help-tips">
                <li>While a room is open: its timer, settings and who is in it, so the room and “Around now” work. It is cleared after the room empties out.</li>
                <li>Blocks, stored against the random device ID above.</li>
              </ul>
              <h4 className="help-subhead">Bug reports</h4>
              <ul className="help-tips">
                <li>A report becomes a public issue on Nook’s GitHub, including the email if you add one. Leave the email out if you would rather keep it private.</li>
              </ul>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
