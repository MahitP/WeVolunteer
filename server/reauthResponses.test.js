import { describe, it, expect, vi } from 'vitest';
import { REFUSALS, refuseReauth, spendChallenge, ChallengeNotSpent } from './reauthResponses.js';
import { REAUTH_ERRORS } from './reauth.js';

/**
 * The step-up refusal vocabulary, and the sync nothing was enforcing.
 *
 * ── Why this file exists ──
 *
 * `reauth.js` returns a closed set of machine-readable refusals; `REFUSALS` maps
 * each to one status and one sentence so no route can invent a different answer
 * for the same condition. Those two tables have to stay in step, and until now
 * nothing checked that they did — `REFUSALS` was referenced only from its own
 * module and imported by no test.
 *
 * The failure mode is quiet and user-facing. Add an error code to `reauth.js`,
 * forget the `REFUSALS` entry, and `refuseReauth` logs "unmapped refusal" and
 * answers **500 Internal server error** — so someone who was locked out, or
 * whose verification expired, is told the server is broken instead of what
 * happened. Every route in the feature shares that table, so one omission
 * affects all nine.
 *
 * This is not hypothetical. `ACCOUNT_LOCKED` was added to both tables during the
 * Task 3 fix round, and it stayed correct because it was remembered. That is the
 * part worth making structural.
 *
 * These are static imports, which is safe here: `reauthResponses.js` →
 * `reauth.js` → `sensitiveActions.js`, and none of those reaches `db.js`. A
 * server test may not statically import anything that does — see the long note
 * in `testServer.js`.
 */

describe('REFUSALS covers the refusal vocabulary exactly', () => {
  const codes = Object.values(REAUTH_ERRORS);

  it('has an entry for every error reauth.js can return', () => {
    expect(codes.length, 'nothing to assert — the error set is empty').toBeGreaterThan(0);

    const unmapped = codes.filter(c => !Object.prototype.hasOwnProperty.call(REFUSALS, c));
    expect(
      unmapped,
      'REAUTH_ERRORS value(s) with no REFUSALS entry — each answers 500 "Internal server '
      + 'error" instead of the real reason, on all nine step-up routes'
    ).toEqual([]);
  });

  /**
   * And the other direction, for the same reason `noDanglingClasses.test.js`
   * checks both: an entry for a code that can no longer happen is a message
   * nobody will ever see and a status nobody can verify, kept because deleting it
   * felt risky.
   */
  it('has no entry for an error that cannot happen', () => {
    const stale = Object.keys(REFUSALS).filter(k => !codes.includes(k));
    expect(stale, 'REFUSALS entry(s) for codes REAUTH_ERRORS no longer contains').toEqual([]);
  });
});

describe('every refusal is a usable answer', () => {
  /**
   * A refusal is never a server fault. `expired`, `locked`, `consumed` and the
   * rest are all things the caller did or waited too long over, so a 5xx would
   * both mislead the user and pollute whatever error monitoring is watching for
   * real defects.
   */
  it('answers 4xx, never 5xx', () => {
    for (const [code, { status }] of Object.entries(REFUSALS)) {
      expect(status, `${code} answers ${status}`).toBeGreaterThanOrEqual(400);
      expect(status, `${code} answers ${status} — a refusal is not a server fault`).toBeLessThan(500);
    }
  });

  it('carries a message a person can act on', () => {
    for (const [code, { error }] of Object.entries(REFUSALS)) {
      expect(typeof error, `${code} has no message`).toBe('string');
      expect(error.trim().length, `${code}'s message is empty`).toBeGreaterThan(0);
      // A code leaking into the copy means someone wrote the identifier where the
      // sentence goes — "not_granted" is not something to show a fourteen-year-old.
      expect(error, `${code}'s message is the code, not a sentence`).not.toBe(code);
      expect(error, `${code}'s message contains the raw code`).not.toMatch(/_/);
    }
  });

  /**
   * `password_unavailable` must never read as "wrong password".
   *
   * The `'!OAUTH_ONLY!'` sentinel is not a bcrypt hash, so a naive comparison
   * returns false and would tell someone with no password that their password is
   * wrong — five times, and then lock them out of the only prompt they were
   * offered. The distinct code exists to prevent that, and so does its wording.
   */
  it('tells an account with no password what is actually true', () => {
    const { error } = REFUSALS[REAUTH_ERRORS.PASSWORD_UNAVAILABLE];
    expect(error).toMatch(/no password/i);
    expect(error, 'reads as a wrong-password error').not.toMatch(/not correct|incorrect/i);
  });

  /**
   * `locked` says to start again; `account_locked` must not, because starting
   * again is exactly what no longer helps — that is the whole point of the
   * account-level ceiling over the per-challenge one.
   */
  it('distinguishes a spent challenge from a spent account', () => {
    expect(REFUSALS[REAUTH_ERRORS.LOCKED].error).toMatch(/start again/i);
    expect(
      REFUSALS[REAUTH_ERRORS.ACCOUNT_LOCKED].error,
      'tells someone to start again when a new challenge will not help either'
    ).not.toMatch(/start again/i);
  });
});

describe('refuseReauth', () => {
  const mockRes = () => {
    const res = {
      statusCode: null,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; return this; }
    };
    return res;
  };

  it('answers the mapped status and includes the machine-readable code', () => {
    const res = mockRes();
    refuseReauth(res, { ok: false, error: REAUTH_ERRORS.EXPIRED });

    expect(res.statusCode).toBe(REFUSALS[REAUTH_ERRORS.EXPIRED].status);
    expect(res.body.code, 'the client branches on this').toBe(REAUTH_ERRORS.EXPIRED);
    expect(res.body.error).toBe(REFUSALS[REAUTH_ERRORS.EXPIRED].error);
  });

  it('passes attemptsRemaining through when there is one, and omits it when not', () => {
    const withCount = mockRes();
    refuseReauth(withCount, { ok: false, error: REAUTH_ERRORS.INVALID_PASSWORD, attemptsRemaining: 3 });
    expect(withCount.body.attemptsRemaining).toBe(3);

    const without = mockRes();
    refuseReauth(without, { ok: false, error: REAUTH_ERRORS.EXPIRED });
    expect(
      Object.prototype.hasOwnProperty.call(without.body, 'attemptsRemaining'),
      'an absent count must be absent, not undefined — the client reads it to decide whether to show one'
    ).toBe(false);
  });

  /**
   * The 500 fallback exists and is correct — an unmapped refusal IS a bug in the
   * table rather than in the caller's request. Asserting it keeps the two tests
   * above honest: they check the table is complete, this checks what happens if
   * it ever is not.
   */
  it('answers 500 for a code it does not know, and says so on the way out', () => {
    const res = mockRes();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    refuseReauth(res, { ok: false, error: 'something_new_nobody_mapped' });

    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('Internal server error');
    expect(spy, 'an unmapped refusal must be loud in the log').toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('spendChallenge', () => {
  const req = (over = {}) => ({
    reauthChallengeId: 'reauth-1',
    user: { id: 'u1' },
    sessionJti: 'jti-1',
    ...over
  });

  /**
   * It throws rather than returning, so a handler cannot forget to check the
   * result and carry on. `inTransaction` then rolls back the work, which is what
   * keeps the action and the spend atomic in both directions.
   */
  it('throws ChallengeNotSpent carrying the refusal, so the transaction rolls back', () => {
    const db = { prepare: () => ({ run: () => ({ changes: 0 }), get: () => undefined }) };

    let thrown;
    try {
      spendChallenge(db, req(), 'account.delete', {});
    } catch (err) {
      thrown = err;
    }

    expect(thrown, 'returned instead of throwing — the caller can ignore that').toBeInstanceOf(ChallengeNotSpent);
    expect(thrown.result.ok).toBe(false);
    // Whatever the reason, it must be one the table can answer.
    expect(Object.prototype.hasOwnProperty.call(REFUSALS, thrown.result.error)).toBe(true);
  });
});
