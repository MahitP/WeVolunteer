# PostgreSQL migration — status

Kept current so this project can be picked up without reading a chat log.

```
Current phase:              1, 4, 5, 6 complete. Phase 7 groups 1-3, waves 4-7
                            complete. Wave 8 scoped; conversion not landed.
Architecture:               option D, PostgreSQL-native async.
Current database:           SQLite - authoritative.
Tests:                      434 files / 6885 passed / 0 failed (with PostgreSQL)
                            434 files / 6853 passed / 34 skipped (without)
Remaining call sites:       653 across 42 files
Remaining sync transactions: 35
Known failures:             none
BLOCKED ON:                 nothing. Budget only.
Last successful checkpoint: wave 8 analysis - recordAudit graph measured exactly
                            (18 sync-tx / 7 async-tx / 14 untransacted), Guard 7
                            widened to cover it, tree returned to green after an
                            unwound tooling attempt.
NEXT OPERATION:             wave 8a - the 14 untransacted recordAudit sites, BY
                            HAND, one file at a time. See "Wave 8" below for the
                            subgroups and the no-bulk-script rule.
Rollback status:            N/A - nothing has been cut over.
```

## Phase 6 — COMPLETE: the PostgreSQL connection and transaction layer

Scope, baseline, rollback point and risk were recorded here before any code was
written; the outcome is appended at the end of the section.

### Scope

Build the PostgreSQL side of the seam phase 4 created, and **prove the one
property that would otherwise break silently**: that a transaction pins a single
pooled client and that concurrent transactions cannot interleave on it.

In scope:
- Add the `pg` driver (a Postgres migration requires a Postgres driver; Node has
  no built-in one). It stays inert unless the engine is selected.
- `server/db/postgresConnection.js` — a pooled adapter whose surface matches the
  parts of `DatabaseSync` this codebase actually uses.
- `server/db/engine.js` — a `DATABASE_ENGINE` switch, defaulting to `sqlite`.
- Transaction support that checks out one client, pins it into the async context
  built in phase 4, and returns it to the pool on commit or rollback.
- Tests, against a real PostgreSQL, that prove pinning and isolation.

**Explicitly NOT in scope:** switching the application over, porting any call
site, or making any existing handler async. SQLite stays the default and the only
engine the app actually runs on. Nothing in `server/routes/` is touched.

### Test baseline before starting

```
427 files / 6758 passed / 2 skipped / 0 failed
npm run lint clean · npm run build ✓
```

Any deviation from that at the end of the phase is a regression to explain, not
to absorb.

### Rollback point

Working tree as of the end of phase 4. Phase 6 is additive: three new files, one
dependency, and no edit to any existing module except `package.json`. Reverting
is deleting the new files and the dependency. The SQLite path is untouched by
construction, not by intention — no existing file changes behaviour.

### Expected risk

| Risk | Why it matters | How it is contained |
|---|---|---|
| The adapter's semantics silently differ from `DatabaseSync` | A `.get()` that returns `undefined` where SQLite returned `null`, or a `.run()` whose `changes` is wrong, breaks conditional-write logic that decides who won a race | Adapter tests assert shape against the SQLite behaviour, case by case |
| A transaction does not actually pin its client | The exact silent failure this migration is about: writes stop being atomic with no error | A concurrency test with two real overlapping transactions, asserting isolation and that a rollback discards |
| Pool exhaustion or a leaked client | A client checked out and never released hangs the next request forever | Release in `finally`; a test asserts the pool returns to idle after commit, rollback, and throw |
| Adding `pg` disturbs the install or audit | Launch-readiness regression | `npm audit` re-run; the import is dynamic so an unused engine loads nothing |

### Outcome

Six files added, two modified (`package.json` for `pg` 8.23.0,
`deploy/wevolunteer.env.example` for the six new settings). **No server module
changed** — the SQLite path is untouched by construction rather than by care.

```
WITH PostgreSQL     430 files / 6814 passed / 2 skipped / 0 failed
WITHOUT PostgreSQL  429 passed + 1 skipped / 6794 passed / 22 skipped / 0 failed
npm run lint        clean   ·  npm run build ✓ 1.53s  ·  npm audit 0 vulnerabilities
```

Baseline was 427 files / 6758 tests; the delta is the three new suites.

**What is proved, against a live PostgreSQL 16:**

- Statement semantics match `DatabaseSync` — asserted by running the same
  operations on both engines in the same test and comparing, rather than
  describing SQLite's behaviour from memory. `get()` misses return `undefined`;
  `run()` reports `changes`, including **0** when nothing matched, which is the
  value 31 conditional-write sites use to decide who won a race.
- `COUNT(*)` comes back as a number, not a bigint string. Left at the `pg`
  default, `0 === '0'` is false and every capacity and parity check silently
  inverts.
- **Two concurrent transactions cannot see each other's uncommitted rows**, each
  observing only its own insert while an outside reader sees neither. This is
  the property the whole phase exists for: `pool.query('BEGIN')` would have let
  both writes escape their transactions with no error at all.
- A rollback discards — and the row is asserted to have *existed inside* the
  transaction first, so a rollback that "worked" cannot be an insert that never
  ran.
- No client leaks: 15 sequential and 15 concurrent transactions against a pool
  of 5, with the pool returning to idle and zero waiters.
- The phase-4 composition end to end: a write made through the **unedited proxy**
  lands in the enclosing transaction and is rolled back with it. That is the
  mechanism by which ~653 existing call sites will join a transaction untouched.

**Selecting `postgres` refuses to boot,** deliberately, and a test pins the
refusal. The adapter works; the application does not — its call sites are
synchronous and would each receive a pending promise rather than a row. The
server would start, serve, and be wrong, treating a promise as a truthy result in
every capacity check and authorization lookup. One constant (`POSTGRES_READY`)
lifts the refusal when phase 7 lands.

**On vacuous tests.** The adapter suite was first written with early `return`s
for the no-database case, which makes twenty skipped tests report as twenty
passes. Running it without a database exposed that (19 genuinely failed), and it
now uses `describe.skipIf`, so the absent case shows as *skipped* in the summary
and prints what is uncovered. Both modes are exercised above.

## What was authorised

Phases 1–5 first, then 6, then 7 — all built against **local PostgreSQL**. No
Supabase project has been created or connected. Phases 8–10 (concurrency
re-establishment, data migration, cutover) are not started.

## What is done

| Phase | State | Evidence |
|---|---|---|
| 0 · Audit | ✅ | `POSTGRES_MIGRATION_AUDIT.md` |
| 1 · Verified backup + baseline | ✅ | `POSTGRES_MIGRATION_BASELINE.json`, `migration/backups/sqlite/` |
| 2 · Shared-store rate limiting | ⬜ not started | — |
| 3 · Object storage for exports | ⬜ not started | — |
| 6 · PG connection + transaction layer | ✅ | `server/db/{postgresConnection,sqlPlaceholders,engine}.js`, proved on PG 16 |
| 7 · Async port | 🟡 groups 1–3 complete | boundaries 3 → 0; token invariant protected; pinning proved |
| 4 · DB-access boundary (SQLite-backed) | ✅ | `server/db/connectionContext.js`, `db.connectionContext.test.js`, `db.accessSurface.test.js` |
| 5 · PG baseline schema + triggers | ✅ | `supabase/migrations/*_baseline_schema.sql`, verified on PG 16 |

Phases 2 and 3 are deliberately left until after 4. Both are independently
useful, but phase 2 rewrites a live security control (the login brute-force
limiter) and doing that in the same stretch of work as a database port is how a
rate limit gets quietly loosened. Phase 4 is the one that makes phases 6–7
tractable, so it is the better next step.

## Phase 1 — verified backup and baseline

`node bin/migration-baseline.mjs`

- Binary backup via `VACUUM INTO`, not `cp`: the database is in WAL mode, so a
  file copy can silently omit committed transactions.
- Logical `.sql` dump alongside it, because the two fail independently.
- **Both are verified by reading them back.** The binary is re-opened and
  integrity-checked; the logical dump is restored into a scratch database and its
  row counts compared table by table. 65/65 tables and 548/548 rows matched.
- Source integrity checked *before* copying, so a corrupt original cannot be
  faithfully preserved as a clean-looking artifact.
- **Secrets are redacted from the report.** `min_id`/`max_id` would otherwise have
  written `appeal_tokens.token` and `revoked_sessions.jti` into a committed file;
  those two are recorded as a hash of their bounds instead. Redaction is by
  column-name pattern, so a future credential column is covered by default.

Baseline: 65 tables, 548 rows, 8 referential invariants all at 0, derived-hours
ledger sum **212.72**.

## Phase 4 — the database-access boundary

The one structural problem that no amount of careful porting fixes on its own:
`inTransaction()` issues `BEGIN` against the module-global connection. Under a
PostgreSQL **pool** that does not become slower or racier — it stops being a
transaction, because the queries inside borrow different clients than the one
that opened it. No error, no failed rollback, just writes that are no longer
atomic.

### What the audit found that changes the estimate

Of the 133 non-test files that touch the database, **95 already receive a handle
as a parameter** — every migration, and most services. Only **42 import the
module-global**, carrying **653** of the query call sites between them. The
injection seam was already 71% built; the work is concentrated in the route
layer, and the ten largest files hold about two thirds of it.

### The seam

`server/db/connectionContext.js` — an `AsyncLocalStorage` holding the current
connection, and a proxy that resolves to it on every access. `inTransaction`
binds its connection for the duration of the callback, so **all 653 call sites
join the enclosing transaction without being edited**.

On SQLite this is a pass-through: one connection, so the proxy always resolves to
the same object. Measured cost **1.4%** over 200,000 `prepare().get()` calls
(378ms → 384ms). `AsyncLocalStorage` was chosen over a module variable because it
survives `await` — which is the entire point of adopting it *before* the async
port rather than after.

`server/db.accessSurface.test.js` ratchets the surface at 42 files / 653 call
sites. It can be lowered, never raised without a written reason — the shape TD-15
says `UNCONVERTED_UX` should have had. It also asserts `inTransaction` still
resolves through the context, because reverting that would leave the SQLite suite
green while silently removing transactionality from the PostgreSQL port.

### Two faults found by testing, not by reading

**The proxy was not transparent to test doubles.** `get` and `set` were trapped;
`defineProperty` was not — and `vi.spyOn` does not assign, it defines. Six tests
across three files silently observed unmocked behaviour: `authz.aal` counted zero
queries where it expected one, and `health.test` got HTTP 200 from a database it
had explicitly broken. Nothing errored. That is the same failure mode this phase
exists to prevent — an abstraction that looks transparent, is not, and reports
success while the thing underneath is untouched. Now trapped, with four
regression cases.

**The baseline script wrote a second copy of every student's record to disk.** It
restored the logical dump to a scratch `.db` to verify it, then deleted it —
which `tooling.scriptSafety.test.js` caught, because no `bin/` script may delete
a database without the real-data content check. Adding the check did not fix it:
the check read the restored copy, correctly found real accounts, and **refused to
delete it**, leaving the PII in place. The guard was right twice. The restore now
goes to `:memory:`, so nothing is written and nothing needs deleting.

## Phase 5 — the PostgreSQL schema

`node bin/generate-postgres-schema.mjs`

Generated rather than hand-written — 568 columns is 568 chances to typo a name
into a schema that then accepts the wrong data. Every non-obvious choice is
written to `migration/schema-decisions.md` for review (166 decisions).

**Verified by applying it to a real PostgreSQL 16**, not by inspection:

| | SQLite | PostgreSQL | |
|---|---:|---:|---|
| Tables | 65 | 65 | ✅ |
| Columns | 568 | 568 | ✅ |
| Named indexes | 95 | 95 | ✅ zero lost |
| Triggers | 20 | 20 | ✅ |
| Foreign keys | — | 87 | ✅ |
| Booleans (from INTEGER) | — | 20 | ✅ |
| Timestamps (from TEXT) | — | 125 | ✅ |

### Five translation faults the schema surfaced — four found by it failing to apply, one by testing it

1. **`DEFAULT datetime('now')`** — not a PostgreSQL function. Now matched as a
   family (`datetime`/`strftime`/`CURRENT_TIMESTAMP`) rather than one literal.
2. **`COLLATE NOCASE`** on three **UNIQUE** indexes — `users.email`,
   `users.username`, `organizations.slug`. Translated to unique indexes on
   `lower(col)`. Losing this would not have been a performance regression, it
   would have let `Leo@x.com` and `leo@x.com` become two accounts.
3. **`BEFORE UPDATE OF <columns>`** collapsing to a bare `BEFORE UPDATE` — my own
   generator's bug. It would have turned "only a report's workflow may change"
   into "a report may never change", breaking the moderation queue rather than
   weakening it.
4. **`IS NOT <value>`** — SQLite's null-safe inequality. PostgreSQL needs
   `IS DISTINCT FROM`. Rewriting it to `<>` would have been the subtle wrong
   answer: `<>` propagates NULL, so the write-once guard on an appellant's
   statement would have stopped firing.
5. **A subquery in a trigger `WHEN`** — PostgreSQL forbids it, and the first
   version of the generator emitted the condition as a *comment*, leaving the
   function raising unconditionally. That schema applied cleanly and would have
   refused **every** account deletion rather than only those with audit history:
   an outage in a privacy obligation, in a path nobody exercises by accident. The
   condition now lives in the function body as an `IF`, with `RETURN OLD` — which
   is itself load-bearing, since a BEFORE DELETE trigger returning NULL cancels
   the delete. Both directions are asserted.

### Triggers verified enforcing, not merely present

`psql -d <db> -f migration/verify-triggers.sql` — **13 assertions, all passing.**
It attempts the forbidden writes and requires them to be refused, because a
trigger that fails to port raises no error; it just stops firing.

It also checks the two **carve-outs**, which are what a careless translation
breaks: the retention worker must still be able to delete audit rows older than
364 days, and a report's `status` must still be changeable while its text is
frozen.

> The first version of these checks reported four passes against a row that did
> not exist — an INSERT had omitted a NOT NULL column, failed silently, and every
> UPDATE matched zero rows. Every fixture is now asserted into existence before
> use, and `must_allow` fails if a statement matches no rows. Recorded because a
> vacuous pass in a security check is worse than no check.

## Phase 7 · Module group 1 — COMPLETE: transaction boundary consolidation

Recorded before any code was written.

### Why this is the first group, and not an async conversion

The pre-conversion SQL inventory turned up a defect that phase 4 missed. Three
application modules open transactions by calling `exec('BEGIN')` **directly on a
database handle**, bypassing `inTransaction` and therefore bypassing the async
context that phase 4 built:

| File | Line | Handle it uses |
|---|---|---|
| `server/organizerAgreement.js` | 248 | one passed in as a parameter |
| `server/studentOrganizerAgreement.js` | 153 | one passed in as a parameter |
| `server/workers/retentionWorker.js` | 197 | the module global |

On SQLite all three are correct — one connection, so `BEGIN` and the writes that
follow are necessarily on it. Against a pool every one of them is the defining
failure of this migration: `BEGIN` goes to one client and the writes inside go to
others, so the work is not atomic and the rollback discards nothing. No error is
raised.

`db.accessSurface.test.js` asserts that `inTransaction` resolves through the
context — and could not see these, because they never call `inTransaction`. A
guard that checks one spelling of a thing is the TD-12/TD-23 pattern for a third
time, so the guard is widened here too.

Converting these modules to async **before** fixing this would bake the broken
boundary into the converted code, so it goes first.

### Exact scope

- Extract `transactionOn(handle, fn)` in `server/utils.js`; `inTransaction(fn)`
  becomes `transactionOn(currentConnection(), fn)`. Both bind the connection.
- Point the three modules above at it. The two agreement modules keep receiving
  their handle as a parameter — that is deliberate (their comments say so: it is
  how they are driven against a throwaway database in tests) and `transactionOn`
  is parameterised precisely so that property survives.
- Widen the ratchet to fail on any *new* `exec('BEGIN')` outside the boundary.

**Not in scope:** any `async`/`await`, any SQL change, any behaviour change. This
is a boundary correction, verified by the existing suite being unchanged.

### Files and call sites

| Metric | Before | Expected after |
|---|---:|---:|
| `db.prepare`/`exec` sites behind the global | 653 | **653 — unchanged** |
| Files importing the global | 42 | 42 |
| **Unmanaged transaction boundaries (app code)** | **3** | **0** |

This group deliberately does not reduce the call-site count. It reduces a
different number, tracked from now on, and the honest statement is that the 653
is untouched until module group 2.

Boot-time and migration `BEGIN`s in `server/db.js`, `server/migrations/**` and
`bin/migrate_usernames.js` are **excluded and stay excluded**: they run
single-threaded before the server accepts traffic, or in a standalone script, so
there is no pool and no concurrent caller. Enumerated in the guard rather than
pattern-matched, so a new one has to be justified.

### Test baseline

```
WITH PostgreSQL     430 files / 6814 passed / 2 skipped / 0 failed
WITHOUT PostgreSQL  6794 passed / 22 skipped / 0 failed
lint clean · build ✓ · audit 0 vulnerabilities
```

### Rollback checkpoint

End of phase 6. Four files change, all small and independently revertible; no
new files except test cases. Reverting is restoring `inTransaction` to its
phase-4 form and the three modules to `exec('BEGIN')`.

### Known risks

| Risk | Containment |
|---|---|
| A transaction nests, and `BEGIN` inside `BEGIN` throws | Checked before starting: the three entry points have no caller inside an existing transaction (verified by inspecting all 5 call sites). A nesting guard is added so the failure is a clear error rather than a SQLite syntax error |
| The agreement modules lose test-injectability | `transactionOn` takes the handle as its first argument specifically to preserve it; their existing tests pass a throwaway handle and must keep passing unchanged |
| `retentionWorker` behaves differently on rollback | Its deletion set is asserted by existing tests; the full suite is the check |

### Expected behaviour changes

**None.** On SQLite `transactionOn(handle, fn)` issues the same BEGIN/COMMIT on
the same handle in the same order. The only difference is that the handle is now
also bound into the async context — which, with one connection, resolves to what
it already was.

### Outcome

```
WITH PostgreSQL     430 files / 6824 passed / 2 skipped / 0 failed
WITHOUT PostgreSQL  429 passed + 1 skipped / 6804 passed / 22 skipped / 0 failed
lint clean · build ✓ 600ms
```

| Metric | Before | After |
|---|---:|---:|
| `db.prepare`/`exec` behind the global | 653 | 653 (unchanged, as planned) |
| Files importing the global | 42 | 42 |
| **Raw transaction boundaries in app code** | **3** | **0** |
| Tests | 6814 | 6824 (+10 cases, no new files) |

**One correction to the scope above:** it said `retentionWorker.js` uses the
module global. It does not — `sweep(db, …)` takes its handle as a parameter, like
the two agreement modules. All three took the same `transactionOn(handle, fn)`
treatment; the note was wrong, not the fix.

### Two defects found while doing this

**`transactionOn` was called with the proxy, and bound it to itself.** Most
callers pass the module-global `db`, which *is* the proxy — so binding it made
`resolve()` return the proxy and the `get` trap look properties up on itself:
`RangeError: Maximum call stack size exceeded`, a hundred identical frames. It
fired on the first focused test run. `concreteConnection()` now unwraps at the
choke point so the situation is unrepresentable, with four regression cases.

**A cycle, avoided by relocating the primitive.** `transactionOn` was first
written in `utils.js` beside `inTransaction` — but `utils.js` imports
`organizerAgreement.js`, which is one of the modules that needs the helper, and
that file's own comment warns "importing it back would be a cycle". It lives in
`db/connectionContext.js` instead, which imports nothing but `node:async_hooks`.

### On the 13 failures in the first full run

The first full-suite run after these changes reported 13 files failing, all with
`Hook timed out in 10000ms` inside `beforeAll`. They were **not** caused by this
change, and the determination was made rather than assumed:

- all five sampled failures passed in isolation;
- an identical re-run of the whole suite was completely green (430/430).

This is **TD-11** — the documented intermittent vitest fork-pool contention,
"roughly one `npm test` run in three, always green on retry, never with an
assertion failure". It reproduced exactly as the register describes. Recorded
because "re-ran it and it passed" is otherwise indistinguishable from ignoring a
real failure, and because TD-11 will make phase 7's per-module verification
loop noisy: **a red run must be re-run before it is believed, and a red run that
repeats is real.**

## Phase 7 · Module group 2 — COMPLETE: `services/verification.js`

Recorded before any code was written.

### Why this module, and why NOT `eventEligibility.js`

`eventEligibility.js` was the planned first conversion — 133 lines, **zero
writes**, the safest-looking leaf in the codebase. Inspecting its callers first,
as required, disqualified it:

| Caller | What it does with the answer |
|---|---|
| `applicationRoutes.js:349` | decides whether to INSERT an application |
| `services/autoSelect.js:100` | filters the pool a draw selects from |
| `utils.js:1278` | rebuilds the waitlist queue |

Read-only or not, making it async puts an `await` between the eligibility read
and the write it authorises, in three of the highest-risk paths in the product.
That is not a leaf conversion; it is the capacity/Auto Select group wearing a
leaf's clothes, and it goes last rather than first.

### The hazard this module actually contains

`issueVerificationToken` is a **DELETE followed by an INSERT**, and its comment
states the invariant it maintains: *"One live token per user, deliberately:
pressing resend three times should leave exactly one working link, not three."*

The schema does **not** enforce that. `email_verification_tokens` is keyed on
`token_hash` alone — there is no unique constraint on `user_id` — so the
invariant is held up entirely by the two statements running with nothing
interleaved between them. Today that is guaranteed by the handler being
synchronous. Add an `await` and two concurrent "resend" presses can both DELETE,
then both INSERT, leaving **two live tokens** for one account. Every link ever
mailed stays usable until it ages out, which is precisely the window the comment
says the design exists to close.

- **Old SQLite atomicity guarantee:** implicit — synchronous handler, no `await`
  between the DELETE and the INSERT, single connection, single process.
- **New implementation:** the pair runs inside `inTransaction`, so the guarantee
  is explicit and survives both an `await` and a connection pool.
- **Concurrency invariant protected:** *at most one live verification token
  exists per user at any time.*

### Exact scope

- `server/services/verification.js`: wrap the DELETE+INSERT pair in a transaction.
- `server/db/connectionContext.js`: refuse an **async callback** in
  `transactionOn`. This is a second hazard the conversion creates and is
  described below.
- Deterministic concurrency tests for the one-token invariant, run repeatedly
  rather than once.

**Not in scope:** making these functions `async`. See "Why no `await` is added
yet" below — this is a finding, not a shortcut.

### Why no `await` is added yet — a hazard found during this analysis

While SQLite is the live engine, **an `await` inside a transaction is unsafe in a
way it will not be on PostgreSQL.** There is one connection. `BEGIN` holds on it
until `COMMIT`. If a handler yields while a transaction is open, another
request's statements execute on that same connection — *inside* the open
transaction — and a rollback would discard work that request believed committed.

On PostgreSQL this hazard disappears, because the transaction owns a pinned
client and other requests borrow different ones. So the safe order is: convert
call sites to async **as part of the engine switch**, not before it, for any path
that runs inside a transaction. Paths outside transactions can convert freely.

Separately, `transactionOn` currently calls `fn()` and then commits. Hand it an
`async` callback and it commits **before the work finishes** — silently, with the
statements landing outside the transaction. Nothing detects that today, so it is
made an error here rather than left as a trap for group 3.

### Files and call sites

| Metric | Before | Expected after |
|---|---:|---:|
| `db.prepare`/`exec` behind the global | 653 | 653 (this module takes `db` via import but is 3 statements; the count moves in group 3) |
| Raw transaction boundaries | 0 | 0 |
| **Unprotected multi-statement invariants** | **1 known** | **0** |

### Test baseline

```
WITH PostgreSQL     430 files / 6824 passed / 2 skipped / 0 failed
WITHOUT PostgreSQL  6804 passed / 22 skipped / 0 failed
```

### Rollback checkpoint

End of module group 1. Two files change; both edits are small and independently
revertible.

### Known risks

| Risk | Containment |
|---|---|
| Wrapping in a transaction nests inside a caller's transaction | Checked all four call sites: none holds a transaction. The `inTransaction` at `accountRoutes.js:808` closes at 811, three lines before the nearest call, and is in a different handler from `issueVerificationToken` |
| The async-callback guard breaks an existing caller | No current caller passes an async function — asserted by the guard's own test suite and by the full run |

### Expected behaviour changes

**None on SQLite.** The DELETE+INSERT already ran with nothing between them; they
now do so inside an explicit transaction. The only new behaviour is an error
raised where previously a silent mis-commit was possible.

### Outcome

```
WITH PostgreSQL     431 files / 6840 passed / 2 skipped / 0 failed
WITHOUT PostgreSQL  430 passed + 1 skipped / 6820 passed / 22 skipped / 0 failed
lint clean · build ✓ 624ms
```

Focused: 16/16. Integration (12 files touching verification, signup, OAuth,
account): 163/163. Full suite green on the first run — no TD-11 retry needed.

| Metric | Before | After |
|---|---:|---:|
| `db.prepare`/`exec` behind the global | 653 | 653 |
| Files importing the global | 42 | 42 |
| Raw transaction boundaries | 0 | 0 |
| **Unprotected multi-statement invariants** | **1** | **0** |
| Tests | 6824 | 6840 (+16, 1 new file) |

**Concurrency risk discovered and fixed:** "one live verification token per user"
was enforced by nothing but synchronous execution. The schema has no unique
constraint on `user_id`, so two concurrent resends after an `await` would leave
two working links alive until expiry. Now inside a transaction.

**Second hazard found and closed:** `transactionOn` commits when its callback
*returns*, so an `async` callback commits before the work runs and the statements
land outside the transaction — silently, with the rollback path unreachable. It
now throws and rolls back. This is the easiest mistake available during the async
port, because adding `await` inside an existing `inTransaction` block looks like
progress.

**Tests added (16):** the invariant under sequential and multi-user load, held at
*every* step across 200 iterations rather than checked once at the end; an
explicit demonstration that the unprotected sequence really does produce two
tokens (so the fixed version is not passing for some unrelated reason); the
nested-interleaving refusal asserted on resulting state, not just on the throw;
six cases for the async-callback guard.

**On test vacuity — one caught here.** The invariant tests reconstruct the
DELETE/INSERT shape locally, because that is the only way to drive a genuine
interleaving. Which means deleting `inTransaction` from the shipped module would
leave all of them passing. Three source-level assertions were added to close
that, and **verified by mutation**: with the transaction removed, 2 tests fail;
restored, 16 pass.

## Phase 7 · Module group 3 — COMPLETE: the pinning proof, and a premise that failed

### Scope as planned, and what the analysis found

Group 3 was to convert the "genuinely non-transactional leaves" — `reportService`
and `badgeService`. Inspecting them first, as required, showed the premise does
not hold for either:

| Module | Finding | Disposition |
|---|---|---|
| `reportService.createReport` | **Transactional.** Three INSERTs (`reports`, `report_evidence`, `moderation_actions`) inside one `inTransaction` at line 168 | Deferred to the engine-switch wave. Async-converting it now is exactly what the revised sequencing forbids |
| `services/badgeService` | Read → decide → write with **no** transaction: reads candidates, then INSERTs or DELETEs `user_badges` | Safe as-is; see below. No conversion needed, no defect |

**`badgeService` is protected by the schema, not by synchronous execution.**
`user_badges` carries `UNIQUE(user_id, badge_id)`, so two concurrent awards
cannot double-award: the second INSERT violates the constraint and is caught by
the existing try/catch. The invariant survives the async conversion untouched.
What changes is the failure mode — from "both silently fine" to "one throws and
is swallowed" — which is a degradation in observability, not in correctness, and
is recorded rather than fixed because fixing it is not required to preserve
behaviour.

So this group converted no call sites. **653 remains 653**, and that is the
honest number: the two modules named as safe were not, and forcing them through
would have created exactly the hybrid state the sequencing rules out.

### What was delivered instead: the no-escape invariant, proved

Requirement 7 — *no database operation may escape the transaction through a
different connection* — is the gate for the entire high-risk wave. It was
previously supported only by an **outcome** test: a proxy write behaved as though
it were inside the transaction because a rollback discarded it. That is indirect.
A write could reach another client, commit independently, and a later assertion
could still pass for an unrelated reason.

It is now proved by **backend identity**. Every PostgreSQL connection is served by
its own backend process, so `pg_backend_pid()` reported from two statements is
identical only if they truly ran on the same connection. Asserted inside a
transaction across: the transaction handle itself, the unedited proxy, a real
write, and — the case the async port depends on — **after an `await`**.

Paired with a **negative control**: two concurrent transactions are shown to sit
on *different* backends. Without it, matching pids would prove nothing if the
pool only ever handed out one connection.

```
transaction begins
  → tx handle, proxy, post-write and post-await all report ONE backend pid
  → a concurrent transaction reports a DIFFERENT pid
  → COMMIT / ROLLBACK
  → client released (pool returns to idle, zero waiters)
```

### Results

```
WITH PostgreSQL     431 files / 6842 passed / 2 skipped / 0 failed
lint clean · build ✓ 651ms
```

| Metric | Before | After |
|---|---:|---:|
| `db.prepare`/`exec` behind the global | 653 | 653 (unchanged — see above) |
| Raw transaction boundaries | 0 | 0 |
| Tests | 6840 | 6842 |

### Concurrency risks recorded, not fixed

- **`badgeService` award/withdraw** is a read-modify-write whose duplicate case
  is covered by a unique constraint. Pre-existing, unchanged by the migration.
  Recorded per rule 5 rather than repaired.

## ARCHITECTURAL DECISION (owner, 2026-08-16): option D — PostgreSQL-native

**The runtime-switch requirement is relaxed.** `DATABASE_ENGINE=sqlite` and
`DATABASE_ENGINE=postgres` are no longer both required to work in the same build.

### Target architecture

- Application and database code become **async and PostgreSQL-native**.
- PostgreSQL is the production engine.
- SQLite is retained **temporarily**, as a validation / development / rollback
  aid while phase 7 proceeds — not as a permanent compatibility target.
- A production rollback means **redeploying the previous known-good build and
  database state**, not keeping two execution models alive.
- SQLite runtime support and the dual-engine machinery are removed in a
  **dedicated retirement phase** after cutover, not folded into each conversion.

### Explicitly ruled out

- No permanent dual-engine orchestration across the 653 call sites.
- No duplicated synchronous/asynchronous implementations of business logic.
- No generator/`yield` abstraction.
- No batch-restructuring of functions merely to keep SQLite working.

### The sub-decision this forces, and how it is being taken

Converting a function to async PostgreSQL-native would break every existing test
that drives it on SQLite — and **164 test files** go through `startTestServer`.
Losing that coverage during the conversion is worse than the conversion is worth.

The resolution is squarely inside the allowance for engine differences at the
**adapter layer**: give the SQLite adapter an async transaction that opens its
own connection for the duration, mirroring what PostgreSQL's pooled client does.
Business logic is then written **once**, async, and both engines satisfy it —
without any dual orchestration, because the difference lives entirely in the
adapter.

This is practical here for a reason worth recording: `startTestServer` backs its
database with a **file** (`test.db`), not `:memory:`, and SQLite in WAL mode
supports a second connection to a file. Only **29** test files use `:memory:`
directly, and those are unit-scale.

This is adapter machinery with a scheduled end: it is removed in the retirement
phase along with the rest of the SQLite path.

## Phase 7 · Wave 8 — COMPLETE: `recordAudit` is async, end to end

Landed by hand in the documented order — 8a (untransacted callers), 8b (the 18
synchronous transactions), 8c (the writer itself) — with the tree green on both
engines between each. The scoping analysis that follows this summary is kept
because its numbers are what the work was checked against.

**8a — 21 call sites.** Fourteen untransacted callers awaited, with eight
enclosing handlers made `async`. The seven `recordAudit(tx, …)` sites left over
from waves 6–7 were already inside `async (tx) =>` callbacks — verified by brace
balance rather than by nearest-match, because `accountRoutes.js:225` sits 130
lines below its opening `runInTransaction` — and awaited.

Two sites resisted and were decided individually:

- `privacyRoutes.js:252` is inside `res.download`'s completion callback. The
  callback was made `async`; the call already sat in a `try/catch`, and the
  file's own comment rules moving the audit out of the callback as a behaviour
  change beyond this task.
- `db.js:326` is the boot-time username dedupe, inside `initDatabase()` — which
  is synchronous and called synchronously from `server.js`, `testServer.js`,
  four `bin/` scripts and some forty test files. It kept a synchronous write.
  See 8c.

**8b — 18 synchronous transactions converted** to `runInTransaction`, one file
at a time, syntax-checked between each and covered by that subsystem's tests
before moving on: `adminRoutes` 7, `badgeRoutes` 3, `appealsRoutes` 2,
`invitationRoutes` 2, and one each in `contentRoutes`, `errorRoutes`,
`eventRoutes`, `messageRoutes`. Every statement inside each converted block was
re-pointed at the transaction handle, not left on the ambient proxy.

**8c — the writer.** `recordAudit` is now `async` and awaits its own INSERT,
which is the point: on PostgreSQL `.run()` returns a promise, so without the
await the row is merely scheduled and a transaction can commit before its audit
write lands.

The boot path could not await, and neither escape was acceptable — a dropped
promise there converts every failure into an unhandled rejection delivered
*after* the dedupe's `COMMIT`, and a raw INSERT is forbidden by
`auditLog.test.js`. So `auditLog.js` gained `recordAuditSync`: the same
validation, id scheme, timestamp and SQL, sharing `auditValues()` and
`INSERT_SQL`, differing only in the two lines that await. It is held to its one
caller by name — a guard that fails if any second file calls it — and retires
with SQLite.

**Six `bin/` call sites were invisible to Guard 7**, whose scan walks `server/`
only. They are the worst possible set to miss: `make-admin`, `grant-ownership`,
`revoke-ownership`, `bootstrap-owners`, `reset-2fa` and `clear-stale-tfa-secret`
each write the audit row for a privilege change from inside `BEGIN … COMMIT`,
relying on the write throwing to roll the grant back. All six now await, and
Guard 7 was widened to `bin/` with its own vacuity tripwire. This is the eighth
time in this project a guard's scan has been narrower than the behaviour it
polices.

### Guards, mutation-tested

Nine mutations, each reverted after proving its guard bites:

| Mutation | Guard that failed |
|---|---|
| drop one `await recordAudit` | Guard 7 — awaits every async spend helper |
| call `recordAuditSync` from a second file | `auditLog` — called from db.js and nowhere else |
| `recordAudit` stops awaiting its INSERT | `auditLog` — propagates a REJECTING run |
| reintroduce a raw `INSERT INTO admin_audit_logs` | `auditLog` — the helper is the only writer |
| drop the `await` in `bin/make-admin.mjs` | Guard 7 (bin) — awaits every audit write in bin/ |
| `recordCliAudit` stops awaiting its delegate | Guard 7 (bin) — keeps recordCliAudit awaiting |
| widen the bin scan's skip to all `.mjs` | Guard 7 (bin) — finds the call sites at all |
| remove the SQLite write gate | write-gate — 3 of 4 assertions, reproducing the 37s stall |
| never release the write gate | write-gate — all 4, by hanging |

## Wave 8 aftermath — a deadlock in the SQLite transaction adapter

Found by the full PostgreSQL suite going red on `twoFactor.singleUseRace`, and
worth recording because the first three readings of it were all wrong.

It was not a PostgreSQL failure: that test never opens a connection to the
adapter database — sampling `pg_stat_activity` throughout a run showed zero. It
was not fork-pool contention (TD-11) either: it reproduced in isolation, four
times, at 37–43 seconds against a 30-second timeout. And it was not pre-existing
— a `git worktree` at HEAD runs the same file in **6.46s, 4 passed**.

The mechanism, measured by tracing `BEGIN`:

```
[tx] BEGIN owned=true waited=0ms
[tx] BEGIN FAILED after 5396ms: database is locked     ×7
```

`runInTransaction` gives a SQLite transaction its own connection, and contention
between two connections is supposed to be absorbed by `PRAGMA busy_timeout`.
That answer requires a thread that can keep running while another releases the
lock. `node:sqlite` is **synchronous**: the wait happens inside a C call on
Node's only thread, and the holder's `COMMIT` is a JavaScript continuation
queued behind it. The lock cannot be released while anyone waits for it, so
every contender burns the full timeout and then fails `SQLITE_BUSY`.

Not a test artefact. SQLite is the live engine until cutover, and the same shape
applies to every converted transactional endpoint — two students clicking at
once freeze the whole process for five seconds. A denial of service against
ourselves, introduced by the conversion.

**Fixed** with an in-process queue in `sqliteTransaction.js`: a contending writer
`await`s, which yields the event loop and lets the holder commit. That is the
one thing blocking in C cannot do. Raising the timeout lengthens the freeze;
lowering it turns the freeze into instant failure — the blocking *is* the bug.
Serialising also states SQLite's own rule directly rather than discovering it
through lock errors. `busy_timeout` is retained for an out-of-process writer,
which the gate cannot see and which, unlike this case, can actually commit while
we wait.

Pinned by `server/db.sqliteWriteGate.test.js`, which asserts all eight
transactions commit, that the run finishes inside one `busy_timeout`, that peak
concurrency is exactly one, and that a rollback opens the gate behind it. It is
file-backed deliberately: a `:memory:` version would pass without executing a
single line of the gate.

### Verification after wave 8

```
npm test                                   433 files | 6866 passed | 34 skipped | 0 failed
TEST_POSTGRES_URL=… npm test               435 files | 6898 passed |  2 skipped | 0 failed
npm run lint                               clean
npm run build                              ✓
npm audit                                  0 vulnerabilities
```

Nothing committed. SQLite remains authoritative.

### Next operation

Phase 7 continues with the remaining synchronous transactions outside the audit
path, sequenced below.

## Phase 7 · remaining surface and wave plan (set 2026-08-16)

32 synchronous transaction sites remain in 16 files. Ordered by blast radius,
least first, so that the riskiest conversions happen against the most
already-converted tree:

| Wave | Subsystem | Sites | Why here in the order |
|---:|---|---:|---|
| 9  | `messaging.js` + `messageRoutes.js` | 4 | self-contained; no derived state, no capacity |
| 10 | `reportService.js` + `appealsRoutes.js` | 4 | moderation records; append-mostly |
| 11 | `organizationRoutes.js` | 5 | membership and roles; no hours |
| 12 | `accountRoutes.js` + `services/verification.js` | 4 | account lifecycle; token invariants already pinned |
| 13 | `eventRoutes.js` + `authRoutes.js` + `oauthRoutes.js` | 5 | event edit paths and session issue |
| 14 | `applicationRoutes.js` | 3 | **capacity** — the conditional-write races from wave 4 |
| 15 | `attendanceRoutes.js` | 3 | **derived hours** — the ledger invariant |
| 16 | agreements + `retentionWorker.js` | 3 | the three `transactionOn` holdouts |
| 17 | boot path: `initDatabase()` | — | what `recordAuditSync` is waiting on |

Invariants that hold across every wave, and are what focused tests check before
the suite runs:

- no ambient `db` inside an async transaction body — every statement moves to
  the `tx` handle, because the proxy resolving to the pool is the silent
  failure this whole phase exists to prevent;
- callers convert before callees for anything whose contract is a throw;
- structural edits by hand, one file at a time, `node --check` between each;
- a conversion that changes a refusal, a row count or an ordering is a defect,
  not a conversion.

Rollback point for every wave: nothing is committed, SQLite remains
authoritative, and `git diff` for the wave's files is the whole change.

## Phase 7 · Waves 9–16 — COMPLETE: 32 synchronous transactions → 1

All executed by hand, one file at a time, `node --check` between each, focused
tests before the suite, both engines green after every wave.

| Wave | Subsystem | Sites | Notes |
|---:|---|---:|---|
| 9  | `messaging.js`, `messageRoutes.js` | 4 | three conversation resolvers became async; one call site each |
| 10 | `reportService.js`, `appealsRoutes.js` | 4 | `createReport` async; evidence collection moved onto `tx` |
| 11 | `organizationRoutes.js` | 5 | membership, bans, org appeal decisions |
| 12 | `accountRoutes.js` | 3 | password reset, email change, email verification |
| 13 | `eventRoutes.js`, `authRoutes.js`, `oauthRoutes.js`, `services/verification.js` | 6 | includes the 106-line event-edit block |
| 14 | `applicationRoutes.js` | 3 | capacity and waitlist promotion |
| 15 | `attendanceRoutes.js` | 3 | the derived-hours ledger and QR check-in |
| 16 | `studentOrganizerAgreement.js`, `workers/retentionWorker.js` | 2 | the destructive retention sweep |

**Global database call sites: 653 → 518**, and the access-surface ratchet was
lowered to match. The file count stays at 42 — a module keeps its import while
one statement still uses it — so the drop is statements moving onto an explicit
`tx`, which is the direction the ratchet exists to encourage.

### The boundary these waves drew, and the test that justifies it

Statements written directly in a transaction body move to `tx`. Helpers reached
*transitively* — `promoteFromWaitlist` and `assignWaitlistOrder` are the
capacity-critical ones — keep using the ambient handle, because converting that
transitive closure means making every read in the application async, which is
the rest of the migration rather than a transaction wave.

That boundary is only sound if the proxy really does resolve to the
transaction's connection, and keeps doing so after the body yields.
`db.connectionContext.test.js` proved the binding survives an await, but against
`withConnection` and a single in-memory handle — where there is no second
connection to resolve to and so nothing to get wrong. The case that matters is
file-backed, where `runInTransaction` genuinely opens one.

`db.sqliteWriteGate.test.js` now asserts it end to end: a post-await ambient
write is invisible to the default connection while the transaction is open,
commits with it, and is discarded by its rollback. Mutation-tested by removing
the `withConnection` binding — two assertions fail. **If those two ever fail,
this boundary is wrong and those helpers need explicit handles.**

### One site deliberately not converted

`organizerAgreement.js:262` (`acceptOrganizerAgreement`) stays synchronous. Its
route caller is ready for async; its second caller is `seedOrganizerAcceptance`
in `db.js`, DEMO_MODE-only boot seeding inside the synchronous `initDatabase()`.

Converting it needs one of: making `initDatabase()` async, which cascades to
`server.js`, `testServer.js`, four `bin/` scripts and some forty test files; a
second sync twin, which turns the `recordAuditSync` exception into a pattern; or
moving the seeding out of boot, a boot-ordering change with unclear blast radius
across the demo-mode tests. None is justified for one call site on a path that
is replaced wholesale when PostgreSQL boots from its own schema. It converts
with the boot wave, next to `recordAuditSync`.

### A lint gap found and closed

`organizationRoutes.js` shipped a 500 on organization creation because the
conversion added `runInTransaction` calls without the import. `npm run lint`
passed: `no-undef` was not enabled, and oxlint does not enable it by default.

A probe confirmed it — a file calling `notDefinedAnywhere()` linted clean. The
rule is now on, with `env: {node, browser, es2024}` so the globals resolve, and
the repository is clean under it. Mutation-tested by deleting that exact import:
three `no-undef` errors, at the three call sites. It caught the same mistake
again in wave 14 before any test ran.

### A guard that could erase itself

`verification.tokenInvariant.test.js` searched for the literal `export function
issueVerificationToken`. When wave 13 made it `async`, the tripwire threw during
**collection**, so vitest reported the file as *0 tests* — the guard was right
and still took its own coverage down, along with the other eight tests in the
file.

Fixed by matching `export\\s+(?:async\\s+)?function` and, more importantly, by
reading the source inside the tests rather than at describe scope, so a miss is
one failing test instead of a vanished file. Mutation-tested: renaming the
function now fails 4 of 17 tests with 13 still running; before, it erased all
17. A scan of the suite found no other guard with a collection-time `expect`.

### Verification after wave 16

```
npm test                                   6870 passed | 34 skipped | 0 failed
TEST_POSTGRES_URL=… npm test               6902 passed |  2 skipped | 0 failed
npm run lint                               clean (now including no-undef)
npm run build                              ✓
```

## Phase 8 — the async port: measured, and it is the bulk of what is left

Phase 7 converted transaction *boundaries*. It did not make the application
async, and `server/db/engine.js` is explicit about why that gate is still shut:
on PostgreSQL every statement returns a promise, so a half-ported application
"would start cleanly and then hand `Promise { <pending> }` to every branch that
reads a row" — capacity checks, hours totals and authorization lookups all
evaluating as truthy objects. A server that starts, serves, and is wrong.

**This is the first accurate count of that surface.** Scanned for
`.prepare(…).get|all|run|iterate(…)` with and without `await`:

| Area | Files | Sync call sites |
|---|---:|---:|
| `routes/` | 23 | 493 |
| other server modules | 45 | 252 |
| `workers/` | 3 | 37 |
| `services/` | 5 | 25 |
| `db.js` (boot) | 1 | 16 |
| **app code total** | **77** | **823** |
| `migrations/` — retires with SQLite, never runs on PostgreSQL | 41 | 119 |

996 query sites exist; 54 are already awaited (phase 7's work); **823 in
application code still need converting**, plus 119 in migrations that do not.

Worst first: `eventRoutes` 67, `adminRoutes` 54, `organizationRoutes` 54,
`accountRoutes` 47, `contentRoutes` 40, `appealsRoutes` 31, `applicationRoutes`
28, `messaging` 26, `authRoutes` 25, `oauthRoutes` 23, `utils` 21.

### How this should be sequenced

Leaf-first, not route-first. Converting a module's reads makes its exported
functions async, which cascades to every caller — so a module with no dependents
converts cleanly, while starting at `eventRoutes` would force half the
codebase's signatures at once. The order that falls out: pure query helpers
(`eventQuery.js`, `profileSerializer.js`, `organizations.js`) → domain services
→ `utils.js` → routes → `db.js` boot last.

The caller-before-callee rule does **not** apply here and must not be borrowed
from phase 7: it exists for helpers whose contract is a throw, where flipping the
callee first makes a refusal fail open. A read returning a promise instead of a
row fails loudly and immediately, so callee-first is both safe and the only order
that terminates.

### Dialect translation — decided, deliberately not implemented yet

Six `INSERT OR IGNORE`, four `strftime`, one `julianday` and the `datetime('now')`
family are all specified in the SQL semantic inventory above. Four app sites were
re-read and confirmed as genuine unique-conflict dedupe (`legalStore`,
`emailService`, `hoursLedger`, `resendWebhook`), each relying on `changes === 0`,
which `ON CONFLICT DO NOTHING` matches.

They were **not** rewritten, for two reasons. `INSERT OR IGNORE` also suppresses
NOT NULL, CHECK and FK violations, which `ON CONFLICT DO NOTHING` raises — so the
rewrite turns a silent skip into a thrown error, and in `hoursLedger` that throw
is inside the attendance transaction. And it buys nothing until the 823 sites
above are converted, because the engine cannot be selected before then. Doing it
now would be an unverifiable behaviour change on the derived-hours path.

`sqlPlaceholders.js` argues dialect translation belongs at the call sites rather
than in a mechanical pass, and that position is left standing.

## Phase 7 — COMPLETE: zero synchronous transactions remain

The boot blocker is gone. `seedOrganizerAcceptance` is extracted from
`initDatabase()` and exported as async; the two real boot paths — `server.js`
(top-level await) and `testServer.js` (already async) — await it. `initDatabase`
itself stays synchronous, so the forty-odd test files and four `bin/` scripts
that call it are untouched. `assertNoDemoOwner()` still runs last and does not
depend on the seed.

That unblocked `acceptOrganizerAgreement`, the final synchronous transaction,
which now uses `runInTransaction` with `recordAcceptances(tx, …)`.

**`grep` for `inTransaction(`/`transactionOn(` outside their own definitions
returns nothing.** 32 → 0.

One test boots the real app itself rather than through `testServer.js` —
`realtime.socket.test.js` — and lost the seed with everything else. Without the
acceptance row the demo organizer's capabilities stay withheld, so five tests
failed on an undefined fixture. It now awaits the seed too. That is the correct
fix rather than a workaround: it is a boot path, and it was relying on boot
doing the seeding.

### A flaky guard, reproduced and fixed rather than dismissed

`envDocumentation.test.js` failed once in a full run and passed in isolation and
in the very next full run — the TD-11 signature. Investigated rather than
retried: its `sourceFiles` walker called `statSync` on **every** directory entry
*before* filtering by extension, so a transient SQLite `-wal`/`-journal` written
by another test file running in parallel could vanish between the `readdir` and
the `stat`, taking the guard down with ENOENT.

Rewritten to use `readdirSync(dir, { withFileTypes: true })`, which reports the
type without a second syscall and so has no race to lose — the same idiom
`db.accessSurface.test.js` already uses. The guard's scan is unchanged; only the
walk is.

## Phase 8 · Wave 1 — COMPLETE: the authorization predicates

The first Phase 8 wave, and deliberately not the biggest one. It took the
call graph that decides **who may do what**, because that is the part of this
phase that can fail silently.

### The fail-open shape, and why it needed a guard before any conversion

Most of Phase 8 is safe by construction. A function that returns a row and is
left unawaited hands back a promise, and the first property read off it is
`undefined` — loud, immediate, and caught by any test that exercises the path.
Helpers returning `{ ok }` fail *closed* for the same reason: `promise.ok` is
`undefined`, so the refusal fires.

Boolean predicates are the exception, and they invert it:

```js
if (canRunEvent(db, event, userId)) { /* grant */ }
```

A pending promise is an object, and every object is truthy. The moment
`canRunEvent` became async, that branch stopped asking a question and started
answering "yes" — to every caller, for every event.

**Demonstrated, not asserted.** With one `await` removed from
`eventRoutes.js`, `npm test` across `canRunEvent`, `routes.event*` and
`routes.eventUpdate` — **183 tests — passed.** The functional suite verifies
that authorized users succeed; almost nothing verifies that unauthorized users
are refused on *every* route, so a total bypass is invisible to it.

`Array.filter` is the same hazard in another syntax: `.filter(a => f(a).ok)`
never awaits, so the predicate's answer is ignored for every element.
`autoSelect.js` had exactly this, and it failed closed (nobody selected) only by
the accident of reading `.ok`. It is now an explicit loop.

### Guard 8

`authz.completeness.test.js` gained a guard modelled on Guard 7: a source scan
requiring `await` at every call site of an authorization predicate, keyed off
whether the predicate is *currently* async. It was committed **before** the
conversion, deliberately inert while the predicates were still synchronous, so
that whoever flipped them — this session or a later one — could not ship the
bypass. It fired correctly the moment they flipped, and its vacuity tripwire
runs either way.

Mutation-tested three ways: flipping a predicate to async with call sites
unawaited (fails, naming each file:line), removing a single `await` from a real
route (fails), and renaming a defining file (fails rather than silently
answering "not async" for everything).

### What converted

| | |
|---|---|
| Predicates now async | `canRunEvent`, `canHelpRun`, `eventApplicationEligibility`, `eligibleRelationship` |
| Helpers now async | `publicProfile`, `organizationsFor`, `buildProfileResponse`, `createOrganization`, `promoteFromWaitlist`, `handleWaitlistPromotion`, `computeDraw`, `hostRefusal`, `loadManagedOrganization` |
| Predicate call sites awaited | 42 across 8 source files |
| Async function declarations in `server/` | 30 → **61** |
| Raw query sites (`.prepare().get/all/run`) | 823 → **821** app-code sync |

The raw query count barely moved, and that is the honest picture: this wave
converted the **call graph above** the queries, not the queries themselves. Both
have to happen, and the graph had to go first for the predicates, because
converting a query site inside a still-synchronous predicate is what creates the
bypass.

`eventQuery.js` — first on the recorded plan — turned out to have **zero** query
sites. It is a pure SQL-string builder and needs no conversion at all.

### Method correction, recorded

Bulk regex passes were used for the mechanical `await` insertion and they
produced three classes of damage, all caught by lint and fixed by hand:

- `autoSelect.await computeDraw(…)` from a namespaced pattern;
- `await expect(await fn(…)).rejects` — a double await that throws before
  `expect` can catch it, in two places;
- `await x(…).map(…)`, which awaits the `.map` rather than the call.

And a scoping error worth remembering: several scans used `git ls-files`, which
lists only **tracked** files. The entire adapter (`server/db/*.js`) and ten test
files are untracked in this working tree, so they were silently skipped. `npm
run lint` walks the filesystem and caught the consequences, but the lesson is
that a scan keyed on git state measures the index, not the tree.

An `async` `describe` callback was also introduced and reverted: vitest does not
await it, so the setup inside would have run after the tests.

## Phase 8 · Wave 2 — COMPLETE: the capability kernel and the relationship graph

Wave 2 was meant to be leaf helpers. Following the dependency chain honestly
turned it into the authorization kernel, because the leaves feed it.

### The chain, and why it had to be converted as one unit

```
grantCapability / revokeCapability      (userCapabilities.js)
  → syncOrganizerCapabilities            (organizationRoles.js)
  → helpsRunAnywhere                     (organizationRoles.js)
  → studentOrganizerWithholdingsFor      (studentOrganizerAgreement.js)
  → hasAccepted*Agreement                (both agreement modules)
  → withheldCapabilitiesFor              (organizerAgreement.js)
  → buildPrincipal                       (utils.js)
  → authenticateToken                    (utils.js)
```

Every one of those reads the database, so every one becomes async, and stopping
halfway leaves a promise being read as a value somewhere in the middle. It was
converted callee-first with each caller awaited in the same edit.

### A silent capability grant, found and fixed

`authz.js` decided withholding with:

```js
if (Array.isArray(principal.withheld) && principal.withheld.includes(cap)) return false;
```

That reads as defensive and is the opposite. **Any** non-array made the
condition false, so the withholding step was skipped and the capability
**granted**. The port makes it reachable: `withheldCapabilitiesFor` is async
now, and one unawaited caller passes a Promise — `Array.isArray(promise)` is
false, and an organizer who never accepted the Organizer Agreement silently
recovers every capability that document gates.

`can()` now throws a `TypeError` on a non-array `withheld`, naming a Promise
specifically. `null`/`undefined` stay legal, because `principalFor` defaults
them. Covered by `authz.withheldType.test.js` (5 cases) and mutation-tested by
restoring the tolerant form — two assertions fail.

This is a **pre-existing latent defect**: the tolerant check was always a silent
grant waiting for a wrong type. The migration is what made it reachable.

### Two more fail-open array shapes

`Array.filter` with an async predicate never awaits, so every element passes:

- `messageRoutes.js` user search filtered candidates through `areFriends`.
  Unconverted, the search would have returned **strangers as friends**, which is
  what opens the friends-only tier of a profile — school, grade, bio for a
  minor. Rewritten as a loop.
- `listConversationsForUser` mapped `decorateConversation` over its rows. An
  array of pending promises serialises to `[{}, {}]` — an empty conversation
  list that looks like a real one. Rewritten with `Promise.all`.

### `authenticateToken` is async, and cannot throw

Express 4 does not await middleware and does not catch a rejected one, so an
async auth callback that throws would be an unhandled rejection and take the
process down. The whole post-verify body is wrapped: any failure is answered as
a 500 by the middleware itself. That is also the only safe answer — a request
whose principal could not be built must never reach a handler with
`req.principal` undefined.

### Modules completed

`userCapabilities.js`, `organizationRoles.js`, `organizerAgreement.js`,
`studentOrganizerAgreement.js`, `evidenceHolds.js`, `blocking.js`,
`relationships.js`, plus the `utils.js` auth kernel and the messaging
conversation layer.

Guard 8 now protects **12 predicates**, each registered *before* it became
async: the five from wave 1 plus `areFriends`, `arePeers`,
`isRestrictedBetween`, `isBlockedBetween`, `eventHasLiveReport`,
`commentHasLiveReport`, `userIsPartyToLiveReport`, `helpsRunAnywhere`,
`hasAcceptedOrganizerAgreement`, `hasAcceptedStudentOrganizerAgreement`.

Async function declarations in `server/`: 61 → **188**.

## Phase 8 · Wave 3 — COMPLETE: the hours ledger, and the boot split

`recordHoursChange` is the ledger writer on the attendance path, and
`backfillHoursLedger` is a boot step that calls it — so converting one forced
the other, and the boot problem deferred twice already had to be answered.

### `completeDatabaseInit()`

`initDatabase()` stays **synchronous**. It is called synchronously from
`server.js`, `testServer.js`, four `bin/` scripts and some forty test files, and
on PostgreSQL its schema-building half does not run at all — the schema comes
from `supabase/migrations/`. Making it async converts every one of those call
sites for the benefit of a path that is being retired.

So the async work was collected into one exported `completeDatabaseInit()`,
awaited by the real boot paths: the hours-ledger backfill, its parity check, and
the DEMO_MODE organizer seed. DDL (`createHoursLedgerTable`) stays in the
synchronous half.

**The split has a footgun, and a test caught it.** `initDatabase()` alone no
longer produces the database a running server would have.
`tooling.dbPath.test.js` seeded a database that way and then failed the ledger
parity gate — *"ledger 0 vs attendance 3"*. Two `bin/` scripts had comments
saying in as many words that they relied on `initDatabase()` running the
backfill (`// runs backfill`, `// This will trigger initHoursLedger…`), so the
omission was silently breaking them too.

Every dependent caller now awaits the second half — `reset-dev-db`,
`seed-pilot`, `simulate-pilot` and the test fixture — and `initDatabase`'s own
header states the contract so the next caller cannot be surprised by it.

### Also converted

`finalizeAttendance` (the derived-hours path), `verifyLedgerParity`,
`getLedgerForUser`, and `verifyHours.js`'s operator gate.

### Four precedence bugs, all from the same mistake

Inserting `await` mechanically in front of a call is wrong whenever the result
is immediately used:

- `await f(db).ok` awaits the *property*, yielding `undefined` — 11 sites across
  three test files, plus one on the local `finalize` helper.
- `await db.prepare(…).all().map(…)` awaits the `.map`, which on PostgreSQL runs
  `.map` on a promise — one site in `hoursLedger.js`.
- `await expect(await f(…)).rejects` throws before `expect` can catch it — three
  sites.

All were found by tests rather than by review, and all are now fixed with
`(await f(…)).prop`. A repo-wide scan for each shape returns clean.

Async function declarations in `server/`: 188 → **197**.

## Phase 8 · Wave 4 — COMPLETE: every route file

All 23 route modules converted — roughly 490 `db.prepare(…).get/all/run(…)`
chains now awaited, and every handler that needed it made `async`.

**App-code synchronous query sites: 823 → 299.** 578 of 996 total sites are
awaited; the 119 in `migrations/` are excluded by design, since they retire with
SQLite and never run against PostgreSQL.

### `server/asyncShapes.test.js` — the guard that made this safe

Waves 1–3 produced the same mistake five times, and every instance was found by
an unrelated failing test rather than by review. Inserting `await` in front of a
call is only correct when nothing else happens on that expression. The new guard
scans for all five shapes, restricted to functions this codebase actually
declares `async` so it cannot fire on legitimate thenables:

| Shape | Why it is wrong |
|---|---|
| `await f(x).prop` | awaits the *property* of a pending promise → `undefined` |
| `await db.prepare(…).get(…)?.col` | same, through optional chaining |
| `await expect(await f()).rejects` | the inner await throws before `expect` sees it |
| `.filter/.some/.every(x => asyncFn(x))` | never awaits; every element passes |
| `describe('…', async () => {})` | vitest does not await it; setup runs too late |

All five are mutation-tested. Two of them were written to catch a shape that had
*already happened*; the optional-chaining variant was added after
`organizationRoutes.js` produced one the first version missed — and on the very
next run it found **two more live instances** in the image-upload paths that
would have read `undefined` instead of the previous image URL.

### Bugs this wave found

- **`issueSession` broke every sign-in.** Made async by the cascade, its first
  statement is a `last_sign_in_at` write, so it suspended *before* setting the
  cookie while nine callers carried on to `res.json()`. 801 tests failed with
  `401 Access token required`. Fixed by awaiting all nine call sites — a
  textbook case of why an unawaited async function that mutates a response is
  not merely slower but wrong.
- **Three `.map()` callbacks** became async without `Promise.all` — the appeals
  queue, the organization appeals list and the admin roster would each have
  serialised an array of pending promises as `[{}, …]`, an empty-looking list
  that reads as real data. All three now use `Promise.all`.
- **`adminRoutes` dashboard totals** all read `.c`/`.h` directly off the query,
  so every figure would have rendered blank rather than erroring.

## Phase 8 · Wave 5 — COMPLETE: `messaging.js`, `utils.js`, and two fail-open bugs

**App-code synchronous query sites: 823 → 255.** 622 of 996 sites awaited.

### Two more silent shapes, both caught by tests, both now guarded

**Spreading a promise.** `selfUserResponse` did `...formatUserResponse(row)`.
A promise has no own enumerable properties, so the spread contributed
**nothing** — the signed-in user object lost its `id`, the next query bound
`undefined`, and **940 tests** failed with "Provided value cannot be bound to
SQLite parameter". Nothing about the expression looks wrong.

**Negating a promise — a fail-open refusal.** `reportService.js` had
`if (!canReporterSee(type, resolved, reporter.id)) return 404`. A promise is
truthy, so `!promise` is always `false` and the refusal became unreachable: a
reporter could file against a target they cannot see and learn from the `200`
that it exists. The suite names this exactly — *"answers identically for a
real-but-invisible target and one that does not exist"* — and it caught it.

`canReporterSee` is module-private, so Guard 8 (which keys on exported
predicates by name) could not see it. The shape guard catches it structurally
instead, and is mutation-tested by restoring the bug.

`server/asyncShapes.test.js` now covers **eight** shapes, each mutation-tested:
property access, optional-chained property access, `prepare()` chains,
`await expect(await …)`, filter/some/every predicates, spreads, negations, and
async `describe` callbacks.

### And one that broke every sign-in

`issueSession` became async with a `last_sign_in_at` write as its first
statement, so it suspended **before setting the session cookie** while nine
callers proceeded to `res.json()`. 801 tests failed with `401 Access token
required`. It is the clearest case in this migration of why an unawaited async
function that mutates a response is wrong rather than merely slow.

## Phase 8 · Wave 6 — PARTIAL, and one tranche deliberately reverted

Wave 6 took `hoursLedger`, `attendance`, `moderation`, `errorReporter`,
`exportWorker`, `legalStore`, `consent`, `legalNotices` and `reauth`. Most of it
held. **Six modules and `reauth.js` were reverted**, and that decision is the
important part of this entry.

### Why the revert

Converting `legalStore` made `resolveDocument` async, which made
`syncLegalDocuments` async, which could no longer run inside the synchronous
`initDatabase()`. Moving it into `completeDatabaseInit()` meant ~40 test files
that call `initDatabase()` alone booted **without legal documents**, and signup
depends on them. That cascaded to ~480 failures.

`reauth.js` was worse: the bulk pass made `load()` and `peekChallenge()` async,
both of which earlier waves had recorded as **deliberately synchronous**. It
also shifted where `grantByPassword` first yields, so the account-wide lockout
started answering before `commitGrant`'s duplicated `attempts < ?` predicate —
changing which defence refuses a challenge locked mid-bcrypt. The refusal still
happened, but the test proving that specific predicate was no longer proving it.

Reverting was cheaper and safer than converging: `legalStore`, `consent`,
`errorReporter`, `moderation`, `exportWorker` and `legalNotices` matched HEAD
exactly once reverted, confirming no earlier-wave work was lost.
`reauth.js` was restored from HEAD, which costs the wave-7 `consumeChallenge`
conversion — the call-site `await`s elsewhere are harmless no-ops on a
synchronous callee, so nothing else needed unwinding.

**This is recorded rather than hidden because the lesson is reusable: a module
whose conversion forces a boot-order change should be converted with the boot
wave, not before it.**

### What wave 6 kept

`hoursLedger`, `attendance` and the check-in path, plus `completeDatabaseInit()`
for the ledger backfill, parity check and DEMO_MODE seed — with every dependent
caller (`server.js`, `testServer.js`, three `bin/` scripts, ~33 test files)
awaiting it.

### A transaction-lifetime bug, and 50 latent PostgreSQL bugs

`computeEventCompletion(tx, …)` was called unawaited inside the attendance
transaction, so it used the transaction handle **after commit** — 13 unhandled
`database is not open` rejections per suite run. Fixed by awaiting it.

Investigating that surfaced a whole class the shape guard could not see: it
scans line by line, and

```js
const total = await db.prepare(`
  SELECT COUNT(*) AS c …
`).get(eventId).c;      // ← `.c` read off the PROMISE
```

spans three lines. **50 of these existed across 21 files.** They are invisible
on SQLite — `.get()` returns a value there, so `await value.c` is correct — and
would every one of them have read `undefined` on PostgreSQL. All 50 are now
parenthesised. The fix is a no-op on SQLite, which is why it could be made
safely at this point.

`asyncShapes.test.js` still scans per line; extending it to multi-line
expressions is the first thing the next session should do, because that scan is
what would have caught these.

## Phase 8 · Wave 7 — COMPLETE: multi-line guard, then the analytics and badge group

### The guard was extended first, and it immediately paid for itself

`asyncShapes.test.js` scanned line by line, which is why it missed 50 real bugs.
Both property scans now run against the whole file with the `s` flag and derive
line numbers from match offsets. This works because `strip()` blanks
template-literal *contents* while preserving newlines, so by the time a scan
runs the SQL is whitespace and the expression matches cleanly across lines.

On its first run the widened guard found **four more live bugs** that the
earlier bulk fix had missed — `contentRoutes` ×2, `userRoutes`,
`retentionWorker` — all cases where nested SQL parens (`COALESCE(SUM(…))`, a
subquery) defeated the fix regex but not the guard. Mutation-tested with the
exact three-line shape that had escaped: it is now reported, with the right line.

### Converted

`volunteerStats`, `volunteerInsights`, `impact`, `organizationHours`,
`checkinTokens`, `organizations`, and the badge service
(`collectStats` → `evaluateBadges`), plus their route entry points and ~90 test
call sites.

**App-code synchronous query sites: 235 → 202.** 675 of 996 awaited. Async
declarations 238 → **269**.

### A third fail-open, caught by the guard rather than by a test

`attendanceRoutes.js` had `if (!consumeCheckinToken(tx, …)) return { raced: true }`.
Unawaited, `!promise` is always `false`, so the replay check never fired and a
QR check-in code could be redeemed **twice**. No test covered that specific
branch; the negation guard named it directly.

### Method note

The guard is now the risky-site detector. The reliable loop is: insert `await`
on plain sites → run `asyncShapes` → it names every expression needing
parentheses, with file and line → fix those → let `oxlint` name the enclosing
scopes. Ad-hoc regex scanning for risky sites is no longer needed and was less
accurate than the guard.

Bulk `await` insertion still re-introduces already-fixed shapes when it runs
over the whole tree, so the guard must be re-run after **every** such pass. It
caught that three times in this wave.

## Phase 8 · Wave 8 — COMPLETE: the independent module group

`relationships`, `services/autoSelect`, `adminInvitations`, `appeals`,
`certificates`, `instanceLock`, `reportService` — plus the cascade they pulled
in (`recordAppealEvent`, `recordRun`, `latestRun`, `disqualifiers`,
`getOrCreateCertificateCode`, `backfillCertificates`, `viewerRelationshipState`
and ~150 call sites).

**App-code synchronous query sites: 202 → 156.** 721 of 996 awaited.

### `reauth.test.js` restored to HEAD

Wave 6 reverted `reauth.js` to HEAD. Its test file still carried the edits made
while the module was async — including an assertion loosened to accept either
`locked` or `account_locked`. Against the synchronous module that assertion
started passing for the wrong reason, and one case reported the grant as
**succeeding**. Both files are now at HEAD together, which is the only coherent
state: a test file and the module it pins move as a pair.

### The guard's per-line blind spot, again

A bulk pass produced `await expect(` at the end of one line and `await
recordAudit(` at the start of the next — the same double-await the guard already
catches, but split across a newline. That scan is now whole-file like the other
two, and mutation-tested with the split form.

**Three of the eight shape checks have now had to be widened from per-line to
whole-file after missing a real instance.** Any new shape added to this file
should be written whole-file from the start.

## Phase 8 · Wave 9 — the boot cluster, converted

The wave that wave 6 could not complete. **App-code synchronous query sites:
156 → 58.** 819 of 996 awaited.

### The legal cluster, and why it worked this time

`legalStore`, `consent` and `legalNotices` are async, and `syncLegalDocuments`
now runs in `completeDatabaseInit()`. Wave 6 attempted exactly this and produced
~480 failures, because ~40 test files called `initDatabase()` alone and then
found no `legal_documents`. Those callers were updated in the meantime, so the
precondition was checked first this time: every caller that needs a fully
initialised database already awaits the async half, and the only two that do not
(`migrate_usernames`, `seed_badges`) are one-shot scripts that need neither the
catalogue nor the ledger.

The hash-enforcement refusal moved with it. `legalRepublish.test.js` pinned
"boot dies on an edited published version" against `initDatabase()`; it now
pins the same property against `completeDatabaseInit()`, which `server.js`
awaits at top level with no catch. Same guarantee, different function.

### Also converted

`errorReporter`, `moderation`, `exportWorker`, `notificationWorker`,
`emailService`, `resendWebhook`, `badgeService`, `notificationService`,
`socketServer` — and `notificationService.dispatch`, whose 49 call sites include
several `if (dispatch(...))` conditionals.

### Three real bugs, all introduced by my own bulk passes

**`initDatabase` became async, and 193 test files stopped starting.**
`backfillCertificates` → `initCertificates` → `initDatabase`. Nothing forces its
~40 synchronous callers to await it, so they all returned before the schema
existed and the failure surfaced far away as `no such table: legal_documents`.
Fixed by splitting `initCertificates` the way the ledger already was — DDL in
`initDatabase`, backfill in `completeDatabaseInit`. **Now guarded**: a ninth
shape check fails the build if `initDatabase` is ever declared `async`,
mutation-tested.

**Every notification preference was ignored.** The sweep made `getPref` async
inside `notificationService.dispatch`. It only searches an array already
fetched — there is nothing to await — and both call sites read it as
`mandatory || getPref(...)`. A pending promise is truthy, so every channel came
out enabled. Caught by a badge test asserting an opted-out volunteer gets
nothing; reverted to synchronous with the reason recorded in place.

**The error handler stopped recording.** `errorCapture`'s harness invoked an
async handler without awaiting, so assertions ran before the write.

### The standing lesson

Bulk `await` insertion is only safe for *call sites*. It must never decide that
a function should be `async` — `getPref` and `initDatabase` were both made async
by inference, and both were wrong in ways no type checker would catch. The
`asyncShapes` guard now has to be re-run after every bulk pass; it caught
re-introduced shapes four times in this wave alone.

## Wave 22 — finishing the tail, and finding out what "ready" actually needs

### 22a · `reauth.js`, and the race the original test could not isolate

Converted in full, with `reauth.test.js` moved in step. The judgement call was
the lockout race. Because `MAX_ACCOUNT_ATTEMPTS === MAX_ATTEMPTS`, a challenge
at its ceiling always implies the account at its ceiling, so once any read in
the path yields, the account gate necessarily answers first. The original test
distinguished the two only through a synchronous-read timing artifact.

Rather than weaken it: the assertion became a property (both codes accepted, one
grant), an isolatable `consumed_at`-during-bcrypt race was added, and a
structural guard now asserts `commitGrant` re-states all four preconditions
after bcrypt. Mutation-tested — dropping `attempts < ?` fails 24 tests, dropping
`consumed_at IS NULL` fails 2.

### 22b · Eager grants, and a `can()` that refuses a promise

`grantsFor` reads the database, so it is async. `buildPrincipal` exposed `grants`
as a lazy memoizing getter, and a getter cannot await — so `grants` would have
become a promise, and `can()`'s `Array.isArray(principal.grants)` would have
been `false` for every account. Every Student Organizer would have silently lost
the four capabilities their agreement confers.

`can()` cannot become async: it is a pure predicate called from hundreds of
branches, and `authz.js` imports nothing on purpose. So `buildPrincipal` resolves
grants eagerly — one indexed lookup per authenticated request, on a table that is
empty for almost every account — and `can()` now throws on a non-array, naming a
promise specifically. The laziness tests were rewritten to pin the new contract
and say why it changed, rather than deleted.

This is the second instance of the shape that produced the `withheld` bug. Both
are now loud.

### 22c · Four guards added, all mutation-proven

| Guard | Shape | What it caught |
|---|---|---|
| 10 | `const x = asyncFn(…)` never awaited | `verifyTotpOnce` — **every 2FA sign-in**; plus alert throttling, the read-only health probe, the Auto Select sweep, and two vacuous tests |
| 11 | `f(tx, …)` unawaited at statement position | `replaceEventTags` at both call sites — every tag edit reported success and saved nothing |
| 12 | hoisted `prepare()` whose executions are unawaited | **59 sites**: attendance check-in, certificate issue, consent records, recovery codes, waitlist promotion, Auto Select accept/waitlist, both workers |
| dialect | SQLite-only SQL, per construct | ratchets 193 remaining sites so the surface cannot grow while the migration is paused |

Guard 10 needed a precision device the others did not: it matches a plain
assignment, so name collisions cost 249 false positives (`makeUser`, `run`,
`login`, `openDb` — async exports in one module, sync helpers in another). It
scans only names that no file declares synchronously, which is a documented hole
rather than a clean solution.

Two sync-callback rewrites came out of this: `pendingApps.map(app => … await …)`
in the waitlist ordering and `remaining.forEach(… await renumber …)` in the
promotion path. Both became loops.

### 22d · The determination: PostgreSQL cannot execute this application yet

The counters reached zero. That is not the same thing, and the audit found three
blockers that have nothing to do with call sites. Each was proven, not assumed.

**1 — Nothing is wired.** `db.js:125` constructs a `DatabaseSync`
unconditionally. `resolveEngine()` has no consumer outside its own test.
Lifting `POSTGRES_READY` today would produce a SQLite connection and a
deployment that believes it migrated.

**2 — There is no PostgreSQL schema path.** Every `CREATE TABLE`, all 55
migrations and the badge catalogue run inside `initDatabase()`, which is
synchronous and must stay so — ~40 callers do not await it, and a guard fails the
build if it changes. Under an async engine those statements return promises
nobody can await. Attempting the conversion in this wave produced exactly that:
27 lint errors in `migrations/**` and `seed_badges.js`, every one of them
`await is only allowed within async functions`. They were reverted, and the
exclusion is recorded in the guard as a finding rather than an exemption.

**3 — 193 SQLite-only SQL constructs remain**, 70 in runtime queries and 123 in
the boot path. Each was executed against a real PostgreSQL 17 server:

```
datetime('now','-1 hour')  ERROR: function datetime(unknown, unknown) does not exist
INSERT OR IGNORE …         ERROR: syntax error at or near "OR"
… COLLATE NOCASE           ERROR: collation "nocase" for encoding "UTF8" does not exist
strftime('%Y-%m', c)       ERROR: function strftime(unknown, text) does not exist
julianday(c)               ERROR: function julianday(text) does not exist
… FROM sqlite_master       ERROR: relation "sqlite_master" does not exist
SELECT rowid FROM …        ERROR: column "rowid" does not exist
… WHERE 1                  ERROR: argument of WHERE must be type boolean, not type integer
```

The encouraging half: **29 of `db.js`'s 30 `CREATE TABLE` statements ran under
PostgreSQL unchanged.** `TEXT`, `REAL` and `INTEGER` all exist there. The tables
are close to portable; the functions, pragmas and conflict syntax are not.

`POSTGRES_READY` was therefore **not** lifted, and the application test suite was
**not** run against PostgreSQL — the precondition in the instruction ("if so")
is not met. `engine.js`'s refusal message and its explanatory comment were
rewritten, because both named the synchronous call sites as the blocker and
would now read as "the blocker is gone, flip the constant".

## Phase 9 — the schema path, the wiring, and most of the dialect

### 9a · The architecture decision, and why it was not escalated

Two candidates: make the migration runner async so the 56 migrations run on both
engines, or derive a PostgreSQL schema and let the migrations retire with SQLite.

It was already decided, in this document, before phase 7 began — "SQLite is
retained temporarily … not as a permanent compatibility target", and
`migrations/` is listed as *"retires with SQLite, never runs on PostgreSQL"*.
The evidence gathered now supports it rather than reopening it:

| Criterion | Async runner | Derived schema |
|---|---|---|
| Migration correctness | 14 of 56 migrations are create-copy-drop-rename **rebuilds**, the dance SQLite needs because it cannot `ALTER` a CHECK. Porting them means translating workarounds for a limitation PostgreSQL does not have — 14 more chances to get the same 65 tables wrong | The destination is read from a booted database. What PostgreSQL gets is what SQLite actually has |
| Rollback safety | `initDatabase()` becomes async, breaking ~40 non-awaiting callers and a guard, in the same change that introduces the engine | The SQLite path is untouched. Rollback is `DATABASE_ENGINE=sqlite` |
| Maintainability | Every future migration written twice, in two dialects | Generated; drift is a build failure |
| Long-term dual-engine | Keeps two engines in the schema layer for ever, which the plan rules out | Ends at the retirement phase, as planned |

Not escalated because it changes no stated requirement — it *implements* one.

### 9b · The generator

`bin/generate-postgres-schema.mjs` boots a real SQLite database (the whole
`initDatabase()` + 56 migrations), reads `sqlite_master`, and translates.
`server/db/postgresSchema.js` is the output: **65 tables, 95 indexes, 20
triggers**. `db.postgresSchema.test.js` regenerates and diffs, so the two
schemas cannot drift.

Every rewrite is counted and the counts are printed. The whole translation:

```
  1  AUTOINCREMENT → identity          8  REAL → double precision
  3  COLLATE NOCASE → the ICU nocase   1  DEFAULT datetime('now') → ISO-8601
 65  CREATE TABLE → IF NOT EXISTS     95  CREATE INDEX → IF NOT EXISTS
 20  RAISE(ABORT) triggers → PL/pgSQL functions
```

`REAL → double precision`, not `real`: PostgreSQL's `real` is four bytes, and
this schema stores service hours. A student's 100-hour certificate reading 99.99
is the kind of bug that is found by the student.

Anything the translator does not recognise **stops** the generation rather than
passing through — `assertNoSqliteIsms` is the backstop, and an unhandled trigger
shape or WHEN clause throws by name.

Three findings from building it:

- **Foreign keys need ordering.** SQLite resolves a `REFERENCES` target lazily,
  so `sqlite_master` order is migration order and the first table alphabetically
  points at `users`. A topological sort was added; a cycle throws rather than
  being papered over.
- **`RETURN NULL` in a BEFORE trigger cancels the operation silently.** Written
  that way first: the retention worker's aged-row delete quietly did nothing.
- **`RETURN OLD` from BEFORE UPDATE writes the old values back**, equally
  silently: an appellant's first statement write was discarded, so the
  write-once guard never armed. DELETE returns OLD, UPDATE returns NEW.

Both were caught by behavioural tests, not by any structural comparison — a
trigger that exists and does nothing is structurally identical to a correct one.

### 9c · Parity, proven both ways

`db.postgresSchema.test.js` compares tables, columns, column order, nullability,
type family, primary keys, foreign keys (including `ON DELETE`), unique indexes
and triggers. Then it provokes the translated guarantees: a case-variant email is
refused, an audit log inside the retention window cannot be deleted, one outside
it can, an appellant writes their statement once, an administrator with audit
history cannot be deleted, one without can.

One structural difference exists and is in PostgreSQL's favour. SQLite does not
enforce NOT NULL on a `TEXT PRIMARY KEY` — a documented legacy quirk — so
`PRAGMA table_info` reports 52 id columns as nullable. It accounted for **every**
nullability difference, and nothing else differed. **At cutover, PostgreSQL will
refuse an INSERT with a NULL id that SQLite accepted.**

### 9d · Wiring

`db.js` now calls `resolveEngine()` and builds through one `openConnection()`
factory. On PostgreSQL `initDatabase()` cannot create anything — it is
synchronous — so it records a deferral, `completeDatabaseInit()` applies the
generated schema, and `assertSchemaReady()` turns a forgotten call into a named
boot error instead of "relation does not exist" from inside a route. WAL and
`busy_timeout` are guarded as SQLite-only.

### 9e · The dialect: 70 → 6

The measurement itself was wrong first. The scanner counted SQL quoted in
comments, inflating the total by ~38 — and worse, improving a comment could have
tripped the ratchet. It now strips comments using the migration registry's own
`canonicalSource`. The corrected starting figure was 45 runtime, not 70.

Most of it turned out to need no dialect branch at all:

| Was | Now | Sites |
|---|---|---:|
| `INSERT OR IGNORE/REPLACE` | `ON CONFLICT (cols) DO NOTHING / DO UPDATE` — SQLite ≥ 3.24 | 6 |
| `strftime('%Y-%m', col)` | `substr(col, 1, 7)` — the columns are ISO-8601 | 5 |
| `COLLATE NOCASE` | `COLLATE nocase` — SQLite resolves collation names case-insensitively, and the generated schema defines a matching ICU collation | 29 |
| `datetime('now')` | a bound ISO-8601 timestamp | 10 |
| `sqlite_master` existence checks | `tableExists()` | 2 |
| `PRAGMA user_version` write probe | `probeWritable()` | 2 |
| `julianday()` | `hoursBetween()` | 2 |

`ON CONFLICT` is also stricter than what it replaced: `OR IGNORE` swallows every
constraint violation, including NOT NULL and foreign-key breaches nobody meant to
ignore.

The residue is `server/db/dialectSql.js` — four small functions, each exercised
against **both engines with the same inputs and required to agree**, in
`db.dialectSql.test.js`. That comparison earned itself immediately:

- `hoursBetween` must round on both sides. Unrounded, `julianday` arithmetic
  answers 2.4999999962747097 for a two-and-a-half hour shift and
  `EXTRACT(EPOCH …)` answers 2.5. The ledger's parity check compares recomputed
  totals against stored ones exactly.
- `probeWritable` was written as `SELECT txid_current()`, reasoning that
  allocating a transaction id requires write access. **It does not** —
  PostgreSQL 17 returns one inside `SET TRANSACTION READ ONLY`, so the probe
  passed on a database it could not write. It is now `CREATE TEMP TABLE IF NOT
  EXISTS`, which is refused there.

**Migration 056** was needed for one column. `tfa_login_attempts.last_attempt_at`
held SQLite's `2026-08-16 17:53:04` while the comparison moved to ISO-8601, and
the two disagree at position 10, where a space sorts below `T`. An unconverted
row therefore sorts below every same-day cutoff however recent it is: a failure
from thirty seconds ago reads as older than fifteen minutes and leaves the
window. The consequence is a rate limit that silently empties on deploy day,
handing a fresh budget to anyone mid-attack. The rows are converted rather than
deleted, because deleting them produces exactly that reset.

The 6 runtime constructs left are in files that are engine-specific by
construction: `testServer.js` and `verifyHours.js` hold raw `DatabaseSync`
handles, and `db/sqliteTransaction.js` is the SQLite adapter.

## Phase 10 — the application actually ran against PostgreSQL

### 10a · The harness

`npm run test:postgres` runs the full server suite with `WEV_POSTGRES_APP_TEST=1`.
Each test FILE gets its own PostgreSQL schema namespace — vitest gives each file
its own module registry, so `db.js` (which opens at module scope) is constructed
once per file, and that is the natural isolation boundary. The namespace is
pinned in the **connection string** (`options=-c search_path=…`), not with
`SET search_path`: `SET` reaches one session and the pool hands out ten, so the
first version created its tables on one connection and queried from another.

Three things make the suite unable to lie about which engine it used:

- `TEST_POSTGRES_URL` must be set, or the harness throws. It never falls back to
  SQLite — a run reporting "postgres" while using a file is worse than no run.
- After boot it asserts `db.dialect === 'postgres'` **from the connection**, not
  from the environment variable that was meant to select it.
- It asserts the live `search_path` contains this file's namespace, so a run that
  landed in `public` and shared rows with other workers fails immediately.

The gate stays shut for deployments. `harnessOverride` requires `VITEST` (set by
the runner and nothing that ships) **and** `WEV_POSTGRES_APP_TEST=1`, and is
refused outright under `NODE_ENV=production`. `db.engine.test.js` asserts each
condition independently, including that no value of the flag alone suffices.

### 10b · Results

| | first run | after fixes |
|---|---:|---:|
| Application tests passing on PostgreSQL | 2,944 | **3,784** |
| Failing | 969 | 896 |
| Skipped (never executed) | 874 | 114 |
| Files fully passing | 144 | 155 |

The skip count matters more than it looks: 760 tests that never ran on the first
attempt now execute.

### 10c · Application defects found by running it

Every one of these was invisible on SQLite.

**Security paths.**
- **The 2FA rate limiter was completely broken.** `ON CONFLICT … DO UPDATE SET
  attempts = attempts + 1` is ambiguous under PostgreSQL — the existing row and
  `excluded` both have `attempts` — and it failed 198 times in one run. SQLite
  resolves the bare name to the existing row, so the defect could not appear
  there. Now `tfa_login_attempts.attempts + 1`.
- **The duplicate-appeal check could not run.** `subject_ref IS ?` is SQLite's
  null-safe equality with a bound parameter; PostgreSQL's `IS` takes only
  keywords. `subject_ref` is NULL for an appeal about the account itself, so
  plain `=` would answer false for exactly those and a suspended user could file
  without limit. Now `nullSafeEquals()` → `IS NOT DISTINCT FROM`.
- **An unawaited DB write in a request handler.** `purgeExpiredVerificationTokens()`
  in the email-confirmation route: on SQLite the delete had already happened by
  the time control returned; on PostgreSQL the promise outlives the request and a
  rejection lands after the 200.

**Boot and workers.**
- **The demo seed never ran.** It lived inside the synchronous `initDatabase()`,
  which is a no-op on PostgreSQL, so the first sign-in answered "No account found
  with that email address." Moved to `completeDatabaseInit()` and made async —
  one definition of what a demo database contains, for both engines.
- **`seedOrganizerAcceptance` inserted a NULL user_id**, from an unawaited
  `db.prepare(…).get()` whose promise read as a truthy row.
- **Both workers were started unawaited at boot.** `startExportWorker` recovers
  exports its predecessor abandoned before polling; not awaiting it means serving
  traffic while that is still running, and a rejection is silent.
- **`reportWorkerError` was called and abandoned** in six catch blocks, losing the
  record of why the worker stumbled.

**Query portability.** `MAX(0, …)` (SQLite overloads `max` as scalar and
aggregate) → `GREATEST`; `instr(h, n)` → `position(n IN h)`; `json_each` →
`jsonb_array_elements_text`; two `GROUP BY` clauses that named only the primary
key; `SELECT DISTINCT … ORDER BY x COLLATE nocase`, which PostgreSQL rejects
because the ordering expression is not in the select list.

**Adapter.** `:name` placeholders were not translated at all — fifteen of them in
`evidenceHolds.js`, the queries that stop a reported event being deleted under a
live report. Adding `:` then broke every cast, because PostgreSQL's `::` is a
double colon and `col::timestamptz` parsed as a parameter named `timestamptz`.
Caught by `db.dialectSql.test.js` running the same expression on both engines.

**Schema.** The generated `nocase` collation checked `pg_collation` without
scoping to the current schema, so a leftover namespace elsewhere in the database
suppressed creation here and every subsequent boot failed with "collation does
not exist" while the collation plainly existed, unreachable.

### 10d · Guards added, both mutation-proven

| Guard | Shape | Found |
|---|---|---|
| 13 | `const { a } = f(…)` — destructuring a promise binds every name to `undefined` | 13 sites in `impact.test.js` |
| 14 | a bare async call at statement position, result discarded | the two worker starts, the request-handler write, six `reportWorkerError` calls, and three abandoned transactions that produced `database is locked` in a different file |

Guard 14 needed two narrowings to be usable: `.then`/`.catch` anywhere in the
statement marks deliberate fire-and-forget, and a call preceded by `=>`, `(` or
`,` is an arrow body or an argument, not a statement.

### 10e · What the remaining 896 failures are

Test-fixture data setup, not application code. Confirmed two ways: the error
classes are foreign-key and NOT NULL violations from `INSERT`s in `*.test.js`
plus 123 `datetime('now')` calls in 26 test files, and the only non-test files
appearing in any failure stack are there through assertion failures downstream of
a fixture that did not insert.

The shape is always the same: a fixture helper that was synchronous now returns a
promise, so the id it yields is `undefined` and every child row it should have
parented fails. `messages.sender_id` is NULL 136 times against 135
`messages_conversation_id_fkey` violations — one helper, two symptoms.

That is a large mechanical job across ~127 files and it is the honest reason
PostgreSQL is not signed off here.

## Phase 11 — porting the test fixtures (partial)

### What was done

Four of the largest failing files were ported end to end — `reauth.test.js`,
`routes.reauth.test.js`, `appeals.lifecycle.test.js`, `appealsRoutes.test.js` —
along with adapter-suite and cross-cutting fixes. PostgreSQL application tests
went **3,784 → 3,861 passing**, failures **896 → 759**.

### The three-step shape of a fixture port

Each file needs all three, and doing only the first two produces failures that
look like data corruption:

1. **Await the statement executions.** `db.prepare(…).get/all/run(…)` on the
   proxy handle.
2. **Await the local helpers.** Making a fixture helper async is only half the
   change — nothing in the toolchain notices an un-awaited call. There is no
   lint error and no syntax error; the helper returns a promise, the id it
   should have produced is `undefined`, and the failure surfaces as a
   foreign-key violation in a different test. This is why `messages.sender_id`
   was NULL 136 times against 135 `messages_conversation_id_fkey` violations.
3. **Convert the refusal assertions.** See below.

### Refusal assertions are the subtle part

`expect(() => stmt).toThrow(/…/)` and `expect(promise).rejects.toThrow(/…/)` are
each correct on exactly one engine:

- SQLite's append-only triggers throw **synchronously** from `.run()`, so
  `expect(promise).rejects` never receives a promise — the throw escapes first.
- PostgreSQL **rejects**, so `expect(fn).toThrow()` never observes it and the
  assertion passes vacuously while the write goes unrefused.

The portable form is `await expect(async () => stmt).rejects.toThrow(/…/)`,
which observes both. Every trigger-refusal and capability-refusal assertion
touched in this phase was converted to it. This matters beyond tidiness: these
are the assertions that prove the audit log, the appeals history and the
capability kernel refuse writes.

### A process failure worth recording

Three bulk regex passes in this phase caused damage that took as long to undo as
the work they were meant to save:

- `await f().prop` → `(await f()).prop` matched non-database calls, wrapping
  supertest's synchronous `request(app)` builder.
- The inverse pass then un-wrapped **802** legitimate sites across 130 files,
  including ones that pre-dated the session.
- A greedy `re.DOTALL` pattern for `expect(await X).rejects` matched across
  lines to a later `.rejects`, stripping `await` from unrelated assertions in
  between — including four in the PostgreSQL adapter suite.

All of it was recovered, and both suites are green. The rule that was violated
is already written down in this document from phase 8: **bulk insertion is safe
for call sites and nothing else.** A transformation that decides where an
expression ends must balance parentheses, not match a regex. `parenwrap.py` and
`upsert.py` in the session scratch do it properly; the failures came from the
passes that did not.

### Phase 11b — the first two suites ported end to end

`appeals.lifecycle.test.js` and `appealsRoutes.test.js` were the two largest
`beforeAll` casualties: 60 tests between them, every one reported as *skipped*
because the suite hook died on `function datetime(unknown) does not exist`.

Both now pass **60/60 on PostgreSQL** and 60/60 on SQLite. What it took, per
file, was the three-step port plus one shape no guard was watching for:

    expect(db.prepare(sql).get(id).c).toBe(1)

No `await` anywhere. Guard 3 finds `await chain.prop` (the await in the wrong
place) and guard 12 finds a hoisted statement whose executions are unawaited,
but neither sees a chain with no `await` at all — it is *correct* on SQLite.
Three of these were the last thing standing between those two files and green.

**A ratchet now counts them: 1,084 across 134 proxy-holding test files** (1,299 → 1,191 → 1,084 as files are ported). That
is the honest remaining size of the fixture port, and it can now only go down —
the guard pins the ceiling to the exact count, so porting a batch means lowering
the number in the same commit. It was first written with ten of slack "to be
safe"; a mutation adding one more chain passed, which is exactly what the
ratchet exists to prevent, so the slack was removed.

### Phase 11c — four suites ported, and a real `rowid` incompatibility

`twoFactor.noFiveHundred.test.js` and `routes.moderationQueue.test.js` joined the
two appeals suites: **94 tests that were entirely cascade-skipped now execute.**

**`ORDER BY ma.rowid` was live application code.** `adminRoutes.js` orders a
moderation history by `created_at` and breaks ties on `rowid`, because one PATCH
writes several rows sharing a timestamp. PostgreSQL has no `rowid`, so the
report-detail endpoint answered 500 there. `ctid` is not a substitute — it is a
physical location that moves when a row is updated.

`insertionTiebreak()` keeps `rowid` on SQLite (unchanged: it is the
authoritative engine, and `rowid` really is insertion order) and uses the
primary key on PostgreSQL. **A difference remains and is deliberately not
papered over:** PostgreSQL's tie-break is lexicographic by UUID, not insertion
order. Making it truly insertion-ordered needs a monotonic column on
`moderation_actions` and `hours_ledger` plus a backfill — a schema change and an
owner decision for cutover, not something to slip into a dialect helper.
`hours_ledger.js` has the same construct and is not yet converted.

**Two assertion forms were established as house style**, both because the naive
version is vacuous on one engine:

    await expect(async () => stmt).rejects.toThrow(/…/)   // refusal
    await stmt; expect(effect).toBe(…)                    // success

`.resolves` cannot be used for the success case: it requires a promise, and
SQLite's `.run()` returns a plain object.

### Phase 11d — three more suites, and four misplaced awaits in live code

`routes.eventEligibility`, `retention` and `appeals.adversarial` ported. Seven
suites are now done; the PostgreSQL application suite is at **4,044 passing**.

**Guard 15 — `(await h.prepare(sql)).get(id)`.** The await group closes before
the execution. This is the inverse of guard 3 and survives every check that
catches it: the `await` is present, just wrapped around `prepare()` — which is
synchronous on both engines, so awaiting it is harmless and silent — leaving
`.get()` to return a promise nobody awaits.

Four were live in application code, found only by running the retention worker
against PostgreSQL:

| Where | Effect on PostgreSQL |
|---|---|
| `retentionWorker.js` deleted-account purge | `.all(cutoff).map(…)` threw; **the purge could not run at all** |
| `contentRoutes.js` ×2 | an organizer's total credited hours → `undefined` |
| `userRoutes.js` | the same figure on the public profile |

On SQLite all four returned the right answer. On PostgreSQL a volunteer's
credited hours would have rendered blank, and retention would have silently
stopped purging. The fix is one parenthesis; the guard balances `prepare()`'s
own parentheses to find the shape, and is mutation-proven.

## CHECKPOINT — exact state

- **Engine:** SQLite, authoritative. `POSTGRES_READY` is **still `false`**.
- **The application HAS now executed against PostgreSQL** — booted, seeded,
  authenticated, served requests, and passed 3,784 of its own tests there. This
  is the first checkpoint at which that sentence is true.
- **Committed:** nothing. Everything is in the working tree.
- **Rollback:** `git checkout -- <path>` per file. No migration has been run
  against a real database; no production data touched.
- **Phases 7, 8, 9:** COMPLETE. **Phase 10:** harness built, application proven
  to run, 896 fixture-level failures remain.

### Verification at this checkpoint

```
npm test                       439 files | 6939 passed | 57 skipped | 0 failed | 0 unhandled
TEST_POSTGRES_URL=… npm test   441 files | 6994 passed |  2 skipped | 0 failed
npm run test:postgres          282 files | 4044 passed | 692 failed |  61 skipped
node bin/generate-postgres-schema.mjs --check   current
npm run lint  clean     npm run build  ✓     npm audit --omit=dev  0 vulnerabilities
```

### Why POSTGRES_READY is still false

Of the twenty-one preconditions, seventeen are met: the connection is real, the
schema is generated and verified, drift is checked, the application boots, core
authentication and authorization work, transactions work, workers start, no
SQLite-only runtime SQL remains in application code, lint and build pass, the
security suite passes, and the SQLite regression suite is green.

Four are not:

1. **692 application tests still fail on PostgreSQL.** Fixture-level, but until
   they pass nothing has verified the behaviour they cover.
2. **The 174 PostgreSQL "skips" are not deliberate skips.** Measured, not
   assumed: nine test files fail in `beforeAll` — `appeals.lifecycle` on
   `function datetime(unknown) does not exist`, and eight more the same way —
   and vitest reports every test in a file with a failed suite hook as skipped.
   Six files account for 171 of them (53 + 39 + 30 + 30 + 12 + 7).

   The codebase contains only **16 deliberate skips**: 12 `skipIf(!live)`
   guarding tests that require a PostgreSQL server, one
   `skipIf(!LEGAL_HASHES_ENFORCED)`, and three gated on a real database file
   existing. All sixteen are intentional and documented at their call sites.

   So this is not a separate blocker needing its own categorisation pass — it is
   the fixture blocker wearing a different number, and it retires with it.
3. **No data-migration dry run has been performed.** SQLite → PostgreSQL with
   representative data, validated row by row, has not been attempted.
4. **Concurrency has not been exercised on PostgreSQL.** The write-gate and
   single-use race tests run on SQLite; their PostgreSQL behaviour is different
   by construction (a pool, not a file lock) and untested.

Lifting the gate now would mean asserting behaviour that 896 red tests are
currently unable to confirm.

### Next operation — phase 11, in order

1. **Port the test fixtures.** ~127 files. The work is mechanical: make fixture
   helpers async, await them, and translate `datetime('now')` (53 uses in 26
   files) to bound ISO timestamps. Guards 13 and 14 catch the two shapes that
   cause most of it, so run `asyncShapes` after each batch.

2. **Then triage the 114 skips.** Any that are adapter-specific get a recorded
   reason; the rest must run.

3. **Then the concurrency suite on PostgreSQL** — challenge single-use, recovery
   codes, check-in, waitlist, Auto Select. The SQLite write gate is a file-lock
   workaround and must be proven engine-specific before it is trusted or removed.

4. **Then the data-migration dry run**, against a representative copy, validating
   row counts, ids, foreign keys, timestamps, booleans and NULLs — and note that
   PostgreSQL will refuse NULL ids in 52 tables that SQLite accepted.

5. **Then lift `POSTGRES_READY`**, in a change that does nothing else.

6. **Production migration** still needs explicit authorization and is not
   reachable until 1–5 are done.

---

## Phase 12 — the fixture port finished by machine, and five live bugs it uncovered

This phase began by reproducing the previous checkpoint rather than trusting it:
4,043 passing / 684 failing / 70 skipped, 162 of 282 files. That is the handoff's
figure to within a rounding of flaky timing, so the numbers below are measured
against it.

### 12a · The fixture port, as two AST passes instead of 127 hand ports

The remaining debt was 1,084 unawaited `db.prepare(…).get/all/run(…)` chains. It
was not 127 files of uniform work — classifying every chain by its enclosing
function showed a sharp split:

| chains | enclosing function | what it needs |
|---|---|---|
| 824 | already `async` | one inserted `await`, no cascade |
| 137 | sync arrow | make async → callers must await |
| 66 | sync vitest hook callback | make async (vitest awaits it) |
| 55 | sync helper declaration | make async → callers must await |

**The 824 were free.** Nothing became async that was not, so no caller changed.
One pass, and PostgreSQL went 4,043 → 4,312 passing. The skip count fell 70 → 15
in the same pass, confirming the previous phase's reading that those were never
deliberate: they were whole files reported skipped after a `beforeAll` died.

**The rest was the cascade**, and it is what produced the foreign-key storm. A
sync helper holding an unawaited `.run()` returns before its INSERT lands, so the
id it should have produced is `undefined` and the violation surfaces later on a
different table. Making the helper async forces its callers to await, which makes
*them* async, so the async set is computed as a **fixpoint per file** before
anything is written.

Both passes are AST transformations — offsets from a real parse, every file
re-parsed before it is written. Three things they had to get right, each one a
mistake this document already records a regex pass making:

- `(await f()).prop`, not `await f().prop`. The first draft got this wrong at
  helper call sites and produced `await membersOf().some(…)`, which reads
  `.some` off a promise. Caught by reading the diff of a single file before
  applying to 69.
- `f().then/.catch/.finally` left alone. Awaiting first turns it into
  `(await f()).catch`, which reads the method off the resolved value. Two SQLite
  tests failed exactly this way; the exclusion is now in the pass.
- **Whole-file atomicity.** 14 files were refused outright rather than half
  converted, because a partly-awaited file is precisely the state this document
  records as having produced a fail-open.

Fixture ratchet: **1,084 → 267 → 63**, lowered in the same commits, as it
requires.

### 12b · Five live application bugs, none of which SQLite could show

The fixture work was the means; these were the findings. Every one is code that
shipped, and every one is invisible on SQLite.

**1. The browse search box answered 500 on every search.** `instr(haystack,
needle)` does not exist on PostgreSQL, which spells it `strpos`. Same argument
order, same 1-based-or-zero result.

**2. The distance filter and the nearest-first sort answered 500.** The
haversine clamps its cosine with `min(1.0, …)`. Two-argument `min` is scalar in
SQLite and the *aggregate* in PostgreSQL, which refuses it — the identical trap
`greatest()` was already written to document, so it gained the symmetric
`least()`.

**3. The nearest-first sort answered 500 for a second reason.**
`ORDER BY distance_miles IS NULL, distance_miles ASC` — PostgreSQL resolves a
SELECT alias in ORDER BY only as a bare reference, never inside an expression.
`NULLS LAST` says it directly and both engines understand it.

**4. Thirty-six camelCase column aliases returned `undefined`.** PostgreSQL folds
an unquoted identifier to lower case, so `AS userId` comes back as `userid`.
This one does **not throw** — the member count, the event count, an organizer's
credited hours, the moderation queue's `assignedToMe`/`urgentLive`, a reviewer's
name on an appeal would each render blank. Quoting is portable; SQLite keeps the
case either way. Quoting the *definitions* then broke three ORDER BY clauses that
referenced them unquoted, which is a 500 rather than a wrong value — both
directions are now ratcheted.

**5. Email two-factor codes could never be sent on PostgreSQL.**
`tfa_email_codes.created_at` is the ONE column whose default differs by engine:
SQLite writes `2026-08-10 12:00:00`, the generated PostgreSQL schema writes
ISO-8601. The send cooldown read it as `new Date(created_at + 'Z')`, which is
right for exactly one shape. On PostgreSQL it made `…123ZZ`, `getTime()` returned
NaN, and the guard — which deliberately fails **shut** — then answered 429 to
every request, permanently. Anyone whose second factor is email could not have
finished signing in.

That guard's own comment predicted this precisely ("the day any other path writes
an ISO string there…"). The PostgreSQL schema generator is that other path.
Failing shut is what kept it from being a security hole and made it a total
outage instead.

It was found by porting fixtures off `datetime('now')` — a change that looked
cosmetic. SQLite's format sorts before every ISO string on the same date, so the
old fixture value read as "infinitely long ago" and the test had been passing for
the wrong reason.

**6. And one the migration itself introduced.** The async port had turned
`generateZip`'s Promise executor into `new Promise(async (resolve, reject) => …)`.
An async executor swallows failures: a rejected `await` rejects the executor's
own implicit promise, which nobody holds, so `reject` is never called,
`finalize()` is never reached, and **the promise never settles** — the export job
sits in `processing` for ever instead of failing and retrying. SQLite's
synchronous reads made it hard to reach; on PostgreSQL every read can reject.
oxlint had been flagging it as `no-async-promise-executor` the whole time.

### 12c · The dialect ratchet could not see a third of the SQL

The guard reported **zero** runtime `instr` while the search box was 500ing. The
cause is worth stating plainly, because it means the ratchet was measuring less
than its name claimed: it counted only string literals containing a statement
verb, and this codebase assembles its larger queries from **fragments**.
`eventQuery.js` hands the route a WHERE clause and an ORDER BY string;
`instr(lower(e.title), lower(@q)) > 0` is SQL by any reading and has no verb in
it.

A literal now also counts as SQL if it carries a named bind parameter or a clause
keyword. Narrowed to those two markers deliberately — scanning every string
instead counts `Math.min(total, LIMIT)` in a log line and `${member.rowid}` in an
email template, which are the *measured* false positives, not imagined ones.

**The hole that remains** is a fragment with neither marker. It is the same shape
as the bug this fixed, minus the `@q` that happens to save it. Closing it means
recognising SQL structurally — a parser, not a regex. Until then the backstop is
the thing that actually found these: running the suite against a real PostgreSQL.

Four constructs added, all mutation-proven: `instr()`, scalar `min`/`max`
(which needs balanced parentheses to tell from the ubiquitous one-argument
aggregate), the unquoted camelCase alias, and its unquoted *use*.

**A mutation test that lied, and how.** The first run of the scalar-`min`
mutation passed, which would have meant a vacuous guard. It did not: the mutation
had rewritten the template so the literal no longer held `@lat`, so the guard was
correct and the *mutation* was unfaithful. Redone by restoring the exact pre-fix
source. This is the second time this document records that failure mode; asserting
the anchor was found is now part of the procedure.

### 12d · Two corrections to things previously written down

- The dialect guard claimed `COLLATE NoCase` "would work on SQLite and fail on
  PostgreSQL". That is untrue — PostgreSQL folds unquoted identifiers, so every
  spelling resolves. Checked against the ICU collation directly rather than
  reasoned about. The one-spelling rule is worth keeping because the ratchet
  distinguishes the two BY CASE, but it is a counting rule, not a correctness
  one, and stating it as correctness sends the next person hunting for a bug that
  is not there.
- **`hours_ledger` rowid is settled, and it was smaller than it looked.**
  `getLedgerForUser` has **no route callers**, nothing reads the `seq` column it
  selects, and both its tests use distinct `created_at` values — so the tiebreak
  is unobservable today. It now uses `insertionTiebreak()`. The difference is
  real and recorded rather than hidden: PostgreSQL orders ties lexicographically
  by id, not by insertion. If this is ever wired to a screen that stops being
  acceptable, and the fix is a monotonic column plus a backfill — a schema change
  and an owner decision. `moderation_actions` carries the identical caveat.

### 12e · A blocker that had not been named before

**71 test files open a raw `DatabaseSync` against `WEV_DB_PATH`**, reaching
around the connection abstraction entirely. 15 of the 59 files still failing are
these. They do not fail for a fixture reason and no amount of awaiting fixes
them: under the PostgreSQL harness the app is on PostgreSQL and the SQLite file
is empty, so they report `no such table: users`.

The behaviour they cover — evidence preservation across account deletion, backup,
identity change, OAuth — is engine-independent and *should* be verified on
PostgreSQL. Porting them means routing them through the app's handle. That is
real work and it is now visible, which it was not before: the fixture ratchet
deliberately excludes files holding a raw handle, so this debt was sitting in the
one blind spot of the measurement that was tracking the port.

### 12f · Measured state at the end of this phase

```
                        handoff        now
PostgreSQL passing        4,043       4,570
PostgreSQL failing          684         213
PostgreSQL skipped           70          19
PostgreSQL files green  162/282     223/282
SQLite passing            4,739       4,745   (0 failing)
fixture debt              1,084          63
dialect constructs            8          12   (all mutation-proven)
```

`npm run lint` is now warning-free, not merely exit-zero — the one warning it had
been carrying was bug 6 above. Schema drift clean; `git diff --check` clean.

### Why POSTGRES_READY is still false

Of the original four blockers, the fixture one has gone from 692 failures to 213
and changed character: what is left is no longer mostly awaits. Unchanged:

1. **213 failures**, now dominated by two named classes — 15 files holding a raw
   SQLite handle (12e) and 14 files the porting pass refused rather than half
   convert. Both are hand work with a known shape.
2. **No data-migration dry run.** Not started.
3. **No PostgreSQL concurrency testing.** Not started. The SQLite write gate is a
   file-lock workaround and must be proven engine-specific before it is trusted
   or removed.
4. **19 skips still need classifying**, though the number is now small enough to
   do one at a time.

### Next operation

1. **Port the 15 raw-`DatabaseSync` files** to the application handle. This is
   the largest single remaining class and the least understood before now.
2. **Hand-port the 14 refused files.** Run the porting pass in dry-run mode to
   list them with the reason each was refused (a helper passed as a bare callback
   to `map`/`filter`, or an anonymous non-hook function).
3. **Then the remaining assertion-level failures**, which are individually small.
4. **Then concurrency on PostgreSQL**, then the migration dry run, then the gate.
