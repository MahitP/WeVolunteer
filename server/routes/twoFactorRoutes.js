import express from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { generateSecret, generateURI } from 'otplib';
import QRCode from 'qrcode';
import { db } from '../db.js';
import { authenticateToken, secondFactorRequiredFor, enabledSecondFactors } from '../utils.js';
import { runInTransaction } from '../db/connectionContext.js';
import { requireAAL2 } from '../authz.js';
import { spendChallenge, ChallengeNotSpent, refuseReauth } from '../reauthResponses.js';
import { encryptSecret, verifyTotp } from '../cryptoUtils.js';
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
    await runInTransaction(db, async (tx) => {
      await spendChallenge(tx, req, '2fa.generate', {});

      const user = await tx.prepare('SELECT email, tfa_enabled FROM users WHERE id = ?').get(req.user.id);

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
      await tx.prepare('UPDATE users SET tfa_secret = ? WHERE id = ?').run(encryptedSecret, req.user.id);
      
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
     * `verifyTotp` used to run with ZERO epoch tolerance, so only the current
     * 30-second step was accepted. Hashing first meant a code generated near a
     * boundary was verified about a second later, in the NEXT step, and a CORRECT
     * code was refused; `routes.2faEnrolment.test.js` failed roughly one run in
     * three on exactly that. Checking first shrinks the window to the request's
     * own latency.
     *
     * That was a mitigation, and the open question it named — whether to widen
     * the accept window — has since been answered: `TOTP_EPOCH_TOLERANCE` is now
     * `[30, 0]`, one previous step and no future one, shipped together with the
     * single-use high-water mark that makes a wider window safe (see
     * `server/totpReplay.js`). So the race this ordering narrowed is closed at
     * the source now.
     *
     * The ordering stays anyway. It is still a second of bcrypt not spent on a
     * request that is about to be refused for a wrong code, and reverting it
     * would put the boundary back in reach of any future change to the
     * tolerance.
     *
     * The secret is read twice on purpose. This read is advisory; the one below is
     * the one that counts. Collapsing them into a value carried across the
     * `await` would make the authoritative check read stale state.
     */
    const enrolling = await db.prepare('SELECT tfa_secret FROM users WHERE id = ?').get(req.user.id);
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

    /**
     * ── Adding a factor must NOT replace codes the account already holds ──
     *
     * This generated ten new codes unconditionally and deleted the old set
     * inside the transaction below. So an account that enrolled EMAIL first —
     * receiving ten codes, and being told to write them down — silently lost
     * every one of them the moment it added an authenticator. The paper in the
     * drawer, the screenshot, the password-manager entry: all dead, with no
     * message saying so, at exactly the moment the person believed they were
     * making their account *more* secure.
     *
     * `/api/2fa/email/enable` has always had this right, and the reasoning in
     * its comment applies here word for word. The two enrolment routes now
     * agree: a set is issued when the account has none, and is otherwise left
     * exactly as it is. Regeneration keeps its own endpoint, its own
     * confirmation dialog and its own step-up action, because destroying
     * recovery codes is something somebody has to choose on purpose.
     *
     * `null` rather than an empty array, so the client can tell "here are your
     * new codes" from "you already have codes and they still work". The email
     * route uses the same convention.
     */
    const existingCodes = (await db.prepare(
      'SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ?'
    ).get(req.user.id)).n;

    const recoveryCodes = existingCodes > 0
      ? null
      : Array.from({ length: 10 }, () => generateRecoveryCode());

    /**
     * Hashed BEFORE the transaction opens, not inside it.
     *
     * The transaction is async now (wave 7), so an `await` inside it is legal
     * where it was not before — but the hashing stays out here regardless, and
     * for a better reason than the original one.
     *
     * Ten bcrypt hashes at cost 10 is roughly a second of work. Inside the
     * transaction that second would be spent holding a write lock: on PostgreSQL
     * a pooled client nobody else can use, on SQLite the database's write lock
     * via `BEGIN IMMEDIATE`. Doing the expensive work first keeps the
     * transaction as short as the writes themselves.
     *
     * The original note recorded why they must not be `bcrypt.hashSync` — ten
     * synchronous hashes block the event loop for about a second, and
     * `bcryptAsync.test.js` guards it after a measured p95 of 3.8s on unrelated
     * endpoints under load. That reason still stands too.
     */
    const hashedCodes = recoveryCodes
      ? await Promise.all(recoveryCodes.map((code) => bcrypt.hash(code, 10)))
      : [];

    await runInTransaction(db, async (tx) => {
      await spendChallenge(tx, req, '2fa.enable', {});

      const user = await tx.prepare('SELECT id, tfa_secret, tfa_last_counter FROM users WHERE id = ?').get(req.user.id);
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

      await tx.prepare('UPDATE users SET tfa_enabled = 1 WHERE id = ?').run(req.user.id);

      /**
       * Written only when this enrolment actually issued a set.
       *
       * Two failure modes had to be avoided here, in opposite directions, and
       * the guard above is what makes both impossible:
       *
       *   • Inserting unconditionally left an account that had already enrolled
       *     email 2FA holding TWENTY live codes, while the response showed only
       *     the ten just made — ten valid codes on an old printout, unseen and
       *     unrevocable. The set a person believes they hold must be the set
       *     that works.
       *   • Deleting unconditionally silently voided the ten they had already
       *     written down, at the moment they were making the account stronger.
       *
       * Both came from this handler treating enrolment as issuance. It is not:
       * a recovery set belongs to the ACCOUNT, not to a factor. It is issued
       * when there is none and replaced only by `regenerate`, which asks first.
       */
      if (hashedCodes.length) {
        await tx.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(req.user.id);

        /* `datetime('now')`, single quotes. Double quotes make SQLite parse `now` as an
           IDENTIFIER, and `node:sqlite` does not enable the legacy fallback that treats
           an unresolvable identifier as a string — so this fails at runtime with
           "no such column: now". It is a latent 500 in every recovery-code path. */
        const insertRC = tx.prepare('INSERT INTO recovery_codes (id, user_id, code_hash, created_at) VALUES (?, ?, ?, ?)');
        const rcCreatedAt = new Date().toISOString();
        for (const hash of hashedCodes) {
          await insertRC.run(`rc-${crypto.randomUUID()}`, req.user.id, hash, rcCreatedAt);
        }
        await recordSecurityEvent(tx, req, req.user.id, '2FA_RECOVERY_GENERATED');
      }

      await recordSecurityEvent(tx, req, req.user.id, '2FA_TOTP_ENABLED');
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
router.post('/api/2fa/disable', authenticateToken, requireAAL2('2fa.disable'), async (req, res) => {
  const { token } = req.body;
  
  try {
    /* Hoisted out of the transaction so the RESPONSE can say which of the two
       outcomes happened — one factor removed, or two-factor switched off. */
    let twoFactorSurvives = false;

    await runInTransaction(db, async (tx) => {
      await spendChallenge(tx, req, '2fa.disable', {});

      const user = await tx.prepare(
        'SELECT id, tfa_secret, tfa_enabled, tfa_email_enabled, email_verified, role, tfa_last_counter FROM users WHERE id = ?'
      ).get(req.user.id);
      if (!user.tfa_enabled) throw new Error('2FA is not enabled');

      /**
       * ── Removing the AUTHENTICATOR is not "turn off two-factor" ──
       *
       * This handler cleared `tfa_email_enabled` alongside `tfa_enabled` and
       * then deleted every recovery code. The screen offering it is the
       * authenticator card, and the button says "Turn off" beneath the heading
       * "Authenticator app" — so a person removing one factor lost all three
       * things: their authenticator, their email second factor, and the ten
       * codes they had written down. Nothing said that would happen, and
       * nothing could bring the codes back.
       *
       * A recovery set belongs to the ACCOUNT, not to a factor. It survives as
       * long as any factor does, exactly as it survives adding one (see the
       * note in `/api/2fa/enable`).
       *
       * So: does a second factor survive this removal? Email counts only when
       * it is switched on AND deliverable — the same pair `enabledSecondFactors`
       * uses, because a `tfa_email_enabled` flag over an unconfirmed address is
       * not a factor anybody can complete a sign-in with, and treating it as one
       * here would leave the account believing it still had 2FA when sign-in
       * would offer it nothing.
       */
      twoFactorSurvives = Boolean(user.tfa_email_enabled) && user.email_verified === 1;
      const emailSurvives = twoFactorSurvives;

      /**
       * An administrator may not remove their LAST factor.
       *
       * Previously this refused an administrator outright, and the comment gave
       * the honest reason: the handler switched email off too, so there was no
       * such thing as removing only the authenticator, and any removal was a
       * removal of everything. That is no longer true — so the rule returns to
       * the one it always wanted to be, and matches `/api/2fa/email/disable`:
       * refuse only when nothing would be left.
       */
      if (secondFactorRequiredFor(user.role) && !emailSurvives) throw new Error('role_requires_2fa');

      if (!token) throw new Error('Token is required to disable 2FA');
      /* Same object-is-truthy defect as enable, and worse here: anybody holding
         the session could TURN 2FA OFF with any six digits, which is the whole
         protection removed by the person it was protecting against. */
      /* Plain verification — see the note on enrolment above and the scope
         section in server/totpReplay.js. Disabling already requires a session and
         a spent step-up grant. */
      if (!verifyTotp(token, user.tfa_secret)) throw new Error('Invalid token');

      /**
       * `tfa_last_counter` is cleared with the secret it belongs to.
       *
       * It is the high-water time step of the last accepted code FOR THAT
       * SECRET. Left behind, it would be compared against codes from a
       * different secret after a re-enrolment, and `verifyTotpOnce` would refuse
       * a perfectly good code as a replay — on the first sign-in after somebody
       * set their authenticator up again, which is the worst possible moment.
       */
      if (emailSurvives) {
        /* Only the authenticator. Email 2FA stays on, so the account still has
           a second factor and the recovery set still has something to be the
           fallback FOR. */
        await tx.prepare(
          'UPDATE users SET tfa_enabled = 0, tfa_secret = NULL, tfa_last_counter = NULL WHERE id = ?'
        ).run(req.user.id);
      } else {
        /* The last factor. Two-factor is genuinely off now, so the recovery set
           has nothing left to recover past and is destroyed with it — leaving
           ten live credentials on an account with no second factor would be a
           standing bypass of a protection the user believes they removed. */
        await tx.prepare(
          'UPDATE users SET tfa_enabled = 0, tfa_secret = NULL, tfa_last_counter = NULL, tfa_email_enabled = 0 WHERE id = ?'
        ).run(req.user.id);
        await tx.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(req.user.id);
      }

      await recordSecurityEvent(tx, req, req.user.id, '2FA_TOTP_DISABLED');
    });

    /* `twoFactorStillOn` so the screen can say what actually happened rather
       than assuming everything came off. */
    res.json({ success: true, twoFactorStillOn: twoFactorSurvives });
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
    const existing = (await db.prepare(
      'SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ?'
    ).get(req.user.id)).n;

    const recoveryCodes = existing > 0
      ? null
      : Array.from({ length: 10 }, () => generateRecoveryCode());

    /* Hashed before the transaction — `inTransaction` is synchronous. */
    const hashedCodes = recoveryCodes
      ? await Promise.all(recoveryCodes.map((code) => bcrypt.hash(code, 10)))
      : [];

    await runInTransaction(db, async (tx) => {
      await spendChallenge(tx, req, '2fa.enable', {});

      const user = await tx.prepare('SELECT email_verified FROM users WHERE id = ?').get(req.user.id);
      if (user.email_verified !== 1) {
        throw new Error('Email must be verified to enable email 2FA');
      }

      await tx.prepare('UPDATE users SET tfa_email_enabled = 1 WHERE id = ?').run(req.user.id);

      if (hashedCodes.length) {
        const insertRC = tx.prepare('INSERT INTO recovery_codes (id, user_id, code_hash, created_at) VALUES (?, ?, ?, ?)');
        const rcCreatedAt = new Date().toISOString();
        for (const hash of hashedCodes) {
          await insertRC.run(`rc-${crypto.randomUUID()}`, req.user.id, hash, rcCreatedAt);
        }
        await recordSecurityEvent(tx, req, req.user.id, '2FA_RECOVERY_GENERATED');
      }

      await recordSecurityEvent(tx, req, req.user.id, '2FA_EMAIL_ENABLED');
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
router.post('/api/2fa/email/disable', authenticateToken, requireAAL2('2fa.disable'), async (req, res) => {
  try {
    await runInTransaction(db, async (tx) => {
      await spendChallenge(tx, req, '2fa.disable', {});

      const user = await tx.prepare('SELECT tfa_enabled, role FROM users WHERE id = ?').get(req.user.id);
      
      const requires2FA = secondFactorRequiredFor(user.role);
      if (requires2FA && user.tfa_enabled !== 1) {
        throw new Error('role_requires_2fa');
      }

      await tx.prepare('UPDATE users SET tfa_email_enabled = 0 WHERE id = ?').run(req.user.id);
      await recordSecurityEvent(tx, req, req.user.id, '2FA_EMAIL_DISABLED');
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
router.get('/api/2fa/status', authenticateToken, async (req, res) => {
  try {
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const countRow = await db.prepare('SELECT COUNT(*) as count FROM recovery_codes WHERE user_id = ?').get(req.user.id);

    const totp = user.tfa_enabled === 1;
    const emailEnrolled = user.tfa_email_enabled === 1;

    /**
     * What the SIGN-IN screen will actually accept — not what was switched on.
     *
     * These two used to disagree, and the disagreement was the same defect this
     * file's header describes fixing in the opposite direction. Since v1.3.1 a
     * confirmed address is accepted as a second factor once the account has any
     * factor at all, so an account that enrolled an authenticator and declined
     * email codes could nonetheless be signed into with a mailed code — while
     * this endpoint reported `email: false`, the Settings card showed no "On"
     * tag and offered "Use email codes", and the disable route wrote a 0 that
     * was already 0. A factor reported as off and impossible to turn off is
     * exactly what `enabledSecondFactors` exists to prevent.
     *
     * So `available` is the derivation the login route enforces, and
     * `enrolled` is the switch the account set. The client shows the first and
     * only offers the enable/disable control for the second.
     */
    const offered = await enabledSecondFactors(user);

    res.json({
      enabled: totp || emailEnrolled,
      methods: {
        totp,
        /* Kept as the ENROLMENT flag, because that is what the disable route
           acts on and what this key has always meant to its callers. */
        email: emailEnrolled,
      },
      /* What the second-factor step will accept for this account, right now. */
      availableMethods: offered,
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
router.post('/api/2fa/recovery-codes/regenerate', authenticateToken, requireAAL2('2fa.recovery.regenerate'), async (req, res) => {
  try {
    const recoveryCodes = Array.from({ length: 10 }, () => generateRecoveryCode());

    /**
     * Hashed BEFORE the transaction opens, not inside it.
     *
     * The transaction is async now (wave 7), so an `await` inside it is legal
     * where it was not before — but the hashing stays out here regardless, and
     * for a better reason than the original one.
     *
     * Ten bcrypt hashes at cost 10 is roughly a second of work. Inside the
     * transaction that second would be spent holding a write lock: on PostgreSQL
     * a pooled client nobody else can use, on SQLite the database's write lock
     * via `BEGIN IMMEDIATE`. Doing the expensive work first keeps the
     * transaction as short as the writes themselves.
     *
     * The original note recorded why they must not be `bcrypt.hashSync` — ten
     * synchronous hashes block the event loop for about a second, and
     * `bcryptAsync.test.js` guards it after a measured p95 of 3.8s on unrelated
     * endpoints under load. That reason still stands too.
     */
    const hashedCodes = await Promise.all(recoveryCodes.map((code) => bcrypt.hash(code, 10)));

    await runInTransaction(db, async (tx) => {
      await spendChallenge(tx, req, '2fa.recovery.regenerate', {});

      await tx.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(req.user.id);
      
      const insertRC = tx.prepare('INSERT INTO recovery_codes (id, user_id, code_hash, created_at) VALUES (?, ?, ?, ?)');
        const rcCreatedAt = new Date().toISOString();
      for (const hash of hashedCodes) {
        await insertRC.run(`rc-${crypto.randomUUID()}`, req.user.id, hash, rcCreatedAt);
      }

      await recordSecurityEvent(tx, req, req.user.id, '2FA_RECOVERY_GENERATED');
    });

    res.json({ success: true, recoveryCodes });
  } catch (err) {
    if (err instanceof ChallengeNotSpent) return refuseReauth(res, err.result || err);
    console.error('Failed to regenerate recovery codes:', err);
    res.status(500).json({ error: 'Failed to regenerate recovery codes' });
  }
});

export default router;
