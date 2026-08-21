import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, TEST_TOTP_SECRET } from './testServer.js';
import { generateSync } from 'otplib';

/**
 * Nobody may end up locked out of their own account by a control the product
 * offered them.
 *
 * ── Two ways it could happen, both closed here ──
 *
 *   1. `POST /api/2fa/generate` wrote a fresh secret unconditionally while
 *      leaving `tfa_enabled` at 1. A user who already had an authenticator
 *      working and pressed "Set Up Authenticator" again — to add a second
 *      device, or out of curiosity — had their live secret replaced by one they
 *      had not scanned. Their app kept producing codes for a secret the server
 *      no longer held.
 *
 *   2. `POST /api/2fa/disable` clears `tfa_enabled` AND `tfa_email_enabled`, and
 *      had no last-factor check, while `/api/2fa/email/disable` did. So an
 *      administrator could remove both factors in one call and be refused by
 *      `requireCap` on every administrative route immediately afterwards —
 *      walled out of their own platform, with no way back except a shell.
 *
 * The second is the one that matters most on this deployment: there are two
 * owner accounts and no self-service reset, so an owner who does it is locked
 * out until somebody with filesystem access intervenes.
 */
describe('two-factor controls cannot lock somebody out', () => {
  let srv, db;

  const ADMIN = 'admin@example.gov';
  const STUDENT = 'leo.chen@example.com';

  const stepUpHeader = async (token, action) =>
    srv.reauthHeader(await srv.stepUp(token, action));

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  /* ── Re-enrolment must not destroy a working secret ─────────────────────── */

  it('refuses to generate a new secret while one is already enrolled', async () => {
    /* The seeded administrator is enrolled by the harness, which is exactly the
       state this guard is about. */
    const token = await srv.login(ADMIN);
    const before = (await db.prepare('SELECT tfa_secret FROM users WHERE email = ?').get(ADMIN)).tfa_secret;

    const res = await srv.call('POST', '/api/2fa/generate', {}, token,
      await stepUpHeader(token, '2fa.generate'));

    expect(res.status).toBe(409);
    expect(res.body?.code).toBe('already_enrolled');

    /* The assertion that actually matters: the working secret is untouched. A
       409 that had already overwritten it would satisfy a status check and lock
       the person out anyway. */
    expect((await db.prepare('SELECT tfa_secret FROM users WHERE email = ?').get(ADMIN)).tfa_secret)
      .toBe(before);
  });

  /**
   * And a user who is NOT yet enrolled can still set one up.
   *
   * Without this the fix could be "refuse always", which passes the case above
   * and makes the feature impossible to adopt.
   */
  it('still lets an unenrolled account generate a secret', async () => {
    const token = await srv.login(STUDENT);
    await db.prepare('UPDATE users SET tfa_enabled = 0, tfa_secret = NULL WHERE email = ?').run(STUDENT);

    const res = await srv.call('POST', '/api/2fa/generate', {}, token,
      await stepUpHeader(token, '2fa.generate'));

    expect(res.status).toBe(200);
    expect(res.body.secret).toBeTruthy();
    /* Stored encrypted, never as plaintext — the `v1:` envelope from cryptoUtils. */
    expect((await db.prepare('SELECT tfa_secret FROM users WHERE email = ?').get(STUDENT)).tfa_secret)
      .toMatch(/^v1:/);
  });

  /* ── An administrator may not remove their last factor ──────────────────── */

  it('refuses to let an administrator disable their only second factor', async () => {
    const token = await srv.login(ADMIN);

    const res = await srv.call('POST', '/api/2fa/disable',
      { token: generateSync({ secret: TEST_TOTP_SECRET }) }, token,
      await stepUpHeader(token, '2fa.disable'));

    expect(res.status).toBe(403);

    /* Still enrolled — and therefore still able to administer. */
    const row = await db.prepare('SELECT tfa_enabled FROM users WHERE email = ?').get(ADMIN);
    expect(row.tfa_enabled).toBe(1);
  });

  /**
   * The administrator is still able to use the platform afterwards.
   *
   * The point of the refusal is not the status code, it is that the account did
   * not become unusable. Asserted against a real capability-gated route, because
   * `requireCap` is what would have refused them.
   */
  it('leaves the administrator able to reach administrative routes', async () => {
    const token = await srv.login(ADMIN);
    const res = await srv.call('GET', '/api/admin/organizers/pending', undefined, token);
    expect(res.status).toBe(200);
  });

  /**
   * A student — for whom no policy applies — can still turn theirs off.
   *
   * The guard is about roles that MUST carry a factor. Applying it to everybody
   * would make 2FA a one-way door for ordinary volunteers, which is its own
   * reason not to switch it on.
   */
  it('lets an ordinary volunteer disable theirs', async () => {
    const { encryptSecret } = await import('./cryptoUtils.js');
    await db.prepare('UPDATE users SET tfa_enabled = 1, tfa_secret = ? WHERE email = ?')
      .run(encryptSecret(TEST_TOTP_SECRET), STUDENT);

    const token = await srv.login(STUDENT);
    const res = await srv.call('POST', '/api/2fa/disable',
      { token: generateSync({ secret: TEST_TOTP_SECRET }) }, token,
      await stepUpHeader(token, '2fa.disable'));

    expect(res.status).toBe(200);
    expect((await db.prepare('SELECT tfa_enabled FROM users WHERE email = ?').get(STUDENT)).tfa_enabled)
      .toBe(0);
  });
});
