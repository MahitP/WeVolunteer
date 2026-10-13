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

import { runInTransaction } from '../db/connectionContext.js';
import { RETAINABLE_MESSAGE_PREDICATE, userIsPartyToLiveReport } from '../evidenceHolds.js';
import { recordError } from '../errorReporter.js';
import { withLease, LEASES } from '../schedulerLease.js';

/** Published periods. Changing one here means changing the Privacy Policy too. */
export const RETENTION = {
  /** Messages: 3 years. The longer end of the stated 1–3 year band, deliberately
   *  — safety investigations surface late, and the extra window protects
   *  students more than it exposes them. */
  messageDays: 3 * 365,
  /** Audit logs: 1 year. The stated band is 90 days to 1 year; 90 days is
   *  shorter than the time it typically takes to discover admin misuse. The
   *  two-factor security records (`security_audit_logs`) share this period. */
  auditDays: 365,
  /** Anonymised account shells: 3 years after deletion, then the row goes. */
  deletedAccountDays: 3 * 365,
  /**
   * Applications: 3 years after the EVENT, not after the application.
   *
   * The Privacy Policy has published this period since v2.0 and nothing enforced it.
   * The only `DELETE FROM applications` statements in the codebase were the event and
   * slot cascades in `eventRoutes.js`, so an application to an event from five years
   * ago was retained for ever — in a table whose own preamble says "these periods are
   * enforced by a job that runs every day".
   *
   * ── Which timestamp controls it ──
   *
   * The end of the event's last slot, with `applications.applied_at` as the fallback
   * for an event that has no slots. Three candidates, and the choice matters:
   *
   *   - `applied_at` alone is wrong. A student who applies to an event two years out
   *     would have their application deleted before the event happened, taking the
   *     organizer's roster with it. The policy says "after the event".
   *   - `events.status = 'completed'` depends on an organizer remembering to set it.
   *     An abandoned event never completes, so its applications would be kept for
   *     ever — the least privacy-preserving option available.
   *   - `MAX(slots.end_datetime)` is derived from data rather than from anyone's
   *     diligence, cannot be forgotten, means literally "after the event", and
   *     deletes at the earliest moment the published policy allows.
   *
   * The fallback exists for the same privacy reason: an event with no slots never
   * happened, and without one its applications would have no cutoff at all.
   *
   * ── What this cannot damage ──
   *
   * `attendance` has no foreign key to `applications` — it keys on
   * (event_id, slot_id, user_id) — so credited hours and certificates are untouched
   * by construction, and `assertPreservedTablesUntouched` still proves it after every
   * sweep. `application_conflicts` cascades from `applications`, which is correct: a
   * scheduling conflict about a deleted application describes nothing.
   */
  applicationDays: 3 * 365,
};

const DAY_MS = 86400000;

/**
 * Tables this sweep must never touch. Asserted, not merely intended.
 *
 * The three safety tables joined the original three in v1.2c. They are a
 * different kind of preserved: certificates and hours are kept because a student
 * needs them years later, reports and their snapshots because an investigation
 * does — and because the party most motivated to destroy them is the party they
 * are about. Migration 011 makes them undeletable at the database level; naming
 * them here means a sweep that somehow removed one fails loudly instead of
 * succeeding quietly, which is the failure mode nobody would notice.
 */
export const PRESERVED_TABLES = [
  'certificates', 'attendance', 'hours_ledger',
  'reports', 'conversation_reports', 'conversation_report_messages',
  /**
   * The adjudication record, added with migration 015.
   *
   * A suspension is permanent by default and appealable years later. Until now
   * the only durable trace of an appeal decision was an `admin_audit_logs` row,
   * and this worker sweeps that table at 365 days — so on day 366 a permanently
   * suspended student's entire due-process record was the word 'stands' in a
   * column, with no statement, no reasons and no reviewer. These three tables
   * hold the answer to "who decided what, on what evidence, when", which is the
   * question a parent or a district asks long after the year is up.
   *
   * `assertPreservedTablesUntouched` turns that from an intention into an
   * assertion after every sweep.
   */
  'appeals', 'appeal_events', 'moderation_actions', 'report_evidence',
];

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
export async function preservedCounts(db) {
  const counts = {};
  for (const table of PRESERVED_TABLES) {
    try {
      counts[table] = (await db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get()).c;
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
export async function sweep(db, { now = new Date(), dryRun = false } = {}) {
  const before = await preservedCounts(db);

  const messageCutoff = cutoff(now, RETENTION.messageDays);
  const auditCutoff = cutoff(now, RETENTION.auditDays);
  const deletedCutoff = cutoff(now, RETENTION.deletedAccountDays);
  const applicationCutoff = cutoff(now, RETENTION.applicationDays);

  /**
   * An application is aged out when the event it was for ended past the cutoff.
   *
   * `COALESCE(MAX(s.end_datetime), a.applied_at)` is the whole decision: the event's
   * last slot when there is one, the application's own timestamp when there is not.
   * Written once and shared by the count and the delete so the dry run can never
   * report a different set from the one the sweep removes.
   */
  const AGED_APPLICATION = `
    COALESCE(
      (SELECT MAX(s.end_datetime) FROM slots s WHERE s.event_id = a.event_id),
      a.applied_at
    ) < ?
  `;

  const countable = {
    messages: (await db.prepare(
      'SELECT COUNT(*) AS c FROM messages WHERE created_at < ?'
    ).get(messageCutoff)).c,
    auditLogs: (await db.prepare(
      'SELECT COUNT(*) AS c FROM admin_audit_logs WHERE created_at < ?'
    ).get(auditCutoff)).c,
    securityEvents: (await db.prepare(
      'SELECT COUNT(*) AS c FROM security_audit_logs WHERE created_at < ?'
    ).get(auditCutoff)).c,
    deletedAccounts: (await db.prepare(`
      SELECT COUNT(*) AS c FROM users
      WHERE account_status = 'deleted' AND deleted_at IS NOT NULL AND deleted_at < ?
    `).get(deletedCutoff)).c,
    applications: (await db.prepare(`
      SELECT COUNT(*) AS c FROM applications a WHERE ${AGED_APPLICATION}
    `).get(applicationCutoff)).c,
  };

  if (dryRun) return { ...countable, dryRun: true };

  /* `transactionOn` rather than `db.exec('BEGIN TRANSACTION')`.

     This sweep deletes across a dozen tables and then calls
     `assertPreservedTablesUntouched` INSIDE the transaction, specifically so a
     violation reaches the ROLLBACK while the rollback still means something.
     That design depends entirely on the deletes and the assertion being on one
     connection — which a pool does not guarantee. Against a pool, `BEGIN` would
     land on one borrowed client, the deletes on others, and the safety assertion
     would inspect a connection that had not done the deleting. The rollback it
     triggers would then discard nothing.

     `db` is a parameter here, so the handle is passed through rather than
     resolved from the context. */
  return runInTransaction(db, async (tx) => {
    /**
     * Messages that are part of a live report are exempt.
     *
     * Deletion must never silently destroy moderation evidence. A conversation
     * under investigation can easily outlive the ordinary retention window —
     * an investigation that started at two years and eleven months would find
     * its evidence deleted underneath it.
     *
     * The exemption used to name `conversation_report_messages` alone, and that
     * was not enough: the snapshot is CAPPED at twenty caller-named ids, or the
     * last ten messages when none are named, so message eleven of a reported
     * conversation was swept while the report was still open. The predicate now
     * lives in evidenceHolds.js and covers the whole live thread. One
     * definition, because a second copy of it is a second way to lose evidence.
     */
    await tx.prepare(`
      DELETE FROM messages
      WHERE created_at < ?
        AND ${RETAINABLE_MESSAGE_PREDICATE}
    `).run(messageCutoff);

    await tx.prepare('DELETE FROM admin_audit_logs WHERE created_at < ?').run(auditCutoff);

    /**
     * Two-factor security records, on the audit log's period.
     *
     * Each row is a sign-in success, failure or factor change with the IP
     * address and browser it came from. Nothing deleted them: they cascade with
     * the user row, and a deleted account's shell is kept while it carries hours
     * or a certificate, which for a real volunteer is for ever. So a deleted
     * student's IP history outlived the account indefinitely, under a policy
     * that says everything but hours, certificates and safety reports has an end
     * date. The table is append-only against UPDATE, not DELETE, by design.
     */
    await tx.prepare('DELETE FROM security_audit_logs WHERE created_at < ?').run(auditCutoff);

    /**
     * Applications, aged out with their event.
     *
     * `attendance` is deliberately NOT touched — it has no foreign key to this table
     * and it is the credited service record, which is retained indefinitely.
     * `application_conflicts` cascades and should: it describes a clash between two
     * applications, and it is meaningless once one of them is gone.
     *
     * No evidence hold is needed here. `application` is not one of
     * `REPORT_TARGET_TYPES`, so a report can never name one, and nothing in
     * `report_evidence` references this table. If a future release lets a report
     * target an application, this DELETE needs the same treatment
     * `RETAINABLE_MESSAGE_PREDICATE` gives messages — and the assertion below is
     * what would catch its absence.
     */
    await tx.prepare(`
      DELETE FROM applications
       WHERE id IN (SELECT a.id FROM applications a WHERE ${AGED_APPLICATION})
    `).run(applicationCutoff);

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
     *
     * ── The organizer clause, and why the two above were not enough ──
     *
     * `events.organizer_id` is also ON DELETE CASCADE (db.js). Purging an
     * organizer's shell therefore deletes every event they ever ran, and each of
     * those events cascades onward into `attendance`, `conversations` (and so
     * into messages and reported conversations), `event_comments` and
     * `event_announcements`.
     *
     * The two clauses above are scoped to the purged account's OWN rows, and
     * `attendance.user_id` is always the volunteer, never the organizer — so an
     * organizer shell was never exempt no matter how many students' credited
     * hours hung off their events. That is the one outcome this file's
     * assertion exists to make impossible, arriving by a route the assertion
     * could not see. It is time-armed rather than live (nothing purges until
     * three years after the first deletion) which is precisely why it had to be
     * found by reading the schema rather than by waiting.
     */
    /* The `await` belongs on the EXECUTION, not on `prepare()`. Written the
       other way round, `prepare` is awaited (harmlessly — it is synchronous on
       both engines) and `.all()` returns the promise, so `.map` is called on it
       and throws `(intermediate value).all(...).map is not a function`. On
       SQLite `.all()` returned an array and the mistake was invisible. */
    const purgeable = (await tx.prepare(`
      SELECT id FROM users
      WHERE account_status = 'deleted'
        AND deleted_at IS NOT NULL
        AND deleted_at < ?
        AND id NOT IN (SELECT DISTINCT user_id FROM attendance)
        AND id NOT IN (SELECT DISTINCT user_id FROM certificates)
        AND id NOT IN (
          SELECT DISTINCT e.organizer_id FROM events e
          WHERE EXISTS (SELECT 1 FROM attendance a WHERE a.event_id = e.id)
             OR EXISTS (SELECT 1 FROM certificates c WHERE c.event_id = e.id)
        )
    `).all(deletedCutoff)).map(r => r.id);

    /**
     * A shell that is party to a live report waits for the report, not the clock.
     *
     * Migration 011 severed the cascades, so purging the shell no longer
     * destroys the report itself — it survives with the name snapshots taken at
     * report time. What the purge still destroys is the surrounding context:
     * `conversations` cascades from both `student_id` and `organizer_id`, taking
     * the live thread and every message in it that the capped snapshot did not
     * capture. A moderator would be left reading ten messages of a four-hundred
     * message thread with nothing to say the rest ever existed.
     *
     * Held in BOTH directions, and the reporter side is the one that is easy to
     * miss: this used to be the path by which a student who reported an adult
     * and then deleted their own account had their safety report destroyed three
     * years later, by their own privacy right.
     *
     * The hold is bounded by the report being resolved, not by a longer timer,
     * and the Privacy Policy's account row says so. A number here would be a
     * number nobody could defend; a queue can discharge "until somebody has
     * dealt with it".
     */
    const heldByReport = [];
    for (const id of purgeable) {
      if (await userIsPartyToLiveReport(tx, id)) { heldByReport.push(id); continue; }
      await tx.prepare('DELETE FROM legal_acceptances WHERE user_id = ?').run(id);
      await tx.prepare('DELETE FROM users WHERE id = ?').run(id);
    }

    /**
     * The assertion runs BEFORE the commit, and that ordering is the whole
     * point of it.
     *
     * It used to run after. A sweep that destroyed certificates, credited hours
     * or safety evidence would throw, the catch below would issue a ROLLBACK
     * against a transaction that had already committed, the resulting error
     * would be swallowed by that inner try, and the scheduler would log one line
     * reading "sweep failed" over a database that had permanently lost the one
     * class of data this file promises to keep for ever. Detection without
     * rollback is not a guard, and the failure it was watching for is not
     * recoverable by hand.
     *
     * Inside the transaction, the throw reaches the ROLLBACK while the rollback
     * still means something.
     */
    await assertPreservedTablesUntouched(tx, before);

    return {
      ...countable,
      purgedAccounts: purgeable.length - heldByReport.length,
      heldByReport: heldByReport.length,
    };
  });
}

/**
 * The promise that certificates and hours are kept for ever, as an assertion.
 *
 * A convention says "do not widen this sweep". An assertion notices when
 * somebody does. The cost of being wrong here is a student discovering, years
 * later, that the record they needed is gone — which is not recoverable and not
 * detectable by any test that only checks what the sweep intended to delete.
 */
export async function assertPreservedTablesUntouched(db, before) {
  const after = await preservedCounts(db);
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

/**
 * Records a retention failure where somebody will see it.
 *
 * Every other background job in the application reports through `recordError`
 * (notificationWorker, exportWorker, autoSelectScheduler); this one used to
 * `console.error` and stop there, which is the difference between a failure on
 * the error dashboard — and therefore eligible for the alert email — and a line
 * in the journal nobody reads.
 *
 * It matters most for the one thing this file exists to guarantee.
 * `assertPreservedTablesUntouched` is the loudest alarm in the codebase: it
 * fires when a sweep has touched certificates, credited hours or safety
 * evidence. Detecting that and telling nobody is not a guard. The assertion's
 * own comment calls a silent widening "the failure mode nobody would notice";
 * the reporting is what makes that stop being true.
 *
 * `recordError` never throws, and takes the same db handle the sweep was given —
 * so a database too broken to sweep is also too broken to file the report, which
 * is honest rather than a new failure mode.
 */
async function reportRetentionError(db, err, boundary) {
  await recordError(db, {
    source: 'worker',
    kind: err?.constructor?.name || 'Error',
    message: err?.message,
    stack: err?.stack,
    context: { component: 'retentionWorker', boundary }
  });
}

/**
 * Starts retention enforcement, and runs one sweep immediately.
 *
 * ── Why the immediate sweep is load-bearing ──
 *
 * This used to arm the interval and return, so the first sweep was 24 hours
 * away. Any deployment restarted more often than daily therefore enforced the
 * published retention periods NEVER: not late, not partially — never, while
 * `/health` reported ok and the Privacy Policy kept promising them. A pilot
 * being configured, a nightly redeploy, or a crash loop is enough.
 *
 * That is precisely the gap this file's header was written to close ("Publishing
 * a period you do not enforce is worse than publishing none"), reintroduced one
 * layer above the code that closed it.
 *
 * `autoSelectScheduler.js` already had this shape and states the reasoning: the
 * immediate pass is startup recovery, for work that came due while the process
 * was down. Retention is the same shape. Safe to run at boot for the same reason
 * it is safe to run at all — `sweep()` is idempotent, deletes only by age, and
 * asserts the preserved tables before committing.
 */
export function startRetentionWorker(db) {
  if (timer) return;

  const run = async () => {
    try {
      const result = await sweep(db);
      const removed = result.messages + result.auditLogs + (result.applications || 0)
        + (result.purgedAccounts || 0);
      if (removed > 0) {
        console.log(
          `[Retention] messages=${result.messages} auditLogs=${result.auditLogs} `
          + `applications=${result.applications} purgedAccounts=${result.purgedAccounts}`
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
      // the process down for a housekeeping task. The startup call below runs on
      // the caller's stack, where an escape would take the BOOT down instead.
      console.error('[Retention] sweep failed:', err.message);
      await reportRetentionError(db, err, 'retentionSweep');
    }
  };

  /**
   * Startup recovery, before the interval is armed — see this function's header.
   *
   * The promise is RETURNED rather than dropped. `sweep` became async when its
   * transaction did, so the startup sweep no longer finishes before this
   * function does, and "enforces retention immediately" stopped being
   * observable by anyone who could only see the return value. A caller that
   * needs the first sweep to have happened — boot, or a test asserting exactly
   * that property — can now await it.
   *
   * `server.js` deliberately does not: retention is housekeeping and must not
   * hold up the listener. The rejection cannot escape either way, because `run`
   * catches everything.
   */
  /**
   * Behind a leader lease, and this is the sweep that most needs one.
   *
   * The other three periodic jobs are idempotent by construction — a dedupe
   * index, a confirmed run row, a pending queue. Retention DELETES. Two
   * concurrent passes over the same expired set is the one place where "both
   * instances did the whole scan" stops being merely wasteful.
   *
   * The lease fails OPEN (see `schedulerLease.js`), which is the right trade
   * here too: a database error must not silently stop retention, because a
   * retention period the Privacy Policy publishes and the software does not
   * enforce is a false statement about what happens to a student's data.
   */
  const leasedRun = async () => (await withLease(db, LEASES.RETENTION, () => run())).result;

  const started = leasedRun();

  /* `setInterval` does not await, so a rejection here would be an unhandled
     rejection — which on Node ends the process. `run` catches everything and
     `withLease` fails open, so this should be unreachable; relying on that
     implicitly is exactly the assumption the notification worker's own header
     warns about, so it is stated rather than assumed. */
  timer = setInterval(() => {
    leasedRun().catch((err) => {
      console.error('[Retention] Sweep failed:', err);
    });
  }, SWEEP_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return started;
}

export function stopRetentionWorker() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
