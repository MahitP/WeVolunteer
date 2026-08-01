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
});
