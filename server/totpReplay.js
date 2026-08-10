import { verifyTotpStep } from './cryptoUtils.js';

/**
 * TOTP verification that also enforces single use.
 *
 * ── Why this exists as a module ──
 *
 * There are three places a TOTP code is checked — signing in
 * (`authRoutes.js`), confirming enrolment and turning 2FA off
 * (`twoFactorRoutes.js`) — and every one of them needs the same two steps in the
 * same order: verify the code, then refuse a counter this account has already
 * spent. Three copies of a two-step security check is how one of them ends up
 * doing only the first step, and it would be the quietest possible defect: the
 * flow still works, and the only thing lost is a guarantee nobody is looking at.
 *
 * ── What it guarantees, and why the tolerance needed it ──
 *
 * RFC 6238 §5.2 requires that a code be accepted at most once. Nothing here did
 * that: within a code's validity window it could be presented repeatedly. While
 * `epochTolerance` was zero that window was one 30-second step; accepting a
 * previous step widens it, so the two changes ship together and the pair is a net
 * improvement over either previous state. See `TOTP_EPOCH_TOLERANCE` in
 * cryptoUtils.js for the tolerance argument.
 *
 * The mark is a high-water counter (`users.tfa_last_counter`), not a set of seen
 * codes, because TOTP counters only move forward: refusing anything at or below
 * the last accepted step makes the current code single-use and every older code
 * permanently unusable, with one integer and nothing to expire.
 *
 * ── Scope: the SIGN-IN path only ──
 *
 * `POST /api/auth/login-2fa` uses this. Confirming enrolment and turning 2FA off
 * deliberately do not, and the asymmetry is the point rather than an oversight.
 *
 * Replay is worth preventing where a replayed code BUYS the attacker something
 * they do not already have. At sign-in it buys a session: somebody holding a
 * stolen password and an observed code gets in, and without single-use the code
 * the victim just typed is still good. That is the case this exists for.
 *
 * The enrolment and disable routes are reached only with a live session AND a
 * step-up grant that is itself single-use and bound to one action. Anybody who can
 * replay a code there already controls the account, so single-use adds no security
 * — while a shared high-water mark WOULD mean an account could not sign in and
 * then change its 2FA settings inside the same thirty seconds, because the code it
 * signed in with had spent the step. That is real friction for no gain, and it is
 * why the mark is written on one path and read on one path.
 *
 * ── Why it takes a `db` and writes ──
 *
 * Because "was this code already used" and "record that it has been" cannot be
 * separated without leaving a race between them. Callers inside a transaction get
 * that atomicity from the transaction; `authRoutes.js` calls it on the sign-in
 * path where the subsequent session mint is the thing that must not happen twice.
 */

/**
 * Verifies `token` for `user`, refusing a code whose step has already been spent.
 *
 * @param {object} db      an open database handle
 * @param {object} user    a row carrying at least `id`, `tfa_secret`, `tfa_last_counter`
 * @param {string} token   the six digits the caller supplied
 * @returns {true|false|'unavailable'}
 *   `true`  — valid and not previously used, and the high-water mark is stored.
 *   `false` — the code is wrong, or has already been spent.
 *   `'unavailable'` — the code looked right but the high-water mark could NOT be
 *   stored, so single-use cannot be guaranteed. The caller must refuse the
 *   sign-in and say so; see the note on the write below.
 */
export function verifyTotpOnce(db, user, token) {
  const result = verifyTotpStep(token, user?.tfa_secret);
  if (!result.valid) return false;

  /**
   * `!= null`, not a truthiness test.
   *
   * `tfa_last_counter` is NULL until the first successful verification, and a
   * truthy check would also skip the comparison for a legitimately stored `0`.
   * More importantly, treating NULL as `0` and comparing `counter <= 0` would be
   * false for every real counter — the check would pass vacuously and the replay
   * protection would be decorative.
   */
  const last = user.tfa_last_counter;
  if (last != null && result.counter <= Number(last)) return false;

  /**
   * The write is guarded, and a failure is neither swallowed nor allowed to
   * become a 500.
   *
   * This statement is the ONLY write in the whole TOTP login path, which gave
   * the failure a memorable shape: on a database missing `tfa_last_counter`
   * (schema behind migration 029), a *correct* code threw here and surfaced as
   * "Internal server error during 2FA login", while a *wrong* code answered a
   * clean 401. Right code fails, wrong code behaves — reported as "Authenticator
   * 2FA produces Internal Server Error".
   *
   * Three behaviours were possible and only one is defensible:
   *
   *   - Let it throw (what it did). A user with a correct code and a healthy
   *     authenticator cannot sign in and is told nothing useful.
   *   - Catch and return true. The sign-in completes, but the accepted step was
   *     never recorded, so the same intercepted code can be replayed for the
   *     rest of its window. That is silently turning off the control this file
   *     exists to provide, on exactly the databases least likely to be watched.
   *   - Catch and report that verification is unavailable. The sign-in is
   *     refused, the operator gets a loud log line naming the cause, and the
   *     user is pointed at their recovery codes — which is what recovery codes
   *     are for.
   *
   * The third. Failing closed on a control that cannot be enforced is the same
   * call `reauth.js` makes about an unspendable grant.
   */
  try {
    db.prepare('UPDATE users SET tfa_last_counter = ? WHERE id = ?').run(result.counter, user.id);
  } catch (err) {
    console.error(
      '[2fa] Could not record the TOTP replay high-water mark; refusing the sign-in '
      + 'rather than accepting a code that cannot be made single-use. '
      + 'If this names a missing column, the database schema is behind — run the server '
      + 'once through initDatabase() to apply pending migrations.',
      err
    );
    return 'unavailable';
  }
  return true;
}
