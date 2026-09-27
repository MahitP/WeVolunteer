import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { OAUTH_CALLBACK_PATH } from './oauthCallbackPath.js';

/**
 * The OAuth redirect-URI guard.
 *
 * `OAUTH_REDIRECT_URI` defaults to `http://localhost:5173/oauth/callback`, which
 * is correct in development and catastrophic in production. Verified during the
 * pre-pilot review: with real Google credentials set and OAUTH_REDIRECT_URI
 * forgotten, a production server
 *
 *   • booted with no warning,
 *   • advertised `{"id":"google","enabled":true}` so the "Continue with Google"
 *     button rendered for every visitor, and
 *   • issued authorize URLs carrying
 *     `redirect_uri=http://localhost:5173/oauth/callback`.
 *
 * Every student pressing that button is sent to Google and then bounced to
 * localhost. Either Google refuses with `redirect_uri_mismatch` — a dead end on
 * an advertised sign-in path — or, if localhost is still a registered URI on
 * that OAuth client (the common case, because it is what development uses and
 * the same client is often reused), Google hands a **live authorization code** to
 * `http://localhost:5173` over plain HTTP on the user's own machine.
 *
 * Forgetting this variable is a likely mistake rather than an exotic one: it is
 * not mentioned in deploy/wevolunteer.env.example, so an operator following the
 * runbook has no reason to know it exists.
 *
 * The rest of config.js fails CLOSED on exactly this class of mistake — a
 * placeholder JWT_SECRET and OAUTH_ALLOW_MOCK in production both refuse to
 * boot. This one failed open and silently, so it now fails closed too.
 *
 * config.js validates at import time, so each case runs in its own subprocess.
 */
/**
 * Boots config.js in a subprocess and returns both streams.
 *
 * spawnSync rather than execFileSync: a WARNING (as opposed to a refusal) exits
 * zero and writes to stderr via console.warn, and execFileSync only hands back
 * stderr when the process fails. The non-HTTPS case below asserts on exactly
 * that combination — booted AND warned.
 */
function boot(env) {
  const root = process.cwd().replace(/\\/g, '/');
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const c = await import('${root}/server/config.js');
      console.log('BOOTED:' + c.OAUTH_REDIRECT_URI);
    `], { env: { ...process.env, ...env }, encoding: 'utf8' });
  return {
    booted: res.status === 0,
    stdout: String(res.stdout || ''),
    stderr: String(res.stderr || '')
  };
}

const STRONG = 'JXAvK3n2Qp7RtY9wLmZbC4dE6fG8hJ1kN5oP0qS2uV4xA7yB9cD3eF5gH8iJ0kLm';
/**
 * A valid AES-256 key for the production boots below.
 *
 * `config.js` requires `TFA_ENCRYPTION_KEY` in production — an absent one is a
 * fatal boot guard, the same as a missing `JWT_SECRET`. These tests are about
 * other guards entirely, so they supply a real key for the same reason they
 * supply `STRONG` above: to reach the thing they are actually testing.
 */
const TFA_KEY = 'c3VwZXJzZWNyZXRrZXkxMjM0NTY3ODkwYWJjZGVmZ2g=';

const PROD = { NODE_ENV: 'production', JWT_SECRET: STRONG, TFA_ENCRYPTION_KEY: TFA_KEY, REQUIRE_ADMIN_2FA: 'true' };
const GOOGLE = { GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'secret' };
const MICROSOFT = { MICROSOFT_CLIENT_ID: 'ms-id', MICROSOFT_CLIENT_SECRET: 'ms-secret' };

describe('OAUTH_REDIRECT_URI in production', () => {
  it('refuses to boot when a provider is configured and the URI still points at localhost', () => {
    const r = boot({ ...PROD, ...GOOGLE, OAUTH_REDIRECT_URI: '' });
    expect(r.booted).toBe(false);
    expect(r.stderr).toMatch(/OAUTH_REDIRECT_URI/);
  });

  it('names the actual problem — a loopback address — in the message', () => {
    const r = boot({ ...PROD, ...GOOGLE, OAUTH_REDIRECT_URI: '' });
    expect(r.stderr).toMatch(/localhost|loopback/i);
  });

  it('refuses an explicit localhost URI just as firmly as the default', () => {
    const r = boot({ ...PROD, ...GOOGLE, OAUTH_REDIRECT_URI: 'http://localhost:5173/oauth/callback' });
    expect(r.booted).toBe(false);
  });

  it('refuses 127.0.0.1 and ::1 too', () => {
    for (const uri of ['http://127.0.0.1:5173/oauth/callback', 'http://[::1]:5173/oauth/callback']) {
      expect(boot({ ...PROD, ...GOOGLE, OAUTH_REDIRECT_URI: uri }).booted, uri).toBe(false);
    }
  });

  it('applies to Microsoft as well, not just Google', () => {
    const r = boot({ ...PROD, ...MICROSOFT, OAUTH_REDIRECT_URI: '' });
    expect(r.booted).toBe(false);
    expect(r.stderr).toMatch(/OAUTH_REDIRECT_URI/);
  });

  /**
   * The guard that was missing on 2026-09-12.
   *
   * Production ran `OAUTH_REDIRECT_URI=https://app.wevolunteers.org/api/auth/google/callback`
   * for fifteen days. The host is not a loopback address, so every check above
   * passed and the server booted reporting google enabled. That path has never
   * been served by anything — the SPA renders the callback at
   * OAUTH_CALLBACK_PATH — so Google was asked to deliver authorization codes to
   * a 404 and sign-in was dead for everyone who pressed the button.
   *
   * A wrong path fails exactly like a forgotten variable: silently, at the
   * provider, on a path the application advertises as working.
   */
  it('refuses a redirect URI whose path is not the route the SPA serves', () => {
    const r = boot({ ...PROD, ...GOOGLE, OAUTH_REDIRECT_URI: 'https://volunteers.example.org/api/auth/google/callback' });
    expect(r.booted).toBe(false);
    expect(r.stderr).toMatch(/OAUTH_REDIRECT_URI/);
  });

  it('names the path it expected, so the fix does not need a code read', () => {
    const r = boot({ ...PROD, ...GOOGLE, OAUTH_REDIRECT_URI: 'https://volunteers.example.org/api/auth/google/callback' });
    expect(r.stderr).toContain(OAUTH_CALLBACK_PATH);
  });

  it('refuses the root, which is the other plausible wrong guess', () => {
    const r = boot({ ...PROD, ...GOOGLE, OAUTH_REDIRECT_URI: 'https://volunteers.example.org/' });
    expect(r.booted).toBe(false);
  });

  /* Providers match the redirect URI exactly, so a trailing slash is a
     different string to Google and fails there too. Refusing it at boot turns
     a redirect_uri_mismatch nobody can see into a message at the moment the
     value is set. */
  it('refuses a trailing slash rather than quietly accepting it', () => {
    const r = boot({ ...PROD, ...GOOGLE, OAUTH_REDIRECT_URI: `https://volunteers.example.org${OAUTH_CALLBACK_PATH}/` });
    expect(r.booted).toBe(false);
  });

  it('applies to Microsoft too — the path is the provider-independent half', () => {
    const r = boot({ ...PROD, ...MICROSOFT, OAUTH_REDIRECT_URI: 'https://volunteers.example.org/api/auth/microsoft/callback' });
    expect(r.booted).toBe(false);
  });

  /* A query string or fragment is not part of the path and providers ignore
     neither; this asserts the check reads pathname rather than the whole URL,
     so a legitimate value is not refused for containing a `?`. */
  it('accepts the correct path even with a query string attached', () => {
    const r = boot({ ...PROD, ...GOOGLE, OAUTH_REDIRECT_URI: `https://volunteers.example.org${OAUTH_CALLBACK_PATH}?district=westfield` });
    expect(r.booted).toBe(true);
  });

  it('does NOT apply outside production, where the dev default is correct', () => {
    const r = boot({ NODE_ENV: 'development', JWT_SECRET: STRONG, ...GOOGLE, OAUTH_REDIRECT_URI: 'http://localhost:5173/anything' });
    expect(r.booted).toBe(true);
  });

  it('does NOT apply when no provider is configured', () => {
    const r = boot({ ...PROD, OAUTH_REDIRECT_URI: 'https://volunteers.example.org/nonsense' });
    expect(r.booted).toBe(true);
  });

  it('boots with a real https redirect URI', () => {
    const r = boot({ ...PROD, ...GOOGLE, OAUTH_REDIRECT_URI: 'https://volunteers.example.org/oauth/callback' });
    expect(r.booted).toBe(true);
    expect(r.stdout).toContain('https://volunteers.example.org/oauth/callback');
  });

  // An email-only district is a supported, normal deployment. It must not be
  // forced to set a variable for a feature it does not use.
  it('does NOT require the URI when no provider is configured', () => {
    const r = boot({ ...PROD, OAUTH_REDIRECT_URI: '' });
    expect(r.booted).toBe(true);
  });

  // Development is where the localhost default belongs.
  it('leaves development alone', () => {
    const r = boot({ NODE_ENV: 'development', JWT_SECRET: STRONG, ...GOOGLE, OAUTH_REDIRECT_URI: '' });
    expect(r.booted).toBe(true);
    expect(r.stdout).toContain('localhost');
  });

  it('warns but still boots on a non-HTTPS production URI (providers reject it, we cannot)', () => {
    const r = boot({ ...PROD, ...GOOGLE, OAUTH_REDIRECT_URI: 'http://volunteers.example.org/oauth/callback' });
    expect(r.booted).toBe(true);
    expect(r.stderr).toMatch(/WARNING: OAUTH_REDIRECT_URI is not https/);
  });
});

/**
 * OAUTH_ALLOW_MOCK — the guard with the worst consequence and, until now, no test.
 *
 * The mock transport skips the provider code exchange entirely and takes the
 * identity straight out of the request body, so with it enabled
 * `POST /api/oauth/google/callback` with
 * `{"code":"{\"email\":\"admin@district.org\",\"sub\":\"1\"}"}` is an
 * unauthenticated sign-in as any account, including a super administrator. It is
 * the single most dangerous configuration this application can hold.
 *
 * `config.js` has carried the refusal since the mock was made opt-in, and its
 * header documents the incident behind it — but nothing pinned it. Every other
 * production boot guard in this file and in `config.jwtSecret.test.js` is covered;
 * this one was covered by its own comment. The comment above `describe('OAUTH_
 * REDIRECT_URI in production')` even cites it as precedent ("a placeholder
 * JWT_SECRET and OAUTH_ALLOW_MOCK in production both refuse to boot") while
 * asserting nothing about it.
 *
 * Two properties matter and they are separate. The refusal is what stops a
 * deliberate mistake; the DEFAULT is what protects the deployment that never
 * heard of the variable, which is every real one.
 */
describe('OAUTH_ALLOW_MOCK in production', () => {
  it('refuses to boot a production process that enables the mock transport', () => {
    const r = boot({ ...PROD, OAUTH_ALLOW_MOCK: 'true' });
    expect(r.booted).toBe(false);
  });

  it('says why, in terms an operator can act on', () => {
    const r = boot({ ...PROD, OAUTH_ALLOW_MOCK: 'true' });
    // The message has to name the consequence, not just the variable: "unset
    // OAUTH_ALLOW_MOCK" is not a reason to take a production outage.
    expect(r.stderr).toMatch(/OAUTH_ALLOW_MOCK/);
    expect(r.stderr).toMatch(/sign in as any user|unsigned identity/i);
  });

  it('refuses even with real provider credentials and a correct redirect URI', () => {
    // The dangerous combination is not "misconfigured OAuth". It is a production
    // process that looks entirely correct and also accepts a forged identity.
    const r = boot({
      ...PROD, ...GOOGLE, OAUTH_ALLOW_MOCK: 'true',
      OAUTH_REDIRECT_URI: 'https://volunteers.example.org/oauth/callback',
    });
    expect(r.booted).toBe(false);
    expect(r.stderr).toMatch(/OAUTH_ALLOW_MOCK/);
  });

  it('defaults OFF in production, so an operator who never heard of it is safe', () => {
    const r = boot({ ...PROD, OAUTH_ALLOW_MOCK: '' });
    expect(r.booted).toBe(true);
  });

  it('and the providers it would have force-enabled report unavailable', () => {
    // OAUTH_PROVIDERS_ENABLED ORs the mock flag in, so a mock left on would
    // advertise "Continue with Google" on a deployment with no Google credentials.
    // With no provider configured and no mock, both must be false.
    const root = process.cwd().replace(/\\/g, '/');
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', `
        const c = await import('${root}/server/config.js');
        console.log('MOCK:' + c.OAUTH_ALLOW_MOCK
          + ' GOOGLE:' + c.OAUTH_PROVIDERS_ENABLED.google
          + ' MICROSOFT:' + c.OAUTH_PROVIDERS_ENABLED.microsoft);
      `], { env: { ...process.env, ...PROD, OAUTH_ALLOW_MOCK: '' }, encoding: 'utf8' });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('MOCK:false GOOGLE:false MICROSOFT:false');
  });

  it('stays available in development, which is what it is for', () => {
    const r = boot({ NODE_ENV: 'development', JWT_SECRET: STRONG, OAUTH_ALLOW_MOCK: 'true' });
    expect(r.booted).toBe(true);
  });
});
