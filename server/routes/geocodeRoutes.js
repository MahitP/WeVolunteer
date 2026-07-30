import express from 'express';
import { authenticateToken } from '../utils.js';
import { DEMO_MODE } from '../config.js';
import rateLimit from 'express-rate-limit';

const router = express.Router();

// --- In-memory cache ---
const CACHE_TTL = 60 * 60 * 1000; // 1 hour
const MAX_CACHE = 500;
const cache = new Map();

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { cache.delete(key); return null; }
  return entry.data;
}

function setCache(key, data) {
  // LRU: evict oldest when full
  if (cache.size >= MAX_CACHE) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  cache.set(key, { data, ts: Date.now() });
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
 * Server-side proxy for Nominatim geocoding. Organizers and admins only.
 * Never called by students. Central rate limiting, caching, and
 * response normalization.
 */
router.get('/api/geocode', geocodeLimiter, authenticateToken, async (req, res) => {
  // Role gate: only organizers and admins need geocoding
  if (req.user.role === 'student') {
    return res.status(403).json({ error: 'Access denied' });
  }

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
  const cached = getCached(cacheKey);
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

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(
      `https://nominatim.openstreetmap.org/search?${params}`,
      {
        headers: {
          'User-Agent': 'WeVolunteer/1.0 (volunteer-app; contact@wevolunteer.app)',
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

    setCache(cacheKey, results);
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
