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
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * A standalone program that mirrors `server.js`'s import order exactly.
 *
 * The two lines that matter are the first two: the observability bootstrap is
 * imported BEFORE anything that pulls in Express, because ES imports are
 * evaluated in source order and a patch installed afterwards patches nobody.
 */
/**
 * The application module: statically imports express, exactly as `app.js` does.
 *
 * It has to be a SEPARATE FILE. Put `import express` in the main program and it
 * is hoisted above every statement there, so express evaluates before
 * `startOtel()` has registered the instrumentations and nothing — not even the
 * loader preload — can help. `server.js` does not have that shape: it imports
 * `app.js`, and express is evaluated as a dependency of that module, after the
 * bootstrap module's body has run. This mirrors that.
 */
function appModuleSource() {
  return `
import express from 'express';
import { currentTraceIds } from ${JSON.stringify(path.join(HERE, 'observability/correlation.js'))};

export const app = express();

/*
 * app.js's correlation middleware, reproduced -- and registered BEFORE the
 * route, which is where app.js registers it. Registered after, Express never
 * reaches it for a matched route and the capture below stays null.
 *
 * What it tests: whether the OpenTelemetry context is still active inside a
 * res.on('finish') listener, because that is where logHttpRequest runs. If it
 * is not, every access-log record is written without a trace id and the join
 * between logs and traces silently does not exist.
 *
 * (No backticks in this comment: it lives inside a template literal.)
 */
export const captured = {};
app.use((req, res, next) => {
  const inMiddleware = currentTraceIds();
  res.on('finish', () => {
    captured.correlation = { inMiddleware, inFinish: currentTraceIds() };
  });
  next();
});

/*
 * A route TABLE, not a route.
 *
 * Express walks its stack looking for a match and the instrumentation names a
 * span for every layer walked, so router-layer noise only becomes visible once
 * there are routes that do NOT match. With a single route the mutation that
 * re-enables ROUTER spans survived, because there was nothing for Express to
 * walk past. These eight unmatched routers are what make the exclusion testable.
 */
const routers = [
  '/api/organizations', '/api/external-hours', '/api/oauth/providers',
  '/api/admin/persona-preview', '/api/issues/categories', '/api/webhooks/resend',
  '/api/auth/demo-accounts', '/api/users/by-username/:username',
];
for (const p of routers) {
  const r = express.Router();
  r.get('/', (req, res) => res.json({ ok: true }));
  app.use(p, r);
}

const events = express.Router();
events.get('/:id', (req, res) => res.json({ ok: true }));
app.use('/api/events', events);
`;
}

/**
 * The main program, mirroring `server.js`'s import order exactly:
 *
 *     import './observability/bootstrap.js';   // starts the SDK
 *     import { app } from './app.js';          // pulls in express
 *
 * Both static, both in that order.
 */
function programSource(appPath) {
  return `
/*
 * The bootstrap module, FIRST -- exactly as server.js imports it.
 *
 * It must be a side-effect import and not a startOtel() call, because a call is
 * a statement and every static import in this file is hoisted above it. An
 * earlier version of this test did call startOtel() here and measured nothing:
 * the SDK started after express had already been evaluated, so not even the
 * http instrumentation applied and spansExported was 0. That is the same class
 * of ordering mistake bootstrap.js exists to prevent, reproduced in the test
 * that was supposed to catch it.
 *
 * bootstrap.js calls startOtel() with no argument, so this also exercises the
 * (env = process.env) default that production depends on.
 */
import ${JSON.stringify(path.join(HERE, 'observability/bootstrap.js'))};
import { shutdownOtel, otelSnapshot } from ${JSON.stringify(path.join(HERE, 'observability/otel.js'))};

import { app, captured } from ${JSON.stringify(appPath)};
import { once } from 'node:events';

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = server.address().port;

await fetch('http://127.0.0.1:' + port + '/api/events/42?email=chris.vale@school.org&q=123%20Maple%20St')
  .then((r) => r.json());

await new Promise((r) => setTimeout(r, 500));
const snapshot = otelSnapshot() ?? {};
await shutdownOtel();
process.stdout.write('SNAPSHOT:' + JSON.stringify(snapshot) + '\\n');
process.stdout.write('CORRELATION:' + JSON.stringify(captured.correlation ?? {}) + '\\n');
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

/**
 * Runs the program above in a real `node`, optionally with the loader preload.
 *
 * `preload` is the whole experiment. `--import ./observability/register.mjs`
 * installs the ESM hook before the module graph is loaded; without it the hook
 * arrives after express has already been read, and the Express instrumentation
 * applies to nothing.
 */
async function runSubprocess({ preload }) {
  /* Written inside the repository tree so that bare specifiers such as
     `express` and `@opentelemetry/*` resolve against its node_modules. */
  const suffix = `${process.pid}-${preload ? 'pre' : 'raw'}`;
  const appPath = path.join(HERE, `zz-otel-app-${suffix}.mjs`);
  const programPath = path.join(HERE, `zz-otel-subprocess-${suffix}.mjs`);
  writeFileSync(appPath, appModuleSource());
  writeFileSync(programPath, programSource(appPath));

  /* `pathToFileURL`, not a bare path: Node treats --import as a URL, and this
     repository lives under a directory with spaces in it, which a raw path
     cannot survive. Passing the wrong thing here fails SILENTLY — the flag is
     accepted, the hook never loads, and Express is simply not instrumented,
     which is the same invisible failure this whole suite exists to catch. */
  const args = preload
    ? ['--import', pathToFileURL(path.join(HERE, 'observability/register.mjs')).href, programPath]
    : [programPath];

  let out = '';
  try {
    const child = spawn(process.execPath, args, {
      cwd: path.dirname(HERE),
      /* A clean environment: no VITEST, which is what lets the SDK start, and
         no inherited Better Stack credentials. The configuration reaches
         startOtel() through this, which is the production path. */
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_ENV: 'test',
        WEV_OTEL_TEST_SINK: '1',
        BETTERSTACK_SOURCE_TOKEN: 'stub-token-not-a-real-credential',
        BETTERSTACK_INGESTING_HOST: `http://127.0.0.1:${stub.address().port}`,
        OTEL_TRACE_SAMPLE_RATE: '1',
        OTEL_TRACE_DAILY_SPAN_BUDGET: '100000',
        TELEMETRY_SERVICE_NAME: 'wevolunteer-subprocess',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });

    const [code] = await once(child, 'exit');
    expect(code, `subprocess failed:\n${out}`).toBe(0);
  } finally {
    try { rmSync(programPath, { force: true }); } catch { /* best effort */ }
    try { rmSync(appPath, { force: true }); } catch { /* best effort */ }
  }
  return out;
}

describe('under a real node process, not vite-node', () => {
  beforeAll(async () => {
    output = await runSubprocess({ preload: true });
  }, 60000);

  function wire() {
    return received.map(r => r.text).join(' ');
  }

  it('exported spans from the subprocess', () => {
    /* `output` is attached to the failure message so a broken subprocess is
       diagnosable from the test report rather than by re-running it by hand. */
    expect(received.length, output).toBeGreaterThan(0);
  });


  it('instrumented EXPRESS, which is the claim Vitest cannot test', () => {
    /* The exact regression, and it reached production once: without the
       `--import` preload this string is absent and the HTTP span alone still
       arrives, with no error anywhere. Found by querying the live Better Stack
       account and noticing 31 of 31 automatic spans came from
       instrumentation-http. */
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

  it('did NOT produce router-layer spans, which scaled with the route table', () => {
    /* MEASURED live before this was excluded: 494 requests produced 196 spans,
       168 of them `router - /api/...` for routes nobody called — the span count
       scaled with the SIZE OF THE ROUTE TABLE rather than with the request.
       Excluding ROUTER took the same workload to 23 spans. */
    expect(wire()).not.toContain('router - ');
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

/**
 * The regression this whole file was rewritten for.
 *
 * ── What happened ──
 *
 * The integration shipped believing an in-process `module.register()` removed
 * the need for a CLI flag. A subprocess test agreed, because it loaded express
 * with a DYNAMIC `await import()`. `server.js` loads it statically, and ES
 * modules are loaded graph-wide before any of them are evaluated — so the hook
 * arrived after express's source had been read and the Express instrumentation
 * applied to nothing.
 *
 * Nothing errored. Every request produced one span named `GET` instead of four
 * named `GET /api/events/:id`. It was found by querying the live Better Stack
 * account: 31 of 31 automatic spans came from `instrumentation-http`, none from
 * `instrumentation-express`.
 *
 * So the flag is required after all, and these two cases are what keep it
 * honest: the positive case above proves it works WITH the preload, and this
 * one proves the failure is real WITHOUT it — and, more importantly, that the
 * application says so out loud instead of degrading silently.
 */
describe('without the --import preload', () => {
  let bare = '';
  let bareWire = '';

  beforeAll(async () => {
    received.length = 0;
    bare = await runSubprocess({ preload: false });
    bareWire = received.map(r => r.text).join(' ');
  }, 60000);

  it('does NOT instrument Express — the flag is load-bearing, not decorative', () => {
    expect(bareWire).not.toContain('request handler');
    expect(bareWire).not.toContain('middleware -');
  });

  it('loses the route pattern, which is the visible symptom', () => {
    /* The span still exists and is still exported; it is just named `GET` and
       carries no http.route. That is why this was invisible for so long. */
    expect(bareWire.length).toBeGreaterThan(0);
    expect(bareWire).not.toContain('/api/events/:id');
  });

  it('reports the hook as NOT preloaded', () => {
    const snapshot = JSON.parse(bare.match(/SNAPSHOT:(\{.*\})/)?.[1] ?? '{}');
    expect(snapshot.esmHook).toBe(false);
  });

  it('WARNS at boot, so a deployment that loses the flag finds out', () => {
    /* The answer to the original objection. A load-bearing flag is acceptable
       when its absence is loud; it is not acceptable when its absence is a
       quietly worse dashboard. */
    expect(bare).toContain('the ESM loader hook was not preloaded');
    expect(bare).toContain('--import ./server/observability/register.mjs');
  });
});
