/**
 * Cardinality, which is the whole cost model for metrics.
 *
 * Better Stack bills metrics by retained size, and retained size is series ×
 * datapoints × retention. One label carrying an identifier turns a fixed monthly
 * cost into one that grows with the user base — the failure that makes
 * observability bills famous, and the one thing about metrics that can actually
 * cost money here.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { METRIC_CARDINALITY_LIMIT, METRIC_TEMPORALITY } from './observability/otel.js';
import {
  normaliseRoute, statusClass, normaliseDbOperation, recordHttpRequest,
  recordDbOperation, recordBusinessOperation, BUSINESS_OPERATIONS, METRIC_BOUNDS,
  __resetMetricsForTests,
} from './observability/metrics.js';

beforeEach(() => { __resetMetricsForTests(); });

describe('normaliseRoute — the label that could become unbounded', () => {
  it('keeps an Express route pattern as it is', () => {
    expect(normaliseRoute('/api/events/:id')).toBe('/api/events/:id');
    expect(normaliseRoute('/api/events/:id/applications/:applicationId')).toBe('/api/events/:id/applications/:applicationId');
  });

  it('refuses a real path, which is a pattern that leaked', () => {
    /* `/42` is a value; `:id` is a pattern. A digit run in a path segment means
       something upstream passed the wrong thing, and recording it would create
       one series per event id. */
    expect(normaliseRoute('/api/events/42')).toBe('other');
    expect(normaliseRoute('/api/users/1001/hours')).toBe('other');
  });

  it('refuses anything carrying a query string or a fragment', () => {
    expect(normaliseRoute('/api/search?q=chris')).toBe('other');
    expect(normaliseRoute('/page#section')).toBe('other');
  });

  it('refuses an unreasonably long route', () => {
    expect(normaliseRoute('/a'.repeat(200))).toBe('other');
  });

  it('answers `unknown` for a missing route rather than inventing one', () => {
    expect(normaliseRoute(undefined)).toBe('unknown');
    expect(normaliseRoute('')).toBe('unknown');
    expect(normaliseRoute(null)).toBe('unknown');
    expect(normaliseRoute(42)).toBe('unknown');
  });

  it('caps the number of distinct route labels this process will ever emit', () => {
    /* The backstop that makes an explosion impossible rather than unlikely: even
       if every guard above were defeated, the label space is finite. */
    const labels = new Set();
    for (let i = 0; i < METRIC_BOUNDS.MAX_DISTINCT_ROUTES + 200; i++) {
      labels.add(normaliseRoute(`/api/route-${String.fromCharCode(97 + (i % 26))}${'x'.repeat(i % 30)}/:id`));
    }
    expect(labels.size).toBeLessThanOrEqual(METRIC_BOUNDS.MAX_DISTINCT_ROUTES + 1);
    expect(labels.has('other')).toBe(true);
  });

  it('keeps answering for routes it already knows once the cap is reached', () => {
    const first = normaliseRoute('/api/first/:id');
    for (let i = 0; i < METRIC_BOUNDS.MAX_DISTINCT_ROUTES + 50; i++) normaliseRoute(`/api/filler-${i}/:id`);
    /* A route seen before the cap must not start reporting as `other`, or a
       dashboard's history would break at an arbitrary moment. */
    expect(normaliseRoute('/api/first/:id')).toBe(first);
  });
});

describe('statusClass — three values, not six hundred', () => {
  it('buckets by class', () => {
    expect(statusClass(200)).toBe('2xx');
    expect(statusClass(204)).toBe('2xx');
    expect(statusClass(301)).toBe('3xx');
    expect(statusClass(404)).toBe('4xx');
    expect(statusClass(422)).toBe('4xx');
    expect(statusClass(500)).toBe('5xx');
    expect(statusClass(503)).toBe('5xx');
  });

  it('never returns the exact code, which would triple the series count', () => {
    const values = new Set();
    for (let code = 100; code < 600; code++) values.add(statusClass(code));
    expect(values.size).toBeLessThanOrEqual(6);
  });

  it('handles a missing status without inventing a label', () => {
    expect(statusClass(undefined)).toBe('unknown');
    expect(statusClass(NaN)).toBe('unknown');
  });
});

describe('normaliseDbOperation', () => {
  it('reduces a statement to its verb, never the statement', () => {
    expect(normaliseDbOperation('SELECT * FROM users WHERE email = ?')).toBe('select');
    expect(normaliseDbOperation('insert into events values (?)')).toBe('insert');
    expect(normaliseDbOperation('PRAGMA table_info(users)')).toBe('other');
  });

  it('cannot be made unbounded by a hostile statement', () => {
    const values = new Set();
    for (let i = 0; i < 500; i++) values.add(normaliseDbOperation(`WEIRDVERB${i} something`));
    expect(values).toEqual(new Set(['other']));
  });
});

describe('recordBusinessOperation — a closed label set', () => {
  it('has a bounded set of operation names', () => {
    expect(BUSINESS_OPERATIONS.size).toBeLessThanOrEqual(30);
  });

  it('contains no name that looks user-supplied', () => {
    for (const op of BUSINESS_OPERATIONS) {
      /* `auth.2fa` is a legitimate code-declared name, so a segment may begin
         with a digit; what matters is that the whole label is lower-case,
         dotted and short — a shape no user input can take. */
      expect(op).toMatch(/^[a-z][a-z0-9]*(\.[a-z0-9][a-z0-9_]*)+$/);
      expect(op.length).toBeLessThanOrEqual(40);
    }
  });
});

describe('the recording helpers are safe before initMetrics', () => {
  /* Every call site is unconditional by design — there is no `if (enabled)` at
     thirty places to get wrong — so the helpers have to be no-ops until the
     meter provider exists, and must never throw. */
  it('does nothing and throws nothing', () => {
    expect(() => recordHttpRequest({ method: 'GET', route: '/x', statusCode: 200, durationMs: 5 })).not.toThrow();
    expect(() => recordDbOperation({ operation: 'SELECT 1', engine: 'sqlite', durationMs: 1 })).not.toThrow();
    expect(() => recordBusinessOperation('event.signup', 'ok')).not.toThrow();
  });

  it('throws nothing on hostile input either', () => {
    expect(() => recordHttpRequest({ method: null, route: {}, statusCode: 'x', durationMs: NaN })).not.toThrow();
    expect(() => recordBusinessOperation(Symbol('x'))).not.toThrow();
  });
});

describe('the latency buckets', () => {
  it('are given explicitly rather than left to the SDK default', () => {
    /* The default ladder has 16 boundaries; every extra boundary is a value
       stored, per series, per export, for the retention period. */
    expect(METRIC_BOUNDS.LATENCY_BUCKETS.length).toBeLessThanOrEqual(12);
    expect(METRIC_BOUNDS.LATENCY_BUCKETS).toEqual([...METRIC_BOUNDS.LATENCY_BUCKETS].sort((a, b) => a - b));
  });

  it('covers the thresholds this application actually acts on', () => {
    /* 1000ms is `telemetry.js`'s "slow request" line and `tailSampler.js`'s
       always-keep line; a histogram that could not resolve it would make the
       three signals disagree about what slow means. */
    expect(METRIC_BOUNDS.LATENCY_BUCKETS).toContain(1000);
  });
});

describe('the hard cardinality ceiling', () => {
  /**
   * A guard on the NUMBER, because that is the cost control.
   *
   * `normaliseRoute` bounds the labels this codebase produces. This bounds the
   * ones it does not: an instrumentation added later, a semantic convention that
   * grows an attribute, a label nobody reviewed. Better Stack bills metrics by
   * retained size and retained size is series count, so an unbounded limit is an
   * unbounded bill — which is why raising it should have to change this line.
   */
  it('is set, and is far below anything expensive', () => {
    expect(METRIC_CARDINALITY_LIMIT).toBeGreaterThan(200);
    expect(METRIC_CARDINALITY_LIMIT).toBeLessThanOrEqual(2000);
  });

  it('leaves room for the ~150 series this application actually produces', () => {
    /* Comfortably above the real figure, so the ceiling never truncates normal
       operation — it only stops an explosion. */
    expect(METRIC_CARDINALITY_LIMIT).toBeGreaterThan(3 * METRIC_BOUNDS.MAX_DISTINCT_ROUTES);
  });
});

describe('metric temporality', () => {
  /**
   * A guard on the VALUE, because cumulative silently empties the histograms.
   *
   * Measured: under cumulative, `http.server.request.duration` had 4 non-zero
   * rows out of 2,742 in the real account, because a cumulative datapoint needs
   * a predecessor to be meaningful and most exports here are a short-lived
   * process's single shutdown flush. Under delta the same run reported 420 / 20
   * / 40 / 10 exactly as served.
   *
   * Metrics are the only signal covering 100% of traffic — traces are sampled at
   * 2% — so this is the setting that decides whether that claim is true.
   */
  it('is delta, so a short-lived process still reports what it served', () => {
    expect(METRIC_TEMPORALITY).toBe('delta');
  });
});
