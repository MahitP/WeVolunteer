import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, TEST_TOTP_SECRET } from './testServer.js';
import { REAUTH_CHALLENGE_HEADER } from './sensitiveActions.js';

/**
 * The properties the enrolment UI is built on.
 *
 * `TwoFactorSetup.jsx` asks for the password ONCE for a flow the server gates
 * twice, holds the `2fa.enable` grant across the QR step, and re-presents it when
 * a code is mistyped. Two of those depend on behaviour of these routes rather
 * than of the component, so they are pinned here — a change that made a rejected
 * code consume the grant would leave the client asking for the password again on
 * every wrong digit, and every functional test would still pass.
 *
 * `/api/2fa/status` gained `roleRequires2FA` for the same reason: the client
 * cannot otherwise tell that an enrolled administrator is forbidden from
 * disabling, so it offered the control and spent a verification on a request the
 * server always refuses.
 */

let srv;
let db;
let generateSync;
let bcrypt;
let crypto;

beforeAll(async () => {
  srv = await startTestServer();
  ({ db } = await import('./db.js'));
  ({ generateSync } = await import('otplib'));
  bcrypt = (await import('bcryptjs')).default;
  crypto = (await import('crypto')).default;
});

afterAll(async () => {
  if (srv) await srv.close();
});

/** A fresh confirmed student, so no test clobbers a seeded fixture's enrolment. */
const PW = 'Password123';
let seq = 0;
const account = () => {
  seq += 1;
  return {
    email: `tfa.enrol.${seq}@example.org`,
    password: PW,
    name: 'Enrolment Subject',
    role: 'student',
    grade: '9',
    school: 'Test High School',
    username: `tfa_enrol_${seq}`
  };
};

/** Runs generate → returns the pending secret, ready to enable with. */
async function beginEnrolment(session) {
  const generateGrant = await srv.stepUp(session, '2fa.generate', { password: PW });
  const res = await srv.call('POST', '/api/2fa/generate', undefined, session, {
    [REAUTH_CHALLENGE_HEADER]: generateGrant
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.secret;
}

/**
 * Waits until the current TOTP step has room to spare before returning a code.
 *
 * ── Why this is necessary, and why it is not papering over a bug ──
 *
 * `verifyTotp` runs with otplib's default `epochTolerance: 0`, so ONLY the
 * current 30-second step is accepted — there is no ±1 step grace. And
 * `POST /api/2fa/enable` hashes ten recovery codes with bcrypt at cost 10
 * BEFORE it opens its transaction, which is roughly a second of work, so the
 * code is verified about a second after it was generated.
 *
 * A code generated in the last second of a step is therefore stale by the time
 * the server checks it, and the test fails with `Invalid token` on a correct
 * code. Measured at roughly one run in three.
 *
 * The product-level fix is a ±1 step tolerance (RFC 6238 §6 recommends exactly
 * that, and it is what every mainstream implementation does) — but that widens
 * the accept window, which is a security decision rather than something to
 * change so a test goes green. It is recorded as an open question instead. This
 * helper removes the race from the TEST without touching the rule under test.
 */
const STEP_MS = 30_000;
async function freshTotp(secret, needMs = 5_000) {
  const remaining = STEP_MS - (Date.now() % STEP_MS);
  if (remaining < needMs) {
    await new Promise(resolve => setTimeout(resolve, remaining + 50));
  }
  return generateSync({ secret });
}

describe('GET /api/2fa/status — roleRequires2FA', () => {
  it('is false for an account the policy does not apply to', async () => {
    const session = await srv.login('leo.chen@example.com');
    const res = await srv.call('GET', '/api/2fa/status', undefined, session);

    expect(res.status).toBe(200);
    expect(res.body.roleRequires2FA).toBe(false);
  });

  /**
   * The field exists to keep the client from offering "Turn off".
   *
   * `principal.tfaRequired` cannot answer this: it is
   * `roleRequires && nothing enabled`, so it reads false for exactly the enrolled
   * administrator in question.
   */
  it('is true for an administrator, who both disable routes refuse', async () => {
    const session = await srv.login('admin@example.gov');
    const res = await srv.call('GET', '/api/2fa/status', undefined, session);

    expect(res.status).toBe(200);
    expect(res.body.roleRequires2FA).toBe(true);
    expect(res.body.methods.totp).toBe(true);

    // The claim the field is making, confirmed against the route it describes.
    const grant = await srv.stepUp(session, '2fa.disable');
    const refused = await srv.call('POST', '/api/2fa/disable',
      /* The harness's own enrolled secret, not a hand-written one. A 16-CHARACTER
         base32 string decodes to 10 bytes, and otplib refuses anything under 16
         bytes (128 bits, RFC 4226) — so the previous literal threw
         `SecretTooShortError` before the request was ever made, and the test
         failed for a reason unrelated to what it asserts. `TEST_TOTP_SECRET` is
         the secret `makeOwner`/`loginAsOwner` actually enrol, so a code built
         from it is a genuinely valid one and the 403 below is the route refusing
         on POLICY rather than on a malformed token. */
      { token: generateSync({ secret: TEST_TOTP_SECRET }) }, session,
      { [REAUTH_CHALLENGE_HEADER]: grant });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('role_requires_2fa');
  });

  it('still reports the enabled methods and the remaining recovery codes', async () => {
    const session = await srv.login('leo.chen@example.com');
    const res = await srv.call('GET', '/api/2fa/status', undefined, session);

    expect(res.body).toMatchObject({
      enabled: expect.any(Boolean),
      methods: { totp: expect.any(Boolean), email: expect.any(Boolean) },
      recoveryCodesRemaining: expect.any(Number)
    });
  });
});

describe('POST /api/2fa/enable — a rejected code and the grant', () => {
  /**
   * The property the client's retry depends on.
   *
   * `spendChallenge` is the first statement inside the handler's transaction and
   * `verifyTotp` throws after it, so the rollback un-spends the grant. That is
   * what lets a user who mistyped six digits type six more without proving who
   * they are a second time — and it is not an accident of ordering that can be
   * left untested, because reversing those two statements breaks the UI in a way
   * no functional assertion would notice.
   */
  it('leaves the grant spendable, so the same verification completes the retry', async () => {
    const { cookie } = await srv.signupConfirmed(account());

    const secret = await beginEnrolment(cookie);
    const enableGrant = await srv.stepUp(cookie, '2fa.enable', { password: PW });

    const wrong = await srv.call('POST', '/api/2fa/enable', { token: '000000' }, cookie,
      { [REAUTH_CHALLENGE_HEADER]: enableGrant });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe('Invalid token');

    const row = await db.prepare('SELECT consumed_at FROM reauth_challenges WHERE id = ?').get(enableGrant);
    expect(row.consumed_at, 'a rejected code must not cost the verification').toBeNull();

    const right = await srv.call('POST', '/api/2fa/enable',
      { token: await freshTotp(secret) }, cookie,
      { [REAUTH_CHALLENGE_HEADER]: enableGrant });
    expect(right.status, JSON.stringify(right.body)).toBe(200);
    expect(right.body.recoveryCodes).toHaveLength(10);
  }, 30000);

  /** And the grant is single-use once it has actually authorised something. */
  it('is spent by a successful enrolment', async () => {
    const { cookie } = await srv.signupConfirmed(account());

    const secret = await beginEnrolment(cookie);
    const enableGrant = await srv.stepUp(cookie, '2fa.enable', { password: PW });

    const ok = await srv.call('POST', '/api/2fa/enable',
      { token: await freshTotp(secret) }, cookie,
      { [REAUTH_CHALLENGE_HEADER]: enableGrant });
    expect(ok.status).toBe(200);

    const row = await db.prepare('SELECT consumed_at FROM reauth_challenges WHERE id = ?').get(enableGrant);
    expect(row.consumed_at).not.toBeNull();
  }, 30000);
});

describe('POST /api/2fa/enable — the recovery-code set it hands back', () => {
  /**
   * ── A recovery set belongs to the ACCOUNT, not to a factor ──
   *
   * This handler used to issue ten codes on every enrolment and DELETE whatever
   * was there. The concern behind that was real — inserting without deleting
   * left an account that had already enrolled email 2FA holding twenty live
   * codes, ten of them never shown to anybody — but the cure was worse than the
   * disease: somebody who enrolled email first, wrote their ten codes down, and
   * then added an authenticator had every one of them silently voided at the
   * moment they were making the account stronger. Nothing said so, and no
   * screen could bring them back.
   *
   * So enrolment issues a set only when the account has NONE. Both failure
   * modes are then unreachable: there is never a second set to leave lying
   * around, and there is never a deletion of one somebody is holding.
   * Regeneration keeps its own endpoint, its own confirmation dialog and its
   * own step-up action, because destroying recovery codes is a thing to choose
   * on purpose.
   */
  it('leaves an existing set untouched, and offers no new one', async () => {
    const { cookie, user } = await srv.signupConfirmed(account());

    // Ten codes from an earlier enrolment, as email 2FA would have issued.
    const stale = await Promise.all(
      Array.from({ length: 10 }, (_, i) => bcrypt.hash(`STALE${i}`, 10))
    );
    const insert = db.prepare(
      "INSERT INTO recovery_codes (id, user_id, code_hash, created_at) VALUES (?, ?, ?, datetime('now'))"
    );
    for (const hash of stale) await insert.run(`rc-${crypto.randomUUID()}`, user.id, hash);

    const secret = await beginEnrolment(cookie);
    const enableGrant = await srv.stepUp(cookie, '2fa.enable', { password: PW });
    const res = await srv.call('POST', '/api/2fa/enable',
      { token: generateSync({ secret }) }, cookie,
      { [REAUTH_CHALLENGE_HEADER]: enableGrant });

    expect(res.status).toBe(200);
    /* `null`, not an array — the client shows the "save these codes" screen only
       when a set was actually issued. */
    expect(res.body.recoveryCodes ?? null).toBeNull();

    const held = await db.prepare('SELECT code_hash FROM recovery_codes WHERE user_id = ?').all(user.id);
    expect(held, 'the set must be neither doubled nor replaced').toHaveLength(10);
    for (const hash of stale) {
      expect(held.some(r => r.code_hash === hash), 'a code the user wrote down was voided').toBe(true);
    }
  }, 30000);

  /** The first factor on a fresh account still gets a set — there is none to keep. */
  it('issues a set when the account holds none', async () => {
    const { cookie, user } = await srv.signupConfirmed(account());

    const secret = await beginEnrolment(cookie);
    const enableGrant = await srv.stepUp(cookie, '2fa.enable', { password: PW });
    const res = await srv.call('POST', '/api/2fa/enable',
      { token: generateSync({ secret }) }, cookie,
      { [REAUTH_CHALLENGE_HEADER]: enableGrant });

    expect(res.status).toBe(200);
    expect(res.body.recoveryCodes).toHaveLength(10);
    expect(
      (await db.prepare('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ?').get(user.id)).n
    ).toBe(10);
  }, 30000);
});

/**
 * ── "Turn off the authenticator" must remove the authenticator ──
 *
 * `/api/2fa/disable` cleared `tfa_email_enabled` alongside `tfa_enabled` and
 * then deleted every recovery code. The control offering it sits on the
 * Authenticator card and reads "Turn off", so somebody removing one factor lost
 * three things — their authenticator, their email second factor, and the ten
 * codes they had written down — with nothing saying that would happen.
 */
describe('POST /api/2fa/disable — removing one factor is not removing them all', () => {
  /** Enrols TOTP, then email 2FA, so the account holds both and one code set. */
  async function enrolBoth() {
    const { cookie, user } = await srv.signupConfirmed(account());
    const secret = await beginEnrolment(cookie);
    const enableGrant = await srv.stepUp(cookie, '2fa.enable', { password: PW });
    const enabled = await srv.call('POST', '/api/2fa/enable',
      { token: generateSync({ secret }) }, cookie,
      { [REAUTH_CHALLENGE_HEADER]: enableGrant });
    expect(enabled.status).toBe(200);

    await db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(user.id);
    const emailGrant = await srv.stepUp(cookie, '2fa.enable', { password: PW });
    const emailOn = await srv.call('POST', '/api/2fa/email/enable', {}, cookie,
      { [REAUTH_CHALLENGE_HEADER]: emailGrant });
    expect(emailOn.status).toBe(200);

    return { cookie, user, secret };
  }

  const codeCount = async (userId) => (await db.prepare(
    'SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ?'
  ).get(userId)).n;

  it('keeps email 2FA and the recovery codes when the authenticator is removed', async () => {
    const { cookie, user, secret } = await enrolBoth();
    expect(await codeCount(user.id)).toBe(10);

    const grant = await srv.stepUp(cookie, '2fa.disable', { password: PW });
    const res = await srv.call('POST', '/api/2fa/disable',
      { token: generateSync({ secret }) }, cookie,
      { [REAUTH_CHALLENGE_HEADER]: grant });

    expect(res.status).toBe(200);
    expect(res.body.twoFactorStillOn, 'email 2FA survives, so 2FA is still on').toBe(true);

    const row = await db.prepare(
      'SELECT tfa_enabled, tfa_secret, tfa_email_enabled, tfa_last_counter FROM users WHERE id = ?'
    ).get(user.id);
    expect(row.tfa_enabled).toBe(0);
    expect(row.tfa_secret).toBeNull();
    /* The high-water mark belongs to the secret; leaving it would refuse a good
       code as a replay on the first sign-in after re-enrolling. */
    expect(row.tfa_last_counter).toBeNull();
    expect(row.tfa_email_enabled, 'email 2FA must survive').toBe(1);
    expect(await codeCount(user.id), 'the codes the user wrote down must survive').toBe(10);
  }, 40000);

  it('clears the codes only when the LAST factor goes', async () => {
    const { cookie, user } = await srv.signupConfirmed(account());
    const secret = await beginEnrolment(cookie);
    const enableGrant = await srv.stepUp(cookie, '2fa.enable', { password: PW });
    await srv.call('POST', '/api/2fa/enable', { token: generateSync({ secret }) }, cookie,
      { [REAUTH_CHALLENGE_HEADER]: enableGrant });
    expect(await codeCount(user.id)).toBe(10);

    const grant = await srv.stepUp(cookie, '2fa.disable', { password: PW });
    const res = await srv.call('POST', '/api/2fa/disable',
      { token: generateSync({ secret }) }, cookie,
      { [REAUTH_CHALLENGE_HEADER]: grant });

    expect(res.status).toBe(200);
    expect(res.body.twoFactorStillOn).toBe(false);

    const row = await db.prepare(
      'SELECT tfa_enabled, tfa_email_enabled FROM users WHERE id = ?'
    ).get(user.id);
    expect(row.tfa_enabled).toBe(0);
    expect(row.tfa_email_enabled).toBe(0);
    /* Ten live credentials on an account with no second factor would be a
       standing bypass of the protection the user just removed. */
    expect(await codeCount(user.id), 'nothing left to recover past').toBe(0);
  }, 40000);
});