import { useEffect, useState } from 'react';
import { apiBase } from './config';
import { Moon, Sparkles } from './graphics.jsx';

const uid = () => crypto.randomUUID();
const phaseLabel = { greet: 'greeting', focus: 'focusing', regroup: 'regrouping' };

export default function Home({ pendingRoom, onEnter }) {
  const [name, setName] = useState('');
  const [todos, setTodos] = useState(['']);
  const [focusMin, setFocusMin] = useState(50);
  const [regroupMin, setRegroupMin] = useState(5);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [rooms, setRooms] = useState([]);

  const cleanTodos = () => todos.map((t) => t.trim()).filter(Boolean);
  const canGo = name.trim().length > 0;

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
        <input value={name} onChange={(e) => setName(e.target.value)}
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
      <button className="link-btn" onClick={() => setShowAdvanced((s) => !s)}>
        {showAdvanced ? 'Hide session length' : 'Set session length'}
      </button>
      {showAdvanced && (
        <div className="durations">
          <label className="field small"><span>Focus (min)</span>
            <input type="number" min="1" max="180" value={focusMin} onChange={(e) => setFocusMin(Number(e.target.value))} /></label>
          <label className="field small"><span>Regroup (min)</span>
            <input type="number" min="0" max="60" value={regroupMin} onChange={(e) => setRegroupMin(Number(e.target.value))} /></label>
        </div>
      )}
    </div>
  );

  if (pendingRoom) {
    return (
      <main className="home">
        <Sparkles />
        <header className="brand">
          <h1>Nook</h1>
          <p className="tagline">You've been invited. Add your name and what you're here to do.</p>
          <Moon size={40} />
        </header>
        {identity}
        <button className="primary block" disabled={!canGo} onClick={() => go(pendingRoom, false)}>Enter room</button>
      </main>
    );
  }

  return (
    <main className="home wide">
      <Sparkles />
      <header className="brand">
        <h1>Nook</h1>
        <p className="tagline">Quiet coworking for up to four. See who's around, or open a room and let people join.</p>
        <Moon size={40} />
      </header>

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
              const names = r.occupants.map((o) => o.name).join(', ');
              const goals = r.occupants.map((o) => o.goal).filter(Boolean).join(' · ');
              const full = r.count >= 4;
              return (
                <li key={r.roomId} className="room-row">
                  <div className="room-people">
                    <strong>{names || 'Someone'}</strong>
                    {goals && <span>{goals}</span>}
                  </div>
                  <div className="room-meta">
                    <span className={`badge badge-${r.phase}`}>{phaseLabel[r.phase]}</span>
                    <span className="count">{r.count}/4</span>
                    <button className="primary sm" disabled={full || !canGo}
                      title={!canGo ? 'Add your name first' : full ? 'Room is full' : ''}
                      onClick={() => go(r.roomId, true)}>Join</button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {identity}

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
    </main>
  );
}
