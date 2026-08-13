import { describe, it, expect, beforeAll, afterAll, vi, beforeEach, afterEach } from 'vitest';
import { startTestServer } from './testServer.js';

let srv;
const originalFetch = global.fetch;
let organizerToken;
let studentToken;

beforeAll(async () => { 
  srv = await startTestServer(); 
});
afterAll(async () => { 
  await srv.close(); 
  global.fetch = originalFetch;
});

describe('Geocoding Proxy Route', () => {
  beforeEach(async () => {
    organizerToken = await srv.login('jordan.whitfield@example.org', 'password123');
    studentToken = await srv.login('leo.chen@example.com', 'password123');

    global.fetch = vi.fn(async (url, init) => {
      if (typeof url === 'string' && url.includes('nominatim')) {
        return {
          ok: true,
          json: () => Promise.resolve([
            {
              name: "Library",
              display_name: "Library, Main Street, Springfield",
              lat: "40.0",
              lon: "-74.0",
              address: { road: "Main Street", city: "Springfield", state: "IL" }
            }
          ])
        };
      }
      return originalFetch(url, init);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects unauthenticated requests', async () => {
    const res = await srv.call('GET', '/api/geocode?q=library');
    expect(res.status).toBe(401);
  });

  it('rejects student requests', async () => {
    const res = await srv.call('GET', '/api/geocode?q=library', undefined, studentToken);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Access denied');
  });

  it('allows organizer requests and returns mapped results', async () => {
    const res = await srv.call('GET', '/api/geocode?q=library', undefined, organizerToken);
    expect(res.status).toBe(200);
    expect(res.body.results.length).toBe(1);
    expect(res.body.results[0].displayName).toBe('Library');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects short queries', async () => {
    const res = await srv.call('GET', '/api/geocode?q=a', undefined, organizerToken);
    expect(res.status).toBe(400);
  });
});

/**
 * The application-wide throttle in front of Nominatim (TD-19).
 *
 * The per-IP limiter bounds one client. Nominatim's usage policy bounds the
 * whole application at one request per second, and nothing enforced that — a
 * handful of organizers on different networks each stayed inside thirty a
 * minute while WeVolunteer as a whole went well past one a second. The
 * consequence is not a 500; it is OSM blocking this application's User-Agent,
 * which removes address lookup for every school at once.
 *
 * These use real timers and real waiting, because the thing under test IS the
 * wall-clock spacing. One second of sleep against a 15s server-project timeout.
 */
describe('Nominatim upstream throttle', () => {
  let organizerToken;
  let upstreamCalls;

  beforeEach(async () => {
    const { __resetUpstreamThrottle } = await import('./routes/geocodeRoutes.js');
    __resetUpstreamThrottle();

    organizerToken = await srv.login('jordan.whitfield@example.org', 'password123');
    upstreamCalls = [];

    global.fetch = vi.fn(async (url, init) => {
      if (typeof url === 'string' && url.includes('nominatim')) {
        upstreamCalls.push({ url, at: Date.now() });
        return { ok: true, json: () => Promise.resolve([]) };
      }
      return originalFetch(url, init);
    });
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('spaces two distinct uncached lookups at least a second apart', async () => {
    /**
     * The end-to-end half: the handler really does await its reservation before
     * calling upstream, and the reservation really does sit after the cache
     * check. The arithmetic itself is asserted exactly in the unit tests below,
     * so this only has to prove the wiring.
     *
     * `>= 900` rather than `>= 1000`, deliberately. A real `setTimeout(1000)`
     * can be reported a millisecond or two early once `Date.now()` is coarsened
     * and the worker pool is saturated, and `999 >= 1000` failing told nobody
     * anything true — the scheduling is proved elsewhere without a clock at all.
     */
    await srv.call('GET', '/api/geocode?q=first library', undefined, organizerToken);
    await srv.call('GET', '/api/geocode?q=second museum', undefined, organizerToken);

    expect(upstreamCalls.length).toBe(2);
    expect(upstreamCalls[1].at - upstreamCalls[0].at).toBeGreaterThanOrEqual(900);
  });

  describe('the reservation arithmetic, without waiting for it', () => {
    /**
     * What the wall-clock test cannot prove, and does not have to.
     *
     * `reserveUpstreamSlot` takes an injectable `now`, so the whole policy —
     * one request per second, refuse beyond a three-second queue, and a refusal
     * reserves nothing — is checkable as arithmetic in microseconds. This pins
     * strictly more than the timing test did.
     */
    let reserve;
    let reset;

    beforeEach(async () => {
      ({ reserveUpstreamSlot: reserve, __resetUpstreamThrottle: reset } =
        await import('./routes/geocodeRoutes.js'));
      reset();
    });

    it('lets the first caller go immediately', () => {
      expect(reserve(5_000)).toBe(0);
    });

    it('makes the second caller wait exactly one interval', () => {
      reserve(5_000);
      expect(reserve(5_000)).toBe(1000);
    });

    it('holds the SLOT fixed, so arriving later means waiting less', () => {
      /**
       * The subtlety worth pinning. A caller arriving 500ms into the interval
       * waits 500ms, not 1000 — because the slot is an absolute instant, not a
       * delay measured from arrival. The spacing between upstream calls is
       * still exactly one interval, which is the property the policy is about.
       *
       * A first draft expected 1500 here, reasoning about delays rather than
       * slots. The code was right.
       */
      reserve(5_000);              // takes 5000, reserves the next for 6000
      expect(reserve(5_500)).toBe(500);
    });

    it('admits a wait of exactly the ceiling and refuses beyond it', () => {
      /* The boundary, stated exactly: `at - now > MAX` refuses, so a 3000ms
         wait is served and 4000ms is not. Asserting the boundary rather than a
         round number is what makes an off-by-one visible. */
      expect(reserve(5_000)).toBe(0);
      expect(reserve(5_000)).toBe(1000);
      expect(reserve(5_000)).toBe(2000);
      expect(reserve(5_000), 'exactly the ceiling is still served').toBe(3000);
      expect(reserve(5_000), 'past the ceiling is refused').toBeNull();
    });

    it('a refusal reserves nothing, so it cannot push the queue further out', () => {
      /**
       * The invariant the docblock claims. A caller that is turned away must
       * not consume a slot — otherwise a burst of refusals would keep moving
       * the queue and lock out the callers that would have been served.
       */
      reserve(5_000);
      reserve(5_000);
      reserve(5_000);
      reserve(5_000);                       // the last one that fits: reserves 9000
      expect(reserve(5_000)).toBeNull();    // refused
      expect(reserve(5_000)).toBeNull();    // and again

      /* At 9000 the reserved slot has come round. Had either refusal consumed
         one, this would be non-zero. */
      expect(reserve(9_000)).toBe(0);
    });

    it('does not bank credit during a quiet period', () => {
      reserve(5_000);
      expect(reserve(20_000), 'a long gap does not earn a burst allowance').toBe(0);
    });
  });

  it('never makes a cached lookup wait', async () => {
    await srv.call('GET', '/api/geocode?q=repeated place', undefined, organizerToken);

    const startedAt = Date.now();
    const res = await srv.call('GET', '/api/geocode?q=repeated place', undefined, organizerToken);

    expect(res.status).toBe(200);
    expect(res.body.cached).toBe(true);
    /* The whole point of putting the throttle after the cache check: a hit must
       not be made to sit behind somebody else's upstream slot. */
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(upstreamCalls.length).toBe(1);
  });

  it('fails fast instead of queueing a caller behind an unreasonable wait', async () => {
    /* Five distinct queries land at once. The first is served immediately, the
       next few queue inside the acceptable wait, and the rest are refused
       rather than parked for six seconds on a request the user has abandoned. */
    const queries = ['alpha hall', 'bravo park', 'charlie centre', 'delta field', 'echo depot', 'foxtrot yard', 'golf green'];
    const results = await Promise.all(
      queries.map(q => srv.call('GET', `/api/geocode?q=${encodeURIComponent(q)}`, undefined, organizerToken)),
    );

    const refused = results.filter(r => r.status === 429);
    expect(refused.length).toBeGreaterThan(0);
    expect(refused[0].body.code).toBe('rate_limited');

    /* A refusal must not have spent an upstream slot. */
    expect(upstreamCalls.length).toBe(results.length - refused.length);
  });

  it('sends the viewbox bias when the caller supplies coordinates', async () => {
    const res = await srv.call('GET', '/api/geocode?q=community centre&lat=40.4&lon=-74.6', undefined, organizerToken);

    expect(res.status).toBe(200);
    expect(upstreamCalls[0].url).toContain('viewbox=');
    expect(upstreamCalls[0].url).toContain('bounded=1');
  });

  it('keys the cache separately with and without the bias', async () => {
    await srv.call('GET', '/api/geocode?q=same words', undefined, organizerToken);
    const biased = await srv.call('GET', '/api/geocode?q=same words&lat=40.4&lon=-74.6', undefined, organizerToken);

    /* A biased search is a different question and must not be answered from the
       unbiased cache entry, or "the park near me" returns the one three states
       away for the rest of the hour. */
    expect(biased.body.cached).toBeUndefined();
    expect(upstreamCalls.length).toBe(2);
  });
});
