# PostgreSQL Migration — Repository & Database Audit

**Phase 1 of 10. Read-only. Nothing in the application was modified.**

Date: 2026-08-15 · Branch: `feat/prelaunch-quality` · Auditor: automated pass over
the repository and the live `pilot.db`

A prior assessment exists at `docs/plans/supabase-vercel-migration-plan.md`
(2026-08-06). Its conclusions still hold, but **every quantity in it is stale** —
the migration surface has roughly tripled since. This document supersedes its
measurements and keeps its reasoning.

---

## 1. Current SQLite architecture

| Fact | Measurement |
|---|---|
| Driver | `node:sqlite` `DatabaseSync` — **synchronous**, experimental, Node `<25` pinned (TD-8) |
| Connection | One module-global `db` singleton in `server/db.js` |
| Pragmas set explicitly | `journal_mode=WAL`, `busy_timeout`, `enableForeignKeyConstraints: true` |
| Process model | **Exactly one**, enforced by `instanceLock.js` |
| Transactions | `inTransaction(fn)` in `server/utils.js:802` — bare `BEGIN`/`COMMIT` on the global connection |
| Background workers | 3 — `notificationWorker`, `exportWorker`, `retentionWorker` |
| Schedulers | 1 — `autoSelectScheduler` |
| Realtime | `socket.io` 4.8, persistent connections |
| File storage | Local filesystem, `0o700` export directory |
| Deployment as built | **systemd** units in `deploy/` — a Linux VM |

There is still no `vercel.json`, no Supabase config, and no Postgres driver in the
repository.

## 2. SQLite database files discovered

**18 `.db` files on disk.** Only one is live.

| Path | Size | Status |
|---|---|---|
| `pilot.db` (repo root) | 1.1 M | **LIVE — real pilot participants, including minors** |
| `server/data.db` | 468 K | Stale, orphaned |
| `pilot-backup-legalsync-20260815-144519.db` | 1.1 M | Ad-hoc backup |
| `pilot-backup-20260808-225321.db` | 812 K | Ad-hoc backup |
| `backups/` (6 files) | 412 K–776 K | Pre-migration snapshots |
| `wevolunteer.db`, `sbvolunteers.db`, `server/*.db`, `server/test.db` | 0–4 K | Empty artifacts |

All are gitignored. The empty ones are the residue of the relative-path trap
`db.js` documents.

## 3. Which database is actually used

`pilot.db` at the repository root. `.env` sets `WEV_DB_PATH=../pilot.db`, and
`npm run dev:server` runs with `server/` as its working directory, so `../` lands
on the root. Confirmed at boot: `[db] using …/pilot.db`.

## 4. Path resolution

`server/db.js` resolves `WEV_DB_PATH` to an absolute path, prints it, and
**refuses a relative path in production**. `:memory:` and `file:` locators are
exempted so tests can pass them through. This is a well-guarded area; the guard
exists because the relative form silently attached a server to a stale database.

## 5. Table inventory

**65 tables · 568 columns · 168 indexes · 20 triggers · 0 views**

Largest tables by row count:

| Rows | Table | | Rows | Table |
|---:|---|---|---:|---|
| 122 | `notifications` | | 18 | `users` |
| 55 | `schema_migrations` | | 16 | `attendance` |
| 48 | `error_events` | | 16 | `hours_ledger` |
| 29 | `applications` | | 13 | `attendance_checkin` |
| 27 | `badges` | | 12 | `legal_documents` |
| 24 | `slots` | | 12 | `messages` |
| 20 | `recovery_codes` | | 9 | `security_audit_logs` |
| 19 | `revoked_sessions` | | 7 | `organization_members` |
| 18 | `admin_audit_logs` | | 5 | `organizations` |

**27 tables are empty**, including `external_hours`, `oauth_accounts`,
`user_capabilities`, `notification_preferences` and `tfa_login_attempts`.

## 6. Row counts

**548 rows in total.** The entire database is 1.1 MB.

> This is the single most important number in this audit. **The data migration is
> effectively free.** Every hour of this project is application-port cost, not
> data-transfer cost. Any estimate that conflates the two will be wrong by an
> order of magnitude.

## 7. Foreign keys and referential integrity

Enforcement is **on and explicit** — `enableForeignKeyConstraints: true` is passed
rather than inherited (TD-21, closed in `a7517b4`), and
`server/db.foreignKeys.test.js` asserts it. `PRAGMA foreign_key_check` over
`pilot.db` returns clean.

44+ tables carry declared keys, including `ON DELETE CASCADE` on `attendance` (3)
and `user_badges` (2). These port to PostgreSQL directly — this is the *least*
risky area of the migration.

## 8. Index inventory

**168 indexes.** Most port unchanged. Two need deliberate attention:

- `018_admin_conversations.js` creates a **partial unique index over an
  expression** — `COALESCE(student_id, organizer_id)` `WHERE kind IN (…)`.
  PostgreSQL supports both, so it ports — but a naïve `CREATE TABLE` translation
  would silently drop it, and dropping it lets an administrator hold two
  duplicate threads with the same person.
- Several indexes exist to compensate for SQLite's planner and may be redundant
  under PostgreSQL. Evaluate against real query plans; do not recreate blindly.

## 9. SQLite-specific SQL usage

| Pattern | Occurrences (non-test) | PostgreSQL treatment |
|---|---:|---|
| `PRAGMA foreign_keys` | 67 | Delete — meaningless outside SQLite |
| `PRAGMA table_info` | 60 | `information_schema.columns` |
| `PRAGMA foreign_key_check` | 15 | Constraints are always enforced; delete |
| `PRAGMA foreign_key_list` | 11 | `information_schema` |
| `datetime(…)` | 27 | `now()` / interval arithmetic — **semantics change** |
| `ON CONFLICT` | 13 | Ports directly |
| `INSERT OR IGNORE` | 12 | `ON CONFLICT DO NOTHING` |
| `strftime(…)` | 5 | `to_char()` / `date_trunc()` |
| `INSERT OR REPLACE` | 2 | `ON CONFLICT … DO UPDATE` — **not equivalent**; REPLACE deletes then inserts, firing delete triggers and cascades |
| `julianday` | 2 | Interval subtraction |
| `AUTOINCREMENT` | 1 | `GENERATED … AS IDENTITY` |
| `last_insert_rowid` | **0** | Nothing to port — already uses `RETURNING`-equivalent patterns |

`last_insert_rowid` being absent is a meaningful piece of luck: the usual worst
concurrency hazard in a SQLite port is simply not present.

## 10. Database access modules

**No abstraction layer exists.** 144 non-test files import and use the global
`db` singleton directly.

| Measure | Count |
|---|---:|
| Non-test files calling `db.prepare(`/`db.exec(` | **144** |
| Test files doing the same | 198 |
| `db.prepare(` call sites, non-test | **1,075** |
| `db.prepare(` call sites, total | **3,058** |
| `inTransaction(` call sites, non-test | **71** |

## 11. Transaction usage

`inTransaction` issues `BEGIN`/`COMMIT` **against the module-global connection**.

This is the deepest structural problem in the migration, and it is worth stating
precisely because it is easy to underestimate:

> With a PostgreSQL connection **pool**, `BEGIN` on a borrowed client does not
> create a transaction the rest of the application is inside. Two concurrent
> requests get different clients; a `BEGIN` issued by one has no relationship to
> the queries the other runs. The current pattern does not merely need `await`
> added — **it silently stops being a transaction at all.**

Fixing it means the global `db` becomes a connection-scoped client that must be
threaded through every function participating in a transaction. That is what
makes this a port rather than a driver swap.

## 12. Concurrency assumptions

The application's atomicity currently rests on an **architectural invariant, not
on locking**:

> `node:sqlite` is synchronous and handlers do not `await` between a read and its
> dependent write, so within the single process they cannot interleave.

Measured surface:

| Measure | Count |
|---|---:|
| Route handlers | **208** |
| Handlers currently `async` | **~28** |
| **Handlers relying on synchronous atomicity** | **~180** |

Every one of the 180 becomes interleavable the moment the driver is async. The
race surface grows by roughly **7×**, and each site must be re-established with a
real transaction or a conditional write (`WHERE … AND <still-unclaimed>` plus a
`changes === 1` check — the pattern already used in `login-2fa`).

Highest-risk sites: capacity checks on application submission, Auto Select,
Equalizer, attendance check-in/out, and hours-ledger writes.

Also single-instance-dependent: the `loginFailures` Map in `authRoutes.js`, the
default in-memory `express-rate-limit` store, `instanceLock.js`, and the three
in-process workers.

## 13. Sensitive data

**23 sensitive columns.** All are hashed or encrypted at rest except where noted:

- `users.password_hash` (bcrypt), `users.tfa_secret` (**encrypted** with `TFA_ENCRYPTION_KEY`), `users.token_version`, `users.tfa_last_counter`
- `recovery_codes.code_hash`, `tfa_email_codes.code_hash`, `tfa_login_attempts.token_hash`
- `password_reset_tokens.token_hash`, `email_verification_tokens.token_hash`, `email_change_tokens.token_hash`, `checkin_tokens.token_hash`, `admin_invitations.token_hash` (all hashed by migration 048)
- `revoked_sessions.jti`, `reauth_challenges.{params_hash,session_jti,ip_hash}`
- `error_events.user_hash`, `legal_documents.content_hash`, `legal_acceptances.content_hash`

**Migration constraint:** `users.tfa_secret` is ciphertext. It must move as an
opaque byte-identical value; any encoding change (TEXT → BYTEA, or a charset
round-trip) breaks every enrolled authenticator irrecoverably.

**Out-of-scope observation (§3):** `appeal_tokens.token` appears to store a token
rather than a hash, unlike its siblings. Not a migration issue — recorded here so
it is not lost.

## 14. Existing backup mechanisms

`bin/backup.sh` (public-key encrypted, `.db.gz.enc`), `bin/verify-restore.sh`,
and systemd `wevolunteer-backup.{service,timer}`. Staleness alerting emails
`ALERT_EMAIL`. **All of it is SQLite-specific** and would be replaced by
`pg_dump`/Supabase-managed backups.

## 15. Tests touching the database

**221 of 425 test files** — over half the suite. Almost all build a real schema
from scratch via `WEV_DB_PATH=:memory:` or a temp file and run the migration
registry.

This is the migration's greatest asset and its largest hidden cost. 6,739
assertions are a genuine regression net, but a synchronous in-memory SQLite
fixture has no PostgreSQL equivalent — every one of those 221 files needs a
provisioned, isolated, **async** database fixture. Expect test-harness work to
rival application work.

## 16. Migration registry

**54 versioned migrations**, checksum-verified at boot, all written against
SQLite. They **cannot be replayed** against PostgreSQL:

- Several are full table rebuilds that exist *only* because SQLite cannot alter a
  constraint in place (`001_authz_roles`, `018_admin_conversations`,
  `055_repair_tfa_login_attempts`). In PostgreSQL these collapse to `ALTER TABLE`
  and their six safety guards become unnecessary.
- 67 `PRAGMA foreign_keys` assertions are meaningless.
- The checksum canonicaliser (`canonicalSource`) parses JavaScript, not SQL, so
  it survives — but it must be re-baselined.

**Required:** a single generated baseline schema, `schema_migrations` restarted at
1, and the checksum system rebuilt around it. The 54 files become history.

## 17. The 20 immutability triggers — a security control, not a convenience

Every trigger in the schema is a `RAISE(ABORT, …)` guard enforcing
append-only/immutable semantics:

| Table | Triggers | Enforces |
|---|---:|---|
| `appeals` | 4 | No delete; immutable; statement and reviewer name write-once |
| `admin_audit_logs` | 2 | No update, no delete |
| `appeal_events` | 2 | No update, no delete |
| `conversation_report_messages` | 2 | Frozen evidence snapshot |
| `conversation_reports` | 2 | No delete, immutable |
| `moderation_actions` | 2 | No update, no delete |
| `report_evidence` | 2 | No update, no delete |
| `reports` | 2 | No delete, immutable |
| `security_audit_logs` | 1 | No update |
| `users` | 1 | No delete while audit logs reference the account |

Each becomes a PL/pgSQL `FUNCTION` + `TRIGGER` pair. **These are the most
dangerous thing in the migration to get quietly wrong**: if they are not ported,
nothing fails, no test necessarily notices, and the audit trail becomes editable —
which is precisely the property the trail exists to have.

## 18. Type mapping — mostly favourable

| SQLite | Count | PostgreSQL | Risk |
|---|---:|---|---|
| `TEXT` | 522 | `text` | Low |
| `INTEGER` | 38 | `integer` / `boolean` | Medium — 17 are booleans stored 0/1 |
| `REAL` | 8 | `double precision` / `numeric` | **Review** — if any is currency or hours, use `numeric` |

**Primary keys — the good news.** 78 of 81 are `TEXT`, application-generated
(`user-<uuid>`). Only three are `INTEGER`:

- `instance_lock.id` — a singleton row; in PostgreSQL this should become an
  **advisory lock**, not a table
- `schema_migrations.version` — explicit versions, not a sequence
- `legal_document_revisions.id` — the **only** true autoincrement, and it has
  **0 rows**

So §22 of the brief (identity/sequence collision after import) reduces to one
empty table. Do **not** convert TEXT ids to `uuid`; the brief is right that this
buys nothing and costs enormously.

**Timestamps.** 126 timestamp-ish columns, all `TEXT`, and the format is
consistent ISO-8601 UTC with milliseconds and a `Z` suffix
(`2026-08-06T06:57:00.801Z`). This maps cleanly to `timestamptz`.

> **Behavioural change to track:** these are currently compared as *strings*.
> TD-10 in the Engineering Guide records a real bug caused by lexicographic
> comparison (`T` = 0x54 vs space = 0x20). Under `timestamptz`, comparison becomes
> temporal and correct. That is an improvement, but it **is** a behaviour change
> and every string-comparison site must be found rather than assumed benign.

**JSON.** Only ~6 candidate columns. Keep them as `text` unless a specific query
needs `jsonb`. The brief is right not to convert for its own sake.

## 19. Estimated complexity

**High — and concentrated almost entirely outside the data.**

| Dimension | Verdict |
|---|---|
| Data volume | Trivial (548 rows) |
| Schema translation | Moderate (65 tables, 20 triggers, 1 expression index) |
| Application port | **Very high** (1,075 call sites, 144 files, 208 handlers) |
| Test harness port | **Very high** (221 files) |
| Concurrency re-establishment | **Very high, and the part that silently breaks** |
| Infrastructure | Moderate (pooling, backups, health checks) |

## 20. Realistic time estimate

Working sessions, assuming focused effort and no parallelism.

| Phase | Optimistic | Realistic | Worst case |
|---|---:|---:|---:|
| Repository audit *(this document)* | — | **done** | — |
| Schema analysis & baseline generation | 1 d | 2 d | 4 d |
| PostgreSQL schema design + triggers | 1 d | 3 d | 5 d |
| Connection/transaction layer rewrite | 2 d | 4 d | 8 d |
| Async port of 1,075 call sites | 5 d | **10 d** | 20 d |
| Concurrency re-establishment (~180 handlers) | 3 d | **7 d** | 15 d |
| Test harness port (221 files) | 4 d | **8 d** | 16 d |
| Data migration tooling + validation | 1 d | 2 d | 3 d |
| Infrastructure (pool, backups, health, monitoring) | 1 d | 3 d | 5 d |
| Rehearsal + staging | 1 d | 2 d | 4 d |
| Cutover + post-verification | 0.5 d | 1 d | 3 d |
| **Total** | **~20 d** | **~42 d** | **~83 d** |

**Realistic: 6–8 working weeks.** The actual `COPY` of 548 rows takes under a
second. Do not let those two numbers be confused.

## 21. Biggest risks, ranked

1. **Silent loss of atomicity.** `inTransaction` stops being a transaction under
   a pool, and ~180 handlers lose their synchronous-execution guarantee. Failure
   mode is *not* an error — it is oversold event capacity and double-credited
   hours under load, appearing only in production.
2. **Unported immutability triggers.** The audit trail becomes editable and
   nothing announces it.
3. **`users.tfa_secret` corruption.** Any encoding change locks every enrolled
   user out of their own account, unrecoverably.
4. **Test-harness collapse.** 221 files rely on synchronous in-memory SQLite. If
   the fixture port is rushed, the regression net is gone exactly when it is most
   needed.
5. **Migration-registry re-baselining.** The checksum chain and the legal-hash
   chain are both boot-fatal; a bad baseline is a server that will not start.
6. **The expression-partial unique index** silently dropped, permitting duplicate
   admin conversations.
7. **Timestamp comparison semantics** changing from lexicographic to temporal.
8. **Losing the fail-closed boot guards** if the host model changes.

## 22. Proposed phases

Sequenced so each phase is independently useful and independently revertible.

| # | Phase | Independently useful? |
|---|---|---|
| 0 | Audit *(this document)* | ✓ done |
| 1 | Verified SQLite backup + baseline snapshot | ✓ yes |
| 2 | Shared-store rate limiting (removes an instance assumption) | ✓ yes — useful on SQLite too |
| 3 | Object storage for exports | ✓ yes — useful on SQLite too |
| 4 | Introduce a database-access boundary, still SQLite-backed | ✓ yes — makes the port mechanical |
| 5 | Generate PostgreSQL baseline schema + port 20 triggers | ✓ reviewable in isolation |
| 6 | Connection/pool/transaction layer | — |
| 7 | Async port, module by module, behind `DATABASE_ENGINE` | — |
| 8 | Concurrency re-establishment + stress tests | — |
| 9 | Data migration tooling + validation | — |
| 10 | Rehearsal → staging → cutover | — |

**Phase 4 is the highest-leverage step.** Introducing the boundary *while still on
SQLite* means the suite stays green throughout, and converts phase 7 from
"rewrite 1,075 call sites and hope" into a mechanical change behind one seam.

## 23. Proposed rollback strategy

`DATABASE_ENGINE=sqlite|postgres` selected at boot, with the SQLite path kept
fully working until acceptance. Both implementations satisfy the phase-4
boundary.

Because the app is **pre-launch with zero real users**, the divergence problem
that makes rollback hard does not exist yet:

- Cutover in a maintenance window; no dual-write.
- Post-cutover PostgreSQL writes are the only divergence risk. Until launch there
  are none, so rollback is: flip the variable, restart, done.
- **After** real users exist, rollback requires either a read-only window or an
  explicit replay plan. That is the point at which this becomes genuinely hard —
  which is an argument for doing the migration *before* launch or well after it,
  not during.

---

## Two things that need your decision

**1. I cannot create the Supabase project.** It needs your account, region
choice, billing tier, and credentials. Everything through phase 5 can be built
and tested against a local PostgreSQL without it; phases 6–10 cannot complete
without a real project.

**2. Sequencing against launch.** WeVolunteer just completed a launch-readiness
pass: 6,737 tests green, 0 P0s, production build and boot verified. This
migration is a 6–8 week port whose central risk is the silent loss of an
atomicity invariant that ~180 handlers depend on — and whose measured benefit at
548 rows is managed backups and future headroom, not present capability.

The 2026-08-06 assessment recommended launching on the systemd/VM path and
treating the PostgreSQL port as its own project. **Every number I measured makes
that recommendation stronger, not weaker** — the call-site count has grown from
64 files to 144, and migrations from 18 to 54, in nine days.

I am not declining the work. Phases 1–5 are safe, useful, and revertible, and I
can start them now. But committing to phases 6–10 immediately before launch is a
product decision, not an engineering one.
