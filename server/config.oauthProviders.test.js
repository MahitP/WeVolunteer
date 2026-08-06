/**
 * The four states a sign-in provider can be in, and what each one is allowed to
 * produce.
 *
 * ── The incident this file exists for ──
 *
 *     AADSTS900144: The request body must contain the following parameter:
 *     'client_id'
 *
 * With MICROSOFT_CLIENT_ID unset, the Microsoft button rendered as a working
 * option, `POST /api/oauth/microsoft/url` answered 200, and the URL it handed
 * back carried `client_id=`. The user discovered the misconfiguration at
 * Microsoft, after leaving the site.
 *
 * Two separate defects produced that, and both are pinned here because fixing
 * either one alone leaves a live path to the same error:
 *
 *   1. ADVERTISING. `OAUTH_PROVIDERS_ENABLED` reads
 *      `OAUTH_ALLOW_MOCK || <credentials>`, and OAUTH_ALLOW_MOCK defaults to
 *      `!IS_PRODUCTION` — so every development environment advertised every
 *      provider. OAUTH_PROVIDERS_CONFIGURED answers from credentials alone and
 *      is what `/api/oauth/providers` reports.
 *   2. MINTING. `getAuthUrl` had no guard at all, in either provider. Hiding the
 *      button is presentation; the mint endpoint is still reachable directly and
 *      `reauthRoutes.js` calls `getAuthUrl` down a second path.
 *
 * ── Why a subprocess ──
 *
 * `config.js` reads `process.env` once at module load, and `testServer.js`
 * configures both providers for the whole server suite. A test that needs to
 * observe an UNCONFIGURED provider therefore cannot run in that process at all.
 * Each case below boots a fresh node with an environment it states in full,
 * which is also the only honest way to test a module whose whole job is reading
 * the environment.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';

const root = process.cwd().replace(/\\/g, '/');

/**
 * Boots config + a provider in a clean process and reports what they did.
 *
 * `env` REPLACES the OAuth variables rather than merging over them: a developer
 * with real credentials exported in their shell would otherwise silently turn
 * every "missing credential" case into a configured one, and the suite would
 * pass for them and fail in CI.
 */
function probe(providerId, env) {
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const c = await import('${root}/server/config.js');
    const p = (await import('${root}/server/oauth/providers/${providerId}.js')).default;
    let url = null, threw = null;
    try { url = p.getAuthUrl('test-state'); }
    catch (e) { threw = e.name + ': ' + e.message; }
    console.log(JSON.stringify({
      configured: c.OAUTH_PROVIDERS_CONFIGURED['${providerId}'],
      enabled: c.OAUTH_PROVIDERS_ENABLED['${providerId}'],
      url,
      threw,
    }));
  `], {
    env: {
      ...process.env,
      JWT_SECRET: 'JXAvK3n2Qp7RtY9wLmZbC4dE6fG8hJ1kN5oP0qS2uV4xA7yB9cD3eF5gH8iJ0kLm',
      GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '',
      MICROSOFT_CLIENT_ID: '', MICROSOFT_CLIENT_SECRET: '',
      ...env,
    },
    encoding: 'utf8',
  });
  const line = String(res.stdout || '').trim().split('\n').pop();
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(`probe did not report JSON.\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
  }
}

const CONFIGURED = {
  google: { GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'secret' },
  microsoft: { MICROSOFT_CLIENT_ID: 'ms-id', MICROSOFT_CLIENT_SECRET: 'ms-secret' },
};

const ID_ONLY = {
  google: { GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com' },
  microsoft: { MICROSOFT_CLIENT_ID: 'ms-id' },
};

const SECRET_ONLY = {
  google: { GOOGLE_CLIENT_SECRET: 'secret' },
  microsoft: { MICROSOFT_CLIENT_SECRET: 'ms-secret' },
};

for (const providerId of ['google', 'microsoft']) {
  describe(`${providerId} provider states`, () => {
    it('fully configured: advertised, and mints a URL carrying the client id', () => {
      const r = probe(providerId, CONFIGURED[providerId]);
      expect(r.threw).toBe(null);
      expect(r.configured).toBe(true);
      expect(r.url).toBeTruthy();

      const clientId = new URL(r.url).searchParams.get('client_id');
      expect(clientId).toBeTruthy();
      expect(clientId).not.toBe('undefined');
    });

    it('missing client id: not advertised, and refuses to mint', () => {
      const r = probe(providerId, SECRET_ONLY[providerId]);
      expect(r.configured).toBe(false);
      expect(r.url).toBe(null);
      expect(r.threw).toMatch(/OAuthNotConfiguredError/);
      expect(r.threw).toMatch(/CLIENT_ID/);
    });

    /**
     * A secret-less provider is refused even though the authorize URL does not
     * carry the secret and would look perfectly valid.
     *
     * Without this the user signs in at the provider, comes back with a real
     * authorization code, and the failure surfaces at the token exchange — after
     * the round trip, with a message about the exchange rather than about the
     * configuration. Refusing up front moves that to the press of the button.
     */
    it('missing secret: not advertised, and refuses to mint despite the URL not needing it', () => {
      const r = probe(providerId, ID_ONLY[providerId]);
      expect(r.configured).toBe(false);
      expect(r.url).toBe(null);
      expect(r.threw).toMatch(/CLIENT_SECRET/);
    });

    it('nothing configured: not advertised, and refuses to mint', () => {
      const r = probe(providerId, {});
      expect(r.configured).toBe(false);
      expect(r.url).toBe(null);
      expect(r.threw).toMatch(/OAuthNotConfiguredError/);
    });

    /**
     * The exact shape of the reported bug: development, mock on, no credentials.
     *
     * `enabled` is true here — that is correct and deliberate, because it is what
     * lets the test suite drive a mock CALLBACK. What must not happen is the
     * provider being offered to a person, or a URL being minted. Before the fix
     * both happened.
     */
    it('mock enabled with no credentials: still not advertised, still refuses to mint', () => {
      const r = probe(providerId, { OAUTH_ALLOW_MOCK: 'true', NODE_ENV: 'development' });

      expect(r.enabled).toBe(true);
      expect(r.configured).toBe(false);
      expect(r.url).toBe(null);
      expect(r.threw).toMatch(/OAuthNotConfiguredError/);
    });

    it('never mints a URL with an empty client_id, under any environment', () => {
      for (const env of [{}, ID_ONLY[providerId], SECRET_ONLY[providerId],
        { OAUTH_ALLOW_MOCK: 'true' }, CONFIGURED[providerId]]) {
        const r = probe(providerId, env);
        if (r.url === null) continue;
        expect(new URL(r.url).searchParams.get('client_id'), JSON.stringify(env)).toBeTruthy();
      }
    });
  });
}

describe('apple', () => {
  it('is neither implemented nor configurable, so it can never be advertised', () => {
    const r = probe('apple', {
      // Even if somebody invents credentials for it.
      APPLE_CLIENT_ID: 'apple-id', APPLE_CLIENT_SECRET: 'apple-secret',
    });
    expect(r.configured).toBe(false);
    expect(r.enabled).toBe(false);
  });
});
