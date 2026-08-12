import express from 'express';
import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { authenticateToken } from '../utils.js';
import { requireCap } from '../authz.js';
import { DEMO_MODE, ROUTING_API_KEY } from '../config.js';

const router = express.Router();

/**
 * How long it takes to drive to a shift.
 *
 * ── What this is, and the thing it is deliberately not ──
 *
 * A **typical driving time**, not a live ETA. The provider below returns a
 * free-flow figure computed from the road network and speed limits: it does not
 * know that the parkway is backed up this afternoon. So the number is honest
 * about itself everywhere it appears — "about 14 min by car", never "arrive by
 * 3:47" and never a leave-by time.
 *
 * The live-traffic answer already ships and is better: the directions link hands
 * the destination to the maps app on the phone, which routes from where the
 * student actually is, in the mode they actually travel, with current traffic,
 * entirely on-device with nothing sent to us. That remains the primary
 * affordance. This adds a rough number to the page so somebody can tell "twenty
 * minutes away" from "an hour away" without leaving the app and losing their
 * place — a real question this product could not answer.
 *
 * ── Privacy, which is the whole design constraint ──
 *
 * The origin is a minor's location. That is a fact that cannot be engineered
 * away — a routing answer requires a starting point — so what is engineered is
 * everything around it:
 *
 *   - **Coarsened before it leaves this process.** Three decimal places, about
 *     110 m. The router snaps the origin to the nearest road segment anyway, so
 *     this costs nothing in accuracy and is the difference between naming a road
 *     and naming a house.
 *   - **Never persisted.** No column, no row, nowhere. `users` has no latitude
 *     or longitude and `directory.privacy.test.js` asserts that as an invariant.
 *   - **Never logged.** Not in access logs, not in the audit trail, not in an
 *     error message. The catch block below records the failure and not the
 *     coordinates, and there is a test that breaks if that changes.
 *   - **Never in a URL.** The upstream call is a POST with a JSON body, so no
 *     origin appears in a query string that a proxy or an access log would
 *     capture in passing.
 *   - **The key never reaches the browser.** That is the reason this route
 *     exists rather than the client calling the provider: an API key shipped to
 *     a browser is a published API key. It also means no CSP change — the
 *     browser only ever talks to this server.
 *
 * The in-memory cache is keyed on the coarsened pair, which makes it a record of
 * road-to-road journeys rather than of people. It is process-local and dies with
 * the process.
 *
 * ── When it is not available ──
 *
 * With no key configured this route returns 503 `routing_unconfigured` and the
 * client renders nothing, falling back to the directions link that has always
 * been there. That is the expected state for a pilot that has not signed up for
 * a provider, and it must stay a silent degradation rather than an error the
 * student has to read.
 */

/**
 * ~110 m.
 *
 * Enough for a router that snaps to roads, not enough to identify a front door.
 * Note this is deliberately FINER than the 2dp the weather proxy uses and the
 * browse filter sends: a forecast is identical across a 1.1 km grid square, a
 * route is not.
 */
const ORIGIN_PRECISION = 3;

/** Long enough to be worth having, short enough that a road closure ages out. */
const CACHE_TTL = 6 * 60 * 60 * 1000;
const MAX_CACHE = 500;
const cache = new Map();

/** Beyond this a driving time stops being the question somebody is asking. */
const MAX_DISTANCE_KM = 200;

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { cache.delete(key); return null; }
  return entry.data;
}

function setCache(key, data) {
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
  cache.set(key, { data, ts: Date.now() });
}

/**
 * Test seam, and the reason the cache is not reached into from outside.
 *
 * Same role as `__hashToken` in `checkinTokens.js`. Without it a test asserting
 * what the provider was sent silently passes on a cache hit from the test
 * before it, having called nothing at all.
 */
export function __clearCache() {
  cache.clear();
}

/** Straight-line kilometres, used only to refuse absurd requests cheaply. */
export function haversineKm(aLat, aLon, bLat, bLon) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Keyed on a hash of the user id, never on the address.
 *
 * `app.js` records the incident this exists because of: a school NATs its whole
 * campus behind one address, so an IP-keyed limiter locked out a building. Two
 * organizers at one school must not share a budget, and neither must thirty
 * students in one classroom all opening the same event.
 */
const travelLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: DEMO_MODE ? 300 : (Number(process.env.TRAVEL_TIME_RATE_LIMIT) || 60),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => crypto.createHash('sha256')
    .update(String(req.user?.id ?? req.principal?.id ?? 'anonymous')).digest('hex'),
  handler: (req, res) => res.status(429).json({
    error: 'Too many travel-time requests. Please wait a moment.',
    code: 'rate_limited',
  }),
});

/**
 * @param {number} seconds
 * @returns {string} a duration a person would say out loud
 */
export function describeDuration(seconds) {
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (rest === 0) return `${hours} hr`;
  return `${hours} hr ${rest} min`;
}

/**
 * Driving time from a point to a point.
 *
 * `event.view` for the same reason the weather proxy uses it: students are the
 * entire audience and do not hold `geocode.use`, and the travel time to an event
 * is a property of an event you are permitted to see.
 *
 * Limiter first, so an unauthenticated flood is refused before it costs a JWT
 * verification; `authenticateToken` before `requireCap`, which reads
 * `req.principal`. Same order as `geocodeRoutes` and `weatherRoutes`.
 *
 * POST rather than GET, and that is a privacy decision rather than a REST one: a
 * GET would put a child's coordinates in a query string, where every proxy,
 * access log and browser history along the way keeps a copy. It creates nothing
 * and is safe to repeat.
 */
router.post('/api/travel-time', travelLimiter, authenticateToken, requireCap('event.view'), async (req, res) => {
  if (!ROUTING_API_KEY) {
    /* The expected state for a deployment that has not signed up for a
       provider. The client renders nothing and the directions link, which needs
       no provider at all, carries on working. */
    return res.status(503).json({ error: 'Travel times are not available.', code: 'routing_unconfigured' });
  }

  const { fromLat, fromLon, toLat, toLon } = req.body ?? {};
  const nums = [fromLat, fromLon, toLat, toLon].map(Number);
  if (nums.some(n => !Number.isFinite(n))) {
    return res.status(400).json({ error: 'Four coordinates are required.', code: 'coordinates_required' });
  }
  const [oLat, oLon, dLat, dLon] = nums;
  if (Math.abs(oLat) > 90 || Math.abs(dLat) > 90 || Math.abs(oLon) > 180 || Math.abs(dLon) > 180) {
    return res.status(400).json({ error: 'Those coordinates are not on Earth.', code: 'coordinates_invalid' });
  }

  /* Coarsened once, then used for the key AND the upstream call, so the thing
     cached is exactly the thing that was asked — and so there is no path where
     the full-precision value reaches the provider. */
  const qOLat = Number(oLat.toFixed(ORIGIN_PRECISION));
  const qOLon = Number(oLon.toFixed(ORIGIN_PRECISION));
  const qDLat = Number(dLat.toFixed(ORIGIN_PRECISION));
  const qDLon = Number(dLon.toFixed(ORIGIN_PRECISION));

  if (haversineKm(qOLat, qOLon, qDLat, qDLon) > MAX_DISTANCE_KM) {
    return res.status(422).json({ error: 'That is too far for a driving estimate.', code: 'too_far' });
  }

  const cacheKey = `${qOLat},${qOLon}>${qDLat},${qDLon}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json({ result: cached, cached: true });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch('https://api.openrouteservice.org/v2/directions/driving-car', {
      method: 'POST',
      headers: {
        Authorization: ROUTING_API_KEY,
        'Content-Type': 'application/json',
        'User-Agent': 'WeVolunteer/1.0 (volunteer-app; contact@wevolunteer.app)',
      },
      /* Longitude first — the provider takes GeoJSON order, and reversing it
         silently returns a route between two other places rather than an
         error. */
      body: JSON.stringify({ coordinates: [[qOLon, qOLat], [qDLon, qDLat]] }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) throw new Error(`routing provider returned ${response.status}`);

    const data = await response.json();
    const summary = data?.routes?.[0]?.summary;
    if (!summary || !Number.isFinite(summary.duration)) {
      return res.status(404).json({ error: 'No driving route was found.', code: 'no_route' });
    }

    const result = {
      seconds: Math.round(summary.duration),
      label: describeDuration(summary.duration),
      /* Named so no reader mistakes it for a live figure. */
      trafficAware: false,
    };
    setCache(cacheKey, result);
    return res.json({ result });
  } catch (err) {
    clearTimeout(timeout);
    /**
     * The message and NOTHING else.
     *
     * No coordinates, no user id, no cache key — a log line is durable, greppable
     * and frequently shipped somewhere else, and a student's origin must not be
     * in it. `err.message` here is our own string or the provider's status.
     */
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'The travel-time request timed out.', code: 'timeout' });
    }
    console.error('Travel-time proxy error:', err.message);
    return res.status(502).json({ error: 'Unable to reach the routing service.', code: 'upstream_error' });
  }
});

export default router;
