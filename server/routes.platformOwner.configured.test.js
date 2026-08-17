import { describe, it, expect, beforeAll, afterAll } from 'vitest';

/**
 * The configured owner wins, and the service account never stands in for a person.
 *
 * ── What this deployment actually looks like ──
 *
 * There are two `super_admin` accounts: the person who runs the platform, and an
 * internal WeVolunteer service account. They were created in the same seeding
 * run, so their `created_at` values are IDENTICAL, and the "earliest owner"
 * fallback therefore decays into a tiebreak on the id — which is to say, into
 * chance.
 *
 * That is fine as a last resort on a deployment that has configured nothing. It
 * is not fine here, because the losing outcome is a public page telling a parent
 * that WeVolunteer is run by an account called "WeVolunteer".
 *
 * ── The two properties ──
 *
 * `PLATFORM_OWNER_USERNAME` decides it, and it decides it ALONE: when the
 * variable is set the fallback does not run at all, so a typo answers "nobody"
 * rather than quietly naming whoever sorted first. Every fixture below is built
 * so the fallback would pick the SERVICE account — that is what makes these
 * tests capable of failing.
 *
 * ── The env var is set before the server is imported ──
 *
 * `server/config.js` reads `process.env` at module load, and ESM hoists static
 * imports above the module body. So `startTestServer` is imported dynamically
 * inside `beforeAll`, after the variable is set. A static import here would read
 * the variable before it existed and every assertion would test the fallback.
 */

const CONFIGURED = 'mahit';

/** The person. Deliberately created LAST, so the fallback would not pick them. */
const PERSON = {
  id: 'user-owner-person-test',
  email: 'owner-person@example.org',
  name: 'Mahit Pulavarthi',
  username: 'Mahit',           // capitalised on purpose: the lookup must fold case
  created: '2099-01-01T00:00:00.000Z',
};

/** The internal service account. Created FIRST, so the fallback WOULD pick it. */
const SERVICE = {
  id: 'user-owner-service-test',
  email: 'owner-service@example.org',
  name: 'WeVolunteer',
  username: 'wevolunteer',
  created: '2000-01-01T00:00:00.000Z',
};

describe('the publicly named platform owner', () => {
  let srv;
  let db;

  beforeAll(async () => {
    process.env.PLATFORM_OWNER_USERNAME = CONFIGURED;
    const { startTestServer } = await import('./testServer.js');
    srv = await startTestServer();
    ({ db } = await import('./db.js'));

    const insert = db.prepare(`
      INSERT INTO users (id, email, name, username, grade, password_hash, role, account_status, created_at)
      VALUES (?, ?, ?, ?, 'Adult', 'x', 'super_admin', 'active', ?)
    `);
    for (const a of [SERVICE, PERSON]) await insert.run(a.id, a.email, a.name, a.username, a.created);
  }, 60000);

  afterAll(async () => {
    delete process.env.PLATFORM_OWNER_USERNAME;
    await srv?.close();
  });

  const owner = async () => (await srv.call('GET', '/api/platform/owner')).body.owner;

  it('has both owner accounts, with the service account sorting first', async () => {
    /**
     * The vacuity guard, and the whole basis of this file. If the service
     * account stopped sorting earlier, the fallback and the configured answer
     * would agree and every test below would pass without distinguishing them.
     */
    const rows = (await db.prepare(
      "SELECT username FROM users WHERE role = 'super_admin' AND account_status = 'active' ORDER BY created_at ASC, id ASC"
    ).all()).map(r => r.username);

    expect(rows).toContain(SERVICE.username);
    expect(rows).toContain(PERSON.username);
    expect(rows[0], 'the fallback must prefer the SERVICE account for these tests to mean anything')
      .toBe(SERVICE.username);
  });

  it('names the configured person, not the account the fallback would pick', async () => {
    const o = await owner();
    expect(o?.username).toBe(PERSON.username);
    expect(o?.name).toBe('Mahit Pulavarthi');
  });

  it('folds case, so "mahit" resolves an account stored as "Mahit"', async () => {
    /* The configured value and the stored username genuinely differ in case on
       this deployment. If the comparison were exact, production would name
       nobody and the warning would be the only sign. */
    expect(CONFIGURED).not.toBe(PERSON.username);
    expect((await owner())?.username).toBe(PERSON.username);
  });

  it('never presents the internal service account as the platform owner', async () => {
    const o = await owner();
    expect(o?.username).not.toBe(SERVICE.username);
    expect(o?.name).not.toBe('WeVolunteer');
  });

  it('identifies the owner by ROLE and configuration, never by a personal name', async () => {
    /**
     * The rule the product asked for in as many words. Renaming the person must
     * not change who is selected — only their role and the configured username
     * may decide it. A serializer that matched "Mahit" would break here.
     */
    await db.prepare('UPDATE users SET name = ? WHERE id = ?').run('Someone Else Entirely', PERSON.id);
    try {
      const o = await owner();
      expect(o?.username).toBe(PERSON.username);
      expect(o?.name).toBe('Someone Else Entirely');
    } finally {
      await db.prepare('UPDATE users SET name = ? WHERE id = ?').run(PERSON.name, PERSON.id);
    }
  });

  it('answers nobody rather than the wrong body when the configured name does not resolve', async () => {
    /**
     * The reason the fallback is not reachable once the variable is set. A typo
     * in production would otherwise have been answered by naming whichever
     * account sorted first — the service account — on a public page, with
     * nothing anywhere reporting a fault.
     */
    await db.prepare('UPDATE users SET username = ? WHERE id = ?').run('renamed-away', PERSON.id);
    try {
      expect(await owner(), 'a missed configured username must not fall back').toBeNull();
    } finally {
      await db.prepare('UPDATE users SET username = ? WHERE id = ?').run(PERSON.username, PERSON.id);
    }
  });

  it('cannot be pointed at an account that does not hold the role', async () => {
    /* Configuration chooses BETWEEN owners; it cannot create one. */
    await db.prepare("UPDATE users SET role = 'student' WHERE id = ?").run(PERSON.id);
    try {
      const o = await owner();
      expect(o?.username, 'a non-owner was named because configuration pointed at them')
        .not.toBe(PERSON.username);
      expect(o, 'and it must not silently fall back to the service account either').toBeNull();
    } finally {
      await db.prepare("UPDATE users SET role = 'super_admin' WHERE id = ?").run(PERSON.id);
    }
  });

  it('stops naming an owner whose account is closed', async () => {
    await db.prepare("UPDATE users SET account_status = 'deleted' WHERE id = ?").run(PERSON.id);
    try {
      expect(await owner()).toBeNull();
    } finally {
      await db.prepare("UPDATE users SET account_status = 'active' WHERE id = ?").run(PERSON.id);
    }
  });
});
