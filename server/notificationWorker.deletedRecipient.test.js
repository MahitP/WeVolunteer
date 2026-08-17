/**
 * A queued notification whose recipient has since deleted their account.
 *
 * ── What happened before this ──
 *
 * Deletion is a SOFT delete: `DELETE /api/auth/account` anonymises the row and
 * rewrites the address to `deleted_<id>@system.local` (accountRoutes.js), because
 * certificates, attendance and the hours ledger hang off that id and are kept for
 * ever. It clears the account's preferences, favourites, notifications, OAuth
 * links and both live token tables — but NOT `notification_jobs`, which has no
 * `user_id` column at all (the id lives inside the JSON payload).
 *
 * So every notification already sitting in the outbox for that person stayed
 * queued, and `handleEmailJob` looked the user up, found the row, and posted mail
 * to `deleted_<id>@system.local`. `.local` is reserved by RFC 6762 and resolves
 * nowhere, so in production that is:
 *
 *   • five delivery attempts across ~62 minutes of backoff, then
 *   • `status = 'failed'`, and
 *   • `reportWorkerError(…, 'notificationJobExhausted')` — a dashboard row and an
 *     alert email, for a notification that was correctly undeliverable.
 *
 * The cost is not the wasted work. It is that a student exercising their deletion
 * right manufactures false alerts in the one channel that is supposed to mean
 * "something is broken", plus a hard bounce per attempt against the district's
 * sending domain. An alert channel that cries wolf is one people learn to filter,
 * which is how the next real outage gets missed — the exact failure the alerting
 * design set out to prevent.
 *
 * ── Why the fix belongs in the worker, not in the deletion handler ──
 *
 * Purging the outbox at deletion time would need `json_extract` over an
 * unindexed TEXT column inside the deletion transaction, and would still lose the
 * race against a request that enqueues a job moments later. Asking the worker
 * "does this recipient still want mail" at send time is one query it already
 * makes, covers jobs enqueued after the deletion, and needs no schema change.
 *
 * Dropped rather than failed: this job will never become deliverable, so leaving
 * it to exhaust its attempts records a defect that does not exist.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

let dir;
/** Every address the worker actually tried to send to, in order. */
let sent;

async function freshWorker() {
  dir = mkdtempSync(path.join(tmpdir(), 'wev-deleted-recipient-'));
  process.env.WEV_DB_PATH = path.join(dir, 'worker.db');
  process.env.JWT_SECRET = 'x'.repeat(48);
  process.env.APP_URL = 'http://localhost:5173';
  delete process.env.NODE_ENV;

  sent = [];
  vi.resetModules();

  // Stubbed so the assertion is "delivery was not ATTEMPTED", which the console
  // mock transport cannot distinguish from a success.
  vi.doMock('./email.js', () => ({
    sendMail: async ({ to }) => { sent.push(to); return { messageId: 'stub' }; },
    buildHtmlTemplate: (title, content) => `<html>${title}${content}</html>`,
    escapeHtml: (v) => String(v ?? ''),
  }));

  const dbMod = await import('./db.js');
  dbMod.initDatabase();
  await dbMod.completeDatabaseInit();
  const worker = await import('./workers/notificationWorker.js');
  return { db: dbMod.db, worker };
}

function makeUser(db, { id, status = 'active', email = null }) {
  db.prepare(`
    INSERT INTO users (id, email, password_hash, name, role, grade, username,
                       email_verified, account_status, created_at)
    VALUES (?, ?, 'h', 'Test Person', 'student', '9', ?, 1, ?, datetime('now'))
  `).run(id, email ?? `${id}@example.com`, id.replace(/-/g, '_'), status);
  return id;
}

function queueJob(db, { id, userId }) {
  db.prepare(`
    INSERT INTO notification_jobs (id, channel, payload, status, attempts, next_attempt_at, created_at)
    VALUES (?, 'email', ?, 'pending', 0, ?, ?)
  `).run(
    id,
    JSON.stringify({ event: 'APPLICATION_ACCEPTED', payload: {}, userId }),
    new Date(Date.now() - 1000).toISOString(),
    new Date().toISOString()
  );
}

const jobRow = (db, id) =>
  db.prepare('SELECT status, attempts FROM notification_jobs WHERE id = ?').get(id);

beforeEach(() => { vi.useRealTimers(); });
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.doUnmock('./email.js');
  if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null; }
});

describe('a notification queued for a deleted account', () => {
  it('is never posted to the placeholder address', async () => {
    const { db, worker } = await freshWorker();
    makeUser(db, { id: 'gone-1', status: 'deleted', email: 'deleted_gone-1@system.local' });
    queueJob(db, { id: 'job-gone-1', userId: 'gone-1' });

    await worker.processNotificationJobs();

    expect(sent).toEqual([]);
  });

  it('is dropped, not left to exhaust five attempts and raise an alert', async () => {
    const { db, worker } = await freshWorker();
    makeUser(db, { id: 'gone-2', status: 'deleted', email: 'deleted_gone-2@system.local' });
    queueJob(db, { id: 'job-gone-2', userId: 'gone-2' });

    await worker.processNotificationJobs();

    // Gone entirely — the same disposition as a successful send, because there is
    // nothing here to retry and nothing to investigate.
    expect(jobRow(db, 'job-gone-2')).toBeUndefined();

    // And no dashboard row, which is the whole point: a deleted recipient is not
    // a defect in this application.
    expect((await db.prepare("SELECT COUNT(*) c FROM error_groups WHERE source = 'worker'").get()).c).toBe(0);
  });

  it('still delivers to an active account', async () => {
    const { db, worker } = await freshWorker();
    makeUser(db, { id: 'here-1' });
    queueJob(db, { id: 'job-here-1', userId: 'here-1' });

    await worker.processNotificationJobs();

    expect(sent).toEqual(['here-1@example.com']);
    expect(jobRow(db, 'job-here-1')).toBeUndefined();
  });

  /**
   * A suspended account is NOT a deleted one.
   *
   * Suspension is the state in which the platform most needs to reach somebody —
   * the suspension notice itself carries the appeal link, and appeal outcome
   * notices are mandatory. Widening this drop to "any non-active account" would
   * silently cut off the only channel a suspended student has.
   */
  it('still delivers to a suspended account, which is how appeals reach anyone', async () => {
    const { db, worker } = await freshWorker();
    makeUser(db, { id: 'susp-1', status: 'suspended' });
    queueJob(db, { id: 'job-susp-1', userId: 'susp-1' });

    await worker.processNotificationJobs();

    expect(sent).toEqual(['susp-1@example.com']);
  });

  /**
   * A hard-deleted row is a different case and keeps its old behaviour.
   *
   * The retention sweep purges a shell three years on, and a job outliving that
   * means the outbox has held something for three years — which IS worth a look.
   */
  it('leaves a job for a row that no longer exists to fail as before', async () => {
    const { db, worker } = await freshWorker();
    queueJob(db, { id: 'job-nobody', userId: 'never-existed' });

    await worker.processNotificationJobs();

    const row = jobRow(db, 'job-nobody');
    expect(row.status).toBe('pending');   // retrying, not dropped
    expect(row.attempts).toBe(1);
  });
});
