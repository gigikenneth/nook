<div align="center">

# 🌙 Nook

### Your focus crew for the next 50 minutes.

Show up, say what you're on, and get it done alongside a few other people. Rooms
of up to four. No account, no downloads, no personal data saved. Inspired by Groove.

**[→ Open Nook](https://nook.gigikenneth.workers.dev)**

<br>

<img src="docs/images/home.png" alt="Nook home screen with a live directory of coworking rooms" width="720">

</div>

---

## What is this?

Working alone is hard. Nook gives you the quiet company of a few other people
working at the same time: you can see each other, say what you're each trying to
get done, then go heads-down together for a focused stretch. It's like sitting at
a shared table in a library, not a video call.

A room holds **four people, max**. That's on purpose. Small enough that everyone's
presence actually matters.

## How a session works

A session moves through three short phases, together, on a shared timer:

| Phase | Cameras | What happens |
|:--|:--|:--|
| 🟢 **Greet** | On | Say hi. Type what you're working on. Everyone shares in turn, then marks themselves ready. |
| 🔵 **Focus** | Off | Heads-down. Just your to-do list and a shared countdown (50 min by default). |
| 🟣 **Regroup** | On | See what got done. Run another round, or head out. |

You control your **own mic and camera** at any time, and you can **add, edit,
check off, or delete tasks** on your list mid-session. You can also flag a
**camera preference** — "up for camera" 📷 or "camera-shy" 🙈 — so the group knows
the vibe without it ever forcing your camera on or off.

A few gentle touches keep you in the flow: a soft chime when someone new joins, a
**5-minute warning** before focus ends, an optional **mid-session check-in** you
can share to the chat, the countdown mirrored into your **browser tab title**,
and a **screen wake lock** so a phone left open doesn't sleep.

**Pick up where you left off.** If your connection blips, you refresh, or even if
everyone steps away and comes back later, the session is waiting exactly where it
was — same phase, same countdown. It doesn't restart from the top.

<table>
<tr>
<td width="50%"><img src="docs/images/session.png" alt="Greet phase: two people, taking turns to share what they're working on"><br><em>Greet: share what you're working on, in turn.</em></td>
<td width="50%"><img src="docs/images/focus.png" alt="Focus phase: heads-down with a shared timer and a personal task list"><br><em>Focus: heads-down with a shared timer and your list.</em></td>
</tr>
</table>

## Join someone, or start your own

The home screen shows a **live directory** of open rooms: who's around, what
they're working on, and how long a session has left. Join anyone with a free
seat, even mid-session — you'll drop into whatever phase they're in and wrap up
together. Hosts can **lock** their room to keep it to the current group, or leave
it **open** so latecomers can join.

Or start your own:

- **Open room** — listed in the directory, anyone can join (up to 4).
- **Invite only** — private and unlisted; share the link yourself.

There's a lightweight **chat** during the session, and one-tap **Download list**
or **Download chat** if you want to keep anything.

## Find someone to cowork

Add your name and you'll show up in the **Around now** list for anyone else on
the home screen. See someone you'd like to work alongside? **Ping** them: it
opens a room and sends them an invite they can join with one tap. You drop off
the list the moment you're in a session.

<table>
<tr>
<td width="50%"><img src="docs/images/presence.png" alt="Around now list showing who is around to cowork, each with a Ping button"><br><em>See who's around and ping them.</em></td>
<td width="50%"><img src="docs/images/invite.png" alt="An incoming cowork invite toast with Join and Dismiss"><br><em>Get pinged, join with one tap.</em></td>
</tr>
</table>

## Peek without leaving

In a session and curious what else is happening? Tap **Home** in the room header
for a quick overlay — just **who's coworking now** and **who's around** — while
your session keeps running underneath. You can even ping someone from there to
pull them into the room you're already in. Close it and you're right back in.

<div align="center">
<img src="docs/images/overlay.png" alt="The home screen open as an overlay over a running session" width="640">
</div>

## Your privacy

No account, no database, no analytics — and **none of your personal data is
stored**.

- Your name, to-do list, and chat live only in your browser and in the room's live memory. A copy of your list and chat is kept in your own browser tab so a refresh or a dropped connection can restore them; it never leaves your device and clears when you close the tab.
- Chat is relayed live and is never stored on a server — the shared history disappears when the room does.
- Video and audio flow through **Cloudflare Realtime** (a media relay), encrypted in transit and **never recorded or stored**. Nothing is written to disk; the stream exists only while the room does.
- Two small pieces of state are kept on the server, and neither identifies you:
  - The room's own **session state** — its phase and countdown — so you can pick
    up a session where you left off. It holds no names, goals, or messages, and
    it's wiped after a room sits empty for a while.
  - If you **ignore** someone, an anonymous **block record** so it keeps holding
    on your next visit. It's a pair of random per-browser ids — no names, no
    accounts, nothing that says who either of you is.

## FAQ

**Do I need an account?** No. Type a name and you're in.

**Is my video recorded?** No. Video and audio pass through Cloudflare Realtime
(a media relay) encrypted in transit and are never recorded or written to disk.
The stream exists only while the room is live and is gone when it ends.

**What if my camera won't connect?** Each person makes one connection to
Cloudflare's nearest edge, with STUN and a TURN relay to get through strict
networks. If your own camera won't start, Nook tells you why (blocked, no device,
or in use by another app) instead of silently doing nothing. Even if video
struggles, presence, the timer, chat, and your list keep working.

**How does the video work?** Every person uploads their camera once to Cloudflare
Realtime (an SFU — a media relay), which forwards it to everyone else. Because
each device sends a single stream instead of one per other person, it holds up
far better on phones and in groups of three or four than a direct browser-to-
browser mesh would. Media is encrypted in transit and never recorded or stored.

**Can I stop seeing someone?** Yes. Hit **Ignore** next to a person in "Around
now" and neither of you shows up for the other there, and you can't pull each
other into a room. It sticks across visits. Because there are no accounts it's
tied to your browser, so someone determined can come back on another browser or
device — it stops casual and repeat run-ins, not a hard block. Un-ignore anytime
from the "Ignored" list on the home screen.

**Can more than four people join?** No — four is the cap, by design.

**Is it really free?** Yes. It runs entirely on free infrastructure. See
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) if you want to run your own.

## Run it yourself

Nook is open source (MIT). You can run it locally or deploy your own copy for
free on Cloudflare.

- **[Development guide](docs/DEVELOPMENT.md)** — local setup, project layout, how to contribute.
- **[Architecture](docs/ARCHITECTURE.md)** — how it works, the signaling protocol, the data model.
- **[Deployment guide](docs/DEPLOYMENT.md)** — ship your own in one command, custom domains, adding TURN.

Quick start:

```bash
git clone https://github.com/gigikenneth/nook.git
cd nook
npm install && npm run dev            # signaling Worker on :8787
cd web && npm install && npm run dev  # web app on :5173
```

Open http://localhost:5173. (Both processes need to be running.)

## License

MIT. See [LICENSE](LICENSE). Emoji art is [Twemoji](https://github.com/jdecked/twemoji)
(CC-BY 4.0), vendored in `web/public/twemoji/`.
