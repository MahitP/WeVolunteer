#!/usr/bin/env node
/**
 * Derives the PostgreSQL schema from the SQLite one, rather than maintaining a
 * second copy of it by hand.
 *
 * ── Why the schema is generated and not written ──
 *
 * The 55 migrations in `server/migrations/` will never run against PostgreSQL.
 * Fourteen of them are table REBUILDS — the create-copy-drop-rename dance SQLite
 * requires because it cannot `ALTER` a CHECK constraint. PostgreSQL can, so
 * porting those would mean translating workarounds for a limitation the target
 * engine does not have, and the result would describe the same 67 tables by a
 * much longer route with fourteen more chances to get it wrong.
 *
 * What PostgreSQL needs is the *destination*: the schema those migrations add up
 * to. That is exactly what a freshly-booted SQLite database contains, so this
 * boots one, reads `sqlite_master`, and translates.
 *
 * The alternative — hand-writing `postgresSchema.js` — was rejected on the one
 * criterion that matters here. Two hand-maintained schemas drift, silently, and
 * the drift surfaces as a production write failing on a column that exists in
 * development. Generation makes drift impossible to introduce: change the SQLite
 * schema, regenerate, and `db.postgresSchema.test.js` fails the build until you
 * do.
 *
 * ── The translation is deliberately small, and closed ──
 *
 * Every rewrite below is counted, and the count is asserted. A schema change
 * that introduces an unhandled SQLite construct does not slip through as
 * plausible-looking DDL — it fails here, with the construct named. The closing
 * scan (`assertNoSqliteIsms`) is the backstop: anything recognisably SQLite-only
 * that survives translation stops the generation.
 *
 * Usage:  node bin/generate-postgres-schema.mjs [--check]
 *   --check  regenerate and diff against the committed file, without writing.
 *            This is what CI and the test suite use.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { refuseNonDisposableDatabase } from './lib/db-safety.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = path.join(ROOT, 'server', 'db', 'postgresSchema.js');

/* ────────────────────────────────────────────────────────────────────────────
 * 1. A fresh, fully-migrated SQLite database
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Boots the real thing rather than reading the migration files.
 *
 * `initDatabase()` is `CREATE TABLE IF NOT EXISTS` plus `addColumnIfMissing`
 * plus the migration registry, and the order among those matters — migration
 * 031 appends columns that 001's rebuild would reject if it ran after. Parsing
 * the sources to predict the result would be a second implementation of the
 * boot path. Running it is the only way to be sure the answer is the same one
 * production gets.
 */
async function freshSqliteSchema() {
  const dir = mkdtempSync(path.join(tmpdir(), 'wev-pgschema-'));
  const file = path.join(dir, 'derive.db');
  const previous = process.env.WEV_DB_PATH;
  process.env.WEV_DB_PATH = file;

  try {
    const db = await import(path.join(ROOT, 'server', 'db.js'));
    db.initDatabase();
    await db.completeDatabaseInit();

    const handle = new DatabaseSync(file);
    const objects = handle.prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_master
        WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
        ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name`
    ).all();
    handle.close();
    return objects;
  } finally {
    if (previous === undefined) delete process.env.WEV_DB_PATH;
    else process.env.WEV_DB_PATH = previous;

    /* The directory came from `mkdtempSync` moments ago and holds one database
       this script created, so in principle nothing here needs protecting. The
       content check runs anyway, because `tooling.scriptSafety.test.js` requires
       every `bin/` script that deletes to run it and is right to: "the path is
       obviously safe" is the reasoning behind most deletions that were not.
       If this ever finds real data, the temp path has been redirected and the
       delete must not happen. */
    refuseNonDisposableDatabase({
      tool: 'postgres schema generation',
      dbPath: file,
      effect: 'delete the throwaway database it derives the schema from',
    });
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * 2. The translation table
 * ──────────────────────────────────────────────────────────────────────────── */

/** Counts every rewrite, so an expectation below can be asserted rather than hoped for. */
const fired = new Map();
const rewrite = (sql, label, pattern, replacement) => {
  const before = sql;
  const out = sql.replace(pattern, replacement);
  /* A non-global pattern matches once, but `String.match` returns the capture
     groups alongside it — counting those would report 190 rewrites for 95
     indexes. */
  const hits = pattern.global ? (before.match(pattern)?.length ?? 0) : 1;
  if (out !== before) fired.set(label, (fired.get(label) ?? 0) + hits);
  return out;
};

/**
 * Type mapping.
 *
 * `REAL` is the interesting one. SQLite's REAL is a C double, and PostgreSQL's
 * `real` is a **4-byte float** — half the precision. The hours ledger sums REAL
 * columns, and silently losing precision on service hours is the kind of bug
 * that is discovered by a student whose 100-hour certificate says 99.99. So
 * `double precision`, which is the same 8 bytes SQLite was using.
 *
 * `INTEGER` stays `integer` rather than becoming `boolean` for the 22 columns
 * that hold 0/1. Changing the type would change what every one of ~800 query
 * sites receives, on the same day the engine changes. Booleans are a separate,
 * later, reversible change; `WHERE x = 1` keeps working meanwhile.
 */
function translateTable(sql) {
  let out = sql;

  /* Idempotence, and it is not cosmetic: this DDL runs at every boot, so a
     statement that fails on the second start is a server that starts once.
     Migrations wrote `CREATE TABLE x` without the guard because the runner
     tracked what had already applied; here there is no runner. */
  out = rewrite(out, 'CREATE TABLE → IF NOT EXISTS',
    /^CREATE TABLE (?!IF NOT EXISTS)/i, 'CREATE TABLE IF NOT EXISTS ');

  out = rewrite(out, 'REAL → double precision', /\bREAL\b/g, 'double precision');
  out = rewrite(out, 'BLOB → bytea', /\bBLOB\b/g, 'bytea');

  /* SQLite's `INTEGER PRIMARY KEY AUTOINCREMENT` is a rowid alias with a
     monotonic guarantee. PostgreSQL's identity column is the same contract, and
     `BY DEFAULT` (not `ALWAYS`) because the app inserts explicit ids in tests. */
  out = rewrite(out, 'AUTOINCREMENT → identity',
    /\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/gi,
    'integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY');

  /* A column default of `datetime('now')` — PostgreSQL has no such function,
     and the column is TEXT holding an ISO-8601 string, so the replacement has to
     produce the same *format*, not merely the same instant. `now()` alone would
     store `2026-08-16 17:53:04.12+00`, which every `new Date(row.created_at)`
     in the app would still parse but which sorts differently as text against the
     `2026-08-16T17:53:04.120Z` the application writes. */
  out = rewrite(out, "DEFAULT datetime('now') → ISO-8601 UTC",
    /DEFAULT\s*\(\s*datetime\s*\(\s*'now'\s*\)\s*\)/gi,
    "DEFAULT (to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'))");

  /* SQLite allows a bare `IS NOT` between two values as a null-safe inequality.
     PostgreSQL spells it `IS DISTINCT FROM`. */
  out = rewrite(out, 'IS NOT → IS DISTINCT FROM', /\bIS\s+NOT\s+(?=(?:NEW|OLD)\.)/gi, 'IS DISTINCT FROM ');

  return out;
}

/**
 * Indexes.
 *
 * The three `COLLATE NOCASE` indexes are the only place the schema asks for
 * case-insensitive comparison, and they are load-bearing: they enforce that two
 * accounts cannot differ only in the case of their email or username.
 * `nocase` is defined once, as a real ICU collation, in the preamble.
 */
function translateIndex(sql) {
  let out = sql;
  out = rewrite(out, 'COLLATE NOCASE (index)', /COLLATE\s+NOCASE/gi, 'COLLATE nocase');
  out = rewrite(out, 'CREATE INDEX → IF NOT EXISTS',
    /^CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/i, (_, unique) => `CREATE ${unique ?? ''}INDEX IF NOT EXISTS `);
  return out;
}

/**
 * Triggers, which are the one genuinely different mechanism.
 *
 * All twenty are the same idea — an append-only or write-once table refusing a
 * DELETE or an UPDATE — expressed as SQLite's `SELECT RAISE(ABORT, 'message')`.
 * PostgreSQL has no `RAISE` in SQL, so each becomes a PL/pgSQL function that
 * raises an exception, plus a trigger that calls it.
 *
 * The four shapes present, all handled:
 *
 *   BEFORE DELETE ON t                       … unconditional refusal
 *   BEFORE UPDATE ON t                       … unconditional refusal
 *   BEFORE UPDATE OF a, b, c ON t            … refusal scoped to columns
 *   BEFORE <op> ON t WHEN <predicate>        … conditional refusal
 *
 * `UPDATE OF` has no PostgreSQL equivalent in the trigger *body*, but it does
 * as `AFTER UPDATE OF a, b, c` in the trigger *declaration* — PostgreSQL
 * supports column-scoped UPDATE triggers directly, so the scoping survives
 * intact rather than being re-implemented as a WHEN clause comparing each
 * column.
 */
function translateTrigger(sql) {
  const flat = sql.replace(/\s+/g, ' ').trim();

  const m = flat.match(
    /^CREATE TRIGGER (\w+) BEFORE (DELETE|UPDATE)(?: OF ([\w, ]+?))? ON (\w+)(?: WHEN (.+?))? BEGIN SELECT RAISE\(ABORT, '(.+?)'\); END$/i
  );
  if (!m) {
    throw new Error(
      `Untranslatable trigger — this generator handles only the append-only RAISE(ABORT) shape:\n  ${flat}\n`
      + '  Add the shape here deliberately, with a comment saying what PostgreSQL does instead.'
    );
  }

  const [, name, op, columns, table, when, rawMessage] = m;
  const message = rawMessage.replace(/''/g, "'");
  fired.set(`trigger (${op.toLowerCase()})`, (fired.get(`trigger (${op.toLowerCase()})`) ?? 0) + 1);

  const guard = when ? `  IF ${translateWhen(when)} THEN\n` : '';
  const close = when ? '  END IF;\n' : '';
  const scope = columns ? ` OF ${columns.trim()}` : '';

  /* The return value, which has three wrong answers and one right one per
     operation. In a PostgreSQL BEFORE trigger:
       - `RETURN NULL` **cancels the row operation silently** — no error, no
         rows affected. For a guard whose job is to refuse loudly or stand
         aside, that is the worst possible default.
       - `RETURN OLD` from BEFORE UPDATE writes the OLD values back, discarding
         the update just as silently.
     So: DELETE returns OLD (the row being removed), UPDATE returns NEW (the row
     as it should land). Both wrong answers were written and both were caught
     here, by the behavioural tests below rather than by any structural check —
     with NULL, the retention worker's aged-row delete quietly did nothing; with
     OLD on UPDATE, an appellant's first statement write was discarded so the
     write-once guard never armed. */
  return `CREATE OR REPLACE FUNCTION ${name}_fn() RETURNS trigger AS $$
BEGIN
${guard}    RAISE EXCEPTION '%', ${quote(message)};
${close}  RETURN ${op.toUpperCase() === 'DELETE' ? 'OLD' : 'NEW'};
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER ${name} BEFORE ${op}${scope} ON ${table}
  FOR EACH ROW EXECUTE FUNCTION ${name}_fn();`;
}

/**
 * The three WHEN predicates in use, translated.
 *
 * Enumerated rather than parsed. There are three, each is load-bearing, and a
 * general SQLite-expression translator would be a large piece of machinery whose
 * mistakes would be silent — a WHEN clause that translates to something merely
 * *plausible* turns an immutability guarantee off without anybody noticing.
 * An unrecognised predicate throws.
 */
function translateWhen(when) {
  const flat = when.replace(/\s+/g, ' ').trim();

  /* `OLD.created_at >= datetime('now','-364 days')` — the retention worker is
     allowed to delete audit logs older than a year; nobody may delete newer
     ones. The comparison is between TEXT ISO-8601 values, so the replacement
     must produce the same format the column holds. */
  const retention = flat.match(/^(.+?)\s+AND\s+OLD\.created_at >= datetime\('now', '-(\d+) days'\)$/i);
  if (retention) {
    return `${translateWhen(retention[1])} AND OLD.created_at >= `
      + `to_char((now() - interval '${retention[2]} days') AT TIME ZONE 'utc', `
      + `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
  }

  /* `OLD.action NOT IN (…)` — portable as written. */
  if (/^OLD\.\w+ NOT IN \([^()]*\)$/i.test(flat)) return flat;

  /* `EXISTS (SELECT 1 FROM t WHERE col = OLD.id)` — portable as written. */
  if (/^EXISTS \(SELECT 1 FROM \w+ WHERE [\w. =]+\)$/i.test(flat)) return flat;

  /* `OLD.x IS NOT NULL AND NEW.x IS NOT OLD.x` — the write-once shape. SQLite's
     bare `IS NOT` between two values is null-safe inequality, which PostgreSQL
     spells `IS DISTINCT FROM`. Translating it to `<>` would make the guard stop
     firing whenever either side is NULL. */
  const writeOnce = flat.match(/^OLD\.(\w+) IS NOT NULL AND NEW\.(\w+) IS NOT OLD\.(\w+)$/i);
  if (writeOnce) {
    const [, a, b, c] = writeOnce;
    return `OLD.${a} IS NOT NULL AND NEW.${b} IS DISTINCT FROM OLD.${c}`;
  }

  throw new Error(
    `Untranslated trigger WHEN clause:\n  ${flat}\n`
    + '  Add it above deliberately. A guess here silently disables an immutability guarantee.'
  );
}

const quote = (s) => `'${s.replace(/'/g, "''")}'`;

/**
 * The backstop.
 *
 * Everything above is a positive rule — "when you see X, write Y". This is the
 * negative one: after translation, no recognisably SQLite-only token may remain.
 * Without it, a construct nobody thought of passes through as DDL that looks
 * fine and fails at `CREATE TABLE` time on a deployment, or worse, succeeds and
 * means something else.
 */
function assertNoSqliteIsms(sql) {
  const banned = [
    [/\bAUTOINCREMENT\b/i, 'AUTOINCREMENT'],
    [/\bWITHOUT ROWID\b/i, 'WITHOUT ROWID'],
    /* Case-sensitive on purpose: `NOCASE` is SQLite's built-in keyword, and
       `nocase` is the ICU collation the preamble defines. The translated output
       legitimately contains the second. */
    [/\bCOLLATE\s+NOCASE\b/, 'COLLATE NOCASE (should be the nocase ICU collation)'],
    [/\bdatetime\s*\(/i, "datetime()"],
    [/\bstrftime\s*\(/i, 'strftime()'],
    [/\bjulianday\s*\(/i, 'julianday()'],
    [/\bRAISE\s*\(\s*ABORT/i, 'RAISE(ABORT)'],
    [/\bsqlite_/i, 'sqlite_ internal'],
    [/\bPRAGMA\b/i, 'PRAGMA'],
    [/\bINSERT\s+OR\s+(IGNORE|REPLACE)\b/i, 'INSERT OR IGNORE/REPLACE'],
    [/\bTEXT\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/i, 'TEXT AUTOINCREMENT'],
    [/\browid\b/i, 'rowid'],
  ];
  for (const [pattern, name] of banned) {
    const hit = sql.match(pattern);
    if (hit) {
      const at = sql.slice(Math.max(0, sql.indexOf(hit[0]) - 90), sql.indexOf(hit[0]) + 90);
      throw new Error(`Untranslated SQLite construct "${name}" survived generation:\n…${at}…`);
    }
  }
}

/**
 * Tables, in an order PostgreSQL will accept.
 *
 * SQLite resolves a foreign key's target lazily — `CREATE TABLE a … REFERENCES b`
 * succeeds when `b` does not exist yet, and only fails if you insert. So the
 * schema comes out of `sqlite_master` in creation order, which is really
 * migration order, and the first table alphabetically (`admin_audit_logs`)
 * references `users`.
 *
 * PostgreSQL resolves it immediately, so the tables have to be sorted by
 * dependency first. A cycle would be unorderable and throws rather than being
 * papered over: the fix for one is to detach that edge into a trailing
 * `ALTER TABLE … ADD CONSTRAINT`, which is a deliberate change to make, not one
 * to make silently. There are none today.
 */
function sortByDependency(tables) {
  const names = new Set(tables.map(t => t.name));
  const references = new Map(tables.map(t => [
    t.name,
    /* Self-references are dropped: a table pointing at its own primary key
       (`users.promoted_by → users.id`) is satisfied by the time the statement
       finishes, and keeping the edge would report every one as a cycle. */
    new Set([...t.sql.matchAll(/REFERENCES\s+"?(\w+)"?/gi)]
      .map(m => m[1])
      .filter(n => names.has(n) && n !== t.name)),
  ]));

  const byName = new Map(tables.map(t => [t.name, t]));
  const ordered = [];
  const placed = new Set();

  while (ordered.length < tables.length) {
    const ready = [...byName.keys()]
      .filter(n => !placed.has(n))
      .filter(n => [...references.get(n)].every(dep => placed.has(dep)))
      .sort();

    if (ready.length === 0) {
      const stuck = [...byName.keys()].filter(n => !placed.has(n));
      throw new Error(
        'Foreign-key cycle among these tables, so no creation order exists:\n'
        + stuck.map(n => `  ${n} → ${[...references.get(n)].filter(d => !placed.has(d)).join(', ')}`).join('\n')
        + '\n  Break it by emitting one edge as a trailing ALTER TABLE … ADD CONSTRAINT.'
      );
    }

    for (const n of ready) { ordered.push(byName.get(n)); placed.add(n); }
  }

  return ordered;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 3. Assembly
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * A case-insensitive collation, defined once.
 *
 * `deterministic = false` is required and is the whole point: it lets two
 * strings that differ only in case compare equal, which is what a unique index
 * on an email address has to mean. ICU level-2 strength ignores case and
 * variant but keeps accents distinct, matching SQLite's NOCASE closely enough
 * for the three indexes that use it (email, username) — both of which are
 * ASCII in practice, and both of which are additionally normalised in the
 * application before they are written.
 */
const PREAMBLE = `-- Generated by bin/generate-postgres-schema.mjs. Do not edit.
DO $$
BEGIN
  -- Scoped to the CURRENT schema, not the database. pg_collation spans every
  -- schema, so an unscoped check finds a nocase belonging to some other one,
  -- skips creation here, and leaves COLLATE nocase unresolvable — the index DDL
  -- twelve lines later then fails with "collation does not exist" while the
  -- collation plainly exists, somewhere unreachable. Found when a test run left
  -- its namespace behind and every subsequent run failed at boot.
  IF NOT EXISTS (
    SELECT 1 FROM pg_collation
     WHERE collname = 'nocase' AND collnamespace = current_schema()::regnamespace
  ) THEN
    CREATE COLLATION nocase (provider = icu, locale = 'und-u-ks-level2', deterministic = false);
  END IF;
END
$$;`;

async function generate() {
  const raw = await freshSqliteSchema();
  /* Read from the registry rather than hard-coded, so adding migration 056 to
     `MIGRATIONS` and regenerating is one step, not two. */
  const { MIGRATIONS } = await import(path.join(ROOT, 'server', 'migrations', 'index.js'));
  const latestMigrationVersion = Math.max(...MIGRATIONS.map(m => m.version));

  /* Tables first and in dependency order; indexes and triggers keep their
     alphabetical order, since both only need their own table to exist. */
  const objects = [
    ...sortByDependency(raw.filter(o => o.type === 'table')),
    ...raw.filter(o => o.type !== 'table'),
  ];
  const parts = [PREAMBLE];
  const counts = { table: 0, index: 0, trigger: 0 };

  for (const o of objects) {
    counts[o.type] = (counts[o.type] ?? 0) + 1;
    if (o.type === 'table') parts.push(`${translateTable(o.sql).trim()};`);
    else if (o.type === 'index') parts.push(`${translateIndex(o.sql).trim()};`);
    else if (o.type === 'trigger') parts.push(translateTrigger(o.sql));
    else throw new Error(`Unhandled schema object type: ${o.type} (${o.name})`);
  }

  const ddl = parts.join('\n\n');
  assertNoSqliteIsms(ddl);

  /* The migration registry's bookkeeping table, created here rather than
     translated: on SQLite it is created by `ensureBookkeeping` at boot, and a
     PostgreSQL database has to carry it too so that a future PostgreSQL-native
     migration can record itself. It is seeded as "everything up to 55 applied",
     because the schema above IS the result of those 55 — a PostgreSQL database
     must never be told to run them. */
  const bookkeeping = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    integer PRIMARY KEY,
  name       text NOT NULL,
  applied_at text NOT NULL,
  checksum   text
);`;

  const file = `/**
 * The PostgreSQL schema, generated from the SQLite one.
 *
 * DO NOT EDIT. Run \`node bin/generate-postgres-schema.mjs\` instead, and read
 * that file's header for why this is derived rather than written.
 *
 * Contents: ${counts.table} tables, ${counts.index} indexes, ${counts.trigger} triggers
 * (as ${counts.trigger} PL/pgSQL functions plus ${counts.trigger} triggers), and the
 * migration bookkeeping table.
 *
 * \`server/db.postgresSchema.test.js\` regenerates this and fails if it differs,
 * so the SQLite schema and this file cannot drift apart.
 */

/** Every statement, in dependency order: tables, then indexes, then triggers. */
export const POSTGRES_SCHEMA = String.raw\`
${ddl}
${bookkeeping}
\`;

/**
 * The migration version the DDL above embodies.
 *
 * A PostgreSQL database created from this file starts at the destination rather
 * than being walked to it, so nothing in the registry is outstanding on it.
 *
 * ── This is NOT the baseline for an existing database ──
 *
 * It moves with every regeneration, which is correct for "what does this DDL
 * contain" and catastrophic as an answer to "what has the deployed database
 * already had applied". A database provisioned before a migration was written
 * does not have that migration, however new this constant is. That question is
 * answered by \`POSTGRES_BASELINE_VERSION\` in the migration registry, which is
 * frozen; see the note there.
 */
export const LATEST_MIGRATION_VERSION = ${latestMigrationVersion};

/**
 * Creates the schema on a PostgreSQL database, and brings an existing one up to
 * date.
 *
 * Idempotent: every statement in the DDL is \`IF NOT EXISTS\` or
 * \`CREATE OR REPLACE\`, so a re-run against a database that already has the
 * schema is a no-op rather than an error. That matters because this runs at
 * boot, and a boot that fails on the second start is worse than one that fails
 * on the first.
 *
 * ── Idempotent is exactly why the migrations below are needed ──
 *
 * \`CREATE TABLE IF NOT EXISTS\` against a table that already exists does not
 * reconcile it — it skips it. So every schema change made after a deployment
 * was provisioned (a widened CHECK, a new column, a new index) reached a NEW
 * database through this DDL and reached the DEPLOYED one not at all, with the
 * boot reporting success either way. \`runPostgresMigrations\` is the other half.
 *
 * ── Fresh and existing are told apart before anything is written ──
 *
 * Emptiness is read from \`schema_migrations\` BEFORE the DDL runs, because the
 * DDL creates that table. A fresh database records every registry version as
 * supplied-by-this-schema, so no migration is outstanding on it. An existing one
 * records nothing, and the runner walks it forward.
 *
 * The previous version of this function wrote one \`postgres_baseline\` row at
 * the CURRENT latest version, unconditionally. On an existing database that
 * claimed a migration had been applied which never ran — so the bookkeeping did
 * not merely fail to record the change, it recorded a change that never
 * happened, and every release added another such row.
 */
export async function applyPostgresSchema(db) {
  /* Imported here rather than at module scope: this file is generated, and the
     registry imports nothing from it, so a top-level import would be a cycle
     between the schema and the migrations that describe it. */
  const { seedPostgresBaseline, postgresIsFresh, runPostgresMigrations } =
    await import('../migrations/index.js');

  /* Refuse a database created by a different schema source before touching it.
     Lives in its own module rather than inline HERE because this file is
     generated: an inline guard would be silently deleted by the next
     regeneration, which is exactly the kind of quiet loss it exists to catch.
     See server/db/schemaSourceGuard.js. */
  const { assertSchemaSourceCompatible } = await import('./schemaSourceGuard.js');
  await assertSchemaSourceCompatible(db);

  const fresh = await postgresIsFresh(db);

  /**
   * On an EXISTING database the migrations run FIRST, and the order is the
   * whole point.
   *
   * This DDL is generated from a fully-migrated SQLite database, so it contains
   * the finished shape — including indexes over columns that older deployments
   * do not have yet. \`CREATE TABLE IF NOT EXISTS events\` against a table that
   * already exists is a no-op and does NOT add the column; the
   * \`CREATE INDEX IF NOT EXISTS … (status, first_slot_start, id)\` two lines
   * later is not a no-op, and fails with
   * \`column "first_slot_start" does not exist\`.
   *
   * That is a boot failure for every deployment upgrading across a migration
   * that adds a column and an index on it — found on the real Supabase
   * database, which had been provisioned at migration 61 and refused to come up
   * on 64. It fails loudly and rolls back the implicit transaction, which is the
   * only forgiving thing about it.
   *
   * Walking the migrations first puts the database into the shape this DDL
   * describes, after which every statement here is the no-op it was always meant
   * to be. The DDL still runs afterwards, so it keeps its second job: repairing
   * a database missing an object outright.
   *
   * A FRESH database keeps the original order, because there the DDL is not a
   * repair net, it is the whole schema — and nothing can be migrated onto a
   * database with no tables.
   *
   * SQLite-style \`?\` placeholders, not \`$1\`: every statement in this codebase
   * goes through \`translatePlaceholders\`, which rewrites \`?\` into PostgreSQL's
   * numbered form. Writing \`$1\` here bypasses the translator, which then reports
   * zero parameters and PostgreSQL answers "there is no parameter $1".
   *
   * Ported from claude/wevolunteer-perf-scaling-ad3613 (50a25b0).
   */
  if (fresh) {
    await db.exec(POSTGRES_SCHEMA);
    await seedPostgresBaseline(db);
  } else {
    await runPostgresMigrations(db);
    await db.exec(POSTGRES_SCHEMA);
  }

  /**
   * The reserved \`system-cli\` actor, which the DDL above cannot carry.
   *
   * This file is generated from the migrations' DDL. Migration 022 creates the
   * actor with an INSERT — DML — so the generator drops it, and a clean-slate
   * PostgreSQL database came up structurally complete and semantically
   * incomplete: all 65 tables and 87 foreign keys, and not the one row
   * \`assertSystemActor()\` requires.
   *
   * Every privileged command depends on it — bootstrap-owners, grant-ownership,
   * revoke-ownership, make-admin, reset-2fa, clear-stale-tfa-secret — so a fresh
   * PostgreSQL deployment had no sanctioned way to create its FIRST OWNER.
   * Found on the real production Supabase database, after the schema applied
   * cleanly and bootstrap-owners then refused.
   *
   * Seeded here rather than by replaying migration DML generally: that would
   * mean deciding which DML is schema-level and which is data-level, and
   * getting that wrong on a data migration is worse than the bug it fixes.
   *
   * NOTE the companion change in db.js: the "is this database empty" gates count
   * users, and this row is a user. They now exclude it, or a demo database
   * seeds nothing because it looks already-initialised.
   *
   * Values mirror migration 022 exactly, including \`account_status\` 'deleted'
   * and role 'student' — what keeps the actor unable to sign in and off every
   * roster. \`WHERE NOT EXISTS\` matches the baseline row above: idempotent, and
   * it will not overwrite the row if a later migration gives it new columns.
   */
  await db.prepare(
    \`INSERT INTO users (
        id, name, email, username, password_hash, grade, role, verified,
        avatar, bio, school, skills, email_verified, account_status,
        leaderboard_opt_in, email_opt_out, profile_visibility, created_at, token_version
      ) SELECT ?, ?, ?, ?, ?, 'N/A', 'student', 0, ?, ?, ?, ?, 0, 'deleted', 0, 1, 'private', ?, 0
         WHERE NOT EXISTS (SELECT 1 FROM users WHERE id = ?)\`
  ).run(
    'system-cli',
    'System (command line)',
    'system-cli@wevolunteer.invalid',
    'system_cli',
    '!SYSTEM_ACCOUNT_NO_LOGIN!',
    '\u2699\ufe0f',
    'Reserved. Records privileged actions performed from the command line, which have no signed-in user to attribute them to.',
    'WeVolunteer',
    JSON.stringify([]),
    new Date().toISOString(),
    'system-cli',
  );
}
`;

  return { file, counts, ddl };
}

const { file, counts } = await generate();

if (process.argv.includes('--check')) {
  if (!existsSync(OUTPUT)) {
    console.error(`${OUTPUT} does not exist. Run without --check to create it.`);
    process.exit(1);
  }
  if (readFileSync(OUTPUT, 'utf8') !== file) {
    console.error(
      'server/db/postgresSchema.js is out of date with the SQLite schema.\n'
      + 'Run: node bin/generate-postgres-schema.mjs'
    );
    process.exit(1);
  }
  console.log('postgresSchema.js is current.');
} else {
  writeFileSync(OUTPUT, file);
  console.log(`Wrote ${path.relative(ROOT, OUTPUT)}`);
  console.log(`  ${counts.table} tables, ${counts.index} indexes, ${counts.trigger} triggers`);
  console.log('  rewrites applied:');
  for (const [label, n] of [...fired].sort()) console.log(`    ${String(n).padStart(3)}  ${label}`);
}
