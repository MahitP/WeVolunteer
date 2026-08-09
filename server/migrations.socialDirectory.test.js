/**
 * Migration 031, run twice.
 *
 * Idempotency is the one property every migration in this repository is
 * required to prove (CLAUDE.md, "any migration (assert idempotency)"), and it
 * is not academic here: 031 mixes `CREATE TABLE IF NOT EXISTS` with guarded
 * `ALTER TABLE ADD COLUMN`, and the latter has no `IF NOT EXISTS` in SQLite. An
 * unguarded second run throws "duplicate column name" and takes the boot down
 * with it.
 *
 * The suite also checks the constraints the feature's safety rests on, because
 * a CHECK that was never asserted is a CHECK somebody can quietly relax.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import migration from './migrations/031_social_directory.js';

const dir = mkdtempSync(path.join(tmpdir(), 'wev-mig031-'));
let db;

/** The pre-031 shape of the tables this migration touches. */
function baseline(handle) {
  handle.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT,
      profile_visibility TEXT DEFAULT 'private', skills TEXT, created_at TEXT
    );
    CREATE TABLE events (
      id TEXT PRIMARY KEY, title TEXT, organizer_id TEXT, status TEXT DEFAULT 'open'
    );
    CREATE TABLE applications (
      id TEXT PRIMARY KEY, user_id TEXT, event_id TEXT, slot_id TEXT, status TEXT
    );
  `);
  handle.prepare('INSERT INTO users (id, name, created_at) VALUES (?, ?, ?)')
    .run('u1', 'Existing Student', '2026-01-01T00:00:00.000Z');
  handle.prepare('INSERT INTO events (id, title, organizer_id) VALUES (?, ?, ?)')
    .run('e1', 'Existing Event', 'u1');
}

const columns = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
const tables = () => db.prepare(
  "SELECT name FROM sqlite_master WHERE type = 'table'"
).all().map(r => r.name);

beforeEach(() => {
  db?.close();
  db = new DatabaseSync(path.join(dir, `m-${Math.random().toString(36).slice(2)}.db`));
  baseline(db);
});

afterAll(() => { db?.close(); rmSync(dir, { recursive: true, force: true }); });

describe('migration 031 — the social directory', () => {
  it('declares the shape the registry requires', () => {
    expect(migration.version).toBe(31);
    expect(migration.name).toBe('social_directory');
    expect(migration.fileUrl).toMatch(/^file:\/\//);
    expect(typeof migration.up).toBe('function');
  });

  it('creates every new table and column', () => {
    migration.up(db);

    for (const table of ['user_relationships', 'organizations', 'organization_members', 'external_hours']) {
      expect(tables(), `${table} must exist`).toContain(table);
    }
    for (const column of ['location', 'hobbies', 'friend_activity_visible']) {
      expect(columns('users'), `users.${column} must exist`).toContain(column);
    }
    for (const column of ['organization_id', 'credits_hours']) {
      expect(columns('events'), `events.${column} must exist`).toContain(column);
    }
  });

  /** The whole point of the file. */
  it('runs twice without throwing, and changes nothing the second time', () => {
    migration.up(db);
    const after = JSON.stringify({
      tables: tables().sort(), users: columns('users').sort(), events: columns('events').sort(),
    });

    expect(() => migration.up(db)).not.toThrow();

    expect(JSON.stringify({
      tables: tables().sort(), users: columns('users').sort(), events: columns('events').sort(),
    })).toBe(after);
  });

  it('is additive — it destroys no existing row', () => {
    migration.up(db);
    expect(db.prepare('SELECT COUNT(*) AS n FROM users').get().n).toBe(1);
    expect(db.prepare('SELECT name FROM users WHERE id = ?').get('u1').name).toBe('Existing Student');
    expect(db.prepare('SELECT COUNT(*) AS n FROM events').get().n).toBe(1);
  });

  describe('the defaults chosen for existing rows', () => {
    /**
     * Every event that predates the column must keep crediting hours. The other
     * default would silently turn the entire back catalogue into
     * participation-only events.
     */
    it('leaves every existing event crediting hours', () => {
      migration.up(db);
      expect(db.prepare('SELECT credits_hours FROM events WHERE id = ?').get('e1').credits_hours).toBe(1);
    });

    /* Friend activity defaults ON: the audience is one the account personally
       approved, and a discovery feature that is off for everybody discovers
       nothing. */
    it('leaves every existing account with friend activity visible', () => {
      migration.up(db);
      expect(db.prepare('SELECT friend_activity_visible FROM users WHERE id = ?').get('u1')
        .friend_activity_visible).toBe(1);
    });

    it('leaves the new profile fields empty rather than inventing content', () => {
      migration.up(db);
      const row = db.prepare('SELECT location, hobbies FROM users WHERE id = ?').get('u1');
      expect(row.location).toBeNull();
      expect(row.hobbies).toBeNull();
    });
  });

  describe('the constraints the feature relies on', () => {
    beforeEach(() => migration.up(db));

    const insertRelationship = (actor, subject, kind, status = 'accepted') =>
      db.prepare(`
        INSERT INTO user_relationships (id, actor_id, subject_id, kind, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(`r-${Math.random()}`, actor, subject, kind, status, '2026-01-01');

    it('refuses a self-relationship', () => {
      db.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run('u2', 'Second');
      expect(() => insertRelationship('u1', 'u1', 'friend')).toThrow();
    });

    it('refuses a second identical relationship', () => {
      db.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run('u2', 'Second');
      insertRelationship('u1', 'u2', 'friend', 'pending');
      expect(() => insertRelationship('u1', 'u2', 'friend', 'pending')).toThrow();
    });

    it('allows the three kinds to coexist for the same pair', () => {
      db.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run('u2', 'Second');
      insertRelationship('u1', 'u2', 'mute');
      expect(() => insertRelationship('u1', 'u2', 'restrict')).not.toThrow();
    });

    it('refuses a relationship kind outside the closed set', () => {
      db.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run('u2', 'Second');
      /* `block` in particular: blocks live in `user_blocks`, and two tables
         both claiming to answer "is this person blocked" is the failure mode
         this CHECK exists to prevent. */
      expect(() => insertRelationship('u1', 'u2', 'block')).toThrow();
    });

    it('refuses two organizations whose slugs differ only in case', () => {
      const insert = (id, slug) => db.prepare(`
        INSERT INTO organizations (id, name, slug, created_at, updated_at)
        VALUES (?, ?, ?, '2026-01-01', '2026-01-01')
      `).run(id, 'NHS', slug);
      insert('o1', 'nhs');
      expect(() => insert('o2', 'NHS')).toThrow();
    });

    it('refuses an external-hours status outside the closed set', () => {
      const insert = (status) => db.prepare(`
        INSERT INTO external_hours (id, user_id, organization_name, activity_name, occurred_on, hours, status, created_at, updated_at)
        VALUES (?, 'u1', 'Org', 'Act', '2026-01-01', 2, ?, '2026-01-01', '2026-01-01')
      `).run(`x-${Math.random()}`, status);
      expect(() => insert('self_reported')).not.toThrow();
      expect(() => insert('approved')).toThrow();
    });

    it('refuses a membership role outside member and manager', () => {
      db.prepare(`
        INSERT INTO organizations (id, name, slug, created_at, updated_at)
        VALUES ('o1', 'NHS', 'nhs', '2026-01-01', '2026-01-01')
      `).run();
      const insert = (role) => {
        /* A real users row each time — the FK is on, and a random id would fail
           for the wrong reason and make the CHECK look enforced when it is not. */
        const uid = `u-${Math.random().toString(36).slice(2)}`;
        db.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run(uid, 'Member');
        db.prepare(`
          INSERT INTO organization_members (organization_id, user_id, member_role, joined_at)
          VALUES ('o1', ?, ?, '2026-01-01')
        `).run(uid, role);
      };
      expect(() => insert('manager')).not.toThrow();
      expect(() => insert('admin')).toThrow();
    });
  });

  it('adds the applications index the profile page depends on', () => {
    migration.up(db);
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'applications'"
    ).all().map(r => r.name);
    expect(indexes).toContain('idx_applications_user_status');
  });
});
