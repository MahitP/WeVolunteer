/**
 * The retention SCHEDULER, as distinct from the sweep it drives.
 *
 * `retention.test.js` covers `sweep()` thoroughly — every published period, every
 * boundary, every preserved table. It covers `startRetentionWorker()` not at all,
 * and both defects below lived in that gap: the sweep was correct and nothing
 * called it.
 *
 * ── 1. The first sweep was a day away, so a restarted server never swept ──
 *
 * `startRetentionWorker` armed `setInterval(run, 24h)` and did not call `run()`.
 * Nothing enforced retention until the process had been up for a full day —
 * so any deployment restarted more often than daily (a pilot being configured,
 * a `systemctl restart`, a crash loop, a nightly redeploy) enforced the published
 * retention periods NEVER, while `/health` reported ok and the Privacy Policy
 * kept promising them.
 *
 * That is the failure this worker's own header calls the worst kind: "Publishing
 * a period you do not enforce is worse than publishing none: it converts an
 * absence into a representation." The absence was reintroduced one layer up from
 * the code that closed it.
 *
 * `autoSelectScheduler.js` already had the answer and documents it — "the
 * immediate sweep is the startup-recovery behaviour: a draw that came due while
 * the process was down should not wait another interval." Retention is the same
 * shape and had the opposite behaviour.
 *
 * ── 2. A failing sweep told nobody ──
 *
 * `run()`'s catch block was a bare `console.error`. Every other background job in
 * the application reports through `recordError` (notificationWorker,
 * exportWorker, autoSelectScheduler), which is what puts a failure on the error
 * dashboard and makes it eligible for the alert email.
 *
 * Retention was the one that did not — and it is the one holding
 * `assertPreservedTablesUntouched`, the loudest alarm in the codebase, the guard
 * on certificates, credited hours and safety evidence. That assertion firing is
 * the single most consequential event this system can detect, and it landed in a
 * journal line with no dashboard row and no alert. A guard nobody is told about
 * is the "failure mode nobody would notice" the assertion exists to prevent.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

let dir;

/**
 * A fresh database and module registry per test.
 *
 * db.js resolves WEV_DB_PATH once at import, so it has to be set before the
 * dynamic import — the pattern testServer.js uses, and the reason
 * vitest.config.js pins `isolate: true`.
 */
async function freshRetention() {
  dir = mkdtempSync(path.join(tmpdir(), 'wev-retention-'));
  process.env.WEV_DB_PATH = path.join(dir, 'retention.db');
  process.env.JWT_SECRET = 'x'.repeat(48);
  delete process.env.NODE_ENV;

  vi.resetModules();
  const dbMod = await import('./db.js');
  dbMod.initDatabase();
  await dbMod.completeDatabaseInit();
  const worker = await import('./workers/retentionWorker.js');
  // Audit rows go through the helper, never a raw INSERT — `auditLog.test.js`
  // enforces that it is the only writer of this table, because it owns the UUID
  // generation that fixed a real primary-key collision.
  const { recordAudit } = await import('./auditLog.js');
  return { db: dbMod.db, worker, recordAudit };
}

beforeEach(() => { vi.useRealTimers(); });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null; }
});

describe('the retention worker sweeps at startup', () => {
  it('enforces retention immediately, not one interval later', async () => {
    const { db, worker, recordAudit } = await freshRetention();

    await db.prepare(`
      INSERT INTO users (id, email, password_hash, name, role, grade, username,
                         email_verified, account_status, created_at)
      VALUES ('ret-admin', 'ret-admin@example.gov', 'h', 'Ret Admin', 'admin', 'N/A',
              'ret_admin', 1, 'active', datetime('now'))
    `).run();

    /**
     * An audit row well past the published 1-year window.
     *
     * Written through `recordAudit` and then backdated, which is the pattern
     * `retention.test.js` uses — a raw INSERT here fails `auditLog.test.js`'s
     * only-one-writer guard, and rightly. Audit rows are chosen over messages
     * because they need no conversation fixture: the point is only that the
     * sweep RAN.
     */
    const stale = new Date(Date.now() - (worker.RETENTION.auditDays + 30) * 86400000).toISOString();
    const seeded = await recordAudit(db, {
      adminId: 'ret-admin',
      action: 'RETENTION_SCHEDULER_FIXTURE',
      details: 'past its window',
      createdAt: stale
    });

    const countStale = () => db.prepare(
      'SELECT COUNT(*) c FROM admin_audit_logs WHERE id = ?'
    ).get(seeded.id).c;
    expect(countStale()).toBe(1);

    try {
      await worker.startRetentionWorker(db);

      // No timer advanced, no waiting. If retention only happens on the interval,
      // this row is still here — which is the state a server restarted daily was
      // permanently in.
      expect(countStale()).toBe(0);
    } finally {
      worker.stopRetentionWorker();
    }
  });

  it('still arms the daily interval after the startup sweep', async () => {
    const { db, worker } = await freshRetention();
    const spy = vi.spyOn(globalThis, 'setInterval');
    try {
      await worker.startRetentionWorker(db);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][1]).toBe(24 * 60 * 60 * 1000);
    } finally {
      worker.stopRetentionWorker();
    }
  });

  it('does not start a second sweep when called twice', async () => {
    const { db, worker } = await freshRetention();
    try {
      await worker.startRetentionWorker(db);
      const spy = vi.spyOn(globalThis, 'setInterval');
      await worker.startRetentionWorker(db);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      worker.stopRetentionWorker();
    }
  });
});

describe('a failing retention sweep reaches the error dashboard', () => {
  /**
   * A database that answers everything except the sweep's first read.
   *
   * Surgical on purpose: `preservedCounts` and `recordError` both need a working
   * handle, so a wholesale broken stub would prove nothing about reporting. This
   * models the realistic fault — one statement failing on an otherwise live
   * database — and leaves the error tables writable so the assertion below is
   * about whether the worker REPORTS, not whether it could.
   */
  function dbFailingOnMessageCount(db) {
    return {
      prepare: (sql) => {
        if (sql.includes('FROM messages')) {
          throw new Error('database disk image is malformed');
        }
        return db.prepare(sql);
      },
      exec: (sql) => db.exec(sql),
    };
  }

  it('records a worker error instead of only logging one line', async () => {
    const { db, worker } = await freshRetention();
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await worker.startRetentionWorker(dbFailingOnMessageCount(db));

      // The log line was the entire previous behaviour, and it is kept.
      expect(consoleErr).toHaveBeenCalled();

      // What was missing: a row on the dashboard, which is also what makes the
      // failure eligible for the alert email.
      const groups = await db.prepare(
        "SELECT kind, source FROM error_groups WHERE source = 'worker'"
      ).all();
      expect(groups.length).toBeGreaterThan(0);
    } finally {
      worker.stopRetentionWorker();
      consoleErr.mockRestore();
    }
  });

  it('files the failure against the retention worker, not an anonymous one', async () => {
    const { db, worker } = await freshRetention();
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await worker.startRetentionWorker(dbFailingOnMessageCount(db));

      const event = await db.prepare(`
        SELECT e.context FROM error_events e
        JOIN error_groups g ON g.fingerprint = e.fingerprint
        WHERE g.source = 'worker' LIMIT 1
      `).get();

      expect(event).toBeTruthy();
      // Named so "the retention sweep is broken" is one line on a dashboard
      // rather than an unattributed database error.
      expect(String(event.context)).toContain('retentionWorker');
    } finally {
      worker.stopRetentionWorker();
      consoleErr.mockRestore();
    }
  });

  it('does not let a sweep failure escape and kill the process', async () => {
    const { db, worker } = await freshRetention();
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      /**
       * A timer callback that throws takes the process down for a housekeeping
       * task, so a failing sweep must escape neither way.
       *
       * Both halves are asserted because the sweep became async: it no longer
       * runs on the caller's stack, so a synchronous `not.toThrow()` alone would
       * pass while the returned promise rejected — and an unhandled rejection is
       * exactly the process death this test exists to prevent. `server.js` drops
       * this promise deliberately, which is only safe if it cannot reject.
       */
      let startup;
      expect(() => { startup = worker.startRetentionWorker(dbFailingOnMessageCount(db)); })
        .not.toThrow();
      (await expect(startup, 'the startup sweep rejected instead of catching internally')).resolves.toBeUndefined();
    } finally {
      worker.stopRetentionWorker();
      consoleErr.mockRestore();
    }
  });
});
