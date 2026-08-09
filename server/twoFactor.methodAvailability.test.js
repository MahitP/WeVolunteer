/**
 * The second factor a sign-in may use is the one the ACCOUNT has.
 *
 * ── The defect ──
 *
 * `POST /api/auth/login-2fa` never consulted `tfa_enabled`. Its TOTP branch
 * verifies against `users.tfa_secret`, and `POST /api/2fa/generate` writes that
 * column while deliberately leaving `tfa_enabled` at 0 so an abandoned enrolment
 * cannot lock anybody out. The two together left every account that had ever
 * OPENED the authenticator setup screen holding a live second factor it had never
 * confirmed:
 *
 *   • invisible — `/api/2fa/status` reports `totp: false` for it;
 *   • unremovable — `/api/2fa/disable` refuses with "2FA is not enabled";
 *   • preferred — accepted here even though `/api/auth/login` had just told the
 *     caller the account's methods were `["email","recovery"]`.
 *
 * Two accounts on the pilot deployment were in exactly that state, both
 * super_admin. Verified before the fix by hand: HTTP 200 and a session.
 *
 * ── And the other half of the same bug ──
 *
 * `recovery` was appended to every method list with the comment "always available
 * as fallback". It is not available to an account holding no recovery codes, and
 * offering it there is worst on the one screen where the user is already shut out
 * of everything else.
 *
 * Both sides are asserted, because hiding a control is a courtesy and refusing the
 * method is the control. The client half lives in src/views/Login.test.jsx.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

// db.js opens its connection at module scope — nothing that reaches it may be
// imported statically here. See the explanation in testServer.js.
let srv, db, encryptSecret, generateSync;

const EMAIL = 'leo.chen28@gmail.com';
const PASSWORD = 'password123';

/** A valid 32-character base32 secret; otplib rejects anything under 16 bytes. */
const SECRET = 'UZ4DHT22AL6CQMULDYSGGT4YT4UU2GMT';

const userId = (email = EMAIL) => db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;

/** Starts a sign-in and returns `{ body, preauth }`. */
async function beginLogin(email = EMAIL) {
  const res = await srv.call('POST', '/api/auth/login', { email, password: PASSWORD });
  const preauth = (res.headers.get('set-cookie') || '').match(/wev_preauth=([^;]+)/)?.[1];
  return { body: res.body, preauth };
}

const submit = (payload, preauth) =>
  srv.call('POST', '/api/auth/login-2fa', payload, undefined,
    preauth ? { Cookie: `wev_preauth=${preauth}` } : {});

beforeAll(async () => {
  ({ startTestServer: srv } = await import('./testServer.js'));
  srv = await (await import('./testServer.js')).startTestServer();
  ({ db } = await import('./db.js'));
  ({ encryptSecret } = await import('./cryptoUtils.js'));
  ({ generateSync } = await import('otplib'));
});

afterAll(async () => { await srv.close(); });

beforeEach(() => {
  db.prepare(`
    UPDATE users
       SET tfa_enabled = 0, tfa_email_enabled = 0, tfa_secret = NULL,
           tfa_last_counter = NULL, email_verified = 1
     WHERE email = ?
  `).run(EMAIL);
  db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(userId());
  db.prepare('DELETE FROM tfa_login_attempts WHERE user_id = ?').run(userId());
  db.prepare('DELETE FROM tfa_email_codes WHERE user_id = ?').run(userId());
});

/** Email 2FA on, and an authenticator secret left behind by an abandoned enrolment. */
function emailOnlyWithAbandonedSecret() {
  db.prepare(`
    UPDATE users
       SET tfa_email_enabled = 1, tfa_enabled = 0, tfa_secret = ?
     WHERE email = ?
  `).run(encryptSecret(SECRET), EMAIL);
}

describe('the methods a sign-in is offered', () => {
  it('does not offer an authenticator that was never confirmed', async () => {
    emailOnlyWithAbandonedSecret();

    const { body } = await beginLogin();
    expect(body.require2FA).toBe(true);
    expect(body.availableMethods).not.toContain('totp');
    expect(body.availableMethods).toContain('email');
  });

  it('does not offer recovery codes to an account holding none', async () => {
    db.prepare('UPDATE users SET tfa_email_enabled = 1 WHERE email = ?').run(EMAIL);

    const { body } = await beginLogin();
    expect(body.availableMethods).toEqual(['email']);
  });

  it('offers recovery codes once the account holds some', async () => {
    db.prepare('UPDATE users SET tfa_email_enabled = 1 WHERE email = ?').run(EMAIL);
    db.prepare(
      "INSERT INTO recovery_codes (id, user_id, code_hash, created_at) VALUES (?, ?, ?, datetime('now'))"
    ).run('rc-availability-test', userId(), '$2a$10$notarealhashbutthatisfineher.eeeeeeeeeeeeeeeeeeeeeeeeeee');

    const { body } = await beginLogin();
    expect(body.availableMethods).toEqual(['email', 'recovery']);
  });
});

describe('the methods a sign-in may actually SPEND', () => {
  it('refuses a TOTP code from an abandoned enrolment on an email-only account', async () => {
    emailOnlyWithAbandonedSecret();
    const { preauth } = await beginLogin();

    /* A genuinely correct code for the stored secret. Before the fix this
       answered 200 with a session; the code being right is the whole point. */
    const res = await submit({ method: 'totp', token: generateSync({ secret: SECRET }) }, preauth);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('method_unavailable');
    expect(res.body.availableMethods).toEqual(['email']);
    // No session was minted.
    expect(res.cookie).toBeFalsy();
  });

  it('refuses a recovery code when the account holds no recovery codes', async () => {
    db.prepare('UPDATE users SET tfa_email_enabled = 1 WHERE email = ?').run(EMAIL);
    const { preauth } = await beginLogin();

    const res = await submit({ method: 'recovery', code: 'ABCDEFGHIJ' }, preauth);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('method_unavailable');
  });

  it('refuses a request that names no method at all', async () => {
    db.prepare('UPDATE users SET tfa_email_enabled = 1 WHERE email = ?').run(EMAIL);
    const { preauth } = await beginLogin();

    const res = await submit({}, preauth);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('method_unavailable');
  });

  it('does not count a refused method as a failed guess', async () => {
    emailOnlyWithAbandonedSecret();
    const { preauth } = await beginLogin();

    await submit({ method: 'totp', token: generateSync({ secret: SECRET }) }, preauth);

    /* The attempt counters bound how many guesses somebody gets. A method that
       was never on offer is not a guess, and charging for it would let a
       confused client burn the budget the real method needs. */
    const attempts = db.prepare(
      'SELECT COALESCE(SUM(attempts), 0) AS n FROM tfa_login_attempts WHERE user_id = ?'
    ).get(userId()).n;
    expect(attempts).toBe(0);
  });

  it('still accepts the method the account DOES hold', async () => {
    emailOnlyWithAbandonedSecret();
    const { preauth } = await beginLogin();

    await srv.call('POST', '/api/auth/login-2fa/email/send', {}, undefined,
      { Cookie: `wev_preauth=${preauth}` });

    /* The plaintext never leaves the send path, so the test reads it the only
       way anything can: by re-hashing candidates is impossible, so instead the
       row is replaced with a known hash. */
    const bcrypt = (await import('bcryptjs')).default;
    const row = db.prepare(
      'SELECT id FROM tfa_email_codes WHERE user_id = ? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1'
    ).get(userId());
    db.prepare('UPDATE tfa_email_codes SET code_hash = ? WHERE id = ?')
      .run(await bcrypt.hash('424242', 10), row.id);

    const res = await submit({ method: 'email', code: '424242' }, preauth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.user.email).toBe(EMAIL);
  });

  it('accepts TOTP normally once the enrolment is actually confirmed', async () => {
    db.prepare('UPDATE users SET tfa_enabled = 1, tfa_secret = ? WHERE email = ?')
      .run(encryptSecret(SECRET), EMAIL);
    const { body, preauth } = await beginLogin();
    expect(body.availableMethods).toContain('totp');

    const res = await submit({ method: 'totp', token: generateSync({ secret: SECRET }) }, preauth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });
});
