/**
 * Reliability cover for the notification outbox worker.
 *
 * Three defects, all invisible to the existing suite because nothing exercised
 * the worker's failure paths:
 *
 * 1. UNHANDLED REJECTION → PROCESS EXIT.
 *    `setInterval(processNotificationJobs, 10000)` attached no `.catch`, and the
 *    `SELECT` at the top of the function sat outside any `try`. A database error
 *    there — a lock held past `busy_timeout`, a full disk — rejected the returned
 *    promise with nobody listening, which under Node's default
 *    `--unhandled-rejections=throw` terminates the process. systemd then restarts
 *    it (`RestartSec=5`), and on a persistent fault it burns `StartLimitBurst=5`
 *    inside 120s and the service stays DOWN until someone runs
 *    `systemctl reset-failed`. The recovery path for a full disk was a manual
 *    intervention nobody would be alerted to.
 *
 * 2. JOBS STUCK IN `processing` FOREVER.
 *    The worker marks a job `processing` before awaiting the send, but the query
 *    selects only `status = 'pending'` and nothing ever reclaims a row left
 *    behind. Any restart mid-send — i.e. every deploy — orphaned those
 *    notifications permanently. Acceptance and cancellation notices are exactly
 *    what sits in that queue.
 *
 * 3. `failed` JOBS SURFACED NOWHERE.
 *    After five attempts (~62 minutes of backoff) a job became `failed` with the
 *    error in a column nobody reads. No log line, no metric, no admin view. An
 *    SMTP outage longer than an hour silently discarded every queued notification.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

let dir;

/**
 * Each test gets a fresh database and a fresh module registry.
 *
 * db.js resolves WEV_DB_PATH once at import, so the variable has to be set before
 * the dynamic import and the registry reset between tests — the same pattern
 * server/testServer.js uses and the reason vitest.config.js pins `isolate: true`.
 */
async function freshWorker() {
  dir = mkdtempSync(path.join(tmpdir(), 'wev-worker-'));
  process.env.WEV_DB_PATH = path.join(dir, 'worker.db');
  process.env.JWT_SECRET = 'x'.repeat(48);
  process.env.APP_URL = 'http://localhost:5173';
  delete process.env.NODE_ENV;

  vi.resetModules();
  const dbMod = await import('./db.js');
  dbMod.initDatabase();
  await dbMod.completeDatabaseInit();
  const worker = await import('./workers/notificationWorker.js');
  return { db: dbMod.db, worker };
}

/** Inserts a job row directly, bypassing notificationService's preference checks. */
async function queueJob(db, { id, status = 'pending', attempts = 0, nextAttemptAt = null, payload = null }) {
  await db.prepare(`
    INSERT INTO notification_jobs (id, channel, payload, status, attempts, next_attempt_at, created_at)
    VALUES (?, 'email', ?, ?, ?, ?, ?)
  `).run(
    id,
    payload ?? JSON.stringify({ event: 'APPLICATION_ACCEPTED', payload: { eventId: 'e1' }, userId: 'u1' }),
    status,
    attempts,
    nextAttemptAt ?? new Date(Date.now() - 1000).toISOString(),
    new Date().toISOString()
  );
}

beforeEach(() => { dir = null; });
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('the worker loop cannot take the process down', () => {
  it('processNotificationJobs resolves rather than rejecting when the database errors', async () => {
    const { db, worker } = await freshWorker();

    // Simulate the failure that used to kill the process: the outer SELECT throws.
    // Dropping the table is the bluntest faithful stand-in for "this query cannot run".
    db.exec('DROP TABLE notification_jobs');

    // Must not reject. Pre-fix this propagated straight out of the interval callback.
    await expect(worker.processNotificationJobs()).resolves.not.toThrow();
  });

  it('reports the loop failure instead of swallowing it silently', async () => {
    const { db, worker } = await freshWorker();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    db.exec('DROP TABLE notification_jobs');
    await worker.processNotificationJobs();

    // Caught is not the same as handled — an operator has to be able to see it.
    expect(spy).toHaveBeenCalled();
    const logged = spy.mock.calls.flat().map(String).join(' ');
    expect(logged).toMatch(/notification/i);
  });

  it('survives a failure while recording a failed attempt', async () => {
    const { db, worker } = await freshWorker();
    await queueJob(db, { id: 'job-bookkeeping' });

    // The bookkeeping UPDATE in the catch block was itself unprotected, so a
    // database that is unhappy for the send is unhappy for the write-back too.
    const original = db.prepare.bind(db);
    let dropped = false;
    vi.spyOn(db, 'prepare').mockImplementation((sql) => {
      if (!dropped && /UPDATE notification_jobs\s+SET status = \?, attempts/.test(sql)) {
        dropped = true;
        throw new Error('database is locked');
      }
      return original(sql);
    });

    await expect(worker.processNotificationJobs()).resolves.not.toThrow();
  });
});

describe('stale processing jobs are reclaimed', () => {
  it('returns a job stranded in processing back to pending', async () => {
    const { db, worker } = await freshWorker();

    // A job left mid-send by a restart: status processing, claimed long ago.
    const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await queueJob(db, { id: 'job-stranded', status: 'processing' });
    await db.prepare('UPDATE notification_jobs SET next_attempt_at = ? WHERE id = ?')
      .run(longAgo, 'job-stranded');

    const reclaimed = await worker.reclaimStaleJobs();

    expect(reclaimed).toBe(1);
    const row = await db.prepare('SELECT status FROM notification_jobs WHERE id = ?').get('job-stranded');
    expect(row.status).toBe('pending');
  });

  it('leaves a job that is genuinely in flight alone', async () => {
    const { db, worker } = await freshWorker();

    // Claimed just now — a concurrent send, not an orphan. Reclaiming this would
    // deliver the same notification twice.
    await queueJob(db, { id: 'job-inflight', status: 'processing' });
    await db.prepare('UPDATE notification_jobs SET next_attempt_at = ? WHERE id = ?')
      .run(new Date().toISOString(), 'job-inflight');

    const reclaimed = await worker.reclaimStaleJobs();

    expect(reclaimed).toBe(0);
    const row = await db.prepare('SELECT status FROM notification_jobs WHERE id = ?').get('job-inflight');
    expect(row.status).toBe('processing');
  });

  it('does not resurrect a job that already exhausted its attempts', async () => {
    const { db, worker } = await freshWorker();

    const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await queueJob(db, { id: 'job-exhausted', status: 'processing', attempts: 5 });
    await db.prepare('UPDATE notification_jobs SET next_attempt_at = ? WHERE id = ?')
      .run(longAgo, 'job-exhausted');

    await worker.reclaimStaleJobs();

    // Retrying past the cap would loop forever against a permanently bad address.
    const row = await db.prepare('SELECT status FROM notification_jobs WHERE id = ?').get('job-exhausted');
    expect(row.status).toBe('failed');
  });

  it('reclaims on startup, so a restart recovers its own orphans', async () => {
    const { db, worker } = await freshWorker();

    const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await queueJob(db, { id: 'job-orphan', status: 'processing' });
    await db.prepare('UPDATE notification_jobs SET next_attempt_at = ? WHERE id = ?')
      .run(longAgo, 'job-orphan');

    // This is the deploy case: the process that claimed the job is gone.
    await worker.startNotificationWorker();
    worker.stopNotificationWorker();

    const row = await db.prepare('SELECT status FROM notification_jobs WHERE id = ?').get('job-orphan');
    expect(row.status).toBe('pending');
  });
});

describe('failed jobs are visible', () => {
  it('logs when a job exhausts its attempts', async () => {
    const { db, worker } = await freshWorker();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // attempts=4 so this run is the fifth and final one.
    await queueJob(db, { id: 'job-final', attempts: 4 });
    // No such user, so handleEmailJob throws.
    await db.prepare('UPDATE notification_jobs SET payload = ? WHERE id = ?').run(
      JSON.stringify({ event: 'APPLICATION_ACCEPTED', payload: {}, userId: 'nobody' }),
      'job-final'
    );

    await worker.processNotificationJobs();

    const row = await db.prepare('SELECT status FROM notification_jobs WHERE id = ?').get('job-final');
    expect(row.status).toBe('failed');

    const logged = spy.mock.calls.flat().map(String).join(' ');
    expect(logged, 'a permanently failed notification was not logged').toMatch(/fail/i);
  });

  it('exposes a queue health summary for the admin surface', async () => {
    const { db, worker } = await freshWorker();

    await queueJob(db, { id: 'p1' });
    await queueJob(db, { id: 'f1', status: 'failed', attempts: 5 });
    await queueJob(db, { id: 'f2', status: 'failed', attempts: 5 });

    const health = await worker.getQueueHealth();

    expect(health.pending).toBe(1);
    expect(health.failed).toBe(2);
    // An operator needs to know a failure is recent rather than historical.
    expect(health).toHaveProperty('oldestPendingAt');
  });
});

describe('the worker stops cleanly', () => {
  it('stopNotificationWorker clears the interval so the process can exit', async () => {
    const { worker } = await freshWorker();

    await worker.startNotificationWorker();
    expect(worker.isRunning()).toBe(true);

    worker.stopNotificationWorker();
    expect(worker.isRunning()).toBe(false);
  });

  it('start is idempotent, so a double call cannot double-send', async () => {
    const { worker } = await freshWorker();

    await worker.startNotificationWorker();
    await worker.startNotificationWorker();
    worker.stopNotificationWorker();

    expect(worker.isRunning()).toBe(false);
  });
});
