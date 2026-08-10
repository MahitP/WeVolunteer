/**
 * Migration 032, run twice, and run against a table it must refuse.
 *
 * This is a TABLE REBUILD — the second sanctioned one in this repository — so
 * the properties under test are the ones ENGINEERING_GUIDE §8.3 requires of the
 * first: it must not lose a row, it must not silently drop a column it did not
 * expect, it must be a no-op on a database that has already had it, and it must
 * leave no foreign-key violation behind.
 *
 * The data question matters more here than the schema one. What 031 stored in
 * `status`, `reviewed_by`, `reviewed_at` and `review_note` was a review workflow
 * that should never have existed; what it stored in the other nine columns is
 * something a student typed about an afternoon of their own life. Dropping the
 * first four while carrying every row of the second is the entire job.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import migration from './migrations/032_external_hours_tracking_only.js';

const dir = mkdtempSync(path.join(tmpdir(), 'wev-mig032-'));
let db;

/** The post-031, pre-032 shape, with rows in every state 031 could produce. */
function baseline(handle) {
  handle.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE external_hours (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      organization_name TEXT NOT NULL,
      activity_name TEXT NOT NULL,
      description   TEXT NOT NULL DEFAULT '',
      occurred_on   TEXT NOT NULL,
      hours         REAL NOT NULL,
      status        TEXT NOT NULL DEFAULT 'self_reported'
                      CHECK (status IN ('self_reported','verified','rejected')),
      reviewed_by   TEXT,
      reviewed_at   TEXT,
      review_note   TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );
  `);
  handle.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run('u1', 'Alice');
  handle.prepare('INSERT INTO users (id, name) VALUES (?, ?)').run('u2', 'Bob');

  const insert = handle.prepare(`
    INSERT INTO external_hours
      (id, user_id, organization_name, activity_name, description, occurred_on, hours,
       status, reviewed_by, reviewed_at, review_note, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const t = '2026-05-01T00:00:00.000Z';
  insert.run('x1', 'u1', 'Food bank', 'Sorting', 'Boxes.', '2026-04-01', 3.5,
    'self_reported', null, null, null, t, t);
  insert.run('x2', 'u1', 'Library', 'Shelving', '', '2026-04-08', 2,
    'verified', 'admin-1', t, 'Confirmed by phone.', t, t);
  insert.run('x3', 'u2', 'Clean-up', 'Litter pick', 'Park.', '2026-04-15', 1.25,
    'rejected', 'admin-1', t, 'No evidence.', t, t);
}

const columns = () => db.prepare('PRAGMA table_info(external_hours)').all().map(c => c.name);
const rows = () => db.prepare('SELECT * FROM external_hours ORDER BY id').all();

beforeEach(() => {
  db?.close();
  db = new DatabaseSync(path.join(dir, `m-${Math.random().toString(36).slice(2)}.db`));
  baseline(db);
});

afterAll(() => { db?.close(); rmSync(dir, { recursive: true, force: true }); });

describe('migration 032 — external hours become tracking-only', () => {
  it('declares the shape the registry requires', () => {
    expect(migration.version).toBe(32);
    expect(migration.name).toBe('external_hours_tracking_only');
    expect(typeof migration.fileUrl).toBe('string');
    /* A rebuild must manage its own transaction: PRAGMA foreign_keys is a
       silent no-op inside an open one. */
    expect(migration.ownTransaction).toBe(true);
  });

  it('removes every review column and keeps every other one', () => {
    migration.up(db);
    expect(columns().sort()).toEqual([
      'activity_name', 'created_at', 'description', 'hours', 'id',
      'occurred_on', 'organization_name', 'updated_at', 'user_id',
    ]);
    for (const gone of ['status', 'reviewed_by', 'reviewed_at', 'review_note']) {
      expect(columns()).not.toContain(gone);
    }
  });

  /**
   * The one thing this migration must not do. Every row a student wrote is
   * carried across verbatim — including the one an administrator had marked
   * `rejected`, because a rejection was an opinion about somebody's own record
   * of their own afternoon and this release's position is that nobody was
   * entitled to hold one.
   */
  it('carries every row across, rejected ones included', () => {
    migration.up(db);
    const after = rows();
    expect(after).toHaveLength(3);
    expect(after.map(r => r.id)).toEqual(['x1', 'x2', 'x3']);
    expect(after[0]).toMatchObject({
      user_id: 'u1', organization_name: 'Food bank', activity_name: 'Sorting',
      description: 'Boxes.', occurred_on: '2026-04-01', hours: 3.5,
    });
    expect(after[2]).toMatchObject({ id: 'x3', user_id: 'u2', hours: 1.25 });
  });

  it('is idempotent — a second run changes nothing', () => {
    migration.up(db);
    const once = rows();
    expect(() => migration.up(db)).not.toThrow();
    expect(rows()).toEqual(once);
    expect(columns()).not.toContain('status');
  });

  it('does nothing at all when the table has never existed', () => {
    db.exec('DROP TABLE external_hours');
    expect(() => migration.up(db)).not.toThrow();
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'external_hours'"
    ).all()).toEqual([]);
  });

  /**
   * The unknown-column guard, which is the whole reason a rebuild is allowed to
   * exist here at all. A migration added after this one could put a column on
   * the table; copying an explicit list would drop it without a word.
   */
  it('refuses to rebuild a table carrying a column it does not know about', () => {
    db.exec('ALTER TABLE external_hours ADD COLUMN evidence_url TEXT');
    expect(() => migration.up(db)).toThrow(/unexpected column\(s\) evidence_url/);
    /* And it refused BEFORE touching anything. */
    expect(columns()).toContain('status');
    expect(rows()).toHaveLength(3);
  });

  it('refuses to rebuild a table missing a column it expects', () => {
    db.exec('ALTER TABLE external_hours DROP COLUMN review_note');
    expect(() => migration.up(db)).toThrow(/missing column\(s\) review_note/);
  });

  it('leaves the cascade to users intact', () => {
    migration.up(db);
    db.exec('PRAGMA foreign_keys = ON');
    db.prepare('DELETE FROM users WHERE id = ?').run('u2');
    expect(rows().map(r => r.id)).toEqual(['x1', 'x2']);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('rebuilds the lookup index the log page reads by', () => {
    migration.up(db);
    const indexes = db.prepare('PRAGMA index_list(external_hours)').all().map(i => i.name);
    expect(indexes).toContain('idx_external_hours_user');
  });
});
