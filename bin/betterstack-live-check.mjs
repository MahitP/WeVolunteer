#!/usr/bin/env node
/**
 * Does the configured Better Stack source actually accept our telemetry?
 *
 * ── Why this exists ──
 *
 * Every other check in this repository runs against a loopback stub. A stub
 * proves the pipeline is correct; it cannot prove that the credential is valid,
 * that the ingesting host resolves, that Better Stack accepts OTLP/protobuf at
 * the paths we post to, or that the source is configured for the platform we
 * think it is. Those are four separate ways for a perfectly correct integration
 * to send into a void, and none of them are visible from inside the application:
 * the exporter swallows delivery failures ON PURPOSE, because a telemetry fault
 * must never become a user's fault.
 *
 * So the one thing an operator needs after rotating a token — "is it working?" —
 * is exactly the thing the design makes invisible. This script asks directly,
 * and reports what Better Stack said.
 *
 * ── What it does NOT do ──
 *
 * It does not read anything back out of Better Stack. Confirming that a record
 * is queryable in the dashboard needs a Better Stack API token, which is a
 * different credential from the source token and is not required to run the
 * application. This reports acceptance at the ingest boundary; seeing the data
 * in the dashboard is the operator's half.
 *
 * ── Secrecy ──
 *
 * The token is read from the environment and never printed, never logged, and
 * never included in any output. Only its presence and length class are
 * reported.
 *
 * Usage, from the repository root:
 *
 *     node --env-file-if-exists=.env bin/betterstack-live-check.mjs
 */
import { diag, DiagLogLevel } from '@opentelemetry/api';

const HR = '─'.repeat(72);

function section(title) {
  console.log(`\n${HR}\n${title}\n${HR}`);
}

/* ── 1. Configuration, without disclosing it ─────────────────────────────── */

section('1. Configuration');

const token = String(process.env.BETTERSTACK_SOURCE_TOKEN || '').trim();
const host = String(process.env.BETTERSTACK_INGESTING_HOST || '').trim();

if (!token) {
  console.error(
    'BETTERSTACK_SOURCE_TOKEN is empty.\n\n'
    + 'Paste the newly rotated source token into .env and run this again.\n'
    + 'Better Stack -> Sources -> WeVolunteer -> Source token.',
  );
  process.exit(2);
}
if (!host) {
  console.error('BETTERSTACK_INGESTING_HOST is empty. Expected the ingesting host for the source.');
  process.exit(2);
}

/* Shape only. A Better Stack source token is a short base62 string; anything
   wildly outside that is usually a paste accident — a whole curl command, a
   quoted value, or the API token by mistake. */
const shape = /^[A-Za-z0-9]+$/.test(token) ? 'base62' : 'contains non-alphanumeric characters';
console.log(`token   : present, ${token.length} characters, ${shape}`);
console.log(`host    : ${host}`);
console.log(`otel    : ${process.env.WEV_OTEL_ENABLED === 'false' ? 'disabled by WEV_OTEL_ENABLED' : 'enabled'}`);

if (token.length < 8 || token.length > 64) {
  console.warn('WARNING: that length is unusual for a source token. Check for a paste accident.');
}
if (shape !== 'base62') {
  console.warn('WARNING: a source token is normally alphanumeric. Check for surrounding quotes or whitespace.');
}

/* ── 2. Logs: the HTTP ingestion API ─────────────────────────────────────── */

section('2. Logs  ->  Better Stack HTTP ingestion');

const base = host.includes('://') ? host : `https://${host}`;
const nonce = `live-check-${Date.now().toString(36)}`;

let logsOk = false;
try {
  const res = await fetch(new URL('/', base).toString(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    /* Deliberately dull and non-sensitive: a marker an operator can search for,
       and nothing else. The `nonce` is what makes it findable in the dashboard. */
    body: JSON.stringify([{
      dt: new Date().toISOString(),
      level: 'info',
      event: 'lifecycle.live_check',
      message: 'WeVolunteer Better Stack connectivity check',
      service: process.env.TELEMETRY_SERVICE_NAME || 'wevolunteer',
      environment: process.env.NODE_ENV || 'development',
      nonce,
    }]),
    signal: AbortSignal.timeout(15_000),
  });
  logsOk = res.ok;
  console.log(`POST /            -> HTTP ${res.status} ${res.statusText}`);
  if (res.status === 401 || res.status === 403) {
    console.error('\nThe source token was REJECTED. It is wrong, revoked, or belongs to another source.');
  }
} catch (err) {
  console.error(`POST /            -> FAILED (${err?.name || 'error'}: ${err?.message || 'unknown'})`);
}
console.log(`search nonce      : ${nonce}`);

/* ── 3. Traces and metrics: OTLP through the real exporters ──────────────── */

section('3. Traces + metrics  ->  OTLP through the application exporters');

/**
 * The SDK is the thing under test, so the SDK is what sends.
 *
 * `diag` is turned all the way up first, because the exporters report delivery
 * through it and through nothing else — that is the same swallowing behaviour
 * this script exists to see past. Every diag line is captured rather than
 * printed, so a verbose SDK cannot bury the summary.
 */
const diagLines = [];
diag.setLogger({
  verbose: (...a) => diagLines.push(['verbose', a.join(' ')]),
  debug: (...a) => diagLines.push(['debug', a.join(' ')]),
  info: (...a) => diagLines.push(['info', a.join(' ')]),
  warn: (...a) => diagLines.push(['warn', a.join(' ')]),
  error: (...a) => diagLines.push(['error', a.join(' ')]),
}, DiagLogLevel.ALL);

const { startOtel, shutdownOtel, otelStatus, otelSnapshot } = await import('../server/observability/otel.js');
const { withSpan } = await import('../server/observability/spans.js');
const { recordHttpRequest } = await import('../server/observability/metrics.js');

/* No argument: the same call bootstrap.js makes, reading process.env. */
const status = startOtel();
console.log(`SDK               : ${status.enabled ? 'started' : `NOT started (${status.reason})`}`);

if (!status.enabled) {
  console.error('\nThe SDK refused to start, so nothing was sent. The reason above says why.');
  process.exit(1);
}

/**
 * One span that is guaranteed to survive sampling.
 *
 * The sample rate is 2% and is NOT raised here — a connectivity check that
 * needed the cost control turned off would be checking a configuration nobody
 * runs. Instead this uses the pipeline's own always-keep rule: a span that
 * records an exception is kept regardless of the rate. Same for a request slower
 * than a second, which is why the metric below is recorded with a large
 * duration.
 */
try {
  withSpan('event.create', { component: 'live-check', reason: nonce }, () => {
    throw new Error(`WeVolunteer Better Stack connectivity check ${nonce}`);
  });
} catch { /* thrown on purpose: it is what makes the trace unconditionally kept */ }

recordHttpRequest({ method: 'GET', route: '/api/live-check', statusCode: 200, durationMs: 1234 });

/* Shutdown is the flush: it forces a final export of both signals and is the
   same path a deploy takes. */
const snapshot = otelSnapshot();
const flush = await shutdownOtel();

console.log(`spans exported    : ${snapshot?.spansExported ?? 0}`);
console.log(`flush             : ${flush.flushed ? 'completed' : `did not complete (${flush.reason})`}`);

/* ── 4. What Better Stack said ───────────────────────────────────────────── */

section('4. Exporter outcome (from the SDK\'s own diagnostics)');

const failures = diagLines.filter(([level, text]) =>
  (level === 'error' || level === 'warn' || level === 'info')
  && /fail|error|retry|refused|timeout|4\d\d|5\d\d/i.test(text));

if (failures.length === 0) {
  console.log('No export failure was reported.');
} else {
  console.log('Export problems reported:');
  for (const [level, text] of failures.slice(0, 12)) console.log(`  [${level}] ${text}`);
}

const succeeded = diagLines.filter(([, t]) => /export succeeded|Export succeeded/i.test(t));
if (succeeded.length) console.log(`Successful exports reported: ${succeeded.length}`);

/* ── 5. Verdict ──────────────────────────────────────────────────────────── */

section('5. Verdict');

const otlpOk = failures.length === 0 && flush.flushed;

console.log(`logs   (HTTP ingestion) : ${logsOk ? 'ACCEPTED' : 'NOT ACCEPTED'}`);
console.log(`traces (OTLP /v1/traces) : ${otlpOk ? 'no failure reported' : 'PROBLEM — see above'}`);
console.log(`metrics(OTLP /v1/metrics): ${otlpOk ? 'no failure reported' : 'PROBLEM — see above'}`);
console.log(
  `\nNow confirm in the Better Stack dashboard. Search for:  ${nonce}`
  + '\nAcceptance at the ingest boundary is what this script can prove;'
  + '\nthat the records are queryable is the half only the dashboard shows.',
);

process.exit(logsOk && otlpOk ? 0 : 1);
