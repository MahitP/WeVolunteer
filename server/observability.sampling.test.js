/**
 * Sampling, buffering and the budget — the three things standing between this
 * integration and a bill.
 *
 * The properties asserted here are the ones the $0 constraint actually rests on:
 * a trace that failed is kept regardless of the rate, an ordinary trace is kept
 * only at the rate, memory is bounded under every kind of abuse, and the daily
 * budget is a ceiling rather than a suggestion.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { SpanStatusCode } from '@opentelemetry/api';
import { SpanBudget } from './observability/spanBudget.js';
import {
  TailSamplingSpanProcessor, isInterestingRoot, traceIdRatio, TAIL_SAMPLER_BOUNDS,
} from './observability/tailSampler.js';

/** A collecting stand-in for the BatchSpanProcessor underneath. */
function fakeDownstream() {
  const seen = [];
  return {
    seen,
    onStart() {},
    onEnd(span) { seen.push(span); },
    forceFlush: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
}

let counter = 0;
/** A ReadableSpan-shaped object; only the fields the processor reads. */
function makeSpan({
  traceId = 'a'.repeat(32), spanId, parentSpanContext, status = { code: SpanStatusCode.UNSET },
  attributes = {}, durationMs = 5, name = 'span',
} = {}) {
  const id = spanId ?? String(counter++).padStart(16, '0');
  return {
    name,
    status,
    attributes,
    duration: [Math.floor(durationMs / 1000), (durationMs % 1000) * 1e6],
    parentSpanContext,
    spanContext: () => ({ traceId, spanId: id }),
  };
}

const CHILD_PARENT = { traceId: 'a'.repeat(32), spanId: 'f'.repeat(16), isRemote: false };

beforeEach(() => { counter = 0; });

describe('SpanBudget', () => {
  it('permits spend up to the limit and refuses past it', () => {
    const budget = new SpanBudget({ limit: 10 });
    expect(budget.consume(4)).toBe(true);
    expect(budget.consume(6)).toBe(true);
    expect(budget.consume(1)).toBe(false);
    expect(budget.stats()).toMatchObject({ spent: 10, remaining: 0, refused: 1 });
  });

  it('is all-or-nothing: a trace that does not fit is refused entirely', () => {
    const budget = new SpanBudget({ limit: 10 });
    budget.consume(8);
    /* Not "spend the last 2 and truncate" — half a waterfall reads as an
       application bug rather than a truncated export. */
    expect(budget.consume(5)).toBe(false);
    expect(budget.stats().spent).toBe(8);
    expect(budget.stats().refused).toBe(5);
  });

  it('a limit of zero disables tracing entirely', () => {
    const budget = new SpanBudget({ limit: 0 });
    expect(budget.hasRoom()).toBe(false);
    expect(budget.consume(1)).toBe(false);
  });

  it('rolls the window forward and restores the budget', () => {
    let now = 1_000_000;
    const budget = new SpanBudget({ limit: 5, windowMs: 1000, now: () => now });
    expect(budget.consume(5)).toBe(true);
    expect(budget.consume(1)).toBe(false);

    now += 1001;
    expect(budget.hasRoom()).toBe(true);
    expect(budget.consume(5)).toBe(true);
    expect(budget.stats().windowsElapsed).toBe(1);
  });

  it('jumps whole windows after a long idle rather than resetting to now', () => {
    let now = 0;
    const budget = new SpanBudget({ limit: 5, windowMs: 1000, now: () => now });
    budget.consume(5);
    now = 10_500;                       // ten and a half windows later
    expect(budget.stats().windowsElapsed).toBe(10);
    expect(budget.stats().spent).toBe(0);
    /* The window boundary stayed on the grid: 500ms in, not restarted at 10_500. */
    expect(budget.windowStart).toBe(10_000);
  });

  it('warns once, not once per refusal', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const budget = new SpanBudget({ limit: 1 });
    budget.consume(1);
    for (let i = 0; i < 50; i++) budget.consume(1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('isInterestingRoot — what is kept regardless of the rate', () => {
  it('keeps a span with ERROR status', () => {
    expect(isInterestingRoot(makeSpan({ status: { code: SpanStatusCode.ERROR } }))).toBe(true);
  });

  it('keeps a 5xx', () => {
    expect(isInterestingRoot(makeSpan({ attributes: { 'http.response.status_code': 503 } }))).toBe(true);
  });

  it('keeps a slow success', () => {
    expect(isInterestingRoot(makeSpan({ durationMs: TAIL_SAMPLER_BOUNDS.SLOW_TRACE_MS + 1 }))).toBe(true);
  });

  it('does NOT keep a 4xx by default', () => {
    /* Deliberate: refusals are ordinary traffic on a public application and
       arrive in bulk. They stay fully visible in the metrics and the log sink. */
    for (const code of [400, 401, 403, 404, 429]) {
      expect(isInterestingRoot(makeSpan({ attributes: { 'http.response.status_code': code } }))).toBe(false);
    }
  });

  it('does not keep an ordinary fast 200', () => {
    expect(isInterestingRoot(makeSpan({ attributes: { 'http.response.status_code': 200 }, durationMs: 12 }))).toBe(false);
  });
});

describe('traceIdRatio', () => {
  it('is deterministic for the same id', () => {
    expect(traceIdRatio('b'.repeat(32))).toBe(traceIdRatio('b'.repeat(32)));
  });

  it('spreads roughly uniformly across ids shaped like the SDK\'s', () => {
    /* Generated the way `RandomIdGenerator` generates them — 16 random bytes —
       because that is the only input this function ever sees in production and
       the distribution claim is only meaningful against it. */
    let kept = 0;
    const N = 20_000;
    for (let i = 0; i < N; i++) {
      if (traceIdRatio(randomBytes(16).toString('hex')) < 0.1) kept++;
    }
    /* Loose bounds: the point is "roughly a tenth", not a distribution test. */
    expect(kept / N).toBeGreaterThan(0.08);
    expect(kept / N).toBeLessThan(0.12);
  });

  it('reads the last 32 bits, so sequential ids are NOT spread', () => {
    /* Pinning a real limitation rather than hiding it. `TraceIdRatioBasedSampler`
       samples the same way, so this matches the ecosystem — but it means the
       function is only uniform on ids that are random in their TAIL. Every id
       this application samples comes from the SDK's CSPRNG, and inbound trace
       context is refused (see propagation.js), so nothing can feed it a crafted
       run of ids to force itself into the sample. If either of those ever
       changes, this test is the one that should stop making sense. */
    const sequential = Array.from({ length: 100 }, (_, i) => i.toString(16).padStart(32, '0'));
    expect(sequential.every(id => traceIdRatio(id) < 0.0001)).toBe(true);
  });
});

describe('TailSamplingSpanProcessor — the decision', () => {
  it('holds children until the root ends, then exports the whole trace together', () => {
    const downstream = fakeDownstream();
    const processor = new TailSamplingSpanProcessor({
      downstream, budget: new SpanBudget({ limit: 100 }), sampleRatio: 1,
    });

    processor.onEnd(makeSpan({ parentSpanContext: CHILD_PARENT, name: 'child-1' }));
    processor.onEnd(makeSpan({ parentSpanContext: CHILD_PARENT, name: 'child-2' }));
    expect(downstream.seen).toHaveLength(0);      // nothing decided yet

    processor.onEnd(makeSpan({ name: 'root' }));
    expect(downstream.seen.map(s => s.name)).toEqual(['child-1', 'child-2', 'root']);
  });

  it('drops a whole ordinary trace when the rate says so', () => {
    const downstream = fakeDownstream();
    const processor = new TailSamplingSpanProcessor({
      downstream, budget: new SpanBudget({ limit: 100 }), sampleRatio: 0,
    });

    processor.onEnd(makeSpan({ parentSpanContext: CHILD_PARENT }));
    processor.onEnd(makeSpan({ name: 'root' }));

    expect(downstream.seen).toHaveLength(0);
    expect(processor.snapshot()).toMatchObject({ tracesDropped: 1, spansDroppedBySampling: 2 });
  });

  it('keeps a FAILED trace at a zero sample rate — the property head sampling cannot give', () => {
    const downstream = fakeDownstream();
    const processor = new TailSamplingSpanProcessor({
      downstream, budget: new SpanBudget({ limit: 100 }), sampleRatio: 0,
    });

    processor.onEnd(makeSpan({ parentSpanContext: CHILD_PARENT, name: 'child' }));
    processor.onEnd(makeSpan({ name: 'root', attributes: { 'http.response.status_code': 500 } }));

    expect(downstream.seen.map(s => s.name)).toEqual(['child', 'root']);
    expect(processor.snapshot().tracesKept).toBe(1);
  });

  it('treats a span with a REMOTE parent as a root', () => {
    /* This service refuses inbound trace context, so a remote parent is one
       nobody agreed to join — and a span waiting for a root that lives in
       another process would wait for ever. */
    const downstream = fakeDownstream();
    const processor = new TailSamplingSpanProcessor({
      downstream, budget: new SpanBudget({ limit: 100 }), sampleRatio: 1,
    });
    processor.onEnd(makeSpan({ parentSpanContext: { ...CHILD_PARENT, isRemote: true }, name: 'remote-child' }));
    expect(downstream.seen.map(s => s.name)).toEqual(['remote-child']);
  });

  it('sends a late span the way its trace already decided', () => {
    const downstream = fakeDownstream();
    const processor = new TailSamplingSpanProcessor({
      downstream, budget: new SpanBudget({ limit: 100 }), sampleRatio: 1,
    });

    processor.onEnd(makeSpan({ name: 'root' }));
    expect(downstream.seen).toHaveLength(1);

    /* Background work started inside the request, finishing after the response. */
    processor.onEnd(makeSpan({ parentSpanContext: CHILD_PARENT, name: 'straggler' }));
    expect(downstream.seen.map(s => s.name)).toEqual(['root', 'straggler']);
    expect(processor.snapshot().lateSpans).toBe(1);
  });

  it('does not let a late span sneak past a decision to drop', () => {
    const downstream = fakeDownstream();
    const processor = new TailSamplingSpanProcessor({
      downstream, budget: new SpanBudget({ limit: 100 }), sampleRatio: 0,
    });
    processor.onEnd(makeSpan({ name: 'root' }));
    processor.onEnd(makeSpan({ parentSpanContext: CHILD_PARENT, name: 'straggler' }));
    expect(downstream.seen).toHaveLength(0);
  });
});

describe('TailSamplingSpanProcessor — the bounds', () => {
  it('evicts the oldest trace rather than growing past MAX_BUFFERED_TRACES', () => {
    const downstream = fakeDownstream();
    const processor = new TailSamplingSpanProcessor({
      downstream, budget: new SpanBudget({ limit: 1e9 }), sampleRatio: 1,
    });

    const over = TAIL_SAMPLER_BOUNDS.MAX_BUFFERED_TRACES + 50;
    for (let i = 0; i < over; i++) {
      const traceId = i.toString(16).padStart(32, '0');
      processor.onEnd(makeSpan({ traceId, parentSpanContext: { traceId, spanId: 'f'.repeat(16), isRemote: false } }));
    }

    expect(processor.pending.size).toBe(TAIL_SAMPLER_BOUNDS.MAX_BUFFERED_TRACES);
    expect(processor.snapshot().tracesEvicted).toBe(50);
  });

  it('refuses further spans past MAX_SPANS_PER_TRACE instead of buffering them', () => {
    const downstream = fakeDownstream();
    const processor = new TailSamplingSpanProcessor({
      downstream, budget: new SpanBudget({ limit: 1e9 }), sampleRatio: 1,
    });

    const over = TAIL_SAMPLER_BOUNDS.MAX_SPANS_PER_TRACE + 25;
    for (let i = 0; i < over; i++) processor.onEnd(makeSpan({ parentSpanContext: CHILD_PARENT }));

    expect(processor.pending.get('a'.repeat(32)).spans).toHaveLength(TAIL_SAMPLER_BOUNDS.MAX_SPANS_PER_TRACE);
    expect(processor.snapshot().spansDroppedByOverflow).toBe(25);
  });

  it('sweeps away a trace whose root never arrived', () => {
    let now = 1_000_000;
    const downstream = fakeDownstream();
    const processor = new TailSamplingSpanProcessor({
      downstream, budget: new SpanBudget({ limit: 1e9 }), sampleRatio: 1, now: () => now,
    });

    processor.onEnd(makeSpan({ parentSpanContext: CHILD_PARENT }));
    expect(processor.pending.size).toBe(1);

    now += TAIL_SAMPLER_BOUNDS.TTL_MS + 1;
    processor._sweep();

    expect(processor.pending.size).toBe(0);
    expect(processor.snapshot().tracesEvicted).toBe(1);
    expect(downstream.seen).toHaveLength(0);      // a partial trace is not exported
  });

  it('does not hold the event loop open with its sweep timer', async () => {
    const processor = new TailSamplingSpanProcessor({
      downstream: fakeDownstream(), budget: new SpanBudget({ limit: 1 }), sampleRatio: 1,
    });
    /* `hasRef()` is Node's own answer to "would this keep the process alive". */
    expect(processor.sweepTimer.hasRef()).toBe(false);
    await processor.shutdown();
  });

  it('bounds the decision memo the same way as the buffer', () => {
    const processor = new TailSamplingSpanProcessor({
      downstream: fakeDownstream(), budget: new SpanBudget({ limit: 1e9 }), sampleRatio: 0,
    });
    for (let i = 0; i < TAIL_SAMPLER_BOUNDS.MAX_BUFFERED_TRACES + 100; i++) {
      processor.onEnd(makeSpan({ traceId: i.toString(16).padStart(32, '0') }));
    }
    expect(processor.decided.size).toBeLessThanOrEqual(TAIL_SAMPLER_BOUNDS.MAX_BUFFERED_TRACES);
  });
});

describe('TailSamplingSpanProcessor — the budget is a ceiling', () => {
  it('refuses a trace that does not fit, and counts it', () => {
    const downstream = fakeDownstream();
    const processor = new TailSamplingSpanProcessor({
      downstream, budget: new SpanBudget({ limit: 3 }), sampleRatio: 1,
    });

    processor.onEnd(makeSpan({ parentSpanContext: CHILD_PARENT }));
    processor.onEnd(makeSpan({ parentSpanContext: CHILD_PARENT }));
    processor.onEnd(makeSpan({ name: 'root-a' }));          // 3 spans — fits exactly
    expect(downstream.seen).toHaveLength(3);

    const t2 = 'b'.repeat(32);
    processor.onEnd(makeSpan({ traceId: t2, name: 'root-b' }));
    expect(downstream.seen).toHaveLength(3);                 // nothing more got out
    expect(processor.snapshot().spansRefusedByBudget).toBe(1);
  });

  it('an exhausted budget refuses an ERROR trace too — money is the harder limit', () => {
    const downstream = fakeDownstream();
    const processor = new TailSamplingSpanProcessor({
      downstream, budget: new SpanBudget({ limit: 0 }), sampleRatio: 1,
    });
    processor.onEnd(makeSpan({ name: 'root', status: { code: SpanStatusCode.ERROR } }));
    expect(downstream.seen).toHaveLength(0);
  });
});

describe('TailSamplingSpanProcessor — failure is forward, never fatal', () => {
  it('does not throw when a span is malformed', () => {
    const downstream = fakeDownstream();
    const processor = new TailSamplingSpanProcessor({
      downstream, budget: new SpanBudget({ limit: 10 }), sampleRatio: 1,
    });
    expect(() => processor.onEnd({ spanContext: () => { throw new Error('boom'); } })).not.toThrow();
  });

  it('does not throw when the downstream processor throws', () => {
    const downstream = { onStart() {}, onEnd() { throw new Error('downstream is down'); },
      forceFlush: async () => {}, shutdown: async () => {} };
    const processor = new TailSamplingSpanProcessor({
      downstream, budget: new SpanBudget({ limit: 10 }), sampleRatio: 1,
    });
    expect(() => processor.onEnd(makeSpan({ name: 'root' }))).not.toThrow();
  });

  it('does not export partial traces on forceFlush', async () => {
    const downstream = fakeDownstream();
    const processor = new TailSamplingSpanProcessor({
      downstream, budget: new SpanBudget({ limit: 100 }), sampleRatio: 1,
    });
    processor.onEnd(makeSpan({ parentSpanContext: CHILD_PARENT }));
    await processor.forceFlush();
    expect(downstream.seen).toHaveLength(0);
    expect(downstream.forceFlush).toHaveBeenCalled();
  });

  it('clears its buffers and stops its timer on shutdown', async () => {
    const downstream = fakeDownstream();
    const processor = new TailSamplingSpanProcessor({
      downstream, budget: new SpanBudget({ limit: 100 }), sampleRatio: 1,
    });
    processor.onEnd(makeSpan({ parentSpanContext: CHILD_PARENT }));
    await processor.shutdown();
    expect(processor.pending.size).toBe(0);
    expect(downstream.shutdown).toHaveBeenCalled();
  });
});
