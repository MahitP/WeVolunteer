import crypto from 'crypto';
import { verifySync } from 'otplib';
import { TFA_ENCRYPTION_KEY } from './config.js';

/**
 * Encrypts a plaintext TOTP secret for storage in the database.
 * 
 * Uses AES-256-GCM. The returned string is formatted as:
 * v1:{base64(iv)}:{base64(authTag)}:{base64(ciphertext)}
 * 
 * @param {string} plaintext - The plaintext string to encrypt.
 * @returns {string} The versioned encrypted payload.
 */
export function encryptSecret(plaintext) {
  if (!plaintext) throw new Error('encryptSecret: plaintext is required');
  // The key must be 32 bytes. config.js enforces this at startup.
  const key = Buffer.from(TFA_ENCRYPTION_KEY, 'base64');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  
  let ciphertext = cipher.update(plaintext, 'utf8', 'base64');
  ciphertext += cipher.final('base64');
  const authTag = cipher.getAuthTag().toString('base64');
  
  return `v1:${iv.toString('base64')}:${authTag}:${ciphertext}`;
}

/**
 * Decrypts a previously encrypted TOTP secret from the database.
 * 
 * Extracts the IV and authentication tag from the payload to verify integrity.
 * 
 * @param {string} encryptedData - The versioned encrypted payload.
 * @returns {string} The plaintext secret.
 */
export function decryptSecret(encryptedData) {
  if (!encryptedData) throw new Error('decryptSecret: encryptedData is required');
  
  const parts = encryptedData.split(':');
  
  // Explicitly fail if it's not the encrypted format. 
  // We do not silently fall back to plaintext. The migration script will 
  // handle identifying unencrypted vs encrypted.
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('decryptSecret: Invalid encrypted secret format or unsupported version');
  }
  
  const [, ivStr, authTagStr, ciphertextStr] = parts;
  const key = Buffer.from(TFA_ENCRYPTION_KEY, 'base64');
  const iv = Buffer.from(ivStr, 'base64');
  const authTag = Buffer.from(authTagStr, 'base64');
  
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  
  let plaintext = decipher.update(ciphertextStr, 'base64', 'utf8');
  plaintext += decipher.final('utf8');
  
  return plaintext;
}

/**
 * Whether `token` is the current TOTP code for `encryptedSecret`.
 *
 * ── Why this exists rather than calling otplib directly ──
 *
 * `verifySync` from otplib v13 returns an OBJECT, not a boolean:
 *
 *     verifySync({ token: correct, secret })  →  { valid: true,  delta: 0, … }
 *     verifySync({ token: wrong,   secret })  →  { valid: false }
 *
 * Both are truthy. All three call sites in this codebase did
 *
 *     isValid = verifySync({ token, secret });
 *     if (!isValid) throw new Error('Invalid token');
 *
 * so `isValid` was an object every time and the check never fired. The
 * consequences, in ascending order of severity: enrolment could be confirmed
 * with a code the authenticator never showed; 2FA could be DISABLED by anyone
 * holding the session with any six digits; and, at `POST /api/auth/login-2fa`,
 * the second factor accepted ANY six-digit string — so an attacker with a stolen
 * password was not slowed down at all, while the account holder believed they
 * were protected. A second factor that always says yes is worse than none,
 * because it is the reason somebody reuses a password.
 *
 * So the raw call is wrapped once, here, in a function whose return type cannot
 * be misread. Nothing outside this module should import `verifySync`.
 *
 * Returns FALSE rather than throwing on a malformed token, an undersized secret,
 * or a decryption failure. Every caller's answer to "I could not check this" is
 * the same as its answer to "this is wrong", and making them handle two failure
 * shapes is how one of them ends up handling neither.
 */
/**
 * How much clock skew a code may carry, in SECONDS, as `[past, future]`.
 *
 * ── Why this is no longer zero ──
 *
 * It was `epochTolerance: 0` — only the current 30-second step, no grace at all —
 * and that rejected CORRECT codes. Three things push a submitted code into the
 * past, and they add up: the user's own typing time, network latency, and this
 * server's processing before the check (`/api/2fa/enable` spent about a second
 * hashing recovery codes before verifying, until that was reordered). A code
 * typed in the last second of a step was routinely checked in the next one. It
 * was measured: an enrolment test failed roughly one run in three on a code that
 * was right when it was typed.
 *
 * A second factor that rejects a correct code is not "strict", it is broken —
 * and it teaches people that 2FA is unreliable, which is how they end up turning
 * it off.
 *
 * ── Why PAST only, and not the symmetric ±30 ──
 *
 * Every cause above makes the code OLDER than "now", never newer; a future code
 * can only come from a clock genuinely running ahead, which is a user-side
 * misconfiguration rather than a normal condition. otplib's own documentation
 * labels the asymmetric past-only form the RFC-compliant one, and accepting one
 * step instead of two halves the widening for no loss in the cases that actually
 * occur. `[30, 0]` is one previous step and nothing from the future.
 *
 * ── Why this is not a net weakening ──
 *
 * On its own, accepting two steps instead of one would double the window in which
 * an intercepted code can be replayed, and RFC 6238 §5.2 requires a verifier to
 * refuse a second use of the same code. Nothing here did.
 *
 * So the tolerance ships WITH replay protection: `verifyTotpStep` returns the
 * counter it matched, and every call site records the highest counter accepted for
 * that account and refuses anything at or below it (`users.tfa_last_counter`). A
 * code is therefore usable exactly once, which it was not before — the window is
 * wider and the guarantee is stronger.
 *
 * Guessing is unaffected in any way that matters: the bound is the attempt
 * counters (five per pre-auth token, twenty per account per quarter hour), not the
 * window, so this moves an attacker from one-in-a-million per guess to
 * two-in-a-million against a five-guess cap.
 */
const TOTP_EPOCH_TOLERANCE = [30, 0];

/**
 * Verifies a code and reports WHICH time step it matched.
 *
 * Returns `{ valid: false }` or `{ valid: true, counter }`. The counter is what
 * makes single-use enforcement possible: a caller compares it against the highest
 * one it has already accepted for that account, so the same code cannot be
 * presented twice even inside its own validity window.
 *
 * Kept separate from `verifyTotp` below rather than replacing it: the boolean form
 * is the right shape for a caller that has no account context to record against,
 * and collapsing the two would push a `{valid}` object back into the `if (!x)`
 * shape whose misreading is the whole reason this module exists.
 */
export function verifyTotpStep(token, encryptedSecret) {
  if (typeof token !== 'string' || !/^\d{6}$/.test(token.trim())) return { valid: false };
  if (!encryptedSecret) return { valid: false };

  try {
    const secret = decryptSecret(encryptedSecret);
    const result = verifySync({
      token: token.trim(),
      secret,
      epochTolerance: TOTP_EPOCH_TOLERANCE,
    });
    if (result?.valid !== true) return { valid: false };

    /* `timeStep` is the counter otplib matched. Falling back to a computed
       current step keeps this defined if a future version stops reporting it —
       a missing counter must not become `undefined` and silently disable the
       replay check at every call site. */
    const counter = Number.isFinite(result.timeStep)
      ? result.timeStep
      : Math.floor(Date.now() / 1000 / 30);
    return { valid: true, counter };
  } catch {
    return { valid: false };
  }
}

export function verifyTotp(token, encryptedSecret) {
  return verifyTotpStep(token, encryptedSecret).valid === true;
}
