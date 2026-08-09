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
    const session = await srv.login('leo.chen28@gmail.com');
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
    const session = await srv.login('leo.chen28@gmail.com');
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

    const row = db.prepare('SELECT consumed_at FROM reauth_challenges WHERE id = ?').get(enableGrant);
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

    const row = db.prepare('SELECT consumed_at FROM reauth_challenges WHERE id = ?').get(enableGrant);
    expect(row.consumed_at).not.toBeNull();
  }, 30000);
});

describe('POST /api/2fa/enable — the recovery-code set it hands back', () => {
  /**
   * The set the user is shown must be the whole set that works.
   *
   * Fixed server-side already (the handler DELETEs before inserting); asserted
   * here because the UI now tells the reader in so many words that their earlier
   * codes are dead, and that sentence has to be true.
   */
  it('replaces every earlier code rather than adding to them', async () => {
    const { cookie, user } = await srv.signupConfirmed(account());

    // Ten codes from an earlier enrolment, as email 2FA would have issued.
    const stale = await Promise.all(
      Array.from({ length: 10 }, (_, i) => bcrypt.hash(`STALE${i}`, 10))
    );
    const insert = db.prepare(
      "INSERT INTO recovery_codes (id, user_id, code_hash, created_at) VALUES (?, ?, ?, datetime('now'))"
    );
    for (const hash of stale) insert.run(`rc-${crypto.randomUUID()}`, user.id, hash);

    const secret = await beginEnrolment(cookie);
    const enableGrant = await srv.stepUp(cookie, '2fa.enable', { password: PW });
    const res = await srv.call('POST', '/api/2fa/enable',
      { token: generateSync({ secret }) }, cookie,
      { [REAUTH_CHALLENGE_HEADER]: enableGrant });

    expect(res.status).toBe(200);
    expect(res.body.recoveryCodes).toHaveLength(10);

    const held = db.prepare('SELECT code_hash FROM recovery_codes WHERE user_id = ?').all(user.id);
    expect(held, 'twenty live codes, ten of them never shown').toHaveLength(10);
    for (const hash of stale) {
      expect(held.some(r => r.code_hash === hash), 'a stale code survived').toBe(false);
    }
  }, 30000);
});
