import { describe, it, expect, beforeAll, afterAll } from 'vitest';

let srv;
beforeAll(async () => { srv = await startTestServerLazy(); }, 60000);
afterAll(async () => { await srv?.close(); });

// startTestServer must not be imported statically alongside db.js access below;
// this indirection keeps the dynamic-import rule explicit and local.
async function startTestServerLazy() {
  const { startTestServer } = await import('./testServer.js');
  return startTestServer();
}

const getDb = async () => (await import('./db.js')).db;

describe('001_authz_roles', () => {
  it('records itself in schema_migrations', async () => {
    const db = await getDb();
    const row = db.prepare('SELECT name FROM schema_migrations WHERE version = 1').get();
    expect(row?.name).toBe('authz_roles');
  });

  it('accepts super_admin and partner as roles', async () => {
    const db = await getDb();
    const now = new Date().toISOString();
    for (const role of ['super_admin', 'partner']) {
      expect(() => db.prepare(`
        INSERT INTO users (id, name, email, password_hash, grade, role, created_at)
        VALUES (?, ?, ?, 'x', 'N/A', ?, ?)
      `).run(`u-${role}`, role, `${role}@test.local`, role, now)).not.toThrow();
    }
    expect(db.prepare("SELECT role FROM users WHERE id = 'u-super_admin'").get().role).toBe('super_admin');
  });

  it('still rejects a role outside the enum', async () => {
    const db = await getDb();
    expect(() => db.prepare(`
      INSERT INTO users (id, name, email, password_hash, grade, role, created_at)
      VALUES ('u-bogus','B','bogus@test.local','x','N/A','wizard', ?)
    `).run(new Date().toISOString())).toThrow();
  });

  it('preserved every seeded user and their data', async () => {
    const db = await getDb();
    // The demo seed creates users, events and applications; all must survive.
    expect(db.prepare('SELECT COUNT(*) c FROM users').get().c).toBeGreaterThan(5);
    expect(db.prepare('SELECT COUNT(*) c FROM events').get().c).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) c FROM applications').get().c).toBeGreaterThan(0);
    // The classic cascade-delete symptom: users survive but children vanish.
    const orphanApps = db.prepare(
      'SELECT COUNT(*) c FROM applications a LEFT JOIN users u ON u.id = a.user_id WHERE u.id IS NULL'
    ).get().c;
    expect(orphanApps).toBe(0);
  });

  it('recreated all three users indexes', async () => {
    const db = await getDb();
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='users'")
      .all().map(r => r.name);
    expect(names).toContain('idx_users_username');
    expect(names).toContain('idx_users_username_nocase');
    expect(names).toContain('idx_users_email_nocase');
  });

  it('kept the case-insensitive email index enforcing', async () => {
    const db = await getDb();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO users (id,name,email,password_hash,grade,role,created_at)
                VALUES ('u-case','C','Case@test.local','x','N/A','student',?)`).run(now);
    expect(() => db.prepare(`INSERT INTO users (id,name,email,password_hash,grade,role,created_at)
                VALUES ('u-case2','C2','case@test.local','x','N/A','student',?)`).run(now)).toThrow();
  });

  it('left foreign key enforcement ON afterwards', async () => {
    const db = await getDb();
    expect(db.prepare('PRAGMA foreign_keys').get().foreign_keys).toBe(1);
  });

  it('is idempotent — a second runMigrations applies nothing', async () => {
    const db = await getDb();
    const { runMigrations } = await import('./migrations/index.js');
    const before = db.prepare('SELECT COUNT(*) c FROM users').get().c;
    const out = runMigrations(db);
    expect(out.applied).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) c FROM users').get().c).toBe(before);
  });

  /**
   * The two tests below run `up()` directly against a throwaway in-memory
   * database, never the app's connection. They cover the one catastrophic path
   * the other assertions structurally cannot see: `DROP TABLE users` with
   * foreign keys still enforced cascade-deletes every child table, and it does
   * so without orphaning anything, so `PRAGMA foreign_key_check` reports clean
   * and the migration would otherwise commit an emptied database.
   */
  const seedRebuildFixture = async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        grade TEXT CHECK(grade IN ('9', '10', '11', '12', 'Adult', 'N/A')) NOT NULL,
        role TEXT CHECK(role IN ('student', 'organizer', 'admin')) NOT NULL,
        verified INTEGER DEFAULT 1, avatar TEXT, bio TEXT, school TEXT, skills TEXT,
        leaderboard_opt_in INTEGER DEFAULT 0, username TEXT UNIQUE,
        profile_visibility TEXT DEFAULT 'private', created_at TEXT NOT NULL,
        token_version INTEGER NOT NULL DEFAULT 0, email_opt_out INTEGER DEFAULT 0,
        account_status TEXT DEFAULT 'active', deleted_at TEXT,
        email_verified INTEGER DEFAULT 0, username_changed_at TEXT
      );
      CREATE TABLE applications (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      INSERT INTO users (id,name,email,password_hash,grade,role,created_at)
        VALUES ('u1','U','u@test.local','x','N/A','student','2026-01-01T00:00:00.000Z');
      INSERT INTO applications (id, user_id) VALUES ('a1','u1');
    `);
    return db;
  };

  it('aborts instead of rebuilding when foreign_keys = OFF cannot take effect', async () => {
    const migration = (await import('./migrations/001_authz_roles.js')).default;
    const db = await seedRebuildFixture();

    // A transaction already open makes `PRAGMA foreign_keys = OFF` a silent no-op.
    db.exec('BEGIN');
    expect(() => migration.up(db)).toThrow(/did not take effect/);

    // Nothing was touched, and the caller's transaction is still its own to end:
    // this ROLLBACK would throw if up() had rolled back a transaction it did not open.
    expect(() => db.exec('ROLLBACK')).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) c FROM users').get().c).toBe(1);
    expect(db.prepare('SELECT COUNT(*) c FROM applications').get().c).toBe(1);
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE name='users'").get().sql)
      .not.toContain('super_admin');
    db.close();
  });

  it('rolls back the rebuild if any child table loses rows', async () => {
    const migration = (await import('./migrations/001_authz_roles.js')).default;
    const real = await seedRebuildFixture();

    // Fault injection: reproduce exactly what SQLite would do to the children if
    // foreign keys were still enforced at DROP TABLE time. Only the test does
    // this — the migration itself is unmodified.
    const cascadingDb = new Proxy(real, {
      get(target, prop) {
        const value = target[prop];
        if (typeof value !== 'function') return value;
        if (prop !== 'exec') return value.bind(target);
        return (sql) => {
          if (/^\s*DROP TABLE users\s*$/i.test(sql)) real.exec('DELETE FROM applications');
          return real.exec(sql);
        };
      },
    });

    expect(() => migration.up(cascadingDb)).toThrow(/applications lost rows/);

    // Detected AND undone: the child rows are back and users is un-rebuilt.
    expect(real.prepare('SELECT COUNT(*) c FROM applications').get().c).toBe(1);
    expect(real.prepare('SELECT COUNT(*) c FROM users').get().c).toBe(1);
    expect(real.prepare("SELECT sql FROM sqlite_master WHERE name='users'").get().sql)
      .not.toContain('super_admin');
    expect(real.prepare('PRAGMA foreign_keys').get().foreign_keys).toBe(1);
    real.close();
  });

  it('kept the hours ledger in parity', async () => {
    const { verifyLedgerParity } = await import('./hoursLedger.js');
    const db = await getDb();
    // verifyLedgerParity(db) returns { ok, mismatches, usersChecked }; assert on
    // both `ok` and `mismatches` so neither can pass by being undefined.
    const result = await verifyLedgerParity(db);
    expect(result.mismatches).toEqual([]);
    expect(result.ok).toBe(true);
  });
});
