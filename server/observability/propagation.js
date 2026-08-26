/**
 * Trace context goes out. It does not come in.
 *
 * ── The decision this mirrors ──
 *
 * `app.js` already refuses an inbound `X-Request-Id`, and says why: "It is
 * client-supplied, unauthenticated and would let anyone poison a shared field or
 * collide with somebody else's trace." A W3C `traceparent` header is the same
 * value with a standard spelling, and accepting it would reopen exactly the hole
 * that decision closed — from a different header, by default, because the
 * default propagator extracts it.
 *
 * ── What accepting it would actually cost here ──
 *
 * Two things, and the second is the one that matters for a free plan:
 *
 *   · **Trace collision.** `traceparent` carries the trace id. A client that
 *     sends a fixed one puts every request it makes — and every request anyone
 *     else makes with the same id — into one trace, which is both a broken
 *     waterfall and a way to attach one's own requests to somebody else's.
 *
 *   · **Telemetry amplification.** `traceparent` also carries the SAMPLED FLAG,
 *     and the conventional `ParentBasedSampler` honours it. A client sending
 *     `traceparent: 00-<random>-<random>-01` on every request would therefore
 *     select ITSELF into 100% sampling — turning the 2% rate into whatever rate
 *     the attacker prefers, spending the span budget, and then the trace
 *     allowance. An unauthenticated header should not be able to move a bill.
 *
 * This application is the edge service: nothing upstream of nginx speaks OTLP,
 * so there is no legitimate inbound context to lose. If a genuine upstream ever
 * exists, the fix is to extract only from a trusted, authenticated hop — not to
 * delete this file.
 *
 * Injection is kept, so that outbound calls this service makes are still
 * correlated end to end if the far side ever participates.
 */

/**
 * Wraps a propagator so that `extract` is the identity.
 *
 * `fields()` still reports the wrapped propagator's headers, because it
 * describes what INJECTION writes and injection is unchanged. Reporting nothing
 * would tell instrumentations there is no context to clear on a retry, which is
 * a different bug.
 */
export class InjectOnlyPropagator {
  constructor(inner) {
    this.inner = inner;
  }

  inject(context, carrier, setter) {
    return this.inner.inject(context, carrier, setter);
  }

  /**
   * Returns the context untouched, discarding whatever the carrier claimed.
   *
   * Not `throw`, not "extract and validate": the header is simply not evidence
   * of anything, so the correct handling is to behave as though it had not been
   * sent. Every request then starts a root span, which is what the sampler and
   * the tail decision both assume.
   */
  extract(context) {
    return context;
  }

  fields() {
    return this.inner.fields();
  }
}
