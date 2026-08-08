import express from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { generateSecret, generateURI } from 'otplib';
import QRCode from 'qrcode';
import { db } from '../db.js';
import { authenticateToken, inTransaction } from '../utils.js';
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

      const user = db.prepare('SELECT email FROM users WHERE id = ?').get(req.user.id);
      const secret = generateSecret();
      const otpauth = generateURI({ secret, accountName: user.email, issuer: 'WeVolunteer' });
      
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

      const user = db.prepare('SELECT tfa_secret FROM users WHERE id = ?').get(req.user.id);
      if (!user.tfa_secret) throw new Error('No 2FA secret found. Generate one first.');

      /* `verifyTotp` returns a real boolean. otplib's `verifySync` returns an
         OBJECT — `{ valid: false }` for a wrong code — which is truthy, so the
         previous `if (!isValid)` never fired and enrolment could be confirmed
         with a code the authenticator never showed. See cryptoUtils.js. */
      if (!verifyTotp(token, user.tfa_secret)) throw new Error('Invalid token');

      db.prepare('UPDATE users SET tfa_enabled = 1 WHERE id = ?').run(req.user.id);
      
      const insertRC = db.prepare('INSERT INTO recovery_codes (id, user_id, code_hash, created_at) VALUES (?, ?, ?, datetime("now"))');
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

      const user = db.prepare('SELECT tfa_secret, tfa_enabled FROM users WHERE id = ?').get(req.user.id);
      if (!user.tfa_enabled) throw new Error('2FA is not enabled');

      if (!token) throw new Error('Token is required to disable 2FA');
      /* Same object-is-truthy defect as enable, and worse here: anybody holding
         the session could TURN 2FA OFF with any six digits, which is the whole
         protection removed by the person it was protecting against. */
      if (!verifyTotp(token, user.tfa_secret)) throw new Error('Invalid token');

      db.prepare('UPDATE users SET tfa_enabled = 0, tfa_secret = NULL, tfa_email_enabled = 0 WHERE id = ?').run(req.user.id);
      db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(req.user.id);

      recordSecurityEvent(db, req, req.user.id, '2FA_TOTP_DISABLED');
    });

    res.json({ success: true });
  } catch (err) {
    if (err instanceof ChallengeNotSpent) return refuseReauth(res, err.result || err);
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
router.post('/api/2fa/email/enable', authenticateToken, requireAAL2('2fa.enable'), (req, res) => {
  try {
    inTransaction(() => {
      spendChallenge(db, req, '2fa.enable', {});

      const user = db.prepare('SELECT email_verified FROM users WHERE id = ?').get(req.user.id);
      if (user.email_verified !== 1) {
        throw new Error('Email must be verified to enable email 2FA');
      }

      db.prepare('UPDATE users SET tfa_email_enabled = 1 WHERE id = ?').run(req.user.id);
      recordSecurityEvent(db, req, req.user.id, '2FA_EMAIL_ENABLED');
    });

    res.json({ success: true });
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
      
      const requires2FA = ['admin', 'super_admin'].includes(user.role);
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
    const user = db.prepare('SELECT tfa_enabled, tfa_email_enabled FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    const countRow = db.prepare('SELECT COUNT(*) as count FROM recovery_codes WHERE user_id = ?').get(req.user.id);
    
    const totp = user.tfa_enabled === 1;
    const email = user.tfa_email_enabled === 1;
    
    res.json({
      enabled: totp || email,
      methods: { totp, email },
      recoveryCodesRemaining: countRow ? countRow.count : 0
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
      
      const insertRC = db.prepare('INSERT INTO recovery_codes (id, user_id, code_hash, created_at) VALUES (?, ?, ?, datetime("now"))');
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
