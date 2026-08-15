import crypto from 'node:crypto';

/**
 * The one-way digest used for credentials that live in a table.
 *
 * ── What this is for ──
 *
 * A verification link, a password-reset link and an email-change link are all
 * bearer credentials: whoever holds the string can use it. They were stored in
 * the database verbatim, which meant that anybody who could read the database —
 * a stray backup, a support query pasted into a chat, an SQL injection
 * elsewhere, a stolen laptop with the file on it — could take over any account
 * with an outstanding reset, without knowing a single password.
 *
 * Storing the digest instead means the table holds no usable credential. The
 * link in somebody's inbox still works; a copy of the table does not.
 *
 * ── Why SHA-256 and not bcrypt ──
 *
 * These are not passwords. A password is short, human-chosen and low-entropy,
 * so it needs a deliberately slow hash to make guessing expensive. These tokens
 * are 32 bytes from `crypto.randomBytes` — 256 bits of uniform entropy. There
 * is nothing to guess: an attacker with the digest cannot work backwards, and
 * brute force is not a consideration at that size no matter how fast the hash
 * is.
 *
 * SHA-256 also stays a plain indexed lookup. bcrypt would force a table scan
 * with a comparison per row on every verification click, because a bcrypt
 * digest is salted and therefore not equal to itself twice — which is correct
 * for passwords and useless for a primary key. `admin_invitations` in this same
 * codebase already made this call, and `checkin_tokens` after it; this matches
 * both.
 *
 * ── Why the column is named `token_hash` ──
 *
 * Migration 048 renames the column rather than quietly changing what is stored
 * in a column still called `token`. A future edit that writes a plaintext token
 * then fails loudly with "no such column" instead of silently reopening the
 * hole this closed.
 */
export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** A fresh 32-byte token, and the digest to file against it. */
export function issueToken() {
  const token = crypto.randomBytes(32).toString('hex');
  return { token, tokenHash: hashToken(token) };
}
