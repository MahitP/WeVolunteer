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
  db.prepare(`INSERT INTO users (id,name,email,password_hash,grade,role,created_at)
              VALUES (?,?,?,'x','N/A','student',?)`)
    .run(id, id, `${id}@test.local`, new Date().toISOString());
  return id;
}

describe('user capability grants', () => {
  it('grants and reads back a capability', async () => {
    const { grantCapability, grantsFor } = await mod();
    const db = await getDb();
    grantCapability({ db, userId: 'user-student-1', capability: 'report.evidence.read', grantedBy: 'user-admin' });
    expect(grantsFor(db, 'user-student-1')).toContain('report.evidence.read');
  });

  it('is idempotent — granting twice does not duplicate', async () => {
    const { grantCapability, grantsFor } = await mod();
    const db = await getDb();
    grantCapability({ db, userId: 'user-student-2', capability: 'report.evidence.read', grantedBy: 'user-admin' });
    grantCapability({ db, userId: 'user-student-2', capability: 'report.evidence.read', grantedBy: 'user-admin' });
    expect(grantsFor(db, 'user-student-2').filter(c => c === 'report.evidence.read')).toHaveLength(1);
  });

  it('revokes a capability', async () => {
    const { grantCapability, revokeCapability, grantsFor } = await mod();
    const db = await getDb();
    grantCapability({ db, userId: 'user-student-3', capability: 'report.evidence.read', grantedBy: 'user-admin' });
    revokeCapability({ db, userId: 'user-student-3', capability: 'report.evidence.read' });
    expect(grantsFor(db, 'user-student-3')).not.toContain('report.evidence.read');
  });

  it('excludes expired grants', async () => {
    const { grantCapability, grantsFor } = await mod();
    const db = await getDb();
    grantCapability({
      db, userId: 'user-org-1', capability: 'report.evidence.read',
      grantedBy: 'user-admin', expiresAt: new Date(Date.now() - 1000).toISOString()
    });
    expect(grantsFor(db, 'user-org-1')).not.toContain('report.evidence.read');
  });

  it('refuses an unknown capability', async () => {
    const { grantCapability } = await mod();
    const db = await getDb();
    expect(() => grantCapability({ db, userId: 'user-student-1', capability: 'made.up', grantedBy: 'user-admin' }))
      .toThrow(/unknown capability/i);
  });

  it('refuses to grant a super-only capability', async () => {
    const { grantCapability } = await mod();
    const db = await getDb();
    expect(() => grantCapability({ db, userId: 'user-student-1', capability: 'impersonation.start', grantedBy: 'user-admin' }))
      .toThrow(/cannot be granted/i);
  });

  it('returns a global grant', async () => {
    const { grantCapability, grantsFor } = await mod();
    const db = await getDb();
    const id = await makeUser('u-scope-global');
    grantCapability({
      db, userId: id, capability: 'report.evidence.read',
      grantedBy: 'user-admin', scope: ''
    });
    expect(grantsFor(db, id)).toContain('report.evidence.read');
  });

  it('refuses a scoped grant at write time', async () => {
    const { grantCapability, grantsFor } = await mod();
    const db = await getDb();
    const id = await makeUser('u-scope-refused');
    expect(() => grantCapability({
      db, userId: id, capability: 'event.moderate',
      grantedBy: 'user-admin', scope: 'event-softball'
    })).toThrow(/not enforced/i);
    // And nothing was written, so the refusal is not merely cosmetic.
    expect(grantsFor(db, id)).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) c FROM user_capabilities WHERE user_id = ?').get(id).c).toBe(0);
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
    db.prepare(`
      INSERT INTO user_capabilities (user_id, capability, scope, granted_by, granted_at, expires_at)
      VALUES (?, ?, ?, ?, ?, NULL)
    `).run(id, 'event.moderate', 'event-softball', 'user-admin', new Date().toISOString());

    expect(grantsFor(db, id)).not.toContain('event.moderate');
    expect(grantsFor(db, id)).toEqual([]);
    // The row really is there — the filter, not an absent insert, is what hides it.
    expect(db.prepare('SELECT COUNT(*) c FROM user_capabilities WHERE user_id = ?').get(id).c).toBe(1);
  });

  it('drops grants when the user is deleted', async () => {
    const { grantCapability, grantsFor } = await mod();
    const db = await getDb();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO users (id,name,email,password_hash,grade,role,created_at)
                VALUES ('u-drop','D','drop@test.local','x','N/A','student',?)`).run(now);
    grantCapability({ db, userId: 'u-drop', capability: 'report.evidence.read', grantedBy: 'user-admin' });
    db.prepare("DELETE FROM users WHERE id = 'u-drop'").run();
    expect(grantsFor(db, 'u-drop')).toEqual([]);
  });
});
