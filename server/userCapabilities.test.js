import { describe, it, expect, beforeAll, afterAll } from 'vitest';

let srv;
beforeAll(async () => {
  const { startTestServer } = await import('./testServer.js');
  srv = await startTestServer();
}, 60000);
afterAll(async () => { await srv?.close(); });

const mod = () => import('./userCapabilities.js');
const getDb = async () => (await import('./db.js')).db;

describe('user capability grants', () => {
  it('grants and reads back a capability', async () => {
    const { grantCapability, grantsFor } = await mod();
    const db = await getDb();
    grantCapability({ db, userId: 'user-student-1', capability: 'service.verify.external', grantedBy: 'user-admin' });
    expect(grantsFor(db, 'user-student-1')).toContain('service.verify.external');
  });

  it('is idempotent — granting twice does not duplicate', async () => {
    const { grantCapability, grantsFor } = await mod();
    const db = await getDb();
    grantCapability({ db, userId: 'user-student-2', capability: 'service.verify.external', grantedBy: 'user-admin' });
    grantCapability({ db, userId: 'user-student-2', capability: 'service.verify.external', grantedBy: 'user-admin' });
    expect(grantsFor(db, 'user-student-2').filter(c => c === 'service.verify.external')).toHaveLength(1);
  });

  it('revokes a capability', async () => {
    const { grantCapability, revokeCapability, grantsFor } = await mod();
    const db = await getDb();
    grantCapability({ db, userId: 'user-student-3', capability: 'service.verify.external', grantedBy: 'user-admin' });
    revokeCapability({ db, userId: 'user-student-3', capability: 'service.verify.external' });
    expect(grantsFor(db, 'user-student-3')).not.toContain('service.verify.external');
  });

  it('excludes expired grants', async () => {
    const { grantCapability, grantsFor } = await mod();
    const db = await getDb();
    grantCapability({
      db, userId: 'user-org-1', capability: 'service.verify.external',
      grantedBy: 'user-admin', expiresAt: new Date(Date.now() - 1000).toISOString()
    });
    expect(grantsFor(db, 'user-org-1')).not.toContain('service.verify.external');
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

  it('drops grants when the user is deleted', async () => {
    const { grantCapability, grantsFor } = await mod();
    const db = await getDb();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO users (id,name,email,password_hash,grade,role,created_at)
                VALUES ('u-drop','D','drop@test.local','x','N/A','student',?)`).run(now);
    grantCapability({ db, userId: 'u-drop', capability: 'service.verify.external', grantedBy: 'user-admin' });
    db.prepare("DELETE FROM users WHERE id = 'u-drop'").run();
    expect(grantsFor(db, 'u-drop')).toEqual([]);
  });
});
