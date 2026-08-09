import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, TEST_TOTP_SECRET } from './testServer.js';

/**
 * The TOTP clock tolerance, and the single-use rule that had to ship with it.
 *
 * ── Why the two are one change ──
 *
 * `verifyTotp` accepted only the current 30-second step. That rejected CORRECT
 * codes: typing time, network latency and the server's own work before the check
 * all push a submitted code into the past, and a code typed in the last second of
 * a step was routinely verified in the next one. It was measured — an enrolment
 * test failed roughly one run in three on a code that was right when typed.
 *
 * Accepting one previous step fixes that and, on its own, doubles the window in
 * which an intercepted code can be replayed. RFC 6238 §5.2 requires a verifier to
 * refuse a second use of a code, and nothing did. So the tolerance ships with a
 * per-account high-water mark (`users.tfa_last_counter`) and the pair is a net
 * improvement on either previous state: the window is wider and the guarantee is
 * stronger.
 *
 * These are the two properties, asserted through the real sign-in endpoint.
 */

const ADMIN = 'admin@example.gov';
const STEP_SECONDS = 30;

describe('TOTP tolerance and single use', () => {
  let srv;
  let generateSync;

  beforeAll(async () => {
    srv = await startTestServer();
    ({ generateSync } = await import('otplib'));
  }, 60000);

  afterAll(async () => { await srv?.close(); });

  /**
   * The pre-auth token for the admin: password accepted, second factor pending.
   *
   * Read out of `set-cookie` rather than from `res.cookie`, because the pre-auth
   * grant is a DIFFERENT cookie (`wev_preauth`) from a session (`wev_session`) —
   * that separation is what stops a pre-auth token being usable as a session, and
   * it means the harness's usual `cookie` field is empty here by design.
   */
  const beginLogin = async () => {
    const first = await srv.call('POST', '/api/auth/login', {
      email: ADMIN, password: 'password123',
    });
    expect(first.body.require2FA, JSON.stringify(first.body)).toBe(true);

    const preauth = (first.headers.get('set-cookie') || '').match(/wev_preauth=([^;]+)/)?.[1];
    expect(preauth, 'no pre-auth cookie was issued').toBeTruthy();
    return preauth;
  };

  /* The pre-auth token goes in an explicit Cookie header, not the session slot. */
  const submit = (token, preauth) =>
    srv.call('POST', '/api/auth/login-2fa', { method: 'totp', token }, undefined,
      { Cookie: `wev_preauth=${preauth}` });

  /**
   * Clears the account's high-water mark.
   *
   * Each case below starts from "nothing spent" so it is testing its own property
   * rather than the leftovers of the previous one. The mark is per account, which
   * is exactly what this resets.
   */
  const clearMark = async () => {
    const { db } = await import('./db.js');
    db.prepare('UPDATE users SET tfa_last_counter = NULL WHERE email = ?').run(ADMIN);
  };

  /**
   * Waits until a step has room, so a case is never decided by the boundary it is
   * not about. Three seconds is far more than a loopback request needs.
   */
  const waitForRoom = async () => {
    const remaining = STEP_SECONDS * 1000 - (Date.now() % (STEP_SECONDS * 1000));
    if (remaining < 3000) await new Promise(r => setTimeout(r, remaining + 50));
  };

  /**
   * The regression the tolerance exists for.
   *
   * A code generated one step ago is what a user who took a moment to type, or
   * whose phone clock is a few seconds behind, actually submits. Before the
   * tolerance this was refused and the user was told their correct code was
   * invalid.
   */
  it('accepts a code from the previous step, which is what latency produces', async () => {
    await waitForRoom();
    await clearMark();

    const now = Math.floor(Date.now() / 1000);
    const previous = generateSync({ secret: TEST_TOTP_SECRET, epoch: now - STEP_SECONDS });

    const res = await submit(previous, await beginLogin());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  /**
   * And no further back. `[30, 0]` is one step, not a general amnesty — a code
   * from ninety seconds ago is not latency, it is a clock that is wrong or a code
   * that was captured.
   */
  it('refuses a code from two steps ago', async () => {
    await waitForRoom();
    await clearMark();

    const now = Math.floor(Date.now() / 1000);
    const old = generateSync({ secret: TEST_TOTP_SECRET, epoch: now - STEP_SECONDS * 2 });

    const res = await submit(old, await beginLogin());
    expect(res.status).toBe(401);
  });

  /**
   * The FUTURE is not tolerated, and the asymmetry is deliberate.
   *
   * Every cause of a late code makes it older than "now", never newer; a future
   * code means a clock genuinely running ahead. otplib's own documentation calls
   * the past-only form the RFC-compliant one, and accepting one step rather than
   * two halves the widening for no loss in the cases that occur.
   */
  it('refuses a code from the next step', async () => {
    await waitForRoom();
    await clearMark();

    const now = Math.floor(Date.now() / 1000);
    const future = generateSync({ secret: TEST_TOTP_SECRET, epoch: now + STEP_SECONDS });

    const res = await submit(future, await beginLogin());
    expect(res.status).toBe(401);
  });

  /**
   * ── The single-use rule ──
   *
   * The whole reason the tolerance is safe. A code that has signed somebody in
   * cannot sign anybody in again, even though it is still inside its validity
   * window — which is what RFC 6238 §5.2 requires and what this platform did not
   * do before.
   *
   * Two SEPARATE pre-auth cookies, because that is the shape of the attack: an
   * attacker holding the stolen password starts their own sign-in and submits the
   * code they observed. Reusing one cookie would prove far less.
   */
  it('refuses a second use of a code that has already signed somebody in', async () => {
    await waitForRoom();
    await clearMark();

    const token = generateSync({ secret: TEST_TOTP_SECRET });

    const victim = await submit(token, await beginLogin());
    expect(victim.status, JSON.stringify(victim.body)).toBe(200);

    /* Same code, same window, a different session attempt. */
    const attacker = await submit(token, await beginLogin());
    expect(attacker.status, 'a used code minted a second session').toBe(401);
    expect(attacker.cookie).toBeFalsy();
  });

  /**
   * And the mark refuses everything at or below it, not just the exact code.
   *
   * A high-water counter rather than a set of seen codes, so once step N is spent
   * the previous step's code — still inside the tolerance window — is dead too.
   * Without this, single-use would leave a second usable code lying behind every
   * successful sign-in.
   */
  it("refuses the previous step's code once a later one has been spent", async () => {
    await waitForRoom();
    await clearMark();

    const now = Math.floor(Date.now() / 1000);
    const current = generateSync({ secret: TEST_TOTP_SECRET });
    const previous = generateSync({ secret: TEST_TOTP_SECRET, epoch: now - STEP_SECONDS });

    expect((await submit(current, await beginLogin())).status).toBe(200);

    const res = await submit(previous, await beginLogin());
    expect(res.status, 'a code inside the tolerance survived a later one being spent').toBe(401);
  });

  /**
   * The mark is per ACCOUNT.
   *
   * Every seeded administrator shares one secret in this harness, so a mark keyed
   * on the secret rather than the user would make one admin signing in lock out
   * every other for the rest of the step. That is a bug the harness itself hit.
   */
  it("does not let one account's spent code block another", async () => {
    await waitForRoom();
    await clearMark();

    const token = generateSync({ secret: TEST_TOTP_SECRET });
    expect((await submit(token, await beginLogin())).status).toBe(200);

    /* A different account, same shared secret, same code, same window. */
    const owner = await srv.loginAsOwner('dsanger@outlook.com');
    expect(owner).toBeTruthy();
  });
});
