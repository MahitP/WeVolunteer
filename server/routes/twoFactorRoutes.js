import express from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { generateSecret, generateURI } from 'otplib';
import QRCode from 'qrcode';
import { db } from '../db.js';
import { authenticateToken, inTransaction, secondFactorRequiredFor } from '../utils.js';
import { requireAAL2 } from '../authz.js';
import { spendChallenge, ChallengeNotSpent, refuseReauth } from '../reauthResponses.js';
import { encryptSecret, decryptSecret, verifyTotp } from '../cryptoUtils.js';
import { recordSecurityEvent } from '../securityAudit.js';

const router = express.Router();

/**
 * Generates a single secure 10-character recovery code.
 * 
 * Uses a cryptographically secure, uniform selection method over the A-Z0-9 alphabet.
 */
function generateRecoveryCode() {
  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  while (result.length < 10) {
    const bytes = crypto.randomBytes(1);
    const value = bytes[0];
    // To ensure uniformity, only use values < 252 (since 252 is a multiple of 36)
    if (value < 252) {
      result += charset[value % 36];
    }
  }
  return result;
}

/**
 * Generate a 2FA secret and QR code for the user to scan.
 * 
 * Generates a new TOTP secret but does NOT enable 2FA yet.
 * The secret is stored as pending in `tfa_secret` encrypted with AES-256-GCM.
 */
router.post('/api/2fa/generate', authenticateToken, requireAAL2('2fa.generate'), async (req, res) => {
  try {
    inTransaction(() => {
      spendChallenge(db, req, '2fa.generate', {});

      const user = db.prepare('SELECT email, tfa_enabled FROM users WHERE id = ?').get(req.user.id);

      /**
       * Generating a new secret would overwrite a working one.
       *
       * This wrote `tfa_secret` unconditionally while leaving `tfa_enabled` at 1.
       * So a user who already had TOTP working and pressed "Set Up
       * Authenticator" again — to add a second device, or just out of curiosity —
       * had their live secret replaced by one they had not scanned yet, while the
       * account still demanded a code. Their authenticator produced codes for a
       * secret the server no longer held: locked out, recovery codes only.
       *
       * Refused rather than silently re-enrolled. The alternative is a second
       * column holding a PENDING secret so the live one survives until the new
       * one is confirmed, which is the better design and a schema change; this is
       * the honest behaviour until then, and it never costs anybody their access.
       */
      if (user.tfa_enabled) {
        throw new Error('already_enrolled');
      }

      const secret = generateSecret();
      /* `label`, not `accountName` — otplib v13 names it `label`, and the wrong
         key is silently ignored rather than rejected. The URI came out as
         `otpauth://totp/WeVolunteer:undefined`, so every authenticator app
         listed the entry as "undefined" and somebody with two accounts on the
         platform could not tell which code belonged to which. */
      const otpauth = generateURI({ secret, label: user.email, issuer: 'WeVolunteer' });
      
      const encryptedSecret = encryptSecret(secret);
      db.prepare('UPDATE users SET tfa_secret = ? WHERE id = ?').run(encryptedSecret, req.user.id);
      
      // We resolve the QR code outside the transaction in a moment
      req.tempSecret = secret;
      req.tempOtpauth = otpauth;
    });

    const qr = await QRCode.toDataURL(req.tempOtpauth);
    res.json({ secret: req.tempSecret, qr });
  } catch (err) {
    if (err instanceof ChallengeNotSpent) return refuseReauth(res, err.result || err);
    if (err.message === 'already_enrolled') {
      return res.status(409).json({
        error: 'An authenticator is already set up for this account. Turn it off first, '
          + 'then set up the new device.',
        code: 'already_enrolled',
      });
    }
    console.error('Failed to generate 2FA:', err);
    res.status(500).json({ error: 'Failed to generate 2FA secret' });
  }
});

/**
 * Enable 2FA by verifying the first token.
 * 
 * Reads the pending `tfa_secret` and verifies the token against it.
 * If successful, enables TOTP and generates recovery codes.
 */
router.post('/api/2fa/enable', authenticateToken, requireAAL2('2fa.enable'), async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token is required' });

  try {
    /**
     * The code is checked BEFORE ten bcrypt hashes are computed.
     *
     * ── Why this pre-check is not redundant ──
     *
     * The authoritative verification is still the one inside the transaction
     * below, beside `spendChallenge`, and it has to be: only there is it atomic
     * with the enrolment. This is a cheap gate in front of it.
     *
     * Without it, every wrong six digits cost the server ten bcrypt hashes at
     * cost 10 — roughly a second of CPU — to produce recovery codes it then threw
     * away when verification failed. That is work amplification on a path a
     * caller drives: the attempt counters bound how many GUESSES somebody gets,
     * not what the server spends on each, so five wrong codes bought fifty bcrypt
     * operations. It also made the latency of the COMMON case — one mistyped
     * digit — a second longer than it needed to be.
     *
     * ── And it narrows a real race ──
     *
     * `verifyTotp` runs with zero epoch tolerance, so only the current 30-second
     * step is accepted. Hashing first meant a code generated near a boundary was
     * verified about a second later, in the NEXT step, and a CORRECT code was
     * refused; `routes.2faEnrolment.test.js` failed roughly one run in three on
     * exactly that. Checking first shrinks the window to the request's own
     * latency. It does not close it — that needs a ±1 step tolerance, which is a
     * decision about the accept window and is recorded as an open question rather
     * than taken quietly here.
     *
     * The secret is read twice on purpose. This read is advisory; the one below is
     * the one that counts. Collapsing them into a value carried across the
     * `await` would make the authoritative check read stale state.
     */
    const enrolling = db.prepare('SELECT tfa_secret FROM users WHERE id = ?').get(req.user.id);
    if (!enrolling?.tfa_secret) {
      return res.status(400).json({ error: 'No 2FA secret found. Generate one first.' });
    }
    /**
     * `verifyTotp`, the BOOLEAN form — deliberately not `verifyTotpOnce`.
     *
     * This is the advisory pre-check. `verifyTotpOnce` records the time step it
     * accepted, and if this call recorded it then the authoritative check inside
     * the transaction below would see its own code as already spent and refuse a
     * correct one. The pre-check must observe without marking; only the
     * authoritative check marks.
     */
    if (!verifyTotp(token, enrolling.tfa_secret)) {
      return res.status(400).json({ error: 'Invalid token' });
    }

    const recoveryCodes = Array.from({ length: 10 }, () => generateRecoveryCode());

    /**
     * Hashed BEFORE the transaction opens, not inside it.
     *
     * `inTransaction` is synchronous, so an `await` cannot go in it — which is
     * how these became `bcrypt.hashSync` and tripped `bcryptAsync.test.js`. Ten
     * synchronous bcrypt hashes at cost 10 is roughly a second of blocked event
     * loop, during which every other request on the process waits; that guard's
     * message records a measured p95 of 3.8s on unrelated endpoints under load.
     *
     * Doing the expensive work first and writing the finished hashes inside the
     * transaction keeps the write atomic and the loop free.
     */
    const hashedCodes = await Promise.all(recoveryCodes.map((code) => bcrypt.hash(code, 10)));

    inTransaction(() => {
      spendChallenge(db, req, '2fa.enable', {});

      const user = db.prepare('SELECT id, tfa_secret, tfa_last_counter FROM users WHERE id = ?').get(req.user.id);
      if (!user.tfa_secret) throw new Error('No 2FA secret found. Generate one first.');

      /* `verifyTotp` returns a real boolean. otplib's `verifySync` returns an
         OBJECT — `{ valid: false }` for a wrong code — which is truthy, so the
         previous `if (!isValid)` never fired and enrolment could be confirmed
         with a code the authenticator never showed. See cryptoUtils.js. */
      /**
       * `verifyTotp`, not `verifyTotpOnce` — single-use is enforced on the
       * SIGN-IN path only, and deliberately not here. See the scope note in
       * server/totpReplay.js: reaching this line already requires a live session
       * AND a spent step-up grant, so anybody able to replay a code here holds
       * everything the code was protecting. Marking the step here would instead
       * mean an account could not sign in and finish enrolling inside the same
       * thirty seconds, which is friction bought for nothing.
       */
      if (!verifyTotp(token, user.tfa_secret)) throw new Error('Invalid token');

      db.prepare('UPDATE users SET tfa_enabled = 1 WHERE id = ?').run(req.user.id);

      /**
       * The previous set is REPLACED, not added to.
       *
       * This handler inserted ten codes unconditionally. An account that had
       * already enrolled email 2FA — which issues its own ten — came out of TOTP
       * enrolment holding twenty live codes, and the response below shows the
       * reader only the ten it just made. The other ten stayed valid, unseen,
       * on a printout or in a password manager from the earlier enrolment,
       * indefinitely.
       *
       * That is the wrong direction for a recovery credential: the set a person
       * believes they hold must be the set that works, or "I have destroyed my
       * old codes" is not something they can make true. `regenerate` below
       * already deletes first; this is the same rule.
       */
      db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(req.user.id);

      /* `datetime('now')`, single quotes. Double quotes make SQLite parse `now` as an
         IDENTIFIER, and `node:sqlite` does not enable the legacy fallback that treats
         an unresolvable identifier as a string — so this fails at runtime with
         "no such column: now". It is a latent 500 in every recovery-code path. */
      const insertRC = db.prepare("INSERT INTO recovery_codes (id, user_id, code_hash, created_at) VALUES (?, ?, ?, datetime('now'))");
      for (const hash of hashedCodes) {
        insertRC.run(`rc-${crypto.randomUUID()}`, req.user.id, hash);
      }

      recordSecurityEvent(db, req, req.user.id, '2FA_TOTP_ENABLED');
      recordSecurityEvent(db, req, req.user.id, '2FA_RECOVERY_GENERATED');
    });

    res.json({ success: true, recoveryCodes });
  } catch (err) {
    if (err instanceof ChallengeNotSpent) return refuseReauth(res, err.result || err);
    if (err.message === 'No 2FA secret found. Generate one first.' || err.message === 'Invalid token') {
      return res.status(400).json({ error: err.message });
    }
    console.error('Failed to enable 2FA:', err);
    res.status(500).json({ error: 'Failed to enable 2FA' });
  }
});

/**
 * Disable 2FA for the user.
 * 
 * Verifies the provided token before disabling TOTP and email 2FA,
 * and purges all recovery codes.
 */
router.post('/api/2fa/disable', authenticateToken, requireAAL2('2fa.disable'), (req, res) => {
  const { token } = req.body;
  
  try {
    inTransaction(() => {
      spendChallenge(db, req, '2fa.disable', {});

      const user = db.prepare(
        'SELECT id, tfa_secret, tfa_enabled, tfa_email_enabled, role, tfa_last_counter FROM users WHERE id = ?'
      ).get(req.user.id);
      if (!user.tfa_enabled) throw new Error('2FA is not enabled');

      /**
       * An administrator may not remove their last factor.
       *
       * `/api/2fa/email/disable` has had this check; this route did not — and it
       * is the more dangerous of the two, because it clears `tfa_email_enabled`
       * as well as `tfa_enabled`. So an administrator could strip BOTH factors
       * in one call and immediately be refused by `requireCap` on every
       * administrative route: walled out of their own platform by a control
       * offered to them as a normal setting, with no way back except a shell.
       *
       * Turning TOTP off is allowed when email 2FA would survive it — but this
       * handler switches that off too, so the honest rule is that an
       * administrator disables nothing here until the policy stops applying.
       */
      if (secondFactorRequiredFor(user.role)) throw new Error('role_requires_2fa');

      if (!token) throw new Error('Token is required to disable 2FA');
      /* Same object-is-truthy defect as enable, and worse here: anybody holding
         the session could TURN 2FA OFF with any six digits, which is the whole
         protection removed by the person it was protecting against. */
      /* Plain verification — see the note on enrolment above and the scope
         section in server/totpReplay.js. Disabling already requires a session and
         a spent step-up grant. */
      if (!verifyTotp(token, user.tfa_secret)) throw new Error('Invalid token');

      db.prepare('UPDATE users SET tfa_enabled = 0, tfa_secret = NULL, tfa_email_enabled = 0 WHERE id = ?').run(req.user.id);
      db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(req.user.id);

      recordSecurityEvent(db, req, req.user.id, '2FA_TOTP_DISABLED');
    });

    res.json({ success: true });
  } catch (err) {
    if (err instanceof ChallengeNotSpent) return refuseReauth(res, err.result || err);
    if (err.message === 'role_requires_2fa') {
      return res.status(403).json({
        error: 'Your role requires a second factor, so it cannot be turned off. '
          + 'An administrator without one cannot use the administrative pages at all.',
        code: 'role_requires_2fa',
      });
    }
    if (err.message === '2FA is not enabled' || err.message === 'Invalid token' || err.message === 'Token is required to disable 2FA') {
      return res.status(400).json({ error: err.message });
    }
    console.error('Failed to disable 2FA:', err);
    res.status(500).json({ error: 'Failed to disable 2FA' });
  }
});

/**
 * Enable email-based 2FA.
 * 
 * Uses the '2fa.enable' sensitive action. Requires a verified email address.
 */
router.post('/api/2fa/email/enable', authenticateToken, requireAAL2('2fa.enable'), async (req, res) => {
  try {
    /**
     * Email enrolment issues recovery codes too — unless the account already has
     * some from TOTP.
     *
     * It issued none, while `TwoFactorSetup.jsx` read `data.recoveryCodes` from
     * this response. So somebody who chose email as their only second factor was
     * shown nothing where the codes should be, and — more seriously — had no way
     * back if they lost access to the mailbox. Email is the weaker of the two
     * methods and the one most likely to become unreachable; leaving it as the
     * single credential with no fallback is the wrong way round.
     *
     * Existing codes are left alone: silently replacing the set an authenticator
     * user already wrote down would invalidate the paper in their drawer.
     */
    const existing = db.prepare(
      'SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ?'
    ).get(req.user.id).n;

    const recoveryCodes = existing > 0
      ? null
      : Array.from({ length: 10 }, () => generateRecoveryCode());

    /* Hashed before the transaction — `inTransaction` is synchronous. */
    const hashedCodes = recoveryCodes
      ? await Promise.all(recoveryCodes.map((code) => bcrypt.hash(code, 10)))
      : [];

    inTransaction(() => {
      spendChallenge(db, req, '2fa.enable', {});

      const user = db.prepare('SELECT email_verified FROM users WHERE id = ?').get(req.user.id);
      if (user.email_verified !== 1) {
        throw new Error('Email must be verified to enable email 2FA');
      }

      db.prepare('UPDATE users SET tfa_email_enabled = 1 WHERE id = ?').run(req.user.id);

      if (hashedCodes.length) {
        const insertRC = db.prepare("INSERT INTO recovery_codes (id, user_id, code_hash, created_at) VALUES (?, ?, ?, datetime('now'))");
        for (const hash of hashedCodes) {
          insertRC.run(`rc-${crypto.randomUUID()}`, req.user.id, hash);
        }
        recordSecurityEvent(db, req, req.user.id, '2FA_RECOVERY_GENERATED');
      }

      recordSecurityEvent(db, req, req.user.id, '2FA_EMAIL_ENABLED');
    });

    res.json({ success: true, recoveryCodes });
  } catch (err) {
    if (err instanceof ChallengeNotSpent) return refuseReauth(res, err.result || err);
    if (err.message === 'Email must be verified to enable email 2FA') {
      return res.status(400).json({ error: err.message });
    }
    console.error('Failed to enable email 2FA:', err);
    res.status(500).json({ error: 'Failed to enable email 2FA' });
  }
});

/**
 * Disable email-based 2FA.
 * 
 * Uses the '2fa.disable' sensitive action.
 */
router.post('/api/2fa/email/disable', authenticateToken, requireAAL2('2fa.disable'), (req, res) => {
  try {
    inTransaction(() => {
      spendChallenge(db, req, '2fa.disable', {});

      const user = db.prepare('SELECT tfa_enabled, role FROM users WHERE id = ?').get(req.user.id);
      
      const requires2FA = secondFactorRequiredFor(user.role);
      if (requires2FA && user.tfa_enabled !== 1) {
        throw new Error('role_requires_2fa');
      }

      db.prepare('UPDATE users SET tfa_email_enabled = 0 WHERE id = ?').run(req.user.id);
      recordSecurityEvent(db, req, req.user.id, '2FA_EMAIL_DISABLED');
    });

    res.json({ success: true });
  } catch (err) {
    if (err instanceof ChallengeNotSpent) return refuseReauth(res, err.result || err);
    if (err.message === 'role_requires_2fa') {
      return res.status(403).json({ error: 'Your role requires at least one 2FA method to be enabled.' });
    }
    console.error('Failed to disable email 2FA:', err);
    res.status(500).json({ error: 'Failed to disable email 2FA' });
  }
});

/**
 * Check 2FA status for the current user.
 */
router.get('/api/2fa/status', authenticateToken, (req, res) => {
  try {
    const user = db.prepare(
      'SELECT tfa_enabled, tfa_email_enabled, role FROM users WHERE id = ?'
    ).get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const countRow = db.prepare('SELECT COUNT(*) as count FROM recovery_codes WHERE user_id = ?').get(req.user.id);

    const totp = user.tfa_enabled === 1;
    const email = user.tfa_email_enabled === 1;

    res.json({
      enabled: totp || email,
      methods: { totp, email },
      recoveryCodesRemaining: countRow ? countRow.count : 0,
      /**
       * Whether the policy forbids this account from turning its factors off.
       *
       * Both disable routes refuse an administrator with `role_requires_2fa`,
       * and until this field existed the client could not know that in advance:
       * `principal.tfaRequired` is `roleRequires && nothing enabled`, so it
       * reads false for exactly the enrolled administrator this question is
       * about. So the settings screen offered "Disable", the user answered a
       * password prompt to prove who they were, and the server then said no.
       *
       * That is the rule ENGINEERING_GUIDE states for the server — answer every
       * refusal before spending a verification — applied on the client, which is
       * where the offer to spend one is made. With this the Disable control is
       * simply not shown, so there is nothing to refuse.
       *
       * Reported, not enforced, here: `secondFactorRequiredFor` is re-evaluated
       * inside both disable handlers, so a client that ignores this field is
       * still refused.
       */
      roleRequires2FA: secondFactorRequiredFor(user.role)
    });
  } catch (err) {
    console.error('Failed to get 2FA status:', err);
    res.status(500).json({ error: 'Failed to get 2FA status' });
  }
});

/**
 * Regenerate recovery codes.
 * 
 * Voids all previous recovery codes and returns a new set.
 */
router.post('/api/2fa/recovery-codes/regenerate', authenticateToken, requireAAL2('2fa.enable'), async (req, res) => {
  try {
    const recoveryCodes = Array.from({ length: 10 }, () => generateRecoveryCode());

    /**
     * Hashed BEFORE the transaction opens, not inside it.
     *
     * `inTransaction` is synchronous, so an `await` cannot go in it — which is
     * how these became `bcrypt.hashSync` and tripped `bcryptAsync.test.js`. Ten
     * synchronous bcrypt hashes at cost 10 is roughly a second of blocked event
     * loop, during which every other request on the process waits; that guard's
     * message records a measured p95 of 3.8s on unrelated endpoints under load.
     *
     * Doing the expensive work first and writing the finished hashes inside the
     * transaction keeps the write atomic and the loop free.
     */
    const hashedCodes = await Promise.all(recoveryCodes.map((code) => bcrypt.hash(code, 10)));

    inTransaction(() => {
      spendChallenge(db, req, '2fa.enable', {});

      db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(req.user.id);
      
      const insertRC = db.prepare("INSERT INTO recovery_codes (id, user_id, code_hash, created_at) VALUES (?, ?, ?, datetime('now'))");
      for (const hash of hashedCodes) {
        insertRC.run(`rc-${crypto.randomUUID()}`, req.user.id, hash);
      }

      recordSecurityEvent(db, req, req.user.id, '2FA_RECOVERY_GENERATED');
    });

    res.json({ success: true, recoveryCodes });
  } catch (err) {
    if (err instanceof ChallengeNotSpent) return refuseReauth(res, err.result || err);
    console.error('Failed to regenerate recovery codes:', err);
    res.status(500).json({ error: 'Failed to regenerate recovery codes' });
  }
});

export default router;
