import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';

import {
  logEvent, logHttpRequest, logLifecycle, logSecurityEvent, shouldLogRequest,
} from './telemetry.js';
import {
  resolveTelemetryConfig, telemetrySinkStats, flushTelemetry, drainTelemetry, __resetTelemetrySink,
} from './telemetrySink.js';

/**
 * The telemetry boundary.
 *
 * ── What this file is actually guarding ──
 *
 * WeVolunteer's population is mostly minors, and telemetry is the one path that
 * carries this application's internals to a third party. The rule the
 * implementation is built around is a single line:
 *
 *   **Better Stack may hold exactly what `error_events` may hold, nothing more.**
 *
 * That bar comes from ENGINEERING_GUIDE §6.10, which sets it for the error table
 * after two release reviews probed the redactor with realistic PII and found
 * PARTIAL failures both times — the dangerous shape, because a partly-redacted
 * row still looks redacted. Reusing the bar means telemetry inherits that work
 * instead of answering the question again, differently.
 *
 * These cases are the enforcement. They are deliberately hostile: the point is
 * not that the four callers in `telemetry.js` behave, it is that a caller
 * nobody has written yet CANNOT leak, because the allowlist drops what it does
 * not recognise.
 *
 * ── Relationship to the existing error tests ──
 *
 * `errorReporter.test.js` owns the redactor itself — which patterns match, the
 * ReDoS bounds, the Unicode email rule. This file does not restate any of that.
 * It owns the two things that are new: that the allowlist drops unknown keys,
 * and that a telemetry failure cannot reach a request.
 */

/** Every key an attacker-ish caller might hope to smuggle through. */
const FORBIDDEN_INPUT = Object.freeze({
  password: 'hunter2',
  passwordHash: '$2a$10$abcdefghijklmnopqrstuv',
  token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig',
  authorization: 'Bearer sk_live_abcdefghijklmnop',
  cookie: 'wev_session=abc123; Path=/; HttpOnly',
  headers: { authorization: 'Bearer nope', cookie: 'wev_session=abc' },
  body: { email: 'leo.chen@example.com', password: 'hunter2' },
  requestBody: '{"password":"hunter2"}',
  responseBody: '{"users":[{"email":"a@b.com"}]}',
  email: 'leo.chen@lincolnhigh.k12.il.us',
  userId: 'user-student-1',
  userEmail: 'priya@school.org',
  name: 'Priya Patel',
  ip: '203.0.113.42',
  ipAddress: '203.0.113.42',
  dateOfBirth: '2009-04-30',
  address: '100 Reichler Park Drive',
  phone: '555-123-4567',
  totp: '123456',
  recoveryCode: 'ABCD-EFGH-IJKL',
  apiKey: 're_abcdefghijklmnop',
  sessionSecret: 's3cret',
  databaseUrl: 'postgres://postgres:hunter2@db.abc.supabase.co:5432/postgres',
  url: '/api/events?q=leo.chen%40example.com',
  query: 'q=leo.chen@example.com',
  user: { id: 'user-1', email: 'a@b.com' },
});

beforeEach(() => { __resetTelemetrySink(); });
afterEach(() => { __resetTelemetrySink(); vi.restoreAllMocks(); });

/* ── The allowlist ─────────────────────────────────────────────────────────── */

describe('what a telemetry record may contain', () => {
  /**
   * THE test. Not "these particular keys are dropped" — that is a denylist
   * written in a test file, and §6.10 says why a denylist is the wrong shape:
   * "a denylist fails on the first thing nobody thought of". This asserts the
   * property: NOTHING arrives except what the allowlist names.
   */
  it('drops every field it does not recognise, whatever the caller passes', () => {
    const record = logEvent('error', 'test.hostile', {
      ...FORBIDDEN_INPUT,
      statusCode: 500,
      route: '/api/events/:id',
    });

    for (const key of Object.keys(FORBIDDEN_INPUT)) {
      expect(record, `"${key}" reached the record`).not.toHaveProperty(key);
    }
    /* And the legitimate fields beside them still came through, so the test is
       not passing because everything was dropped. */
    expect(record.statusCode).toBe(500);
    expect(record.route).toBe('/api/events/:id');
  });

  it('carries no value from a forbidden field under any other name', () => {
    const record = logEvent('error', 'test.hostile', FORBIDDEN_INPUT);
    const serialised = JSON.stringify(record);
    for (const secret of [
      'hunter2', '$2a$10$abcdefghijklmnopqrstuv', 'eyJhbGciOiJIUzI1NiJ9',
      'sk_live_abcdefghijklmnop', 'wev_session', 'leo.chen', 'priya@school.org',
      're_abcdefghijklmnop', '203.0.113.42', 'ABCD-EFGH-IJKL', 'Reichler Park Drive',
    ]) {
      expect(serialised, `"${secret}" survived into the payload`).not.toContain(secret);
    }
  });

  /**
   * The allowlist protects the KEY. This protects the VALUE — a caller passing
   * a secret in a field that IS allowed, which is the realistic accident: an
   * error message that happens to interpolate an address.
   */
  it('redacts the values of fields it does keep', () => {
    const record = logEvent('error', 'test.message', {
      message: 'Failed to email josé.garcía@lincolnhigh.k12.il.us on 555-123-4567',
      stack: 'Error: connect postgres://postgres:hunter2@db.abc.supabase.co:5432/db',
    });
    expect(record.message).not.toContain('josé.garcía');
    expect(record.message).not.toContain('lincolnhigh');
    expect(record.message).not.toContain('555-123-4567');
    expect(record.message).toContain('[redacted]');
    expect(record.stack).not.toContain('hunter2');
  });

  it('keeps the record small enough to be a log line', () => {
    const record = logEvent('error', 'test.huge', {
      message: 'x'.repeat(50_000),
      stack: 'y'.repeat(50_000),
    });
    expect(record.message.length).toBeLessThanOrEqual(501);
    expect(record.stack.length).toBeLessThanOrEqual(4000);
  });

  /**
   * A wrong-typed value is dropped rather than coerced. `statusCode: '500 oops'`
   * stored as a status code makes a dashboard lie, and a dashboard that lies is
   * worse than a field that is missing.
   */
  it('drops values of the wrong type instead of coercing them', () => {
    const record = logEvent('info', 'test.types', {
      statusCode: '500 Internal Server Error',
      durationMs: NaN,
      ok: 'yes',
      requestId: { toString: () => 'nice try' },
    });
    expect(record).not.toHaveProperty('statusCode');
    expect(record).not.toHaveProperty('durationMs');
    expect(record).not.toHaveProperty('ok');
    expect(record).not.toHaveProperty('requestId');
  });

  /** An id is opaque by construction, so anything shaped otherwise is not one. */
  it('accepts only identifier-shaped correlation ids', () => {
    expect(logEvent('info', 'e', { requestId: 'b3f1c2d4-0000-4a1b-9c3d-1122334455aa' }).requestId)
      .toBe('b3f1c2d4-0000-4a1b-9c3d-1122334455aa');
    for (const bad of ['leo.chen@example.com', 'id with spaces', '<script>', 'a'.repeat(200)]) {
      expect(logEvent('info', 'e', { requestId: bad }), bad).not.toHaveProperty('requestId');
    }
  });
});

/* ── Structure ─────────────────────────────────────────────────────────────── */

describe('the shape of a record', () => {
  it('carries the fields a query needs to group by', () => {
    const record = logEvent('info', 'test.base');
    expect(record).toMatchObject({
      service: expect.any(String),
      environment: expect.any(String),
      level: 'info',
      event: 'test.base',
    });
    /* An ISO instant, which is the `dt` format Better Stack parses. */
    expect(new Date(record.dt).toISOString()).toBe(record.dt);
    expect(record.release, 'no release means no way to ask "did this start at 1.2.0?"').toBeTruthy();
  });

  it('names the instance without naming the machine', () => {
    const record = logEvent('info', 'test.instance');
    /* A hostname in a school district can name a building. This is a random id
       per boot: enough to tell two processes apart, and nothing else. */
    expect(record.instance).toMatch(/^i-[0-9a-f]{8}$/);
  });

  it('falls back to a known level rather than inventing one', () => {
    expect(logEvent('catastrophe', 'e').level).toBe('info');
    for (const level of ['debug', 'info', 'warn', 'error']) {
      expect(logEvent(level, 'e').level).toBe(level);
    }
  });

  it('never throws, whatever it is handed', () => {
    const hostile = { get message() { throw new Error('boom'); } };
    expect(() => logEvent('error', 'e', hostile)).not.toThrow();
    expect(() => logEvent(null, null, null)).not.toThrow();
    expect(() => logEvent('info', 'e', 'not an object')).not.toThrow();
  });
});

describe('the HTTP access record', () => {
  it('is built from the route pattern, not a URL', () => {
    /* `logHttpRequest` returns null when telemetry is off, so the shape is
       asserted through `logEvent`, which is what it calls. */
    const record = logEvent('info', 'http.request', {
      method: 'GET', route: '/api/events/:id', statusCode: 200, durationMs: 12,
    });
    expect(record.route).toBe('/api/events/:id');
  });

  /** Errors and refusals always; the morning-registration 200s are sampled. */
  it('always logs failures, refusals and slow requests', () => {
    expect(shouldLogRequest(500, 5, 0.99)).toBe(true);
    expect(shouldLogRequest(403, 5, 0.99)).toBe(true);
    expect(shouldLogRequest(401, 5, 0.99)).toBe(true);
    expect(shouldLogRequest(429, 5, 0.99)).toBe(true);
    expect(shouldLogRequest(200, 4000, 0.99)).toBe(true);
  });

  it('samples ordinary successes', () => {
    expect(shouldLogRequest(200, 5, 0.99)).toBe(false);
    expect(shouldLogRequest(200, 5, 0.001)).toBe(true);
  });

  it('logs a request whose status is unknown rather than guessing', () => {
    expect(shouldLogRequest(undefined, 5, 0.99)).toBe(true);
  });
});

describe('the security record', () => {
  /**
   * The action NAME only. An audit row's `details` is prose written at ~30 call
   * sites and names people by construction — "Suspended Chris Vale".
   */
  it('carries the action and never the audit details', () => {
    const record = logEvent('info', 'security.action', {
      operation: 'ACCOUNT_SUSPENDED',
      details: 'Suspended Chris Vale for messaging a student',
    });
    expect(record.operation).toBe('ACCOUNT_SUSPENDED');
    expect(record).not.toHaveProperty('details');
    expect(JSON.stringify(record)).not.toContain('Chris Vale');
  });
});

/* ── Configuration ─────────────────────────────────────────────────────────── */

describe('deciding whether to send anything at all', () => {
  const base = { BETTERSTACK_SOURCE_TOKEN: 't', BETTERSTACK_INGESTING_HOST: 'h.example.com' };

  it('is off when nothing is configured — the default', () => {
    expect(resolveTelemetryConfig({})).toMatchObject({ enabled: false, reason: 'not_configured' });
  });

  it('is off with a token and no host, and with a host and no token', () => {
    expect(resolveTelemetryConfig({ BETTERSTACK_SOURCE_TOKEN: 't' }).enabled).toBe(false);
    expect(resolveTelemetryConfig({ BETTERSTACK_INGESTING_HOST: 'h' }).enabled).toBe(false);
  });

  /**
   * THE test for "tests must not send real telemetry". Checked BEFORE the token
   * is read, so a developer whose shell exports production credentials cannot
   * ship fixture data into a real account by running the suite.
   */
  it('refuses to send from a test run even when fully configured', () => {
    expect(resolveTelemetryConfig({ ...base, VITEST: 'true' }))
      .toMatchObject({ enabled: false, reason: 'test_environment' });
  });

  it('lets a test opt in by name, for the transport cases below', () => {
    expect(resolveTelemetryConfig({ ...base, VITEST: 'true', WEV_TELEMETRY_TEST_SINK: '1' }).enabled)
      .toBe(true);
  });

  it('accepts a bare host or a full URL', () => {
    expect(resolveTelemetryConfig(base).endpoint).toBe('https://h.example.com/');
    expect(resolveTelemetryConfig({ ...base, BETTERSTACK_INGESTING_HOST: 'https://h.example.com' }).endpoint)
      .toBe('https://h.example.com/');
  });

  it('refuses a malformed host rather than failing once per batch for ever', () => {
    for (const host of ['ftp://h', 'not a host', '://']) {
      expect(resolveTelemetryConfig({ ...base, BETTERSTACK_INGESTING_HOST: host }).enabled, host)
        .toBe(false);
    }
  });

  /**
   * The payload carries a bearer token and redacted-but-real diagnostics.
   * Sending it in clear over the public internet would undo the redaction.
   */
  it('refuses plain HTTP in production', () => {
    const env = { ...base, BETTERSTACK_INGESTING_HOST: 'http://h.example.com', NODE_ENV: 'production' };
    expect(resolveTelemetryConfig(env)).toMatchObject({ enabled: false, reason: 'insecure_host' });
  });

  it('allows plain HTTP outside production, for a local stub', () => {
    const env = { ...base, BETTERSTACK_INGESTING_HOST: 'http://127.0.0.1:1', NODE_ENV: 'development' };
    expect(resolveTelemetryConfig(env).enabled).toBe(true);
  });

  it('queues nothing while disabled', () => {
    logEvent('error', 'test.disabled', { message: 'x' });
    expect(telemetrySinkStats().pending).toBe(0);
    expect(telemetrySinkStats().queued).toBe(0);
  });
});

/* ── The wire ──────────────────────────────────────────────────────────────── */

describe('delivery', () => {
  let server, received, url;

  /** A stub standing in for the ingesting host, so the POST is real. */
  const startStub = async (handler) => {
    received = [];
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        received.push({ method: req.method, auth: req.headers.authorization, body });
        if (handler) handler(req, res); else res.writeHead(202).end('{}');
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    url = `http://127.0.0.1:${server.address().port}`;
  };

  const withSink = (fn) => {
    const prev = { ...process.env };
    process.env.WEV_TELEMETRY_TEST_SINK = '1';
    process.env.BETTERSTACK_SOURCE_TOKEN = 'test-source-token';
    process.env.BETTERSTACK_INGESTING_HOST = url;
    __resetTelemetrySink();
    return Promise.resolve(fn()).finally(() => {
      process.env = prev;
      __resetTelemetrySink();
    });
  };

  afterEach(async () => {
    if (server) { server.close(); await once(server, 'close').catch(() => {}); server = null; }
  });

  it('posts a JSON array with the source token as a bearer credential', async () => {
    await startStub();
    await withSink(async () => {
      logEvent('error', 'test.delivery', { message: 'hello', statusCode: 500 });
      await flushTelemetry();

      expect(received).toHaveLength(1);
      expect(received[0].method).toBe('POST');
      expect(received[0].auth).toBe('Bearer test-source-token');

      const batch = JSON.parse(received[0].body);
      expect(Array.isArray(batch), 'the ingest API takes an array').toBe(true);
      expect(batch[0]).toMatchObject({ event: 'test.delivery', level: 'error', statusCode: 500 });
      expect(batch[0].dt).toBeTruthy();
    });
  });

  it('batches several records into one request', async () => {
    await startStub();
    await withSink(async () => {
      for (let i = 0; i < 5; i++) logEvent('info', 'test.batch', { count: i });
      await flushTelemetry();
      expect(received).toHaveLength(1);
      expect(JSON.parse(received[0].body)).toHaveLength(5);
    });
  });

  /* ── The property that matters more than delivery ── */

  it('does not throw when the endpoint refuses the batch', async () => {
    await startStub((req, res) => res.writeHead(500).end('nope'));
    await withSink(async () => {
      logEvent('error', 'test.rejected', { message: 'x' });
      await expect(flushTelemetry()).resolves.toBeUndefined();
      expect(telemetrySinkStats().failed).toBe(1);
    });
  });

  it('does not throw when the endpoint is unreachable', async () => {
    const prev = { ...process.env };
    process.env.WEV_TELEMETRY_TEST_SINK = '1';
    process.env.BETTERSTACK_SOURCE_TOKEN = 't';
    /* Port 1 on loopback: nothing listens, so the connection is refused. */
    process.env.BETTERSTACK_INGESTING_HOST = 'http://127.0.0.1:1';
    __resetTelemetrySink();
    try {
      logEvent('error', 'test.unreachable', { message: 'x' });
      await expect(flushTelemetry()).resolves.toBeUndefined();
      expect(telemetrySinkStats().failed).toBe(1);
    } finally {
      process.env = prev;
      __resetTelemetrySink();
    }
  });

  /**
   * A retry loop against an endpoint that is down is how a telemetry outage
   * becomes a memory leak, and the records it would preserve are the least
   * valuable thing the process is holding.
   */
  it('discards a failed batch rather than requeueing it for ever', async () => {
    await startStub((req, res) => res.writeHead(503).end());
    await withSink(async () => {
      logEvent('error', 'test.drop', { message: 'x' });
      await flushTelemetry();
      expect(telemetrySinkStats().pending).toBe(0);
    });
  });

  it('bounds memory, dropping the oldest when the queue is full', async () => {
    await startStub();
    await withSink(async () => {
      /* More than MAX_QUEUE (500) without flushing. `enqueue` auto-flushes at
         MAX_BATCH, so the stub absorbs most of it; what matters is that the
         queue never grows without limit and the drops are counted. */
      for (let i = 0; i < 1200; i++) logEvent('info', 'test.flood', { count: i });
      expect(telemetrySinkStats().pending).toBeLessThanOrEqual(500);
    });
  });
});

/* ── The application must not care ─────────────────────────────────────────── */

describe('telemetry cannot become the application\'s problem', () => {
  it('returns a record rather than a promise, so no caller can await it', () => {
    const record = logEvent('info', 'test.sync');
    expect(record).not.toBeInstanceOf(Promise);
    expect(record.event).toBe('test.sync');
  });

  it('survives a fetch that throws synchronously', async () => {
    const prev = { ...process.env };
    process.env.WEV_TELEMETRY_TEST_SINK = '1';
    process.env.BETTERSTACK_SOURCE_TOKEN = 't';
    process.env.BETTERSTACK_INGESTING_HOST = 'http://127.0.0.1:1';
    __resetTelemetrySink();
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('boom'); });
    try {
      logEvent('error', 'test.throwing-fetch', { message: 'x' });
      await expect(flushTelemetry()).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
      process.env = prev;
      __resetTelemetrySink();
    }
  });

  it('flushes safely when nothing is configured', async () => {
    await expect(flushTelemetry()).resolves.toBeUndefined();
  });

  it('lifecycle and security helpers are no-ops while disabled', () => {
    expect(logSecurityEvent('ACCOUNT_SUSPENDED', {})).toBeNull();
    /* `logLifecycle` still builds a record — boot and shutdown are worth having
       even locally — but nothing is queued. */
    expect(logLifecycle('boot', { ok: true }).event).toBe('lifecycle.boot');
    expect(telemetrySinkStats().queued).toBe(0);
  });

  it('logHttpRequest is a no-op while disabled', () => {
    expect(logHttpRequest({ method: 'GET', route: '/x', statusCode: 500, durationMs: 1 })).toBeNull();
  });
});

/**
 * The security pulse, now that `recordAudit` emits one.
 *
 * The audit table is the record. This is so somebody watching Better Stack can
 * see that privileged actions are happening at all — without opening a
 * `super_admin` screen, and without the vendor learning who they happened to.
 */
describe('what an audit action tells the vendor', () => {
  it('carries the action name and nothing that names a person', () => {
    const record = logEvent('info', 'security.action', {
      operation: 'ACCOUNT_SUSPENDED',
      /* Every field `recordAudit` actually holds beside the action. */
      details: 'Suspended Chris Vale for messaging a student after being asked to stop',
      targetUserId: 'user-student-2',
      adminId: 'user-admin',
    });
    expect(record.operation).toBe('ACCOUNT_SUSPENDED');
    for (const key of ['details', 'targetUserId', 'adminId']) {
      expect(record, key).not.toHaveProperty(key);
    }
    const serialised = JSON.stringify(record);
    expect(serialised).not.toContain('Chris Vale');
    expect(serialised).not.toContain('user-student-2');
    expect(serialised).not.toContain('user-admin');
  });

  it('is reached from recordAudit without the audit row depending on it', async () => {
    const { recordAudit } = await import('./auditLog.js');
    /* A database handle whose INSERT works, so the audit row succeeds. The
       point is that the call returns normally with telemetry disabled — which
       is the state every test and every unconfigured deployment runs in. */
    const calls = [];
    const fakeDb = {
      prepare: () => ({ run: async (...args) => { calls.push(args); return { changes: 1 }; } }),
    };
    const result = await recordAudit(fakeDb, {
      adminId: 'system-cli', action: 'EVENT_HOURS_CLOSED_OUT',
      targetUserId: null, details: 'Closed out the hours for "Park Cleanup"',
    });
    expect(result.id, 'the audit row is what matters and it must still be written').toBeTruthy();
    expect(calls).toHaveLength(1);
  });
});

/* ── The shutdown drain ─────────────────────────────────────────────────────
 *
 * `flushTelemetry` posts one batch of 50. A shutdown must send everything —
 * the records describing WHY the process is restarting are the ones worth
 * keeping — while still ending, because systemd's patience is finite.
 *
 * These cases pin all three bounds and the boundary sizes around MAX_BATCH.
 */
describe('draining telemetry at shutdown', () => {
  let server, received, url;

  const startStub = async ({ status = 202, delayMs = 0 } = {}) => {
    received = [];
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try { received.push(...JSON.parse(body)); } catch { /* ignore */ }
        const send = () => res.writeHead(status).end('{}');
        if (delayMs) setTimeout(send, delayMs); else send();
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    url = `http://127.0.0.1:${server.address().port}`;
  };

  const withSink = async (host, fn) => {
    const prev = { ...process.env };
    process.env.WEV_TELEMETRY_TEST_SINK = '1';
    process.env.BETTERSTACK_SOURCE_TOKEN = 'drain-token';
    process.env.BETTERSTACK_INGESTING_HOST = host;
    __resetTelemetrySink();
    try { return await fn(); } finally { process.env = prev; __resetTelemetrySink(); }
  };

  afterEach(async () => {
    if (server) { server.close(); await once(server, 'close').catch(() => {}); server = null; }
  });

  /* The sizes that matter: side of one batch, exactly one, just over, and well
     over — the arithmetic around `MAX_BATCH` is where an off-by-one lives. */
  for (const n of [1, 49, 50, 51, 100, 320]) {
    it(`delivers all ${n} queued record(s)`, async () => {
      await startStub();
      await withSink(url, async () => {
        for (let i = 0; i < n; i++) logEvent('info', 'drain.case', { count: i });
        await drainTelemetry();

        expect(received).toHaveLength(n);
        expect(telemetrySinkStats().pending).toBe(0);
      });
    });
  }

  /** Nothing may arrive twice, however the batches happened to split. */
  it('delivers each record exactly once', async () => {
    await startStub();
    await withSink(url, async () => {
      for (let i = 0; i < 120; i++) logEvent('info', 'drain.unique', { count: i });
      await drainTelemetry();

      const counts = received.map(r => r.count).sort((a, b) => a - b);
      expect(counts).toHaveLength(120);
      expect(new Set(counts).size, 'a record was delivered twice').toBe(120);
    });
  });

  it('is safe to call twice, as a re-entered shutdown would', async () => {
    await startStub();
    await withSink(url, async () => {
      for (let i = 0; i < 60; i++) logEvent('info', 'drain.twice', { count: i });
      await drainTelemetry();
      await expect(drainTelemetry()).resolves.toBeUndefined();
      expect(received).toHaveLength(60);
    });
  });

  it('is safe with nothing queued', async () => {
    await startStub();
    await withSink(url, async () => {
      await expect(drainTelemetry()).resolves.toBeUndefined();
      expect(received).toHaveLength(0);
    });
  });

  /**
   * THE bound that protects the deploy. Against an unreachable endpoint every
   * pass costs a request timeout; eleven of those is 55 seconds, on top of the
   * 15-second request drain, against systemd's 90-second patience. Stopping at
   * the first failure keeps a Better Stack outage from turning a restart into a
   * SIGKILL.
   */
  it('stops at the first failed pass rather than paying a timeout per batch', async () => {
    await startStub({ status: 503 });
    await withSink(url, async () => {
      for (let i = 0; i < 300; i++) logEvent('info', 'drain.failing', { count: i });

      const started = Date.now();
      await drainTelemetry();
      const elapsed = Date.now() - started;

      /* One pass attempted, not six. */
      expect(telemetrySinkStats().batches).toBe(1);
      expect(elapsed, 'the drain kept retrying a dead endpoint').toBeLessThan(2000);
    });
  });

  it('does not hang when the endpoint never answers', async () => {
    /* Port 1 on loopback: connection refused immediately, which is the fast
       failure. The slow one is covered by the request timeout itself. */
    await withSink('http://127.0.0.1:1', async () => {
      for (let i = 0; i < 200; i++) logEvent('info', 'drain.dead', { count: i });
      const started = Date.now();
      await expect(drainTelemetry()).resolves.toBeUndefined();
      expect(Date.now() - started).toBeLessThan(6000);
    });
  }, 15000);

  /**
   * A slow-but-WORKING endpoint is the case the first-failure exit does not
   * cover, and the one where a large queue can still outrun the shutdown budget.
   * Ten batches at 120ms is 1.2s of delivery; a 250ms deadline must cut it off
   * partway rather than run it to completion.
   */
  it('honours its own deadline against a slow endpoint', async () => {
    await startStub({ delayMs: 120 });
    await withSink(url, async () => {
      for (let i = 0; i < 500; i++) logEvent('info', 'drain.slow', { count: i });

      const started = Date.now();
      await drainTelemetry({ deadlineMs: 250 });
      const elapsed = Date.now() - started;

      /* Well short of the ten passes the queue would otherwise take. */
      expect(telemetrySinkStats().batches, 'the deadline did not stop the drain').toBeLessThan(6);
      expect(elapsed).toBeLessThan(1000);
      /* It stops early, so not everything arrives — that is the trade, and what
         remains is left bounded rather than delivered. */
      expect(telemetrySinkStats().pending).toBeGreaterThan(0);
      expect(telemetrySinkStats().pending).toBeLessThanOrEqual(500);
    });
  }, 15000);

  /** The queue cap holds even while a drain is running. */
  it('keeps the queue bounded under a burst', async () => {
    await startStub();
    await withSink(url, async () => {
      for (let i = 0; i < 5000; i++) logEvent('info', 'drain.burst', { count: i });
      expect(telemetrySinkStats().pending).toBeLessThanOrEqual(500);
      expect(telemetrySinkStats().dropped).toBeGreaterThan(0);
      await drainTelemetry();
    });
  }, 15000);
});
