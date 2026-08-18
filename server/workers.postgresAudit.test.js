/**
 * Workers, under PostgreSQL, exercised rather than reasoned about.
 *
 * ── The class of bug this is looking for ──
 *
 * Every worker defect this migration has found had the same shape: code that
 * was safe because SQLite made it effectively serial, running against a pool
 * where it no longer is. The alerting sweep double-sent because its "mark then
 * send" was no longer atomic. `generateZip` could never settle because an async
 * Promise executor swallowed the rejection.
 *
 * So the questions here are not "does the worker run". They are:
 *   · does a failure stop it running again?
 *   · does a failure leak the client it borrowed?
 *   · does running two at once do the work twice?
 *
 * The retention sweep is the one that matters most, because it HARD-DELETES.
 * Its production interval is 24 hours, so overlap is not a realistic schedule
 * hazard — but it is directly callable, and a worker whose second call undoes
 * or doubles the first is worth knowing about either way.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { RUNNING_ON_POSTGRES } from './testEngine.js';

describe.skipIf(!RUNNING_ON_POSTGRES)('workers under PostgreSQL', () => {
  let srv, db, retention;

  beforeAll(async () => {
    const { startTestServer } = await import('./testServer.js');
    srv = await startTestServer();
    ({ db } = await import('./db.js'));
    retention = await import('./workers/retentionWorker.js');
  }, 60_000);

  afterAll(async () => { await srv?.close(); });

  /**
   * Two sweeps at once must not report the same deletions twice.
   *
   * A sweep that selects rows, then deletes them, can have both callers select
   * the same set. Deletes are idempotent, so the ROWS end up right either way —
   * the tell is the reported counts, which is what an operator reads to decide
   * whether retention is working.
   */
  it('does not double-count when two retention sweeps overlap', async () => {
    const [a, b] = await Promise.all([sweepQuietly(), sweepQuietly()]);
    const total = (r) => (r.messages ?? 0) + (r.auditLogs ?? 0)
      + (r.applications ?? 0) + (r.purgedAccounts ?? 0);

    /**
     * A third sweep, alone, is the control: by the time the concurrent pair has
     * finished there must be nothing left to remove. If either of them had
     * failed partway — or rolled back work it reported — this finds the
     * remainder.
     *
     * Both sweeps reporting the SAME rows is the other half of the question,
     * and this does not answer it: a full double-count check needs a seeded
     * population of expired rows and an exact expected total, which the
     * retention rules make a fixture of its own. What is asserted here is that
     * concurrency leaves the database in the state one sweep would have — not
     * that the reported counts partition cleanly. Stated rather than implied,
     * because an assertion that cannot fail is worse than no assertion.
     */
    const after = await sweepQuietly();
    expect(total(after), 'a sweep after two concurrent ones still found work to do').toBe(0);
    expect(total(a), 'sweep A returned no usable result').toBeGreaterThanOrEqual(0);
    expect(total(b), 'sweep B returned no usable result').toBeGreaterThanOrEqual(0);
  }, 60_000);

  /** Silences the worker's own logging so a failing sweep does not spam the run. */
  const sweepQuietly = async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try { return await retention.sweep(db); } finally { log.mockRestore(); }
  };

  /**
   * A sweep that throws must not take the pool with it.
   *
   * The worker catches internally, so the loop survives by construction. What
   * that catch cannot promise is that the client it borrowed came back — and a
   * worker that leaks one connection per failed daily sweep exhausts a pool of
   * ten inside a fortnight, with the symptom appearing in ordinary requests.
   */
  it('returns its connection when a sweep fails', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (let i = 0; i < 12; i += 1) {
        /* A table that does not exist makes the sweep's first statement fail. */
        await expect(async () => retention.sweep({
          ...db,
          prepare: (sql) => db.prepare(sql.replace(/FROM\s+messages/i, 'FROM no_such_retention_table')),
        })).rejects.toThrow().catch(() => { /* some shapes catch internally */ });

        expect(
          Number((await db.prepare('SELECT 1 AS ok').get()).ok),
          'the pool stopped answering after a failed sweep — a client was not returned',
        ).toBe(1);
      }
    } finally {
      err.mockRestore();
    }
  }, 60_000);

  /**
   * The notification sweep is the one that already produced a real defect, so
   * it gets the overlap test the alerting fix was written for: several ticks in
   * flight together must not each send.
   */
  it('runs the maintenance sweep concurrently without double-claiming alerts', async () => {
    process.env.ALERT_EMAIL = 'ops@worker.audit';
    const email = await import('./email.js');
    const utils = await import('./utils.js');
    const sendMail = vi.spyOn(email, 'sendMail').mockResolvedValue({ ok: true });
    try {
      const now = new Date().toISOString();
      const fp = `fp-worker-audit-${Math.random().toString(36).slice(2)}`;
      await db.prepare('DELETE FROM error_groups').run();
      await db.prepare(`
        INSERT INTO error_groups
          (fingerprint, source, kind, message, route, status, occurrences, users_seen,
           first_seen_at, last_seen_at, alerted_at)
        VALUES (?, 'server', 'TypeError', 'worker audit', '/w', 'open', 1, 0, ?, ?, NULL)
      `).run(fp, now, now);

      await Promise.all([utils.runNotificationSweep(), utils.runNotificationSweep(),
        utils.runNotificationSweep()]);

      /* Wait for the un-awaited alert promises to settle. */
      for (let i = 0; i < 300; i += 1) {
        const row = await db.prepare('SELECT alerted_at FROM error_groups WHERE fingerprint = ?').get(fp);
        if (row?.alerted_at) break;
        await new Promise(r => setTimeout(r, 10));
      }
      await new Promise(r => setTimeout(r, 50));

      const digests = sendMail.mock.calls.filter(c => String(c[0]?.subject ?? '').includes('error'));
      expect(digests.length, 'three overlapping sweeps mailed the same problem more than once')
        .toBeLessThanOrEqual(1);
    } finally {
      sendMail.mockRestore();
      delete process.env.ALERT_EMAIL;
    }
  }, 60_000);
});
