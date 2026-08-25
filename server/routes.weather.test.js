import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { startTestServer } from './testServer.js';

/**
 * The weather proxy: who may call it, and what it asks Open-Meteo for.
 *
 * ── Why this file exists at all ──
 *
 * There were no weather tests. The route also had no `authenticateToken` and no
 * capability gate — only a rate limiter — so anyone on the internet could use
 * this application as a free cached weather proxy for any coordinate on earth.
 * Nothing would have noticed: an unauthenticated 200 looks exactly like a
 * working feature.
 *
 * The gate is `event.view` rather than `geocode.use` because students do not
 * hold `geocode.use`, and students are the entire audience for a forecast on an
 * event they are about to attend. Both the student 200 and the organizer 200
 * below are load-bearing: the first proves the gate is not too tight, the
 * second proves the organizer's location picker did not regress.
 */

const STUDENT = 'leo.chen@example.com';
const ORGANIZER = 'jordan.whitfield@example.org';

/** An hour that is inside the forecast window, on the hour, in UTC. */
function targetHour(daysFromNow = 2) {
  const d = new Date(Date.now() + daysFromNow * 24 * 3600 * 1000);
  d.setUTCMinutes(0, 0, 0);
  return d;
}

/** An Open-Meteo hourly series that contains `iso`'s hour and little else. */
function forecastCovering(iso, { code = 0, temp = 71.6, feels = 70.2 } = {}) {
  const hour = `${iso.slice(0, 13)}:00`;
  return {
    hourly: {
      time: [hour],
      temperature_2m: [temp],
      apparent_temperature: [feels],
      weather_code: [code],
    },
  };
}

describe('weather proxy', () => {
  let srv;
  let student;
  let organizer;
  let upstream;
  const originalFetch = global.fetch;

  beforeAll(async () => {
    srv = await startTestServer();
    student = await srv.login(STUDENT);
    organizer = await srv.login(ORGANIZER);
  }, 60000);

  afterAll(async () => {
    await srv?.close();
    global.fetch = originalFetch;
  });

  beforeEach(() => {
    upstream = vi.fn();
    /* The test's own HTTP request also goes through global fetch, so anything
       that is not Open-Meteo is handed straight back to the real one. */
    global.fetch = vi.fn(async (url, init) => {
      if (typeof url === 'string' && url.includes('open-meteo')) {
        return upstream(url, init);
      }
      return originalFetch(url, init);
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  /** A distinct coordinate per test, so the module-level cache cannot bleed. */
  let n = 0;
  const freshCoords = () => {
    n += 1;
    return { lat: 30 + n * 0.5, lon: -80 - n * 0.5 };
  };

  const ok = (body) => ({ ok: true, status: 200, json: async () => body });

  const get = (coords, when, session) =>
    srv.call(
      'GET',
      `/api/weather?lat=${coords.lat}&lon=${coords.lon}&datetime=${encodeURIComponent(when.toISOString())}`,
      undefined,
      session,
    );

  describe('authorization', () => {
    it('refuses an unauthenticated caller', async () => {
      const res = await get(freshCoords(), targetHour());
      expect(res.status).toBe(401);
      expect(upstream).not.toHaveBeenCalled();
    });

    it('serves a student, who is the whole point of the feature', async () => {
      const when = targetHour();
      upstream.mockResolvedValue(ok(forecastCovering(when.toISOString())));

      const res = await get(freshCoords(), when, student);
      expect(res.status).toBe(200);
      expect(res.body.result.temperature).toBe(72);
      expect(res.body.result.condition).toBe('Clear sky');
      expect(res.body.result.icon).toBe('Sun');
    });

    it('serves an organizer, so the location picker did not regress', async () => {
      const when = targetHour();
      upstream.mockResolvedValue(ok(forecastCovering(when.toISOString())));

      const res = await get(freshCoords(), when, organizer);
      expect(res.status).toBe(200);
      expect(res.body.result.temperature).toBe(72);
    });
  });

  /**
   * ── The hour asked for is the hour answered, in any server timezone ──
   *
   * The route built its lookup key with `targetDate.setMinutes(0, 0, 0)` — a
   * LOCAL-time setter — and then formatted it with `toISOString()`, which is
   * UTC. Those agree only where the server's offset is a whole number of hours.
   * Open-Meteo is asked with `timezone=UTC`, so `hourly.time` is UTC hours on
   * the hour, and in a half-hour zone the lookup went to the hour BEFORE the one
   * requested for every request whose UTC minutes were under :30.
   *
   * In production that is not a 404. Open-Meteo returns sixteen days of hourly
   * data, so the neighbouring hour is present and gets returned — a confidently
   * wrong temperature for the wrong hour. The cases above surface it as a 404
   * only because their mocked series holds nothing but the requested hour.
   *
   * Every other case in this file fails on a machine in such a zone and passes
   * everywhere else, which makes them a regression test that depends on who runs
   * it. These force the zone, so the rule is checked wherever the suite runs.
   */
  describe('the server\'s own timezone', () => {
    const ZONES = ['UTC', 'America/New_York', 'Asia/Kolkata', 'Australia/Adelaide', 'Asia/Kathmandu'];

    it.each(ZONES)('answers for the requested UTC hour in %s', async (tz) => {
      const original = process.env.TZ;
      process.env.TZ = tz;
      try {
        /* :05 past the hour, which is inside the half-hour window the broken
           version pushed onto the previous hour. */
        const when = targetHour();
        when.setUTCMinutes(5, 0, 0);
        const hourAsked = when.toISOString().slice(0, 13);

        upstream.mockResolvedValue(ok(forecastCovering(when.toISOString())));
        const res = await get(freshCoords(), when, student);

        expect(res.status, `${tz} missed the hour it asked for`).toBe(200);
        expect(res.body.result.temperature).toBe(72);

        /* And it asked Open-Meteo about that hour rather than a neighbour: the
           mocked series contains only `hourAsked`, so a 200 proves the match. */
        expect(forecastCovering(when.toISOString()).hourly.time[0]).toBe(`${hourAsked}:00`);
      } finally {
        process.env.TZ = original;
      }
    });
  });

  describe('coordinate precision', () => {
    it('asks Open-Meteo for two decimal places, not four', async () => {
      const when = targetHour();
      upstream.mockResolvedValue(ok(forecastCovering(when.toISOString())));

      await srv.call(
        'GET',
        `/api/weather?lat=40.386187&lon=-74.556042&datetime=${encodeURIComponent(when.toISOString())}`,
        undefined,
        student,
      );

      const url = upstream.mock.calls[0][0];
      expect(url).toContain('latitude=40.39');
      expect(url).toContain('longitude=-74.56');
    });

    it('shares one cache entry between two points in the same neighbourhood', async () => {
      const when = targetHour();
      upstream.mockResolvedValue(ok(forecastCovering(when.toISOString())));

      /* ~40 m apart. At four decimal places these were separate keys, so two
         events in one car park each paid for their own upstream request. */
      const a = await srv.call('GET', `/api/weather?lat=41.1234&lon=-75.1234&datetime=${encodeURIComponent(when.toISOString())}`, undefined, student);
      const b = await srv.call('GET', `/api/weather?lat=41.1238&lon=-75.1236&datetime=${encodeURIComponent(when.toISOString())}`, undefined, student);

      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(b.body.cached).toBe(true);
      expect(upstream).toHaveBeenCalledTimes(1);
    });
  });

  describe('input and window refusals, none of which reach upstream', () => {
    it('requires lat, lon and datetime', async () => {
      const res = await srv.call('GET', '/api/weather?lat=40.1', undefined, student);
      expect(res.status).toBe(400);
      expect(upstream).not.toHaveBeenCalled();
    });

    it('refuses non-numeric coordinates', async () => {
      const when = targetHour();
      const res = await srv.call('GET', `/api/weather?lat=north&lon=west&datetime=${encodeURIComponent(when.toISOString())}`, undefined, student);
      expect(res.status).toBe(400);
      expect(upstream).not.toHaveBeenCalled();
    });

    it('refuses an unparseable datetime', async () => {
      const c = freshCoords();
      const res = await srv.call('GET', `/api/weather?lat=${c.lat}&lon=${c.lon}&datetime=not-a-date`, undefined, student);
      expect(res.status).toBe(400);
      expect(upstream).not.toHaveBeenCalled();
    });

    it('refuses an event too far in the past', async () => {
      const res = await get(freshCoords(), targetHour(-3), student);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('past_event');
      expect(upstream).not.toHaveBeenCalled();
    });

    it('refuses an event beyond the forecast horizon', async () => {
      const res = await get(freshCoords(), targetHour(20), student);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('future_event');
      expect(upstream).not.toHaveBeenCalled();
    });
  });

  describe('upstream failures, which must never look like a forecast', () => {
    it('404s when the series has no row for that hour', async () => {
      const when = targetHour();
      upstream.mockResolvedValue(ok(forecastCovering(targetHour(3).toISOString())));

      const res = await get(freshCoords(), when, student);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('not_found');
    });

    it('502s when Open-Meteo answers with an error', async () => {
      upstream.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });

      const res = await get(freshCoords(), targetHour(), student);
      expect(res.status).toBe(502);
      expect(res.body.code).toBe('upstream_error');
    });

    it('504s when Open-Meteo does not answer in time', async () => {
      upstream.mockImplementation(async () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      });

      const res = await get(freshCoords(), targetHour(), student);
      expect(res.status).toBe(504);
      expect(res.body.code).toBe('timeout');
    });

    it('names an unmapped WMO code rather than guessing at it', async () => {
      const when = targetHour();
      upstream.mockResolvedValue(ok(forecastCovering(when.toISOString(), { code: 4242 })));

      const res = await get(freshCoords(), when, student);
      expect(res.status).toBe(200);
      expect(res.body.result.condition).toBe('Unknown conditions');
      expect(res.body.result.icon).toBe('Cloud');
    });

    it('maps a thunderstorm to its own icon', async () => {
      const when = targetHour();
      upstream.mockResolvedValue(ok(forecastCovering(when.toISOString(), { code: 95 })));

      const res = await get(freshCoords(), when, student);
      expect(res.body.result.condition).toBe('Thunderstorm');
      expect(res.body.result.icon).toBe('CloudLightning');
    });
  });
});
