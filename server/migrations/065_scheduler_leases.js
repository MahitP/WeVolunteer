/**
 * Leader leases for the periodic sweeps.
 *
 * ── The problem, stated precisely ──
 *
 * Four things in this application run on a timer: the notification sweep
 * (`server.js`), Auto Select (`services/autoSelectScheduler.js`), retention
 * (`workers/retentionWorker.js`) and the search indexer
 * (`search/indexWorker.js`). Every one of them is correct for exactly one
 * process, and none of them says so in a way a second process would notice.
 *
 * That is different from the three JOB queues, which are already safe: the
 * notification, export and mail workers claim a row with a conditional
 * `UPDATE … WHERE status = 'pending'` and branch on `changes`, so two processes
 * racing for the same job produce one winner. The sweeps have no row to claim —
 * they are "do the whole scan now" — so two processes both do the whole scan.
 *
 * ── Why a table rather than Redis ──
 *
 * The lease is a correctness mechanism, and Redis in this project is optional
 * and off by default (`docs/operations/upstash.md`). A guard that silently stops
 * guarding when an optional service is absent is worse than no guard, because
 * the deployment that most needs it is the one least likely to have configured
 * it. The relational database is the thing this application cannot run without,
 * so the lease lives there.
 *
 * It is also the same idiom that is already load-bearing twice in this codebase
 * — `instanceLock.js` and `notificationWorker.reclaimStaleJobs` — which means it
 * is an idiom the next reader has already met.
 *
 * ── Why the columns are what they are ──
 *
 * `owner` is a token unique to one process's hold, not a hostname or a pid.
 * Release and renewal both predicate on it, so a process that lost its lease to
 * an expiry cannot delete or extend the lease its successor now holds. That is
 * exactly the predicate `releaseInstanceLock` uses, and for the same reason.
 *
 * `expires_at` is what makes the lease self-healing. A holder that is SIGKILLed
 * releases nothing, so without an expiry the sweep would stop running until
 * somebody noticed — turning a crash into a silent, indefinite outage of
 * notification reminders. There is no unbounded lease here by construction: the
 * column is NOT NULL and every acquisition sets it.
 *
 * ── Reversal ──
 *
 *   DROP TABLE scheduler_leases;
 *
 * Nothing else references it, and the sweeps fall back to running unconditionally
 * — which is what they did before this existed.
 */

function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduler_leases (
      -- The sweep's stable name, e.g. 'notification-sweep'. One row per sweep,
      -- so "who holds it" has exactly one answer and no tie-break is needed.
      name        TEXT PRIMARY KEY,
      owner       TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      renewed_at  TEXT NOT NULL,
      expires_at  TEXT NOT NULL
    )
  `);

  /**
   * The expiry scan.
   *
   * Small table — one row per sweep, so four — and an index on it will not be
   * chosen by either planner at that size. It exists for the operator query
   * ("which leases are stale right now?") rather than for the acquire path,
   * which is a primary-key probe.
   */
  db.exec('CREATE INDEX IF NOT EXISTS idx_scheduler_leases_expiry ON scheduler_leases(expires_at)');
}

/**
 * The same table on PostgreSQL.
 *
 * A separate implementation rather than a shared one, because the two engines
 * do not spell the schema identically and `migrations.postgres.test.js` ratchets
 * on every migration above the baseline having one — a migration that ran on
 * SQLite only would be silently skipped on PostgreSQL, and the symptom would be
 * `relation "scheduler_leases" does not exist` the first time a sweep ticked.
 *
 * `CREATE TABLE IF NOT EXISTS` rather than a catalogue probe, for the reason
 * migrations 058 and 059 give: the clause exists, it is atomic, and it makes
 * re-running the migration the database's problem rather than a read-then-write
 * race in application code.
 *
 * A freshly-provisioned PostgreSQL database gets this table from the generated
 * `db/postgresSchema.js` instead; this exists for one already deployed.
 */
async function postgresUp(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS scheduler_leases (
      name        text PRIMARY KEY,
      owner       text NOT NULL,
      acquired_at text NOT NULL,
      renewed_at  text NOT NULL,
      expires_at  text NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scheduler_leases_expiry
      ON scheduler_leases(expires_at);
  `);
}

export default {
  version: 65,
  name: 'scheduler_leases',
  up,
  postgres: { up: postgresUp },
  fileUrl: import.meta.url,
};
