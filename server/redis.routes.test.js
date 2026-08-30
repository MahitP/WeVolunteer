/**
 * The Redis layer as the routes actually use it.
 *
 * ── Why this is separate from the unit tests ──
 *
 * `redis.lookupCache.test.js` proves the cache is a cache. This proves the
 * *wiring*: that the weather and geocode routes really consult the shared tier,
 * that a warm shared tier spares the upstream call, and that an Upstash outage
 * degrades to exactly the behaviour those routes had before Redis existed —
 * through the real middleware stack, with real authentication and the real
 * capability gates.
 *
 * The distinction matters because every defect this could catch is a wiring
 * defect. A cache module that works perfectly and is never consulted looks
 * identical from the outside to one that is.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { startTestServer } from './testServer.js';
import { __resetRedisConfig } from './redis/redisConfig.js';
import { __resetRedisUsage, redisUsage } from './redis/redisClient.js';

const STUDENT = 'leo.chen@example.com';
const ORGANIZER = 'jordan.whitfield@example.org';

function targetHour(daysFromNow = 2) {
  const d = new Date(Date.now() + daysFromNow * 24 * 3600 * 1000);
  d.setUTCMinutes(0, 0, 0);
  return d;
}

function forecastCovering(iso) {
  return {
    hourly: {
      time: [`${iso.slice(0, 13)}:00`],
      temperature_2m: [71.6],
      apparent_temperature: [70.2],
      weather_code: [0],
    },
  };
}

describe('the routes that use Redis', () => {
  let srv;
  let student;
  let organizer;
  const originalFetch = global.fetch;

  /**
   * One fake standing in for both the vendor and Upstash.
   *
   * They are distinguished by URL, which is also the assertion: a request that
   * reaches `api.open-meteo.com` or `nominatim.openstreetmap.org` is an
   * upstream call the cache did not spare.
   *
   * Anything else goes to the REAL fetch, and that is load-bearing rather than
   * tidy: `srv.call` issues the test's own HTTP request through `global.fetch`
   * too, so a mock that swallowed everything would answer the test client
   * directly and no request would ever reach the server. Every assertion here
   * would then be measuring the mock. `routes.weather.test.js` records the same
   * trap.
   */
  function installFetch({ redis, upstreamBody, redisDown = false }) {
    const counts = { upstream: 0, redis: 0 };
    const isUpstream = (href) =>
      href.includes('open-meteo') || href.includes('nominatim.openstreetmap.org');

    global.fetch = vi.fn(async (url, init) => {
      const href = String(url);

      if (!href.includes('fake.upstash.io') && !isUpstream(href)) {
        return originalFetch(url, init);
      }

      if (href.includes('fake.upstash.io')) {
        counts.redis += 1;
        if (redisDown) throw new TypeError('fetch failed');
        const [name, key, value, , px] = JSON.parse(init.body);
        if (name === 'GET') {
          const entry = redis.get(key);
          const alive = entry && entry.expiresAt > Date.now();
          return new Response(JSON.stringify({ result: alive ? entry.value : null }), { status: 200 });
        }
        if (name === 'SET') {
          redis.set(key, { value, expiresAt: Date.now() + Number(px ?? 60_000) });
          return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
        }
        if (name === 'EVAL') {
          /* The Nominatim reservation. Always grants immediately here; its own
             arithmetic is covered in redis.upstreamThrottle.test.js. */
          return new Response(JSON.stringify({ result: 0 }), { status: 200 });
        }
        return new Response(JSON.stringify({ result: null }), { status: 200 });
      }

      counts.upstream += 1;
      return new Response(JSON.stringify(upstreamBody), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    });

    return counts;
  }

  beforeAll(async () => {
    srv = await startTestServer();
    student = await srv.login(STUDENT);
    organizer = await srv.login(ORGANIZER);
  }, 60000);

  afterAll(async () => {
    await srv?.close();
    global.fetch = originalFetch;
  });

  beforeEach(async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
    __resetRedisConfig();
    __resetRedisUsage();

    /* Both in-process tiers, cleared, so each case starts from a cold L1 and
       the shared tier is the thing being measured. */
    const { __clearWeatherCache } = await import('./routes/weatherRoutes.js');
    const { __clearGeocodeCache, __resetUpstreamThrottle } = await import('./routes/geocodeRoutes.js');
    __clearWeatherCache();
    __clearGeocodeCache();
    __resetUpstreamThrottle();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    __resetRedisConfig();
  });

  describe('the weather forecast', () => {
    it('a warm shared tier spares the upstream call after a restart', async () => {
      /* The whole reason Redis is in front of this route: L1 is empty after a
         deploy, and without a shared tier every forecast anybody looks at is
         fetched again. */
      const redis = new Map();
      const when = targetHour();
      const iso = when.toISOString();

      const first = installFetch({ redis, upstreamBody: forecastCovering(iso) });
      const warm = await srv.call('GET', `/api/weather?lat=34.42&lon=-119.70&datetime=${encodeURIComponent(iso)}`, undefined, student);
      expect(warm.status).toBe(200);
      expect(first.upstream).toBe(1);
      expect(redis.size).toBe(1);

      /* A fresh process: L1 gone, the shared tier still warm. */
      const { __clearWeatherCache } = await import('./routes/weatherRoutes.js');
      __clearWeatherCache();

      const second = installFetch({ redis, upstreamBody: forecastCovering(iso) });
      const afterDeploy = await srv.call('GET', `/api/weather?lat=34.42&lon=-119.70&datetime=${encodeURIComponent(iso)}`, undefined, student);
      expect(afterDeploy.status).toBe(200);
      expect(afterDeploy.body.cached).toBe(true);
      expect(second.upstream).toBe(0);
    });

    it('an Upstash outage is a cache miss, never an error', async () => {
      const when = targetHour();
      const iso = when.toISOString();
      const counts = installFetch({ redis: new Map(), upstreamBody: forecastCovering(iso), redisDown: true });

      const res = await srv.call('GET', `/api/weather?lat=34.42&lon=-119.70&datetime=${encodeURIComponent(iso)}`, undefined, student);
      expect(res.status).toBe(200);
      /* Degraded to exactly the pre-Redis behaviour: ask upstream. */
      expect(counts.upstream).toBe(1);
    });

    it('rounds the coordinate before it is used as a key, so no precise point is stored', async () => {
      /* COORD_PRECISION is 2 decimal places, about 1.1 km. The route's own
         comment records that the extra precision cost cache hits AND privacy:
         at 11 m a key names a building. */
      const redis = new Map();
      const when = targetHour();
      const iso = when.toISOString();

      installFetch({ redis, upstreamBody: forecastCovering(iso) });
      /* Rounds to (34.42, -119.70). */
      await srv.call('GET', `/api/weather?lat=34.4212345&lon=-119.7043210&datetime=${encodeURIComponent(iso)}`, undefined, student);

      const counts = installFetch({ redis, upstreamBody: forecastCovering(iso) });
      const { __clearWeatherCache } = await import('./routes/weatherRoutes.js');
      __clearWeatherCache();

      /* A point ~300 m away, which rounds to the same pair and is therefore the
         same key. Open-Meteo's model grid is 1-11 km, so the forecast returned
         is byte-identical — the extra precision bought nothing and cost both a
         cache hit and, at 11 m, the ability to name a building. */
      const near = await srv.call('GET', `/api/weather?lat=34.4198765&lon=-119.7012345&datetime=${encodeURIComponent(iso)}`, undefined, student);
      expect(near.status).toBe(200);
      expect(counts.upstream).toBe(0);
    });

    it('stores nothing identifying: every key is prefixed and hashed', async () => {
      const redis = new Map();
      const when = targetHour();
      const iso = when.toISOString();
      installFetch({ redis, upstreamBody: forecastCovering(iso) });
      await srv.call('GET', `/api/weather?lat=34.42&lon=-119.70&datetime=${encodeURIComponent(iso)}`, undefined, student);

      for (const key of redis.keys()) {
        expect(key).toMatch(/^wev:[a-z]+:cache:weather:[0-9a-f]{32}$/);
        expect(key).not.toContain('34.42');
        expect(key).not.toContain('119.70');
      }
    });
  });

  describe('the address lookup', () => {
    const NOMINATIM = [{
      lat: '34.4208', lon: '-119.6982', display_name: 'Santa Barbara, CA',
      address: { city: 'Santa Barbara', state: 'California', postcode: '93101' },
    }];

    it('a warm shared tier spares a request against a one-per-second policy', async () => {
      const redis = new Map();
      const first = installFetch({ redis, upstreamBody: NOMINATIM });
      const warm = await srv.call('GET', '/api/geocode?q=santa%20barbara%20city%20hall', undefined, organizer);
      expect(warm.status).toBe(200);
      expect(first.upstream).toBe(1);

      const { __clearGeocodeCache } = await import('./routes/geocodeRoutes.js');
      __clearGeocodeCache();

      const second = installFetch({ redis, upstreamBody: NOMINATIM });
      const afterDeploy = await srv.call('GET', '/api/geocode?q=santa%20barbara%20city%20hall', undefined, organizer);
      expect(afterDeploy.status).toBe(200);
      expect(afterDeploy.body.cached).toBe(true);
      expect(second.upstream).toBe(0);
    });

    it('never puts the typed query on the wire', async () => {
      /* A keyspace listing on a vendor console must not be a list of the
         addresses this district searched for. */
      const redis = new Map();
      installFetch({ redis, upstreamBody: NOMINATIM });
      await srv.call('GET', '/api/geocode?q=1421%20Maple%20Avenue', undefined, organizer);

      for (const key of redis.keys()) {
        expect(key).toMatch(/^wev:[a-z]+:cache:geocode:[0-9a-f]{32}$/);
        expect(key.toLowerCase()).not.toContain('maple');
        expect(key).not.toContain('1421');
      }
      for (const { value } of redis.values()) {
        expect(String(value).toLowerCase()).not.toContain('maple');
      }
    });

    it('an Upstash outage still answers, using the unchanged local throttle', async () => {
      const counts = installFetch({ redis: new Map(), upstreamBody: NOMINATIM, redisDown: true });
      const res = await srv.call('GET', '/api/geocode?q=santa%20barbara', undefined, organizer);
      expect(res.status).toBe(200);
      expect(counts.upstream).toBe(1);
    });

    it('is still gated: a student holds event.view but not geocode.use', async () => {
      /* The cache sits behind the capability gate, not in front of it, so a
         cached answer is never a way around authorization. */
      installFetch({ redis: new Map(), upstreamBody: NOMINATIM });
      const res = await srv.call('GET', '/api/geocode?q=santa%20barbara', undefined, student);
      expect(res.status).toBe(403);
    });
  });

  describe('quota accounting', () => {
    it('a cache hit in process memory costs no command at all', async () => {
      const redis = new Map();
      const when = targetHour();
      const iso = when.toISOString();
      installFetch({ redis, upstreamBody: forecastCovering(iso) });

      const url = `/api/weather?lat=34.42&lon=-119.70&datetime=${encodeURIComponent(iso)}`;
      await srv.call('GET', url, undefined, student);
      const afterFirst = redisUsage().commands;

      await srv.call('GET', url, undefined, student);
      await srv.call('GET', url, undefined, student);
      /* Three requests, one cold. The in-process tier is what keeps the free
         plan comfortable at every scale in docs/operations/upstash.md §7.3. */
      expect(redisUsage().commands).toBe(afterFirst);
    });
  });
});
