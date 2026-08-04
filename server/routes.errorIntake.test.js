/**
 * The unauthenticated intake, asserted against what lands in the DATABASE.
 *
 * Every privacy assertion here reads the stored row rather than a response body
 * or a helper's return value. Task 3 already unit-tests `normaliseClientRoute`;
 * this file asserts the endpoint actually CALLS it, which is a different claim
 * and the one that fails silently if the wiring is forgotten — a perfect
 * normaliser that is never invoked stores raw paths with every unit test green.
 *
 * The endpoint answers 202 to everything, so a test that checks only the status
 * proves almost nothing. The database is the observable.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

let srv, db;

beforeAll(async () => {
  // Well above the 20/15min production limit so the volume tests below are not
  // fighting the limiter; the limiter gets its own test with its own override.
  process.env.ERROR_REPORT_RATE_LIMIT = '100000';
  const { startTestServer } = await import('./testServer.js');
  srv = await startTestServer();
  ({ db } = await import('./db.js'));
}, 60000);

afterAll(async () => {
  await srv?.close();
  delete process.env.ERROR_REPORT_RATE_LIMIT;
});

beforeEach(() => {
  db.prepare('DELETE FROM error_events').run();
  db.prepare('DELETE FROM error_groups').run();
});

const groups = () => db.prepare('SELECT * FROM error_groups').all();
const events = () => db.prepare('SELECT * FROM error_events').all();

/** Raw POST, so a non-JSON or oversized body can be sent deliberately. */
const post = (body, headers = {}) =>
  fetch(`${srv.base}/api/errors/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const report = (over = {}) => post({ kind: 'TypeError', message: 'client boom', route: '/events', ...over });

describe('intake: accepts a report without a session', () => {
  it('answers 202 and stores one group and one event', async () => {
    const res = await report();
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true });

    expect(groups().length).toBe(1);
    expect(events().length).toBe(1);
    expect(groups()[0]).toMatchObject({ source: 'client', kind: 'TypeError', status: 'open', occurrences: 1 });
  });

  it('leaves user_hash null when nobody is signed in, and sets it when they are', async () => {
    await report({ message: 'anon report' });
    expect(events()[0].user_hash).toBeNull();

    const cookie = await srv.login('leo.chen28@gmail.com');
    const res = await fetch(`${srv.base}/api/errors/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `wev_session=${cookie}` },
      body: JSON.stringify({ kind: 'TypeError', message: 'signed-in report', route: '/events' }),
    });
    expect(res.status).toBe(202);

    const signedIn = groups().find(g => g.message.includes('signed-in'));
    const ev = db.prepare('SELECT * FROM error_events WHERE fingerprint = ?').get(signedIn.fingerprint);
    expect(ev.user_hash).toMatch(/^[0-9a-f]{32}$/);
    // A hash, never the id.
    expect(JSON.stringify(events())).not.toContain('user-student-1');
  });

  it('answers 202 for a garbage or expired session rather than 401', async () => {
    // A broken session is one of the states most worth hearing about; refusing
    // the report would also make this endpoint a token-validity oracle.
    const res = await post(
      { kind: 'Error', message: 'broken session report', route: '/login' },
      { Cookie: 'wev_session=not-a-real-token' }
    );
    expect(res.status).toBe(202);
    expect(groups().length).toBe(1);
    expect(events()[0].user_hash).toBeNull();
  });
});

describe('intake: the client cannot assign what the server owns', () => {
  it('ignores a client-supplied source, release, status, occurred_at and fingerprint', async () => {
    const res = await report({
      source: 'server',
      release: '9.9.9-attacker',
      status: 'resolved',
      occurred_at: '1999-01-01T00:00:00.000Z',
      occurredAt: '1999-01-01T00:00:00.000Z',
      fingerprint: 'attacker-chosen-fingerprint',
      user_hash: 'attacker-chosen-hash',
      userHash: 'attacker-chosen-hash',
      users_seen: 9999,
      occurrences: 9999,
      message: 'override attempt',
    });
    expect(res.status).toBe(202);

    const [g] = groups();
    expect(g.source, 'a client escaped the client ceiling by claiming to be the server').toBe('client');
    expect(g.release).not.toBe('9.9.9-attacker');
    expect(g.status).toBe('open');
    expect(g.occurrences).toBe(1);
    expect(g.users_seen).toBe(0);
    expect(g.fingerprint).not.toBe('attacker-chosen-fingerprint');
    expect(g.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(g.first_seen_at.startsWith('1999'), 'a client backdated its own report').toBe(false);

    const ev = events()[0];
    expect(ev.user_hash).not.toBe('attacker-chosen-hash');
    expect(ev.occurred_at.startsWith('1999')).toBe(false);
  });

  it('drops context keys the table cannot hold', async () => {
    await report({
      context: { component: 'Login', password: 'hunter2', newEmail: 'a@b.com', challengeId: 'reauth-xyz' },
      message: 'context probe',
    });
    const ctx = events()[0].context ?? '';
    expect(ctx).toContain('Login');
    for (const leak of ['hunter2', 'a@b.com', 'reauth-xyz', 'password', 'newEmail', 'challengeId']) {
      expect(ctx, `${leak} reached the context column`).not.toContain(leak);
    }
  });
});

describe('intake: fingerprints', () => {
  it('collapses identical reports into one group', async () => {
    for (let i = 0; i < 4; i++) await report({ message: 'the same failure' });
    expect(groups().length).toBe(1);
    expect(groups()[0].occurrences).toBe(4);
  });

  it('separates genuinely different reports', async () => {
    await report({ message: 'alpha failure' });
    await report({ message: 'beta failure' });
    await report({ message: 'alpha failure', kind: 'RangeError' });
    expect(groups().length).toBe(3);
  });
});

describe('intake: route privacy, asserted on stored values', () => {
  const storedRoute = () => groups()[0].route;

  it('never persists a query string', async () => {
    await report({ route: '/events?q=12%20Maple%20Ave&city=Princeton' });
    expect(storedRoute()).toBe('/events');
    expect(JSON.stringify([...groups(), ...events()])).not.toContain('Maple');
  });

  it('never persists a fragment', async () => {
    await report({ route: '/calendar#section-private' });
    expect(storedRoute()).toBe('/calendar');
    expect(JSON.stringify(groups())).not.toContain('section-private');
  });

  it('never persists an email carried in a route', async () => {
    await report({ route: '/login?email=leo.chen28@gmail.com' });
    expect(storedRoute()).toBe('/login');
    expect(JSON.stringify([...groups(), ...events()])).not.toContain('leo.chen28@gmail.com');
  });

  it('never persists a token carried in a route', async () => {
    await report({ route: '/reset-password?token=eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.sig' });
    expect(storedRoute()).toBe('/reset-password');
    expect(JSON.stringify([...groups(), ...events()])).not.toContain('eyJhbGci');
  });

  it('never persists a real id sitting in a path parameter', async () => {
    await report({ route: '/checkin/event-softball-2026' });
    expect(storedRoute()).toBe('/checkin/:eventId');
    expect(JSON.stringify(groups())).not.toContain('softball');
  });

  /**
   * `/users/:id/profile` is deliberately NOT on the allowlist: it is not a real
   * client route (the real one is `/profile`), and the allowlist describes the
   * application rather than what a plan once guessed. So this stores `unknown`,
   * and the real user id must not survive.
   */
  it('stores unknown for /users/user-student-2/profile, and keeps the id out', async () => {
    await report({ route: '/users/user-student-2/profile' });
    expect(storedRoute()).toBe('unknown');
    expect(JSON.stringify([...groups(), ...events()])).not.toContain('user-student-2');
  });

  it('stores unknown for arbitrary and hostile paths, never the raw path', async () => {
    for (const hostile of [
      '/admin/secret-panel', '/../../etc/passwd', '//evil.com/x',
      'https://evil.com/events', 'not-a-path', '/' + 'a'.repeat(4000),
    ]) {
      db.prepare('DELETE FROM error_groups').run();
      const res = await report({ route: hostile, message: `hostile ${hostile.slice(0, 12)}` });
      expect(res.status).toBe(202);
      expect(storedRoute(), `${hostile} was stored raw`).toBe('unknown');
    }
  });

  it('neutralises a route that is not a string at all', async () => {
    for (const bad of [null, 42, { a: 1 }, ['/events'], true]) {
      db.prepare('DELETE FROM error_groups').run();
      const res = await report({ route: bad, message: 'non-string route' });
      expect(res.status, 'intake failed on hostile input instead of neutralising it').toBe(202);
      expect(storedRoute()).toBe('unknown');
    }
  });

  it('every stored route is an approved pattern or unknown — asserted over the whole table', async () => {
    const { CLIENT_ROUTE_PATTERNS, UNKNOWN_ROUTE } = await import('./clientRoutes.js');
    const allowed = new Set([...CLIENT_ROUTE_PATTERNS, UNKNOWN_ROUTE]);

    for (const route of [
      '/events?q=x', '/settings#a', '/verify/CERT-9', '/oauth/callback?code=abc',
      '/checkin/evt-1', '/nope', null, 12, '/events/new',
    ]) {
      await report({ route, message: `sweep ${String(route).slice(0, 10)}` });
    }

    const stored = new Set(groups().map(g => g.route).filter(Boolean));
    for (const r of stored) {
      expect(allowed.has(r), `stored route "${r}" is outside the approved set`).toBe(true);
    }
    expect(stored.size).toBeGreaterThan(2);
  });
});

describe('intake: the ceiling is a bound, not an oracle', () => {
  it('stops creating groups at the ceiling, counts the overflow, and answers 202 throughout', async () => {
    const { CLIENT_GROUP_CEILING, OVERFLOW_FINGERPRINT } = await import('./errorReporter.js');

    // Distinct by LETTERS: the fingerprint deliberately collapses numeric
    // variation, so digits would produce one group rather than many.
    const label = (n) => { let o = '', x = n; do { o += String.fromCharCode(97 + (x % 26)); x = Math.floor(x / 26); } while (x > 0); return o; };

    const statuses = new Set();
    for (let i = 0; i < CLIENT_GROUP_CEILING + 40; i++) {
      const res = await report({ message: `distinct client failure ${label(i)}` });
      statuses.add(res.status);
    }

    expect([...statuses], 'the response varied, which tells an attacker when the ceiling was hit').toEqual([202]);

    const real = db.prepare(
      "SELECT COUNT(*) c FROM error_groups WHERE source = 'client' AND fingerprint != ?"
    ).get(OVERFLOW_FINGERPRINT).c;
    expect(real).toBeLessThanOrEqual(CLIENT_GROUP_CEILING);

    const overflow = db.prepare('SELECT * FROM error_groups WHERE fingerprint = ?').get(OVERFLOW_FINGERPRINT);
    expect(overflow, 'the flood vanished silently instead of being counted').toBeTruthy();
    expect(overflow.occurrences).toBeGreaterThan(0);
  }, 120000);
});

describe('intake: failures never reach the client', () => {
  it('still answers 202 when recording throws', async () => {
    const reporter = await import('./errorReporter.js');
    const spy = vi.spyOn(reporter, 'recordError').mockImplementation(() => { throw new Error('reporter exploded'); });

    const res = await report({ message: 'resilience probe' });

    const called = spy.mock.calls.length;
    spy.mockRestore();

    expect(called, 'the spy never intercepted — this test proves nothing').toBeGreaterThan(0);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true });
    expect(groups().length).toBe(0);
  });

  it('answers 202 for an empty object and an array body', async () => {
    for (const body of ['{}', '[]']) {
      const res = await post(body);
      expect(res.status, `body ${body} was refused`).toBe(202);
    }
  });

  /**
   * `express.json` runs in strict mode, so a bare scalar is not a valid body and
   * is refused by the parser before this route is reached — the same 400 the
   * application already gives every other endpoint for `entity.parse.failed`.
   * Asserted rather than worked around: it is existing, consistent behaviour,
   * and it costs the reporter nothing, because no honest client sends `123`.
   */
  it('answers 400 for a bare scalar body, like every other endpoint', async () => {
    for (const body of ['"a string"', '123', 'null']) {
      const res = await post(body);
      expect(res.status, `body ${body} was accepted`).toBe(400);
    }
    expect(groups().length).toBe(0);
  });

  it('answers 400 for malformed JSON without leaking internals', async () => {
    const res = await post('{not json');
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toMatch(/at .*\.js:\d+/); // no stack
  });
});

describe('intake: the 8 kB body cap actually engages', () => {
  it('rejects a body over 8 kB with 413', async () => {
    const res = await post({ kind: 'Error', message: 'x'.repeat(20_000), route: '/events' });
    expect(
      res.status,
      'the 8 kB cap is not active — a route-level parser after the global one is a no-op'
    ).toBe(413);
    expect(groups().length).toBe(0);
  });

  it('accepts a body comfortably under the cap', async () => {
    const res = await post({ kind: 'Error', message: 'y'.repeat(2000), route: '/events' });
    expect(res.status).toBe(202);
  });

  it('leaves the global 100 kB limit in place for other routes', async () => {
    // Under 100 kB: accepted by the parser and refused by the handler's own
    // validation, which proves the parser did not reject it.
    const under = await fetch(`${srv.base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.co', password: 'p'.repeat(20_000) }),
    });
    expect(under.status).not.toBe(413);

    const over = await fetch(`${srv.base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.co', password: 'p'.repeat(200_000) }),
    });
    expect(over.status).toBe(413);
  });
});

describe('intake: structural guarantees', () => {
  it('has no ROUTE_REGISTRY entry, because it carries no authenticateToken', async () => {
    const registry = readFileSync(path.join(here, 'authz.completeness.test.js'), 'utf8');
    expect(
      registry,
      'a registry entry for an unauthenticated route fails the build as stale'
    ).not.toContain('/api/errors/report');

    // Asserted on CODE. The module's own header explains why it deliberately
    // does NOT use `authenticateToken`, and a raw text check is satisfied by
    // that sentence while the middleware is present — the same prose-vs-code
    // trap Task 5's structural tests hit.
    const { canonicalSource } = await import('./migrations/index.js');
    const route = canonicalSource(readFileSync(path.join(here, 'routes', 'errorRoutes.js'), 'utf8'));
    expect(route, 'the intake must stay unauthenticated').not.toContain('authenticateToken');
    expect(route, 'no capability gate belongs on an unauthenticated report').not.toContain('requireCap');
    expect(route, 'no step-up belongs on an unauthenticated report').not.toContain('requireAAL2');
  });

  it('is mounted behind its own limiter, and the limiter counts successes', async () => {
    const { canonicalSource } = await import('./migrations/index.js');
    const app = canonicalSource(readFileSync(path.join(here, 'app.js'), 'utf8'));
    expect(app).toContain("app.use('/api/errors/report', errorReportLimiter)");
    // skipSuccessfulRequests would skip the entire attack: this endpoint answers
    // 202 to everything, including a flood.
    const limiterBlock = app.slice(app.indexOf('errorReportLimiter = rateLimit'), app.indexOf('lookupLimiter'));
    expect(limiterBlock).not.toContain('skipSuccessfulRequests');
  });
});
