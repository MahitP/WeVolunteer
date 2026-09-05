/**
 * A database provisioned from the wrong schema source must be refused at boot.
 *
 * ── What this is protecting ──
 *
 * The repository carries two PostgreSQL schema definitions, and only one of
 * them is how production is built:
 *
 *   server/db/postgresSchema.js            the application's own schema, applied
 *                                          by completeDatabaseInit() on boot
 *   supabase/migrations/*_baseline.sql     a HISTORICAL artefact generated from
 *                                          pilot.db during the SQLite migration
 *
 * They disagree on 150 columns — ~130 timestamps (TEXT vs TIMESTAMPTZ) and ~20
 * booleans (INTEGER 0/1 vs BOOLEAN) — because the application's types are
 * deliberately SQLite-compatible so one codebase serves both engines.
 *
 * `CREATE TABLE IF NOT EXISTS` cannot repair a table that already exists, so a
 * database built from the baseline keeps BOOLEAN columns and the application
 * then runs `WHERE present = 1` against them.
 *
 * Two failure modes, and the quiet one is the dangerous one:
 *
 *   loud   PostgreSQL: operator does not exist: boolean = integer
 *   quiet  pg returns BOOLEAN as JavaScript `true`; hoursLedger credits on
 *          `present === 1`; `true === 1` is false, so every attending
 *          volunteer is credited ZERO hours
 *
 * The second is why this guard exists rather than a note in a runbook.
 */
import { describe, it, expect } from 'vitest';
import { assertSchemaSourceCompatible } from './schemaSourceGuard.js';

/**
 * Minimal stand-in for the db handle: the guard only ever issues one shape of
 * query, so a map from column to reported type is the whole surface.
 */
function fakeDb(types) {
  return {
    prepare() {
      return {
        async get(table, column) {
          const key = `${table}.${column}`;
          return key in types ? { data_type: types[key] } : undefined;
        }
      };
    }
  };
}

const APP_SCHEMA = {
  'attendance.present': 'integer',
  'users.created_at': 'text',
};

const BASELINE_SCHEMA = {
  'attendance.present': 'boolean',
  'users.created_at': 'timestamp with time zone',
};

describe('accepts', () => {
  it('a database built by the application', async () => {
    await expect(assertSchemaSourceCompatible(fakeDb(APP_SCHEMA))).resolves.toBeUndefined();
  });

  /**
   * The normal path for a first deployment: nothing exists yet, so there is no
   * evidence of a wrong source and the schema is about to be created correctly.
   */
  it('an empty database, where no sentinel table exists', async () => {
    await expect(assertSchemaSourceCompatible(fakeDb({}))).resolves.toBeUndefined();
  });

  it('a half-created database, where only one sentinel exists', async () => {
    await expect(
      assertSchemaSourceCompatible(fakeDb({ 'attendance.present': 'integer' }))
    ).resolves.toBeUndefined();
  });
});

describe('refuses', () => {
  it('a database provisioned from the Supabase baseline', async () => {
    await expect(assertSchemaSourceCompatible(fakeDb(BASELINE_SCHEMA)))
      .rejects.toThrow(/different schema source/);
  });

  /**
   * Each divergence class is caught on its own. A database that got only its
   * booleans wrong is just as broken as one that got everything wrong, and the
   * boolean class is the one that silently zeroes credited hours.
   */
  it('on the boolean class alone', async () => {
    await expect(assertSchemaSourceCompatible(fakeDb({
      ...APP_SCHEMA, 'attendance.present': 'boolean',
    }))).rejects.toThrow(/attendance\.present is boolean/);
  });

  it('on the timestamp class alone', async () => {
    await expect(assertSchemaSourceCompatible(fakeDb({
      ...APP_SCHEMA, 'users.created_at': 'timestamp with time zone',
    }))).rejects.toThrow(/users\.created_at is timestamp with time zone/);
  });
});

describe('the message is actionable', () => {
  it('names the column, both types, and what to do', async () => {
    let msg = '';
    try { await assertSchemaSourceCompatible(fakeDb(BASELINE_SCHEMA)); }
    catch (e) { msg = e.message; }

    expect(msg).toMatch(/attendance\.present is boolean/);
    expect(msg).toMatch(/requires integer/);
    // The cause, which the raw PostgreSQL error never names.
    expect(msg).toMatch(/baseline_schema\.sql/);
    // The fix.
    expect(msg).toMatch(/EMPTY database/);
    expect(msg).toMatch(/Do not run the baseline migration by hand/);
  });

  /**
   * The observed first failure without this guard named `users.verified` — a
   * column unrelated to the cause — and sent an operator to the wrong place.
   * The message must explain the silent variant too, because an operator who
   * "fixes" the loud error by casting one column would then ship the quiet one.
   */
  it('explains the zero-hours failure, not just the type error', async () => {
    let msg = '';
    try { await assertSchemaSourceCompatible(fakeDb(BASELINE_SCHEMA)); }
    catch (e) { msg = e.message; }

    expect(msg).toMatch(/zero hours/);
    expect(msg).toMatch(/present === 1/);
  });
});
