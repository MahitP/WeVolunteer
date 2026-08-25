import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./api', () => ({ api: { getWeather: vi.fn() } }));

import { api } from './api';
import { getForecast, isForecastable, weatherKey, __resetWeatherCache } from './weatherCache';

const SOON = () => new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString();
const RESULT = { temperature: 72, feelsLike: 70, condition: 'Clear sky', icon: 'Sun' };

describe('weatherCache', () => {
  beforeEach(() => {
    __resetWeatherCache();
    vi.mocked(api.getWeather).mockReset();
  });

  describe('weatherKey', () => {
    it('collapses two points about a hundred metres apart', () => {
      const when = SOON();
      expect(weatherKey(40.3861, -74.5561, when)).toBe(weatherKey(40.38608, -74.55605, when));
    });

    it('keeps genuinely different places apart', () => {
      const when = SOON();
      expect(weatherKey(40.386, -74.556, when)).not.toBe(weatherKey(40.41, -74.59, when));
    });

    it('truncates to the hour, because a forecast is hourly', () => {
      const a = weatherKey(40.386, -74.556, '2026-08-20T14:05:00.000Z');
      const b = weatherKey(40.386, -74.556, '2026-08-20T14:55:00.000Z');
      expect(a).toBe(b);
    });

    it('separates different hours', () => {
      const a = weatherKey(40.386, -74.556, '2026-08-20T14:00:00.000Z');
      const b = weatherKey(40.386, -74.556, '2026-08-20T17:00:00.000Z');
      expect(a).not.toBe(b);
    });

    /**
     * ── The zone the machine happens to be in must not decide the answer ──
     *
     * The key was built with `d.setMinutes(0, 0, 0)` — a LOCAL-time setter —
     * and then formatted with `toISOString()`, which is UTC. Those agree only
     * where the offset is a whole number of hours, so the defect was invisible
     * in UTC and in every US and European zone, and real in India, Adelaide,
     * Newfoundland, Iran and Nepal. It was found by a suite run on a machine in
     * `Asia/Calcutta`; on the CI box it had always passed.
     *
     * The cases above still only fail in one of those zones, which makes them a
     * regression test nobody can rely on. These force the zone instead, so the
     * rule holds wherever the suite runs.
     *
     * Node re-reads `process.env.TZ` for each new `Date`, so the assignment is
     * enough; it is restored afterwards because the variable is process-wide and
     * every later case in this worker would inherit it.
     */
    describe('regardless of the machine\'s timezone', () => {
      const ZONES = [
        'UTC',
        'America/New_York',   // -04:00/-05:00 — whole hours, where this passed anyway
        'Asia/Kolkata',       // +05:30
        'Australia/Adelaide', // +09:30/+10:30
        'America/St_Johns',   // -02:30/-03:30
        'Asia/Kathmandu',     // +05:45
        'Pacific/Chatham',    // +12:45/+13:45
      ];

      const inZone = (tz, fn) => {
        const original = process.env.TZ;
        process.env.TZ = tz;
        try { return fn(); } finally { process.env.TZ = original; }
      };

      it.each(ZONES)('buckets on the UTC hour in %s', (tz) => {
        inZone(tz, () => {
          /* Every minute of one UTC hour, including the :30 and :45 boundaries
             the broken version straddled. */
          const keys = ['00', '05', '29', '30', '31', '45', '59'].map(
            (mm) => weatherKey(40.386, -74.556, `2026-08-20T14:${mm}:00.000Z`),
          );
          expect(new Set(keys).size, `${tz} split one UTC hour into ${new Set(keys).size} keys`).toBe(1);
          /* And it is the hour that was ASKED for, not a neighbouring one — a
             consistently wrong bucket would satisfy the assertion above. */
          expect(keys[0].endsWith('2026-08-20T14')).toBe(true);
        });
      });

      it.each(ZONES)('keeps adjacent UTC hours apart in %s', (tz) => {
        inZone(tz, () => {
          const a = weatherKey(40.386, -74.556, '2026-08-20T14:59:00.000Z');
          const b = weatherKey(40.386, -74.556, '2026-08-20T15:00:00.000Z');
          expect(a).not.toBe(b);
        });
      });
    });

    it('is null for an unparseable time rather than a key nothing can match', () => {
      expect(weatherKey(40.386, -74.556, 'whenever')).toBeNull();
    });
  });

  describe('isForecastable', () => {
    const now = Date.parse('2026-08-11T12:00:00.000Z');

    it('accepts an event inside the provider window', () => {
      expect(isForecastable('2026-08-13T12:00:00.000Z', now)).toBe(true);
    });

    it('refuses an event well in the past', () => {
      expect(isForecastable('2026-08-01T12:00:00.000Z', now)).toBe(false);
    });

    it('refuses an event beyond the horizon', () => {
      expect(isForecastable('2026-09-30T12:00:00.000Z', now)).toBe(false);
    });

    it('allows the tail of yesterday, which the server also allows', () => {
      expect(isForecastable('2026-08-10T18:00:00.000Z', now)).toBe(true);
    });

    it('is false for nothing at all', () => {
      expect(isForecastable(null, now)).toBe(false);
      expect(isForecastable('not a date', now)).toBe(false);
    });
  });

  describe('getForecast', () => {
    it('asks the server once and answers from memory after that', async () => {
      vi.mocked(api.getWeather).mockResolvedValue({ result: RESULT });
      const when = SOON();

      const a = await getForecast(40.386, -74.556, when);
      const b = await getForecast(40.386, -74.556, when);

      expect(a).toEqual(RESULT);
      expect(b).toEqual(RESULT);
      expect(api.getWeather).toHaveBeenCalledTimes(1);
    });

    it('shares one in-flight request between simultaneous callers', async () => {
      /* The reason the per-component AbortController had to go: the modal and
         the dashboard can want the same forecast at the same moment. */
      let resolve;
      vi.mocked(api.getWeather).mockReturnValue(new Promise((r) => { resolve = r; }));
      const when = SOON();

      const first = getForecast(40.386, -74.556, when);
      const second = getForecast(40.386, -74.556, when);
      resolve({ result: RESULT });

      expect(await first).toEqual(RESULT);
      expect(await second).toEqual(RESULT);
      expect(api.getWeather).toHaveBeenCalledTimes(1);
    });

    it('resolves to null rather than throwing when the server fails', async () => {
      vi.mocked(api.getWeather).mockRejectedValue(new Error('502'));

      await expect(getForecast(40.386, -74.556, SOON())).resolves.toBeNull();
    });

    it('remembers a failure briefly instead of retrying on every render', async () => {
      vi.mocked(api.getWeather).mockRejectedValue(new Error('502'));
      const when = SOON();

      await getForecast(40.386, -74.556, when);
      await getForecast(40.386, -74.556, when);

      expect(api.getWeather).toHaveBeenCalledTimes(1);
    });

    it('never calls the server without coordinates or a time', async () => {
      await getForecast(null, null, SOON());
      await getForecast(40.386, -74.556, null);

      expect(api.getWeather).not.toHaveBeenCalled();
    });
  });
});
