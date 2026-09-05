import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { startTestServer, enrolTwoFactor } from './testServer.js';
import { __resetProviderCache } from './integrations/providerCache.js';

/**
 * The Owner Center's API: who may read it, and what may leave the process.
 *
 * ── Why this exists beside `authz.matrix.test.js` ──
 *
 * That file asserts a STATUS per role, which is the right shape for a gate and
 * the wrong shape for the two things that would actually hurt here.
 *
 * The first is content. `owner.console` is SUPER_ONLY, so an ordinary
 * administrator must be refused — and the failure mode of getting that wrong is
 * not a 403 that turns into a 200. It is an operational map of a service holding
 * minors' records, handed to an account nobody vetted for it.
 *
 * The second is credentials. Every one of these endpoints exists to relay what
 * a third party said, using tokens that can read every event in an analytics
 * project or every log line in a telemetry account. A field that starts echoing
 * one would look completely reasonable in a diff. So the cases below configure
 * REAL-SHAPED credentials, drive the endpoints, and assert that no part of any
 * of them appears in any response.
 */
describe('the Owner Center API', () => {
  let srv, owner, admin, student, organizer;

  beforeAll(async () => {
    srv = await startTestServer();
    admin = await srv.login('admin@example.gov');
    student = await srv.login('leo.chen@example.com');
    organizer = await srv.login('jordan.whitfield@example.org');

    const { db } = await import('./db.js');
    const signed = await srv.signupConfirmed({
      name: 'Owner', username: 'owner_center_owner', email: 'owner.center@test.local',
      password: 'Password123', grade: 'Adult', role: 'student',
    });
    await db.prepare("UPDATE users SET role = 'super_admin', verified = 1 WHERE email = ?")
      .run('owner.center@test.local');
    /* An administrator without a second factor is refused by `requireCap` before
       any capability is consulted, so a promoted fixture has to be enrolled or
       every assertion below reads 403 for a reason unrelated to the capability. */
    await enrolTwoFactor(db, 'owner.center@test.local');
    owner = signed.cookie;
  }, 120000);

  afterAll(async () => { await srv?.close(); });
  afterEach(() => { __resetProviderCache(); vi.unstubAllGlobals(); });

  /**
   * Replaces only the OUTBOUND `fetch`, letting the test client through.
   *
   * `srv.call` reaches the application over real HTTP with the same global
   * `fetch` the integrations use, so a blanket stub breaks the test harness
   * before it reaches the code under test — which reads as the endpoint being
   * broken. Passing this server's own base URL through to the real
   * implementation is the same trick `authz.matrix.test.js` uses to mock
   * Nominatim without unplugging itself.
   */
  const stubOutbound = (handler) => {
    const real = globalThis.fetch;
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const href = String(url);
      if (href.startsWith(srv.base)) return real(url, init);
      calls.push({ url: href, init });
      return handler(href, init);
    }));
    return calls;
  };

  const PATHS = [
    '/api/owner/health',
    '/api/owner/monitoring',
    '/api/owner/analytics',
    '/api/owner/infrastructure',
  ];

  describe('who may read it', () => {
    it.each(PATHS)('%s refuses an unauthenticated caller with 401, not 403', async (path) => {
      /* The two mean different things to a client: one says "sign in", the
         other says "you can never do this". */
      expect((await srv.call('GET', path)).status).toBe(401);
    });

    it.each(PATHS)('%s refuses a student', async (path) => {
      expect((await srv.call('GET', path, undefined, student)).status).toBe(403);
    });

    it.each(PATHS)('%s refuses an organizer', async (path) => {
      expect((await srv.call('GET', path, undefined, organizer)).status).toBe(403);
    });

    /**
     * The row an "admins see the admin pages" assumption gets wrong.
     *
     * `owner.console` is in SUPER_ONLY, so it is owner-only AND ungrantable:
     * `can()` refuses it before per-user grants are consulted and
     * `userCapabilities.js` will not store a grant naming one.
     */
    it.each(PATHS)('%s refuses an ordinary administrator', async (path) => {
      const res = await srv.call('GET', path, undefined, admin);
      expect(res.status).toBe(403);
      /* Not a 200 with an empty body — that is what a capability cascade
         terminating in "see nothing" looks like, and a status assertion alone
         cannot tell the two apart. */
      expect(res.body?.monitors).toBeUndefined();
      expect(res.body?.application).toBeUndefined();
    });

    it.each(PATHS)('%s answers the owner', async (path) => {
      expect((await srv.call('GET', path, undefined, owner)).status).toBe(200);
    });

    it('cannot be reached by granting the capability to somebody', async () => {
      const { grantCapability } = await import('./userCapabilities.js');
      const { db } = await import('./db.js');
      const target = await db.prepare('SELECT id FROM users WHERE email = ?').get('leo.chen@example.com');

      /* SUPER_ONLY is checked BEFORE grants, and the grant store refuses to
         record one naming such a capability — so "let the person who watches
         the dashboards see the dashboards" is a conversation that has to happen
         as a role change. Either a refusal to store or a still-403 read proves
         the property; both are asserted so a change to which one it is fails
         loudly rather than silently opening the door. */
      let stored = true;
      try {
        await grantCapability({ db, userId: target.id, capability: 'owner.console', grantedBy: 'test' });
      } catch {
        stored = false;
      }
      expect((await srv.call('GET', '/api/owner/health', undefined, student)).status).toBe(403);
      expect(stored).toBe(false);
    });
  });

  describe('what leaves the process', () => {
    /**
     * Credentials shaped like the real ones, set for the duration of one case.
     *
     * Real-SHAPED matters: a probe value of `x` would be found inside ordinary
     * words and the assertion would pass or fail for the wrong reason. These are
     * distinctive strings that cannot occur by accident.
     */
    const SECRETS = {
      BETTERSTACK_UPTIME_API_TOKEN: 'bsuptime_QQQZZZ111secret',
      AMPLITUDE_API_KEY: 'amplkey_QQQZZZ222secret',
      AMPLITUDE_SECRET_KEY: 'amplsec_QQQZZZ333secret',
      UPSTASH_REDIS_REST_URL: 'https://upstash-QQQZZZ444.example.test',
      UPSTASH_REDIS_REST_TOKEN: 'upstok_QQQZZZ555secret',
      PINECONE_API_KEY: 'pckey_QQQZZZ666secret',
    };

    const withSecrets = async (fn) => {
      const saved = {};
      for (const [k, v] of Object.entries(SECRETS)) { saved[k] = process.env[k]; process.env[k] = v; }
      try { return await fn(); } finally {
        for (const [k] of Object.entries(SECRETS)) {
          if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
        }
      }
    };

    it('never echoes a configured credential, in any state', async () => {
      /* Every provider answers 401 — the state most likely to make a vendor
         quote back what it was sent, and the one whose body a naive
         implementation would forward as "the error". */
      stubOutbound(async () => ({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ error: `Invalid credential ${SECRETS.AMPLITUDE_SECRET_KEY}` }),
      }));

      await withSecrets(async () => {
        for (const path of PATHS) {
          const res = await srv.call('GET', `${path}?fresh=1`, undefined, owner);
          expect(res.status).toBe(200);
          const body = JSON.stringify(res.body);
          for (const [name, value] of Object.entries(SECRETS)) {
            expect(body, `${path} leaked ${name}`).not.toContain(value);
          }
          /* Nor the vendor's message, which on a 401 is the thing carrying it. */
          expect(body).not.toContain('Invalid credential');
        }
      });
    });

    it('does not put a credential in an outbound URL either', async () => {
      const calls = stubOutbound(async () => ({ ok: false, status: 500, text: async () => 'nope' }));

      await withSecrets(async () => {
        await srv.call('GET', '/api/owner/monitoring?fresh=1', undefined, owner);
        await srv.call('GET', '/api/owner/analytics?fresh=1', undefined, owner);
      });

      expect(calls.length).toBeGreaterThan(0);
      for (const { url } of calls) {
        for (const value of Object.values(SECRETS)) {
          /* A credential in a query string lands in every proxy log between
             here and the vendor, and in the vendor's own access log. */
          expect(url).not.toContain(value);
        }
      }
    });
  });

  describe('when a provider is unreachable', () => {
    it('still answers 200, with the failure named per section', async () => {
      stubOutbound(async () => { throw new TypeError('network down'); });
      process.env.BETTERSTACK_UPTIME_API_TOKEN = 'token-for-this-case';
      try {
        const res = await srv.call('GET', '/api/owner/monitoring?fresh=1', undefined, owner);
        /* The page must not fail because one external provider is unavailable —
           the whole point of a status page is that it answers on a bad day. */
        expect(res.status).toBe(200);
        expect(res.body.monitors.state).toBe('unavailable');
        /* And the local half of the same card still works. */
        expect(res.body.telemetry).toBeTruthy();
        expect(res.body.links.dashboard).toMatch(/^https:\/\//);
      } finally {
        delete process.env.BETTERSTACK_UPTIME_API_TOKEN;
      }
    });

    it('reports "not configured" rather than an error when nothing is set up', async () => {
      const calls = stubOutbound(async () => { throw new Error('should not be called'); });

      const res = await srv.call('GET', '/api/owner/analytics?fresh=1', undefined, owner);
      expect(res.status).toBe(200);
      expect(res.body.users.state).toBe('not_configured');
      /* The variables come from the server so the page never has to name them —
         see `redis.privacy.test.js`, which fails the build on a client file that
         mentions the Redis pair. */
      expect(res.body.users.configureWith).toContain('AMPLITUDE');
      /* An unconfigured integration must not cost a request per page load. */
      expect(calls).toHaveLength(0);
    });
  });

  describe('the health read', () => {
    it('reports the database by asking it, and the error trend by counting', async () => {
      const res = await srv.call('GET', '/api/owner/health', undefined, owner);
      expect(res.status).toBe(200);
      expect(res.body.database.state).toBe('ok');
      expect(typeof res.body.database.latencyMs).toBe('number');

      /* Counts, never content: the messages, stacks and routes live at
         `/errors` behind `error.read`, and a second surface disclosing the same
         evidence under a different capability is how one of them ends up with
         weaker rules. */
      expect(res.body.errors).toMatchObject({ windowDays: 30 });
      expect(typeof res.body.errors.last24h).toBe('number');
      expect(JSON.stringify(res.body.errors)).not.toMatch(/message|stack|fingerprint|route/i);
    });

    it('contacts no third party at all', async () => {
      /* This endpoint has to answer when every vendor is down — which is the
         state in which an owner most needs it. */
      const calls = stubOutbound(async () => { throw new Error('no'); });
      expect((await srv.call('GET', '/api/owner/health', undefined, owner)).status).toBe(200);
      expect(calls).toHaveLength(0);
    });
  });

  describe('caching', () => {
    it('does not spend a vendor request per page render', async () => {
      const calls = stubOutbound(async () => ({ ok: true, status: 200, text: async () => '{"data":[]}' }));
      process.env.BETTERSTACK_UPTIME_API_TOKEN = 'token-for-this-case';
      try {
        await srv.call('GET', '/api/owner/monitoring?fresh=1', undefined, owner);
        const afterFirst = calls.length;
        await srv.call('GET', '/api/owner/monitoring', undefined, owner);
        await srv.call('GET', '/api/owner/monitoring', undefined, owner);
        expect(calls.length, 'a cached read reached the vendor again').toBe(afterFirst);
      } finally {
        delete process.env.BETTERSTACK_UPTIME_API_TOKEN;
      }
    });

    it('refetches when the refresh button asks', async () => {
      const calls = stubOutbound(async () => ({ ok: true, status: 200, text: async () => '{"data":[]}' }));
      process.env.BETTERSTACK_UPTIME_API_TOKEN = 'token-for-this-case';
      try {
        await srv.call('GET', '/api/owner/monitoring?fresh=1', undefined, owner);
        const afterFirst = calls.length;
        await srv.call('GET', '/api/owner/monitoring?fresh=1', undefined, owner);
        expect(calls.length).toBeGreaterThan(afterFirst);
      } finally {
        delete process.env.BETTERSTACK_UPTIME_API_TOKEN;
      }
    });
  });
});
