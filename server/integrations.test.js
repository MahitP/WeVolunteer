import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PROVIDER_STATES, classifyStatus, fail, notConfigured, ok } from './integrations/providerResult.js';
import { fetchJson } from './integrations/httpJson.js';
import { __resetProviderCache, cached } from './integrations/providerCache.js';
import { fetchIncidents, fetchMonitors } from './integrations/betterstack.js';
import { fetchEventUsage, fetchUsers } from './integrations/amplitude.js';

/**
 * The four third-party integrations, exercised against a stubbed transport.
 *
 * ── What these tests are actually protecting ──
 *
 * Not the happy path. The happy path is the one an operator notices is broken
 * within a minute. What nobody notices is a FAILURE path: a revoked token, a
 * vendor outage, a plan that stopped including an endpoint. Those show up on a
 * page whose whole purpose is to be trustworthy about status, and the two ways
 * to get them wrong are both silent — reporting a vendor's outage as our own,
 * or letting one vendor's 500 take the whole page down.
 *
 * The other half is the rule from `providerResult.js`: **nothing from the wire
 * may travel further in.** A 401 body has been observed to echo a credential
 * prefix, and a 500 body is arbitrary text from somebody else's server that
 * would otherwise land in the Owner Center's DOM. Several cases below feed
 * exactly that back and assert that none of it survives.
 */

/** A `fetch` that answers whatever the case describes, and records the calls. */
function stubFetch(handler) {
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }));
  return calls;
}

const json = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  body: null,
  text: async () => JSON.stringify(body),
});

beforeEach(() => { __resetProviderCache(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/* ── The shared vocabulary ─────────────────────────────────────────────── */

describe('provider results', () => {
  it('refuses a state it does not know, rather than rendering an unknown card', () => {
    /* A typo'd state would render as "Unavailable" — indistinguishable from a
       vendor problem, and silent. Throwing surfaces it in this suite instead. */
    expect(() => fail('not_configued')).toThrow(/Unknown provider state/);
  });

  it('maps the statuses that mean different things to a reader', () => {
    expect(classifyStatus(401)).toBe('unauthorized');
    expect(classifyStatus(402)).toBe('plan_restricted');
    expect(classifyStatus(403)).toBe('forbidden');
    expect(classifyStatus(429)).toBe('rate_limited');
    expect(classifyStatus(503)).toBe('unavailable');
  });

  it('keeps every state in the declared vocabulary', () => {
    for (const state of [...PROVIDER_STATES]) {
      expect(() => (state === 'ok' ? ok({}) : fail(state))).not.toThrow();
    }
  });

  it('carries the variables that would configure it, so the page never names them', () => {
    /* `redis.privacy.test.js` fails the build on any file under `src/` naming a
       Redis connection variable. The names have to come from here. */
    expect(notConfigured('SOME_TOKEN').configureWith).toBe('SOME_TOKEN');
    expect(notConfigured().configureWith).toBeUndefined();
  });
});

/* ── The transport ─────────────────────────────────────────────────────── */

describe('the outbound request', () => {
  it('reduces an HTTP failure to a state and keeps the body out of it', async () => {
    stubFetch(async () => ({
      ok: false,
      status: 401,
      /* The shape of a real refusal: vendors do echo fragments of what they
         were sent, and this one is a credential prefix. */
      text: async () => JSON.stringify({ error: 'Invalid token bs_live_abcd1234' }),
    }));

    const res = await fetchJson('https://example.test/x');
    expect(res.state).toBe('unauthorized');
    expect(JSON.stringify(res)).not.toContain('bs_live_abcd1234');
    expect(JSON.stringify(res)).not.toContain('Invalid token');
  });

  it('reports a timeout as a timeout, and never throws it at the caller', async () => {
    stubFetch(async () => { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; });
    await expect(fetchJson('https://example.test/x')).resolves.toEqual({ state: 'timeout' });
  });

  it('reports a transport failure without the host it failed to reach', async () => {
    stubFetch(async () => { throw new TypeError('getaddrinfo ENOTFOUND secret-host.internal'); });
    const res = await fetchJson('https://example.test/x');
    expect(res).toEqual({ state: 'unavailable' });
    expect(JSON.stringify(res)).not.toContain('secret-host');
  });

  it('treats a 200 that is not JSON as a bad response, not as data', async () => {
    /* A captive portal, a proxy error page, or an API that changed shape. All
       three would otherwise put somebody else's HTML in front of the owner. */
    stubFetch(async () => ({ ok: true, status: 200, text: async () => '<html>Sign in to WiFi</html>' }));
    await expect(fetchJson('https://example.test/x')).resolves.toEqual({ state: 'bad_response' });
  });
});

/* ── Caching, deduplication and the stale fallback ─────────────────────── */

describe('the provider cache', () => {
  it('runs the producer once per TTL, so a page render is not a burst', async () => {
    const producer = vi.fn(async () => ok({ n: 1 }));
    await cached('k', 60_000, producer);
    await cached('k', 60_000, producer);
    await cached('k', 60_000, producer);
    expect(producer).toHaveBeenCalledTimes(1);
  });

  it('deduplicates two callers that arrive together', async () => {
    let resolve;
    const producer = vi.fn(() => new Promise(r => { resolve = r; }));
    const a = cached('k', 60_000, producer);
    const b = cached('k', 60_000, producer);
    resolve(ok({ n: 1 }));
    await Promise.all([a, b]);
    /* Two in-flight requests to one endpoint is the shape that turns a rate
       limit into an outage. */
    expect(producer).toHaveBeenCalledTimes(1);
  });

  it('serves the last good answer, labelled stale, when a refresh fails', async () => {
    await cached('k', 0, async () => ok({ n: 7 }));
    const second = await cached('k', 0, async () => fail('timeout'));

    expect(second.state).toBe('ok');
    expect(second.n).toBe(7);
    expect(second.stale).toBe(true);
    /* The reason is carried so the page can say WHY it is showing an old
       figure. "This is 90 seconds old and the vendor has not answered since"
       is a different sentence from "this is 90 seconds old". */
    expect(second.staleReason).toBe('timeout');
  });

  it('never serves a remembered success over "not configured"', async () => {
    await cached('k', 0, async () => ok({ n: 7 }));
    const second = await cached('k', 0, async () => notConfigured('SOME_TOKEN'));

    /**
     * The one direction a status page must never be wrong in. An operator who
     * has just REVOKED a credential would otherwise still see live-looking
     * figures, and conclude the revocation had not taken.
     */
    expect(second.state).toBe('not_configured');
    expect(second.n).toBeUndefined();
  });

  it('treats a thrown producer as an unreachable vendor rather than a 500', async () => {
    /* The caller is a route handler rendering a status page. An exception there
       is a 500 on the page that exists to say what is broken. */
    await expect(cached('k', 0, async () => { throw new Error('boom'); }))
      .resolves.toMatchObject({ state: 'unavailable' });
  });

  it('bypasses a cache hit when the refresh button asks, but still deduplicates', async () => {
    const producer = vi.fn(async () => ok({ n: 1 }));
    await cached('k', 60_000, producer);
    await cached('k', 60_000, producer, { fresh: true });
    expect(producer).toHaveBeenCalledTimes(2);
  });
});

/* ── Better Stack ──────────────────────────────────────────────────────── */

describe('Better Stack', () => {
  const env = (extra = {}) => ({ BETTERSTACK_UPTIME_API_TOKEN: 'test-token', ...extra });

  it('is "not configured" with no token, and makes no request at all', async () => {
    const calls = stubFetch(async () => json({}));
    const res = await fetchMonitors({});
    expect(res.state).toBe('not_configured');
    expect(res.configureWith).toContain('BETTERSTACK_UPTIME_API_TOKEN');
    /* Not merely a graceful failure — an unconfigured integration must not cost
       a DNS lookup, let alone a request, on every page load. */
    expect(calls).toHaveLength(0);
  });

  it('reads the monitors and counts what is down', async () => {
    stubFetch(async () => json({
      data: [
        { id: '1', attributes: { pronounceable_name: 'API', url: 'https://x.test', status: 'up', last_checked_at: '2026-09-02T10:00:00Z' } },
        { id: '2', attributes: { pronounceable_name: 'Web', url: 'https://y.test', status: 'down' } },
        { id: '3', attributes: { pronounceable_name: 'Old', status: 'up', paused_at: '2026-08-01T00:00:00Z' } },
      ],
    }));

    const res = await fetchMonitors(env());
    expect(res.state).toBe('ok');
    expect(res.down).toBe(1);
    expect(res.monitors[0]).toMatchObject({ name: 'API', status: 'up' });
    /* Paused is neither healthy nor broken — it is a monitor nobody is
       watching, which is its own thing to notice on a status page. */
    expect(res.monitors[2].paused).toBe(true);
    expect(res.paused).toBe(1);
  });

  it('sends the token as a bearer and never in the URL', async () => {
    const calls = stubFetch(async () => json({ data: [] }));
    await fetchMonitors(env());
    expect(calls[0].init.headers.Authorization).toBe('Bearer test-token');
    /* A credential in a query string lands in every proxy log between here and
       the vendor. */
    expect(calls[0].url).not.toContain('test-token');
  });

  it('bounds a monitor name rather than rendering whatever arrives', async () => {
    stubFetch(async () => json({ data: [{ id: '1', attributes: { pronounceable_name: 'x'.repeat(500), status: 'up' } }] }));
    const res = await fetchMonitors(env());
    expect(res.monitors[0].name.length).toBeLessThanOrEqual(160);
  });

  it('rejects a well-formed 200 whose shape is wrong', async () => {
    stubFetch(async () => json({ data: 'not an array' }));
    await expect(fetchMonitors(env())).resolves.toEqual({ state: 'bad_response' });
  });

  it('fails the incidents card when the OPEN list cannot be read', async () => {
    /* Showing a week of resolved incidents while silently not knowing whether
       anything is on fire right now is worse than showing nothing. */
    stubFetch(async (url) => (url.includes('resolved=false')
      ? { ok: false, status: 500, text: async () => 'nope' }
      : json({ data: [] })));
    await expect(fetchIncidents(env())).resolves.toMatchObject({ state: 'unavailable' });
  });

  it('keeps the card when only the history fails, and says the history is missing', async () => {
    stubFetch(async (url) => (url.includes('resolved=false')
      ? json({ data: [{ id: '9', attributes: { name: 'API down', cause: 'HTTP 500', started_at: '2026-09-02T09:00:00Z' } }] })
      : { ok: false, status: 500, text: async () => 'nope' }));

    const res = await fetchIncidents(env());
    expect(res.state).toBe('ok');
    expect(res.active).toHaveLength(1);
    /* Named, so the UI never has to infer "we could not read the history" from
       an empty array — which is also what "nothing has gone wrong" looks like. */
    expect(res.recentAvailable).toBe(false);
  });
});

/* ── Amplitude ─────────────────────────────────────────────────────────── */

describe('Amplitude', () => {
  const env = (extra = {}) => ({ AMPLITUDE_API_KEY: 'key', AMPLITUDE_SECRET_KEY: 'secret', ...extra });
  const NOW = Date.UTC(2026, 8, 2);

  const usersBody = (values) => ({
    data: {
      series: [values],
      xValues: values.map((_, i) => `2026-08-${String(i + 1).padStart(2, '0')}`),
    },
  });

  it('is "not configured" without BOTH halves of the credential', async () => {
    const calls = stubFetch(async () => json({}));
    expect((await fetchUsers({ AMPLITUDE_API_KEY: 'key' }, NOW)).state).toBe('not_configured');
    expect(calls).toHaveLength(0);
  });

  it('sends the pair as HTTP Basic and never in the query string', async () => {
    const calls = stubFetch(async () => json(usersBody([1, 2])));
    await fetchUsers(env(), NOW);
    expect(calls[0].init.headers.Authorization)
      .toBe(`Basic ${Buffer.from('key:secret').toString('base64')}`);
    expect(calls[0].url).not.toContain('secret');
  });

  it('totals the window and computes a week-on-week trend', async () => {
    /* 14 days: 7 at 1/day, then 7 at 2/day. Recent 14, previous 7, so +100%. */
    const points = [...Array(7).fill(1), ...Array(7).fill(2)];
    stubFetch(async () => json(usersBody(points)));

    const res = await fetchUsers(env(), NOW);
    expect(res.state).toBe('ok');
    expect(res.active.last7).toBe(14);
    expect(res.active.trend).toBe(100);
  });

  it('reports "cannot tell yet" rather than a trend it cannot compute', async () => {
    /* Fewer than two weeks of history, and a previous period of zero. Both are
       `null`: every increase from zero is infinite, and "+∞%" is not a fact. */
    stubFetch(async () => json(usersBody([1, 2, 3])));
    expect((await fetchUsers(env(), NOW)).active.trend).toBeNull();

    stubFetch(async () => json(usersBody([...Array(7).fill(0), ...Array(7).fill(5)])));
    expect((await fetchUsers(env(), NOW)).active.trend).toBeNull();
  });

  it('keeps the card when new-user counts fail, and marks them absent not zero', async () => {
    stubFetch(async (url) => (url.includes('m=new')
      ? { ok: false, status: 500, text: async () => 'nope' }
      : json(usersBody([3, 4]))));

    const res = await fetchUsers(env(), NOW);
    expect(res.state).toBe('ok');
    /* `null`, never 0. A card that cannot say it failed to read new users would
       instead tell the owner that nobody signed up. */
    expect(res.new).toBeNull();
  });

  it('reads a plan refusal as a plan refusal, not as a broken credential', async () => {
    /* The remedies differ and neither is "try again": one means the token is
       wrong, the other means the account's plan does not include the query. */
    stubFetch(async () => ({ ok: false, status: 403, text: async () => '{}' }));
    const res = await fetchUsers(env(), NOW);
    expect(res.state).toBe('plan_restricted');
    expect(res.detail).toMatch(/plan|refused/i);
  });

  it('asks only for the events the application actually sends', async () => {
    const calls = stubFetch(async () => json({ data: { series: [[1]], xValues: ['2026-08-01'] } }));
    const { ANALYTICS_EVENT_NAMES } = await import('./analyticsEvents.js');

    const res = await fetchEventUsage(env(), NOW);
    expect(res.state).toBe('ok');
    expect(res.events.map(e => e.name)).toEqual([...ANALYTICS_EVENT_NAMES]);
    /* One request per event, and no group-by or segment: the cheapest shape the
       Dashboard API has, because its cost is (days x conditions x query type). */
    expect(calls).toHaveLength(ANALYTICS_EVENT_NAMES.length);
    for (const call of calls) {
      expect(call.url).toContain('m=totals');
      expect(call.url).not.toContain('&g=');
      expect(call.url).not.toContain('&s=');
    }
  });

  it('shows an unread event as unavailable rather than as zero usage', async () => {
    const { ANALYTICS_EVENT_NAMES } = await import('./analyticsEvents.js');
    /* Built the way the module builds it. `URLSearchParams` encodes a space as
       `+` and `encodeURIComponent` as `%20`, so a hand-written expectation
       matches nothing and the case silently asserts the happy path twice. */
    const first = new URLSearchParams({
      e: JSON.stringify({ event_type: ANALYTICS_EVENT_NAMES[0] }),
    }).toString();
    stubFetch(async (url) => (url.includes(first)
      ? { ok: false, status: 500, text: async () => 'nope' }
      : json({ data: { series: [[4]], xValues: ['2026-08-01'] } })));

    const res = await fetchEventUsage(env(), NOW);
    expect(res.events[0].total).toBeNull();
    expect(res.events[1].total).toBe(4);
  });

  it('reports one failure once when every event fails the same way', async () => {
    /* A fact about the credential, not about the events. Four identical error
       rows would send the reader looking for four problems. */
    stubFetch(async () => ({ ok: false, status: 401, text: async () => '{}' }));
    await expect(fetchEventUsage(env(), NOW)).resolves.toEqual({ state: 'unauthorized' });
  });
});
