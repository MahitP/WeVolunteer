/**
 * The whole pipeline, against a real OTLP endpoint — a stub on loopback, but a
 * real HTTP server speaking the real protocol over the real exporter.
 *
 * ── Why the strongest assertions here are about RAW BYTES ──
 *
 * `observability.privacy.test.js` proves the scrubber removes what it should,
 * given a span. This file proves the thing that actually matters: that the bytes
 * which leave the process do not contain the email address, the street address
 * or the IP that went in. Protobuf encodes strings as their own bytes, so a
 * substring search of the decompressed request body is a direct, honest test of
 * what Better Stack would receive — one that cannot be satisfied by a scrubber
 * that runs in the wrong place, or by a second code path nobody remembered.
 *
 * ── Why this suite is allowed to send at all ──
 *
 * `resolveOtelConfig` refuses under `VITEST` unless `WEV_OTEL_TEST_SINK=1`, and
 * the host below is `127.0.0.1`. Nothing here can reach a real account.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { once } from 'node:events';

import { startOtel, shutdownOtel, otelStatus, otelSnapshot, __resetOtelForTests } from './observability/otel.js';
import { withSpan } from './observability/spans.js';
import { currentTraceIds } from './observability/correlation.js';

/**
 * An OTLP endpoint that records what it was sent and can be told to misbehave.
 */
function createOtlpStub() {
  const requests = [];
  let mode = 'ok';
  let held = [];

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      let body = raw;
      if (req.headers['content-encoding'] === 'gzip') {
        try { body = gunzipSync(raw); } catch { /* record it as it arrived */ }
      }
      requests.push({
        url: req.url,
        headers: req.headers,
        contentType: req.headers['content-type'],
        encoding: req.headers['content-encoding'],
        /* latin1 preserves every byte one-for-one; protobuf is not valid UTF-8
           and a lossy decode could destroy the very substring being searched. */
        text: body.toString('latin1'),
        bytes: body.length,
      });

      if (mode === 'error') { res.writeHead(500); res.end('nope'); return; }
      if (mode === 'hang') { held.push(res); return; }
      res.writeHead(200, { 'Content-Type': 'application/x-protobuf' });
      res.end();
    });
  });

  return {
    server,
    requests,
    setMode(next) { mode = next; },
    releaseHeld() { for (const res of held) { try { res.writeHead(200); res.end(); } catch { /* gone */ } } held = []; },
    tracesFor() { return requests.filter(r => r.url === '/v1/traces'); },
    metricsFor() { return requests.filter(r => r.url === '/v1/metrics'); },
    reset() { requests.length = 0; mode = 'ok'; },
  };
}

/** Everything the exporter was ever sent, as one searchable string. */
function wireText(stub) {
  return stub.requests.map(r => r.text).join(' ');
}

let stub;
let stubPort;
const TOKEN = 'stub-token-not-a-real-credential';

beforeAll(async () => {
  stub = createOtlpStub();
  stub.server.listen(0, '127.0.0.1');
  await once(stub.server, 'listening');
  stubPort = stub.server.address().port;
});

afterAll(async () => {
  await shutdownOtel();
  __resetOtelForTests();
  stub.releaseHeld();
  await new Promise((resolve) => stub.server.close(resolve));
});

function startAgainstStub(overrides = {}) {
  __resetOtelForTests();
  return startOtel({
    VITEST: '1',
    WEV_OTEL_TEST_SINK: '1',
    BETTERSTACK_SOURCE_TOKEN: TOKEN,
    BETTERSTACK_INGESTING_HOST: `http://127.0.0.1:${stubPort}`,
    NODE_ENV: 'test',
    APP_RELEASE: '1.2.0-test',
    TELEMETRY_SERVICE_NAME: 'wevolunteer-test',
    OTEL_TRACE_SAMPLE_RATE: '1',
    OTEL_TRACE_DAILY_SPAN_BUDGET: '100000',
    ...overrides,
  });
}

/** Waits long enough for the 2s batch delay to fire. */
async function settle(ms = 2600) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('startOtel', () => {
  beforeEach(() => { stub.reset(); });

  it('starts against a configured endpoint', () => {
    const status = startAgainstStub();
    expect(status.enabled).toBe(true);
    expect(otelStatus().enabled).toBe(true);
  });

  it('reports the ESM hook as NOT preloaded, because Vitest does not preload it', () => {
    /* `esmHook` means "register.mjs ran via --import, before the module graph
       was loaded" — not "module.register() was called". The distinction is the
       one that cost a production defect: the in-process call works for a
       DYNAMIC import and does nothing for a static one, which is what
       `server.js` uses.
       
       Vitest does not pass --import, so false is the correct answer here and a
       `true` would mean the flag had stopped meaning anything. The preloaded
       case is covered in `observability.production.test.js`, which spawns a real
       node both ways. */
    startAgainstStub();
    expect(otelSnapshot().esmHook).toBe(false);
  });

  it('is a no-op when called twice', () => {
    startAgainstStub();
    const before = otelSnapshot();
    startOtel({ BETTERSTACK_SOURCE_TOKEN: 'other', BETTERSTACK_INGESTING_HOST: 'https://elsewhere.example' });
    expect(otelSnapshot().config).toEqual(before.config);
  });

  it('does not start, and does not throw, when unconfigured', () => {
    __resetOtelForTests();
    expect(startOtel({ VITEST: '1' }).enabled).toBe(false);
    expect(otelSnapshot()).toBeNull();
  });
});

describe('spans reach the wire', () => {
  beforeEach(() => { stub.reset(); });

  it('posts protobuf, gzipped, to /v1/traces with a bearer token', async () => {
    startAgainstStub();
    withSpan('event.signup', { component: 'test' }, () => 'done');
    await settle();

    const traces = stub.tracesFor();
    expect(traces.length).toBeGreaterThan(0);
    const first = traces[0];
    expect(first.contentType).toBe('application/x-protobuf');
    expect(first.encoding).toBe('gzip');
    expect(first.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('carries the span name and the service identity', async () => {
    startAgainstStub();
    withSpan('attendance.finalize', {}, () => 42);
    await settle();
    const text = wireText(stub);
    expect(text).toContain('attendance.finalize');
    expect(text).toContain('wevolunteer-test');
    expect(text).toContain('1.2.0-test');
  });

  it('never puts the source token in the payload — only in the header', async () => {
    startAgainstStub();
    withSpan('event.create', {}, () => 1);
    await settle();
    expect(wireText(stub)).not.toContain(TOKEN);
  });

  it('records an exception on a failing operation, redacted', async () => {
    startAgainstStub();
    expect(() => withSpan('event.create', {}, () => {
      throw new Error('Duplicate account for chris.vale@school.org');
    })).toThrow();
    await settle();

    const text = wireText(stub);
    expect(text).toContain('event.create');
    /* The exception is recorded, but the address inside it is not on the wire. */
    expect(text).not.toContain('chris.vale@school.org');
  });
});

describe('metrics reach the wire', () => {
  beforeEach(() => { stub.reset(); });

  it('posts to /v1/metrics on shutdown, carrying the instrument names', async () => {
    startAgainstStub();
    const { recordHttpRequest } = await import('./observability/metrics.js');
    recordHttpRequest({ method: 'GET', route: '/api/events/:id', statusCode: 200, durationMs: 12 });
    recordHttpRequest({ method: 'GET', route: '/api/events/:id', statusCode: 403, durationMs: 3 });

    /* The periodic reader runs every 60s; its shutdown forces the final export,
       which is the same code path a deploy actually exercises. */
    await shutdownOtel();

    const metrics = stub.metricsFor();
    expect(metrics.length).toBeGreaterThan(0);
    const text = metrics.map(m => m.text).join('');
    expect(text).toContain('http.server.request.duration');
    expect(text).toContain('wev.http.refusals');
  });

  it('carries no identifier as a metric label', async () => {
    startAgainstStub();
    const { recordHttpRequest, recordBusinessOperation } = await import('./observability/metrics.js');
    recordHttpRequest({ method: 'GET', route: '/api/events/:id', statusCode: 200, durationMs: 5 });
    recordBusinessOperation('event.signup', 'ok');
    await shutdownOtel();

    const text = stub.metricsFor().map(m => m.text).join('');
    expect(text).toContain('http.route');
    /* The status CLASS, never the code — the difference is a threefold series
       count for no extra answer. */
    expect(text).toContain('http.response.status_class');
    expect(text).not.toContain('http.response.status_code');
  });
});

describe('the correlation between a log record and its trace', () => {
  beforeEach(() => { stub.reset(); });

  it('reports the active trace and span ids inside a span', () => {
    startAgainstStub();
    const ids = withSpan('welly.answer', {}, () => currentTraceIds());
    expect(ids.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(ids.spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('reports nothing outside a span, rather than a zero id', () => {
    startAgainstStub();
    expect(currentTraceIds()).toEqual({});
  });

  it('produces ids a telemetry log record will accept as `id` fields', async () => {
    startAgainstStub();
    const { logEvent } = await import('./telemetry.js');
    const record = withSpan('search.discover', {}, () => logEvent('info', 'test.event', {}));
    /* `telemetry.js` drops an `id` that fails ID_SHAPE or looks like a JWT. If
       the ids did not survive that, the two signals would silently not join up
       and nothing would say so. */
    expect(record.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(record.spanId).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('failure injection — Better Stack being down is not an outage', () => {
  beforeEach(() => { stub.reset(); });

  it('survives HTTP 500 from the endpoint', async () => {
    startAgainstStub();
    stub.setMode('error');
    expect(() => withSpan('event.signup', {}, () => 'still works')).not.toThrow();
    await settle();
    expect(stub.tracesFor().length).toBeGreaterThan(0);
    stub.setMode('ok');
  });

  it('survives a connection refused', async () => {
    /* Port 1 on loopback: nothing listens, and the OS refuses immediately. */
    __resetOtelForTests();
    startOtel({
      VITEST: '1', WEV_OTEL_TEST_SINK: '1',
      BETTERSTACK_SOURCE_TOKEN: TOKEN,
      BETTERSTACK_INGESTING_HOST: 'http://127.0.0.1:1',
      OTEL_TRACE_SAMPLE_RATE: '1', OTEL_TRACE_DAILY_SPAN_BUDGET: '1000',
    });
    expect(withSpan('event.signup', {}, () => 'served')).toBe('served');
    await settle();
    expect(otelStatus().enabled).toBe(true);
  });

  it('survives a DNS failure', async () => {
    __resetOtelForTests();
    startOtel({
      VITEST: '1', WEV_OTEL_TEST_SINK: '1',
      BETTERSTACK_SOURCE_TOKEN: TOKEN,
      BETTERSTACK_INGESTING_HOST: 'http://this-host-does-not-exist.invalid',
      OTEL_TRACE_SAMPLE_RATE: '1', OTEL_TRACE_DAILY_SPAN_BUDGET: '1000',
    });
    expect(withSpan('event.create', {}, () => 'served')).toBe('served');
    await settle();
    expect(otelStatus().enabled).toBe(true);
  });

  it('keeps serving through a burst far larger than the batch queue', async () => {
    startAgainstStub();
    stub.setMode('hang');
    /* 5,000 operations against an endpoint that never answers. The batch queue
       caps at 2,048 and drops beyond it; the process must simply carry on. */
    for (let i = 0; i < 5000; i++) withSpan('event.signup', {}, () => i);
    expect(otelStatus().enabled).toBe(true);
    expect(process.memoryUsage().heapUsed).toBeLessThan(1024 * 1024 * 1024);
    stub.releaseHeld();
    stub.setMode('ok');
  });
});

describe('shutdown is bounded even when the endpoint is not', () => {
  beforeEach(() => { stub.reset(); });

  it('returns within its deadline against an endpoint that never answers', async () => {
    startAgainstStub();
    stub.setMode('hang');
    withSpan('event.signup', {}, () => 1);

    const started = Date.now();
    const result = await shutdownOtel({ deadlineMs: 500 });
    const elapsed = Date.now() - started;

    /* The bound is the point. A generous ceiling is used because CI timing is
       noisy; the failure this guards against is tens of seconds, not tens of
       milliseconds. */
    expect(elapsed).toBeLessThan(3000);
    expect(result.flushed).toBe(false);
    expect(result.reason).toBe('deadline');

    stub.releaseHeld();
    stub.setMode('ok');
  });

  it('flushes cleanly when the endpoint is healthy', async () => {
    startAgainstStub();
    withSpan('attendance.close_out', {}, () => 1);
    const result = await shutdownOtel();
    expect(result.flushed).toBe(true);
    expect(stub.tracesFor().length).toBeGreaterThan(0);
  });

  it('a second shutdown does not export again', async () => {
    startAgainstStub();
    withSpan('event.signup', {}, () => 1);
    await shutdownOtel();
    const after = stub.requests.length;

    const second = await shutdownOtel();
    expect(second.reason).toBe('not_running');
    expect(stub.requests.length).toBe(after);
  });

  it('is a no-op, not an error, when OpenTelemetry was never started', async () => {
    __resetOtelForTests();
    await expect(shutdownOtel()).resolves.toMatchObject({ flushed: false, reason: 'not_running' });
  });
});

describe('the exporter does not trace itself', () => {
  beforeEach(() => { stub.reset(); });

  it('does not produce a span per export, which would be a feedback loop', async () => {
    startAgainstStub();
    withSpan('event.signup', {}, () => 1);
    await settle();
    const afterFirst = stub.requests.length;

    /* If exporting created spans, the count would keep climbing on its own with
       no further application activity. */
    await settle();
    expect(stub.requests.length).toBe(afterFirst);
  });
});

describe('the daily span budget is a real ceiling', () => {
  beforeEach(() => { stub.reset(); });

  it('stops exporting once the budget is spent', async () => {
    startAgainstStub({ OTEL_TRACE_DAILY_SPAN_BUDGET: '3' });
    for (let i = 0; i < 200; i++) withSpan('event.signup', {}, () => i);
    await settle();

    const snapshot = otelSnapshot();
    expect(snapshot.budget.remaining).toBe(0);
    expect(snapshot.spansExported).toBeLessThanOrEqual(3);
  });

  it('a budget of zero means no spans are recorded at all', async () => {
    startAgainstStub({ OTEL_TRACE_DAILY_SPAN_BUDGET: '0' });
    for (let i = 0; i < 50; i++) withSpan('event.signup', {}, () => i);
    await settle();
    expect(stub.tracesFor()).toHaveLength(0);
    /* And the application still worked. */
    expect(withSpan('event.signup', {}, () => 'served')).toBe('served');
  });
});
