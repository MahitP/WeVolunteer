/**
 * The instruments, and the cardinality rules that keep them affordable.
 *
 * ── Why metrics carry the latency story and traces do not ──
 *
 * Traces are sampled at 2% (see `otelConfig.js` for the arithmetic). That is the
 * right rate for waterfalls and the wrong one for "is the site slow", because a
 * 2% sample of a p99 is not a p99 of anything. Metrics are aggregated at the
 * source, so a histogram costs the same whether it counts a hundred requests or
 * a hundred million — which makes it the only signal here that can describe the
 * WHOLE population within a free plan.
 *
 * The division of labour that follows is deliberate:
 *
 *   metrics  every request, aggregated — how much, how slow, how often failing
 *   traces   2% plus every failure, in full — why this particular one was slow
 *   logs     every error and refusal, individually — what exactly happened
 *
 * ── Cardinality is the whole cost model ──
 *
 * Better Stack bills metrics by RETAINED SIZE, with 30 GB included per month,
 * and retained size is series × datapoints-per-series × retention. A metric
 * labelled with a user id, a request id or a raw URL creates one series per
 * distinct value and turns a fixed cost into an unbounded one — the "metrics
 * explosion" that makes observability bills famous.
 *
 * The budget, worked (see `docs/operations/observability.md` for the table):
 *
 *   ~150 active series × 13 values per histogram series ≈ 1,950 values
 *   ≈ 78 KB per export × 60s interval × 30 days         ≈ 3.4 GB/month
 *
 * That is ~11% of the included 30 GB, and it is a number that does not move when
 * traffic does. The two things that WOULD move it are guarded rather than
 * trusted: route labels are capped (`normaliseRoute`), and no instrument here
 * takes an identifier as a label at all.
 */
import { metrics } from '@opentelemetry/api';
import { telemetrySinkStats } from '../telemetrySink.js';

const METER_NAME = 'wevolunteer';

/**
 * Latency buckets, in milliseconds.
 *
 * Given explicitly rather than left to the SDK default, which is a 16-boundary
 * ladder reaching 10,000 — more resolution than this application can act on, at
 * a per-series cost paid every export for ever. These ten cover the range where
 * a decision changes: single-digit milliseconds (a cached read), the ~100ms
 * where a page starts to feel slow, the 1,000ms that `telemetry.js` already
 * treats as "slow request", and the 5,000ms beyond which something is wrong
 * rather than slow.
 */
const LATENCY_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

/**
 * Distinct route labels this process will ever emit.
 *
 * Express route patterns are declared in source, so the set is bounded by the
 * code — in principle. In practice `routePatternOf` also has to answer for
 * requests that never reached a route, and a bug or a future refactor that let a
 * real URL through would create a series per URL, silently, at vendor expense.
 *
 * This is the backstop that makes that impossible rather than unlikely: after 60
 * distinct routes the 61st and everything after it is labelled `other`. Sixty is
 * comfortably above the number of routes this application actually serves and
 * comfortably below anything that would cost real money.
 */
const MAX_DISTINCT_ROUTES = 60;
const seenRoutes = new Set();

/**
 * A route label that cannot become unbounded.
 *
 * Anything carrying a digit run, a query string or an unreasonable length is
 * refused before the cap is even consulted — those are the shapes a real URL has
 * and a pattern does not, so their presence means something upstream is passing
 * the wrong thing and the right response is to stop, not to record it.
 */
export function normaliseRoute(route) {
  if (typeof route !== 'string' || route === '') return 'unknown';
  if (route.length > 100) return 'other';
  if (route.includes('?') || route.includes('#')) return 'other';
  /* A pattern says `:id`; a URL says `/42`. A path segment that is entirely
     digits is therefore a value that escaped the pattern. */
  if (/\/\d+(\/|$)/.test(route)) return 'other';

  if (seenRoutes.has(route)) return route;
  if (seenRoutes.size >= MAX_DISTINCT_ROUTES) return 'other';
  seenRoutes.add(route);
  return route;
}

/** `2xx`, `4xx`, `5xx` — never the exact code, which triples the series count. */
export function statusClass(statusCode) {
  if (!Number.isFinite(statusCode)) return 'unknown';
  if (statusCode >= 500) return '5xx';
  if (statusCode >= 400) return '4xx';
  if (statusCode >= 300) return '3xx';
  if (statusCode >= 200) return '2xx';
  return 'other';
}

/**
 * Business operations that may appear as a metric label.
 *
 * A closed set, for the reason the whole file exists: `wev.business.operations`
 * takes an operation name, and an operation name derived from user input — an
 * event title, a search term — is an unbounded label. Anything not named here is
 * recorded as `other`, so a caller cannot widen the label space by accident.
 */
export const BUSINESS_OPERATIONS = new Set([
  'event.create', 'event.update', 'event.delete',
  'event.signup', 'event.withdraw',
  'attendance.finalize', 'attendance.close_out',
  'autoselect.run', 'equalizer.run',
  'auth.login', 'auth.register', 'auth.2fa',
  'welly.answer', 'search.discover', 'export.generate',
]);

let instruments = null;

/**
 * Creates the instruments, once.
 *
 * Called after the MeterProvider is registered. Before that — and when telemetry
 * is off entirely — `metrics.getMeter` returns the API's no-op meter, so every
 * `record` below becomes a function call that does nothing. That is what lets
 * the call sites be unconditional: no `if (enabled)` at 30 places, no chance of
 * one of them being wrong.
 */
export function initMetrics() {
  const meter = metrics.getMeter(METER_NAME);

  instruments = {
    httpDuration: meter.createHistogram('http.server.request.duration', {
      description: 'Duration of HTTP server requests.',
      unit: 'ms',
      advice: { explicitBucketBoundaries: LATENCY_BUCKETS },
    }),

    /* Refusals get their own counter rather than being read off the status
       class, because "how many people were told no" is an operational question
       asked on its own and answering it should not require a bucket query. Three
       series, total. */
    httpRefusals: meter.createCounter('wev.http.refusals', {
      description: 'Requests refused by authentication, authorisation or rate limiting.',
    }),

    dbDuration: meter.createHistogram('wev.db.operation.duration', {
      description: 'Duration of database operations.',
      unit: 'ms',
      advice: { explicitBucketBoundaries: LATENCY_BUCKETS },
    }),

    dbErrors: meter.createCounter('wev.db.errors', {
      description: 'Database operations that raised.',
    }),

    businessOperations: meter.createCounter('wev.business.operations', {
      description: 'Named business operations, by outcome.',
    }),
  };

  /**
   * Telemetry's own health, as observable gauges.
   *
   * Observable rather than recorded: these are the values of counters that
   * already exist elsewhere, and a callback that reads them at export time
   * cannot drift from the thing it is reporting. It also means the telemetry
   * pipeline reports its own drops — the failure mode that is otherwise
   * invisible by construction, because the mechanism for telling you is the one
   * that is failing.
   */
  const sinkGauge = meter.createObservableGauge('wev.telemetry.sink', {
    description: 'Better Stack log sink queue and delivery counters.',
  });
  sinkGauge.addCallback((observer) => {
    try {
      const s = telemetrySinkStats();
      observer.observe(s.pending, { state: 'pending' });
      observer.observe(s.dropped, { state: 'dropped' });
      observer.observe(s.failed, { state: 'failed' });
      observer.observe(s.sent, { state: 'sent' });
    } catch { /* a gauge that cannot read is a gauge that reports nothing */ }
  });

  return instruments;
}

/**
 * Wires the trace-pipeline gauges, which need the processor that owns the counters.
 *
 * Separate from `initMetrics` because the tail sampler is constructed after the
 * meter provider and passing it in would make the ordering a constraint rather
 * than a detail.
 */
export function observeTracePipeline(tailProcessor) {
  const meter = metrics.getMeter(METER_NAME);

  const gauge = meter.createObservableGauge('wev.telemetry.traces', {
    description: 'Trace sampling, buffering and budget counters.',
  });
  gauge.addCallback((observer) => {
    try {
      const s = tailProcessor.snapshot();
      observer.observe(s.spansExported, { state: 'exported' });
      observer.observe(s.spansDroppedBySampling, { state: 'dropped_sampling' });
      observer.observe(s.spansDroppedByOverflow, { state: 'dropped_overflow' });
      observer.observe(s.spansRefusedByBudget, { state: 'refused_budget' });
      observer.observe(s.pendingTraces, { state: 'pending_traces' });
      observer.observe(s.budget.remaining, { state: 'budget_remaining' });
    } catch { /* see above */ }
  });
}

/* ── Recording helpers ──────────────────────────────────────────────────────
 *
 * Each one is a no-op until `initMetrics` has run, and each swallows its own
 * errors. The call sites are on request and query paths; the guarantee they are
 * owed is the one `telemetrySink.js` states for the log wire — a telemetry fault
 * cannot become a user's fault.
 */

export function recordHttpRequest({ method, route, statusCode, durationMs }) {
  if (!instruments) return;
  try {
    const attrs = {
      'http.request.method': typeof method === 'string' ? method.slice(0, 10) : 'UNKNOWN',
      'http.route': normaliseRoute(route),
      'http.response.status_class': statusClass(statusCode),
    };
    instruments.httpDuration.record(Math.max(0, durationMs) || 0, attrs);

    const outcome = statusCode === 401 ? 'unauthenticated'
      : statusCode === 403 ? 'forbidden'
        : statusCode === 429 ? 'rate_limited'
          : null;
    if (outcome) instruments.httpRefusals.add(1, { outcome });
  } catch { /* never the reason a response is not sent */ }
}

export function recordDbOperation({ operation, engine, durationMs, failed = false }) {
  if (!instruments) return;
  try {
    const attrs = { operation: normaliseDbOperation(operation), engine: engine === 'postgres' ? 'postgres' : 'sqlite' };
    instruments.dbDuration.record(Math.max(0, durationMs) || 0, attrs);
    if (failed) instruments.dbErrors.add(1, attrs);
  } catch { /* never the reason a query appears to fail */ }
}

/** Five values, taken from the statement's first word. Never the statement. */
export function normaliseDbOperation(operation) {
  const word = String(operation || '').trim().split(/\s+/)[0]?.toLowerCase();
  return ['select', 'insert', 'update', 'delete'].includes(word) ? word : 'other';
}

export function recordBusinessOperation(operation, outcome = 'ok') {
  if (!instruments) return;
  try {
    instruments.businessOperations.add(1, {
      operation: BUSINESS_OPERATIONS.has(operation) ? operation : 'other',
      outcome: outcome === 'error' ? 'error' : 'ok',
    });
  } catch { /* see above */ }
}

/** Test seam. Instruments and the route cap must not leak between cases. */
export function __resetMetricsForTests() {
  instruments = null;
  seenRoutes.clear();
}

export const METRIC_BOUNDS = Object.freeze({ MAX_DISTINCT_ROUTES, LATENCY_BUCKETS });
