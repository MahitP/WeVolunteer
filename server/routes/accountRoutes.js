import express from 'express';
import { runInTransaction } from '../db/connectionContext.js';
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

import { authenticateToken, selfUserResponse } from '../utils.js';
import { requireAAL2, ROLE, can } from '../authz.js';
import { ChallengeNotSpent, refuseReauth, spendChallenge } from '../reauthResponses.js';
import { recordAudit } from '../auditLog.js';
import { db } from '../db.js';
import {
  acceptOrganizerAgreement, organizerAgreementStatus
} from '../organizerAgreement.js';
import { ORGANIZER_DOCUMENTS, STUDENT_ORGANIZER_DOCUMENTS } from '../legalDocuments.js';
import {
  acceptStudentOrganizerAgreement, studentOrganizerAgreementStatus,
} from '../studentOrganizerAgreement.js';
import { helpsRunAnywhere } from '../organizationRoles.js';
import {
  validateAccountFields, validatePassword, validateUsername, validateEmail,
  validateProfilePatch, isCurrentPassword
} from '../accountValidation.js';
import { issueVerificationToken, sendVerificationMail, purgeExpiredVerificationTokens } from '../services/verification.js';
import { OAUTH_ONLY, issueSession, clearLoginFailuresForUser } from './authRoutes.js';
// The one safe way anything in this application deletes an uploaded file. It
// lives with the module that owns public/uploads/ and writes into it — read its
// header before calling it, and never hand-roll a second unlink beside it.
import { deleteUploadedFile } from './profilePictureRoutes.js';
import { hashToken, issueToken } from '../tokenDigest.js';

const router = express.Router();

/**
 * Deletes the caller's own account, behind a fresh proof of identity.
 *
 * ── What replaced what ──
 *
 * A password account proved its password inline here; a provider-only account,
 * having none, was asked to type its own username — and the code conceded the
 * point in the same breath: "Typing the account's own username is not a
 * credential." A username is public within the app and appears on every comment
 * the person has posted. Both are gone. `requireAAL2('account.delete')` now
 * demands a challenge satisfied by a password OR by provider re-consent, so the
 * provider-only account is proving something for the first time.
 *
 * A typed confirmation phrase remains the right thing in the UI — deletion is
 * irreversible and a deliberateness check is worth having — but it is no longer
 * a server-side credential, because it never was one.
 */
router.delete('/api/auth/account', authenticateToken, requireAAL2('account.delete'), async (req, res) => {
  try {
    const userRow = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!userRow) return res.status(404).json({ error: 'User not found' });

    if (can(req.principal, 'admin.create')) {
      return res.status(403).json({
        error: 'Super administrators cannot delete their own accounts. You must demote yourself to an ordinary administrator first.',
        code: 'super_admin_protected'
      });
    }

    // Active-events check: business logic about what deletion does, not an
    // authorization gate — "may this account be deleted while it still hosts
    // events" is a question about this row, not about a kind of actor. Only
    // an organizer's id can ever appear as `organizer_id`, so the query below
    // is already scoped by ownership and always finds zero rows for a
    // student, admin, super_admin, or partner deleting their own account;
    // the earlier check gating this on the account's role was a redundant
    // optimisation, not a second gate, and dropping it changes nothing
    // observable.
    const activeEventsCount = (await db.prepare(`
      SELECT COUNT(*) as count FROM events
      WHERE organizer_id = ? AND status NOT IN ('completed', 'cancelled')
    `).get(req.principal.userId)).count;

    if (activeEventsCount > 0) {
      return res.status(409).json({
        error: 'You currently manage active volunteer opportunities. Transfer ownership or close these events before deleting your account.',
        code: 'has_active_events'
      });
    }

    const now = new Date().toISOString();

    await runInTransaction(db, async (tx) => {
      /**
       * 0. Spend the grant, first, inside the same transaction as the deletion.
       *
       * `requireAAL2` above is an early refusal, not the check: it asks whether
       * the presented challenge is a live grant for this action, and answers
       * before any work is done. This is what makes the grant single-use, and it
       * is here rather than in the middleware so that a request refused later —
       * the active-events 409 above, or a rollback below — does not burn a
       * verification the user then has to repeat for something that never
       * happened. Being inside the transaction makes it atomic in both
       * directions: no deletion without a spent grant, no spent grant without a
       * deletion.
       */
      await spendChallenge(tx, req, 'account.delete', {});

      // 1. Snapshot Certificates
      const certificates = await tx.prepare('SELECT * FROM certificates WHERE user_id = ?').all(req.user.id);
      for (const cert of certificates) {
        // Fetch current dynamic data
        const eventRow = await tx.prepare(`
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
          await tx.prepare(`
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
      const releasedEvents = await tx.prepare(`
        SELECT DISTINCT a.event_id, e.organizer_id, e.title
        FROM applications a
        JOIN events e ON a.event_id = e.id
        JOIN slots s ON a.slot_id = s.id
        WHERE a.user_id = ?
          AND a.status IN ('pending', 'waitlisted', 'accepted')
          AND s.start_datetime > ?
          AND e.status NOT IN ('completed', 'cancelled')
      `).all(req.user.id, new Date().toISOString());

      await tx.prepare(`
        UPDATE applications SET status = 'withdrawn', waitlist_order = NULL
        WHERE user_id = ? AND status IN ('pending', 'waitlisted', 'accepted')
      `).run(req.user.id);

      // 2. Delete preferences
      await tx.prepare('DELETE FROM notification_preferences WHERE user_id = ?').run(req.user.id);
      await tx.prepare('DELETE FROM user_favorites WHERE user_id = ?').run(req.user.id);
      await tx.prepare('DELETE FROM notifications WHERE user_id = ?').run(req.user.id);
      await tx.prepare('DELETE FROM oauth_accounts WHERE user_id = ?').run(req.user.id);
      // Live credentials for an account that no longer exists. A reset link
      // already in someone's inbox must not outlive the account it belongs to.
      await tx.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run(req.user.id);
      await tx.prepare('DELETE FROM email_verification_tokens WHERE user_id = ?').run(req.user.id);

      // 3. Update User Table (Anonymise and Soft Delete)
      const deletedEmail = `deleted_${req.user.id}@system.local`;
      const deletedUsername = `deleted_${req.user.id}`;
      
      const nameParts = userRow.name.trim().split(/\s+/);
      const anonymizedName = nameParts.length > 1 
        ? `${nameParts[0]} ${nameParts[nameParts.length - 1].charAt(0)}.`
        : `${nameParts[0]}`;

      /**
       * `profile_picture_url` is nulled here with the rest of the profile, and
       * the FILE it named is unlinked after this transaction commits (below).
       *
       * It was omitted from this statement entirely: `avatar` (the emoji) and
       * `bio` and `school` were cleared, the photograph was not, and nothing
       * ever removed it from `public/uploads/`. So a deleted student's
       * photograph stayed on disk and stayed served, unauthenticated, at the
       * URL it had always had — one that had already been handed out to
       * everybody who had loaded their profile. The Data Deletion Policy tells
       * them in plain words that "we permanently delete: your profile picture,
       * bio, and school". Two of those three were true.
       *
       * `profile_picture_uploaded_at` goes with it: a timestamp for a picture
       * that no longer exists is a fact about a deleted account and nothing
       * else.
       */
      await tx.prepare(`
        UPDATE users
        SET name = ?, email = ?, username = ?, avatar = NULL, bio = NULL, school = NULL,
            profile_picture_url = NULL, profile_picture_uploaded_at = NULL,
            account_status = 'deleted', deleted_at = ?, token_version = token_version + 1
        WHERE id = ?
      `).run(anonymizedName, deletedEmail, deletedUsername, now, req.user.id);

      // 4. Audit Log
      //
      // The incident that produced the UUID id now lives in auditLog.js, which
      // generates it: two deletions in the same millisecond collided on this
      // PRIMARY KEY, rolled the transaction back, and failed the whole deletion
      // with a 500 for both people. No call site can reintroduce a Date.now()
      // id, because the id is not a parameter.
      //
      // admin_id is the account itself: this is a self-deletion, and the column
      // is NOT NULL with a foreign key, so there is no administrator to name.
      await recordAudit(tx, {
        adminId: req.user.id,
        action: 'ACCOUNT_DELETED',
        targetUserId: req.user.id,
        details: 'User self-deleted their account'
      });

      /**
       * 5. Tell the organizers who were counting on this person.
       *
       * Inside the transaction so a rollback cannot leave organizers notified
       * about a deletion that did not happen. Notifying is what makes the
       * withdrawal above actionable — a spot silently freeing up on an event
       * three days out is not much better than a spot silently held.
       */
      for (const ev of releasedEvents) {
        await tx.prepare(`
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

    /**
     * The photograph itself, after the commit.
     *
     * Deliberately outside the transaction: an unlink cannot be rolled back, so
     * doing it inside would mean a transaction that fails at any later step
     * leaves a live account whose picture has already been destroyed. Ordering
     * it here makes the only possible mismatch the harmless one — a committed
     * deletion with a file still on disk, if the process dies in between.
     *
     * `deleteUploadedFile` is the shared safe-unlink helper: it refuses any
     * stored path that resolves outside `public/uploads/`, and it never throws,
     * so an already-missing file (ENOENT) cannot turn a completed account
     * deletion into a 500.
     */
    deleteUploadedFile(userRow.profile_picture_url);

    res.clearCookie(COOKIE_NAME, clearCookieOptions());
    res.json({ success: true });
  } catch (err) {
    // A grant that could not be spent is never a server fault — it is stale,
    // replayed, or bound to something other than this request — and the
    // transaction has already rolled back, so nothing was deleted.
    if (err instanceof ChallengeNotSpent) return refuseReauth(res, err.result);
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
    const user = await db.prepare(`
      SELECT id, email FROM users
      WHERE (email = ? COLLATE nocase OR username = ? COLLATE nocase)
        AND account_status = 'active'
    `).get(identifier, identifier);

    if (user) {
      /* Only the digest is stored. A reset token IS the account until it is
         spent, so a readable copy of this table used to be a set of keys to
         every account with an outstanding reset. See migration 048. */
      const { token, tokenHash } = issueToken();
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

      // One live token per user: issuing a new link invalidates the old one.
      await db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run(user.id);
      await db.prepare('INSERT INTO password_reset_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
        .run(tokenHash, user.id, expiresAt);

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
    /* The link carries the plaintext; the table holds the digest. Hashing the
       incoming value is what turns one into the other. */
    const tokenHash = hashToken(token);
    const row = await db.prepare('SELECT * FROM password_reset_tokens WHERE token_hash = ?').get(tokenHash);
    if (!row) {
      return res.status(400).json({ error: 'That reset link is not valid. Request a new one.' });
    }

    if (new Date(row.expires_at) < new Date()) {
      await db.prepare('DELETE FROM password_reset_tokens WHERE token_hash = ?').run(tokenHash);
      return res.status(400).json({ error: 'That reset link has expired. Request a new one.' });
    }

    const userRow = await db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
    if (!userRow || userRow.account_status === 'deleted') {
      await db.prepare('DELETE FROM password_reset_tokens WHERE token_hash = ?').run(tokenHash);
      return res.status(400).json({ error: 'That reset link is not valid. Request a new one.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    await runInTransaction(db, async (tx) => {
      /**
       * Bumping token_version signs every existing session out.
       *
       * That is the point of a reset: if the reason for it is that someone
       * else had the old password, leaving their 7-day cookie live would make
       * the reset cosmetic.
       */
      await tx.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?')
        .run(passwordHash, row.user_id);
      await tx.prepare('DELETE FROM password_reset_tokens WHERE token_hash = ?').run(tokenHash);
      // Any other outstanding reset link for this account is now moot, and
      // leaving it live is a second key to a lock that was just changed.
      await tx.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run(row.user_id);
    });

    /**
     * Reaching a mailbox proves control of the address, which is exactly what
     * the confirmation link asks for. An account that resets its password from
     * an unconfirmed address is therefore confirmed by the same act — without
     * this, a user who mistyped nothing but never clicked the welcome link
     * would land back on the "check your email" wall right after recovering.
     */
    if (userRow.email_verified !== 1) {
      await db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(row.user_id);
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
 * Change the password from inside Settings, behind a fresh proof of identity.
 *
 * The Settings screen had a "Change Password" button whose entire
 * implementation was `addToast('Password change email sent.', 'info')`. It
 * sent nothing and changed nothing; it just claimed both. There was no
 * endpoint behind it at all.
 *
 * ── What `requireAAL2` changed here ──
 *
 * The `currentPassword` field is gone, and with it the branch that skipped the
 * check entirely for an account with no password to give. A provider-only
 * account can now set a FIRST password by re-consenting with its provider —
 * which it could not do before, because the only proof this endpoint accepted
 * was one it had no way to produce, and the workaround was to exempt it from
 * proving anything at all.
 *
 * The "choose a different password from the one you have" rule stays. It is
 * password policy, not authorization, and it is now asked of every account
 * including the one setting its first password (where it can never fire) — see
 * `isCurrentPassword` in accountValidation.js.
 */
router.post('/api/auth/change-password', authenticateToken, requireAAL2('password.change'), async (req, res) => {
  const { newPassword } = req.body ?? {};
  if (!newPassword) {
    return res.status(400).json({ error: 'Choose a new password.', field: 'newPassword' });
  }

  const passwordCheck = validatePassword(newPassword);
  if (!passwordCheck.ok) {
    return res.status(400).json({ error: passwordCheck.error, field: 'newPassword' });
  }

  try {
    const userRow = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!userRow) return res.status(404).json({ error: 'User not found' });

    // Reported back to the client so the UI can say "password added" rather than
    // "password changed"; the two are a different sentence to the person reading
    // them, and for a provider-only account this is a new capability, not an
    // edit.
    const isOauthOnly = userRow.password_hash === OAUTH_ONLY;

    if (await isCurrentPassword(newPassword, userRow.password_hash)) {
      return res.status(400).json({ error: 'That is already your password. Choose a different one.', field: 'newPassword' });
    }

    // Hashed BEFORE the transaction opens. `bcrypt.hash` is the one genuinely
    // async step in this handler, and an await inside a synchronous SQLite
    // transaction lets unrelated statements interleave with an open one — see
    // bcryptAsync.test.js, which fails the build on that shape.
    const passwordHash = await bcrypt.hash(newPassword, 10);

    await runInTransaction(db, async (tx) => {
      // The grant is spent with the write it authorises, not before it: a
      // rollback here must leave the user's verification unspent. See the
      // longer note on DELETE /api/auth/account above.
      await spendChallenge(tx, req, 'password.change', {});

      await tx.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?')
        .run(passwordHash, req.user.id);
      await tx.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run(req.user.id);
    });

    // token_version just invalidated every session including this one. Reissue
    // for the caller so changing a password does not eject the person doing it,
    // while every other device is signed out — which is the point.
    const fresh = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    await issueSession(res, await selfUserResponse(fresh), fresh.token_version);

    res.json({ success: true, addedPassword: isOauthOnly });
  } catch (err) {
    if (err instanceof ChallengeNotSpent) return refuseReauth(res, err.result);
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
 *
 * ── Two different problems, both still solved ──
 *
 * `requireAAL2('email.change')` asks "is the person doing this the account
 * holder"; the `email_change_tokens` link below asks "is the new address one
 * this person can read". Neither substitutes for the other, and the second is
 * deliberately untouched by the step-up work.
 *
 * The grant binds `newEmail`, so verifying in order to move the address to
 * a@x.com does not also authorise moving it to the attacker's — the binding most
 * step-up implementations forget, and the one somebody holding a stolen session
 * would actually reach for.
 */
router.post('/api/auth/change-email', authenticateToken, requireAAL2('email.change'), async (req, res) => {
  const { newEmail } = req.body ?? {};

  const check = validateEmail(newEmail);
  if (!check.ok) {
    return res.status(400).json({ error: check.error, field: 'newEmail' });
  }
  const target = check.value;

  try {
    const userRow = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
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
    if (await db.prepare('SELECT 1 FROM users WHERE email = ? COLLATE nocase AND id != ?').get(target, req.user.id)) {
      return res.status(409).json({
        error: 'Another account already uses that email address.',
        field: 'newEmail'
      });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + EMAIL_CHANGE_TTL_MS).toISOString();

    await runInTransaction(db, async (tx) => {
      /**
       * Bound to `newEmail` exactly as the request presented it, NOT to the
       * normalised `target`.
       *
       * The grant's hash was computed by `POST /api/auth/reauth/challenge` over
       * the params the client sent it, which is the raw string; deriving the
       * expectation here from a value this handler has since lower-cased would
       * refuse an honest client whose address contained a capital letter — a
       * `params_mismatch` on every attempt, sending the UI back to the
       * verification modal it has just come from, for ever. The client's
       * contract is therefore: send the same string to both endpoints. It costs
       * nothing in strength — normalisation only ever merges two raw values into
       * one target, so binding the raw value is if anything the tighter of the
       * two — and it removes the only way this binding can break by accident.
       */
      await spendChallenge(tx, req, 'email.change', { newEmail });

      // One live request per user: asking again supersedes the previous link
      // rather than leaving two addresses able to claim the account. Inside the
      // transaction with the insert that replaces it, so a rollback cannot
      // discard the pending change the user already had.
      await tx.prepare('DELETE FROM email_change_tokens WHERE user_id = ?').run(req.user.id);
      /* Digest only. This link can move an account's only recovery channel to a
         new address, so a readable copy of it is an account-takeover primitive.
         See migration 048. */
      await tx.prepare('INSERT INTO email_change_tokens (token_hash, user_id, new_email, expires_at) VALUES (?, ?, ?, ?)')
        .run(hashToken(token), req.user.id, target, expiresAt);
    });

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
    if (err instanceof ChallengeNotSpent) return refuseReauth(res, err.result);
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
router.post('/api/auth/confirm-email-change', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token is required' });

  try {
    const tokenHash = hashToken(token);
    const row = await db.prepare('SELECT * FROM email_change_tokens WHERE token_hash = ?').get(tokenHash);
    if (!row) {
      return res.status(400).json({ error: 'That link is not valid. Request the change again from Settings.' });
    }
    if (new Date(row.expires_at) < new Date()) {
      await db.prepare('DELETE FROM email_change_tokens WHERE token_hash = ?').run(tokenHash);
      return res.status(400).json({ error: 'That link has expired. Request the change again from Settings.' });
    }

    const userRow = await db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
    if (!userRow || userRow.account_status !== 'active') {
      await db.prepare('DELETE FROM email_change_tokens WHERE token_hash = ?').run(tokenHash);
      return res.status(400).json({ error: 'That link is not valid. Request the change again from Settings.' });
    }

    // Re-check availability: the address was free when the request was made,
    // and someone else may have claimed it during the 24-hour window.
    if (await db.prepare('SELECT 1 FROM users WHERE email = ? COLLATE nocase AND id != ?').get(row.new_email, row.user_id)) {
      await db.prepare('DELETE FROM email_change_tokens WHERE token_hash = ?').run(tokenHash);
      return res.status(409).json({
        error: 'Another account claimed that email address while this request was open. Try a different one.'
      });
    }

    await runInTransaction(db, async (tx) => {
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
      await tx.prepare(
        'UPDATE users SET email = ?, email_verified = 1, token_version = token_version + 1 WHERE id = ?'
      ).run(row.new_email, row.user_id);

      await tx.prepare('DELETE FROM email_change_tokens WHERE user_id = ?').run(row.user_id);
      // Reset links already in flight were mailed to the OLD address and must
      // not stay usable now that the account answers somewhere else.
      await tx.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run(row.user_id);
      await tx.prepare('DELETE FROM email_verification_tokens WHERE user_id = ?').run(row.user_id);
    });

    const fresh = await db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
    const user = await selfUserResponse(fresh);

    // Opening the link proves control of the new mailbox, so the person holding
    // it gets a working session — otherwise confirming from a phone would leave
    // them signed out everywhere with no explanation.
    await issueSession(res, user, fresh.token_version);
    clearLoginFailuresForUser(fresh.id);

    res.json({ success: true, user, emailVerified: true });
  } catch (err) {
    console.error('Confirm email change error:', err);
    res.status(500).json({ error: 'Could not confirm that address.' });
  }
});

/** Cancels a pending email-address change. */
router.post('/api/auth/cancel-email-change', authenticateToken, async (req, res) => {
  try {
    const { changes } = await db.prepare('DELETE FROM email_change_tokens WHERE user_id = ?').run(req.user.id);
    res.json({ success: true, cancelled: changes > 0 });
  } catch (err) {
    console.error('Cancel email change error:', err);
    res.status(500).json({ error: 'Could not cancel that request.' });
  }
});

/** Reports whether a change is waiting on confirmation, for the Settings card. */
router.get('/api/auth/pending-email-change', authenticateToken, async (req, res) => {
  try {
    const row = await db.prepare(
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

router.post('/api/auth/change-username', authenticateToken, async (req, res) => {
  const check = validateUsername(req.body.username);
  if (!check.ok) {
    return res.status(400).json({ error: check.error, field: 'username' });
  }
  const target = check.value;

  try {
    const userRow = await db.prepare('SELECT username, username_changed_at FROM users WHERE id = ?').get(req.user.id);
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

    if (!caseOnly && await db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE nocase AND id != ?').get(target, req.user.id)) {
      return res.status(409).json({ error: 'That username is already taken.', field: 'username' });
    }

    // No token_version bump: a username authenticates nothing, so changing it
    // is no reason to sign anyone out.
    await db.prepare('UPDATE users SET username = ?, username_changed_at = ? WHERE id = ?')
      .run(target, caseOnly ? userRow.username_changed_at : new Date().toISOString(), req.user.id);

    const fresh = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    res.json({ success: true, user: await selfUserResponse(fresh) });
  } catch (err) {
    console.error('Change username error:', err);
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'That username is already taken.', field: 'username' });
    }
    res.status(500).json({ error: 'Could not change your username.' });
  }
});

/** Confirms an address from the link in the welcome email. Single use. */
router.post('/api/auth/verify-email', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token is required' });

  try {
    const tokenHash = hashToken(token);
    const row = await db.prepare('SELECT * FROM email_verification_tokens WHERE token_hash = ?').get(tokenHash);
    if (!row) {
      return res.status(400).json({ error: 'That confirmation link is not valid. Request a new one.' });
    }
    if (new Date(row.expires_at) < new Date()) {
      await db.prepare('DELETE FROM email_verification_tokens WHERE token_hash = ?').run(tokenHash);
      return res.status(400).json({ error: 'That confirmation link has expired. Request a new one.' });
    }

    const userRow = await db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
    if (!userRow || userRow.account_status !== 'active') {
      await db.prepare('DELETE FROM email_verification_tokens WHERE token_hash = ?').run(tokenHash);
      return res.status(400).json({ error: 'That confirmation link is not valid. Request a new one.' });
    }

    await runInTransaction(db, async (tx) => {
      await tx.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(row.user_id);
      await tx.prepare('DELETE FROM email_verification_tokens WHERE token_hash = ?').run(tokenHash);
    });

    const fresh = await db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
    const user = await selfUserResponse(fresh);

    /**
     * Confirming signs you in, which is what makes the link from the welcome
     * email work on a phone that has never seen this site. The token is
     * single-use and 24-hour, and the act of opening it proves control of the
     * mailbox — the same proof "forgot password" relies on.
     */
    await issueSession(res, user, fresh.token_version);
    /* Awaited. It is housekeeping, and it used to be a bare call because on
       SQLite the delete had already happened by the time control returned. On
       PostgreSQL the promise outlives the request: a rejection becomes an
       unhandled rejection after the 200 has been sent, and the rows stay. One
       indexed delete is not worth leaving that open. */
    await purgeExpiredVerificationTokens();

    res.json({ success: true, user, emailVerified: true });
  } catch (err) {
    console.error('Verify email error:', err);
    res.status(500).json({ error: 'Could not confirm that address' });
  }
});

/** Sends a fresh confirmation link to the signed-in user's own address. */
router.post('/api/auth/resend-verification', authenticateToken, async (req, res) => {
  try {
    const user = await db.prepare('SELECT id, email, email_verified FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.email_verified === 1) {
      return res.json({ success: true, message: 'That address is already confirmed.' });
    }

    const token = await issueVerificationToken(user.id);
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
router.get('/api/auth/check-email', async (req, res) => {
  const check = validateEmail(req.query.email);
  if (!check.ok) {
    return res.json({ available: false, valid: false, error: check.error });
  }
  try {
    const row = await db.prepare('SELECT 1 FROM users WHERE email = ? COLLATE nocase').get(check.value);
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


/**
 * ── The Organizer Agreement ─────────────────────────────────────────────────
 *
 * Both routes act only on the caller's own account, which is why they live in
 * this file rather than in `adminRoutes.js`. The point of the whole mechanism is
 * that acceptance is the ORGANIZER's act and not something an administrator can
 * perform for them — see `server/organizerAgreement.js` for why approval and
 * acceptance cannot stand in for one another.
 */

/**
 * What the caller must accept, and whether they have.
 *
 * Readable by any authenticated user, not just organizers. A student gets
 * `required: false` rather than a 403: the client asks this on load to decide
 * whether to show the interstitial, and an error response for the ordinary case
 * would make "no agreement needed" indistinguishable from "the request failed".
 */
router.get('/api/legal/organizer-agreement', authenticateToken, async (req, res) => {
  try {
    const user = await db.prepare('SELECT id, role FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'Account not found' });
    res.json(await organizerAgreementStatus(db, user));
  } catch (error) {
    console.error('Organizer agreement status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Accept it.
 *
 * ── Every checkbox is required, and the server is what enforces that ──
 *
 * The agreement itemises its undertakings and the form renders one checkbox per
 * item. A client that ticks the box for the reader is a client bug; a server that
 * accepts a submission with `acknowledged: false` records a consent that was
 * never given, and that record is the only thing standing behind the document.
 * `=== true` and not a truthy test, for the reason `assertConsent` gives: the
 * string "false" is truthy.
 *
 * No step-up re-authentication. It is tempting — this is a consequential act —
 * but the seven registered sensitive actions are all things that change WHO CAN
 * REACH an account. This adds an obligation to the person already signed in, and
 * gating it would mean an organizer who cannot complete a re-auth round trip is
 * locked out of the only action that restores their account.
 */
router.post('/api/legal/organizer-agreement/accept', authenticateToken, async (req, res) => {
  try {
    const user = await db.prepare('SELECT id, role FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'Account not found' });

    if (user.role !== ROLE.ORGANIZER) {
      // Refused rather than recorded. An acceptance row for somebody the
      // agreement does not bind is a false record, and a false record in this
      // table is worse than a missing one.
      return res.status(400).json({
        error: 'The Organizer Agreement applies to organizer accounts.',
        code: 'not_an_organizer',
      });
    }

    if (req.body?.acknowledged !== true) {
      return res.status(400).json({
        error: 'Every undertaking must be acknowledged before the agreement can be accepted.',
        code: 'acknowledgement_required',
      });
    }

    const result = await acceptOrganizerAgreement(db, { userId: user.id, req });

    await recordAudit(db, {
      adminId: user.id,
      action: 'ACCEPT_ORGANIZER_AGREEMENT',
      targetUserId: user.id,
      details: result.already
        ? 'Re-submitted an agreement already accepted at the current version; no new record written'
        : `Accepted ${ORGANIZER_DOCUMENTS.map(d => `${d.slug}@${d.version}`).join(', ')}`,
    });

    res.json({ accepted: true, alreadyAccepted: result.already, recorded: result.recorded });
  } catch (error) {
    console.error('Organizer agreement acceptance error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * ── The Student Organizer Agreement, same shape and a different document ──
 *
 * Separate routes rather than a parameter on the pair above. The two agreements
 * bind different people to different undertakings and are withheld against
 * different capability sets; a `?which=` parameter would put the choice of
 * which contract somebody is accepting into a query string.
 */

/**
 * What the caller must accept, and whether they have.
 *
 * Readable by any authenticated user. An ordinary member gets
 * `required: false` rather than a 403, for the reason the organizer route
 * gives: the client asks on load, and an error would make "nothing to accept"
 * indistinguishable from "the request failed".
 */
router.get('/api/legal/student-organizer-agreement', authenticateToken, async (req, res) => {
  try {
    const user = await db.prepare('SELECT id, role FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'Account not found' });
    res.json(await studentOrganizerAgreementStatus(db, user));
  } catch (error) {
    console.error('Student organizer agreement status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Accept it.
 *
 * Refused for somebody who does not hold the rank anywhere, rather than
 * recorded: an acceptance row for a person the agreement does not bind is a
 * false record, and a false record in this table is worse than a missing one.
 * It is checked against the membership table and not against a role, because
 * the rank IS a membership row.
 *
 * `=== true` and not a truthy test, for the reason `assertConsent` gives: the
 * string "false" is truthy.
 *
 * No step-up re-authentication, matching the organizer route — this adds an
 * obligation to somebody already signed in rather than changing who can reach
 * the account, and gating it would lock a student out of the only action that
 * releases their capabilities.
 */
router.post('/api/legal/student-organizer-agreement/accept', authenticateToken, async (req, res) => {
  try {
    const user = await db.prepare('SELECT id, role FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'Account not found' });

    if (!await helpsRunAnywhere(db, user.id)) {
      return res.status(400).json({
        error: 'The Student Organizer Agreement applies to student organizers.',
        code: 'not_a_student_organizer',
      });
    }

    if (req.body?.acknowledged !== true) {
      return res.status(400).json({
        error: 'Every undertaking must be acknowledged before the agreement can be accepted.',
        code: 'acknowledgement_required',
      });
    }

    const result = await acceptStudentOrganizerAgreement(db, { userId: user.id, req });

    await recordAudit(db, {
      adminId: user.id,
      action: 'ACCEPT_STUDENT_ORGANIZER_AGREEMENT',
      targetUserId: user.id,
      details: result.already
        ? 'Re-submitted an agreement already accepted at the current version; no new record written'
        : `Accepted ${STUDENT_ORGANIZER_DOCUMENTS.map(d => `${d.slug}@${d.version}`).join(', ')}`,
    });

    res.json({ accepted: true, alreadyAccepted: result.already, recorded: result.recorded });
  } catch (error) {
    console.error('Student organizer agreement acceptance error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
