#!/usr/bin/env node
/**
 * Reports whether the trigram indexes the search box relies on are actually
 * there, on the database this deployment is actually using.
 *
 * ── Why this needs a tool ──
 *
 * Migration 064 is allowed to DECLINE. `CREATE EXTENSION` needs a privilege the
 * application's role may not have, and failing the boot over an index would be
 * the wrong trade for a query that returns correct rows without one. So the
 * migration warns once, at a boot nobody was reading, and records itself as
 * applied.
 *
 * That is the right behaviour and it has one consequence: "the search is slow"
 * and "the search is fine" look identical from outside. This is the question an
 * operator can ask instead of reading a migration and guessing.
 *
 * It also catches the other direction — indexes that exist on a database whose
 * `pg_trgm` was later dropped, and a `search_path` that no longer contains the
 * schema the opclass lives in.
 *
 * ── Usage ──
 *
 *   node bin/verify-search-indexes.mjs           # report
 *   node bin/verify-search-indexes.mjs --strict  # exit 1 if anything is missing
 *
 * Read-only. It creates nothing, drops nothing and writes nothing.
 */
import { openPrivilegedDb } from './resolveDb.mjs';
import { TRIGRAM_INDEXES } from '../server/migrations/064_search_trigram_indexes.js';

const STRICT = process.argv.includes('--strict');

const { db } = await openPrivilegedDb('bin/verify-search-indexes.mjs');

/**
 * SQLite has nothing to check, and that is not a failure.
 *
 * The predicate there is `instr(...)`, which no index can answer on any engine,
 * and the pilot's few hundred events make the scan the right plan anyway. Said
 * out loud rather than silently reporting "0 of 4", which reads like breakage.
 */
if (db.dialect !== 'postgres') {
  console.log('engine: SQLite — trigram indexes are a PostgreSQL-only optimisation.');
  console.log('The search box is correct here and scans; see migration 064.');
  process.exit(0);
}

const [extension] = await db.prepare(`
  SELECT n.nspname AS schema, e.extversion AS version
    FROM pg_extension e
    JOIN pg_namespace n ON n.oid = e.extnamespace
   WHERE e.extname = 'pg_trgm'
`).all();

console.log(extension
  ? `pg_trgm: installed, version ${extension.version}, schema ${extension.schema}`
  : 'pg_trgm: NOT INSTALLED — every text search scans the whole events table.');

let missing = extension ? 0 : 1;

for (const [name, table, column] of TRIGRAM_INDEXES) {
  const [row] = await db.prepare(`
    SELECT c.relname AS name, pg_relation_size(c.oid) AS bytes,
           (SELECT COUNT(*) FROM pg_index i WHERE i.indexrelid = c.oid AND i.indisvalid) AS valid
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relname = ? AND c.relkind = 'i'
  `).all(name);

  if (!row) {
    missing += 1;
    console.log(`  MISSING  ${name.padEnd(30)} ${table}(lower(${column}))`);
    continue;
  }
  /* An index left INVALID by an interrupted `CREATE INDEX CONCURRENTLY` exists
     and is never used, which looks like "present" to anything that only asks
     whether the name is there. */
  const state = Number(row.valid) ? 'ok' : 'INVALID';
  console.log(`  ${state.padEnd(8)} ${name.padEnd(30)} ${(Number(row.bytes) / 1048576).toFixed(1)} MB`);
  if (!Number(row.valid)) missing += 1;
}

/**
 * Whether the planner would actually reach for one.
 *
 * An index can be present, valid and unused — a `search_path` without the
 * extension's schema, a stale `ANALYZE`, or a table small enough that a scan is
 * genuinely cheaper. The plan is the only answer that is not a guess, so this
 * asks for one with a needle chosen to match nothing: that is the case where an
 * index has the largest possible advantage, so a sequential scan there means it
 * is not being used at all rather than that the planner made a defensible
 * choice.
 *
 * Below a few thousand rows a sequential scan IS the defensible choice, and
 * reporting it as a fault would send an operator looking for a problem that is
 * a correct decision about a small table. So the question is only asked when
 * the answer means something.
 */
const [{ n: eventCount }] = await db.prepare('SELECT COUNT(*) AS n FROM events').all();
const PLAN_MEANINGFUL_ABOVE = 2000;

let plannerOk = true;
if (Number(eventCount) < PLAN_MEANINGFUL_ABOVE) {
  console.log(`planner: not asked — ${eventCount} events is small enough that a scan is `
    + 'the right plan whatever indexes exist.');
} else {
  const rows = await db.prepare(`
    EXPLAIN (FORMAT JSON)
    SELECT id FROM events WHERE lower(title) LIKE ('%' || lower(?) || '%')
  `).all('zzzz-no-such-title-zzzz');
  const plan = JSON.stringify(rows[0]?.['QUERY PLAN'] ?? rows[0] ?? '');
  plannerOk = /Bitmap Index Scan|Index Scan/.test(plan);
  console.log(plannerOk
    ? 'planner: chooses an index for a selective title search.'
    : 'planner: chooses a SEQUENTIAL SCAN for a selective title search — the index '
      + 'exists but is not being used.');
}

if (missing === 0 && plannerOk) {
  console.log('\nSearch indexing is complete.');
  process.exit(0);
}

if (missing > 0) {
  console.log(`\n${missing} item(s) missing or invalid.`);
  console.log('To fix, as a role that may create extensions:');
  console.log('  CREATE EXTENSION IF NOT EXISTS pg_trgm;');
  console.log('then restart the application, or create the indexes named above with');
  console.log('CREATE INDEX CONCURRENTLY using the expressions listed in migration 064.');
} else {
  console.log('\nEvery index is present but the planner is not using one. Check that '
    + "the extension's schema is on the connection's search_path, and run ANALYZE events.");
}
if (STRICT) process.exit(1);
