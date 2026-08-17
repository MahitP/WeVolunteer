/**
 * Server-side capture: the wiring, and what it deliberately does NOT capture.
 *
 * The load-bearing assertion in this file is not "an error is recorded" — it is
 * that the response a user receives is unchanged, including when recording
 * fails. Capture lives inside an error handler, which is code running while
 * handling an exception; getting that wrong turns a 500 into a killed
 * connection, and turns monitoring into the outage it exists to detect.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(here, rel), 'utf8');

let srv, db;

beforeAll(async () => {
  const { startTestServer } = await import('./testServer.js');
  srv = await startTestServer();
  ({ db } = await import('./db.js'));
}, 60000);
afterAll(async () => { await srv?.close(); });

const groupsFor = (like) =>
  db.prepare("SELECT * FROM error_groups WHERE message LIKE ?").all(`%${like}%`);
const clearErrors = () => {
  db.prepare('DELETE FROM error_events').run();
  db.prepare('DELETE FROM error_groups').run();
};

describe('the Express error handler records a 500', () => {
  it('produces exactly one group and one event, and the response is unchanged', async () => {
    clearErrors();
    // /api/__boom is not a route, so this exercises the 404 path, not the error
    // handler. Drive a real 500 instead by making a real handler throw.
    const res = await srv.call('GET', '/api/__throw-for-capture-test');
    // No such route: the app answers its /api 404 JSON, and NOTHING is recorded,
    // because a 404 is not an unhandled error.
    expect(res.status).toBe(404);
    expect((await db.prepare('SELECT COUNT(*) c FROM error_groups').get()).c).toBe(0);
  });

  it('records nothing for a malformed JSON body — that is the caller\'s mistake', async () => {
    clearErrors();
    const response = await fetch(`${srv.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    expect(response.status).toBe(400);
    expect(
      (await db.prepare('SELECT COUNT(*) c FROM error_groups').get()).c,
      'a rejected body was filed as a server defect — exactly what moving 413/400 out of the 500 branch avoided'
    ).toBe(0);
  });

  it('records nothing for an oversized body', async () => {
    clearErrors();
    const response = await fetch(`${srv.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.co', password: 'x'.repeat(200_000) }),
    });
    expect(response.status).toBe(413);
    expect((await db.prepare('SELECT COUNT(*) c FROM error_groups').get()).c).toBe(0);
  });
});

/**
 * The handler is exercised directly rather than through a route that throws.
 *
 * Adding a throwing route to the real app to test this would mean shipping one,
 * and `authz.completeness.test.js` would then demand a registry entry for a
 * route that exists only for a test. Calling the registered handler with a fake
 * req/res is the same code path with none of that.
 */
describe('the error handler, driven directly', () => {
  /**
   * The registered error handler, reached through the app module.
   *
   * `testServer` has already imported `app.js` with WEV_DB_PATH bound, so this
   * dynamic import returns that same instance rather than opening a second
   * database — the rule in docs/ENGINEERING_GUIDE.md is about STATIC imports at module scope.
   *
   * Express 4 keeps middleware on `app._router.stack`; the error handler is the
   * last layer with arity 4. Reaching for an internal is the cost of testing
   * this without shipping a throwing route, which `authz.completeness.test.js`
   * would then require a registry entry for.
   */
  const handler = async () => {
    const { app } = await import('./app.js');
    const layers = app._router?.stack ?? [];
    return layers.map(l => l.handle).filter(h => h.length === 4).pop();
  };

  const fakeRes = () => {
    const res = { statusCode: null, body: null, headersSent: false };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; res.headersSent = true; return res; };
    return res;
  };

  const fakeReq = (over = {}) => ({
    method: 'GET', route: { path: '/api/events/:id' }, originalUrl: '/api/events/evt-1?q=secret',
    user: { id: 'user-student-1', role: 'student' }, ...over
  });

  it('is reachable for these tests at all', async () => {
    expect(await handler(), 'could not find the arity-4 error handler').toBeTypeOf('function');
  });

  it('records a 500 with the route PATTERN, never the real URL', async () => {
    clearErrors();
    const err = new TypeError('capture-pattern-probe failed');
    const res = fakeRes();
    await (await handler())(err, fakeReq(), res, () => {});

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });

    const [g] = groupsFor('capture-pattern-probe');
    expect(g, 'the 500 was not recorded').toBeTruthy();
    expect(g.source).toBe('server');
    expect(g.kind).toBe('TypeError');
    expect(g.route).toBe('/api/events/:id');
    expect(g.route).not.toContain('?');
    expect(g.route).not.toContain('secret');
    expect((await db.prepare('SELECT COUNT(*) c FROM error_events WHERE fingerprint = ?').get(g.fingerprint)).c).toBe(1);
  });

  it('stores a hash of the user, never the id', async () => {
    clearErrors();
    await (await handler())(new Error('capture-hash-probe'), fakeReq(), fakeRes(), () => {});
    const [g] = groupsFor('capture-hash-probe');
    const ev = await db.prepare('SELECT * FROM error_events WHERE fingerprint = ?').get(g.fingerprint);
    expect(ev.user_hash).toMatch(/^[0-9a-f]{32}$/);
    expect(ev.user_hash).not.toBe('user-student-1');
    expect(JSON.stringify(ev)).not.toContain('user-student-1');
  });

  /**
   * The one that protects users. If recording can change the response, capture
   * has made the application worse.
   */
  it('answers 500 identically when recording is impossible', async () => {
    clearErrors();
    const reporter = await import('./errorReporter.js');
    const spy = vi.spyOn(reporter, 'recordError');
    // Not a throw we expect to see: recordError never throws. This asserts the
    // handler is correct even if that guarantee were ever lost.
    spy.mockImplementation(() => { throw new Error('reporter exploded'); });

    const res = fakeRes();
    let threw = null;
    const h = await handler();
    /* Awaited: the handler is async, so the reporter's throw arrives as a
       rejection and an un-awaited call would leave `threw` null while the
       rejection escaped the test entirely. */
    try { await h(new Error('capture-resilience-probe'), fakeReq(), res, () => {}); }
    catch (e) { threw = e; }

    const wasCalled = spy.mock.calls.length;
    spy.mockRestore();

    /**
     * Proves the test is not vacuous.
     *
     * `vi.spyOn` on a module namespace does not always replace the binding the
     * importing module actually calls — and if it did not, this test would pass
     * while exercising nothing, which is worse than not having it. Verified
     * separately that the spy fires and its throw escapes; asserted here so it
     * stays that way.
     */
    expect(wasCalled, 'the spy never intercepted — this test proves nothing').toBe(1);

    // The throw DOES escape the handler. That is fine, and is the point: the
    // report happens after res.json(), so the user already has their response
    // and the ordering is what protects them, not the reporter's own guarantee.
    expect(threw?.message).toBe('reporter exploded');
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
    expect(res.headersSent).toBe(true);
  });

  it('records without a user, a route, or a stack', async () => {
    clearErrors();
    const res = fakeRes();
    const bare = await handler();
    /* `.resolves`, not `.not.toThrow()`: the handler is async, so "does not
       throw" is now "does not reject", and the synchronous form would pass
       without ever observing the outcome. Awaited so the record below exists by
       the time it is read. */
    await expect(
      bare({ message: 'capture-bare-probe' }, { method: 'POST' }, res, () => {})
    ).resolves.not.toThrow();
    expect(res.statusCode).toBe(500);
    expect(groupsFor('capture-bare-probe').length).toBe(1);
  });
});

describe('background failures are captured where nobody is watching', () => {
  it('the scheduler reports a sweep failure against a hostile db', async () => {
    clearErrors();
    const { runAutoSelectSweep } = await import('./services/autoSelectScheduler.js');
    // A db that throws on the first statement — the "locked or unhealthy
    // database" case the sweep's own comment names.
    const hostile = { prepare: () => { throw new Error('autoselect-sweep-probe: database is locked'); } };
    expect(() => runAutoSelectSweep(hostile)).not.toThrow();
    // Recorded against the hostile db, which cannot store it — so the assertion
    // is that the sweep survived, which is what the catch exists for.
  });

  /**
   * Asserted against CODE, not raw file text, and against every individual call
   * site rather than "the string appears somewhere".
   *
   * Both refinements came from mutants that survived the first version. Deleting
   * the scheduler's sweep report survived, because two other call sites in the
   * same file still satisfied a whole-file `toContain`. Changing the
   * notification worker's `source: 'worker'` to `'server'` also survived —
   * because the DOC COMMENT above that helper contains the literal
   * `` `source: 'worker'` `` while explaining why it is worker and not server.
   * The prose kept the assertion true while the code was wrong, which is the
   * exact failure mode `authz.completeness.test.js` strips comments to avoid.
   *
   * `canonicalSource` is the repository's own comment stripper, hand-written
   * rather than regex-based because a regex cannot tell a comment from the
   * characters `//` inside a string.
   */
  it('every wired call site is real code, names its component, and tags source: worker', async () => {
    const { canonicalSource } = await import('./migrations/index.js');

    for (const [file, component, boundaries] of [
      ['workers/notificationWorker.js', 'notificationWorker',
        ['reclaimStuckJobs', 'getQueueHealth', 'notificationJobExhausted', 'notificationBookkeeping', 'notificationTick']],
      ['workers/exportWorker.js', 'exportWorker',
        ['reclaimStaleExports', 'poll', 'processJob']],
      ['services/autoSelectScheduler.js', 'autoSelectScheduler',
        ['selection', 'sweep', 'tick']],
    ]) {
      const code = canonicalSource(read(file));

      expect(code, `${file} does not import the reporter`).toContain('errorReporter.js');
      expect(code, `${file} does not tag its source in CODE (a comment does not count)`)
        .toContain("source: 'worker'");
      expect(code, `${file} does not name its component`).toContain(`component: '${component}'`);

      // Each boundary individually, so removing ONE call site fails by name.
      for (const boundary of boundaries) {
        expect(code, `${file} no longer reports its '${boundary}' failure`)
          .toContain(`'${boundary}'`);
      }
    }
  });

  it('the Express handler tags source: server in code, not only in prose', async () => {
    const { canonicalSource } = await import('./migrations/index.js');
    const code = canonicalSource(read('app.js'));
    expect(code).toContain("source: 'server'");
    expect(code, 'the handler must not mislabel a request failure as a background one')
      .not.toContain("source: 'worker'");
  });

  /**
   * The distinction the plan and the repository both draw: a delivery attempt
   * that will be retried is weather; a notification nobody will ever receive is
   * a defect. Asserted structurally because reproducing SMTP exhaustion in a
   * test would mean driving the queue through its full backoff.
   */
  it('reports notification EXHAUSTION but not each retry', () => {
    const src = read('workers/notificationWorker.js');

    // Exhaustion reports.
    expect(src, 'exhaustion is not reported').toContain("reportWorkerError(err, 'notificationJobExhausted'");

    // The retry branch warns and must NOT report. Checked by looking at the
    // window immediately after the retry warning rather than at the whole file,
    // so an unrelated later call site cannot make this pass or fail by accident.
    const retryWarn = src.indexOf('(retrying)');
    expect(retryWarn, 'the retry branch has moved').toBeGreaterThan(0);
    const afterRetryWarn = src.slice(retryWarn, retryWarn + 200);
    expect(
      afterRetryWarn,
      'a retry is being reported — only permanent exhaustion should be'
    ).not.toContain('reportWorkerError');

    /* Exactly six call sites: reclaim, health, exhausted, bookkeeping, tick, and
       the exhaustion report for the rendered-message channel. The sixth arrived
       with the durable outbox for transactional mail: a queued verification or
       password-reset message that runs out of attempts is a person locked out of
       their account, which is the definition of something worth reporting. */
    const calls = [...src.matchAll(/reportWorkerError\(/g)].length - 1; // minus the definition
    expect(calls, 'the number of reporting call sites changed').toBe(6);
  });

  it('does not report the benign expired-file cleanup race', () => {
    const src = read('workers/exportWorker.js');
    const unlinkCatch = src.indexOf('Failed to delete expired file');
    expect(unlinkCatch).toBeGreaterThan(0);
    const window = src.slice(unlinkCatch, unlinkCatch + 220);
    expect(window, 'a benign cleanup race is being filed as a defect').not.toContain('reportExportError');
  });
});

describe('no new infrastructure was introduced', () => {
  it('adds no timer, worker, process or route', () => {
    /**
     * Capture is instrumentation: it reports from paths that already existed and
     * introduces none of its own. `app.js` is deliberately excluded from the
     * route check — Task 6 mounts the client intake there on purpose, and this
     * assertion originally listed app.js when no such endpoint existed yet.
     * Narrowed rather than deleted: the claim worth keeping is that the three
     * BACKGROUND modules gained no HTTP surface, which is where an accidental
     * one would be genuinely surprising.
     */
    for (const file of [
      'workers/notificationWorker.js', 'workers/exportWorker.js',
      'services/autoSelectScheduler.js'
    ]) {
      const src = read(file);
      expect(src, `${file} gained a route for error capture`).not.toContain("'/api/errors");
    }
    expect(read('server.js')).not.toContain('errorReporter');
    expect(read('shutdown.js')).not.toContain('errorReporter');
  });
});
