# SBVolunteers Production Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. Each task is one reviewable commit with its own test cycle; do not proceed past a failed verification.

**Goal:** Close the remaining P1/P2 findings from the launch-readiness audit so SBVolunteers is safe for a public release beyond the pilot — enforced identity, no minor-data leaks, revocable sessions, validated workflows, unforgeable certificates.

**Architecture:** Three phases in strict priority order. Phase 1 (security & privacy) rests on one keystone change — making `authenticateToken` read the user row from the database instead of trusting the JWT payload — after which email enforcement, deleted-user rejection, live roles, and session revocation are all small additions. Phase 2 hardens the event/application/selection/certificate workflows. Phase 3 clears reliability debt. Nothing is a rewrite; every task is an additive change to an existing file following patterns already in the codebase.

**Tech Stack:** Express 4, `node:sqlite` (`DatabaseSync`), JWT (`jsonwebtoken`), bcryptjs, nodemailer, React 19 + Vite, Vitest 4.

## Global Constraints

- **Do not change the hours pipeline.** `server/attendance.js` and `server/hoursLedger.js` are audited-correct with the largest test coverage. No task here modifies them.
- **Hours are always derived** from `attendance` rows where `present = 1`. Never store a total on `users`.
- **`node:sqlite`'s `DatabaseSync` has NO `.transaction()` method** — use `inTransaction(fn)` from `server/utils.js` for multi-statement writes.
- **Never import from `../app.js` into a router** — `app.js` imports the routers before defining its exports, so it is a boot-fatal circular import. Rate limits are mounted by path in `app.js`.
- **Migrations follow the existing patterns in `db.js`:** `addColumnIfMissing(table, col, def)` for new columns; the `applications_new` table-rebuild pattern for constraint changes. Every migration must be idempotent and safe to run against an existing populated database on every boot.
- **Do not lock out the pilot.** When `REQUIRE_EMAIL_VERIFICATION` is unset/false, behaviour must be identical to today. Test both flag states.
- **Preserve existing working behaviour.** Every task starts from a green suite (143 tests at plan start) and must leave it green.
- **Terminology:** applications *open* and *close*; volunteers *apply*; organizers *accept / waitlist / reject*; students *withdraw*. Never "sign up" for the act of applying.
- **Design system "Field Notes":** paper `#F7F7F5`, service green `#0F6B45` for actions, amber `#B45309` reserved exclusively for hours/credit. No new colors.
- **Small reviewable commits.** One task = one commit. Scoped `git add` naming only changed files (never `git add -A`).
- **Every fix ships with a test that fails without it.** After implementing, revert the production change and confirm the new test fails (deliberate-break), then restore.

## Test harness (unchanged, reused by every server task)

`server/testServer.js` exports `startTestServer()` → `{ base, call, login, close }`, where `call(method, path, body?, token?) → { status, body }` and `login(email, password='password123') → JWT`. The harness sets `DEMO_MODE=true`, so seeded fixtures exist. **Exactly one `startTestServer()` per test file**, in a single file-level `beforeAll`, because `db.js` is module-cached. A test file that needs a config flag (e.g. `REQUIRE_EMAIL_VERIFICATION`) sets `process.env` **before** the dynamic `await import('./testServer.js')` inside `beforeAll` — see `server/routes.verification.test.js` for the pattern.

Seeded accounts (password `password123`): students `leo.chen28@gmail.com`, `priya.patel.nhs@outlook.com`, `emiller2027@gmail.com`, `colin.carbin29@outlook.com`; organizers `jkatzenback@vikings.org` (approved, hosts seeded events), `rmiller@sbpl.info` (pending); admin `admin@sbvolunteers.gov`.

---

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `server/utils.js` | `authenticateToken` (keystone: DB-backed), `certificateCode` removal | 1, 2, 3, 11 |
| `server/db.js` | new columns (`token_version`, `certificate_code`), case-insensitive email index, dedupe migration | 2, 8, 11 |
| `server/routes/authRoutes.js` | JWT claims, signup email normalisation, reset bumps token_version, profile field scoping | 2, 5, 8 |
| `server/config.js` | already holds `REQUIRE_EMAIL_VERIFICATION`; add `AUTH_VERIFY_ALLOWLIST` constant if needed | 3 |
| `server/routes/contentRoutes.js` | leaderboard opt-in, announcements gating | 6, 7 |
| `server/routes/eventRoutes.js` | `GET /api/events` auth + instructions scoping, event validation, Auto Select deadline/redraw | 7, 9, 10 |
| `server/validation.js` (new) | shared event/slot validation | 9 |
| `server/routes/attendanceRoutes.js` | certificate issue + verify (stored code, reduced disclosure) | 11 |
| `server/app.js` | `/health` + error-handler ordering, certificate-verify rate limiter | 11, 12 |
| `server/server.js` | apply SQLite pragmas at boot | 14 |
| `src/index.css` | define `--brand-shade` | 13 |
| `vitest.config.js` (new) | pin `isolate: true` | 14 |
| New test files per task | `routes.session.test.js`, `routes.privacy.test.js`, `routes.emailUniqueness.test.js`, `validation.test.js`, `routes.autoselect.test.js`, `routes.certificates.test.js`, `app.ordering.test.js` | various |

---

# Phase 1 — Security & Privacy Blockers

## Task 1 — DB-backed authentication (keystone)

**Purpose.** Make `authenticateToken` load the caller's row from the database on every request instead of trusting the decoded JWT payload, so that identity, role, and account existence are always current.

**Why it matters.** Today `req.user` is whatever was signed into the token up to 7 days ago. A deleted user's token still authenticates; a demoted admin keeps admin for a week; there is nowhere to enforce email verification or revoke a session. Every subsequent Phase-1 security task depends on this DB read existing.

**Files expected to change.**
- Modify: `server/utils.js` — `authenticateToken`.
- Test: `server/routes.session.test.js` (new).

**Dependencies.** None. This is the foundation for Tasks 2 and 3.

**Implementation approach.**
- `authenticateToken` keeps verifying the JWT signature (rejects forged/expired tokens as now). After a successful `jwt.verify`, look up `SELECT id, role, email, name, email_verified, token_version FROM users WHERE id = ?` using the token's `id`.
- If no row → `401 { error: 'Account no longer exists' }` (deleted user).
- Set `req.user` from the **database row** (live `role`, live `email`, live `email_verified`), keeping `req.user.id`. This makes role changes and email changes take effect on the next request.
- Do **not** add the email-verification gate or token-version check here yet — those arrive in Tasks 2 and 3 so each is independently reviewable. This task only swaps the source of truth from token to DB and rejects deleted users.
- Performance: this adds one primary-key lookup per authenticated request. On in-process SQLite that is sub-millisecond; acceptable and not worth caching for pilot/early-public scale. Note it in the report.

**Tests required (`routes.session.test.js`).**
1. A valid token for an existing user still authenticates and `/api/auth/me` returns them.
2. After deleting a user's row directly in the DB, their previously-valid token returns 401 on `/api/auth/me`.
3. After changing a user's `role` directly in the DB, a fresh call reflects the new role (e.g. a token minted as `student`, DB row flipped to `organizer`, then an organizer-only endpoint succeeds — proving role is read live, not from the token).
4. A forged/garbage token still returns 403 (signature check unchanged).

**Security considerations.** This is a strict tightening — no path becomes more permissive. Verify no endpoint relied on a token field absent from the DB row (only `id/role/email/name` are used from `req.user` across the codebase; confirm with `grep -rn "req.user\." server/`).

**Migration considerations.** None (no schema change). Existing tokens keep working; they simply get re-validated against the DB.

---

## Task 2 — Token versioning and session revocation

**Purpose.** Add a `token_version` integer to each user, embed it in the JWT, verify it in `authenticateToken`, and bump it on password reset — so a reset (or an explicit revoke) invalidates every existing session for that user.

**Why it matters.** F-9: a stolen token currently survives a password reset for up to 7 days. Session revocation is the standard mitigation and the hook the platform will need for account-takeover response.

**Files expected to change.**
- Modify: `server/db.js` — `addColumnIfMissing('users', 'token_version', 'INTEGER NOT NULL DEFAULT 0')`.
- Modify: `server/utils.js` — `authenticateToken` compares `decoded.tokenVersion` (default 0 for legacy tokens) against the DB row's `token_version`.
- Modify: `server/routes/authRoutes.js` — both `jwt.sign` calls include `tokenVersion: user.token_version ?? 0`; `reset-password` increments `token_version` inside its existing `inTransaction`.
- Test: extend `server/routes.session.test.js`.

**Dependencies.** Task 1 (the DB read in `authenticateToken`).

**Implementation approach.**
- Migration adds the column with default 0. Existing rows get 0.
- `formatUserResponse` and the login/signup handlers already load the full row; include `token_version` when signing (`SELECT` in login already does `SELECT *`).
- In `authenticateToken`: after loading the row, if `(decoded.tokenVersion ?? 0) !== row.token_version` → `401 { error: 'Session expired, please sign in again' }`. Legacy tokens (no claim) compare 0-vs-0 and keep working until they expire.
- In `reset-password`: `UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?` — the password change and the bump are one statement, already inside the existing transaction.

**Tests required.**
1. A token minted before a password reset returns 401 after the reset; a fresh login after the reset works.
2. A token minted with the current version keeps working across unrelated requests.
3. A legacy token with no `tokenVersion` claim (sign one manually with the test `JWT_SECRET`, omitting the claim) still authenticates against a version-0 row.

**Security considerations.** The 401 vs 403 distinction matters: 401 tells the client to drop the token and re-auth (the existing `apiFetch` clears storage on 401), 403 does not. Use 401 for version mismatch. Do not leak whether the mismatch was due to reset vs revoke.

**Migration considerations.** Idempotent column add. On an existing DB, all users start at version 0 and all live tokens keep working until their next reset — no forced logout on deploy.

---

## Task 3 — Enforce email verification server-side (F-4)

**Purpose.** When `REQUIRE_EMAIL_VERIFICATION` is true, actually block unverified accounts from using the API — not just from the client UI.

**Why it matters.** F-4: today the flag gates only the React shell. An unverified account can drive the whole API directly, so the flag provides no real identity assurance. Hours attach to unverified identities.

**Files expected to change.**
- Modify: `server/utils.js` — add the gate to `authenticateToken` (or a dedicated middleware; see approach).
- Modify: `server/config.js` — export `EMAIL_GATE_ALLOWLIST` (the paths an unverified user may still reach).
- Test: extend `server/routes.verification.test.js` (which already runs flag-ON).

**Dependencies.** Task 1 (live `email_verified` in `req.user`).

**Implementation approach.**
- Enforce inside `authenticateToken`, immediately after the token-version check, so every authenticated route is covered with one change and there is no risk of forgetting to attach a per-route guard.
- Gate condition: `REQUIRE_EMAIL_VERIFICATION === true && row.email_verified !== 1 && !allowed(req)`. When the flag is false, skip entirely — **pilot behaviour is byte-identical to today**.
- Allowlist: the unverified user must still be able to see their own state and complete verification, so `allowed(req)` is true for `GET /api/auth/me`, `POST /api/auth/verify-email`, `POST /api/auth/resend-verification`, and `PATCH /api/notifications`/`GET /api/notifications` (so the shell's bell doesn't error the user into a corner). Match on `req.path` (absolute, since routes are mounted at `/api/...`). Define the allowlist as an exported constant in `config.js` so it is reviewable in one place.
- Blocked response: `403 { error: 'Please verify your email address to continue.', code: 'email_unverified' }`.
- Note: the unauthenticated endpoints (login, signup, forgot/reset-password, public certificate verify) never reach `authenticateToken`, so they are unaffected.

**Tests required (in `routes.verification.test.js`, flag ON).**
1. An unverified user gets 403 (`code: 'email_unverified'`) on a normal action route (e.g. `GET /api/applications`).
2. The same unverified user still gets 200 on `GET /api/auth/me` and can call `resend-verification`.
3. After verifying (via the existing verify-email flow), the same user gets 200 on `GET /api/applications`.
4. In a **flag-OFF** file (`routes.auth.test.js` already runs flag-OFF), an unverified user is not blocked — assert an action route returns non-403 for a user whose `email_verified` is 0. This is the anti-lockout guard for the pilot.

**Security considerations.** The allowlist is the only bypass; keep it minimal and data-free (no action routes, no other users' data). Confirm `req.path` cannot be spoofed past the mount (it is derived by Express, not client-controlled).

**Migration considerations.** None. Relies on Task P1-A's existing backfill (`email_verified = 1` for pre-feature users) so enabling the flag never locks out historical accounts.

---

## Task 4 — Scope student profile fields to legitimate viewers (privacy)

**Purpose.** Restrict `grade`, `school`, and `bio` on `GET /api/users/:id/profile` to the student themselves and to organizers who host an event that student has applied to — not to every signed-in user.

**Why it matters.** P0-1 closed the *whereabouts* leak (`upcoming`), but `isStaff` is still "any organizer or admin", so any self-registered organizer — or, for grade/school/bio, any signed-in student — can read a minor's grade, school, and bio. This is the residual half of the same finding.

**Files expected to change.**
- Modify: `server/routes/authRoutes.js` — `GET /api/users/:id/profile`: replace the blanket `isStaff` with a relationship check.
- Test: `server/routes.privacy.test.js` (new).

**Dependencies.** None (independent of Tasks 1–3, but keep after them so the suite context is settled).

**Implementation approach.**
- Compute `hostsApplicant`: `SELECT 1 FROM applications a JOIN events e ON a.event_id = e.id WHERE a.user_id = :profileId AND e.organizer_id = :viewerId LIMIT 1`. True only when the viewer is an organizer who hosts an event this student applied to.
- `canSeeContact = isSelf || req.user.role === 'admin' || (req.user.role === 'organizer' && hostsApplicant)`.
- Gate `email`, `grade`, `school`, `bio` on `canSeeContact`. `name`, `avatar`, aggregate `stats.hours`/`eventsCompleted`, `milestones`, and `byCategory` stay visible (they carry no direct-contact or whereabouts risk and organizers rely on service history to judge applicants). `upcoming` stays self-only (unchanged from P0-1). `upcomingCount` → `isSelf || canSeeContact ? … : 0`.
- Admins retain full visibility (moderation need).

**Tests required (`routes.privacy.test.js`).**
1. A student viewing another student's profile gets `grade/school/bio/email` all null/absent.
2. An organizer who does **not** host any event the student applied to gets them null.
3. An organizer who **does** host such an event gets them populated (seed: have the student apply to that organizer's event first).
4. An admin gets them populated.
5. Self gets them populated.

**Security considerations.** The relationship query must key on the *viewer's* `req.user.id` (server-trusted, from Task 1's DB read) — never a client-supplied id. Enumerable user ids make the blanket exposure a bulk-harvest; this closes it.

**Migration considerations.** None.

---

## Task 5 — Leaderboard opt-in and reduced disclosure (privacy)

**Purpose.** Return only students who set `leaderboard_opt_in = 1`, and drop `school` and `grade` from the payload.

**Why it matters.** F: the leaderboard publishes every student's name, school, grade, and hours to any authenticated caller, ignoring the `leaderboard_opt_in` column that already exists for exactly this. It is a directory of minors.

**Files expected to change.**
- Modify: `server/routes/contentRoutes.js` — `GET /api/leaderboard`.
- Test: extend `server/routes.privacy.test.js`.

**Dependencies.** None.

**Implementation approach.**
- Add `WHERE u.role = 'student' AND u.leaderboard_opt_in = 1` to the query.
- Remove `school` and `grade` from both the `SELECT` and the mapped response. Keep `rank, id, name, avatar, hours, shifts`.
- The client `Leaderboard` view must tolerate the smaller shape — confirm it does not hard-read `.school`/`.grade` (grep the client); if it renders them, remove those cells. Keep this client edit minimal and in the same commit.

**Tests required.**
1. A seeded student with `leaderboard_opt_in = 0` (the default) does **not** appear in the leaderboard.
2. After setting a student's `leaderboard_opt_in = 1` directly, they appear.
3. No leaderboard row contains a `school` or `grade` field.

**Security considerations.** Default-off is the safe default and matches the column default. No new exposure.

**Migration considerations.** None — column exists. Note in the report that the leaderboard will look empty until students opt in, which is the intended privacy posture.

---

## Task 6 — Require auth on event listing and scope instructions/announcements (privacy)

**Purpose.** Require authentication on `GET /api/events`; strip the `instructions` field for users who are not accepted on the event; gate `GET /api/events/:id/announcements` to accepted volunteers plus event staff.

**Why it matters.** F: `GET /api/events` is unauthenticated and returns `instructions` (arrival details) to the open internet; announcements (the "confirmed volunteers only" channel — meeting points, gate codes) are readable by any signed-in user for any event.

**Files expected to change.**
- Modify: `server/routes/eventRoutes.js` — add `authenticateToken` to `GET /api/events`; compute per-event acceptance and blank `instructions` when not accepted/staff.
- Modify: `server/routes/contentRoutes.js` — `GET /api/events/:id/announcements`: apply the same accepted-or-staff gate already used by `GET /api/events/:id/attendees`.
- Test: extend `server/routes.privacy.test.js`.

**Dependencies.** None. (Independent of the auth keystone, but adding `authenticateToken` means `req.user` is now the live DB row from Task 1.)

**Implementation approach.**
- `GET /api/events`: add `authenticateToken`. Batch-load the caller's accepted event ids once (`SELECT DISTINCT event_id FROM applications WHERE user_id = ? AND status = 'accepted'`). For each event, include `instructions` only if the caller is an accepted volunteer OR the hosting organizer OR an admin; otherwise emit `instructions: ''`. Everything else in the payload is unchanged.
- **Client check:** the client currently fetches `/api/events` on load. It already sends the token (`apiFetch` attaches it). Confirm no unauthenticated pre-login call to `/api/events` exists (grep the client); the public certificate-verification route is separate and stays unauthenticated. If any pre-login fetch exists, note it — but the app gates all event views behind login, so this should be a no-op for the UI.
- Announcements gate: copy the visibility check from `GET /api/events/:id/attendees` (`contentRoutes.js`) — staff always; a student only if accepted on the event. Return `{ visible: false, announcements: [] }` shape consistent with attendees for the non-visible case, and have the client treat that as "no announcements".

**Tests required.**
1. `GET /api/events` with no token → 401.
2. A signed-in student who is not accepted on an event gets that event with `instructions === ''`.
3. An accepted student gets the real `instructions`; the hosting organizer and an admin do too.
4. A student not accepted on an event gets `visible: false` / empty from that event's announcements; an accepted student and staff get the real list.

**Security considerations.** This is the reason attendee visibility was built server-side; announcements must match it. Ensure the instructions-blanking happens server-side (never rely on the client to hide it).

**Migration considerations.** None. Behaviour change is visible to users (some previously-public detail disappears for non-participants) — intended.

---

## Task 7 — Case-insensitive email uniqueness, normalisation, and dedupe (account security)

**Purpose.** Store and compare emails case-insensitively so one person cannot hold two accounts (`leo@x` and `Leo@x`), and reconcile any existing duplicates.

**Why it matters.** F-11: signup uniqueness is case-sensitive while password reset is `COLLATE NOCASE`; two accounts for one person split their service hours and make reset ambiguous.

**Files expected to change.**
- Modify: `server/routes/authRoutes.js` — signup lowercases/trims `email` before the uniqueness check and insert; login lowercases before lookup.
- Modify: `server/db.js` — add a case-insensitive unique index `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_nocase ON users(email COLLATE NOCASE)`; add a one-time dedupe/normalisation migration guarded so it runs only when needed.
- Test: `server/routes.emailUniqueness.test.js` (new).

**Dependencies.** None. Interacts with Task 2 only in that a normalised login must still mint a versioned token — no code overlap.

**Implementation approach.**
- Normalise on write: `const normEmail = String(email).trim().toLowerCase()` in signup; insert `normEmail`. Login: look up by `email = ? COLLATE NOCASE` (or normalise then compare) so existing mixed-case rows still authenticate during the transition.
- Uniqueness check in signup uses `COLLATE NOCASE` (already partially there for username; mirror it for email) so `Leo@x` is rejected when `leo@x` exists.
- Migration: adding the unique index will **fail** if duplicates already exist. So the migration must, before creating the index: detect case-insensitive duplicate groups; for each group keep the **oldest** account (min `created_at`) and — because merging attendance across accounts is out of scope and risky — rename the losers' emails to a reserved non-colliding form (e.g. append `+dup-<rowid>` before the `@`) and set their `token_version` +1 so their sessions drop, rather than deleting them (deleting would cascade a student's attendance). Log every rename. Only then create the index. This is conservative: no data is destroyed, the index becomes creatable, and an admin can manually merge flagged accounts later. Document this clearly.
- Reset ambiguity: with the index in place, `forgot-password`'s `COLLATE NOCASE` lookup matches at most one row — the ambiguity disappears.

**Tests required.**
1. Signing up `alex@x.com`, then `ALEX@x.com`, is refused with a 400 naming email.
2. A user who registered `leo.chen28@gmail.com` can log in with `LEO.CHEN28@GMAIL.COM`.
3. The dedupe migration, run against a DB seeded with two case-variant emails, keeps the older account's email unchanged, renames the newer to the `+dup-` form, and then the unique index exists (assert via `PRAGMA index_list`).
4. `forgot-password` with a case-variant address issues a token for the single surviving account.

**Security considerations.** Never delete a user in the dedupe path (cascade would destroy attendance). Renaming + token bump is reversible and non-destructive. The `+dup-` email must be syntactically invalid-for-login-intent but valid-for-storage; ensure it cannot itself collide.

**Migration considerations.** The dedupe step is the riskiest migration in the plan. It must be idempotent (re-running after index creation is a no-op because no duplicates remain and `CREATE ... IF NOT EXISTS`), wrapped in a transaction, and must log what it changed. Recommend the operator take a DB backup before the deploy that includes this task (add to the README runbook).

---

# Phase 2 — Core Workflow Correctness

## Task 8 — Server-side event and slot validation

**Purpose.** Reject invalid event/slot payloads at the API: deadlines in the past or after the first shift, slot end before start, capacities outside `1..100`, and over-long strings — on both create and update.

**Why it matters.** F: every temporal/numeric guard is client-side and bypassable. The server accepts a deadline in 2020, an end before its start (which produces junk hours), and `maxSpots = -5`. Verified live.

**Files expected to change.**
- Create: `server/validation.js` — `validateEventPayload({ title, description, location, instructions, applicationDeadline, slots })` returning `{ ok: true }` or `{ ok: false, error }`.
- Modify: `server/routes/eventRoutes.js` — call it in `POST /api/events` and `PUT /api/events/:id` before writing.
- Test: `server/validation.test.js` (new, pure-function unit tests) + a couple of route-level tests in an existing events test.

**Dependencies.** None.

**Implementation approach.**
- Pure module, no DB, fully unit-testable in isolation (no server needed).
- Rules: `applicationDeadline` parses to a valid future date and is `<=` the earliest slot `startDatetime`; each slot's `endDatetime > startDatetime`; `1 <= maxSpots <= 100` and integer; length caps (title ≤ 200, description ≤ 5000, location ≤ 300, instructions ≤ 5000, slot name ≤ 120, slot description ≤ 1000). Return the first failing rule's message.
- Wire into both routes right after the existing category check; return `400 { error }` on failure. Keep the existing presence checks.
- The DB `slots.max_spots` has no CHECK today; the validation layer is the enforcement point (adding a CHECK constraint would require a table rebuild — out of scope; note it as a future DB-level defence).

**Tests required (`validation.test.js`, pure).** Past deadline; deadline after first shift; slot end before start; `maxSpots` 0, negative, 101, non-integer; over-long title; a fully valid payload passes. Plus two route tests: `POST /api/events` with an inverted-time slot → 400; a valid create → 201.

**Security considerations.** Length caps also bound request size beyond the existing 100 kb body limit. No auth change.

**Migration considerations.** None. Existing rows that violate the new rules are left as-is (validation applies to new writes only); note that historical invalid events are not retroactively rejected.

---

## Task 9 — Auto Select: enforce deadline and make draws non-shoppable

**Purpose.** Refuse to run a draw before the application deadline; cap re-draws and require a typed reason that is stored and surfaced.

**Why it matters.** F: the draw can run before the advertised deadline (excluding late applicants) and can be re-rolled without limit with no reason recorded — verified 3 draws stored with `reason: null`. A fairness mechanism that can be shopped is not fair.

**Files expected to change.**
- Modify: `server/routes/eventRoutes.js` — `POST /api/events/:id/auto-select/run` (deadline guard, re-draw reason + cap), and the confirm/summary path to include the run count and any reason.
- Test: `server/routes.autoselect.test.js` (new).

**Dependencies.** None. (`auto_select_runs.reason` column already exists — added but unused.)

**Implementation approach.**
- Deadline guard: at the top of `run`, `if (new Date() < new Date(event.application_deadline)) return 400 { error: 'Applications are still open; selection can run after the deadline.', code: 'deadline_not_passed' }`.
- Re-draw policy: the first run needs no reason. Any subsequent run (`runCount >= 1`) requires a non-empty `reason` in the body → else `400 { code: 'reason_required' }`; store it in the `reason` column of the new run row. Cap total runs at a small constant (e.g. `MAX_AUTO_SELECT_DRAWS = 5`); beyond that → `409 { code: 'draw_cap_reached' }`.
- Surface: the confirm step's `selection_summary` gains `runCount` and the list of re-draw reasons, so the published summary students can see reflects that re-draws happened.
- Determinism: the seed is already `${eventId}:${slotId}:run-${n}`. Add an explicit `ORDER BY a.id` to the pending-applicants query so tie-breaking is stable and the documented reproducibility actually holds.

**Tests required.**
1. Running before the deadline → 400 `deadline_not_passed` (create an event with a future deadline).
2. First run after the deadline succeeds with no reason.
3. A second run without a reason → 400 `reason_required`; with a reason → 200 and the reason is stored (assert via `GET .../auto-select/runs`).
4. Exceeding the cap → 409.
5. Two runs with the same run number/seed produce identical selection given identical applicants (determinism), with `ORDER BY a.id` in place.

**Security considerations.** Organizer/admin-only unchanged. The stored reason is an audit record; ensure it is length-capped (reuse a cap from Task 8's module).

**Migration considerations.** None — column exists. Existing draft runs are unaffected.

---

## Task 10 — Unforgeable certificates with reduced disclosure and rate limiting

**Purpose.** Replace the deterministic derivable certificate code with a random stored code; drop `grade` from the public verification response; rate-limit and index the public lookup.

**Why it matters.** F-10: `certificateCode(userId, eventId)` is a non-secret hash of two guessable ids — the reviewer computed a valid code offline and pulled a minor's name, grade, and hours unauthenticated. The verify endpoint also full-table-scans on every call.

**Files expected to change.**
- Modify: `server/db.js` — new table `certificates(user_id, event_id, code UNIQUE, created_at, PRIMARY KEY(user_id,event_id))`, plus a backfill that assigns a random code to every existing `(user_id, event_id)` that has present attendance.
- Modify: `server/utils.js` — remove `certificateCode`; add `getOrCreateCertificateCode(userId, eventId)` that reads/creates from the table with a cryptographically random code (`crypto.randomBytes` → base32, formatted `SBV-XXXX-XXXX`).
- Modify: `server/routes/attendanceRoutes.js` — `GET /api/certificates` uses the stored code; `GET /api/certificates/verify/:code` looks the code up by indexed column (no scan) and returns volunteer name, event, organizer, hours, date — **not grade**.
- Modify: `server/app.js` — mount a rate limiter on `/api/certificates/verify` (reuse the `mailLimiter` shape or a new `verifyLimiter`, by path, no circular import).
- Test: `server/routes.certificates.test.js` (new).

**Dependencies.** Task 11 (Phase 3) touches `app.js` ordering; keep this task's limiter mount consistent with the existing by-path mounts. No hard code dependency.

**Implementation approach.**
- Code generation: `crypto.randomBytes(5)` → 8 base32 chars (Crockford alphabet, no 0/O/1/I) → `SBV-XXXX-XXXX`. Insert with `INSERT OR IGNORE` keyed on `(user_id, event_id)`; on conflict read the existing code (stable per certificate).
- Backfill migration: for every distinct `(user_id, event_id)` in `attendance WHERE present = 1` with no `certificates` row, create one. Idempotent (keyed insert). Runs at boot like the hours-ledger backfill.
- Verify endpoint: `SELECT ... FROM certificates c JOIN ... WHERE c.code = ?` (indexed, single row) — O(1) instead of scanning all attendance. Uppercase-normalise input. Return `{ valid, volunteerName, eventTitle, organizerName, hours, completedAt }` — grade removed.
- Rate limit: `verifyLimiter` (e.g. 20/15 min, no `skipSuccessfulRequests`) mounted `app.use('/api/certificates/verify', verifyLimiter)`.
- The printed certificate copy already says "Verify at …/verify/CODE"; the code format is unchanged in shape (`SBV-XXXX-XXXX`), so existing printed certificates that were generated from the old deterministic code will **no longer verify**. Because this is pre-public and the pilot's certificates were demo data, that is acceptable — but call it out explicitly in the report and README: any certificate printed before this deploy must be re-issued.

**Tests required.**
1. Two calls to `GET /api/certificates` for the same completed event return the **same** code (stable), and it verifies.
2. A code computed by the **old** `certificateCode(userId, eventId)` algorithm does **not** verify (proves the switch away from derivable codes).
3. The verify response contains no `grade` field.
4. Codes for two different certificates differ and are not derivable from ids (statistical: generate several, assert format and uniqueness).
5. Hammering the verify endpoint past the limit returns 429.

**Security considerations.** The code is now a bearer secret (holding it proves nothing about identity, only that someone was given it) — that is the intended model for "hand a printout to a school office". Do not log full codes. Ensure the backfill's randomness uses `crypto`, not `Math.random`.

**Migration considerations.** New table + backfill, both idempotent. **Breaking:** old printed codes stop verifying — document re-issue. Recommend a DB backup before this deploy (same runbook note as Task 7).

---

# Phase 3 — Reliability & Polish

## Task 11 — Fix `/health` and error-handler ordering

**Purpose.** Register `/health` before the SPA catch-all so it returns JSON in production, and place the error handler after the routes it must catch.

**Why it matters.** F: in production `GET /health` returns the SPA's `index.html` (verified `200 text/html`), so load-balancer/uptime checks pass against a dead API. The error handler sits before the static/SPA block.

**Files expected to change.**
- Modify: `server/app.js` — move the `/health` route registration above the `IS_PRODUCTION` static + `app.get('*')` block; keep the JSON-404 and error handler correctly ordered (error handler last, after all routes including static).
- Test: `server/app.ordering.test.js` (new) — boot the app with `NODE_ENV=production` semantics for routing (or assert `/health` returns JSON `content-type` and the `status:ok` body).

**Dependencies.** None. Coordinate with Task 10's limiter mount (both edit `app.js`) — sequence Task 10 before or after and rebase cleanly; they touch different regions.

**Implementation approach.**
- Reorder so the final middleware chain is: security/cors/json → limiters → routers → `/health` → JSON `/api` 404 → production static + SPA `*` → error handler (last). The error handler must be `app.use((err,…))` registered after everything so it catches errors from any layer.
- Verify the reorder doesn't change dev behaviour (no production block in dev).

**Tests required.** `/health` returns `application/json` with `{ status: 'ok' }` (drive it against the app; simulate production by asserting the route resolves before any catch-all — a request to `/health` must not return HTML). Add a test that an unknown `/api/*` path still returns the JSON 404.

**Security considerations.** None.

**Migration considerations.** None.

---

## Task 12 — Define the missing `--brand-shade` CSS variable

**Purpose.** Define `--brand-shade` (referenced in `CheckInView.jsx` and `ApplicantReview.jsx` but never declared) so those elements render the intended Field Notes green rather than an inherited/invalid color.

**Why it matters.** F: `var(--brand-shade)` resolves to nothing, so text using it falls back to inherited color — a silent visual defect on the day-of check-in screen.

**Files expected to change.**
- Modify: `src/index.css` — add `--brand-shade` to `:root` alongside the existing `--brand`, `--brand-tint`, `--brand-tint-2`, `--brand-ink`.
- Test: manual/visual + a build check (no unit test framework for CSS).

**Dependencies.** None.

**Implementation approach.** Set `--brand-shade` to a darker shade of the service green `#0F6B45` (e.g. `#0B5537`) consistent with the palette. Confirm the two usage sites read correctly. This is a one-line addition; no behaviour change beyond the intended color.

**Tests required.** `npm run build` succeeds; visually confirm the check-in "present" text uses the green shade (screenshot in the report). No amber introduced.

**Security considerations.** None.

**Migration considerations.** None.

---

## Task 13 — SQLite production settings, malformed-input handling, and test-isolation pin

**Purpose.** Enable WAL + a busy timeout for production durability/concurrency; make malformed input return 400 instead of a 500 leaking raw SQLite errors; pin Vitest's `isolate: true` so the suite's cross-file assumption is explicit.

**Why it matters.** F: `journal_mode=delete` and `busy_timeout=0` are not production-tuned; malformed types currently 500 with raw driver messages; the whole suite silently depends on Vitest's default per-file isolation (no `vitest.config`), which a future config could break.

**Files expected to change.**
- Modify: `server/db.js` (or `server/server.js` boot) — `db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')` at startup.
- Modify: `server/app.js` — the last-resort error handler maps known driver/parse errors to 400 with a generic message (it already special-cases `entity.parse.failed`; extend to SQLite type/range errors) without leaking internals.
- Create: `vitest.config.js` — `export default { test: { isolate: true } }`.
- Test: extend `server/app.ordering.test.js` or add small assertions; a pragma read-back test in a db test.

**Dependencies.** Task 11 (shares `app.js` error-handler region).

**Implementation approach.**
- Pragmas: apply once after opening the DB. WAL persists on the file; safe to set every boot. Note WAL creates `-wal`/`-shm` sidecar files the backup runbook must include.
- Error mapping: in the handler, if `err.code`/`err.message` indicates a constraint/type error from `node:sqlite`, respond 400 `{ error: 'Invalid request' }` and `console.error` the detail server-side only. Keep the existing CORS and JSON-parse branches.
- `vitest.config.js`: explicit `isolate: true`. Confirm the full suite still passes with it present (it should be a no-op that documents the assumption).

**Tests required.** A request with a malformed body type to a validated endpoint returns 400, not 500, and the body contains no SQLite text. `PRAGMA journal_mode` reads back `wal` after boot. Full suite green with `vitest.config.js` present.

**Security considerations.** Not leaking driver internals is a minor info-disclosure hardening. No auth change.

**Migration considerations.** WAL mode is a file-format setting; document the `-wal`/`-shm` sidecars in the backup procedure. Reversible (`PRAGMA journal_mode = DELETE`).

---

## Task 14 — Final verification pass

**Purpose.** Prove the whole hardened surface end to end and that nothing regressed.

**Files expected to change.** None.

**Steps.**
- Clean install (`npm ci`, `npm ci --prefix server`), `npm run build`, full `npm test`.
- Fresh production DB comes up empty; boots with `NODE_ENV=production` + JWT + SMTP; refuses without SMTP/JWT (regression check on prior fixes).
- Upgrade path: build a DB with the pre-plan code, run this branch against it, confirm hours preserved, `token_version`/`certificate_code`/email-index migrations apply cleanly, no data loss.
- Flag matrix: `REQUIRE_EMAIL_VERIFICATION` on and off — verify enforcement on, pilot-unaffected off.
- Browser: student (verification wall when flag on, profile privacy), organizer (event validation rejects bad input, Auto Select deadline guard), admin (moderation), certificate verify page shows reduced info.
- Produce a readiness report with the same structure as the pilot report: ready-for-public YES/NO, remaining items, confidence.

---

## Self-Review Notes

**Spec coverage.** Phase 1: F-4 → Task 3; privacy leaks → Tasks 4 (profile), 5 (leaderboard), 6 (events/announcements); JWT revocation/deleted-users/live-roles/reset-invalidation → Tasks 1+2; email uniqueness/dedupe/reset-ambiguity → Task 7. Phase 2: event validation → Task 8; Auto Select reliability → Task 9; certificate security → Task 10. Phase 3: `/health` + error ordering → Task 11; undefined CSS var → Task 12; SQLite settings + malformed input + test isolation → Task 13. Verification → Task 14. Every listed finding maps to a task.

**Keystone dependency.** Tasks 2 and 3 require Task 1's DB-backed `authenticateToken`; they must land in order. Tasks 4–13 are mutually independent except the two `app.js`-editing pairs (10/11 and 11/13) which touch different regions and should be sequenced to rebase cleanly.

**Recommended split.** This plan spans three genuinely separable subsystems. Execute and validate **Phase 1 as its own reviewable block and redeploy** before starting Phase 2, and Phase 2 before Phase 3 — matching the stated priority. Each phase leaves the app shippable.

**Pilot-workflow risks flagged.** (a) Task 3's email gate: guarded to no-op when the flag is off — the pilot runs with it off, so no impact; the flag-off anti-lockout test is mandatory. (b) Task 5: the leaderboard goes empty until students opt in — intended, but user-visible. (c) Task 7's dedupe and Task 10's certificate re-issue are the two breaking migrations; both require a pre-deploy DB backup (add to runbook) and neither deletes data. (d) Task 1 adds a per-request DB read — negligible at pilot/early-public scale but noted.

**No placeholders / type consistency.** Middleware names (`authenticateToken` extended in place, not renamed), new columns (`token_version`, `certificate_code`/`certificates` table), and helper names (`getOrCreateCertificateCode`, `validateEventPayload`) are used consistently across the tasks that reference them.
