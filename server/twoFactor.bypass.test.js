import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateSecret, generateSync } from 'otplib';
import { startTestServer } from './testServer.js';

/**
 * The second factor must actually refuse a wrong code.
 *
 * ── The bypass ──
 *
 * otplib v13's `verifySync` returns an OBJECT, not a boolean:
 *
 *     verifySync({ token: correct, secret })  →  { valid: true,  delta: 0, … }
 *     verifySync({ token: wrong,   secret })  →  { valid: false }
 *
 * Both are truthy. All three call sites wrote
 *
 *     isValid = verifySync({ token, secret });
 *     if (!isValid) throw new Error('Invalid token');
 *
 * so the guard never fired. At `POST /api/auth/login-2fa` that meant **any**
 * six-digit string completed two-factor authentication: an attacker holding a
 * stolen password met no obstacle whatsoever, while the account holder believed
 * they were protected. That is worse than having no second factor at all,
 * because believing you have one is why somebody reuses a password.
 *
 * The same defect let anybody holding a session TURN 2FA OFF (`/api/2fa/disable`)
 * and confirm enrolment with a code the authenticator never showed
 * (`/api/2fa/enable`).
 *
 * ── Why the test is written against the ROUTE ──
 *
 * `cryptoUtils.verifyTotp` has its own unit test, and it would have caught the
 * helper being wrong. It would NOT have caught this, because the defect was that
 * the routes did not use a helper. The property worth pinning is the one a user
 * has: a wrong code does not sign me in.
 */
describe('two-factor authentication refuses a wrong code', () => {
  let srv, db, secret;

  const EMAIL = 'leo.chen28@gmail.com';

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));
    const { encryptSecret } = await import('./cryptoUtils.js');

    /* A real enrolment, stored the way the product stores it: encrypted, with
       the `v1:` envelope. Using a plaintext secret here would test a shape the
       application never writes. */
    secret = generateSecret();
    db.prepare('UPDATE users SET tfa_enabled = 1, tfa_secret = ? WHERE email = ?')
      .run(encryptSecret(secret), EMAIL);
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  /** Sign in far enough to be handed a preauth cookie, and return it. */
  const preauth = async () => {
    const res = await srv.call('POST', '/api/auth/login', { email: EMAIL, password: 'password123' });
    expect(res.body?.require2FA, 'the account is not enrolled, so this proves nothing').toBe(true);
    const raw = res.headers.get('set-cookie') || '';
    const match = raw.match(/wev_preauth=([^;]+)/);
    expect(match, 'no preauth cookie was issued').toBeTruthy();
    return match[1];
  };

  it('hands out a preauth cookie and no session when 2FA is enrolled', async () => {
    const res = await srv.call('POST', '/api/auth/login', { email: EMAIL, password: 'password123' });

    expect(res.body.require2FA).toBe(true);
    /* And crucially NOT a usable session — the password alone must not be
       enough, which is the entire point of the factor. */
    const raw = res.headers.get('set-cookie') || '';
    expect(raw).not.toMatch(/wev_session=/);
  });

  /**
   * The bypass itself. Against the old code this returned 200 with a session.
   */
  it.each(['000000', '111111', '123456', '999999'])(
    'refuses the wrong code %s', async (wrong) => {
      const cookie = await preauth();

      const res = await srv.call('POST', '/api/auth/login-2fa',
        { method: 'totp', token: wrong }, undefined, { Cookie: `wev_preauth=${cookie}` });

      expect(res.status, `${wrong} was accepted as a second factor`).not.toBe(200);
      /* No session may be issued on a refusal. A 401 that still set the cookie
         would satisfy a status assertion and hand over the account anyway. */
      expect(res.headers.get('set-cookie') || '').not.toMatch(/wev_session=/);
    });

  it('refuses a code that is not six digits', async () => {
    const cookie = await preauth();
    for (const junk of ['', 'abcdef', '12345', '1234567', '  ']) {
      const res = await srv.call('POST', '/api/auth/login-2fa',
        { method: 'totp', token: junk }, undefined, { Cookie: `wev_preauth=${cookie}` });
      expect(res.status, `"${junk}" was accepted`).not.toBe(200);
    }
  });

  /**
   * And the correct code still works.
   *
   * Without this the fix could be "refuse everything", which passes every case
   * above and locks every enrolled user out of their own account.
   */
  it('accepts the current code and issues a session', async () => {
    const cookie = await preauth();
    const token = generateSync({ secret });

    const res = await srv.call('POST', '/api/auth/login-2fa',
      { method: 'totp', token }, undefined, { Cookie: `wev_preauth=${cookie}` });

    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie') || '').toMatch(/wev_session=/);
  });
});
