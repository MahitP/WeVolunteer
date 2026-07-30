import express from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { sendVerificationEmail, sendPasswordResetEmail } from '../email.js';
import { VALID_GRADES, JWT_SECRET, DEMO_MODE, COOKIE_NAME, cookieOptions, clearCookieOptions } from '../config.js';

import { authenticateToken, formatUserResponse, inTransaction } from '../utils.js';
import { db, initDatabase } from '../db.js';
import { validateAccountFields, validatePassword, validateUsername, validateEmail } from '../accountValidation.js';
import { issueVerificationToken, sendVerificationMail, purgeExpiredVerificationTokens } from '../services/verification.js';

const router = express.Router();

/** Sentinel stored in password_hash for accounts that sign in only through a provider. */
const OAUTH_ONLY = '!OAUTH_ONLY!';

/**
 * Per-identifier login throttle.
 *
 * app.js already limits sign-in attempts per source address, which stops one
 * machine grinding through a password list. It does nothing about the opposite
 * shape: many source addresses each trying a handful of passwords against one
 * known account. That is the shape that actually takes over accounts, and on a
 * school platform the target list is guessable — first.last@district.org.
 *
 * So failures are also counted against the identifier that was tried. The
 * counter is in-process, which is the right size for a single-process
 * deployment and degrades to per-instance if that ever changes; it is a
 * hardening layer over the IP limiter, not the only thing standing there.
 *
 * A successful sign-in clears the count, so a person who remembers their
 * password on the sixth try is never locked out by the first five.
 */
const LOGIN_FAILURE_LIMIT = Number(process.env.LOGIN_FAILURE_LIMIT) || 10;
const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const loginFailures = new Map();

function failureKey(identifier) {
  return String(identifier).trim().toLowerCase();
}

function loginLockState(identifier) {
  const entry = loginFailures.get(failureKey(identifier));
  if (!entry || entry.until <= Date.now()) return { locked: false };
  if (entry.count < LOGIN_FAILURE_LIMIT) return { locked: false };
  return { locked: true, minutes: Math.max(1, Math.ceil((entry.until - Date.now()) / 60000)) };
}

function recordLoginFailure(identifier) {
  const key = failureKey(identifier);
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
  }
}

function clearLoginFailures(identifier) {
  loginFailures.delete(failureKey(identifier));
}

/** Test seam: lets a suite exercise the throttle without leaking state between cases. */
export function __resetLoginThrottle() {
  loginFailures.clear();
}

/** Signs the caller in by setting the session cookie. */
function issueSession(res, user, tokenVersion) {
  const token = jwt.sign(
    { id: user.id, role: user.role, email: user.email, name: user.name, tokenVersion: tokenVersion ?? 0 },
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

router.post('/api/auth/signup', (req, res) => {
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
    return res.status(400).json({ error: check.error, field: check.field });
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
      ? bcrypt.hashSync(password, bcrypt.genSaltSync(10))
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
      db.prepare(`
        INSERT INTO users (id, name, email, username, password_hash, grade, role, verified, email_verified, avatar, bio, school, skills, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        userId, fields.name, fields.email, fields.username, passwordHash,
        fields.grade, fields.role, verifiedVal, emailVerifiedVal,
        fields.avatar, fields.bio, fields.school, JSON.stringify(fields.skills), now
      );

      if (oauthData) {
        db.prepare(`
          INSERT INTO oauth_accounts (id, user_id, provider, provider_user_id, provider_email, created_at, updated_at, last_used_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(`oauth-${crypto.randomUUID()}`, userId, oauthData.provider, oauthData.providerUserId, oauthData.providerEmail, now, now, now);
      }
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

router.post('/api/auth/login', (req, res) => {
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

    if (!userRow || userRow.account_status === 'deleted') {
      recordLoginFailure(identifier);
      return res.status(401).json({
        error: GENERIC_LOGIN_ERRORS
          ? GENERIC_MESSAGE
          : looksLikeEmail
            ? 'No account found with that email address.'
            : 'No account found with that username.',
        code: 'no_such_account'
      });
    }

    if (userRow.account_status === 'suspended') {
      return res.status(403).json({
        error: 'This account has been suspended. Contact your school administrator.',
        code: 'suspended'
      });
    }

    /**
     * An account that signs in only through a provider has the OAUTH_ONLY
     * sentinel in password_hash. compareSync against that just returns false,
     * so without this branch the user was told their password was wrong — for
     * an account that has never had one, with no hint about what to do.
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

    const lock = loginLockState(identifier);
    if (lock.locked) {
      return res.status(429).json({
        error: `Too many failed attempts for this account. Try again in about ${lock.minutes} minute${lock.minutes === 1 ? '' : 's'}, or reset your password.`,
        code: 'account_throttled',
        retryAfterMinutes: lock.minutes
      });
    }

    if (!bcrypt.compareSync(password, userRow.password_hash)) {
      recordLoginFailure(identifier);
      return res.status(401).json({
        error: GENERIC_LOGIN_ERRORS ? GENERIC_MESSAGE : 'Incorrect password.',
        code: 'wrong_password'
      });
    }

    clearLoginFailures(identifier);

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

// 3. Get Authenticated User Details (Me)
router.get('/api/auth/me', authenticateToken, (req, res) => {
  try {
    const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!userRow) return res.status(404).json({ error: 'User not found' });
    
    res.json(formatUserResponse(userRow));
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
    res.clearCookie(COOKIE_NAME, clearCookieOptions());
    res.json({ success: true });
  } catch (err) {
    console.error('Logout error:', err);
    res.status(500).json({ error: 'Failed to logout' });
  }
});

// Delete Account
router.delete('/api/auth/account', authenticateToken, (req, res) => {
  const { password, confirmUsername } = req.body;
  try {
    const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!userRow) return res.status(404).json({ error: 'User not found' });

    if (userRow.password_hash !== OAUTH_ONLY) {
      if (!password) {
        return res.status(400).json({ error: 'Password is required to delete your account' });
      }
      if (!bcrypt.compareSync(password, userRow.password_hash)) {
        return res.status(401).json({ error: 'Incorrect password' });
      }
    } else {
      /**
       * A provider-only account has no password to re-prove with, and the
       * previous code therefore asked for nothing at all: a single request
       * against a live session irreversibly anonymised the account. Typing the
       * account's own username is not a credential, but it is a server-checked
       * deliberate act, which is what this confirmation is for. Compare
       * case-insensitively — the intent is confirmation, not a spelling test.
       */
      if (String(confirmUsername || '').trim().toLowerCase() !== String(userRow.username || '').toLowerCase()) {
        return res.status(400).json({
          error: 'Type your username exactly to confirm deletion.',
          code: 'confirm_username_required',
          field: 'confirmUsername'
        });
      }
    }

    // Organizer ownership check
    if (req.user.role === 'organizer') {
      const activeEventsCount = db.prepare(`
        SELECT COUNT(*) as count FROM events 
        WHERE organizer_id = ? AND status NOT IN ('completed', 'cancelled')
      `).get(req.user.id).count;

      if (activeEventsCount > 0) {
        return res.status(409).json({ 
          error: 'You currently manage active volunteer opportunities. Transfer ownership or close these events before deleting your account.',
          code: 'has_active_events'
        });
      }
    }

    const now = new Date().toISOString();

    inTransaction(() => {
      // 1. Snapshot Certificates
      const certificates = db.prepare('SELECT * FROM certificates WHERE user_id = ?').all(req.user.id);
      for (const cert of certificates) {
        // Fetch current dynamic data
        const eventRow = db.prepare(`
          SELECT e.title, org.name AS organizer_name,
                 COALESCE(SUM(at.hours_awarded),0) AS hours, MAX(s.end_datetime) AS last_end
          FROM attendance at
          JOIN slots s ON at.slot_id = s.id
          JOIN events e ON at.event_id = e.id
          JOIN users org ON e.organizer_id = org.id
          WHERE at.user_id = ? AND at.event_id = ? AND at.present = 1
          GROUP BY at.user_id, e.id
        `).get(cert.user_id, cert.event_id);
        
        if (eventRow) {
          db.prepare(`
            UPDATE certificates 
            SET volunteer_name_snapshot = ?, event_name_snapshot = ?, 
                organization_snapshot = ?, hours_snapshot = ?, completed_at_snapshot = ?
            WHERE user_id = ? AND event_id = ?
          `).run(
            userRow.name, 
            eventRow.title, 
            eventRow.organizer_name, 
            Number(eventRow.hours), 
            eventRow.last_end, 
            cert.user_id, 
            cert.event_id
          );
        }
      }

      // 2. Delete preferences
      db.prepare('DELETE FROM notification_preferences WHERE user_id = ?').run(req.user.id);
      db.prepare('DELETE FROM user_favorites WHERE user_id = ?').run(req.user.id);
      db.prepare('DELETE FROM notifications WHERE user_id = ?').run(req.user.id);
      db.prepare('DELETE FROM oauth_accounts WHERE user_id = ?').run(req.user.id);
      // Live credentials for an account that no longer exists. A reset link
      // already in someone's inbox must not outlive the account it belongs to.
      db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run(req.user.id);
      db.prepare('DELETE FROM email_verification_tokens WHERE user_id = ?').run(req.user.id);

      // 3. Update User Table (Anonymise and Soft Delete)
      const deletedEmail = `deleted_${req.user.id}@system.local`;
      const deletedUsername = `deleted_${req.user.id}`;
      
      const nameParts = userRow.name.trim().split(/\s+/);
      const anonymizedName = nameParts.length > 1 
        ? `${nameParts[0]} ${nameParts[nameParts.length - 1].charAt(0)}.`
        : `${nameParts[0]}`;

      db.prepare(`
        UPDATE users 
        SET name = ?, email = ?, username = ?, avatar = NULL, bio = NULL, school = NULL, 
            account_status = 'deleted', deleted_at = ?, token_version = token_version + 1
        WHERE id = ?
      `).run(anonymizedName, deletedEmail, deletedUsername, now, req.user.id);

      // 4. Audit Log
      db.prepare(`
        INSERT INTO admin_audit_logs (id, admin_id, action, target_user_id, details, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(`audit-${Date.now()}`, req.user.id, 'ACCOUNT_DELETED', req.user.id, 'User self-deleted their account', now);
    });

    res.clearCookie(COOKIE_NAME, clearCookieOptions());
    res.json({ success: true });
  } catch (err) {
    console.error('Account deletion error:', err);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});



/**
 * Step 1 of password reset: issue a single-use, expiring token and mail it.
 *
 * The response is identical whether or not the address is registered — a
 * differing response here is an account-enumeration oracle, and this endpoint
 * is unauthenticated.
 */
router.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  const SAME_ANSWER = {
    success: true,
    message: 'If that address has an account, a reset link is on its way.'
  };

  if (!email) return res.status(400).json({ error: 'Email is required' });

  try {
    // COLLATE NOCASE: someone typing Leo.Chen@… who registered leo.chen@…
    // should still get their mail, not silence.
    const user = db.prepare(
      "SELECT id, email FROM users WHERE email = ? COLLATE NOCASE AND account_status = 'active'"
    ).get(String(email).trim());

    if (user) {
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

      // One live token per user: issuing a new link invalidates the old one.
      db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run(user.id);
      db.prepare('INSERT INTO password_reset_tokens (token, user_id, expires_at) VALUES (?, ?, ?)')
        .run(token, user.id, expiresAt);

      await sendPasswordResetEmail(user.email, token);
    }

    res.json(SAME_ANSWER);
  } catch (err) {
    console.error('Forgot password error:', err);
    res.json(SAME_ANSWER);
  }
});

/** Step 2: exchange the token for a new password. Single use. */
router.post('/api/auth/reset-password', (req, res) => {
  const { token, password } = req.body;

  if (!token || !password) {
    return res.status(400).json({ error: 'Token and password are required' });
  }

  /**
   * The same rules as signup.
   *
   * This used to check only `length >= 8`, so the reset flow was a way to
   * downgrade any account to a password the signup form would have refused —
   * "aaaaaaaa" was rejected at the front door and accepted at the side one.
   */
  const passwordCheck = validatePassword(password);
  if (!passwordCheck.ok) {
    return res.status(400).json({ error: passwordCheck.error, field: 'password' });
  }

  try {
    const row = db.prepare('SELECT * FROM password_reset_tokens WHERE token = ?').get(token);
    if (!row) {
      return res.status(400).json({ error: 'That reset link is not valid. Request a new one.' });
    }

    if (new Date(row.expires_at) < new Date()) {
      db.prepare('DELETE FROM password_reset_tokens WHERE token = ?').run(token);
      return res.status(400).json({ error: 'That reset link has expired. Request a new one.' });
    }

    const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
    if (!userRow || userRow.account_status === 'deleted') {
      db.prepare('DELETE FROM password_reset_tokens WHERE token = ?').run(token);
      return res.status(400).json({ error: 'That reset link is not valid. Request a new one.' });
    }

    const passwordHash = bcrypt.hashSync(password, bcrypt.genSaltSync(10));

    inTransaction(() => {
      /**
       * Bumping token_version signs every existing session out.
       *
       * That is the point of a reset: if the reason for it is that someone
       * else had the old password, leaving their 7-day cookie live would make
       * the reset cosmetic.
       */
      db.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?')
        .run(passwordHash, row.user_id);
      db.prepare('DELETE FROM password_reset_tokens WHERE token = ?').run(token);
      // Any other outstanding reset link for this account is now moot, and
      // leaving it live is a second key to a lock that was just changed.
      db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run(row.user_id);
    });

    /**
     * Reaching a mailbox proves control of the address, which is exactly what
     * the confirmation link asks for. An account that resets its password from
     * an unconfirmed address is therefore confirmed by the same act — without
     * this, a user who mistyped nothing but never clicked the welcome link
     * would land back on the "check your email" wall right after recovering.
     */
    if (userRow.email_verified !== 1) {
      db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(row.user_id);
    }

    clearLoginFailures(userRow.email);
    if (userRow.username) clearLoginFailures(userRow.username);

    res.json({ success: true });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Could not reset the password' });
  }
});

/**
 * Change the password from inside Settings, proving the current one.
 *
 * The Settings screen had a "Change Password" button whose entire
 * implementation was `addToast('Password change email sent.', 'info')`. It
 * sent nothing and changed nothing; it just claimed both. There was no
 * endpoint behind it at all.
 */
router.post('/api/auth/change-password', authenticateToken, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!newPassword) {
    return res.status(400).json({ error: 'Choose a new password.', field: 'newPassword' });
  }

  const passwordCheck = validatePassword(newPassword);
  if (!passwordCheck.ok) {
    return res.status(400).json({ error: passwordCheck.error, field: 'newPassword' });
  }

  try {
    const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!userRow) return res.status(404).json({ error: 'User not found' });

    const isOauthOnly = userRow.password_hash === OAUTH_ONLY;

    // Someone who has only ever signed in through a provider is adding a first
    // password, not replacing one — there is nothing for them to prove here
    // beyond the session they already hold.
    if (!isOauthOnly) {
      if (!currentPassword) {
        return res.status(400).json({ error: 'Enter your current password.', field: 'currentPassword' });
      }
      if (!bcrypt.compareSync(currentPassword, userRow.password_hash)) {
        return res.status(401).json({ error: 'That is not your current password.', field: 'currentPassword' });
      }
      if (bcrypt.compareSync(newPassword, userRow.password_hash)) {
        return res.status(400).json({ error: 'That is already your password. Choose a different one.', field: 'newPassword' });
      }
    }

    const passwordHash = bcrypt.hashSync(newPassword, bcrypt.genSaltSync(10));

    inTransaction(() => {
      db.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?')
        .run(passwordHash, req.user.id);
      db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run(req.user.id);
    });

    // token_version just invalidated every session including this one. Reissue
    // for the caller so changing a password does not eject the person doing it,
    // while every other device is signed out — which is the point.
    const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    issueSession(res, formatUserResponse(fresh), fresh.token_version);

    res.json({ success: true, addedPassword: isOauthOnly });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ error: 'Could not change your password.' });
  }
});

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

/** Confirms an address from the link in the welcome email. Single use. */
router.post('/api/auth/verify-email', (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token is required' });

  try {
    const row = db.prepare('SELECT * FROM email_verification_tokens WHERE token = ?').get(token);
    if (!row) {
      return res.status(400).json({ error: 'That confirmation link is not valid. Request a new one.' });
    }
    if (new Date(row.expires_at) < new Date()) {
      db.prepare('DELETE FROM email_verification_tokens WHERE token = ?').run(token);
      return res.status(400).json({ error: 'That confirmation link has expired. Request a new one.' });
    }

    const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
    if (!userRow || userRow.account_status !== 'active') {
      db.prepare('DELETE FROM email_verification_tokens WHERE token = ?').run(token);
      return res.status(400).json({ error: 'That confirmation link is not valid. Request a new one.' });
    }

    inTransaction(() => {
      db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(row.user_id);
      db.prepare('DELETE FROM email_verification_tokens WHERE token = ?').run(token);
    });

    const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
    const user = formatUserResponse(fresh);

    /**
     * Confirming signs you in, which is what makes the link from the welcome
     * email work on a phone that has never seen this site. The token is
     * single-use and 24-hour, and the act of opening it proves control of the
     * mailbox — the same proof "forgot password" relies on.
     */
    issueSession(res, user, fresh.token_version);
    purgeExpiredVerificationTokens();

    res.json({ success: true, user, emailVerified: true });
  } catch (err) {
    console.error('Verify email error:', err);
    res.status(500).json({ error: 'Could not confirm that address' });
  }
});

/** Sends a fresh confirmation link to the signed-in user's own address. */
router.post('/api/auth/resend-verification', authenticateToken, async (req, res) => {
  try {
    const user = db.prepare('SELECT id, email, email_verified FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.email_verified === 1) {
      return res.json({ success: true, message: 'That address is already confirmed.' });
    }

    const token = issueVerificationToken(user.id);
    await sendVerificationEmail(user.email, token);

    res.json({ success: true, email: user.email });
  } catch (err) {
    console.error('Resend verification error:', err);
    res.status(500).json({ error: 'Could not send verification email' });
  }
});

/**
 * Availability check behind the live tick on the signup form.
 *
 * `valid` and `available` are separate answers. Previously a malformed address
 * and a taken one both came back as `{ available: false }`, and so did a
 * server error — so the signup button stayed disabled with "Enter a valid,
 * unused email" whatever had actually gone wrong, including when nothing was
 * wrong with the address at all.
 */
router.get('/api/auth/check-email', (req, res) => {
  const check = validateEmail(req.query.email);
  if (!check.ok) {
    return res.json({ available: false, valid: false, error: check.error });
  }
  try {
    const row = db.prepare('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE').get(check.value);
    res.json({ available: !row, valid: true });
  } catch (err) {
    console.error('check-email error:', err);
    // Distinguishable from "taken" so the client can let the user proceed and
    // let the signup POST be the authority, rather than dead-ending the form.
    res.status(503).json({ error: 'Could not check that address right now.', code: 'check_unavailable' });
  }
});

if (DEMO_MODE) {
  router.post('/api/auth/reset', (req, res) => {
    try {
      console.log('Resetting database tables to seeds...');
      // Drop children before parents; includes V2 tables so re-seeding never
      // collides with stale rows (seed ids are fixed strings). auto_select_runs
      // is in the list because its rows reference those fixed event ids — left
      // behind, a stale confirmed run attaches itself to a freshly seeded event
      // and blocks Auto Select from running on it.
      db.exec('DROP TABLE IF EXISTS hours_ledger');
      db.exec('DROP TABLE IF EXISTS attendance_checkin');
      db.exec('DROP TABLE IF EXISTS auto_select_runs');
      db.exec('DROP TABLE IF EXISTS event_announcements');
      db.exec('DROP TABLE IF EXISTS user_favorites');
      db.exec('DROP TABLE IF EXISTS event_comments');
      db.exec('DROP TABLE IF EXISTS notifications');
      db.exec('DROP TABLE IF EXISTS attendance');
      db.exec('DROP TABLE IF EXISTS applications');
      db.exec('DROP TABLE IF EXISTS slots');
      db.exec('DROP TABLE IF EXISTS events');
      db.exec('DROP TABLE IF EXISTS users');

      initDatabase();
      res.json({ success: true });
    } catch (error) {
      console.error('Reset database error:', error);
      res.status(500).json({ error: 'Internal server error resetting database' });
    }
  });
} else {
  console.log('[Security] DEMO_MODE is off — the database reset endpoint is not registered.');
}

// ────────────────────────────────────────────────────────────────────
// V2 ENHANCED FEATURES — Notifications, Comments, Favorites, etc.
// ────────────────────────────────────────────────────────────────────

// 15. List my notifications

router.get('/api/users/:id/profile', authenticateToken, (req, res) => {
  try {
    const row = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'student'").get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Volunteer not found' });

    const isSelf = req.params.id === req.user.id;

    // Organizers only see contact/PII fields for students who have applied
    // to an event they host — not for every student on the platform.
    const hostsApplicant = req.user.role === 'organizer' && !!db.prepare(`
      SELECT 1 FROM applications a
      JOIN events e ON a.event_id = e.id
      WHERE a.user_id = ? AND e.organizer_id = ?
      LIMIT 1
    `).get(req.params.id, req.user.id);
    const canSeeContact = isSelf || req.user.role === 'admin' || hostsApplicant;

    const totals = db.prepare(`
      SELECT COALESCE(SUM(hours_awarded), 0) as hours,
             COUNT(DISTINCT event_id) as events,
             COUNT(*) as shifts
      FROM attendance WHERE user_id = ? AND present = 1
    `).get(req.params.id);

    // Completed service, newest first
    const completed = db.prepare(`
      SELECT e.id as event_id, e.title, e.category, e.location, u.name as organizer_name,
             s.name as slot_name, s.start_datetime, s.end_datetime, at.hours_awarded
      FROM attendance at
      JOIN slots s ON at.slot_id = s.id
      JOIN events e ON at.event_id = e.id
      JOIN users u ON e.organizer_id = u.id
      WHERE at.user_id = ? AND at.present = 1
      ORDER BY s.start_datetime DESC
    `).all(req.params.id);

    // Upcoming confirmed shifts
    const upcoming = db.prepare(`
      SELECT e.id as event_id, e.title, e.category, e.location, s.name as slot_name,
             s.start_datetime, s.end_datetime
      FROM applications a
      JOIN slots s ON a.slot_id = s.id
      JOIN events e ON a.event_id = e.id
      WHERE a.user_id = ? AND a.status = 'accepted'
        AND s.start_datetime > datetime('now') AND e.status != 'cancelled'
      ORDER BY s.start_datetime ASC
    `).all(req.params.id);

    const pendingCount = db.prepare(`
      SELECT COUNT(*) as c FROM applications
      WHERE user_id = ? AND status IN ('pending', 'waitlisted')
    `).get(req.params.id).c;

    // Hours by category — what kind of volunteer someone is
    const byCategory = db.prepare(`
      SELECT e.category, COALESCE(SUM(at.hours_awarded), 0) as hours
      FROM attendance at
      JOIN events e ON at.event_id = e.id
      WHERE at.user_id = ? AND at.present = 1
      GROUP BY e.category ORDER BY hours DESC
    `).all(req.params.id);

    res.json({
      volunteer: {
        id: row.id,
        name: row.name,
        avatar: row.avatar,
        grade: canSeeContact ? row.grade : null,
        bio: canSeeContact ? row.bio : null,
        school: canSeeContact ? row.school : null,
        skills: row.skills ? JSON.parse(row.skills) : [],
        joinedAt: row.created_at,
        // Contact details stay with the person and the adults coordinating them
        email: canSeeContact ? row.email : null
      },
      stats: {
        hours: Number(totals.hours) || 0,
        eventsCompleted: totals.events || 0,
        shiftsCompleted: totals.shifts || 0,
        // The count alone carries no whereabouts, so staff who legitimately
        // see contact info may see it too — the array itself (event location,
        // exact times) is self-only, below.
        upcomingCount: isSelf || canSeeContact ? upcoming.length : 0,
        pendingCount
      },
      milestones: buildMilestones(Number(totals.hours) || 0, totals.events || 0),
      byCategory: byCategory.map(c => ({ category: c.category, hours: Number(c.hours) })),
      completed: completed.map(formatServiceRow),
      // A confirmed future shift discloses a minor's physical whereabouts at a
      // known time — visible to the student themselves only, never to other
      // students, organizers, or admins.
      upcoming: isSelf ? upcoming.map(u => ({
        eventId: u.event_id, title: u.title, category: u.category, location: u.location,
        slotName: u.slot_name, startDatetime: u.start_datetime, endDatetime: u.end_datetime
      })) : []
    });
  } catch (err) {
    console.error('Volunteer profile error:', err);
    res.status(500).json({ error: 'Failed to load profile' });
  }
});

function formatServiceRow(r) {
  return {
    eventId: r.event_id,
    title: r.title,
    category: r.category,
    location: r.location,
    organizerName: r.organizer_name,
    slotName: r.slot_name,
    startDatetime: r.start_datetime,
    endDatetime: r.end_datetime,
    hours: Number(r.hours_awarded)
  };
}

/**
 * Milestones mark real service already completed — they are never targets to
 * chase, and there are no points or streaks. Each one is either earned or not.
 */
const MILESTONE_TIERS = [
  { id: 'first-shift', label: 'First shift', hint: 'Completed your first volunteer shift', test: (h, e) => e >= 1 },
  { id: 'ten-hours', label: '10 hours', hint: 'Ten hours of service', test: (h) => h >= 10 },
  { id: 'five-events', label: '5 events', hint: 'Helped at five different events', test: (h, e) => e >= 5 },
  { id: 'silver', label: 'Silver Award', hint: '25 hours — the district Silver Award target', test: (h) => h >= 25 },
  { id: 'fifty-hours', label: '50 hours', hint: 'Fifty hours of service', test: (h) => h >= 50 },
  { id: 'ten-events', label: '10 events', hint: 'Helped at ten different events', test: (h, e) => e >= 10 },
  { id: 'century', label: '100 hours', hint: 'One hundred hours of service', test: (h) => h >= 100 }
];

function buildMilestones(hours, events) {
  return MILESTONE_TIERS.map(m => ({
    id: m.id,
    label: m.label,
    hint: m.hint,
    earned: m.test(hours, events)
  }));
}

// ── Certificates ────────────────────────────────────────────────────
// One certificate per completed event. The verification code is derived
// from the record itself, so the same service always produces the same code
// and a school office can check a printed copy against the platform.

router.get('/api/organizers/:id/profile', authenticateToken, (req, res) => {
  try {
    const row = db.prepare("SELECT * FROM users WHERE id = ? AND role IN ('organizer','admin')").get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Organizer not found' });

    const totals = db.prepare(`
      SELECT COUNT(DISTINCT e.id) as events_hosted,
             COUNT(DISTINCT a.user_id) as volunteers_helped
      FROM events e
      LEFT JOIN applications a ON a.event_id = e.id AND a.status = 'accepted'
      WHERE e.organizer_id = ?
    `).get(req.params.id);

    const hoursAwarded = db.prepare(`
      SELECT COALESCE(SUM(at.hours_awarded), 0) as h
      FROM attendance at
      JOIN events e ON at.event_id = e.id
      WHERE e.organizer_id = ? AND at.present = 1
    `).get(req.params.id).h;

    const events = db.prepare(`
      SELECT e.id, e.title, e.category, e.location, e.status, e.application_deadline,
             (SELECT MIN(s.start_datetime) FROM slots s WHERE s.event_id = e.id) as start_datetime,
             (SELECT COALESCE(SUM(s.max_spots), 0) FROM slots s WHERE s.event_id = e.id) as max_spots,
             (SELECT COUNT(*) FROM applications a WHERE a.event_id = e.id AND a.status = 'accepted') as accepted
      FROM events e WHERE e.organizer_id = ?
      ORDER BY start_datetime DESC
    `).all(req.params.id);

    const now = new Date().toISOString();
    const shape = (e) => ({
      id: e.id, title: e.title, category: e.category, location: e.location,
      status: e.status, startDatetime: e.start_datetime,
      applicationDeadline: e.application_deadline,
      maxSpots: Number(e.max_spots), accepted: e.accepted
    });

    res.json({
      organizer: {
        id: row.id,
        name: row.name,
        avatar: row.avatar,
        bio: row.bio,
        organization: row.school,
        verified: row.verified === 1,
        joinedAt: row.created_at,
        email: row.email
      },
      stats: {
        eventsHosted: totals.events_hosted || 0,
        volunteersHelped: totals.volunteers_helped || 0,
        hoursAwarded: Number(hoursAwarded) || 0
      },
      upcoming: events.filter(e => e.start_datetime && e.start_datetime > now && e.status !== 'cancelled').reverse().map(shape),
      past: events.filter(e => !e.start_datetime || e.start_datetime <= now || e.status === 'cancelled').map(shape)
    });
  } catch (err) {
    console.error('Organizer profile error:', err);
    res.status(500).json({ error: 'Failed to load organizer profile' });
  }
});

// 18. Favorites toggle and list

router.patch('/api/auth/profile', authenticateToken, (req, res) => {
  try {
    const { name, avatar, bio, school, skills, grade, leaderboardOptIn, emailOptOut } = req.body;
    const updates = [];
    const values = [];

    if (name !== undefined) { updates.push('name = ?'); values.push(name.trim()); }
    if (avatar !== undefined) { updates.push('avatar = ?'); values.push(avatar); }
    if (bio !== undefined) { updates.push('bio = ?'); values.push(bio); }
    if (school !== undefined) { updates.push('school = ?'); values.push(school); }
    if (grade !== undefined) {
      if (!VALID_GRADES.includes(grade)) {
        return res.status(400).json({ error: `Grade must be one of: ${VALID_GRADES.join(', ')}` });
      }
      updates.push('grade = ?'); values.push(grade);
    }
    if (skills !== undefined) { updates.push('skills = ?'); values.push(JSON.stringify(skills || [])); }
    if (leaderboardOptIn !== undefined) { updates.push('leaderboard_opt_in = ?'); values.push(leaderboardOptIn ? 1 : 0); }
    if (emailOptOut !== undefined) { updates.push('email_opt_out = ?'); values.push(emailOptOut ? 1 : 0); }

    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
    values.push(req.user.id);
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    res.json({ user: formatUserResponse(row) });
  } catch (err) {
    console.error('Profile update error:', err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// 20. Statistics endpoint for a volunteer

router.get('/api/user/preferences', authenticateToken, (req, res) => {
  try {
    const prefs = db.prepare('SELECT category, channel, enabled FROM notification_preferences WHERE user_id = ?').all(req.user.id);
    const userRow = db.prepare('SELECT email_opt_out FROM users WHERE id = ?').get(req.user.id);

    res.json({
      globalEmailOptOut: userRow ? userRow.email_opt_out === 1 : false,
      preferences: prefs
    });
  } catch (error) {
    console.error('Fetch preferences error:', error);
    res.status(500).json({ error: 'Failed to fetch preferences' });
  }
});

router.post('/api/user/preferences', authenticateToken, (req, res) => {
  try {
    const { category, channel, enabled } = req.body;
    
    if (category === 'global' && channel === 'email') {
      db.prepare('UPDATE users SET email_opt_out = ? WHERE id = ?').run(enabled ? 0 : 1, req.user.id);
      return res.json({ success: true });
    }

    db.prepare(`
      INSERT INTO notification_preferences (user_id, category, channel, enabled)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, category, channel) DO UPDATE SET enabled = excluded.enabled
    `).run(req.user.id, category, channel, enabled ? 1 : 0);

    res.json({ success: true });
  } catch (error) {
    console.error('Update preference error:', error);
    res.status(500).json({ error: 'Failed to update preferences' });
  }
});

export default router;
