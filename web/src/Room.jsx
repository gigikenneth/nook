import { useEffect, useRef, useState } from 'react';
import { useRoom } from './useRoom';
import { useWakeLock } from './useWakeLock';
import { usePipTimer } from './usePipTimer';
import { chime } from './sound';
import { ReportBug } from './ReportBug.jsx';
import { ThemeToggle } from './ThemeToggle.jsx';
import { Moon, ChatDoodle, CamBadge } from './graphics.jsx';

// Camera-preference cycle: unset -> up for camera -> camera-shy -> unset.
const nextPref = (p) => (p === 'on' ? 'off' : p === 'off' ? null : 'on');
const REACTIONS = ['👍', '❤️', '🎉', '😂', '👀']; // quick emoji reactions (#53)

// A chat message with emoji reactions: existing reactions show as chips (click
// to toggle your own), and a ＋ opens the quick palette. Reactions are relayed
// live and kept only in the client's chat state, like the messages themselves.
function ChatMessage({ m, selfId, onReact }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const reactions = m.reactions || {};
  const mineFor = (e) => (reactions[e] || []).includes(selfId);
  const hasReactions = Object.keys(reactions).length > 0;
  return (
    <div className={`chat-msg ${m.mine ? 'mine' : ''}`} style={m.mine ? undefined : { background: chatColor(m.name) }}>
      <span className="who">{m.mine ? 'You' : m.name}</span>
      <span className="body">{m.text}</span>
      {/* Chips only appear once a message has reactions, so un-reacted messages
          don't grow. The ＋ is a hover overlay in the corner, not a row. */}
      {hasReactions && (
        <div className="reactions">
          {Object.entries(reactions).map(([emoji, who]) => (
            <button key={emoji} className={`reaction ${who.includes(selfId) ? 'me' : ''}`}
              onClick={() => onReact(m.mid, emoji, !who.includes(selfId))}>{emoji} {who.length}</button>
          ))}
        </div>
      )}
      {m.mid && (
        <button className="react-btn" aria-label="Add reaction" onClick={() => setPickerOpen((o) => !o)}>＋</button>
      )}
      {/* Picker is anchored to the bubble's own edge (not the ＋ corner) so it
          opens inward and never spills off the panel on short messages. */}
      {m.mid && pickerOpen && (
        <span className="react-picker">
          {REACTIONS.map((e) => (
            <button key={e} onClick={() => { onReact(m.mid, e, !mineFor(e)); setPickerOpen(false); }}>{e}</button>
          ))}
        </span>
      )}
    </div>
  );
}

// Optional mid-session check-ins (#16): one gentle prompt at the focus midpoint,
// a fresh question each round. "Share" posts your answer to the room chat.
const CHECKINS = [
  "How's it going so far?",
  'Still on track with your goal?',
  'Anything to adjust for the rest of the session?',
  "One word for how you're feeling right now?",
  "What's your next small step?",
];

const initials = (n) => (n || '?').trim().slice(0, 2).toUpperCase();
const CHIP = ['#29bcee', '#a5d67b', '#6be492', '#171a6b']; // cyan, lime, green, indigo (Groove complements)

// A small who's-here bubble for the focus phase, where cameras are off. The name
// stays full-size and readable; only the avatar is a compact circle.
function PresenceChip({ name, isHost, i, onKick }) {
  return (
    <span className="presence-chip">
      <span className="presence-av" style={{ background: CHIP[i % CHIP.length] }}>{initials(name)}</span>
      <span className="presence-name">{name}{isHost ? ' · host' : ''}</span>
      {onKick && <button className="presence-kick" title={`Remove ${name} from the room`} aria-label={`Remove ${name}`} onClick={onKick}>×</button>}
    </span>
  );
}
// Light tints so each other person's chat bubbles read as their own colour.
// Keyed by name (stable across reconnects, unlike the per-connection id).
const CHAT_TINT = ['#dbe4ff', '#d4f3e0', '#e6f0cf', '#cdeefb']; // pale blue, mint, lime, cyan
const chatColor = (name) => {
  let h = 0;
  for (const c of name || '') h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return CHAT_TINT[h % CHAT_TINT.length];
};

// UUID ids so restored-from-storage tasks never collide with newly added ones.
const nextTaskId = () => crypto.randomUUID();

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
  useEffect(() => {
    const v = ref.current;
    if (!v || !stream) return;
    v.srcObject = stream;
    // Some browsers block autoplay of an unmuted peer stream; nudge it and
    // retry on the next click if the first play() is rejected.
    const play = () => v.play().catch(() => {});
    play();
    window.addEventListener('click', play, { once: true });
    return () => window.removeEventListener('click', play);
  }, [stream]);
  return <video ref={ref} autoPlay playsInline muted={muted} />;
}

function Tile({ name, stream, self, camOff, isHost, canKick, onKick, media, onToggleCam, onToggleMic, pref, onCyclePref, mediaError, onDismissError, videoMuted }) {
  const camShown = stream && !camOff && media?.cam !== false && !videoMuted;
  return (
    <div className={`tile ${camOff ? 'camoff' : ''}`}>
      {camShown ? <Video stream={stream} muted={self} /> : <div className="avatar">{initials(name)}</div>}
      {self && mediaError && (
        <div className="media-error" role="alert">
          <span>{mediaError}</span>
          <button className="ghost x" onClick={onDismissError} aria-label="Dismiss">×</button>
        </div>
      )}
      {self && !camOff && (
        <div className="tile-controls">
          <button className={`mediabtn ${media?.cam ? '' : 'off'}`} onClick={onToggleCam}
            aria-pressed={!media?.cam} aria-label={media?.cam ? 'Camera on' : 'Camera off'}>
            <span aria-hidden="true">{media?.cam ? '📷' : '🚫'}</span>
            <span className="mb-label">{media?.cam ? 'Camera on' : 'Camera off'}</span>
          </button>
          <button className={`mediabtn ${media?.mic ? '' : 'off'}`} onClick={onToggleMic}
            aria-pressed={!media?.mic} aria-label={media?.mic ? 'Mic on' : 'Mic off'}>
            <span aria-hidden="true">{media?.mic ? '🎙' : '🔇'}</span>
            <span className="mb-label">{media?.mic ? 'Mic on' : 'Mic off'}</span>
          </button>
        </div>
      )}
      <div className="tile-bar">
        <span className="tile-name">{name}{self ? ' (you)' : ''}{isHost ? ' · host' : ''}</span>
        {self ? (
          <button className="cam-pref-btn" onClick={onCyclePref}
            title="Signal whether you'd rather be on or off camera (tap to change)">
            {pref ? <CamBadge pref={pref} compact /> : <span className="cam-set">＋ camera pref</span>}
          </button>
        ) : <CamBadge pref={pref} compact />}
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

export default function Room({ roomId, name, todos, focusMin, regroupMin, isPublic, camPref, onLeave, onBrowse }) {
  const room = useRoom(roomId, name, { focusMin, regroupMin, isPublic });
  const { selfId, hostId, peers, phase, endsAt, checkinSeed, ready, shared, order, locked, goals, camPrefs, chat, config, status, local } = room;

  const [goal, setGoal] = useState(todos[0] || '');
  // Personal, editable task list (browser-only, never synced). Restored from this
  // tab's own storage first, so a refresh or a phone reclaiming the tab doesn't
  // wipe your list; falls back to the goals you joined with.
  const [tasks, setTasks] = useState(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(`nook.tasks.${roomId}`) || 'null');
      if (Array.isArray(saved) && saved.length) return saved;
    } catch { /* ignore */ }
    return todos.map((t) => ({ id: nextTaskId(), text: t, done: false }));
  });
  // Keep the tab's copy in step so it survives a reload. sessionStorage is per-tab
  // and clears when the tab closes, so nothing outlives the session or leaves the
  // device.
  useEffect(() => {
    try { sessionStorage.setItem(`nook.tasks.${roomId}`, JSON.stringify(tasks)); } catch { /* full/blocked */ }
  }, [tasks, roomId]);
  const addTask = (text) => setTasks((ts) => [...ts, { id: nextTaskId(), text, done: false }]);
  const editTask = (id, text) => setTasks((ts) => ts.map((t) => (t.id === id ? { ...t, text } : t)));
  const toggleTask = (id) => setTasks((ts) => ts.map((t) => (t.id === id ? { ...t, done: !t.done } : t)));
  const removeTask = (id) => setTasks((ts) => ts.filter((t) => t.id !== id));
  const reorderTask = (id, toIndex) => setTasks((ts) => {
    const from = ts.findIndex((t) => t.id === id);
    if (from < 0 || toIndex < 0 || toIndex >= ts.length || from === toIndex) return ts;
    const next = [...ts];
    const [item] = next.splice(from, 1);
    next.splice(toIndex, 0, item);
    return next;
  });

  // Opt-in: share your list with the room for accountability (#47). Off by
  // default (private, as before). While on, broadcast the list (debounced) on
  // every change; turning off clears it for everyone. Relayed, never stored.
  const [listShared, setListShared] = useState(false);
  const toggleShareList = () => setListShared((s) => { const on = !s; if (!on) room.shareList(null); return on; });
  useEffect(() => {
    if (!listShared) return;
    const t = setTimeout(() => room.shareList(tasks.map((x) => ({ text: x.text, done: x.done }))), 400);
    return () => clearTimeout(t);
  }, [listShared, tasks]); // eslint-disable-line react-hooks/exhaustive-deps

  const [copied, setCopied] = useState(false);
  const [draft, setDraft] = useState('');

  const isHost = selfId && selfId === hostId;
  const iAmReady = selfId && ready.includes(selfId);
  const peerIds = Object.keys(peers);
  const count = peerIds.length + 1;
  const inviteLink = `${window.location.origin}${window.location.pathname}#room/${encodeURIComponent(roomId)}`;
  const camOff = phase === 'focus';

  // Send the pre-typed goal + camera preference once connected.
  const sentGoal = useRef(false);
  useEffect(() => {
    if (selfId && goal.trim() && !sentGoal.current) { room.sendGoal(goal.trim()); sentGoal.current = true; }
  }, [selfId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Carry the greet goal into your task list when focus starts, even if you never
  // clicked "I've shared my goal" — otherwise a goal typed in greet just vanishes
  // when the session begins.
  useEffect(() => {
    if (phase !== 'focus') return;
    const g = goal.trim();
    if (g) setTasks((ts) => (ts.some((t) => t.text === g) ? ts : [{ id: nextTaskId(), text: g, done: false }, ...ts]));
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps
  const sentPref = useRef(false);
  useEffect(() => {
    if (selfId && camPref && !sentPref.current) { room.setCamPref(camPref); sentPref.current = true; }
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

  // Keep the phone/desktop screen awake while you're in a room (#17).
  useWakeLock(true);

  // Optional pop-out timer (Document PiP) so the countdown stays visible when the
  // tab is minimised on desktop (#34). Feed it the current phase + timer.
  const pip = usePipTimer();
  useEffect(() => { pip.setData(endsAt, phase); }, [endsAt, phase]); // eslint-disable-line react-hooks/exhaustive-deps

  // Show the live countdown in the browser tab title (#18), so a glance at the
  // tab shows the time left even when Nook isn't the foreground app.
  useEffect(() => {
    const base = 'Nook: your focus crew';
    if (!endsAt) { document.title = base; return () => { document.title = base; }; }
    const tick = () => {
      const rem = Math.max(0, endsAt - Date.now());
      const mm = String(Math.floor(rem / 60000)).padStart(2, '0');
      const ss = String(Math.floor((rem % 60000) / 1000)).padStart(2, '0');
      document.title = `⏳ ${mm}:${ss} · Nook`;
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => { clearInterval(t); document.title = base; };
  }, [endsAt]);

  // Mid-session check-in (#16). The question comes from a server-picked seed so
  // everyone in the room sees the same one; read via a ref for the latest value.
  const [checkin, setCheckin] = useState(null);
  const [checkinDraft, setCheckinDraft] = useState(() => {
    try { return sessionStorage.getItem(`nook.checkin.draft.${roomId}`) || ''; } catch { return ''; }
  });
  const checkinSeedRef = useRef(checkinSeed);
  checkinSeedRef.current = checkinSeed;
  // "done" is persisted per focus block (keyed by endsAt) so a refresh re-shows an
  // UNanswered check-in — immediately if the midpoint already passed while you
  // were away — but never re-nags one you've answered or dismissed.
  const checkinDone = () => {
    try { const s = JSON.parse(sessionStorage.getItem(`nook.checkin.${roomId}`) || 'null'); return !!(s && s.endsAt === endsAt && s.done); }
    catch { return false; }
  };
  const finishCheckin = () => {
    try { sessionStorage.setItem(`nook.checkin.${roomId}`, JSON.stringify({ endsAt, done: true })); sessionStorage.removeItem(`nook.checkin.draft.${roomId}`); } catch { /* ignore */ }
    setCheckin(null); setCheckinDraft('');
  };
  useEffect(() => { if (phase !== 'focus') setCheckin(null); }, [phase]); // no lingering card past focus
  useEffect(() => {
    if (phase !== 'focus' || !endsAt || checkinDone()) return;
    const show = () => setCheckin(CHECKINS[Math.floor((checkinSeedRef.current ?? Math.random()) * CHECKINS.length)]);
    const delay = endsAt - (config.focusMin * 60000) / 2 - Date.now();
    if (delay <= 0) { if (checkinSeedRef.current != null) show(); return; } // past the midpoint (e.g. after a refresh)
    const t = setTimeout(show, delay);
    return () => clearTimeout(t);
  }, [phase, endsAt, config.focusMin, roomId, checkinSeed]); // eslint-disable-line react-hooks/exhaustive-deps
  function shareCheckin(text) {
    const t = text.trim();
    if (t) room.sendChat(`Mid-session check-in — ${t}`);
    finishCheckin();
  }
  function onCheckinDraft(text) {
    setCheckinDraft(text);
    try { sessionStorage.setItem(`nook.checkin.draft.${roomId}`, text); } catch { /* ignore */ }
  }

  // Five-minutes-left warning chime during focus (#23). Skipped for sessions that
  // are 5 min or shorter, and if you joined inside the final 5 minutes.
  const warnedRef = useRef(false);
  useEffect(() => { if (phase !== 'focus') warnedRef.current = false; }, [phase]);
  useEffect(() => {
    if (phase !== 'focus' || !endsAt || warnedRef.current) return;
    const FIVE = 5 * 60000;
    if (config.focusMin * 60000 <= FIVE) return;
    const delay = endsAt - FIVE - Date.now();
    if (delay <= 0) return;
    const t = setTimeout(() => { warnedRef.current = true; chime('warn'); }, delay);
    return () => clearTimeout(t);
  }, [phase, endsAt, config.focusMin]);

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
  if (status === 'locked') return <Ended msg="This room is locked. The host isn't taking new people right now." onLeave={onLeave} />;
  if (status === 'offline') return <Ended msg="Lost connection to the server. Check your internet, then rejoin." onLeave={onLeave} />;
  if (status === 'closed') return <Ended msg="You left the room." onLeave={onLeave} />;

  // Roommates who opted to share their list (#47), read-only.
  const sharedListsEl = peerIds.some((id) => Array.isArray(peers[id].list) && peers[id].list.length) ? (
    <aside className="panel shared-lists">
      <h3 className="panel-title">Room lists</h3>
      {peerIds.filter((id) => Array.isArray(peers[id].list) && peers[id].list.length).map((id) => (
        <div key={id} className="shared-list">
          <strong>{peers[id].name || 'Someone'}</strong>
          <ul className="todo-check readonly">
            {peers[id].list.map((t, i) => (
              <li key={i} className={t.done ? 'done' : ''}><span>{t.done ? '✓' : '·'} {t.text}</span></li>
            ))}
          </ul>
        </div>
      ))}
    </aside>
  ) : null;

  const chatPanelEl = (
    <aside className="panel chat-panel">
      <div className="panel-head">
        <h3 className="panel-title">Chat</h3>
        <span className="hint" title="Never stored on a server. A copy stays in your browser so a refresh can restore it, and it clears when you close the tab.">not on our servers</span>
      </div>
      <div className="chat-log" ref={logRef}>
        {chat.length === 0 ? (
          <div className="chat-empty"><ChatDoodle /><p>Say something. Messages vanish when the room does.</p></div>
        ) : chat.map((m, i) => (
          <ChatMessage key={m.mid || i} m={m} selfId={selfId} onReact={room.react} />
        ))}
      </div>
      <form className="chat-form" onSubmit={send}>
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Message…" maxLength={500} />
        <button className="primary chat-send" type="submit" disabled={!draft.trim()}>Send</button>
      </form>
      <p className="chat-note">Chat isn’t saved. It clears when you leave or the room closes.</p>
      <div className="dl-row">
        <button className="secondary sm" onClick={downloadTodos}>Download list</button>
        <button className="secondary sm" onClick={downloadChat} disabled={chat.length === 0}>Download chat</button>
      </div>
    </aside>
  );

  return (
    <main className={`room ${phase === 'focus' ? 'focus-fit' : ''}`}>
      {status === 'reconnecting' && <div className="reconnecting" role="status">Reconnecting…</div>}
      {checkin && <CheckIn question={checkin} initialText={checkinDraft} onDraft={onCheckinDraft} onShare={shareCheckin} onClose={finishCheckin} />}
      <header className="room-head">
        <div className="room-id">
          <Moon size={26} className="small" /><span>Nook</span>
          <span className="dot">·</span><span className="count">{count}/4 here</span>
          {isPublic ? <span className="badge badge-greet">open</span> : <span className="badge">invite only</span>}
          {locked && <span className="badge badge-locked">🔒 locked</span>}
        </div>
        <div className="room-actions">
          <ThemeToggle className="sm" />
          {isHost && (
            <button className={`ghost sm ${locked ? 'is-locked' : ''}`} onClick={room.toggleLock}
              title={locked ? 'Room is closed to new people' : 'Anyone with space can join, even mid-session'}>
              {locked ? '🔒 Locked' : '🔓 Open'}
            </button>
          )}
          {onBrowse && <button className="ghost sm" onClick={onBrowse}>Home</button>}
          {pip.supported && (
            <button className="ghost sm" onClick={() => (pip.isOpen ? pip.close() : pip.open())}
              title="Keep the timer visible when this tab is minimised">
              {pip.isOpen ? 'Close timer' : '⧉ Pop out timer'}
            </button>
          )}
          <button className="secondary sm" onClick={copy}>{copied ? 'Link copied' : 'Copy invite link'}</button>
          <button className="primary sm" onClick={onLeave}>Leave</button>
        </div>
      </header>

      <PhaseBanner phase={phase} endsAt={endsAt} regroupMin={regroupMin} />

      {phase === 'focus' ? (
        /* Focus: nobody's on camera, so people become small name bubbles under
           the bar, and the space goes to chat (left) + your list (right). */
        <>
          <div className="presence-bar">
            <PresenceChip name={`${name} (you)`} isHost={isHost} i={0} />
            {peerIds.map((id, idx) => (
              <PresenceChip key={id} name={peers[id].name || 'Guest'} isHost={id === hostId} i={idx + 1}
                onKick={isHost ? () => { if (window.confirm(`Remove ${peers[id].name || 'this person'} from the room?`)) room.kick(id); } : undefined} />
            ))}
          </div>
          <section className="focus-cols">
            {chatPanelEl}
            <div className="focus-right">
              <aside className="panel">
                <FocusPanel tasks={tasks} onAdd={addTask} onEdit={editTask} onToggle={toggleTask}
                  onRemove={removeTask} onReorder={reorderTask} shared={listShared} onToggleShare={toggleShareList} />
              </aside>
              {sharedListsEl}
            </div>
          </section>
        </>
      ) : (
        <section className="stage">
          <div className={`grid grid-${count}`}>
            <Tile name={name} stream={local} self camOff={camOff} isHost={isHost}
              media={room.media} onToggleCam={room.toggleCam} onToggleMic={room.toggleMic}
              mediaError={room.mediaError} onDismissError={room.dismissMediaError}
              pref={camPrefs[selfId]} onCyclePref={() => room.setCamPref(nextPref(camPrefs[selfId] || null))} />
            {peerIds.map((id) => (
              <Tile key={id} name={peers[id].name || 'Guest'} stream={peers[id].stream} camOff={camOff}
                isHost={id === hostId} canKick={isHost && id !== selfId} onKick={() => room.kick(id)}
                pref={camPrefs[id]} videoMuted={peers[id].camLive === false} />
            ))}
          </div>

          <div className="rail">
            <aside className="panel">
              {phase === 'greet' && (
                <GreetPanel selfId={selfId} selfName={name} goal={goal} setGoal={setGoal}
                  onShareGoal={() => goal.trim() && room.sendGoal(goal.trim())}
                  onShared={() => {
                    const g = goal.trim();
                    if (g) {
                      room.sendGoal(g);
                      // Your shared goal becomes the top item on your to-do list (deduped).
                      setTasks((ts) => ts.some((t) => t.text === g) ? ts : [{ id: nextTaskId(), text: g, done: false }, ...ts]);
                    }
                    room.shareGoal();
                  }}
                  goals={goals} peers={peers} order={order} shared={shared}
                  ready={ready} iAmReady={iAmReady} count={count}
                  onReady={() => room.setReady(!iAmReady)} isHost={isHost} onStart={room.start} />
              )}
              {phase === 'regroup' && (
                <RegroupPanel tasks={tasks} onRestart={room.restart} />
              )}
            </aside>
            {sharedListsEl}
            {chatPanelEl}
          </div>
        </section>
      )}
      <footer className="site-foot in-room">
        <ReportBug />
        <span>Built by <a href="https://www.gigikenneth.com/" target="_blank" rel="noopener noreferrer">Gigi</a>. <a href="https://github.com/gigikenneth/nook" target="_blank" rel="noopener noreferrer">Source on GitHub</a>. <a href="https://discord.gg/7fvsBq79VU" target="_blank" rel="noopener noreferrer">Join the Discord</a>.</span>
      </footer>
    </main>
  );
}

function PhaseBanner({ phase, endsAt, regroupMin }) {
  const copy = {
    greet: { t: 'Say hello', s: 'When it’s your turn, share what you’re working on (out loud or typed), then pass on. Mark ready when you’re set.' },
    focus: { t: 'Heads down', s: 'Cameras off. Just you, your list, and the clock.' },
    regroup: { t: 'Regroup', s: regroupMin > 0 ? 'How did it go? Turn your camera on to chat.' : 'Wrapping up.' },
  }[phase];
  return (
    <div className={`banner banner-${phase}`}>
      <div><h2>{copy.t}</h2><p>{copy.s}</p></div>
      {phase !== 'greet' && <Timer endsAt={endsAt} label={phase === 'focus' ? 'focus ends in' : 'regroup ends in'} />}
    </div>
  );
}

function GreetPanel({ selfId, selfName, goal, setGoal, onShareGoal, onShared, goals, peers, order, shared,
  ready, iAmReady, count, onReady, isHost, onStart }) {
  // Turn-taking: the frame sits on the first person (join order) who hasn't shared yet.
  const currentSharer = order.find((id) => !shared.includes(id));
  const allShared = order.length > 0 && !currentSharer;
  const myTurn = currentSharer === selfId;
  const nameOf = (id) => (id === selfId ? 'You' : peers[id]?.name || 'Guest');
  const goalOf = (id) => (id === selfId ? goal : goals[id] || '');

  return (
    <>
      <label className="field">
        <span>What are you working on? <span className="opt">optional</span></span>
        <input value={goal} onChange={(e) => setGoal(e.target.value)} onBlur={onShareGoal}
          placeholder="Say it out loud, or type it here" maxLength={200} />
      </label>

      <ul className="goal-list">
        {order.map((id) => {
          const isCurrent = id === currentSharer;
          const hasShared = shared.includes(id);
          return (
            <li key={id} className={`share-row ${isCurrent ? 'current' : ''} ${hasShared ? 'shared' : ''}`}>
              <span className="goal-chip" style={{ background: CHIP[order.indexOf(id) % CHIP.length] }}>
                {initials(id === selfId ? selfName : nameOf(id))}
              </span>
              <div className="goal-body">
                <strong>{id === selfId ? 'You' : `${nameOf(id)}’s goal`}</strong>
                <span>{goalOf(id) || (isCurrent ? 'sharing now…' : '…')}</span>
              </div>
              {hasShared && <span className="share-tick" aria-label="shared">✓</span>}
            </li>
          );
        })}
      </ul>

      {!allShared && myTurn && (
        <button className="primary" onClick={onShared}>I’ve shared</button>
      )}
      {!allShared && !myTurn && currentSharer && (
        <p className="hint">{nameOf(currentSharer)} is sharing… you’re up next in turn.</p>
      )}

      {allShared && (
        <>
          <div className="ready-row">
            <span>{ready.length}/{count} ready</span>
            <button className={`primary ${iAmReady ? 'is-on' : ''}`} onClick={onReady}>{iAmReady ? 'Ready ✓' : (ready.length === count - 1 ? 'I’m ready · Start Focus' : 'I’m ready')}</button>
          </div>
          <p className="hint">Everyone’s shared. Focus begins when everyone’s ready.</p>
        </>
      )}
      <button className="link-btn" onClick={onStart}>Start now (don’t wait for others)</button>
    </>
  );
}

function FocusPanel({ tasks, onAdd, onEdit, onToggle, onRemove, onReorder, shared, onToggleShare }) {
  const [draft, setDraft] = useState('');
  const [dragId, setDragId] = useState(null);
  const ulRef = useRef(null);
  function add(e) {
    e.preventDefault();
    const t = draft.trim();
    if (t) { onAdd(t); setDraft(''); }
  }
  // Drag-to-reorder via pointer events (works with mouse and touch, no library).
  // Grabbing the handle captures the pointer; as it moves over other rows we
  // splice the dragged task to that row's index, so the list reorders live.
  const startDrag = (e, id) => {
    e.preventDefault();
    setDragId(id);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* older browser */ }
  };
  const onMove = (e) => {
    if (dragId == null || !ulRef.current) return;
    const rows = [...ulRef.current.children];
    let target = rows.findIndex((li) => { const r = li.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; });
    if (target === -1) target = rows.length - 1;
    onReorder(dragId, target);
  };
  const endDrag = () => setDragId(null);
  return (
    <>
      <div className="list-head">
        <h3 className="panel-title">Your list</h3>
        <label className="share-toggle" title="Let the room see your list, for accountability. Off keeps it private.">
          <input type="checkbox" checked={shared} onChange={onToggleShare} />
          <span>{shared ? 'Sharing' : 'Share with room'}</span>
        </label>
      </div>
      {tasks.length === 0 && <p className="hint">Nothing yet. Add a task below.</p>}
      <ul className="todo-check" ref={ulRef}>
        {tasks.map((t) => (
          <li key={t.id} className={`${t.done ? 'done' : ''} ${dragId === t.id ? 'dragging' : ''}`}>
            <button className="drag-handle" aria-label="Drag to reorder" title="Drag to reorder"
              onPointerDown={(e) => startDrag(e, t.id)} onPointerMove={onMove} onPointerUp={endDrag} onPointerCancel={endDrag}>⠿</button>
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
    </>
  );
}

function RegroupPanel({ tasks, onRestart }) {
  const finished = tasks.filter((t) => t.done).length;
  // The countdown lives in the phase banner (heading); no second timer here.
  return (
    <>
      <h3 className="panel-title">How it went</h3>
      <p className="tally">{finished}/{tasks.length || 0} done</p>
      <ul className="todo-check">
        {tasks.map((t) => (
          <li key={t.id} className={t.done ? 'done' : ''}><span>{t.done ? '✓' : '·'} {t.text}</span></li>
        ))}
      </ul>
      {/* Anyone can start the next round (#55), so it doesn't stall if the host left. */}
      <button className="secondary" onClick={onRestart}>Run another session</button>
    </>
  );
}

// Mid-session check-in card (#16): optional, dismissible. Share posts to chat.
function CheckIn({ question, initialText = '', onDraft, onShare, onClose }) {
  const [text, setText] = useState(initialText);
  return (
    <div className="checkin" role="dialog" aria-label="Mid-session check-in">
      <div className="checkin-head">
        <strong>Mid-session check-in</strong>
        <button className="ghost x" onClick={onClose} aria-label="Dismiss">×</button>
      </div>
      <p className="checkin-q">{question}</p>
      <form className="checkin-form" onSubmit={(e) => { e.preventDefault(); onShare(text); }}>
        <input value={text} onChange={(e) => { setText(e.target.value); onDraft && onDraft(e.target.value); }} maxLength={200}
          placeholder="Share a line with the room (optional)…" autoFocus />
        <button className="primary sm" type="submit" disabled={!text.trim()}>Share</button>
      </form>
    </div>
  );
}

function Ended({ msg, onLeave }) {
  return (
    <main className="ended">
      <div className="card center"><Moon size={56} /><p>{msg}</p><button className="primary" onClick={onLeave}>Back to start</button></div>
    </main>
  );
}
