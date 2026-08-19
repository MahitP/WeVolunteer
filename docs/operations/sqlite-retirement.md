# What still exists because SQLite exists

Production is PostgreSQL. This classifies everything in the tree that is here
only because SQLite is also supported, so a future decision to retire it is an
inventory rather than an investigation.

**Nothing here is a recommendation to delete something today.** Two things
currently make SQLite load-bearing: `pilot.db` holds the real pilot data and has
not been migrated, and the SQLite suite is the fast local loop that 449 test
files run in. Retiring SQLite before the first is resolved would strand real
records, and before the second is replaced would cost more than it saves.

## The surface is much smaller than it looks

Dialect branching lives in **two files**:

| file | what it branches on |
|---|---|
| `server/db.js` | engine selection, WAL pragmas, the SQLite DDL block, deferring schema to `completeDatabaseInit()` on PostgreSQL |
| `server/db/dialectSql.js` | 19 branch sites: `probeWritable`, `withForeignKeysOff`, date arithmetic, JSON array containment, `FOR UPDATE`, `greatest`/`least` |

Everything else — roughly 653 call sites in the route layer — is engine-agnostic
and always has been. That is the property worth protecting: a new route needs to
know nothing about which database it is talking to. Any future change should
keep branches inside these two files rather than spreading them.

## Category 1 — production runtime (PostgreSQL; keep)

- `server/db/postgresConnection.js` — pool, executor, transactions
- `server/db/postgresSchema.js` — **generated**, do not hand-edit
- `server/db/engine.js` — engine resolution, TLS, pool config
- `server/db/sqlPlaceholders.js` — `?` → `$n` translation
- `server/db/connectionContext.js` — binds a transaction to the async context

`sqlPlaceholders.js` reads like SQLite compatibility and is not: every statement
in the codebase is written with `?`, so the translator is what the whole route
layer depends on. It stays regardless.

## Category 2 — SQLite compatibility (removable when SQLite retires)

- `server/db/sqliteTransaction.js` — the synchronous transaction path
- the `CREATE TABLE` DDL block in `server/db.js` (the PostgreSQL boot returns
  before it, at `db.js:577`)
- `server/migrations/` — 55 migrations that will never run against PostgreSQL
- the SQLite half of each of the 19 branches in `dialectSql.js`
- `addColumnIfMissing`, `rebuildApplicationsForWithdrawn`, and the `PRAGMA`
  helpers in `db.js` — all unreachable on PostgreSQL
- the `nocase` collation created in `postgresSchema.js`, which exists so
  `COLLATE nocase` written for SQLite keeps working

## Category 3 — machinery to keep even after retirement

- **The 55 migrations as a record.** They document how the schema reached its
  current shape, and `postgresSchema.js` is *derived* from replaying them
  (`bin/generate-postgres-schema.mjs`). Deleting them makes the generated schema
  unreproducible.
- **The migration test suite.** It proves the historical upgrade path still
  works for any deployment not yet cut over.
- **The dual-engine test matrix.** Running the suite on both engines is what
  caught every dialect defect this project has found — `LIKE` case folding,
  `ROUND(double precision, int)`, unquoted camelCase in `ORDER BY`, identity
  sequence desync, SQLSTATE vs message-string matching. A single-engine suite
  would not have found any of them.

## Category 4 — debt that shrinks as SQLite retires

- **113 unawaited `prepare()` chains** across 24 test files, pinned exactly by
  `server/asyncShapes.test.js`. Each is correct on SQLite and wrong on
  PostgreSQL. The ceiling only ever moves down.
- Test files holding a raw `DatabaseSync` handle rather than the application's.

## What would have to be true to retire SQLite

1. `pilot.db` migrated or formally retired — an owner decision, not an
   engineering one, because it is real people's records.
2. `deploy/wevolunteer.env.example` and the deployment runbook no longer
   describing a SQLite path as the primary deployment.
3. A replacement for the fast local loop — most plausibly a disposable
   PostgreSQL schema per run, which `bin/scale-probe.mjs` and the
   `wev_t_…` per-file namespaces already demonstrate.
4. The fixture debt in category 4 driven to zero, since those files would
   otherwise start failing rather than merely being unported.

Until then the correct state is the current one: PostgreSQL in production,
both engines tested, and every dialect difference confined to two files.
