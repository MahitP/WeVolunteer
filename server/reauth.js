import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { SENSITIVE_ACTIONS, isSensitiveAction, paramsHash } from './sensitiveActions.js';

/**
 * The step-up challenge lifecycle: open → grant → consume, then swept.
 *
 * ── What a challenge is ──
 *
 * A row in `reauth_challenges` is a grant of AAL2 for ONE action, with THOSE
 * arguments, from THAT session, for five minutes, once. All four bindings are
 * load-bearing and each one closes a real hole:
 *
 *   - action     — verifying to change your email must not delete your account
 *   - params     — verifying to move your address to a@x.com must not move it
 *                  to attacker@x.com; this is the binding most step-up
 *                  implementations forget, and the one an attacker with a
 *                  stolen session actually reaches for
 *   - session    — a grant obtained in the victim's browser must not be
 *                  spendable from the attacker's
 *   - single use — a replayed grant is a second free sensitive action
 *
 * ── Why a table rather than a claim ──
 *
 * Recorded server-side because a JWT claim cannot be revoked inside its own
 * lifetime, and because "spent" is a fact about the world that has to survive
 * the response that created it.
 *
 * ── Boundaries ──
 *
 * This module knows nothing about HTTP: no req, no res, no status codes. It
 * returns `{ ok, error }` and the routes map that onto responses. It also
 * imports no database — `db` arrives as an argument on every call, so a test
 * can drive it against a throwaway file and `utils.js` can pass the live
 * connection without this file reaching for one.
 *
 * Timestamps are ISO-8601 UTC from JS, never SQLite's `datetime('now')`:
 * `expires_at` is compared as a string, and mixing the two formats produces a
 * challenge that silently never expires (TD-10).
 */

/**
 * Five minutes. Long enough to find your password manager, short enough that a
 * grant left open on an unattended screen is not a standing authorisation.
 */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

/** Guesses allowed against one challenge before it is dead. */
export const MAX_ATTEMPTS = 5;

/**
 * How long an expired row is kept before the sweep removes it.
 *
 * Not zero, deliberately. A row deleted the instant it expires can no longer
 * tell a user "your verification timed out" — it answers "no such challenge",
 * the same thing a forged id gets. Keeping it an hour past expiry costs nothing
 * (it is ungrantable and unconsumable from the moment it expires) and keeps the
 * honest message available for the case that actually happens. It also bounds
 * how long `ip_hash` — network metadata about a minor — is retained.
 */
export const CHALLENGE_RETENTION_MS = 60 * 60 * 1000;

/**
 * The account has no password to compare against.
 *
 * `users.password_hash` is NOT NULL, so an OAuth-only account stores this
 * sentinel instead. It is not a bcrypt hash: comparing against it yields false,
 * which reads as "wrong password" — five of those and the user, who has no
 * password to give, is locked out of the only prompt they were offered.
 */
const OAUTH_ONLY = '!OAUTH_ONLY!';

/**
 * The closed set of refusals. Exported so the routes can map each to a status
 * code and a message in one place instead of matching on strings.
 */
export const REAUTH_ERRORS = Object.freeze({
  NOT_FOUND: 'not_found',
  EXPIRED: 'expired',
  CONSUMED: 'consumed',
  LOCKED: 'locked',
  NOT_GRANTED: 'not_granted',
  INVALID_PASSWORD: 'invalid_password',
  PASSWORD_UNAVAILABLE: 'password_unavailable',
  PROVIDER_NOT_LINKED: 'provider_not_linked',
  PROVIDER_MISMATCH: 'provider_mismatch',
  METHOD_NOT_ALLOWED: 'method_not_allowed',
  ACTION_MISMATCH: 'action_mismatch',
  PARAMS_MISMATCH: 'params_mismatch',
  SESSION_MISMATCH: 'session_mismatch'
});

const E = REAUTH_ERRORS;

const fail = (error, extra) => ({ ok: false, error, ...extra });

/**
 * The challenge, scoped to its owner.
 *
 * Every lookup is by id AND user_id, so a challenge id belonging to someone
 * else is indistinguishable from one that does not exist — the id is not a
 * secret worth confirming.
 *
 * This scoping is a second line: the two statements that actually WRITE
 * (commitGrant and the consume UPDATE) each carry their own `user_id = ?`, and
 * mutation testing confirms those are the load-bearing ones. Removing it here
 * changes only which error a stranger sees, but keep it — a diagnosis built
 * from someone else's row is one refactor away from being trusted.
 */
function load(db, challengeId, userId) {
  return db.prepare('SELECT * FROM reauth_challenges WHERE id = ? AND user_id = ?')
    .get(challengeId, userId);
}

/**
 * Why this challenge cannot be granted, or null if it can.
 *
 * Ordered most-permanent-first: consumed and locked are terminal states, and
 * saying so is more useful than "expired" for a row that is also both.
 */
function notGrantable(row, nowIso) {
  if (!row) return E.NOT_FOUND;
  if (row.consumed_at) return E.CONSUMED;
  if (row.attempts >= MAX_ATTEMPTS) return E.LOCKED;
  // String comparison of two ISO-8601 UTC timestamps — same format on both
  // sides, which is the whole reason this module never uses datetime('now').
  if (row.expires_at <= nowIso) return E.EXPIRED;
  return null;
}

/**
 * Records one wrong guess and reports what it cost.
 *
 * A single `attempts = attempts + 1` statement rather than a read, an add and a
 * write, so two guesses arriving together cannot both read `4` and both be
 * allowed. Guarded on the challenge still being open, so a guess against an
 * already-spent challenge cannot drive the counter anywhere.
 */
function recordFailedAttempt(db, row, error) {
  const updated = db.prepare(`
    UPDATE reauth_challenges
       SET attempts = attempts + 1
     WHERE id = ? AND consumed_at IS NULL AND granted_at IS NULL
     RETURNING attempts
  `).get(row.id);

  /**
   * The counter only moves while the challenge is still open, so a wrong guess
   * that arrives just after the row was granted or consumed increments nothing.
   * Fall back to the count we read rather than to MAX_ATTEMPTS: there is
   * nothing left to brute-force on a spent challenge, and reporting a lock that
   * does not exist would send the user to account recovery for no reason.
   */
  const attempts = updated ? updated.attempts : row.attempts;
  if (attempts >= MAX_ATTEMPTS) return fail(E.LOCKED, { attemptsRemaining: 0 });
  return fail(error, { attemptsRemaining: MAX_ATTEMPTS - attempts });
}

/**
 * Marks the challenge granted, if it is still grantable at this instant.
 *
 * The preconditions are re-stated in the WHERE clause rather than trusted from
 * the earlier read: bcrypt runs between the two (it must — the sync API blocks
 * the event loop, see bcryptAsync.test.js), and the row can change while it
 * does. `changes === 1` is the only proof the grant was ours to make.
 *
 * `attempts < ?` duplicates the lock gate in notGrantable() on purpose. It is
 * the only one of these predicates that survives mutation testing untested,
 * because the earlier gate always fires first — but the earlier gate reads a
 * row from BEFORE the ~100 ms bcrypt comparison, which is exactly the window a
 * parallel guesser would use to push the count over the limit.
 */
function commitGrant(db, { challengeId, userId, method, nowIso }) {
  const granted = db.prepare(`
    UPDATE reauth_challenges
       SET granted_at = ?, method = ?
     WHERE id = ? AND user_id = ?
       AND consumed_at IS NULL
       AND granted_at IS NULL
       AND expires_at > ?
       AND attempts < ?
  `).run(nowIso, method, challengeId, userId, nowIso, MAX_ATTEMPTS).changes === 1;

  if (granted) return { ok: true };

  /**
   * The write lost. Reached only AFTER the verification itself succeeded, so
   * the caller has proved who they are; the question is only what state the
   * row is in.
   *
   * A challenge that is already granted and still spendable is the
   * double-submitted verify form, and reporting an error for it would be a
   * lie — the user asked for a grant and there is one. Anything else is a
   * genuine refusal.
   */
  const after = load(db, challengeId, userId);
  if (after && after.granted_at && !after.consumed_at && after.expires_at > nowIso) {
    return { ok: true };
  }
  return fail(notGrantable(after, new Date().toISOString()) ?? E.NOT_FOUND);
}

/**
 * Opens a challenge for one action with its arguments bound in.
 *
 * `methods` is what THIS account can actually satisfy — the registry's list of
 * methods for the action, narrowed to the ones the user can answer. An account
 * with no password is never offered a password prompt; an account with no
 * linked provider is never sent to one. An empty list is possible in principle
 * and is left for the caller to reject: it means the account cannot prove
 * itself at all, which is a recovery problem, not a challenge problem.
 *
 * Throws rather than returning an error on a bad call, because there is no
 * error channel in the return shape and both cases are coding errors at the
 * call site: an unregistered action, or a session with no `jti` to bind to. A
 * grant bound to no session is not a step-up — anyone holding the id could
 * spend it — so failing loudly is the only safe answer.
 */
export function openChallenge({ db, userId, action, params = {}, sessionJti, ipHash = null }) {
  if (!userId) throw new Error('openChallenge: a userId is required');
  if (!isSensitiveAction(action)) throw new Error(`openChallenge: unknown sensitive action: ${action}`);
  if (!sessionJti) throw new Error('openChallenge: a session jti is required to bind the challenge');

  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId);
  if (!user) throw new Error(`openChallenge: no such user: ${userId}`);

  const linked = db.prepare('SELECT COUNT(*) AS c FROM oauth_accounts WHERE user_id = ?').get(userId).c;
  const available = {
    password: user.password_hash !== OAUTH_ONLY && !!user.password_hash,
    oauth: linked > 0
  };
  const methods = SENSITIVE_ACTIONS[action].methods.filter(m => available[m]);

  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_MS).toISOString();
  const id = `reauth-${crypto.randomUUID()}`;

  db.prepare(`
    INSERT INTO reauth_challenges
      (id, user_id, action, params_hash, method, session_jti, created_at, expires_at, granted_at, consumed_at, attempts, ip_hash)
    VALUES (?, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, 0, ?)
  `).run(id, userId, action, paramsHash(action, params), sessionJti, nowIso, expiresAt, ipHash);

  return { id, methods, expiresAt };
}

/** Whether the action still permits this verification method. */
function methodAllowed(row, method) {
  // `?.` because an action removed from the registry leaves rows behind; those
  // become ungrantable rather than throwing.
  return (SENSITIVE_ACTIONS[row.action]?.methods ?? []).includes(method);
}

/**
 * Grants a challenge by re-checking the account password.
 *
 * bcrypt is awaited outside any transaction: `bcryptjs` is pure JavaScript, so
 * the sync API holds the single event-loop thread for ~100 ms per comparison,
 * and an `await` inside an open SQLite transaction lets unrelated statements
 * interleave with it. bcryptAsync.test.js guards both.
 */
export async function grantByPassword({ db, challengeId, userId, password }) {
  const nowIso = new Date().toISOString();
  const row = load(db, challengeId, userId);

  const blocked = notGrantable(row, nowIso);
  if (blocked) return fail(blocked);
  if (!methodAllowed(row, 'password')) return fail(E.METHOD_NOT_ALLOWED);

  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId);
  if (!user) return fail(E.NOT_FOUND);

  /**
   * The sentinel check, before bcrypt and before the attempt counter.
   *
   * Without it, `bcrypt.compare(anything, '!OAUTH_ONLY!')` is false and the
   * account is told its password is wrong — an answer that is not true, cannot
   * be acted on, and after five tries locks the challenge. Not counting this as
   * an attempt matters just as much: a client that probes the password path
   * before reading `methods` must not spend the user's budget on a question
   * they were never able to answer.
   */
  if (!user.password_hash || user.password_hash === OAUTH_ONLY) {
    return fail(E.PASSWORD_UNAVAILABLE);
  }

  // bcryptjs throws on a non-string, and an empty password is a guess like any
  // other — both are wrong answers, not crashes.
  if (typeof password !== 'string' || password.length === 0) {
    return recordFailedAttempt(db, row, E.INVALID_PASSWORD);
  }

  const matches = await bcrypt.compare(password, user.password_hash);
  if (!matches) return recordFailedAttempt(db, row, E.INVALID_PASSWORD);

  return commitGrant(db, { challengeId, userId, method: 'password', nowIso });
}

/**
 * Grants a challenge from a completed provider re-consent.
 *
 * The `subject` is the provider's `sub` claim from the fresh callback, and it
 * is checked against the `provider_user_id` on THIS user's linked row. Skipping
 * that comparison would mean any account at that provider satisfies the
 * challenge: an attacker with a stolen session clicks "verify with Google",
 * signs in as themselves, and is re-verified as the victim. The re-consent only
 * proves who the person at the keyboard is; the row is what ties that to the
 * account being acted on.
 *
 * The caller is responsible for having forced a genuine re-authentication
 * (`prompt=login`, and `max_age=0` for Google) — this function cannot tell a
 * fresh sign-in from a silently reissued session.
 */
export async function grantByOAuth({ db, challengeId, userId, provider, subject }) {
  const nowIso = new Date().toISOString();
  const row = load(db, challengeId, userId);

  const blocked = notGrantable(row, nowIso);
  if (blocked) return fail(blocked);
  if (!methodAllowed(row, 'oauth')) return fail(E.METHOD_NOT_ALLOWED);

  const link = db.prepare(
    'SELECT provider_user_id FROM oauth_accounts WHERE user_id = ? AND provider = ?'
  ).get(userId, provider);

  // Not a wrong answer, a missing one: no attempt is spent, because no amount
  // of guessing makes an unlinked provider linked.
  if (!link) return fail(E.PROVIDER_NOT_LINKED);

  // A mismatch IS a wrong answer — it is the guessable half of this path, so it
  // costs an attempt exactly like a wrong password does.
  if (!subject || String(subject) !== String(link.provider_user_id)) {
    return recordFailedAttempt(db, row, E.PROVIDER_MISMATCH);
  }

  return commitGrant(db, { challengeId, userId, method: 'oauth', nowIso });
}

/**
 * Spends a granted challenge, or explains why it cannot be spent.
 *
 * ── Why this is one statement ──
 *
 * Every binding is a predicate in a single conditional UPDATE, and `changes`
 * is the answer. A read-then-write — fetch the row, compare in JS, write
 * `consumed_at` — has a window between the two in which a second caller reads
 * the same un-consumed row, and both spend the same grant. Here the database
 * decides, once.
 *
 * The diagnosis that follows a miss re-reads the row purely to produce a useful
 * error. It cannot grant anything: by then the UPDATE has already declined.
 *
 * Never throws. It is called from inside the handler's transaction, where an
 * exception would roll back the caller's own work rather than simply denying
 * it — so even an unregistered action comes back as a mismatch.
 *
 * `async` despite awaiting nothing, so that every entry point in this module
 * has the same shape at the call site and adding an await here later is not a
 * breaking change for the routes.
 */
export async function consumeChallenge({ db, challengeId, userId, action, params = {}, sessionJti }) {
  const nowIso = new Date().toISOString();

  // A stored challenge can only ever hold a registered action, so an
  // unregistered one cannot match any row — and paramsHash would throw on it.
  if (!isSensitiveAction(action)) return fail(E.ACTION_MISMATCH);

  const expectedHash = paramsHash(action, params);

  /**
   * `action` is checked here as well as through `params_hash`, which folds the
   * action name into its digest — so this predicate can never be the only thing
   * that refuses a request, and mutation testing shows it survives deletion.
   * It stays because the two are only equivalent for as long as paramsHash
   * keeps hashing `${action}|...`, and nothing in that module promises the
   * binding it is providing here.
   */
  const spent = db.prepare(`
    UPDATE reauth_challenges
       SET consumed_at = ?
     WHERE id = ?
       AND user_id = ?
       AND action = ?
       AND params_hash = ?
       AND session_jti = ?
       AND granted_at IS NOT NULL
       AND consumed_at IS NULL
       AND expires_at > ?
  `).run(nowIso, challengeId, userId, action, expectedHash, sessionJti ?? null, nowIso).changes === 1;

  if (spent) return { ok: true };

  // ── Diagnosis only. Nothing below can authorise anything. ──
  const row = load(db, challengeId, userId);
  if (!row) return fail(E.NOT_FOUND);
  if (row.consumed_at) return fail(E.CONSUMED);
  if (row.expires_at <= nowIso) return fail(E.EXPIRED);
  if (row.action !== action) return fail(E.ACTION_MISMATCH);
  if (row.params_hash !== expectedHash) return fail(E.PARAMS_MISMATCH);
  if (row.session_jti !== sessionJti) return fail(E.SESSION_MISMATCH);
  if (row.attempts >= MAX_ATTEMPTS) return fail(E.LOCKED);
  if (!row.granted_at) return fail(E.NOT_GRANTED);
  return fail(E.NOT_FOUND);
}

/**
 * Deletes challenges whose retention window has closed.
 *
 * Driven by the maintenance sweep in utils.js. Nothing here is recoverable and
 * nothing here is a record: an expired challenge cannot be granted or consumed,
 * so this deletes only rows that can no longer do anything.
 */
export function sweepExpiredChallenges(db, now = new Date()) {
  const cutoff = new Date(now.getTime() - CHALLENGE_RETENTION_MS).toISOString();
  return db.prepare('DELETE FROM reauth_challenges WHERE expires_at < ?').run(cutoff).changes;
}
