/**
 * Suspensions that end on their own.
 *
 * ── What was missing ──
 *
 * `POST /api/admin/users/:id/suspend` took a reason and nothing else, so every
 * suspension this platform could express was permanent until an administrator
 * remembered to lift it by hand. For a school that is the wrong default in both
 * directions: a week-long suspension for something a student did once had to be
 * recorded as indefinite, and the only thing standing between "one week" and
 * "for ever" was somebody's memory.
 *
 * ── Why a column and not a scheduled job that flips the status ──
 *
 * A job is a promise the process has to keep running to honour. If it is down for
 * a day, a student who should be back is still locked out, and nothing about the
 * row says the deadline passed — which is exactly the "fake expiration behaviour"
 * this was asked not to be. Storing the deadline makes the DATA authoritative:
 * `server/suspension.js` treats an elapsed `suspended_until` as not-suspended at
 * the two points where suspension is enforced, so access returns at the moment
 * the clock passes it whether or not any background work ran.
 *
 * The sweep that normalises the row exists too, but it is a tidier, not the
 * mechanism — see `server/suspension.js`.
 *
 * ── Why nullable, and why NULL means indefinite ──
 *
 * NULL is every row that exists today, and it has to keep meaning what those
 * rows have always meant: no end date. A DEFAULT would be a lie about
 * suspensions imposed before this column existed, and a backfill would invent an
 * expiry nobody decided. Indefinite stays available and stays the value a
 * moderator gets by not choosing one.
 *
 * ── Rollback ──
 *
 *     ALTER TABLE users DROP COLUMN suspended_until;
 *     ALTER TABLE users DROP COLUMN suspension_lifted_at;
 *     DELETE FROM schema_migrations WHERE version = 17;
 *
 * Additive only: no table is rebuilt, no existing column is read or rewritten,
 * so the guards ENGINEERING_GUIDE §8.3 requires of a destructive rebuild do not
 * apply.
 */
function up(db) {
  /**
   * Guarded per column: SQLite's ADD COLUMN has no IF NOT EXISTS, and the
   * registry's own idempotency test runs `up` against a database that may
   * already carry them.
   */
  const existing = new Set(db.prepare('PRAGMA table_info(users)').all().map(c => c.name));

  if (!existing.has('suspended_until')) {
    db.exec('ALTER TABLE users ADD COLUMN suspended_until TEXT');
  }

  /**
   * When the suspension stopped applying, whether it expired or was lifted.
   *
   * Separate from clearing `suspended_at`, `suspension_reason` and
   * `suspended_by`, which are deliberately NOT cleared: "this account was
   * suspended in March for this reason" stays true after the suspension ends, an
   * appeal can be reviewed years later, and a moderator looking at a repeat
   * incident needs to know there was a first one. Blanking the reason on lift
   * would destroy the only record of why — the audit row is swept at 365 days.
   */
  if (!existing.has('suspension_lifted_at')) {
    db.exec('ALTER TABLE users ADD COLUMN suspension_lifted_at TEXT');
  }
}

export default { version: 17, name: 'timed_suspension', up, fileUrl: import.meta.url };
