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
    const owner = await srv.loginAsOwner('derek.sorensen@example.com');
    expect(owner).toBeTruthy();
  });
});

/**
 * The replay scope rests on a compensating control. Assert the control.
 *
 * Single use is enforced on the sign-in path and deliberately not on enrolment
 * or disable. `totpReplay.js` explains why at length, and the argument is sound
 * — but it is only sound while its premise holds: those routes are reachable
 * ONLY with a live session AND a step-up grant that is itself single-use and
 * bound to one action. That premise is what makes a replayed code there worth
 * nothing, because anybody who can present one already controls the account.
 *
 * Nothing asserted the premise. Remove `requireAAL2` from one of those routes —
 * a plausible edit, since the friction it adds is exactly what somebody
 * simplifying a 2FA flow would target — and the route keeps working, every
 * functional test stays green, and the replay-scope reasoning silently becomes
 * false. Guard 5 in authz.completeness.test.js pairs each `requireAAL2` with a
 * `spendChallenge`, which is a different property: it constrains the gates that
 * exist rather than requiring these particular routes to have one.
 *
 * This is a source scan because the property is structural. A functional test
 * could show one route refusing without a grant; it could not show that no
 * TOTP-checking route anywhere has lost its gate.
 */
describe('the premise behind scoping replay protection to sign-in', () => {
  const TWO_FACTOR_ROUTES = new URL('./routes/twoFactorRoutes.js', import.meta.url);

  /** Every `router.<verb>('<path>', ...)` head, up to the handler body. */
  function routeDeclarations(source) {
    const decls = [];
    const re = /router\.(get|post|put|patch|delete)\(\s*'([^']+)'([\s\S]*?)=>\s*\{/g;
    let m;
    while ((m = re.exec(source)) !== null) {
      decls.push({ verb: m[1], path: m[2], middleware: m[3] });
    }
    return decls;
  }

  it('every 2FA enrolment and disable route is behind a step-up grant', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(TWO_FACTOR_ROUTES, 'utf8');
    const decls = routeDeclarations(source);

    // Anti-vacuity: if the scan stops matching, it must fail rather than pass
    // over an empty list.
    expect(decls.length, 'the route scan matched nothing — it is testing nothing').toBeGreaterThan(4);

    const ungated = decls
      .filter(d => d.verb !== 'get')
      .filter(d => !d.middleware.includes('requireAAL2'))
      .map(d => `${d.verb.toUpperCase()} ${d.path}`);

    expect(
      ungated,
      'These routes change 2FA state without a step-up grant. TOTP replay protection '
      + 'is deliberately NOT applied to enrolment/disable (see server/totpReplay.js), '
      + 'and that is only safe because a single-use grant already stands in front of '
      + 'them. Restore the gate, or extend verifyTotpOnce to cover this route.'
    ).toEqual([]);
  });

  /**
   * Comments are stripped before matching.
   *
   * `twoFactorRoutes.js` documents, twice and by name, that it calls `verifyTotp`
   * and deliberately NOT `verifyTotpOnce`. A raw substring scan counts that
   * explanation as the thing it is warning about — which is precisely the
   * failure this suite exists to catch, so it is worth having hit it here. The
   * assertion is about executable code; the prose has to come out first.
   */
  function codeOnly(source) {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
      .replace(/^\s*\/\/.*$/gm, '');      // whole-line comments
  }

  it('single-use verification is used on the sign-in path and nowhere else', async () => {
    const { readFileSync } = await import('node:fs');
    const authSource = codeOnly(readFileSync(new URL('./routes/authRoutes.js', import.meta.url), 'utf8'));
    const twoFactorSource = codeOnly(readFileSync(TWO_FACTOR_ROUTES, 'utf8'));

    // The sign-in path must keep it: this is the case where a replayed code buys
    // a session the attacker does not already have.
    expect(authSource, 'the sign-in path stopped enforcing single use').toContain('verifyTotpOnce');

    // And the enrolment/disable routes must not adopt it silently: a shared
    // high-water mark would stop an account signing in and then changing its 2FA
    // settings inside the same 30-second step.
    expect(
      twoFactorSource.includes('verifyTotpOnce'),
      'twoFactorRoutes.js now marks the counter. That is a real behaviour change — '
      + 'it makes sign-in and a 2FA settings change in the same step mutually '
      + 'exclusive. If it is intended, update the scope note in server/totpReplay.js.'
    ).toBe(false);
  });
});
