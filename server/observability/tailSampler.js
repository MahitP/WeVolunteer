/**
 * Keeps every trace that went wrong, and 2% of the ones that did not.
 *
 * ── The problem head sampling cannot solve ──
 *
 * OpenTelemetry's built-in samplers decide at span START, which is before the
 * request has done anything. `TraceIdRatioBasedSampler(0.02)` therefore keeps 2%
 * of successes and 2% of failures — and the 98% of failures it discards are the
 * only traces anybody was ever going to look at. Raising the rate to keep them
 * means paying for the successes too, and the successes are ~99% of the volume.
 *
 * The standard answer is tail sampling in an OpenTelemetry Collector: a separate
 * process, supervised separately, deployed separately. That is a reasonable
 * answer for a fleet and a poor one here — this is a single long-lived Node
 * service on one host, and adding a second daemon to decide what to keep would
 * be more operational surface than the application it observes.
 *
 * So the decision is deferred in-process. Spans are held until their ROOT ends,
 * at which point the outcome is known and the whole trace is kept or dropped
 * together.
 *
 * ── What this buys, in the terms that matter here ──
 *
 * The base rate can be set an order of magnitude lower than it otherwise could,
 * because the rate no longer has to be high enough to catch failures by luck.
 * That is what keeps a month of ordinary traffic at ~90 MB against a 3 GB free
 * allowance while still having a complete trace for every 500 the application
 * has ever served.
 *
 * ── Why holding spans in memory is safe here, and where the bounds are ──
 *
 * Buffering is the risk this file has to earn, so it is bounded four ways, and
 * every bound drops data rather than growing:
 *
 *   traces      MAX_BUFFERED_TRACES; the oldest trace is evicted whole
 *   spans/trace MAX_SPANS_PER_TRACE; further spans in that trace are refused
 *   age         a sweep evicts any trace whose root has not arrived in TTL_MS
 *   budget      `SpanBudget`, which is about money rather than memory
 *
 * The worst case is `500 × 100` spans held, which at the size a span serialises
 * to is a few tens of megabytes — and reaching it requires 500 concurrent
 * requests each producing 100 spans, on a service whose own HTTP drain timeout
 * is 15 seconds. Ordinary operation holds one trace per in-flight request for
 * the length of that request.
 *
 * ── Failure is forward, never fatal ──
 *
 * Every entry point is wrapped. An unexpected internal error forwards the span
 * downstream rather than dropping it, and never propagates: this object sits on
 * the hot path of every request, and the contract `telemetrySink.js` establishes
 * for the log wire — that a telemetry fault cannot become a user's fault — is
 * not weakened by adding a second wire.
 */
import { SpanStatusCode, SpanKind } from '@opentelemetry/api';

/** Concurrent traces held while waiting for their root to end. */
const MAX_BUFFERED_TRACES = 500;

/** Spans held for any one trace. A runaway loop cannot buy more than this. */
const MAX_SPANS_PER_TRACE = 100;

/**
 * How long a trace may wait for a root that never comes.
 *
 * A root arrives when the HTTP response finishes, so the normal wait is one
 * request. Sixty seconds is past every timeout this application has — the
 * in-flight drain is 15s and the OTLP export timeout is 5s — so anything still
 * waiting is a span that leaked, not a request that is slow.
 */
const TTL_MS = 60_000;

/** How often the sweep runs. */
const SWEEP_INTERVAL_MS = 15_000;

/**
 * A successful request slower than this is kept regardless of the sample rate.
 *
 * The same threshold `telemetry.js` uses for always logging a slow request, and
 * deliberately so: an operator who sees a slow-request log line should be able
 * to open the trace behind it, and two different thresholds would mean sometimes
 * there isn't one.
 */
const SLOW_TRACE_MS = 1000;

/**
 * Whether a finished root span describes something worth keeping unconditionally.
 *
 * Errors and slowness only. 4xx is deliberately NOT here: an unauthenticated
 * request, a rejected form and a rate-limited client are ordinary traffic on a
 * public application, they arrive in bulk, and keeping all of them would spend
 * the allowance on the least surprising thing the server does. They remain fully
 * visible in the metrics (which count the whole population) and in the log sink
 * (which records every one).
 */
export function isInterestingRoot(span) {
  if (span.status?.code === SpanStatusCode.ERROR) return true;

  const status = span.attributes?.['http.response.status_code'];
  if (typeof status === 'number' && status >= 500) return true;

  /* `duration` is an HrTime pair, [seconds, nanoseconds]. */
  const [s, ns] = span.duration ?? [0, 0];
  if (s * 1000 + ns / 1e6 >= SLOW_TRACE_MS) return true;

  return false;
}

/**
 * A stable 0–1 value derived from the trace id.
 *
 * Deterministic rather than `Math.random()` for two reasons: the same trace
 * reaching this code twice must decide the same way, and a test can assert the
 * rate without running the law of large numbers. The last 8 hex characters are
 * used because trace ids are generated most-random-last in some SDKs and this
 * matches what `TraceIdRatioBasedSampler` samples on.
 */
export function traceIdRatio(traceId) {
  if (typeof traceId !== 'string' || traceId.length < 8) return 1;
  const tail = traceId.slice(-8);
  const value = Number.parseInt(tail, 16);
  if (!Number.isFinite(value)) return 1;
  return value / 0xffffffff;
}

export class TailSamplingSpanProcessor {
  /**
   * @param {object} opts
   * @param {import('@opentelemetry/sdk-trace-base').SpanProcessor} opts.downstream
   * @param {import('./spanBudget.js').SpanBudget} opts.budget
   * @param {number} opts.sampleRatio
   * @param {() => number} [opts.now]
   */
  constructor({ downstream, budget, sampleRatio, now = Date.now }) {
    this.downstream = downstream;
    this.budget = budget;
    this.sampleRatio = sampleRatio;
    this.now = now;

    /** traceId -> { spans: ReadableSpan[], firstSeen: number, overflowed: boolean } */
    this.pending = new Map();

    /**
     * traceId -> true|false, for spans that end AFTER their root.
     *
     * Background work started inside a request can outlive the response — the
     * root ends, the trace is decided, and a span belonging to it arrives
     * afterwards. Without this it would be buffered under a trace nothing will
     * ever decide, and evicted by the sweep sixty seconds later; with it, it
     * follows the decision its own trace already made.
     */
    this.decided = new Map();

    this.stats = {
      tracesKept: 0,
      tracesDropped: 0,
      tracesEvicted: 0,
      spansExported: 0,
      spansDroppedBySampling: 0,
      spansDroppedByOverflow: 0,
      spansRefusedByBudget: 0,
      lateSpans: 0,
    };

    this.sweepTimer = setInterval(() => this._sweep(), SWEEP_INTERVAL_MS);
    /* A sweep must never be the reason a finished process stays alive. */
    if (typeof this.sweepTimer.unref === 'function') this.sweepTimer.unref();
  }

  onStart() { /* nothing to do until a span ends */ }

  onEnd(span) {
    try {
      this._route(span);
    } catch {
      /* Something unexpected about this span. Forwarding it costs at most one
         span of budget; dropping the request because telemetry was confused
         costs a user. */
      try { this.downstream.onEnd(span); } catch { /* downstream is out too */ }
    }
  }

  _route(span) {
    const ctx = span.spanContext();
    const traceId = ctx?.traceId;
    if (!traceId) { this.downstream.onEnd(span); return; }

    /* A root is a span with no parent inside this process. `parentSpanContext`
       is absent for one; a REMOTE parent is treated as absent too, because this
       service refuses inbound trace context (see propagation.js) and any remote
       parent that reached here is not one we agreed to join. */
    const parent = span.parentSpanContext;
    const isRoot = !parent || parent.isRemote === true;

    if (isRoot) { this._decide(traceId, span); return; }

    const already = this.decided.get(traceId);
    if (already !== undefined) {
      this.stats.lateSpans++;
      if (already && this.budget.consume(1)) {
        this.stats.spansExported++;
        this.downstream.onEnd(span);
      } else {
        this.stats.spansDroppedBySampling++;
      }
      return;
    }

    this._buffer(traceId, span);
  }

  _buffer(traceId, span) {
    let entry = this.pending.get(traceId);
    if (!entry) {
      if (this.pending.size >= MAX_BUFFERED_TRACES) {
        /* Map iteration is insertion-ordered, so the first key is the oldest
           trace. Evicting a whole trace rather than a span keeps the invariant
           that a trace is exported complete or not at all. */
        const oldest = this.pending.keys().next().value;
        const victim = this.pending.get(oldest);
        this.pending.delete(oldest);
        this.stats.tracesEvicted++;
        this.stats.spansDroppedByOverflow += victim?.spans.length ?? 0;
      }
      entry = { spans: [], firstSeen: this.now(), overflowed: false };
      this.pending.set(traceId, entry);
    }

    if (entry.spans.length >= MAX_SPANS_PER_TRACE) {
      entry.overflowed = true;
      this.stats.spansDroppedByOverflow++;
      return;
    }
    entry.spans.push(span);
  }

  /**
   * The whole point of the file: one decision, applied to a whole trace.
   */
  _decide(traceId, rootSpan) {
    const entry = this.pending.get(traceId);
    this.pending.delete(traceId);

    const spans = entry ? [...entry.spans, rootSpan] : [rootSpan];

    const keep = isInterestingRoot(rootSpan) || traceIdRatio(traceId) < this.sampleRatio;

    /* Remembered before any export, so a late span cannot race the decision. */
    this._remember(traceId, keep);

    if (!keep) {
      this.stats.tracesDropped++;
      this.stats.spansDroppedBySampling += spans.length;
      return;
    }

    /* All-or-nothing: half a waterfall reads as an application bug. */
    if (!this.budget.consume(spans.length)) {
      this.stats.tracesDropped++;
      this.stats.spansRefusedByBudget += spans.length;
      /* The trace was wanted but not affordable. A later span of the same trace
         must not sneak past the budget on its own. */
      this._remember(traceId, false);
      return;
    }

    this.stats.tracesKept++;
    this.stats.spansExported += spans.length;
    for (const s of spans) {
      try { this.downstream.onEnd(s); } catch { /* one bad span, not a bad trace */ }
    }
  }

  /**
   * Records a trace's decision for long enough that its stragglers can follow it.
   *
   * Bounded the same way everything else here is: the map is capped and evicts
   * oldest-first. A trace whose decision has been forgotten is treated as a new
   * trace, which is the harmless outcome — its late span is buffered and then
   * swept.
   */
  _remember(traceId, keep) {
    if (this.decided.size >= MAX_BUFFERED_TRACES) {
      const oldest = this.decided.keys().next().value;
      this.decided.delete(oldest);
    }
    this.decided.delete(traceId);
    this.decided.set(traceId, keep);
  }

  /** Evicts traces whose root never arrived, and stale decisions. */
  _sweep() {
    try {
      const cutoff = this.now() - TTL_MS;
      for (const [traceId, entry] of this.pending) {
        /* Insertion-ordered: the first entry newer than the cutoff means every
           entry after it is newer too. */
        if (entry.firstSeen >= cutoff) break;
        this.pending.delete(traceId);
        this.stats.tracesEvicted++;
        this.stats.spansDroppedByOverflow += entry.spans.length;
      }
      /* `decided` has no timestamps by design — it is a fixed-size LRU and its
         only job is to outlive a straggler, which takes milliseconds. */
    } catch { /* a sweep that fails must not take the interval down */ }
  }

  async forceFlush() {
    /* Buffered spans are deliberately NOT flushed. Their roots have not ended,
       so exporting them would publish partial traces — a waterfall missing the
       request it belongs to, which reads as a broken application rather than an
       interrupted export. They are dropped, and the downstream batch (whole
       traces, already decided) is what gets flushed. */
    try { await this.downstream.forceFlush(); } catch { /* counted downstream */ }
  }

  async shutdown() {
    try { clearInterval(this.sweepTimer); } catch { /* already gone */ }
    this.pending.clear();
    this.decided.clear();
    try { await this.downstream.shutdown(); } catch { /* nothing left to do */ }
  }

  snapshot() {
    return { ...this.stats, pendingTraces: this.pending.size, budget: this.budget.stats() };
  }
}

export const TAIL_SAMPLER_BOUNDS = Object.freeze({
  MAX_BUFFERED_TRACES, MAX_SPANS_PER_TRACE, TTL_MS, SLOW_TRACE_MS, SWEEP_INTERVAL_MS,
});

/* Re-exported so callers need not import from two places to build a processor. */
export { SpanKind };
