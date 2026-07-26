import { useEffect, useMemo, useRef, useState } from 'react';
import { useRoom } from './useRoom';

const initials = (n) => (n || '?').trim().slice(0, 2).toUpperCase();

// Attaches a MediaStream to a <video>. Self is muted to avoid echo.
function Video({ stream, muted }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current && stream) ref.current.srcObject = stream;
  }, [stream]);
  return <video ref={ref} autoPlay playsInline muted={muted} />;
}

function Tile({ name, stream, self, camOff, isHost, canKick, onKick }) {
  return (
    <div className={`tile ${camOff ? 'camoff' : ''}`}>
      {stream && !camOff ? (
        <Video stream={stream} muted={self} />
      ) : (
        <div className="avatar">{initials(name)}</div>
      )}
      <div className="tile-bar">
        <span className="tile-name">{name}{self ? ' (you)' : ''}{isHost ? ' · host' : ''}</span>
        {canKick && <button className="ghost kick" onClick={onKick}>Remove</button>}
      </div>
    </div>
  );
}

function Timer({ endsAt, label }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
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

export default function Room({ roomId, name, todos, focusMin, regroupMin, onLeave }) {
  const room = useRoom(roomId, name, { focusMin, regroupMin });
  const { selfId, hostId, peers, phase, endsAt, ready, goals, status, local } = room;

  const [goal, setGoal] = useState(todos[0] || '');
  const [done, setDone] = useState({}); // todo index -> bool
  const [copied, setCopied] = useState(false);

  const isHost = selfId && selfId === hostId;
  const iAmReady = selfId && ready.includes(selfId);
  const peerIds = Object.keys(peers);
  const count = peerIds.length + 1;
  const inviteLink = `${window.location.origin}${window.location.pathname}#room/${encodeURIComponent(roomId)}`;

  // Send the pre-typed goal once connected.
  const sentGoal = useRef(false);
  useEffect(() => {
    if (selfId && goal.trim() && !sentGoal.current) {
      room.sendGoal(goal.trim());
      sentGoal.current = true;
    }
  }, [selfId]); // eslint-disable-line react-hooks/exhaustive-deps

  function copy() {
    navigator.clipboard?.writeText(inviteLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const camOff = phase === 'focus';

  if (status === 'kicked') return <Ended msg="You were removed from this room." onLeave={onLeave} />;
  if (status === 'full') return <Ended msg="That room is full (four is the max)." onLeave={onLeave} />;
  if (status === 'closed') return <Ended msg="You left the room." onLeave={onLeave} />;

  return (
    <main className="room">
      <header className="room-head">
        <div className="room-id">
          <span className="brand-mark small" aria-hidden="true" />
          <span>Nook</span>
          <span className="dot">·</span>
          <span className="count">{count}/4 here</span>
        </div>
        <div className="room-actions">
          <button className="secondary sm" onClick={copy}>{copied ? 'Link copied' : 'Copy invite link'}</button>
          <button className="ghost sm" onClick={onLeave}>Leave</button>
        </div>
      </header>

      <PhaseBanner phase={phase} endsAt={endsAt} regroupMin={regroupMin} />

      <section className="stage">
        <div className={`grid grid-${count}`}>
          <Tile name={name} stream={local} self camOff={camOff} isHost={isHost} />
          {peerIds.map((id) => (
            <Tile
              key={id}
              name={peers[id].name || 'Guest'}
              stream={peers[id].stream}
              camOff={camOff}
              isHost={id === hostId}
              canKick={isHost && id !== selfId}
              onKick={() => room.kick(id)}
            />
          ))}
        </div>

        <aside className="panel">
          {phase === 'greet' && (
            <GreetPanel
              goal={goal} setGoal={(v) => { setGoal(v); }}
              onShareGoal={() => goal.trim() && room.sendGoal(goal.trim())}
              goals={goals} peers={peers} selfId={selfId} name={name}
              ready={ready} iAmReady={iAmReady} count={count}
              onReady={() => room.setReady(!iAmReady)}
              isHost={isHost} onStart={room.start}
            />
          )}

          {phase === 'focus' && (
            <FocusPanel todos={todos} done={done} setDone={setDone} endsAt={endsAt} />
          )}

          {phase === 'regroup' && (
            <RegroupPanel
              todos={todos} done={done} endsAt={endsAt}
              isHost={isHost} onRestart={room.restart}
            />
          )}
        </aside>
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
      <div>
        <h2>{copy.t}</h2>
        <p>{copy.s}</p>
      </div>
      {phase !== 'greet' && <Timer endsAt={endsAt} label={phase === 'focus' ? 'focus ends in' : 'regroup ends in'} />}
    </div>
  );
}

function GreetPanel({ goal, setGoal, onShareGoal, goals, peers, selfId, name, ready, iAmReady, count, onReady, isHost, onStart }) {
  const others = Object.keys(peers);
  return (
    <>
      <label className="field">
        <span>What are you working on?</span>
        <input value={goal} onChange={(e) => setGoal(e.target.value)} onBlur={onShareGoal}
          placeholder="Your focus for this session" maxLength={200} />
      </label>

      <ul className="goal-list">
        {others.map((id) => (
          <li key={id}>
            <strong>{peers[id].name || 'Guest'}</strong>
            <span>{goals[id] || '…'}</span>
          </li>
        ))}
      </ul>

      <div className="ready-row">
        <span>{ready.length}/{count} ready</span>
        <button className={`primary ${iAmReady ? 'is-on' : ''}`} onClick={onReady}>
          {iAmReady ? 'Ready ✓' : 'I’m ready'}
        </button>
      </div>
      {isHost && (
        <button className="link-btn" onClick={onStart}>Start now (don’t wait)</button>
      )}
      <p className="hint">Focus begins when everyone’s ready.</p>
    </>
  );
}

function FocusPanel({ todos, done, setDone, endsAt }) {
  return (
    <>
      <h3 className="panel-title">Your list</h3>
      {todos.length === 0 && <p className="hint">No list this time. Just focus.</p>}
      <ul className="todo-check">
        {todos.map((t, i) => (
          <li key={i} className={done[i] ? 'done' : ''}>
            <label>
              <input type="checkbox" checked={!!done[i]}
                onChange={(e) => setDone({ ...done, [i]: e.target.checked })} />
              <span>{t}</span>
            </label>
          </li>
        ))}
      </ul>
      <Timer endsAt={endsAt} label="focus ends in" />
    </>
  );
}

function RegroupPanel({ todos, done, endsAt, isHost, onRestart }) {
  const finished = todos.filter((_, i) => done[i]).length;
  return (
    <>
      <h3 className="panel-title">How it went</h3>
      <p className="tally">{finished}/{todos.length || 0} done</p>
      <ul className="todo-check">
        {todos.map((t, i) => (
          <li key={i} className={done[i] ? 'done' : ''}>
            <span>{done[i] ? '✓' : '·'} {t}</span>
          </li>
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
      <div className="card center">
        <span className="brand-mark" aria-hidden="true" />
        <p>{msg}</p>
        <button className="primary" onClick={onLeave}>Back to start</button>
      </div>
    </main>
  );
}
