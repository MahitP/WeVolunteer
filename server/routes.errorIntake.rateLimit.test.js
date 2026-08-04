/**
 * Rate limiting on the unauthenticated error intake.
 *
 * ── Why this is its own file ──
 *
 * Two reasons, and the second was found by trying the alternative.
 *
 * express-rate-limit keeps its counters in the app's memory keyed by client
 * address, and every request in a vitest file comes from 127.0.0.1 — so one
 * shared bucket spans the whole file. Testing the limit alongside the functional
 * tests would make those order-dependent on how many reports happened to be sent
 * before them. Same reasoning as `routes.reauth.rateLimit.test.js`.
 *
 * And `startTestServer` cannot be called twice in one process: `db.js` opens its
 * database at module scope, so the second boot reuses the first connection while
 * asserting a fresh directory, and fails. Lowering the limit for one test inside
 * the functional file is therefore not merely untidy, it does not work.
 *
 * `ERROR_REPORT_RATE_LIMIT` is set low here and high in
 * `routes.errorIntake.test.js`, before the harness — and therefore `app.js` and
 * `config.js` — is imported.
 *
 * ── Why the limiter is not enough on its own ──
 *
 * It bounds requests from ONE address and says nothing about a thousand. The
 * 500-group ceiling in `errorReporter.js` bounds stored rows regardless of where
 * the traffic comes from. Neither subsumes the other; an unauthenticated write
 * needs both.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const LIMIT = 3;
let srv, db;

beforeAll(async () => {
  process.env.ERROR_REPORT_RATE_LIMIT = String(LIMIT);
  const { startTestServer } = await import('./testServer.js');
  srv = await startTestServer();
  ({ db } = await import('./db.js'));
}, 60000);

afterAll(async () => {
  await srv?.close();
  delete process.env.ERROR_REPORT_RATE_LIMIT;
});

const send = (i) =>
  fetch(`${srv.base}/api/errors/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'Error', message: `limited report ${i}`, route: '/events' }),
  });

describe('the error-report limiter', () => {
  it('accepts up to the limit, then refuses, and refusals never reach storage', async () => {
    const statuses = [];
    for (let i = 0; i < LIMIT + 3; i++) statuses.push((await send(i)).status);

    expect(
      statuses.slice(0, LIMIT),
      'the limiter refused a request inside its own allowance'
    ).toEqual(Array(LIMIT).fill(202));

    expect(
      statuses.slice(LIMIT),
      'the limiter never engaged — an unauthenticated write with no ceiling on requests'
    ).toEqual(Array(3).fill(429));

    /**
     * The refused requests must not have been recorded.
     *
     * A limiter that answered 429 *after* the row was written would bound the
     * response and not the storage, which is the half that matters — and the two
     * are easy to confuse, because both look like "the limiter works" from the
     * client side.
     *
     * Counted as OCCURRENCES, not as groups. The messages here differ only by a
     * number, and the fingerprint deliberately collapses numeric variation, so
     * the three accepted reports are one group with a counter of three. Counting
     * groups asserted the grouping behaviour instead of the limiter, and read as
     * "the limiter leaked" when it had not.
     */
    const recorded = db.prepare(
      "SELECT COALESCE(SUM(occurrences), 0) AS n FROM error_groups WHERE source = 'client'"
    ).get().n;
    expect(recorded, 'a rate-limited report still reached the database').toBe(LIMIT);
  }, 60000);

  it('answers a refusal as JSON, without leaking internals', async () => {
    const res = await send(99);
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(typeof body.error).toBe('string');
    expect(JSON.stringify(body)).not.toMatch(/at .*\.js:\d+/);
  });
});
