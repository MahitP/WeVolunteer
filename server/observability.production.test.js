/**
 * The one thing that cannot be tested from inside Vitest: module patching.
 *
 * ── Why this suite spawns a real `node` ──
 *
 * MEASURED. Inside Vitest, a request through a real Express app produced exactly
 * one span — the `http` one — with `esmHook` reporting `true` and no Express
 * span anywhere. That is not a bug in `otel.js`. Vitest loads modules through
 * vite-node's own module runner rather than Node's ESM loader, so the loader
 * hook `import-in-the-middle` installs never sees `import 'express'` and the
 * patch has nothing to apply to.
 *
 * Production does not run under vite-node. It runs `node server.js`, where the
 * same code was measured to produce four spans and a route-qualified name.
 *
 * So the claim "Express is instrumented" cannot honestly be proven by a test
 * that runs in the harness. Weakening the assertion until it passed would have
 * produced a green suite asserting nothing about the thing most likely to break
 * — and this is a repository whose own notes warn about a server that "starts,
 * serves, and is wrong". The subprocess below is the alternative: a real `node`,
 * the real import order from `server.js`, the real `otel.js`, a real Express
 * app, and a real OTLP endpoint.
 *
 * ── What it is NOT ──
 *
 * It is not the whole application: booting that needs a database, a JWT secret
 * and a seeded schema, and none of those participate in module patching. What is
 * under test here is the loading mechanism, and the loading mechanism is
 * identical.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * A standalone program that mirrors `server.js`'s import order exactly.
 *
 * The two lines that matter are the first two: the observability bootstrap is
 * imported BEFORE anything that pulls in Express, because ES imports are
 * evaluated in source order and a patch installed afterwards patches nobody.
 */
function programSource() {
  return `
import { startOtel, shutdownOtel, otelSnapshot } from ${JSON.stringify(path.join(HERE, 'observability/otel.js'))};

/*
 * Called with NO ARGUMENT, exactly as bootstrap.js calls it.
 *
 * The configuration reaches it through the child's real process.env, set by the
 * spawn below. An explicit env object here would have tested the resolver and
 * NOT the thing production depends on -- the (env = process.env) default. That
 * default surviving a mutation is what prompted this: break it and the
 * application boots, logs "not_configured", serves every request correctly, and
 * sends nothing at all.
 */
startOtel();

// Imported AFTER the line above, exactly as app.js is in server.js.
const { default: express } = await import('express');

const { currentTraceIds } = await import(${JSON.stringify(path.join(HERE, 'observability/correlation.js'))});

const app = express();

/*
 * The shape of app.js's correlation middleware, reproduced exactly.
 *
 * What is being tested is whether the OpenTelemetry context is still active
 * inside a res.on('finish') listener, because that is where logHttpRequest
 * runs -- and if it is not, every access-log record is written without a trace
 * id, and the join between the two signals silently does not exist for the
 * highest-volume log this application produces.
 *
 * (No backticks in this comment: it lives inside a template literal.)
 */
let correlation = null;
app.use((req, res, next) => {
  const inMiddleware = currentTraceIds();
  res.on('finish', () => {
    correlation = { inMiddleware, inFinish: currentTraceIds() };
  });
  next();
});

app.get('/api/events/:id', (req, res) => res.json({ ok: true }));
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const port = server.address().port;

await fetch('http://127.0.0.1:' + port + '/api/events/42?email=chris.vale@school.org&q=123%20Maple%20St')
  .then((r) => r.json());

await new Promise((r) => setTimeout(r, 500));
// Captured BEFORE the shutdown: shutdownOtel() clears the state the snapshot
// reads, so asking afterwards returns null and the assertions would be vacuous.
const snapshot = otelSnapshot() ?? {};
await shutdownOtel();
process.stdout.write('SNAPSHOT:' + JSON.stringify(snapshot) + '\\n');
process.stdout.write('CORRELATION:' + JSON.stringify(correlation ?? {}) + '\\n');
server.close();
process.exit(0);
`;
}

let stub;
let received;
let workdir;

beforeAll(async () => {
  received = [];
  stub = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = Buffer.concat(chunks);
      if (req.headers['content-encoding'] === 'gzip') {
        try { body = gunzipSync(body); } catch { /* keep as received */ }
      }
      received.push({ url: req.url, text: body.toString('latin1'), headers: req.headers });
      res.writeHead(200);
      res.end();
    });
  });
  stub.listen(0, '127.0.0.1');
  await once(stub, 'listening');

  workdir = mkdtempSync(path.join(tmpdir(), 'wev-otel-prod-'));
});

afterAll(async () => {
  await new Promise((resolve) => stub.close(resolve));
  try { rmSync(workdir, { recursive: true, force: true }); } catch { /* best effort */ }
});

let output = '';

describe('under a real node process, not vite-node', () => {
  beforeAll(async () => {
    /* Written inside the repository tree so that bare specifiers such as
       `express` and `@opentelemetry/*` resolve against its node_modules. */
    const programPath = path.join(HERE, `zz-otel-subprocess-${process.pid}.mjs`);
    writeFileSync(programPath, programSource());

    try {
      const child = spawn(process.execPath, [programPath], {
        cwd: path.dirname(HERE),
        /* A clean environment: no VITEST, which is what lets the SDK start, and
           no inherited Better Stack credentials. */
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          NODE_ENV: 'test',
          /* The real configuration surface: process.env in a real process, with
             no VITEST set — which is what lets the SDK start at all. */
          WEV_OTEL_TEST_SINK: '1',
          BETTERSTACK_SOURCE_TOKEN: 'stub-token-not-a-real-credential',
          BETTERSTACK_INGESTING_HOST: `http://127.0.0.1:${stub.address().port}`,
          OTEL_TRACE_SAMPLE_RATE: '1',
          OTEL_TRACE_DAILY_SPAN_BUDGET: '100000',
          TELEMETRY_SERVICE_NAME: 'wevolunteer-subprocess',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', (d) => { output += d.toString(); });
      child.stderr.on('data', (d) => { output += d.toString(); });

      const [code] = await once(child, 'exit');
      expect(code, `subprocess failed:\n${output}`).toBe(0);
    } finally {
      try { rmSync(programPath, { force: true }); } catch { /* best effort */ }
    }
  }, 60000);

  function wire() {
    return received.map(r => r.text).join(' ');
  }

  it('exported spans from the subprocess', () => {
    expect(received.length, output).toBeGreaterThan(0);
  });

  it('instrumented EXPRESS, which is the claim Vitest cannot test', () => {
    /* The exact regression: without the in-process `module.register()` in
       otel.js, this string is absent and the HTTP span alone still arrives. */
    expect(wire()).toContain('request handler');
  });

  it('resolved the route pattern onto the HTTP span', () => {
    /* `GET /api/events/:id` rather than a bare `GET` — the express
       instrumentation feeding the route back into the http span. This is the
       single most useful thing the Express patch buys. */
    expect(wire()).toContain('/api/events/:id');
    expect(wire()).toContain('http.route');
  });

  it('produced more than one span, so the trace is a waterfall not a bar', () => {
    const snapshot = JSON.parse(output.match(/SNAPSHOT:(\{.*\})/)?.[1] ?? '{}');
    expect(snapshot.spansExported).toBeGreaterThan(1);
  });

  it('did NOT produce a span per middleware, which would be most of the budget', () => {
    /* `ignoreLayersType: [MIDDLEWARE]`. Express emits `middleware - query` and
       `middleware - expressInit` on a bare app before any of this
       application's dozen middlewares are added. */
    expect(wire()).not.toContain('middleware - query');
    expect(wire()).not.toContain('expressInit');
  });

  it('still put no query string on the wire, in a real process', () => {
    /* The privacy guarantee is re-asserted here rather than assumed from the
       in-harness suite: this is the only place a genuinely production-shaped
       span set is observed. */
    const text = wire();
    expect(text).not.toContain('chris.vale@school.org');
    expect(text).not.toContain('Maple');
    expect(text).not.toContain('url.query');
    expect(text).not.toContain('url.path');
    expect(text).not.toContain('client.address');
  });

  /**
   * ── Why this is asserted in the subprocess and not in the harness ──
   *
   * Measured, in Vitest: BOTH captures come back empty, in the middleware body
   * as well as in the finish listener — the same vite-node module-loading
   * artifact that hides the Express spans. Read there, it looks exactly like a
   * broken correlation, and softening it to "{} is fine" would have written the
   * bug into the test.
   *
   * In a real process the context survives to `finish`, which is what makes the
   * access-log record joinable to its trace. That is the claim
   * `docs/operations/observability.md` makes, so it is asserted where it can be
   * asserted honestly.
   */
  it('carries the trace context into res.on(finish), where the access log runs', () => {
    const correlation = JSON.parse(output.match(/CORRELATION:(\{.*\})/)?.[1] ?? '{}');
    expect(correlation.inFinish?.traceId, 'no trace id at finish — every access-log record would be unjoinable')
      .toMatch(/^[0-9a-f]{32}$/);
    expect(correlation.inFinish?.spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('reports the SAME trace inside the handler and at finish', () => {
    /* A different trace id at the two points would be worse than none: the log
       record would join to a trace that is not the request it describes. */
    const correlation = JSON.parse(output.match(/CORRELATION:(\{.*\})/)?.[1] ?? '{}');
    expect(correlation.inMiddleware?.traceId).toBe(correlation.inFinish?.traceId);
  });

  it('took its configuration from process.env, the way bootstrap.js does', () => {
    /* `startOtel()` was called with no argument; the only way this service name
       reached the payload is the `env = process.env` default. */
    expect(wire()).toContain('wevolunteer-subprocess');
  });

  it('reported the ESM hook as registered', () => {
    const snapshot = JSON.parse(output.match(/SNAPSHOT:(\{.*\})/)?.[1] ?? '{}');
    expect(snapshot.esmHook).toBe(true);
  });
});
