# Trust & Safety MVP — buildable specification

**Date.** 2026-08-05
**Status.** Specification. No code written; every item below is executable by one engineer without
rediscovering current state.
**Supersedes.** `docs/legal/09-ROADMAP.md` PR-3, PR-5, PR-6, PR-7, PR-8 — those are the sketch,
this is the version that survives contact with the schema. Where this document and the roadmap
disagree, the disagreement is called out and the reason given.
**Sized for.** A one-to-two-person moderation team. Everything that assumes a moderation
department is listed in §5.7 as deliberately omitted, with the reason.

> **Partly superseded, 2026-08-07 — suspended sessions.** This document states in several
> places that `authenticateToken` refuses a suspended account outright and that "a suspended
> account never reaches" anything past it. That was true when it was written and is no longer
> the behaviour. A suspended account now receives a session that reaches exactly four routes —
> read yourself, submit an appeal, read your appeals, sign out — enumerated in
> `server/suspendedAccess.js` and matched by exact method and exact path.
>
> The reason for the change is that the old design left the person with no durable account of
> what had happened to them: everything they were told existed in one email sent at the moment
> of suspension, and the product's only other answer was a sentence on the login form. The
> enforcement itself did not weaken — everything outside those four routes is still refused in
> `authenticateToken`, before any handler and before any capability gate — and the sign-in
> refusal moved below the password check, which closed an enumeration oracle this document
> accepted as a product decision.
>
> Left otherwise unedited: it is a dated record of what was designed on 2026-08-05, and
> rewriting it would destroy that. `server/suspendedSession.test.js` is the current contract.

---

## 0. Ground truth — what the code actually does today

Read before anything else. Six of these contradict the roadmap or the published policies.

### 0.1 Verified facts

| Fact | Evidence |
|---|---|
| `reports.target_type` accepts exactly `'event'` and `'comment'`, by CHECK constraint | `server/db.js:606-616` |
| `reports` has 7 columns: `id, reporter_id, target_type, target_id, reason, status, created_at`. No category, priority, assignee, resolution, reviewer, or history | `server/db.js:606-616` |
| `reports.status` CHECK is `('open','resolved','dismissed')` — no in-progress state | `server/db.js:612` |
| `reports.reporter_id` is `NOT NULL` with `REFERENCES users(id) ON DELETE CASCADE` | `server/db.js:608, 614` |
| **No table in the schema holds a foreign key to `reports`.** It has zero children today | `PRAGMA foreign_key_list` over `server/db.js`; grep for `REFERENCES reports` returns nothing |
| `reports` has **no indexes at all** | `server/db.js:836-860` — none named `reports` |
| `POST /api/reports` has no capability gate; it is declared `OPEN_TO_AUTHENTICATED` in the guard-2 registry | `server/routes/contentRoutes.js:600`; `server/authz.completeness.test.js:692` |
| `POST /api/reports` does **not** check that the target exists, and does not check that the reporter can see it | `server/routes/contentRoutes.js:600-634` |
| `POST /api/reports` carries only the blanket `apiLimiter` — 600 requests / 15 min | `server/app.js:299-306, 563`; no `/api/reports` mount among the specific limiters |
| `conversation_reports` is a **separate** table with its own reason enum `('inappropriate','spam','safety','other')` and its own status enum including `'reviewing'` | `server/db.js:556-568` |
| `conversation_report_messages` snapshots reported message bodies, `ON DELETE CASCADE` from `conversation_reports(id)` | `server/db.js:570-580` |
| The conversation-report snapshot is **capped**: at most 20 caller-named ids, or the last 10 messages if none are named | `server/routes/messageRoutes.js:339, 350-359` |
| `GET /api/admin/reports` selects `FROM reports` only, is unpaginated, unfiltered, and enriches only `event` and `comment` targets | `server/routes/adminRoutes.js:208-235` |
| `PATCH /api/admin/reports/:id` accepts `status` and nothing else; it writes an audit row naming the **reporter** as `target_user_id` | `server/routes/adminRoutes.js:238-284` |
| The capability governing reports today is **`report.resolve`**, held by `admin` (and `super_admin` via `'*'`) | `server/authz.js:64`, `server/routes/adminRoutes.js:208, 238, 287` |
| Suspension already writes `account_status`, `suspended_at`, `suspension_reason`, `suspended_by`, bumps `token_version`, and records `ACCOUNT_SUSPENDED` — all in one transaction | `server/migrations/006_account_suspension.js`; `server/routes/adminRoutes.js:563-644` |
| Suspension refusals are already correct: self, deleted, super-admin target, admin-target-without-`admin.create`, already-suspended, unknown user | `server/routes/adminRoutes.js:508-546`, 25 cases in `server/routes.suspension.test.js` |
| `authenticateToken` refuses a suspended account with **403 before `req.user` or `req.principal` is populated** | `server/utils.js:164` |
| `EMAIL_GATE_ALLOWLIST` is **not** an analogue for suspension. It is consulted *after* `authenticateToken` has already admitted the request; a suspended account never reaches it | `server/config.js:259-321`, `server/utils.js:164` |
| The retention sweep exempts messages **only** by `id NOT IN (SELECT message_id FROM conversation_report_messages)` | `server/workers/retentionWorker.js:123-127` |
| `admin_audit_logs` is swept at **365 days**; `messages` at 3 years; deleted-account shells at 3 years | `server/workers/retentionWorker.js:40-50, 129` |
| `PRESERVED_TABLES` is `['certificates','attendance','hours_ledger']`, asserted after every sweep | `server/workers/retentionWorker.js:55, 180-194` |
| `POST /api/blocks/:userId` has **no rate limit** and returns 404 for an unknown/deleted id vs 200 for a real one | `server/routes/messageRoutes.js:464-506`; no `/api/blocks` limiter mount in `server/app.js` |
| Blocking is student-only by capability (`event.apply`), deliberately one-directional | `server/blocking.js:10-24`, `server/routes/messageRoutes.js:452-464` |
| A block does **not** prevent the blocked pair's conversation from being reported — reporting needs participation, not writability | `server/routes/messageRoutes.js:328-334` |
| `certificates` has **no `id` column**; its primary key is `(user_id, event_id)` and its public handle is the random `code` | `server/certificates.js:39-45` |
| `GET /api/certificates/verify/:code` is **unauthenticated** | `server/routes/attendanceRoutes.js:243` |
| `recordAudit` throws on unknown fields; there is no `severity` column and `createdAt`/`id` are not parameters | `server/auditLog.js:49, 108-139` |
| The highest existing migration on this branch is **009** (`009_user_blocks.js`), and 006–009 are untracked working-tree additions | `server/migrations/index.js:12-25`, git status |

### 0.2 Where the roadmap is wrong

1. **"Today they can report … a whole conversation."** They can *file* one. **Nothing in `server/`
   ever reads `conversation_reports` or `conversation_report_messages`** — grep the whole tree
   outside tests and the only statements are the two INSERTs in
   `server/routes/messageRoutes.js:344-368`. The admin queue (`GET /api/admin/reports`) selects
   `FROM reports` and never touches them. **Conversation reporting is write-only.** The most
   safety-critical report type on the platform — the one the Youth Safety Guidelines points every
   student at — lands in a table with no reader.

2. **There is no route by which any moderator can read a reported conversation.**
   `GET /api/messages/conversations/:id/messages` gates on
   `isConversationParticipant(conversation.id, req.user.id)` with no capability escape
   (`server/routes/messageRoutes.js:90-96`). An admin is not a participant. So Youth Safety
   Guidelines §"What happens after you report" item 2 — *"We look at what was reported —
   including the messages in a reported conversation. This is the one situation in which an
   administrator reads private messages, and it is logged"* — describes a capability that does
   not exist in any form, and consequently is not logged either, because it cannot happen.
   `eligibleRelationship()` lets an admin *open* a conversation (`server/messaging.js:78-83`); it
   does not let them read an existing one.

3. **PR-5 calls the workflow columns "additive".** Two of them are not.
   `status` must gain `'reviewing'` and that is a CHECK change — a rebuild. Since PR-3 rebuilds
   the same table for `target_type`, this is one rebuild, not "additive columns after a rebuild".
   The roadmap's own parenthetical ("consider merging PR-3 and PR-5's migrations") is the right
   call; this spec makes it mandatory, and adds the reason the merge is *safe*: see §2.3.

4. **PR-8's suggested fix — "add to the `EMAIL_GATE_ALLOWLIST` equivalent for suspended
   accounts" — cannot work.** There is no equivalent, and there cannot be a cheap one: the
   suspension refusal is at `server/utils.js:164`, inside `authenticateToken`, before
   `req.user` and `req.principal` exist. The email gate is a separate, later check on an
   already-authenticated request. Any allowlist approach means teaching
   `authenticateToken` to mint a principal for a suspended account, which is precisely the state
   line 164 exists to make impossible. §7 specifies the token path instead.

5. **PR-7 says "the retention sweep already exempts reported messages".** It exempts
   *snapshotted* messages. The snapshot is capped at 20 named ids or the last 10 messages
   (`server/routes/messageRoutes.js:339, 358`). Message 11 of a reported conversation is
   **swept today**. That is a live evidence-destruction path, independent of redaction. See §6.3.

6. **Migration numbers.** The roadmap says 012/013/014/015. The registry's highest is **009**.
   Numbers below are 010–013 and **must be re-checked at implementation time** — two other agents
   are editing `server/migrations/` concurrently. What matters is the order in
   `server/migrations/index.js`, not the digits.

### 0.3 Policy promises the code cannot currently keep

| Published promise | Reality |
|---|---|
| Youth Safety §"How to report": *every conversation, comment, and event page has a Report button* | Conversation reports are unreadable (§0.2 #1); `event_announcements` — organizer→student broadcast text — is not reportable at all, and Community Guidelines say the rules *"apply everywhere you can type"* |
| Youth Safety §"What happens after you report" #2: *an administrator reads private messages … and it is logged* | No such route exists (§0.2 #2) |
| Community Guidelines §"What we do about violations" step 1: *We remove the content and tell you why* | No redaction; `DELETE /api/comments/:id` hard-deletes, destroying evidence; nothing tells the author anything |
| Community Guidelines step 3: *Suspension … for a stated period* | `users` has no `suspended_until`. Every suspension is indefinite and the period cannot be stated |
| Community Guidelines: *If you are under 18, we tell your parent or guardian about a suspension* | No guardian contact exists anywhere in the schema. This promise is **unkeepable** and is blocked on roadmap PR-2, not on this spec. Flagged in §11 |
| Community Guidelines §appeals: *Email us … we reply within 5 business days* | Honest today (it *is* an inbox) but the Guidelines also promise the outcome and reason; nothing records either |
| Youth Safety and Community Guidelines both: *You can report anonymously* | `reports.reporter_id` is `NOT NULL`. In-app reporting is never anonymous to a moderator. See §3.4 — this is a copy fix, not a schema fix |

---

## 1. Design principle: enforcement hangs off a report

Adopt this and most of the authorization questions below answer themselves.

> **Every moderation action is an action *on a report*. If there is no report, make one.**

Consequences, all deliberate:

- The route that lets a moderator read private messages is
  `GET /api/admin/reports/:id/conversation` — not `/api/admin/conversations/:id/messages`. The
  report id is in the path, so "you may only read a conversation somebody reported" is
  **structural**, not a validated query parameter somebody can forget to check.
- Redaction is `POST /api/admin/reports/:id/redactions`, not `/api/admin/messages/:id/redact`.
  Same reasoning: the reported scope bounds what can be redacted, by construction.
- An admin who notices bad content with no report files one first. That is not friction, it is the
  record — and it is what makes "who decided, on what evidence, when" answerable a year later.
- Suspension is the exception: `POST /api/admin/users/:id/suspend` keeps working without a
  `reportId`, because it is already shipped and tested (25 cases) and breaking it to enforce a
  principle is the wrong trade. It gains an **optional** `reportId` that the moderation UI always
  sends. See §7.1.

---

## 2. Migration 010 — the `reports` rebuild

`server/migrations/010_report_targets_and_workflow.js`, `ownTransaction: true`.

One rebuild, carrying both the roadmap's PR-3 target types and PR-5's workflow columns, because
`target_type` and `status` are both CHECK constraints and SQLite cannot alter either.

### 2.1 Target types, and the modelling decision

```
target_type IN ('event','comment','announcement','message','conversation','user','certificate')
```

| Value | `target_id` holds | Notes |
|---|---|---|
| `event` | `events.id` | existing |
| `comment` | `event_comments.id` | existing |
| `announcement` | `event_announcements.id` | **new surface.** Organizer→student broadcast text. Currently unreportable; Community Guidelines say the rules apply "everywhere you can type" |
| `message` | `messages.id` | one message |
| `conversation` | `conversations.id` | whole thread; absorbs `conversation_reports` |
| `user` | `users.id` | a person — student or organizer |
| `certificate` | `certificates.code` | **not an id.** `certificates` has no `id` column; `(user_id, event_id)` is the PK and `code` is the public handle |

**"Organizer" and "impersonation" are not target types, and this is a deliberate deviation from
the brief's list.** `target_type` answers *what did you point at*; `category` (§4) answers *what is
wrong*. An organizer is a `users` row — a separate `'organizer'` value would be a second, mutable
source of truth about a role that already lives on the row, and it would be wrong the moment
somebody's role changes. Impersonation is a `category` (`pretending_to_be_someone`) whose target is
a `user`. A forged certificate is `target_type='certificate'` with
`category='fake_hours_or_certificate'`.

What the product loses: nothing. The UI still offers "Report this person" from an organizer's
profile and "Report this certificate" from the verification page. What it gains: triage can sort
adult-reported-by-student to the top from `reported_role_snapshot` (§3.1), which records the role
**at report time** and therefore does not lie when the role changes afterwards.

### 2.2 Full DDL

```sql
CREATE TABLE reports_new (
  id                    TEXT PRIMARY KEY,
  reporter_id           TEXT REFERENCES users(id) ON DELETE SET NULL,
  reporter_name_snapshot TEXT,
  target_type           TEXT NOT NULL CHECK(target_type IN
                          ('event','comment','announcement','message','conversation','user','certificate')),
  target_id             TEXT NOT NULL,
  reported_user_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  reported_role_snapshot TEXT,
  category              TEXT NOT NULL,
  description           TEXT,
  status                TEXT NOT NULL DEFAULT 'open'
                          CHECK(status IN ('open','reviewing','resolved','dismissed')),
  priority              TEXT NOT NULL DEFAULT 'normal'
                          CHECK(priority IN ('urgent','normal')),
  assigned_to           TEXT REFERENCES users(id) ON DELETE SET NULL,
  assigned_at           TEXT,
  resolution            TEXT CHECK(resolution IS NULL OR resolution IN
                          ('no_action','content_removed','warning_issued','account_suspended',
                           'account_removed','escalated_offline','duplicate')),
  resolution_note       TEXT,
  resolved_by           TEXT REFERENCES users(id) ON DELETE SET NULL,
  resolved_at           TEXT,
  created_at            TEXT NOT NULL
);
```

`category` deliberately has **no CHECK constraint**. The list in §4 will change as students tell us
what is happening to them, and a CHECK on it buys a table rebuild every time. Validation lives in
`server/moderation.js`'s exported `REPORT_CATEGORIES` and is enforced at the route, where a bad
value is a 400 with a list — which is a better error than a SQLite constraint failure anyway. The
two enums that *are* CHECKed (`status`, `priority`) are closed sets that queries branch on;
`category` is a label.

Indexes (there are none today):

```sql
CREATE INDEX IF NOT EXISTS idx_reports_queue      ON reports(status, priority, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_assignee   ON reports(assigned_to) WHERE assigned_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reports_target     ON reports(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_reports_reported   ON reports(reported_user_id) WHERE reported_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reports_reporter   ON reports(reporter_id) WHERE reporter_id IS NOT NULL;
-- Duplicate suppression (§9.1). A second live report of the same thing by the same person
-- is not new information.
CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_no_dup
  ON reports(reporter_id, target_type, target_id)
  WHERE status IN ('open','reviewing') AND reporter_id IS NOT NULL;
```

`idx_reports_target` is what makes the retention exemption subqueries in §6.3 cheap; without it
every sweep does a table scan of `reports` per message.

### 2.3 Column mapping for the copy

```js
export const EXPECTED_REPORT_COLUMNS = [
  'id', 'reporter_id', 'target_type', 'target_id', 'reason', 'status', 'created_at',
];
```

```sql
INSERT INTO reports_new
  (id, reporter_id, target_type, target_id, category, description, status, priority, created_at)
SELECT
  id, reporter_id, target_type, target_id, 'other', reason, status, 'normal', created_at
FROM reports;
```

`reason` becomes `description` and `category` backfills to `'other'` — correct, because existing
rows carry free text and no category was ever collected. `priority` backfills to `'normal'`: a
historical report cannot be triaged retroactively by software, and marking them all urgent would
bury the live queue on day one.

`reporter_name_snapshot` is **not** backfilled. It is `NULL` for historical rows and the queue
renders `reporter_id`'s current name when the snapshot is absent (§5.2). Inventing a snapshot from
today's name would be a fabricated record.

### 2.4 The six §8.3 guards, applied concretely

Copy `001_authz_roles.js`'s structure. Each guard, and what it means *for this table*:

1. **Back up first.** `bin/verify-restore.sh` before the release that carries 010. Same as 001 —
   this is a release-process step, not code, and it belongs in the release checklist entry for
   this version.

2. **Pragma-took-effect assertion.** `PRAGMA foreign_keys = OFF` outside the transaction, read
   back, abort if not `0`.
   *Why it still matters even though `reports` has no children:* the copy re-validates
   `reports_new`'s four `REFERENCES users(id)` constraints on every inserted row. With foreign keys
   ON and a `reporter_id` pointing at a purged shell, the insert throws mid-migration; with them
   OFF the row copies and guard 6's `foreign_key_check` reports it cleanly at the end. More
   importantly: deviating from the reviewed recipe per-table is how a rebuild gets it wrong. Keep
   the assertion, and keep `ownTransaction: true` — the pragma is a silent no-op inside a
   transaction.

3. **Explicit column list, never `SELECT *`.** Non-negotiable and the reason is sharper here than
   for `users`: the copy is a **transformation**, not a copy —`reason`→`description`, two literal
   defaults injected, and the source has 7 columns against the target's 18. `SELECT *` cannot
   express it and would silently write `reason` into `target_id`'s position.

4. **Unknown/missing-column guard.** Compare `PRAGMA table_info(reports)` against
   `EXPECTED_REPORT_COLUMNS`. Throw on an unknown column (the copy would drop it) and on a missing
   one (the table is not in the state this migration assumes). `reports` predates the registry, so
   a pilot database may carry an `addColumnIfMissing` column this spec does not know about — that
   is exactly the case this guard exists for.

5. **Schema-derived child-row count comparison.** Implement it exactly as 001 does
   (`sqlite_master` + `PRAGMA foreign_key_list`, never a hardcoded list). **It is vacuous today
   and that is the point:** zero tables reference `reports`, so nothing can cascade. That fact is
   *why 010 must run before 011* — 011 creates `moderation_actions` and `report_evidence`, both
   with FKs to `reports(id)`. Doing the destructive step while the table is childless is the
   cheapest ordering available, and the guard stays in the code so a re-run, or any future rebuild
   of `reports`, is covered without anyone remembering to add it.

6. **Row-count equality on the copy, and `PRAGMA foreign_key_check` before `COMMIT`.** Same shape
   as 001:145-172. Recreate the five indexes from §2.2 after the rename — `DROP TABLE` takes
   indexes with it, and `reports` having had none before is not a reason to ship without them.

**Idempotency probe.** The CHECK text is the cheapest reliable one, matching 001:59-61:

```js
const existing = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='reports'").get();
if (existing?.sql?.includes("'conversation'")) return;
```

**Rollback.** Forward-only, like the rest of the registry. Recovery is manual and documented in the
migration header: restore the backup from guard 1. Unlike 006's three `ALTER TABLE ... DROP COLUMN`
recovery, a rebuild has no column-level undo — say so in the header rather than leaving the reader
to work it out.

---

## 3. Migration 011 — history, evidence, and folding `conversation_reports`

`server/migrations/011_moderation_history.js`. Additive DDL plus an INSERT-only backfill. No
`ownTransaction` — the registry's own BEGIN/COMMIT is correct.

### 3.1 `moderation_actions` — the append-only history

```sql
CREATE TABLE IF NOT EXISTS moderation_actions (
  id             TEXT PRIMARY KEY,
  report_id      TEXT NOT NULL REFERENCES reports(id) ON DELETE RESTRICT,
  actor_id       TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action         TEXT NOT NULL CHECK(action IN (
                   'filed','assigned','unassigned','prioritised','note','evidence_viewed',
                   'content_redacted','content_unredacted','warning_issued','user_suspended',
                   'user_unsuspended','escalated','resolved','dismissed','reopened')),
  target_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  detail         TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_moderation_actions_report ON moderation_actions(report_id, created_at);
CREATE INDEX IF NOT EXISTS idx_moderation_actions_target ON moderation_actions(target_user_id, created_at)
  WHERE target_user_id IS NOT NULL;
```

**Append-only is enforced by the database, not by convention:**

```sql
CREATE TRIGGER IF NOT EXISTS moderation_actions_no_update
BEFORE UPDATE ON moderation_actions BEGIN
  SELECT RAISE(ABORT, 'moderation_actions is append-only: correct the record by appending, never by editing');
END;
CREATE TRIGGER IF NOT EXISTS moderation_actions_no_delete
BEFORE DELETE ON moderation_actions BEGIN
  SELECT RAISE(ABORT, 'moderation_actions is append-only: a moderation record is never deleted');
END;
```

A test asserting "history is append-only" checks the code path somebody wrote. A trigger checks
every path anybody ever writes, including a `bin/` script and a psql-equivalent session. It costs
two statements.

`ON DELETE RESTRICT` on both `report_id` and `actor_id`, deliberately: a moderation record must be
impossible to destroy by deleting something else. This means a `users` row that has moderated
anything cannot be hard-deleted — which is correct, and which the retention sweep must now respect
(§6.4).

**Why `moderation_actions` and not just `admin_audit_logs`.** Two trails, different purposes, and
the difference is retention. `admin_audit_logs` is swept at **365 days**
(`server/workers/retentionWorker.js:47, 129`). A suspension is permanent and appealable; a district
asks about a safety incident years later. `moderation_actions` is the durable, report-scoped,
append-only record; `admin_audit_logs` stays exactly as it is and moderation mutations keep writing
to **both**. `recordAudit` also cannot hold this shape — it has four allowed fields and throws on
anything else (`server/auditLog.js:49, 116-123`), by design.

### 3.2 `report_evidence` — snapshotted message bodies

```sql
CREATE TABLE IF NOT EXISTS report_evidence (
  report_id  TEXT NOT NULL REFERENCES reports(id) ON DELETE RESTRICT,
  message_id TEXT NOT NULL,
  sender_id  TEXT,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(report_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_report_evidence_message ON report_evidence(message_id);
```

Shape follows `conversation_report_messages` (`server/db.js:570-580`) with three changes, each
load-bearing:

- **`ON DELETE RESTRICT`, not CASCADE.** The old table cascades from `conversation_reports`, which
  means deleting a report destroys its evidence. Reports are never deleted in this design; RESTRICT
  makes that a database fact rather than a hope.
- **`message_id` carries no FK to `messages`.** It must survive the message row being swept or
  hard-deleted — that is the entire purpose of a snapshot. A CASCADE here would make evidence
  preservation a lie; a RESTRICT here would make retention impossible.
- **`idx_report_evidence_message`** exists because the retention sweep's exemption subquery
  (§6.3) probes this column on every pass.

### 3.3 Folding `conversation_reports` — the decision

**Decision: fold the report envelope into `reports`; migrate the evidence into `report_evidence`;
leave the two legacy tables in place, frozen and read-only, and keep them in the retention
exemption.**

**Why fold at all.** Because they are not folded today, the admin queue does not show conversation
reports (§0.2 #1). Two queues on a one-to-two-person team is not "two queues", it is one queue and
one blind spot. The blind spot currently contains the highest-severity report type on the platform.
Any design that leaves them separate has to build and maintain a second queue UI, a second
filter/assign/resolve workflow, a second history table and a second set of capability gates —
for a team of one.

**Why not drop the legacy tables.** Migrations are additive (§8.3) and those two tables hold real
moderation evidence about real students. `DROP TABLE conversation_report_messages` is the exact
shape of destruction this whole spec exists to prevent, and it would also silently break
`server/workers/retentionWorker.js:126`, whose subquery names the table by hand. They stay, frozen,
with a header comment saying so, and a later release drops them once the fold is verified against
the pilot database.

**Backfill (INSERT-only; nothing is deleted or updated):**

```sql
-- 1. Envelope. Ids are preserved: 'msg-report-…' is already unique and any external
--    reference to it stays valid.
INSERT INTO reports
  (id, reporter_id, target_type, target_id, category, description, status, priority, created_at)
SELECT cr.id, cr.reporter_id, 'conversation', cr.conversation_id,
       CASE cr.reason
         WHEN 'safety'        THEN 'something_feels_wrong'
         WHEN 'inappropriate' THEN 'bullying_or_harassment'
         WHEN 'spam'          THEN 'spam_or_advertising'
         ELSE 'other'
       END,
       cr.details,
       cr.status,
       CASE WHEN cr.reason = 'safety' THEN 'urgent' ELSE 'normal' END,
       cr.created_at
FROM conversation_reports cr
WHERE cr.id NOT IN (SELECT id FROM reports);   -- idempotent

-- 2. Evidence.
INSERT INTO report_evidence (report_id, message_id, sender_id, body, created_at)
SELECT crm.report_id, crm.message_id, crm.sender_id, crm.body, crm.created_at
FROM conversation_report_messages crm
WHERE NOT EXISTS (
  SELECT 1 FROM report_evidence re
  WHERE re.report_id = crm.report_id AND re.message_id = crm.message_id
);
```

The `WHERE ... NOT IN` / `NOT EXISTS` clauses are what make `up()` safe to re-run, which the
registry's idempotency test requires. The reason→category map is lossy in one direction only
(`inappropriate` covers more than bullying); `description` carries the reporter's own words, which
is the authoritative content. Note the mapping in the migration header so a moderator reading an
old report knows the category was derived.

**Uncertain:** whether the pilot database holds any `conversation_reports` rows at all. Unknown
from here. The backfill must be correct at zero rows, and the idempotency test must cover both zero
rows and a seeded row.

### 3.4 Nullability, and why each nullable column is nullable

| Column | Nullable | Why |
|---|---|---|
| `reporter_id` | **yes** — changed from `NOT NULL` | `ON DELETE CASCADE` today means the retention sweep purging a reporter's anonymised shell **destroys their reports** (`retentionWorker.js:148-160`). `SET NULL` + `reporter_name_snapshot` keeps the report and loses only the live link |
| `reporter_name_snapshot` | yes | `NULL` for pre-010 rows; fabricating one would be a fabricated record |
| `reported_user_id` | yes | Meaningless for `target_type='event'`. Populated at write time for `user`/`message`/`conversation`/`comment`/`announcement` by resolving the author; `NULL` for `event` and `certificate` |
| `reported_role_snapshot` | yes | Same as above. Stores `users.role` at report time so triage does not depend on a mutable column |
| `description` | yes | A student who taps a category and cannot type more must still be able to file. Youth Safety: *"You do not need proof. You do not need to be sure."* Requiring prose is a barrier at the exact moment it costs the most |
| `assigned_to`, `assigned_at` | yes | Unassigned is the normal state on a two-person team |
| `resolution`, `resolution_note`, `resolved_by`, `resolved_at` | yes | Absent until resolved. Enforced non-null **at the route** on transition to `resolved`/`dismissed` (§5.3), not by the schema — a CHECK spanning four columns is a rebuild every time the resolution enum grows |
| `category` | **no** | The one field that makes triage possible without reading prose. `'other'` is a legal value, so this is never a barrier |
| `target_id` | **no** | A report pointing at nothing is not a report |

**On "you can report anonymously" (§0.3).** `reporter_id` stays required at write time. In-app
reporting is *anonymous to the reported party* — which is what students actually fear and what
`ReportModal.jsx`'s existing copy already says (*"Reports are not shown to the person who posted
it"*) — but never anonymous to a moderator, because a moderator with no reporter cannot ask a
follow-up question and cannot detect report-bombing. The genuinely anonymous channel is the
published email address, which both policies already name. **This is a copy fix, not a schema fix:**
Youth Safety Guidelines and Community Guidelines must say "you can report anonymously by email" and
"the person you report is never told who reported them". Those files belong to another agent —
listed in §11 as a required cross-file change.

---

## 4. Report categories, in students' words

Stored values are stable snake_case and never displayed. Labels are what a 15-year-old sees.
Drafted from `docs/legal/policies/08-youth-safety-guidelines.md` §"What adults are not allowed to
do" and `03-community-guidelines.md` §"What does not [belong]", translated out of policy voice.

Exported from `server/moderation.js` as `REPORT_CATEGORIES` — one definition, imported by
`src/components/ReportModal.jsx` so the two cannot drift, the same pattern
`sensitiveActions.js` uses for the challenge header.

### 4.1 The list

**Pinned first — "I'm not sure, but something's off"**

| Stored | Label | Urgent |
|---|---|---|
| `something_feels_wrong` | Something feels wrong and I can't explain why | ● |

Pinned deliberately. Youth Safety: *"If a conversation makes you uneasy and you cannot say exactly
why, that is reason enough to report it."* Making the vaguest option the easiest one to pick is the
whole design.

**"I feel unsafe"**

| Stored | Label | Urgent |
|---|---|---|
| `asked_for_private_info` | Someone asked me for my phone number, address, or social media | ● |
| `asked_to_move_off_platform` | They want to talk somewhere else — text, Snap, Instagram, Discord | ● |
| `asked_to_keep_secret` | Someone asked me to keep this secret from my parents or teachers | ● |
| `asked_to_meet_alone` | Someone wants to meet me alone | ● |
| `comments_on_my_body` | Someone said something about my body or how I look | ● |
| `sexual_content` | Someone sent me something sexual, or asked me for photos | ● |
| `offered_gifts_or_substances` | Someone offered me money, gifts, vapes, alcohol, or drugs | ● |
| `threatened_me` | Someone threatened me, or said they'd hurt someone | ● |
| `pressured_about_my_place` | Someone said I'd lose my volunteer spot if I didn't do something | ● |
| `messages_not_about_the_event` | An adult is messaging me about things that have nothing to do with the event | ● |

**"Someone is being cruel"**

| Stored | Label | Urgent |
|---|---|---|
| `bullying_or_harassment` | Someone is being mean, piling on, or won't leave me alone | |
| `hate_or_discrimination` | Someone targeted me for my race, religion, disability, gender, sexuality, or where I'm from | ● |
| `shared_private_info` | Someone posted private information about me or someone else | ● |

**"Something is dishonest"**

| Stored | Label | Urgent |
|---|---|---|
| `pretending_to_be_someone` | This account is pretending to be someone else | |
| `fake_hours_or_certificate` | Someone's claiming hours they didn't work, or using a certificate that isn't theirs | |
| `spam_or_advertising` | Spam, ads, or recruiting for something that isn't volunteering | |

**Last**

| Stored | Label | Urgent |
|---|---|---|
| `other` | Something else — I'll explain | |

### 4.2 Presentation and per-target filtering

Eighteen options is too many to scan. The modal groups them under the four headings above, with
`something_feels_wrong` outside the groups at the top and `other` at the bottom, and **filters the
offered set by `targetType`**:

| targetType | Offered categories |
|---|---|
| `message`, `conversation` | everything |
| `user` | everything except `spam_or_advertising` |
| `comment`, `announcement`, `event` | cruelty group, `spam_or_advertising`, `shared_private_info`, `pretending_to_be_someone`, `something_feels_wrong`, `other` |
| `certificate` | `fake_hours_or_certificate`, `pretending_to_be_someone`, `other` |

The filter is UI-only. The server accepts any `REPORT_CATEGORIES` value for any target type — a
mismatch is a mis-tap, not an attack, and 400-ing a distressed student over a category/target
combination is worse than filing a slightly wrong report. **State this in the route's comment** so
nobody "tightens" it later.

### 4.3 Priority derivation

```js
export const URGENT_CATEGORIES = new Set([...]); // the ● rows above
```

`priority` is derived server-side from `category` at write time, never accepted from the client.
Two levels only — `urgent` and `normal`. A five-level scale on a two-person team is a field nobody
fills in consistently and every triage decision then distrusts. `urgent` means what Community
Guidelines publishes: *"Anything flagged as a safety concern is looked at the same day."*
`normal` means one business day.

A moderator may raise or lower `priority` afterwards via `PATCH` (§5.3); every change writes a
`prioritised` history row. That is the escape hatch for the cases derivation gets wrong, and it
leaves a record of who overrode what.

**The obvious abuse:** eleven of eighteen categories self-select into the urgent lane, and
`something_feels_wrong` needs no prose. Flooding the urgent lane is trivially available to any
student. Mitigations in §9.1 — rate limit, duplicate index, and target-grouping in the queue. This
is accepted residual risk: the alternative is making the safety categories harder to reach, which
inverts the priority.

---

## 5. Routes

### 5.1 Reporting (student-facing)

#### `POST /api/reports` — extended

- **Gate.** `authenticateToken` only. The guard-2 `ROUTE_REGISTRY` entry at
  `server/authz.completeness.test.js:692` **must be updated** — its reason still says
  "any event/comment". New reason: `'any signed-in user may report any surface; no capability
  distinction by design (abuse-reporting entry point). Target visibility is checked in the handler
  and refusals are uniform — see §5.1'`. Category stays `OPEN_TO_AUTHENTICATED`.
- **Limiter.** New `reportLimiter`, mounted in `server/app.js` (§9.1).
- **Request.**
  ```
  { targetType, targetId, category, description? }
  ```
  Accept `reason` as a deprecated alias for `description` and map it. `src/utils/api.js:632`
  currently sends `{targetType, targetId, reason}` and `src/` is being edited concurrently by
  another agent — a server that 400s the shipped client is a self-inflicted outage.
- **Validation, in order.**
  1. `targetType` in the seven values → else 400.
  2. `category` in `REPORT_CATEGORIES` → else 400 **with the valid list in the response**.
  3. `description`, if present, a string ≤ 2000 chars (raised from the existing 1000 — a student
     describing a grooming conversation needs room) → else 400.
  4. `targetId` a non-empty string → else 400. (Keeps the existing type check at
     `contentRoutes.js:613`; a non-string is unbindable by `node:sqlite` and would 500.)
  5. **Target resolution and self-report refusal** — see below.
- **Target resolution.** Resolve `reported_user_id` and `reported_role_snapshot` from the target:
  `message`→`messages.sender_id`; `conversation`→ the other participant; `comment`→
  `event_comments.user_id`; `announcement`→`event_announcements.author_id`; `user`→`target_id`;
  `event`→`NULL` (an event is a listing, not a person); `certificate`→`NULL`.
  If the resolved user is the caller → **400** `'You cannot report yourself.'` (matching the
  existing self-block refusal at `messageRoutes.js:467`).
- **Existence and the enumeration oracle.** Follow the established precedent at
  `server/messaging.js:116-144` — *collapse the two answers*:
  - For `message`, `conversation`, `comment`, `announcement`, `event`: verify the caller can
    **see** the target (conversation participation for the first two; event visibility for the
    rest). Not-visible and not-existing return **the identical 404** `'We could not find what you
    are reporting.'` Distinguishable codes here would be an existence oracle over a platform of
    minors, which is the exact leak `messaging.js` already fixed once.
  - For `user`: **no existence check at all**, and therefore no oracle. Report accepted; the queue
    renders `'Deleted or unknown account'` at read time, exactly as the existing queue already does
    for deleted events (`adminRoutes.js:223`).
  - For `certificate`: **shape check only** (`/^WEV-[A-Z2-9]{4}-[A-Z2-9]{4}$/`, matching
    `certificates.js`'s generator). Do **not** look the code up. Validating existence would turn
    the report endpoint into a certificate-code oracle, and the codes are bearer credentials
    (`server/certificates.js:47-52`).
- **Duplicate handling.** `idx_reports_no_dup` will raise on a second live report of the same
  target by the same reporter. Catch it and return **200** with the original `reportId` and
  `duplicate: true`. Never a 409: telling a student "you already reported this" is fine; making it
  an error page after they worked up to tapping the button is not.
- **Evidence snapshot.** For `targetType='message'`, snapshot the message plus up to 10 messages
  before and 10 after **within the same conversation**, into `report_evidence`. Context is what
  makes a single line readable — "sure, whatever you want" means nothing alone. For
  `targetType='conversation'`, snapshot the whole thread up to a hard cap of 500 messages, and
  record `detail: 'truncated at 500'` on the `filed` history row when the cap bites. The current
  10/20 cap is why message 11 of a reported conversation is swept today (§0.2 #5).
- **History.** One `moderation_actions` row, `action='filed'`, `actor_id = reporter`. This is why
  `actor_id` is not named `moderator_id`.
- **Notification.** **None, to anybody.** The reported party is never told a report exists —
  telling them converts a safety control into a provocation, the same reasoning
  `messaging.js:146-159` gives for not revealing a block. Moderators learn from the queue. (A
  moderator email alert on `priority='urgent'` is worth having and is listed as deferred in §5.7.)
- **Response.** `201 { success: true, reportId, duplicate: false }`. Nothing about the target,
  ever.
- **Transaction.** The `reports` insert, the `report_evidence` rows and the `moderation_actions`
  row in one `inTransaction()`. A report with no history row is a report nobody can audit.

#### `POST /api/messages/conversations/:id/report` — reimplemented, path kept

Rewrite the body to write `reports` + `report_evidence` + `moderation_actions` (via a shared
`server/moderation.js` helper with `POST /api/reports`), and stop writing `conversation_reports`.

**Keep the path.** It is the button both policies point every student at, and changing a URL in the
same release as a table rebuild is two risks wearing one commit. Keep the existing
`{reason, details, messageIds}` request shape working — map `reason` through §3.3's table and
`details`→`description` — and additionally accept `{category, description}`. Deprecate in a later
release.

#### `POST /api/messages/:id/report` — new

Thin wrapper over `POST /api/reports` with `targetType='message'`. Exists so the UI can put a
report affordance on one message without the client having to know the generic shape. Same gate,
same limiter, same `ROUTE_REGISTRY` treatment (`OPEN_TO_AUTHENTICATED`, reason: participation is
checked in the handler and refusals are uniform).

### 5.2 `GET /api/admin/reports` — the queue

- **Gate.** `requireCap('report.resolve')`.
- **Query.** `status` (csv, default `open,reviewing`) · `priority` · `category` · `targetType` ·
  `assignee` (`me` | `unassigned` | a user id) · `q` (substring over `description` and
  `reporter_name_snapshot`) · `limit` (default 50, max 200) · `cursor` (opaque
  `created_at|id`, keyset — offsets skip rows when a report is filed mid-scroll).
- **Ordering.** `priority = 'urgent' DESC, created_at ASC` within `open`/`reviewing` — **oldest
  first**, which is the opposite of the current `created_at DESC` (`adminRoutes.js:216`). A
  newest-first queue on a small team starves the oldest report, and "reaches a human within one
  business day" is a promise about the *oldest* item.
- **CRITICAL — `LEFT JOIN`, not `JOIN`.** The current query inner-joins `users` on
  `reporter_id` (`adminRoutes.js:213`). With `reporter_id` now nullable (§3.4), an inner join makes
  reports **silently vanish from the queue** — the quietest possible failure and the one a
  moderator cannot notice. Use `LEFT JOIN` and coalesce:
  `COALESCE(u.name, r.reporter_name_snapshot, 'Account since deleted')`. Same for `assigned_to` and
  `resolved_by`. A test must assert a report with a NULL `reporter_id` still appears.
- **Target enrichment.** Extend the existing switch (`adminRoutes.js:220-228`) to all seven types.
  Every branch has an explicit "deleted or unknown" fallback — never `undefined`, which renders as
  a blank cell a moderator reads as "nothing wrong here".
  **Message and conversation targets return no body text here.** The list view shows
  `"3 messages preserved"`; bodies come only from §5.4, which logs.
- **Response.** `{ reports: [...], counts: { open, reviewing, urgentOpen, assignedToMe }, nextCursor }`.
  The counts are the whole dashboard for a one-person team.

### 5.3 `PATCH /api/admin/reports/:id` — assign, prioritise, resolve

- **Gate.** `requireCap('report.resolve')`.
- **Body.** Any subset of `{ status, priority, assignedTo, resolution, resolutionNote }`.
- **Rules.**
  - `assignedTo` may be `null` (unassign), `'me'`, or a user id that holds `report.resolve`
    (checked with `can(principalFor(row), 'report.resolve')` — **never** a role comparison; guard 1
    fails the build on that).
  - Transition to `resolved` or `dismissed` **requires** `resolution` (from the enum in §2.2) and
    `resolutionNote` of ≥ 20 characters → else 400 `code: 'resolution_note_required'`. Mirrors the
    `MIN_SUSPENSION_REASON` precedent at `adminRoutes.js:493, 576-581`, and for the same reason: it
    is what an appeal is reviewed against.
  - `resolved` → `open` is a **reopen**, allowed, and writes `action='reopened'`. There is no
    silent reopen: the history row is written in the same transaction as the status change.
  - `resolved_by` and `resolved_at` are stamped server-side, never accepted from the client.
- **Conflict of interest.** Refuse **403** `code: 'conflict_of_interest'` when the actor is the
  subject of the report — `reported_user_id === actor`, or the target is an `event` the actor
  organizes, or a `comment`/`announcement`/`message` the actor authored. Applies to `assignedTo`
  (self-assignment), `status` and `resolution`; reading is allowed, because a moderator has to be
  able to see what was said about them.
  **Escalation path when it fires:** only a principal holding `admin.create` (SUPER_ONLY, i.e.
  super_admin) may act. When the super_admin is themselves the subject there is **no on-platform
  path**, by design — the resolution is off-platform, at the district. Community Guidelines already
  publishes the honest note about not guaranteeing an independent reviewer; self-review is a
  different and worse thing, and this refusal is what separates them.
  *This cascade must be ordered most-privileged-first and end in an explicit deny*
  (`server/authz.js:13-31`), because `can()` is true for every capability a super_admin asks about.
- **Writes, one transaction.** the `reports` UPDATE · one `moderation_actions` row per field
  changed (assign / prioritise / resolve are three separate history entries, not one blob) ·
  `recordAudit` with `action='MODERATE_REPORT'`. Keep the existing audit shape and its comment
  (`adminRoutes.js:258-277`) — including `target_user_id` being the *reporter* — but **add**
  `reported_user_id` to the `details` string, because "who this was about" is the question the
  current audit row cannot answer.

### 5.4 `GET /api/admin/reports/:id` and `/conversation` — evidence, and the logging promise

#### `GET /api/admin/reports/:id`

`requireCap('report.resolve')`. Returns the report, its resolved target, its
`moderation_actions` history, and **evidence metadata only** — counts and timestamps, no bodies.

#### `GET /api/admin/reports/:id/evidence`

`requireCap('report.evidence.read')` (new, §8). Returns `report_evidence` bodies for this report.
Writes `action='evidence_viewed'` with `detail` naming the count. **This route is the fix for
§0.2 #2** — it is the first and only way a moderator can read a private message body, and it logs,
which is what Youth Safety Guidelines already promises in print.

#### `GET /api/admin/reports/:id/conversation`

`requireCap('report.evidence.read')`. Reads the **live** conversation behind a report, paginated
like the participant route. Preconditions, all four:

1. the report's `target_type` is `conversation`, or `message` whose message belongs to a
   conversation;
2. the report's `status` is `open` or `reviewing` — a resolved report does not license further
   reading;
3. writes `action='evidence_viewed'`, `detail='live conversation, N messages'`, **before**
   returning, in the same transaction;
4. **the report id is in the path.** There is no `/api/admin/conversations/:id/messages`. Deriving
   the conversation from `reports.target_id` makes "a moderator may only read a reported
   conversation" structural rather than a validated parameter — the roadmap's `:id`-is-the-
   conversation shape puts the whole rule in an `if`, and §1 is the reason not to.

Redacted messages are returned **in full** to this route, with `redactedAt`/`redactedBy` attached.
That is the point of a tombstone.

### 5.5 `POST /api/admin/reports/:id/notes` and `GET .../history`

`requireCap('report.resolve')`. `notes` appends `action='note'` (1–2000 chars, required).
`history` returns `moderation_actions` for the report, oldest first, with actor names resolved
through a `LEFT JOIN`. Neither has a mutation path — the triggers in §3.1 mean there could not be
one.

### 5.6 `POST /api/admin/reports/:id/escalate`

`requireCap('report.resolve')`. Sets `priority='urgent'`, appends `action='escalated'` with a
required note, and enqueues one email to the configured safety address via `notification_jobs`.

**It does nothing else, deliberately.** The mandated-reporting duty under N.J.S.A. 9:6-8.10 is a
**phone call a human makes** (Youth Safety §Mandated reporting: *"Reporting to WeVolunteer does not
satisfy your legal duty"*). A button that looks like it discharges a legal duty is worse than no
button. The response body says so in the copy the moderator sees, and the escalation email
includes the DCP&P number.

### 5.7 Deliberately omitted, and why

| Omitted | Why |
|---|---|
| Round-robin / load-balanced auto-assignment | Two people. `assignee=unassigned` is the whole routing algorithm |
| SLA timers, breach alerts, escalation queues | `counts.urgentOpen` and oldest-first ordering give the same information with no clock to maintain. A timer that fires at 2am for a two-person team trains people to ignore alerts |
| Priority levels beyond urgent/normal | §4.3 |
| Canned responses / macros | Nothing sends the reporter a message yet. Templates before a delivery channel is scaffolding |
| Bulk actions | Bulk-resolve is the one operation that makes "read before you decide" skippable, on the exact surface where skipping is most costly. Add it when the queue is measured in hundreds |
| Separate `escalations` table | An `escalated` row in `moderation_actions` plus a `priority` change carries the same facts, and the real escalation is off-platform |
| Enforced reviewer independence on appeals | Cannot be delivered by a two-person team and Community Guidelines already says so in print. §7.4 specifies the separable capability that makes it *possible*, not mandatory |
| Moderator email alert on a new urgent report | Genuinely wanted; deferred only because it needs a configured address and an on-call expectation. First follow-up after this spec ships |
| Automated content classification | Youth Safety promises *"Reports are not triaged by software."* Building a classifier contradicts a published statement |
| Reporter-facing outcome notification | Community Guidelines promises *"We tell you what happened."* Needs a delivery channel and a redaction rule for what a reporter may be told. §11 |

---

## 6. Redaction and evidence preservation

`server/migrations/012_content_redaction.js`. Additive.

### 6.1 DDL

```sql
ALTER TABLE messages           ADD COLUMN redacted_at TEXT;
ALTER TABLE messages           ADD COLUMN redacted_by TEXT;
ALTER TABLE messages           ADD COLUMN redaction_report_id TEXT;
ALTER TABLE event_comments     ADD COLUMN redacted_at TEXT;
ALTER TABLE event_comments     ADD COLUMN redacted_by TEXT;
ALTER TABLE event_comments     ADD COLUMN redaction_report_id TEXT;
ALTER TABLE event_announcements ADD COLUMN redacted_at TEXT;
ALTER TABLE event_announcements ADD COLUMN redacted_by TEXT;
ALTER TABLE event_announcements ADD COLUMN redaction_report_id TEXT;
```

Guard each with the `PRAGMA table_info` check 006 uses (`006_account_suspension.js:78-88`) —
SQLite's `ADD COLUMN` has no `IF NOT EXISTS` and the registry's idempotency test re-runs `up()`.
No FKs on `redacted_by`/`redaction_report_id`: an FK to `reports` with CASCADE would let deleting a
report un-redact content, and with RESTRICT would block cleanup. The values are recorded facts,
and `moderation_actions` is the authoritative link.

`event_announcements` gets the columns now — they are free, and adding them later is a second
migration. Its redaction *route* is deferred (§11); the columns exist so the reads in §6.2 can
treat all three surfaces the same from day one.

**Body is never modified.** Redaction sets timestamps. `messages.body` keeps the original text
permanently. That is the tombstone: the content stops being displayed, the proof stops being
deletable.

### 6.2 Reads

- Participants (`GET /api/messages/conversations/:id/messages`): `formatMessage` returns
  `body: null, redacted: true, redactedAt` when `redacted_at IS NOT NULL`. The client renders
  *"A moderator removed this message."* The message is **not** filtered out of the list — a
  silently vanishing message reads as a bug, and the gap in a conversation is itself information
  the participants are entitled to.
- Unread counts, `last_message_id`, and search
  (`server/routes/messageRoutes.js:298-326`, `server/messaging.js:281-297`) must all exclude
  redacted bodies. **The search route is the leak that matters:** it `LIKE`s over `m.body`
  (line 310) and returns a 180-char snippet (line 319), so without a `AND m.redacted_at IS NULL`
  clause a participant retrieves the exact text a moderator just removed. Same for
  `decorateConversation`'s `lastMessage` (`messaging.js:217-219`).
- `report.evidence.read` holders: full body, plus redaction metadata (§5.4).

### 6.3 The retention interaction — the part that must not be got wrong

`server/workers/retentionWorker.js:123-127` today:

```sql
DELETE FROM messages
WHERE created_at < ?
  AND id NOT IN (SELECT message_id FROM conversation_report_messages)
```

Three separate holes, two of them live before redaction exists:

1. the snapshot is capped, so message 11 of a reported conversation is swept (§0.2 #5);
2. a `target_type='message'` or `'conversation'` report exempts nothing at all;
3. after 012, a redacted message's body is the only surviving proof, and nothing exempts it.

Replace the exemption with **one exported helper** so there is a single definition and a single
test surface — the same reasoning `sensitiveActions.js` gives for one definition of the challenge
header:

```js
// server/moderation.js
/**
 * SQL predicate: true for a message the retention sweep may delete.
 * ONE definition. A second copy of this logic is a second way to destroy evidence.
 */
export const RETAINABLE_MESSAGE_PREDICATE = `
  id NOT IN (SELECT message_id FROM conversation_report_messages)
  AND id NOT IN (SELECT message_id FROM report_evidence)
  AND id NOT IN (SELECT target_id FROM reports
                 WHERE target_type = 'message' AND $EVIDENCE_STILL_LIVE)
  AND conversation_id NOT IN (SELECT target_id FROM reports
                 WHERE target_type = 'conversation' AND $EVIDENCE_STILL_LIVE)
  AND redacted_at IS NULL
`;
```

where `$EVIDENCE_STILL_LIVE` is

```sql
(status IN ('open','reviewing') OR resolved_at IS NULL OR resolved_at > :evidenceCutoff)
```

**Why a bound and not a blanket exemption.** An unbounded exemption is a *second* published-policy
violation, in the other direction: the Privacy Policy publishes a 3-year message period, and
"except any message anyone ever reported, kept forever" is not that. So:

```js
// server/workers/retentionWorker.js
RETENTION.moderationEvidenceDays = 365;   // after a report is resolved
```

- Evidence for an `open` or `reviewing` report: exempt, **unconditionally and indefinitely**. An
  open report is an unfinished investigation and nothing may delete under it.
- Evidence for a `resolved`/`dismissed` report: exempt until `resolved_at + 365 days`, then swept
  normally — so both the 3-year floor **and** the evidence period must have elapsed.
- **Redacted messages: exempt while `redacted_at IS NOT NULL`, full stop.** A redacted message
  whose body is deleted leaves an author accused of writing something nobody can produce. The
  bounded release for these is un-redaction, which is a deliberate moderator act with a history
  row — not a timer.
- Snapshotted bodies in `report_evidence` and `conversation_report_messages` are **never** swept
  (they *are* the record; the live message is the copy).

`conversation_report_messages` stays in the predicate. Dropping it because 011 folded the table
would silently un-exempt every legacy snapshot.

### 6.4 `PRESERVED_TABLES` and the shell purge

Add `reports` and `moderation_actions` to `PRESERVED_TABLES`
(`server/workers/retentionWorker.js:55`). `assertPreservedTablesUntouched` then makes it an
assertion rather than an intention, which is what that function exists for (lines 172-194).
`report_evidence` too.

`moderation_actions.actor_id` is `ON DELETE RESTRICT`, so the shell purge at lines 148-160 will now
**throw** on an account that has moderated anything — a hard failure of the nightly sweep. Two
changes:

```sql
-- add to the `purgeable` subquery
AND id NOT IN (SELECT actor_id FROM moderation_actions)
AND id NOT IN (SELECT reported_user_id FROM reports
               WHERE reported_user_id IS NOT NULL AND status IN ('open','reviewing'))
```

The second clause is independently necessary: purging the shell of a person with an unresolved
report against them destroys the subject of a live investigation.

The Privacy Policy must publish the moderation-record period. That file belongs to another agent —
§11.

---

## 7. Account enforcement — deltas only

Suspension already works. `006_account_suspension.js` + `adminRoutes.js:563-691` +
`routes.suspension.test.js` (25 cases) already deliver reason (≥10 chars, mandatory), audit row,
`token_version` bump, six correct refusals, and preservation of the suspended organizer's
volunteers' hours. **Do not respecify any of that.** Four deltas:

### 7.1 Report linkage — `POST /api/admin/users/:id/suspend`

Optional `reportId` in the body. When present: validate the report exists, apply §5.3's
conflict-of-interest refusal to it, and append `moderation_actions { report_id, action:'user_suspended',
target_user_id: targetId, detail: reason }` **inside the existing `inTransaction`**
(`adminRoutes.js:597-614`). Nothing new on `users`: `moderation_actions.target_user_id` is how an
appeal reviewer finds the report that produced a suspension, which is why that column is on the
history table (§3.1).

### 7.2 Duration — `migration 013`

```sql
ALTER TABLE users ADD COLUMN suspended_until TEXT;   -- NULL = indefinite
```

Community Guidelines step 3 publishes *"Suspension — you cannot sign in, for a stated period"*, and
every suspension today is indefinite because there is nowhere to state a period. Body gains
`durationDays?` (integer 1–365, or omitted for indefinite).

**Enforcement uses two mechanisms, and the split is the point:**

- **Sign-in and `authenticateToken` refuse only while the suspension is live** —
  `account_status = 'suspended' AND (suspended_until IS NULL OR suspended_until > now)`.
  This is a **read-only** change to `server/utils.js:164` and to both sign-in paths. Do **not**
  auto-lift here: a write inside the authentication path is a new failure mode on every request in
  the application, and it would produce an unaudited state change with no actor.
- **A daily job lifts expired suspensions** — clears the four columns, bumps nothing, writes
  `ACCOUNT_UNSUSPENDED` via `recordAudit`, appends `moderation_actions`, and emails the user. Put
  it beside `startRetentionWorker` (`retentionWorker.js:203-240`), same `sweep(db, {now})` shape so
  the boundary cases are ordinary unit tests. **`admin_id` is `NOT NULL` with an FK to `users`**
  (`auditLog.js:133-136`), so a system actor cannot write an audit row — the retention worker
  documents exactly this at lines 215-229. The lift therefore records to
  `moderation_actions`… which has the same problem (`actor_id NOT NULL`). **Resolution:** record
  the *original suspending admin* as the actor with
  `detail: 'automatic lift at end of stated period'`. They are the person whose decision this
  carries out, and it is a true statement. Note it in the migration header.

The read-only sign-in check is what makes a stalled job under-punish rather than over-punish. Both
mechanisms, for that reason.

### 7.3 Notification — the delta that matters most

**Nothing tells a suspended user anything today.** They discover it at the next sign-in, with
`'Account is suspended'` and no reason, no period, and no appeal route.

**It must be email, and `notifications` is useless here** — a suspended account cannot pass
`authenticateToken` (`utils.js:164`), so it can never read `GET /api/notifications`. Enqueue a
`notification_jobs` row (channel `email`) inside the suspension transaction, carrying:

- the reason (already mandatory, already ≥10 chars, already written for exactly this purpose —
  `006_account_suspension.js:44-51`);
- the stated period, or that it is indefinite;
- **the appeal link with its token** (§7.5). This is why the token path and the notification are one
  delta, not two.

Same on unsuspend. And the email must go through the escaping path
`server/email.escaping.test.js` already guards — the reason is admin-authored text landing in an
HTML mail.

### 7.4 Unsuspend reason — a recommendation with a named cost

Recommend requiring `reason` on `POST /api/admin/users/:id/unsuspend` at the same
`MIN_SUSPENSION_REASON` threshold. An unsuspension with no stated reason is how a favour gets done
quietly, and it is the one moderation action currently possible with no explanation.

**Cost, stated plainly:** `routes.suspension.test.js:258` ("restores the account and clears the
suspension detail") and probably 275 and 285 call the route with no body and will fail. That is not
an accident to work around — changing those three assertions *is* the deliberate part of this
change, and it needs the security review any authz-adjacent diff needs. **Flagged as a decision for
the implementer and reviewer, not a settled instruction.**

### 7.5 Warnings

Community Guidelines step 2 is *"A warning on your account"*, and there is no such thing. Minimum
viable: `moderation_actions { action: 'warning_issued', target_user_id }` plus a
`createNotification` (a warned user is **not** suspended, so the in-app channel works) plus an
email. No new table, no new column on `users` — "how many warnings does this person have" is
`SELECT COUNT(*) FROM moderation_actions WHERE target_user_id = ? AND action = 'warning_issued'`,
and the history table is already append-only and index-covered for it.

Route: `POST /api/admin/reports/:id/warn`, body `{ targetUserId, message }`,
`requireCap('report.resolve')`, §5.3's conflict-of-interest refusal applies.

---

## 8. Capabilities

Add three to `server/authz.js`'s `CAPABILITIES.admin`. `super_admin` needs nothing —`'*'` covers
it. `partner`, `organizer` and `student` get none of them.

| Capability | Roles | Why separate from `report.resolve` |
|---|---|---|
| `report.evidence.read` | admin | Reading a student's private messages is the single most invasive power on the platform. Splitting it means a per-user grant (`capability.grant`, migration 002) can create a **triage-only** helper who sorts the queue and never reads a DM. Costs nothing today — same roles — and is the only way that grant is ever possible |
| `content.redact` | admin | Suppressing content is a different act from deciding a report. Separable for the same reason |
| `appeal.review` | admin | The closest this platform can get to Community Guidelines' independence note: a grant can hand appeal review to someone who is not the moderator who decided. Not enforced (§5.7) — made possible |

None go in `SUPER_ONLY`: `SUPER_ONLY` capabilities are unreachable by per-user grant
(`server/authz.js:152-155`), and grantability is the entire reason these three exist as separate
names.

Required companion edits, each of which fails the build if missed:

- `src/authz.js` re-exports the table into the client bundle — verify the re-export needs no change
  (it should not; it re-exports the module).
- `server/authz.test.js` may assert `ALL_CAPABILITIES` contents. Update if so.
- `App.jsx` `NAV`: one entry, `requiredCap: 'report.resolve'`. Every entry **must** declare
  `requiredCap` or a non-empty `requiredCapAny` or a boot-time loop throws.
- `server/authz.completeness.test.js`: guard 2's `ROUTE_REGISTRY` needs entries for
  `POST /api/messages/:id/report` and the two unauthenticated appeal routes (which never reach
  `authenticateToken` and so will not appear in the walk — confirm rather than assume), and the
  existing `POST /api/reports` reason needs updating (§5.1).

No new `requireAAL2` gates. Step-up re-authentication guards actions against a **stolen session**;
every moderation route is already behind a capability only a handful of accounts hold, and adding a
gate obliges a paired `spendChallenge` (guard 5) on a surface a moderator uses dozens of times an
hour. **Uncertain, worth a reviewer's opinion:** `POST /api/admin/users/:id/suspend` is arguably
sensitive enough to justify one. Not specified here; it would need a `sensitiveActions.js` registry
entry and both halves of the gate/spend pair.

---

## 9. Abuse and griefing analysis

### 9.1 Per endpoint

| Endpoint | Abuse case | Mitigation |
|---|---|---|
| `POST /api/reports` | **Report-bombing** — one student files hundreds, burying a real report | New `reportLimiter`: 20 / 24h, keyed on the **hashed user id, not the IP** (the campus-NAT reasoning documented on `mailLimiter`, `app.js:347-362`, applies with full force to a school). Successes counted. Plus `idx_reports_no_dup`. Plus the queue groups by `(target_type, target_id)` so 40 reports of one thing is one row with a count |
| `POST /api/reports` | **Report-bombing a person** — 20 reports against 20 different targets still clears the per-user limit | Queue groups by `reported_user_id` as well, and shows `reporterCount` distinctly from `reportCount`. Twenty reports from one reporter reads visibly differently from twenty reporters |
| `POST /api/reports` | **Retaliatory reporting** — an organizer reports the student who reported them | `server/moderation.js` computes a **cross-report flag**: an open report in the opposite direction between the same pair. Both surface linked in the queue with an explicit "these two reported each other" banner. Not auto-resolved — sometimes both are true |
| `POST /api/reports` | **Unmasking** — using the report flow to learn whether an account, event or certificate exists | Uniform 404 for visibility-scoped targets; **no existence check at all** for `user` and `certificate`; no target detail in any response. §5.1 |
| `POST /api/reports` | **Provocation** — filing a report to make the target aware they are being watched | Nothing notifies the reported party, ever. §5.1 |
| `POST /api/reports` | Storage exhaustion via 2000-char descriptions | Bounded by the rate limit: 20 × 2 KB per user per day |
| `POST /api/blocks/:userId` | **No rate limit today.** Unbounded writes to `user_blocks` **and** unbounded `admin_audit_logs` rows (`messageRoutes.js:490-497` writes an audit row per new block) — audit-log flooding is the worse half, because it dilutes the trail moderation depends on | New `blockLimiter`: 30 / 24h per hashed user id. Mount `app.use('/api/blocks', blockLimiter)` |
| `POST /api/blocks/:userId` | **Enumeration oracle** — 404 for unknown/deleted vs 200 for real (`messageRoutes.js:471-472`), walkable over arbitrary ids by any student | **Recommended:** scope the target set to users the caller shares a conversation or an application with — the only set a student can legitimately need — and return the same 404 outside it. Removes the oracle and is semantically right, since contact on this platform requires an application relationship. **Trade-off, stated:** Youth Safety says *"You do not need permission, and you do not have to explain why"* — scoping does not require an explanation, but it does narrow the set. **Marked as a decision, not settled** |
| `POST /api/blocks/:userId` | **Blocking to evade accountability** | Structurally bounded, verified: organizers cannot block (`event.apply`, `messageRoutes.js:464`); student↔student DMs do not exist (`conversations` is keyed `(student_id, organizer_id, event_id)`); and a block does not stop the blocked party reporting the conversation, because reporting needs participation, not writability (`messageRoutes.js:328-334`). Additionally: `GET /api/admin/reports/:id/conversation` is exempt from block checks — a moderator must reach both parties precisely when a block exists, the same exemption `messaging.js:146-159` already makes |
| `PATCH /api/admin/reports/:id` | **Moderator self-dealing** — resolving or dismissing a report about yourself, your event, or your comment | §5.3's `conflict_of_interest` 403, covering resolve, dismiss **and self-assignment**. Escalates to `admin.create` only; no on-platform path when the super_admin is the subject, and that is stated rather than papered over |
| `PATCH /api/admin/reports/:id` | Quiet reopen-and-redecide to bury an outcome | `reopened` history row in the same transaction; `moderation_actions` is UPDATE/DELETE-proof by trigger (§3.1) |
| `GET .../evidence`, `.../conversation` | **Moderator curiosity** — reading students' DMs with no report | Structural: the report id is in the path, `target_type` must match, status must be `open`/`reviewing`, and every read appends `evidence_viewed`. A moderator who wants to read a conversation must first file a report against it — under their own name |
| `POST .../redactions` | Redaction used to destroy inconvenient evidence | Body is never modified; `redacted_at` is a tombstone; the retention sweep **exempts** redacted messages (§6.3); un-redaction is available and audited |
| `DELETE /api/comments/:id` | **Existing evidence-destruction path** — the author (or a moderator) hard-deletes a comment that is the target of an open report | Refuse **409** `code: 'under_review'` when an `open`/`reviewing` report targets that comment, and point the caller at redaction. This is not new functionality; it is closing a hole redaction would otherwise sit beside |
| `POST /api/appeals/token/:token` | Unauthenticated write; token brute force; mail flooding | Single-use, `crypto.randomBytes(32)` hex, 30-day expiry, one live token per user. `appealLimiter` (5 / hour per IP) **plus** `mailIpCeilingLimiter`, mounted like `/api/auth/reset-password` (`app.js:494`). Uniform response whether the token is unknown, expired or spent — a differentiated 404 is a token oracle |
| `POST /api/appeals/token/:token` | An appeal statement used to reach a moderator with abuse | The statement is text in a moderation UI. Rendered as text (§10), capped at 5000 chars, and the appeal shares the report's history trail |
| All admin routes | Stored XSS against a privileged session | §10 |

### 9.2 Two abuse cases with no clean mitigation, stated rather than hidden

- **A single moderator on a two-person team.** Every conflict-of-interest refusal escalates to
  super_admin, and when the platform has one admin who is also the super_admin, the refusal has
  nowhere to send the report. There is no software fix. The mitigation is the append-only trail plus
  the published honest note, and the district as the off-platform escalation.
- **Report-bombing the urgent lane.** §4.3. Eleven of eighteen categories self-select as urgent and
  `something_feels_wrong` needs no prose. Accepted, because the alternative — making safety
  categories harder to pick — inverts the priority. The rate limit and target-grouping bound the
  damage; they do not eliminate it.

---

## 10. The moderator dashboard is where stored XSS lands

Say it in the spec because it is the one place in this application where hostile text authored by a
user is rendered to a session holding `report.resolve`. Every field on the surface is
attacker-controlled: `description`, `reporter_name_snapshot`, message bodies, comment bodies,
profile bios, event titles, appeal statements.

Four requirements:

1. **Never `dangerouslySetInnerHTML` on this surface.** React escapes by default; the only way to
   lose that is to opt out.
2. **Add a fourth static client guard**, `src/noDangerousHtml.test.js`, in the style of
   `tokens.test.js` / `noHardcodedColors.test.js` / `noDanglingClasses.test.js`: no
   `dangerouslySetInnerHTML`, no `innerHTML =`, no `document.write`, anywhere in `src/`. **No
   allowlist** — that is what makes the existing three guards work. Build-failing, cheap, and it
   protects the whole app rather than one view.
3. **CSV export.** Any moderation export must reuse `sanitizeCsv`
   (`adminRoutes.js:304-310`), which prefixes `=+-@\t\r`. A moderator opening a report export in
   Excel is a formula-injection target, and the existing helper is currently used in exactly one
   place — copying it is the failure mode.
4. **Email templates.** Escalation mail, suspension mail and appeal mail all interpolate
   user-authored text into HTML. Route them through the path
   `server/email.escaping.test.js` already guards, and extend that test to the new templates.

---

## 11. Appeals

### 11.1 The reachability problem, verified

`server/utils.js:164`:

```js
if (userRow.account_status === 'suspended') return res.status(403).json({ error: 'Account is suspended' });
```

Before `req.user`, before `req.principal`, before any allowlist. **A suspended account cannot reach
any authenticated route.** `EMAIL_GATE_ALLOWLIST` is not an analogue — it is consulted on an
already-authenticated request (§0.2 #4).

### 11.2 Options considered

- **(a) Signed single-use token, emailed with the suspension notice, unauthenticated route.**
- **(b) An `allowSuspended` variant of `authenticateToken` mounted on the appeal routes.**
- **(c) Fully unauthenticated form plus an email round-trip to prove address ownership.**

**Chosen: (a).**

**Why not (b).** It means teaching the most security-critical middleware in the application to mint
a `req.principal` for a suspended account. From that moment, "a suspended account has a principal"
is a state every one of the ~14 route modules must be trusted to refuse, forever, and the thing
that currently guarantees it — one early return — is gone. Any future route that forgets is a
suspended abuser back on the platform. The 403 at line 164 is the cheapest correct check in the
codebase and it should not acquire an exception.

**Why not (c).** It is (a) with a worse first step: the round-trip mail *is* the token, and doing it
on demand adds an unauthenticated endpoint that accepts an arbitrary email address — a mail cannon
and an account-existence oracle in one.

**Why (a) works.** The suspension notification must be sent anyway (§7.3), so the token rides on a
mail that already has to exist. The token is bearer-only, scoped to one action, single-use, expiring
— the same shape as `password_reset_tokens` (`db.js:712-719`), which is already reviewed and
tested. And it needs **zero** change to `authenticateToken`.

**Residual limitation, stated rather than glossed.** A suspended account whose email address is
wrong or unreachable cannot use the token path. Fallback is the published address both policies
already name. Every OAuth account has an email, so provider-only accounts are covered; an account
with a typo'd address is not, and there is no mechanism that would cover it without reintroducing
(c)'s oracle.

### 11.3 Migration 013 — `appeals` and `appeal_tokens`

```sql
CREATE TABLE IF NOT EXISTS appeals (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  subject      TEXT NOT NULL CHECK(subject IN ('suspension','content_removal','report_outcome')),
  subject_ref  TEXT,                       -- report id, message id, or NULL for a suspension
  statement    TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open'
                 CHECK(status IN ('open','reviewing','upheld','overturned','withdrawn')),
  reviewer_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  decision     TEXT CHECK(decision IS NULL OR decision IN ('upheld','overturned','partial')),
  reasoning    TEXT,
  created_at   TEXT NOT NULL,
  decided_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_appeals_queue ON appeals(status, created_at);
CREATE INDEX IF NOT EXISTS idx_appeals_user  ON appeals(user_id, created_at);

CREATE TABLE IF NOT EXISTS appeal_tokens (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_appeal_tokens_user ON appeal_tokens(user_id);
```

- `ON DELETE RESTRICT` on `appeals.user_id`: an appeal is the record of a person contesting an
  enforcement action, and deleting the account must not delete their side of it.
- `ON DELETE CASCADE` on `appeal_tokens.user_id`: a token is a credential, not a record. It should
  vanish with the account, exactly like `password_reset_tokens`.
- **Terminology:** `upheld` means *the original decision stands*. Ambiguous in English, so name it
  in the migration header and in the UI copy ("Decision stands" / "Decision reversed"), because a
  reviewer picking the wrong one tells the appellant the opposite of the truth.
- `used_at` rather than deleting the row: "this token was spent, at this time" is an audit fact, and
  a spent token and an unknown token must return the same response (§9.1).
- Expiry **30 days**. Community Guidelines' 5 business days is *our reply* time, not their filing
  window. Re-issuable: `POST /api/admin/users/:id/appeal-token` (`requireCap('user.suspend')`)
  re-sends, for the case where the first mail was lost.

### 11.4 Routes

| Route | Gate | Notes |
|---|---|---|
| `GET /api/appeals/token/:token` | **none** | Returns only `{ subject, suspensionReason, statedPeriod, expiresAt }` for the form. Never the name, email, or user id. `appealLimiter` |
| `POST /api/appeals/token/:token` | **none** | Body `{ statement }` (20–5000 chars). Marks `used_at`, inserts the appeal, appends `moderation_actions` on the linked report when there is one. `appealLimiter` + `mailIpCeilingLimiter`. Uniform response for unknown/expired/spent |
| `POST /api/appeals` | `authenticateToken` | For a **non-suspended** user appealing a content removal or a report outcome. `ROUTE_REGISTRY`: `SELF_ONLY` — writes only an appeal for `req.user.id` |
| `GET /api/appeals/mine` | `authenticateToken` | `ROUTE_REGISTRY`: `SELF_ONLY` |
| `GET /api/admin/appeals` | `requireCap('appeal.review')` | Queue, oldest first |
| `GET /api/admin/appeals/:id` | `requireCap('appeal.review')` | Includes the linked report and its history |
| `PATCH /api/admin/appeals/:id` | `requireCap('appeal.review')` | `decision` **and** `reasoning` (≥ 20 chars) both required to leave `open`/`reviewing`. Records `reviewer_id`. Community Guidelines promises *"We will tell you who reviewed it"* — this column is that promise. An `overturned` decision does **not** auto-unsuspend: it enqueues the unsuspend for a deliberate act, because reversing enforcement is a second decision with its own audit row |

The two unauthenticated routes need `authLimiter`-style mounts in `server/app.js` and, because they
never reach `authenticateToken`, will not appear in guard 2's router walk. **Confirm that by running
the guard rather than assuming it** — a route that silently escapes the completeness scan is worse
than one that fails it.

### 11.5 What appeals cannot deliver

- **Guardian notification.** Community Guidelines: *"If you are under 18, we tell your parent or
  guardian about a suspension or removal."* There is no guardian contact anywhere in the schema.
  This promise is **currently unkeepable** and is blocked on roadmap PR-2 (guardian consent), not on
  anything in this spec. Either PR-2 ships or the Guidelines change. **This is a launch blocker for
  the published document, and it is outside this spec's scope.**
- **Reviewer independence.** §5.7, §8.

---

## 12. Required cross-file changes owned by other agents

Name them here because this spec cannot land them and they are load-bearing.

| File | Change | Why |
|---|---|---|
| `docs/legal/policies/01-privacy-policy.md` | Publish the moderation-record retention period (reports and moderation history retained indefinitely; message evidence 3 years or resolution + 1 year, whichever is later) | §6.3–6.4 change what is retained. `retentionWorker.js:39` says changing a period here means changing the Policy too |
| `docs/legal/policies/08-youth-safety-guidelines.md` | Correct *"You can report anonymously"* → anonymous **to the reported party** in-app, genuinely anonymous **by email**. Remove the "Still not built" note about redaction and non-conversation reporting once §5–6 ship | §3.4, §0.3 |
| `docs/legal/policies/03-community-guidelines.md` | Same anonymity correction. Confirm the suspension step now states a period (§7.2). Guardian-notice line needs PR-2 or removal | §0.3 |
| `docs/legal/policies/10-admin-responsibilities-policy.md` | Conflict-of-interest rule (§5.3) and the logged-evidence-read rule (§5.4) as published admin obligations | These are now enforced in code; the policy should say so |
| `docs/ENGINEERING_GUIDE.md` | Add the `reports` rebuild to §8.3's list of sanctioned destructive rebuilds alongside `001_authz_roles.js` | §8.3 currently names exactly one, and a second unlisted one invites a third |
| `CHANGELOG.md` | Behaviour changes with reasoning, per the repo convention | |

---

## 13. Tests

Repo rule: coverage is proportional to consequence. Required for any bug fix (failing first), any
new endpoint, any auth/authz change, any new boot guard, any migration (idempotency), any security
fix. Every item below is required, not suggested.

### 13.1 Migration 010 — `server/migrations.reportTargets.test.js`

- `up()` twice in a row is a no-op the second time (registry idempotency requirement)
- every one of the 7 `target_type` values inserts; an 8th value is rejected by the CHECK
- all 4 `status` values insert; a 5th is rejected
- **pre-010 rows survive with `reason`→`description` and `category='other'`**, verified row by row
- unknown-column guard: add a junk column, assert `up()` throws naming it (guard 4)
- missing-column guard: drop a column from the fixture, assert `up()` throws (guard 4)
- pragma assertion: call `up()` with a transaction already open, assert it throws rather than
  proceeding (guard 2) — this is the guard nothing else catches
- child-row count guard: create a table with an FK to `reports`, seed it, assert `up()` preserves
  the count (guard 5). Proves the vacuous-today guard actually works before 011 makes it matter
- `foreign_key_check` is clean after the rebuild (guard 6)
- all five indexes exist after the rebuild
- `idx_reports_no_dup` rejects a second `open` report of the same target by the same reporter and
  **permits** one after the first is `resolved`

### 13.2 Migration 011 — `server/migrations.moderationHistory.test.js`

- idempotency, including the backfill (run `up()` twice, assert no duplicate rows)
- backfill correct at **zero** `conversation_reports` rows
- a seeded `conversation_reports` + `conversation_report_messages` pair appears in `reports` with
  `target_type='conversation'`, the same id, and its messages in `report_evidence`
- the `reason`→`category` map, per branch, including the `safety`→`urgent` priority
- **UPDATE on `moderation_actions` throws** (trigger)
- **DELETE on `moderation_actions` throws** (trigger)
- `DELETE FROM reports` with a `moderation_actions` child throws (RESTRICT)
- the legacy tables still exist and still hold their rows

### 13.3 Reporting — `server/routes.reports.test.js`

- each of the 7 target types accepted, with the correct `reported_user_id` and
  `reported_role_snapshot` resolved
- reporting yourself → 400, for `user`, `message`, `comment` and `announcement` targets
- **a non-existent target and an invisible-to-the-caller target return byte-identical 404s** — the
  enumeration test, and the one worth writing twice
- a `user` target that does not exist is **accepted** (no oracle) and renders as unknown in the queue
- a malformed certificate code → 400; a well-formed but non-existent one → **accepted**
- every `REPORT_CATEGORIES` value accepted; an unknown one → 400 **with the list in the body**
- `priority` derives from `category`; a client-supplied `priority` is **ignored**
- a second report of the same target → 200 with `duplicate: true`, not 409, and no second row
- `reportLimiter` fires at 21 in 24h; the 21st gets the friendly limiter message, not a bare 429
- a `message` report snapshots ±10 context messages
- a `conversation` report snapshots the whole thread; a 501-message thread truncates at 500 and says
  so in the history row
- one `moderation_actions` `filed` row per report
- **the reported party receives no notification of any kind** — assert `notifications` and
  `notification_jobs` are unchanged
- `reason` (the deprecated alias) still works, so the shipped client does not break
- the legacy `POST /api/messages/conversations/:id/report` writes a `reports` row and **no**
  `conversation_reports` row

### 13.4 Queue and workflow — `server/routes.moderationQueue.test.js`

- `report.resolve` gates every route; a student, an organizer and a partner each get 403; an
  unauthenticated call gets 401
- **a report whose `reporter_id` is NULL still appears** — the `LEFT JOIN` regression test, written
  because an inner join makes reports vanish silently
- filters: status, priority, category, targetType, assignee=`me`/`unassigned`/id — each in isolation
- keyset pagination returns no duplicates and no gaps when a report is inserted mid-scroll
- ordering: urgent before normal, oldest first within each
- assignment is visible to a second moderator
- resolving without a `resolutionNote` → 400 `resolution_note_required`; with 19 chars → 400; 20 → ok
- **conflict of interest:** an admin cannot resolve, dismiss or self-assign a report whose
  `reported_user_id` is themselves, nor one targeting their own event/comment/message; a super_admin
  can; the admin **can still read** it
- the conflict cascade is ordered most-privileged-first and denies explicitly — assert a super_admin
  lands in the privileged branch, which is the failure a status-code assertion cannot see
- reopen writes a `reopened` history row; there is no silent reopen
- every mutation writes both a `moderation_actions` row and an `admin_audit_logs` row
- history is oldest-first with actor names resolved, and survives the actor's account being
  soft-deleted

### 13.5 Evidence reads — `server/routes.moderationEvidence.test.js`

- `GET /api/admin/reports/:id/evidence` requires `report.evidence.read`; a holder of
  `report.resolve` **alone** gets 403 (this is the test that proves the split is real)
- every evidence read appends `evidence_viewed` with a count
- `GET /api/admin/reports/:id/conversation` returns the live thread for a `conversation` report
- it **404s** when the report's `target_type` is `event` — there is no path to an unreported
  conversation
- it **403s** when the report is `resolved`
- it returns messages **regardless of a block** between the parties
- it returns redacted bodies **in full**, with metadata
- a participant hitting the ordinary conversation route still gets `403`/`404` as before — no
  widening

### 13.6 Redaction — `server/routes.redaction.test.js`, `server/messaging.redaction.test.js`

- redaction requires `content.redact`
- `messages.body` is **byte-identical** after redaction — the core assertion
- a participant sees `body: null, redacted: true`, and the message is **still in the list**
- unread counts exclude a redacted message
- **`GET /api/messages/search` does not return a redacted body or snippet** — the leak that
  matters, at `messageRoutes.js:310, 319`
- `decorateConversation`'s `lastMessage` is suppressed when the last message is redacted
- un-redaction restores display and appends `content_unredacted`
- `DELETE /api/comments/:id` → 409 `under_review` when an open report targets it, and succeeds when
  the report is resolved
- redaction is refused for content outside the reported scope

### 13.7 Retention — extend `server/retention.test.js`

- a message snapshotted in `report_evidence` is **not** swept
- a message snapshotted in the **legacy** `conversation_report_messages` is not swept (the fold did
  not un-exempt it)
- **message 11 of a 3-year-old conversation with an open `conversation` report is not swept** — the
  §0.2 #5 regression, and the single most valuable test in this section
- a message that is the `target_id` of an open `message` report is not swept
- a **redacted** message is not swept, even with no live report
- evidence for a report resolved **366 days ago** and older than 3 years **is** swept — the bound is
  real, not decorative
- evidence for a report resolved **364 days ago** is not
- `reports`, `moderation_actions` and `report_evidence` are in `PRESERVED_TABLES` and
  `assertPreservedTablesUntouched` throws if a sweep touches them
- the shell purge **skips** an account that has moderated anything (would otherwise throw on
  RESTRICT) and one with an unresolved report against them
- the purge still works for an ordinary deleted shell — the guard did not disable the feature

### 13.8 Enforcement — extend `server/routes.suspension.test.js`

- `durationDays` sets `suspended_until`; omitting it leaves NULL (indefinite)
- `durationDays` of 0, 366, `-1` and `'7'` are each rejected
- sign-in is refused while `suspended_until` is in the future and **permitted** once it has passed,
  even before the daily job runs
- the daily lift clears all four columns, writes `ACCOUNT_UNSUSPENDED`, appends
  `moderation_actions` attributed to the original suspending admin, and emails
- the lift is idempotent across two runs on the same day
- a `notification_jobs` email row is enqueued on suspend, carrying reason, period and an appeal
  token
- `reportId` links the suspension to a report via `moderation_actions`
- suspending with a `reportId` whose subject is the actor → 403 `conflict_of_interest`
- all 25 existing cases still pass (or, for §7.4, are deliberately updated with the reason recorded
  in the commit message)

### 13.9 Appeals — `server/routes.appeals.test.js`

- **a suspended user can file an appeal** — the case the whole design exists for
- an unknown, expired and spent token return **byte-identical** responses
- a spent token cannot be reused
- `GET /api/appeals/token/:token` leaks no name, email or user id
- `appealLimiter` fires
- a statement under 20 or over 5000 chars → 400
- deciding without `reasoning` → 400
- `reviewer_id` is recorded and returned to the appellant
- `overturned` does **not** auto-unsuspend
- `appeal.review` gates the admin routes; `report.resolve` alone is 403
- a non-suspended user appeals a content removal through the authenticated route

### 13.10 Authz and static guards

- `server/authz.test.js` — the three new capabilities are in `ALL_CAPABILITIES`, held by `admin`,
  reachable by per-user grant, absent from `SUPER_ONLY`, and denied to student/organizer/partner
- `server/authz.completeness.test.js` — **all six guards pass unmodified except for the declared
  `ROUTE_REGISTRY` additions**. If a guard needs weakening, stop and escalate
- `src/noDangerousHtml.test.js` — new, no allowlist (§10)
- `src/tokens.test.js`, `noHardcodedColors.test.js`, `noDanglingClasses.test.js` — pass for every
  new moderation view
- `server/email.escaping.test.js` — extended to the escalation, suspension and appeal templates

---

## 14. Build sequence

Dependency-ordered. Each step is a branch, one concern, squash-merged, with the four PR gates
(`npm ci` first — it is the only one that validates the lockfile).

| # | Branch | Contents | Depends on |
|---|---|---|---|
| 1 | `chore/moderation-module` | `server/moderation.js`: `REPORT_CATEGORIES`, `URGENT_CATEGORIES`, `RETAINABLE_MESSAGE_PREDICATE`, target-resolution helpers. **Zero imports beyond `node:crypto`**, like `authz.js` and `blocking.js`, so it is unit-testable with no fixtures and importable by `src/`. Pure-module test | — |
| 2 | `feature/reports-rebuild` | Migration 010 + its test. **Schema only** — no route changes. The destructive step lands alone, while `reports` is still childless, so a rollback is a restore of one table | 1 |
| 3 | `feature/moderation-history` | Migration 011: `moderation_actions`, `report_evidence`, triggers, the `conversation_reports` fold + test | 2 |
| 4 | `feature/report-targets` | `POST /api/reports` extended · `POST /api/messages/:id/report` · legacy conversation-report route reimplemented · `reportLimiter` · `ROUTE_REGISTRY` updates · `src/components/ReportModal.jsx` rewritten against `REPORT_CATEGORIES` | 1, 3 |
| 5 | `fix/block-rate-limit` | `blockLimiter` + the enumeration decision (§9.1). **Independent of everything above** — ship it first if the T&S chain slips, it is a live gap and a two-file change | — |
| 6 | `feature/moderation-queue` | The three new capabilities · `GET/PATCH /api/admin/reports` · notes · history · escalate · warn · conflict-of-interest rule | 3, 4 |
| 7 | `feature/moderation-evidence` | `/evidence` and `/conversation` reads, with `evidence_viewed` logging. **The fix for §0.2 #1 and #2 — the largest single safety gain in this document** | 6 |
| 8 | `feature/content-redaction` | Migration 012 · redaction routes · participant-facing suppression · the search-route leak · `DELETE /api/comments/:id` 409 | 7 |
| 9 | `fix/retention-evidence-exemption` | `RETAINABLE_MESSAGE_PREDICATE` wired into the sweep · `PRESERVED_TABLES` · the shell-purge guards · `RETENTION.moderationEvidenceDays`. **Must land in the same release as 8** — 8 creates redacted messages the current sweep will delete | 8 |
| 10 | `feature/suspension-notification` | `notification_jobs` email on suspend/unsuspend · `reportId` linkage · warnings. **Ship before 12** — the appeal token rides on this mail | 6 |
| 11 | `feature/suspension-duration` | Migration 013a (`suspended_until`) · sign-in read-only check · the daily lift job | 10 |
| 12 | `feature/appeals` | Migration 013b (`appeals`, `appeal_tokens`) · the six appeal routes · `src/views/Appeal.jsx` | 10 |
| 13 | `feature/moderator-dashboard` | `src/views/Moderation/*` · NAV entry · `src/noDangerousHtml.test.js`. Run `/design-critique` and `/accessibility-review` before merge | 6, 7, 8, 12 |
| 14 | `docs/trust-and-safety-policy-sync` | §12's cross-file changes. **Last**, so the documents describe shipped behaviour rather than intended behaviour | 1–13 |

**Safety-first reordering, if the chain has to be cut short.** Steps 5, 2, 3, 7 and 9 are the ones
that close live evidence-destruction or blind-spot gaps. Steps 4, 6, 13 are the ones that make the
product usable. If only half of this ships, ship the first list.

**Version bump.** Any release carrying this touches both manifests:
`npm version <x.y.z> --no-git-tag-version --workspaces --include-workspace-root`. `/health` reads
`server/package.json`.

---

## 15. Where I am uncertain

Listed rather than guessed at.

1. **Migration numbers 010–013 may collide.** Two other agents are editing `server/migrations/`
   right now. Re-derive the numbers at implementation time; the order in `index.js` is what
   matters.
2. **Whether the pilot database holds any `conversation_reports` rows.** Not knowable from here.
   §3.3's backfill must be correct at zero rows and both cases must be tested.
3. **Unauthenticated certificate-abuse reporting.** `GET /api/certificates/verify/:code` is public,
   so the person who discovers a forged certificate — an employer, an admissions office — may have
   no account. I specify **no** unauthenticated report endpoint: it is a spam cannon and the true
   volume is near zero. The published email address is the channel. **Someone should disagree with
   me on this if they think the volume is not near zero.**
4. **Blocking target scoping (§9.1).** Removes a real oracle at the cost of narrowing a control the
   Youth Safety Guidelines describes as unconditional. Marked as a decision, not settled.
5. **Requiring a reason on unsuspend (§7.4).** Right, but it breaks up to three currently-passing
   tests. Needs a reviewer to agree the breakage is the deliberate part.
6. **`requireAAL2` on suspension (§8).** Arguable either way. Not specified.
7. **`RETENTION.moderationEvidenceDays = 365`.** Defensible, not derived from anything. It is the
   number that has to be published in the Privacy Policy, so counsel may have a view.
8. **`something_feels_wrong` as auto-urgent (§4.3).** Correct for a small pilot. At a few hundred
   students it may need a distinct lane rather than the urgent one — measure before changing, and
   do not solve it by making the category harder to pick.
9. **Whether the two unauthenticated appeal routes appear in guard 2's router walk.** They should
   not (no `authenticateToken`), but I did not run the guard. **Run it; do not assume.**
10. **Whether `src/authz.js` needs any edit for the three new capabilities.** It re-exports the
    module, so it should not. Verify.
11. **Warning delivery for a *suspended* user.** §7.5 uses `createNotification`, which a suspended
    account cannot read. Warnings are for non-suspended users by definition, so this should be fine
    — but if a warning is ever issued alongside a suspension, it needs the email path instead.
