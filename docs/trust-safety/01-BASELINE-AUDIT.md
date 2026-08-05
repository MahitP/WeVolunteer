# Phase 3 baseline audit — trust & safety as it actually exists

**Date:** 2026-08-05 · **Suite at audit time:** 163 files, 2642 tests passing ·
**Head:** `1da3ca9`

What is here, read from the code rather than from the documents. Every claim below
carries the file and line it was read from. Nothing in this document is a proposal —
the plan is `02-PHASE-3-PLAN.md`.

---

## 1. There are two reporting systems, and they do not know about each other

### 1a. `reports` — events and comments

```
server/db.js:610   CREATE TABLE reports (
                     id, reporter_id,
                     target_type CHECK(target_type IN ('event','comment')),
                     target_id, reason,
                     status CHECK(status IN ('open','resolved','dismissed')),
                     created_at )
```

- Written by `POST /api/reports` — `server/routes/contentRoutes.js:600`
- Read by `GET /api/admin/reports` — `server/routes/adminRoutes.js:208`
- Mutated by `PATCH /api/admin/reports/:id` — `server/routes/adminRoutes.js:238`
- Rendered by `src/views/AdminDashboard.jsx:288-330`

Missing against the Phase 3 requirement: `category`, `severity`, `priority`,
`assigned_admin_id`, `updated_at`, `resolved_at`, `resolution_reason`, and moderator
notes. `status` has no `reviewing` and no `escalated`.

### 1b. `conversation_reports` — messages

```
server/db.js:560   CREATE TABLE conversation_reports (
                     id, reporter_id, conversation_id,
                     reason CHECK(reason IN ('inappropriate','spam','safety','other')),
                     details, status CHECK(... 'open','reviewing','resolved','dismissed'),
                     snapshot_created_at, created_at )
server/db.js:575   CREATE TABLE conversation_report_messages (
                     report_id, message_id, sender_id, body, created_at )
```

Written by `POST /api/messages/conversations/:id/report` —
`server/routes/messageRoutes.js:328`.

The snapshot design is **good and worth keeping**: `conversation_report_messages`
copies the message bodies at report time, so later deletion or editing of the
conversation cannot destroy the evidence. That is exactly the "do not destroy evidence"
requirement, already solved, for one target type.

### 1c. **CRITICAL — `conversation_reports` is write-only**

```
$ grep -rn "conversation_reports" server/ | grep -v test | grep -v db.js
server/routes/messageRoutes.js:346:        INSERT INTO conversation_reports (...)
```

One hit. An INSERT. **No route in the application reads this table**, and no admin
screen references it.

A student — usually a minor — opens a conversation with an adult organizer, chooses
"safety", writes what happened, and submits. The platform answers `201 { success: true }`.
The row is written. The message bodies are preserved. And no human being will ever see
it, because there is no surface that reads the table.

This is worse than having no message reporting at all. A platform with no report button
tells a student to find another way to raise a concern. A platform with a report button
that goes nowhere tells them the concern has been raised, and it has not been. It is the
single highest-severity finding of this audit and it is fixed first.

`status` on that table has never moved off `'open'` for the same reason: nothing can
move it.

---

## 2. Capability gating

`server/authz.js:95` — `report.resolve` is the only report capability, held by `admin`
(and `super_admin` via `'*'`).

Both submission routes are gated by `authenticateToken` alone:

- `contentRoutes.js:600` — `POST /api/reports`
- `messageRoutes.js:328` — `POST /api/messages/conversations/:id/report`

There is no `report.create`. That is defensible — every authenticated person should be
able to report — but it means the guard in `authz.completeness.test.js` is carrying
these as declared exceptions rather than as gates, and reporting a *user* will need a
deliberate decision about which principals may do it.

Both admin routes correctly use `requireCap('report.resolve')`
(`adminRoutes.js:208, 238, 287`).

---

## 3. Audit logging

`server/auditLog.js:108` — `recordAudit(db, entry)` with a strict field allowlist that
**throws** on an unknown field rather than silently dropping it. Table is
`admin_audit_logs` (`server/db.js:622`): `id, admin_id, action, target_user_id, details,
created_at`.

Two consequences for Phase 3:

- There is no `severity` column and no free-form metadata. The allowlist is deliberate
  and documented; moderation history has to fit `action` + `details`, or get its own
  table.
- `target_user_id` is a foreign key to `users`. `PATCH /api/admin/reports/:id`
  (`adminRoutes.js:238`) already records the **reporter** there and puts what was
  reported into `details`, with a comment explaining exactly that trade-off.

Status change is audited. Nothing else about a report is, because nothing else can
change yet.

---

## 4. Suspension — and why appeals cannot have the requested shape

Suspension is **not** a table. `server/migrations/006_account_suspension.js:72-88` adds
three columns to `users`: `suspended_at`, `suspension_reason`, `suspended_by`.
`account_status` carries `'suspended'` (`001_authz_roles.js:131`).

So the Phase 3 requirement `appeals.suspension_id` **has nothing to point at.** There is
no suspension row and therefore no suspension id. Options are recorded in the plan; the
short version is that inventing a `suspensions` table purely to satisfy a foreign key
would be a rewrite of a completed system, which this phase is not allowed to do.

Suspension does the hard part correctly (`adminRoutes.js:470-560`): mandatory reason,
`token_version` bump so existing cookies die, privilege guards expressed as
capabilities, organizers suspended rather than deleted.

**The appeal problem this creates:** a suspended user cannot sign in
(`authRoutes.js:452`), and `authenticateToken` refuses them too
(`server/utils.js:186`). Every session they held was invalidated by the
`token_version` bump. There is currently no authenticated route they can reach. An
appeals system that lives behind `authenticateToken` is an appeals system no suspended
user can use.

### 4a. Two defects found in the sign-in path while designing appeal access

**S-1 — the suspension notice is addressed to the wrong person.**
`authRoutes.js:454` answers *"This account has been suspended. Contact your school
administrator."* WeVolunteer is explicitly **not** a school district service — the
Organizer Agreement's §1 says so in terms. A school administrator has no access to this
platform, no ability to review a suspension, and no idea what the user is talking about.
This is the exact place an appeal route has to be advertised, and today it sends the
user to someone who cannot help them.

**S-2 — suspended status is disclosed before the password is checked.**
The `account_status === 'suspended'` branch at `authRoutes.js:452` sits **above** the
`bcrypt.compare` that follows it. An unknown address answers `no_such_account`; a
suspended one answers `suspended`. So anyone can learn that a given email belongs to a
suspended WeVolunteer account without knowing its password. Low severity — it discloses
a status, not content — but it is free to fix by ordering the check after
verification, and doing so is what lets the refusal safely carry the suspension reason
and an appeal route to the person who actually owns the account.

---

## 5. Blocking — verified, not to be touched

`server/blocking.js` — `isBlockedBetween`, `blockedBy`, `block`, `unblock`.
Routes at `messageRoutes.js:441` (list), `:464` (block), `:509` (unblock), gated on
`requireCap('event.apply')` so it is student-held and asymmetric by design.

Verified against the Phase 3 checklist:

| Requirement | State |
|---|---|
| Blocked users cannot message | `blocking.test.js:89` closes an EXISTING conversation, `:108` stops a new one, `:142` both directions |
| Blocking does not remove volunteer records | `:155` does not withdraw from the event, `:167` leaves credited hours untouched |
| Blocking does not punish the student | The two above, plus `:128` — the block is never announced back to the blocked party |

Also covered: idempotency (`:80`), organizer-blocking refused (`:218`), self-block
refused (`:226`), admin can still reach both parties (`:197`), and a moderation signal
raised on block (`:180`) because students block far more often than they report.

**No change proposed.** All three Phase 3 verification requirements already have
explicit, passing assertions.

---

## 6. Client surface

Two report modals that do not agree with each other:

- `src/components/ReportModal.jsx` (122 lines) — used by `EventModal.jsx:599` and
  `EventComments.jsx:140`; free-text reason, posts to `/api/reports`
- `src/components/messages/ReportModal.jsx` (157 lines) — used by
  `ConversationPane.jsx:382`; four fixed reasons plus message selection, posts to the
  conversation route

The admin surface is `src/views/AdminDashboard.jsx:288-330` — a flat list with a
resolve/dismiss control, reading only the `reports` table.

---

## 7. Summary of gaps against the Phase 3 requirement

| # | Gap | Severity |
|---|---|---|
| G-1 | Message safety reports are written and never read | **Critical** |
| G-2 | Cannot report a user, an organizer, or an individual message | **High** |
| G-3 | No category, severity, priority, assignment, notes, resolution reason, or timestamps beyond `created_at` | **High** |
| G-4 | Status lacks `reviewing` and `escalated` | Medium |
| G-5 | No appeals mechanism, and a suspended user has no reachable authenticated route | **High** |
| G-6 | Moderator actions other than status change are unaudited because they do not exist | Medium |
| G-7 | Two divergent report models and two divergent report modals | Medium |
| G-8 | Reporter cannot see what happened to their report | Medium |
| S-1 | Suspension notice tells the user to contact a school administrator who has no access to this platform | Medium |
| S-2 | Suspended status disclosed before password verification | Low |
