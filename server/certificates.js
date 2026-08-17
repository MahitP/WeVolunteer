/**
 * Certificates — random, stored verification codes for completed service.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 *
 * The code used to be derived deterministically from a user id and an event
 * id (a hash, not a secret), computable offline by anyone who could guess or
 * enumerate those two ids. Handed to the public, unauthenticated,
 * unrate-limited verify endpoint, that hash was enough to pull a minor's
 * name, grade, and hours. It was never a secret — it just looked like one.
 *
 * A certificate code is now a cryptographically random value, generated once
 * per (user, event) and stored. Knowing a user id and an event id no longer
 * gets you anywhere; you have to have been given the code (e.g. handed a
 * printout) to look anything up. That is the intended trust model: the code
 * is a bearer credential for "someone in possession of this printout",
 * nothing more.
 *
 * ── What this deliberately does not touch ───────────────────────────────
 *
 * `attendance` remains the single source of truth for whether a shift counts
 * and how many hours it is worth. This module only reads it (to know which
 * (user, event) pairs need a code) and never writes to it.
 */

import crypto from 'crypto';

// Crockford base32, minus 0/O/1/I to avoid visual ambiguity on a printout.
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/**
 * Creates the certificates table.
 *
 * UNIQUE(code) already creates its own index, so a code lookup
 * (`WHERE code = ?`) is indexed without a separate CREATE INDEX statement.
 */
export function createCertificatesTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS certificates (
      user_id    TEXT NOT NULL,
      event_id   TEXT NOT NULL,
      code       TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      PRIMARY KEY(user_id, event_id)
    )
  `);
}

/**
 * A random `WEV-XXXX-XXXX` code. Uses `crypto.randomBytes`, never
 * `Math.random` — this value is a bearer credential, so it has to be
 * unguessable, not merely well-distributed.
 *
 * 5 random bytes (40 bits) give 8 base32 characters, one nibble-and-a-bit
 * short of an even split; taking each byte mod 32 sacrifices a small, fixed
 * amount of uniformity for simplicity, which is fine at this entropy budget
 * (~34 bits after the mod-32 rounding, still well beyond guessable).
 */
function generateCode() {
  const bytes = crypto.randomBytes(5); // 40 bits -> 8 base32-ish characters
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);

  // 40 bits split into 8 groups of 5 bits, most-significant group first.
  let chars = '';
  for (let i = 7; i >= 0; i--) {
    const idx = Number((bits >> BigInt(i * 5)) & 0x1fn);
    chars += ALPHABET[idx % ALPHABET.length];
  }

  return `WEV-${chars.slice(0, 4)}-${chars.slice(4, 8)}`;
}

/**
 * Returns the stored code for (userId, eventId), creating one if it doesn't
 * exist yet. Stable: the same certificate always returns the same code.
 *
 * On the astronomically unlikely event of a code collision with a different
 * certificate, the UNIQUE(code) insert fails and a fresh code is generated
 * and retried, rather than the row silently failing to appear.
 */
export async function getOrCreateCertificateCode(db, userId, eventId) {
  const existing = await db.prepare(
    'SELECT code FROM certificates WHERE user_id = ? AND event_id = ?'
  ).get(userId, eventId);
  /**
   * An issued certificate is returned unconditionally, whatever became of the
   * event afterwards.
   *
   * That is not an oversight, it is the published position:
   * `06-certificate-verification-policy.md` states "There is no option to void
   * a certificate", keeps the drafted voiding text behind a `[[NOT YET BUILT]]`
   * marker that blocks publication, and couples it to the Data Deletion Policy
   * and the Privacy Policy. Revoking one here would make three published
   * documents false and would be a policy change, not a bug fix.
   */
  if (existing) return existing.code;

  /**
   * A certificate is never ISSUED for an event that was called off.
   *
   * Cancelling is not archiving. `PATCH /api/events/:id/status` notifies every
   * confirmed volunteer with `EVENT_CANCELLED` because "they may have arranged
   * a ride around it" — it means the event is not happening. Attendance rows
   * can survive it (the update deliberately refuses to delete them), and this
   * function is reached from the boot backfill and from the certificates list,
   * so without this guard a called-off event mints a fresh credential on the
   * next start. Verified before writing this: it did.
   *
   * The platform now counts that event as zero hours and keeps it off the
   * transcript. Issuing a verification code asserting a college can check that
   * the service happened would be the platform contradicting itself, in the one
   * artifact that leaves it.
   *
   * Returning null rather than throwing: the callers are a boot task and a list
   * endpoint, and neither should fail because one row is ineligible.
   */
  const event = await db.prepare('SELECT status FROM events WHERE id = ?').get(eventId);
  if (event?.status === 'cancelled') return null;

  const insert = await db.prepare(
    'INSERT INTO certificates (user_id, event_id, code, created_at) VALUES (?, ?, ?, ?)'
  );

  const MAX_ATTEMPTS = 5;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const code = generateCode();
    try {
      await insert.run(userId, eventId, code, new Date().toISOString());
      break;
    } catch (err) {
      // A UNIQUE(user_id, event_id) collision means someone else created this
      // exact certificate's row between our SELECT and INSERT — the row that
      // exists now is authoritative, so stop trying to insert our own.
      // A UNIQUE(code) collision means our random code happens to already
      // belong to a different certificate — regenerate and retry.
      if (!String(err.message).includes('UNIQUE')) throw err;
    }
  }

  // Re-select regardless of which branch above fired, so the value returned
  // is always what's actually stored (stable per certificate).
  const row = await db.prepare(
    'SELECT code FROM certificates WHERE user_id = ? AND event_id = ?'
  ).get(userId, eventId);

  if (!row) {
    // Only reachable if every attempt above collided on code AND none of
    // those collisions was our own row — vanishingly unlikely at this
    // entropy budget, but fail loudly rather than return undefined.
    throw new Error(`Failed to issue a certificate code for ${userId}/${eventId} after ${MAX_ATTEMPTS} attempts`);
  }

  return row.code;
}

/**
 * Issues a certificate row for every distinct (user_id, event_id) with
 * credited attendance that doesn't have one yet. Idempotent: a second run
 * finds nothing left to do and returns `{ inserted: 0 }`.
 *
 * Never writes to `attendance`. Runs at boot, mirroring the hours-ledger
 * backfill.
 */
export async function backfillCertificates(db) {
  const pairs = await db.prepare(`
    SELECT DISTINCT user_id, event_id FROM attendance WHERE present = 1
  `).all();

  let inserted = 0;
  for (const { user_id, event_id } of pairs) {
    const before = await db.prepare(
      'SELECT 1 FROM certificates WHERE user_id = ? AND event_id = ?'
    ).get(user_id, event_id);
    if (before) continue;

    await getOrCreateCertificateCode(db, user_id, event_id);
    inserted++;
  }

  return { inserted };
}
