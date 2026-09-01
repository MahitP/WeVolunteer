import jwt from 'jsonwebtoken';
import { db } from './db.js';
import { currentConnection, transactionOn } from './db/connectionContext.js';
import { notificationService } from './services/notificationService.js';
import { sendNotificationEmail, sendMail } from './email.js';
import { JWT_SECRET, REQUIRE_EMAIL_VERIFICATION, isEmailGateAllowed, COOKIE_NAME, REQUIRE_ADMIN_2FA, DEMO_MODE } from './config.js';
import { principalFor, requiresSecondFactor, ROLE, ROLES } from './authz.js';
import { SERVICE_HOUR_GOAL } from './milestones.js';
import { creditedHoursFor } from './volunteerStats.js';
import { grantsFor } from './userCapabilities.js';
import { eventApplicationEligibility } from './eventEligibility.js';
import { usersWithClashingAcceptance } from './shiftOverlap.js';
import { withheldCapabilitiesFor } from './organizerAgreement.js';
import { sweepExpiredChallenges, peekChallenge } from './reauth.js';
import { sweepCheckinTokens } from './checkinTokens.js';
import { sweepErrors } from './errorReporter.js';
import { sendErrorAlerts, sendBackupAlert } from './alerting.js';
import { forUpdate, isUniqueViolation } from './db/dialectSql.js';
/* Read here rather than inside alerting.js — that module imports nothing on
   purpose, so everything it needs arrives as an argument. */
import { backupStatus } from './backupStatus.js';
import { REAUTH_CHALLENGE_HEADER } from './sensitiveActions.js';
import { isSuspended, liftIfExpired, suspensionNotice } from './suspension.js';
import { suspendedMayReach } from './suspendedAccess.js';
/* The distinguished-profile presentation, from the one module that decides it.
   Restated here would be a second answer to "what kind of account is this",
   which is how the self payload and a member's view of the same account come to
   disagree. profileSerializer imports only volunteerStats, so this is not a
   cycle. */
import { distinctionFor, parseHighlights as parseHighlightsList } from './profileSerializer.js';
import { normaliseVisibility } from './serviceVisibility.js';

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
export async function enabledSecondFactors(row) {
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
    const held = (await db.prepare(
      'SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ?'
    ).get(row.id))?.n ?? 0;
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
export async function isSessionRevoked(jti) {
  if (!jti) return false;
  return !!await db.prepare('SELECT 1 FROM revoked_sessions WHERE jti = ?').get(jti);
}

/** Records a session as signed out, until the point its token would expire anyway. */
export async function revokeSession({ jti, userId, expSeconds }) {
  if (!jti) return false;
  // `exp` is seconds since the epoch. Without it, fall back to the 7-day token
  // lifetime so the row still has a definite point at which it can be purged.
  const expiresAt = expSeconds
    ? new Date(expSeconds * 1000).toISOString()
    : new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  await db.prepare(`
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
export async function purgeExpiredRevocations(now = new Date()) {
  return (await db.prepare('DELETE FROM revoked_sessions WHERE expires_at < ?')
    .run(now.toISOString())).changes;
}

/**
 * Expired second-factor codes and stale login-attempt counters.
 *
 * Neither table was swept by anything, and both hold material that is worthless
 * the moment it ages out: `tfa_email_codes` a bcrypt hash of every code ever
 * mailed, `tfa_login_attempts` one row per pre-auth grant anybody ever failed a
 * code against. `reauth_challenges` is swept for exactly this reason and these
 * two were simply missed.
 *
 * ── The two columns are in DIFFERENT formats, and that decides the comparison ──
 *
 * `tfa_email_codes.expires_at` is written by the send route as
 * `new Date(...).toISOString()` — `2026-08-10T12:00:00.000Z`. So it is compared
 * against an ISO string.
 *
 * `tfa_login_attempts.last_attempt_at` is written as `datetime('now')` —
 * `2026-08-10 12:00:00`. So it is compared against `datetime(...)`, IN SQL.
 * Comparing the two formats to each other is a string comparison in which `T`
 * sorts after a space and the `Z` suffix has no counterpart, which is the class
 * of bug `datetimeComparison.test.js` exists for. Mixing them here would delete
 * either everything or nothing, and both failures are silent.
 *
 * An hour, not fifteen minutes: the ceiling that reads `tfa_login_attempts`
 * only ever looks back fifteen, so anything older is already invisible to it,
 * and the extra margin means a sweep can never race a live window.
 */
export async function sweepTwoFactorRemnants(dbHandle = db, now = new Date()) {
  let removed = 0;
  try {
    removed += (await dbHandle.prepare('DELETE FROM tfa_email_codes WHERE expires_at < ?')
      .run(now.toISOString())).changes;
    /* An hour before `now`, computed here. The column is ISO-8601 as of
       migration 056, and the comparison has to be in the same format. */
    const staleBefore = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    removed += (await dbHandle.prepare(
      'DELETE FROM tfa_login_attempts WHERE last_attempt_at < ?'
    ).run(staleBefore)).changes;
  } catch {
    /* Caught rather than thrown, like `sweepErrors`: this runs inside one
       shared try block with the other sweep tasks, and a table missing on an
       old database must not abandon the ones above it. */
    return removed;
  }
  return removed;
}

/**
 * Builds the request principal, resolving `grants` before it returns.
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
 * It costs one or two indexed queries per authenticated request. It used to be
 * organizers only, and is not since the Student Organizer Agreement: that gate
 * withholds against a RANK rather than a role, so "do you help run a club" is
 * asked of every account (`organization_members`, covered by
 * `idx_org_members_user`). Organizers and administrators are answered from their
 * role and never reach it; everybody else pays the one lookup, and only somebody
 * who does hold a rank pays the second (`legal_acceptances`, covered by
 * `idx_acceptances_user`). See `server/organizerAgreement.js` and
 * `server/studentOrganizerAgreement.js` for why the lists exist.
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
export async function buildPrincipal(
  userRow,
  fetchGrants = (id) => grantsFor(db, id),
  computeWithheld = (row) => withheldCapabilitiesFor(db, row)
) {
  const principal = principalFor(userRow, {
    withheld: await computeWithheld(userRow),
    effectiveRole: previewPersonaFor(userRow) || userRow?.role,
  });
  /**
   * Resolved eagerly, where it used to be a lazy memoising getter.
   *
   * ── Why the laziness had to go ──
   *
   * `grantsFor` reads `user_capabilities`, so it is async now. A property
   * getter cannot await, so the getter could only ever hand back a **promise**
   * — and `can()` reads it as
   *
   *     Array.isArray(principal.grants) && principal.grants.includes(cap)
   *
   * which is `false` for a promise. Every user-capability grant would have
   * stopped applying, silently: a Student Organizer would simply lose the four
   * capabilities their agreement confers, with no error anywhere. The same
   * shape as the `withheld` defect, and fixed the same way — see `can()`.
   *
   * The alternative was making `can()` async, which is not available: it is a
   * pure synchronous predicate called from hundreds of branches, and
   * `authz.js` deliberately imports nothing.
   *
   * ── What it costs ──
   *
   * One indexed lookup per authenticated request, on a table that is empty for
   * almost every account. Previously it was skipped whenever nothing read
   * `grants` — which is the common case, because a role's own capabilities
   * usually answer first. That is a real regression in query count and a
   * deliberate trade for an authorization kernel that cannot silently
   * under-grant.
   */
  principal.grants = await fetchGrants(userRow.id);
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
export async function resolveAssurance(
  { challengeId, userId, sessionJti },
  peek = (args) => peekChallenge({ db, ...args })
) {
  if (!challengeId || typeof challengeId !== 'string') return null;
  if (!userId || !sessionJti) return null;

  const result = await peek({ challengeId, userId });
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

  /**
   * The callback is `async` because the principal is now built from the
   * database — `withheldCapabilitiesFor` reads the agreement acceptances.
   *
   * Express 4 does not await middleware and does not catch a rejected one, so a
   * throw in here would become an unhandled rejection and take the process
   * down. The whole body is wrapped below and any failure is answered as a 500
   * by this middleware itself, which is also the only safe answer: a request
   * whose principal could not be built must not reach a handler with
   * `req.principal` undefined, because every capability gate would then read
   * `undefined` and refuse — or worse, be skipped by a guard that tolerates it.
   */
  jwt.verify(token, JWT_SECRET, async (err, decodedUser) => {
    try {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });

    // A preauth token must never be accepted as a full session token.
    if (decodedUser.preauth) {
      return res.status(401).json({ error: 'Pre-authentication tokens cannot be used as full sessions' });
    }

    // Re-derive identity from the database on every request rather than
    // trusting the (up to 7-day-old) token payload, so a deleted user's
    // token stops working and a role/email change takes effect immediately.
    const userRow = await db.prepare(
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
    await liftIfExpired(db, userRow);

    if ((decodedUser.tokenVersion ?? 0) !== userRow.token_version) {
      return res.status(401).json({ error: 'Session expired, please sign in again' });
    }

    // This one session signed out. Checked after token_version so the account-wide
    // case still reports itself as such, and before req.user is populated so a
    // revoked token never reaches a handler.
    if (await isSessionRevoked(decodedUser.jti)) {
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
    req.principal = await buildPrincipal(userRow);
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
    const aalAction = await resolveAssurance({
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
    } catch (error) {
      /* Never rethrow: see the note on the callback above. */
      console.error('authenticateToken failed to build the principal:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Could not verify your session. Please try again.' });
      }
    }
  });
}

// Helper to format database user row (calculating hours dynamically from Attendance)
/**
 * The signed-in user's OWN payload — everything `formatUserResponse` returns,
 * plus the two fields the client's `can()` needs to agree with the server.
 *
 * ── Why this exists as a separate function ──
 *
 * `grants` and `withheld` must NOT go through `formatUserResponse`, which also
 * describes OTHER people on the admin user list and on a profile view: there
 * they would disclose what somebody else has been granted, or whether they have
 * signed an agreement, to anybody who can see them.
 *
 * But `/api/auth/me` is not the only endpoint whose response the browser stores
 * as `currentUser` — changing a username, confirming an email and saving a
 * profile all hand their result straight to `setCurrentUser`, replacing it
 * wholesale. Those returned the bare formatter, so editing a bio silently
 * emptied `grants` and a Student Organizer lost every helper capability
 * client-side until a full reload: the nav, the route guard and the create
 * button all vanished.
 *
 * Note the asymmetry, because it is why nothing caught this. A missing
 * `withheld` OVER-offers, which `src/authz.js` names as the safe direction. A
 * missing `grants` UNDER-offers — it hides a control the server would have
 * allowed, which is the failure this whole mirror exists to prevent.
 *
 * One function, called by every endpoint that returns the caller to itself.
 */
export async function selfUserResponse(row) {
  if (!row) return null;
  return {
    /* Awaited: spreading a PROMISE yields {} — the user object would lose its
       id and every downstream query would bind undefined. */
    ...(await formatUserResponse(row)),
    grants: await grantsFor(db, row.id),
    withheld: await withheldCapabilitiesFor(db, row),
  };
}

export async function formatUserResponse(row) {
  if (!row) return null;

  /**
   * Credited hours, by the platform's one definition of them.
   *
   * ── Why this is a call and not a query ──
   *
   * It was `SELECT SUM(hours_awarded) FROM attendance WHERE user_id = ? AND
   * present = 1`, with no reference to the event — so it counted the hours of
   * events that had since been CANCELLED, which every other surface deliberately
   * does not. See the note on `creditedHoursFor`: a cancelled event is not
   * completed service, and printing it as such under a student's name is a claim
   * the platform cannot support.
   *
   * This copy was the one that mattered most, because it is `volunteeredHours`
   * on the user payload and therefore the large number on the dashboard.
   * Measured on a scratch database: 209 hours against one event, event
   * cancelled, dashboard still 209 while the same student's insights, profile
   * and transcript all read 0. Welly reading the second of those is what
   * surfaced it — "my dashboard says I have 209hrs […] its been like this for a
   * while."
   *
   * Same single query as before, so this stays as cheap as it was on a path that
   * runs for every authenticated response.
   */
  const totalHours = Number(await creditedHoursFor(db, row.id)) || 0;

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
    avatarColor: row.avatar_color || null,
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
    /* The account's own two service-privacy answers, so the Settings screen can
       render the switch in the state it is actually in rather than guessing a
       default. Normalised through the same function the read path uses, so the
       control and the enforcement can never disagree about what a stored value
       means. */
    hoursVisibility: normaliseVisibility(row.hours_visibility),
    certificatesVisibility: normaliseVisibility(row.certificates_visibility),
    friendActivityVisible: row.friend_activity_visible !== 0,
    /**
     * Whether this person agreed to be measured — and whether they have been
     * asked at all.
     *
     * Three states deliberately survive the trip to the client (see migration
     * 052): `null` is "not asked", which Settings renders differently from a
     * considered "no". Everything except exactly `1` reads as no consent, so a
     * corrupted value fails towards collecting nothing.
     *
     * It is on the SELF response only. `profileSerializer.js` is an allowlist
     * and this is not in it, which is correct: whether somebody agreed to
     * analytics is nobody else's business, including an organizer's.
     */
    analyticsConsent: row.analytics_consent === null || row.analytics_consent === undefined
      ? null
      : row.analytics_consent === 1,
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
/**
 * A transaction on the ambient connection.
 *
 * The primitive itself is `transactionOn` in `server/db/connectionContext.js` —
 * it lives there rather than here because two of its callers
 * (`organizerAgreement.js`, `studentOrganizerAgreement.js`) are modules that
 * `utils.js` already imports, so importing back would be a cycle. This is the
 * ambient-connection spelling that the ~71 existing callers use, unchanged.
 */
export function inTransaction(fn) {
  return transactionOn(currentConnection(), fn);
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
export async function createNotification({ userId, kind, title, body, link = null, dedupeKey = null }) {
  try {
    if (!NOTIFICATION_KINDS.includes(kind)) {
      console.warn(`Unknown notification kind "${kind}" — falling back to info.`);
      kind = 'info';
    }
    const id = `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await db.prepare(`
      INSERT INTO notifications (id, user_id, kind, title, body, link, read, created_at, dedupe_key)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(id, userId, kind, title, body || '', link, new Date().toISOString(), dedupeKey);
    
    // Stage 5: Email Notification Dispatch
    const IMPORTANT_EMAIL_KINDS = ['accepted', 'declined', 'promoted', 'hours', 'cancelled'];
    if (IMPORTANT_EMAIL_KINDS.includes(kind)) {
      const user = await db.prepare('SELECT email, email_opt_out FROM users WHERE id = ?').get(userId);
      if (user && user.email_opt_out !== 1) {
        // Fire and forget, we don't want to block the request on SMTP
        sendNotificationEmail(user.email, title, body || '').catch(err => {
          console.error(`Failed to send notification email to ${user.email}:`, err);
        });
      }
    }
    
    return id;
  } catch (e) {
    /**
     * A unique violation means we already sent this one — that's success.
     *
     * This matched on `String(e.message).includes('UNIQUE')`, which is SQLite's
     * wording ("UNIQUE constraint failed: …"). PostgreSQL says "duplicate key
     * value violates unique constraint" — lower case, and the match is
     * case-sensitive — so on PostgreSQL every DEDUPLICATED notification took the
     * error branch and logged "Failed to create notification". The return value
     * was the same either way, so nothing broke; what it produced was a steady
     * stream of logged errors for the one case that is explicitly not an error,
     * which is how a real failure gets lost.
     *
     * `isUniqueViolation` knows both engines: SQLSTATE 23505 on PostgreSQL, the
     * message on SQLite.
     */
    if (isUniqueViolation(e)) return null;
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
export async function purgeExpiredNotifications(now = new Date()) {
  let removed = 0;
  const stmt = await db.prepare('DELETE FROM notifications WHERE priority = ? AND created_at < ?');
  for (const [priority, days] of Object.entries(NOTIFICATION_RETENTION_DAYS)) {
    const cutoff = new Date(now.getTime() - days * 24 * 3600 * 1000).toISOString();
    removed += await stmt.run(priority, cutoff).changes;
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
export async function runNotificationSweep() {
  const now = new Date();
  const in48h = new Date(now.getTime() + 48 * 3600 * 1000).toISOString();
  const in24h = new Date(now.getTime() + 24 * 3600 * 1000).toISOString();
  const in2h = new Date(now.getTime() + 2 * 3600 * 1000).toISOString();
  let created = 0;

  try {
    // Deadline approaching on a starred event the student hasn't applied to
    const closingSoon = await db.prepare(`
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
      if (await notificationService.dispatch('EVENT_DEADLINE_APPROACHING', {
        eventId: row.event_id,
        eventTitle: row.title,
        countdownPhrase: countdownPhrase(row.application_deadline)
      }, row.user_id, `deadline:${row.event_id}`)) {
        created++;
      }
    }

    // Shift starting within 24h for confirmed volunteers
    const upcoming = await db.prepare(`
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
      if (await notificationService.dispatch('EVENT_REMINDER_24H', {
        eventId: row.event_id,
        eventTitle: row.title,
        slotName: row.slot_name,
        location: row.location
      }, row.user_id, `reminder-24h:${row.slot_id}`)) {
        created++;
      }
    }

    // Shift starting within 2h for confirmed volunteers
    const upcoming2h = await db.prepare(`
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
      if (await notificationService.dispatch('EVENT_REMINDER_2H', {
        eventId: row.event_id,
        eventTitle: row.title,
        slotName: row.slot_name,
        location: row.location
      }, row.user_id, `reminder-2h:${row.slot_id}`)) {
        created++;
      }
    }

    const stalled = await db.prepare(`
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

      if (await notificationService.dispatch('DECISION_NEEDED', {
        eventId: row.event_id,
        eventTitle: row.title,
        applicantsText: applicants + (n === 1 ? ' is' : ' are'),
        nextStep
      }, row.organizer_id, `awaiting-decision:${row.event_id}`)) {
        created++;
      }
    }
    
    const removed = await purgeExpiredNotifications(now);
    const revocations = await purgeExpiredRevocations(now);
    if (revocations > 0) console.log(`[Sessions] Purged ${revocations} expired revocation(s).`);

    // Step-up challenges: one row per sensitive action a user starts, including
    // every abandoned one, each carrying an ip_hash. Worthless once expired.
    const challenges = await sweepExpiredChallenges(db, now);
    if (challenges > 0) console.log(`[Reauth] Purged ${challenges} spent step-up challenge(s).`);

    /**
     * The two second-factor tables, on the same reasoning as the line above.
     *
     * Neither was swept by anything. `tfa_email_codes` keeps a bcrypt hash of
     * every code ever mailed, and rows are only ever read while unexpired — so
     * what accumulates is credential material with no remaining purpose, which
     * is precisely what `reauth_challenges` is swept to avoid keeping.
     *
     * `tfa_login_attempts` was deleted only by that user's own SUCCESSFUL
     * sign-in, so every abandoned attempt — the failure that made somebody give
     * up and reset their password instead — left a row keyed by a token hash
     * for ever. The counters are read against a fifteen-minute window, so
     * anything older than the widest window is already invisible to the ceiling
     * that reads it; an hour is a generous margin on that.
     */
    const tfa = await sweepTwoFactorRemnants(db, now);
    if (tfa > 0) console.log(`[2FA] Purged ${tfa} expired code and attempt row(s).`);

    /* Check-in codes expire after five minutes; these are swept a day later, so
       "did Leo's code work this morning?" is still answerable in the afternoon.
       After that it is credential material with no remaining purpose, which is
       the same reason the 2FA codes above are swept. */
    const codes = await sweepCheckinTokens(db, now);
    if (codes > 0) console.log(`[Check-in] Purged ${codes} expired check-in code(s).`);

    /**
     * Error records: aged evidence, closed groups, and the single-occurrence
     * client groups an unauthenticated flood leaves behind.
     *
     * Here rather than on a timer of its own, deliberately — a second interval
     * would be a second thing `shutdown.js` has to drain. `sweepErrors` catches
     * internally and returns counts instead of throwing, so a failure in it
     * cannot abandon the sweep tasks above it inside this one shared try block.
     */
    const errors = await sweepErrors(db, now);
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
     * one.
     *
     * What stops the next tick double-sending is NOT that this one finished:
     * on PostgreSQL every statement inside `sendErrorAlerts` is a round trip and
     * this call is not awaited, so two sweeps really can overlap. It is that
     * `sendErrorAlerts` CLAIMS its groups with a single conditional
     * `UPDATE … WHERE alerted_at IS NULL … RETURNING`, so only one caller can
     * ever own a given row and a loser sends nothing. The earlier wording said
     * the marking was synchronous, which was true on SQLite and is what would
     * have made this call unsafe here. The
     * `.catch` is belt and braces — the function does not reject — but an
     * unhandled rejection here would be reported by our own error capture,
     * which is the loop worth refusing outright.
     */
    /* `flow: 'error-alert'` sends this under the platform identity rather than
       the one users see. It goes to whoever runs the deployment, not to a
       volunteer, and a reply belongs in the operators' mailbox. */
    sendErrorAlerts(db, {
      send: (msg) => sendMail({ ...msg, flow: 'error-alert' }),
      now,
      appUrl: process.env.APP_URL
    })
      .then(({ sent, reason }) => {
        if (sent > 0) console.log(`[Alerts] Sent an alert covering ${sent} new problem(s).`);
        else if (reason === 'failed') console.warn('[Alerts] Alert send failed — see the error above.');
      })
      .catch(() => { /* sendErrorAlerts does not reject; this is belt and braces */ });

    /**
     * The backups, separately — and it has to be separate.
     *
     * `sendErrorAlerts` returns early on `nothing_new`, and a backup that
     * stopped running produces no error rows at all. A system that is otherwise
     * perfectly healthy is exactly the one whose backups fail unnoticed, so this
     * cannot ride on a path that a quiet error table short-circuits.
     *
     * Same contract as the call above: not awaited, catches internally, throttles
     * itself. Its own 12-hour floor rather than the hourly one, because a stale
     * backup is a standing condition and hourly mail about it gets the channel
     * muted — which is how this became invisible in the first place.
     */
    sendBackupAlert({
      status: backupStatus(),
      send: (msg) => sendMail({ ...msg, flow: 'error-alert' }),
      now,
      appUrl: process.env.APP_URL
    })
      .then(({ sent, reason, status }) => {
        if (sent > 0) console.warn(`[Alerts] Backups need attention (${status}) — an alert was sent.`);
        else if (reason === 'failed') console.warn('[Alerts] Backup alert send failed — see the error above.');
      })
      .catch(() => { /* does not reject; belt and braces */ });

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
/**
 * Notifies every confirmed volunteer for an event.
 *
 * ── Why this is one call and not a loop ──
 *
 * It dispatched recipients one at a time, and each dispatch cost up to five
 * database round trips — the opt-out lookup, the dedupe probe, the preference
 * read, and two inserts. So the organizer's request grew with how popular the
 * event had been: measured at 4,440 ms for 150 confirmed volunteers at 5 ms of
 * database latency. Bounding the concurrency at five brought that to 943 ms;
 * `dispatchMany` does the whole broadcast in a fixed four statements, because
 * every recipient of a fan-out shares the event, the payload and the rendered
 * content.
 *
 * `dispatchMany` keeps every per-recipient decision — preferences, the global
 * opt-out, the mandatory-notice override, deduplication and the realtime emit —
 * by feeding the same `decideDelivery` the single path uses.
 * `notificationDispatch.batch.test.js` runs both ways on identical fixtures and
 * compares the rows.
 *
 * The `sent` count is unchanged: `dispatchMany` reports the same tri-state per
 * recipient, and only a genuine delivery counts.
 */
export async function notifyConfirmedVolunteers(eventId, event, payload, dedupeKey = null) {
  const recipients = await db.prepare(`
    SELECT DISTINCT user_id FROM applications
    WHERE event_id = ? AND status = 'accepted'
  `).all(eventId);

  const outcomes = await notificationService.dispatchMany(
    event,
    payload,
    recipients.map(r => r.user_id),
    dedupeKey ? (userId) => `${dedupeKey}:${userId}` : null,
  );

  /* `dispatchMany` returns true when it delivered, and false or null when it
     deduped, found no user, or skipped the recipient. The count has always meant
     "how many were actually notified", so only `true` counts. */
  return [...outcomes.values()].filter(Boolean).length;
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
export async function assignWaitlistOrder(applicationId, slotId) {
  const row = await db.prepare(`
    SELECT COALESCE(MAX(waitlist_order), 0) AS last
    FROM applications
    WHERE slot_id = ? AND status = 'waitlisted' AND id != ?
  `).get(slotId, applicationId);
  await db.prepare('UPDATE applications SET waitlist_order = ? WHERE id = ?')
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
export async function promoteFromWaitlist(slotId) {
  /**
   * The slot row is LOCKED before anything is counted.
   *
   * This function reads the accepted count, computes `free = max_spots -
   * accepted`, and promotes that many from the head of the queue. Two spots
   * released at the same moment each run this, and without the lock both read
   * the same queue and promote the SAME person — the second UPDATE lands on a
   * row that is already accepted, so one promotion is silently lost and a
   * volunteer keeps waiting for a spot that is free.
   *
   * Measured before the lock existed: two spots released together with three
   * people waiting promoted ONE person, not two.
   *
   * `FOR UPDATE` is applied to the slot only, so the join to `events` still
   * reads normally — PostgreSQL would otherwise try to lock the event row too,
   * and nothing here modifies it.
   */
  const slot = await db.prepare(`
    SELECT s.id, s.name, s.max_spots, s.event_id,
           s.start_datetime, s.end_datetime,
           e.title AS event_title, e.organizer_id, e.status AS event_status,
           e.organization_id, e.audience
    FROM slots s JOIN events e ON e.id = s.event_id
    WHERE s.id = ?
  ${forUpdate(db) ? 'FOR UPDATE OF s' : ''}`).get(slotId);
  if (!slot) return [];

  // Pulling someone into a called-off event would be worse than leaving them
  // waiting — they would arrange a ride around a shift that is not happening.
  if (slot.event_status === 'cancelled' || slot.event_status === 'completed') return [];

  const accepted = (await db.prepare(
    "SELECT COUNT(*) AS c FROM applications WHERE slot_id = ? AND status = 'accepted'"
  ).get(slotId)).c;

  const free = slot.max_spots - accepted;
  if (free <= 0) return [];

  // NULLS LAST so a legacy row written before waitlist_order was assigned sorts
  // behind properly-queued ones instead of jumping the queue; applied_at then id
  // as a stable tiebreak so two rows can never swap places between calls.
  /**
   * The WHOLE queue, filtered, then cut to the free places.
   *
   * ── Why eligibility is re-asked here ──
   *
   * A waitlisted row is a request, not a place. Promotion is the moment the
   * place is actually given — a NEW seating decision, taken by the platform,
   * possibly weeks after the person joined the queue. In between, the
   * organization may have banned them, or the event may have been narrowed to
   * members only. Seating them anyway would have the platform hand somebody a
   * shift the organization had just refused them, with nobody having decided
   * anything.
   *
   * This is deliberately NOT the same rule as an already-accepted place, which
   * a ban leaves alone (see `routes.eventEligibility.test.js`). Keeping a place
   * somebody was given is not the same act as giving them one.
   *
   * Skipped rows stay `waitlisted` and keep their position — the queue moves
   * past them rather than dropping them, so a lifted ban or a new membership
   * puts them back in line where they were.
   *
   * ── And why a clashing acceptance is asked about in the same breath ──
   *
   * It is the same argument with a different fact. Promotion is a new seating
   * decision taken by the platform, and somebody who has since been accepted to
   * a shift at this time cannot take this one; promoting them anyway hands the
   * organizer a name who will not arrive, and it happens with nobody deciding.
   *
   * The rule is `usersWithClashingAcceptance`, which is the same rule and the
   * same boundary the Auto Select draw applies — the two paths must agree,
   * because they are the same platform making the same automatic decision at
   * two different moments, and a student passed over by one and seated by the
   * other would be the platform contradicting itself.
   *
   * The skip-don't-drop behaviour above is exactly what makes this humane and
   * self-healing: this is re-asked on every freed place, so when the clashing
   * acceptance is withdrawn the student is promoted at the position they held.
   * That is the reason the draw waitlists a clash rather than rejecting it.
   *
   * ── One query, and no lock on the other slot ──
   *
   * Asked once for the whole queue rather than per row. The other slots'
   * acceptances are read without locking them, so in principle somebody could
   * be accepted elsewhere between this read and the UPDATE below. Locking them
   * would mean taking row locks on slots in an order set by the data, and two
   * promotions on two mutually-overlapping slots would each hold what the other
   * wants — a deadlock in place of a rare and self-correcting stale read, which
   * the next call to this function fixes. The pre-existing eligibility read
   * above has the same shape for the same reason.
   */
  const waiting = await db.prepare(`
    SELECT a.id, a.user_id, u.name AS volunteer_name
    FROM applications a JOIN users u ON u.id = a.user_id
    WHERE a.slot_id = ? AND a.status = 'waitlisted'
    ORDER BY a.waitlist_order IS NULL, a.waitlist_order ASC, a.applied_at ASC, a.id ASC
  `).all(slotId);

  const clashing = await usersWithClashingAcceptance(
    db, waiting.map(row => row.user_id), slot,
  );

  const queue = [];
  for (const row of waiting) {
    if (queue.length >= free) break;
    if (clashing.has(row.user_id)) continue;
    if ((await eventApplicationEligibility(slot, row.user_id)).ok) queue.push(row);
  }
  if (queue.length === 0) return [];

  const promote = await db.prepare(
    "UPDATE applications SET status = 'accepted', waitlist_order = NULL WHERE id = ?"
  );
  const renumber = await db.prepare('UPDATE applications SET waitlist_order = ? WHERE id = ?');

  for (const row of queue) await promote.run(row.id);

  // Close the gap the promotion left, so positions stay 1..n and the person who
  // was 3rd is told they are now 2nd rather than staying stuck at 3.
  const remaining = await db.prepare(`
    SELECT id FROM applications
    WHERE slot_id = ? AND status = 'waitlisted'
    ORDER BY waitlist_order IS NULL, waitlist_order ASC, applied_at ASC, id ASC
  `).all(slotId);
  /* A sequential loop, not `forEach`: the callback would have to be async, and
     `forEach` neither awaits nor collects what it returns — every renumbering
     would be an unhandled promise racing the response. */
  for (const [i, r] of remaining.entries()) await renumber.run(i + 1, r.id);

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
export async function notifyPromotions(promotions) {
  /**
   * Deliberately a loop, and NOT `dispatchMany`.
   *
   * `dispatchMany` takes a set of RECIPIENTS and notifies each of them once — it
   * deduplicates the id list, which is right for a broadcast and wrong here.
   * These are per-PROMOTION notices: one volunteer can be promoted off two
   * different slots in the same sweep, and they are owed a notification for each.
   * Batching would silently collapse the second one.
   *
   * The per-dispatch cost fell anyway: `dispatch` now reads the opt-out, both
   * preferences and the dedupe probe in one statement instead of three.
   *
   * `notificationDispatch.batch.test.js` pins the collapsing behaviour, so the
   * distinction is checkable rather than a matter of memory.
   */
  for (const p of promotions) {
    await notificationService.dispatch('WAITLIST_PROMOTED', {
      eventId: p.eventId,
      eventTitle: p.eventTitle,
      slotName: p.slotName
    }, p.userId);

    await notificationService.dispatch('WAITLIST_PROMOTION_MADE', {
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
export async function handleWaitlistPromotion(slotId) {
  try {
    return await notifyPromotions(await promoteFromWaitlist(slotId));
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

