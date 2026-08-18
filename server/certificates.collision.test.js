import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';
import { isUniqueViolation } from './db/dialectSql.js';

/**
 * What a unique violation actually looks like on the engine in use.
 *
 * `certificates.js` and `utils.js` both swallow unique violations on purpose —
 * a duplicate certificate row and a duplicate notification are each the
 * mechanism working, not a failure. Both recognised it with
 *
 *     String(err.message).includes('UNIQUE')
 *
 * which is SQLite's wording ("UNIQUE constraint failed: …"). PostgreSQL says
 * "duplicate key value violates unique constraint" — lower case — so on
 * PostgreSQL neither was recognised. In `utils.js` that logged a failure for a
 * non-failure; in `certificates.js` it RE-THREW, turning a retryable collision
 * into a failed issuance.
 *
 * ── Why this asserts on the error and not on a race ──
 *
 * The first version of this test raced two `getOrCreateCertificateCode` calls
 * and asserted they agreed. It passed with the bug reintroduced, twice: first
 * because the pair was already certified so the early return fired, then because
 * two awaited calls do not reliably interleave between their SELECT and INSERT.
 * A test that cannot make the collision happen proves nothing about how the
 * collision is handled.
 *
 * Provoking the violation directly is deterministic, and it pins the thing that
 * actually differs between the engines: the shape of the error.
 */
describe('unique violations are recognised on the engine in use', () => {
  let srv, db;

  beforeAll(async () => {
    srv = await startTestServer();
    ({ db } = await import('./db.js'));
  }, 60_000);

  afterAll(async () => { await srv?.close(); });

  it('is recognised by isUniqueViolation, whatever the engine calls it', async () => {
    const user = await db.prepare(
      "SELECT id FROM users WHERE role = 'student' AND account_status = 'active' ORDER BY id LIMIT 1"
    ).get();
    const event = await db.prepare('SELECT id FROM events ORDER BY id LIMIT 1').get();
    expect(user && event, 'fixture: need a student and an event').toBeTruthy();

    const code = `WEV-DUP-${Date.now().toString(36).toUpperCase()}`;
    const now = new Date().toISOString();
    await db.prepare('DELETE FROM certificates WHERE user_id = ? AND event_id = ?')
      .run(user.id, event.id);
    await db.prepare(
      'INSERT INTO certificates (user_id, event_id, code, created_at) VALUES (?, ?, ?, ?)'
    ).run(user.id, event.id, code, now);

    /* The same row again — a real UNIQUE(user_id, event_id) violation from the
       real engine, not a constructed Error. */
    let err = null;
    try {
      await db.prepare(
        'INSERT INTO certificates (user_id, event_id, code, created_at) VALUES (?, ?, ?, ?)'
      ).run(user.id, event.id, `${code}-B`, now);
    } catch (caught) {
      err = caught;
    }

    expect(err, 'the duplicate insert was accepted — the unique index is missing').toBeTruthy();
    expect(
      isUniqueViolation(err),
      `isUniqueViolation did not recognise this engine's unique violation: ${err?.code} / ${err?.message}`,
    ).toBe(true);
  }, 60_000);

  it('is NOT recognised by the SQLite-only message match, on PostgreSQL', async () => {
    /* The failing half, stated explicitly. On SQLite the old check works, which
       is exactly why the defect survived: the suite it was written against
       could not see it. */
    const user = await db.prepare(
      "SELECT id FROM users WHERE role = 'student' AND account_status = 'active' ORDER BY id LIMIT 1"
    ).get();
    const event = await db.prepare('SELECT id FROM events ORDER BY id LIMIT 1').get();

    const code = `WEV-DUP2-${Date.now().toString(36).toUpperCase()}`;
    const now = new Date().toISOString();
    await db.prepare('DELETE FROM certificates WHERE user_id = ? AND event_id = ?')
      .run(user.id, event.id);
    await db.prepare(
      'INSERT INTO certificates (user_id, event_id, code, created_at) VALUES (?, ?, ?, ?)'
    ).run(user.id, event.id, code, now);

    let err = null;
    try {
      await db.prepare(
        'INSERT INTO certificates (user_id, event_id, code, created_at) VALUES (?, ?, ?, ?)'
      ).run(user.id, event.id, `${code}-B`, now);
    } catch (caught) { err = caught; }

    const oldCheck = String(err?.message).includes('UNIQUE');
    if (db.dialect === 'postgres') {
      expect(
        oldCheck,
        'the SQLite message match now works on PostgreSQL — if the driver changed '
        + 'its wording, the reason these call sites were fixed no longer holds',
      ).toBe(false);
    } else {
      expect(oldCheck, 'SQLite stopped saying "UNIQUE constraint failed"').toBe(true);
    }
  }, 60_000);
});
