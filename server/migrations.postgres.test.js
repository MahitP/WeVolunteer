import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgresDatabase } from './db/postgresConnection.js';
import { translatePlaceholders } from './db/sqlPlaceholders.js';
import {
  MIGRATIONS,
  POSTGRES_BASELINE_VERSION,
  POSTGRES_BASELINE_CHECKSUM,
  postgresMigrations,
  runPostgresMigrations,
  seedPostgresBaseline,
  postgresIsFresh,
  checksumFor,
} from './migrations/index.js';

/**
 * PostgreSQL's upgrade path.
 *
 * ── The defect this file exists for ──
 *
 * PostgreSQL had a fresh-install path and no upgrade path at all, and nothing
 * said so. `applyPostgresSchema` runs `postgresSchema.js`, which is generated
 * from a fully-migrated SQLite database — so a NEW database always arrived at
 * the destination correct. Every statement in it is `CREATE TABLE IF NOT
 * EXISTS`, which against a table that already exists is a no-op, so an EXISTING
 * database received nothing: no widened CHECK, no new column, no new index. The
 * boot logged "schema applied" and served traffic either way.
 *
 * It also recorded a change that never happened. The baseline row was written
 * `WHERE NOT EXISTS (… WHERE version = ?)` against the CURRENT latest version,
 * so each release that added a migration inserted another `postgres_baseline`
 * row asserting that migration had been applied. Verified by hand against a
 * database provisioned at the previous schema: after booting the newer code it
 * held two rows named `postgres_baseline` (56 and 57), the five-value category
 * constraint still in force, and no error anywhere.
 *
 * ── Why this needs a live server ──
 *
 * Every claim below is a claim about PostgreSQL: that `ALTER TABLE … DROP
 * CONSTRAINT` removes the constraint the catalogue names, that DDL rolls back
 * with its transaction, that the second boot changes nothing. A mock would
 * assert that the runner calls the functions the runner calls.
 *
 *   TEST_POSTGRES_URL=postgres://…/db npm test
 *
 * ── Why it works in its own schema ──
 *
 * These cases DROP and recreate `events`, because the whole point is to put the
 * table back into the shape a deployment had before the migration and then walk
 * it forward. The PostgreSQL application suite shares one database, so doing
 * that in `public` fights every other file for the same table — and the symptom
 * is a failure in whichever suite happened to be running, not in this one.
 *
 * So the connection is pinned to a private schema via `search_path`, and every
 * unqualified name in these tests and in the migrations they run resolves
 * inside it. Two consequences worth stating: `'events'::regclass` finds the
 * copy in this schema, and the schema is dropped afterwards, so nothing leaks
 * into the next run.
 */
const BASE_URL = process.env.TEST_POSTGRES_URL;
const live = Boolean(BASE_URL);

/** A namespace nothing else uses, named for what it is. */
const SCHEMA = 'wev_migration_tests';

/**
 * The same database, with every unqualified name resolving inside `SCHEMA`.
 *
 * Set through the connection string rather than with a `SET search_path`
 * statement, so it applies to every client the pool opens rather than to
 * whichever one happened to run the SET.
 */
function scopedUrl() {
  const u = new global.URL(BASE_URL);
  u.searchParams.set('options', `-c search_path=${SCHEMA}`);
  return u.toString();
}
if (!live) {
  console.warn(
    '[postgres] TEST_POSTGRES_URL is not set — the PostgreSQL MIGRATION tests are SKIPPED. '
    + 'They are the only cover for the upgrade path of an already-provisioned database.'
  );
}

/* ── Engine-independent guards, which must run whether or not a server is up ── */

describe('the PostgreSQL migration contract', () => {
  /**
   * THE ratchet. Without it the gap reopens the first time somebody adds a
   * migration and tests it on SQLite only — which is what happened, and the
   * symptom was a constraint violation in production on a value the dropdown
   * offered.
   */
  it('gives every migration above the baseline a PostgreSQL implementation', () => {
    const missing = postgresMigrations()
      .filter(m => typeof m.postgres?.up !== 'function')
      .map(m => `${m.version}_${m.name}`);

    expect(
      missing,
      'these migrations run on SQLite and would be skipped on PostgreSQL. '
      + 'Add `postgres: { up: async (db) => … }` to each.',
    ).toEqual([]);
  });

  /**
   * The baseline is a fact about databases already deployed, so deriving it
   * from the registry would make every new migration retroactively "already
   * applied" — the deployed database would be told a change it never received
   * was present.
   */
  it('keeps the baseline below the newest migration, so new work is not swallowed', () => {
    const newest = Math.max(...MIGRATIONS.map(m => m.version));
    expect(POSTGRES_BASELINE_VERSION).toBeLessThan(newest);
  });

  it('treats everything at or below the baseline as SQLite-only', () => {
    for (const m of postgresMigrations()) {
      expect(m.version).toBeGreaterThan(POSTGRES_BASELINE_VERSION);
    }
    const versions = postgresMigrations().map(m => m.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
  });
});

describe.skipIf(!live)('an already-provisioned PostgreSQL database', () => {
  let db;

  /**
   * `events` as a deployment provisioned before migration 057 has it: the
   * five-value CHECK, and a baseline row saying the database is at 56.
   *
   * Written out rather than imported from the old generated file, because the
   * point is the shape a deployed database is IN, and that shape is now history
   * — the generated file has moved on.
   */
  const provisionAtBaseline = async () => {
    await db.exec(`
      DROP TABLE IF EXISTS mig_events CASCADE;
      DROP TABLE IF EXISTS schema_migrations CASCADE;
    `);
    await db.exec(`
      CREATE TABLE schema_migrations (
        version integer PRIMARY KEY, name text NOT NULL,
        applied_at text NOT NULL, checksum text
      );
      INSERT INTO schema_migrations VALUES (56, 'postgres_baseline', now()::text, 'baseline');
    `);
  };

  /** The real `events` table at its pre-057 shape, under its real name. */
  const provisionEvents = async () => {
    await db.exec(`
      DROP TABLE IF EXISTS events CASCADE;
      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        category TEXT CHECK(category IN ('School', '5K', 'Food Pantry', 'Fundraiser', 'Other')) NOT NULL,
        location TEXT NOT NULL,
        application_deadline TEXT NOT NULL,
        organizer_id TEXT NOT NULL,
        status TEXT CHECK(status IN ('open','closed','completed','cancelled')) DEFAULT 'open',
        created_at TEXT NOT NULL
      );
      INSERT INTO events (id,title,description,category,location,application_deadline,organizer_id,created_at)
        VALUES ('e1','Snack Shack','d','Other','Park','2026-09-01','u1','2026-08-01'),
               ('e2','Charity 5K','d','5K','Park','2026-09-01','u1','2026-08-01');
    `);
  };

  /**
   * `users` at the shape a pre-057 deployment has it, as far as the migrations
   * above the baseline care.
   *
   * ── Why this table is here at all ──
   *
   * The fixture used to provision `events` and nothing else, because every
   * post-baseline migration happened to touch only `events`. Migration 060
   * indexes `users`, and the fixture answered `relation "users" does not
   * exist` — a failure of the stand-in, not of the migration: a real deployed
   * database has had `users` since before any of this.
   *
   * Only the columns the post-baseline migrations name, plus the primary key.
   * Restating the whole table would make this fixture a second copy of the
   * schema that drifts, which is the reason the file gives for writing `events`
   * out by hand rather than importing the generated one.
   */
  const provisionUsers = async () => {
    await db.exec(`
      DROP TABLE IF EXISTS users CASCADE;
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL DEFAULT 'student',
        leaderboard_opt_in INTEGER DEFAULT 0
      );
      INSERT INTO users (id, role, leaderboard_opt_in)
        VALUES ('u1', 'organizer', 0), ('u2', 'student', 1);
    `);
  };

  const categoryConstraints = async () => await db.prepare(`
    SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
     WHERE conrelid = 'events'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%category%'
  `).all();

  const recorded = async () => await db.prepare(
    'SELECT version, name, checksum FROM schema_migrations ORDER BY version'
  ).all();

  beforeAll(async () => {
    if (!live) return;
    /* The schema has to exist before a connection can select it, so this one
       connection is opened without the search_path and only creates it. */
    const bootstrap = new PostgresDatabase({
      connectionString: BASE_URL, max: 1, translate: translatePlaceholders,
    });
    await bootstrap.exec(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    await bootstrap.close();

    db = new PostgresDatabase({ connectionString: scopedUrl(), max: 4, translate: translatePlaceholders });
  }, 30000);

  afterAll(async () => {
    if (!live) return;
    await db.close();
    const cleanup = new PostgresDatabase({
      connectionString: BASE_URL, max: 1, translate: translatePlaceholders,
    });
    await cleanup.exec(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await cleanup.close();
  });

  beforeEach(async () => {
    if (!live) return;
    await provisionAtBaseline();
    await provisionEvents();
    await provisionUsers();
  });

  it('starts out refusing a category the widened vocabulary admits', async () => {
    await expect(db.exec(
      "INSERT INTO events (id,title,description,category,location,application_deadline,organizer_id,created_at)"
      + " VALUES ('e3','x','d','Animals','P','2026-09-01','u1','2026-08-01')"
    )).rejects.toThrow();
  });

  it('is not fresh, so the baseline must not be re-seeded over it', async () => {
    expect(await postgresIsFresh(db)).toBe(false);
  });

  /* ── The upgrade itself ── */

  /**
   * Every post-baseline migration, in order, and nothing from below the line.
   * Asserted against the registry rather than against a hand-written list, so
   * the next migration is covered on the day it is added.
   */
  it('applies every post-baseline migration and nothing below the line', async () => {
    const { applied, skipped } = await runPostgresMigrations(db);
    expect(applied).toEqual(postgresMigrations().map(m => `${m.version}_${m.name}`));
    expect(skipped).toEqual([]);
  });

  /** 058: the two columns the close-out lock lives in. */
  it('adds the hours close-out columns', async () => {
    await runPostgresMigrations(db);
    const cols = await db.prepare(
      "SELECT column_name FROM information_schema.columns"
      + " WHERE table_schema = current_schema() AND table_name = 'events'"
      + "   AND column_name LIKE 'hours_closed%'"
      + " ORDER BY column_name"
    ).all();
    expect(cols.map(c => c.column_name)).toEqual(['hours_closed_out_at', 'hours_closed_out_by']);
  });

  /** 060: the leaderboard candidate index, on a database that predates it. */
  it('adds the leaderboard candidate index', async () => {
    await runPostgresMigrations(db);
    const row = await db.prepare(
      "SELECT indexdef FROM pg_indexes"
      + " WHERE schemaname = current_schema() AND indexname = 'idx_users_leaderboard'"
    ).get();

    expect(row?.indexdef).toBeTruthy();
    /* Both columns, in the order the migration argues for. */
    expect(row.indexdef).toMatch(/\(role, leaderboard_opt_in\)/);
  });

  /** Nullable and unset, so every existing event stays correctable. */
  it('leaves existing events un-frozen', async () => {
    await runPostgresMigrations(db);
    const rows = await db.prepare('SELECT hours_closed_out_at FROM events').all();
    expect(rows.every(r => r.hours_closed_out_at === null)).toBe(true);
  });

  it('ends with exactly one category constraint, carrying all sixteen values', async () => {
    await runPostgresMigrations(db);
    const cons = await categoryConstraints();
    expect(cons).toHaveLength(1);
    for (const value of ['School', '5K', 'Food Pantry', 'Fundraiser', 'Other',
      'Tutoring', 'Youth Programs', 'Housing & Shelter', 'Seniors', 'Health',
      'Environment', 'Animals', 'Sports', 'Arts & Culture', 'Donation Drive',
      'Administrative']) {
      expect(cons[0].def, `${value} missing from the constraint`).toContain(value);
    }
  });

  it('accepts a new category afterwards, and still refuses one outside the list', async () => {
    await runPostgresMigrations(db);
    await db.exec(
      "INSERT INTO events (id,title,description,category,location,application_deadline,organizer_id,created_at)"
      + " VALUES ('e3','x','d','Animals','P','2026-09-01','u1','2026-08-01')"
    );
    expect((await db.prepare("SELECT category FROM events WHERE id = 'e3'").get()).category).toBe('Animals');
    await expect(db.exec(
      "INSERT INTO events (id,title,description,category,location,application_deadline,organizer_id,created_at)"
      + " VALUES ('e4','x','d','Ballooning','P','2026-09-01','u1','2026-08-01')"
    )).rejects.toThrow();
  });

  it('keeps every existing row and its category', async () => {
    await runPostgresMigrations(db);
    const rows = await db.prepare('SELECT id, category FROM events ORDER BY id').all();
    expect(rows).toEqual([
      { id: 'e1', category: 'Other' },
      { id: 'e2', category: '5K' },
    ]);
  });

  /** The row must carry the migration's real checksum, not the baseline marker. */
  it('records the migration honestly', async () => {
    await runPostgresMigrations(db);
    const rows = await recorded();
    expect(rows.map(r => Number(r.version)))
      .toEqual([56, ...postgresMigrations().map(m => m.version)]);
    const row57 = rows.find(r => Number(r.version) === 57);
    expect(row57.name).toBe('widen_event_categories');
    expect(row57.checksum).not.toBe(POSTGRES_BASELINE_CHECKSUM);
    expect(row57.checksum).toBe(checksumFor(MIGRATIONS.find(m => m.version === 57)));
  });

  it('is a no-op on the second run', async () => {
    await runPostgresMigrations(db);
    const second = await runPostgresMigrations(db);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(postgresMigrations().map(m => `${m.version}_${m.name}`));
    expect(await categoryConstraints()).toHaveLength(1);
  });

  /**
   * A partial application is the state that cannot be recovered from
   * automatically, so the DDL and its bookkeeping row have to land together.
   * PostgreSQL has transactional DDL, which is what makes this assertable.
   */
  it('rolls the DDL back with its bookkeeping row when a migration throws', async () => {
    const exploding = [{
      version: 9057, name: 'explodes',
      up: () => {},
      postgres: { up: async (tx) => {
        await tx.exec('ALTER TABLE events ADD COLUMN half_applied text');
        throw new Error('boom');
      } },
      fileUrl: import.meta.url,
    }];

    await expect(runPostgresMigrations(db, exploding)).rejects.toThrow(/9057_explodes/);

    const col = await db.prepare(
      "SELECT 1 AS found FROM information_schema.columns"
      + " WHERE table_schema = current_schema() AND table_name = 'events'"
      + "   AND column_name = 'half_applied'"
    ).get();
    expect(col, 'the column survived a rolled-back migration').toBeUndefined();
    expect((await recorded()).map(r => Number(r.version))).toEqual([56]);
  });

  /**
   * Refusing the boot is the whole point: skipping is how the two engines drift
   * into disagreeing about the same table, and the symptom is a production
   * constraint violation on a value development accepts.
   */
  it('refuses to boot on a migration with no PostgreSQL implementation', async () => {
    const sqliteOnly = [{
      version: 9058, name: 'sqlite_only', up: () => {}, fileUrl: import.meta.url,
    }];
    await expect(runPostgresMigrations(db, sqliteOnly))
      .rejects.toThrow(/no PostgreSQL implementation/);
    expect((await recorded()).map(r => Number(r.version))).toEqual([56]);
  });

  /** A hand-edited migration must not be re-run against a database that has it. */
  it('refuses when a recorded migration\'s source has changed underneath it', async () => {
    await runPostgresMigrations(db);
    await db.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = ?')
      .run('not-the-real-hash', 57);
    await expect(runPostgresMigrations(db)).rejects.toThrow(/does not match/);
  });

  /**
   * The SQLite half of 058 is guarded on `PRAGMA table_info`; the PostgreSQL
   * half is `ADD COLUMN IF NOT EXISTS`. Re-running it by hand after a partial
   * repair must converge rather than collide.
   */
  it('can re-run the close-out migration by hand without colliding', async () => {
    await runPostgresMigrations(db);
    const m58 = MIGRATIONS.find(m => m.version === 58);
    await expect(m58.postgres.up(db)).resolves.not.toThrow();
    const cols = await db.prepare(
      "SELECT COUNT(*) AS n FROM information_schema.columns"
      + " WHERE table_schema = current_schema() AND table_name = 'events'"
      + "   AND column_name LIKE 'hours_closed%'"
    ).get();
    expect(Number(cols.n)).toBe(2);
  });
});

describe.skipIf(!live)('a fresh PostgreSQL database', () => {
  let db;
  const freshSchema = `${SCHEMA}_fresh`;

  beforeAll(async () => {
    if (!live) return;
    const bootstrap = new PostgresDatabase({
      connectionString: BASE_URL, max: 1, translate: translatePlaceholders,
    });
    /* Dropped and recreated, so "fresh" means fresh however the last run ended. */
    await bootstrap.exec(`DROP SCHEMA IF EXISTS ${freshSchema} CASCADE`);
    await bootstrap.exec(`CREATE SCHEMA ${freshSchema}`);
    await bootstrap.close();

    const u = new global.URL(BASE_URL);
    u.searchParams.set('options', `-c search_path=${freshSchema}`);
    db = new PostgresDatabase({ connectionString: u.toString(), max: 4, translate: translatePlaceholders });
  }, 30000);

  afterAll(async () => {
    if (!live) return;
    await db.close();
    const cleanup = new PostgresDatabase({
      connectionString: BASE_URL, max: 1, translate: translatePlaceholders,
    });
    await cleanup.exec(`DROP SCHEMA IF EXISTS ${freshSchema} CASCADE`);
    await cleanup.close();
  });

  it('reports itself fresh before anything is recorded', async () => {
    expect(await postgresIsFresh(db)).toBe(true);
  });

  /**
   * Every version, not just the highest. One row at the latest version is
   * enough to say how far along the database is and not enough to drive the
   * runner: add migration 58 and a database created at 57 has no row for 58, so
   * 58 becomes outstanding — and its `postgres.up` would run against DDL that
   * already contains 58's change, because the schema is regenerated with it.
   */
  it('records every registry version as supplied by the generated schema', async () => {
    await seedPostgresBaseline(db);
    const rows = await db.prepare('SELECT version, checksum FROM schema_migrations').all();
    expect(rows).toHaveLength(MIGRATIONS.length);
    expect(rows.every(r => r.checksum === POSTGRES_BASELINE_CHECKSUM)).toBe(true);
  });

  it('leaves nothing outstanding, so no migration re-applies a change the DDL made', async () => {
    await seedPostgresBaseline(db);
    const out = await runPostgresMigrations(db);
    expect(out.applied).toEqual([]);
  });

  /**
   * A baseline row records that the DDL already said so — no code ran, so there
   * is nothing to hash. Verifying it would fail every boot on a value that
   * could never match.
   */
  it('does not check a baseline row against a source checksum', async () => {
    await seedPostgresBaseline(db);
    await expect(runPostgresMigrations(db)).resolves.toBeTruthy();
  });
});
