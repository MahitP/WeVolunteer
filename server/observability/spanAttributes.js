/**
 * The allowlist for everything a span may carry off this machine.
 *
 * ── Why this file exists at all ──
 *
 * Automatic instrumentation is the reason. It is the feature — `http` and
 * `express` are patched and spans appear with no code written — and it is also
 * the hazard, because what those spans contain was decided by the semantic
 * conventions, not by this application's privacy review.
 *
 * Measured, on this repository's own dependencies, against a request to
 * `/api/events/42?email=…&q=123+Maple+St`, `@opentelemetry/instrumentation-http`
 * records by default:
 *
 *   url.query             the query string, verbatim — the email address, the
 *                         street address and anything else a search box put there
 *   url.path              the real path, ids and slugs included
 *   client.address        the client's IP address
 *   network.peer.address  the same again
 *   user_agent.original   the client's User-Agent
 *
 * Every one of those is something the existing log pipeline deliberately refuses
 * to send. `telemetry.js` records the Express PATTERN rather than the URL, and
 * says why: "a real URL carries search terms, addresses and email addresses, and
 * an IP address is personal data that redaction does not cover." That decision
 * was reviewed against a population that is mostly minors. Adding a second wire
 * to the same vendor does not reopen it.
 *
 * So spans are held to the SAME bar as `error_events` and the log records: an
 * allowlist, failing closed, applied to every span before it can be exported.
 *
 * ── Why an allowlist and not "delete the five bad ones" ──
 *
 * The five above are what these package versions emit today. Semantic
 * conventions change, instrumentations add attributes in minor releases, and a
 * dependency bump is not a privacy review. A denylist would ship the next new
 * attribute by default and nobody would find out. This fails the other way: a
 * genuinely useful new attribute is invisible until somebody adds it here, which
 * is a bug report rather than a disclosure.
 */
import { redactMessage } from '../errorReporter.js';

/** Strings are truncated to this. `exception.stacktrace` gets the larger cap. */
const MAX_ATTR_STRING = 500;
const MAX_STACK = 4000;

/**
 * Span attribute keys that may leave the process.
 *
 * Grouped by who sets them, because the question "is this safe" has a different
 * answer for a value the semantic conventions chose and one this codebase wrote.
 */
export const ALLOWED_SPAN_ATTRIBUTES = new Set([
  /* HTTP — the pattern, the verb and the outcome. Not the URL, not the peer. */
  'http.request.method',
  'http.response.status_code',
  'http.route',
  'url.scheme',
  'network.protocol.version',

  /* Express. Both values are function or route names declared in this
     repository's own source, so neither can carry a user's data. */
  'express.name',
  'express.type',

  /* PostgreSQL. `db.query.text` is the PARAMETERISED statement — `pg`
     instrumentation only inlines parameter values when
     `enhancedDatabaseReporting` is on, and `otel.js` sets it off explicitly so
     that turning it on has to be a deliberate edit rather than a default. It is
     redacted and truncated anyway, on the same principle the log sink applies to
     strings that are "already clean". */
  'db.system.name',
  'db.system',
  'db.namespace',
  'db.operation.name',
  'db.collection.name',
  'db.query.text',
  'db.statement',

  /* This application's own, set through `spans.js`, which validates them at the
     point of creation as well. Listed individually rather than by `wev.` prefix:
     a prefix rule is a denylist wearing an allowlist's clothes, and the next
     person to add `wev.userEmail` would sail through it. */
  'wev.operation',
  'wev.component',
  'wev.outcome',
  'wev.reason',
  'wev.role',
  'wev.engine',
  'wev.count',
  'wev.request_id',
  'wev.welly.operation',
  'wev.welly.provider',
  'wev.welly.mode',
]);

/**
 * Event attribute keys that may leave the process.
 *
 * Span EVENTS are a second channel and are easy to forget: `span.recordException`
 * writes the error's message and its stack trace into one, and neither has been
 * near the allowlist above. They get the same treatment the log sink gives the
 * same two values — `redactMessage`, then a cap.
 */
export const ALLOWED_EVENT_ATTRIBUTES = new Set([
  'exception.type',
  'exception.message',
  'exception.stacktrace',
  'exception.escaped',
]);

/** Keys whose string values are redacted rather than passed through. */
const REDACTED_KEYS = new Set([
  'exception.message', 'exception.stacktrace', 'db.query.text', 'db.statement',
  'wev.reason', 'wev.outcome', 'wev.operation', 'wev.component',
]);

function cleanValue(key, value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;   // arrays and objects are refused outright

  const limit = key === 'exception.stacktrace' ? MAX_STACK : MAX_ATTR_STRING;
  if (!REDACTED_KEYS.has(key)) return value.slice(0, limit);

  const redacted = redactMessage(value);
  return redacted ? redacted.slice(0, limit) : undefined;
}

/**
 * Rewrites one span's attributes and events in place, keeping only what is allowed.
 *
 * In place, and on the live object, because that is the only place the removal
 * can be made to stick: `ReadableSpan.attributes` is the same object the
 * exporter will serialise, and a copy would leave the original to be exported by
 * anything else holding the span. Mutating a `readonly` field is deliberate and
 * is why this is one function in one file rather than a habit spread around.
 *
 * Returns a small report so a test can assert on what was removed without
 * re-deriving the allowlist.
 */
export function scrubSpan(span) {
  const removed = [];

  const attrs = span?.attributes;
  if (attrs && typeof attrs === 'object') {
    for (const key of Object.keys(attrs)) {
      if (!ALLOWED_SPAN_ATTRIBUTES.has(key)) {
        delete attrs[key];
        removed.push(key);
        continue;
      }
      const cleaned = cleanValue(key, attrs[key]);
      if (cleaned === undefined) { delete attrs[key]; removed.push(key); }
      else attrs[key] = cleaned;
    }
  }

  const events = span?.events;
  if (Array.isArray(events)) {
    for (const event of events) {
      const eventAttrs = event?.attributes;
      if (!eventAttrs || typeof eventAttrs !== 'object') continue;
      for (const key of Object.keys(eventAttrs)) {
        if (!ALLOWED_EVENT_ATTRIBUTES.has(key)) {
          delete eventAttrs[key];
          removed.push(`event:${key}`);
          continue;
        }
        const cleaned = cleanValue(key, eventAttrs[key]);
        if (cleaned === undefined) { delete eventAttrs[key]; removed.push(`event:${key}`); }
        else eventAttrs[key] = cleaned;
      }
    }
  }

  return { removed };
}

/**
 * A SpanProcessor that scrubs, then forwards.
 *
 * Placed FIRST in the chain, ahead of the tail sampler and the batch processor,
 * so that nothing downstream — including the buffer the tail sampler holds for
 * up to a minute — ever contains an attribute this application would not send.
 * Scrubbing at export time instead would leave the unredacted values sitting in
 * memory in the meantime, which is the wrong place for a heap dump to find them.
 */
export class ScrubbingSpanProcessor {
  constructor(downstream) {
    this.downstream = downstream;
    this.removedCount = 0;
  }

  onStart() { /* attributes are not final until the span ends */ }

  onEnd(span) {
    try {
      this.removedCount += scrubSpan(span).removed.length;
    } catch {
      /* A span that cannot be scrubbed is not a span that may be exported: this
         is the one place in the telemetry path where failing CLOSED is right,
         because the failure mode of failing open is a disclosure. */
      return;
    }
    try { this.downstream.onEnd(span); } catch { /* downstream counts its own */ }
  }

  /**
   * Both are `async` rather than one-line returns, and that is not decoration.
   *
   * `asyncShapes.test.js` reads a bare `shutdown(` at the start of a line as a
   * call that was started and abandoned — the shape that, elsewhere in this
   * codebase, leaves a `BEGIN` open on a second connection. A one-line method
   * DECLARATION has exactly that shape. Marking them `async` says what they are,
   * to that guard and to a reader, without weakening the guard for everybody
   * else.
   */
  async forceFlush() { return this.downstream.forceFlush(); }

  async shutdown() { return this.downstream.shutdown(); }
}
