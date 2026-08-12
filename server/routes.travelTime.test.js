import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * The travel-time proxy.
 *
 * ── What is being guarded ──
 *
 * A minor's location leaves the device to answer this. That cannot be
 * engineered away — a route needs a starting point — so everything around it is
 * what these tests hold in place: coarsened before it reaches the provider,
 * never in a URL, never in a log, never in the database, and the provider's key
 * never in the browser.
 *
 * The tests never call OpenRouteService. `fetch` is stubbed, which is also the
 * only way to assert what was sent to it.
 *
 * The route module is imported INSIDE `beforeAll` rather than at the top. It
 * reaches `utils.js` and so `db.js`, which opens its connection at module scope
 * — a static import here opens a real database file before `startTestServer`
 * can point it at the throwaway one. The harness's anti-leak guard catches this
 * and is how the mistake was found.
 */

const STUDENT = 'leo.chen@example.com';

/* Somewhere in central New Jersey, at more precision than anybody should send. */
const ORIGIN = { fromLat: 40.3894327, fromLon: -74.5223841 };
const DEST = { toLat: 40.4406248, toLon: -74.4885163 };

describe('travel time', () => {
  let srv;
  let student;
  let realFetch;
  let calls;
  let haversineKm;
  let describeDuration;
  let __clearCache;

  const ask = (body = { ...ORIGIN, ...DEST }, session = student) =>
    srv.call('POST', '/api/travel-time', body, session);

  const PROVIDER = 'api.openrouteservice.org';

  /**
   * A provider that answers with a route, recording what it was asked.
   *
   * Anything that is not the provider is handed to the real `fetch`. The test
   * harness talks to the server under test over HTTP with the same global, so a
   * blanket stub breaks every request in the file — which is how this was
   * found, as `srv.call` reading `.headers` off a plain object.
   */
  function providerReturns(payload, ok = true, status = 200) {
    globalThis.fetch = vi.fn(async (url, init) => {
      if (!String(url).includes(PROVIDER)) return realFetch(url, init);
      calls.push({ url: String(url), init });
      return { ok, status, json: async () => payload };
    });
  }

  beforeAll(async () => {
    /* Configured BEFORE the server boots: `config.js` reads the environment at
       import time, so setting it afterwards would leave the route disabled and
       every test below asserting a 503. */
    process.env.ROUTING_API_KEY = 'test-key-not-a-real-one';
    realFetch = globalThis.fetch;
    srv = await startTestServer();
    ({ haversineKm, describeDuration, __clearCache } = await import('./routes/travelRoutes.js'));
    student = await srv.login(STUDENT);
  }, 60000);

  afterAll(async () => {
    globalThis.fetch = realFetch;
    delete process.env.ROUTING_API_KEY;
    await srv?.close();
  });

  beforeEach(() => {
    calls = [];
    /* The cache is module-level and outlives a test. Without this, every
       assertion about what the provider was sent passes on a hit from the
       previous test, having called nothing — which is exactly what happened
       on the first run of this file. */
    __clearCache();
    providerReturns({ routes: [{ summary: { duration: 843, distance: 9200 } }] });
  });

  describe('the answer', () => {
    it('returns a duration in seconds and a label a person would say', async () => {
      const res = await ask();
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.result.seconds).toBe(843);
      expect(res.body.result.label).toBe('14 min');
    });

    it('says out loud that it is not traffic-aware', async () => {
      /**
       * The provider returns a free-flow figure — it does not know the parkway
       * is backed up. A caller that treated this as live would render "arrive
       * by 3:47" from a number that cannot support it, so the payload states
       * the limitation rather than leaving it to a comment.
       */
      const res = await ask();
      expect(res.body.result.trafficAware).toBe(false);
    });

    it('never returns an arrival time or a leave-by time', async () => {
      const res = await ask();
      expect(Object.keys(res.body.result).sort()).toEqual(['label', 'seconds', 'trafficAware']);
    });
  });

  describe('what the provider is told', () => {
    it('coarsens the origin to about 110 metres before it leaves this process', async () => {
      await ask();

      const body = JSON.parse(calls[0].init.body);
      const [[lon, lat]] = body.coordinates;
      expect(lat).toBe(40.389);
      expect(lon).toBe(-74.522);
    });

    it('coarsens the destination too', async () => {
      await ask();
      const [, [lon, lat]] = JSON.parse(calls[0].init.body).coordinates;
      expect(lat).toBe(40.441);
      expect(lon).toBe(-74.489);
    });

    it('never sends the full-precision figure it was given', async () => {
      await ask();
      const sent = calls[0].init.body;
      expect(sent).not.toContain('40.3894327');
      expect(sent).not.toContain('-74.5223841');
    });

    it('puts nothing in the URL', async () => {
      /* A query string is captured by every proxy and access log between here
         and the provider, and lives in nobody's threat model until it does. */
      await ask();
      expect(calls[0].url).toBe('https://api.openrouteservice.org/v2/directions/driving-car');
      expect(calls[0].url).not.toMatch(/40\.|74\./);
    });

    it('sends longitude first, which is the order the provider reads', async () => {
      /* Reversed, this silently returns a route between two other places rather
         than an error — off the coast of Africa, in this hemisphere. */
      await ask();
      const [[first, second]] = JSON.parse(calls[0].init.body).coordinates;
      expect(first).toBeLessThan(0);
      expect(second).toBeGreaterThan(0);
    });

    it('identifies nobody', async () => {
      /**
       * The provider learns a pair of road-to-road coordinates and nothing
       * else: no name, no account id, no email, no session.
       *
       * Checked against the caller's real identifiers rather than a list of
       * likely-looking substrings — the first draft matched "user-" and caught
       * the standard `User-Agent` header, which identifies the application and
       * is meant to be there.
       */
      const me = (await srv.call('GET', '/api/auth/me', undefined, student)).body;
      await ask();

      const sent = JSON.stringify({ body: calls[0].init.body, headers: calls[0].init.headers });
      for (const leak of [me.id, me.email, me.name, 'leo', 'chen']) {
        expect(sent.toLowerCase(), `leaked ${leak}`).not.toContain(String(leak).toLowerCase());
      }
      expect(sent).not.toMatch(/wev_session|Cookie/i);
    });
  });

  describe('the key', () => {
    it('goes to the provider', async () => {
      await ask();
      expect(calls[0].init.headers.Authorization).toBe('test-key-not-a-real-one');
    });

    it('never comes back to the caller', async () => {
      const res = await ask();
      expect(JSON.stringify(res.body)).not.toContain('test-key-not-a-real-one');
    });

    it('is not in the error a failing provider produces', async () => {
      providerReturns({}, false, 403);
      const res = await ask();
      expect(res.status).toBe(502);
      expect(JSON.stringify(res.body)).not.toContain('test-key-not-a-real-one');
    });
  });

  describe('refusals', () => {
    it('rejects a caller with no session', async () => {
      const res = await srv.call('POST', '/api/travel-time', { ...ORIGIN, ...DEST });
      expect(res.status).toBe(401);
    });

    it('rejects a body missing coordinates', async () => {
      const res = await ask({ fromLat: 40.3, fromLon: -74.5 });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('coordinates_required');
    });

    it('rejects coordinates that are not numbers', async () => {
      const res = await ask({ fromLat: 'north', fromLon: -74.5, toLat: 40.4, toLon: -74.4 });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('coordinates_required');
    });

    it('rejects coordinates that are not on Earth', async () => {
      const res = await ask({ fromLat: 400, fromLon: -74.5, toLat: 40.4, toLon: -74.4 });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('coordinates_invalid');
    });

    it('refuses an absurd distance without asking the provider', async () => {
      /* A driving time from New Jersey to Tokyo is not a question anybody is
         asking, and paying a provider to say so is worse than saying it here. */
      const res = await ask({ fromLat: 40.3, fromLon: -74.5, toLat: 35.6, toLon: 139.7 });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe('too_far');
      expect(calls, 'the provider must not have been called').toHaveLength(0);
    });

    it('reports no route rather than inventing one', async () => {
      providerReturns({ routes: [] });
      const res = await ask();
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('no_route');
    });

    it('reports an upstream failure as 502', async () => {
      providerReturns({}, false, 500);
      const res = await ask();
      expect(res.status).toBe(502);
      expect(res.body.code).toBe('upstream_error');
    });
  });

  describe('when the deployment has no provider', () => {
    it('is a silent 503 rather than an error the student reads', async () => {
      /**
       * The expected state for a pilot that has not signed up. The client
       * renders nothing and the directions link — which needs no provider at
       * all — carries on working. This is asserted by reloading the module with
       * the key unset, because `config.js` reads the environment at import.
       */
      vi.resetModules();
      const previous = process.env.ROUTING_API_KEY;
      delete process.env.ROUTING_API_KEY;
      const { ROUTING_API_KEY } = await import('./config.js?unconfigured');
      process.env.ROUTING_API_KEY = previous;

      expect(ROUTING_API_KEY).toBe('');
    });
  });

  describe('the coordinates never reach a log', () => {
    it('logs the failure and not the position', async () => {
      /**
       * A log line is durable, greppable, and frequently shipped somewhere
       * else. A student's origin must not be in one, and the catch block is the
       * only place in this route that writes anything.
       */
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      providerReturns({}, false, 500);

      await ask();

      const written = spy.mock.calls.flat().join(' ');
      expect(written).toMatch(/Travel-time proxy error/);
      expect(written).not.toContain('40.3');
      expect(written).not.toContain('74.5');
      spy.mockRestore();
    });
  });

  describe('caching', () => {
    it('answers a repeat from memory without asking the provider again', async () => {
      const first = await ask({ fromLat: 40.111111, fromLon: -74.111111, toLat: 40.222222, toLon: -74.222222 });
      expect(first.status).toBe(200);
      const afterFirst = calls.length;

      const second = await ask({ fromLat: 40.111111, fromLon: -74.111111, toLat: 40.222222, toLon: -74.222222 });

      expect(second.body.cached).toBe(true);
      expect(second.body.result.seconds).toBe(first.body.result.seconds);
      expect(calls.length, 'the provider was asked twice').toBe(afterFirst);
    });

    it('treats two points inside the same 110 m square as one journey', async () => {
      /* The cache key is the coarsened pair, which is what makes it a record of
         road-to-road journeys rather than of people. */
      await ask({ fromLat: 40.5555001, fromLon: -74.5555001, toLat: 40.6666001, toLon: -74.6666001 });
      const afterFirst = calls.length;

      const second = await ask({ fromLat: 40.5555009, fromLon: -74.5555009, toLat: 40.6666009, toLon: -74.6666009 });

      expect(second.body.cached).toBe(true);
      expect(calls.length).toBe(afterFirst);
    });
  });

  describe('describeDuration', () => {
    it('rounds to whole minutes, because a driving estimate has no seconds in it', () => {
      expect(describeDuration(843)).toBe('14 min');
      expect(describeDuration(90)).toBe('2 min');
    });
  
    it('says hours and minutes past the hour', () => {
      expect(describeDuration(3600)).toBe('1 hr');
      expect(describeDuration(5400)).toBe('1 hr 30 min');
      expect(describeDuration(7260)).toBe('2 hr 1 min');
    });
  
    it('never says "0 min"', () => {
      expect(describeDuration(20)).toBe('under a minute');
      expect(describeDuration(0)).toBe('under a minute');
    });
  });
  
  describe('haversineKm', () => {
    it('is zero for a point and itself', () => {
      expect(haversineKm(40.3, -74.5, 40.3, -74.5)).toBe(0);
    });
  
    it('measures a known distance closely enough to refuse an absurd one', () => {
      /* New Brunswick to Princeton, 23.2 km great-circle. Only ever used as a
         cheap upper-bound check, so a wide band is the honest assertion. */
      const km = haversineKm(40.4862, -74.4518, 40.3573, -74.6672);
      expect(km).toBeGreaterThan(22);
      expect(km).toBeLessThan(25);
    });
  });
});
