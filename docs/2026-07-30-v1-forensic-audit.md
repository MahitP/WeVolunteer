# WeVolunteer V1 — Forensic Audit & Production Readiness Assessment

**Date:** 2026-07-30
**Baseline:** `229a94d` (Initial commit, 2026-07-20)
**Head audited:** `d8672a4` on `v1.1-security-accessibility-ux` (2026-07-30)
**Divergence:** 47 commits ahead of `main`, 0 behind. 206 files changed, +36,805 / −4,269.
**Method:** Zero-trust. Every claim below is backed by a command I ran in this audit — a booted server, a live HTTP journey, a SQL query against the resulting database, or a git object scan. Prior reports were treated as hypotheses, and several did not survive.

---

## Executive Summary

WeVolunteer's **security, authentication, and data-integrity engineering is genuinely strong** — stronger than most pre-pilot codebases of this size. I attacked it directly and it held: 10/10 unauthenticated endpoints refused, 6/6 privilege-escalation attempts refused, IDOR attempts refused, cross-organizer hours-crediting refused, OAuth state replay refused, socket handshakes with forged and absent sessions refused. Hours cannot be inflated by a client *by construction*. The append-only ledger's parity invariant held under test.

**But the product loop has a broken limb, and the demo has a self-destruct button.**

Three findings dominate:

1. **`POST /api/auth/reset` destroys the database instead of resetting it.** It drops 16 tables, fails partway on `DROP TABLE users`, and never reaches `initDatabase()`. The pilot/demo is left with users but no events, applications, attendance, notifications, or hours ledger — and every screen that touches them throws. The UI reports this as a toast. This is a regression: tables added for messaging, certificates, and moderation were never added to the drop list. **Zero test coverage.**

2. **The waitlist does not work on manually-managed events.** When a confirmed volunteer releases a spot, nobody is promoted — promotion is gated on `auto_approve === 1`. I watched a shift end up with capacity 1, zero accepted, and one person waitlisted. Nobody was told.

3. **Waitlisted volunteers receive a placeholder notification** reading literally *"Notification / You have a new notification."* — no link, wrong category, and at `NORMAL` priority, meaning the 30-day retention sweep deletes it. `APPLICATION_WAITLISTED` is dispatched from three places and mapped in neither the category table nor the content switch.

None of these were caught by the 515-test suite, and all three sit on the core organizer decision path — accept / waitlist / decline. Waitlisting is one third of that path, and it is the third that is broken.

**A green test suite has been mistaken for a working product.** The suite is good at what it covers and silent about what it doesn't.

**Verdict: not production-ready today. Approximately one focused week from being genuinely ready.** None of the top findings are architectural; they are gaps between components that were each built correctly.

**Overall grade: B− .** Security and data integrity earn an A−; the product loop's completeness and the honesty of "done" earn a C+.

---

## Required Verification (run in this audit)

```
npm test    → 53 test files, 515 tests, 515 passed, 0 failed. Exit 0.
npm run build → Exit 0, built in 1.22s.
              dist/assets/index-*.js  1,270.42 kB │ gzip: 333.48 kB   ⚠ warns >500 kB
              dist/assets/LeafletMap-*.js 154.26 kB │ gzip: 45.35 kB
              dist/assets/index-*.css    92.44 kB │ gzip: 17.54 kB
```

Live journeys executed against a real booted server (Express + Socket.IO, throwaway SQLite, `DEMO_MODE=true`, `OAUTH_ALLOW_MOCK=true`):

| Suite | Result |
|---|---|
| Authentication journeys | **23 / 23 passed** |
| Authorization & IDOR | **28 / 29** (1 real defect: oversized body → 500) |
| Product loop, hours, certificates, realtime | **16 / 17** (1 real defect: waitlist promotion) |
| Notification copy, waitlist, retention, dedupe | **4 / 9** (4 real defects, all waitlist-cluster) |
| OAuth, performance, admin, privacy | **10 / 14** (3 were my own assertion errors, 1 characterisation) |

One earlier "crash" I recorded was **my own harness artifact** — I piped server stdout to `head -60`, so the process took SIGPIPE. Not an application defect; corrected here so it is not miscounted.

---

## Part 1 — Changelog Reconstruction

All 47 commits since `main` land in four phases inside eight days. Dates are author dates.

### Phase A — Foundation & hardening (pre-`main`, 2026-07-20 → 07-27)
Baseline `229a94d` already contained the volunteer platform. Before `main` was tagged: append-only hours ledger, attendance decoupled from application status, demo scaffolding excluded from production, password reset, email verification endpoints, username persistence, route/boot split for testability, npm workspace migration, WeVolunteer rebrand.

### Phase B — v1.1 security, tokens, cookies (07-27 → 07-28, 22 commits)
| Change | Commits | Files | Risk | Status |
|---|---|---|---|---|
| jsdom + React Testing Library harness | `c108072` | vitest.config.js, setupTests.js | Low | **Working** |
| Design tokens replace colour literals | `2b52b43`, `6a32eb2` | index.css, ~40 JSX | Low | **Working, enforced by test** |
| Content-Security-Policy enabled | `24b455f`, `0bc7437` | app.js | Med | **Working, verified live** |
| Session cookie config | `79be2b0`, `66030e1` | config.js, authRoutes | High | **Working** |
| Cookie authentication (replaces localStorage JWT) | `0b82c03`, `ca7c4c4`, `eeb2c27`, `78428cc` | utils.js, api.js, all tests | High | **Working, verified live** |
| Server-side logout | `3ed4748` | authRoutes | Med | **Working (see F-12)** |
| Min password length → 8 | `e791eb8` | accountValidation | Low | **Working** |
| Scoped refresh invalidation | `00a2d33` | App.jsx | Med | **Working** |
| EventModal decomposition | `6afce2e` | 6 new components | Med | **Working** |
| Empty/loading states, a11y, mobile touch targets, dark mode | `066fa16`, `d4ae667`, `038f670`, `d621d05` | index.css, many | Med | **Mostly working (see F-8)** |
| Email notifications + opt-out | `d401938` | email.js, notificationService | Med | **Working** |

### Phase C — Code splitting, then its silent reversal (07-28)
| Change | Commit | Status |
|---|---|---|
| React code splitting (15 views → `React.lazy`) | `353a492` | **REVERTED — see F-6** |
| Playwright tests updated | `11b9aeb` | Present, not run in `npm test` |

### Phase D — Auth audit & stabilization (07-30, 12 commits)
| Change | Commits | Risk | Status |
|---|---|---|---|
| Auth audit findings + remediation plan | `70cd700`, `fe14d19` | — | Docs — **but `70cd700` also reverted code splitting and rewrote 270 lines of EventApplicantsTab** |
| Four broken auth flows repaired (OAuth callback route, reset-password route, global-logout bug, username case-sensitivity) | `3c6a725` | High | **Working, verified live** |
| Security hardening: per-account throttle, validation, deletion, demo data | `46c4a73` | High | **Working, verified live** |
| Email + username change flows | `ec0f7cc` | Med | **Working** |
| Dialog semantics, touch targets, iOS zoom, render crashes | `587b084` | Med | **Mostly working (see F-8)** |
| Three P0 fixes: realtime handshake, ICS, secrets | `a9dce6c` | High | **Working, verified live** |
| Pre-commit secret scanning | `2e3ac59` | Med | Present |
| Compression, list windowing, iOS safe-area | `6b3aab4` | Med | **Working, gzip verified live** |
| Real JWT_SECRET guard + event pagination | `a4d1b62` | High | **Working** |
| SPA wired to paged endpoint | `233fe3a` | Med | **Working (PAGE_SIZE=60)** |
| Filtering/sorting/distance pushed into SQL | `986986b` | Med | **Working** |
| Route split + P2 fixes + regression cover | `d8672a4` | Med | **Working** |

**Architectural arc:** monolith → route modules (13 routers) → config extraction with no side effects → testable boot. `server/config.js` importing without opening a database or starting a listener is what makes 515 tests possible. That was the single best structural decision in the project.

---

## Part 2 — Authentication Findings

**23/23 live journey checks passed.** This is the strongest area of the codebase.

Verified working:
- Weak password rejected with a *specific* remediation list ("still needs: at least 8 characters, at least 1 uppercase letter, at least 1 number").
- Invalid email rejected; duplicate username and duplicate email both rejected **case-insensitively** (409), backed by real `COLLATE NOCASE` unique indexes plus dedupe migrations that reconcile pre-existing collisions without merging or deleting accounts.
- Unverified account is signed in but confined: `/api/auth/me` 200, `/api/events` **403 `email_unverified`**, notifications allowlisted, resend works. The allowlist deliberately includes the email-*change* routes so a mistyped address is escapable rather than a permanent dead end — that is a subtle, correct call.
- Login by email **or** username.
- **Per-account throttle keyed on the resolved account, not the typed string.** After 10 failures, the correct password is refused with 429 `account_throttled`; alternating email/username spelling does not double the allowance. The lock is checked *before* the no-such-account / suspended / oauth-only branches, so a locked-out attacker cannot keep reading those oracles.
- Logout is **per-device**: device A logging out leaves device B signed in.
- `sign-out-others` genuinely rotates `token_version`, invalidates other devices, and re-issues the current one. (Both of these were previously lies; both are now real.)
- `forgot-password` returns 200 for unknown addresses (no existence leak); bogus reset tokens refused.
- OAuth: state nonce is a JWT in the authorize URL, **single-use** (replay refused), missing/forged state refused. Apple correctly advertised `enabled:false, implemented:false`. Provider-attested email auto-confirms (Google asserts `email_verified`; Microsoft honestly does not).

**F-13 (Medium, by design): login is an account-enumeration oracle.** `no_such_account` vs `wrong_password` are distinguishable. This is documented and deliberate, with a stated reversal switch (`GENERIC_LOGIN_ERRORS`). The reasoning — that `check-username`/`check-email` already expose the same fact — is sound. But on a platform whose users are mostly minors, the aggregate posture is that anyone can confirm whether a given child has an account. Worth a deliberate second look with the district, not a code fix.

**F-12 (Medium): logout does not revoke.** `POST /api/auth/logout` clears the cookie only; the JWT stays valid for its full 7 days. I confirmed cookie A still authenticated after logout. Documented as a trade-off with `sign-out-others` as the escape hatch — but "Sign out" on a shared library computer is weaker than the word implies, and that is the exact scenario schools have.

---

## Part 3 — Notification Findings

Architecture: a single `notificationService.dispatch(event, payload, userId, dedupeKey)` → category lookup → per-category preference check → in-app row + socket emit + queued email job. This is a good design, and the earlier parallel `createNotification()` path has been correctly retired.

Verified working:
- Acceptance wrote a row **and pushed it live over the socket** (`APPLICATION | IMPORTANT | "You were accepted!"`).
- Cancellation notified the confirmed volunteer at **CRITICAL** priority (`EVENT | CRITICAL | "Cancellation Probe was cancelled"`), so retention can never sweep it.
- **Dedupe is real:** three consecutive `runNotificationSweep()` calls left the count at 12 → 12, with zero duplicate `(user_id, dedupe_key)` pairs.
- Mark-all-read cleared unread to 0 and left the other user's unread untouched. API unread count matched the database.

### F-3 (HIGH) — `APPLICATION_WAITLISTED` is unmapped; waitlisted users get placeholder copy

Live evidence, from a real waitlisting through the API:

```
S2's waitlist notification:
  SYSTEM :: NORMAL :: Notification :: You have a new notification. :: NO-LINK
```

Root cause: `APPLICATION_WAITLISTED` appears in neither `EVENT_CATEGORIES` nor the `getInAppContent` switch in `server/services/notificationContent.js`, so it falls through to `default:` which returns `title: payload.title || 'Notification'`. The payload carries `{eventId, eventTitle, waitlistRank}` and no `title`/`body`/`link`.

Four consequences, all confirmed:
1. Copy is the generic fallback — a student is told nothing.
2. Category resolves to `SYSTEM`, so it is **invisible under the Applications filter** in `src/utils/notifications.js`.
3. `link` is NULL — tapping it goes nowhere.
4. Priority is `NORMAL`, so the 30-day retention sweep **deletes it**, unlike accepted (IMPORTANT) and cancelled (CRITICAL).

Three dispatch sites: `applicationRoutes.js:473` (single), `applicationRoutes.js:334` (bulk), `eventRoutes.js:1123` (Auto Select — which computes a `waitlistRank` and then discards it).

### F-9 (Medium) — 11 declared notification categories never fire

`APPLICATION_SUBMITTED`, `REMOVED_FROM_EVENT`, `EVENT_LOCATION_CHANGED`, `EVENT_TIME_CHANGED`, `EVENT_FULL`, `SPOT_AVAILABLE`, `CERTIFICATE_REVOKED`, `PASSWORD_CHANGED`, `PASSWORD_RESET`, `EMAIL_VERIFIED`, `MAINTENANCE_NOTICE`. `REMOVED_FROM_EVENT` even has written copy that never renders — a volunteer removed *after being confirmed* instead receives "not selected this time", which is wrong and slightly insulting. `EVENT_LOCATION_CHANGED` / `EVENT_TIME_CHANGED` matter operationally: a location change currently arrives as a generic `EVENT_UPDATED`.

### F-11 (Low) — Retention is one-sided
The sweep deletes `NORMAL`/`LOW` older than 30 days. `CRITICAL`/`IMPORTANT` are never deleted, so they grow without bound.

### F-16 (Low) — Socket revocation lag
`SOCKET_SESSION_CHECK_INTERVAL_MS` defaults to 5 minutes, so a revoked session keeps a live channel for up to that long. **F-17 (Low):** the typing rate-limit bucket is created per connection, so N tabs get N× the allowance.

---

## Part 4 — Calendar Findings

- Month and week views (`viewMode` state), plus agenda sections (upcoming / pending / history), each capped at 5 entries.
- **Conflict detection is real and good.** Applying to an overlapping shift returns 409 with severity levels: `level 1` (pending elsewhere) and `level 2` ("already accepted for another volunteer shift during this time"). The client renders distinct copy per level and offers an explicit override, which writes an `application_conflicts` row with `acknowledged_at` and dispatches `SCHEDULE_CONFLICT_WARNING`. Conflicts are logged, not just warned about.
- **ICS export is RFC 5545 valid.** Verified on a live export: `BEGIN`/`END:VCALENDAR`, `VERSION:2.0`, `PRODID`, `UID`, `DTSTAMP`, **CRLF line endings**, **all lines folded to ≤75 octets** (the long `DESCRIPTION` correctly continues with a leading space), `Content-Type: text/calendar; charset=utf-8`. Most hand-rolled ICS writers fail the folding rule; this one does not.

Caveat: export is per-slot (`/api/events/:eventId/slots/:slotId/ics`). There is **no whole-calendar subscription feed**, so a volunteer with eight shifts adds eight files by hand and gets no updates when a shift moves.

---

## Part 5 — Messaging Findings

**The permission model is structurally sound, which is the right way to build this.**

`POST /api/messages/conversations/resolve` takes `{eventId, studentId}`. A student supplies only `eventId`; the organizer side is derived from the event. There is no request shape a student can send that names another student as the counterparty — **student↔student messaging is impossible by construction, not by a check that could be forgotten.** For a platform serving minors this is the correct architecture.

Verified:
- Messaging is gated on relationship: `403 "Messaging unlocks after an application exists for this event"`.
- An uninvolved student reading another's conversation gets **404, not 403** — no existence leak.
- An uninvolved student cannot post into it.
- A student passing `studentId` cannot impersonate an organizer opening a conversation.
- Message bodies are stored raw (correct — escape at render, not at rest).
- Report/lifecycle tables exist with snapshotting (`conversation_reports`, `conversation_report_messages`) so a report preserves evidence even if messages are later deleted. That is thoughtful.

`GET /api/messages/users/search` returned `{users: []}` for a student with no event relationships — correct, though the empty state needs to explain *why* rather than just being empty (see Part 12).

---

## Part 6 — Mobile Findings

Implemented and real:
- **Bottom navigation** (`.mobilenav`), `display:none` by default and revealed in media queries, with `aria-current='page'` on the active item.
- **13 `safe-area-inset` usages** — iOS notch/home-indicator handled.
- 19 `@media (max-width: …)` breakpoints; sidebar collapses to icons at mid-width.
- Touch targets: 5 × `min-height: 44px`, 1 × `min-width: 44px` — the Apple HIG minimum is applied, though sparsely enough that it reads as targeted fixes rather than a systemic rule.
- iOS input zoom addressed in `587b084`.

Gaps:
- The 1.27 MB single JS bundle (F-6) is a *mobile* problem first. On school cellular this is the difference between a 1-second and a 4-second first paint, and it is the regression with the widest user impact.
- `ReportModal` is mouse-only (F-8) — no Escape, no focus trap. On mobile this is less visible but it is also the safety-reporting surface.
- Landscape behaviour has no dedicated rules; nothing keys off `orientation`.

---

## Part 7 — Design System Findings

**This is the most disciplined part of the frontend.** 277 CSS custom properties, and `src/noHardcodedColors.test.js` makes a colour literal anywhere under `src/` a **build failure** (with a deliberate, documented exception for OAuth brand colours in `components/auth/`). A companion `tokens.test.js` validates that every `var(--x)` resolves. Result: **0 hardcoded hex colours in JSX.** Dark mode is driven by a `data-theme` attribute with one `prefers-color-scheme` default and a pre-paint script in `public/` — kept external specifically so CSP can forbid `unsafe-inline`. That is a real, coherent architectural chain.

Does it feel like one product? **Mostly yes** — the "Field Notes" identity (paper canvas, service green for actions, amber reserved for hours, the `▪▪▪▫▫` seats motif) is consistently applied.

Where philosophies collide:
- **F-8: two hand-rolled modals.** `src/components/ReportModal.jsx` and `src/components/messages/ReportModal.jsx` have **zero** matches for `useModal`, `aria-modal`, `role="dialog"`, or Escape handling. The project's own documented invariant is that every modal uses `Modal.jsx` or `useModal(onClose)` — which supply Escape, focus containment, focus restore, scroll lock, and `aria-modal`. Five components comply; these two do not, and **both are live** (`EventModal` + `EventComments` use one; `ConversationPane` uses the other).
- **F-14: near-duplicate components.** The two ReportModals are 65 and 71 lines of substantially the same thing.
- **F-15: inconsistent API response shapes** leak into the client: `POST /api/events` → flat `{success, id, …}`; `GET /api/events/:id` → `{event, applications}`; `GET /api/events` → a bare array, or a paged object when `limit` is passed. Every caller needs a different unwrap, and I hit this three times writing test journeys.
- `index.css` is a single 5,013-line file — navigable today, a merge-conflict magnet with more than one contributor.

---

## Part 8 — Security Findings

I attacked this surface directly. **It held.**

| Attack | Result |
|---|---|
| Unauthenticated access to 10 protected endpoints | **All 401** |
| Student → 5 admin endpoints + organizer approval | **All 403** |
| Student creating an event | **403** |
| Student PATCH/DELETE another's event | **403/404** |
| Student marking their own attendance | **403** |
| A *different* organizer crediting hours on someone else's event | **Refused** |
| Reading/posting in a conversation you're not in | **404 (no existence leak)** |
| Downloading a foreign/nonexistent data export | **Refused** |
| OAuth callback with no state | **400** |
| OAuth callback with forged state | **400** |
| OAuth state replay | **Refused (single-use)** |
| Socket handshake, anonymous | **Rejected** |
| Socket handshake, bogus token | **Rejected** |
| Malformed JSON | **400 (not 500)** |
| Login brute force (per-IP + per-account) | **Throttled, 429** |
| Leaderboard PII leak | **None; opt-in respected** |
| Other-user profile PII leak | **No email exposed** |

Headers verified live: CSP with **no `unsafe-inline`** on `script-src`, `frame-ancestors 'none'`, `object-src 'none'`, HSTS `max-age=31536000; includeSubDomains`, `nosniff`, `referrer-policy: no-referrer`. Session cookie: **`HttpOnly`, `SameSite=Lax`**, `Max-Age=604800`. `Secure` is correctly gated on production.

Boot-time guards are the right shape — they fail closed: missing `JWT_SECRET` is fatal everywhere; placeholder/low-entropy secrets are fatal *in production* and a warning in dev (so nobody is tempted to paste a production secret locally); `OAUTH_ALLOW_MOCK=true` in production **refuses to boot**; `DEMO_MODE` in production is fatal. The mock OAuth transport used to switch itself on whenever a client ID was absent — a missing env var turning the callback into login-as-anyone. That is now opt-in and unreachable in production. Good catch by whoever found it.

**CSRF:** no token, `SameSite=Lax`, with the reasoning written down — single origin in both topologies, so `Lax` covers the entire cross-site write surface — plus an explicit "REVISIT THIS IF" trigger for subdomain deployment. Correct for the current topology and honestly documented.

### Secrets
`.env` in the working tree contains a **real Gmail SMTP app password and a real Google OAuth client secret**. `.gitignore` correctly ignores `.env` and `.env.*` while re-allowing only the committed templates. I scanned **every object in the repository, including unreachable ones** (`git cat-file --batch-all-objects`) for the live SMTP password: **zero hits.** The secrets are not recoverable from git history. Committed templates contain only placeholders. This is clean — but live third-party credentials sitting in a working tree should still be rotated on any shared machine.

### F-7 (Low) — Oversized body returns 500
`express.json({ limit: '100kb' })` raises `entity.too.large`, but the error handler in `app.js` only special-cases `entity.parse.failed` → 400, so everything else becomes **500 "Internal server error"**. Confirmed live: a 200 KB body returned 500 instead of 413. Cosmetic, but it turns a client mistake into an apparent server fault and pollutes error monitoring.

### F-1 — see Part 9. The reset endpoint is `DEMO_MODE`-gated and correctly *not registered* in production, so it is **not** a production security hole. It is a data-destruction hole in every demo and pilot.

---

## Part 9 — Database & Data Integrity Findings

Integrity on a live database after full journey exercise:

```
PRAGMA integrity_check                    → ok
PRAGMA foreign_key_check                  → (empty; no violations)
PRAGMA foreign_keys (app's connection)    → 1   ← enforced
PRAGMA journal_mode                       → wal
orphan applications                       → 0
orphan attendance                         → 0
attendance without a matching application → 0
ledger vs attendance mismatched users     → 0
notifications with NULL priority          → 0
conversations without participants        → 0
```

Foreign keys **are** enforced (`node:sqlite` enables them by default) — worth stating explicitly because the `sqlite3` CLI reports `foreign_keys=0` for its own connection, which is a trap for anyone spot-checking by hand.

Strengths:
- WAL + `busy_timeout=5000`, with the reasoning (boot backfills, the 15-minute sweep, and standalone scripts all open the same file) written down.
- `addColumnIfMissing()` makes migrations idempotent; the `applications` table rebuild for the `withdrawn` status is done correctly inside a transaction.
- The case-insensitive email and username dedupe migrations are unusually careful: they **rename, never merge or delete** (merging would collide with `PRIMARY KEY(slot_id, user_id)` and deleting would cascade away credited hours), pick survivors deterministically, notify the affected user, and write an audit row.
- `email_verified` backfill sets existing accounts verified the first time the column appears — otherwise enabling verification would lock out every existing user.
- Indexes were added after an actual query-plan audit, with `applications(user_id)` deliberately *not* duplicated because `UNIQUE(user_id, slot_id)` already covers it as a leftmost prefix. That is real understanding, not cargo cult.

### F-1 (P0) — `POST /api/auth/reset` destroys the database

The handler (`server/routes/accountRoutes.js:746`, inside `if (DEMO_MODE)`) drops 16 tables in order, then fails:

```
Reset database error: Error: no such table: main.events
    at accountRoutes.js:781   ← DROP TABLE IF EXISTS users
```

`conversations` declares foreign keys to **both** `events` and `users`. By the time `users` is dropped, `events` is already gone, so SQLite cannot resolve the cascade and throws. `initDatabase()` is never reached.

Database state after the call, measured:

```
SURVIVING: users(14), conversations(0), messages(0), certificates(1),
           admin_audit_logs, application_conflicts, conversation_participants,
           conversation_report_messages, conversation_reports, data_export_jobs,
           notification_jobs, notification_preferences, oauth_states, reports
DESTROYED: events, slots, applications, attendance, notifications, hours_ledger,
           attendance_checkin, auto_select_runs, event_announcements,
           user_favorites, event_comments, oauth_accounts, oauth_signup_sessions,
           email_verification_tokens, password_reset_tokens, email_change_tokens
```

Every request touching events, applications, attendance, or notifications now throws. Restarting recreates the empty tables but **will not re-seed**, because `users` is non-empty — so the demo comes back permanently empty.

Missing from the drop list: `conversations`, `conversation_participants`, `messages`, `conversation_reports`, `conversation_report_messages`, `notification_preferences`, `notification_jobs`, `admin_audit_logs`, `data_export_jobs`, `certificates`, `reports`, `application_conflicts`, `oauth_states`.

The client (`DemoBar.jsx:39`) calls this and, on failure, shows `Could not reset demo data: …` — so the operator is told a button didn't work, not that their database is gone.

**Why the tests missed it:** no test exercises `POST /api/auth/reset`. This is a textbook integration regression — messaging, certificates, and moderation each added tables correctly, and each left the reset list behind.

### F-5 (High) — `verifyHours.js` verifies the wrong database

```js
const dbPath = process.argv[2] || path.join(__dirname, 'wevolunteer.db');
```

It ignores `WEV_DB_PATH`. Proven:

```
$ WEV_DB_PATH=/tmp/definitely-not-this.db node verifyHours.js
Database: …/SBVolunteers App/server/wevolunteer.db
```

`npm run verify:hours` is `node --env-file-if-exists=../.env verifyHours.js`, and `.env` sets `WEV_DB_PATH=../pilot.db`. So the command loads the env file that names the real database, then verifies a **different, stale one** — and prints `PASS — ledger matches attendance`. The single tool whose job is to prove hours integrity gives false assurance by default. `server/wevolunteer.db` exists (548 KB, stale), which is what makes the failure silent instead of loud.

---

## Part 10 — Performance Findings

Measured: `GET /api/events` returned in **8 ms** at seed scale (14 users, 4 events, 10 slots, 15 applications). Too small to extrapolate from, so I read the query paths instead.

Genuine improvements, verified:
- **gzip is actually negotiated** (`content-encoding: gzip`), mounted before helmet and the routers so it can wrap `res.write`/`res.end`. The commit records a real measurement: 690,129 bytes → 12,769 bytes on a 503-event list.
- **N+1s were removed properly.** The three batch loads (slots, accepted counts, attendance presence) are scoped to `pageIds` — the page's ids — not the whole table. The comment notes they previously loaded the district's entire slot and attendance history to answer a 20-event page. Fixed correctly.
- Filtering, sorting, and distance are computed in SQL (`eventQuery.js`), not in JS after fetching everything.
- Pagination: `EVENTS_MAX_LIMIT = 500` clamp, `EVENTS_WARN_THRESHOLD = 400` server warning, stable `ORDER BY … , e.id ASC` tiebreak so `OFFSET` cannot skip or duplicate rows across pages. The SPA opts in at `PAGE_SIZE = 60`.

Concerns:
- **F-6 (High): 1,270 KB single JS chunk.** Code splitting exists in the git history and is gone from `HEAD`.
- **F-15b (Medium): `/api/events` is unpaginated by default.** Paging is opt-in; a caller that omits `limit` gets the entire table (with only a server-side `console.warn`). The current SPA opts in, so this is a latent trap for any other client — a stale cached bundle, a mobile wrapper, a script.
- `formatUserResponse()` runs a `SUM(hours_awarded)` subquery per call. Fine for one user; it is on `/api/auth/me` and every auth-adjacent response, so it must never be mapped over a list.

**Scaling estimate** (single-process Node + SQLite WAL, single district):

| Users | Assessment |
|---|---|
| 100 | Comfortable. |
| 500 | Comfortable. Bundle size is the felt cost, not the server. |
| 1,000 | Fine, if every list caller paginates. Notification table growth begins to matter (F-11). |
| 5,000 | The single writer becomes the ceiling. The 15-minute sweep scans applications × slots × events unbounded. Any unpaginated `/api/events` caller is now serving multi-MB responses. |
| 10,000 | Beyond this architecture. Needs Postgres, a job queue outside the request process, and Redis-backed rate limiting (the login throttle is an in-process `Map` and degrades to per-instance). |

For a single-district pilot — the actual target — the architecture is correctly sized. SQLite is the right call here, not a compromise.

---

## Part 11 — Regression Findings

| Feature | Problem it solved | Solved? | New problems | Verdict |
|---|---|---|---|---|
| Cookie auth (from localStorage JWT) | XSS token theft | **Yes** | Reintroduced CSRF, closed by `SameSite=Lax` + single origin, documented | **Keep** |
| CSP | XSS had no mitigation at all | **Yes** | Forced the theme script external — correctly done | **Keep** |
| Per-account login throttle | Distributed low-rate password guessing | **Yes** | In-process `Map`, per-instance at scale | **Keep** |
| Email verification gate ON by default | Unconfirmed accounts had full API access | **Yes** | Needed a careful allowlist; got one | **Keep** |
| Per-device logout | Logout killed every device | **Yes** | Cookie clear ≠ revocation (F-12) | **Keep, document honestly** |
| Design tokens + colour-literal test | Dark mode broken by literals | **Yes** | None | **Exceeded expectations** |
| Hours ledger | Silent hours loss | **Yes** | Verification tool reads the wrong DB (F-5) | **Keep, fix the tool** |
| `attendanceMap` contract | Client-supplied hours | **Yes** | None | **Exceeded expectations** |
| Realtime (Socket.IO) | No live updates | **Yes** — the `payload.userId` vs `payload.id` bug that refused *every* handshake is fixed and verified | 5-min revocation lag | **Keep** |
| Messaging | Coordination outside the app | **Yes**, and safely | Empty states unexplained; duplicate ReportModal | **Keep, polish** |
| Event pagination + SQL filtering | 690 KB list payloads | **Yes** | Opt-in, so unbounded by default | **Keep, make paging mandatory** |
| Compression | No encoding negotiated | **Yes** | None | **Keep** |
| **Code splitting** | 1.27 MB bundle | **NO — reverted** | Regression restored | **Re-apply (F-6)** |
| **Waitlist** | Managing over-subscribed shifts | **NO** | Inert on manual events; placeholder copy; no ordering | **Rework (F-2/F-3/F-4)** |
| **Demo reset** | Restoring demo state | **NO — destroys data** | Bricks the demo | **Fix (F-1)** |
| Notification consolidation | Two competing write paths | **Yes** | Left dead code + 11 unfired categories | **Keep, prune (F-9/F-10)** |

### F-6 (High) — Code splitting implemented, then silently reverted

`353a492` ("chore(v1.2): implement React Code Splitting") converted 15 views to `React.lazy`. `70cd700` — titled **`docs: auth audit Phase 1 findings and remediation plan`** — converted all 15 back to static imports.

```
$ git log -S "React.lazy(() => import('./views/Login'))" -- src/App.jsx
70cd700 docs: auth audit Phase 1 findings and remediation plan   ← removed
353a492 chore(v1.2): implement React Code Splitting …            ← added
```

`HEAD` has exactly one lazy boundary left (`MapPreview` → `LeafletMap`), which is why the build emits a single 1,270 KB chunk and warns. That same "docs" commit also rewrote 270 lines of `EventApplicantsTab.jsx` and touched 8 other components. **A documentation commit silently reverted a performance feature and shipped substantial code changes.** The process failure is more concerning than the bundle: nothing in the pipeline noticed a 15-file feature disappear.

### F-2 (P0/High) — Waitlist promotion never fires on manually-managed events

All three promotion sites gate on Auto Select:

```js
const event = db.prepare('SELECT auto_approve FROM events WHERE id = ?').get(app.event_id);
if (event && event.auto_approve === 1) {
  handleWaitlistPromotion(app.slot_id, app.event_id, app.event_title, app.organizer_id);
}
```

Live result on a normal event after a confirmed volunteer released their spot (`released: true`):

```
slot now: max=1  accepted=0  waitlisted=1
```

**A shift sits empty with a volunteer waiting on it, and neither the volunteer nor the organizer is told a spot opened.** The organizer does receive `VOLUNTEER_RELEASED_SPOT`, so this is recoverable by a diligent organizer — but the waitlist, as a feature, does nothing for the majority of events. `handleWaitlistPromotion` also runs its multi-statement promotion **outside a transaction**, so a mid-sequence failure leaves ranks inconsistent.

### F-4 (Medium) — `waitlist_order` is never assigned

Every write sets it to `NULL` (`applicationRoutes.js:195`, `:383`) and the waitlisting branch never assigns one. So `handleWaitlistPromotion`'s `ORDER BY a.waitlist_order ASC LIMIT 1` has no defined order, promotion is effectively arbitrary rather than FIFO, and no honest "you are 3rd on the waitlist" can be shown. Confirmed live: `waitlist_order → NULL`.

---

## Part 12 — Product Experience Findings

**Student.** Would trust it; the service record, milestones, and printable certificate are the emotional payoff and they work. Would be confused by *"Notification / You have a new notification."* — and if they are waitlisted, that is the only thing they are told. Would be quietly failed by the waitlist: they wait, a spot opens, nothing happens. Would be delighted by the conflict warning that names the clashing shift.

**Organizer.** The strongest role. Sign-up sheet building, applicant review with volunteer history inline, bulk accept/waitlist/decline with per-slot capacity enforced across the batch, roster CSV, announcements, event duplication, Auto Select with a documented weighting curve. Would be frustrated that waitlists don't self-manage and that "1 spot, 0 accepted, 1 waitlisted" can persist silently.

**Administrator.** Adequate but thin: stats, pending-organizer approvals, moderation queue, `smtpConfigured` status. `admin_audit_logs` had **0 rows** after a full exercise of the system — the audit trail exists structurally but records almost nothing. For a district signing off on student records, that is the gap they will ask about first.

**Parent.** Would trust the certificate — a `WEV-XXXX-XXXX` code verifiable at a public URL without an account is exactly right, and it worked (`{valid:true, volunteerName, eventTitle, organizerName, hours, completedAt}`), while a fabricated code was rejected. Would want a parent view; none exists.

**District employee / principal.** Would ask: where are the records kept, who can see a child's data, what happens when a student leaves? The answers are good (server-side attendee visibility, opt-in leaderboard, no email exposure in profiles, data export, account deletion) but are documented for engineers, not administrators. The hours-integrity story is genuinely excellent **and its verification tool reads the wrong file** (F-5) — that is the one I would be most uncomfortable defending in a meeting.

**Volunteer coordinator.** Wants the whole-calendar subscription feed that doesn't exist (per-slot ICS only) and self-managing waitlists that don't work.

**First-time user.** Welcome → signup → verify is clear, and the password error message tells you exactly what is missing. The `{users: []}` empty recipient list in Messages says nothing about *why* it is empty ("you can message an organizer once you've applied to their event"), which reads as broken rather than as a rule.

---

## Top Issues, Ranked by Severity

I found 18 substantive issues. I am not padding to 25 — the remainder would be noise, and inflating the list would obscure the three that matter.

| # | Sev | ID | Issue | Evidence |
|---|---|---|---|---|
| 1 | **P0** | F-1 | `POST /api/auth/reset` destroys the database instead of resetting it; 13 tables missing from the drop list; no test coverage | Live 500 + measured table loss |
| 2 | **P0** | F-2 | Waitlist promotion never fires on manually-managed events; shift left empty with someone waiting, nobody notified | Live: max=1, accepted=0, waitlisted=1 |
| 3 | **P1** | F-3 | `APPLICATION_WAITLISTED` unmapped → placeholder copy, wrong category, no link, deleted by retention | Live: `SYSTEM :: NORMAL :: Notification :: …` |
| 4 | **P1** | F-5 | `verifyHours.js` ignores `WEV_DB_PATH`; the hours-integrity tool verifies a stale DB and prints PASS | Proven with an explicit override |
| 5 | **P1** | F-6 | Code splitting reverted by a `docs:` commit; 1,270 KB single chunk | `git log -S`, build output |
| 6 | **P2** | F-4 | `waitlist_order` never assigned; promotion order undefined, position unshowable | Live: NULL |
| 7 | **P2** | F-8 | Two hand-rolled `ReportModal`s: no Escape, focus trap, or `aria-modal`; violates the project's own invariant; it's the safety-reporting surface | 0 matches for all four affordances |
| 8 | **P2** | F-9 | 11 declared notification categories never dispatched; `REMOVED_FROM_EVENT` has copy that never renders | Static cross-reference |
| 9 | **P2** | F-12 | Logout clears the cookie but does not revoke the JWT (7-day validity) | Live: cookie valid post-logout |
| 10 | **P2** | F-15b | `/api/events` unpaginated by default; paging opt-in | Live: bare array |
| 11 | **P2** | — | `admin_audit_logs` empty after full system exercise; audit trail records almost nothing | 0 rows |
| 12 | **P2** | F-13 | Login is an account-enumeration oracle (deliberate, documented) on a platform for minors | Live responses |
| 13 | **P3** | F-11 | CRITICAL/IMPORTANT notifications never expire; unbounded growth | Retention query |
| 14 | **P3** | F-7 | Oversized body → 500 instead of 413 | Live: 500 |
| 15 | **P3** | F-15 | Inconsistent API response shapes (flat vs `{event}` vs bare array) | Hit 3× writing journeys |
| 16 | **P3** | F-14 | Duplicate `ReportModal` (65 vs 71 lines), both live | File comparison |
| 17 | **P3** | F-10 | Dead code: `createNotification()`, `NOTIFICATION_KINDS`, `realtimeAvailable()`; project memory still documents the retired system as live | 0 call sites |
| 18 | **P3** | F-16/17 | Socket revocation lag ≤5 min; typing rate limit per-socket, so N tabs = N× allowance | Code review |
| — | Ops | — | Live Gmail + Google OAuth secrets in working-tree `.env` (correctly gitignored, **not** in any git object — verified) | Full object scan |
| — | Ops | — | No whole-calendar ICS subscription feed; per-slot only | Route table |

---

## Top Improvements Since the Original Repo

1. **`attendanceMap` as `{applicationId: boolean}`** — hours derived from slot duration, never client-supplied. Structurally forecloses hour inflation.
2. **Append-only hours ledger** with a parity invariant that held under test.
3. **Cookie sessions replacing localStorage JWTs**, with the CSRF consequence closed and documented.
4. **CSP with no `unsafe-inline`**, and the theme script externalised to earn it.
5. **Per-account login throttle keyed on the resolved account**, with the lock checked before every account-describing branch.
6. **Config extraction with no side effects** — the decision that made 515 tests possible.
7. **13-router split** from a monolith.
8. **Colour-literal build failure** — 0 hardcoded colours in JSX, 277 tokens.
9. **Case-insensitive email + username uniqueness** with rename-never-merge dedupe migrations that notify and audit.
10. **Email verification ON by default** with a minimal allowlist that keeps a mistyped address escapable.
11. **Messaging permission model structurally forbidding student↔student contact.**
12. **RFC 5545-valid ICS**, including 75-octet folding.
13. **Realtime handshake bug fixed** (`payload.id` vs `payload.userId`) — it had been rejecting *every* socket connection silently.
14. **Schedule conflict detection** with severity levels, explicit override, and a logged `application_conflicts` row.
15. **N+1 elimination scoped to `pageIds`**, not the whole table.
16. **gzip negotiated**, measured at 54× on a real payload.
17. **Boot-time guards that fail closed**: weak secret, mock OAuth, and `DEMO_MODE` in production all refuse to boot.
18. **Mock OAuth transport made opt-in** — it used to enable itself when a client ID was missing, i.e. login-as-anyone on the most likely deployment mistake.
19. **Working `sign-out-others`** (was a success toast over an empty handler).
20. **Per-device logout** (was global).
21. **Index set derived from an actual query-plan audit**, with a redundant index deliberately omitted.
22. **Indexed notification dedupe** — verified idempotent across three sweeps.
23. **Public certificate verification** with rate limiting worded to never read as a verdict on the certificate.
24. **Mobile bottom nav + 13 safe-area insets + iOS zoom fixes.**
25. **Secrets purged from git history** — verified against every object, reachable and unreachable.

---

## Features That Exceeded Expectations

- **The `attendanceMap` contract.** Most implementations accept `hoursAwarded` from the client. This one cannot be abused because the shape makes abuse unrepresentable.
- **The dedupe migrations.** Renaming rather than merging, with survivor selection by credited hours, a notification to the affected user, and an audit row — with the reasoning for *why* merging is unsafe written into the code.
- **The comment discipline generally.** Comments explain *why*, cite the failure they prevent, and often the measurement. `app.js`'s CORS reasoning and `config.js`'s cookie/CSRF note are better than most production codebases.
- **ICS line folding.** Almost universally skipped; done correctly here.
- **The design-token guard as a test.** Enforcement, not aspiration.

## Features That Should Be Reworked

- **The waitlist, end to end** (F-2/F-3/F-4). Promotion, ordering, and copy are each individually broken.
- **The demo reset** (F-1). Rewrite as `DROP` derived from `sqlite_master` (or delete the file and re-init) so it cannot drift from the schema again.
- **`ReportModal`** (F-8/F-14). Collapse the two copies into one built on `Modal.jsx`.
- **Notification category table** (F-9). Delete the 11 unfired entries or implement them; a declared-and-never-sent category is a promise the product doesn't keep.
- **Admin audit logging.** Structurally present, effectively empty.

---

## Recommended V1.1 Priorities (ship-blocking)

1. **F-1** — Fix `POST /api/auth/reset`; derive the drop list from `sqlite_master` and add a regression test that resets, then asserts the seed set is back.
2. **F-2** — Remove the `auto_approve` gate on promotion (or make it an explicit, labelled event setting), wrap `handleWaitlistPromotion` in `inTransaction`, and test the release→promote path.
3. **F-3** — Add `APPLICATION_WAITLISTED` to `EVENT_CATEGORIES` (`APPLICATION`) and to `getInAppContent` with real copy, `IMPORTANT` priority, an `event:` link, and the `waitlistRank` Auto Select already computes. Add a test asserting no dispatched event falls through to `default:`.
4. **F-5** — Make `verifyHours.js` read `WEV_DB_PATH` (keeping `argv[2]` as an override) and print the resolved path.
5. **F-6** — Re-apply `React.lazy` to the 15 views; add a build assertion that the entry chunk stays under ~600 kB so it cannot silently regress again.
6. **F-4** — Assign `waitlist_order` on every transition into `waitlisted`.
7. **F-7** — Map `entity.too.large` → 413.

## Recommended V2 Priorities

1. Session revocation via a `jti` denylist or short access tokens — make "Sign out" mean it (F-12).
2. Whole-calendar ICS subscription feed with `REFRESH-INTERVAL`.
3. Make pagination mandatory on `/api/events`; remove the unbounded branch (F-15b).
4. Real admin audit logging on every privileged mutation.
5. Notification retention for CRITICAL/IMPORTANT (archive rather than delete) (F-11).
6. Normalise API response envelopes (F-15).
7. Split `index.css` (5,013 lines) by surface.
8. Postgres + external job queue + Redis rate limiting if scope grows past one district.
9. A parent/guardian read-only view.
10. Revisit the enumeration trade-off with the district as an explicit, recorded decision (F-13).

---

## Production Readiness Assessment

| Dimension | Grade | Basis |
|---|---|---|
| Authentication | **A** | 23/23 live; throttle, gating, per-device logout all real |
| Authorization | **A** | Every escalation and IDOR attempt refused |
| Data integrity | **A−** | Clean integrity, ledger parity, FKs on; verification tool reads wrong DB |
| Security posture | **A−** | Headers, CSP, fail-closed guards, secrets clean; enumeration by choice |
| Notifications | **C+** | Delivery/dedupe/realtime solid; one core event unmapped, 11 unfired |
| Core product loop | **C** | Apply→accept→attend→hours→certificate excellent; waitlist broken |
| Calendar | **B** | Valid ICS, real conflict detection; no subscription feed |
| Messaging | **B+** | Permission model exemplary; empty states unexplained |
| Mobile | **B−** | Bottom nav, safe areas, touch targets; 1.27 MB bundle |
| Design system | **A−** | 277 tokens, enforced; two rogue modals |
| Performance | **B** | Real N+1/compression/SQL wins; bundle regression, opt-in paging |
| Testing | **B−** | 515 tests, genuinely good; blind to reset, waitlist, notification copy |
| Ops readiness | **B−** | Runbook, health check, guards; broken verify tool, empty audit log |

**Overall: B− — not production-ready today; approximately one focused week away.**

The honest summary: **the hard parts are done well and the easy parts are unfinished.** Nobody who could design the `attendanceMap` contract, the dedupe migrations, or the CSP/theme-script chain would struggle with any of the seven V1.1 items. What failed here was not capability — it was verification. A suite of 515 passing tests was treated as evidence that the product works, when it was only evidence that the covered paths work. The three worst findings all live in the gaps *between* well-built components, and every one of them would have been caught by a single manual pass through the organizer's waitlist flow or one press of the demo reset button.

Fix the seven, add tests that walk the loop rather than the units, and this is a genuinely professional platform.
