/**
 * A foreign data export must be indistinguishable from one that does not exist.
 *
 * ── The finding ──
 *
 * `GET /api/privacy/export/download/:id` answered:
 *
 *     someone else's export  → 403 'Unauthorized to access this export'
 *     no such export         → 404 'Export not found'
 *
 * Verified live with two student sessions. No data crosses — the ownership check
 * holds — but the pair of status codes is an existence oracle: any authenticated
 * user can learn whether a given export id exists.
 *
 * ── Why it matters ──
 *
 * Export ids are `export-${Date.now()}-${6 chars of base36}`, so the timestamp half
 * is guessable. That turns the oracle into "did this person request a copy of their
 * personal data around this time" — small, but it is metadata about a
 * privacy-exercise action taken by a minor, and it is discoverable by any other
 * student.
 *
 * It is also inconsistent with the project's own convention, which the messaging
 * routes state explicitly and are tested on: an uninvolved student reading another's
 * conversation gets 404, not 403, precisely so existence does not leak. This
 * endpoint is the outlier.
 *
 * The response for a genuinely expired export is left as 410 — that is the owner's
 * own export, so there is nothing to hide from them, and the distinct code is what
 * lets the UI say "this expired, request another" instead of "not found".
 *
 * ── Why every probe below now carries a grant (v1.2b audit, F-1) ──
 *
 * The route gained `requireAAL2('data.download')`, which answers 403 before the
 * handler runs. Without a grant every case here would be 403 — indistinguishable,
 * so the assertions would still pass while testing the GATE rather than the
 * ownership branch this file exists for. Each probe therefore presents a real,
 * unspent grant bound to the id it is probing, so control reaches the 404 and the
 * property is exercised for real.
 *
 * Opening a challenge is itself not an oracle: `POST /api/auth/reauth/challenge`
 * binds whatever `jobId` it is handed without looking it up, so it answers
 * identically for a real id, a foreign one and one that was never issued.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

let srv, owner, other, ownerId;

beforeAll(async () => {
  srv = await startTestServer();
  owner = await srv.login('leo.chen28@gmail.com');
  other = await srv.login('emiller2027@gmail.com');
  ownerId = (await srv.call('GET', '/api/auth/me', undefined, owner)).body.id;
}, 60000);
afterAll(async () => { await srv?.close(); });

/** Inserts a completed export owned by `userId`, without waiting on the worker. */
async function completedExport(userId, id) {
  const { db } = await import('./db.js');
  const now = new Date();
  db.prepare(`
    INSERT INTO data_export_jobs (id, user_id, status, file_location, created_at, completed_at, expires_at)
    VALUES (?, ?, 'completed', NULL, ?, ?, ?)
  `).run(
    id, userId, now.toISOString(), now.toISOString(),
    new Date(now.getTime() + 7 * 24 * 3600_000).toISOString()
  );
  return id;
}

describe('export download does not leak existence', () => {
  it('returns the same status for a foreign export and a nonexistent one', async () => {
    const id = await completedExport(ownerId, 'export-idor-probe-1');
    const absent = 'export-definitely-absent';

    // A grant per probe: they are single-use and bound to their own jobId.
    const foreign = await srv.call(
      'GET', `/api/privacy/export/download/${id}`, undefined, other,
      await srv.verified(other, 'data.download', { params: { jobId: id } })
    );
    const missing = await srv.call(
      'GET', `/api/privacy/export/download/${absent}`, undefined, other,
      await srv.verified(other, 'data.download', { params: { jobId: absent } })
    );

    expect(
      foreign.status,
      'a foreign export answers differently from a missing one, so its existence leaks'
    ).toBe(missing.status);
    expect(foreign.status).toBe(404);
  });

  it('does not hint at ownership in the body either', async () => {
    const id = await completedExport(ownerId, 'export-idor-probe-2');

    const res = await srv.call(
      'GET', `/api/privacy/export/download/${id}`, undefined, other,
      await srv.verified(other, 'data.download', { params: { jobId: id } })
    );
    const body = JSON.stringify(res.body ?? '') + String(res.text ?? '');

    // "Unauthorized" tells the caller the row is real. The message must not.
    expect(body).not.toMatch(/unauthoris?zed/i);
    expect(body).not.toContain(ownerId);
  });

  it('still lets the owner download their own export', async () => {
    // The ownership check must not have been widened into a blanket refusal.
    const id = await completedExport(ownerId, 'export-idor-probe-3');

    const res = await srv.call(
      'GET', `/api/privacy/export/download/${id}`, undefined, owner,
      await srv.verified(owner, 'data.download', { params: { jobId: id } })
    );

    // file_location is NULL on this fixture, so the owner reaches the
    // not-ready branch rather than a download — but crucially NOT a 404.
    expect(res.status).not.toBe(404);
    expect([400, 410]).toContain(res.status);
  });

  it('still refuses an unauthenticated caller', async () => {
    const id = await completedExport(ownerId, 'export-idor-probe-4');
    const res = await srv.call('GET', `/api/privacy/export/download/${id}`);
    expect(res.status).toBe(401);
  });
});
