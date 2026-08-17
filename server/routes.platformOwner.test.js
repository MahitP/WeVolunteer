import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * Who runs this platform, named publicly.
 *
 * ── What this endpoint is for ──
 *
 * Every legal document on this deployment says "we" and "the platform", and
 * nothing anywhere named the account behind those words. A parent deciding
 * whether their child should sign up, or a student who wants to complain to
 * somebody real, could not find out without already holding an account — which
 * is backwards, since those are exactly the people without one.
 *
 * ── The two properties worth guarding ──
 *
 * It is answerable signed-out, because of who asks. And it discloses a name, a
 * handle and an avatar and nothing else — no email, no id, no hours — because
 * it answers "who is responsible", not "tell me about this person".
 */

describe('GET /api/platform/owner', () => {
  let srv;
  let db;

  /**
   * The suite seeds no `super_admin`, so every assertion below used to fall
   * through its "a deployment with no owner is a legal state" guard and pass
   * without testing anything. Found by asserting the fixture existed and
   * watching that fail. The owner is created here so the guards are reached.
   *
   * Dated 2099 deliberately, which is the second thing this fixture had to
   * learn. At 2020 the owner was also the EARLIEST account, so `ORDER BY
   * created_at` alone selected them and deleting the `role = 'super_admin'`
   * filter changed nothing — the test that claims the role is what identifies an
   * owner passed with that filter removed. Sorting the owner LAST means the role
   * is the only thing that can pick them out, so breaking it now breaks the
   * test.
   */
  const OWNER_ID = 'user-platform-owner-test';

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));

    await db.prepare(`
      INSERT INTO users (id, email, name, username, grade, password_hash, role, account_status, created_at)
      VALUES (?, ?, ?, ?, 'Adult', 'x', 'super_admin', 'active', '2099-01-01T00:00:00.000Z')
    `).run(OWNER_ID, 'owner-under-test@example.org', 'Ada Owner', 'adaowner');
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  it('has an owner to talk about — the fixture the rest of this file needs', () => {
    /* Guards the vacuity directly: if this account stops existing, the tests
       below stop testing and stay green, which is how they shipped the first
       time. */
    expect(db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'super_admin' AND account_status = 'active'").get().n)
      .toBeGreaterThan(0);
  });

  const fetchOwner = (session) => srv.call('GET', '/api/platform/owner', undefined, session);

  it('answers without a session at all', async () => {
    /* The whole point. A parent reading the Legal Center has no account, and an
       endpoint that made them sign in to learn who runs the place would defeat
       the reason the page exists. */
    const res = await fetchOwner();

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toHaveProperty('owner');
  });

  it('names an account that actually holds the owner role', async () => {
    const res = await fetchOwner();
    expect(res.body.owner, 'the fixture owner should be named').toBeTruthy();

    const row = await db.prepare('SELECT role, account_status FROM users WHERE username = ?')
      .get(res.body.owner.username);
    expect(row?.role, 'a non-owner was presented as the owner').toBe('super_admin');
    expect(row?.account_status).toBe('active');
  });

  it('discloses only identity, never contact details or history', async () => {
    /**
     * The leak this guards. Widening the SELECT is a one-word edit, and the
     * fields immediately either side of the ones wanted are an email address and
     * a service record — on a route with no authentication in front of it.
     */
    const res = await fetchOwner();
    expect(res.body.owner).toBeTruthy();

    expect(Object.keys(res.body.owner).sort()).toEqual(
      ['avatar', 'avatarColor', 'name', 'profilePictureUrl', 'username'].sort(),
    );
    const serialised = JSON.stringify(res.body.owner);
    expect(serialised).not.toMatch(/@[\w.-]+\.\w+/); // no email address
    expect(serialised).not.toMatch(/"id"|password|token|hours/i);
  });

  it('never presents a suspended or deleted account as the owner', async () => {
    /* An owner whose account has been closed is not who to complain to, and
       publishing their name on the front of the platform would be worse than
       publishing nobody's. */
    const owner = await db.prepare(
      "SELECT id, account_status FROM users WHERE role = 'super_admin' AND account_status = 'active' ORDER BY created_at ASC, id ASC LIMIT 1"
    ).get();
    if (!owner) return;

    await db.prepare("UPDATE users SET account_status = 'deleted' WHERE id = ?").run(owner.id);
    try {
      const res = await fetchOwner();
      const named = res.body.owner?.username;
      if (named) {
        const row = await db.prepare('SELECT id, account_status FROM users WHERE username = ?').get(named);
        expect(row.account_status).toBe('active');
        expect(row.id).not.toBe(owner.id);
      }
    } finally {
      await db.prepare("UPDATE users SET account_status = 'active' WHERE id = ?").run(owner.id);
    }
  });

  it('answers the same to everyone, signed in or not', async () => {
    /* Nothing here is viewer-dependent. If these ever diverge, something has
       started tailoring a public transparency answer per caller. */
    const anon = await fetchOwner();
    const student = await srv.login('leo.chen@example.com');
    const signedIn = await fetchOwner(student);

    expect(signedIn.body).toEqual(anon.body);
  });
});
