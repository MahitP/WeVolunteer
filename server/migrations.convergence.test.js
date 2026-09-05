/**
 * A fresh database and an upgraded one must end up with the SAME schema.
 *
 * ── Why this file exists ──
 *
 * PostgreSQL is provisioned two entirely different ways, and until now nothing
 * compared their results:
 *
 *   FRESH    `applyPostgresSchema` runs generated DDL that already contains
 *            every migration's effect, then records all of them as supplied.
 *            Almost no `postgres.up` executes.
 *   UPGRADE  an older database walks forward through `postgres.up` one
 *            migration at a time, and the generated DDL is a no-op net behind
 *            them.
 *
 * Two code paths producing one schema is an assumption, and this repository has
 * now been bitten by it twice: a postgres-only migration recorded as applied
 * without running, and generated DDL indexing a column its own migrations had
 * not added yet. Both were invisible to every existing test, because every
 * existing test asserted the migration LEDGER — the row count, the version
 * number — rather than the schema those migrations were supposed to produce.
 *
 * So this compares the catalogue: columns and their types and nullability,
 * every index by its definition, every constraint by its definition, and the
 * triggers. If the two paths disagree about anything, one of them is wrong and
 * a deployment somewhere has a schema nobody designed.
 *
 *   TEST_POSTGRES_URL=postgres://…/db npm test
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgresDatabase } from './db/postgresConnection.js';
import { translatePlaceholders } from './db/sqlPlaceholders.js';
import { MIGRATIONS } from './migrations/index.js';

const BASE_URL = process.env.TEST_POSTGRES_URL;
const live = Boolean(BASE_URL);

const FRESH = 'wev_converge_fresh';
const UPGRADED = 'wev_converge_upgraded';

/**
 * The state an older deployment is in: everything this branch added after 064
 * removed, and the ledger wound back to match.
 *
 * Written against what those migrations ADD, so a new migration that adds a
 * column or an index belongs in this list. That is deliberate friction: the
 * list is the statement of what "an older deployment" means, and it should
 * cost a line to change.
 */
const WIND_BACK = [
  'DROP TABLE IF EXISTS scheduler_leases CASCADE',            // 065
  'DROP INDEX IF EXISTS idx_events_first_slot_start',         // 066
  'DROP INDEX IF EXISTS idx_events_browse_order',             // 066
  'ALTER TABLE events DROP COLUMN IF EXISTS first_slot_start', // 066
  'DROP INDEX IF EXISTS idx_events_title_trgm',               // 067
  'DROP INDEX IF EXISTS idx_events_description_trgm',         // 067
  'DROP INDEX IF EXISTS idx_events_location_trgm',            // 067
  'DROP INDEX IF EXISTS idx_users_name_trgm',                 // 067
];
const WIND_BACK_TO = 64;

const connect = (schema) => {
  const u = new global.URL(BASE_URL);
  u.searchParams.set('options', `-c search_path=${schema}`);
  return new PostgresDatabase({ connectionString: u.toString(), max: 4, translate: translatePlaceholders });
};

async function makeSchema(name) {
  const admin = new PostgresDatabase({ connectionString: BASE_URL, max: 1, translate: translatePlaceholders });
  await admin.exec(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
  await admin.exec(`CREATE SCHEMA ${name}`);
  await admin.close();
}

/* Definitions rather than names: two indexes can share a name and index
   different columns, which is exactly the divergence worth catching. The
   schema qualifier is stripped because the two live in different schemas. */
const COLUMNS = (s) => `
  SELECT c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
         || CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END AS sig
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = '${s}' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
   ORDER BY 1`;
const INDEXES = (s) => `
  SELECT regexp_replace(pg_get_indexdef(i.indexrelid), '${s}\\.', '', 'g') AS sig
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = '${s}' ORDER BY 1`;
const CONSTRAINTS = (s) => `
  SELECT conname || ' ' || contype::text || ' ' || pg_get_constraintdef(c.oid) AS sig
    FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
   WHERE n.nspname = '${s}' ORDER BY 1`;
const TRIGGERS = (s) => `
  SELECT tg.tgname AS sig FROM pg_trigger tg
    JOIN pg_class c ON c.oid = tg.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE NOT tg.tgisinternal AND n.nspname = '${s}' ORDER BY 1`;

let freshDb, upgradedDb;

beforeAll(async () => {
  if (!live) return;
  const { applyPostgresSchema } = await import('./db/postgresSchema.js');

  await makeSchema(FRESH);
  freshDb = connect(FRESH);
  await applyPostgresSchema(freshDb);

  await makeSchema(UPGRADED);
  upgradedDb = connect(UPGRADED);
  await applyPostgresSchema(upgradedDb);
  for (const sql of WIND_BACK) await upgradedDb.exec(sql);
  await upgradedDb.prepare('DELETE FROM schema_migrations WHERE version > ?').run(WIND_BACK_TO);
  await applyPostgresSchema(upgradedDb);           // the upgrade under test
}, 240000);

afterAll(async () => {
  if (!live) return;
  await freshDb?.close();
  await upgradedDb?.close();
  const admin = new PostgresDatabase({ connectionString: BASE_URL, max: 1, translate: translatePlaceholders });
  await admin.exec(`DROP SCHEMA IF EXISTS ${FRESH} CASCADE`);
  await admin.exec(`DROP SCHEMA IF EXISTS ${UPGRADED} CASCADE`);
  await admin.close();
});

const signatures = async (db, sql) => new Set((await db.prepare(sql).all()).map((r) => r.sig));

describe.skipIf(!live)('a fresh database and an upgraded one converge', () => {
  it('starts from two genuinely different provisioning paths', async () => {
    const [f] = await freshDb.prepare(
      'SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE checksum <> ?)::int AS ran FROM schema_migrations'
    ).all('baseline');
    const [u] = await upgradedDb.prepare(
      'SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE checksum <> ?)::int AS ran FROM schema_migrations'
    ).all('baseline');

    expect(f.n, 'both should record every migration').toBe(MIGRATIONS.length);
    expect(u.n).toBe(MIGRATIONS.length);
    /* The point of the fixture: the upgraded one actually EXECUTED migrations
       the fresh one only recorded. If this is ever 0, the test is comparing a
       fresh database against itself. */
    expect(u.ran, 'the upgrade path ran no migrations — it is not an upgrade')
      .toBeGreaterThan(f.ran);
  });

  it('has the same columns, types and nullability', async () => {
    const [f, u] = await Promise.all([
      signatures(freshDb, COLUMNS(FRESH)), signatures(upgradedDb, COLUMNS(UPGRADED)),
    ]);
    expect([...f].filter((x) => !u.has(x)), 'missing after an upgrade').toEqual([]);
    expect([...u].filter((x) => !f.has(x)), 'present only after an upgrade').toEqual([]);
  });

  it('has the same indexes, compared by definition rather than by name', async () => {
    const [f, u] = await Promise.all([
      signatures(freshDb, INDEXES(FRESH)), signatures(upgradedDb, INDEXES(UPGRADED)),
    ]);
    expect([...f].filter((x) => !u.has(x)), 'missing after an upgrade').toEqual([]);
    expect([...u].filter((x) => !f.has(x)), 'present only after an upgrade').toEqual([]);
  });

  it('has the same constraints', async () => {
    const [f, u] = await Promise.all([
      signatures(freshDb, CONSTRAINTS(FRESH)), signatures(upgradedDb, CONSTRAINTS(UPGRADED)),
    ]);
    expect([...f].filter((x) => !u.has(x))).toEqual([]);
    expect([...u].filter((x) => !f.has(x))).toEqual([]);
  });

  it('has the same triggers', async () => {
    const [f, u] = await Promise.all([
      signatures(freshDb, TRIGGERS(FRESH)), signatures(upgradedDb, TRIGGERS(UPGRADED)),
    ]);
    expect([...f]).toEqual([...u]);
  });

  it('records the same ledger, and the upgraded rows carry real checksums', async () => {
    const rows = await upgradedDb.prepare(
      'SELECT version, checksum FROM schema_migrations WHERE version > ? ORDER BY version'
    ).all(WIND_BACK_TO);
    const expected = MIGRATIONS.filter((m) => m.version > WIND_BACK_TO).map((m) => m.version);
    expect(rows.map((r) => Number(r.version))).toEqual(expected);
    for (const row of rows) {
      expect(row.checksum, 'a migration that RAN must not be recorded as baseline').not.toBe('baseline');
    }
  });
});
