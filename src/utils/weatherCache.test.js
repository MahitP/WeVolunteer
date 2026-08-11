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
