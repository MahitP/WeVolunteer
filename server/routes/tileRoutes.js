import express from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { authenticateToken } from '../utils.js';
import { requireCap } from '../authz.js';
import { readFileSync } from 'node:fs';
import { DEMO_MODE } from '../config.js';
import { ADDRESSES, BRAND } from '../emailIdentity.js';

/**
 * Map tiles, served through this application instead of fetched by the browser.
 *
 * ── Why this exists ──
 *
 * Two things were wrong with the student's browser fetching tiles from CARTO
 * directly, and the second made the first urgent.
 *
 *   1. It was the one place in the product where a third party saw a student's
 *      IP address and roughly which neighbourhood they were looking at — every
 *      other outside lookup (geocoding, weather, travel time) is already made by
 *      the server. The compliance register records it as R-18 and names a
 *      server-side proxy, "mirrors how Nominatim and Open-Meteo are already
 *      handled", as the fix. Click-to-load was the interim.
 *   2. CARTO began requiring an API key for its basemaps. Without one every tile
 *      comes back with "API KEY REQUIRED" printed across it, at every zoom, in
 *      both styles — so every event map in production was defaced. Observed on
 *      2026-09-13 by downloading tiles, not inferred.
 *
 * A key in the browser bundle is readable by anybody; a key on the server is
 * not. So the key, if there is one, lives here.
 *
 * ── Which upstream ──
 *
 * `MAP_TILES_CARTO_KEY` set: CARTO Voyager (light) and dark_all (dark), the
 * basemaps the product was designed around. CARTO's free key covers
 * non-commercial use up to five million tiles a month.
 *
 * Unset: the OpenStreetMap standard tiles, which need no key. OSM's tile policy
 * asks for an identifying User-Agent, caching, attribution and light use; this
 * sends the first, the Cache-Control below lets Cloudflare and the browser do the
 * second, the client renders the third, and a school's usage is the fourth.
 * OSM has no dark style, so the client dims the light one in dark mode.
 *
 * ── Why a session (and `event.view`, as the weather and travel proxies ask) is
 * required, and Cloudflare may still cache ──
 *
 * The tiles are public cartography, so a cached copy served to anyone is
 * harmless. What must not exist is an open relay: without a session check,
 * anybody could walk the whole world through this server, spending its egress
 * and getting it banned upstream. Requiring a session on the origin means an
 * uncached tile is only ever fetched on behalf of a member, while the edge is
 * still free to cache what members have already loaded — which is what keeps
 * the egress at $0.
 */

const router = express.Router();

/** Styles the client may ask for. Anything else is a 404, not an upstream call. */
const THEMES = new Set(['light', 'dark']);

/** OSM's standard tiles stop at 19; CARTO's raster basemaps go no further in practice. */
const MAX_ZOOM = 19;

/** A 256px PNG tile is tens of kilobytes. Anything this large is not a tile. */
const MAX_TILE_BYTES = 512 * 1024;

const UPSTREAM_TIMEOUT_MS = 5000;

/** Browser and edge: a week. Streets change slowly and a stale tile is harmless. */
const TILE_CACHE_CONTROL = 'public, max-age=604800';

/**
 * A small in-process cache in front of the upstream.
 *
 * The edge is the real cache; this one catches the repeats that reach the origin
 * anyway (a cold edge location, two members opening the same event at once).
 * Bounded by count, and tiles are small, so the worst case is a few megabytes.
 */
const MEMORY_TILES = 400;
/* Seven days, matching TILE_CACHE_CONTROL: OSM's policy asks a relay that does
   not read upstream cache headers to hold tiles for at least a week. */
const MEMORY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/**
 * Who is asking, in the form OSM's tile policy gives as its example:
 * `MyTownMaps/1.4 (+https://example.org; contact: maps@example.org)`.
 *
 * A relay is permitted there on two conditions — a distinctive User-Agent that
 * names the organization, and caching — and OSM blocks relays that do not
 * identify themselves. Verified rather than read: a first draft sent
 * `WeVolunteer/1 (+<placeholder url>) map tile proxy` and every tile came back as
 * OSM's "Access blocked" image, while this form is served normally.
 *
 * The site is the public application URL rather than APP_URL, which is a
 * placeholder anywhere but production and would make the request look like
 * exactly the anonymous relay the policy blocks.
 */
export const TILE_USER_AGENT = `${BRAND}/${VERSION} (+https://app.wevolunteers.org; contact: ${ADDRESSES.support})`;
const memory = new Map();

export function __clearTileCache() {
  memory.clear();
}

function remember(key, body) {
  memory.delete(key);
  memory.set(key, { body, at: Date.now() });
  while (memory.size > MEMORY_TILES) memory.delete(memory.keys().next().value);
}

function recall(key) {
  const hit = memory.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > MEMORY_TTL_MS) { memory.delete(key); return null; }
  memory.delete(key);
  memory.set(key, hit);
  return hit.body;
}

/**
 * The upstream this deployment uses, read per call so a test (or an operator
 * restart) that changes the environment is honoured.
 */
export function tileProvider(env = process.env) {
  const key = (env.MAP_TILES_CARTO_KEY || '').trim();
  return key ? { name: 'carto', key } : { name: 'osm', key: null };
}

export function upstreamTileUrl(provider, theme, z, x, y) {
  if (provider.name === 'carto') {
    const style = theme === 'dark' ? 'dark_all' : 'rastertiles/voyager';
    return `https://basemaps.cartocdn.com/${style}/${z}/${x}/${y}.png?key=${encodeURIComponent(provider.key)}`;
  }
  return `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
}

/**
 * One line per provider per ten minutes: a block affects every tile of every
 * map, and a log line per tile would bury the one message that matters.
 */
const BLOCK_WARN_INTERVAL_MS = 10 * 60 * 1000;
const lastBlockWarning = new Map();
function warnBlocked(providerName, detail) {
  const now = Date.now();
  if (now - (lastBlockWarning.get(providerName) || 0) < BLOCK_WARN_INTERVAL_MS) return;
  lastBlockWarning.set(providerName, now);
  console.warn(`[tiles] ${providerName} is refusing this server's tile requests: ${String(detail).slice(0, 200)}`);
}

/** Parses one path segment as a bounded non-negative integer, or null. */
function coordinate(raw, limitExclusive) {
  if (!/^\d{1,7}$/.test(raw)) return null;
  const n = Number(raw);
  return n < limitExclusive ? n : null;
}

/**
 * Generous for a person, tight for a crawler. Opening a map loads a dozen or
 * two tiles; panning an interactive one loads a few dozen more.
 */
const tileLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: DEMO_MODE ? 10000 : 1500,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => `tiles:${ipKeyGenerator(req.ip)}`,
  handler: (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.status(429).json({ error: 'Too many map requests. Please wait a moment.', code: 'rate_limited' });
  },
});

/**
 * Every response starts uncacheable, so a refusal — 401, 404, 429, 502 — can
 * never be stored at the edge and replayed to members. Only a real tile below
 * replaces this with a public, cacheable header.
 */
router.use('/tiles', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

/**
 * Which provider's attribution the map must show. A licence condition, so it is
 * answered by the server that chose the provider rather than guessed by the client.
 */
router.get('/tiles/provider', tileLimiter, authenticateToken, requireCap('event.view'), (req, res) => {
  res.json({ provider: tileProvider().name });
});

router.get('/tiles/:theme/:z/:x/:y.png', tileLimiter, authenticateToken, requireCap('event.view'), async (req, res) => {
  const { theme } = req.params;
  if (!THEMES.has(theme)) return res.status(404).json({ error: 'Not found' });

  const z = coordinate(req.params.z, MAX_ZOOM + 1);
  if (z === null) return res.status(404).json({ error: 'Not found' });
  const span = 2 ** z;
  const x = coordinate(req.params.x, span);
  const y = coordinate(req.params.y, span);
  if (x === null || y === null) return res.status(404).json({ error: 'Not found' });

  const provider = tileProvider();
  const cacheKey = `${provider.name}:${theme}:${z}:${x}:${y}`;

  const cached = recall(cacheKey);
  if (cached) {
    res.setHeader('Cache-Control', TILE_CACHE_CONTROL);
    return res.type('image/png').send(cached);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    /**
     * Nothing about the member is forwarded: no cookie, no referrer, no client
     * address. The upstream learns that this server wanted a tile, which is the
     * whole point. The User-Agent identifies the application, as OSM's policy
     * requires.
     */
    const upstream = await fetch(upstreamTileUrl(provider, theme, z, x, y), {
      signal: controller.signal,
      redirect: 'error',
      headers: {
        'User-Agent': TILE_USER_AGENT,
        Accept: 'image/png',
      },
    });

    const type = upstream.headers.get('content-type') || '';
    if (!upstream.ok || !type.startsWith('image/png')) {
      return res.status(502).json({ error: 'The map provider did not return a tile.' });
    }

    /**
     * A refusal dressed as a tile.
     *
     * OpenStreetMap answers a client it has blocked with HTTP 200, `image/png`
     * and a picture that says "Access blocked", marked `X-Blocked` and
     * `Cache-Control: no-cache`. Relayed with this route's week-long public
     * header, that picture would be pinned in Cloudflare and in every member's
     * browser for seven days after the block was lifted. Observed while building
     * this route, not hypothesised: an unidentifying User-Agent was blocked and
     * the browser kept the image across a server restart.
     *
     * So it is a 502 — never cached — and it is said out loud, because a block
     * is an operator problem that no member can report usefully.
     */
    if (upstream.headers.get('x-blocked')) {
      warnBlocked(provider.name, upstream.headers.get('x-blocked'));
      return res.status(502).json({ error: 'The map provider did not return a tile.' });
    }
    const upstreamCache = (upstream.headers.get('cache-control') || '').toLowerCase();
    const cacheable = !/\b(no-store|no-cache|private)\b/.test(upstreamCache);

    const declared = Number(upstream.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_TILE_BYTES) {
      return res.status(502).json({ error: 'The map provider did not return a tile.' });
    }

    const body = Buffer.from(await upstream.arrayBuffer());
    if (body.length > MAX_TILE_BYTES) {
      return res.status(502).json({ error: 'The map provider did not return a tile.' });
    }

    /* An upstream that says not to cache is relayed as it asked: served once,
       stored nowhere — not here, not at the edge, not in the browser. */
    if (!cacheable) return res.type('image/png').send(body);

    remember(cacheKey, body);
    res.setHeader('Cache-Control', TILE_CACHE_CONTROL);
    return res.type('image/png').send(body);
  } catch {
    /* Timeout, DNS, TLS, a redirect: all the same to a map, which shows a grey
       square for one tile and keeps working. Never cached — see above. */
    return res.status(502).json({ error: 'The map provider did not return a tile.' });
  } finally {
    clearTimeout(timer);
  }
});

export default router;
