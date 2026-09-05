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

  /**
   * `organizations` at the shape a pre-057 deployment has it, as far as the
   * migrations above the baseline care.
   *
   * ── Why this table is here at all ──
   *
   * The same reason `users` is, one migration later. The fixture provisioned
   * `events` alone, because every post-baseline migration happened to touch only
   * that; 060 indexed `users` and answered `relation "users" does not exist`, and
   * 062 adds two columns to `organizations` and answered the same thing about it.
   * Both were failures of the STAND-IN, not of the migration: a real deployed
   * database has had `organizations` since migration 031, and 040 gave it the
   * identity columns.
   *
   * Only the columns the post-baseline migrations name, plus the primary key and
   * the two NOT NULLs an insert here needs. Restating the whole table would make
   * this fixture a second copy of the schema that drifts, which is the reason the
   * file gives for writing `events` out by hand rather than importing the
   * generated one.
   */
  const provisionOrganizations = async () => {
    await db.exec(`
      DROP TABLE IF EXISTS organizations CASCADE;
      CREATE TABLE organizations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO organizations (id, name, slug, created_at, updated_at)
        VALUES ('org1', 'Chess Club', 'chess-club', '2026-08-01', '2026-08-01');
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
    await provisionOrganizations();
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

  /** 062: the membership policy, on a database that predates it. */
  it('adds the organization membership policy columns, defaulted', async () => {
    await runPostgresMigrations(db);

    const cols = await db.prepare(
      "SELECT column_name, is_nullable, column_default FROM information_schema.columns"
      + " WHERE table_schema = current_schema() AND table_name = 'organizations'"
      + "   AND column_name IN ('join_policy', 'invite_policy')"
      + " ORDER BY column_name"
    ).all();
    expect(cols.map(c => c.column_name)).toEqual(['invite_policy', 'join_policy']);
    expect(cols.every(c => c.is_nullable === 'NO')).toBe(true);

    /**
     * And the club that was already there is `open`.
     *
     * This is the property that makes the migration safe to ship without a
     * coordinated release: an organization created before any of this existed
     * was joinable by anybody, and `'open'` is what says so. Asserted on the
     * ROW rather than on the default, because a default that existing rows did
     * not receive would be exactly as broken and would look identical in the
     * catalogue.
     */
    const row = await db.prepare(
      "SELECT join_policy AS jp, invite_policy AS ip FROM organizations WHERE id = 'org1'"
    ).get();
    expect(row).toEqual({ jp: 'open', ip: 'helpers' });
  });

  it('adds the invitation-link and join-request tables with their constraints', async () => {
    await runPostgresMigrations(db);

    const tables = (await db.prepare(
      "SELECT table_name FROM information_schema.tables"
      + " WHERE table_schema = current_schema()"
      + "   AND table_name IN ('organization_share_links', 'organization_join_requests')"
      + " ORDER BY table_name"
    ).all()).map(t => t.table_name);
    expect(tables).toEqual(['organization_join_requests', 'organization_share_links']);

    /**
     * The partial unique index IS the "no duplicate active requests" rule, so it
     * is asserted with its predicate rather than by name alone. An index that
     * lost the `WHERE` would silently stop a declined student from ever asking
     * again — a behaviour change with no error anywhere.
     */
    const live = await db.prepare(
      "SELECT indexdef FROM pg_indexes"
      + " WHERE schemaname = current_schema() AND indexname = 'idx_org_join_requests_live'"
    ).get();
    expect(live?.indexdef).toBeTruthy();
    expect(live.indexdef).toMatch(/UNIQUE/i);
    expect(live.indexdef).toMatch(/WHERE \(status = 'pending'/);

    /* And the database really refuses the second one. */
    const file = async (id, user) => await db.prepare(
      "INSERT INTO organization_join_requests (id, organization_id, user_id, status, created_at)"
      + " VALUES (?, 'org1', ?, 'pending', '2026-09-03')"
    ).run(id, user);
    await file('r1', 'u2');
    await expect(file('r2', 'u2')).rejects.toThrow();
    /* A different person is unaffected, and a decided request does not block a
       later one. */
    await expect(file('r3', 'u1')).resolves.toBeTruthy();
    await db.prepare("UPDATE organization_join_requests SET status = 'rejected' WHERE id = 'r1'").run();
    await expect(file('r4', 'u2')).resolves.toBeTruthy();
  });

  /**
   * 063: the same table, after its primary key moved off `organization_id`.
   *
   * This assertion used to be the opposite — one row per organization, which
   * WAS the constraint 062 shipped. 063 removes it deliberately, so this now
   * proves the removal reached PostgreSQL: a `DO $$ … $$` block probing
   * `pg_index` has to find the old constraint and drop it, and a block that
   * silently matched nothing would leave PostgreSQL enforcing a rule SQLite no
   * longer does — the exact kind of engine drift the parity tests exist for.
   */
  it('lets one organization hold several invitation links, each with a unique token', async () => {
    await runPostgresMigrations(db);

    const mint = async (id, org, token) => await db.prepare(
      'INSERT INTO organization_share_links (id, organization_id, token, label, created_at, uses)'
      + " VALUES (?, ?, ?, 'General', ?, 0)"
    ).run(id, org, token, '2026-09-03');

    await mint('l1', 'org1', 'a'.repeat(64));
    /* Several links per club, which is what makes retiring the autumn flyer
       possible without breaking the Instagram bio. */
    await expect(mint('l2', 'org1', 'b'.repeat(64))).resolves.toBeTruthy();

    await db.prepare(
      "INSERT INTO organizations (id, name, slug, created_at, updated_at)"
      + " VALUES ('org2', 'Robotics', 'robotics', '2026-08-01', '2026-08-01')"
    ).run();
    /* And still no two links anywhere sharing a token — a token is resolved by
       itself, so a duplicate would make "which club does this open" ambiguous. */
    await expect(mint('l3', 'org2', 'a'.repeat(64))).rejects.toThrow();

    /* The primary key really is `id` now, not `organization_id`. */
    const pk = await db.prepare(
      "SELECT a.attname FROM pg_index i"
      + " JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)"
      + " WHERE i.indrelid = 'organization_share_links'::regclass AND i.indisprimary"
    ).all();
    expect(pk.map(r => r.attname)).toEqual(['id']);

    /* And the column 062 counted rotations in is gone, since a rotation is now
       a new row rather than an increment. */
    const rotations = await db.prepare(
      "SELECT column_name FROM information_schema.columns"
      + " WHERE table_schema = current_schema() AND table_name = 'organization_share_links'"
      + "   AND column_name = 'rotations'"
    ).get();
    expect(rotations).toBeFalsy();
  });

  it('adds the link columns the multi-link model needs', async () => {
    await runPostgresMigrations(db);

    const cols = (await db.prepare(
      "SELECT column_name FROM information_schema.columns"
      + " WHERE table_schema = current_schema() AND table_name = 'organization_share_links'"
      + " ORDER BY column_name"
    ).all()).map(c => c.column_name);

    expect(cols).toEqual([
      'created_at', 'created_by', 'expires_at', 'id', 'label',
      'last_used_at', 'organization_id', 'revoked_at', 'token', 'uses',
    ]);
  });

  /**
   * 063: visibility, and the direction it fails.
   *
   * The backfill is the privacy decision, and it is the one that would be
   * quietest to get wrong: a DEFAULT of 'public' would publish every school
   * club on the platform at boot, with no error and no notice to anybody.
   * Asserted on the ROW rather than on the catalogue default, because a default
   * that existing rows did not receive would look identical in the catalogue.
   */
  it('leaves every organization that predates the setting unlisted', async () => {
    await runPostgresMigrations(db);

    const col = await db.prepare(
      "SELECT is_nullable, column_default FROM information_schema.columns"
      + " WHERE table_schema = current_schema() AND table_name = 'organizations'"
      + "   AND column_name = 'visibility'"
    ).get();
    expect(col?.is_nullable).toBe('NO');

    const row = await db.prepare("SELECT visibility AS v FROM organizations WHERE id = 'org1'").get();
    expect(row.v).toBe('unlisted');

    const published = await db.prepare(
      "SELECT COUNT(*)::int AS n FROM organizations WHERE visibility = 'public'"
    ).get();
    expect(Number(published.n)).toBe(0);
  });

  it('adds the nullable note to a join request', async () => {
    await runPostgresMigrations(db);
    const col = await db.prepare(
      "SELECT is_nullable FROM information_schema.columns"
      + " WHERE table_schema = current_schema()"
      + "   AND table_name = 'organization_join_requests' AND column_name = 'message'"
    ).get();
    /* Nullable, so every request filed before the column existed stays valid
       and its absence of a note is a fact rather than an empty string. */
    expect(col?.is_nullable).toBe('YES');
  });

  /**
   * 063: the invitations table, and the credential it deliberately has none of.
   *
   * An invitation names `invited_user_id`, and the only thing that can accept it
   * is a session belonging to that user. Asserted as an ABSENCE, because that is
   * the shape of the decision: a token column would be a redundant secret that
   * can leak, be logged, or be read off a screen.
   */
  it('adds the invitations table with no token and no email column', async () => {
    await runPostgresMigrations(db);

    const cols = (await db.prepare(
      "SELECT column_name FROM information_schema.columns"
      + " WHERE table_schema = current_schema() AND table_name = 'organization_invitations'"
      + " ORDER BY column_name"
    ).all()).map(c => c.column_name);

    expect(cols).toEqual([
      'created_at', 'expires_at', 'id', 'invited_by', 'invited_user_id',
      'message', 'organization_id', 'resolved_at', 'status',
    ]);
    expect(cols).not.toContain('token');
    expect(cols).not.toContain('token_hash');
    expect(cols).not.toContain('email');
  });

  it('holds one pending invitation per person per organization', async () => {
    await runPostgresMigrations(db);

    const live = await db.prepare(
      "SELECT indexdef FROM pg_indexes"
      + " WHERE schemaname = current_schema() AND indexname = 'idx_org_invitations_live'"
    ).get();
    expect(live?.indexdef).toBeTruthy();
    expect(live.indexdef).toMatch(/UNIQUE/i);
    /* The predicate, asserted rather than assumed: an index that lost its WHERE
       would stop a club from ever re-inviting anybody after a withdrawal. */
    expect(live.indexdef).toMatch(/WHERE \(status = 'pending'/);

    const invite = async (id, user, status = 'pending') => await db.prepare(
      'INSERT INTO organization_invitations'
      + " (id, organization_id, invited_user_id, status, created_at)"
      + " VALUES (?, 'org1', ?, ?, '2026-09-03')"
    ).run(id, user, status);

    await invite('i1', 'u2');
    await expect(invite('i2', 'u2')).rejects.toThrow();
    /* A different person is unaffected, and a resolved one does not block a
       later invitation. */
    await expect(invite('i3', 'u1')).resolves.toBeTruthy();
    await db.prepare("UPDATE organization_invitations SET status = 'revoked' WHERE id = 'i1'").run();
    await expect(invite('i4', 'u2')).resolves.toBeTruthy();
  });

  it('refuses an invitation status outside the vocabulary', async () => {
    await runPostgresMigrations(db);

    /* Through an awaited helper rather than `expect(db.prepare(…).run())`
       directly. `fixtureDebt.js` reads an un-awaited `prepare()` chain as
       PostgreSQL debt and cannot see that `expect(…).rejects` awaits it — and
       the helper shape is what the rest of this file already uses. */
    const insert = async () => await db.prepare(
      'INSERT INTO organization_invitations'
      + " (id, organization_id, invited_user_id, status, created_at)"
      + " VALUES ('i9', 'org1', 'u2', 'maybe', '2026-09-03')"
    ).run();

    await expect(insert()).rejects.toThrow();
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

    /* Every version EXCEPT the `postgresOnly` ones, which are not in the
       generated schema and therefore actually ran — see below. */
    const onlyPg = new Set(MIGRATIONS.filter(m => m.postgresOnly).map(m => m.version));
    expect(rows.filter(r => !onlyPg.has(Number(r.version)))
      .every(r => r.checksum === POSTGRES_BASELINE_CHECKSUM)).toBe(true);
  });

  /**
   * The exception the baseline seeder has to make, and the reason it exists.
   *
   * `postgresSchema.js` is generated from a booted SQLite database, so it
   * contains everything SQLite can express and nothing it cannot. A migration
   * whose whole content is a PostgreSQL index — 064's trigram indexes — is
   * therefore absent from the generated schema, and recording it as
   * already-supplied would mean a fresh deployment never got it. Silently: the
   * tables would all be there, the tests would all pass, and the search box
   * would be correct and linear.
   */
  it('RUNS a postgres-only migration rather than recording it as already there', async () => {
    const onlyPg = MIGRATIONS.filter(m => m.postgresOnly);
    expect(onlyPg.length, 'this test is meaningless with no postgres-only migrations').toBeGreaterThan(0);

    await seedPostgresBaseline(db);
    const rows = await db.prepare('SELECT version, checksum FROM schema_migrations').all();
    for (const m of onlyPg) {
      const row = rows.find(r => Number(r.version) === m.version);
      expect(row, `migration ${m.version} was not recorded`).toBeTruthy();
      expect(row.checksum, 'code ran, so drift in it is worth catching').toBe(checksumFor(m));
    }
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

/**
 * A database provisioned exactly the way a new deployment is.
 *
 * Its own schema and its own connection, because the block above deliberately
 * seeds bookkeeping into an EMPTY schema — which records the postgres-only
 * migration before there is an `events` table for it to index, and is not the
 * order `applyPostgresSchema` uses. The order is the thing being tested: DDL
 * first, then the baseline, so a postgres-only migration finds its tables.
 */
describe.skipIf(!live)('a PostgreSQL database provisioned from the generated schema', () => {
  let db;
  const provisionedSchema = `${SCHEMA}_provisioned`;

  beforeAll(async () => {
    if (!live) return;
    const bootstrap = new PostgresDatabase({
      connectionString: BASE_URL, max: 1, translate: translatePlaceholders,
    });
    await bootstrap.exec(`DROP SCHEMA IF EXISTS ${provisionedSchema} CASCADE`);
    await bootstrap.exec(`CREATE SCHEMA ${provisionedSchema}`);
    await bootstrap.close();

    const u = new global.URL(BASE_URL);
    u.searchParams.set('options', `-c search_path=${provisionedSchema}`);
    db = new PostgresDatabase({ connectionString: u.toString(), max: 4, translate: translatePlaceholders });

    const { applyPostgresSchema } = await import('./db/postgresSchema.js');
    await applyPostgresSchema(db);
  }, 120000);

  afterAll(async () => {
    if (!live) return;
    await db?.close();
    const cleanup = new PostgresDatabase({
      connectionString: BASE_URL, max: 1, translate: translatePlaceholders,
    });
    await cleanup.exec(`DROP SCHEMA IF EXISTS ${provisionedSchema} CASCADE`);
    await cleanup.close();
  });

  it('has the trigram indexes the search box needs', async () => {
    const { TRIGRAM_INDEXES } = await import('./migrations/067_search_trigram_indexes.js');

    const [{ schema: trgmSchema } = {}] = await db.prepare(`
      SELECT n.nspname AS schema FROM pg_extension e
        JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_trgm'
    `).all();

    /* The migration is allowed to decline when the role cannot install the
       extension, so the assertion is conditional on the thing it depends on —
       and states which case it took, rather than passing quietly either way. */
    if (!trgmSchema) {
      expect(trgmSchema, 'pg_trgm could not be installed by this role; indexes correctly skipped')
        .toBeUndefined();
      return;
    }

    const present = new Set((await db.prepare(`
      SELECT c.relname AS name FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = ? AND c.relkind = 'i'
    `).all(provisionedSchema)).map(r => r.name));

    for (const [name] of TRIGRAM_INDEXES) expect(present, `${name} is missing`).toContain(name);
  }, 60000);
});

/**
 * Upgrading a deployment that was provisioned at an OLDER schema version.
 *
 * ── The failure this reproduces ──
 *
 * `applyPostgresSchema` used to run the generated DDL first and the migrations
 * second. The DDL is generated from a fully-migrated SQLite database, so it
 * describes the finished shape — including `CREATE INDEX IF NOT EXISTS
 * idx_events_first_slot_start ON events(status, first_slot_start, id)`.
 *
 * On a database provisioned before migration 66, `CREATE TABLE IF NOT EXISTS
 * events` is a no-op that does NOT add the column, and the index two lines
 * later fails with `column "first_slot_start" does not exist`. The boot dies
 * there — for every existing deployment, on every release that adds a column
 * and an index over it.
 *
 * Found on the real Supabase database, which another checkout had provisioned
 * at migration 61 while this branch stood at 64.
 *
 * ── Why the state is built by REMOVING rather than by checking out an old tree ──
 *
 * The test needs a database in the shape an older release left behind. Applying
 * the current schema and then undoing migrations 65-67 produces exactly that
 * shape and needs no second checkout, and each undo is written against what the
 * migration adds, so a new migration that adds a column and an index over it
 * belongs in the list below.
 */
describe.skipIf(!live)('upgrading a database provisioned at an older version', () => {
  let db;
  const oldSchema = `${SCHEMA}_upgrade`;

  beforeAll(async () => {
    if (!live) return;
    const bootstrap = new PostgresDatabase({
      connectionString: BASE_URL, max: 1, translate: translatePlaceholders,
    });
    await bootstrap.exec(`DROP SCHEMA IF EXISTS ${oldSchema} CASCADE`);
    await bootstrap.exec(`CREATE SCHEMA ${oldSchema}`);
    await bootstrap.close();

    const u = new global.URL(BASE_URL);
    u.searchParams.set('options', `-c search_path=${oldSchema}`);
    db = new PostgresDatabase({ connectionString: u.toString(), max: 4, translate: translatePlaceholders });

    const { applyPostgresSchema } = await import('./db/postgresSchema.js');
    await applyPostgresSchema(db);

    /* Now wind it back to what a deployment at migration 61 looks like. */
    await db.exec('DROP TABLE IF EXISTS scheduler_leases CASCADE');            // 65
    await db.exec('DROP INDEX IF EXISTS idx_events_first_slot_start');         // 66
    await db.exec('DROP INDEX IF EXISTS idx_events_browse_order');             // 66
    await db.exec('ALTER TABLE events DROP COLUMN IF EXISTS first_slot_start'); // 66
    for (const name of ['idx_events_title_trgm', 'idx_events_description_trgm',
      'idx_events_location_trgm', 'idx_users_name_trgm']) {                    // 67
      await db.exec(`DROP INDEX IF EXISTS ${name}`);
    }
    await db.prepare('DELETE FROM schema_migrations WHERE version > 64').run();
  }, 180000);

  afterAll(async () => {
    if (!live) return;
    await db?.close();
    const cleanup = new PostgresDatabase({
      connectionString: BASE_URL, max: 1, translate: translatePlaceholders,
    });
    await cleanup.exec(`DROP SCHEMA IF EXISTS ${oldSchema} CASCADE`);
    await cleanup.close();
  });

  it('starts from a database that genuinely lacks the later changes', async () => {
    const [at] = await db.prepare('SELECT MAX(version) AS v FROM schema_migrations').all();
    expect(Number(at.v)).toBe(64);

    const [col] = await db.prepare(`
      SELECT COUNT(*)::int AS n FROM pg_attribute
       WHERE attrelid = to_regclass('events') AND attname = 'first_slot_start' AND NOT attisdropped
    `).all();
    expect(col.n, 'the fixture did not actually remove the column').toBe(0);
  });

  it('applies the outstanding migrations instead of failing on an index', async () => {
    const { applyPostgresSchema } = await import('./db/postgresSchema.js');

    /* The assertion IS that this resolves. Before the fix it rejected with
       `column "first_slot_start" does not exist`. */
    await expect(applyPostgresSchema(db)).resolves.toBeUndefined();
  }, 180000);

  it('ends with the column, the table and every index the newer version needs', async () => {
    const [col] = await db.prepare(`
      SELECT COUNT(*)::int AS n FROM pg_attribute
       WHERE attrelid = to_regclass('events') AND attname = 'first_slot_start' AND NOT attisdropped
    `).all();
    expect(col.n, 'migration 66 did not add its column').toBe(1);

    const leases = await db.prepare("SELECT to_regclass('scheduler_leases') AS t").get();
    expect(leases.t, 'migration 65 did not create its table').toBeTruthy();

    const present = new Set((await db.prepare(`
      SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = ? AND c.relkind = 'i'
    `).all(oldSchema)).map((r) => r.name));

    for (const name of ['idx_events_first_slot_start', 'idx_events_browse_order']) {
      expect(present, `${name} is missing after the upgrade`).toContain(name);
    }
  });

  it('records the migrations it actually ran, with their real checksums', async () => {
    const rows = await db.prepare(
      'SELECT version, checksum FROM schema_migrations WHERE version > 64 ORDER BY version'
    ).all();
    expect(rows.map((r) => Number(r.version))).toEqual([65, 66, 67]);
    for (const row of rows) {
      expect(row.checksum, 'a migration that RAN must not be recorded as baseline')
        .not.toBe(POSTGRES_BASELINE_CHECKSUM);
    }
  });

  it('is idempotent — a second boot changes nothing', async () => {
    const { applyPostgresSchema } = await import('./db/postgresSchema.js');
    const before = await db.prepare('SELECT COUNT(*)::int AS n, MAX(version) AS v FROM schema_migrations').get();
    await applyPostgresSchema(db);
    const after = await db.prepare('SELECT COUNT(*)::int AS n, MAX(version) AS v FROM schema_migrations').get();
    expect(after).toEqual(before);
  }, 180000);
});
