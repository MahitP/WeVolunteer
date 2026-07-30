# WeVolunteer V1 — Integration Verification & Production Readiness Audit

**Date:** 2026-07-30 · **Branch:** `v1.1-security-accessibility-ux` (at `dd37e60`)
**Nature:** Verification only. **No source files were changed.**
**Method:** Repository read + runtime verification against an isolated instance.

---

## 0. How this was verified, and what could not be

Runtime verification ran against an **isolated instance** — a throwaway seeded `verify.db` with
`OAUTH_ALLOW_MOCK=true` — because verifying signup, deletion, OAuth linking and notification flows
requires writing rows, and `pilot.db` holds real pilot data. `pilot.db` was confirmed unchanged
afterwards (26 users, 7 events, 8.5 credited hours). The audit environment was removed and `.env`
restored.

**Explicitly NOT verified, and why:**

| Area | Why not |
|---|---|
| Real Google / Microsoft OAuth round-trip | Requires live provider auth. Exercised via the mock transport, which is **more permissive than production** — see M-1. |
| Microsoft `email_verified` handling in production | The mock honours an injected claim; production hardcodes `false`. Verified by **code reading only** (`microsoft.js:98`). |
| iOS/Android Safari & Chrome on real hardware | No device available. Verified in an emulated 375×812 / 812×375 viewport, which does **not** report a coarse pointer or non-zero safe-area insets. Touch-target and safe-area findings below are therefore mechanism-level, not device-observed. |
| Browser restart / cookie expiry over 7 days | Cannot fast-forward a browser's cookie clock. Session invalidation verified via `token_version` instead. |
| Real SMTP delivery | Mock transport logs to console. Token lifecycle verified; deliverability not. |
| Offline notification delivery | Depends on the socket, which is non-functional (C-1). Untestable until that is fixed. |
| Load beyond 5,000 notifications / 503 events | Seeded that much; district-year scale extrapolated, not measured. |

---

## ❌ Critical — must fix before launch

### C-1 (P0) Real-time delivery is completely non-functional

Two independent defects, either sufficient alone.

**(a) The socket handshake reads a claim that does not exist.**
`server/realtime/socketServer.js:29` reads `payload.userId`. The token is signed with `id`
(`authRoutes.js:97`), and the REST middleware correctly reads `decodedUser.id` (`utils.js:21`).

Evidence — decoded from a live session cookie:
```
payload.id     = user-student-1
payload.userId = undefined   <-- what socketServer.js:29 reads
```
A real `socket.io-client` connection with a valid session cookie:
```
{ "result": "REJECTED", "error": "Authentication error: Invalid session" }
```
`db.prepare(...).get(undefined)` throws in `node:sqlite`, so it lands in the catch-all. **Every
socket connection is rejected, in development and in production.**

**(b) Vite has no `/socket.io` proxy.**
`src/services/socket.js:16` states "the Vite proxy forwards `/socket.io` to the backend".
`vite.config.js` proxies only `/api`. Measured: `/socket.io/?EIO=4…` returns
`content-type: text/html` — the SPA shell — so the client parses HTML as a handshake and, with
`reconnectionAttempts: Infinity`, retries forever.

**Impact.** Everything below silently requires a manual refresh: `notification.created`,
`notification.read` (NotificationsBell, Notifications view), `message.created` (Messages,
ConversationPane), `typing.start`/`stop`, `conversation.read`. The server-side emit calls are
correct — the break is purely the connection.

**Why tests missed it.** No test opens a socket. Phase 8's "real-time delivery" and Phase 9's
"receiving / unread counts" cannot work as specified.

### C-2 (P0) `.ics` calendar export produces a file no calendar application can parse

`server/routes/eventRoutes.js:1073` joins the lines with `'\\r\\n'` inside a single-quoted string,
which emits the four literal characters `\`, `r`, `\`, `n` rather than CRLF.

Hex evidence from the served file:
```
00000000: 4245 4749 4e3a 5643 414c 454e 4441 525c   BEGIN:VCALENDAR\
00000010: 725c 6e56 4552 5349 4f4e 3a32 2e30 5c72   r\nVERSION:2.0\r
```
`5c 72 5c 6e` = `\r\n` as text. The file has **0 physical lines and 0 CR bytes**. RFC 5545 requires
`BEGIN:VCALENDAR` as its own first content line; the entire file is one line, so Apple Calendar,
Google Calendar and Outlook all reject it. "Add to calendar" is broken for every user.

**Why tests missed it.** `routes.events.test.js:32-38` asserts only `toContain('BEGIN:VCALENDAR')`
and similar substrings — all of which pass on a single-line file. The test validates presence, not
validity.

*(Note: the `\\n\\n` inside `DESCRIPTION:` is correct — RFC 5545 escapes newlines in text values as
`\n`. Only the line separator is wrong.)*

### C-3 (P0, process) `.env` with a live Google client secret was committed

Introduced by **this session's** commit `65a2ee8`, because `.gitignore` covers `.env.production` but
not `.env`. Contains a real `GOOGLE_CLIENT_SECRET` (`GOCSPX-…`); `JWT_SECRET` and `SMTP_PASS` are
still placeholders.

**Not pushed** — `git rev-parse @{u}` reports no upstream for this branch, and `.env` appears in
exactly one commit. Remediation: rotate the Google secret regardless, `git rm --cached .env`, add
`.env` to `.gitignore`, and purge the single unpushed commit from history. Do not push until done.

---

## ⚠ Minor — can wait for v1.1

### P1

- **N-1 `/api/events` is unbounded and uncompressed.** 503 events → **690,129 bytes**. Requesting
  with `Accept-Encoding: gzip` returns a byte-identical response (no `compression` middleware in
  `app.js`); the same payload gzips to **12,769 bytes — 54× smaller**. `App.jsx` fetches this on
  every session restore. On school cellular this is the single largest UX cost in the product.
- **N-2 `BrowseEvents` renders every event with no windowing.** `BrowseEvents.jsx:264` maps
  `filtered` directly. Measured with 502 events: **23,815 DOM nodes**, **285,547 px** of scroll
  height, no virtualization. Lighthouse warns above 1,500 nodes and calls 6,000 excessive.
- **N-3 iOS safe-area handling is written but inert.** `index.css` uses
  `env(safe-area-inset-*)` in 12 places, correctly — including `padding-bottom` on `.mobilenav`
  (4220) and `.app` (4247). But `index.html:6` is
  `content="width=device-width, initial-scale=1.0"` with **no `viewport-fit=cover`**, without which
  iOS resolves every inset to `0px`. Measured bottom-nav `padding-bottom: 0px`. On any iPhone with
  a home indicator the bottom nav and message composer sit in the gesture area. One-line root
  cause disabling all the safe-area work already done.
- **N-4 Dashboard overflows horizontally on mobile.** 18 px of horizontal scroll at 375 px wide, on
  the first screen after sign-in. No single element exceeds the viewport, so it is cumulative
  margin/padding. Every other screen measured 0.

### P2

- **M-1 The OAuth mock is more permissive than production.** `microsoft.js:31` returns
  `emailVerified: parsed.emailVerified === true` — honouring an injected claim — while production
  (`:98`) hardcodes `false`. A test suite using the mock can assert a trust behaviour production
  does not have. Worth making the mock mirror production's hardcoded `false`.
- **M-2 OAuth `state` is not invalidated server-side.** Replay is prevented only by clearing the
  HttpOnly nonce cookie. A browser honours that; a scripted client that retains the cookie can
  replay the same `state`. Confirmed: second presentation returned `200 signup_required`. Not
  exploitable on its own — the authorization *code* is single-use at the provider, which is what
  actually blocks it in production — but the nonce should be burned server-side.
- **M-3 The `.ics` endpoint requires no authentication.** `GET /api/events/:id/slots/:id/ics`
  returned `200` with no cookie, disclosing event title, description, location and exact times.
  Event listings are visible to all authenticated users, so this is an exposure *widening* rather
  than a new class of leak — but shift location and time for minors is the data the product is
  otherwise careful about.
- **M-4 `[DEBUG]` logging in the notification dispatch path.**
  `notificationService.js` logs `[DEBUG] dispatch successful for event … userId …` on **every**
  notification. Log noise at district scale, and it writes user ids to stdout.
- **M-5 Authorization runs after validation on `PUT /api/events/:id`.** A non-owner with a
  malformed body gets `400 "At least one shift is required."` instead of `403`. With a valid body the
  check is correctly enforced (verified: `403 "You do not host this event"`, title unchanged). No
  data exposure — only a small hint about payload shape to a non-owner.
- **M-6 58 lint warnings remain**, all `exhaustive-deps` or unused imports. The crash class is
  clean: `jsx-no-undef` is now zero.

### P3

- **L-1 `authRoutes.js` is 1,546 lines** and holds authentication, volunteer profiles, milestones,
  organizer profiles and notification preferences. Four concerns; split before it grows.
- **L-2 `window.confirm` remains in 7 non-auth places** (event deletion, comments, admin
  moderation). `ConfirmDialog` now exists to replace them.
- **L-3 Four dead `href="#"` links** were fixed on the Help screen; the same pattern should be
  audited elsewhere.
- **L-4 `notificationService` uses `Date.now()`-based ids** (`notif-${Date.now()}-${random}`).
  The random suffix makes collision unlikely, unlike the audit-log bug already fixed, but
  `randomUUID` would be consistent.

---

## ✅ Verified working

Each line below was exercised at runtime with recorded evidence, not inferred.

**Authentication (Phase 3)** — Sign-in by email *and* by username; wrong-password and
unknown-account paths distinguished; `oauth_only` accounts correctly refused password login with a
recovery hint; suspended and deleted accounts refused; session restore via `/api/auth/me`; logout
clears only the current device; `sign-out-others` invalidates every other session and reissues the
caller's; `token_version` invalidation on password reset and email change.

**Authorization / IDOR (Phase 13) — 20/20 + 12 cross-tenant probes.** All unauthenticated reads
`401`. Students blocked from every `/api/admin/*` (`403`). `role:'admin'` via `PATCH /profile`
rejected (`400`, role unchanged). Peer profile reads hide email and hide upcoming shifts (a minor's
whereabouts). Students cannot mutate a peer's application. **Cross-organizer:** PATCH, PUT, DELETE,
status change, announcement, auto-select, attendance and roster export against another organizer's
event all `403`, with the title verified unchanged after every attempt. **Unapproved organizer
cannot publish** (`403`). **Conversations:** non-participants — *including admins* — get `404` on
read, send, preferences and mark-read, so existence is not even confirmed.

**OAuth (Phase 4) — 25/27, both non-passes explained above.** Apple correctly `501` and reported
`implemented: false`; unknown provider `404`. New Google identity → `signup_required` → signup
completes → Google-attested email pre-verified. Returning identity → `login`. **State/CSRF:**
callback without the nonce cookie `400`; forged state `400`; Microsoft state on the Google route
`400`. Provider email colliding with a password account → `link_required`; wrong password `401`,
correct password links. Duplicate username `409`, **including case-variants**. `role:'admin'` in the
signup blob rejected at `/url`. Signed-in + own email → `auto_linked` (the branch that was
unreachable before this session's C1 fix). Unlink works; unlinking an unconnected provider `404`;
an OAuth-only account **cannot remove its last sign-in method** (`last_sign_in_method`).

**Email verification & recovery (Phase 5) — 25/25.** Signup is *not* auto-verified. The email gate
genuinely confines: `/api/events` and apply both `403 email_unverified`, while `/api/auth/me` and
`resend-verification` are allowed. Resend rotates the token and invalidates the old one. Invalid,
expired and replayed tokens all `400`; expired tokens purged on use. Reset: re-requesting
invalidates the prior link, weak passwords refused with signup's rules, single-use, old password
stops working, `token_version` bumped. Expiry correctly enforced on all three token types
(verification, reset, email-change). `forgot-password` returns a byte-identical body for a real and
an unknown address.

**Database integrity (Phase 12)** — `PRAGMA integrity_check` = ok. `foreign_key_check` = no
violations. `foreign_keys = 1` (`node:sqlite` enables it by default, unlike better-sqlite3), and
`ON DELETE CASCADE` verified live: child notification and reset-token rows vanished with the parent
user. **18-relationship orphan sweep: 0 orphans.** 24 indexes present. No duplicate email
(case-insensitive), username (case-insensitive), provider identity, or per-user provider.

**Calendar (Phase 7)** — Month and week views; agenda rendered as upcoming/pending/history panels.
**Conflict detection verified end to end:** overlapping application blocked `409` with a specific
message, override permitted deliberately, and the acknowledged conflict surfaces as `hasConflict`.
ICS *endpoint* reachable and correctly typed — but see C-2 for its contents.

**Performance (Phase 14)** — All four hot query plans use indexes (`SEARCH … USING INDEX`, no full
scans) on notifications-by-user, slots-by-event, applications-by-slot+status, attendance-by-user.
`/api/notifications` caps at 50 rows without a `limit` param (5,003 in table → 50 returned).
Response times with 5,003 notifications and 503 events: 1–18 ms. Cold `domContentLoaded` 269 ms.
No error boundary triggered on any of 7 screens.

**Runtime cleanliness (Phase 2)** — Zero console errors and zero React warnings across dashboard,
browse, calendar, notifications, messages, profile and settings. No error boundaries. No 5xx across
a 19-endpoint GET sweep plus 6 event-scoped reads.

**Mobile (Phase 10)** — At 375×812: no horizontal overflow on browse, calendar, notifications,
messages or settings (dashboard excepted, N-4). All auth-screen targets clear WCAG 2.5.8 AA. Radio
and checkbox controls measure 16 px but are wrapped in 311×62 and 311×97 labels, so the card is the
target. Landscape 812×375 scrolls correctly with nothing clipped.

---

## Production readiness assessment

**Not ready to launch — two P0 functional defects.**

Neither is a security hole, and the security posture is genuinely good: 20/20 authorization checks,
25/27 OAuth branches, zero orphans, cascades enforced, no privilege escalation path found. Attempts
that found nothing include role escalation via both signup doors, verification bypass, OAuth state
forgery, cross-tenant event and conversation access, and reset-token reuse.

The blockers are integration failures of exactly the kind this audit was for — each sits in the seam
between two subsystems that were built separately and never exercised together:

- **C-1** is a claim-name disagreement between the auth layer and the realtime layer, plus a proxy
  entry that was documented but never added. The whole realtime feature set is dark.
- **C-2** is a two-character string-escape error, shipped green because the test asserted substrings
  rather than parsing the output.

Both are small fixes. Both need a test that exercises the real contract — open an actual socket;
parse the actual `.ics` — rather than asserting on fragments.

**Recommended launch gate:** fix C-1 and C-2, resolve C-3, and add N-1 (compression is a two-line
middleware for a 54× payload reduction) and N-3 (`viewport-fit=cover` is one attribute that
activates 12 existing rules). N-2 is the largest remaining piece of work and is the one item I would
be comfortable deferring to v1.1 with a known-issue note.
