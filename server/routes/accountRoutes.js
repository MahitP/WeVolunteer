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
import { VALID_GRADES, JWT_SECRET, COOKIE_NAME, cookieOptions, clearCookieOptions } from '../config.js';

import { authenticateToken, formatUserResponse, inTransaction } from '../utils.js';
import { db } from '../db.js';
import { validateAccountFields, validatePassword, validateUsername, validateEmail, validateProfilePatch } from '../accountValidation.js';
import { issueVerificationToken, sendVerificationMail, purgeExpiredVerificationTokens } from '../services/verification.js';
import { OAUTH_ONLY, issueSession, clearLoginFailuresForUser } from './authRoutes.js';

const router = express.Router();

router.delete('/api/auth/account', authenticateToken, async (req, res) => {
  const { password, confirmUsername } = req.body;
  try {
    const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!userRow) return res.status(404).json({ error: 'User not found' });

    if (userRow.password_hash !== OAUTH_ONLY) {
      if (!password) {
        return res.status(400).json({ error: 'Password is required to delete your account' });
      }
      if (!await bcrypt.compare(password, userRow.password_hash)) {
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

      /**
       * 1b. Release every commitment the account still holds.
       *
       * Deletion previously touched only the user row and its preferences, so a
       * deleted volunteer stayed `accepted` on tomorrow's shift: they occupied a
       * spot nobody could fill, they still counted towards the slot's capacity,
       * and an anonymised name sat on the organizer's roster for an event being
       * staffed that week. Withdrawing is the same state a person reaches by
       * pulling out themselves, so nothing downstream has to learn a new one.
       *
       * `attendance` is deliberately untouched — that is the verified service
       * record, and the delete dialog promises the user it is preserved.
       */
      const releasedEvents = db.prepare(`
        SELECT DISTINCT a.event_id, e.organizer_id, e.title
        FROM applications a
        JOIN events e ON a.event_id = e.id
        JOIN slots s ON a.slot_id = s.id
        WHERE a.user_id = ?
          AND a.status IN ('pending', 'waitlisted', 'accepted')
          AND s.start_datetime > ?
          AND e.status NOT IN ('completed', 'cancelled')
      `).all(req.user.id, new Date().toISOString());

      db.prepare(`
        UPDATE applications SET status = 'withdrawn', waitlist_order = NULL
        WHERE user_id = ? AND status IN ('pending', 'waitlisted', 'accepted')
      `).run(req.user.id);

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
      //
      // randomUUID, not Date.now(): two deletions in the same millisecond
      // collided on this PRIMARY KEY, which rolled the transaction back and
      // failed the whole deletion with a 500 for both people.
      db.prepare(`
        INSERT INTO admin_audit_logs (id, admin_id, action, target_user_id, details, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(`audit-${crypto.randomUUID()}`, req.user.id, 'ACCOUNT_DELETED', req.user.id, 'User self-deleted their account', now);

      /**
       * 5. Tell the organizers who were counting on this person.
       *
       * Inside the transaction so a rollback cannot leave organizers notified
       * about a deletion that did not happen. Notifying is what makes the
       * withdrawal above actionable — a spot silently freeing up on an event
       * three days out is not much better than a spot silently held.
       */
      for (const ev of releasedEvents) {
        db.prepare(`
          INSERT INTO notifications (id, user_id, kind, title, body, link, read, created_at)
          VALUES (?, ?, 'info', ?, ?, ?, 0, ?)
        `).run(
          `notif-${crypto.randomUUID()}`,
          ev.organizer_id,
          'A volunteer left an upcoming event',
          `Someone deleted their account and has been withdrawn from "${ev.title}". `
            + `Check the roster — a spot may now be open.`,
          `event:${ev.event_id}`,
          now
        );
      }
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
  // Deliberately vague about *where* it was sent as well as about whether it
  // was: a username lookup must not disclose the address behind it.
  const SAME_ANSWER = {
    success: true,
    message: 'If that matches an account, a reset link is on its way to its email address.'
  };

  if (!email) return res.status(400).json({ error: 'Enter your email address or username.' });

  try {
    /**
     * Matches an email address OR a username.
     *
     * The sign-in field above it accepts either, and the "Forgot?" link carries
     * whatever was typed there straight into this form. So a student who signs
     * in with their username — which the product actively encourages — typed it
     * here, was told "a reset link is on its way", and no mail was ever sent.
     * A recovery flow that silently does nothing is worse than one that is
     * missing, because the person stops looking for another way in.
     *
     * The response is identical either way, so this widens no enumeration
     * surface. COLLATE NOCASE on both: someone typing Leo.Chen@… who registered
     * leo.chen@… should get their mail, not silence.
     */
    const identifier = String(email).trim();
    const user = db.prepare(`
      SELECT id, email FROM users
      WHERE (email = ? COLLATE NOCASE OR username = ? COLLATE NOCASE)
        AND account_status = 'active'
    `).get(identifier, identifier);

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
router.post('/api/auth/reset-password', async (req, res) => {
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

    const passwordHash = await bcrypt.hash(password, 10);

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

    // Someone who has just proved control of their mailbox and chosen a new
    // password should not then meet a lockout earned by whoever was guessing.
    // One call now covers both identifiers, because the bucket is per account.
    clearLoginFailuresForUser(row.user_id);

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
router.post('/api/auth/change-password', authenticateToken, async (req, res) => {
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
      if (!await bcrypt.compare(currentPassword, userRow.password_hash)) {
        return res.status(401).json({ error: 'That is not your current password.', field: 'currentPassword' });
      }
      if (await bcrypt.compare(newPassword, userRow.password_hash)) {
        return res.status(400).json({ error: 'That is already your password. Choose a different one.', field: 'newPassword' });
      }
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);

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

/** How long a pending email-address change stays open. */
const EMAIL_CHANGE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Step 1 of changing the account's email address.
 *
 * Why this exists at all: there was no way to change an address, and the
 * verification wall told anyone who mistyped theirs to "sign out and create your
 * account again with the right address". That advice does not work — the
 * abandoned account keeps both the mistyped email and the username, so the
 * second attempt can reuse neither, and the person is left with a permanently
 * unusable account holding an address they cannot read.
 *
 * The new address is only written to `users` once it has been proven reachable
 * (step 2). Until then the account keeps the address it has, so a typo here is
 * recoverable by simply asking again.
 */
router.post('/api/auth/change-email', authenticateToken, async (req, res) => {
  const { newEmail, password } = req.body;

  const check = validateEmail(newEmail);
  if (!check.ok) {
    return res.status(400).json({ error: check.error, field: 'newEmail' });
  }
  const target = check.value;

  try {
    const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!userRow) return res.status(404).json({ error: 'User not found' });

    if (target === String(userRow.email).toLowerCase()) {
      return res.status(400).json({
        error: 'That is already your email address.',
        field: 'newEmail'
      });
    }

    // Deliberately the same answer whether the address is on an active account
    // or a deletion tombstone: both mean "not available", and distinguishing
    // them would tell the caller something about somebody else.
    if (db.prepare('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE AND id != ?').get(target, req.user.id)) {
      return res.status(409).json({
        error: 'Another account already uses that email address.',
        field: 'newEmail'
      });
    }

    /**
     * A password account re-proves the password; a provider-only account cannot,
     * so its live session is the proof — the same rule change-password already
     * applies, for the same reason.
     */
    if (userRow.password_hash !== OAUTH_ONLY) {
      if (!password) {
        return res.status(400).json({ error: 'Enter your password to change your email address.', field: 'password' });
      }
      if (!await bcrypt.compare(password, userRow.password_hash)) {
        return res.status(401).json({ error: 'That is not your password.', field: 'password' });
      }
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + EMAIL_CHANGE_TTL_MS).toISOString();

    // One live request per user: asking again supersedes the previous link
    // rather than leaving two addresses able to claim the account.
    db.prepare('DELETE FROM email_change_tokens WHERE user_id = ?').run(req.user.id);
    db.prepare('INSERT INTO email_change_tokens (token, user_id, new_email, expires_at) VALUES (?, ?, ?, ?)')
      .run(token, req.user.id, target, expiresAt);

    await sendEmailChangeConfirmation(target, token);

    /**
     * Tell the OLD address too, and do not fail the request if that mail
     * bounces. If a stolen session moves an account to an attacker's address,
     * the only person who can notice is whoever still reads the old mailbox.
     */
    sendEmailChangeNotice(userRow.email, target).catch(err =>
      console.error('Email-change notice failed to send:', err)
    );

    res.json({ success: true, pending: target });
  } catch (err) {
    console.error('Change email error:', err);
    res.status(500).json({ error: 'Could not start that email change.' });
  }
});

/**
 * Step 2: confirm the new address from the link sent to it. Single use.
 *
 * Unauthenticated on purpose. The link may well be opened on a device that has
 * never signed in — a phone reading a school mailbox — and the token itself is
 * the proof of control, exactly as with the welcome link.
 */
router.post('/api/auth/confirm-email-change', (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token is required' });

  try {
    const row = db.prepare('SELECT * FROM email_change_tokens WHERE token = ?').get(token);
    if (!row) {
      return res.status(400).json({ error: 'That link is not valid. Request the change again from Settings.' });
    }
    if (new Date(row.expires_at) < new Date()) {
      db.prepare('DELETE FROM email_change_tokens WHERE token = ?').run(token);
      return res.status(400).json({ error: 'That link has expired. Request the change again from Settings.' });
    }

    const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
    if (!userRow || userRow.account_status !== 'active') {
      db.prepare('DELETE FROM email_change_tokens WHERE token = ?').run(token);
      return res.status(400).json({ error: 'That link is not valid. Request the change again from Settings.' });
    }

    // Re-check availability: the address was free when the request was made,
    // and someone else may have claimed it during the 24-hour window.
    if (db.prepare('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE AND id != ?').get(row.new_email, row.user_id)) {
      db.prepare('DELETE FROM email_change_tokens WHERE token = ?').run(token);
      return res.status(409).json({
        error: 'Another account claimed that email address while this request was open. Try a different one.'
      });
    }

    inTransaction(() => {
      /**
       * Bumping token_version signs every session out, including whichever one
       * asked for the change.
       *
       * That is the point. The email address is the account's recovery channel,
       * so changing it is exactly as security-relevant as changing the password
       * — and if the request came from a session that should not have had it,
       * leaving that session live would make the notice to the old address
       * useless.
       */
      db.prepare(
        'UPDATE users SET email = ?, email_verified = 1, token_version = token_version + 1 WHERE id = ?'
      ).run(row.new_email, row.user_id);

      db.prepare('DELETE FROM email_change_tokens WHERE user_id = ?').run(row.user_id);
      // Reset links already in flight were mailed to the OLD address and must
      // not stay usable now that the account answers somewhere else.
      db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run(row.user_id);
      db.prepare('DELETE FROM email_verification_tokens WHERE user_id = ?').run(row.user_id);
    });

    const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
    const user = formatUserResponse(fresh);

    // Opening the link proves control of the new mailbox, so the person holding
    // it gets a working session — otherwise confirming from a phone would leave
    // them signed out everywhere with no explanation.
    issueSession(res, user, fresh.token_version);
    clearLoginFailuresForUser(fresh.id);

    res.json({ success: true, user, emailVerified: true });
  } catch (err) {
    console.error('Confirm email change error:', err);
    res.status(500).json({ error: 'Could not confirm that address.' });
  }
});

/** Cancels a pending email-address change. */
router.post('/api/auth/cancel-email-change', authenticateToken, (req, res) => {
  try {
    const { changes } = db.prepare('DELETE FROM email_change_tokens WHERE user_id = ?').run(req.user.id);
    res.json({ success: true, cancelled: changes > 0 });
  } catch (err) {
    console.error('Cancel email change error:', err);
    res.status(500).json({ error: 'Could not cancel that request.' });
  }
});

/** Reports whether a change is waiting on confirmation, for the Settings card. */
router.get('/api/auth/pending-email-change', authenticateToken, (req, res) => {
  try {
    const row = db.prepare(
      'SELECT new_email, expires_at FROM email_change_tokens WHERE user_id = ? AND expires_at > ?'
    ).get(req.user.id, new Date().toISOString());
    res.json(row ? { pending: row.new_email, expiresAt: row.expires_at } : { pending: null });
  } catch (err) {
    console.error('Pending email change error:', err);
    res.status(500).json({ error: 'Could not check that.' });
  }
});

/**
 * Change the account's username.
 *
 * There was no way to do this at all, which mattered more than it sounds: the
 * username is half of the sign-in identity and the dedupe migration can rename
 * an account without being asked, so an account could end up wearing a handle
 * its owner never chose and could not change.
 */
const USERNAME_COOLDOWN_DAYS = 30;

router.post('/api/auth/change-username', authenticateToken, (req, res) => {
  const check = validateUsername(req.body.username);
  if (!check.ok) {
    return res.status(400).json({ error: check.error, field: 'username' });
  }
  const target = check.value;

  try {
    const userRow = db.prepare('SELECT username, username_changed_at FROM users WHERE id = ?').get(req.user.id);
    if (!userRow) return res.status(404).json({ error: 'User not found' });

    const current = String(userRow.username || '');
    if (target === current) {
      return res.status(400).json({ error: 'That is already your username.', field: 'username' });
    }

    /**
     * A change of capitalisation only is free and starts no cooldown.
     *
     * It cannot collide with anyone — the uniqueness index is case-insensitive —
     * so nobody else is affected, and someone fixing `alice` to `Alice` should
     * not be told to come back in a month. Refusing that would be pedantry.
     */
    const caseOnly = target.toLowerCase() === current.toLowerCase();

    if (!caseOnly && userRow.username_changed_at) {
      const nextAllowed = new Date(new Date(userRow.username_changed_at).getTime()
        + USERNAME_COOLDOWN_DAYS * 24 * 60 * 60 * 1000);
      if (nextAllowed > new Date()) {
        const days = Math.max(1, Math.ceil((nextAllowed - Date.now()) / (24 * 60 * 60 * 1000)));
        return res.status(429).json({
          error: `You can change your username again in ${days} day${days === 1 ? '' : 's'}.`,
          code: 'username_cooldown',
          field: 'username',
          retryAfterDays: days,
          nextAllowedAt: nextAllowed.toISOString()
        });
      }
    }

    if (!caseOnly && db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE AND id != ?').get(target, req.user.id)) {
      return res.status(409).json({ error: 'That username is already taken.', field: 'username' });
    }

    // No token_version bump: a username authenticates nothing, so changing it
    // is no reason to sign anyone out.
    db.prepare('UPDATE users SET username = ?, username_changed_at = ? WHERE id = ?')
      .run(target, caseOnly ? userRow.username_changed_at : new Date().toISOString(), req.user.id);

    const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    res.json({ success: true, user: formatUserResponse(fresh) });
  } catch (err) {
    console.error('Change username error:', err);
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'That username is already taken.', field: 'username' });
    }
    res.status(500).json({ error: 'Could not change your username.' });
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

// ────────────────────────────────────────────────────────────────────
// V2 ENHANCED FEATURES — Notifications, Comments, Favorites, etc.
// ────────────────────────────────────────────────────────────────────

// 15. List my notifications


export default router;
