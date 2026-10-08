import { useEffect, useRef, useState } from 'react';
import { useRoom } from './useRoom';
import { useWakeLock } from './useWakeLock';
import { usePipTimer } from './usePipTimer';
import { chime, unlockAudio } from './sound';
import { ReportBug } from './ReportBug.jsx';
import { SupportNook } from './SupportNook.jsx';
import { ThemeToggle } from './ThemeToggle.jsx';
import { JitsiStage } from './JitsiStage.jsx';
import { Moon, ChatDoodle } from './graphics.jsx';
import { prepareImage, isImage, bytesOf } from './image';

const REACTIONS = ['👍', '❤️', '🎉', '😂', '👀']; // quick emoji reactions (#53)

// Turn bare URLs in a message into links. Nothing is fetched and nothing is sent
// anywhere: this is purely how the text is drawn. The label drops the scheme and
// any trailing slash, so a long link reads as the place it goes rather than as a
// wall of query string.
const URL_RE = /\bhttps?:\/\/[^\s<>"')]+/gi;
const linkLabel = (url) => {
  const bare = url.replace(/^https?:\/\//i, '').replace(/\/$/, '');
  return bare.length > 48 ? `${bare.slice(0, 47)}…` : bare;
};
function linkify(text) {
  const out = [];
  let last = 0;
  for (const match of String(text).matchAll(URL_RE)) {
    if (match.index > last) out.push(text.slice(last, match.index));
    out.push(
      <a key={match.index} className="chat-link" href={match[0]} target="_blank" rel="noopener noreferrer nofollow">
        {linkLabel(match[0])}
      </a>,
    );
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const dataUrlToBlobUrl = (dataUrl) => {
  const [head, b64] = dataUrl.split(',');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: head.slice(5, head.indexOf(';')) }));
};

const sizeLabel = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

// A chat message with emoji reactions: existing reactions show as chips (click
// to toggle your own), and a ＋ opens the quick palette. Reactions are relayed
// live and kept only in the client's chat state, like the messages themselves.
function ChatMessage({ m, selfId, onReact, onEdit }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [edraft, setEdraft] = useState(m.text);
  const reactions = m.reactions || {};
  const mineFor = (e) => (reactions[e] || []).includes(selfId);
  const hasReactions = Object.keys(reactions).length > 0;
  const saveEdit = () => {
    const t = edraft.trim();
    if (t && t !== m.text) onEdit(m.mid, t);
    setEditing(false);
  };
  const startEdit = () => { setEdraft(m.text); setEditing(true); };
  return (
    <div className={`chat-msg ${m.mine ? 'mine' : ''}`} style={m.mine ? undefined : { '--tint': chatColor(m.name) }}>
      <div className="chat-head">
        <span className="who">{m.mine ? 'You' : m.name}</span>
        {m.t && <time className="chat-time" dateTime={new Date(m.t).toISOString()}>{new Date(m.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>}
      </div>
      {m.img && (
        // Browsers refuse to open a data: URI in a new tab, so hand it over as a blob URL.
        <a href={m.img} target="_blank" rel="noopener noreferrer" className="chat-img-link"
          onClick={(e) => { e.preventDefault(); window.open(dataUrlToBlobUrl(m.img), '_blank', 'noopener'); }}>
          <img className="chat-img" src={m.img} alt={`Shared by ${m.mine ? 'you' : m.name}`} loading="lazy" />
        </a>
      )}
      {m.img && (
        <div className="chat-img-meta">
          {m.mime === 'image/gif' && <span className="gif-tag">GIF</span>}
          <span>{sizeLabel(bytesOf(m.img))}</span>
        </div>
      )}
      {m.imgDropped && <div className="chat-img-gone">Picture not kept after a refresh.</div>}
      {editing ? (
        // Inline editor for your own message (#70). Enter saves, Shift+Enter adds
        // a line, Esc cancels.
        <form className="chat-edit" onSubmit={(e) => { e.preventDefault(); saveEdit(); }}>
          <textarea value={edraft} autoFocus rows={2} maxLength={500}
            onChange={(e) => setEdraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(); }
              else if (e.key === 'Escape') setEditing(false);
            }} />
          <div className="chat-edit-actions">
            <button type="button" className="link-btn" onClick={() => setEditing(false)}>Cancel</button>
            <button type="submit" className="primary sm" disabled={!edraft.trim()}>Save</button>
          </div>
        </form>
      ) : (
        <span className="body">{linkify(m.text || '')}{m.edited && <span className="edited-tag"> (edited)</span>}</span>
      )}
      {/* Chips only appear once a message has reactions, so un-reacted messages
          don't grow. The actions are a hover overlay in the corner, not a row. */}
      {hasReactions && (
        <div className="reactions">
          {Object.entries(reactions).map(([emoji, who]) => (
            <button key={emoji} className={`reaction ${who.includes(selfId) ? 'me' : ''}`}
              onClick={() => onReact(m.mid, emoji, !who.includes(selfId))}>{emoji} {who.length}</button>
          ))}
        </div>
      )}
      {m.mid && !editing && (
        <div className="msg-actions">
          {m.mine && !m.img && !m.imgDropped && <button className="msg-act" aria-label="Edit message" title="Edit" onClick={startEdit}>✎</button>}
          <button className="msg-act" aria-label="Add reaction" title="React" onClick={() => setPickerOpen((o) => !o)}>＋</button>
        </div>
      )}
      {/* Picker is anchored to the bubble's own edge (not the corner) so it
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

// Parse an imported list so a downloaded list can be brought back later.
// Accepts Nook's own "[x] text" dump, Markdown checkboxes ("- [ ] text"),
// plain bullet/numbered lines, and JSON (array of strings or {text,done}).
function parseList(text) {
  const t = text.trim();
  if (t.startsWith('[') || t.startsWith('{')) {
    try {
      const j = JSON.parse(t);
      const arr = Array.isArray(j) ? j : j.tasks || j.list || [];
      return arr.map((x) =>
        typeof x === 'string' ? { text: x.trim(), done: false }
                              : { text: String(x.text ?? '').trim(), done: !!x.done }
      ).filter((x) => x.text);
    } catch { /* not JSON, fall through to line parsing */ }
  }
  return text.split(/\r?\n/).map((line) => {
    const s = line.trim();
    if (!s) return null;
    if (/^nook (to-do list|chat log)$/i.test(s) || s === '(empty)') return null; // our headers
    const box = s.match(/^[-*]?\s*\[([ xX])\]\s*(.+)$/);   // [x]/[ ] or "- [x]"
    if (box) return { text: box[2].trim(), done: box[1].toLowerCase() === 'x' };
    const bullet = s.replace(/^([-*]|\d+[.)])\s+/, '');     // strip -, *, "1." bullets
    return { text: bullet.trim(), done: false };
  }).filter(Boolean);
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
  const { selfId, hostId, peers, phase, startingAt, endsAt, ready, shared, order, locked, goals, chat, config, status } = room;

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

  // Safety net for audio: prime the context on the first interaction of any kind,
  // so even someone who joined mid-focus (and never clicked Ready/Start) still
  // hears the chimes. Safari only starts audio inside a user gesture.
  useEffect(() => {
    const prime = () => unlockAudio();
    window.addEventListener('pointerdown', prime, { once: true });
    window.addEventListener('keydown', prime, { once: true });
    return () => {
      window.removeEventListener('pointerdown', prime);
      window.removeEventListener('keydown', prime);
    };
  }, []);

  // A quiet tick when someone else posts to the chat (#91), so a message doesn't
  // go unnoticed while you're heads-down. Own messages stay silent, and the count
  // starts from whatever is already on screen so a reload (chat is restored from
  // sessionStorage) doesn't replay a tick for old messages.
  const seenChat = useRef(chat.length);
  useEffect(() => {
    if (chat.length > seenChat.current) {
      if (!chat[chat.length - 1]?.mine) chime('tick');
    }
    seenChat.current = chat.length;
  }, [chat]);

  // Keep the chat log pinned to the newest message.
  const logRef = useRef(null);
  const chatTaRef = useRef(null); // composer textarea, to reset its height after send
  const picRef = useRef(null);    // hidden file input behind the picture button
  const [preparing, setPreparing] = useState(false); // shrinking a picture right now
  const [imgError, setImgError] = useState('');      // why the last one couldn't go
  const [dragging, setDragging] = useState(false);   // a file is hovering the chat panel
  const fileRef = useRef(null);   // hidden file input for importing a list
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
    if (t) {
      room.sendChat(t);
      setDraft('');
      if (chatTaRef.current) chatTaRef.current.style.height = 'auto'; // collapse the grown textarea
    }
  }

  // Share a picture: shrink it here, hand the result to the room, show the reason
  // if it can't go. Anything that isn't a picture is ignored rather than explained.
  async function sendPicture(file) {
    if (!isImage(file)) return;
    setImgError('');
    setPreparing(true);
    try {
      const { data, mime } = await prepareImage(file);
      room.sendImage(data, mime);
    } catch (err) {
      setImgError(err.message || 'That picture could not be shared.');
    } finally {
      setPreparing(false);
    }
  }
  const onPickFile = (e) => { const f = e.target.files?.[0]; if (f) sendPicture(f); e.target.value = ''; };
  const onPasteChat = (e) => {
    const file = [...(e.clipboardData?.files || [])][0];
    if (file && isImage(file)) { e.preventDefault(); sendPicture(file); }
  };
  const onDropChat = (e) => {
    const file = [...(e.dataTransfer?.files || [])][0];
    if (file && isImage(file)) { e.preventDefault(); setDragging(false); sendPicture(file); }
  };
  function downloadTodos() {
    const body = tasks.map((t) => `[${t.done ? 'x' : ' '}] ${t.text}`).join('\n');
    download('nook-todo.txt', `Nook to-do list\n\n${body || '(empty)'}\n`);
  }
  function downloadChat() {
    const body = chat.map((m) => `[${new Date(m.t).toLocaleTimeString()}] ${m.name}: ${m.text ?? '[picture]'}`).join('\n');
    download('nook-chat.txt', `Nook chat log\n\n${body || '(no messages)'}\n`);
  }
  function importList(e) {
    const file = e.target.files?.[0];
    e.target.value = '';                 // let the same file be re-picked
    if (!file) return;
    file.text().then((txt) => {
      const parsed = parseList(txt);
      if (!parsed.length) return;
      setTasks((ts) => {
        const seen = new Set(ts.map((t) => t.text));
        const fresh = parsed.filter((p) => !seen.has(p.text))
                            .map((p) => ({ id: nextTaskId(), text: p.text, done: p.done }));
        return [...ts, ...fresh];
      });
    });
  }

  if (status === 'kicked') return <Ended msg="You were removed from this room." onLeave={onLeave} />;
  if (status === 'full') return <Ended msg="That room is full. Four is the max." onLeave={onLeave} />;
  if (status === 'locked') return <Ended msg="That room is closed to new people right now. Try again later, or start your own room." onLeave={onLeave} />;
  if (status === 'offline') return <Ended msg="Lost connection to the room. This may be your internet, or Nook may be briefly down — try rejoining in a moment." onLeave={onLeave} />;
  if (status === 'superseded') return <Ended msg="You opened this room in another tab or window, so this one stepped aside." onLeave={onLeave} />;

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
    <aside className={`panel chat-panel ${dragging ? 'dropping' : ''}`}
      onDragOver={(e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={onDropChat}>
      <div className="panel-head">
        <h3 className="panel-title">Chat</h3>
        <span className="hint" title="Never stored on a server. A copy stays in your browser so a refresh can restore it, and it clears when you close the tab.">not on our servers</span>
      </div>
      <div className="chat-log" ref={logRef}>
        {chat.length === 0 ? (
          <div className="chat-empty"><ChatDoodle /><p>Say something. Messages vanish when the room does.</p></div>
        ) : chat.map((m, i) => (
          <ChatMessage key={m.mid || i} m={m} selfId={selfId} onReact={room.react} onEdit={room.editChat} />
        ))}
      </div>
      <form className="chat-form" onSubmit={send}>
        {/* Multi-line composer (#70): grows to a few lines. Enter sends,
            Shift+Enter adds a line. */}
        {/* Picture: picker here, or paste into the composer, or drop on the panel. */}
        <input ref={picRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden onChange={onPickFile} />
        <button type="button" className="attach-btn" onClick={() => picRef.current?.click()} disabled={preparing}
          aria-label="Share a picture" title="Share a picture">{preparing ? '…' : '🖼'}</button>
        <textarea ref={chatTaRef} className="chat-input" value={draft} placeholder="Message…" maxLength={500} rows={1}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={onPasteChat}
          onInput={(e) => { e.target.style.height = 'auto'; e.target.style.height = `${Math.min(e.target.scrollHeight, 84)}px`; }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(e); } }} />
        <button className="primary chat-send" type="submit" disabled={!draft.trim()}>Send</button>
      </form>
      {imgError && <p className="chat-img-error" role="alert">{imgError}</p>}
      <p className="chat-note">Chat isn’t saved, and pictures are passed straight through, never stored. Both clear when you leave or the room closes.</p>
      <div className="dl-row">
        <button className="secondary sm" onClick={downloadTodos}>Download list</button>
        <button className="secondary sm" onClick={() => fileRef.current?.click()}>Import list</button>
        <input ref={fileRef} type="file" accept=".txt,.md,.csv,.json" hidden onChange={importList} />
        <button className="secondary sm" onClick={downloadChat} disabled={chat.length === 0}>Download chat</button>
      </div>
    </aside>
  );

  return (
    <main className={`room ${phase === 'focus' ? 'focus-fit' : ''}`}>
      {status === 'reconnecting' && <div className="reconnecting" role="status">Reconnecting…</div>}
      {status === 'down' && <div className="reconnecting" role="status">Nook's rooms are temporarily down — hang tight, we keep retrying and you'll reconnect automatically.</div>}
      {startingAt && phase === 'greet' && <StartCountdown startingAt={startingAt} />}
      <header className="room-head">
        <div className="room-id">
          <Moon size={26} className="small" /><span>Nook</span>
          <span className="dot">·</span><span className="count">{count}/4 here</span>
          {isPublic ? <span className="badge badge-greet">open</span> : <span className="badge">invite only</span>}
          {locked && <span className="badge badge-locked">🔒 closed</span>}
        </div>
        <div className="room-actions">
          <ThemeToggle className="sm" />
          {/* Anyone in the room can close it: a group that doesn't want company
              locks the door themselves, rather than the room deciding for them. */}
          <button className={`ghost sm ${locked ? 'is-locked' : ''}`} onClick={room.toggleLock}
            title={locked
              ? 'Closed to new people. Open it to let someone in.'
              : 'Anyone with space can join, even mid-session. Close it to keep the room to this group.'}>
            {locked ? '🔒 Closed' : '🔓 Open'}
          </button>
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
          {/* Left column: the video, and chat filling the space beneath it. With
              cameras off (or someone who can't join on camera) chat is the main
              channel, and a wide column under the faces is far easier to read
              than a narrow rail. */}
          <div className="stage-main">
            <JitsiStage roomId={roomId} name={name} />
            {chatPanelEl}
          </div>

          <div className="rail">
            <aside className="panel stage-lead">
              {phase === 'greet' && (
                <GreetPanel selfId={selfId} selfName={name} goal={goal} setGoal={setGoal}
                  onShareGoal={() => goal.trim() && room.sendGoal(goal.trim())}
                  onShared={() => {
                    unlockAudio();
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
                  onReady={() => { unlockAudio(); room.setReady(!iAmReady); }} isHost={isHost}
                  onStart={() => { unlockAudio(); room.start(); }} />
              )}
              {phase === 'regroup' && (
                <RegroupPanel tasks={tasks} isHost={isHost} focusMin={config.focusMin} regroupMin={config.regroupMin} onRestart={room.restart}
                  selfId={selfId} selfName={name} peers={peers} order={order} shared={shared}
                  onReported={() => room.shareGoal()} />
              )}
            </aside>
            {/* In greet, surface the list you're carrying into the next round (#88) —
                otherwise you only see the room's shared lists, not your own. */}
            {phase === 'greet' && tasks.length > 0 && (
              <aside className="panel your-list">
                <FocusPanel tasks={tasks} onAdd={addTask} onEdit={editTask} onToggle={toggleTask}
                  onRemove={removeTask} onReorder={reorderTask} shared={listShared} onToggleShare={toggleShareList} />
              </aside>
            )}
            {sharedListsEl}
          </div>
        </section>
      )}
      <footer className="site-foot in-room">
        <span><ReportBug /> · <SupportNook /></span>
        <span>Built by <a href="https://www.gigikenneth.com/" target="_blank" rel="noopener noreferrer">Gigi</a>. <a href="https://github.com/gigikenneth/nook" target="_blank" rel="noopener noreferrer">Source on GitHub</a>. Prefer Discord? There’s the <a href="https://discord.gg/7fvsBq79VU" target="_blank" rel="noopener noreferrer">Groove Part 2 community</a>.</span>
      </footer>
    </main>
  );
}

// Full-screen shared countdown between "start" and heads-down, so cameras and
// audio stay live for a beat and nobody's cut off mid-sentence (#74).
function StartCountdown({ startingAt }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 200); return () => clearInterval(t); }, []);
  const secs = Math.max(0, Math.ceil((startingAt - now) / 1000));
  return (
    <div className="start-countdown" role="status" aria-live="assertive">
      <div className="start-countdown-inner">
        <p className="start-countdown-label">Heads down in</p>
        <div className="start-countdown-num" key={secs}>{secs || 'go'}</div>
        <p className="start-countdown-sub">You can keep talking until then.</p>
      </div>
    </div>
  );
}

function PhaseBanner({ phase, endsAt, regroupMin }) {
  const copy = {
    greet: { t: 'Say hello', s: 'When it’s your turn, share what you’re working on, out loud or in the chat. Then pass it to the next person. Ready when you are.' },
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
        <p className="hint">{nameOf(currentSharer)} is sharing… you’re up next.</p>
      )}

      {allShared && (
        <>
          <div className="ready-row">
            <span>{ready.length}/{count} ready</span>
            <button className={`primary ${iAmReady ? 'is-on' : ''}`} onClick={onReady}>{iAmReady ? 'Ready ✓' : 'I’m ready'}</button>
          </div>
          <p className="hint">Everyone’s shared. We’ll start when you’re all ready.</p>
        </>
      )}
      <button className="link-btn" onClick={onStart}>Start focus now</button>
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

const LEN_PRESETS = [15, 25, 50]; // quick focus-length picks for the next round

function RegroupPanel({ tasks, isHost, focusMin, regroupMin, onRestart,
  selfId, selfName, peers, order, shared, onReported }) {
  const finished = tasks.filter((t) => t.done).length;
  // Host can retune the next round's length; seeded with the current length.
  const [f, setF] = useState(focusMin);
  const [r, setR] = useState(regroupMin);
  // Reporting order (#90): nobody should have to negotiate who goes first, so the
  // frame walks the join order exactly like greet does. The server clears the
  // greet round's flags on the flip into regroup, so the numbering starts fresh.
  const current = order.find((id) => !shared.includes(id));
  const allReported = order.length > 0 && !current;
  const myTurn = current === selfId;
  const nameOf = (id) => (id === selfId ? 'You' : peers[id]?.name || 'Guest');
  // The countdown lives in the phase banner (heading); no second timer here.
  return (
    <>
      {order.length > 1 && (
        <>
          <h3 className="panel-title">Reporting order</h3>
          <ul className="goal-list turn-list">
            {order.map((id, i) => (
              <li key={id} className={`share-row ${id === current ? 'current' : ''} ${shared.includes(id) ? 'shared' : ''}`}>
                <span className="turn-num">{i + 1}</span>
                <span className="goal-chip" style={{ background: CHIP[i % CHIP.length] }}>
                  {initials(id === selfId ? selfName : nameOf(id))}
                </span>
                <div className="goal-body">
                  <strong>{nameOf(id)}</strong>
                  <span>{id === current ? 'reporting now…' : shared.includes(id) ? 'done' : 'waiting'}</span>
                </div>
                {shared.includes(id) && <span className="share-tick" aria-label="reported">✓</span>}
              </li>
            ))}
          </ul>
          {myTurn && <button className="primary" onClick={onReported}>I’ve reported</button>}
          {!myTurn && current && <p className="hint">{nameOf(current)} is reporting… you’re up after them.</p>}
          {allReported && <p className="hint">Everyone’s reported.</p>}
        </>
      )}
      <h3 className="panel-title">How it went</h3>
      <p className="tally">{finished}/{tasks.length || 0} done</p>
      <ul className="todo-check">
        {tasks.map((t) => (
          <li key={t.id} className={t.done ? 'done' : ''}><span>{t.done ? '✓' : '·'} {t.text}</span></li>
        ))}
      </ul>
      {/* Anyone can start the next round (#55), so it doesn't stall if the host
          left. The host can also change the length for the next round. */}
      {isHost ? (
        <>
          <div className="len-block">
            <span className="len-cap">Next session length</span>
            <div className="len-presets">
              {LEN_PRESETS.map((p) => (
                <button key={p} type="button" className={`len-preset ${f === p ? 'sel' : ''}`} onClick={() => setF(p)}>{p}m</button>
              ))}
            </div>
            <div className="len-row">
              <label className="field small"><span>Focus (min)</span>
                <input type="number" min="1" max="180" value={f} onChange={(e) => setF(Number(e.target.value))} /></label>
              <label className="field small"><span>Regroup (min)</span>
                <input type="number" min="0" max="60" value={r} onChange={(e) => setR(Number(e.target.value))} /></label>
            </div>
            {f !== focusMin && <p className="hint">Was {focusMin}m last round.</p>}
          </div>
          <button className="secondary" onClick={() => onRestart({ focusMin: f, regroupMin: r })}>
            Go another round{f ? ` · ${f} min` : ''}
          </button>
        </>
      ) : (
        <>
          <button className="secondary" onClick={() => onRestart()}>Go another round</button>
          <p className="hint">The host can change the length of the next round.</p>
        </>
      )}
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
