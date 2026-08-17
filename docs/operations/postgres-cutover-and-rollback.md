# PostgreSQL cutover and rollback

Status: **procedure written, partly rehearsed.** The rehearsable parts have been
run against scratch databases; the parts that need a real deployment window are
marked as such and are owner decisions, not something this document invents.

SQLite is still the authoritative engine. `POSTGRES_READY` is `false`.

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
| Rollback to SQLite after cutover | **no** | needs a real deployment; the file being untouched is what makes it safe |
| Write-hold during the window | **no** | no read-only mode exists; owner decision above |

---

## Open owner decisions

1. **How writes are held during the window** — maintenance stop (available now)
   versus a read-only mode (would need building).
2. **Whether a reverse PostgreSQL → SQLite migration is worth building**, to
   shrink the data loss on a post-cutover rollback.
3. **`hours_ledger` / `moderation_actions` insertion ordering.** PostgreSQL
   tie-breaks equal timestamps lexicographically by id rather than by insertion.
   Currently unobservable — `getLedgerForUser` has no route callers and nothing
   reads the `seq` it selects — so no schema change has been made. If either is
   ever wired to a screen, it needs a monotonic column and a backfill.
