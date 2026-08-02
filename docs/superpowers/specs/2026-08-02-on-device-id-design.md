# On-device identity for Nook (design notes)

Status: **not built. Decision pending.** Captured 2026-08-02 so a future session
can pick it up cold. Nothing here is implemented yet.

Origin: GitHub issue **#28** ("an 'ignore' button would be nice, so you can't see
a certain person and they can't see you"). Reporter left an email:
sarahmak888@gmail.com. A draft reply to Sarah is at the bottom of this doc.

## The problem

Nook is deliberately **login-free**: no accounts, and nothing about a person is
stored. That is the whole privacy pitch. It is also exactly why a real "ignore"
(mutual invisibility) is hard: to block a certain person and keep them from
seeing you, the app needs a **stable way to recognise that person every time**,
and today there is none. Names are not unique; the only ids in the system are
per-connection (`selfId`, regenerated every reconnect) and per-tab
(`cid`, sessionStorage, used for reconnect detection). Neither survives a tab
close or identifies a returning browser.

## Proposed primitive: an on-device id (`did`)

A random, anonymous identifier saved in **localStorage** (not a cookie, no
account, no PII). Created once, survives refreshes, new tabs, and future visits
on that device:

```js
let did = localStorage.getItem('nook.did');
if (!did) { did = crypto.randomUUID(); localStorage.setItem('nook.did', did); }
```

It is the persistent, per-browser sibling of the existing per-tab `cid`. Sent to
the server on join (WS query param, like `cid`/`name`) and on presence `hello`.

**Honest ceiling (applies to everything below):** a `did` is per-browser. Anyone
can clear storage, use incognito, switch browsers, or use another device and get
a fresh `did`, so they reappear. It stops casual and repeat encounters well; it
is not a hard wall. This is the same ceiling every account-free system hits.

## Blocking design (issue #28)

When you "ignore" someone, you store *their* `did` in your own block list
(`localStorage['nook.blocks']`, with their display name kept only for your UI).
Then presence, the directory, and rooms filter by `did`. Three levels, each with
a real trade-off. The ask in #28 is **mutual** ("they can't see you either").

| Level | Behaviour | Cost |
|---|---|---|
| **1. One-way, local only** | You stop seeing them. Purely client-side filter. | Simplest, zero server change, stores nothing. **Not mutual**, so it does not meet #28. |
| **2. Mutual, session-scoped** (recommended) | Server holds block pairs in memory and hides both directions (A↔B) while things are live. | Meets #28. Adds a little **relational state on the server** (opaque ids, no PII), ephemeral, resets when the room/lobby DO restarts. |
| **3. Mutual, durable** | Block pairs persisted server-side keyed by `did`, so a block sticks across days. | Truly persistent. But Nook now **stores relational data**, a real departure from "nothing stored," even though ids are anonymous. |

**Recommendation for #28:** Level 2. It actually delivers "we can't see each
other" during a session, keeps the privacy ethos mostly intact (anonymous ids,
nothing durable), and avoids becoming a persistence/moderation system.

## Other benefits of a `did` (beyond blocking)

Grouped by whether they keep the "nothing stored" ethos.

**Cheap wins, client-only (keep the ethos):**
- **Remember you / "welcome back":** prefill name, session lengths, camera
  preference on return so a regular does not re-type. (Mostly localStorage prefs;
  the `did` makes them "yours.")
- **Smoother return, not just refresh:** today's rejoin trick dies on a tab
  *close* (sessionStorage clears). A persistent id lets the server recognise a
  returning browser even after a full close, so "pick up where you left off"
  (goal, task list, no join-noise) works in more cases.
- **Stable visual identity:** `selfId` changes every reconnect (caused the chat
  colour bug we fixed). A `did` gives a consistent avatar colour across
  reconnects and rooms.
- **Presence dedup:** two tabs open = one "you" in Around-now, not a ghost double.

**More powerful, but pull toward accounts/persistence (cost some ethos):**
- **Kicks that stick:** a kicked person currently rejoins fresh; a `did` lets a
  host's kick hold for that room. Needs server to remember the `did`.
- **Better anti-spam:** rate-limit room creation per device, not just per IP.
- **"Cowork again":** optionally mark people you enjoyed a session with and find
  them next time. Nice socially, but starts building a **social graph**, which is
  the "no profiles" thing Nook deliberately skipped.

**Read:** the cheap group is low-cost and purely on-device; "remember name +
prefs" and "smoother return" are worth adding on their own merits, no blocking
needed. The bottom group is the real decision: *is Nook willing to have a light,
anonymous identity?* Kicks-that-stick and durable blocking need the server to
remember `did`s and relationships, which is the first real crack in "nothing
stored" (still anonymous, but relational + durable).

## Implementation sketch (when/if built)

- **Client:** `nook.did` in localStorage (create-once). `nook.blocks` =
  `[{ did, name }]`. Send `did` on the room WS join query and on lobby `hello`.
- **Ignore action:** a small "Ignore" control on a person in Around-now and on a
  room tile. Adds their `{ did, name }` to `nook.blocks`; an "unignore" list in
  settings/help to undo.
- **Level 1 (one-way):** client filters roster/directory/tiles by blocked `did`.
- **Level 2 (mutual, session-scoped):** client sends its block list (dids) to
  `LobbyDO` (and `RoomDO`) on connect; server hides A from B and B from A in the
  roster, directory listings, and room membership broadcasts. Held in memory,
  ephemeral.
- **`did` also unlocks** the client-only wins above independently (name/pref
  recall in Home via localStorage; reconnect recognition by passing `did` to
  RoomDO's existing `recentLeavers`/reconnect logic; avatar colour seeded from
  `did`).
- Update ARCHITECTURE.md (new `did` param, block protocol) and the privacy copy
  if any server-side block state is added.

## Decisions to make before building

1. Do we want an anonymous on-device identity in Nook at all? (Philosophical.)
2. If yes for #28: Level 2 (session-scoped mutual) vs Level 3 (durable)?
3. Ship the cheap client-only wins (remember name/prefs, smoother return) on
   their own, independent of blocking?
4. Privacy copy + README updates if any block state lives server-side.

## Draft reply to Sarah (issue #28)

> Hey Sarah, thanks so much for this. It's a thoughtful ask, and feeling
> comfortable about who can see you matters a lot in a space like this.
>
> I want to be honest about where it lands, though. Nook is deliberately
> login-free: no accounts, and nothing about you is stored. That's great for
> privacy, but it's also the exact reason a real "ignore" is hard to build. To
> reliably block a certain person and keep them from seeing you, the app would
> need a stable way to recognise that person every time, and without accounts
> there isn't one. Names aren't unique, and anyone can rejoin with a different
> name or a fresh tab and show up again. So a block would only really hold within
> a single session, and I don't want to ship something that looks like it protects
> you but quietly doesn't.
>
> A few things that do help today:
> - Rooms are capped at four. You can start one as Invite only (private, kept off
>   the public list) and lock it, so you fully control who's in with you.
> - You're only listed as "around" while you're on the home screen. The moment
>   you're in a session, you drop off that list.
>
> Longer term, if I add an optional local identity (a private, on-device id, still
> no account), a proper mutual block becomes possible, and this is near the top of
> the list for that. I'll keep this issue open as a known gap so it doesn't get
> forgotten.
>
> Really appreciate you flagging it, and I'm open to ideas on how you'd want it to
> feel.
>
> Thanks,
> Gigi
