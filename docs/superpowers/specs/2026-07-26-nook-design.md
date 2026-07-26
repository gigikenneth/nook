# Nook — Design

A login-free, zero-database virtual coworking app. Inspired by Groove. Small rooms
(max 4 people), timed focus sessions with camera-on bookends, to-do list + shared
timer during focus. Nothing about a user is ever stored.

## Principle

Keep it light and **free to run forever**. No auth, no database, no video SFU, no
always-on server. Every piece of state is ephemeral and lives in memory or in the
browser. Rooms die when empty. All infra sits inside free tiers.

## Core flow

1. Open app → type a display name + a to-do list.
2. Land in a room, **camera on** (greet phase). Say what you're working on.
3. Everyone hits **Start** → **camera off**. Screen shows only the to-do list + shared timer.
4. Focus timer ends → **Regroup**, cameras back on. Report what got done.
5. Leave, or run another session.

## Ways into a room

- **Invite** — create a room, share an unguessable link/code (UUID). No strangers. Safe default.
- **Public match** — "match me": server drops you into an open room (<4 people) or opens a
  new one. Kick + leave buttons live here (only abuse surface invite-only lacks).

## Timer

- Default: **5 min greet / 50 min focus / 5 min regroup**.
- Room creator may override durations.
- Camera on during greet + regroup; off during focus.
- Phase transitions are broadcast from the server so all members stay synced.

## Architecture

| Piece | Choice | Role |
|---|---|---|
| Server | **Cloudflare Workers + Durable Objects** — one DO per room, in-memory state | Signaling relay, membership, timer phase broadcast, matchmaking queue, cap-of-4, rate-limit on room creation. No DB, no always-on box. |
| Video | Native browser WebRTC, **mesh** (peer-to-peer) | ≤4 people = 3 connections each. Zero server bandwidth. |
| NAT | Google STUN. **No TURN in v1.** | STUN covers most networks; ~10-15% strict-NAT users won't connect (documented). Cloudflare free TURN is the fallback if needed. |
| Frontend | React + Vite → **Cloudflare Pages / GitHub Pages** | Static, free. To-do list stays client-side, never sent to server. |

### Cost — free forever

Everything runs inside free tiers with no always-on server:
- **Cloudflare Workers + Durable Objects**: free tier ~100k requests/day, WebSocket
  hibernation, in-memory DO state. No paid box.
- **Cloudflare/GitHub Pages**: static hosting, free.
- **WebRTC mesh**: peer-to-peer video, no server bandwidth cost.
- **STUN**: free (Google).

**Honest ceiling:** "free" holds while traffic stays under Cloudflare's free tier
(~100k req/day). A viral spike would need a paid plan — unlikely for a niche 4-person
tool, but not hidden. No credit card required to run it.

## Data stored

None persistent. Display name and to-do list are ephemeral (memory / browser only).
Rooms vanish when empty.

## Security / abuse (no accounts)

| Risk | Severity | Mitigation |
|---|---|---|
| Guessing room codes | Medium | Long random UUID room IDs. |
| Room-creation spam / DoS | Medium | IP-based rate limit on session creation. |
| Bad actor joining | Low-Med | Hard cap of 4 enforced server-side. |
| No way to ban | Low | Sessions ephemeral; kick removes them, they rejoin fresh at worst. |
| Camera/video abuse | Medium | Invite rooms aren't public; public-match rooms get kick + leave. |

## Color scheme

Groove's palette is warm coral/peach on cream. Nook takes the complement — hue
rotated 180° — landing on cool teal/cyan on a cool off-white. Signals "not Groove."

| Role | Groove (warm, ref) | Nook (complement) |
|---|---|---|
| Primary | Coral `#FF6F5E` | Teal `#2EC4C6` |
| Accent | Peach `#FFB59E` | Sky `#7FD8E8` |
| Background | Cream `#FFF6EF` | Cool mist `#EEF6F7` |
| Ink/text | Warm brown `#3A2A24` | Deep slate-teal `#16302F` |

Groove refs are from memory of its branding; re-derive complements if the real
primary differs.

## Explicitly skipped (YAGNI)

Auth, database, LiveKit/Jitsi/SFU, chat, profiles, session history, mobile app.
Add an SFU only if room cap ever exceeds ~5 — which defeats the point of Nook.
