/**
 * Migration 017 — the suspension deadline columns.
 *
 * Additive, so what needs proving is narrow but not trivial:
 *
 *   - it is idempotent, because the registry's own tests run `up` against a
 *     database that may already carry the columns, and SQLite's ADD COLUMN has no
 *     IF NOT EXISTS — an unguarded second run throws;
 *   - existing rows are NOT backfilled. Every suspension imposed before this
 *     column existed had no end date, and inventing one would silently convert a
 *     permanent suspension into one that expires. NULL has to keep meaning
 *     indefinite;
 *   - nothing else on `users` is touched. This is the migration a rebuild would
 *     have been tempting for, and a rebuild is what ENGINEERING_GUIDE §8.3 exists
 *     to make expensive.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import timedSuspension from './migrations/017_timed_suspension.js';

let dir, db;

/** The `users` shape this migration alters, reduced to what it reads. */
function seedUsers(database) {
  database.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      name TEXT,
      account_status TEXT DEFAULT 'active',
      suspended_at TEXT,
      suspension_reason TEXT,
      suspended_by TEXT
    )
  `);
  database.prepare('INSERT INTO users (id, name, account_status) VALUES (?, ?, ?)')
    .run('u_active', 'Active Person', 'active');
  database.prepare(`INSERT INTO users (id, name, account_status, suspended_at, suspension_reason)
                    VALUES (?, ?, ?, ?, ?)`)
    .run('u_susp', 'Suspended Person', 'suspended', '2026-07-01T00:00:00.000Z', 'a reason');
}

const columns = () => new Set(db.prepare('PRAGMA table_info(users)').all().map(c => c.name));

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'wev-mig17-'));
  db = new DatabaseSync(path.join(dir, 'm.db'));
  seedUsers(db);
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

describe('017_timed_suspension', () => {
  it('adds both columns', () => {
    timedSuspension.up(db);
    expect(columns().has('suspended_until')).toBe(true);
    expect(columns().has('suspension_lifted_at')).toBe(true);
  });

  it('is idempotent — running it twice does not throw', () => {
    timedSuspension.up(db);
    expect(() => timedSuspension.up(db)).not.toThrow();
    expect(columns().has('suspended_until')).toBe(true);
  });

  /**
   * The one that matters. A DEFAULT or a backfill here would give every
   * already-suspended account an expiry nobody decided — silently converting
   * indefinite suspensions, imposed for safety reasons, into ones that lapse.
   */
  it('leaves every existing row with no deadline, so NULL still means indefinite', () => {
    timedSuspension.up(db);

    const rows = db.prepare('SELECT id, suspended_until, suspension_lifted_at FROM users').all();
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.suspended_until, `${row.id} was given a deadline it never had`).toBe(null);
      expect(row.suspension_lifted_at).toBe(null);
    }
  });

  it('preserves the suspension record it did not come to change', () => {
    timedSuspension.up(db);

    const row = db.prepare('SELECT * FROM users WHERE id = ?').get('u_susp');
    expect(row.account_status).toBe('suspended');
    expect(row.suspension_reason).toBe('a reason');
    expect(row.suspended_at).toBe('2026-07-01T00:00:00.000Z');
  });

  it('declares the registry fields the checksum verifier needs', () => {
    expect(timedSuspension.version).toBe(17);
    expect(timedSuspension.name).toBe('timed_suspension');
    // Without fileUrl the registry silently falls back to hashing `up` alone, so
    // module-level code would be outside the checksum.
    expect(timedSuspension.fileUrl).toBeTruthy();
  });
});
