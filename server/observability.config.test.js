/**
 * The gate: who may send telemetry, and who may not.
 *
 * The property that matters most here is the FIRST one asserted — a test run
 * cannot ship spans to a real Better Stack account even when the credentials are
 * present in the environment. `telemetrySink.js` established that rule for logs
 * and gave the reason (a suite that ships telemetry leaks fixture data into a
 * production account and burns somebody's quota, silently); adding a second wire
 * to the same vendor is only safe if the second wire obeys the same rule.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { resolveOtelConfig, OTEL_DEFAULTS } from './observability/otelConfig.js';

const CREDS = {
  BETTERSTACK_SOURCE_TOKEN: 'test-token-not-a-real-one',
  BETTERSTACK_INGESTING_HOST: 's2716518.eu-central-1a.betterstackdata.com',
};

describe('resolveOtelConfig — the test gate', () => {
  it('refuses under VITEST even with valid credentials present', () => {
    const config = resolveOtelConfig({ ...CREDS, VITEST: '1' });
    expect(config.enabled).toBe(false);
    expect(config.reason).toBe('test_environment');
  });

  it('checks the test gate BEFORE looking at credentials', () => {
    /* If the order were reversed, a suite with no credentials would report
       `not_configured` and a suite WITH them would report `test_environment` —
       and the second is the case that matters. Asserting the reason pins the
       order, not just the outcome. */
    expect(resolveOtelConfig({ VITEST: '1' }).reason).toBe('test_environment');
    expect(resolveOtelConfig({ ...CREDS, VITEST: '1' }).reason).toBe('test_environment');
  });

  it('allows an opted-in test to reach a local stub', () => {
    const config = resolveOtelConfig({
      ...CREDS, VITEST: '1', WEV_OTEL_TEST_SINK: '1',
      BETTERSTACK_INGESTING_HOST: 'http://127.0.0.1:4318',
    });
    expect(config.enabled).toBe(true);
    expect(config.tracesUrl).toBe('http://127.0.0.1:4318/v1/traces');
  });
});

describe('resolveOtelConfig — credentials and host', () => {
  it('is off with no credentials', () => {
    expect(resolveOtelConfig({}).reason).toBe('not_configured');
  });

  it('refuses a token with no host, and a host with no token', () => {
    expect(resolveOtelConfig({ BETTERSTACK_SOURCE_TOKEN: 'x' }).reason).toBe('not_configured');
    expect(resolveOtelConfig({ BETTERSTACK_INGESTING_HOST: 'h.example' }).reason).toBe('not_configured');
  });

  it('accepts a bare host and a full URL alike', () => {
    const bare = resolveOtelConfig(CREDS);
    const full = resolveOtelConfig({ ...CREDS, BETTERSTACK_INGESTING_HOST: 'https://s2716518.eu-central-1a.betterstackdata.com' });
    expect(bare.tracesUrl).toBe(full.tracesUrl);
    expect(bare.tracesUrl).toBe('https://s2716518.eu-central-1a.betterstackdata.com/v1/traces');
    expect(bare.metricsUrl).toBe('https://s2716518.eu-central-1a.betterstackdata.com/v1/metrics');
  });

  it('builds the signal paths without doubling a slash', () => {
    const config = resolveOtelConfig({ ...CREDS, BETTERSTACK_INGESTING_HOST: 'https://host.example/' });
    expect(config.tracesUrl).toBe('https://host.example/v1/traces');
  });

  it('refuses a non-http scheme rather than coercing it', () => {
    expect(resolveOtelConfig({ ...CREDS, BETTERSTACK_INGESTING_HOST: 'ftp://h.example' }).reason).toBe('bad_host');
  });

  it('refuses plain HTTP in production, because the token rides in the header', () => {
    const config = resolveOtelConfig({ ...CREDS, BETTERSTACK_INGESTING_HOST: 'http://h.example', NODE_ENV: 'production' });
    expect(config.reason).toBe('insecure_host');
  });

  it('allows plain HTTP outside production, for a loopback stub', () => {
    const config = resolveOtelConfig({ ...CREDS, BETTERSTACK_INGESTING_HOST: 'http://127.0.0.1:4318' });
    expect(config.enabled).toBe(true);
  });
});

describe('resolveOtelConfig — the operator off switch', () => {
  it('is off when WEV_OTEL_ENABLED=false, even with credentials', () => {
    const config = resolveOtelConfig({ ...CREDS, WEV_OTEL_ENABLED: 'false' });
    expect(config.enabled).toBe(false);
    expect(config.reason).toBe('disabled_by_operator');
  });

  it('is not confused by other values of the switch', () => {
    expect(resolveOtelConfig({ ...CREDS, WEV_OTEL_ENABLED: 'true' }).enabled).toBe(true);
    expect(resolveOtelConfig({ ...CREDS, WEV_OTEL_ENABLED: '' }).enabled).toBe(true);
  });
});

describe('resolveOtelConfig — the cost controls', () => {
  it('defaults to the documented sample rate and daily budget', () => {
    const config = resolveOtelConfig(CREDS);
    expect(config.sampleRatio).toBe(OTEL_DEFAULTS.sampleRatio);
    expect(config.dailySpanBudget).toBe(OTEL_DEFAULTS.dailySpanBudget);
  });

  it('keeps the default sample rate at or below 5%', () => {
    /* A guard on the NUMBER, not on the plumbing. The free plan includes 3 GB of
       traces a month and bills beyond it; the arithmetic in otelConfig.js shows
       unsampled traffic at ~4.5 GB. A future edit that raises this default past
       a few percent has re-opened that, and should have to change this line and
       explain itself. */
    expect(OTEL_DEFAULTS.sampleRatio).toBeLessThanOrEqual(0.05);
    expect(OTEL_DEFAULTS.sampleRatio).toBeGreaterThan(0);
  });

  it('keeps the default daily budget inside a month of the free trace allowance', () => {
    /* 3 GB/month at ~500 bytes/span is ~6.4M spans/month, ~214k/day. The default
       must sit under that, so that a month spent AT THE CEILING still lands on
       the free plan rather than past it. */
    const spansPerDayAtAllowance = (3 * 1024 ** 3) / 500 / 30;
    expect(OTEL_DEFAULTS.dailySpanBudget).toBeLessThan(spansPerDayAtAllowance);
  });

  it('honours an operator-supplied rate and budget', () => {
    const config = resolveOtelConfig({ ...CREDS, OTEL_TRACE_SAMPLE_RATE: '0.5', OTEL_TRACE_DAILY_SPAN_BUDGET: '1234' });
    expect(config.sampleRatio).toBe(0.5);
    expect(config.dailySpanBudget).toBe(1234);
  });

  it('falls back to the default rather than accepting nonsense', () => {
    for (const bad of ['abc', '-1', '2', 'NaN', 'Infinity']) {
      expect(resolveOtelConfig({ ...CREDS, OTEL_TRACE_SAMPLE_RATE: bad }).sampleRatio)
        .toBe(OTEL_DEFAULTS.sampleRatio);
    }
    expect(resolveOtelConfig({ ...CREDS, OTEL_TRACE_DAILY_SPAN_BUDGET: 'lots' }).dailySpanBudget)
      .toBe(OTEL_DEFAULTS.dailySpanBudget);
  });

  it('accepts an explicit zero rate, which is different from an invalid one', () => {
    expect(resolveOtelConfig({ ...CREDS, OTEL_TRACE_SAMPLE_RATE: '0' }).sampleRatio).toBe(0);
    expect(resolveOtelConfig({ ...CREDS, OTEL_TRACE_DAILY_SPAN_BUDGET: '0' }).dailySpanBudget).toBe(0);
  });
});

describe('resolveOtelConfig — the credential never appears in a URL', () => {
  it('puts the token nowhere except its own field', () => {
    const config = resolveOtelConfig(CREDS);
    expect(config.tracesUrl).not.toContain(CREDS.BETTERSTACK_SOURCE_TOKEN);
    expect(config.metricsUrl).not.toContain(CREDS.BETTERSTACK_SOURCE_TOKEN);
    expect(config.token).toBe(CREDS.BETTERSTACK_SOURCE_TOKEN);
  });
});

describe('the configuration path from process.env to the exporter', () => {
  /**
   * ── The refactor this exists to catch ──
   *
   * Every other test in this file passes `resolveOtelConfig` an explicit `env`
   * object, which proves the resolver reads what it is given and proves nothing
   * about where production gets it from. `bootstrap.js` calls `startOtel()` with
   * NO argument, so the whole integration rests on one default parameter —
   * `startOtel(env = process.env)` — and on `resolveOtelConfig(env = process.env)`
   * underneath it.
   *
   * Change either default, or introduce a config module that forgets to forward
   * the variable, and the application would boot, log "not_configured", serve
   * every request perfectly, and send nothing. Nothing would fail. That is
   * exactly the class of silent breakage this repository keeps naming, so the
   * default is pinned rather than assumed.
   *
   * No real credential is involved: the value below is synthetic and hyphenated,
   * which is also the shape the secret scanner deliberately lets past.
   */
  const SAVED = {};
  const VARS = ['BETTERSTACK_SOURCE_TOKEN', 'BETTERSTACK_INGESTING_HOST', 'WEV_OTEL_TEST_SINK'];

  afterEach(() => {
    for (const key of VARS) {
      if (SAVED[key] === undefined) delete process.env[key];
      else process.env[key] = SAVED[key];
      delete SAVED[key];
    }
  });

  function setEnv(values) {
    for (const key of VARS) SAVED[key] = process.env[key];
    for (const [key, value] of Object.entries(values)) process.env[key] = value;
  }

  it('reads process.env when no env object is passed', () => {
    setEnv({
      BETTERSTACK_SOURCE_TOKEN: 'synthetic-not-a-real-token-value',
      BETTERSTACK_INGESTING_HOST: 's2716518.eu-central-1a.betterstackdata.com',
      WEV_OTEL_TEST_SINK: '1',
    });

    /* Called with NO argument, which is how bootstrap.js calls startOtel. */
    const config = resolveOtelConfig();

    expect(config.enabled, 'resolveOtelConfig() no longer defaults to process.env').toBe(true);
    expect(config.token).toBe('synthetic-not-a-real-token-value');
  });

  it('reports not_configured from process.env when the token is blank', () => {
    /* The state the environment file ships in, before a token is pasted. The
       application must boot and serve; telemetry simply stays off. */
    setEnv({
      BETTERSTACK_SOURCE_TOKEN: '',
      BETTERSTACK_INGESTING_HOST: 's2716518.eu-central-1a.betterstackdata.com',
      WEV_OTEL_TEST_SINK: '1',
    });
    expect(resolveOtelConfig().reason).toBe('not_configured');
  });

  it('derives both Better Stack OTLP signal endpoints from the ingesting host', () => {
    /* The paths Better Stack documents. Pinned because a typo here is invisible
       from inside the application: the exporter would post to a 404 for ever and
       the only symptom would be an empty dashboard. */
    setEnv({
      BETTERSTACK_SOURCE_TOKEN: 'synthetic-not-a-real-token-value',
      BETTERSTACK_INGESTING_HOST: 's2716518.eu-central-1a.betterstackdata.com',
      WEV_OTEL_TEST_SINK: '1',
    });
    const config = resolveOtelConfig();
    expect(config.tracesUrl).toBe('https://s2716518.eu-central-1a.betterstackdata.com/v1/traces');
    expect(config.metricsUrl).toBe('https://s2716518.eu-central-1a.betterstackdata.com/v1/metrics');
  });
});
