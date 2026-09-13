/**
 * Cache isolation for `/api`.
 *
 * ── The failure this forbids ──
 *
 * A shared cache — Cloudflare, a corporate proxy, a school's filtering
 * appliance — keys a stored response on the URL. `GET /api/auth/me` is one URL
 * and returns a different person for every session. If anything between the
 * browser and this process is willing to store that response, the next caller
 * of that URL receives the previous caller's identity, and on this platform
 * that identity usually belongs to a minor.
 *
 * ── Why the assertion lives here and not only in deployment config ──
 *
 * The property was previously carried by three separate things agreeing:
 * `deploy/nginx/wevolunteers.conf` adding the header at the proxy, Cloudflare's
 * default of caching by file extension (an extensionless `/api` path is not a
 * candidate), and two handlers that set the header by hand after someone found
 * a specific leak. Each is real; none is the application's own guarantee.
 *
 * So `app.js` sets `Cache-Control: no-store` for every `/api` request, and this
 * file asserts it on the emitted response — which is the only form of the check
 * that survives someone moving the middleware.
 *
 * The production-mode half — a real hashed asset keeping `immutable`, and
 * `index.html` keeping `no-cache` — needs the built client and a production
 * boot, so it lives in `app.ordering.test.js` beside the other probes that do.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer } from './testServer.js';

const PW = 'Password123';

let srv;

beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });

let seq = 0;
const account = () => {
  seq += 1;
  return {
    email: `cache.iso.${seq}@example.org`, password: PW, name: `Cache Subject ${seq}`,
    role: 'student', grade: '9', school: 'Test High School',
    username: `cache_iso_${seq}`
  };
};

const cacheControl = (res) => res.headers.get('cache-control');

describe('/api is never stored by a shared cache', () => {
  /**
   * The whole point, stated as the attack rather than as the header.
   *
   * Two accounts ask the same URL and receive different people. That is the
   * shape a URL-keyed cache gets wrong, so the response that carries it must
   * say `no-store` — not `private`, which still permits the browser's own
   * on-disk cache, and the shared school Chromebook is a real deployment
   * target here.
   */
  it('an authenticated response naming one person is uncacheable', async () => {
    const a = await srv.signupConfirmed(account());
    const b = await srv.signupConfirmed(account());

    const resA = await srv.call('GET', '/api/auth/me', undefined, a.cookie);
    const resB = await srv.call('GET', '/api/auth/me', undefined, b.cookie);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    // Same URL, different subject — the condition that makes storage a leak.
    expect(resA.body.email).not.toBe(resB.body.email);

    for (const res of [resA, resB]) {
      expect(cacheControl(res)).toBe('no-store');
    }
  });

  /**
   * An unauthenticated `/api` response is covered too.
   *
   * Not because a public answer is secret, but because "is this response
   * personal?" is a judgement made per handler, and the leaks this repository
   * has already had were each somebody answering it wrongly for one route. A
   * blanket rule has no such edge.
   */
  it('an anonymous response is uncacheable as well', async () => {
    const res = await srv.call('GET', '/api/auth/check-email?email=nobody@example.org');
    expect(res.status).toBe(200);
    expect(cacheControl(res)).toBe('no-store');
  });

  /**
   * Responses produced before any router runs.
   *
   * A 401 and a 404 prove the header precedes the routers. They do not prove it
   * precedes the layers mounted above the routers, and the first version of
   * this control did not: it sat beside cookie-parser, below CORS and below
   * both body parsers, so the three refusals below reached the error handler
   * without it. A cached 403 or 400 is not a data leak, but it is a stale
   * refusal pinned onto everybody behind the same cache, outliving the
   * condition that produced it.
   */
  it('a request refused by a router carries it', async () => {
    const unauthorized = await srv.call('GET', '/api/auth/me');
    expect(unauthorized.status).toBe(401);
    expect(cacheControl(unauthorized)).toBe('no-store');

    const notFound = await srv.call('GET', '/api/definitely-not-a-route');
    expect(notFound.status).toBe(404);
    expect(cacheControl(notFound)).toBe('no-store');
  });

  it('a CORS refusal carries it', async () => {
    const res = await srv.call('GET', '/api/auth/check-email?email=nobody@example.org',
      undefined, undefined, { Origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(cacheControl(res)).toBe('no-store');
  });

  it('a body the parser refuses as malformed carries it', async () => {
    const res = await fetch(`${srv.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"email": "nobody@example.org", '
    });
    expect(res.status).toBe(400);
    expect(cacheControl(res)).toBe('no-store');
  });

  it('a body the parser refuses as too large carries it', async () => {
    const res = await fetch(`${srv.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@example.org', padding: 'x'.repeat(200 * 1024) })
    });
    expect(res.status).toBe(413);
    expect(cacheControl(res)).toBe('no-store');
  });

  /**
   * The guard against over-applying it.
   *
   * Uploaded pictures are served outside `/api` with `immutable`, because the
   * filename changes whenever the picture does. A blanket `no-store` across the
   * whole app would re-download every avatar on every page, so the scope is
   * asserted, not assumed. (The hashed bundle is the same argument, asserted in
   * `app.ordering.test.js`, where a production build exists.)
   */
  it('does not reach outside /api', async () => {
    const res = await fetch(`${srv.base}/uploads/does-not-exist-abcdef.png`);
    expect(res.status).toBe(404);
    expect(cacheControl(res) ?? '').not.toBe('no-store');

    // A path that merely begins with the letters "api" is not the API.
    const lookalike = await fetch(`${srv.base}/apiary`);
    expect(cacheControl(lookalike) ?? '').not.toBe('no-store');
  });

  /*
   * A handler that sets a stricter value still wins.
   *
   * `certificateRoutes` sends `private, no-store` on the PDF, and
   * `routes.certificateViewer.test.js` asserts both words on the wire. It is left
   * there rather than duplicated here, but named here because it is the case
   * that would break if this middleware ever moved from setting a default to
   * overwriting one.
   */
});
