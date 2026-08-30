import express from 'express';
import { authenticateToken } from '../utils.js';
import { requireCap } from '../authz.js';
import { DEMO_MODE } from '../config.js';
import rateLimit from 'express-rate-limit';
import { createLookupCache } from '../redis/lookupCache.js';
import { reserveSharedUpstreamSlot } from '../redis/upstreamThrottle.js';

const router = express.Router();

/**
 * The address cache: in-process first, Redis behind it.
 *
 * ── Why this one earns a network round trip ──
 *
 * The alternative to a hit is a request to Nominatim, which this application is
 * permitted to make at most once per second IN TOTAL (see below), and whose
 * operators can withdraw that permission from every school at once. The
 * in-process tier answers repeats for free; Redis exists for the one thing it
 * cannot do — survive a deploy. Emptying a five-hundred-entry cache on every
 * release and re-warming it at one request per second is minutes of avoidable
 * pressure against somebody else's published policy.
 *
 * ── What is stored, and what is not ──
 *
 * The value is a normalised list of public places. The key is the query
 * somebody typed, and it is HASHED before it reaches Redis — a keyspace listing
 * on a vendor console should not be a list of the addresses this district
 * searched for. The route is gated on `geocode.use`, which students do not
 * hold, so these are organizers looking up event venues rather than anybody
 * looking up a home.
 *
 * Twenty-four hours rather than the one hour this cache used to keep. An
 * address does not move, and the shorter TTL was chosen when the cache was
 * process-local and died on every restart anyway.
 */
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
const MAX_CACHE = 500;
const addressCache = createLookupCache({ domain: 'geocode', ttlMs: CACHE_TTL, maxLocal: MAX_CACHE });

/** Test seam: drops the in-process tier between cases. */
export function __clearGeocodeCache() {
  addressCache.__clearLocal();
}

/** Counters for the operator status panel. No queries, no keys. */
export function geocodeCacheStats() {
  return addressCache.stats();
}

// --- Rate limiter ---
const geocodeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: DEMO_MODE ? 200 : 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too many geocoding requests. Please wait a moment and try again.',
      code: 'rate_limited'
    });
  }
});

/**
 * The application-wide throttle in front of Nominatim (TD-19).
 *
 * ── Why the per-IP limiter above is not this ──
 *
 * `geocodeLimiter` bounds how much ONE CLIENT may ask for. The Nominatim usage
 * policy bounds how much THIS APPLICATION may ask for: an absolute maximum of
 * one request per second, in total, across every user. Those are different
 * jobs, so this is a second control rather than a change to the first — a
 * handful of organizers on different networks each stayed inside thirty a
 * minute while the application as a whole went well past one a second.
 *
 * ── Why a reservation and not a promise chain ──
 *
 * Chaining each request onto the last serialises correctly but queues without
 * bound: the two-hundredth caller waits two hundred seconds, for a client that
 * closed the tab three minutes ago. Reserving a timestamp lets the handler ask
 * "how long would I wait?" BEFORE it waits, and refuse with the 429 this route
 * already returns — a shape the client already understands.
 *
 * Process-local state is genuinely application-wide state here: `instanceLock`
 * refuses to boot a second production instance against one database, and that
 * file names multiplied rate limits as the reason it exists.
 *
 * The constants are not operator tunables. One request per second is somebody
 * else's published policy, not a knob, so it is not read from the environment.
 *
 * @see https://operations.osmfoundation.org/policies/nominatim/
 */
const NOMINATIM_MIN_INTERVAL_MS = 1000;
const NOMINATIM_MAX_WAIT_MS = 3000;
let nextUpstreamSlotAt = 0;

/**
 * Claims the next upstream slot.
 *
 * @returns {number|null} milliseconds to wait before calling, or `null` when
 *   the queue is already deeper than a caller should be asked to sit through.
 *   A `null` return reserves nothing, so refusing does not push the queue out
 *   further for everyone behind it.
 */
/**
 * Exported as a test seam.
 *
 * The `now` parameter has always been injectable; the function simply was not
 * reachable, so the only way to test the throttle was to measure elapsed wall
 * time — a real `setTimeout(1000)` asserted with `>= 1000`, which a coarsened
 * or slightly early clock reports as 999 under load. That was the flake, and it
 * was the slowest test in the suite for a property that is pure arithmetic.
 */
export function reserveUpstreamSlot(now = Date.now()) {
  const at = Math.max(now, nextUpstreamSlotAt);
  if (at - now > NOMINATIM_MAX_WAIT_MS) return null;
  nextUpstreamSlotAt = at + NOMINATIM_MIN_INTERVAL_MS;
  return at - now;
}

/** Test seam: the bucket is module state and suites must not inherit each other's. */
export function __resetUpstreamThrottle() {
  nextUpstreamSlotAt = 0;
}

/**
 * Formats a Nominatim address object into a single-line string.
 * Picks the most useful fields and joins them.
 */
function formatAddress(addr) {
  if (!addr) return '';
  const parts = [];
  // Street-level
  const road = [addr.house_number, addr.road].filter(Boolean).join(' ');
  if (road) parts.push(road);
  // City-level
  const city = addr.city || addr.town || addr.village || addr.hamlet || '';
  if (city) parts.push(city);
  // State
  if (addr.state) parts.push(addr.state);
  // Postal code
  if (addr.postcode) parts.push(addr.postcode);
  return parts.join(', ');
}

/**
 * GET /api/geocode?q=<query>
 *
 * Server-side proxy for Nominatim geocoding, gated on `geocode.use`, with
 * caching and response normalisation.
 *
 * ── Two limits, doing two different jobs (TD-19, resolved) ──
 *
 * `geocodeLimiter` is per client IP — thirty a minute each — and bounds how
 * much one client may ask for. `reserveUpstreamSlot` is application-wide and
 * bounds how much WeVolunteer may ask Nominatim for, which its usage policy
 * caps at one request per second in total.
 *
 * Only the first of those existed, and this comment used to claim "central rate
 * limiting" — which is why the gap survived a read. Anyone checking whether the
 * policy was honoured found a sentence saying yes.
 *
 * The cache is still the first line and does most of the work: a repeat lookup
 * of the same address never leaves the process, and never reaches the throttle.
 *
 * The consequence of getting this wrong is not a 500 — it is OSM blocking this
 * application's User-Agent, which removes address lookup for every school at
 * once, and is slow to reverse.
 */
router.get('/api/geocode', geocodeLimiter, authenticateToken, requireCap('geocode.use'), async (req, res) => {
  const raw = req.query.q;
  if (!raw || typeof raw !== 'string') {
    return res.status(400).json({ error: 'Query parameter q is required' });
  }

  const query = raw.trim();
  if (query.length < 2) {
    return res.status(400).json({ error: 'Query must be at least 2 characters' });
  }
  if (query.length > 200) {
    return res.status(400).json({ error: 'Query must be 200 characters or fewer' });
  }

  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  const hasLoc = !isNaN(lat) && !isNaN(lon);

  // Include location bias in cache key if present
  const cacheKey = query.toLowerCase() + (hasLoc ? `|${lat},${lon}` : '');
  const cached = await addressCache.get(cacheKey);
  if (cached) {
    return res.json({ results: cached, cached: true });
  }

  try {
    const params = new URLSearchParams({
      q: query,
      format: 'json',
      addressdetails: '1',
      limit: '5'
    });

    if (hasLoc) {
      // Create a bounding box roughly ~35 miles around the user
      const left = lon - 0.5;
      const right = lon + 0.5;
      const top = lat + 0.5;
      const bottom = lat - 0.5;
      params.append('viewbox', `${left},${top},${right},${bottom}`);
      params.append('bounded', '1');
    }

    /* After the cache check, so a hit never waits, and before the fetch, so
       nothing reaches Nominatim faster than its policy allows.

       Two reservations, and BOTH must grant. The process-local one is
       unchanged and remains the only one that exists without Redis. The shared
       one extends the same guarantee across restarts and across instances,
       which is what the policy actually asks for — it is an obligation on this
       application, not on this process. Taking the longer of the two waits is
       the conservative direction: over-throttling costs a caller a second,
       while under-throttling risks OSM blocking the User-Agent for every
       school at once. */
    const localWaitMs = reserveUpstreamSlot();
    const sharedWaitMs = localWaitMs === null
      ? null
      : await reserveSharedUpstreamSlot({
        name: 'nominatim',
        intervalMs: NOMINATIM_MIN_INTERVAL_MS,
        maxWaitMs: NOMINATIM_MAX_WAIT_MS,
      });
    const waitMs = localWaitMs === null || sharedWaitMs === null
      ? null
      : Math.max(localWaitMs, sharedWaitMs);
    if (waitMs === null) {
      return res.status(429).json({
        error: 'Address lookup is busy right now. Try again in a moment.',
        code: 'rate_limited'
      });
    }
    if (waitMs > 0) {
      await new Promise(resolve => setTimeout(resolve, waitMs));
      /* The caller may have given up during the wait. The slot is already spent
         either way — releasing it would let the next caller jump the interval. */
      if (req.destroyed) return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(
      `https://nominatim.openstreetmap.org/search?${params}`,
      {
        headers: {
          'User-Agent': 'WeVolunteer/1.0 (volunteer-app; contact@wevolunteers.org)',
          'Accept': 'application/json'
        },
        signal: controller.signal
      }
    );

    clearTimeout(timeout);

    if (!response.ok) {
      const status = response.status;
      if (status === 429) {
        return res.status(429).json({
          error: 'Geocoding service is rate limited. Please try again shortly.',
          code: 'upstream_rate_limited'
        });
      }
      return res.status(502).json({
        error: 'Geocoding service is temporarily unavailable.',
        code: 'upstream_error'
      });
    }

    const raw = await response.json();

    const results = raw.map(item => ({
      displayName: item.name || item.display_name?.split(',')[0] || '',
      address: formatAddress(item.address) || item.display_name || '',
      latitude: parseFloat(item.lat),
      longitude: parseFloat(item.lon)
    }));

    await addressCache.set(cacheKey, results);
    res.json({ results });
  } catch (err) {
    if (err.name === 'AbortError') {
      return res.status(504).json({
        error: 'Geocoding request timed out. Please try again.',
        code: 'timeout'
      });
    }
    console.error('Geocode proxy error:', err.message);
    res.status(502).json({
      error: 'Unable to reach geocoding service.',
      code: 'upstream_error'
    });
  }
});

export default router;
