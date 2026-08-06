import express from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import {
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendEmailChangeConfirmation,
  sendEmailChangeNotice
} from '../email.js';
import { VALID_GRADES, JWT_SECRET, DEMO_MODE, COOKIE_NAME, cookieOptions, clearCookieOptions } from '../config.js';

import { authenticateToken, formatUserResponse, inTransaction, revokeSession } from '../utils.js';
import { assertConsent, recordAcceptances, ConsentMissing } from '../consent.js';
import { withheldCapabilitiesFor } from '../organizerAgreement.js';
import { db, initDatabase } from '../db.js';
import { validateAccountFields, validatePassword, validateUsername, validateEmail, validateProfilePatch } from '../accountValidation.js';
import { issueVerificationToken, sendVerificationMail, purgeExpiredVerificationTokens } from '../services/verification.js';
import { isSuspended, liftIfExpired } from '../suspension.js';

const router = express.Router();

/** Sentinel stored in password_hash for accounts that sign in only through a provider. */
export const OAUTH_ONLY = '!OAUTH_ONLY!';

/**
 * Per-ACCOUNT login throttle.
 *
 * app.js already limits sign-in attempts per source address, which stops one
 * machine grinding through a password list. It does nothing about the opposite
 * shape: many source addresses each trying a handful of passwords against one
 * known account. That is the shape that actually takes over accounts, and on a
 * school platform the target list is guessable — first.last@district.org.
 *
 * The counter is in-process, which is the right size for a single-process
 * deployment and degrades to per-instance if that ever changes; it is a
 * hardening layer over the IP limiter, not the only thing standing there.
 *
 * A successful sign-in clears the count, so a person who remembers their
 * password on the sixth try is never locked out by the first five.
 *
 * ── Keyed on the resolved account, not on what was typed ──
 *
 * This used to key on the identifier string, which meant an account reachable
 * as both `leo.chen@school.org` and `leochen` had two independent buckets and
 * therefore twice the allowance — an attacker just alternated spellings. The
 * limit is a property of the account being attacked, so the key has to be too.
 *
 * Attempts against an identifier that matches no account still need a bucket
 * (there is no id to key on), so those fall back to the normalised string under
 * a separate prefix. They can never collide with a real account's bucket.
 */
const LOGIN_FAILURE_LIMIT = Number(process.env.LOGIN_FAILURE_LIMIT) || 10;
const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const loginFailures = new Map();

/** Bucket key for a resolved account, or for an identifier that matched none. */
function throttleKey(userRow, identifier) {
  return userRow ? `id:${userRow.id}` : `anon:${String(identifier).trim().toLowerCase()}`;
}

function loginLockState(key) {
  const entry = loginFailures.get(key);
  if (!entry || entry.until <= Date.now()) return { locked: false };
  if (entry.count < LOGIN_FAILURE_LIMIT) return { locked: false };
  return { locked: true, minutes: Math.max(1, Math.ceil((entry.until - Date.now()) / 60000)) };
}

function recordLoginFailure(key) {
  const now = Date.now();
  const entry = loginFailures.get(key);
  if (!entry || entry.until <= now) {
    loginFailures.set(key, { count: 1, until: now + LOGIN_FAILURE_WINDOW_MS });
  } else {
    entry.count += 1;
  }

  // Opportunistic sweep so an attacker cannot grow this map without bound by
  // trying a new identifier every request.
  if (loginFailures.size > 5000) {
    for (const [k, v] of loginFailures) {
      if (v.until <= now) loginFailures.delete(k);
    }
    // If the map is still too large (e.g., under active attack with unexpired entries),
    // forcefully evict entries to prevent a memory exhaustion crash. Map iteration
    // is insertion order, so this evicts the oldest attempts first.
    if (loginFailures.size > 5000) {
      for (const k of loginFailures.keys()) {
        loginFailures.delete(k);
        if (loginFailures.size <= 4000) break;
      }
    }
  }
}

/** Clears an account's bucket. Takes the user id, not a typed identifier. */
export function clearLoginFailuresForUser(userId) {
  loginFailures.delete(`id:${userId}`);
}

/** Test seam: lets a suite exercise the throttle without leaking state between cases. */
export function __resetLoginThrottle() {
  loginFailures.clear();
}

/** Signs the caller in by setting the session cookie. */
export function issueSession(res, user, tokenVersion) {
  const token = jwt.sign(
    {
      id: user.id, role: user.role, email: user.email, name: user.name,
      tokenVersion: tokenVersion ?? 0,
      /**
       * Per-session id, so ONE session can be revoked.
       *
       * `tokenVersion` can only revoke every session an account has, which is
       * why logout could not use it: doing so signed the user out on all their
       * devices, the bug that /sign-out-others exists to keep separate. With a
       * jti, logout records just this token (see revoked_sessions) and the
       * account's other devices are untouched.
       */
      jti: crypto.randomUUID()
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
  res.cookie(COOKIE_NAME, token, cookieOptions());
}

/**
 * Availability check behind the live tick on the signup form.
 *
 * This is an enumeration oracle by construction — that is what it is for — so
 * it is deliberately narrow. It answers only about a syntactically valid
 * candidate username, so it cannot be walked with one-character probes, and
 * app.js puts it behind a dedicated limiter. A caller who fails the format
 * rules gets the format complaint and no information about the database.
 */
router.get('/api/auth/check-username', (req, res) => {
  const check = validateUsername(req.query.username);
  if (!check.ok) {
    return res.json({ available: false, valid: false, error: check.error });
  }
  const taken = db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(check.value);
  res.json({ available: !taken, valid: true });
});

router.post('/api/auth/signup', async (req, res) => {
  const { password, signupToken } = req.body;

  /**
   * An OAuth signup token proves the provider vouched for this address, and
   * carries whether the provider actually attested to it.
   */
  let oauthData = null;
  if (signupToken) {
    try {
      oauthData = jwt.verify(signupToken, JWT_SECRET);
    } catch {
      return res.status(400).json({ error: 'That sign-up link expired. Please start again.' });
    }
    if (oauthData.action !== 'signup') {
      return res.status(400).json({ error: 'Invalid token action' });
    }
  }

  /**
   * The address always comes from the provider when there is one.
   *
   * The old code compared the typed address against the provider's and
   * rejected a mismatch, which made a field the user could not usefully change
   * into a way to fail the form. Taking the provider's value outright is both
   * simpler and stricter: there is no path where a client-supplied address
   * gets attached to a provider identity.
   */
  const emailSource = oauthData ? oauthData.providerEmail : req.body.email;

  const check = validateAccountFields({ ...req.body, email: emailSource });
  if (!check.ok) {
    // `code` is passed through so the client can treat an age refusal as
    // terminal rather than as a field to correct — an age screen that invites
    // a retry with a different year is a formality, not a gate.
    return res.status(400).json({ error: check.error, field: check.field, code: check.code });
  }
  const fields = check.value;

  /**
   * A password is required on the email path, and optional — but never
   * discarded — on the provider path.
   *
   * The old code skipped every password rule when a signupToken was present
   * and then stored the OAUTH_ONLY sentinel anyway, directly contradicting the
   * comment sitting above it which said the local password was deliberately
   * kept. So someone who completed the provider signup form typed a password,
   * watched it be accepted, and silently ended up with an account that had
   * none. "Forgot password" could not help them either, because there was no
   * password to reset — only the provider could let them back in.
   *
   * Either behaviour is defensible; silently doing one while claiming the
   * other is not. The rule now: if you give us a password it is validated and
   * stored, and if you do not, the account signs in through its provider and
   * can add one later from Settings.
   */
  const wantsPassword = Boolean(password) || !oauthData;
  if (wantsPassword) {
    const passwordCheck = validatePassword(password);
    if (!passwordCheck.ok) {
      return res.status(400).json({ error: passwordCheck.error, field: passwordCheck.field });
    }
  }

  /**
   * Consent, checked on the server because the checkbox never was.
   *
   * `Signup.jsx` rendered a privacy checkbox and validated it, and then
   * `baseFields()` — the object actually sent — did not include it. It never
   * left the browser, the server never saw it, and nothing stored it. The
   * control was also wrapped in `{PRIVACY_URL && ...}` with an empty default,
   * so a default build asked for nothing at all. The platform published
   * policies while holding no evidence that anyone had accepted one, which is
   * what makes a Terms of Service unenforceable.
   *
   * Placed here, ahead of the uniqueness queries, because it is a free local
   * check and because it applies identically to BOTH signup paths — this one
   * endpoint serves the password form and the provider flow (distinguished by
   * `signupToken`), so a single gate covers both. An OAuth user who was never
   * asked is exactly the hole that would make the whole record worthless.
   */
  try {
    assertConsent(req.body);
  } catch (err) {
    if (err instanceof ConsentMissing) {
      return res.status(400).json({
        error: 'Please agree to the Terms of Service and confirm you have seen the Privacy Policy.',
        code: 'consent_required',
        missing: err.missing,
      });
    }
    throw err;
  }

  // Explicit checks for clean, field-attributed messages. The UNIQUE-violation
  // catch below is only the race backstop between here and the INSERT.
  if (db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(fields.username)) {
    return res.status(409).json({ error: 'That username is already taken.', field: 'username' });
  }
  if (db.prepare('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE').get(fields.email)) {
    return res.status(409).json({ error: 'An account already exists for that email address.', field: 'email' });
  }

  try {
    const userId = `user-${crypto.randomUUID()}`;
    const passwordHash = wantsPassword
      ? await bcrypt.hash(password, 10)
      : OAUTH_ONLY;
    const now = new Date().toISOString();

    // Organizers are approved by staff before they can post events. Separate
    // gate from confirming an email address; both must pass.
    const verifiedVal = fields.role === 'organizer' ? 0 : 1;

    /**
     * Only a provider that actually attests to the address counts as
     * confirmation. Google does (`email_verified`); Microsoft's Graph
     * attributes do not, and the provider module reports that honestly.
     */
    const emailVerifiedVal = oauthData && oauthData.providerEmailVerified === true ? 1 : 0;

    inTransaction(() => {
      /**
       * `graduation_year` is the stored truth about grade level;
       * `fields.grade` is the value DERIVED from it by
       * `validateGraduationYear`, never the one the client claimed. Writing
       * `req.body.grade` here instead would reintroduce exactly the
       * contradiction the derivation exists to prevent — and would let a
       * hand-written request register a ninth grader as a senior.
       */
      db.prepare(`
        INSERT INTO users (id, name, email, username, password_hash, grade, graduation_year, role, verified, email_verified, avatar, bio, school, skills, date_of_birth, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        userId, fields.name, fields.email, fields.username, passwordHash,
        fields.grade, fields.graduationYear, fields.role, verifiedVal, emailVerifiedVal,
        fields.avatar, fields.bio, fields.school, JSON.stringify(fields.skills),
        fields.dateOfBirth, now
      );

      if (oauthData) {
        db.prepare(`
          INSERT INTO oauth_accounts (id, user_id, provider, provider_user_id, provider_email, created_at, updated_at, last_used_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(`oauth-${crypto.randomUUID()}`, userId, oauthData.provider, oauthData.providerUserId, oauthData.providerEmail, now, now, now);
      }

      /**
       * Written in the SAME transaction as the account row.
       *
       * An account that exists without its acceptance rows is an account that
       * never agreed to anything, and it would look entirely normal in every
       * functional test — the user can sign in, the profile renders, nothing
       * errors. It only surfaces when somebody asks what this person agreed to
       * and there is no answer.
       *
       * This is the same atomicity rule `spendChallenge` follows for step-up
       * grants, for the same reason and with the same shape: both writes commit
       * or neither does. `now` is shared with the user INSERT so the account and
       * its consent carry an identical timestamp rather than two that differ by
       * a millisecond and invite questions later.
       */
      recordAcceptances(db, {
        userId,
        method: oauthData ? 'oauth_signup' : 'signup',
        context: oauthData ? `oauth:${oauthData.provider}` : 'password',
        req,
        now,
      });
    });

    const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    const user = formatUserResponse(userRow);

    /**
     * Sign the new account in either way, and let the email gate decide what
     * it may do.
     *
     * Previously a form signup got `{ action: 'verification_required' }` and no
     * session at all — which sounds strict but achieved nothing, because
     * /api/auth/login had no verification check, so the same user simply
     * signed in a second later with full access. Meanwhile it broke the honest
     * path: with no session, "resend verification" (which requires one) was
     * unreachable, so anyone who mistyped their address was stuck.
     *
     * Now the session exists, authenticateToken's allowlist confines an
     * unconfirmed account to seeing itself and finishing verification, and
     * `emailVerified` on the response tells the client which screen to show.
     */
    issueSession(res, user, userRow.token_version);

    if (emailVerifiedVal !== 1) {
      sendVerificationMail(fields.email, issueVerificationToken(userId));
    }

    res.status(201).json({
      user,
      emailVerified: emailVerifiedVal === 1,
      action: emailVerifiedVal === 1 ? 'signed_in' : 'verification_required'
    });
  } catch (error) {
    console.error('Signup error:', error);
    if (String(error.message).includes('UNIQUE')) {
      const isUsername = String(error.message).includes('username');
      return res.status(409).json({
        error: isUsername ? 'That username is already taken.' : 'An account already exists for that email address.',
        field: isUsername ? 'username' : 'email'
      });
    }
    res.status(500).json({ error: 'Internal server error during registration' });
  }
});

/**
 * Sign in with an email address OR a username.
 *
 * ── A deliberate trade-off, recorded here because it is not free ──
 *
 * This route distinguishes "no such account" from "wrong password", which is
 * an account-enumeration oracle: an unauthenticated caller can confirm whether
 * a given address or username belongs to someone here, and the people here are
 * mostly minors.
 *
 * It is done anyway because it was asked for explicitly, and because the
 * generic message was making real support work out of ordinary typos — a
 * student who mistypes their username cannot tell that from a forgotten
 * password, and neither can the adult helping them. Every major consumer
 * sign-in (Google, Apple, GitHub) makes the same call.
 *
 * What bounds it: the signup form already needs a public availability check
 * for both fields (`check-username`, `check-email`), so the same fact is
 * obtainable regardless of what this route says — closing it here without
 * closing those would be theatre. All four endpoints sit behind limiters in
 * app.js, and this one additionally throttles per identifier so the answer
 * cannot be harvested in bulk from a rotating set of source addresses.
 *
 * To reverse: set GENERIC_LOGIN_ERRORS to true. Nothing else needs to change.
 */
const GENERIC_LOGIN_ERRORS = false;
const GENERIC_MESSAGE = 'That email or password is not correct.';

/**
 * Async bcrypt, deliberately.
 *
 * `bcryptjs` is pure JavaScript, so `compareSync`/`hashSync` occupy the single
 * event-loop thread for the whole computation. Measured before this change: while 40
 * logins were in flight, `/health` — which performs no hashing at all — went from
 * ~1 ms to a p95 of 3,761 ms, and only 6 health probes completed in 4.2 s. Every
 * other user's request was queued behind password hashing.
 *
 * The async API chunks its work and yields between rounds, so unrelated requests
 * interleave. Cost and output are unchanged: hashes produced either way verify under
 * either API (checked both directions), so stored hashes stay valid and no migration
 * is needed.
 *
 * No bcrypt call sits inside `inTransaction(...)` — verified before converting.
 * Awaiting inside a synchronous SQLite transaction would let unrelated statements
 * interleave with an open transaction, which is a far worse bug than the stall.
 */
router.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Enter your email or username and your password.' });
  }

  try {
    const identifier = String(email).trim();
    const userRow = db.prepare(
      'SELECT * FROM users WHERE email = ? COLLATE NOCASE OR username = ? COLLATE NOCASE'
    ).get(identifier, identifier);

    const looksLikeEmail = identifier.includes('@');
    const key = throttleKey(userRow, identifier);

    /**
     * The lock is checked FIRST, before any branch that describes the account.
     *
     * It used to sit just above the bcrypt comparison, below the
     * no_such_account / suspended / oauth_only replies — so a caller who had
     * already been locked out could still read all three of those oracles at
     * will, and attempts against identifiers matching no account were never
     * gated at all. A lock that only covers the password comparison is not a
     * lock on the endpoint.
     */
    const lock = loginLockState(key);
    if (lock.locked) {
      return res.status(429).json({
        error: `Too many failed attempts for this account. Try again in about ${lock.minutes} minute${lock.minutes === 1 ? '' : 's'}, or reset your password.`,
        code: 'account_throttled',
        retryAfterMinutes: lock.minutes
      });
    }

    if (!userRow || userRow.account_status === 'deleted') {
      recordLoginFailure(key);
      return res.status(401).json({
        error: GENERIC_LOGIN_ERRORS
          ? GENERIC_MESSAGE
          : looksLikeEmail
            ? 'No account found with that email address.'
            : 'No account found with that username.',
        code: 'no_such_account'
      });
    }

    /**
     * The suspension notice, and who it sends the user to.
     *
     * This read "Contact your school administrator." WeVolunteer is an
     * independent platform and not a school district service — a school
     * administrator has no access to it, cannot see the suspension, and cannot
     * review it. The one screen a suspended user is guaranteed to see pointed
     * them at somebody powerless, while the Community Guidelines and the Terms
     * both commit to an appeal answered within five business days at an address
     * this message never mentioned.
     */
    /**
     * `isSuspended`, not `account_status === 'suspended'`.
     *
     * A timed suspension ends when its deadline passes, and this is the door the
     * person walks back through — comparing the status string alone would keep
     * somebody locked out after their own end date, which is the failure the
     * stored deadline exists to prevent. `liftIfExpired` then corrects the row so
     * the rest of the platform stops calling them suspended.
     *
     * The end date is named in the refusal. A suspension the person cannot see the
     * end of is indistinguishable from a permanent one, and the Community
     * Guidelines' promise to tell somebody the outcome is not kept by telling them
     * only that there is one.
     */
    if (isSuspended(userRow)) {
      const until = userRow.suspended_until
        ? new Date(userRow.suspended_until)
        : null;
      const when = until && !Number.isNaN(until.getTime())
        ? until.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
        : null;

      return res.status(403).json({
        error: (when
          ? `This account is suspended until ${when}. `
          : 'This account has been suspended. ')
          + 'If you think that is wrong, email '
          + 'wevolunteer.platform@gmail.com to ask for a review — we reply within five '
          + 'business days with the outcome and the reason.',
        code: 'suspended',
        suspendedUntil: userRow.suspended_until ?? null,
      });
    }
    liftIfExpired(db, userRow);

    /**
     * An account that signs in only through a provider has the OAUTH_ONLY
     * sentinel in password_hash. compareSync against that just returns false,
     * so without this branch the user was told their password was wrong — for
     * an account that has never had one, with no hint about what to do.
     *
     * Not counted as a failure: it is not a password guess, and counting it
     * would let anyone lock a provider-only account out of a route it cannot
     * use anyway.
     */
    if (userRow.password_hash === OAUTH_ONLY) {
      const linked = db.prepare('SELECT provider FROM oauth_accounts WHERE user_id = ?').all(userRow.id);
      const names = linked.map(l => l.provider.charAt(0).toUpperCase() + l.provider.slice(1));
      return res.status(409).json({
        error: names.length
          ? `This account signs in with ${names.join(' or ')}. Use that button above, or reset your password to add one.`
          : 'This account has no password set. Use “Forgot password” to create one.',
        code: 'oauth_only',
        providers: linked.map(l => l.provider)
      });
    }

    if (!await bcrypt.compare(password, userRow.password_hash)) {
      recordLoginFailure(key);
      return res.status(401).json({
        error: GENERIC_LOGIN_ERRORS ? GENERIC_MESSAGE : 'Incorrect password.',
        code: 'wrong_password'
      });
    }

    clearLoginFailuresForUser(userRow.id);

    const user = formatUserResponse(userRow);
    issueSession(res, user, userRow.token_version);

    /**
     * An unconfirmed account is signed in but confined by the email gate in
     * authenticateToken. Reporting it here lets the client route straight to
     * the "confirm your address" screen with a working resend button, rather
     * than discovering the restriction as a 403 on the first real action.
     */
    res.json({
      user,
      emailVerified: userRow.email_verified === 1,
      ...(userRow.email_verified !== 1 && {
        action: 'verification_required',
        message: 'This account has not been verified. Check your email for the confirmation link.'
      })
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error during login' });
  }
});

/**
 * 3. Get Authenticated User Details (Me)
 *
 * ── Why `withheld` is added here and not in `formatUserResponse` ──
 *
 * This is the ONLY payload the client's `currentUser` is ever built from —
 * `SessionProvider` sets it from `api.getMe()` and from nowhere else, including
 * after an acceptance, which calls `refreshAll`. So this is the one place the
 * field is read, and adding it to the shared formatter would instead attach it
 * to two payloads describing OTHER people (the admin user list, and a profile
 * view), where it discloses whether some third party has signed an agreement to
 * anyone who can see them.
 *
 * It is what lets the client's `can()` agree with the server about an organizer
 * who has not yet accepted; see the header in `src/authz.js`. The gate itself is
 * server-side and derived per request — this changes what is offered, never what
 * is allowed.
 */
router.get('/api/auth/me', authenticateToken, (req, res) => {
  try {
    const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!userRow) return res.status(404).json({ error: 'User not found' });

    res.json({
      ...formatUserResponse(userRow),
      withheld: withheldCapabilitiesFor(db, userRow),
    });
  } catch (error) {
    console.error('Auth check error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Sign out of THIS device.
 *
 * Clears the cookie and nothing else. It previously also incremented
 * token_version, which invalidates every session the account has — so signing
 * out of a shared library computer also signed the same student out on their
 * own phone, and there was no way to sign out of one device without losing the
 * others.
 *
 * The global case is a separate, deliberate act with its own button and its own
 * route (/api/auth/sign-out-others), which is where that behaviour belongs.
 * Because sessions are stateless JWTs, a cookie cleared here is still
 * technically valid until it expires — the trade-off accepted when sessions
 * moved to token_version-based bulk invalidation, and the reason the "sign out
 * everywhere else" control exists for anyone who needs the stronger guarantee.
 */
router.post('/api/auth/logout', authenticateToken, (req, res) => {
  try {
    /**
     * Revoke THIS session, not the account.
     *
     * Clearing the cookie alone left the token valid for the rest of its seven
     * days, so a copy taken from a shared machine kept working after the student
     * had signed out and believed they were done. Recording the token's `jti`
     * makes the sign-out real while leaving the account's other devices alone —
     * which `token_version` could not do, since it revokes all of them.
     *
     * Decoded without re-verifying: authenticateToken has already verified the
     * signature and expiry to get here.
     */
    const token = req.cookies?.[COOKIE_NAME];
    const claims = token ? jwt.decode(token) : null;
    if (claims?.jti) {
      revokeSession({ jti: claims.jti, userId: req.user.id, expSeconds: claims.exp });
    }

    res.clearCookie(COOKIE_NAME, clearCookieOptions());
    res.json({ success: true });
  } catch (err) {
    console.error('Logout error:', err);
    res.status(500).json({ error: 'Failed to logout' });
  }
});

// Delete Account
/**
 * Sign out everywhere else.
 *
 * Also previously a lie: Settings' "Sign out all other devices" button called
 * a handler whose body was a success toast. A user acting on a suspicion that
 * someone else had their session was told it had been dealt with, and nothing
 * had happened.
 */
router.post('/api/auth/sign-out-others', authenticateToken, (req, res) => {
  try {
    db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(req.user.id);
    const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    issueSession(res, formatUserResponse(fresh), fresh.token_version);
    res.json({ success: true });
  } catch (err) {
    console.error('Sign out others error:', err);
    res.status(500).json({ error: 'Could not sign out your other devices.' });
  }
});


export default router;
