/**
 * Migration 021: Administrator Promotion Metadata
 *
 * Records when, by whom, and why an account was promoted to administrator.
 *
 * ── Why this is stored rather than derived ──
 *
 * The promotion is already written to `admin_audit_logs`, and for most questions
 * that is the better source. But the audit trail is swept at 365 days, and an
 * administrator's tenure routinely outlasts that. Without these columns, the
 * answer to "why does this person have administrative access" expires a year
 * after it was decided, while the access continues.
 *
 * They are cleared on revocation, so they describe the CURRENT grant only. The
 * history of grants and revocations lives in the audit trail, which is where a
 * history belongs.
 */

/**
 * Guarded per column: SQLite's ADD COLUMN has no IF NOT EXISTS, and the
 * registry's idempotency test runs `up` against a database that may already
 * carry them. The original version of this migration issued three bare
 * ALTER TABLE statements and would throw on a second application.
 */
function addColumn(db, table, column, type) {
  const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
  if (!existing.has(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

export default {
  version: 21,
  name: 'administrator_promotion_metadata',
  fileUrl: import.meta.url,

  up(db) {
    addColumn(db, 'users', 'promoted_at', 'TEXT');
    /**
     * Deliberately NOT a foreign key to `users`.
     *
     * This is a record of who made a decision, and Volume I §1.7.5 is explicit
     * that a record of an event must not be deleted with the subject of that
     * event. A foreign key here would either block the owner's deletion or, with
     * a cascade, quietly erase the attribution — and "promoted by nobody" is a
     * worse answer than a dangling id.
     */
    addColumn(db, 'users', 'promoted_by', 'TEXT');
    addColumn(db, 'users', 'promotion_reason', 'TEXT');
  },
};
