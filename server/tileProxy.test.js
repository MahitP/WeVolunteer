/**
 * The map tile proxy (server/routes/tileRoutes.js).
 *
 * What it must guarantee, each asserted on the wire:
 *
 *   - A student's browser talks only to this server. The upstream request
 *     carries nothing about the member: no cookie, no referrer, no address.
 *   - The provider key, when there is one, never appears in a response.
 *   - It is not an open relay: no session, no upstream call.
 *   - A refusal or failure is never cacheable, so the edge cannot replay a 401
 *     or a 502 to members; a real tile is.
 *   - Coordinates are bounded, so a request cannot become an arbitrary URL.
 *
 * The upstream is replaced with a recording fake — this suite never touches the
 * network — while requests to the test server itself pass through untouched.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer } from './testServer.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001', 'hex');
const KEY = 'carto-test-key-do-not-leak-1234567890';

let srv, cookie, realFetch, clearTileCache;
let upstreamCalls = [];
let upstreamResponder;

beforeAll(async () => {
  srv = await startTestServer();
  cookie = await srv.login('leo.chen@example.com');
  ({ __clearTileCache: clearTileCache } = await import('./routes/tileRoutes.js'));

  realFetch = global.fetch;
  global.fetch = async (url, init) => {
    const target = String(url);
    if (target.startsWith(srv.base)) return realFetch(url, init);
    upstreamCalls.push({ url: target, init });
    return upstreamResponder(target, init);
  };
});

afterAll(async () => {
  global.fetch = realFetch;
  delete process.env.MAP_TILES_CARTO_KEY;
  await srv?.close();
});

beforeEach(() => {
  upstreamCalls = [];
  clearTileCache();
  delete process.env.MAP_TILES_CARTO_KEY;
  upstreamResponder = async () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
});

const tile = (p, withCookie = true) => realFetch(`${srv.base}${p}`, {
  headers: withCookie ? { Cookie: `wev_session=${cookie}`, Referer: 'https://app.wevolunteers.org/events' } : {},
});

describe('serving a tile', () => {
  it('returns the upstream PNG with a public, cacheable header', async () => {
    const res = await tile('/tiles/light/15/9647/12320.png');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^image\/png/);
    expect(res.headers.get('cache-control')).toBe('public, max-age=604800');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it('uses OpenStreetMap when no CARTO key is configured', async () => {
    await tile('/tiles/dark/3/2/3.png');
    expect(upstreamCalls).toHaveLength(1);
    expect(upstreamCalls[0].url).toBe('https://tile.openstreetmap.org/3/2/3.png');
  });

  it('uses the CARTO style for the theme when a key is configured, and never shows the key', async () => {
    process.env.MAP_TILES_CARTO_KEY = KEY;
    const dark = await tile('/tiles/dark/3/2/3.png');
    const light = await tile('/tiles/light/3/2/4.png');
    expect(upstreamCalls.map(c => c.url)).toEqual([
      `https://basemaps.cartocdn.com/dark_all/3/2/3.png?key=${KEY}`,
      `https://basemaps.cartocdn.com/rastertiles/voyager/3/2/4.png?key=${KEY}`,
    ]);
    for (const res of [dark, light]) {
      expect(JSON.stringify([...res.headers])).not.toContain(KEY);
      expect(Buffer.from(await res.arrayBuffer()).toString('latin1')).not.toContain(KEY);
    }

    const provider = await tile('/tiles/provider');
    const body = await provider.text();
    expect(JSON.parse(body)).toEqual({ provider: 'carto' });
    expect(body).not.toContain(KEY);
  });

  it('forwards nothing about the member to the upstream', async () => {
    await tile('/tiles/light/10/300/400.png');
    const headers = new Headers(upstreamCalls[0].init.headers);
    expect(headers.get('cookie')).toBeNull();
    expect(headers.get('referer')).toBeNull();
    expect(headers.get('x-forwarded-for')).toBeNull();
    /* OSM's policy example shape: product/version, a URL, a contact. A relay
       that does not identify itself this way is served a "blocked" tile. */
    expect(headers.get('user-agent')).toMatch(/^WeVolunteer\/\d+\.\d+\.\d+ \(\+https:\/\/app\.wevolunteers\.org; contact: [^@\s]+@[^)\s]+\)$/);
    expect(upstreamCalls[0].init.redirect).toBe('error');
  });

  it('answers a repeat from memory instead of asking the upstream again', async () => {
    await tile('/tiles/light/12/1000/1500.png');
    await tile('/tiles/light/12/1000/1500.png');
    expect(upstreamCalls).toHaveLength(1);
  });
});

describe('what it refuses', () => {
  it('is not an open relay: no session, no upstream call, and nothing cacheable', async () => {
    const res = await tile('/tiles/light/15/9647/12320.png', false);
    expect(res.status).toBe(401);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(upstreamCalls).toHaveLength(0);
  });

  it('rejects coordinates outside the tile grid without calling the upstream', async () => {
    for (const p of [
      '/tiles/light/20/0/0.png',        // beyond the maximum zoom
      '/tiles/light/2/4/0.png',         // x must be < 2^z
      '/tiles/light/2/0/-1.png',
      '/tiles/light/1.5/0/0.png',
      '/tiles/sepia/2/0/0.png',         // unknown style
      '/tiles/light/2/0/0x1.png',
      '/tiles/light/2/%2e%2e/0.png',
    ]) {
      const res = await tile(p);
      expect(res.status, p).toBe(404);
      expect(res.headers.get('cache-control'), p).toBe('no-store');
    }
    expect(upstreamCalls).toHaveLength(0);
  });

  it('answers 502, uncacheable, when the upstream fails or sends something that is not a tile', async () => {
    const cases = [
      async () => new Response('nope', { status: 403, headers: { 'content-type': 'text/plain' } }),
      async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      async () => new Response(Buffer.alloc(600 * 1024), { status: 200, headers: { 'content-type': 'image/png' } }),
      async () => { throw new Error('ECONNRESET'); },
    ];
    let n = 0;
    for (const responder of cases) {
      upstreamResponder = responder;
      const res = await tile(`/tiles/light/5/${n}/${n}.png`);
      n += 1;
      expect(res.status).toBe(502);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('content-type')).not.toMatch(/image/);
    }
  });

  /**
   * OpenStreetMap's refusal is HTTP 200 and a PNG that reads "Access blocked",
   * marked `X-Blocked` and `no-cache`. Relayed as a tile, it would be pinned at
   * the edge and in every browser for the week-long max-age.
   */
  it('refuses to relay a blocked-client image as a tile', async () => {
    upstreamResponder = async () => new Response(PNG, {
      status: 200,
      headers: {
        'content-type': 'image/png',
        'cache-control': 'no-cache',
        'x-blocked': 'Access denied. See https://operations.osmfoundation.org/policies/tiles/',
      },
    });
    const first = await tile('/tiles/light/7/1/1.png');
    expect(first.status).toBe(502);
    expect(first.headers.get('cache-control')).toBe('no-store');

    // And nothing was remembered: a lifted block is visible immediately.
    upstreamResponder = async () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
    expect((await tile('/tiles/light/7/1/1.png')).status).toBe(200);
  });

  it('relays, but stores nowhere, a tile the upstream marks uncacheable', async () => {
    upstreamResponder = async () => new Response(PNG, {
      status: 200, headers: { 'content-type': 'image/png', 'cache-control': 'no-store' },
    });
    const res = await tile('/tiles/light/8/2/2.png');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    await tile('/tiles/light/8/2/2.png');
    expect(upstreamCalls).toHaveLength(2);
  });

  it('does not remember a failure', async () => {
    upstreamResponder = async () => { throw new Error('down'); };
    expect((await tile('/tiles/light/6/1/1.png')).status).toBe(502);
    upstreamResponder = async () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
    expect((await tile('/tiles/light/6/1/1.png')).status).toBe(200);
  });
});
