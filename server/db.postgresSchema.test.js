/**
 * The generated PostgreSQL schema, held against the SQLite one it came from.
 *
 * ── The two things this has to prove ──
 *
 * **That it is current.** `bin/generate-postgres-schema.mjs --check` regenerates
 * from a freshly-booted SQLite database and diffs. A schema change made in
 * `db.js` or a new migration, without regenerating, fails here — which is the
 * whole reason the schema is generated rather than written. This runs with no
 * PostgreSQL server, so it protects every contributor, not only the ones with
 * one installed.
 *
 * **That it means the same thing.** Given a server, the schema is applied to a
 * real PostgreSQL database and compared to SQLite table by table, column by
 * column, constraint by constraint. Then the parts that were *translated* rather
 * than copied — the case-insensitive indexes and all twenty append-only triggers
 * — are exercised behaviourally, because a trigger that exists and does nothing
 * looks identical to a correct one in any structural comparison, and these
 * particular triggers are what make the audit log and the appeals history
 * tamper-evident.
 *
 *   TEST_POSTGRES_URL=postgres://…/db npm test
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PostgresDatabase } from './db/postgresConnection.js';
import { translatePlaceholders } from './db/sqlPlaceholders.js';
import { POSTGRES_SCHEMA, LATEST_MIGRATION_VERSION, applyPostgresSchema } from './db/postgresSchema.js';
/* The sanctioned writer, not a raw INSERT: `auditLog.test.js` enforces that it
   is the only thing in `server/` that writes this table, and it takes any handle
   exposing `prepare`. Using it here means these tests additionally prove the
   real audit writer works against PostgreSQL. */
import { recordAudit } from './auditLog.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const URL = process.env.TEST_POSTGRES_URL;
const live = Boolean(URL);

/**
 * Its own PostgreSQL schema namespace, not its own database.
 *
 * `db.postgresConnection.test.js` and `capacity.postgresConcurrency.test.js`
 * share this server and vitest runs files in parallel, so creating 65 tables in
 * `public` would collide with whatever they are doing. A namespace plus a
 * `search_path` gives full isolation, and dropping it cascades everything away
 * — including the 20 trigger functions, which a table-by-table teardown would
 * leave behind.
 */
const NAMESPACE = 'wev_schema_parity';

/**
 * The namespace is pinned in the CONNECTION STRING, not with `SET search_path`.
 *
 * `SET` applies to one session, and `PostgresDatabase` is a pool of four. The
 * first version set the path on whichever client happened to serve that call
 * and then created 65 tables in `public` from a different one — which showed up
 * as a duplicate-key error from rows a previous run had left behind, three
 * tests later and nowhere near the cause. `options=-c search_path=…` is sent at
 * connection time, so every client in the pool gets it.
 */
const namespacedUrl = (name) => {
  const u = new global.URL(URL ?? 'postgres://localhost/x');
  u.searchParams.set('options', `-c search_path=${name},public`);
  return u.toString();
};

/** Creates (or resets) a namespace, on a connection that does not use it. */
const resetNamespace = async (name) => {
  const admin = new PostgresDatabase({ connectionString: URL, max: 1, translate: translatePlaceholders });
  await admin.exec(`DROP SCHEMA IF EXISTS ${name} CASCADE; CREATE SCHEMA ${name};`);
  await admin.close();
};

const dropNamespace = async (name) => {
  const admin = new PostgresDatabase({ connectionString: URL, max: 1, translate: translatePlaceholders });
  await admin.exec(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
  await admin.close();
};

describe('the generated schema is current', () => {
  /**
   * Boots a SQLite database and regenerates, so it is slower than the rest of
   * the file. Worth it: this is the assertion that makes "generated, not
   * written" true rather than aspirational.
   */
  it('matches what the SQLite schema generates today', () => {
    let output;
    try {
      output = execFileSync('node', [path.join(ROOT, 'bin', 'generate-postgres-schema.mjs'), '--check'],
        { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      throw new Error(
        'server/db/postgresSchema.js is out of date with the SQLite schema.\n'
        + 'Regenerate it: node bin/generate-postgres-schema.mjs\n\n'
        + (err.stderr || err.stdout || err.message)
      );
    }
    expect(output).toMatch(/is current/);
  }, 60000);

  it('carries the migration version the schema already embodies', () => {
    expect(LATEST_MIGRATION_VERSION, 'a PostgreSQL database must never be told to replay the SQLite migrations')
      .toBeGreaterThanOrEqual(55);
  });

  it('contains no SQLite-only construct', () => {
    for (const [pattern, name] of [
      [/\bAUTOINCREMENT\b/i, 'AUTOINCREMENT'],
      [/COLLATE\s+NOCASE\b/, 'COLLATE NOCASE'],
      [/\bdatetime\s*\(/i, 'datetime()'],
      [/RAISE\s*\(\s*ABORT/i, 'RAISE(ABORT)'],
      [/\bPRAGMA\b/i, 'PRAGMA'],
    ]) {
      expect(POSTGRES_SCHEMA, `${name} survived generation`).not.toMatch(pattern);
    }
  });
});

if (!live) {
  console.warn(
    '[postgres] TEST_POSTGRES_URL is not set — the schema PARITY tests are SKIPPED. '
    + 'They are the only proof that the generated schema means what the SQLite one means.'
  );
}

describe.skipIf(!live)('SQLite and PostgreSQL describe the same database', () => {
  let pg;
  let sqlite;
  let dir;

  beforeAll(async () => {
    if (!live) return;

    dir = mkdtempSync(path.join(tmpdir(), 'wev-parity-'));
    /* The SQLite side is built by the same route the generator uses: boot the
       real `initDatabase()`, so what is compared is what production has rather
       than what the migration files are read to say. */
    const previous = process.env.WEV_DB_PATH;
    process.env.WEV_DB_PATH = path.join(dir, 'parity.db');
    const db = await import('./db.js');
    db.initDatabase();
    await db.completeDatabaseInit();
    if (previous === undefined) delete process.env.WEV_DB_PATH;
    else process.env.WEV_DB_PATH = previous;
    sqlite = new DatabaseSync(path.join(dir, 'parity.db'));

    await resetNamespace(NAMESPACE);
    pg = new PostgresDatabase({
      connectionString: namespacedUrl(NAMESPACE), max: 4, translate: translatePlaceholders,
    });
    await applyPostgresSchema(pg);
  }, 120000);

  afterAll(async () => {
    if (!live) return;
    try { sqlite?.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
    await pg?.close();
    await dropNamespace(NAMESPACE);
  });

  const sqliteTables = () => sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map(r => r.name);

  /* `?` rather than `$1`: every statement goes through `translatePlaceholders`,
     which rewrites SQLite's form into PostgreSQL's numbered one. Writing `$1`
     here would bypass the translator and PostgreSQL would answer "there is no
     parameter $1" — which is exactly what it did when this file first ran. */
  const pgTables = async () => (await pg
    .prepare('SELECT tablename FROM pg_tables WHERE schemaname = ? ORDER BY tablename').all(NAMESPACE))
    .map(r => r.tablename);

  it('has the same tables', async () => {
    const inSqlite = sqliteTables();
    const inPg = await pgTables();

    expect(inSqlite.length, 'the SQLite fixture built no tables — the comparison would be vacuous')
      .toBeGreaterThan(50);
    expect(inPg.filter(t => !inSqlite.includes(t)), 'tables PostgreSQL has and SQLite does not').toEqual([]);
    expect(inSqlite.filter(t => !inPg.includes(t)), 'tables SQLite has and PostgreSQL does not').toEqual([]);
  });

  /**
   * ── The one difference that is real, expected, and in PostgreSQL's favour ──
   *
   * SQLite does not enforce NOT NULL on a `TEXT PRIMARY KEY`. It is a documented
   * legacy quirk — an early version omitted the check and it was kept for
   * compatibility — so `PRAGMA table_info` reports `notnull = 0` for the id
   * column of all 52 tables keyed by a string. PostgreSQL derives NOT NULL from
   * PRIMARY KEY, as the standard requires.
   *
   * Comparing the raw flags therefore reports 52 differences that are not drift.
   * The SQLite side is normalised instead: a primary-key column counts as NOT
   * NULL, which is what the schema means and what the application has always
   * assumed. Verified before normalising that this quirk accounted for **every**
   * nullability difference and there were no others, so nothing real is being
   * hidden — a column that differs for any other reason still fails here.
   *
   * Worth knowing at cutover: PostgreSQL will refuse an `INSERT` with a NULL id
   * that SQLite silently accepted. That is a bug being caught, not a regression,
   * but it is a behaviour change and it belongs in the cutover notes.
   */
  it('has the same columns, in the same order, with the same nullability', async () => {
    const differences = [];

    for (const table of sqliteTables()) {
      const here = sqlite.prepare(`PRAGMA table_info("${table}")`).all()
        .map(c => ({ name: c.name, notNull: Boolean(c.notnull) || c.pk > 0 }));
      const there = (await pg.prepare(
        `SELECT column_name, is_nullable FROM information_schema.columns
          WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position`
      ).all(NAMESPACE, table)).map(c => ({ name: c.column_name, notNull: c.is_nullable === 'NO' }));

      if (JSON.stringify(here) !== JSON.stringify(there)) {
        differences.push({ table, sqlite: here, postgres: there });
      }
    }

    expect(differences, 'these tables differ between the engines').toEqual([]);
  });

  /**
   * Types are compared by *family*, not by name, because the mapping is
   * deliberately not the identity: SQLite's REAL becomes `double precision`
   * (PostgreSQL's `real` is half the width, and this schema stores service
   * hours). What must hold is that a text column stayed text and a numeric one
   * stayed numeric — a REAL that became TEXT would compare and sort wrongly,
   * and no structural check other than this one would notice.
   */
  it('keeps every column in the same type family', async () => {
    const family = (t) => {
      const s = t.toLowerCase();
      if (/int/.test(s)) return 'integer';
      if (/real|double|numeric|decimal|float/.test(s)) return 'number';
      if (/char|text|clob/.test(s)) return 'text';
      if (/blob|bytea/.test(s)) return 'binary';
      return s || 'untyped';
    };
    const drift = [];

    for (const table of sqliteTables()) {
      const there = new Map((await pg.prepare(
        'SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = ? AND table_name = ?'
      ).all(NAMESPACE, table)).map(c => [c.column_name, c.data_type]));

      for (const c of sqlite.prepare(`PRAGMA table_info("${table}")`).all()) {
        const pgType = there.get(c.name);
        /* An untyped SQLite column has no family to preserve; PostgreSQL
           requires one, and the generator leaves it as whatever SQLite printed. */
        if (!c.type) continue;
        if (family(c.type) !== family(pgType ?? '')) {
          drift.push(`${table}.${c.name}: sqlite ${c.type} → postgres ${pgType}`);
        }
      }
    }

    expect(drift, 'a column changed type family across the engines').toEqual([]);
  });

  it('has the same primary keys', async () => {
    const drift = [];
    for (const table of sqliteTables()) {
      const here = sqlite.prepare(`PRAGMA table_info("${table}")`).all()
        .filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => c.name);
      const there = (await pg.prepare(
        `SELECT a.attname FROM pg_index i
           JOIN pg_class c ON c.oid = i.indrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
          WHERE i.indisprimary AND n.nspname = ? AND c.relname = ?`
      ).all(NAMESPACE, table)).map(r => r.attname);

      if (here.sort().join(',') !== there.sort().join(',')) {
        drift.push(`${table}: sqlite [${here}] vs postgres [${there}]`);
      }
    }
    expect(drift, 'a primary key differs between the engines').toEqual([]);
  });

  it('has the same foreign keys', async () => {
    const drift = [];
    for (const table of sqliteTables()) {
      const here = sqlite.prepare(`PRAGMA foreign_key_list("${table}")`).all()
        .map(f => `${f.from}→${f.table}.${f.to ?? 'pk'} ${f.on_delete}`).sort();
      const there = (await pg.prepare(
        `SELECT kcu.column_name AS from_col, ccu.table_name AS to_table,
                ccu.column_name AS to_col, rc.delete_rule
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON kcu.constraint_name = tc.constraint_name AND kcu.constraint_schema = tc.constraint_schema
           JOIN information_schema.constraint_column_usage ccu
             ON ccu.constraint_name = tc.constraint_name AND ccu.constraint_schema = tc.constraint_schema
           JOIN information_schema.referential_constraints rc
             ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.constraint_schema
          WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = ? AND tc.table_name = ?
            /* The schema is pinned on EVERY view, not only on tc. The join
               conditions match on constraint_schema but carry no filter, so the
               planner builds each side across every schema in the database
               before narrowing, and the harness gives each of ~283 test files
               its own namespace, all live at once during a run. That turned
               this query from instant into a fifteen-second timeout, reported
               as SQLite and PostgreSQL disagreeing about foreign keys.
               (No backticks here: this sits inside a template literal.) */
            AND kcu.constraint_schema = ? AND ccu.constraint_schema = ? AND rc.constraint_schema = ?`
      ).all(NAMESPACE, table, NAMESPACE, NAMESPACE, NAMESPACE)).map(f => `${f.from_col}→${f.to_table}.${f.to_col} ${f.delete_rule}`).sort();

      if (here.join(' | ') !== there.join(' | ')) {
        drift.push(`${table}:\n    sqlite   ${here.join(' | ')}\n    postgres ${there.join(' | ')}`);
      }
    }
    expect(drift, 'a foreign key differs — a cascade that does not cascade loses referential integrity')
      .toEqual([]);
  });

  it('has the same unique indexes', async () => {
    /* Unique indexes specifically, rather than all of them: these are
       constraints, and a missing one admits duplicate accounts. Non-unique
       indexes are a performance property, and PostgreSQL additionally creates
       its own for primary keys, so comparing the full set would report
       differences that are not differences. */
    const here = sqlite.prepare(
      "SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND sql LIKE '%UNIQUE%' ORDER BY name"
    ).all().map(r => r.name);
    /* Read from the catalogs rather than the pg_indexes view. That view calls
       pg_get_indexdef() in its select list, so PostgreSQL renders the
       definition of EVERY index in the database before the schemaname filter
       can apply — and the harness has ~283 namespaces live at once, each with
       ~95 indexes. It timed out at fifteen seconds, reported as an index
       disagreement. indisunique is also the precise question; matching UNIQUE
       in rendered DDL text was a proxy for it. */
    const there = (await pg.prepare(
      `SELECT c.relname AS indexname
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ? AND i.indisunique
        ORDER BY c.relname`
    ).all(NAMESPACE)).map(r => r.indexname);

    expect(here.length, 'no unique indexes found — this comparison would be vacuous').toBeGreaterThan(5);
    expect(here.filter(n => !there.includes(n)), 'unique indexes SQLite enforces and PostgreSQL does not')
      .toEqual([]);
  });

  it('has the same triggers, by name', async () => {
    const here = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name")
      .all().map(r => r.name);
    const there = (await pg.prepare(
      `SELECT DISTINCT t.tgname FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE NOT t.tgisinternal AND n.nspname = ? ORDER BY t.tgname`
    ).all(NAMESPACE)).map(r => r.tgname);

    expect(here.length, 'no triggers found — this comparison would be vacuous').toBe(20);
    expect(here.filter(n => !there.includes(n)), 'triggers SQLite enforces and PostgreSQL does not').toEqual([]);
  });
});

/**
 * The translated pieces, exercised rather than inspected.
 *
 * Everything above compares structure, and structure cannot distinguish a
 * trigger that refuses a DELETE from one that exists and returns quietly. These
 * are the guarantees the schema is *for* — an audit log nobody can edit, an
 * appellant's statement nobody can overwrite, two accounts that cannot differ
 * only in capitalisation — so each is provoked and the refusal observed.
 */
describe.skipIf(!live)('the translated guarantees still hold under PostgreSQL', () => {
  let pg;

  beforeAll(async () => {
    if (!live) return;
    await resetNamespace(`${NAMESPACE}_b`);
    pg = new PostgresDatabase({
      connectionString: namespacedUrl(`${NAMESPACE}_b`), max: 4, translate: translatePlaceholders,
    });
    await applyPostgresSchema(pg);
  }, 120000);

  afterAll(async () => {
    if (!live) return;
    await pg?.close();
    await dropNamespace(`${NAMESPACE}_b`);
  });

  const iso = (offsetDays = 0) =>
    new Date(Date.now() + offsetDays * 86400000).toISOString();

  const makeUser = async (id, email) => {
    await pg.prepare(
      `INSERT INTO users (id, name, email, password_hash, grade, role, created_at)
       VALUES (?, ?, ?, 'x', 'N/A', 'student', ?)`
    ).run(id, id, email, iso());
  };

  /**
   * `COLLATE NOCASE` became an ICU collation with `deterministic = false`. If
   * that had been dropped, or created as an ordinary deterministic collation,
   * this insert would succeed — and two accounts would exist for one address.
   */
  it('still refuses an email that differs only in case', async () => {
    await makeUser('u-case-1', 'Case.Test@example.gov');
    await expect(
      makeUser('u-case-2', 'case.test@example.gov'),
      'the nocase collation is not enforcing case-insensitive uniqueness',
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  let recentLogId;

  it('refuses to delete an audit log inside the retention window', async () => {
    await makeUser('u-audit', 'audit@example.gov');
    ({ id: recentLogId } = await recordAudit(pg, {
      adminId: 'u-audit', action: 'SOMETHING_REAL', createdAt: iso(),
    }));

    await expect(
      pg.prepare('DELETE FROM admin_audit_logs WHERE id = ?').run(recentLogId),
      'the append-only trigger did not fire — the audit log is editable',
    ).rejects.toThrow(/append-only/);
  });

  /**
   * The other half of the same trigger, and the half a naive translation loses.
   * Its `WHEN` clause exists so the retention worker CAN delete aged rows; a
   * translation that dropped the condition would make the audit log grow
   * without bound and the retention worker fail every night.
   */
  it('still lets the retention worker delete an aged one', async () => {
    /* A real action, not `RETENTION_FIXTURE`: that one is in the trigger's
       exemption list, so using it would prove the list works and say nothing
       about the date comparison this test is for. */
    const { id } = await recordAudit(pg, {
      adminId: 'u-audit', action: 'SOMETHING_REAL', createdAt: iso(-400),
    });

    await pg.prepare('DELETE FROM admin_audit_logs WHERE id = ?').run(id);
    const left = await pg.prepare('SELECT COUNT(*) AS n FROM admin_audit_logs WHERE id = ?').get(id);
    expect(Number(left.n), 'a row outside the retention window should have been deletable').toBe(0);
  });

  it('refuses to update an audit log at all', async () => {
    await expect(
      pg.prepare('UPDATE admin_audit_logs SET action = ? WHERE id = ?').run('EDITED', recentLogId),
      'an audit record was rewritten',
    ).rejects.toThrow(/append-only/);
  });

  /**
   * The write-once shape, whose `WHEN` clause is
   * `OLD.x IS NOT NULL AND NEW.x IS NOT OLD.x`. SQLite's bare `IS NOT` is
   * null-safe; translated to `<>` instead of `IS DISTINCT FROM` the guard would
   * silently stop firing whenever either side were NULL.
   */
  it('lets an appellant write their statement once, and never again', async () => {
    await makeUser('u-appellant', 'appellant@example.gov');
    await pg.prepare(
      `INSERT INTO appeals (id, user_id, subject, status, reasoning, created_at, updated_at)
       VALUES (?, ?, 'suspension', 'open', 'r', ?, ?)`
    ).run('ap-1', 'u-appellant', iso(), iso());

    /* First write: allowed, because the column is still NULL. */
    await pg.prepare('UPDATE appeals SET statement = ? WHERE id = ?').run('I was not there.', 'ap-1');

    await expect(
      pg.prepare('UPDATE appeals SET statement = ? WHERE id = ?').run('Actually I was.', 'ap-1'),
      'an appellant\'s own words were overwritten',
    ).rejects.toThrow(/statement/i);

    const row = await pg.prepare('SELECT statement FROM appeals WHERE id = ?').get('ap-1');
    expect(row.statement).toBe('I was not there.');
  });

  it('refuses to delete an appeal', async () => {
    await expect(
      pg.prepare('DELETE FROM appeals WHERE id = ?').run('ap-1'),
      'the record of somebody contesting an enforcement action was deletable',
    ).rejects.toThrow(/never deleted/);
  });

  /**
   * The `EXISTS (…)` shape. This one protects referential history: an
   * administrator who has taken logged actions cannot be deleted out from under
   * those logs.
   */
  it('refuses to delete a user who has written audit logs', async () => {
    await expect(
      pg.prepare('DELETE FROM users WHERE id = ?').run('u-audit'),
      'an administrator with audit history was deletable',
    ).rejects.toThrow(/audit/i);
  });

  it('still deletes a user who has not', async () => {
    await makeUser('u-innocent', 'innocent@example.gov');
    await pg.prepare('DELETE FROM users WHERE id = ?').run('u-innocent');
    const left = await pg.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').get('u-innocent');
    expect(Number(left.n), 'the EXISTS guard is refusing every delete, not only the guarded one').toBe(0);
  });
});
