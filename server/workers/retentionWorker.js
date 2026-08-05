/**
 * Retention enforcement.
 *
 * ── Why this exists, stated plainly ──
 *
 * The Privacy Policy publishes retention periods — messages 3 years, audit logs
 * 1 year, anonymised account shells 3 years — and until this file, nothing
 * deleted anything. Publishing a period you do not enforce is worse than
 * publishing none: it converts an absence into a representation, and under
 * FTC Act §5 a representation about data handling is exactly the kind that gets
 * enforced. This closes that gap rather than describing it.
 *
 * ── What is NEVER swept, and why that is not an oversight ──
 *
 * Certificates and attendance/credited hours are retained INDEFINITELY, by
 * product decision. A service record that expires is worthless precisely when
 * somebody needs it — usually years later, for a college application or a job —
 * and the certificate verification endpoint is a core feature that must keep
 * working after the account is gone. `assertPreservedTablesUntouched` below
 * turns that promise into an assertion rather than a convention, because the
 * failure mode (a future sweep quietly widening) would destroy the one thing
 * this platform exists to build and would be discovered years later by a
 * student who needed it.
 *
 * That indefinite retention is lawful only while no under-13 account can exist
 * — the amended COPPA Rule forbids retaining a child's data indefinitely. The
 * age gate is what licenses it. See migration 008.
 *
 * ── Why the sweep is a pure function taking `now` ──
 *
 * Retention is the one subsystem whose entire behaviour is "what has aged past
 * a boundary", so a test that cannot move the clock cannot test it. `sweep()`
 * takes `now` and a db handle and returns counts; the scheduler below is a thin
 * wrapper that calls it with the real clock. Every boundary case is then an
 * ordinary unit test rather than something that only reproduces in production
 * three years from now.
 */

/** Published periods. Changing one here means changing the Privacy Policy too. */
export const RETENTION = {
  /** Messages: 3 years. The longer end of the stated 1–3 year band, deliberately
   *  — safety investigations surface late, and the extra window protects
   *  students more than it exposes them. */
  messageDays: 3 * 365,
  /** Audit logs: 1 year. The stated band is 90 days to 1 year; 90 days is
   *  shorter than the time it typically takes to discover admin misuse. */
  auditDays: 365,
  /** Anonymised account shells: 3 years after deletion, then the row goes. */
  deletedAccountDays: 3 * 365,
};

const DAY_MS = 86400000;

/** Tables this sweep must never touch. Asserted, not merely intended. */
export const PRESERVED_TABLES = ['certificates', 'attendance', 'hours_ledger'];

function cutoff(now, days) {
  return new Date(now.getTime() - days * DAY_MS).toISOString();
}

/**
 * Counts rows in the preserved tables, so a sweep can prove it left them alone.
 *
 * `hours_ledger` may not exist on a database that has not run the ledger
 * bootstrap yet, so a missing table is treated as zero rather than throwing —
 * the assertion is about the sweep not deleting, not about the schema.
 */
export function preservedCounts(db) {
  const counts = {};
  for (const table of PRESERVED_TABLES) {
    try {
      counts[table] = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
    } catch {
      counts[table] = null;
    }
  }
  return counts;
}

/**
 * One retention pass.
 *
 * Each category is deleted in its own statement inside one transaction: a
 * partial sweep that removed messages but not audit rows would leave the
 * database in a state no published policy describes.
 *
 * Returns what it removed, so the caller can log it and a test can assert it.
 */
export function sweep(db, { now = new Date(), dryRun = false } = {}) {
  const before = preservedCounts(db);

  const messageCutoff = cutoff(now, RETENTION.messageDays);
  const auditCutoff = cutoff(now, RETENTION.auditDays);
  const deletedCutoff = cutoff(now, RETENTION.deletedAccountDays);

  const countable = {
    messages: db.prepare(
      'SELECT COUNT(*) AS c FROM messages WHERE created_at < ?'
    ).get(messageCutoff).c,
    auditLogs: db.prepare(
      'SELECT COUNT(*) AS c FROM admin_audit_logs WHERE created_at < ?'
    ).get(auditCutoff).c,
    deletedAccounts: db.prepare(`
      SELECT COUNT(*) AS c FROM users
      WHERE account_status = 'deleted' AND deleted_at IS NOT NULL AND deleted_at < ?
    `).get(deletedCutoff).c,
  };

  if (dryRun) return { ...countable, dryRun: true };

  db.exec('BEGIN TRANSACTION');
  try {
    /**
     * Messages that are part of a live report are exempt.
     *
     * Deletion must never silently destroy moderation evidence. A conversation
     * under investigation can easily outlive the ordinary retention window —
     * an investigation that started at two years and eleven months would find
     * its evidence deleted underneath it. `conversation_report_messages`
     * snapshots the reported messages, so the exemption is a subquery against
     * it rather than a flag somebody has to remember to set.
     */
    db.prepare(`
      DELETE FROM messages
      WHERE created_at < ?
        AND id NOT IN (SELECT message_id FROM conversation_report_messages)
    `).run(messageCutoff);

    db.prepare('DELETE FROM admin_audit_logs WHERE created_at < ?').run(auditCutoff);

    /**
     * Anonymised shells go last, and only after their dependent rows.
     *
     * `legal_acceptances` is ON DELETE RESTRICT — deliberately, so a hard
     * delete cannot silently take the evidence that somebody agreed to the
     * Terms. Retention is the one place that evidence is genuinely allowed to
     * expire, and it expires WITH the account rather than before it, so the
     * clearing is explicit and scoped here for the same reason the
     * denied-organizer route clears it explicitly.
     *
     * Attendance and certificates are NOT cleared, so the FK from those tables
     * (ON DELETE CASCADE on users) is what would destroy a purged account's
     * service record. That is why shells are only removed once nothing depends
     * on them: the subquery excludes any account that still has attendance or
     * a certificate, which after three years is the normal case for a real
     * volunteer and means their record — under a shortened name — survives.
     */
    const purgeable = db.prepare(`
      SELECT id FROM users
      WHERE account_status = 'deleted'
        AND deleted_at IS NOT NULL
        AND deleted_at < ?
        AND id NOT IN (SELECT DISTINCT user_id FROM attendance)
        AND id NOT IN (SELECT DISTINCT user_id FROM certificates)
    `).all(deletedCutoff).map(r => r.id);

    for (const id of purgeable) {
      db.prepare('DELETE FROM legal_acceptances WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM users WHERE id = ?').run(id);
    }

    db.exec('COMMIT');

    assertPreservedTablesUntouched(db, before);
    return { ...countable, purgedAccounts: purgeable.length };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

/**
 * The promise that certificates and hours are kept for ever, as an assertion.
 *
 * A convention says "do not widen this sweep". An assertion notices when
 * somebody does. The cost of being wrong here is a student discovering, years
 * later, that the record they needed is gone — which is not recoverable and not
 * detectable by any test that only checks what the sweep intended to delete.
 */
export function assertPreservedTablesUntouched(db, before) {
  const after = preservedCounts(db);
  for (const table of PRESERVED_TABLES) {
    if (before[table] === null || after[table] === null) continue;
    if (after[table] !== before[table]) {
      throw new Error(
        `Retention sweep removed ${before[table] - after[table]} row(s) from "${table}". `
        + 'Certificates, attendance and the hours ledger are retained indefinitely by product '
        + 'decision — a service record that expires is worthless exactly when somebody needs it, '
        + 'and certificate verification must keep working after the account is gone. '
        + 'If this period genuinely changed, change the Privacy Policy and this assertion together.'
      );
    }
  }
}

/* ── Scheduler ───────────────────────────────────────────────────────────── */

let timer = null;

/** Once a day is ample: nothing here is time-critical to the hour. */
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function startRetentionWorker(db) {
  if (timer) return;

  const run = () => {
    try {
      const result = sweep(db);
      const removed = result.messages + result.auditLogs + (result.purgedAccounts || 0);
      if (removed > 0) {
        console.log(
          `[Retention] messages=${result.messages} auditLogs=${result.auditLogs} `
          + `purgedAccounts=${result.purgedAccounts}`
        );
        /**
         * Deliberately NOT written to admin_audit_logs.
         *
         * `admin_audit_logs.admin_id` is NOT NULL with a foreign key to
         * `users(id)`, and node:sqlite enables foreign-key enforcement by
         * default — so a synthetic 'system' actor would fail the constraint,
         * and inventing a real system user row to satisfy it would put an
         * account in the users table that nobody can sign in as and that every
         * user-count query would then have to know to exclude.
         *
         * The sweep is also the one actor whose rows this table cannot safely
         * hold anyway: it DELETES from admin_audit_logs, so its own record
         * would eventually delete itself and the count would be a lie.
         * Operational logging is the honest home for it.
         */
      }
    } catch (err) {
      // Never throw from a timer callback: an unhandled rejection here takes
      // the process down for a housekeeping task.
      console.error('[Retention] sweep failed:', err.message);
    }
  };

  timer = setInterval(run, SWEEP_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

export function stopRetentionWorker() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
