import { useState } from 'react';
import { apiBase } from './config';

const uid = () => crypto.randomUUID();

export default function Home({ pendingRoom, onEnter }) {
  const [name, setName] = useState('');
  const [todos, setTodos] = useState(['']);
  const [focusMin, setFocusMin] = useState(50);
  const [regroupMin, setRegroupMin] = useState(5);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);

  const cleanTodos = () => todos.map((t) => t.trim()).filter(Boolean);
  const canGo = name.trim().length > 0;

  function setTodo(i, v) {
    const next = [...todos];
    next[i] = v;
    if (i === todos.length - 1 && v.trim()) next.push('');
    setTodos(next);
  }
  function removeTodo(i) {
    setTodos(todos.length === 1 ? [''] : todos.filter((_, j) => j !== i));
  }

  function go(roomId) {
    onEnter({ roomId, name: name.trim(), todos: cleanTodos(), focusMin, regroupMin });
  }

  async function match() {
    setBusy(true);
    try {
      const res = await fetch(`${apiBase}/match`);
      const { roomId } = await res.json();
      go(roomId);
    } catch {
      setBusy(false);
    }
  }

  return (
    <main className="home">
      <header className="brand">
        <span className="brand-mark" aria-hidden="true" />
        <h1>Nook</h1>
        <p className="tagline">Quiet coworking for up to four. Show up, set an intention, get it done.</p>
      </header>

      <div className="card">
        {pendingRoom && (
          <p className="joining">You're joining a room. Say who you are and what you're here to do.</p>
        )}

        <label className="field">
          <span>Your name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="What should we call you?"
            maxLength={32}
            autoFocus
          />
        </label>

        <div className="field">
          <span>Today's intentions</span>
          <ul className="todo-edit">
            {todos.map((t, i) => (
              <li key={i}>
                <input
                  value={t}
                  onChange={(e) => setTodo(i, e.target.value)}
                  placeholder={i === 0 ? 'One thing you want to finish…' : 'And…'}
                  maxLength={120}
                />
                {t.trim() && (
                  <button className="ghost x" onClick={() => removeTodo(i)} aria-label="Remove">
                    ×
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>

        <button className="link-btn" onClick={() => setShowAdvanced((s) => !s)}>
          {showAdvanced ? 'Hide session length' : 'Set session length'}
        </button>
        {showAdvanced && (
          <div className="durations">
            <label className="field small">
              <span>Focus (min)</span>
              <input type="number" min="1" max="180" value={focusMin}
                onChange={(e) => setFocusMin(Number(e.target.value))} />
            </label>
            <label className="field small">
              <span>Regroup (min)</span>
              <input type="number" min="0" max="60" value={regroupMin}
                onChange={(e) => setRegroupMin(Number(e.target.value))} />
            </label>
          </div>
        )}

        {pendingRoom ? (
          <button className="primary" disabled={!canGo} onClick={() => go(pendingRoom)}>
            Enter room
          </button>
        ) : (
          <div className="actions">
            <button className="primary" disabled={!canGo} onClick={() => go(uid())}>
              Start a room
            </button>
            <button className="secondary" disabled={!canGo || busy} onClick={match}>
              {busy ? 'Finding a room…' : 'Match me with others'}
            </button>
          </div>
        )}
        {!pendingRoom && (
          <p className="hint">Starting a room gives you a private link to share. Matching drops you in with whoever's around.</p>
        )}
      </div>
    </main>
  );
}
