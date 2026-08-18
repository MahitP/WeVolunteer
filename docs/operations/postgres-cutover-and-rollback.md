# PostgreSQL cutover and rollback

Status: **rehearsed end to end against scratch infrastructure.** Everything that
can be exercised without a real deployment window has been run — including a
production-mode boot, a `pg_dump`/`pg_restore` round trip, and the privileged
recovery tooling. What genuinely needs a live deployment is marked as such and is
an owner decision, not something this document invents.

`POSTGRES_READY` is **`true`** as of 2026-08-18. That means the engine is
supported and boot-tested, **not** that this deployment has cut over: the default
engine is still SQLite, and nothing changes until `DATABASE_ENGINE=postgres` is
set deliberately.

---

## The one rule

**The SQLite file is the source of truth until somebody decides otherwise, and it
is never deleted, never moved, and never written to by the migration.**
`bin/migrate-sqlite-to-postgres.mjs` opens it **read-only**, so no failure mode of
the migration can damage it. Rollback is therefore always possible up to the
moment the application starts writing to PostgreSQL — and after that moment, only
by accepting the loss of whatever was written there.

That single sentence is what makes the rest of this document short.

---

## Which database is authoritative

One variable decides, and nothing infers it:

```
DATABASE_ENGINE=sqlite     # today
DATABASE_ENGINE=postgres   # after cutover
```

`server/db/engine.js` refuses an unrecognised value rather than defaulting —
`DATABASE_ENGINE=postgre` stops the boot instead of quietly opening SQLite,
which is how a deployment comes to believe it migrated. It additionally refuses
`postgres` while `POSTGRES_READY` is false, unless the test harness override is
present, and that override is refused outright when `NODE_ENV=production`.

**There is no dual-write mode and none should be added.** Two writable databases
with no reconciliation is a worse failure than either database being down: the
divergence is silent and unbounded, and there is no correct way to merge two
independently-accepted volunteer applications after the fact.

---

## Cutover

### 1. Before the window

```bash
# Verify the target is reachable and empty of application tables.
psql "$DATABASE_URL" -c '\dt'

# Apply the generated schema.
node -e "…applyPostgresSchema…"     # or let the app do it: completeDatabaseInit()

# Dry-run the migration against a COPY, not the live file.
cp pilot.db /tmp/pre-cutover-snapshot.db
node bin/migrate-sqlite-to-postgres.mjs \
     --source /tmp/pre-cutover-snapshot.db \
     --target "$DATABASE_URL" --apply
```

The migration exits non-zero if row counts, primary-key sets or foreign keys
disagree, and prints what disagreed. **Treat a non-zero exit as a stop.**

### 2. The window itself

Writes must not be accepted while the data is in flight, or they land in a
database that is about to stop being authoritative.

**Owner decision, not made here:** how writes are held. The two workable shapes
are (a) a short maintenance window with the application stopped, and (b) putting
the application in a read-only mode for the duration. This codebase has no
read-only mode today, so (a) is the only one available without new code. The
dry run moved 548 rows in under a second; the window is dominated by
process restart, not by the copy.

```
stop the application
  → snapshot the SQLite file (this is the rollback artefact)
  → run the migration against the real target
  → confirm the verification block reports all-match
  → set DATABASE_ENGINE=postgres
  → start the application
  → confirm /health and /ready report the PostgreSQL engine
```

### 3. After

Keep the snapshot. Do not delete the SQLite file. Watch error rates and the
`/errors` dashboard for the first day — the error reporter now persists events
on PostgreSQL, which it did not before, so a genuinely new class of problem will
be visible there rather than silently discarded.

---

## Rollback

### If PostgreSQL fails at startup

Nothing has been written. `engine.js` fails the boot loudly rather than opening
SQLite behind your back.

```
set DATABASE_ENGINE=sqlite → start
```

Service returns on the untouched SQLite file. **Rehearsed:** the engine's refusal
paths are covered by `sqliteDialect.test.js`'s gate tests and
`db.postgresConnection.test.js`.

### If schema creation fails

`initDatabase()` records `postgresSchemaPending` and `assertSchemaReady()` turns
any later query into a clear error rather than a `relation does not exist` from
whichever statement happened to run first. Nothing has been migrated.

```
drop the target database → fix → retry, or roll back to sqlite
```

### If the data migration fails halfway

The migration does **not** leave a half-populated database quietly: re-running
into a populated target is **refused** with a non-zero exit and a list of the
tables that already hold rows. The recovery is to discard the target, not to
patch it.

```bash
dropdb <target> && createdb <target>   # then re-apply schema and re-run
```

**Rehearsed:** a second run against a populated database refuses and exits 1,
with row counts verified unchanged afterwards.

### If post-migration validation fails

The verification block prints the specific mismatch — row counts, missing or
unexpected primary keys, or the exact foreign key that would not validate. Do
not proceed. Discard the target and investigate; the SQLite file is untouched.

### If the application starts, then a runtime PostgreSQL bug appears

This is the only case where rollback costs data: anything written to PostgreSQL
after cutover is not in the SQLite snapshot.

```
stop the application
  → set DATABASE_ENGINE=sqlite
  → restore the snapshot taken during the window
  → start
```

**The writes made to PostgreSQL between cutover and rollback are lost.** There is
no automatic reconciliation and this document does not pretend there is one.
That is the reason the observation period matters and the reason the window
should be chosen when volume is lowest.

**Owner decision, not made here:** whether a reverse migration (PostgreSQL →
SQLite) is worth building to shrink that loss. It is the mirror of the existing
tool and would be a day's work, but it is only worth it if the acceptable
rollback horizon is longer than a few minutes.

---

## What has actually been rehearsed

| Step | Rehearsed | How |
|---|---|---|
| Schema applied to a fresh database | yes | 65 tables created, twice, on two scratch databases |
| Migration correctness | yes | 548 rows; row counts, PK **sets** and all 87 FKs validated |
| Repeatability into a populated target | yes | refused, exit 1, row counts unchanged |
| Repeatability into a fresh target | yes | identical result on a second scratch database |
| Application boots on migrated data | yes | schema applied, hours-ledger parity verified, 18 users / 4 events / 16 attendance / 18 audit logs read back |
| Tombstoned accounts preserved | yes | 3 `deleted` users both sides, anonymised addresses identical |
| Engine refuses an unknown value | yes | covered by the engine gate tests |
| PostgreSQL backup and restore | yes | `pg_dump --format=custom` (184 KB), whole `public` schema dropped, `pg_restore` — 61 users / 15 events / 360 applications / 60 attendance / 480 notifications / 2 audit rows all returned, plus **20 functions, 20 triggers and the `nocase` collation** |
| Privileged tooling on PostgreSQL | yes | `reset-2fa` cleared the secret, zeroed both flags, bumped `token_version` and wrote the audit row against the right user; `grant-ownership` and `bootstrap-owners` promoted/created owners — each confirmed by querying afterwards, not by the script's own success message |
| Cutover without `--force` | yes | create → apply schema → load → verify: 1121 rows, 65 tables, PK sets and all 87 FKs match |
| Rollback to SQLite after cutover | **no** | needs a real deployment; the file being untouched is what makes it safe |
| Write-hold during the window | **no** | no read-only mode exists; owner decision above |

---

### If PostgreSQL fails AFTER it has served traffic

This is the case the three above do not cover, and the only one where rollback
is not free.

**The point of no return is the first write on PostgreSQL, not the cutover
command.** From that moment the SQLite file is a point-in-time snapshot, not a
live alternative. Measured, not assumed: the migration opens the source
`readOnly: true`, and the file is **byte-identical afterwards** (SHA-256 taken
either side of a 760-row load). It is a perfect rollback artefact and a
perfectly stale one — an account created on PostgreSQL after cutover is present
there and absent from the snapshot, which is exactly what reverting would
discard.

So "roll back to SQLite" at this stage is not a rollback. It is a decision to
accept losing every signup, application, check-in, hours entry and moderation
action since cutover. That is an owner's call about acceptable data loss, and
nobody should be making it for the first time during an incident.

**The engineering recovery is PostgreSQL, not SQLite:**

```
pg_restore --clean --if-exists --dbname="$DATABASE_URL" <the pre-cutover dump>
```

Rehearsed — see the table above. It returns the rows *and* the 20 immutability
trigger functions, their triggers, and the `nocase` collation. Reverting the
engine is the last resort behind it, not the first move.

**Before starting the cutover, decide and write down:** the maximum data loss
that would be accepted to get back to SQLite, and who is allowed to make that
call at 3am. If the answer is "none", then SQLite reversion is not a recovery
option for this deployment and `pg_restore` is the whole plan.

## Open owner decisions

1. **How writes are held during the window** — maintenance stop (available now)
   versus a read-only mode (would need building).
2. **Whether a reverse PostgreSQL → SQLite migration is worth building**, to
   shrink the data loss on a post-cutover rollback. Assessed 2026-08-18 and
   **not recommended as a launch gate**: it would be a second full migration
   path — with its own dialect translation, its own verification and its own
   failure modes — built to serve a scenario in which `pg_restore` is already
   the better answer. The gap it closes is data loss, and the way to close that
   is to not need the reversion, which the rehearsed PostgreSQL restore already
   does. Worth revisiting only if an owner decides SQLite must remain a live
   fallback indefinitely.
3. **`hours_ledger` / `moderation_actions` insertion ordering.** PostgreSQL
   tie-breaks equal timestamps lexicographically by id rather than by insertion.
   Currently unobservable — `getLedgerForUser` has no route callers and nothing
   reads the `seq` it selects — so no schema change has been made. If either is
   ever wired to a screen, it needs a monotonic column and a backfill.


---

## The rehearsal, as executed (2026-08-18)

Reproducible end to end against scratch infrastructure. Nothing below touches
production; `--source` is opened read-only throughout.

```bash
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
SCRATCH=/tmp/wev-rehearsal && mkdir -p "$SCRATCH"

# 1. A production-shaped SQLite dataset (real migrations, real init path)
node server/testing/makeScaleDataset.mjs --out "$SCRATCH/cli.db" --users 60

# 2. A clean PostgreSQL database with the generated schema
dropdb --if-exists wv_cli_test && createdb wv_cli_test
node --input-type=module -e "
  const { PostgresDatabase } = await import('./server/db/postgresConnection.js');
  const { translatePlaceholders } = await import('./server/db/sqlPlaceholders.js');
  const { applyPostgresSchema } = await import('./server/db/postgresSchema.js');
  const db = new PostgresDatabase({ connectionString: process.env.PG,
    translate: translatePlaceholders, max: 2 });
  await applyPostgresSchema(db); await db.close();"

# 3. Load and verify — no --force
node bin/migrate-sqlite-to-postgres.mjs \
  --source "$SCRATCH/cli.db" --target "$PG" --apply

# 4. Back up before anything else touches it
pg_dump --format=custom --file="$SCRATCH/rollback.dump" "$PG"

# 5. Prove the backup restores: destroy, then restore
psql "$PG" -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
pg_restore --dbname="$PG" --no-owner "$SCRATCH/rollback.dump"
```

### What the rehearsal established

**The documented sequence did not work before it was executed.** Two defects,
both invisible to reading:

1. `applyPostgresSchema()` stamps one `schema_migrations` row
   (`56, postgres_baseline`), and the loader's populated-target guard counted it
   — so step 3 always refused and the operator reached for `--force`, which
   disables the guard entirely, including the part that stops a second load
   duplicating a live database.
2. With the guard passed, the load died **partway through**, foreign keys
   suspended, on `duplicate key value violates unique constraint
   "schema_migrations_pkey"` — the source's own history contains version 56 and
   collided with that same marker.

Both are fixed; step 3 now completes with no `--force`.

**The restore returns more than rows.** The drop cascaded through 86 objects,
including 20 trigger functions that enforce immutability — `admin_audit_logs`
no-delete/no-update, `appeals_immutable`, `reports_immutable`,
`security_audit_logs_no_update` and the rest. All 20 functions, all 20 triggers
and the `nocase` collation came back with the dump. A restore that returned the
rows but not those triggers would leave the append-only guarantees silently off,
which is the failure this step exists to rule out.

### Still not rehearsed

Rollback *from* PostgreSQL *to* SQLite after a real cutover. The SQLite file is
never written during migration, so the rollback is "point the engine back and
start" — but that has not been executed against a live deployment, and is listed
above as not rehearsed rather than assumed.
