/**
 * Migration 063, run twice, and the data it is trusted not to lose.
 *
 * ── Why the rebuild is the subject of most of this file ──
 *
 * 062 gave `organization_share_links` a primary key on `organization_id`, which
 * is exactly the constraint "a club has one link". 063 has to remove it, and
 * SQLite cannot drop a primary key — so the table is rebuilt: create the new
 * shape, copy, drop, rename.
 *
 * That is the one destructive shape in this feature. A rebuild that silently
 * dropped a row would take a club's live invitation link with it, and the
 * symptom would be indistinguishable from somebody having revoked it — no
 * error, no log, a flyer that stopped working. So the copy is asserted row by
 * row and value by value, including the tokens, because a token that changed is
 * a link that broke.
 *
 * ── Why every existing row is labelled "General" ──
 *
 * Requirement: existing share links keep working unless explicitly revoked. A
 * label is NOT NULL, so the copy has to supply one, and "General" is the same
 * word `createShareLink` defaults to — so a club that never thinks about names
 * sees one consistent word rather than a blank beside its oldest link.
 *
 * ── Why `visibility` backfills to `unlisted` and new rows default to `public` ──
 *
 * The asymmetry is the privacy argument, and it is deliberate. Every club that
 * already existed was created when the page required a session, and nobody
 * running one agreed to publish it. A club created today is created in a product
 * that offers a public page, by somebody looking at the setting.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import migration062 from './migrations/062_organization_membership_policy.js';
import migration from './migrations/063_organization_public_identity.js';

const dir = mkdtempSync(path.join(tmpdir(), 'wev-mig063-'));
let db;

/**
 * The post-062 shape, which is what 063 actually meets in the wild.
 *
 * Built by RUNNING 062 rather than by restating its DDL, so the two cannot
 * drift: if 062 changes, this baseline changes with it, and a rebuild written
 * against a shape that no longer exists fails here rather than in production.
 *
 * Writes through the module-level `db` binding rather than a parameter, for the
 * reason the 062 test explains at length: `fixtureDebt.js` treats a parameter
 * as the application's async proxy and would count these synchronous fixture
 * chains against the `asyncShapes.test.js` ratchet.
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
  for (const [id, name, slug] of [
    ['org-1', 'Existing Club', 'existing-club'],
    ['org-2', 'Second Club', 'second-club'],
    ['org-3', 'Linkless Club', 'linkless-club'],
  ]) {
    db.prepare(`
      INSERT INTO organizations (id, name, slug, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, name, slug, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  }
  migration062.up(db);
}

/** Two clubs with links in circulation, and one without. */
function seedLinks() {
  for (const [orgId, token] of [['org-1', 'a'.repeat(64)], ['org-2', 'b'.repeat(64)]]) {
    db.prepare(`
      INSERT INTO organization_share_links
        (organization_id, token, created_at, created_by, rotations)
      VALUES (?, ?, ?, ?, ?)
    `).run(orgId, token, '2026-02-01T00:00:00.000Z', 'u2', 3);
  }
}

const columns = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
const tables = () => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
  .all().map(r => r.name);
const indexSql = (name) => db.prepare(
  "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?"
).get(name)?.sql ?? null;
const tableSql = (name) => db.prepare(
  "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?"
).get(name)?.sql ?? null;

beforeEach(() => {
  db?.close();
  db = new DatabaseSync(path.join(dir, `m-${Math.random().toString(36).slice(2)}.db`));
  baseline();
});

afterAll(() => { db?.close(); rmSync(dir, { recursive: true, force: true }); });

describe('migration 063 — organization public identity', () => {
  it('declares the shape the registry requires, on both engines', () => {
    expect(migration.version).toBe(63);
    expect(migration.name).toBe('organization_public_identity');
    expect(migration.fileUrl).toMatch(/^file:\/\//);
    expect(typeof migration.up).toBe('function');
    /* Above POSTGRES_BASELINE_VERSION, so `runPostgresMigrations` refuses to
       boot without this. Asserted here too, because failing the build beats
       failing a deployment's boot. */
    expect(typeof migration.postgres?.up).toBe('function');
  });

  it('runs twice without complaining', () => {
    seedLinks();
    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();

    /* And the second run is a no-op rather than a second rebuild: the rows are
       still there, once each. */
    const rows = db.prepare('SELECT organization_id AS o FROM organization_share_links ORDER BY o').all();
    expect(rows.map(r => r.o)).toEqual(['org-1', 'org-2']);
  });
});

describe('the share-link rebuild', () => {
  it('gives the table an id of its own and drops the one-link constraint', () => {
    migration.up(db);

    expect(columns('organization_share_links')).toEqual([
      'id', 'organization_id', 'token', 'label', 'created_at', 'created_by',
      'expires_at', 'revoked_at', 'uses', 'last_used_at',
    ]);
    /* The primary key moved. `organization_id` carrying it was the whole of "a
       club has one link", so this assertion is the feature. */
    expect(tableSql('organization_share_links')).toMatch(/\bid\s+TEXT PRIMARY KEY/);
    expect(tableSql('organization_share_links')).not.toMatch(/organization_id\s+TEXT PRIMARY KEY/);
  });

  it('lets one club hold several links', () => {
    migration.up(db);
    const insert = db.prepare(`
      INSERT INTO organization_share_links
        (id, organization_id, token, label, created_at, uses)
      VALUES (?, 'org-1', ?, ?, '2026-03-01T00:00:00.000Z', 0)
    `);
    insert.run('l1', 'c'.repeat(64), 'Flyer');
    expect(() => insert.run('l2', 'd'.repeat(64), 'Instagram')).not.toThrow();
  });

  it('still refuses two links with the same token', () => {
    migration.up(db);
    const insert = db.prepare(`
      INSERT INTO organization_share_links
        (id, organization_id, token, label, created_at, uses)
      VALUES (?, ?, ?, 'General', '2026-03-01T00:00:00.000Z', 0)
    `);
    insert.run('l1', 'org-1', 'e'.repeat(64));
    /* Across clubs, not merely within one — a token is resolved by itself, so a
       duplicate would make "which club does this open" ambiguous. */
    expect(() => insert.run('l2', 'org-2', 'e'.repeat(64))).toThrow(/UNIQUE/i);
  });

  /**
   * The assertion this whole file exists for.
   *
   * A rebuild that dropped a club's live link would be indistinguishable from
   * somebody having revoked it.
   */
  it('carries every existing link across, token for token', () => {
    seedLinks();
    const before = db.prepare(
      'SELECT organization_id AS o, token, created_at AS c, created_by AS b FROM organization_share_links ORDER BY o'
    ).all();
    expect(before).toHaveLength(2);

    migration.up(db);

    const after = db.prepare(`
      SELECT organization_id AS o, token, created_at AS c, created_by AS b, label,
             expires_at AS e, revoked_at AS r, uses, last_used_at AS l
        FROM organization_share_links ORDER BY o
    `).all();
    expect(after).toHaveLength(2);

    for (const [i, row] of after.entries()) {
      expect(row.o).toBe(before[i].o);
      /* The token is the link. A changed token is a broken flyer. */
      expect(row.token).toBe(before[i].token);
      expect(row.c).toBe(before[i].c);
      expect(row.b).toBe(before[i].b);
      /* And every new column reads as "a link nobody has touched", which is
         what these rows are. */
      expect(row.label).toBe('General');
      expect(row.e).toBeNull();
      expect(row.r).toBeNull();
      expect(row.uses).toBe(0);
      expect(row.l).toBeNull();
    }
  });

  it('gives each carried link a distinct id', () => {
    seedLinks();
    migration.up(db);
    const ids = db.prepare('SELECT id FROM organization_share_links').all().map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every(id => typeof id === 'string' && id.length > 0)).toBe(true);
  });

  it('is harmless on a database where no club ever made a link', () => {
    migration.up(db);
    expect(db.prepare('SELECT COUNT(*) AS n FROM organization_share_links').get().n).toBe(0);
    expect(columns('organization_share_links')).toContain('label');
  });

  it('leaves the foreign keys intact afterwards', () => {
    seedLinks();
    migration.up(db);
    /* The check ENGINEERING_GUIDE §8.3 requires after a rebuild: a table
       recreated with a mistyped reference passes every row-count assertion and
       fails here. */
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('indexes the lookup the list endpoint actually runs', () => {
    migration.up(db);
    /* `(organization_id, revoked_at)` — the club's links, live ones
       distinguishable without reading every row. */
    expect(indexSql('idx_org_share_links_org')).toMatch(/organization_id/);
  });
});

describe('the visibility column', () => {
  it('backfills every existing club to unlisted', () => {
    migration.up(db);
    const rows = db.prepare('SELECT id, visibility AS v FROM organizations ORDER BY id').all();
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row.v, row.id).toBe('unlisted');
  });

  /**
   * Nobody who runs a club that already existed agreed to publish it.
   *
   * This is the one assertion in the file that is about consent rather than
   * correctness, and it is the one that would be quietest to get wrong: a
   * DEFAULT of 'public' on the ALTER would publish every school club on the
   * platform at boot, with no error and no notice to anybody.
   */
  it('never publishes a club that predates the setting', () => {
    migration.up(db);
    const published = db.prepare(
      "SELECT COUNT(*) AS n FROM organizations WHERE visibility = 'public'"
    ).get();
    expect(Number(published.n)).toBe(0);
  });

  it('is NOT NULL, so a row cannot be neither value', () => {
    migration.up(db);
    expect(tableSql('organizations')).toMatch(/visibility\s+TEXT NOT NULL/);
  });
});

describe('the request note', () => {
  it('adds a nullable message column, so an existing request stays valid', () => {
    seedLinks();
    db.prepare(`
      INSERT INTO organization_join_requests (id, organization_id, user_id, status, created_at)
      VALUES ('r1', 'org-1', 'u1', 'pending', '2026-02-01T00:00:00.000Z')
    `).run();

    migration.up(db);

    expect(columns('organization_join_requests')).toContain('message');
    const row = db.prepare('SELECT message FROM organization_join_requests WHERE id = ?').get('r1');
    /* NULL, not an empty string — the note is optional and its absence is a
       fact rather than a blank somebody typed. */
    expect(row.message).toBeNull();
  });
});

describe('the invitations table', () => {
  it('exists, with no token column at all', () => {
    migration.up(db);
    expect(tables()).toContain('organization_invitations');

    /**
     * The security design, asserted as an ABSENCE.
     *
     * An invitation names `invited_user_id`, and the only thing that can accept
     * it is a session belonging to that user. A bearer token would be a
     * redundant credential that can leak, be logged, or be read off a screen —
     * so there is none, and this is the assertion that keeps it that way.
     */
    const names = columns('organization_invitations');
    expect(names).not.toContain('token');
    expect(names).not.toContain('token_hash');
    /* And no email either: an address field here would be the platform's only
       write oracle over a privileged column. */
    expect(names).not.toContain('email');
    expect(names).toContain('invited_user_id');
  });

  it('holds one pending invitation per person per club, and no more', () => {
    migration.up(db);
    const insert = db.prepare(`
      INSERT INTO organization_invitations
        (id, organization_id, invited_user_id, invited_by, status, created_at)
      VALUES (?, 'org-1', 'u1', 'u2', ?, '2026-03-01T00:00:00.000Z')
    `);
    insert.run('i1', 'pending');
    expect(() => insert.run('i2', 'pending')).toThrow(/UNIQUE/i);

    /* But a RESOLVED one does not block a later invitation — the index is
       partial, scoped to `pending`, which is what lets a club invite somebody
       again after withdrawing. */
    expect(() => insert.run('i3', 'revoked')).not.toThrow();
  });

  it('scopes that uniqueness to pending, in the index itself', () => {
    migration.up(db);
    const sql = indexSql('idx_org_invitations_live');
    expect(sql).toMatch(/UNIQUE/i);
    expect(sql).toMatch(/organization_id/);
    expect(sql).toMatch(/invited_user_id/);
    /* The predicate, asserted rather than assumed: a partial index that quietly
       lost its WHERE clause would stop a club from ever re-inviting anybody,
       with no error anywhere. */
    expect(sql).toMatch(/WHERE\s+status\s*=\s*'pending'/i);
  });

  it('refuses a status outside the vocabulary', () => {
    migration.up(db);
    expect(() => db.prepare(`
      INSERT INTO organization_invitations
        (id, organization_id, invited_user_id, status, created_at)
      VALUES ('i9', 'org-1', 'u1', 'maybe', '2026-03-01T00:00:00.000Z')
    `).run()).toThrow(/CHECK/i);
  });

  it('accepts every status the module uses', () => {
    migration.up(db);
    for (const [i, status] of ['pending', 'accepted', 'declined', 'revoked', 'expired'].entries()) {
      expect(() => db.prepare(`
        INSERT INTO organization_invitations
          (id, organization_id, invited_user_id, status, created_at)
        VALUES (?, 'org-1', ?, ?, '2026-03-01T00:00:00.000Z')
      `).run(`ok-${i}`, `u${(i % 2) + 1}`, status), status).not.toThrow();
    }
  });

  it('indexes the two reads the feature makes', () => {
    migration.up(db);
    /* The club's outstanding list, and one person's invitations. */
    expect(indexSql('idx_org_invitations_org')).toMatch(/organization_id/);
    expect(indexSql('idx_org_invitations_user')).toMatch(/invited_user_id/);
  });

  it('requires an invited user, because there is nobody to invite without one', () => {
    migration.up(db);
    expect(tableSql('organization_invitations')).toMatch(/invited_user_id\s+TEXT NOT NULL/);
  });
});
