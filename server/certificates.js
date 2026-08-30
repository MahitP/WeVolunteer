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
import { isUniqueViolation } from './db/dialectSql.js';

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
      /* `isUniqueViolation` rather than a message match: the string this tested
         for ("UNIQUE constraint failed") is SQLite's. PostgreSQL says "duplicate
         key value violates unique constraint" in lower case, so on PostgreSQL
         NEITHER collision was recognised and both re-threw — turning a retryable
         code clash, and a concurrent duplicate that the re-select below already
         handles, into a failed certificate issuance. */
      if (!isUniqueViolation(err)) throw err;
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
 * The codes for a whole page of one volunteer's events, in one query where it
 * can be one query.
 *
 * ── What this replaces, and what it measured ──
 *
 * `GET /api/certificates` called `getOrCreateCertificateCode` once per event
 * inside a `Promise.all`. In the steady state that is one SELECT per event; for
 * an event with no certificate yet it is four statements. A volunteer's list
 * grows for as long as they volunteer, so the cost of the page grows with their
 * service record — the one number on this platform that is supposed to go up.
 *
 * Measured with `bin/load-test.mjs --db-latency 5`, against a student with 80
 * completed events: **p50 914 ms, 20.8 req/s**. The `Promise.all` also made it a
 * pool problem rather than only a latency one — eighty concurrent statements per
 * request against a pool of ten, so twenty simultaneous readers queued sixteen
 * hundred statements.
 *
 * ── Why the minting path is NOT reimplemented here ──
 *
 * Everything that decides what a certificate IS stays in
 * `getOrCreateCertificateCode`: that an issued certificate is returned
 * unconditionally whatever became of the event, that a cancelled event never
 * mints a new one, the collision retry, and the re-select that guarantees the
 * returned value is what is stored. Each of those is a published policy position
 * with a test behind it, and a second copy would be a second thing to get wrong.
 *
 * So this batches the READ and delegates every WRITE. After the boot backfill
 * has run — which issues a row for every credited attendance — the common case
 * is that every code already exists and this costs exactly one statement.
 *
 * Returns a `Map` from event id to code. An event with no code and no way to get
 * one (cancelled) is simply absent, matching `getOrCreateCertificateCode`'s
 * `null`.
 */
export async function certificateCodesFor(db, userId, eventIds) {
  const codes = new Map();
  const ids = [...new Set(eventIds)].filter(Boolean);
  if (!ids.length) return codes;

  const marks = ids.map(() => '?').join(',');
  for (const row of await db.prepare(
    `SELECT event_id, code FROM certificates WHERE user_id = ? AND event_id IN (${marks})`
  ).all(userId, ...ids)) {
    codes.set(row.event_id, row.code);
  }

  /* Whatever is left needs issuing, one at a time and through the real path.
     Sequential rather than concurrent on purpose: this is a write, it is rare
     after the backfill, and a `Promise.all` of writes is what made the read
     expensive in the first place. */
  for (const eventId of ids) {
    if (codes.has(eventId)) continue;
    const code = await getOrCreateCertificateCode(db, userId, eventId);
    if (code) codes.set(eventId, code);
  }

  return codes;
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
  /**
   * Only the pairs that still NEED a certificate, in one query.
   *
   * This used to select every credited (user, event) pair and then ask, one
   * statement at a time, whether each already had a certificate. On the second
   * and every subsequent boot the answer is "yes" for all of them, so the cost
   * of discovering there was nothing to do was one statement per credited
   * attendance row — and this runs on the boot path, before the server listens.
   *
   * On `node:sqlite` that was cheap enough not to notice. On PostgreSQL each one
   * is a round trip: at 5 ms and fifty thousand attendance rows it is four
   * minutes of boot spent learning that the work was already done.
   *
   * `NOT EXISTS` rather than a `LEFT JOIN … IS NULL`, because the certificates
   * table's uniqueness is on the pair and this reads as the question being
   * asked. The per-pair issuing path below is unchanged: everything that decides
   * what a certificate is stays in `getOrCreateCertificateCode`.
   */
  const pairs = await db.prepare(`
    SELECT DISTINCT a.user_id, a.event_id
      FROM attendance a
     WHERE a.present = 1
       AND NOT EXISTS (
             SELECT 1 FROM certificates c
              WHERE c.user_id = a.user_id AND c.event_id = a.event_id
           )
  `).all();

  let inserted = 0;
  for (const { user_id, event_id } of pairs) {
    /* `getOrCreateCertificateCode` returns null for a cancelled event, which is
       the published rule and not an error. Counting only what was actually
       issued keeps the boot log's number honest — it used to count refusals as
       insertions. */
    const code = await getOrCreateCertificateCode(db, user_id, event_id);
    if (code) inserted++;
  }

  return { inserted };
}
