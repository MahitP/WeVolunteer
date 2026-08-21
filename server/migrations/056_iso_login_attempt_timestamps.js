/**
 * 056 — `tfa_login_attempts.last_attempt_at` becomes ISO-8601, like every other
 * timestamp in this schema.
 *
 * ── Why this column was different, and why that has to end ──
 *
 * It was written as SQLite's `datetime('now')` — `2026-08-16 17:53:04` — and
 * compared in SQL against `datetime('now', '-15 minutes')`. Self-consistent, and
 * the only column in the schema that does not hold the `2026-08-16T17:53:04.120Z`
 * the application writes everywhere else.
 *
 * PostgreSQL has no `datetime()`. The replacement binds a JS timestamp, so the
 * comparison value arrives as ISO-8601 — and ISO-8601 does not compare correctly
 * against the stored SQLite form. The two disagree at position 10, where the old
 * format has a space (0x20) and the new one has `T` (0x54), so **an unconverted
 * row sorts below every same-day cutoff however recent it is**. A failure from
 * thirty seconds ago reads as older than fifteen minutes and leaves the window.
 *
 * The consequence is a rate limit that silently empties on the day of the
 * deploy: everyone part-way through guessing a second factor gets their budget
 * back. (Rows from an earlier DATE are excluded before and after — the date
 * digits differ long before position 10 — so the harm is confined to exactly the
 * rows that should still count.)
 *
 * So the stored rows must move to the same format as the comparison, and both
 * must move together. This migration is the "together".
 *
 * ── Why the rows are converted rather than discarded ──
 *
 * Deleting them would be simpler and is nearly harmless — the window is fifteen
 * minutes, so all but the newest rows are already spent. Nearly. The rows inside
 * the window are an in-progress rate limit, and dropping them produces precisely
 * the free reset described above rather than avoiding it. Converting keeps the
 * limiter continuous across the upgrade.
 *
 * ── Idempotence ──
 *
 * A row already in ISO-8601 contains a `T` at position 11 and is left alone, so
 * a second run converts nothing. That test is on the DATA rather than on a
 * schema marker because this migration changes no schema: a half-applied run
 * (interrupted between rows) has to be resumable, and only the data can say
 * which rows are done.
 */
export default {
  version: 56,
  name: 'iso_login_attempt_timestamps',
  fileUrl: import.meta.url,

  up(db) {
    const table = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tfa_login_attempts'"
    ).get();
    /* Absent on a database that predates migration 025. Nothing to convert, and
       the table will be created in the new format. */
    if (!table) return;

    const columns = db.prepare('PRAGMA table_info(tfa_login_attempts)').all();
    if (!columns.some(c => c.name === 'last_attempt_at')) return;

    /**
     * `datetime(x)` re-parses the stored value and `strftime` renders it in the
     * application's format — a conversion SQLite can do in one statement and
     * that JS would need a row-by-row round trip for.
     *
     * The `NOT LIKE '%T%'` clause is the idempotence test. It also protects the
     * one case where re-running WOULD corrupt: `datetime()` given an ISO-8601
     * string with milliseconds silently drops them, so a second pass over an
     * already-converted row would rewrite `…:04.120Z` as `…:04.000Z`.
     */
    const converted = db.prepare(`
      UPDATE tfa_login_attempts
         SET last_attempt_at = strftime('%Y-%m-%dT%H:%M:%S.000Z', datetime(last_attempt_at))
       WHERE last_attempt_at IS NOT NULL
         AND last_attempt_at NOT LIKE '%T%'
    `).run();

    /* Rows `datetime()` could not parse come back NULL, which would make them
       invisible to the window check — the safe direction (an attempt that no
       longer counts) but not a silent one. There should be none; if there are,
       the count says so. */
    const unparseable = db.prepare(
      'SELECT COUNT(*) AS n FROM tfa_login_attempts WHERE last_attempt_at IS NULL'
    ).get().n;

    if (converted.changes > 0 || unparseable > 0) {
      console.log(
        `Migration 056: ${converted.changes} login-attempt timestamp(s) converted to ISO-8601`
        + (unparseable > 0 ? `; ${unparseable} unparseable row(s) left NULL` : '')
      );
    }
  },
};
