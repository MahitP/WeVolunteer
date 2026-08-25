/**
 * Structured telemetry: the one place that decides what may leave this
 * application, and the only caller of the Better Stack wire.
 *
 * ── The rule this module exists to enforce ──
 *
 *   **Better Stack may hold exactly what `error_events` may hold, and nothing
 *   more.**
 *
 * That bar is not invented here. ENGINEERING_GUIDE §6.10 sets it for the error
 * table, which is the one store in this system deliberately fed by "the code
 * paths most likely to be holding somebody's data at the moment they broke", on
 * a population that is mostly minors. Four decisions carry the property there:
 * redaction happens before storage, the user is a hash, the route is a pattern,
 * and there is no request-body column. Reusing that bar means the privacy
 * question for telemetry has already been reviewed twice, by people probing it
 * with realistic PII — rather than being answered again, differently, here.
 *
 * `telemetry.betterstack.test.js` asserts the rule as a property: every field
 * this module can emit is one `error_events` could store.
 *
 * ── Why this is not the same call as `alerting.js` made ──
 *
 * That module carries "no error message, no stack trace, no route, no user
 * hash", and says why: an alert lands in a mailbox this application does not
 * control and WILL be forwarded, and §6.10 is explicit that redaction does not
 * cover names, addresses, IP addresses or dates of birth.
 *
 * Better Stack is a different kind of destination. It is the operator's own
 * access-controlled account under a processing agreement, in the same category
 * as the database host and the mail provider — not a distribution list. So it
 * gets the database's bar rather than the mailbox's. The distinction is the
 * whole reason the two modules do different things, and it is the one an
 * operator should re-examine if the account is ever shared more widely.
 *
 * ── Why there is no `log.info(...)` sprinkled through the codebase ──
 *
 * There are nearly 400 `console.*` calls in `server/`, written over a year by
 * people who were not thinking about a telemetry boundary. Routing those to a vendor
 * would ship whatever any of them happens to interpolate. So none of them
 * changed: they keep going to the journal, which is local, and Better Stack is
 * fed from a small number of CHOKE POINTS that already carry structured,
 * redacted data:
 *
 *   `recordError`      every server, worker and client error   (already redacted)
 *   the access log     method, route pattern, status, duration
 *   lifecycle          boot, shutdown, migrations
 *   security           audit action names, never their details
 *
 * Adding a new source means adding it here, where the allowlist is.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

import { redactMessage } from './errorReporter.js';
import { enqueue, telemetryEnabled, telemetryStatus, flushTelemetry, drainTelemetry } from './telemetrySink.js';

export { telemetryEnabled, telemetryStatus, flushTelemetry, drainTelemetry };

/**
 * Every field that may appear on a telemetry record, and its type.
 *
 * An ALLOWLIST, for the reason §6.10 gives for `CONTEXT_KEYS`: "a denylist fails
 * on the first thing nobody thought of; an allowlist fails closed." A caller
 * that passes `email`, `body`, `token` or `password` does not get a warning —
 * the key is simply not copied, and cannot be, whatever the caller believed.
 *
 *   'string'  redacted through `redactMessage`, then truncated
 *   'number'  finite numbers only
 *   'bool'    booleans only
 *   'id'      an opaque identifier this system generated — UUIDs, hashes,
 *             fingerprints. Bounded and pattern-checked, never redacted,
 *             because redaction would eat a hex run that is the whole point.
 */
const FIELDS = Object.freeze({
  /* What happened */
  event: 'string',
  level: 'string',
  message: 'string',
  source: 'string',
  kind: 'string',

  /* Where */
  route: 'string',
  method: 'string',
  statusCode: 'number',
  operation: 'string',
  component: 'string',

  /* How long */
  durationMs: 'number',

  /* Correlation — opaque by construction */
  requestId: 'id',
  fingerprint: 'id',
  userHash: 'id',

  /* Who, in the only terms this system logs anybody */
  role: 'string',

  /* Deployment */
  service: 'string',
  environment: 'string',
  release: 'string',
  engine: 'string',
  instance: 'id',

  /* Diagnostics that survived redaction */
  stack: 'string',
  errorType: 'string',
  outcome: 'string',
  reason: 'string',
  count: 'number',
  migrationVersion: 'number',
  ok: 'bool',
});

/** Per-field ceilings. `stack` is the only one that needs room. */
const MAX_STRING = 500;
const MAX_STACK = 4000;

/**
 * The longest identifier this system actually produces.
 *
 * A `fingerprint` is a sha256 in hex (64), a `userHash` is half of one (32), a
 * `requestId` is a UUID (36), an `instance` is ten characters. Sixty-four is the
 * real ceiling, and the limit is set there rather than at a comfortable round
 * number because of what happens to a value that exceeds it — see below.
 */
const MAX_ID = 64;

/**
 * An id must look like one. Anything else is dropped rather than redacted.
 *
 * ── Why an over-long id is REJECTED and not truncated ──
 *
 * The other string fields are truncated, which is right for them: half an error
 * message is still a useful error message. An id is the opposite — a truncated
 * one matches nothing, correlates with nothing, and answers no question. So
 * truncation cannot preserve any of an id's value, and it CAN preserve harm:
 * this character class permits base64url and dots, which means a JSON Web Token
 * passes it, and truncating one to 128 characters leaves its header and most of
 * its payload — the claims, in readable base64 — sitting in a field this module
 * has promised not to redact.
 *
 * No caller does that today. `requestId` is generated per request and the
 * inbound header is deliberately ignored; the hashes are digests. This is for
 * the caller nobody has written yet, which is the whole premise of an allowlist.
 */
const ID_SHAPE = new RegExp(`^[A-Za-z0-9_.:-]{1,${MAX_ID}}$`);

/**
 * Three base64url segments separated by dots: a JWT, or near enough.
 *
 * Refused explicitly rather than left to the length limit, because a short token
 * — an unsigned one, or a compact session token — would fit inside 64 characters
 * and pass. A credential is not an identifier however short it is.
 */
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

/**
 * Fields attached to every record, resolved once.
 *
 * `release` is the deployed version, which is what makes "did this start at
 * 1.2.0?" answerable in Better Stack. `instance` distinguishes two processes of
 * the same release; it is a random id per boot, NOT a hostname — a hostname in a
 * school district can name a building.
 */
let base = null;
function baseFields() {
  if (base) return base;
  base = clean({
    service: process.env.TELEMETRY_SERVICE_NAME || 'wevolunteer',
    environment: process.env.NODE_ENV || 'development',
    release: process.env.APP_RELEASE || readVersion(),
    engine: (process.env.DATABASE_ENGINE || 'sqlite').toLowerCase(),
    instance: instanceId(),
  });
  return base;
}

/**
 * The deployed version, from the same manifest `/health` reports.
 *
 * `APP_RELEASE` overrides it, so a deployment that builds from a commit can put
 * a SHA here and have Better Stack group by the thing that actually shipped.
 *
 * Read lazily and defensively: a missing or unreadable manifest must not stop a
 * boot, and this module is imported by the error path.
 */
function readVersion() {
  try {
    return JSON.parse(
      readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8'),
    ).version || null;
  } catch { return null; }
}

let instance = null;
function instanceId() {
  if (instance) return instance;
  try {
    instance = `i-${crypto.randomUUID().slice(0, 8)}`;
  } catch { instance = 'i-unknown'; }
  return instance;
}

/**
 * Copies the allowed fields, applying the rule for each type.
 *
 * Unknown keys are dropped in silence. Values of the wrong type are dropped
 * rather than coerced — `statusCode: '500 Internal Server Error'` is not a
 * status code, and storing it as one makes a dashboard lie.
 */
function clean(fields) {
  const out = {};
  if (!fields || typeof fields !== 'object') return out;

  for (const [key, kind] of Object.entries(FIELDS)) {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
    const value = fields[key];
    if (value === null || value === undefined) continue;

    if (kind === 'number') {
      if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    } else if (kind === 'bool') {
      if (typeof value === 'boolean') out[key] = value;
    } else if (kind === 'id') {
      if (typeof value !== 'string') continue;
      if (!ID_SHAPE.test(value)) continue;   // wrong shape, or longer than any real id
      if (JWT_SHAPE.test(value)) continue;   // a credential wearing an id's shape
      out[key] = value;
    } else if (kind === 'string') {
      if (typeof value !== 'string') continue;
      const limit = key === 'stack' ? MAX_STACK : MAX_STRING;
      /* Redacted even though most callers pass values that are already clean.
         The cost is a regex pass; the benefit is that this holds for the caller
         nobody has written yet. */
      const redacted = redactMessage(value);
      if (redacted) out[key] = redacted.slice(0, limit);
    }
  }
  return out;
}

/** Levels Better Stack understands, and the only ones emitted. */
const LEVELS = new Set(['debug', 'info', 'warn', 'error']);

/**
 * Emits one structured record.
 *
 * Never throws — it is called from the error handler, from `recordError`, and
 * from the shutdown path, and a telemetry failure in any of those is exactly the
 * failure this whole module is arranged to prevent. Returns the record it built
 * (or `null`) so tests can assert on the payload without a network.
 *
 * @param {'debug'|'info'|'warn'|'error'} level
 * @param {string} event  a stable, greppable name — `http.request`, `error.recorded`
 * @param {object} [fields]  keys from FIELDS; everything else is dropped
 */
export function logEvent(level, event, fields = {}) {
  try {
    const record = {
      dt: new Date().toISOString(),
      ...baseFields(),
      ...clean(fields),
      level: LEVELS.has(level) ? level : 'info',
      event: typeof event === 'string' ? event.slice(0, 100) : 'unknown',
    };
    enqueue(record);
    return record;
  } catch {
    return null;
  }
}

/**
 * The access log: one record per HTTP response.
 *
 * ── What is NOT here ──
 *
 * No URL, no query string, no headers, no cookies, no request body, no response
 * body, no IP address. `route` is the Express PATTERN (`/api/events/:id`) for
 * the same reason §6.10 gives for the error table: a real URL carries search
 * terms, addresses and email addresses, and an IP address is personal data that
 * redaction does not cover.
 *
 * ── Sampling ──
 *
 * Every 4xx and 5xx, and every slow request, always. Successful requests are
 * sampled, because a school district at morning registration produces thousands
 * of identical 200s that answer no question — and the ones that do (how slow,
 * how many) survive sampling fine.
 */
const SLOW_REQUEST_MS = 1000;
const SUCCESS_SAMPLE_RATE = Number(process.env.TELEMETRY_SAMPLE_RATE ?? 0.05);

export function shouldLogRequest(statusCode, durationMs, random = Math.random()) {
  if (!Number.isFinite(statusCode)) return true;
  if (statusCode >= 400) return true;
  if (durationMs >= SLOW_REQUEST_MS) return true;
  return random < SUCCESS_SAMPLE_RATE;
}

export function logHttpRequest({ method, route, statusCode, durationMs, requestId, role, userHash }) {
  if (!telemetryEnabled()) return null;
  if (!shouldLogRequest(statusCode, durationMs)) return null;

  const level = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info';
  return logEvent(level, 'http.request', {
    method, route, statusCode, durationMs, requestId, role, userHash,
    /* Named so a dashboard can group refusals without parsing status codes. */
    outcome: statusCode >= 500 ? 'server_error'
      : statusCode === 401 ? 'unauthenticated'
        : statusCode === 403 ? 'forbidden'
          : statusCode === 429 ? 'rate_limited'
            : statusCode >= 400 ? 'client_error' : 'ok',
  });
}

/**
 * A lifecycle event — boot, shutdown, a migration, a worker starting.
 *
 * Deliberately narrow: these are the events that explain a gap in the other
 * logs, and an operator reading Better Stack at 2am wants to know the process
 * restarted before they wonder where the requests went.
 */
export function logLifecycle(event, fields = {}) {
  return logEvent(fields.level === 'error' ? 'error' : 'info', `lifecycle.${event}`, fields);
}

/**
 * A security-relevant action that succeeded.
 *
 * The ACTION NAME only — `ACCOUNT_SUSPENDED`, `EVENT_HOURS_CLOSED_OUT` — never
 * the audit row's `details`, which is prose written at ~30 call sites and names
 * people by construction ("Suspended Chris Vale"). The audit trail itself is the
 * record; this is the pulse, so somebody can see that privileged actions are
 * happening at all without opening it.
 */
export function logSecurityEvent(action, { requestId, role, userHash, outcome } = {}) {
  if (!telemetryEnabled()) return null;
  return logEvent('info', 'security.action', {
    operation: typeof action === 'string' ? action.slice(0, 100) : 'unknown',
    requestId, role, userHash, outcome,
  });
}
