import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * A second-factor code is spent ONCE, even when it is presented several times
 * at once.
 *
 * ── What this file is defending ──
 *
 * `POST /api/auth/login-2fa` verifies a recovery code and an emailed code with
 * `await bcrypt.compare`, and that await is the whole problem: the SELECT that
 * finds the code and the write that spends it sat on either side of it. Node
 * runs each handler to its first await and then picks up the next request, so N
 * submissions of the SAME code all read it as unspent, all matched it, and all
 * completed — the delete/update landing N times with nobody asking whether THIS
 * request was the one that did it.
 *
 * It is not a narrow window. An extreme-usage run found eight independent
 * pre-auth grants presenting one recovery code and receiving five sessions, and
 * four parallel submissions of one emailed code receiving four. The account was
 * then told a single code had been spent, which is the part that makes it worse
 * than an accounting error: "1 code used, 9 remaining" is exactly what a user
 * checks after a suspicious sign-in, and it was under-reporting.
 *
 * The fix makes the WRITE the claim — `DELETE … WHERE id = ?` and
 * `UPDATE … WHERE id = ? AND used_at IS NULL` — and reads `changes` to decide
 * who won. SQLite applies those atomically, so exactly one caller can ever see
 * 1, and every other caller gets the 401 a replayed code has always got.
 *
 * ── Why the codes are inserted rather than enrolled ──
 *
 * Full TOTP enrolment hashes ten codes at bcrypt cost 10 before returning, and
 * this file needs several accounts. The rows written here are exactly the rows
 * enrolment writes; `twoFactor.recoveryLifecycle.test.js` covers the enrolment
 * path itself.
 */
describe('a second-factor code cannot be spent twice, even concurrently', () => {
  let srv, db, bcrypt, encryptSecret, mail;

  const PW = 'Password123';
  /* 32 base32 characters: otplib v13 refuses anything shorter than 16 bytes. */
  const TOTP_SECRET = 'UZ4DHT22AL6CQMULDYSGGT4YT4UU2GMT';

  let seq = 0;
  const account = () => {
    seq += 1;
    return {
      email: `tfa.race.${seq}@example.org`,
      password: PW,
      name: 'Race Subject',
      role: 'student',
      grade: '9',
      school: 'Test High School',
      username: `tfa_race_${seq}`,
    };
  };

  /** Enrols an authenticator and a set of recovery codes, by direct write. */
  const enrol = async (userId, codes) => {
    await db.prepare('UPDATE users SET tfa_enabled = 1, tfa_secret = ? WHERE id = ?')
      .run(encryptSecret(TOTP_SECRET), userId);
    const ins = db.prepare(
      "INSERT INTO recovery_codes (id, user_id, code_hash, created_at) VALUES (?, ?, ?, datetime('now'))"
    );
    /* Sequential, not `forEach`: an async callback there is neither awaited nor
       collected, so the codes would still be arriving when the race starts. */
    for (const [i, c] of codes.entries()) {
      await ins.run(`rc-${userId}-${i}`, userId, bcrypt.hashSync(c, 10));
    }
  };

  /** One sign-in as far as the pre-auth grant, returning the cookie header. */
  const preauth = async (email) => {
    const first = await srv.call('POST', '/api/auth/login', { email, password: PW });
    expect(first.body?.require2FA, JSON.stringify(first.body)).toBe(true);
    const cookie = (first.headers.get('set-cookie') || '').match(/wev_preauth=([^;]+)/)?.[1];
    expect(cookie, 'no preauth cookie issued').toBeTruthy();
    return `wev_preauth=${cookie}`;
  };

  const codeCount = async userId => (await db.prepare(
    'SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ?'
  ).get(userId)).n;

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));
    bcrypt = (await import('bcryptjs')).default;
    ({ encryptSecret } = await import('./cryptoUtils.js'));
    mail = await import('./email.js');
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  /**
   * Independent grants, because that is the case that actually reproduced.
   *
   * Each grant is established BEFORE the burst, so all eight sockets exist and
   * the submissions genuinely overlap. Fresh connections stagger themselves on
   * the TCP handshake, which is enough to hide the window — the first draft of
   * this test passed against the unfixed server for exactly that reason.
   */
  it('grants one session when eight independent pre-auth grants spend one recovery code', async () => {
    const { user } = await srv.signupConfirmed(account());
    const CODE = 'ZZZZ9999YYYY';
    await enrol(user.id, [CODE]);

    const grants = [];
    for (let i = 0; i < 8; i++) grants.push(await preauth(user.email));

    const attempts = await Promise.all(grants.map(cookie =>
      srv.call('POST', '/api/auth/login-2fa', { method: 'recovery', code: CODE }, undefined, { Cookie: cookie })
    ));

    const accepted = attempts.filter(a => a.status === 200);
    expect(
      accepted.length,
      `statuses: ${attempts.map(a => a.status).join(',')}`
    ).toBe(1);
    /**
     * The seven losers are refused, but not all with the same status, and that
     * is correct rather than sloppy. A request that lost the DELETE race is a
     * 401 ("Invalid code."); one that arrives after the row is gone finds the
     * account holding no recovery codes at all, so `enabledSecondFactors` stops
     * offering the method and it is refused earlier with 400
     * `method_unavailable`. Both are honest answers to a spent credential; what
     * matters here is that neither is a session.
     */
    expect(attempts.filter(a => a.status === 200).length).toBe(1);
    expect(attempts.every(a => a.status === 200 || (a.status >= 400 && a.status < 500))).toBe(true);
    expect(await codeCount(user.id)).toBe(0);

    /* The one that won reports the spend truthfully. */
    expect(accepted[0].body.recoveryCodesRemaining).toBe(0);
  }, 30_000);

  /** The same burst against one grant, which the per-token ceiling also bounds. */
  it('grants one session when five parallel submissions share a pre-auth grant', async () => {
    const { user } = await srv.signupConfirmed(account());
    const CODES = ['AAAA1111BBBB', 'CCCC2222DDDD', 'EEEE3333FFFF'];
    await enrol(user.id, CODES);

    const cookie = await preauth(user.email);
    const attempts = await Promise.all(Array.from({ length: 5 }, () =>
      srv.call('POST', '/api/auth/login-2fa', { method: 'recovery', code: CODES[0] }, undefined, { Cookie: cookie })
    ));

    expect(
      attempts.filter(a => a.status === 200).length,
      `statuses: ${attempts.map(a => a.status).join(',')}`
    ).toBe(1);
    /* Two untouched codes: the burst spent the one it was given, and no more. */
    expect(await codeCount(user.id)).toBe(2);
  }, 30_000);

  /**
   * The emailed code, which had the same shape and the worse result: four
   * parallel submissions produced four sessions.
   */
  it('grants one session when four parallel submissions spend one emailed code', async () => {
    const { user } = await srv.signupConfirmed(account());
    await db.prepare('UPDATE users SET tfa_email_enabled = 1, email_verified = 1 WHERE id = ?').run(user.id);

    const cookie = await preauth(user.email);

    /* The plaintext exists only in the delivered message, so it is read from
       the transport rather than guessed — the product's own test seam. */
    const sent = [];
    mail.setMailTransportForTests({ sendMail: async m => { sent.push(m); return { messageId: 'test' }; } });
    const send = await srv.call('POST', '/api/auth/login-2fa/email/send', {}, undefined, { Cookie: cookie });
    mail.setMailTransportForTests(null);
    expect(send.status, JSON.stringify(send.body)).toBe(200);

    const code = sent.map(m => (`${m.text || ''}${m.html || ''}`.match(/\b(\d{6})\b/) || [])[1]).filter(Boolean).pop();
    expect(code, 'no six-digit code in the delivered message').toBeTruthy();

    const attempts = await Promise.all(Array.from({ length: 4 }, () =>
      srv.call('POST', '/api/auth/login-2fa', { method: 'email', code }, undefined, { Cookie: cookie })
    ));

    expect(
      attempts.filter(a => a.status === 200).length,
      `statuses: ${attempts.map(a => a.status).join(',')}`
    ).toBe(1);

    const row = await db.prepare(
      'SELECT used_at FROM tfa_email_codes WHERE user_id = ? ORDER BY rowid DESC LIMIT 1'
    ).get(user.id);
    expect(row.used_at).toBeTruthy();
  }, 30_000);

  /**
   * Losing the race must not cost the honest user their remaining codes: a
   * refused duplicate spends nothing beyond the one code that was presented.
   */
  it('a lost race consumes no additional code', async () => {
    const { user } = await srv.signupConfirmed(account());
    const CODES = ['LOSE1111AAAA', 'LOSE2222BBBB', 'LOSE3333CCCC', 'LOSE4444DDDD'];
    await enrol(user.id, CODES);

    const grants = [];
    for (let i = 0; i < 6; i++) grants.push(await preauth(user.email));
    await Promise.all(grants.map(cookie =>
      srv.call('POST', '/api/auth/login-2fa', { method: 'recovery', code: CODES[0] }, undefined, { Cookie: cookie })
    ));

    expect(await codeCount(user.id)).toBe(3);
  }, 30_000);
});
