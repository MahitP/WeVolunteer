import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * A deduplicated notification is success, and must not be logged as a failure.
 *
 * `createNotification` swallows a unique violation on purpose — the partial index
 * `idx_notifications_dedupe` is what makes "send this at most once" true, so
 * hitting it is the mechanism working. It recognised that violation with
 *
 *     String(e.message).includes('UNIQUE')
 *
 * which is SQLite's wording. PostgreSQL says "duplicate key value violates unique
 * constraint" — lower case, and `includes` is case-sensitive — so on PostgreSQL
 * every deduplicated notification took the error branch and logged "Failed to
 * create notification".
 *
 * The return value was `null` either way, which is why nothing broke and why no
 * test caught it: the observable result was identical. What it produced was a
 * steady stream of logged errors for the one case that is explicitly not an
 * error, and an error log that cries wolf is where a real failure goes to hide.
 *
 * So the assertion here is on the LOG, not the return value. Asserting the
 * return value would pass against the bug.
 */
describe('notification dedupe is not an error', () => {
  let srv, db, utils;

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));
    utils = await import('./utils.js');
  }, 60_000);

  afterAll(async () => { await srv?.close(); });

  it('logs nothing when the same notification is created twice', async () => {
    const user = await db.prepare(
      "SELECT id FROM users WHERE role = 'student' AND account_status = 'active' ORDER BY id LIMIT 1"
    ).get();
    expect(user, 'fixture: no active student to notify').toBeTruthy();

    const dedupeKey = `dedupe-rehearsal-${Date.now()}`;
    const payload = {
      userId: user.id,
      kind: 'info',
      title: 'Dedupe rehearsal',
      body: 'Sent once.',
      dedupeKey,
    };

    const first = await utils.createNotification(payload);
    expect(first, 'the first notification was not created').toBeTruthy();

    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const second = await utils.createNotification(payload);
      expect(second, 'a duplicate should be reported as already-sent').toBeNull();

      const complaints = errors.mock.calls
        .map(args => String(args[0]))
        .filter(line => line.includes('Failed to create notification'));

      expect(
        complaints,
        'the duplicate was logged as a failure — on PostgreSQL the unique '
        + 'violation was not recognised, because the check matched SQLite wording',
      ).toEqual([]);
    } finally {
      errors.mockRestore();
    }

    /* And exactly one row exists, so the dedupe did its job rather than the
       insert quietly succeeding twice. */
    const { n } = await db.prepare(
      'SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND dedupe_key = ?'
    ).get(user.id, dedupeKey);
    expect(Number(n)).toBe(1);
  }, 60_000);
});
