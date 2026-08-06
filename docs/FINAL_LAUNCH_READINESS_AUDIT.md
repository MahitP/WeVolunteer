# Final launch readiness audit

**Date:** 2026-08-06
**Version:** 1.2.0
**Scope:** completion pass over moderation, admin capability, the error experience,
the legal baseline, OAuth and deployment readiness.

This document states what was verified and what was not. Where something is
unfinished it says so, with the reason, rather than describing an intention as a
result. It supersedes `docs/reviews/FINAL_LAUNCH_READINESS_AUDIT.md`, whose §3
listed six items as not done; four of those are now built and two are still not,
and both are named in §4 below.

---

## 1. Verification performed

| Gate | Result |
|---|---|
| `npm ci` | passes; installs from the root lockfile |
| `npm test` | **194 files, 3163 tests, 0 failures** |
| `npm run lint` | clean (oxlint) |
| `npm run build` | clean, 372 kB main chunk (116 kB gzip) |
| Server boot | reaches listening against the real pilot database; both new migrations applied to it in place |
| `/health` | `{"status":"ok","database":"connected","writable":true,"version":"1.2.0"}` |
| Legal endpoints | all 10 answer 200, all at v1.0, hashes verified at boot |
| OAuth | Google `available`; Microsoft `misconfigured` and `POST /url` answers **503**, not a URL with `client_id=` |

Baseline for comparison: 185 files / 3029 tests at the start of this pass. **+9
files, +134 tests.**

Beyond the gates, the following were exercised against the running application
rather than inferred from tests:

- A conversation report's preserved evidence opened in the Moderation Center, and
  the disclosure appeared in the report's timeline immediately afterwards and in
  both audit trails in the database.
- A timed suspension imposed from a report stored `2026-09-15T03:59:59Z` for "until
  the 14th", named the date in the sign-in refusal and in the notice, and — after
  backdating the deadline — let the account sign in again with the row normalised
  and the reason preserved.
- An administrator opened a thread with a student from a report; it appeared in both
  inboxes with `kind = 'admin_student'`, `event_id = NULL`, both participant rows,
  and an audit row.
- `/portfolio` as an administrator rendered the full-screen 403 — no navigation,
  sidebar or profile menu — naming the feature, the reason and the remedy.

Method note, still true: do not run a manual server alongside `npm test`. A
`shutdown.test.js` failure traced to a port collision, not a regression.

---

## 2. Completed in this pass

### 2.1 Moderation evidence viewer — built

`GET /api/admin/reports/:id/evidence` existed, was gated on `report.evidence.read`,
froze the bodies at filing, made them immutable at the database, and logged every
read. **No client code called it.** The queue rendered the evidence *count* with no
way to open it, so a moderator deciding whether to suspend a student could see that
evidence existed and not read it — and the Youth Safety Guidelines' printed promise
("this is the one situation in which an administrator reads private messages, and it
is logged") described something the product could not do.

- `GET /api/admin/reports/:id` returns one report plus its append-only action
  history. `moderation_actions` had been written on every decision since v1.2 and
  read back by nothing.
- The evidence bodies are deliberately **not** in that response. `report.resolve`
  and `report.evidence.read` are split so a per-user grant can create a triage-only
  helper who works the queue without reading a student's private messages; folding
  the bodies in would have collapsed that split while the separate capability still
  looked like it did something.
- Evidence is fetched only when a moderator asks. The server logs a disclosure on
  every call, so prefetching would manufacture records of reads nobody performed.
  The load-bearing client test asserts it is **not** fetched on open.
- The response now carries `captured_at` beside `created_at` — when the message was
  sent versus when the report froze a copy. The column existed since migration 013
  and was never selected, so "preserved copy" was a label the UI asserted.

### 2.2 Moderation actions — real, and only the real ones

- **Warnings now reach the person.** `REPORT_RESOLUTIONS` has offered
  `warning_issued` since v1.2 and the resolution dropdown has offered "Warning
  issued to the person reported"; choosing it wrote a word on a closed report and
  told nobody. `POST /api/admin/users/:id/warn` sends a mandatory notice, writes an
  audit row, and changes nothing about the account. New capability `user.warn`,
  split from `user.suspend` so a triage helper can tell somebody to stop without
  being able to lock them out.
- **Suspensions can end on their own.** Migration 017 adds `suspended_until` (NULL =
  indefinite, which is what every existing row has always meant — no backfill). The
  deadline is authoritative in the *data*: `server/suspension.js` derives "suspended
  right now" on every read, so access returns the instant the clock passes it with
  no background job involved. That is the difference between a real expiry and a job
  pretending to be one. An unreadable deadline fails **closed**.
- **Reinstatement is reachable.** `unsuspendUser` existed but only from
  `AdminAppeals`, i.e. only via the suspended person appealing. An administrator who
  suspended the wrong account had no way back.
- The report detail view resolves and names the person a report is about, derived
  server-side because the rule is easy to get wrong, and deliberately **not** falling
  back to the reporter — that fallback exists for an audit foreign key and here would
  point a "warn them" button at the child who filed the report.

**Not built, and not faked:** removing organizer privileges, and per-account feature
restriction. Both were scoped and deferred by the owner. Neither has an endpoint, so
neither is offered in the UI.

### 2.3 Admin messaging — built, via a migration

The previous audit was right that this needed a conversation shape that is not
`(event, student, organizer)`. Migration 018 rebuilds `conversations`:

- adds `kind` (`student_organizer` | `admin_student` | `admin_organizer`);
- drops NOT NULL from the three columns an admin thread cannot fill, replaced with
  CHECKs so relaxing them does not also admit an event-scoped thread about no event;
- adds a partial unique index on `(kind, created_by, COALESCE(student_id,
  organizer_id))`. The existing `UNIQUE(student_id, organizer_id, event_id)` cannot
  do this job — SQLite treats NULLs as distinct — so without it, pressing "message"
  twice would split the conversation in half.

Membership lives in `conversation_participants`, which already existed and which
`isConversationParticipant` already read. Nobody is put in the `organizer_id` slot.
`computeConversationLifecycle` returns early for admin threads so a student's channel
to an administrator cannot be closed by an unrelated event ending.

This is the **second** sanctioned destructive rebuild in the repo and carries all six
ENGINEERING_GUIDE §8.3 guards. It ran against the live development database: every
conversation, message, participant row and evidence row intact, zero foreign key
violations.

### 2.4 Permission refusals name the door

Every 403 read identically, and three of the six themes told the reader that "your
school administrator" could help — the same wording `authRoutes.js` had already
corrected in the suspension notice, for the same reason: WeVolunteer is not a school
district service, so a school administrator cannot see the refusal or act on it.

`denialDetail.js` adds the feature, the reason and the remedy. Two cases where the
obvious answer would be wrong are pinned: an unapproved organizer *holds*
`event.create`, and `error.read` is SUPER_ONLY so no grant can reach it.

### 2.5 OAuth — the guard is now inherited, not remembered

The credential refusal was correct but was a convention each provider had to
remember, and the state matrix looped over a hand-written `['google','microsoft']`.
Both now derive from the provider directory, so a fourth provider cannot ship without
the guard or without the six state cases. Verified by adding a violating provider:
both guards fail with actionable messages.

### 2.6 Legal baseline — verified, unchanged

All ten documents publish at v1.0, hashes verified by `bin/legal-hashes.mjs` and at
boot, zero drift. The development database holds ten v1.0 rows and **zero**
acceptance records, so no fake launch history exists. `PrivacyNotice.jsx` is gone;
`/privacy` redirects to the registry document. Nothing about hash pinning, the
immutability guard or acceptance tracking was touched.

---

## 3. Security

| Item | Status |
|---|---|
| Authorization completeness (6 build-failing guards) | pass, including the two new capabilities and four new routes |
| Suspension enforced at every door | **fixed** — see below |
| Suspension end-date disclosure | **fixed** — see below |
| Evidence immutability | unchanged; triggers still refuse UPDATE and DELETE by any path |
| Evidence read logged to both trails | verified in the database |
| Admin wildcard | not granted |
| `npm audit` | 2 high, assessed below |

Two defects were found **in this pass's own work** and fixed:

**A provider-only account could be locked out permanently.** Both sign-in branches
of `oauthRoutes.js` compared `account_status === 'suspended'`. The column stays
'suspended' until something normalises the row, and the OAuth path never did — so a
student suspended for a week and signing in with Google was still refused after
their week was up, and an account with no password has no other door. The guard
meant to prevent this had missed it because it *named* the two enforcement points its
author knew about; it now derives them by scanning every server module, with stale
exemptions failing too. Both new cases were verified against the pre-fix code.

**The suspension end date leaked to anyone who could guess an email.** The sign-in
refusal named it, and that branch runs before the password check. Account existence
being disclosed there is an accepted product decision (`GENERIC_LOGIN_ERRORS`
reverses it); the date is not — it is a detail of a moderation action against a named
minor. It is now only in the notice sent to the account.

That is the third time on this branch a hand-written list turned out to be the bug —
the OAuth provider loop, the provider credential fixtures, and the suspension
enforcement points. Every one of the three is now derived.

**`npm audit`: not exploitable in this configuration.** GHSA-qwww-vcr4-c8h2 ("RSC
Mode CSRF Bypass") against `react-router` 7.18.2, which is the newest 7.x published —
no patched release exists. Verified independently: the app uses `BrowserRouter` only,
imports no server-side router API anywhere (`createStaticHandler`,
`StaticRouterProvider`, `renderToString`, RSC entry points — none present), and the
server deliberately never loads `react-router`. The only offered remedy is a
breaking downgrade to 7.11.0. **Recommendation: do not downgrade. Watch for a
patched 7.x. Re-assess if server-side rendering is ever adopted.**

---

## 4. Not done, and why

### 4.1 Audit-log viewer — NOT built

`admin_audit_logs` is written on every administrative action and is readable by
nothing. `audit.read` exists and gates only `GET /api/admin/system/status`. This is
the same defect `moderation_actions` had before this pass, and it is the more
consequential of the two remaining gaps: the Admin Responsibilities Policy's
accountability claims rest on a record no administrator can read.

Needs a paginated, filterable endpoint with PII scoping decisions made deliberately
(the table names target users), plus a view. Not started.

### 4.2 User-management screen — NOT built

There is no endpoint that lists users, so there is no screen. Suspend, warn and
unsuspend are reachable only from a report. An administrator who needs to act on
somebody nobody has reported has no route to them.

Deliberately not faked: a screen over an endpoint that does not exist is worse than
its absence.

### 4.3 Removing organizer privileges / feature restriction — NOT built

Scoped and deferred by the owner. `user_capabilities` (migration 002) already
supports per-account withholding, so feature restriction has a mechanism when it is
wanted; organizer demotion has none — "deny" only works pre-approval and deletes the
account.

### 4.4 Suspension sweep — deliberately absent

`sweepExpiredSuspensions` exists in `server/suspension.js` and nothing calls it on a
timer. Access is correct without it, because the predicate is authoritative and both
sign-in doors normalise the row on the way past. What lags is *labelling*: an account
whose deadline passed and who never returns still reads as suspended in
administrative views. Wiring it to an interval is a small change; it was left out
rather than added untested.

---

## 5. Deployment

See `docs/plans/supabase-vercel-migration-plan.md`, whose measurements were re-taken
for this pass (18 migrations, 109 PRAGMAs, 64 files containing SQL).

The assessment is unchanged: the frontend can move to Vercel immediately; the backend
cannot move to Supabase without converting synchronous `node:sqlite` access
throughout, which reintroduces a concurrency hazard `instanceLock.js` exists to
prevent. **Recommendation stands: launch on the VPS.** Migration 018 adds one thing
a naïve port would silently drop — a partial unique index over an expression, which
Postgres supports and which is the only thing stopping duplicate admin threads.

Still required before launch, none of it code:

- `ALERT_EMAIL` and the `SMTP_*` set configured and delivery-tested.
- A **verified restore drill**. `wevolunteer-backup.timer` exists; a backup that has
  never been restored is not a backup. This pass performed two table rebuilds, which
  raises rather than lowers the value of that drill.
- `OAUTH_REDIRECT_URI` set to the real callback and registered with Google.
- `MICROSOFT_CLIENT_ID`/`SECRET` if Microsoft sign-in is wanted; otherwise the button
  correctly reads "not set up on this site".
- The Privacy Policy must keep saying the hosting provider is not yet chosen until a
  deployment exists. That is still true today.

---

## 6. Recommended next steps, in priority order

1. **Audit-log viewer** (§4.1). Highest remaining value; the accountability record
   exists and nobody can read it.
2. **Restore drill and `ALERT_EMAIL`** (§5). Neither is code, both are launch
   blockers, and the drill matters more now that two rebuilds have shipped.
3. **User-management screen** (§4.2), starting with the list endpoint.
4. **Wire the suspension sweep** to an interval with a test (§4.4).
5. Supabase/Vercel: frontend whenever convenient; backend as its own project.
