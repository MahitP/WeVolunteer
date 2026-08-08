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
export function verifyTotp(token, encryptedSecret) {
  if (typeof token !== 'string' || !/^\d{6}$/.test(token.trim())) return false;
  if (!encryptedSecret) return false;

  try {
    const secret = decryptSecret(encryptedSecret);
    const result = verifySync({ token: token.trim(), secret });
    return result?.valid === true;
  } catch {
    return false;
  }
}
