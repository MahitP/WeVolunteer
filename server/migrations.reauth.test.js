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

describe('003_reauth_challenges', () => {
  it('records itself in schema_migrations as version 3 with a non-null checksum', async () => {
    const db = await getDb();
    const row = db.prepare('SELECT name, checksum FROM schema_migrations WHERE version = 3').get();
    expect(row?.name).toBe('reauth_challenges');
    expect(row?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('creates the reauth_challenges table with id as PRIMARY KEY', async () => {
    const db = await getDb();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'reauth_challenges'").get()).toBeTruthy();
    const columns = db.prepare('PRAGMA table_info(reauth_challenges)').all();
    const idCol = columns.find(c => c.name === 'id');
    expect(idCol?.pk).toBe(1);
  });

  it('creates the idx_reauth_user index on (user_id, expires_at)', async () => {
    const db = await getDb();
    const idx = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'reauth_challenges' AND name = 'idx_reauth_user'"
    ).get();
    expect(idx).toBeTruthy();
    const cols = db.prepare('PRAGMA index_info(idx_reauth_user)').all().map(c => c.name);
    expect(cols).toEqual(['user_id', 'expires_at']);
  });

  it('round-trips a row through every column', async () => {
    const db = await getDb();
    const now = new Date().toISOString();
    const later = new Date(Date.now() + 5 * 60 * 1000).toISOString();

    const userId = 'u-reauth-roundtrip';
    db.prepare(`
      INSERT INTO users (id, name, email, password_hash, grade, role, created_at)
      VALUES (?, 'Reauth Roundtrip', 'reauth-roundtrip@test.local', 'x', 'N/A', 'student', ?)
    `).run(userId, now);

    db.prepare(`
      INSERT INTO reauth_challenges
        (id, user_id, action, params_hash, method, session_jti, created_at, expires_at,
         granted_at, consumed_at, attempts, ip_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'rc-1', userId, 'delete_account', 'hash-of-params', 'password', 'jti-1',
      now, later, now, null, 2, 'hash-of-ip'
    );

    const row = db.prepare('SELECT * FROM reauth_challenges WHERE id = ?').get('rc-1');
    expect(row).toEqual({
      id: 'rc-1',
      user_id: userId,
      action: 'delete_account',
      params_hash: 'hash-of-params',
      method: 'password',
      session_jti: 'jti-1',
      created_at: now,
      expires_at: later,
      granted_at: now,
      consumed_at: null,
      attempts: 2,
      ip_hash: 'hash-of-ip',
    });
  });

  it('cascades: deleting the user removes their reauth challenges', async () => {
    const db = await getDb();
    const now = new Date().toISOString();
    const later = new Date(Date.now() + 5 * 60 * 1000).toISOString();

    const userId = 'u-reauth-cascade';
    db.prepare(`
      INSERT INTO users (id, name, email, password_hash, grade, role, created_at)
      VALUES (?, 'Reauth Cascade', 'reauth-cascade@test.local', 'x', 'N/A', 'student', ?)
    `).run(userId, now);

    db.prepare(`
      INSERT INTO reauth_challenges
        (id, user_id, action, params_hash, session_jti, created_at, expires_at, attempts)
      VALUES (?, ?, 'delete_account', 'hash', 'jti-2', ?, ?, 0)
    `).run('rc-2', userId, now, later);

    expect(db.prepare('SELECT COUNT(*) c FROM reauth_challenges WHERE user_id = ?').get(userId).c).toBe(1);

    db.prepare('DELETE FROM users WHERE id = ?').run(userId);

    expect(db.prepare('SELECT COUNT(*) c FROM reauth_challenges WHERE user_id = ?').get(userId).c).toBe(0);
  });

  it('is idempotent — a second runMigrations applies nothing and throws nothing', async () => {
    const db = await getDb();
    const { runMigrations } = await import('./migrations/index.js');
    const before = db.prepare('SELECT COUNT(*) c FROM reauth_challenges').get().c;

    let out;
    expect(() => { out = runMigrations(db); }).not.toThrow();

    expect(out.applied).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) c FROM reauth_challenges').get().c).toBe(before);
  });
});
