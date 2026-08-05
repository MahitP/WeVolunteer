/**
 * Migration 010 — users.graduation_year.
 *
 * One nullable ALTER TABLE ADD COLUMN, so the interesting assertions are not
 * about the DDL. They are:
 *
 *   - **Idempotency.** `runMigrations` is called from `initDatabase()` on every
 *     boot, and the guard that makes a second run a no-op is a `PRAGMA
 *     table_info` check inside `up`. Running it twice here is the only thing that
 *     proves the guard, rather than proving that `schema_migrations` happened to
 *     record a row.
 *   - **INTEGER, and nullable.** Both are load-bearing. A TEXT year sorts and
 *     compares by digit rather than by magnitude, and a NOT NULL column would
 *     force a placeholder onto every organizer and onto every account that
 *     predates this change — at which point "has a class year" stops meaning
 *     "is in school".
 *   - **No CHECK constraint.** The eligible range moves every school year, so a
 *     CHECK would be a literal that starts refusing real applicants and
 *     accepting graduated ones. That rule lives in `graduationYearRange()`,
 *     which can read a clock.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

let srv;
beforeAll(async () => {
  const { startTestServer } = await import('./testServer.js');
  srv = await startTestServer();
}, 60000);
afterAll(async () => { await srv?.close(); });

const getDb = async () => (await import('./db.js')).db;

describe('010_graduation_year — applies and registers', () => {
  it('records itself in schema_migrations as version 10 with a non-null checksum', async () => {
    const db = await getDb();
    const row = db.prepare('SELECT name, checksum FROM schema_migrations WHERE version = 10').get();
    expect(row?.name).toBe('graduation_year');
    expect(row?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('adds graduation_year to users as a nullable INTEGER with no default', async () => {
    const db = await getDb();
    const col = db.prepare('PRAGMA table_info(users)').all().find(c => c.name === 'graduation_year');

    expect(col, 'graduation_year is missing from users').toBeTruthy();
    expect(col.type).toBe('INTEGER');
    expect(col.notnull, 'NOT NULL would force a placeholder year onto every adult').toBe(0);
    expect(col.dflt_value, 'a default would invent a class year for grandfathered rows').toBeNull();
  });

  it('carries no CHECK constraint, because the eligible range moves every year', async () => {
    const db = await getDb();
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get().sql;
    expect(sql).toContain('graduation_year');
    expect(
      /graduation_year[^,)]*CHECK/i.test(sql),
      'a hardcoded year range would refuse real applicants once the school year turns over'
    ).toBe(false);
  });

  it('accepts a NULL year — the permanent answer for an adult, and for every pre-010 row', async () => {
    const db = await getDb();
    const now = new Date().toISOString();
    expect(() => db.prepare(`
      INSERT INTO users (id, name, email, username, password_hash, grade, role, created_at)
      VALUES ('u-gy-null', 'No Year', 'gy.null@test.local', 'gy_null', 'x', 'Adult', 'organizer', ?)
    `).run(now)).not.toThrow();

    expect(db.prepare("SELECT graduation_year FROM users WHERE id = 'u-gy-null'").get())
      .toEqual({ graduation_year: null });
  });

  it('round-trips a year as a number, not as text', async () => {
    const db = await getDb();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO users (id, name, email, username, password_hash, grade, graduation_year, role, created_at)
      VALUES ('u-gy-int', 'Has Year', 'gy.int@test.local', 'gy_int', 'x', '10', 2029, 'student', ?)
    `).run(now);

    const value = db.prepare("SELECT graduation_year FROM users WHERE id = 'u-gy-int'").get().graduation_year;
    expect(value).toBe(2029);
    expect(typeof value).toBe('number');
  });

  it('is idempotent — a second runMigrations applies nothing, throws nothing, and loses no data', async () => {
    const db = await getDb();
    const { runMigrations } = await import('./migrations/index.js');
    const before = db.prepare('SELECT COUNT(*) c FROM users WHERE graduation_year IS NOT NULL').get().c;

    let out;
    expect(() => { out = runMigrations(db); }).not.toThrow();

    expect(out.applied).toEqual([]);
    expect(out.skipped).toContain('10_graduation_year');
    expect(db.prepare('SELECT COUNT(*) c FROM users WHERE graduation_year IS NOT NULL').get().c).toBe(before);
    // A second ALTER TABLE would have thrown "duplicate column name"; assert the
    // column is still singular anyway, since that is what the guard promises.
    expect(
      db.prepare('PRAGMA table_info(users)').all().filter(c => c.name === 'graduation_year').length
    ).toBe(1);
  });

  it('runs after 001, so 001\'s unknown-column guard never sees this column', async () => {
    // The reason this is a registry migration and not an `addColumnIfMissing`
    // line in db.js: that pass runs BEFORE runMigrations, so the column would
    // exist when 001 rebuilds `users`, and 001 correctly refuses to copy a
    // column it does not know about.
    const { MIGRATIONS } = await import('./migrations/index.js');
    const versions = MIGRATIONS.map(m => m.version);
    expect(versions).toContain(10);
    expect(Math.max(...versions.filter(v => v !== 10))).toBeLessThan(10);
  });
});
