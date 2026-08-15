/**
 * Per-volunteer check-in codes, and the provenance of a check-in mark.
 *
 * ── Why a row, and not a signature ──
 *
 * The obvious design is an HMAC: sign `(slot, user, expiry)` and verify it with
 * a secret, storing nothing. It does not work here, because a code has to be
 * single-use. Knowing a code has been spent requires a record of the spending,
 * so an HMAC design is "a table, plus a new fail-closed secret, plus a canonical
 * signing string, plus a constant-time comparison, plus a rotation story", and
 * this design is "a table". The signature buys nothing the table does not
 * already give.
 *
 * Two reasons specific to this repository make it worse than neutral. A new
 * signing secret is a new way for production to fail to boot, guarding a
 * five-minute mark that credits no hours. And there is no `timingSafeEqual`
 * anywhere in this codebase and no guard that would notice its absence — so a
 * future edit writing `a === b` reintroduces a timing side channel silently. A
 * hashed row has no comparison to get wrong: the lookup is a unique-index probe
 * on a value derived from 256 bits of entropy.
 *
 * This mirrors `adminInvitations`, which guards administrator authority the
 * same way: random token out, SHA-256 at rest, uniform failure.
 *
 * ── Reversal ──
 *
 *   DROP TABLE checkin_tokens;
 *
 * `attendance_checkin.method` cannot be dropped without a table rebuild, and it
 * is harmless to leave: it defaults to 'manual' and nothing reads it if the
 * feature is withdrawn.
 */

function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS checkin_tokens (
      id             TEXT PRIMARY KEY,
      token_hash     TEXT NOT NULL UNIQUE,
      application_id TEXT NOT NULL,
      event_id       TEXT NOT NULL,
      slot_id        TEXT NOT NULL,
      user_id        TEXT NOT NULL,
      status         TEXT NOT NULL CHECK(status IN ('pending', 'used', 'replaced')),
      created_at     TEXT NOT NULL,
      expires_at     TEXT NOT NULL,
      resolved_at    TEXT,
      resolved_by    TEXT
    )
  `);

  /**
   * At most one live code per signup.
   *
   * Refreshing must retire the previous code atomically, or a photograph taken
   * a minute ago stays valid for the rest of its five minutes — which is
   * exactly what single-use exists to prevent. Without this index, "UPDATE the
   * old, INSERT the new" is a race whose failure mode is two live codes for one
   * volunteer, and it would never show up in testing.
   */
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_checkin_tokens_live
      ON checkin_tokens(application_id) WHERE status = 'pending'
  `);

  /* The sweep's range scan. */
  db.exec('CREATE INDEX IF NOT EXISTS idx_checkin_tokens_expiry ON checkin_tokens(expires_at)');

  /**
   * How a check-in mark was taken.
   *
   * The QR design's accepted residual risk is a volunteer relaying a live code
   * to somebody who is not there. An accepted risk that cannot be investigated
   * afterwards is not accepted, it is ignored — so an organizer asked "were
   * those six really here?" has to be able to tell a scanned mark from one they
   * typed. That distinction is the whole of the answer.
   *
   * Additive, so no rebuild, and every pre-existing row is truthfully 'manual'
   * because there was no other path. SQLite cannot add a CHECK constraint by
   * ALTER TABLE and rebuilding `attendance_checkin` is out of scope, so the
   * enum is enforced in `recordCheckins` instead. Noted as debt alongside the
   * existing "this table has no foreign keys" debt.
   */
  const columns = db.prepare('PRAGMA table_info(attendance_checkin)').all();
  if (!columns.some(c => c.name === 'method')) {
    db.exec("ALTER TABLE attendance_checkin ADD COLUMN method TEXT NOT NULL DEFAULT 'manual'");
  }
}

export default {
  version: 37,
  name: 'checkin_tokens',
  up,
  fileUrl: import.meta.url,
};
