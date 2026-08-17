import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';
import { REAUTH_CHALLENGE_HEADER } from './sensitiveActions.js';

/**
 * The recovery set across a whole account lifetime.
 *
 * ── The report this exists to answer ──
 *
 * A user signed in, signed out, signed in again, and read "9 codes remaining".
 * The worry is precise and worth stating: **an authentication-code sign-in must
 * never imply that it spent a recovery code.** Nine is the truth if a recovery
 * code really was used earlier and never regenerated — and a lie if an ordinary
 * TOTP or email sign-in is quietly consuming one, or if the count is being
 * reported on sign-ins that spent nothing.
 *
 * `routes.2faEnrolment.test.js` already covers enrolment issuing a set, adding a
 * second factor leaving it untouched, removing the authenticator keeping it, and
 * the last factor clearing it. This file covers what that one does not: the
 * REVERSE of each of those, and the sign-in paths themselves — which is where a
 * count that "appears from nowhere" would actually come from.
 */
describe('the recovery set over an account lifetime', () => {
  let srv, db, generateSync;

  const PW = 'Password123';
  let seq = 0;
  const account = () => {
    seq += 1;
    return {
      email: `tfa.life.${seq}@example.org`,
      password: PW,
      name: 'Lifecycle Subject',
      role: 'student',
      grade: '9',
      school: 'Test High School',
      username: `tfa_life_${seq}`,
    };
  };

  const codeCount = userId => db.prepare(
    'SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ?'
  ).get(userId).n;

  const hashes = userId => db.prepare(
    'SELECT code_hash FROM recovery_codes WHERE user_id = ? ORDER BY code_hash'
  ).all(userId).map(r => r.code_hash);

  /* See routes.2faEnrolment.test.js: enrolment hashes ten codes with bcrypt
     before verifying, so a token minted in the last second of a step is stale by
     the time it is checked. */
  const STEP_MS = 30_000;
  async function freshTotp(secret, needMs = 5_000) {
    const remaining = STEP_MS - (Date.now() % STEP_MS);
    if (remaining < needMs) await new Promise(r => setTimeout(r, remaining + 50));
    return generateSync({ secret });
  }

  /**
   * Waits out the current TOTP step.
   *
   * A TOTP code is single-use — `tfa_last_counter` records the step accepted and
   * refuses anything at or below it (migration 029, RFC 6238 §5.2). So two
   * sign-ins inside one 30-second window is CORRECTLY refused, and a test that
   * signs in twice in quick succession is asking the server to accept a replay.
   */
  async function waitForNextStep() {
    await new Promise(r => setTimeout(r, STEP_MS - (Date.now() % STEP_MS) + 100));
  }

  /**
   * The two-step sign-in, done by hand so each case can inspect the response.
   *
   * `srv.login` does this internally but only hands back the session cookie, and
   * every assertion here is about the BODY of the second step. The preauth token
   * rides in `wev_preauth`, which is a different cookie from the session one
   * `srv.call`'s `token` argument sets — passing it as the latter is why an
   * earlier draft of this file got "Session expired" on every case.
   */
  async function signIn(email, second, secret = null) {
    const attempt = async (body) => {
      const first = await srv.call('POST', '/api/auth/login', { email, password: PW });
      expect(first.body?.require2FA, JSON.stringify(first.body)).toBe(true);
      const preauth = (first.headers.get('set-cookie') || '').match(/wev_preauth=([^;]+)/)?.[1];
      expect(preauth, 'no preauth cookie issued').toBeTruthy();
      return srv.call('POST', '/api/auth/login-2fa', body, undefined,
        { Cookie: `wev_preauth=${preauth}` });
    };

    const res = await attempt(second);

    /**
     * One retry, and only for a stale authenticator code.
     *
     * Enrolment hashes ten recovery codes with bcrypt before this call, so under
     * a loaded full-suite run the token can be minted in one 30-second step and
     * checked in the next — which the server correctly refuses. Waiting out the
     * step unconditionally cost more than the race did (every case paying up to
     * twelve seconds, several then exceeding their timeout), so the wait happens
     * only when the refusal actually occurs.
     *
     * Deliberately narrow: it re-mints only a TOTP token, and only on a 401.
     * A recovery code is single-use and must never be retried, and any other
     * status is a real failure this must not paper over.
     */
    if (res.status === 401 && secret && second?.method === 'totp') {
      await waitForNextStep();
      return await attempt({ token: await freshTotp(secret), method: 'totp' });
    }
    return res;
  }

  /** Enrols TOTP and returns the session, user and secret. */
  async function enrolTotp() {
    const { cookie, user } = await srv.signupConfirmed(account());
    const generateGrant = await srv.stepUp(cookie, '2fa.generate', { password: PW });
    const gen = await srv.call('POST', '/api/2fa/generate', undefined, cookie,
      { [REAUTH_CHALLENGE_HEADER]: generateGrant });
    expect(gen.status).toBe(200);
    const secret = gen.body.secret;

    const enableGrant = await srv.stepUp(cookie, '2fa.enable', { password: PW });
    const on = await srv.call('POST', '/api/2fa/enable',
      { token: await freshTotp(secret) }, cookie,
      { [REAUTH_CHALLENGE_HEADER]: enableGrant });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    return { cookie, user, secret, codes: on.body.recoveryCodes };
  }

  /** Turns email 2FA on for an already-enrolled account. */
  async function enableEmail(cookie, user) {
    await db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(user.id);
    const grant = await srv.stepUp(cookie, '2fa.enable', { password: PW });
    const res = await srv.call('POST', '/api/2fa/email/enable', {}, cookie,
      { [REAUTH_CHALLENGE_HEADER]: grant });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));
    ({ generateSync } = await import('otplib'));
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  /* ── Sign-in paths ────────────────────────────────────────────────────── */

  describe('signing in', () => {
    /**
     * The heart of the report.
     *
     * A TOTP sign-in spends no recovery code, so it must neither delete one nor
     * report a count. Reporting a count on a sign-in that spent nothing is how a
     * screen comes to say "9 remaining" for no reason the user can connect to
     * anything they did.
     */
    it('spends no recovery code, and reports no count, on a TOTP sign-in', async () => {
      const { user, secret } = await enrolTotp();
      expect(codeCount(user.id)).toBe(10);
      const before = hashes(user.id);

      const done = await signIn(user.email, { token: await freshTotp(secret), method: 'totp' }, secret);
      expect(done.status, JSON.stringify(done.body)).toBe(200);

      expect(done.body.recoveryCodesRemaining).toBeUndefined();
      expect(codeCount(user.id)).toBe(10);
      expect(hashes(user.id)).toEqual(before);
    }, 30_000);

    /**
     * And it stays true across sign-out and back in, which is the exact sequence
     * from the report. Three round trips, still ten codes, still no count.
     */
    it('still spends nothing after signing out and in again', async () => {
      const { user, secret } = await enrolTotp();

      for (let i = 0; i < 2; i += 1) {
        if (i > 0) await waitForNextStep();
        const done = await signIn(user.email, { token: await freshTotp(secret), method: 'totp' }, secret);
        expect(done.status, `sign-in ${i + 1}: ${JSON.stringify(done.body)}`).toBe(200);
        expect(done.body.recoveryCodesRemaining, `sign-in ${i + 1}`).toBeUndefined();
      }

      expect(codeCount(user.id)).toBe(10);
    }, 90_000);

    /**
     * A recovery sign-in DOES spend one, reports the count, and reports it
     * accurately. This is the case where "9 remaining" is the truth.
     */
    it('spends exactly one code on a recovery sign-in and says so', async () => {
      const { user, codes } = await enrolTotp();
      expect(Array.isArray(codes)).toBe(true);

      const done = await signIn(user.email, { code: codes[0], method: 'recovery' });
      expect(done.status, JSON.stringify(done.body)).toBe(200);
      expect(done.body.recoveryCodesRemaining).toBe(9);
      expect(codeCount(user.id)).toBe(9);
    }, 30_000);

    /** And the SAME code cannot be spent twice — it is deleted, not marked. */
    it('refuses a recovery code that has already been spent', async () => {
      const { user, codes } = await enrolTotp();

      expect((await signIn(user.email, { code: codes[0], method: 'recovery' })).status).toBe(200);
      const replay = await signIn(user.email, { code: codes[0], method: 'recovery' });
      expect(replay.status).not.toBe(200);
      expect(codeCount(user.id)).toBe(9);
    }, 30_000);

    /**
     * The count is reported only when a code was spent, so a later ordinary
     * sign-in cannot re-announce a number the user has already been told. That
     * re-announcement is precisely what would make an authenticator sign-in look
     * like it had consumed something.
     */
    it('does not repeat the count on the next ordinary sign-in', async () => {
      const { user, secret, codes } = await enrolTotp();

      const used = await signIn(user.email, { code: codes[0], method: 'recovery' });
      expect(used.body.recoveryCodesRemaining).toBe(9);

      const next = await signIn(user.email, { token: await freshTotp(secret), method: 'totp' }, secret);
      expect(next.status, JSON.stringify(next.body)).toBe(200);
      expect(next.body.recoveryCodesRemaining).toBeUndefined();
      expect(codeCount(user.id)).toBe(9);
    }, 30_000);

    /**
     * `GET /api/2fa/status` is what Settings reads, and after all of the above it
     * must agree with the table. Nine there is honest reporting of a code the
     * user really did spend — the screen's job is to be right, not reassuring.
     */
    it('reports a count in Settings that matches the database', async () => {
      const { cookie, user, codes } = await enrolTotp();
      expect((await signIn(user.email, { code: codes[0], method: 'recovery' })).status).toBe(200);

      const status = await srv.call('GET', '/api/2fa/status', undefined, cookie);
      expect(status.status).toBe(200);
      expect(status.body.recoveryCodesRemaining).toBe(codeCount(user.id));
      expect(status.body.recoveryCodesRemaining).toBe(9);
    }, 30_000);
  });

  /* ── Adding and removing factors ──────────────────────────────────────── */

  describe('changing which factors are on', () => {
    /**
     * The reverse of the covered case: TOTP first, then EMAIL added.
     *
     * A recovery set belongs to the account, not to a factor, so adding a second
     * one must not mint a new set — which would silently invalidate the codes the
     * user has already written down and put somewhere safe.
     */
    it('keeps the same codes when email is added to an authenticator', async () => {
      const { cookie, user } = await enrolTotp();
      const before = hashes(user.id);

      await enableEmail(cookie, user);

      expect(codeCount(user.id)).toBe(10);
      expect(hashes(user.id)).toEqual(before);
    }, 30_000);

    /**
     * The reverse of the covered removal: take EMAIL away and keep the
     * authenticator. The account still has a second factor, so it still needs a
     * way back in.
     */
    it('keeps the codes when email is removed and the authenticator remains', async () => {
      const { cookie, user, secret } = await enrolTotp();
      await enableEmail(cookie, user);
      const before = hashes(user.id);

      const grant = await srv.stepUp(cookie, '2fa.disable', { password: PW });
      const off = await srv.call('POST', '/api/2fa/email/disable',
        { token: await freshTotp(secret) }, cookie, { [REAUTH_CHALLENGE_HEADER]: grant });
      expect(off.status, JSON.stringify(off.body)).toBe(200);

      expect(codeCount(user.id)).toBe(10);
      expect(hashes(user.id)).toEqual(before);

      const status = await srv.call('GET', '/api/2fa/status', undefined, cookie);
      expect(status.body.methods.totp).toBe(true);
      expect(status.body.methods.email).toBe(false);
    }, 30_000);

    /**
     * Settings must describe the server's real state.
     *
     * A screen saying a factor is off while sign-in still accepts it is worse
     * than no screen — it is the one a user consults before deciding they are
     * safe.
     */
    /**
     * `methods` is what the account SWITCHED ON; `availableMethods` is what the
     * sign-in screen will actually accept. They are deliberately different, and
     * conflating them is the defect this endpoint's own header records fixing:
     * since v1.3.1 a confirmed address is accepted once an account holds any
     * factor, so an authenticator-only account can also be signed into with a
     * mailed code — reporting that as "email: off" made a factor that was
     * impossible to turn off look like one that was already off.
     *
     * What must hold is that `availableMethods` equals what login offers, and
     * that `methods` equals the database's enrolment flags.
     */
    it('reports enrolment and acceptance separately, and both truthfully', async () => {
      const { cookie, user } = await enrolTotp();
      const status = await srv.call('GET', '/api/2fa/status', undefined, cookie);

      const row = await db.prepare(
        'SELECT tfa_enabled, tfa_email_enabled FROM users WHERE id = ?'
      ).get(user.id);

      expect(status.body.methods.totp).toBe(row.tfa_enabled === 1);
      expect(status.body.methods.email).toBe(row.tfa_email_enabled === 1);

      /* The screen's list and the sign-in screen's list are the same list. A
         factor offered at sign-in but reported as unavailable here — or the
         reverse — is the disagreement that makes Settings untrustworthy. */
      const pre = await srv.call('POST', '/api/auth/login', { email: user.email, password: PW });
      expect([...pre.body.availableMethods].sort())
        .toEqual([...status.body.availableMethods].sort());
      expect(pre.body.availableMethods).toContain('totp');
    }, 30_000);
  });
});
