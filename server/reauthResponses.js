import { consumeChallenge, REAUTH_ERRORS } from './reauth.js';

/**
 * The HTTP vocabulary of step-up, and the one way a handler spends a grant.
 *
 * ── Why this is its own module ──
 *
 * The refusal table started in `reauthRoutes.js`, where the four endpoints that
 * MINT assurance live, and its whole point was to be the only one: "reauth.js
 * returns a closed set of machine-readable refusals; this file maps each to one
 * status and one sentence, in ONE table, so no route can invent a different
 * answer for the same condition." Task 6 gave five more endpoints — in three
 * other route files — the same refusals to answer, so the table had to be
 * reachable from all of them.
 *
 * It could not simply be exported from `reauthRoutes.js`: that file imports
 * `resolveProvider` from `oauthRoutes.js`, so importing back the other way would
 * make the pair a cycle whose correctness depended on which of them app.js
 * happened to load first. It could not move into `reauth.js` either — that
 * module deliberately knows nothing about HTTP (no req, no res, no status
 * codes), which is what lets a test drive the lifecycle without a server.
 * So: one module, imported by all nine routes, no cycle.
 *
 * ── What `spendChallenge` is for ──
 *
 * `requireAAL2` is an early refusal, NOT the check. A handler that gates on it
 * and never consumes leaves the grant spendable again, which defeats single use
 * — and does so invisibly, because every functional test still passes. This
 * function is the one place that reads the three bindings a spend must carry
 * (challenge id, user, session) off the request, so no route can pick up two of
 * three, and it throws rather than returning, so no route can forget to check
 * the result and carry on anyway.
 */

const E = REAUTH_ERRORS;

/**
 * How a lifecycle refusal reaches the client.
 *
 * `locked` is 429 rather than 403 because it is a rate limit by another name —
 * five guesses spent on one challenge — and 429 is what the client already
 * knows how to explain. `expired` is 410 rather than 404 because "your
 * verification timed out, start again" and "no such thing" need different words
 * in the UI, and the challenge row is deliberately kept for an hour past expiry
 * (see CHALLENGE_RETENTION_MS) precisely so that distinction can be made.
 */
export const REFUSALS = Object.freeze({
  [E.NOT_FOUND]: { status: 404, error: 'That verification request no longer exists. Please start again.' },
  [E.EXPIRED]: { status: 410, error: 'That verification timed out. Please start again.' },
  [E.CONSUMED]: { status: 409, error: 'That verification has already been used. Please start again.' },
  [E.LOCKED]: { status: 429, error: 'Too many failed attempts. Please start again.' },
  // Deliberately does NOT say "start again" — starting again is the thing that
  // no longer helps, and that is the whole point of the account-level ceiling.
  [E.ACCOUNT_LOCKED]: {
    status: 429,
    error: 'Too many failed verification attempts. Please wait a few minutes and try again.'
  },
  [E.NOT_GRANTED]: { status: 409, error: 'That verification has not been completed yet.' },
  [E.INVALID_PASSWORD]: { status: 401, error: 'That password is not correct.' },
  [E.PASSWORD_UNAVAILABLE]: {
    status: 409,
    error: 'This account has no password. Verify with your sign-in provider instead.'
  },
  [E.PROVIDER_NOT_LINKED]: {
    status: 409,
    error: 'That provider is not connected to your account. Use one you have connected.'
  },
  [E.PROVIDER_MISMATCH]: {
    status: 401,
    error: 'That is a different account at your provider. Sign in with the one connected here.'
  },
  [E.METHOD_NOT_ALLOWED]: { status: 400, error: 'That verification method cannot be used for this action.' },
  [E.ACTION_MISMATCH]: { status: 409, error: 'That verification was for a different action.' },
  [E.PARAMS_MISMATCH]: { status: 409, error: 'That verification was for different details.' },
  [E.SESSION_MISMATCH]: { status: 409, error: 'That verification belongs to a different sign-in.' }
});

export function refuseReauth(res, result) {
  const mapped = REFUSALS[result.error];
  if (!mapped) {
    // An unmapped refusal is a bug in this table, not in the caller's request.
    // Answering 500 says so, rather than inventing a 400 that sends the user
    // round a loop no message explains.
    console.error('reauth: unmapped refusal', result.error);
    return res.status(500).json({ error: 'Internal server error' });
  }
  return res.status(mapped.status).json({
    error: mapped.error,
    code: result.error,
    ...(result.attemptsRemaining === undefined ? {} : { attemptsRemaining: result.attemptsRemaining })
  });
}

/**
 * A grant that could not be spent, thrown so the transaction around it rolls
 * back.
 *
 * The action and the consumption have to be atomic in both directions: work
 * without a spent grant would make the grant reusable, and a spent grant
 * without the work would make the user re-verify for something that never
 * happened. `inTransaction` gives that for free IF the failure leaves by
 * throwing — a returned `{ok:false}` would commit whatever the handler had
 * already written and then answer 409.
 *
 * Carries the `{ ok:false, error }` from reauth.js so the catch can map it
 * through `refuseReauth` instead of reporting a 500. A failed consume is never a
 * server fault: it is a stale, replayed, or mis-bound grant, and each of those
 * has a status and a sentence in the table above.
 */
export class ChallengeNotSpent extends Error {
  constructor(result) {
    super(`reauth: challenge not spent (${result.error})`);
    this.name = 'ChallengeNotSpent';
    this.result = result;
  }
}

/**
 * Spends the caller's grant for `action` with `params`, or throws.
 *
 * MUST be called inside the handler's own `inTransaction(...)`, as the first
 * statement, so nothing is written before the grant is proved spendable.
 * `consumeChallenge` is synchronous for exactly this reason — see its docstring,
 * and `bcryptAsync.test.js` for the guard that forbids an await in there.
 *
 * The three bindings come from `req` and nowhere else:
 *   - `req.reauthChallengeId` — set by `authenticateToken` from the ONE
 *     definition of the header name; never re-read the header here.
 *   - `req.user.id` — the caller, never a value from the request body.
 *   - `req.sessionJti` — this sign-in, so a grant obtained in the victim's
 *     browser is not spendable from the attacker's.
 *
 * `action` and `params` are the handler's, because they must describe the work
 * that is actually about to happen rather than what the middleware was told to
 * expect. `params` must carry exactly the keys the registry's `bindsParams`
 * lists for the action — no more, since paramsHash ignores the rest, and no
 * fewer, since a missing key hashes as absent and will not match a grant that
 * had it.
 */
export function spendChallenge(db, req, action, params = {}) {
  const result = consumeChallenge({
    db,
    challengeId: req.reauthChallengeId,
    userId: req.user.id,
    action,
    params,
    sessionJti: req.sessionJti
  });
  if (!result.ok) throw new ChallengeNotSpent(result);
  return result;
}
