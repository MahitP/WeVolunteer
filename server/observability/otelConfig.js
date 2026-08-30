/**
 * Whether this process may send traces and metrics to Better Stack, and where.
 *
 * ── Why this mirrors `telemetrySink.js` rather than reading OTEL_* variables ──
 *
 * The OpenTelemetry exporters read a standard environment surface of their own
 * (`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`,
 * `OTEL_TRACES_SAMPLER`, …), and adopting it wholesale was considered and
 * rejected for two specific reasons:
 *
 *   · **It would give telemetry two gates that disagree.** `telemetrySink.js`
 *     refuses to send anything when `VITEST` is set, so a test suite cannot leak
 *     fixture data into a real account. An exporter configured from `OTEL_*`
 *     obeys none of that — a developer with those variables exported would ship
 *     spans from every `npm test` run, silently, against the same source token
 *     the logs gate is protecting.
 *   · **It splits one credential across two spellings.** Traces, metrics and
 *     logs all authenticate to the SAME Better Stack source with the SAME token.
 *     Naming it twice invites the two halves to drift, and an operator who
 *     rotates one and not the other gets a half-working integration whose
 *     failure is invisible from the dashboard.
 *
 * So the token and host are read from the variables that already exist, the
 * exporters are configured EXPLICITLY in code, and the standard `OTEL_*`
 * variables are deliberately not the configuration surface. Explicit
 * configuration wins over the environment in the OTLP exporters, so a stray
 * `OTEL_EXPORTER_OTLP_ENDPOINT` in somebody's shell cannot redirect this
 * application's telemetry to somewhere else.
 *
 * ── The endpoints ──
 *
 * Better Stack documents OTLP over HTTP at three signal-specific paths on the
 * ingesting host: `/v1/traces`, `/v1/metrics`, `/v1/logs`, authenticated with
 * `Authorization: Bearer $SOURCE_TOKEN`. Only the first two are used here; see
 * `otel.js` for why logs stay on the existing sink.
 */

/**
 * Fraction of ordinary, successful traces kept.
 *
 * ── Why 0.02 and not a rounder number ──
 *
 * It is derived from the Better Stack free allowance rather than chosen for
 * looking reasonable. The free plan includes **3 GB of traces per month**, and
 * ingestion beyond it is billed rather than refused — so the sampling rate is a
 * cost control, not a taste preference.
 *
 * Working, at the traffic this deployment is sized for (see
 * `docs/operations/observability.md` §"Telemetry budget" for the full table):
 *
 *   50,000 requests/day × 6 spans/request × ~500 bytes/span ≈ 150 MB/day
 *                                                            ≈ 4.5 GB/month
 *
 * Unsampled, that is 150% of the allowance — the free plan is exceeded by
 * ordinary operation, which is exactly the shape of accident this repository is
 * required to make impossible. At 2% the same traffic costs ~90 MB/month, and a
 * TEN-FOLD traffic surprise still lands at ~900 MB — inside the allowance with
 * room to spare.
 *
 * What 2% would normally cost is the ability to find a specific slow request,
 * and that is bought back two ways rather than by raising the rate: every error
 * trace is kept regardless of this number (see `tailSampler.js`), and latency
 * for the whole population — not the 2% — is carried by the metrics histogram,
 * which is on a separate 30 GB allowance and is far cheaper per unit of answer.
 */
const DEFAULT_SAMPLE_RATIO = 0.02;

/**
 * The hard stop: spans this process may export in a rolling 24 hours.
 *
 * Sampling is a RATE, and a rate multiplied by unexpected traffic is still
 * unbounded — a crawler, a retry storm or a health-check loop can raise the
 * denominator by orders of magnitude without anybody noticing until the invoice
 * does. This is the ceiling that does not care why the traffic arrived.
 *
 * 200,000 spans/day at ~500 bytes is roughly 100 MB/day, or 3 GB over a
 * 30-day month — precisely the free trace allowance. So the budget is set at the
 * value where a full month of running AT THE CEILING lands on the allowance
 * rather than past it, which makes the worst case equal to the free plan instead
 * of a bill.
 *
 * Reaching it is not an error and does not disturb the application: sampling
 * goes to zero for the remainder of the window, a counter records how many spans
 * were refused, and one line is written to the journal. Metrics and the existing
 * log sink are unaffected — they are on different allowances and are not what
 * runs out.
 */
const DEFAULT_DAILY_SPAN_BUDGET = 200_000;

/** A ratio an operator typed. Refused rather than coerced when it is nonsense. */
function parseRatio(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) return fallback;
  return value;
}

function parseBudget(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

/**
 * Resolves the OpenTelemetry configuration for this process.
 *
 * The gate order is deliberate and matches `resolveTelemetryConfig` exactly, for
 * the reason given there: the test refusal is checked FIRST, before any token is
 * looked at, so that a developer with production credentials in their shell
 * cannot ship spans from a test run even by accident.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{enabled: boolean, reason?: string, tracesUrl?: string,
 *            metricsUrl?: string, token?: string, sampleRatio?: number,
 *            dailySpanBudget?: number}}
 */
export function resolveOtelConfig(env = process.env) {
  /* Same seam, same spelling, same reasoning as the log sink's — and a separate
     opt-in name so a suite can exercise the OTLP path against a local stub
     without also turning the log sink on. */
  if (env.VITEST && env.WEV_OTEL_TEST_SINK !== '1') {
    return { enabled: false, reason: 'test_environment' };
  }

  /* An explicit off switch, for an operator who has the token set for logs and
     wants traces off — during an incident, or while measuring overhead. Checked
     before the credentials so that "off" cannot be overridden by having them. */
  if (String(env.WEV_OTEL_ENABLED || '').trim().toLowerCase() === 'false') {
    return { enabled: false, reason: 'disabled_by_operator' };
  }

  const token = String(env.BETTERSTACK_SOURCE_TOKEN || '').trim();
  const rawHost = String(env.BETTERSTACK_INGESTING_HOST || '').trim();
  if (!token || !rawHost) return { enabled: false, reason: 'not_configured' };

  let url;
  try {
    url = new URL(rawHost.includes('://') ? rawHost : `https://${rawHost}`);
  } catch {
    return { enabled: false, reason: 'bad_host' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { enabled: false, reason: 'bad_host' };
  }
  /* Plain HTTP carries the Bearer token in clear. Allowed for a loopback stub,
     which is what the tests use, and refused in production — the same rule the
     log sink applies, for the same reason. */
  if (url.protocol === 'http:' && env.NODE_ENV === 'production') {
    return { enabled: false, reason: 'insecure_host' };
  }

  /* `new URL('/v1/traces', origin)` rather than string concatenation: a host
     pasted with a trailing slash, or with a path already on it, would otherwise
     produce `//v1/traces` or silently drop the path. */
  const base = url.origin;

  return {
    enabled: true,
    tracesUrl: new URL('/v1/traces', base).toString(),
    metricsUrl: new URL('/v1/metrics', base).toString(),
    token,
    sampleRatio: parseRatio(env.OTEL_TRACE_SAMPLE_RATE, DEFAULT_SAMPLE_RATIO),
    dailySpanBudget: parseBudget(env.OTEL_TRACE_DAILY_SPAN_BUDGET, DEFAULT_DAILY_SPAN_BUDGET),
  };
}

export const OTEL_DEFAULTS = Object.freeze({
  sampleRatio: DEFAULT_SAMPLE_RATIO,
  dailySpanBudget: DEFAULT_DAILY_SPAN_BUDGET,
});
