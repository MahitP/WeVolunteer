/**
 * Email-confirmation tokens.
 *
 * Extracted from authRoutes so the OAuth callback can mint one too — a
 * Microsoft sign-up arrives with an address no one has proven control of, and
 * has to confirm it exactly like a form sign-up does.
 */

import { db } from '../db.js';
import { runInTransaction } from '../db/connectionContext.js';
import { issueToken } from '../tokenDigest.js';
import { sendVerificationEmail } from '../email.js';

/** How long a confirmation link stays good. */
export const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Issues a fresh confirmation token, invalidating any previous one.
 *
 * One live token per user, deliberately: pressing "resend" three times should
 * leave exactly one working link, not three. Otherwise every link ever mailed
 * stays usable until it ages out, which widens the window on a token that
 * reached the wrong inbox.
 */
export async function issueVerificationToken(userId) {
  /* Only the digest is filed. The plaintext is returned to this caller, goes
     into the email, and is never written down — so the table holds nothing
     anybody could sign in with. */
  const { token, tokenHash } = issueToken();
  const expiresAt = new Date(Date.now() + VERIFICATION_TTL_MS).toISOString();

  /**
   * The DELETE and the INSERT are one operation, stated rather than assumed.
   *
   * ── What was holding the invariant up, and what it is now ──
   *
   * "One live token per user" is not enforced by the schema. The table is keyed
   * on `token_hash` alone; there is no unique constraint on `user_id`. So the
   * rule above survived only because these two statements ran back to back in a
   * synchronous handler with nothing able to interleave.
   *
   * That is a guarantee this migration removes. With an `await` anywhere between
   * them — or a connection pool underneath — two concurrent "resend" presses can
   * both DELETE, then both INSERT, and the account ends up with **two live
   * tokens**. Every link ever mailed stays usable until it ages out, which is
   * exactly the window the one-token rule exists to close, and nothing would
   * report it: both requests succeed, both emails arrive, both links work.
   *
   * Wrapping the pair makes the atomicity explicit and engine-independent. It
   * changes nothing on SQLite today, where the statements were already
   * uninterruptible; it is what keeps them uninterruptible afterwards.
   *
   * Deliberately NOT solved with a unique index on `user_id`. That would be a
   * schema change with its own migration and would turn a concurrent resend into
   * a constraint violation the caller must handle, rather than into the
   * last-writer-wins behaviour the feature already has.
   */
  await runInTransaction(db, async (tx) => {
    await tx.prepare('DELETE FROM email_verification_tokens WHERE user_id = ?').run(userId);
    await tx.prepare('INSERT INTO email_verification_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(tokenHash, userId, expiresAt);
  });

  return token;
}

/**
 * Mails a confirmation link without making the caller wait for SMTP.
 *
 * Sending is best-effort on purpose: a slow or down mail server must not turn
 * a successful sign-up into a 500 with an orphaned account. The user always
 * has "resend" available, and the failure is logged.
 */
export function sendVerificationMail(email, token) {
  sendVerificationEmail(email, token).catch(err =>
    console.error(`Verification email to ${email} failed to send:`, err)
  );
}

/** Drops confirmation tokens that have aged out. */
export async function purgeExpiredVerificationTokens() {
  try {
    const { changes } = await db.prepare('DELETE FROM email_verification_tokens WHERE expires_at < ?')
      .run(new Date().toISOString());
    return changes;
  } catch (err) {
    console.error('Failed to purge expired verification tokens:', err);
    return 0;
  }
}
