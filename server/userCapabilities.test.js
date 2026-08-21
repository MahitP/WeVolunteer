import { describe, it, expect, beforeAll, afterAll } from 'vitest';

let srv;
beforeAll(async () => {
  const { startTestServer } = await import('./testServer.js');
  srv = await startTestServer();
}, 60000);
afterAll(async () => { await srv?.close(); });

const mod = () => import('./userCapabilities.js');
const getDb = async () => (await import('./db.js')).db;

/** A throwaway user row — user_capabilities has a FOREIGN KEY to users(id). */
async function makeUser(id) {
  const db = await getDb();
  await db.prepare(`INSERT INTO users (id,name,email,password_hash,grade,role,created_at)
              VALUES (?,?,?,'x','N/A','student',?)`)
    .run(id, id, `${id}@test.local`, new Date().toISOString());
  return id;
}

describe('user capability grants', () => {
  it('grants and reads back a capability', async () => {
    const { grantCapability, grantsFor } = await mod();
    const db = await getDb();
    await grantCapability({ db, userId: 'user-student-1', capability: 'report.evidence.read', grantedBy: 'user-admin' });
    expect(await grantsFor(db, 'user-student-1')).toContain('report.evidence.read');
  });

  it('is idempotent — granting twice does not duplicate', async () => {
    const { grantCapability, grantsFor } = await mod();
    const db = await getDb();
    await grantCapability({ db, userId: 'user-student-2', capability: 'report.evidence.read', grantedBy: 'user-admin' });
    await grantCapability({ db, userId: 'user-student-2', capability: 'report.evidence.read', grantedBy: 'user-admin' });
    expect((await grantsFor(db, 'user-student-2')).filter(c => c === 'report.evidence.read')).toHaveLength(1);
  });

  it('revokes a capability', async () => {
    const { grantCapability, revokeCapability, grantsFor } = await mod();
    const db = await getDb();
    await grantCapability({ db, userId: 'user-student-3', capability: 'report.evidence.read', grantedBy: 'user-admin' });
    await revokeCapability({ db, userId: 'user-student-3', capability: 'report.evidence.read' });
    expect(await grantsFor(db, 'user-student-3')).not.toContain('report.evidence.read');
  });

  it('excludes expired grants', async () => {
    const { grantCapability, grantsFor } = await mod();
    const db = await getDb();
    await grantCapability({
      db, userId: 'user-org-1', capability: 'report.evidence.read',
      grantedBy: 'user-admin', expiresAt: new Date(Date.now() - 1000).toISOString()
    });
    expect(await grantsFor(db, 'user-org-1')).not.toContain('report.evidence.read');
  });

  it('refuses an unknown capability', async () => {
    const { grantCapability } = await mod();
    const db = await getDb();
    await expect(async () => grantCapability({ db, userId: 'user-student-1', capability: 'made.up', grantedBy: 'user-admin' })).rejects.toThrow(/unknown capability/i);
  });

  it('refuses to grant a super-only capability', async () => {
    const { grantCapability } = await mod();
    const db = await getDb();
    await expect(async () => grantCapability({ db, userId: 'user-student-1', capability: 'impersonation.start', grantedBy: 'user-admin' })).rejects.toThrow(/cannot be granted/i);
  });

  it('returns a global grant', async () => {
    const { grantCapability, grantsFor } = await mod();
    const db = await getDb();
    const id = await makeUser('u-scope-global');
    await grantCapability({
      db, userId: id, capability: 'report.evidence.read',
      grantedBy: 'user-admin', scope: ''
    });
    expect(await grantsFor(db, id)).toContain('report.evidence.read');
  });

  it('refuses a scoped grant at write time', async () => {
    const { grantCapability, grantsFor } = await mod();
    const db = await getDb();
    const id = await makeUser('u-scope-refused');
    await expect(async () => grantCapability({
      db, userId: id, capability: 'event.moderate',
      grantedBy: 'user-admin', scope: 'event-softball'
    })).rejects.toThrow(/not enforced/i);
    // And nothing was written, so the refusal is not merely cosmetic.
    expect(await grantsFor(db, id)).toEqual([]);
    expect((await db.prepare('SELECT COUNT(*) c FROM user_capabilities WHERE user_id = ?').get(id)).c).toBe(0);
  });

  it('never returns a scoped row, even one inserted behind grantCapability\'s back', async () => {
    // `can()` takes no scope argument, so a scoped row read back as a plain
    // capability string would be enforced platform-wide — for event.moderate
    // that is the "may act on any event" bypass in every ownership check.
    // grantCapability refuses to write one; this proves the read side is
    // independently safe against a hand-inserted or future scope-aware write.
    const { grantsFor } = await mod();
    const db = await getDb();
    const id = await makeUser('u-scope-row');
    await db.prepare(`
      INSERT INTO user_capabilities (user_id, capability, scope, granted_by, granted_at, expires_at)
      VALUES (?, ?, ?, ?, ?, NULL)
    `).run(id, 'event.moderate', 'event-softball', 'user-admin', new Date().toISOString());

    expect(await grantsFor(db, id)).not.toContain('event.moderate');
    expect(await grantsFor(db, id)).toEqual([]);
    // The row really is there — the filter, not an absent insert, is what hides it.
    expect((await db.prepare('SELECT COUNT(*) c FROM user_capabilities WHERE user_id = ?').get(id)).c).toBe(1);
  });

  it('drops grants when the user is deleted', async () => {
    const { grantCapability, grantsFor } = await mod();
    const db = await getDb();
    const now = new Date().toISOString();
    await db.prepare(`INSERT INTO users (id,name,email,password_hash,grade,role,created_at)
                VALUES ('u-drop','D','drop@test.local','x','N/A','student',?)`).run(now);
    await grantCapability({ db, userId: 'u-drop', capability: 'report.evidence.read', grantedBy: 'user-admin' });
    await db.prepare("DELETE FROM users WHERE id = 'u-drop'").run();
    expect(await grantsFor(db, 'u-drop')).toEqual([]);
  });
});
