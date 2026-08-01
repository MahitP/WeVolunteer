import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

let dir, db;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'wev-mig-'));
  db = new DatabaseSync(path.join(dir, 'm.db'));
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

describe('migration registry', () => {
  it('creates schema_migrations and records an applied migration', async () => {
    const { runMigrations } = await import('./migrations/index.js');
    const fake = [{ version: 9001, name: 'test_only', up: (d) => d.exec('CREATE TABLE t9001 (x TEXT)') }];

    const first = runMigrations(db, fake);

    expect(first.applied).toEqual(['9001_test_only']);
    const rows = db.prepare('SELECT version, name FROM schema_migrations').all();
    expect(rows).toEqual([{ version: 9001, name: 'test_only' }]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 't9001'").get()).toBeTruthy();
  });

  it('is idempotent — a second run applies nothing', async () => {
    const { runMigrations } = await import('./migrations/index.js');
    const fake = [{ version: 9001, name: 'test_only', up: (d) => d.exec('CREATE TABLE t9001 (x TEXT)') }];

    runMigrations(db, fake);
    const second = runMigrations(db, fake);

    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(['9001_test_only']);
  });

  it('rolls back a failing migration, leaving no partial state', async () => {
    const { runMigrations } = await import('./migrations/index.js');
    const bad = [{
      version: 9002, name: 'explodes',
      up: (d) => { d.exec('CREATE TABLE half (x TEXT)'); throw new Error('boom'); }
    }];

    expect(() => runMigrations(db, bad)).toThrow(/9002_explodes/);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'half'").get()).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations').get().c).toBe(0);
  });

  it('runs migrations in version order regardless of array order', async () => {
    const { runMigrations } = await import('./migrations/index.js');
    const order = [];
    const out = runMigrations(db, [
      { version: 9002, name: 'second', up: () => order.push(2) },
      { version: 9001, name: 'first',  up: () => order.push(1) },
    ]);
    expect(order).toEqual([1, 2]);
    expect(out.applied).toEqual(['9001_first', '9002_second']);
  });

  it('rejects duplicate version numbers', async () => {
    const { runMigrations } = await import('./migrations/index.js');
    expect(() => runMigrations(db, [
      { version: 9001, name: 'a', up: () => {} },
      { version: 9001, name: 'b', up: () => {} },
    ])).toThrow(/duplicate migration version/i);
  });

  it('records a checksum when applying a migration', async () => {
    const { runMigrations } = await import('./migrations/index.js');
    const fake = [{ version: 9001, name: 'test_only', up: (d) => d.exec('CREATE TABLE t9001 (x TEXT)') }];

    runMigrations(db, fake);

    const row = db.prepare('SELECT checksum FROM schema_migrations WHERE version = 9001').get();
    expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('skips silently when the checksum still matches', async () => {
    const { runMigrations } = await import('./migrations/index.js');
    const fake = [{ version: 9001, name: 'test_only', up: (d) => d.exec('CREATE TABLE t9001 (x TEXT)') }];

    runMigrations(db, fake);
    let second;
    expect(() => { second = runMigrations(db, fake); }).not.toThrow();
    expect(second.applied).toEqual([]);
  });

  it('throws when a recorded migration\'s source has changed', async () => {
    const { runMigrations } = await import('./migrations/index.js');
    const original = [{ version: 9001, name: 'test_only', up: (d) => d.exec('CREATE TABLE t9001 (x TEXT)') }];
    const changed = [{ version: 9001, name: 'test_only', up: (d) => d.exec('CREATE TABLE t9001 (x TEXT, y TEXT)') }];

    runMigrations(db, original);

    expect(() => runMigrations(db, changed)).toThrow(/9001/);
    expect(() => runMigrations(db, changed)).toThrow(/test_only/);
  });

  it('throws when a recorded migration has a NULL checksum', async () => {
    const { runMigrations } = await import('./migrations/index.js');
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    INTEGER PRIMARY KEY,
        name       TEXT NOT NULL,
        applied_at TEXT NOT NULL,
        checksum   TEXT
      )
    `);
    db.prepare(
      'INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)'
    ).run(9001, 'test_only', new Date().toISOString(), null);

    const fake = [{ version: 9001, name: 'test_only', up: (d) => d.exec('CREATE TABLE t9001 (x TEXT)') }];

    expect(() => runMigrations(db, fake)).toThrow(/9001/);
  });

  it('adds the checksum column to a pre-existing three-column table', async () => {
    const { runMigrations } = await import('./migrations/index.js');
    db.exec(`
      CREATE TABLE schema_migrations (
        version    INTEGER PRIMARY KEY,
        name       TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
    db.prepare(
      'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
    ).run(1, 'legacy_row', new Date().toISOString());

    // No migration in this list matches version 1, so the legacy row is never
    // verified and this run cannot throw — it only proves the ALTER TABLE path.
    runMigrations(db, [{ version: 9001, name: 'test_only', up: (d) => d.exec('CREATE TABLE t9001 (x TEXT)') }]);

    const columns = db.prepare('PRAGMA table_info(schema_migrations)').all().map(c => c.name);
    expect(columns).toContain('checksum');
  });

  it('produces an actionable error message naming the migration and the remedy', async () => {
    const { runMigrations } = await import('./migrations/index.js');
    const original = [{ version: 9001, name: 'test_only', up: (d) => d.exec('CREATE TABLE t9001 (x TEXT)') }];
    const changed = [{ version: 9001, name: 'test_only', up: (d) => d.exec('CREATE TABLE t9001 (x TEXT, y TEXT)') }];

    runMigrations(db, original);

    try {
      runMigrations(db, changed);
      throw new Error('expected runMigrations to throw');
    } catch (err) {
      expect(err.message).toMatch(/test_only/);
      expect(err.message).toMatch(/schema_migrations/);
      expect(err.message).toMatch(/delete/i);
    }
  });
});
