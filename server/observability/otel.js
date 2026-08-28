/**
 * OpenTelemetry: traces and metrics to Better Stack. Logs stay where they are.
 *
 * ── The architecture, and why it is not "migrate everything to OTel" ──
 *
 * OpenTelemetry JavaScript marks Traces **Stable**, Metrics **Stable** and Logs
 * **Development** (opentelemetry.io/docs/languages/js, checked 2026-08-27). That
 * is not a formality: a Development signal may change its API in a minor
 * release, and the thing it would be replacing here is `telemetry.js` — the
 * module that holds this application's field allowlist, its redaction pass, its
 * "an id is rejected rather than truncated" rule, and the reviewed decision that
 * Better Stack may hold exactly what `error_events` may hold.
 *
 * Replacing a hardened, reviewed, tested boundary with a signal whose own
 * project calls it unstable would be trading a privacy guarantee for tidiness.
 * So the split is by maturity AND by what each part is good at:
 *
 *   logs     `telemetry.js` → Better Stack HTTP ingestion   (unchanged)
 *   traces   OpenTelemetry  → OTLP /v1/traces               (new)
 *   metrics  OpenTelemetry  → OTLP /v1/metrics              (new)
 *
 * One source, one token, one vendor, three signals. Correlation between them is
 * the `traceId`/`spanId` pair that `telemetry.js` now stamps on every log record
 * (see `currentTraceIds`), so a log line found in Better Stack links to its trace
 * and a trace links back to the errors it produced.
 *
 * ── Ordering: this module must be imported before Express ──
 *
 * Instrumentation works by patching modules as they load, so anything already
 * loaded is already too late. `server.js` imports this second, after
 * `preflight.js` and before `app.js`, and ES module evaluation order is what
 * makes that work — the same mechanism, and the same reasoning, as the comment
 * at the top of `server.js` about `preflight.js`.
 *
 * ── The ESM problem, and the flag that turned out to be required ──
 *
 * MEASURED, not assumed: with `NodeTracerProvider` registered the ordinary way,
 * a request through Express produced exactly ONE span — the `http` one. Express
 * produced none. `@opentelemetry/instrumentation-express` patches CommonJS
 * through `require-in-the-middle`, and an ESM `import 'express'` does not go
 * through `Module.prototype.require`, so the patch never applies.
 *
 * The documented fix is a loader hook on the command line
 * (`--import`). It was first rejected here on the grounds that a load-bearing
 * flag in `package.json` AND the systemd unit is a flag a deployment can lose,
 * degrading silently into a server that "starts, serves, and is wrong".
 * `module.register()` from inside this module appeared to do the same job
 * without a flag, and a subprocess test confirmed it.
 *
 * ── That was wrong, and the real account is what proved it ──
 *
 * The subprocess test loaded Express with a DYNAMIC `await import('express')`.
 * `server.js` loads it STATICALLY, through `import { app } from './app.js'`, and
 * ES modules are LOADED graph-wide before any of them are EVALUATED. So express's
 * source was already read by the time this module's body ran, and
 * `import-in-the-middle` — which transforms source at load time — had nothing
 * left to transform. The in-process call worked in the test and did nothing in
 * production.
 *
 * Nothing errored. The symptom was one span per request named `GET` instead of
 * four named `GET /api/events/:id`, and it was found only by querying the live
 * Better Stack account: 31 of 31 automatic spans came from
 * `instrumentation-http` and none from `instrumentation-express`.
 *
 * So the flag is used after all — and the original objection is answered where
 * it should have been answered in the first place, by making its absence LOUD
 * rather than by avoiding it. `register.mjs` leaves a marker, this module checks
 * for it, and a boot without the preload prints a warning naming the exact
 * command to fix it. The in-process `register()` is kept as a fallback for
 * modules imported dynamically later.
 */
import { diag, DiagLogLevel, metrics, trace, propagation } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { BatchSpanProcessor, SamplingDecision } from '@opentelemetry/sdk-trace-base';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation, ExpressLayerType } from '@opentelemetry/instrumentation-express';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';

import { resolveOtelConfig } from './otelConfig.js';
import { SpanBudget } from './spanBudget.js';
import { TailSamplingSpanProcessor } from './tailSampler.js';
import { ScrubbingSpanProcessor } from './spanAttributes.js';
import { InjectOnlyPropagator } from './propagation.js';
import { initMetrics, observeTracePipeline } from './metrics.js';

/**
 * How long one OTLP request may take.
 *
 * Five seconds, matching `telemetrySink.js`'s `REQUEST_TIMEOUT_MS`, and chosen
 * against the same constraint. The default is 10,000ms, and the exporter retries
 * a retryable failure up to five times WITHIN that budget — so an unreachable
 * Better Stack costs up to ten seconds per export attempt at the default, which
 * is most of a systemd stop timeout by itself.
 */
const EXPORT_TIMEOUT_MS = 5000;

/**
 * The whole telemetry shutdown's budget, not one exporter's.
 *
 * `shutdown.js` already reasons about this for the log sink and settled on five
 * seconds, for the reason recorded there: an unreachable vendor must not push a
 * deploy into `SIGKILL`, because that discards exactly the cleanup the shutdown
 * exists to perform. The trace and metric pipelines get one shared budget of the
 * same size, enforced by a race rather than by trusting the SDK — see
 * `shutdownOtel`.
 */
const SHUTDOWN_DEADLINE_MS = 5000;

let state = null;

/**
 * Module patching is process-global and is done exactly once.
 *
 * ── The bug this exists for ──
 *
 * `register()` and `registerInstrumentations()` both mutate the process, not
 * this module: the first installs a loader hook, the second wraps `http`,
 * `express` and `pg`. Calling either a second time does not replace the first —
 * it stacks another layer on top. Driven from a test suite that starts and stops
 * the SDK a dozen times, that showed up as
 * `MaxListenersExceededWarning: 11 response listeners added to [ClientRequest]`
 * and `The 'import-in-the-middle' hook has already been initialized`, which is
 * eleven copies of the same patch adding eleven sets of listeners to every
 * outgoing request.
 *
 * Production calls `startOtel` once, so this was invisible there — which is
 * precisely the reason to fix it rather than to silence the warning. A
 * process-global side effect guarded only by a variable that a caller can reset
 * is not guarded.
 */
let patching = null;

/**
 * Whether `register.mjs` ran via `--import`, i.e. BEFORE the module graph loaded.
 *
 * ── Why this distinction is the whole point ──
 *
 * Calling `module.register()` from here works for a module imported
 * DYNAMICALLY and does nothing for one imported STATICALLY, because ES modules
 * are loaded graph-wide before any of them are evaluated —
 * `import-in-the-middle` transforms source at load time, and by the time this
 * function runs, `express` has already been read.
 *
 * `server.js` imports `app.js` statically. So the in-process call below is a
 * fallback that covers dynamic imports, and the `--import` preload is what
 * actually instruments Express. Reporting them separately is what makes a
 * missing flag visible.
 */
function esmHookPreloaded() {
  try {
    return globalThis[Symbol.for('wevolunteer.otel.esmHookPreloaded')] === true;
  } catch { return false; }
}

/**
 * ── Why this does NOT call `module.register()` ──
 *
 * It used to, as a "fallback for dynamically imported modules". Mutation testing
 * killed the idea: removing the call changed nothing any test could observe,
 * because nothing in this application dynamically imports an instrumented
 * package — `grep` finds no dynamic import of `express` or `pg` anywhere in
 * `server/`. It was covering a case that does not exist.
 *
 * Worse, it registered the hook UNSCOPED, without the `include` allowlist that
 * `register.mjs` passes. So the one thing it could still have done was
 * re-introduce the boot crash it was written after: rewriting an application
 * module and exposing the `app.js` ↔ `checkinLimiters.js` circular import.
 *
 * A fallback that protects nothing and can only cause the failure it was added
 * to prevent is not a fallback. The hook is installed in exactly one place now —
 * `register.mjs`, via `--import` — and its absence is reported rather than
 * silently patched over.
 */
function ensurePatched() {
  if (patching) return patching;

  const disable = registerInstrumentations({ instrumentations: buildInstrumentations() });
  patching = { esmHook: esmHookPreloaded(), disable };
  return patching;
}

/** The instrumentations, and the reasoning for each one's configuration. */
function buildInstrumentations() {
  return [
    new HttpInstrumentation({
      /**
       * Never trace the pipeline's own traffic.
       *
       * `BatchSpanProcessor` already wraps its export in `suppressTracing`
       * (verified in the installed source), so this is defence in depth rather
       * than the only guard — but the failure it prevents is a feedback loop
       * in which exporting a span creates a span, and a guarantee that rests
       * on one upstream implementation detail is not a guarantee.
       */
      ignoreOutgoingRequestHook: (options) => {
        try {
          const host = options?.hostname || options?.host || '';
          return typeof host === 'string' && host.endsWith('betterstackdata.com');
        } catch { return false; }
      },
      ignoreIncomingRequestHook: (request) => {
        try {
          const url = request?.url || '';
          /* The health endpoint is polled by the service manager and by uptime
             checks, forever, and answers nothing anybody traces. Excluding it
             is worth roughly its share of the span budget. */
          if (url === '/health' || url.startsWith('/health?')) return true;

          /**
           * OTLP ingest paths, which this application does not serve.
           *
           * They are here for the case where the ingest endpoint is on the
           * same host — a local OpenTelemetry Collector sidecar, or the stub
           * the integration tests point at. Without this, the exporter's POST
           * to `/v1/traces` ARRIVES as an incoming request, becomes a server
           * span, and is exported — which posts to `/v1/traces` again. The
           * outgoing half of that loop is already suppressed by
           * `BatchSpanProcessor`, but suppression is a context that does not
           * survive the trip through a socket, so the incoming half needs its
           * own guard.
           */
          return url.startsWith('/v1/traces') || url.startsWith('/v1/metrics') || url.startsWith('/v1/logs');
        } catch { return false; }
      },
    }),

    new ExpressInstrumentation({
      /**
       * Only REQUEST_HANDLER spans are kept. Middleware and router layers are
       * both off, and the second one is not a mere optimisation.
       *
       * ── What ROUTER layers actually produced ──
       *
       * MEASURED against the live account, on 494 requests: express emitted
       * **182 spans**, and the top of the histogram was
       *
       *     router - /api/webhooks/resend         14
       *     router - /api/admin/persona-preview   14
       *     router - /api/organizations           14
       *
       * — fourteen each, for routes that were never requested. Express walks its
       * router stack looking for a match and the instrumentation names a span
       * for every layer it walks, so the span count per request scales with the
       * SIZE OF THE ROUTE TABLE rather than with what the request did. On this
       * application that was roughly eighteen spans per trace, of which one was
       * the handler that actually ran.
       *
       * Three problems at once: it is most of the trace volume the free-plan
       * budget exists to protect, it buries the useful span in a waterfall of
       * routes nobody called, and it grows every time a route is added.
       *
       * MIDDLEWARE is off for the plainer version of the same reason. This
       * application stacks a dozen (helmet, compression, cors, cookie-parser,
       * the body parser, several rate limiters, authentication) and they are
       * sub-millisecond bars nobody reads. The two things worth naming inside a
       * request — authentication and the business operation — are named
       * explicitly through `spans.js`, where they get stable names rather than
       * whatever a middleware function happens to be called.
       *
       * What survives is `request handler - /api/events/:id`: the one express
       * span that says what the request did.
       */
      ignoreLayersType: [ExpressLayerType.MIDDLEWARE, ExpressLayerType.ROUTER],
    }),

    new PgInstrumentation({
      /**
       * Explicitly off, though it is also the default.
       *
       * `enhancedDatabaseReporting` inlines PARAMETER VALUES into
       * `db.statement`. On this application the parameters are names, emails,
       * addresses and dates of birth belonging mostly to minors. It is set
       * here so that turning it on is an edit somebody makes on purpose and a
       * reviewer can see, rather than a default that could change underneath.
       */
      enhancedDatabaseReporting: false,
      requireParentSpan: true,
    }),
  ];
}

/** Whether OpenTelemetry is running in this process, and why not if it isn't. */
export function otelStatus() {
  if (state?.enabled) return { enabled: true };
  return { enabled: false, reason: state?.reason ?? 'not_started' };
}

/**
 * Starts the SDK. Safe to call twice; the second call is a no-op.
 *
 * Never throws. A misconfigured or unreachable observability stack is not a
 * reason a volunteer cannot sign up for an event, and this function is on the
 * boot path.
 */
export function startOtel(env = process.env) {
  if (state) return otelStatus();

  let config;
  try {
    config = resolveOtelConfig(env);
  } catch {
    state = { enabled: false, reason: 'config_error' };
    return otelStatus();
  }

  if (!config.enabled) {
    state = { enabled: false, reason: config.reason };
    return otelStatus();
  }

  try {
    return startEnabled(config, env);
  } catch (err) {
    /* Partial construction is possible — a provider registered, a timer running.
       Tear down what exists rather than leaving half an SDK in place. */
    try { state?.tearDown?.(); } catch { /* nothing better to do */ }
    state = { enabled: false, reason: 'start_failed' };
    try {
      console.warn(`[otel] OpenTelemetry failed to start (${err?.name || 'error'}). Traces and metrics are off; logging continues.`);
    } catch { /* nothing left */ }
    return otelStatus();
  }
}

function startEnabled(config, env) {
  /**
   * Silence, unless asked.
   *
   * The SDK logs export failures through `diag` at INFO, and an unreachable
   * endpoint fails on every batch — the same journal-filling behaviour
   * `telemetrySink.js` has `warnOnce` for. `diag` is left at NONE and the
   * pipeline reports itself through the `wev.telemetry.traces` gauge instead;
   * `WEV_OTEL_DIAG=debug` turns the firehose on for somebody debugging it.
   */
  const diagLevel = String(env.WEV_OTEL_DIAG || '').toLowerCase();
  if (diagLevel === 'debug') {
    diag.setLogger(console, DiagLogLevel.DEBUG);
  } else {
    diag.disable();
  }

  /**
   * The resource: what this process says it is.
   *
   * Built EXPLICITLY rather than from `defaultResource()`, which runs the host,
   * OS and process detectors. Those add `host.name`, `process.command_line`,
   * `process.executable.path` and the rest — a hostname that in a school
   * district can name a building, and a command line that can carry whatever an
   * operator put on it. `telemetry.js` already refused a hostname for exactly
   * that reason and uses a random per-boot id instead; the same three fields,
   * with the same values, are used here so the two signals join up.
   */
  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: env.TELEMETRY_SERVICE_NAME || 'wevolunteer',
    [ATTR_SERVICE_VERSION]: env.APP_RELEASE || 'unknown',
    'deployment.environment.name': env.NODE_ENV || 'development',
    'wev.engine': (env.DATABASE_ENGINE || 'sqlite').toLowerCase(),
  });

  const headers = { Authorization: `Bearer ${config.token}` };

  const traceExporter = new OTLPTraceExporter({
    url: config.tracesUrl,
    headers,
    /* Better Stack recommends gzip, and the SDK default is `none`. On a payload
       of repetitive JSON-shaped protobuf it is a large reduction in wire bytes
       for a small, once-per-batch CPU cost. */
    compression: 'gzip',
    timeoutMillis: EXPORT_TIMEOUT_MS,
    /* The SDK's own bound on simultaneous in-flight exports. The default is 30;
       one at a time is what `telemetrySink.js` settled on for the log wire after
       finding that concurrency hid queue pressure and made the bounded-memory
       invariant unmeasurable. The same argument applies, so the same answer. */
    concurrencyLimit: 1,
  });

  /**
   * The batch processor, tuned down from its defaults.
   *
   * Defaults are maxQueueSize 2048, maxExportBatchSize 512, scheduledDelay
   * 5000ms, exportTimeout 30000ms. Two of those are wrong here: a 30-second
   * export timeout is six times the shutdown budget, and a 512-span batch is
   * larger than any trace this application produces, so it only ever adds
   * latency before the first export.
   *
   * The queue is left generous. It is the last bound before spans are dropped,
   * it holds only spans the tail sampler already decided to keep, and dropping
   * there is dropping a trace somebody wanted.
   */
  const batchProcessor = new BatchSpanProcessor(traceExporter, {
    maxQueueSize: 2048,
    maxExportBatchSize: 128,
    scheduledDelayMillis: 2000,
    exportTimeoutMillis: EXPORT_TIMEOUT_MS,
  });

  const budget = new SpanBudget({ limit: config.dailySpanBudget });
  const tailProcessor = new TailSamplingSpanProcessor({
    downstream: batchProcessor,
    budget,
    sampleRatio: config.sampleRatio,
  });

  /**
   * The chain, and why the order is this one.
   *
   *   scrub → tail sample → batch → OTLP
   *
   * Scrubbing first so that no buffer downstream of it — and the tail sampler's
   * buffer can hold a trace for up to a minute — ever contains a client IP
   * address or a query string. Sampling second so the batch only ever holds
   * spans that are going to be sent. Batching last because that is the only part
   * that talks to the network.
   */
  const processor = new ScrubbingSpanProcessor(tailProcessor);

  const tracerProvider = new NodeTracerProvider({
    resource,
    spanProcessors: [processor],
    sampler: budgetSampler(budget),
  });

  /**
   * Registered with an inject-only propagator.
   *
   * See `propagation.js`: honouring an inbound `traceparent` would let an
   * unauthenticated client choose its own trace id AND its own sampling flag,
   * which is a way to spend the span budget from outside.
   */
  tracerProvider.register({ propagator: new InjectOnlyPropagator(new W3CTraceContextPropagator()) });

  const metricExporter = new OTLPMetricExporter({
    url: config.metricsUrl,
    headers,
    compression: 'gzip',
    timeoutMillis: EXPORT_TIMEOUT_MS,
    concurrencyLimit: 1,
  });

  /**
   * Sixty seconds, which is the default and is also the right answer.
   *
   * Metrics are billed by retained size, and the export interval is a direct
   * multiplier on it: halving the interval doubles the bill for the same
   * information. Sixty seconds is finer than any alert this application would
   * act on.
   */
  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 60_000,
    exportTimeoutMillis: EXPORT_TIMEOUT_MS,
  });

  const meterProvider = new MeterProvider({ resource, readers: [metricReader] });
  metrics.setGlobalMeterProvider(meterProvider);

  initMetrics();
  observeTracePipeline(tailProcessor);

  const { esmHook } = ensurePatched();

  /**
   * Nothing to undo.
   *
   * Module patching is owned by `ensurePatched` and is deliberately NOT reversed
   * on shutdown: un-patching `http` while requests are in flight would swap the
   * module out from under them, and the process is exiting anyway. The
   * instrumentations become harmless the moment the tracer provider is shut
   * down, because every span they start is then a no-op.
   */
  const tearDown = () => {};

  state = {
    enabled: true, esmHook, tracerProvider, meterProvider, metricReader,
    tailProcessor, budget, tearDown, config: { sampleRatio: config.sampleRatio, dailySpanBudget: config.dailySpanBudget },
  };

  if (!esmHook) {
    try {
      console.warn(
        '[otel] WARNING: the ESM loader hook was not preloaded, so Express is NOT instrumented.\n'
        + '       Traces will show one span named "GET" instead of "GET /api/events/:id",\n'
        + '       and no middleware or handler spans at all. Nothing else is affected.\n'
        + '       Fix: start the server with\n'
        + '         node --import ./server/observability/register.mjs server/server.js\n'
        + '       (npm start and deploy/wevolunteer.service already do this.)'
      );
    } catch { /* nothing left */ }
  }

  return otelStatus();
}

/**
 * The head sampler: a circuit breaker, not a sampling policy.
 *
 * The policy is in `tailSampler.js`, which needs to SEE a span before it can
 * decide whether it was interesting — so this returns RECORD_AND_SAMPLED for
 * everything and lets the tail do the choosing.
 *
 * What it does do is stop recording entirely once the daily budget is spent.
 * Past that point the tail would drop every trace anyway, and recording spans in
 * order to discard them is CPU and allocation spent on nothing — which is the
 * cost that matters when the reason the budget ran out is a traffic flood.
 *
 * It also ignores the parent's sampling flag, which is the second half of the
 * amplification defence described in `propagation.js`.
 */
function budgetSampler(budget) {
  return {
    shouldSample() {
      return { decision: budget.hasRoom() ? SamplingDecision.RECORD_AND_SAMPLED : SamplingDecision.NOT_RECORD };
    },
    toString() { return 'WeVolunteerBudgetSampler'; },
  };
}

/**
 * Flushes and stops both pipelines, within a hard deadline.
 *
 * ── Why the deadline is enforced here and not delegated ──
 *
 * `BatchSpanProcessor.shutdown()` and `PeriodicExportingMetricReader.shutdown()`
 * each flush what they hold, and each is bounded by its own export timeout —
 * which is 5s here, per attempt. But "bounded per attempt" is not "bounded", and
 * `shutdown.js` is explicit about the consequence of getting this wrong: a
 * vendor outage during a deploy that pushes the process past systemd's
 * `TimeoutStopSec` turns a graceful stop into a `SIGKILL`, discarding the
 * database close and the queued work the whole sequence exists to protect.
 *
 * So the SDK's own bound is not trusted. The race below is the bound: after
 * `SHUTDOWN_DEADLINE_MS` this resolves regardless of what the exporters are
 * doing, and the process continues to exit. Spans still in flight are lost,
 * which is the correct trade — they describe a process that is going away, and
 * `telemetrySink.js` reached the same conclusion for the same reason.
 *
 * Always resolves. Never throws. Safe to call twice.
 */
export async function shutdownOtel({ deadlineMs = SHUTDOWN_DEADLINE_MS } = {}) {
  const current = state;
  if (!current?.enabled) return { flushed: false, reason: 'not_running' };

  /* Cleared first, so a second call — a repeated SIGTERM, or the shutdown
     sequence re-entered through `unhandledRejection` — cannot start a second
     flush and cannot double-export. */
  state = { enabled: false, reason: 'shut_down' };

  try { current.tearDown(); } catch { /* instrumentation already gone */ }

  const work = (async () => {
    /* Metrics first: one final export means the counters describing the
       shutdown — including the span budget — are not lost with the process. */
    try { await current.metricReader.shutdown(); } catch { /* counted, not thrown */ }
    try { await current.tracerProvider.shutdown(); } catch { /* ditto */ }
    try { await current.meterProvider.shutdown(); } catch { /* ditto */ }
  })();

  const timedOut = Symbol('timeout');
  const outcome = await Promise.race([
    work.then(() => 'flushed', () => 'failed'),
    new Promise((resolve) => {
      const t = setTimeout(() => resolve(timedOut), deadlineMs);
      if (typeof t.unref === 'function') t.unref();
    }),
  ]);

  if (outcome === timedOut) {
    try {
      console.warn(`[otel] Telemetry flush did not finish within ${deadlineMs}ms — exiting anyway.`);
    } catch { /* nothing left */ }
    return { flushed: false, reason: 'deadline' };
  }

  return { flushed: outcome === 'flushed', reason: outcome === 'flushed' ? 'ok' : 'export_failed' };
}

/** Pipeline counters, for the boot line, the tests, and a future health route. */
export function otelSnapshot() {
  if (!state?.enabled) return null;
  return { ...state.tailProcessor.snapshot(), config: state.config, esmHook: state.esmHook };
}

/** Test seam. Module state must not leak between cases. */
export function __resetOtelForTests() {
  try { state?.tearDown?.(); } catch { /* nothing to undo */ }
  state = null;
  try { trace.disable(); metrics.disable(); propagation.disable(); } catch { /* not registered */ }
}
