import express from 'express';
import rateLimit from 'express-rate-limit';
import { authenticateToken } from '../utils.js';
import { requireCap } from '../authz.js';
import { DEMO_MODE } from '../config.js';
import { createLookupCache } from '../redis/lookupCache.js';

const router = express.Router();

/**
 * How precisely a coordinate is used, for the upstream call and the cache key.
 *
 * Two decimal places is about 1.1 km. Open-Meteo's model grid is 1–11 km, so
 * the forecast this returns is byte-identical to what four decimal places
 * returns — the extra precision bought nothing and cost twice.
 *
 * It cost cache hits: at four decimal places (~11 m) two events at opposite
 * ends of one car park are different keys, so a shift and the event listing it
 * belongs to each paid for their own upstream request.
 *
 * And it cost privacy. The cache key is a record of which points somebody
 * looked up, and at 11 m resolution that is a record of buildings. At 1.1 km it
 * is a record of neighbourhoods, which is all a forecast ever needed.
 */
const COORD_PRECISION = 2;

/**
 * The forecast cache: in-process first, Redis behind it.
 *
 * ── Why this one is worth a network round trip when a database query is not ──
 *
 * The alternative to a hit here is not a 0.4 ms query; it is a request to
 * api.open-meteo.com, which is somebody else's server and somebody else's
 * capacity. The in-process tier still answers the common case — many students
 * opening the same event — at zero cost, and Redis exists for the one thing it
 * cannot do: survive a deploy. Without it, every release re-fetches every
 * forecast anybody looks at.
 *
 * ── Why there is no privacy question here, unlike travel time ──
 *
 * The key is a coordinate rounded to two decimal places (~1.1 km, see
 * COORD_PRECISION above) and a UTC hour. At that resolution it is a record of
 * neighbourhoods and not of people, it is derived from an EVENT's published
 * location rather than from a user, and the same value is returned to everyone.
 * `routes/travelRoutes.js` is the opposite case on every one of those points,
 * and is deliberately not a caller here.
 */
const CACHE_TTL = 60 * 60 * 1000; // 1 hour
const MAX_CACHE = 1000;
const forecastCache = createLookupCache({ domain: 'weather', ttlMs: CACHE_TTL, maxLocal: MAX_CACHE });

/** Test seam: drops the in-process tier between cases. */
export function __clearWeatherCache() {
  forecastCache.__clearLocal();
}

/** Counters for the operator status panel. No coordinates, no keys. */
export function weatherCacheStats() {
  return forecastCache.stats();
}

// --- Rate limiter ---
const weatherLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: DEMO_MODE ? 500 : 100,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too many weather requests. Please wait a moment.',
      code: 'rate_limited'
    });
  }
});

// WMO weather code mapping to human readable strings and lucide icon names
const WMO_MAP = {
  0: { label: 'Clear sky', icon: 'Sun' },
  1: { label: 'Mainly clear', icon: 'Sun' },
  2: { label: 'Partly cloudy', icon: 'CloudSun' },
  3: { label: 'Overcast', icon: 'Cloud' },
  45: { label: 'Fog', icon: 'CloudFog' },
  48: { label: 'Depositing rime fog', icon: 'CloudFog' },
  51: { label: 'Light drizzle', icon: 'CloudDrizzle' },
  53: { label: 'Moderate drizzle', icon: 'CloudDrizzle' },
  55: { label: 'Dense drizzle', icon: 'CloudDrizzle' },
  56: { label: 'Light freezing drizzle', icon: 'CloudDrizzle' },
  57: { label: 'Dense freezing drizzle', icon: 'CloudDrizzle' },
  61: { label: 'Slight rain', icon: 'CloudRain' },
  63: { label: 'Moderate rain', icon: 'CloudRain' },
  65: { label: 'Heavy rain', icon: 'CloudRain' },
  66: { label: 'Light freezing rain', icon: 'CloudRain' },
  67: { label: 'Heavy freezing rain', icon: 'CloudRain' },
  71: { label: 'Slight snow', icon: 'CloudSnow' },
  73: { label: 'Moderate snow', icon: 'CloudSnow' },
  75: { label: 'Heavy snow', icon: 'CloudSnow' },
  77: { label: 'Snow grains', icon: 'CloudSnow' },
  80: { label: 'Slight rain showers', icon: 'CloudRain' },
  81: { label: 'Moderate rain showers', icon: 'CloudRain' },
  82: { label: 'Violent rain showers', icon: 'CloudLightning' },
  85: { label: 'Slight snow showers', icon: 'CloudSnow' },
  86: { label: 'Heavy snow showers', icon: 'CloudSnow' },
  95: { label: 'Thunderstorm', icon: 'CloudLightning' },
  96: { label: 'Thunderstorm with slight hail', icon: 'CloudLightning' },
  99: { label: 'Thunderstorm with heavy hail', icon: 'CloudLightning' }
};

/**
 * Forecast for a point and an hour.
 *
 * ── Why this is gated, when it once was not ──
 *
 * This route carried the rate limiter and nothing else: no `authenticateToken`,
 * no capability. Anyone on the internet could use the application as a free,
 * cached weather proxy for any coordinate on earth, and the only cost to them
 * was 100 requests per fifteen minutes per address.
 *
 * `event.view` rather than `geocode.use`, because students do not hold
 * `geocode.use` — it is an organizer/admin/partner capability for the address
 * search behind the location picker — and students are the entire audience for
 * a forecast on an event they are about to attend. `event.view` is also the
 * honest name for it: the forecast is a property of an event you are permitted
 * to see.
 *
 * Order matters. The limiter runs first so an unauthenticated flood is refused
 * before it costs a JWT verification and a database read; `authenticateToken`
 * runs before `requireCap` because the capability gate reads `req.principal`.
 * This is the same order `geocodeRoutes` uses.
 */
router.get('/api/weather', weatherLimiter, authenticateToken, requireCap('event.view'), async (req, res) => {
  const { lat, lon, datetime } = req.query;
  
  if (!lat || !lon || !datetime) {
    return res.status(400).json({ error: 'lat, lon, and datetime are required' });
  }

  const latitude = parseFloat(lat);
  const longitude = parseFloat(lon);

  if (isNaN(latitude) || isNaN(longitude)) {
    return res.status(400).json({ error: 'Invalid coordinates' });
  }

  const targetDate = new Date(datetime);
  if (isNaN(targetDate.getTime())) {
    return res.status(400).json({ error: 'Invalid datetime' });
  }

  /**
   * The UTC hour being asked about, e.g. "2024-06-15T10".
   *
   * ── The bug this replaces ──
   *
   * It was `targetDate.setMinutes(0, 0, 0)` followed by `toISOString()`.
   * `setMinutes` is a LOCAL-time setter and `toISOString` is UTC, so the two
   * only agree when the server's zone is a whole number of hours from UTC. In a
   * half-hour zone — India, Adelaide, Newfoundland, Iran, and Nepal at 45
   * minutes — zeroing the local minutes leaves the UTC minutes at :30, and the
   * slice below then truncates to the WRONG hour.
   *
   * Open-Meteo is asked with `timezone=UTC`, so `hourly.time` is a list of UTC
   * hours on the hour. The lookup therefore matched the hour BEFORE the one
   * requested for any request whose UTC minutes were under :30 — roughly half of
   * them — and returned that forecast as though it were the answer. Not a 404: a
   * confidently wrong temperature for the wrong hour, on a deployment in one of
   * those zones. `routes.weather.test.js` catches it because its mocked series
   * holds only the requested hour, so the miss surfaces as a 404 instead.
   *
   * ── Why there is no rounding step now ──
   *
   * There never needed to be one. `toISOString()` is UTC by definition and
   * slicing at 13 characters IS the truncation to the hour, so the mutation was
   * redundant as well as wrong. Removing it rather than switching to
   * `setUTCMinutes` also leaves `targetDate` holding the instant that was
   * actually requested, which is what the forecast-window check below should be
   * measuring — it was previously measuring a rounded one.
   */
  const targetIso = targetDate.toISOString().slice(0, 13);
  
  /* Rounded once, then used for both the key and the upstream call, so the
     thing cached is exactly the thing that was asked for. */
  const qLat = Number(latitude.toFixed(COORD_PRECISION));
  const qLon = Number(longitude.toFixed(COORD_PRECISION));

  const cacheKey = `${qLat}_${qLon}_${targetIso}`;
  const cached = await forecastCache.get(cacheKey);

  if (cached) {
    return res.json({ result: cached, cached: true });
  }

  try {
    const now = new Date();
    const daysDiff = (targetDate.getTime() - now.getTime()) / (1000 * 3600 * 24);
    
    if (daysDiff < -1) {
      return res.status(400).json({ error: 'Cannot fetch weather for past events', code: 'past_event' });
    }
    if (daysDiff > 14) {
      return res.status(400).json({ error: 'Forecast unavailable this far in advance', code: 'future_event' });
    }

    const params = new URLSearchParams({
      latitude: String(qLat),
      longitude: String(qLon),
      hourly: 'temperature_2m,apparent_temperature,weather_code',
      temperature_unit: 'fahrenheit',
      timezone: 'UTC',
      forecast_days: '16'
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, {
      headers: { 'User-Agent': 'WeVolunteer/1.0 (volunteer-app; contact@wevolunteers.org)' },
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`Open-Meteo returned ${response.status}`);
    }

    const data = await response.json();
    
    const times = data.hourly.time;
    const targetMatchString = `${targetIso}:00`;
    
    const index = times.findIndex(t => t === targetMatchString);
    
    if (index === -1) {
      return res.status(404).json({ error: 'No forecast available for this specific time', code: 'not_found' });
    }

    const temp = data.hourly.temperature_2m[index];
    const feelsLike = data.hourly.apparent_temperature[index];
    const code = data.hourly.weather_code[index];
    
    const wmo = WMO_MAP[code] || { label: 'Unknown conditions', icon: 'Cloud' };

    const result = {
      temperature: Math.round(temp),
      feelsLike: Math.round(feelsLike),
      condition: wmo.label,
      icon: wmo.icon
    };

    await forecastCache.set(cacheKey, result);
    res.json({ result });
    
  } catch (err) {
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'Weather request timed out', code: 'timeout' });
    }
    console.error('Weather proxy error:', err.message);
    res.status(502).json({ error: 'Unable to reach weather service', code: 'upstream_error' });
  }
});

export default router;
