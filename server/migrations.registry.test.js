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

  it('hashes the whole migration FILE, so module-level code is covered too', async () => {
    // The failure this replaces: `String(m.up)` covered only the function body,
    // so 001's EXPECTED_USER_COLUMNS and countCascadingChildren() — the parts
    // that change when a users column is added — could be rewritten with no
    // change to the checksum at all.
    const { checksumFor } = await import('./migrations/index.js');
    const authzRoles = (await import('./migrations/001_authz_roles.js')).default;

    const real = checksumFor(authzRoles);
    // Same `up`, no fileUrl: falls back to hashing the function source alone.
    const upOnly = checksumFor({ version: 1, name: 'authz_roles', up: authzRoles.up });

    expect(real).toMatch(/^[0-9a-f]{64}$/);
    expect(real, 'the file hash must not equal the up-only hash').not.toBe(upOnly);
  });

  it('gives every REAL migration a fileUrl, so none silently falls back to up-only hashing', async () => {
    const { MIGRATIONS } = await import('./migrations/index.js');
    expect(MIGRATIONS.length).toBeGreaterThan(0);
    for (const m of MIGRATIONS) {
      expect(typeof m.fileUrl, `${m.version}_${m.name} must declare fileUrl: import.meta.url`)
        .toBe('string');
      expect(m.fileUrl).toMatch(/^file:\/\//);
    }
  });

  it('names the scheme-change backfill in the mismatch error, not just row deletion', async () => {
    const { runMigrations } = await import('./migrations/index.js');
    const original = [{ version: 9001, name: 'test_only', up: (d) => d.exec('CREATE TABLE t9001 (x TEXT)') }];
    const changed = [{ version: 9001, name: 'test_only', up: (d) => d.exec('CREATE TABLE t9001 (x TEXT, y TEXT)') }];

    runMigrations(db, original);

    try {
      runMigrations(db, changed);
      throw new Error('expected runMigrations to throw');
    } catch (err) {
      // The case the old message stranded the operator on: change already
      // present, so deleting the row is wrong, and nothing said what IS right.
      expect(err.message).toMatch(/UPDATE schema_migrations SET checksum/);
      expect(err.message).toMatch(/bin\/migration-checksums\.mjs/);
      expect(err.message).toMatch(/scheme/i);
      expect(err.message).toMatch(/ENGINEERING_GUIDE\.md section 8\.5/);
    }
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

/**
 * The canonicaliser the checksum is computed over.
 *
 * Tested directly, because both of the checksum's failure modes live here: it
 * must drop enough (comments, whitespace) that a cosmetic edit does not fail a
 * boot, and drop nothing else — deleting real code would let two different
 * migrations hash identically, which is strictly worse than the false positive
 * it replaced.
 */
describe('canonicalSource', () => {
  const canon = async () => (await import('./migrations/index.js')).canonicalSource;

  it('ignores comment and whitespace changes', async () => {
    const c = await canon();
    const a = `
      // create the table
      function up(db) {
        /* block comment */
        db.exec('CREATE TABLE t (x TEXT)');
      }
    `;
    const b = `
      // Create the table. Reworded, reflowed,
      // and now spread over two lines.
      function up(db) {
        db.exec('CREATE TABLE t (x TEXT)');
      }
    `;
    expect(c(a)).toBe(c(b));
  });

  it('still notices a real code change', async () => {
    const c = await canon();
    expect(c("db.exec('CREATE TABLE t (x TEXT)')"))
      .not.toBe(c("db.exec('CREATE TABLE t (x TEXT, y TEXT)')"));
  });

  it('never treats // inside a string or template as a comment', async () => {
    const c = await canon();
    // The false negative to avoid: stripping from '//' to end of line here
    // would delete `const keep = 2` and make this identical to a file without
    // it.
    const withUrl = `const u = 'https://example.org/x'; const keep = 2;`;
    expect(c(withUrl)).toContain('keep');
    expect(c(withUrl)).not.toBe(c(`const u = 'https://example.org/x';`));

    const tpl = 'const q = `SELECT 1 -- not js`; const keep = 2;';
    expect(c(tpl)).toContain('keep');
  });

  it('keeps a backtick that appears inside an interpolation', async () => {
    const c = await canon();
    const src = 'const s = `a ${ [1].map(n => `${n}`).join(``) } b`; const keep = 2;';
    expect(c(src)).toContain('keep');
  });

  it('does not let a regex literal swallow the rest of the line', async () => {
    const c = await canon();
    const src = 'const re = /a\\/\\/b/; const keep = 2;';
    expect(c(src)).toContain('keep');
  });

  it('preserves division as division', async () => {
    const c = await canon();
    expect(c('const n = a / b; const keep = 2;')).toContain('keep');
  });

  it('does not merge tokens when collapsing whitespace', async () => {
    const c = await canon();
    expect(c('const  a =\n\n 1')).toBe('const a = 1');
    expect(c('return\nx')).toBe('return x');
  });
});
