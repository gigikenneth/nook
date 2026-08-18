import { useState } from 'react';

// Hand-maintained changelog, grouped by date, newest first. Add a new dated
// block at the top for each release; older ones stay below and the panel scrolls,
// so people can read back through past updates. (No em dashes, per house style.)
const CHANGELOG = [
  {
    date: 'August 18, 2026',
    items: [
      'New video: the call is steadier and needs no sign-in. Nothing said or shown is ever recorded',
      'The room list now shows each session’s focus length, so you can see how long it runs before you join',
    ],
  },
  {
    date: 'August 7, 2026',
    items: [
      'Dark mode: tap the moon in the header to switch, and Nook remembers your choice on your device',
      'Group audio is steadier: if someone’s voice does not come through, the connection now repairs itself instead of staying silent',
      'Fixed a glitch where you could momentarily show up twice after reconnecting',
      'Clearer wording in the greeting and the mid-session check-in',
    ],
  },
  {
    date: 'August 5, 2026',
    items: [
      'The focus screen is redesigned: with cameras off, people show as small name bubbles, and the space goes to a bigger chat and your to-do list side by side',
      'Greeting is simpler: share your goal out loud or typed, and pass the turn without having to type anything',
      'Drag to reorder your to-do list by its handle',
      'React to any chat message with an emoji',
      'Anyone can start the next session from regroup, not just the host',
      'A link to join the Discord, down in the footer',
    ],
  },
  {
    date: 'August 4, 2026',
    items: [
      'Share your to-do list with the room for accountability, or keep it private (it stays private unless you turn sharing on)',
      'Ignore someone in “Around now” so you and they no longer see each other, and can’t pull each other into a room. It sticks across visits',
      'Nook remembers your name and camera choice for next time, kept on your own device',
      'Turning your camera off now fully releases it, so the camera light goes off',
      'The pop-out timer works in Safari and other browsers now, not just Chrome',
    ],
  },
  {
    date: 'August 2, 2026',
    items: [
      'Your to-do list and chat now come back after a refresh or a dropped connection, kept only in your own browser',
      'Camera and mic controls are icon-only on phones so they don’t cover the screen',
      'Anyone can start the session, not just the host, in case the host drops',
    ],
  },
  {
    date: 'August 1, 2026',
    items: [
      'Pop-out timer so the countdown stays visible when you minimise the tab (desktop)',
      'Camera and mic stay off until you turn them on, in every phase',
      'A goal you type in greet now carries into your to-do list',
      'Removed the sound that played when someone joined',
    ],
  },
  {
    date: 'July 28, 2026',
    items: [
      'A flaky connection no longer spams the room with sounds',
      'A longer, clearer chime when the focus session ends',
    ],
  },
  {
    date: 'July 27, 2026',
    items: [
      'Your session survives a refresh or a dropped connection, so you pick up where you left off',
      'A 5 minute warning chime before focus ends',
      'A mid-session check-in to share how it is going',
      'The screen stays awake while a session is running',
      'The countdown now shows in the browser tab title',
      'Signal whether you are up for camera or camera-shy',
      'See who is around and invite them into your room',
    ],
  },
];

// A small "how to use Nook + what's new" panel, opened from the ? button.
export function HelpModal({ onClose }) {
  const [tab, setTab] = useState('how');
  return (
    <div className="report-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="help-card" role="dialog" aria-label="How Nook works">
        <div className="help-head">
          <div className="help-tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'how'} className={tab === 'how' ? 'sel' : ''} onClick={() => setTab('how')}>How it works</button>
            <button role="tab" aria-selected={tab === 'new'} className={tab === 'new' ? 'sel' : ''} onClick={() => setTab('new')}>What’s new</button>
          </div>
          <button className="ghost x" onClick={onClose} aria-label="Close">×</button>
        </div>

        {tab === 'how' ? (
          <div className="help-body">
            <ol className="help-steps">
              <li>Add your name.</li>
              <li>Join an open room or start your own, up to four people.</li>
              <li>Move through three short phases together, on a shared timer:</li>
            </ol>
            <ul className="help-phases">
              <li><strong>Greet.</strong> Say what you’re working on.</li>
              <li><strong>Focus.</strong> Heads-down with the countdown. Cameras off.</li>
              <li><strong>Regroup.</strong> See what got done, then run another round or head out.</li>
            </ul>
            <h4 className="help-subhead">Good to know</h4>
            <ul className="help-tips">
              <li><strong>Private group:</strong> start a room as <strong>Invite only</strong> and share the link with just the people you want. It stays off the public directory.</li>
              <li><strong>Lock a room:</strong> the host can lock a room to keep it to the current group, so no newcomers join.</li>
              <li><strong>Pop out the timer:</strong> on desktop, pop the countdown into a little always-on-top window so it stays visible when you minimise the tab.</li>
              <li><strong>Camera preference:</strong> signal whether you’re up for camera or camera-shy, so the group knows the vibe.</li>
              <li><strong>Join any time:</strong> you can join an open room even mid-session, and drop into whatever phase it’s in.</li>
            </ul>
            <p className="hint">Nothing here is recorded or saved. The video call is live only, and your to-do list and chat stay in your own browser. Your camera and mic are off until you turn them on.</p>
          </div>
        ) : (
          <div className="help-body">
            {CHANGELOG.map((rel) => (
              <div key={rel.date} className="help-release">
                <h4 className="help-date">{rel.date}</h4>
                <ul className="help-new">
                  {rel.items.map((line, i) => <li key={i}>{line}</li>)}
                </ul>
              </div>
            ))}
            <p className="help-end">🌙 You’re all caught up</p>
          </div>
        )}
      </div>
    </div>
  );
}
