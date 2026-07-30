import { describe, it, expect, beforeAll, afterAll, vi, beforeEach, afterEach } from 'vitest';
import { startTestServer } from './testServer.js';

let srv;
const originalFetch = global.fetch;
let organizerToken;
let studentToken;

beforeAll(async () => { 
  srv = await startTestServer(); 
});
afterAll(async () => { 
  await srv.close(); 
  global.fetch = originalFetch;
});

describe('Geocoding Proxy Route', () => {
  beforeEach(async () => {
    organizerToken = await srv.login('jkatzenback@vikings.org', 'password123');
    studentToken = await srv.login('leo.chen28@gmail.com', 'password123');

    global.fetch = vi.fn(async (url, init) => {
      if (typeof url === 'string' && url.includes('nominatim')) {
        return {
          ok: true,
          json: () => Promise.resolve([
            {
              name: "Library",
              display_name: "Library, Main Street, Springfield",
              lat: "40.0",
              lon: "-74.0",
              address: { road: "Main Street", city: "Springfield", state: "IL" }
            }
          ])
        };
      }
      return originalFetch(url, init);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects unauthenticated requests', async () => {
    const res = await srv.call('GET', '/api/geocode?q=library');
    expect(res.status).toBe(401);
  });

  it('rejects student requests', async () => {
    const res = await srv.call('GET', '/api/geocode?q=library', undefined, studentToken);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Access denied');
  });

  it('allows organizer requests and returns mapped results', async () => {
    const res = await srv.call('GET', '/api/geocode?q=library', undefined, organizerToken);
    expect(res.status).toBe(200);
    expect(res.body.results.length).toBe(1);
    expect(res.body.results[0].displayName).toBe('Library');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects short queries', async () => {
    const res = await srv.call('GET', '/api/geocode?q=a', undefined, organizerToken);
    expect(res.status).toBe(400);
  });
});
