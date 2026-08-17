/**
 * No ordinary second-factor failure may answer 500.
 *
 * ── The bug this file exists for ──
 *
 * "Authenticator 2FA produces Internal Server Error." A *correct* code answered
 * 500 while a *wrong* one answered a clean 401 — the most confusing shape a
 * sign-in failure can take, because every instinct says the code is the problem.
 *
 * The cause was that the accepted TOTP time step is written to
 * `users.tfa_last_counter`, and that write was the only statement in the whole
 * TOTP login path. On a database whose schema was behind migration 029 the
 * column did not exist, the write threw, and the handler's outer catch turned it
 * into a generic 500 — but only ever on the path where the code was right, since
 * a wrong code returns before reaching it.
 *
 * Two more 500s were found in the same handler while probing: `code.trim()` was
 * called on the raw request body, so a non-string `code` threw a TypeError, and
 * it did so BEFORE the failure counter was bumped, so it was not rate-limited
 * either.
 *
 * The assertions below are therefore about STATUS CODES rather than about
 * messages. A user-facing failure gets a 4xx and a sentence they can act on; a
 * genuine server fault is still logged, but no normal path produces one.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, TEST_TOTP_SECRET, freshTotp, enrolTwoFactor } from './testServer.js';

const EMAIL = 'admin@example.gov';
const PASSWORD = 'password123';

describe('the second-factor step never answers 500 for a user-facing failure', () => {
  let srv, db;

  /** Signs in far enough to hold a pre-auth grant, and returns its cookie. */
  async function beginLogin() {
    const res = await srv.call('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.require2FA).toBe(true);
    const setCookie = res.headers.get('set-cookie') || '';
    const preauth = /wev_preauth=([^;]+)/.exec(setCookie)?.[1];
    expect(preauth).toBeTruthy();
    return preauth;
  }

  const submit = (preauth, body) => srv.call(
    'POST', '/api/auth/login-2fa', body, undefined,
    { Cookie: `wev_preauth=${preauth}` }
  );

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));
    await enrolTwoFactor(db, EMAIL);
    await db.prepare('UPDATE users SET email_verified = 1 WHERE email = ?').run(EMAIL);

    /* `enrolTwoFactor` sets up the authenticator only. Recovery codes are a
       separate enrolment, and without at least one stored row the method is
       correctly NOT offered — which is the behaviour utils.js documents. */
    const bcrypt = (await import('bcryptjs')).default;
    const userId = (await db.prepare('SELECT id FROM users WHERE email = ?').get(EMAIL)).id;
    for (const plain of ['SEEDCODEAAAA', 'SEEDCODEBBBB']) {
      await db.prepare(`
        INSERT INTO recovery_codes (id, user_id, code_hash, created_at)
        VALUES (?, ?, ?, ?)
      `).run(`rc-seed-${plain}`, userId, bcrypt.hashSync(plain, 10), new Date().toISOString());
    }
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  describe('the authenticator path', () => {
    it('accepts a valid code', async () => {
      const preauth = await beginLogin();
      const res = await submit(preauth, { method: 'totp', token: await freshTotp() });
      expect(res.status).toBe(200);
    });

    it('refuses a wrong code with 401, not 500', async () => {
      const preauth = await beginLogin();
      const res = await submit(preauth, { method: 'totp', token: '000000' });
      expect(res.status).toBe(401);
    });

    /**
     * The headline regression. With the replay column absent, the accepted code
     * cannot be recorded as spent — so the sign-in is REFUSED (a code that
     * cannot be made single-use must not complete one) but the refusal is a
     * named 503 with a route out, not an unexplained 500.
     */
    it('does not 500 when the replay high-water mark cannot be stored', async () => {
      const preauth = await beginLogin();
      const token = await freshTotp();
      /* Clear the high-water mark so the replay guard cannot reject this token
         first — the condition under test is the WRITE failing, which is only
         reached once the code itself has been accepted. */
      await db.prepare('UPDATE users SET tfa_last_counter = NULL WHERE email = ?').run(EMAIL);

      /* Simulate the broken-schema condition without rebuilding `users`: a
         trigger that raises on the one UPDATE this path performs. */
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS block_counter_write
        BEFORE UPDATE OF tfa_last_counter ON users
        BEGIN SELECT RAISE(ABORT, 'simulated missing column'); END
      `);
      try {
        const res = await submit(preauth, { method: 'totp', token });
        expect(res.status).not.toBe(500);
        expect(res.status).toBe(503);
        expect(res.body.code).toBe('verification_unavailable');
        /* And it names a way in that does not depend on the broken path. */
        expect(res.body.availableMethods).toContain('recovery');
      } finally {
        db.exec('DROP TRIGGER IF EXISTS block_counter_write');
      }
    });

    it('still works once the condition clears', async () => {
      await db.prepare('UPDATE users SET tfa_last_counter = NULL WHERE email = ?').run(EMAIL);
      const preauth = await beginLogin();
      const res = await submit(preauth, { method: 'totp', token: await freshTotp() });
      expect(res.status).toBe(200);
    });
  });

  /**
   * A wrong TYPE is a malformed request, and malformed requests are 400s. Each
   * of these produced a TypeError and a 500 before the fix — and did so without
   * touching the attempt counter, so they were not rate-limited.
   */
  describe('a non-string code is a 400, not a 500', () => {
    const NOT_STRINGS = [123456, ['a'], { a: 1 }, true];

    for (const value of NOT_STRINGS) {
      it(`refuses ${JSON.stringify(value)} in the recovery branch`, async () => {
        const preauth = await beginLogin();
        const res = await submit(preauth, { method: 'recovery', code: value });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('malformed_code');
      });

      it(`refuses ${JSON.stringify(value)} in the email branch`, async () => {
        const preauth = await beginLogin();
        const res = await submit(preauth, { method: 'email', code: value });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('malformed_code');
      });
    }

    it('refuses a non-string authenticator token', async () => {
      const preauth = await beginLogin();
      const res = await submit(preauth, { method: 'totp', token: 123456 });
      expect(res.status).toBe(400);
      expect(res.body.field).toBe('token');
    });

    /**
     * An empty submission is malformed, and must not spend one of the twenty
     * attempts an account gets in fifteen minutes.
     */
    it.each([['recovery', 'code'], ['email', 'code'], ['totp', 'token']])(
      'refuses an empty %s submission as malformed, not as a wrong guess', async (method, field) => {
        const userId = (await db.prepare('SELECT id FROM users WHERE email = ?').get(EMAIL)).id;
        await db.prepare('DELETE FROM tfa_login_attempts WHERE user_id = ?').run(userId);

        const res = await submit(await beginLogin(), { method, [field]: '   ' });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('malformed_code');

        const spent = (await db.prepare(
          'SELECT COALESCE(SUM(attempts), 0) AS n FROM tfa_login_attempts WHERE user_id = ?'
        ).get(userId)).n;
        expect(spent, 'an empty submission must cost no attempts').toBe(0);
      });

    it('still accepts a well-formed string that is simply wrong', async () => {
      const preauth = await beginLogin();
      const res = await submit(preauth, { method: 'recovery', code: 'NOTACODE' });
      expect(res.status).toBe(401);
    });
  });

  describe('recovery codes are a genuine last resort', () => {
    const addRecoveryCode = async (plain) => {
      const bcrypt = (await import('bcryptjs')).default;
      const userId = (await db.prepare('SELECT id FROM users WHERE email = ?').get(EMAIL)).id;
      await db.prepare(`
        INSERT INTO recovery_codes (id, user_id, code_hash, created_at)
        VALUES (?, ?, ?, ?)
      `).run(`rc-${Math.random().toString(36).slice(2)}`, userId,
        bcrypt.hashSync(plain, 10), new Date().toISOString());
      return userId;
    };

    const remaining = async () => (await db.prepare(
      'SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = (SELECT id FROM users WHERE email = ?)'
    ).get(EMAIL)).n;

    it('is offered even when the authenticator is the only enrolled factor', async () => {
      const res = await srv.call('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD });
      expect(res.body.availableMethods).toContain('recovery');
    });

    /**
     * The hierarchy the product promises: a recovery code works when the
     * authenticator and the email address are BOTH out of reach. Nothing about
     * the other two factors is consulted on this path, which is exactly what
     * makes it a last resort rather than a third convenience.
     */
    it('works with the authenticator broken and the address unconfirmed', async () => {
      await addRecoveryCode('LASTRESORT01');
      await db.prepare('UPDATE users SET email_verified = 0 WHERE email = ?').run(EMAIL);
      const login = await srv.call('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD });
      expect(login.body.availableMethods).not.toContain('email');
      expect(login.body.availableMethods).toContain('recovery');

      const res = await submit(await beginLogin(), { method: 'recovery', code: 'LASTRESORT01' });
      expect(res.status).toBe(200);
      await db.prepare('UPDATE users SET email_verified = 1 WHERE email = ?').run(EMAIL);
    });

    it('accepts a real code, and refuses the same one twice', async () => {
      const plain = 'TESTRECOVERY1';
      await addRecoveryCode(plain);
      const before = await remaining();

      const first = await submit(await beginLogin(), { method: 'recovery', code: plain });
      expect(first.status).toBe(200);
      /* The session transition, and the code is CONSUMED — one fewer left. */
      expect((first.headers.get('set-cookie') || '')).toContain('wev_session=');
      expect(await remaining()).toBe(before - 1);

      const second = await submit(await beginLogin(), { method: 'recovery', code: plain });
      expect(second.status).toBe(401);
      expect(await remaining()).toBe(before - 1);
    });

    /* Case and surrounding whitespace are a transcription artefact, not a
       different code — somebody is reading these off a printout or a photograph. */
    it('accepts a code typed in the wrong case, with spaces around it', async () => {
      await addRecoveryCode('CASEINSENSITIVE');
      const res = await submit(await beginLogin(), { method: 'recovery', code: '  caseinsensitive  ' });
      expect(res.status).toBe(200);
    });

    /**
     * When the last code is spent, recovery stops being offered — because
     * `enabledSecondFactors` counts stored rows. An account in that state is not
     * locked out (it still has its authenticator); it has simply used up the
     * fallback, and saying so beats offering a method with nothing behind it.
     */
    it('stops offering recovery once every code is spent', async () => {
      const userId = (await db.prepare('SELECT id FROM users WHERE email = ?').get(EMAIL)).id;
      const saved = await db.prepare('SELECT * FROM recovery_codes WHERE user_id = ?').all(userId);
      await db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(userId);
      try {
        const login = await srv.call('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD });
        expect(login.body.availableMethods).not.toContain('recovery');

        /* And the route refuses the method rather than answering "Invalid code",
           which is the message that sends somebody round a loop retyping a code
           that is correct. */
        const res = await submit(await beginLogin(), { method: 'recovery', code: 'ANYTHINGATALL' });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('method_unavailable');
      } finally {
        for (const r of saved) {
          await db.prepare(`
            INSERT INTO recovery_codes (id, user_id, code_hash, created_at) VALUES (?, ?, ?, ?)
          `).run(r.id, r.user_id, r.code_hash, r.created_at);
        }
      }
    });
  });

  /**
   * The pre-auth grant itself, which is the thing standing between a stolen
   * password and a session.
   */
  describe('the pre-auth grant', () => {
    it('refuses the submit route outright with no grant at all', async () => {
      const res = await srv.call('POST', '/api/auth/login-2fa', { method: 'totp', token: '000000' });
      expect(res.status).toBe(401);
      expect(res.status).not.toBe(500);
    });

    it('refuses a forged or corrupted grant with 401, not 500', async () => {
      for (const bogus of ['not-a-jwt', 'a.b.c', '']) {
        const res = await submit(bogus, { method: 'totp', token: '000000' });
        expect(res.status).toBe(401);
      }
    });

    /**
     * A full SESSION cookie is not a pre-auth grant. They are both JWTs signed
     * with the same secret, so the only thing separating them is the `preauth`
     * claim this route checks — which is precisely the confusion that would let
     * an ordinary session be replayed into the second-factor step.
     */
    it('refuses a real session token presented as a pre-auth grant', async () => {
      const jwt = (await import('jsonwebtoken')).default;
      const { JWT_SECRET } = await import('./config.js');
      const userId = (await db.prepare('SELECT id FROM users WHERE email = ?').get(EMAIL)).id;
      const session = jwt.sign({ id: userId, jti: 'x' }, JWT_SECRET, { expiresIn: '7d' });

      const res = await submit(session, { method: 'totp', token: await freshTotp() });
      expect(res.status).toBe(401);
    });

    /**
     * The grant is spent by a successful sign-in: the cookie is cleared and a
     * session replaces it.
     *
     * Driven through a RECOVERY code rather than the authenticator, deliberately.
     * The claim under test is about the cookie, and a TOTP code is bound to a
     * 30-second step that the replay guard refuses to accept twice — so under a
     * loaded full-suite run the token can be minted in step N and arrive in step
     * N+1, failing this test for a reason that has nothing to do with what it
     * asserts. A recovery code has no such coupling.
     */
    it('clears the grant on success', async () => {
      const bcrypt = (await import('bcryptjs')).default;
      const userId = (await db.prepare('SELECT id FROM users WHERE email = ?').get(EMAIL)).id;
      await db.prepare(`
        INSERT INTO recovery_codes (id, user_id, code_hash, created_at) VALUES (?, ?, ?, ?)
      `).run(`rc-clear-${Math.random().toString(36).slice(2)}`, userId,
        bcrypt.hashSync('GRANTCLEAR01', 10), new Date().toISOString());

      const ok = await submit(await beginLogin(), { method: 'recovery', code: 'GRANTCLEAR01' });
      expect(ok.status).toBe(200);
      const cleared = ok.headers.get('set-cookie') || '';
      expect(cleared).toMatch(/wev_preauth=;|wev_preauth=deleted|Max-Age=0|Expires=Thu, 01 Jan 1970/);
      expect(cleared).toContain('wev_session=');
    });

    /**
     * Guessing is bounded per ACCOUNT, not merely per grant — otherwise an
     * attacker holding the password just requests a fresh grant with a fresh
     * counter and keeps going. The refusal is a 429 and never a 500.
     */
    /**
     * Seeded rather than looped.
     *
     * The first version of this guessed 25 times and waited for a 429, which made
     * it a timing test: every iteration is two HTTP round trips plus a bcrypt
     * compare, and under a loaded full-suite run it could exhaust the loop
     * without the per-account window behaving as it does in isolation. A test
     * that passes alone and fails in the suite is a defect in the test —
     * docs/ENGINEERING_GUIDE.md is explicit that flakiness is not a re-run.
     *
     * What matters is the RULE: attempts are summed across grants for one
     * account, so a fresh grant does not reset the budget. Seeding the ledger to
     * one below the ceiling asserts exactly that, in two requests, with no clock
     * in it.
     */
    it('throttles sustained guessing across fresh grants', async () => {
      const userId = (await db.prepare('SELECT id FROM users WHERE email = ?').get(EMAIL)).id;
      const clear = async () => await db.prepare('DELETE FROM tfa_login_attempts WHERE user_id = ?').run(userId);
      await clear();

      /* 19 attempts already spent, against a grant that no longer exists.
         ISO-8601, matching what the route now writes: the column moved formats
         in migration 056, and a fixture still writing `datetime('now')` produces
         a row that sorts BELOW every cutoff and is therefore invisible to the
         window — which is this test failing for the reason the migration
         exists, rather than the rule being wrong. */
      await db.prepare(`
        INSERT INTO tfa_login_attempts (token_hash, user_id, attempts, last_attempt_at)
        VALUES ('spent-on-an-older-grant', ?, 19, ?)
      `).run(userId, new Date().toISOString());

      /* A brand-new grant, with a per-token counter of zero, is still refused on
         the ACCOUNT budget once it crosses the ceiling. */
      const twentieth = await submit(await beginLogin(), { method: 'totp', token: '000000' });
      expect(twentieth.status).toBe(401);

      const twentyFirst = await submit(await beginLogin(), { method: 'totp', token: '000000' });
      expect(twentyFirst.status).toBe(429);

      /* And a CORRECT code is refused too — the ceiling is not a guess filter. */
      await db.prepare('UPDATE users SET tfa_last_counter = NULL WHERE id = ?').run(userId);
      const withGoodCode = await submit(await beginLogin(), { method: 'totp', token: await freshTotp() });
      expect(withGoodCode.status).toBe(429);

      await clear();
    });
  });

  describe('a spent recovery code is reported and notified', () => {
    /**
     * It used to be silent: the row was deleted, an audit entry was written, and
     * the response said nothing. So somebody could sign in with their LAST code,
     * be told nothing, and discover at the next sign-in that the only method
     * left was the authenticator they had lost. A used recovery code is also
     * what an account takeover looks like from the inside.
     */
    it('returns the remaining count and writes a notice', async () => {
      const bcrypt = (await import('bcryptjs')).default;
      const userId = (await db.prepare('SELECT id FROM users WHERE email = ?').get(EMAIL)).id;
      await db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(userId);
      await db.prepare('DELETE FROM notifications WHERE user_id = ?').run(userId);
      for (const plain of ['LASTBUTONE01', 'THEVERYLAST1']) {
        await db.prepare(`
          INSERT INTO recovery_codes (id, user_id, code_hash, created_at) VALUES (?, ?, ?, ?)
        `).run(`rc-n-${plain}`, userId, bcrypt.hashSync(plain, 10), new Date().toISOString());
      }

      const first = await submit(await beginLogin(), { method: 'recovery', code: 'LASTBUTONE01' });
      expect(first.status).toBe(200);
      expect(first.body.recoveryCodesRemaining).toBe(1);

      const notices = await db.prepare(
        `SELECT * FROM notifications WHERE user_id = ? AND title LIKE 'A recovery code was used%'`
      ).all(userId);
      expect(notices).toHaveLength(1);
      expect(notices[0].body).toContain('1 recovery code');
    });

    it('says so plainly when the last one is spent', async () => {
      const userId = (await db.prepare('SELECT id FROM users WHERE email = ?').get(EMAIL)).id;
      const res = await submit(await beginLogin(), { method: 'recovery', code: 'THEVERYLAST1' });
      expect(res.status).toBe(200);
      expect(res.body.recoveryCodesRemaining).toBe(0);

      const notices = await db.prepare(
        `SELECT body FROM notifications WHERE user_id = ? AND title LIKE 'A recovery code was used%'
         ORDER BY created_at DESC`
      ).all(userId);
      expect(notices[0].body).toMatch(/last recovery code/i);
    });

    /* An ordinary TOTP sign-in must not claim a count it did not spend. */
    it('omits the count when no recovery code was used', async () => {
      const userId = (await db.prepare('SELECT id FROM users WHERE email = ?').get(EMAIL)).id;
      await db.prepare('UPDATE users SET tfa_last_counter = NULL WHERE id = ?').run(userId);
      const res = await submit(await beginLogin(), { method: 'totp', token: await freshTotp() });
      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty('recoveryCodesRemaining');
    });
  });

  describe('email codes', () => {
    it('offers email once the address is confirmed, even without the separate flag', async () => {
      await db.prepare('UPDATE users SET tfa_email_enabled = 0, email_verified = 1 WHERE email = ?').run(EMAIL);
      const res = await srv.call('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD });
      expect(res.body.availableMethods).toContain('email');
    });

    it('does not offer email when the address is unconfirmed', async () => {
      await db.prepare('UPDATE users SET email_verified = 0 WHERE email = ?').run(EMAIL);
      const res = await srv.call('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD });
      expect(res.body.availableMethods).not.toContain('email');
      await db.prepare('UPDATE users SET email_verified = 1 WHERE email = ?').run(EMAIL);
    });

    /**
     * The screen that offers a method and the route that honours it now read the
     * same derivation, so "offered" and "accepted" cannot drift apart — which is
     * what produced a visible radio button whose first action was a 400.
     *
     * Both directions, and stated as an implication rather than as the
     * self-satisfying comparison this assertion used to be: if the login screen
     * was told email is available then the send route must not refuse it as
     * unavailable, and if it was not then the send route must.
     */
    it('sends to exactly the accounts the login screen was told it could', async () => {
      for (const verified of [1, 0]) {
        await db.prepare('UPDATE users SET email_verified = ? WHERE email = ?').run(verified, EMAIL);
        const login = await srv.call('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD });
        const offered = login.body.availableMethods.includes('email');
        expect(offered).toBe(verified === 1);

        const preauth = await beginLogin();
        const send = await srv.call(
          'POST', '/api/auth/login-2fa/email/send', {}, undefined,
          { Cookie: `wev_preauth=${preauth}` }
        );
        if (offered) {
          /* Anything but "this method is not available". Delivery itself can
             legitimately fail in a test environment with no SMTP. */
          expect(send.body.code).not.toBe('method_unavailable');
        } else {
          expect(send.status).toBe(400);
          expect(send.body.code).toBe('method_unavailable');
        }
      }
      await db.prepare('UPDATE users SET email_verified = 1 WHERE email = ?').run(EMAIL);
    });

    /**
     * The whole email round trip, end to end: ask for a code, read the one that
     * was actually stored, and spend it.
     *
     * The stored value is a bcrypt HASH, so the test cannot read the code back —
     * it writes a known one over the row the send route created. That still
     * exercises everything the user meets: the send route ran, a live row exists
     * with an expiry the route chose, and the submit path finds it, matches it,
     * marks it used and mints a session.
     */
    it('accepts a delivered code, then refuses the same one again', async () => {
      const bcrypt = (await import('bcryptjs')).default;
      const userId = (await db.prepare('SELECT id FROM users WHERE email = ?').get(EMAIL)).id;

      const preauth = await beginLogin();
      await srv.call('POST', '/api/auth/login-2fa/email/send', {}, undefined,
        { Cookie: `wev_preauth=${preauth}` });

      const row = await db.prepare(
        'SELECT id FROM tfa_email_codes WHERE user_id = ? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1'
      ).get(userId);
      expect(row, 'the send route stored no live code').toBeTruthy();
      await db.prepare('UPDATE tfa_email_codes SET code_hash = ?, attempts = 0 WHERE id = ?')
        .run(bcrypt.hashSync('123456', 10), row.id);

      const ok = await submit(preauth, { method: 'email', code: '123456' });
      expect(ok.status).toBe(200);
      /* The session transition: a session cookie replaces the pre-auth one. */
      const setCookie = ok.headers.get('set-cookie') || '';
      expect(setCookie).toContain('wev_session=');

      /* Single use. The row is marked spent, so a replay finds nothing to match
         and is refused like any wrong code. */
      expect((await db.prepare('SELECT used_at FROM tfa_email_codes WHERE id = ?').get(row.id)).used_at)
        .toBeTruthy();
      const replay = await submit(await beginLogin(), { method: 'email', code: '123456' });
      expect(replay.status).toBe(401);
    });

    /** A wrong code is a 401, and it burns one of the three attempts, not three. */
    it('spends one attempt per wrong guess however many codes are live', async () => {
      const bcrypt = (await import('bcryptjs')).default;
      const userId = (await db.prepare('SELECT id FROM users WHERE email = ?').get(EMAIL)).id;
      await db.prepare('DELETE FROM tfa_email_codes WHERE user_id = ?').run(userId);
      const expires = new Date(Date.now() + 600000).toISOString();
      for (const n of ['111111', '222222', '333333']) {
        await db.prepare(`
          INSERT INTO tfa_email_codes (id, user_id, code_hash, expires_at, created_at)
          VALUES (?, ?, ?, ?, '${new Date().toISOString()}')
        `).run(`multi-${n}`, userId, bcrypt.hashSync(n, 10), expires);
      }

      const res = await submit(await beginLogin(), { method: 'email', code: '999999' });
      expect(res.status).toBe(401);
      const attempts = (await db.prepare(
        'SELECT attempts FROM tfa_email_codes WHERE user_id = ? ORDER BY id'
      ).all(userId)).map(r => r.attempts);
      expect(attempts).toEqual([1, 1, 1]);
      await db.prepare('DELETE FROM tfa_email_codes WHERE user_id = ?').run(userId);
    });

    it('refuses an expired code with 401 rather than 500', async () => {
      const preauth = await beginLogin();
      const bcrypt = (await import('bcryptjs')).default;
      const userId = (await db.prepare('SELECT id FROM users WHERE email = ?').get(EMAIL)).id;
      await db.prepare(`
        INSERT INTO tfa_email_codes (id, user_id, code_hash, expires_at, created_at)
        VALUES (?, ?, ?, ?, '${new Date().toISOString()}')
      `).run(`exp-${Math.random().toString(36).slice(2)}`, userId,
        bcrypt.hashSync('654321', 10), new Date(Date.now() - 60000).toISOString());

      const res = await submit(preauth, { method: 'email', code: '654321' });
      expect(res.status).toBe(401);
    });
  });
  /**
   * ── The guessing budget must survive concurrency ──
   *
   * Both ceilings were read-only SELECTs, and the increment happened only after
   * the code had been checked — with `await bcrypt.compare` sitting between the
   * two. Requests bearing the SAME preauth cookie therefore all read
   * `attempts = 0` before any of them wrote, and all of them were allowed.
   *
   * That made the per-account ceiling — the one the comments call "the ceiling
   * that actually bounds the search" — worth nothing against an attacker who
   * simply does not wait for a reply. The per-IP limiter is not a substitute:
   * it is exactly the limit the account ceiling exists to backstop.
   *
   * The recovery branch is the sharpest version, because one guess there costs
   * the server up to ten bcrypt comparisons at cost 10 — roughly a second of
   * wall time in which every other request is free to read a stale counter.
   */
  describe('the guessing budget', () => {
    it('is not bypassable by firing attempts concurrently on one grant', async () => {
      const preauth = await beginLogin();
      const userId = (await db.prepare('SELECT id FROM users WHERE email = ?').get(EMAIL)).id;
      await db.prepare('DELETE FROM tfa_login_attempts WHERE user_id = ?').run(userId);

      /**
       * The RECOVERY method, deliberately — not TOTP.
       *
       * `verifyTotp` is synchronous, so the authenticator path never yields
       * between reading the counter and writing it and a single-threaded
       * handler cannot interleave with itself. The race needs a real await in
       * that gap, and `bcrypt.compare` is the one that was there: this branch
       * awaits once per stored code. A test written against TOTP passes on the
       * unfixed handler and proves nothing.
       */
      const bcrypt = (await import('bcryptjs')).default;
      await db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(userId);
      for (const plain of ['RACECODEAAAA', 'RACECODEBBBB', 'RACECODECCCC']) {
        await db.prepare(`
          INSERT INTO recovery_codes (id, user_id, code_hash, created_at)
          VALUES (?, ?, ?, ?)
        `).run(`rc-race-${plain}`, userId, bcrypt.hashSync(plain, 10), new Date().toISOString());
      }

      /* Fired together, deliberately not awaited in turn: the whole point is
         that they interleave at the bcrypt await. */
      const results = await Promise.all(
        Array.from({ length: 12 }, () => submit(preauth, { method: 'recovery', code: 'WRONGCODEZZZZ' }))
      );

      const checked = results.filter(r => r.status === 401).length;
      const refused = results.filter(r => r.status === 429).length;

      expect(checked + refused).toBe(12);
      expect(checked, 'no more than five guesses may reach the verifier').toBeLessThanOrEqual(5);
      expect(refused, 'the rest must be throttled').toBeGreaterThan(0);
    });

    /**
     * A refused request must not extend the window.
     *
     * The claim is rolled back when it exceeds the ceiling, so a 429 leaves the
     * counter exactly where it was. Without that, every rejected request would
     * refresh `last_attempt_at`, and somebody holding the password could keep
     * the account's own owner throttled indefinitely — which is precisely the
     * lockout this endpoint is documented as refusing to be.
     */
    it('does not count the attempts it refuses', async () => {
      const preauth = await beginLogin();
      const userId = (await db.prepare('SELECT id FROM users WHERE email = ?').get(EMAIL)).id;
      await db.prepare('DELETE FROM tfa_login_attempts WHERE user_id = ?').run(userId);

      for (let i = 0; i < 5; i++) {
        expect((await submit(preauth, { method: 'totp', token: '000000' })).status).toBe(401);
      }
      const atCeiling = (await db.prepare(
        'SELECT COALESCE(SUM(attempts), 0) AS n FROM tfa_login_attempts WHERE user_id = ?'
      ).get(userId)).n;
      expect(atCeiling).toBe(5);

      for (let i = 0; i < 4; i++) {
        expect((await submit(preauth, { method: 'totp', token: '000000' })).status).toBe(429);
      }
      const afterRefusals = (await db.prepare(
        'SELECT COALESCE(SUM(attempts), 0) AS n FROM tfa_login_attempts WHERE user_id = ?'
      ).get(userId)).n;
      expect(afterRefusals, 'a refused request costs nothing').toBe(5);
    });

    /**
     * A success releases the budget, so getting the code right repeatedly is
     * never what locks somebody out. The original counter was bumped
     * unconditionally and this was the bug that fixed; claiming before
     * verification must not quietly bring it back.
     */
    it('clears the budget on a successful sign-in', async () => {
      const userId = (await db.prepare('SELECT id FROM users WHERE email = ?').get(EMAIL)).id;
      await db.prepare('DELETE FROM tfa_login_attempts WHERE user_id = ?').run(userId);

      const failing = await beginLogin();
      expect((await submit(failing, { method: 'totp', token: '000000' })).status).toBe(401);

      /* Earlier tests in this file have already signed in on the current time
         step, and a spent step is correctly refused as a replay. Clearing the
         high-water mark is what makes THIS test about the attempt counter
         rather than about `tfa_last_counter`. */
      await db.prepare('UPDATE users SET tfa_last_counter = NULL WHERE id = ?').run(userId);

      const preauth = await beginLogin();
      expect((await submit(preauth, { method: 'totp', token: await freshTotp() })).status).toBe(200);

      const left = (await db.prepare(
        'SELECT COALESCE(SUM(attempts), 0) AS n FROM tfa_login_attempts WHERE user_id = ?'
      ).get(userId)).n;
      expect(left).toBe(0);
    });
  });
  /**
   * ── A preauth grant completes ONE sign-in ──
   *
   * Success used to clear the cookie and stop there, which takes away the
   * browser's copy and leaves the token valid for the rest of its fifteen
   * minutes. And nothing on that path read `token_version`, so the two controls
   * that bump it — "sign out all other devices" and a password reset — could not
   * reach a sign-in that was already half-finished.
   */
  describe('the pre-auth grant', () => {
    it('cannot be replayed to mint a second session', async () => {
      const userId = (await db.prepare('SELECT id FROM users WHERE email = ?').get(EMAIL)).id;
      await db.prepare('DELETE FROM tfa_login_attempts WHERE user_id = ?').run(userId);
      await db.prepare('UPDATE users SET tfa_last_counter = NULL WHERE id = ?').run(userId);

      const preauth = await beginLogin();
      const first = await submit(preauth, { method: 'totp', token: await freshTotp() });
      expect(first.status).toBe(200);

      /* The same cookie again. A fresh code is used so the refusal cannot be
         the replay guard on the TOTP step standing in for this one. */
      await db.prepare('UPDATE users SET tfa_last_counter = NULL WHERE id = ?').run(userId);
      const replay = await submit(preauth, { method: 'totp', token: await freshTotp() });
      expect(replay.status).toBe(401);
    });

    /**
     * Signing out everywhere, or resetting the password, must also cancel a
     * sign-in that is standing at the second-factor step.
     */
    it('is refused once the account token version moves', async () => {
      const userId = (await db.prepare('SELECT id FROM users WHERE email = ?').get(EMAIL)).id;
      await db.prepare('DELETE FROM tfa_login_attempts WHERE user_id = ?').run(userId);

      const preauth = await beginLogin();
      await db.prepare('UPDATE users SET token_version = COALESCE(token_version, 0) + 1 WHERE id = ?').run(userId);

      await db.prepare('UPDATE users SET tfa_last_counter = NULL WHERE id = ?').run(userId);
      const res = await submit(preauth, { method: 'totp', token: await freshTotp() });
      expect(res.status).toBe(401);
    });
  });
});
