import { useEffect, useRef, useState } from 'react';
import { useRoom } from './useRoom';
import { chime } from './sound';
import { Moon, ChatDoodle } from './graphics.jsx';

const initials = (n) => (n || '?').trim().slice(0, 2).toUpperCase();
const CHIP = ['#29bcee', '#a5d67b', '#6be492', '#171a6b']; // cyan, lime, green, indigo (Groove complements)

let taskSeq = 0;
const nextTaskId = () => ++taskSeq;

function download(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function Video({ stream, muted }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current && stream) ref.current.srcObject = stream; }, [stream]);
  return <video ref={ref} autoPlay playsInline muted={muted} />;
}

function Tile({ name, stream, self, camOff, isHost, canKick, onKick }) {
  return (
    <div className={`tile ${camOff ? 'camoff' : ''}`}>
      {stream && !camOff ? <Video stream={stream} muted={self} /> : <div className="avatar">{initials(name)}</div>}
      <div className="tile-bar">
        <span className="tile-name">{name}{self ? ' (you)' : ''}{isHost ? ' · host' : ''}</span>
        {canKick && <button className="ghost kick" onClick={onKick}>Remove</button>}
      </div>
    </div>
  );
}

function Timer({ endsAt, label }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(t); }, []);
  if (!endsAt) return null;
  const remaining = Math.max(0, endsAt - now);
  const mm = String(Math.floor(remaining / 60000)).padStart(2, '0');
  const ss = String(Math.floor((remaining % 60000) / 1000)).padStart(2, '0');
  return (
    <div className="timer">
      <span className="timer-label">{label}</span>
      <span className="timer-clock">{mm}:{ss}</span>
    </div>
  );
}

export default function Room({ roomId, name, todos, focusMin, regroupMin, isPublic, onLeave }) {
  const room = useRoom(roomId, name, { focusMin, regroupMin, isPublic });
  const { selfId, hostId, peers, phase, endsAt, ready, goals, chat, status, local } = room;

  const [goal, setGoal] = useState(todos[0] || '');
  // Personal, editable task list (browser-only, never synced). Stable ids so
  // add/edit/delete works mid-session without index shuffling.
  const [tasks, setTasks] = useState(() => todos.map((t) => ({ id: nextTaskId(), text: t, done: false })));
  const addTask = (text) => setTasks((ts) => [...ts, { id: nextTaskId(), text, done: false }]);
  const editTask = (id, text) => setTasks((ts) => ts.map((t) => (t.id === id ? { ...t, text } : t)));
  const toggleTask = (id) => setTasks((ts) => ts.map((t) => (t.id === id ? { ...t, done: !t.done } : t)));
  const removeTask = (id) => setTasks((ts) => ts.filter((t) => t.id !== id));
  const [copied, setCopied] = useState(false);
  const [draft, setDraft] = useState('');

  const isHost = selfId && selfId === hostId;
  const iAmReady = selfId && ready.includes(selfId);
  const peerIds = Object.keys(peers);
  const count = peerIds.length + 1;
  const inviteLink = `${window.location.origin}${window.location.pathname}#room/${encodeURIComponent(roomId)}`;
  const camOff = phase === 'focus';

  // Send the pre-typed goal once connected.
  const sentGoal = useRef(false);
  useEffect(() => {
    if (selfId && goal.trim() && !sentGoal.current) { room.sendGoal(goal.trim()); sentGoal.current = true; }
  }, [selfId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Chimes on phase transitions.
  const prevPhase = useRef(phase);
  useEffect(() => {
    const prev = prevPhase.current;
    if (prev !== phase) {
      if (phase === 'focus') chime('start');
      else if (phase === 'regroup') chime('end');
      else if (phase === 'greet' && prev === 'regroup') chime('regroup');
      prevPhase.current = phase;
    }
  }, [phase]);

  // Keep the chat log pinned to the newest message.
  const logRef = useRef(null);
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [chat.length]);

  function copy() {
    navigator.clipboard?.writeText(inviteLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  function send(e) {
    e.preventDefault();
    const t = draft.trim();
    if (t) { room.sendChat(t); setDraft(''); }
  }
  function downloadTodos() {
    const body = tasks.map((t) => `[${t.done ? 'x' : ' '}] ${t.text}`).join('\n');
    download('nook-todo.txt', `Nook to-do list\n\n${body || '(empty)'}\n`);
  }
  function downloadChat() {
    const body = chat.map((m) => `[${new Date(m.t).toLocaleTimeString()}] ${m.name}: ${m.text}`).join('\n');
    download('nook-chat.txt', `Nook chat log\n\n${body || '(no messages)'}\n`);
  }

  if (status === 'kicked') return <Ended msg="You were removed from this room." onLeave={onLeave} />;
  if (status === 'full') return <Ended msg="That room is full. Four is the max." onLeave={onLeave} />;
  if (status === 'offline') return <Ended msg="Can't reach the server. Is the Worker running on :8787?" onLeave={onLeave} />;
  if (status === 'closed') return <Ended msg="You left the room." onLeave={onLeave} />;

  return (
    <main className="room">
      <header className="room-head">
        <div className="room-id">
          <Moon size={26} className="small" /><span>Nook</span>
          <span className="dot">·</span><span className="count">{count}/4 here</span>
          {isPublic ? <span className="badge badge-greet">open</span> : <span className="badge">invite only</span>}
        </div>
        <div className="room-actions">
          <button className="secondary sm" onClick={copy}>{copied ? 'Link copied' : 'Copy invite link'}</button>
          <button className="primary sm" onClick={onLeave}>Leave 🔥</button>
        </div>
      </header>

      <PhaseBanner phase={phase} endsAt={endsAt} regroupMin={regroupMin} />

      <section className="stage">
        <div className={`grid grid-${count}`}>
          <Tile name={name} stream={local} self camOff={camOff} isHost={isHost} />
          {peerIds.map((id) => (
            <Tile key={id} name={peers[id].name || 'Guest'} stream={peers[id].stream} camOff={camOff}
              isHost={id === hostId} canKick={isHost && id !== selfId} onKick={() => room.kick(id)} />
          ))}
        </div>

        <div className="rail">
          <aside className="panel">
            {phase === 'greet' && (
              <GreetPanel goal={goal} setGoal={setGoal}
                onShareGoal={() => goal.trim() && room.sendGoal(goal.trim())}
                goals={goals} peers={peers} ready={ready} iAmReady={iAmReady} count={count}
                onReady={() => room.setReady(!iAmReady)} isHost={isHost} onStart={room.start} />
            )}
            {phase === 'focus' && (
              <FocusPanel tasks={tasks} onAdd={addTask} onEdit={editTask} onToggle={toggleTask}
                onRemove={removeTask} endsAt={endsAt} />
            )}
            {phase === 'regroup' && (
              <RegroupPanel tasks={tasks} endsAt={endsAt} isHost={isHost} onRestart={room.restart} />
            )}
          </aside>

          <aside className="panel chat-panel">
            <div className="panel-head">
              <h3 className="panel-title">Chat</h3>
              <span className="hint">not saved</span>
            </div>
            <div className="chat-log" ref={logRef}>
              {chat.length === 0 ? (
                <div className="chat-empty"><ChatDoodle /><p>Say something. Messages vanish when the room does.</p></div>
              ) : chat.map((m, i) => (
                <div key={i} className={`chat-msg ${m.id === selfId ? 'mine' : ''}`}>
                  <span className="who">{m.id === selfId ? 'You' : m.name}</span>
                  <span className="body">{m.text}</span>
                </div>
              ))}
            </div>
            <form className="chat-form" onSubmit={send}>
              <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Message…" maxLength={500} />
              <button className="primary chat-send" type="submit" disabled={!draft.trim()}>Send</button>
            </form>
            <div className="dl-row">
              <button className="secondary sm" onClick={downloadTodos}>Download list</button>
              <button className="secondary sm" onClick={downloadChat} disabled={chat.length === 0}>Download chat</button>
            </div>
          </aside>
        </div>
      </section>
    </main>
  );
}

function PhaseBanner({ phase, endsAt, regroupMin }) {
  const copy = {
    greet: { t: 'Say hello', s: 'Cameras on. Share what you’re working on, then mark yourself ready.' },
    focus: { t: 'Heads down', s: 'Cameras off. Just you, your list, and the clock.' },
    regroup: { t: 'Regroup', s: regroupMin > 0 ? 'Cameras back on. How did it go?' : 'Wrapping up.' },
  }[phase];
  return (
    <div className={`banner banner-${phase}`}>
      <div><h2>{copy.t}</h2><p>{copy.s}</p></div>
      {phase !== 'greet' && <Timer endsAt={endsAt} label={phase === 'focus' ? 'focus ends in' : 'regroup ends in'} />}
    </div>
  );
}

function GreetPanel({ goal, setGoal, onShareGoal, goals, peers, ready, iAmReady, count, onReady, isHost, onStart }) {
  const others = Object.keys(peers);
  return (
    <>
      <label className="field">
        <span>What are you working on?</span>
        <input value={goal} onChange={(e) => setGoal(e.target.value)} onBlur={onShareGoal}
          placeholder="Your focus for this session" maxLength={200} />
      </label>
      <ul className="goal-list">
        {others.map((id, i) => (
          <li key={id}>
            <span className="goal-chip" style={{ background: CHIP[i % CHIP.length] }}>{initials(peers[id].name)}</span>
            <div className="goal-body">
              <strong>{peers[id].name || 'Guest'}’s goal</strong>
              <span>{goals[id] || '…'}</span>
            </div>
          </li>
        ))}
      </ul>
      <div className="ready-row">
        <span>{ready.length}/{count} ready</span>
        <button className={`primary ${iAmReady ? 'is-on' : ''}`} onClick={onReady}>{iAmReady ? 'Ready ✓' : 'I’m ready'}</button>
      </div>
      {isHost && <button className="link-btn" onClick={onStart}>Start now (don’t wait)</button>}
      <p className="hint">Focus begins when everyone’s ready.</p>
    </>
  );
}

function FocusPanel({ tasks, onAdd, onEdit, onToggle, onRemove, endsAt }) {
  const [draft, setDraft] = useState('');
  function add(e) {
    e.preventDefault();
    const t = draft.trim();
    if (t) { onAdd(t); setDraft(''); }
  }
  return (
    <>
      <h3 className="panel-title">Your list</h3>
      {tasks.length === 0 && <p className="hint">Nothing yet. Add a task below.</p>}
      <ul className="todo-check">
        {tasks.map((t) => (
          <li key={t.id} className={t.done ? 'done' : ''}>
            <input type="checkbox" checked={t.done} onChange={() => onToggle(t.id)} aria-label="Done" />
            <input className="task-text" value={t.text} onChange={(e) => onEdit(t.id, e.target.value)}
              maxLength={200} aria-label="Task" />
            <button className="ghost x" onClick={() => onRemove(t.id)} aria-label="Remove task">×</button>
          </li>
        ))}
      </ul>
      <form className="chat-form" onSubmit={add}>
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Add a task…" maxLength={200} />
        <button className="primary sm" type="submit" disabled={!draft.trim()}>Add</button>
      </form>
      <Timer endsAt={endsAt} label="focus ends in" />
    </>
  );
}

function RegroupPanel({ tasks, endsAt, isHost, onRestart }) {
  const finished = tasks.filter((t) => t.done).length;
  return (
    <>
      <h3 className="panel-title">How it went</h3>
      <p className="tally">{finished}/{tasks.length || 0} done</p>
      <ul className="todo-check">
        {tasks.map((t) => (
          <li key={t.id} className={t.done ? 'done' : ''}><span>{t.done ? '✓' : '·'} {t.text}</span></li>
        ))}
      </ul>
      <Timer endsAt={endsAt} label="regroup ends in" />
      {isHost && <button className="secondary" onClick={onRestart}>Run another session</button>}
    </>
  );
}

function Ended({ msg, onLeave }) {
  return (
    <main className="ended">
      <div className="card center"><Moon size={56} /><p>{msg}</p><button className="primary" onClick={onLeave}>Back to start</button></div>
    </main>
  );
}
