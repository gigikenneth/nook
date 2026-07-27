import { useEffect, useState } from 'react';
import { apiBase } from './config';
import { useLobby } from './useLobby';
import { ReportBug } from './ReportBug.jsx';
import { Moon, Sparkles } from './graphics.jsx';

const uid = () => crypto.randomUUID();
const phaseLabel = { greet: 'greeting', focus: 'focusing', regroup: 'regrouping' };
const initials = (n) => (n || '?').trim().slice(0, 2).toUpperCase();
const AV = ['#3e5ad5', '#10124e', '#1f97bf', '#5a7d2a']; // blue, indigo, teal, moss — readable with white text

export default function Home({ pendingRoom, onEnter, embedded = false, initialName = '', onClose }) {
  const [name, setName] = useState(initialName);
  const [todos, setTodos] = useState(['']);
  const [focusMin, setFocusMin] = useState(50);
  const [regroupMin, setRegroupMin] = useState(5);
  const [rooms, setRooms] = useState([]);

  const cleanTodos = () => todos.map((t) => t.trim()).filter(Boolean);
  const canGo = name.trim().length > 0;

  // Presence: you're "around" as soon as you have a name (no extra opt-in step).
  // Not while shown as an in-room overlay — you're already in a session.
  const online = canGo && !pendingRoom && !embedded;
  const { roster, selfId, invite, dismissInvite, ping } = useLobby(online, name.trim());
  const others = roster.filter((p) => p.id !== selfId);

  function pingPerson(p) {
    const roomId = uid();
    ping(p.id, roomId); // invite them into a room we're about to open
    go(roomId, true);
  }
  function acceptInvite() {
    const roomId = invite.roomId;
    dismissInvite();
    onEnter({ roomId, name: name.trim(), todos: cleanTodos(), focusMin, regroupMin, isPublic: false });
  }

  // Poll the live directory of open rooms.
  useEffect(() => {
    if (pendingRoom) return;
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(`${apiBase}/rooms`);
        const data = await res.json();
        if (alive) setRooms(data.rooms || []);
      } catch {}
    };
    load();
    const t = setInterval(load, 4000);
    return () => { alive = false; clearInterval(t); };
  }, [pendingRoom]);

  // Esc closes the in-room overlay.
  useEffect(() => {
    if (!embedded) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [embedded, onClose]);

  function setTodo(i, v) {
    const next = [...todos];
    next[i] = v;
    if (i === todos.length - 1 && v.trim()) next.push('');
    setTodos(next);
  }
  function removeTodo(i) {
    setTodos(todos.length === 1 ? [''] : todos.filter((_, j) => j !== i));
  }

  function go(roomId, isPublic) {
    onEnter({ roomId, name: name.trim(), todos: cleanTodos(), focusMin, regroupMin, isPublic });
  }

  const identity = (
    <div className="card">
      <label className="field">
        <span>Your name</span>
        <input id="nook-name" value={name} onChange={(e) => setName(e.target.value)}
          placeholder="What should we call you?" maxLength={32} />
      </label>
      <div className="field">
        <span>What you're working on</span>
        <ul className="todo-edit">
          {todos.map((t, i) => (
            <li key={i}>
              <input value={t} onChange={(e) => setTodo(i, e.target.value)}
                placeholder={i === 0 ? 'One thing you want to finish…' : 'And…'} maxLength={120} />
              {t.trim() && <button className="ghost x" onClick={() => removeTodo(i)} aria-label="Remove">×</button>}
            </li>
          ))}
        </ul>
      </div>
      <div className="field">
        <span>Session length</span>
        <div className="durations">
          <label className="field small"><span>Focus (min)</span>
            <input type="number" min="1" max="180" value={focusMin} onChange={(e) => setFocusMin(Number(e.target.value))} /></label>
          <label className="field small"><span>Regroup (min)</span>
            <input type="number" min="0" max="60" value={regroupMin} onChange={(e) => setRegroupMin(Number(e.target.value))} /></label>
        </div>
      </div>
    </div>
  );

  if (pendingRoom) {
    return (
      <main className="home">
        <Sparkles />
        <header className="brand">
          <h1>Nook</h1><span className="beta-tag">beta</span>
          <p className="tagline">You've been invited. Add your name and what you're here to do.</p>
          <Moon size={40} />
        </header>
        {identity}
        <button className="primary block" disabled={!canGo} onClick={() => go(pendingRoom, false)}>Enter room</button>
      </main>
    );
  }

  const wide = (
    <main className={`home wide${embedded ? ' embedded' : ''}`}>
      {embedded && <button className="overlay-close" onClick={onClose} aria-label="Close">×</button>}
      <Sparkles />
      {!embedded && invite && (
        <div className="invite-toast" role="alert">
          <span><strong>{invite.fromName}</strong> wants to cowork ✌️</span>
          <div className="invite-actions">
            <button className="primary sm" onClick={acceptInvite}>Join</button>
            <button className="ghost sm" onClick={dismissInvite}>Dismiss</button>
          </div>
        </div>
      )}
      <header className="brand">
        <h1>Nook</h1><span className="beta-tag">beta</span>
        <p className="tagline">Your focus crew for the next 50 minutes. Show up, say what you're on, and get it done alongside a few other people.</p>
        <Moon size={40} />
      </header>

      <ol className="steps">
        <li><span>1</span> Add your name</li>
        <li><span>2</span> Join a room or open your own</li>
        <li><span>3</span> Focus together, then regroup</li>
      </ol>

      <section className="directory card">
        <div className="panel-head">
          <h2 className="panel-title">Who's coworking now</h2>
          <span className="live-dot" title="live" />
        </div>
        {rooms.length === 0 ? (
          <p className="chat-empty">No open rooms yet. Be the first. Open one below.</p>
        ) : (
          <ul className="room-list">
            {rooms.map((r) => {
              // Live sessions show how long is left; refreshed each poll (~4s).
              const minsLeft = r.endsAt ? Math.max(0, Math.round((r.endsAt - Date.now()) / 60000)) : null;
              // Private sessions appear anonymously — visibility without exposure.
              if (r.isPublic === false) {
                return (
                  <li key={r.roomId} className="room-row private">
                    <div className="room-left">
                      <span className="room-av lock" aria-hidden="true">🔒</span>
                      <div className="room-people"><strong>Private session</strong></div>
                    </div>
                    <div className="room-meta">
                      <span className={`badge badge-${r.phase}`}>{phaseLabel[r.phase]}</span>
                      {minsLeft != null && <span className="time-left">~{minsLeft}m left</span>}
                    </div>
                  </li>
                );
              }
              const names = r.occupants.map((o) => o.name).join(', ');
              const goals = r.occupants.map((o) => o.goal).filter(Boolean).join(' · ');
              const full = r.count >= 4;
              return (
                <li key={r.roomId} className="room-row">
                  <div className="room-left">
                    <div className="room-avatars">
                      {r.occupants.slice(0, 4).map((o, i) => (
                        <span key={i} className="room-av" style={{ background: AV[i % AV.length] }}>{initials(o.name)}</span>
                      ))}
                    </div>
                    <div className="room-people">
                      <strong>{names || 'Someone'}</strong>
                      {goals && <span>{goals}</span>}
                    </div>
                  </div>
                  <div className="room-meta">
                    <span className={`badge badge-${r.phase}`}>{phaseLabel[r.phase]}</span>
                    {minsLeft != null && <span className="time-left">~{minsLeft}m left</span>}
                    {r.locked && <span className="badge badge-locked" title="Closed to new people">🔒</span>}
                    <span className="count">{r.count}/4</span>
                    <button className="primary sm" disabled={full || !canGo || r.locked}
                      title={r.locked ? 'Locked by the host' : !canGo ? 'Add your name first' : full ? 'Room is full' : ''}
                      onClick={() => go(r.roomId, true)}>Join</button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {identity}

      {!embedded && (
      <section className="card presence">
        <div className="panel-head">
          <h2 className="panel-title">Around now</h2>
          {online && <span className="live-dot" title="you're visible here" />}
        </div>
        {online ? (
          others.length === 0 ? (
            <p className="chat-empty">You're here. When others show up you'll see them, and they can ping you to cowork.</p>
          ) : (
            <ul className="people-list">
              {others.map((p, i) => (
                <li key={p.id} className="person-row">
                  <span className="goal-chip" style={{ background: AV[i % AV.length] }}>{initials(p.name)}</span>
                  <strong>{p.name}</strong>
                  <button className="primary sm" onClick={() => pingPerson(p)}>Ping to cowork</button>
                </li>
              ))}
            </ul>
          )
        ) : (
          <p className="hint">
            <button className="link-btn inline" onClick={() => { const el = document.getElementById('nook-name'); el?.scrollIntoView({ block: 'center', behavior: 'smooth' }); el?.focus(); }}>Add your name</button>
            {' '}above to see who's around and let people invite you.
          </p>
        )}
      </section>
      )}

      <section className="card start-card">
        <h2 className="panel-title">Start your own</h2>
        <div className="actions two">
          <button className="primary" disabled={!canGo} onClick={() => go(uid(), true)}>
            Open room
            <small>Anyone can join, listed above</small>
          </button>
          <button className="secondary" disabled={!canGo} onClick={() => go(uid(), false)}>
            Invite only
            <small>Private, share the link yourself</small>
          </button>
        </div>
      </section>

      <footer className="site-foot">
        <span>Nook is in beta, and I'm actively tinkering with it.</span>
        <span>Found a bug? <ReportBug label="Report it" /></span>
        <span>Built by <a href="https://www.gigikenneth.com/" target="_blank" rel="noopener noreferrer">Gigi</a>. <a href="https://github.com/gigikenneth/nook" target="_blank" rel="noopener noreferrer">Source on GitHub</a>.</span>
      </footer>
    </main>
  );

  if (embedded) {
    return (
      <div className="home-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        {wide}
      </div>
    );
  }
  return wide;
}
