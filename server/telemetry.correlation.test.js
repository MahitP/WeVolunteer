import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { startTestServer } from './testServer.js';

/**
 * The correlation id, through the real server.
 *
 * ── What it is for ──
 *
 * One id that a developer can follow from a browser error to the backend's own
 * record of the same failure:
 *
 *   browser   ApiError.requestId        ← read from X-Request-Id
 *   report    POST /api/errors/report   ← echoes it back
 *   backend   error_events.context.requestId
 *   vendor    http.request + error.recorded, same id
 *
 * `telemetry.betterstack.test.js` owns what may be SENT. This file owns the
 * thread: that the id exists on every response, that it is this server's and not
 * a caller's, and that it reaches the stored row.
 *
 * ── Why through `startTestServer` ──
 *
 * The id is assigned by the FIRST middleware in `app.js`, deliberately ahead of
 * compression, helmet and the body parser, so that a request refused by any of
 * those still has one. That ordering is the property worth testing and it only
 * exists in the assembled app.
 */
/**
 * ── One server, and it runs with telemetry POINTED AT A DEAD PORT ──
 *
 * `startTestServer()` may be called once per file: `db.js` binds its connection
 * at module scope, so a second call finds the first throwaway path already open
 * and refuses rather than writing fixtures somewhere real.
 *
 * That constraint turns out to be an improvement. Telemetry is enabled for the
 * whole file and aimed at `127.0.0.1:1`, where nothing listens — so every send
 * fails, on every request, for the entire run. Each correlation assertion below
 * is therefore also an assertion that a total telemetry outage changes nothing
 * about what the server does.
 */
let srv, student;
const savedEnv = {};

beforeAll(async () => {
  for (const key of ['WEV_TELEMETRY_TEST_SINK', 'BETTERSTACK_SOURCE_TOKEN', 'BETTERSTACK_INGESTING_HOST']) {
    savedEnv[key] = process.env[key];
  }
  process.env.WEV_TELEMETRY_TEST_SINK = '1';
  process.env.BETTERSTACK_SOURCE_TOKEN = 'test-token-not-a-real-one';
  process.env.BETTERSTACK_INGESTING_HOST = 'http://127.0.0.1:1';
  (await import('./telemetrySink.js')).__resetTelemetrySink();

  srv = await startTestServer();
  student = await srv.login('leo.chen@example.com');
}, 60000);

afterAll(async () => {
  await srv?.close();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  (await import('./telemetrySink.js')).__resetTelemetrySink();
});

describe('the request id on a real response', () => {
  /* `testServer.call` hands back the fetch `Headers` object, not a plain one. */
  const idOf = (res) => res.headers.get('X-Request-Id');
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  it('is present on a successful response', async () => {
    const res = await srv.call('GET', '/api/events', undefined, student);
    expect(res.status).toBe(200);
    expect(idOf(res)).toMatch(UUID);
  });

  it('is present on an unauthenticated refusal', async () => {
    const res = await srv.call('GET', '/api/events', undefined, null);
    expect(res.status).toBe(401);
    expect(idOf(res), 'a refusal is exactly the response somebody will hunt for').toMatch(UUID);
  });

  it('is present on a 404', async () => {
    const res = await srv.call('GET', '/api/nope-does-not-exist', undefined, student);
    expect(res.status).toBe(404);
    expect(idOf(res)).toMatch(UUID);
  });

  it('is different for every request', async () => {
    const ids = [];
    for (let i = 0; i < 4; i++) {
      ids.push(idOf(await srv.call('GET', '/api/events', undefined, student)));
    }
    expect(new Set(ids).size).toBe(4);
  });

  /**
   * An inbound id is unauthenticated and would let anyone collide with somebody
   * else's trace, or poison a field a developer is searching. A proxy that wants
   * its own id can read this one out of the response.
   */
  it('ignores an id the caller supplied', async () => {
    const res = await srv.call('GET', '/api/events', undefined, student, {
      'X-Request-Id': 'attacker-chosen-value',
    });
    expect(idOf(res)).not.toBe('attacker-chosen-value');
    expect(idOf(res)).toMatch(UUID);
  });

  /** Correlation must not become a way to read something back out. */
  it('says nothing about who made the request', async () => {
    const res = await srv.call('GET', '/api/events', undefined, student);
    const id = idOf(res);
    expect(id).not.toContain('leo');
    expect(id).not.toContain('student');
    expect(id).toMatch(UUID);
  });
});

/**
 * The id reaching the stored error row, which is the half that makes it useful.
 *
 * `context.requestId` was added to `CONTEXT_KEYS` for this. It is safe there for
 * the reason the allowlist exists at all: it is a v4 UUID this server generated,
 * it names no person, and it carries no meaning outside this system.
 */
describe('the id on a client crash report', () => {
  const report = (body) => srv.call('POST', '/api/errors/report', body, null);

  /**
   * The stored context, or `{}`.
   *
   * `safeContext` returns NULL rather than an empty object when nothing survives
   * the allowlist — which is itself the property these cases care about, so it
   * is normalised here rather than asserted around at three call sites.
   */
  const contextOf = (row) => (row?.context ? JSON.parse(row.context) : {});

  /**
   * The stored row for a reported message, waited for rather than read once.
   *
   * `POST /api/errors/report` answers 202 **before** it writes — deliberately,
   * so a reporting failure can never become a client-visible one on a path with
   * no session to recover. That makes the write a race with any test that reads
   * straight afterwards, and the race is real: this passed on SQLite and failed
   * on PostgreSQL, where the round trip is slower. Polling is the honest fix,
   * because the endpoint's contract genuinely is "accepted, will be written".
   */
  const rowFor = async (message) => {
    const { db } = await import('./db.js');
    const query = db.prepare(`
      SELECT e.context FROM error_events e
        JOIN error_groups g ON g.fingerprint = e.fingerprint
       WHERE g.message = ?
       ORDER BY e.occurred_at DESC LIMIT 1
    `);
    for (let attempt = 0; attempt < 50; attempt++) {
      const row = await query.get(message);
      if (row) return row;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return undefined;
  };

  it('stores a well-formed id the client echoed back', async () => {
    const id = 'b3f1c2d4-0000-4a1b-9c3d-1122334455aa';
    const message = `correlated crash ${Math.random().toString(36).slice(2)}`;
    expect((await report({ kind: 'crash', message, route: '/', requestId: id })).status).toBe(202);

    const row = await rowFor(message);
    expect(row, 'the report was not stored at all').toBeTruthy();
    expect(contextOf(row).requestId).toBe(id);
  });

  /**
   * The intake is unauthenticated, so "the client validated it" means nothing.
   * A value that is not a plain id is dropped rather than corrected — a
   * corrected one would be a correlation id that correlates with nothing.
   */
  it('drops an id that is not identifier-shaped', async () => {
    const message = `hostile id ${Math.random().toString(36).slice(2)}`;
    await report({
      kind: 'crash', message, route: '/',
      requestId: 'leo.chen@example.com and some prose',
    });

    const row = await rowFor(message);
    expect(row).toBeTruthy();
    expect(contextOf(row).requestId).toBeUndefined();
    expect(row.context ?? '').not.toContain('leo.chen');
  });

  it('stores nothing extra when the client sends no id', async () => {
    const message = `uncorrelated crash ${Math.random().toString(36).slice(2)}`;
    await report({ kind: 'crash', message, route: '/' });

    const row = await rowFor(message);
    expect(row).toBeTruthy();
    /* Null, not `{}` — nothing survived the allowlist, so nothing is stored. */
    expect(row.context).toBeNull();
    expect(contextOf(row).requestId).toBeUndefined();
  });
});

/**
 * The property the whole integration rests on: **Better Stack is never a
 * dependency for serving a request.**
 *
 * These run with telemetry pointed at a port where nothing is listening, which
 * is the worst realistic case — every send fails, on every request, for as long
 * as the outage lasts. If the application notices, the design is wrong.
 */
describe('an unreachable Better Stack', () => {
  it('is genuinely enabled and genuinely failing, or the cases below prove nothing', async () => {
    const { telemetryEnabled, telemetrySinkStats } = await import('./telemetrySink.js');
    expect(telemetryEnabled(), 'telemetry was off, so nothing here was exercised').toBe(true);
    await srv.call('GET', '/api/events', undefined, student);
    const { flushTelemetry } = await import('./telemetrySink.js');
    await flushTelemetry();
    expect(telemetrySinkStats().failed, 'nothing was even attempted').toBeGreaterThan(0);
  });

  it('serves ordinary requests normally', async () => {
    const res = await srv.call('GET', '/api/events', undefined, student);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.events ?? res.body)).toBe(true);
  });

  it('still refuses what it should refuse', async () => {
    expect((await srv.call('GET', '/api/events', undefined, null)).status).toBe(401);
  });

  it('still answers the health check', async () => {
    const res = await srv.call('GET', '/health', undefined, null);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('still accepts a crash report and stores it', async () => {
    const res = await srv.call('POST', '/api/errors/report', {
      kind: 'crash', message: 'crash while telemetry is down', route: '/',
    }, null);
    expect(res.status).toBe(202);
  });

  it('does not slow a request down waiting for the vendor', async () => {
    const started = Date.now();
    await srv.call('GET', '/api/events', undefined, student);
    /* The sink's own request timeout is 5s. A response that waited on it would
       be well past this; one that did not is comfortably under. */
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('leaves nothing queued indefinitely', async () => {
    const { flushTelemetry, telemetrySinkStats } = await import('./telemetrySink.js');
    for (let i = 0; i < 3; i++) await srv.call('GET', '/api/events', undefined, student);
    await flushTelemetry();
    /* A failed batch is discarded rather than requeued: a retry loop against a
       dead endpoint is how a telemetry outage becomes a memory leak. */
    expect(telemetrySinkStats().pending).toBeLessThan(50);
  });
});

/**
 * The last link, checked on the wire.
 *
 * Everything above proves the id exists, is this server's, and reaches the
 * stored row. What it does not prove is the link an operator actually uses: the
 * id printed in a browser console is the id they can paste into Better Stack's
 * search and find the server's side of the same request.
 *
 * That claim can only be tested by looking at what was SENT, so this block —
 * alone in this file — points the sink at a stub that answers, rather than at a
 * dead port. It runs last so the outage cases above still ran against a genuinely
 * unreachable vendor.
 *
 * ── Why a 404 and a crash report, rather than a 500 ──
 *
 * Nothing in this application can be made to return 500 on demand, which is a
 * good property and an inconvenient one: the 500 branch of the error handler is
 * the natural subject here. So the two paths that DO carry an id to the vendor
 * are exercised instead — the access log (every 4xx is sent unsampled) and
 * `recordError`, which is the same function the 500 branch calls, reached
 * through the crash-report intake. What is not proven end-to-end is the error
 * handler's own `context: { requestId: req.id }`, which is read from the same
 * `req.id` the header is written from a few hundred lines above.
 */
describe('the id an operator would search Better Stack for', () => {
  let stub = null;
  let received = [];
  let base = null;

  beforeAll(async () => {
    received = [];
    stub = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try { received.push(...JSON.parse(body)); } catch { /* not ours */ }
        res.writeHead(202).end('{}');
      });
    });
    stub.listen(0, '127.0.0.1');
    await once(stub, 'listening');
    base = `http://127.0.0.1:${stub.address().port}`;

    process.env.BETTERSTACK_INGESTING_HOST = base;
    (await import('./telemetrySink.js')).__resetTelemetrySink();
  });

  afterAll(async () => {
    process.env.BETTERSTACK_INGESTING_HOST = 'http://127.0.0.1:1';
    (await import('./telemetrySink.js')).__resetTelemetrySink();
    if (stub) { stub.close(); await once(stub, 'close').catch(() => {}); stub = null; }
  });

  /** Everything delivered so far, after draining what is queued. */
  const delivered = async () => {
    const { drainTelemetry } = await import('./telemetrySink.js');
    await drainTelemetry();
    return received;
  };

  it('puts the response header id on the access record for the same request', async () => {
    const res = await srv.call('GET', '/api/definitely-not-a-route', undefined, null);
    expect(res.status).toBe(404);

    const id = res.headers.get('x-request-id');
    expect(id, 'the response carried no id to correlate on').toBeTruthy();

    const records = await delivered();
    const match = records.find((r) => r.event === 'http.request' && r.requestId === id);
    expect(match, 'no access record carried the id the client was given').toBeTruthy();
    expect(match.statusCode).toBe(404);
    expect(match.method).toBe('GET');
  });

  /**
   * And the URL did not travel with it. A 404 has no route pattern to report —
   * which is honest — but it must not be filled in with the real path, because a
   * real path is where the query strings and the email addresses are.
   */
  it('does not send the URL that produced the 404', async () => {
    await srv.call('GET', '/api/definitely-not-a-route?email=leo.chen%40example.com', undefined, null);

    const records = await delivered();
    const serialised = JSON.stringify(records);
    expect(serialised).not.toContain('definitely-not-a-route');
    expect(serialised).not.toContain('leo.chen');
  });

  /**
   * The error side of the thread, through `recordError` — the same function the
   * 500 branch of the error handler calls.
   */
  it('sends an error record carrying the id the client reported', async () => {
    const id = 'c4d5e6f7-0000-4b2c-8d3e-2233445566bb';
    const message = `wire-correlated crash ${Math.random().toString(36).slice(2)}`;
    expect((await srv.call('POST', '/api/errors/report', {
      kind: 'crash', message, route: '/', requestId: id,
    }, null)).status).toBe(202);

    /* The intake answers 202 before it writes, so the telemetry it emits is
       likewise not ready the instant the response lands. */
    let match;
    for (let attempt = 0; attempt < 50 && !match; attempt++) {
      const records = await delivered();
      match = records.find((r) => r.requestId === id && r.event !== 'http.request');
      if (!match) await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(match, 'no error record reached the vendor with the reported id').toBeTruthy();
    /* A fingerprint groups it; the id threads it to one request. Both, or the
       operator has a group they cannot narrow. */
    expect(match.fingerprint, 'the error record had no fingerprint').toBeTruthy();
    expect(JSON.stringify(match)).not.toContain('leo.chen');
  });

  it('never sends a session cookie or an authorization header', async () => {
    await srv.call('GET', '/api/events', undefined, student);
    await srv.call('GET', '/api/definitely-not-a-route', undefined, null);

    const serialised = JSON.stringify(await delivered());
    for (const forbidden of ['wev_session', 'Cookie', 'cookie', 'authorization', 'Bearer']) {
      expect(serialised, `"${forbidden}" reached the vendor`).not.toContain(forbidden);
    }
  });
});
