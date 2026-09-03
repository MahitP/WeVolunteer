/**
 * Migration 062, run twice, and the constraints the feature's safety rests on.
 *
 * ── Why running it twice is the first assertion ──
 *
 * Idempotency is the one property every migration here is required to prove, and
 * it is not academic for this one: it mixes `CREATE TABLE IF NOT EXISTS` with
 * guarded `ALTER TABLE ADD COLUMN`, and the latter has no `IF NOT EXISTS` in
 * SQLite. An unguarded second run throws "duplicate column name" and takes the
 * boot down with it.
 *
 * ── Why the indexes are asserted and not assumed ──
 *
 * `idx_org_join_requests_live` is the whole of "no duplicate active requests".
 * It is a partial unique index, and a partial index that quietly lost its
 * `WHERE` clause would stop a student who was declined in September from ever
 * asking again — a behaviour change with no error anywhere. So its predicate is
 * asserted from `sqlite_master`, not merely its existence.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import migration from './migrations/062_organization_membership_policy.js';

const dir = mkdtempSync(path.join(tmpdir(), 'wev-mig062-'));
let db;

/**
 * The pre-062 shape of everything this migration references.
 *
 * Writes through the module-level `db`, which is bound to a throwaway
 * `new DatabaseSync(...)`, rather than taking a handle as a parameter. That is
 * not a style preference: `server/testing/fixtureDebt.js` resolves each
 * `prepare().run()` chain through the scope that binds it and treats a
 * PARAMETER as the application's async proxy, because it cannot prove
 * otherwise — so a `baseline(handle)` shape would add three unawaited chains to
 * the `asyncShapes.test.js` ratchet for fixture SQL that is genuinely
 * synchronous. Using the raw binding directly says what is true.
 */
function baseline() {
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, account_status TEXT DEFAULT 'active'
    );
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE organization_members (
      organization_id TEXT NOT NULL, user_id TEXT NOT NULL,
      member_role TEXT NOT NULL DEFAULT 'member', joined_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, user_id)
    );
  `);
  db.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run('u1', 'Existing Student');
  db.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run('u2', 'Existing Manager');
  db.prepare(`
    INSERT INTO organizations (id, name, slug, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run('org-1', 'Existing Club', 'existing-club', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
}

const columns = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
const tables = () => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
  .all().map(r => r.name);
const indexSql = (name) => db.prepare(
  "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?"
).get(name)?.sql ?? null;

beforeEach(() => {
  db?.close();
  db = new DatabaseSync(path.join(dir, `m-${Math.random().toString(36).slice(2)}.db`));
  baseline();
});

afterAll(() => { db?.close(); rmSync(dir, { recursive: true, force: true }); });

describe('migration 062 — organization membership policy', () => {
  it('declares the shape the registry requires, on both engines', () => {
    expect(migration.version).toBe(62);
    expect(migration.name).toBe('organization_membership_policy');
    expect(migration.fileUrl).toMatch(/^file:\/\//);
    expect(typeof migration.up).toBe('function');
    /* Above POSTGRES_BASELINE_VERSION, so `runPostgresMigrations` refuses to boot
       without this. Asserted here as well, because failing the build is better
       than failing a deployment's boot. */
    expect(typeof migration.postgres?.up).toBe('function');
  });

  it('adds the two policy columns and the two tables', () => {
    migration.up(db);

    expect(columns('organizations')).toContain('join_policy');
    expect(columns('organizations')).toContain('invite_policy');
    expect(tables()).toContain('organization_share_links');
    expect(tables()).toContain('organization_join_requests');
  });

  /**
   * Every existing club keeps behaving exactly as it did.
   *
   * This is the property that makes the migration safe to ship without a
   * coordinated release: a club created before this existed was joinable by
   * anybody, and `'open'` is what says so. A NULL would be a third state that
   * every reader would have to interpret.
   */
  it('leaves every existing organization open, with no NULLs', () => {
    migration.up(db);
    const row = db.prepare(
      'SELECT join_policy AS jp, invite_policy AS ip FROM organizations WHERE id = ?'
    ).get('org-1');
    expect(row).toEqual({ jp: 'open', ip: 'helpers' });

    const nulls = db.prepare(
      'SELECT COUNT(*) AS n FROM organizations WHERE join_policy IS NULL OR invite_policy IS NULL'
    ).get();
    expect(Number(nulls.n)).toBe(0);
  });

  it('runs twice without throwing, and changes nothing the second time', () => {
    migration.up(db);
    const before = db.prepare('SELECT * FROM organizations WHERE id = ?').get('org-1');

    expect(() => migration.up(db)).not.toThrow();

    expect(db.prepare('SELECT * FROM organizations WHERE id = ?').get('org-1')).toEqual(before);
    expect(columns('organizations').filter(c => c === 'join_policy')).toHaveLength(1);
  });

  describe('the invitation link table', () => {
    beforeEach(() => migration.up(db));

    it('holds one link per organization', () => {
      const insert = db.prepare(`
        INSERT INTO organization_share_links (organization_id, token, created_at)
        VALUES (?, ?, ?)
      `);
      insert.run('org-1', 'a'.repeat(64), '2026-09-03T00:00:00.000Z');
      /* The primary key is what makes rotation an UPDATE with no gap in which
         the club has no link at all. */
      expect(() => insert.run('org-1', 'b'.repeat(64), '2026-09-03T00:00:00.000Z')).toThrow();
    });

    it('refuses two organizations sharing a token', () => {
      db.prepare(`
        INSERT INTO organizations (id, name, slug, created_at, updated_at)
        VALUES ('org-2', 'Second Club', 'second-club', '2026-01-01', '2026-01-01')
      `).run();
      const insert = db.prepare(`
        INSERT INTO organization_share_links (organization_id, token, created_at)
        VALUES (?, ?, ?)
      `);
      insert.run('org-1', 'a'.repeat(64), '2026-09-03T00:00:00.000Z');
      expect(() => insert.run('org-2', 'a'.repeat(64), '2026-09-03T00:00:00.000Z')).toThrow();
    });

    it('gives the lookup an index without a separate CREATE INDEX', () => {
      /* `UNIQUE(token)` creates its own index, so resolving a link is one
         indexed equality rather than a scan comparing secrets row by row. */
      const auto = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'organization_share_links'"
      ).all();
      expect(auto.length).toBeGreaterThan(0);
    });

    it('starts the rotation count at zero', () => {
      db.prepare(`
        INSERT INTO organization_share_links (organization_id, token, created_at)
        VALUES (?, ?, ?)
      `).run('org-1', 'a'.repeat(64), '2026-09-03T00:00:00.000Z');
      expect(db.prepare('SELECT rotations FROM organization_share_links').get().rotations).toBe(0);
    });
  });

  describe('the join-requests table', () => {
    beforeEach(() => migration.up(db));

    const file = (id, userId, status = 'pending') => db.prepare(`
      INSERT INTO organization_join_requests (id, organization_id, user_id, status, created_at)
      VALUES (?, 'org-1', ?, ?, '2026-09-03T00:00:00.000Z')
    `).run(id, userId, status);

    it('constrains the status vocabulary at the schema', () => {
      /* A new table, created fresh on both engines, so it DOES get its CHECK —
         unlike the two policy columns, which SQLite cannot constrain by ALTER. */
      expect(() => file('r1', 'u1', 'maybe')).toThrow();
      for (const status of ['pending', 'accepted', 'rejected', 'withdrawn']) {
        expect(() => file(`r-${status}`, 'u1', status)).not.toThrow();
      }
    });

    /**
     * The database's guarantee that there is at most one LIVE request.
     *
     * Not the handler's. Two simultaneous presses of the same button would
     * otherwise produce two rows, after which accepting one leaves the other
     * pending for ever.
     */
    it('permits exactly one pending request per person per organization', () => {
      file('r1', 'u1', 'pending');
      expect(() => file('r2', 'u1', 'pending')).toThrow();
      /* A different person is unaffected. */
      expect(() => file('r3', 'u2', 'pending')).not.toThrow();
    });

    /**
     * And the reason it is PARTIAL: a club's answer is not permanent. A student
     * declined in September may ask again in March, and the history of both
     * survives.
     */
    it('lets a decided request be followed by a new one', () => {
      file('r1', 'u1', 'rejected');
      expect(() => file('r2', 'u1', 'pending')).not.toThrow();
      file('r3', 'u2', 'withdrawn');
      expect(() => file('r4', 'u2', 'pending')).not.toThrow();

      expect(Number(db.prepare('SELECT COUNT(*) AS n FROM organization_join_requests').get().n)).toBe(4);
    });

    it('keeps the WHERE clause on the live index', () => {
      const sql = indexSql('idx_org_join_requests_live');
      expect(sql).toBeTruthy();
      expect(sql).toMatch(/UNIQUE/i);
      expect(sql).toMatch(/organization_id/);
      expect(sql).toMatch(/user_id/);
      /* Without the predicate this becomes "one request ever", which silently
         stops a declined student from asking again. */
      expect(sql).toMatch(/WHERE\s+status\s*=\s*'pending'/i);
    });

    it('indexes the manager queue and the student’s own view', () => {
      expect(indexSql('idx_org_join_requests_queue')).toMatch(/organization_id.*status.*created_at/s);
      expect(indexSql('idx_org_join_requests_user')).toMatch(/user_id.*status/s);
    });
  });

  describe('the PostgreSQL half', () => {
    /**
     * Driven against a recorder rather than a live server, so the shape is
     * checked in every run and not only when TEST_POSTGRES_URL is set.
     * `migrations.postgres.test.js` is where the real engine runs it.
     */
    it('adds the columns with IF NOT EXISTS, and no CHECK on either', async () => {
      const statements = [];
      await migration.postgres.up({ exec: async (sql) => { statements.push(sql); } });
      const sql = statements.join('\n');

      expect(sql).toMatch(/ALTER TABLE organizations\s+ADD COLUMN IF NOT EXISTS join_policy/);
      expect(sql).toMatch(/ALTER TABLE organizations\s+ADD COLUMN IF NOT EXISTS invite_policy/);

      /**
       * Deliberately no CHECK on the two policy columns.
       *
       * SQLite cannot add one without rebuilding `organizations`, and adding it
       * on PostgreSQL alone would leave a migrated database constrained while a
       * fresh one — built from the generated DDL — is not. Two databases
       * claiming to be the same schema and disagreeing about what a column may
       * hold is exactly the drift the generated file exists to prevent.
       */
      const policyDdl = sql.slice(0, sql.indexOf('CREATE TABLE'));
      expect(policyDdl).not.toMatch(/CHECK/i);

      /* The new tables DO carry their CHECK, because they are created fresh on
         both engines from the same vocabulary. */
      expect(sql).toMatch(/CHECK\(status IN \('pending', 'accepted', 'rejected', 'withdrawn'\)\)/);
      expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_org_join_requests_live[\s\S]*WHERE status = 'pending'/);
    });

    it('declares the same defaults as the SQLite half', () => {
      /* The two halves are written separately and must agree about what an
         existing club becomes. A mismatch here is a club that is open on one
         engine and invitation-only on the other. */
      const source = migration.postgres.up.toString();
      expect(source).toMatch(/join_policy\s+text NOT NULL DEFAULT 'open'/);
      expect(source).toMatch(/invite_policy\s+text NOT NULL DEFAULT 'helpers'/);
    });
  });
});
