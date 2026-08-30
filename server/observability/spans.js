/**
 * Manual spans, for the operations automatic instrumentation cannot name.
 *
 * ── Why manual spans exist alongside auto-instrumentation ──
 *
 * `instrumentation-express` produces a span per middleware layer, named after
 * the function — `middleware - jsonParser`, `middleware - <anonymous>`. That
 * answers "which layer was slow" and not "what was the application doing", and
 * on this codebase the interesting operations are not layers at all: Auto
 * Select's weighting pass, the Equalizer, an attendance finalisation, a Welly
 * answer. Each is one call inside one handler, and each is a thing an operator
 * would go looking for by name.
 *
 * So middleware spans are switched OFF in `otel.js` — they are the bulk of the
 * span count and the least of the signal — and the operations worth naming get
 * named here, deliberately, a dozen of them rather than a hundred.
 *
 * ── The rule for attributes ──
 *
 * A span attribute is not a log field: it is not covered by `telemetry.js`'s
 * allowlist, and `recordException` will happily serialise an error's message and
 * stack. So this helper does not accept arbitrary attributes. It accepts the
 * `wev.*` keys `spanAttributes.js` allows, and everything else is dropped before
 * the span ever exists — which is one layer earlier than the scrubbing
 * processor, and belt to its braces.
 */
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { ALLOWED_SPAN_ATTRIBUTES } from './spanAttributes.js';
import { recordBusinessOperation } from './metrics.js';

const TRACER_NAME = 'wevolunteer';

/** Keys a caller may set. A subset of the allowlist, and checked against it. */
function safeAttributes(attributes) {
  const out = {};
  if (!attributes || typeof attributes !== 'object') return out;
  for (const [key, value] of Object.entries(attributes)) {
    const namespaced = key.startsWith('wev.') ? key : `wev.${key}`;
    if (!ALLOWED_SPAN_ATTRIBUTES.has(namespaced)) continue;
    if (typeof value === 'string') out[namespaced] = value.slice(0, 200);
    else if (typeof value === 'number' && Number.isFinite(value)) out[namespaced] = value;
    else if (typeof value === 'boolean') out[namespaced] = value;
  }
  return out;
}

/**
 * Runs `fn` inside a span named for a business operation.
 *
 * Works whether or not telemetry is configured: with no SDK registered,
 * `trace.getTracer` returns the API's no-op tracer, so this is a function call
 * and a `try/finally` around work that would have happened anyway. That is the
 * property that lets call sites be unconditional.
 *
 * The operation is ALSO counted as a metric, because a counter covers the whole
 * population and the span covers 2% of it — and "how many event signups failed
 * today" should not be answered from a sample.
 *
 * @param {string} operation  one of `metrics.js`'s BUSINESS_OPERATIONS
 * @param {object} attributes `wev.*` attributes; anything else is dropped
 * @param {() => any} fn
 */
export function withSpan(operation, attributes, fn) {
  let tracer;
  try {
    tracer = trace.getTracer(TRACER_NAME);
  } catch {
    /* No tracer is not a reason not to do the work. */
    return fn();
  }

  return tracer.startActiveSpan(operation, { attributes: safeAttributes({ ...attributes, operation }) }, (span) => {
    let settled = false;
    /* Declared once and reused by both exits so that an operation cannot be
       counted twice — the sync path and the promise path are mutually exclusive
       but the code that ends them is not obviously so. */
    const finish = (outcome, err) => {
      if (settled) return;
      settled = true;
      try {
        if (err) {
          span.setStatus({ code: SpanStatusCode.ERROR });
          /* The message and stack are recorded, and are redacted by
             `ScrubbingSpanProcessor` before they can leave. Recording them raw
             here and redacting at the boundary is the same order `recordError`
             uses, and keeps the redaction in one reviewable place. */
          span.recordException(err);
        }
        span.setAttribute('wev.outcome', outcome);
      } catch { /* a span that will not be annotated is still a span */ }
      try { span.end(); } catch { /* already ended */ }
      recordBusinessOperation(operation, outcome);
    };

    let result;
    try {
      result = fn();
    } catch (err) {
      finish('error', err);
      throw err;
    }

    if (result && typeof result.then === 'function') {
      return result.then(
        (value) => { finish('ok'); return value; },
        (err) => { finish('error', err); throw err; },
      );
    }

    finish('ok');
    return result;
  });
}

/* The log/trace join lives in `correlation.js`, which imports the OpenTelemetry
   API and nothing else so that `telemetry.js` can use it from the error path
   without pulling this module's dependencies along. Re-exported here because
   this is where a caller looks for it. */
export { currentTraceIds } from './correlation.js';
