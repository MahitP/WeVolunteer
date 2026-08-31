/**
 * The ceiling that does not care why the traffic arrived.
 *
 * ── Why a rate is not enough ──
 *
 * `OTEL_TRACE_SAMPLE_RATE` bounds the FRACTION of traffic that becomes billable
 * telemetry. It does not bound the amount, because the amount is the fraction
 * times a denominator this application does not control. A crawler discovering
 * the event pages, a client stuck in a retry loop, a misconfigured uptime check
 * at one-second resolution — each multiplies the denominator without anybody
 * changing a setting, and 2% of a hundredfold surprise is still twice the
 * traffic the rate was chosen for.
 *
 * Better Stack's free plan bills ingestion beyond its inclusions rather than
 * refusing it, so "unbounded telemetry" and "unbounded invoice" are the same
 * sentence. This counter is the part of the design that makes the worst case a
 * number rather than a rate.
 *
 * ── What happens when it runs out ──
 *
 * Sampling drops to zero for the remainder of the window. Nothing else changes:
 * requests are served, the existing log sink keeps recording every error, and
 * the metrics pipeline — which is on a separate 30 GB allowance and is orders of
 * magnitude cheaper per unit of answer — keeps reporting latency for the whole
 * population, not the sampled part. One line goes to the journal, once, and
 * `spansRefused` counts what was refused so the gap is visible rather than
 * mysterious.
 *
 * ── Why a rolling window and not a calendar day ──
 *
 * A calendar day resets at a boundary an operator has to know about, and a
 * burst that straddles midnight gets two budgets. The window here is anchored at
 * the first span of the window and slides forward a whole window at a time, so
 * the guarantee is the simple one: never more than `limit` spans in any
 * `windowMs`, wherever the incident happens to fall.
 */

const WINDOW_MS = 24 * 60 * 60 * 1000;

export class SpanBudget {
  /**
   * @param {object} opts
   * @param {number} opts.limit      spans exportable per window; 0 disables tracing entirely
   * @param {number} [opts.windowMs] length of the window; only tests change it
   * @param {() => number} [opts.now] clock seam, so a test need not wait a day
   */
  constructor({ limit, windowMs = WINDOW_MS, now = Date.now }) {
    this.limit = Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : 0;
    this.windowMs = windowMs;
    this.now = now;
    this.windowStart = now();
    this.spent = 0;
    this.refused = 0;
    this.windowsElapsed = 0;
    this._warned = false;
  }

  /** Slides the window forward if the current one has expired. */
  _roll() {
    const elapsed = this.now() - this.windowStart;
    if (elapsed < this.windowMs) return;
    /* Jump whole windows rather than resetting to "now": a process idle for
       three days should not be given a fresh budget at an arbitrary offset, and
       the arithmetic keeps window boundaries stable across a quiet period. */
    const windows = Math.floor(elapsed / this.windowMs);
    this.windowStart += windows * this.windowMs;
    this.windowsElapsed += windows;
    this.spent = 0;
    this._warned = false;
  }

  /** Whether any budget remains. Does not consume. */
  hasRoom() {
    this._roll();
    return this.spent < this.limit;
  }

  /**
   * Consumes budget for `count` spans, all or nothing.
   *
   * All-or-nothing because the caller is deciding about a WHOLE TRACE: exporting
   * four spans of a six-span trace produces a broken waterfall that reads as a
   * bug in the application rather than a truncation in the pipeline. A trace
   * that does not fit is refused entirely and counted.
   *
   * @returns {boolean} whether the spans may be exported
   */
  consume(count = 1) {
    this._roll();
    const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
    if (n === 0) return false;
    if (this.spent + n > this.limit) {
      this.refused += n;
      if (!this._warned) {
        this._warned = true;
        try {
          console.warn(
            `[otel] Daily span budget of ${this.limit} is spent. Trace sampling is off `
            + 'until the window rolls; metrics and log telemetry are unaffected. '
            + 'Raise OTEL_TRACE_DAILY_SPAN_BUDGET only after checking the Better Stack usage page.'
          );
        } catch { /* nothing left to try */ }
      }
      return false;
    }
    this.spent += n;
    return true;
  }

  stats() {
    this._roll();
    return {
      limit: this.limit,
      spent: this.spent,
      remaining: Math.max(0, this.limit - this.spent),
      refused: this.refused,
      windowsElapsed: this.windowsElapsed,
    };
  }
}
