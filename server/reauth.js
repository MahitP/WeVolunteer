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
 * Guesses allowed against one ACCOUNT before every challenge it holds is dead.
 *
 * ── Why this equals MAX_ATTEMPTS, and used to be three times it ──
 *
 * `MAX_ATTEMPTS` on its own bounds nothing an attacker cares about: opening a
 * fresh challenge costs one request and starts a new counter at zero, so a holder
 * of a stolen session guesses indefinitely at one extra round trip per attempt.
 * That is why an account-level budget exists at all, and it is still the half
 * `app.js`'s per-IP `reauthLimiter` cannot cover for an attacker with more than
 * one address.
 *
 * It was 15 — "three challenges' worth" — and that produced a user-visible lie.
 * The dialog counts down from five, says "locked out" at zero, and a page refresh
 * opens a new challenge whose counter starts again: the account really did have
 * ten guesses left, so the refresh really did work. A lockout somebody can clear
 * by pressing F5 teaches that lockouts are decorative, which is worse than either
 * a stricter or a looser limit honestly stated.
 *
 * So the two are the same number and there is one budget: five wrong answers per
 * account per window, whichever challenges they were spread across. A refresh now
 * inherits the spent count instead of resetting it, and the number the dialog
 * shows is the number the server enforces.
 *
 * Five is not a tightening in practice — `reauthLimiter` already allows five
 * failures per IP per fifteen minutes, so five was the effective ceiling for a
 * single-address caller before this. What changed is that the account budget no
 * longer exceeds the one the interface promises.
 *
 * Tripping it is not a denial-of-service worth worrying about: opening a challenge
 * requires an authenticated session, so anyone who can reach this already holds the
 * thing step-up exists to contain.
 */
export const MAX_ACCOUNT_ATTEMPTS = MAX_ATTEMPTS;

/**
 * The window the account-level count is taken over.
 *
 * Attempts carry no timestamp of their own — `attempts` is a counter on the
 * challenge — so the window is applied to `created_at` and every attempt on a
 * counted challenge is attributed to it. A challenge lives five minutes, so
 * that attribution is never off by more than a challenge's lifetime, and it
 * errs in the safe direction: an old challenge's guesses keep counting for
 * slightly longer than they strictly happened.
 *
 * Shorter than CHALLENGE_RETENTION_MS on purpose — the sweep must not be what
 * decides when someone is allowed to guess again.
 */
export const ACCOUNT_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

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
  ACCOUNT_LOCKED: 'account_locked',
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
 * This scoping is a second line: all THREE statements that WRITE — commitGrant,
 * the consume UPDATE, and `recordFailedAttempt` — carry their own
 * `user_id = ?`, and mutation testing confirms those are the load-bearing ones.
 * Removing it here changes only which error a stranger sees, but keep it — a
 * diagnosis built from someone else's row is one refactor away from being
 * trusted.
 *
 * `recordFailedAttempt` was the exception until the T3 fix round, and the
 * comment here asserted it was not: it counted two writers when there were
 * three. It is reached only with a row this function already scoped, so nothing
 * was exploitable through it — but a predicate that is missing and a comment
 * that says it is present is worse than either alone, because the next reader
 * checks the comment.
 */
async function load(db, challengeId, userId) {
  return await db.prepare('SELECT * FROM reauth_challenges WHERE id = ? AND user_id = ?')
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
 * allowed.
 *
 * ── Why the guard is `consumed_at IS NULL` and nothing else ──
 *
 * It used to be `consumed_at IS NULL AND granted_at IS NULL`, and the extra
 * predicate was a brute-force bypass in a state the app reaches on its own.
 * `notGrantable` does NOT refuse an already-granted challenge — deliberately,
 * so a double-submitted verify form still has to produce the password — so
 * between a grant and its consumption the password path stays open. With
 * `granted_at IS NULL` in the WHERE clause every guess in that window updated
 * nothing, `attempts` stayed pinned at whatever it was, and the caller was told
 * four tries remained, for ever. A grant lives up to five minutes; that is an
 * unmetered password oracle for anyone holding the session, and it is reached
 * by the ordinary sequence of verifying with a provider and then guessing.
 *
 * Consumed is different and still excluded: a spent challenge authorises
 * nothing, so guesses against it are not guesses at anything.
 *
 * `user_id = ?` is the caller's, not `row.user_id`. The row was already loaded
 * scoped, so this cannot currently refuse anything — it is here so that the
 * statement names the account it is charging, in the file where every other
 * write already does.
 */
async function recordFailedAttempt(db, { row, userId, error, nowIso }) {
  const updated = await db.prepare(`
    UPDATE reauth_challenges
       SET attempts = attempts + 1
     WHERE id = ? AND user_id = ? AND consumed_at IS NULL
     RETURNING attempts
  `).get(row.id, userId);

  /**
   * Fall back to the count we read rather than to MAX_ATTEMPTS: the only way
   * the update misses now is a challenge consumed between the two statements,
   * where there is nothing left to brute-force, and reporting a lock that does
   * not exist would send the user to account recovery for no reason.
   */
  const attempts = updated ? updated.attempts : row.attempts;

  /**
   * Remaining is the ACCOUNT's budget, not this row's.
   *
   * This is the whole fix for the refresh bypass. Reporting `MAX_ATTEMPTS -
   * attempts` described one challenge, so a new challenge reported a full five
   * again while the account had already spent them — the number the dialog showed
   * was not the number the server would enforce, and refreshing appeared to work
   * because it did.
   *
   * Read AFTER the increment above, so the figure already includes this guess.
   */
  const remaining = await accountAttemptsRemaining(db, userId, nowIso ?? new Date().toISOString());

  /**
   * ACCOUNT_LOCKED, not LOCKED, when the budget that is actually spent is the
   * account's — because the two say different things and only one of them is
   * true here. `LOCKED` reads "Please start again", which was correct when a new
   * challenge really did restore five guesses; now that it does not, sending the
   * user to start again would be the same misdirection in a different sentence.
   * `ACCOUNT_LOCKED` says to wait, which is the thing that helps.
   *
   * `LOCKED` is still right for a dead row whose account budget has since aged
   * out of the window: there, starting again genuinely does work.
   */
  if (remaining <= 0) return fail(E.ACCOUNT_LOCKED, { attemptsRemaining: 0 });
  if (attempts >= MAX_ATTEMPTS) return fail(E.LOCKED, { attemptsRemaining: 0 });
  return fail(error, { attemptsRemaining: remaining });
}

/**
 * Whether this account has spent its guessing budget across ALL its challenges.
 *
 * Summed over rows rather than tracked on the user, because the number is only
 * ever needed at this instant and a column would be a second thing to keep
 * true. `attempts` is already the count of wrong answers, and the sweep's
 * retention window is longer than this one, so every row that should be counted
 * is still present to count.
 */
async function accountAttemptsSpent(db, userId, nowIso) {
  const since = new Date(new Date(nowIso).getTime() - ACCOUNT_ATTEMPT_WINDOW_MS).toISOString();
  const { spent } = await db.prepare(`
    SELECT COALESCE(SUM(attempts), 0) AS spent
      FROM reauth_challenges
     WHERE user_id = ? AND created_at > ?
  `).get(userId, since);
  return Number(spent) || 0;
}

/** What the caller may still spend. Never negative, so the client can render it. */
async function accountAttemptsRemaining(db, userId, nowIso) {
  return Math.max(0, MAX_ACCOUNT_ATTEMPTS - await accountAttemptsSpent(db, userId, nowIso));
}

async function accountAttemptsExhausted(db, userId, nowIso) {
  return await accountAttemptsSpent(db, userId, nowIso) >= MAX_ACCOUNT_ATTEMPTS;
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
async function commitGrant(db, { challengeId, userId, method, nowIso }) {
  const granted = (await db.prepare(`
    UPDATE reauth_challenges
       SET granted_at = ?, method = ?
     WHERE id = ? AND user_id = ?
       AND consumed_at IS NULL
       AND granted_at IS NULL
       AND expires_at > ?
       AND attempts < ?
  `).run(nowIso, method, challengeId, userId, nowIso, MAX_ATTEMPTS)).changes === 1;

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
  const after = await load(db, challengeId, userId);
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
export async function openChallenge({ db, userId, action, params = {}, sessionJti, ipHash = null }) {
  if (!userId) throw new Error('openChallenge: a userId is required');
  if (!isSensitiveAction(action)) throw new Error(`openChallenge: unknown sensitive action: ${action}`);
  if (!sessionJti) throw new Error('openChallenge: a session jti is required to bind the challenge');

  const user = await db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId);
  if (!user) throw new Error(`openChallenge: no such user: ${userId}`);

  const linked = (await db.prepare('SELECT COUNT(*) AS c FROM oauth_accounts WHERE user_id = ?').get(userId)).c;
  const available = {
    password: user.password_hash !== OAUTH_ONLY && !!user.password_hash,
    oauth: linked > 0
  };
  const methods = SENSITIVE_ACTIONS[action].methods.filter(m => available[m]);

  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_MS).toISOString();
  const id = `reauth-${crypto.randomUUID()}`;

  await db.prepare(`
    INSERT INTO reauth_challenges
      (id, user_id, action, params_hash, method, session_jti, created_at, expires_at, granted_at, consumed_at, attempts, ip_hash)
    VALUES (?, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, 0, ?)
  `).run(id, userId, action, paramsHash(action, params), sessionJti, nowIso, expiresAt, ipHash);

  /**
   * The account's remaining budget travels with the new challenge.
   *
   * A fresh row always has `attempts = 0`, so anything derived from the row
   * alone would tell a refreshed dialog it has a full five guesses when the
   * account has none left — the exact lie this module used to tell. The count
   * is the account's, so opening a challenge cannot launder a spent budget into
   * an unspent one.
   *
   * Opening is still ALLOWED at zero rather than refused: the grant paths below
   * answer with `ACCOUNT_LOCKED` before doing any work, and a challenge that
   * exists and reports nothing left is easier to render honestly than an
   * open call that fails.
   */
  return {
    id,
    methods,
    expiresAt,
    attemptsRemaining: await accountAttemptsRemaining(db, userId, nowIso)
  };
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
  const row = await load(db, challengeId, userId);
  if (!row) return fail(E.NOT_FOUND);

  /**
   * The account ceiling outranks every per-challenge diagnosis except "no such
   * challenge", and the ORDER is a correctness detail rather than a preference.
   *
   * `notGrantable` reports `LOCKED` for a row at its own limit, which the client
   * renders as "Please start again". Diagnosed first, the fifth wrong answer
   * says "wait a few minutes" (the account budget just emptied) and a sixth on
   * the same open dialog says "start again" — two different instructions for one
   * situation, one of which does not work. That contradiction is the same class
   * of defect as the refresh bypass itself, so the dominant fact is reported
   * first.
   *
   * `NOT_FOUND` still wins: a challenge id that names nothing is not a statement
   * about the account, and answering it with a lockout would be a worse
   * diagnosis, not a better one.
   */
  if (await accountAttemptsExhausted(db, userId, nowIso)) return fail(E.ACCOUNT_LOCKED);

  const blocked = notGrantable(row, nowIso);
  if (blocked) return fail(blocked);
  if (!methodAllowed(row, 'password')) return fail(E.METHOD_NOT_ALLOWED);

  /* The ceiling was already checked above — before bcrypt, so an exhausted
     account costs no CPU, and before the sentinel check could tell an attacker
     anything about the account's shape. */
  const user = await db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId);
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
    return await recordFailedAttempt(db, { row, userId, error: E.INVALID_PASSWORD, nowIso });
  }

  const matches = await bcrypt.compare(password, user.password_hash);
  if (!matches) return await recordFailedAttempt(db, { row, userId, error: E.INVALID_PASSWORD, nowIso });

  return await commitGrant(db, { challengeId, userId, method: 'password', nowIso });
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
  const row = await load(db, challengeId, userId);
  if (!row) return fail(E.NOT_FOUND);

  /**
   * The account ceiling outranks every per-challenge diagnosis except "no such
   * challenge", and the ORDER is a correctness detail rather than a preference.
   *
   * `notGrantable` reports `LOCKED` for a row at its own limit, which the client
   * renders as "Please start again". Diagnosed first, the fifth wrong answer
   * says "wait a few minutes" (the account budget just emptied) and a sixth on
   * the same open dialog says "start again" — two different instructions for one
   * situation, one of which does not work. That contradiction is the same class
   * of defect as the refresh bypass itself, so the dominant fact is reported
   * first.
   *
   * `NOT_FOUND` still wins: a challenge id that names nothing is not a statement
   * about the account, and answering it with a lockout would be a worse
   * diagnosis, not a better one.
   */
  if (await accountAttemptsExhausted(db, userId, nowIso)) return fail(E.ACCOUNT_LOCKED);

  const blocked = notGrantable(row, nowIso);
  if (blocked) return fail(blocked);
  if (!methodAllowed(row, 'oauth')) return fail(E.METHOD_NOT_ALLOWED);

  const link = await db.prepare(
    'SELECT provider_user_id FROM oauth_accounts WHERE user_id = ? AND provider = ?'
  ).get(userId, provider);

  // Not a wrong answer, a missing one: no attempt is spent, because no amount
  // of guessing makes an unlinked provider linked.
  if (!link) return fail(E.PROVIDER_NOT_LINKED);

  // A mismatch IS a wrong answer — it is the guessable half of this path, so it
  // costs an attempt exactly like a wrong password does.
  if (!subject || String(subject) !== String(link.provider_user_id)) {
    return await recordFailedAttempt(db, { row, userId, error: E.PROVIDER_MISMATCH, nowIso });
  }

  return await commitGrant(db, { challengeId, userId, method: 'oauth', nowIso });
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
 * ── Why this entry point alone is synchronous ──
 *
 * The two grant functions are `async` because bcrypt genuinely is. This one is
 * called from INSIDE a route handler's `inTransaction(...)` block, and
 * `bcryptAsync.test.js` fails the build on any `await` between `inTransaction(`
 * and its closing brace — because an await inside a synchronous SQLite
 * transaction lets unrelated statements interleave with an open transaction.
 * That guard is right, so spending a grant has to be possible without one.
 * There is nothing here to await: one UPDATE and some comparisons, all
 * synchronous under `node:sqlite`.
 *
 * It was `async` until Task 6, on the reasoning that a uniform shape would let
 * an await be added later without breaking callers. The opposite turned out to
 * be true — the only correct call site is one where an await is forbidden — and
 * `await consumeChallenge(...)` still reads fine either way, because awaiting a
 * plain value is a no-op. Every existing caller was left untouched.
 */
export async function consumeChallenge({ db, challengeId, userId, action, params = {}, sessionJti }) {
  const nowIso = new Date().toISOString();

  // A stored challenge can only ever hold a registered action, so an
  // unregistered one cannot match any row — and paramsHash would throw on it.
  if (!isSensitiveAction(action)) return fail(E.ACTION_MISMATCH);

  const expectedHash = paramsHash(action, params);

  /**
   * `attempts < ?` is here because `peekChallenge` already refuses a locked row
   * and the two must not disagree about whether a grant is spendable. Before
   * the T3 fix round it could not be reached: the counter froze the moment a
   * challenge was granted, so no granted row ever held five attempts. Now that
   * guessing in the granted window is counted, a grant can be locked after it
   * was earned — and `requireAAL2`, which asks `peekChallenge`, would refuse the
   * request while this statement still spent the grant behind it.
   *
   * `action` is checked here as well as through `params_hash`, which folds the
   * action name into its digest — so this predicate can never be the only thing
   * that refuses a request, and mutation testing shows it survives deletion.
   * It stays because the two are only equivalent for as long as paramsHash
   * keeps hashing `${action}|...`, and nothing in that module promises the
   * binding it is providing here.
   */
  const spent = (await db.prepare(`
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
       AND attempts < ?
  `).run(nowIso, challengeId, userId, action, expectedHash, sessionJti ?? null, nowIso, MAX_ATTEMPTS))
    .changes === 1;

  if (spent) return { ok: true };

  // ── Diagnosis only. Nothing below can authorise anything. ──
  const row = await load(db, challengeId, userId);
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
 * Reads a challenge's spendability WITHOUT spending it.
 *
 * ── Why this exists ──
 *
 * `authenticateToken` has to decide a request's assurance level before the
 * handler runs, and the only honest source for that is this table. It could
 * not use `consumeChallenge`: a middleware that consumes on the way in burns
 * the grant even when the handler then rejects the request for an unrelated
 * reason — a failed validation, a 409, a rolled-back transaction — leaving the
 * user to re-verify for a request that never happened. Assurance is a question
 * asked on the way in; consumption is a decision made in the handler's
 * transaction, next to the work it authorises.
 *
 * It also could not query `reauth_challenges` directly from utils.js. Every
 * statement against this table lives in this module, so the bindings are
 * enforced in one place and a second reader cannot quietly implement four of
 * the five.
 *
 * ── Why it cannot mutate ──
 *
 * One SELECT, and comparisons in JS. There is no UPDATE, no INSERT and no
 * DELETE on this path, and the projection it returns is frozen, so a caller
 * cannot write through it into a later decision either. The read-then-compare
 * race that makes `consumeChallenge` a single conditional UPDATE is not a
 * hazard here for the same reason: this answers a question and changes
 * nothing, so two callers racing simply both get an answer. Whether the grant
 * was still spendable at the moment it MATTERED is settled by the UPDATE
 * inside `consumeChallenge`, which re-states every predicate below.
 *
 * ── What it does not return ──
 *
 * Not `params_hash`. Assurance is resolved per action, and the params binding
 * is checked when the grant is spent, against the request the handler is
 * actually about to perform. Exposing the hash here would invite a middleware
 * to approximate that check against a body it has not finished parsing.
 *
 * Scoped by user like every other lookup in this module, so another user's
 * challenge id is indistinguishable from one that does not exist.
 */
export async function peekChallenge({ db, challengeId, userId }) {
  // Not an error worth throwing over: an absent or malformed challenge id is
  // what an ordinary request looks like, and this is called from a middleware
  // that must not blow up on one.
  if (!challengeId || !userId) return fail(E.NOT_FOUND);

  const nowIso = new Date().toISOString();
  const row = await load(db, challengeId, userId);

  // Same order and same predicates as consumeChallenge's diagnosis, minus the
  // per-request bindings (action, params, session) that only the caller knows.
  if (!row) return fail(E.NOT_FOUND);
  if (row.consumed_at) return fail(E.CONSUMED);
  if (row.expires_at <= nowIso) return fail(E.EXPIRED);
  if (row.attempts >= MAX_ATTEMPTS) return fail(E.LOCKED);
  if (!row.granted_at) return fail(E.NOT_GRANTED);

  return {
    ok: true,
    challenge: Object.freeze({
      id: row.id,
      userId: row.user_id,
      action: row.action,
      sessionJti: row.session_jti,
      grantedAt: row.granted_at,
      expiresAt: row.expires_at
    })
  };
}

/**
 * Deletes challenges whose retention window has closed.
 *
 * Driven by the maintenance sweep in utils.js. Nothing here is recoverable and
 * nothing here is a record: an expired challenge cannot be granted or consumed,
 * so this deletes only rows that can no longer do anything.
 */
export async function sweepExpiredChallenges(db, now = new Date()) {
  const cutoff = new Date(now.getTime() - CHALLENGE_RETENTION_MS).toISOString();
  return (await db.prepare('DELETE FROM reauth_challenges WHERE expires_at < ?').run(cutoff)).changes;
}
