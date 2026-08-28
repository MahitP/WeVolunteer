#!/usr/bin/env node
/**
 * Mutation check for the observability pipeline.
 *
 * ── What this is for ──
 *
 * A passing test proves the code does something. It does not prove the test
 * would NOTICE if the code stopped doing it — and for this integration the
 * things that must not stop are unusually easy to break without any test going
 * red: a redaction that silently starts passing a query string, a budget that
 * silently stops being consumed, a sampler that silently keeps everything.
 *
 * Each entry below removes exactly ONE guarantee this integration claims, runs
 * the suite that is supposed to be guarding it, and reports whether the suite
 * noticed. A mutation that SURVIVES is a test that is decorative.
 *
 * Two survived when this was first run, and both were real defects in the tests
 * rather than in the code:
 *
 *   · the shutdown-deadline mutation left the timeout branch in the race, so it
 *     had not actually removed the deadline — a faulty mutation, which is its
 *     own kind of false comfort;
 *   · the inbound-traceparent test searched the wire for the trace id as HEX,
 *     and OTLP encodes trace_id as 16 raw bytes. The hex string could never
 *     have appeared whatever the code did. That assertion was unfalsifiable and
 *     was rewritten to search the raw bytes.
 *
 * Both are recorded here because they are the reason this file exists.
 *
 * ── Usage ──
 *
 *     node bin/otel-mutation-check.mjs            # all of them (slow: ~15 min)
 *     node bin/otel-mutation-check.mjs redaction  # only matching names
 *
 * Every mutation is reverted in a `finally`, including on a crash or a Ctrl-C.
 * If this script is ever killed hard, `git status` will show what is left.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * name     what guarantee is being removed
 * file     the source file to mutate
 * find     the exact text to replace; a stale anchor is reported, never ignored
 * replace  the broken version
 * tests    the suites that are supposed to catch it
 */
const MUTATIONS = [
  {
    name: "test gate: suites may ship telemetry",
    file: "server/observability/otelConfig.js",
    find: "  if (env.VITEST && env.WEV_OTEL_TEST_SINK !== '1') {\n    return { enabled: false, reason: 'test_environment' };\n  }",
    replace: "  if (false) {\n    return { enabled: false, reason: 'test_environment' };\n  }",
    tests: ["server/observability.config.test.js"],
  },
  {
    name: "sampling: default rate raised to 100%",
    file: "server/observability/otelConfig.js",
    find: "const DEFAULT_SAMPLE_RATIO = 0.02;",
    replace: "const DEFAULT_SAMPLE_RATIO = 1.0;",
    tests: ["server/observability.config.test.js"],
  },
  {
    name: "budget: daily ceiling raised past the free allowance",
    file: "server/observability/otelConfig.js",
    find: "const DEFAULT_DAILY_SPAN_BUDGET = 200_000;",
    replace: "const DEFAULT_DAILY_SPAN_BUDGET = 500_000_000;",
    tests: ["server/observability.config.test.js"],
  },
  {
    name: "insecure host: plain HTTP allowed in production",
    file: "server/observability/otelConfig.js",
    find: "  if (url.protocol === 'http:' && env.NODE_ENV === 'production') {\n    return { enabled: false, reason: 'insecure_host' };\n  }",
    replace: "  if (false) {\n    return { enabled: false, reason: 'insecure_host' };\n  }",
    tests: ["server/observability.config.test.js"],
  },
  {
    name: "redaction: the query string is allowlisted",
    file: "server/observability/spanAttributes.js",
    find: "  'url.scheme',\n  'network.protocol.version',",
    replace: "  'url.scheme',\n  'url.query',\n  'url.path',\n  'client.address',\n  'user_agent.original',\n  'network.protocol.version',",
    tests: ["server/observability.privacy.test.js", "server/observability.endToEnd.test.js"],
  },
  {
    name: "redaction: span EVENTS are no longer scrubbed",
    file: "server/observability/spanAttributes.js",
    find: "  const events = span?.events;\n  if (Array.isArray(events)) {",
    replace: "  const events = span?.events;\n  if (false && Array.isArray(events)) {",
    tests: ["server/observability.privacy.test.js"],
  },
  {
    name: "redaction: exception messages pass through unredacted",
    file: "server/observability/spanAttributes.js",
    find: "  if (!REDACTED_KEYS.has(key)) return value.slice(0, limit);",
    replace: "  if (true) return value.slice(0, limit);",
    tests: ["server/observability.privacy.test.js"],
  },
  {
    name: "scrubber fails OPEN instead of closed",
    file: "server/observability/spanAttributes.js",
    find: "    } catch {\n      /* A span that cannot be scrubbed is not a span that may be exported: this\n         is the one place in the telemetry path where failing CLOSED is right,\n         because the failure mode of failing open is a disclosure. */\n      return;\n    }",
    replace: "    } catch {\n      /* mutated: forward anyway */\n    }",
    tests: ["server/observability.privacy.test.js"],
  },
  {
    name: "tail sampling: errors are no longer always kept",
    file: "server/observability/tailSampler.js",
    find: "export function isInterestingRoot(span) {",
    replace: "export function isInterestingRoot(span) {\n  if (span) return false;",
    tests: ["server/observability.sampling.test.js"],
  },
  {
    name: "budget: the tail sampler stops consuming it",
    file: "server/observability/tailSampler.js",
    find: "    if (!this.budget.consume(spans.length)) {",
    replace: "    if (false && !this.budget.consume(spans.length)) {",
    tests: ["server/observability.sampling.test.js", "server/observability.integration.test.js"],
  },
  {
    name: "bounds: the trace buffer grows without limit",
    file: "server/observability/tailSampler.js",
    find: "      if (this.pending.size >= MAX_BUFFERED_TRACES) {",
    replace: "      if (false) {",
    tests: ["server/observability.sampling.test.js"],
  },
  {
    name: "bounds: spans per trace grow without limit",
    file: "server/observability/tailSampler.js",
    find: "    if (entry.spans.length >= MAX_SPANS_PER_TRACE) {",
    replace: "    if (false) {",
    tests: ["server/observability.sampling.test.js"],
  },
  {
    name: "bounds: the sweep no longer evicts rootless traces",
    file: "server/observability/tailSampler.js",
    find: "        if (entry.firstSeen >= cutoff) break;",
    replace: "        if (true) break;",
    tests: ["server/observability.sampling.test.js"],
  },
  {
    name: "bounds: the sweep timer holds the event loop open",
    file: "server/observability/tailSampler.js",
    find: "    if (typeof this.sweepTimer.unref === 'function') this.sweepTimer.unref();",
    replace: "    /* mutated: no unref */",
    tests: ["server/observability.sampling.test.js"],
  },
  {
    name: "shutdown: the hard deadline is removed",
    file: "server/observability/otel.js",
    find: "  const timedOut = Symbol('timeout');\n  const outcome = await Promise.race([\n    work.then(() => 'flushed', () => 'failed'),\n    new Promise((resolve) => {\n      const t = setTimeout(() => resolve(timedOut), deadlineMs);\n      if (typeof t.unref === 'function') t.unref();\n    }),\n  ]);",
    replace: "  const timedOut = Symbol('timeout');\n  const outcome = await work.then(() => 'flushed', () => 'failed');",
    tests: ["server/observability.integration.test.js"],
  },
  {
    name: "shutdown: a second call exports again",
    file: "server/observability/otel.js",
    find: "  state = { enabled: false, reason: 'shut_down' };",
    replace: "  /* mutated: state left in place */",
    tests: ["server/observability.integration.test.js"],
  },
  {
    name: "cardinality: the route label cap is removed",
    file: "server/observability/metrics.js",
    find: "  if (seenRoutes.size >= MAX_DISTINCT_ROUTES) return 'other';",
    replace: "  /* mutated: no cap */",
    tests: ["server/observability.metrics.test.js"],
  },
  {
    name: "cardinality: raw paths become route labels",
    file: "server/observability/metrics.js",
    find: "  if (/\\/\\d+(\\/|$)/.test(route)) return 'other';",
    replace: "  /* mutated: digits allowed */",
    tests: ["server/observability.metrics.test.js"],
  },
  {
    name: "cardinality: the exact status code becomes a label",
    file: "server/observability/metrics.js",
    find: "      'http.response.status_class': statusClass(statusCode),",
    replace: "      'http.response.status_code': statusCode,",
    tests: ["server/observability.integration.test.js"],
  },
  {
    name: "propagation: inbound traceparent is honoured",
    file: "server/observability/propagation.js",
    find: "  extract(context) {\n    return context;\n  }",
    replace: "  extract(context, carrier, getter) {\n    return this.inner.extract(context, carrier, getter);\n  }",
    tests: ["server/observability.endToEnd.test.js"],
  },
  {
    name: "correlation: log records stop carrying the trace id",
    file: "server/telemetry.js",
    find: "      ...clean(currentTraceIds()),",
    replace: "      /* mutated: no correlation */",
    tests: ["server/observability.integration.test.js"],
  },
  {
    name: "correlation: traceId is dropped from the field allowlist",
    file: "server/telemetry.js",
    find: "  traceId: 'id',\n  spanId: 'id',",
    replace: "  /* mutated: not allowlisted */",
    tests: ["server/observability.integration.test.js"],
  },
  {
    name: "ESM: the in-process loader hook is removed",
    file: "server/observability/otel.js",
    find: "    register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);",
    replace: "    /* mutated: no hook */",
    tests: ["server/observability.production.test.js"],
  },
  {
    name: "express: middleware spans are re-enabled",
    file: "server/observability/otel.js",
    find: "      ignoreLayersType: [ExpressLayerType.MIDDLEWARE],",
    replace: "      /* mutated: middleware spans on */",
    tests: ["server/observability.production.test.js"],
  },
  {
    name: "correlation: currentTraceIds stops reporting the active span",
    file: "server/observability/correlation.js",
    find: "    const span = trace.getSpan(context.active());\n    if (!span) return {};",
    replace: "    const span = trace.getSpan(context.active());\n    if (span) return {};",
    tests: ["server/observability.production.test.js", "server/observability.integration.test.js"],
  },
  {
    name: "secrets: the token is put in the exported payload",
    file: "server/observability/otel.js",
    find: "    'wev.engine': (env.DATABASE_ENGINE || 'sqlite').toLowerCase(),",
    replace: "    'wev.engine': (env.DATABASE_ENGINE || 'sqlite').toLowerCase(),\n    'service.name': env.BETTERSTACK_SOURCE_TOKEN,",
    tests: ["server/observability.integration.test.js"],
  },
  {
    name: "exporter: gzip and protobuf swapped for defaults",
    file: "server/observability/otel.js",
    find: "    compression: 'gzip',\n    timeoutMillis: EXPORT_TIMEOUT_MS,\n    /* The SDK's own bound on simultaneous in-flight exports.",
    replace: "    compression: 'none',\n    timeoutMillis: EXPORT_TIMEOUT_MS,\n    /* The SDK's own bound on simultaneous in-flight exports.",
    tests: ["server/observability.integration.test.js"],
  },
  {
    name: "config path: resolveOtelConfig stops defaulting to process.env",
    file: "server/observability/otelConfig.js",
    find: "export function resolveOtelConfig(env = process.env) {",
    replace: "export function resolveOtelConfig(env = {}) {",
    tests: ["server/observability.config.test.js"],
  },
  {
    name: "config path: startOtel stops defaulting to process.env",
    file: "server/observability/otel.js",
    find: "export function startOtel(env = process.env) {",
    replace: "export function startOtel(env = {}) {",
    tests: ["server/observability.production.test.js"],
  },
  {
    name: "endpoints: the OTLP traces path is wrong",
    file: "server/observability/otelConfig.js",
    find: "    tracesUrl: new URL('/v1/traces', base).toString(),",
    replace: "    tracesUrl: new URL('/v1/trace', base).toString(),",
    tests: ["server/observability.config.test.js"],
  },
];

const filter = process.argv[2];
const selected = filter ? MUTATIONS.filter(m => m.name.includes(filter)) : MUTATIONS;

if (selected.length === 0) {
  console.error(`No mutation matches ${JSON.stringify(filter)}.`);
  process.exit(1);
}

const survived = [];
const stale = [];
let caught = 0;

for (const mutation of selected) {
  const file = path.join(ROOT, mutation.file);
  const original = readFileSync(file, 'utf8');

  if (!original.includes(mutation.find)) {
    /* The code moved and the mutation no longer describes it. Reported rather
       than skipped quietly: a stale mutation is a guarantee nobody is checking
       any more, which is the same failure as one that survives. */
    stale.push(mutation.name);
    console.log(`[STALE   ] ${mutation.name}`);
    continue;
  }

  try {
    writeFileSync(file, original.replace(mutation.find, mutation.replace));
    const result = spawnSync('npx', ['vitest', 'run', '--project', 'server', ...mutation.tests], {
      cwd: ROOT, encoding: 'utf8', stdio: 'pipe',
    });
    if (result.status !== 0) {
      caught++;
      console.log(`[CAUGHT  ] ${mutation.name}`);
    } else {
      survived.push(mutation.name);
      console.log(`[SURVIVED] ${mutation.name}   <-- the tests did not notice`);
    }
  } finally {
    writeFileSync(file, original);
  }
}

console.log(`\ncaught ${caught}/${selected.length}`);
for (const name of survived) console.log(`  SURVIVED: ${name}`);
for (const name of stale) console.log(`  STALE:    ${name}`);

process.exit(survived.length || stale.length ? 1 : 0);
