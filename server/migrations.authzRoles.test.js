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

  it('kept the hours ledger in parity', async () => {
    const { verifyLedgerParity } = await import('./hoursLedger.js');
    const db = await getDb();
    // verifyLedgerParity(db) returns { ok, mismatches, usersChecked }; assert on
    // both `ok` and `mismatches` so neither can pass by being undefined.
    const result = verifyLedgerParity(db);
    expect(result.mismatches).toEqual([]);
    expect(result.ok).toBe(true);
  });
});
