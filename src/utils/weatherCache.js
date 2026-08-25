import { api } from './api';

/**
 * One forecast request per place-and-hour, however many components ask.
 *
 * ── Why a module-level cache and not component state ──
 *
 * The forecast is about to appear in more than one place at once — the event
 * modal and the dashboard's next-shift card can both be mounted for the same
 * shift. Each `WeatherSummary` used to own its own request, so N badges meant N
 * round trips for one answer.
 *
 * React also mounts effects twice in development StrictMode, and the modal
 * remounts every time it is opened, so even a single visible badge was not a
 * single request.
 *
 * ── Why the per-request AbortController had to go ──
 *
 * `WeatherSummary` aborted its in-flight request on unmount. That is correct for
 * a request nobody else is waiting on, and actively wrong the moment two
 * components share one: closing the modal would cancel the dashboard's forecast
 * out from under it, and the dashboard would silently render nothing. Sharing a
 * promise and having each consumer ignore a late result is the version that
 * composes.
 *
 * ── Why failures are cached too ──
 *
 * Without it, a 502 on a component that re-renders is a request per render. The
 * negative entry is short, so a genuine outage recovers on its own within a few
 * minutes without anybody reloading.
 */

const TTL_MS = 15 * 60 * 1000;
const NEGATIVE_TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 100;

/** key -> { at, value, failed } */
const results = new Map();
/** key -> Promise, for the window where a request is in flight */
const inflight = new Map();

/**
 * The identity of a forecast: a place, to about a hundred metres, and an hour.
 *
 * Three decimal places rather than the server's two. The client key must be at
 * least as fine as the server's or two genuinely different questions would
 * collapse into one answer locally that the server would have answered
 * separately. Finer is safe; coarser is not.
 */
export function weatherKey(latitude, longitude, datetime) {
  const d = new Date(datetime);
  if (Number.isNaN(d.getTime())) return null;
  /**
   * The hour is taken in UTC, and taken by SLICING rather than by rounding.
   *
   * This was `d.setMinutes(0, 0, 0)` before the `toISOString()` below.
   * `setMinutes` is a local-time setter and `toISOString` is UTC, so the pair
   * only agree where the offset is a whole number of hours. In a half-hour zone
   * — India, Adelaide, Newfoundland, Iran, Nepal at 45 minutes — zeroing the
   * local minutes leaves the UTC minutes at :30, and the buckets this produced
   * were an hour wide but aligned to the local hour, not the UTC one.
   *
   * That breaks the promise three lines above: "the client key must be at least
   * as fine as the server's". A bucket straddling two UTC hours is COARSER, so
   * two shifts the server would answer differently could collapse onto one
   * cached answer here — the badge on one event showing the other's forecast.
   *
   * `toISOString()` is UTC by definition and 13 characters is exactly
   * `YYYY-MM-DDTHH`, so the slice alone is the truncation. Nothing rounds, and
   * no local-time setter appears in this file.
   */
  return `${Number(latitude).toFixed(3)},${Number(longitude).toFixed(3)},${d.toISOString().slice(0, 13)}`;
}

function readCache(key) {
  const entry = results.get(key);
  if (!entry) return null;
  const ttl = entry.failed ? NEGATIVE_TTL_MS : TTL_MS;
  if (Date.now() - entry.at > ttl) {
    results.delete(key);
    return null;
  }
  return entry;
}

function writeCache(key, entry) {
  if (results.size >= MAX_ENTRIES) {
    /* Oldest insertion first: Map preserves insertion order, and a strict LRU
       would need a touch on every read for a cache this small. */
    const oldest = results.keys().next().value;
    results.delete(oldest);
  }
  results.set(key, { ...entry, at: Date.now() });
}

/**
 * The forecast for a point and an hour, or `null` if there isn't one.
 *
 * Never rejects. Every failure — no coordinates, a refused window, an outage, a
 * timeout — resolves to `null`, because every one of them means the same thing
 * to a caller: render no badge. A forecast is an enhancement, and an
 * enhancement that can throw is a page that can break.
 */
export async function getForecast(latitude, longitude, datetime) {
  if (latitude == null || longitude == null || !datetime) return null;

  const key = weatherKey(latitude, longitude, datetime);
  if (!key) return null;

  const cached = readCache(key);
  if (cached) return cached.failed ? null : cached.value;

  const existing = inflight.get(key);
  if (existing) return existing;

  const request = api
    .getWeather(latitude, longitude, datetime)
    .then((data) => {
      const value = data?.result ?? null;
      writeCache(key, value ? { value } : { failed: true });
      return value;
    })
    .catch(() => {
      writeCache(key, { failed: true });
      return null;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, request);
  return request;
}

/**
 * Whether a forecast could exist for this time at all.
 *
 * The server refuses more than a day in the past and more than fourteen days
 * ahead. Checking here means an event three weeks out never issues a request
 * that can only be refused — which matters because the dashboard and the
 * calendar are full of events three weeks out.
 */
export function isForecastable(datetime, now = Date.now()) {
  if (!datetime) return false;
  const t = new Date(datetime).getTime();
  if (Number.isNaN(t)) return false;
  const days = (t - now) / (24 * 3600 * 1000);
  return days >= -1 && days <= 14;
}

/** Test seam. Module state must not leak between cases. */
export function __resetWeatherCache() {
  results.clear();
  inflight.clear();
}
