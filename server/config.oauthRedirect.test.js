import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';

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
const PROD = { NODE_ENV: 'production', JWT_SECRET: STRONG };
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
