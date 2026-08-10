import jwt from 'jsonwebtoken';
import { db } from './db.js';
import { notificationService } from './services/notificationService.js';
import { sendNotificationEmail, sendMail } from './email.js';
import { JWT_SECRET, REQUIRE_EMAIL_VERIFICATION, isEmailGateAllowed, COOKIE_NAME, REQUIRE_ADMIN_2FA, DEMO_MODE } from './config.js';
import { principalFor, requiresSecondFactor, ROLE, ROLES } from './authz.js';
import { SERVICE_HOUR_GOAL } from './milestones.js';
import { grantsFor } from './userCapabilities.js';
import { withheldCapabilitiesFor } from './organizerAgreement.js';
import { sweepExpiredChallenges, peekChallenge } from './reauth.js';
import { sweepErrors } from './errorReporter.js';
import { sendErrorAlerts } from './alerting.js';
import { REAUTH_CHALLENGE_HEADER } from './sensitiveActions.js';
import { isSuspended, liftIfExpired, suspensionNotice } from './suspension.js';
import { suspendedMayReach } from './suspendedAccess.js';
/* The distinguished-profile presentation, from the one module that decides it.
   Restated here would be a second answer to "what kind of account is this",
   which is how the self payload and a member's view of the same account come to
   disagree. profileSerializer imports only volunteerStats, so this is not a
   cycle. */
import { distinctionFor, parseHighlights as parseHighlightsList } from './profileSerializer.js';

/**
 * The seeded demo administrator, and the ONLY account that may skip the policy.
 *
 * `db.js` creates it as `admin@example.gov` — an address nobody can receive mail
 * at, which is the whole problem: the account is enrolled in EMAIL two-factor, so
 * signing in requires a code delivered to a mailbox that does not exist. The
 * account is unusable, and it is the account a developer needs to see the
 * administrative surfaces at all.
 *
 * Matched on the address rather than the id so a re-seeded database with a fresh
 * UUID still resolves, and lower-cased because addresses are compared that way
 * everywhere else here.
 */
const DEMO_EXEMPT_EMAILS = new Set(['admin@example.gov']);

/**
 * Whether `user` is the demo administrator, in a process that is actually a demo.
 *
 * ── Why this cannot become a production backdoor ──
 *
 * Three independent things must all be true, and the first cannot be true in
 * production at all: `server.js` refuses to boot when `IS_PRODUCTION && DEMO_MODE`.
 * So the gate is not "an attacker must not guess the address" — the branch does
 * not exist in a production process.
 *
 * On top of that it is a single hardcoded address rather than a pattern, and
 * `super_admin` is excluded outright: an owner account must never be exempt, and
 * naming that here means a demo database that somehow contained one still could
 * not use this path. `db.js` already refuses to boot a demo database holding a
 * super_admin, so this is the second lock on a door that is already bolted.
 *
 * This is deliberately NOT a general "development skips 2FA" switch. That is what
 * `REQUIRE_ADMIN_2FA=false` is for, and it is a different, louder decision: it
 * turns the policy off for every administrator, and production refuses to boot
 * with it. This exempts one seeded fixture and nothing else.
 */
function isDemoExemptAccount(user) {
  if (!DEMO_MODE || !user) return false;
  /* `ROLE.SUPER_ADMIN`, not the literal — `authz.completeness.test.js` fails the
     build on a role name compared as a string, and it is right to: this IS an
     authorization decision, and the remedy its message names is importing the
     name from the one table that defines it. */
  if (user.role === ROLE.SUPER_ADMIN) return false;
  return DEMO_EXEMPT_EMAILS.has(String(user.email || '').toLowerCase());
}

/**
 * Whether the second-factor policy applies to `role` in this deployment.
 *
 * ── Why the policy is one function and not four expressions ──
 *
 * `requiresSecondFactor(role)` in authz.js answers "does the ROLE carry the
 * rule"; `REQUIRE_ADMIN_2FA` answers "is the rule switched on here". Both are
 * needed at four call sites — twice in this file, twice in
 * routes/twoFactorRoutes.js — and for a while only two of them consulted the
 * flag. The result was an asymmetry that is worse than either setting: with the
 * flag off, an administrator could not be REQUIRED to enrol, and an
 * administrator who had enrolled anyway was still refused when they tried to
 * turn it off. Enrolment was optional and irreversible at the same time.
 *
 * `authz.js` cannot answer this itself — it imports nothing, deliberately, so
 * that the capability table cannot acquire a dependency on configuration — so
 * the composition lives here, once.
 *
 * @param {string} role   the account's role
 * @param {object} [user] the account row, when the caller has it. Supplying it is
 *   what enables the demo exemption above; a caller that omits it gets the plain
 *   policy unchanged, which is the safe direction to fail.
 */
export function secondFactorRequiredFor(role, user = null) {
  if (!REQUIRE_ADMIN_2FA) return false;
  if (isDemoExemptAccount(user)) return false;
  return requiresSecondFactor(role);
}

/**
 * The second factors this account can actually satisfy, in the order they should
 * be offered.
 *
 * ── Why this is one function ──
 *
 * Three endpoints tell a half-signed-in caller which methods to present —
 * `POST /api/auth/login` and both `require_2fa` branches in
 * `routes/oauthRoutes.js` — and each built the list inline. All three got it
 * wrong in the same two ways:
 *
 *   • `recovery` was pushed UNCONDITIONALLY, "always available as fallback".
 *     It is not: an account holding zero recovery codes was offered a method
 *     that cannot succeed, on the one screen where the user is already locked
 *     out of everything else. Worse, it was the only method offered to an
 *     account with no codes and an unreachable mailbox.
 *
 *   • TOTP was listed from `tfa_enabled` while the SIGN-IN path verified against
 *     `tfa_secret` without consulting `tfa_enabled` at all. Those disagree for
 *     any account that started an authenticator enrolment and abandoned it —
 *     `POST /api/2fa/generate` stores the pending secret and deliberately leaves
 *     `tfa_enabled` at 0 — so the account carried a live, working second factor
 *     that `/api/2fa/status` reported as off, that its owner had never confirmed
 *     and could not turn off (`/api/2fa/disable` refuses with "2FA is not
 *     enabled"). Two accounts on the pilot deployment were in exactly that
 *     state.
 *
 * So the list is derived once, here, and `POST /api/auth/login-2fa` ENFORCES it
 * rather than trusting the method named in the request. Hiding a button is a
 * courtesy; refusing the method is the control.
 *
 * ── Email is offered whenever it can actually work ──
 *
 * `tfa_email_enabled` used to be the sole test, and it disagreed with the send
 * route, which additionally requires `email_verified`. An account with the flag
 * set and an unconfirmed address was TOLD email was available, shown the radio,
 * and met a 400 when it pressed send.
 *
 * The fix goes the other way round rather than just adding the missing
 * condition, because the product intent is that email is the fallback a person
 * reaches for when their authenticator is gone: once an account has a second
 * factor at all, a CONFIRMED address is enough to receive a code, whether or not
 * anybody separately switched "email 2FA" on. `tfa_email_enabled` therefore
 * still turns email on by itself (it may be somebody's only factor), but it is
 * no longer required when another factor already exists.
 *
 * This does not widen who can sign in. Delivery goes to the address on the
 * account — the same address that could already reset the password — so an
 * attacker who controls the mailbox was never being stopped by this flag. What
 * it changes is that a locked-out owner has a route back in before they have to
 * spend a recovery code.
 *
 * @param {object} row the users row (needs `id`, `tfa_enabled`, `tfa_email_enabled`,
 *   `email_verified`)
 * @returns {string[]} some subset of ['totp', 'email', 'recovery'], possibly empty
 */
export function enabledSecondFactors(row) {
  if (!row) return [];
  const methods = [];
  if (row.tfa_enabled) methods.push('totp');

  /**
   * Email is offered when a code can actually be delivered AND there is a
   * reason to deliver one.
   *
   * Two conditions, stated as two conditions rather than as a cascade:
   *
   *   deliverable — the address has been CONFIRMED. Without this, "email" is a
   *     method whose first action is a 400 from the send route, which is the
   *     defect this whole derivation was written to close.
   *   wanted — either the account switched email 2FA on (it may be its only
   *     factor), or it already holds some other factor and email is the fallback
   *     it reaches for when that factor is gone.
   */
  const deliverable = row.email_verified === 1 || row.email_verified === true;
  const wanted = Boolean(row.tfa_email_enabled) || methods.length > 0;
  if (deliverable && wanted) methods.push('email');

  /* Recovery codes are a fallback for the methods above, not a method in their
     own right: offering them to an account that has enrolled nothing would turn
     a leftover code set into a way past a second factor nobody switched on. */
  if (methods.length) {
    const held = db.prepare(
      'SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ?'
    ).get(row.id)?.n ?? 0;
    if (held > 0) methods.push('recovery');
  }

  return methods;
}

/**
 * Whether this specific session has been signed out.
 *
 * Sessions are stateless JWTs, so "signed out" has to be recorded somewhere for
 * the token to stop working before it expires. `revoked_sessions` holds one row
 * per explicit logout, keyed on the token's `jti`.
 *
 * A token with NO jti predates this mechanism. Those are allowed through: they
 * cannot be identified individually, they expire within seven days, and refusing
 * them would sign out every currently signed-in user the moment this deploys.
 */
export function isSessionRevoked(jti) {
  if (!jti) return false;
  return !!db.prepare('SELECT 1 FROM revoked_sessions WHERE jti = ?').get(jti);
}

/** Records a session as signed out, until the point its token would expire anyway. */
export function revokeSession({ jti, userId, expSeconds }) {
  if (!jti) return false;
  // `exp` is seconds since the epoch. Without it, fall back to the 7-day token
  // lifetime so the row still has a definite point at which it can be purged.
  const expiresAt = expSeconds
    ? new Date(expSeconds * 1000).toISOString()
    : new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  db.prepare(`
    INSERT INTO revoked_sessions (jti, user_id, revoked_at, expires_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(jti) DO NOTHING
  `).run(jti, userId, new Date().toISOString(), expiresAt);
  return true;
}

/**
 * Drops revocations whose token has expired.
 *
 * Once a token is past its own expiry, `jwt.verify` rejects it regardless, so the
 * denylist row has no further work to do. Without this the table would grow by
 * one row per sign-out forever.
 */
export function purgeExpiredRevocations(now = new Date()) {
  return db.prepare('DELETE FROM revoked_sessions WHERE expires_at < ?')
    .run(now.toISOString()).changes;
}

/**
 * Builds the request principal with `grants` attached as a lazy, memoizing
 * getter rather than an eagerly-fetched array.
 *
 * Only one route consults capabilities today (more arrive in Task 7), so
 * running `grantsFor` on every authenticated request — most of which never
 * read `principal.grants` at all — would spend a SQL query on work nobody
 * asked for. The getter defers that query until the first read and caches
 * the result, so a request that never touches capabilities never touches
 * the database for them; a request that reads it more than once (or that
 * `can()` reads internally) pays for exactly one query.
 *
 * `fetchGrants` is injectable purely so a test can spy on call counts
 * without going through `db.js` — production code never passes it and gets
 * the real `grantsFor` bound to the live connection.
 *
 * ── `withheld` is eager, and that is deliberate ──
 *
 * `grants` is lazy because most requests never read it. The withheld list is the
 * opposite: `can()` consults it on EVERY capability check, so deferring it would
 * buy nothing and a lazy getter that `can()` forgets to trigger would fail open —
 * the one direction an authorization mechanism must never fail.
 *
 * It costs one indexed query per authenticated request, and only for organizers:
 * `withheldCapabilitiesFor` returns `[]` without touching the database for every
 * other role. See `server/organizerAgreement.js` for why the list exists.
 *
 * `computeWithheld` is injectable for the same reason `fetchGrants` is: so this
 * function's own contract — the shape of the principal, and the laziness of
 * `grants` — can be tested against a throwaway handle with no schema, rather than
 * requiring a fully migrated database to assert that a field is spelled
 * correctly. Production never passes it.
 */
/**
 * The persona a row is previewing as, or null.
 *
 * Both columns must be present and the expiry must be in the future. A row with
 * one of the pair written and not the other resolves to null — the safe
 * direction, since the only thing this value can do is take capabilities away,
 * and "no preview" is the account's real access.
 *
 * The persona is checked against `ROLES` rather than trusted. It reaches the
 * database through a route that validates it, but this is the function that
 * decides what `can()` is asked about, and a value that is not a role would make
 * `can()` deny everything — locking the account out of the application until the
 * expiry, from one bad write.
 *
 * ISO strings compared as strings, both sides in the same format. `expires_at`
 * is written with `toISOString()` and read against another `toISOString()`; this
 * module never compares one to SQLite's `datetime('now')`, which is the mistake
 * `datetimeComparison.test.js` exists for.
 */
function previewPersonaFor(userRow) {
  const persona = userRow?.preview_persona;
  const expiresAt = userRow?.preview_expires_at;
  if (!persona || !expiresAt) return null;
  if (!ROLES.includes(persona)) return null;
  if (expiresAt <= new Date().toISOString()) return null;
  /* Previewing as your own role is not a preview; resolving it to null keeps
     `effectiveRole !== actualRole` meaning what it says everywhere downstream. */
  if (persona === userRow.role) return null;
  return persona;
}

/**
 * ── The persona preview ──
 *
 * `effectiveRole` is set from the row's preview columns, and that is the ONLY
 * place in this application it is set to anything other than the real role.
 *
 * It cannot escalate, and the reason is not that this function checks anything.
 * `can()` intersects the effective role with `actualRole` — which is read from
 * the database on every request and is never the preview — so a preview column
 * naming a more powerful role grants nothing at all. See the narrowing rule in
 * `authz.js`. That is what makes it safe for this to be a plain column read
 * rather than a gate: there is no value that could be written here, by any means,
 * that would give the account more than it already has.
 *
 * Nothing about the account's own security follows the preview. Whether a second
 * factor is required is decided from `userRow.role` at sign-in
 * (`secondFactorRequiredFor`), before a principal exists — so an owner previewing
 * as a student is still an owner as far as authentication is concerned.
 */
export function buildPrincipal(
  userRow,
  fetchGrants = (id) => grantsFor(db, id),
  computeWithheld = (row) => withheldCapabilitiesFor(db, row)
) {
  const principal = principalFor(userRow, {
    withheld: computeWithheld(userRow),
    effectiveRole: previewPersonaFor(userRow) || userRow?.role,
  });
  let cached = null;
  Object.defineProperty(principal, 'grants', {
    get() {
      if (cached === null) cached = fetchGrants(userRow.id);
      return cached;
    },
    enumerable: true,
    configurable: true
  });
  return principal;
}

/**
 * The lower-cased lookup key for the challenge header.
 *
 * The wire name itself is defined once, in `sensitiveActions.js`, so the client
 * can import the same constant instead of retyping it — see the reasoning in
 * that file's header, and the guard in `sensitiveActions.test.js` that fails
 * the build on a second definition. Node lower-cases incoming header names, so
 * `req.headers` must be indexed with this form and never with the wire form.
 */
const REAUTH_CHALLENGE_HEADER_KEY = REAUTH_CHALLENGE_HEADER.toLowerCase();

/**
 * The action this request has proved a fresh identity for, or null.
 *
 * ── Cost ──
 *
 * This runs on every authenticated request in the application, so the first
 * thing it does is establish that there is nothing to look up. A request with
 * no challenge id issues NO query — same reasoning as `buildPrincipal`'s lazy
 * grants getter, and the same reason: an unconditional per-request query here
 * is a tax on the whole API paid by the handful of requests that need it.
 * `authz.aal.test.js` counts the statements rather than trusting the reading.
 *
 * ── The jti case ──
 *
 * Every challenge is bound to a session jti when it is opened — `openChallenge`
 * refuses to create one otherwise, because a grant bound to no session is
 * spendable by anyone holding the id. Tokens issued before jti existed are
 * still admitted by `authenticateToken`, and they simply cannot match a bound
 * grant. That is resolved here as AAL1, before the query and without an
 * exception; the separate question of what to tell someone on such a token who
 * tries to START a step-up belongs to the challenge-creation route.
 *
 * ── Not consuming ──
 *
 * `peekChallenge`, never `consumeChallenge`. Spending the grant here would
 * burn it on a request the handler may still reject for unrelated reasons.
 *
 * `peek` is injectable purely so a test can count calls without going through
 * db.js; production code never passes it.
 */
export function resolveAssurance(
  { challengeId, userId, sessionJti },
  peek = (args) => peekChallenge({ db, ...args })
) {
  if (!challengeId || typeof challengeId !== 'string') return null;
  if (!userId || !sessionJti) return null;

  const result = peek({ challengeId, userId });
  if (!result || !result.ok) return null;

  // The session binding. `peekChallenge` scopes its read to the user; this is
  // the check that stops a grant obtained in one browser being spent from
  // another, which is the whole scenario step-up exists for.
  if (result.challenge.sessionJti !== sessionJti) return null;

  return result.challenge.action;
}

// --- AUTHENTICATION MIDDLEWARE ---
export function authenticateToken(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];

  if (!token) return res.status(401).json({ error: 'Access token required' });

  jwt.verify(token, JWT_SECRET, (err, decodedUser) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });

    // A preauth token must never be accepted as a full session token.
    if (decodedUser.preauth) {
      return res.status(401).json({ error: 'Pre-authentication tokens cannot be used as full sessions' });
    }

    // Re-derive identity from the database on every request rather than
    // trusting the (up to 7-day-old) token payload, so a deleted user's
    // token stops working and a role/email change takes effect immediately.
    const userRow = db.prepare(
      /* An explicit list, not `SELECT *`, and that is a trap worth naming: a
         column this list omits is simply absent from the row `buildPrincipal`
         resolves the principal from, with no error anywhere. The persona preview
         columns were added to the schema and to `buildPrincipal` and did nothing
         at all on a real request until they were added HERE — while every unit
         test passed, because those build a principal from `SELECT *`. */
      `SELECT id, role, email, name, email_verified, token_version, account_status,
              suspended_until, suspended_at, suspension_reason,
              tfa_enabled, tfa_email_enabled,
              preview_persona, preview_expires_at
         FROM users WHERE id = ?`
    ).get(decodedUser.id);

    if (!userRow) return res.status(401).json({ error: 'Account no longer exists' });
    if (userRow.account_status === 'deleted') return res.status(401).json({ error: 'Account has been deleted' });

    /**
     * Asked as a question about time, not a string comparison.
     *
     * A timed suspension stops applying the instant its deadline passes, and it
     * has to stop applying HERE as well as at sign-in — this is the check that
     * governs an already-issued cookie, so a stale definition of "suspended"
     * here is the one that lets a suspended person keep working. `isSuspended`
     * is the single definition; see server/suspension.js.
     *
     * The row is normalised on the way past so that administrative views, which
     * read `account_status` directly, stop describing this person as suspended.
     * The sweep does the same thing for accounts that never come back.
     */
    const suspended = isSuspended(userRow);
    liftIfExpired(db, userRow);

    if ((decodedUser.tokenVersion ?? 0) !== userRow.token_version) {
      return res.status(401).json({ error: 'Session expired, please sign in again' });
    }

    // This one session signed out. Checked after token_version so the account-wide
    // case still reports itself as such, and before req.user is populated so a
    // revoked token never reaches a handler.
    if (isSessionRevoked(decodedUser.jti)) {
      return res.status(401).json({ error: 'You have been signed out. Please sign in again.' });
    }

    /**
     * The suspension gate.
     *
     * ── What changed, and what did not ──
     *
     * This used to be a flat `return 403` sitting above the two checks before
     * it, and it refused everything. A suspended account therefore had no
     * authenticated surface at all, which meant the only account of what had
     * happened to the person was the email sent at the moment of suspension.
     *
     * A suspended session now exists and reaches four routes: read the decision,
     * appeal it, check the appeal, sign out. `suspendedAccess.js` holds that list
     * and matches it exactly, by method and full path, with no prefixes.
     *
     * What did not change is the part that matters: everything else is still
     * refused here, before any route handler and before any capability gate. A
     * suspended administrator is a suspended account first.
     *
     * ── Ordering ──
     *
     * Deliberately BELOW `token_version` and the revocation denylist, where it
     * used to sit above both. A session that is expired or has been signed out
     * is not a suspended session, it is not a session at all, and answering it
     * with a suspension notice would disclose the account's moderation state to
     * a cookie that is no longer valid.
     *
     * The notice is attached rather than looked up again by the handlers, so
     * `/api/auth/me` cannot disagree with the gate that let it through.
     */
    if (suspended) {
      req.suspension = suspensionNotice(userRow);

      if (!suspendedMayReach(req.method, req.originalUrl.split('?')[0])) {
        return res.status(403).json({
          error: 'Your account is suspended.',
          /* Distinct from the generic `Access denied` a capability refusal
             returns, because the client has to tell them apart: one shows the
             suspension screen, the other shows the permission refusal. */
          code: 'account_suspended',
          suspension: req.suspension,
        });
      }
    }

    req.user = {
      id: userRow.id,
      role: userRow.role,
      email: userRow.email,
      name: userRow.name,
      email_verified: userRow.email_verified
    };

    // The capability principal. req.user is left exactly as it was, so every
    // existing handler and test keeps working while call sites migrate.
    req.principal = buildPrincipal(userRow);
    req.principal.tfaRequired = secondFactorRequiredFor(userRow.role, userRow)
      && !userRow.tfa_enabled && !userRow.tfa_email_enabled;

    /**
     * This session's identifier, for the routes that BIND something to it.
     *
     * `openChallenge` refuses to create a grant without one, and
     * `consumeChallenge` re-checks it, so the step-up routes need the value —
     * and re-verifying the cookie in each of them to recover a claim this
     * middleware has already verified is both wasted work and a second place
     * for the verification to be got wrong.
     *
     * Explicitly `null`, never absent, for tokens minted before per-session
     * revocation existed. Those are admitted here — see `isSessionRevoked` — so
     * the routes that cannot work without a jti have to recognise the case and
     * say so, rather than throwing. Every code path that mints a session now
     * goes through `authRoutes.js`'s `issueSession`, which always sets one;
     * oauthRoutes.js had its own jti-less copy until v1.2b Task 6.
     */
    req.sessionJti = decodedUser.jti ?? null;

    /**
     * The challenge id this request presented, for the handlers that SPEND it.
     *
     * `requireAAL2` is an early refusal, not the check: the handler performing a
     * sensitive action has to call `consumeChallenge` inside its own
     * transaction, against the action and the params it is actually about to
     * perform — and to do that it needs the id.
     *
     * Read here, once, from the same `REAUTH_CHALLENGE_HEADER_KEY` lookup that
     * resolves assurance below, and never re-read in a route file. Two spellings
     * of the header name is one typo away from a handler that gates on a grant
     * and then consumes nothing: the request succeeds, the grant stays
     * spendable, and single use — the property that makes a replayed grant not a
     * second free sensitive action — is silently gone with every test still
     * green. Same reasoning as `sensitiveActions.js`'s header on why the wire
     * name has exactly one definition.
     *
     * `null` rather than absent for a request that presented nothing, matching
     * `req.sessionJti` above, so a handler can compare without first asking
     * whether this middleware ran. A duplicated header arrives comma-joined (a
     * string that matches no challenge id) and an array-valued one is discarded
     * by the typeof — both resolve to AAL1, which is the safe direction.
     */
    const presentedChallengeId = req.headers[REAUTH_CHALLENGE_HEADER_KEY];
    req.reauthChallengeId = typeof presentedChallengeId === 'string' ? presentedChallengeId : null;

    // Assurance. Additive to the principal and nothing else — a request that
    // presents no challenge id leaves it at the AAL1 principalFor() already
    // built, having touched the database not at all.
    const aalAction = resolveAssurance({
      challengeId: req.reauthChallengeId,
      userId: userRow.id,
      sessionJti: decodedUser.jti
    });
    if (aalAction !== null) {
      req.principal.aal = 2;
      req.principal.aalAction = aalAction;
    }

    if (
      REQUIRE_EMAIL_VERIFICATION &&
      userRow.email_verified !== 1 &&
      !isEmailGateAllowed(req.path)
    ) {
      return res.status(403).json({
        error: 'Please verify your email address to continue.',
        code: 'email_unverified'
      });
    }

    next();
  });
}

// Helper to format database user row (calculating hours dynamically from Attendance)
export function formatUserResponse(row) {
  if (!row) return null;

  // Calculate hours dynamically from confirmed attendance records where student was present
  const hoursRow = db.prepare(`
    SELECT SUM(hours_awarded) as total
    FROM attendance
    WHERE user_id = ? AND present = 1
  `).get(row.id);

  const totalHours = hoursRow && hoursRow.total ? Number(hoursRow.total) : 0.0;

  return {
    id: row.id,
    name: row.name,
    username: row.username || null,
    email: row.email,
    grade: row.grade,
    role: row.role,
    verified: row.verified === 1,
    emailVerified: row.email_verified === 1,
    leaderboardOptIn: row.leaderboard_opt_in === 1,
    emailOptOut: row.email_opt_out === 1,
    hasPassword: row.password_hash !== '!OAUTH_ONLY!',
    tfaEnabled: Boolean(row.tfa_enabled),
    tfaEmailEnabled: Boolean(row.tfa_email_enabled),
    tfaMethods: [
      ...(row.tfa_enabled ? ['totp'] : []),
      ...(row.tfa_email_enabled ? ['email'] : []),
    ],
    tfaRequired: secondFactorRequiredFor(row.role, row) && !row.tfa_enabled && !row.tfa_email_enabled,
    avatar: row.avatar,
    profile_picture_url: row.profile_picture_url,
    volunteeredHours: totalHours,
    /**
     * The threshold `volunteeredHours` is measured against, sent beside it.
     *
     * A platform-wide constant on a per-user payload, deliberately: it is the
     * denominator of the figure on the line above, and both client views that
     * draw that progress meter — VolunteerDashboard and VolunteerProfile — held
     * their own `const HOUR_GOAL = 25` instead. Two copies of the district's
     * Silver Award threshold in a different language from the server that decides
     * whether the milestone is earned, so nothing could check them against it and
     * the meter could read "8 hours to go" beside a milestone already shown as
     * achieved.
     *
     * Delivered here rather than on a fetch so it is present on the first frame:
     * the alternative was a meter that could not render its own maximum until a
     * second request landed. Derived from the Silver tier in milestones.js.
     */
    serviceHourGoal: SERVICE_HOUR_GOAL,
    bio: row.bio,
    school: row.school,
    skills: row.skills ? JSON.parse(row.skills) : [],
    hobbies: row.hobbies ? JSON.parse(row.hobbies) : [],
    location: row.location || null,
    /**
     * The distinguished-profile fields, and the presentation derived from role.
     *
     * On the SELF payload so the profile editor can render what is currently
     * written without a second request, and so `/profile` can draw the
     * distinguished header on its first frame for an account — a partner — that
     * does not hold `directory.read` and therefore cannot fetch a profile
     * payload at all, not even its own.
     *
     * `distinction` is a pure function of `role`, which is three lines above.
     * It grants nothing; see the note on `distinctionFor`.
     */
    headline: row.profile_headline || null,
    highlights: parseHighlightsList(row.profile_highlights),
    distinction: distinctionFor(row.role),
    /**
     * The two privacy switches, so Settings can render their current state
     * without a second request.
     *
     * This serializer is self-only WITH ONE EXCEPTION, and the exception is
     * worth naming rather than leaving as a claim that is nearly true:
     * `adminRoutes.js` maps it over other users' rows for the pending-organizer
     * list. That route is gated on `organizer.approve` and already discloses
     * email, bio, school and grade there — an approver is deciding whether to
     * let an adult work with students and needs the particulars — so the extra
     * fields are acceptable there and nowhere else.
     *
     * Every OTHER user-to-user disclosure goes through profileSerializer.js.
     * See the note at the top of that file for why.
     */
    profileVisibility: row.profile_visibility || 'private',
    friendActivityVisible: row.friend_activity_visible !== 0,
    createdAt: row.created_at
  };
}

// Helper to push a notification to a user
/**
 * Runs `fn` inside a transaction, rolling back if it throws.
 *
 * `node:sqlite`'s DatabaseSync has no `.transaction()` helper — that belongs to
 * better-sqlite3 — so multi-statement writes have to drive BEGIN/COMMIT
 * directly or they fail at runtime and leave partial data behind.
 */
export function inTransaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

/**
 * Notification kinds. Kept as a closed set so the client can map each to an
 * icon and a filter without guessing.
 */
export const NOTIFICATION_KINDS = [
  'accepted',      // selected for a shift
  'waitlisted',    // placed on the waitlist
  'promoted',      // moved off the waitlist into a spot
  'declined',      // not selected this time
  'deadline',      // applications close soon on something you starred
  'reminder',      // your shift is coming up
  'announcement',  // organizer posted an update
  'location',      // the meeting place changed
  'hours',         // attendance confirmed / hours credited
  'cancelled',     // the event was called off
  'application',   // organizer-facing: someone applied
  'approval',      // organizer account approved
  'comment',       // someone asked a question on your event
  'info'
];

/**
 * Writes a notification.
 *
 * `dedupeKey` makes the write idempotent per user: the repeating sweep can run
 * every few minutes and re-attempt the same reminder without ever producing a
 * duplicate, because a unique index rejects the second insert.
 */
export function createNotification({ userId, kind, title, body, link = null, dedupeKey = null }) {
  try {
    if (!NOTIFICATION_KINDS.includes(kind)) {
      console.warn(`Unknown notification kind "${kind}" — falling back to info.`);
      kind = 'info';
    }
    const id = `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    db.prepare(`
      INSERT INTO notifications (id, user_id, kind, title, body, link, read, created_at, dedupe_key)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(id, userId, kind, title, body || '', link, new Date().toISOString(), dedupeKey);
    
    // Stage 5: Email Notification Dispatch
    const IMPORTANT_EMAIL_KINDS = ['accepted', 'declined', 'promoted', 'hours', 'cancelled'];
    if (IMPORTANT_EMAIL_KINDS.includes(kind)) {
      const user = db.prepare('SELECT email, email_opt_out FROM users WHERE id = ?').get(userId);
      if (user && user.email_opt_out !== 1) {
        // Fire and forget, we don't want to block the request on SMTP
        sendNotificationEmail(user.email, title, body || '').catch(err => {
          console.error(`Failed to send notification email to ${user.email}:`, err);
        });
      }
    }
    
    return id;
  } catch (e) {
    // A UNIQUE violation means we already sent this one — that's success.
    if (String(e.message).includes('UNIQUE')) return null;
    console.error('Failed to create notification:', e);
    return null;
  }
}

/**
 * How long a notification is kept, by priority, in days.
 *
 * The previous rule deleted NORMAL and LOW after 30 days and kept IMPORTANT and
 * CRITICAL forever. That was wrong in both directions. Forever is not a
 * retention policy — the two priorities that are dispatched most (acceptance,
 * reminders, promotions are all IMPORTANT) grew without bound, so the table with
 * the highest write rate was the only one that never shrank. Meanwhile 30 days
 * was aggressive for NORMAL: a volunteer looking back over a season lost the
 * ordinary history that gives the important entries context.
 *
 * Every priority now has a finite, stated window, longest for the entries a
 * volunteer would be upset to lose. These are notifications, not records: hours,
 * attendance, certificates and the hours ledger are the durable history and are
 * never touched by this sweep, so a deleted notification loses a message about
 * an event, never the event itself.
 */
export const NOTIFICATION_RETENTION_DAYS = {
  LOW: 30,        // deadline nudges — worthless once the deadline has passed
  NORMAL: 90,     // a season's worth of ordinary traffic
  IMPORTANT: 365, // acceptances, promotions, reminders, credited hours
  CRITICAL: 365   // cancellations and conflicts — a full year, then bounded
};

/**
 * Deletes notifications past their retention window.
 *
 * One statement per priority rather than a single query, so a priority missing
 * from the table above is left alone rather than silently swept on a default —
 * an unknown priority is a bug to notice, not data to delete.
 */
export function purgeExpiredNotifications(now = new Date()) {
  let removed = 0;
  const stmt = db.prepare('DELETE FROM notifications WHERE priority = ? AND created_at < ?');
  for (const [priority, days] of Object.entries(NOTIFICATION_RETENTION_DAYS)) {
    const cutoff = new Date(now.getTime() - days * 24 * 3600 * 1000).toISOString();
    removed += stmt.run(priority, cutoff).changes;
  }
  return removed;
}

/**
 * Time-based notifications, generated by a sweep rather than by a user action.
 *
 * Two kinds, both deliberately conservative so the bell stays worth checking:
 *   • deadline — applications close within 48h on an event you starred but
 *     have not applied to. Only useful to someone who showed intent.
 *   • reminder — a shift you are confirmed for starts within 24h.
 */
export function runNotificationSweep() {
  const now = new Date();
  const in48h = new Date(now.getTime() + 48 * 3600 * 1000).toISOString();
  const in24h = new Date(now.getTime() + 24 * 3600 * 1000).toISOString();
  const in2h = new Date(now.getTime() + 2 * 3600 * 1000).toISOString();
  let created = 0;

  try {
    // Deadline approaching on a starred event the student hasn't applied to
    const closingSoon = db.prepare(`
      SELECT f.user_id, e.id as event_id, e.title, e.application_deadline
      FROM user_favorites f
      JOIN events e ON f.event_id = e.id
      WHERE e.status = 'open'
        AND e.application_deadline > ?
        AND e.application_deadline <= ?
        AND NOT EXISTS (
          SELECT 1 FROM applications a
          WHERE a.event_id = e.id AND a.user_id = f.user_id AND a.status NOT IN ('rejected', 'withdrawn')
        )
    `).all(now.toISOString(), in48h);

    for (const row of closingSoon) {
      if (notificationService.dispatch('EVENT_DEADLINE_APPROACHING', {
        eventId: row.event_id,
        eventTitle: row.title,
        countdownPhrase: countdownPhrase(row.application_deadline)
      }, row.user_id, `deadline:${row.event_id}`)) {
        created++;
      }
    }

    // Shift starting within 24h for confirmed volunteers
    const upcoming = db.prepare(`
      SELECT a.user_id, e.id as event_id, e.title, e.location, s.id as slot_id,
             s.name as slot_name, s.start_datetime
      FROM applications a
      JOIN slots s ON a.slot_id = s.id
      JOIN events e ON a.event_id = e.id
      WHERE a.status = 'accepted'
        AND e.status != 'cancelled'
        AND s.start_datetime > ?
        AND s.start_datetime <= ?
    `).all(now.toISOString(), in24h);

    for (const row of upcoming) {
      if (notificationService.dispatch('EVENT_REMINDER_24H', {
        eventId: row.event_id,
        eventTitle: row.title,
        slotName: row.slot_name,
        location: row.location
      }, row.user_id, `reminder-24h:${row.slot_id}`)) {
        created++;
      }
    }

    // Shift starting within 2h for confirmed volunteers
    const upcoming2h = db.prepare(`
      SELECT a.user_id, e.id as event_id, e.title, e.location, s.id as slot_id,
             s.name as slot_name, s.start_datetime
      FROM applications a
      JOIN slots s ON a.slot_id = s.id
      JOIN events e ON a.event_id = e.id
      WHERE a.status = 'accepted'
        AND e.status != 'cancelled'
        AND s.start_datetime > ?
        AND s.start_datetime <= ?
    `).all(now.toISOString(), in2h);

    for (const row of upcoming2h) {
      if (notificationService.dispatch('EVENT_REMINDER_2H', {
        eventId: row.event_id,
        eventTitle: row.title,
        slotName: row.slot_name,
        location: row.location
      }, row.user_id, `reminder-2h:${row.slot_id}`)) {
        created++;
      }
    }

    const stalled = db.prepare(`
      SELECT e.id AS event_id, e.title, e.organizer_id, e.auto_approve,
             COUNT(a.id) AS pending_count
      FROM events e
      JOIN applications a ON a.event_id = e.id AND a.status = 'pending'
      WHERE e.status NOT IN ('completed', 'cancelled')
        AND e.application_deadline <= ?
      GROUP BY e.id
    `).all(now.toISOString());

    for (const row of stalled) {
      const n = row.pending_count;
      const applicants = `${n} applicant${n === 1 ? '' : 's'}`;
      const nextStep = row.auto_approve === 1
        ? 'Run Auto Select to choose volunteers.'
        : 'Review them and choose who is accepted.';

      if (notificationService.dispatch('DECISION_NEEDED', {
        eventId: row.event_id,
        eventTitle: row.title,
        applicantsText: applicants + (n === 1 ? ' is' : ' are'),
        nextStep
      }, row.organizer_id, `awaiting-decision:${row.event_id}`)) {
        created++;
      }
    }
    
    const removed = purgeExpiredNotifications(now);
    const revocations = purgeExpiredRevocations(now);
    if (revocations > 0) console.log(`[Sessions] Purged ${revocations} expired revocation(s).`);

    // Step-up challenges: one row per sensitive action a user starts, including
    // every abandoned one, each carrying an ip_hash. Worthless once expired.
    const challenges = sweepExpiredChallenges(db, now);
    if (challenges > 0) console.log(`[Reauth] Purged ${challenges} spent step-up challenge(s).`);

    /**
     * Error records: aged evidence, closed groups, and the single-occurrence
     * client groups an unauthenticated flood leaves behind.
     *
     * Here rather than on a timer of its own, deliberately — a second interval
     * would be a second thing `shutdown.js` has to drain. `sweepErrors` catches
     * internally and returns counts instead of throwing, so a failure in it
     * cannot abandon the sweep tasks above it inside this one shared try block.
     */
    const errors = sweepErrors(db, now);
    if (errors.groups > 0 || errors.events > 0) {
      console.log(`[Errors] Purged ${errors.groups} error group(s) and ${errors.events} event(s).`);
    }

    /**
     * Tell somebody a server or worker error appeared.
     *
     * Here for the same reasons `sweepErrors` is: no new interval, nothing more
     * for `shutdown.js` to drain, and it catches internally so it cannot
     * abandon this shared try block.
     *
     * Deliberately NOT awaited. This sweep is synchronous and its callers do
     * not await it, so awaiting an SMTP round trip would either block the tick
     * behind a slow mail server or, worse, make the sweep's timing depend on
     * one. `sendErrorAlerts` marks the groups synchronously before it sends, so
     * the next tick cannot double-send even if this one is still in flight. The
     * `.catch` is belt and braces — the function does not reject — but an
     * unhandled rejection here would be reported by our own error capture,
     * which is the loop worth refusing outright.
     */
    sendErrorAlerts(db, { send: sendMail, now, appUrl: process.env.APP_URL })
      .then(({ sent, reason }) => {
        if (sent > 0) console.log(`[Alerts] Sent an alert covering ${sent} new problem(s).`);
        else if (reason === 'failed') console.warn('[Alerts] Alert send failed — see the error above.');
      })
      .catch(() => { /* sendErrorAlerts does not reject; this is belt and braces */ });

    if (removed > 0) {
      console.log(`[Notifications] Cleaned up ${removed} expired notifications.`);
    }

  } catch (err) {
    console.error('Notification sweep failed:', err);
  }

  if (created > 0) console.log(`[Notifications] Sent ${created} time-based notification(s).`);
  return created;
}

/** "in 3 days" / "tomorrow" / "today", for notification copy. */
export function countdownPhrase(iso) {
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const days = Math.round((startOfDay(new Date(iso)) - startOfDay(new Date())) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

/** Notify every confirmed volunteer on an event. Returns how many were told. */
export function notifyConfirmedVolunteers(eventId, event, payload, dedupeKey = null) {
  const recipients = db.prepare(`
    SELECT DISTINCT user_id FROM applications
    WHERE event_id = ? AND status = 'accepted'
  `).all(eventId);
  let sent = 0;
  
  for (const r of recipients) {
    if (notificationService.dispatch(event, payload, r.user_id, dedupeKey ? `${dedupeKey}:${r.user_id}` : null)) {
      sent++;
    }
  }
  return sent;
}

/**
 * Puts an application at the BACK of its slot's waitlist queue.
 *
 * `waitlist_order` used to be written only by Auto Select. Every manual path set
 * it to NULL, which made the queue orderless: `ORDER BY waitlist_order ASC`
 * over all-NULL rows returns them in whatever order the b-tree happens to
 * yield, so "first in line" was arbitrary and no honest "you are 3rd" could be
 * shown. Assigning it on every transition into `waitlisted` is what makes the
 * queue a queue.
 *
 * Called inside the caller's transaction, so the read and the write cannot
 * interleave with another applicant joining the same slot.
 */
export function assignWaitlistOrder(applicationId, slotId) {
  const row = db.prepare(`
    SELECT COALESCE(MAX(waitlist_order), 0) AS last
    FROM applications
    WHERE slot_id = ? AND status = 'waitlisted' AND id != ?
  `).get(slotId, applicationId);
  db.prepare('UPDATE applications SET waitlist_order = ? WHERE id = ?')
    .run(row.last + 1, applicationId);
  return row.last + 1;
}

/**
 * Fills any genuinely free spots in a slot from its waitlist, in queue order.
 *
 * ── Why this no longer consults Auto Select ──
 *
 * All three callers used to gate this behind `event.auto_approve === 1`. That
 * flag chooses how volunteers are SELECTED (a weighted draw after the deadline
 * versus the organizer's judgement); it says nothing about whether a spot that
 * has just been vacated should be refilled. Tying promotion to it meant that on
 * an ordinary organizer-managed event — the default — a confirmed volunteer
 * releasing their place left the shift under capacity with someone waiting on
 * it, and told neither of them. The waitlist was decorative for most events.
 *
 * Promotion is now a function of the three things that actually determine it:
 * how much capacity is free, who is next in the queue, and whether the event is
 * still happening. The selection method is irrelevant to all three.
 *
 * Capacity is re-counted here rather than inferred from "somebody just left",
 * so this is safe to call speculatively: if nothing is free it promotes nobody.
 * It also promotes as many people as there are free spots, which matters for a
 * bulk demotion that frees several at once.
 *
 * Returns the promoted rows so the caller can notify AFTER its transaction
 * commits — dispatching inside one would leave notification writes to roll back
 * with it, and a socket emit cannot be un-sent.
 */
export function promoteFromWaitlist(slotId) {
  const slot = db.prepare(`
    SELECT s.id, s.name, s.max_spots, s.event_id,
           e.title AS event_title, e.organizer_id, e.status AS event_status
    FROM slots s JOIN events e ON e.id = s.event_id
    WHERE s.id = ?
  `).get(slotId);
  if (!slot) return [];

  // Pulling someone into a called-off event would be worse than leaving them
  // waiting — they would arrange a ride around a shift that is not happening.
  if (slot.event_status === 'cancelled' || slot.event_status === 'completed') return [];

  const accepted = db.prepare(
    "SELECT COUNT(*) AS c FROM applications WHERE slot_id = ? AND status = 'accepted'"
  ).get(slotId).c;

  const free = slot.max_spots - accepted;
  if (free <= 0) return [];

  // NULLS LAST so a legacy row written before waitlist_order was assigned sorts
  // behind properly-queued ones instead of jumping the queue; applied_at then id
  // as a stable tiebreak so two rows can never swap places between calls.
  const queue = db.prepare(`
    SELECT a.id, a.user_id, u.name AS volunteer_name
    FROM applications a JOIN users u ON u.id = a.user_id
    WHERE a.slot_id = ? AND a.status = 'waitlisted'
    ORDER BY a.waitlist_order IS NULL, a.waitlist_order ASC, a.applied_at ASC, a.id ASC
    LIMIT ?
  `).all(slotId, free);
  if (queue.length === 0) return [];

  const promote = db.prepare(
    "UPDATE applications SET status = 'accepted', waitlist_order = NULL WHERE id = ?"
  );
  const renumber = db.prepare('UPDATE applications SET waitlist_order = ? WHERE id = ?');

  for (const row of queue) promote.run(row.id);

  // Close the gap the promotion left, so positions stay 1..n and the person who
  // was 3rd is told they are now 2nd rather than staying stuck at 3.
  const remaining = db.prepare(`
    SELECT id FROM applications
    WHERE slot_id = ? AND status = 'waitlisted'
    ORDER BY waitlist_order IS NULL, waitlist_order ASC, applied_at ASC, id ASC
  `).all(slotId);
  remaining.forEach((r, i) => renumber.run(i + 1, r.id));

  return queue.map(row => ({
    applicationId: row.id,
    userId: row.user_id,
    volunteerName: row.volunteer_name,
    slotId,
    slotName: slot.name,
    eventId: slot.event_id,
    eventTitle: slot.event_title,
    organizerId: slot.organizer_id
  }));
}

/**
 * Notifies both sides about promotions returned by `promoteFromWaitlist`.
 * Deliberately separate, so it is only ever called after a commit.
 */
export function notifyPromotions(promotions) {
  for (const p of promotions) {
    notificationService.dispatch('WAITLIST_PROMOTED', {
      eventId: p.eventId,
      eventTitle: p.eventTitle,
      slotName: p.slotName
    }, p.userId);

    notificationService.dispatch('WAITLIST_PROMOTION_MADE', {
      eventId: p.eventId,
      eventTitle: p.eventTitle,
      slotName: p.slotName,
      volunteerName: p.volunteerName
    }, p.organizerId);
  }
  return promotions.length;
}

/**
 * Backwards-compatible wrapper: promote, then notify.
 *
 * Safe only outside a transaction, because it notifies. Callers that already
 * hold one should use `promoteFromWaitlist` inside it and `notifyPromotions`
 * after the commit.
 */
export function handleWaitlistPromotion(slotId) {
  try {
    return notifyPromotions(promoteFromWaitlist(slotId));
  } catch (err) {
    console.error('Waitlist promotion error:', err);
    return 0;
  }
}

/* `MILESTONE_TIERS` and `buildMilestones` were here too, exported, and were a
   byte-for-byte duplicate of the copies in routes/userRoutes.js. Nothing
   imported these: the only call site uses its own local copy, so this pair was
   dead the day it was written.

   Deleted rather than left as a spare, because of what the duplication was OF.
   These are the hour thresholds a student's service record is judged against —
   including the 25-hour Silver Award — and two copies of a threshold diverge
   silently. Whoever next raised the Silver target had a 50% chance of editing
   the copy nobody calls, shipping a change that appeared to work because the
   tests and the page both read the other one. */

