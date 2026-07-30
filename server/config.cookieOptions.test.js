import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';

/**
 * cookieOptions() must gate `secure` on production.
 *
 * The route-level assertion in routes.cookieAuth.test.js
 * ("does not mark the cookie Secure outside production") proves only the
 * ambient default: testServer.js never sets NODE_ENV, so IS_PRODUCTION is
 * always false during that suite. A regression that deleted the gate and
 * hardcoded `secure: false` would keep that suite green, and a session cookie
 * without Secure in production travels in cleartext.
 *
 * So this test imports config.js in a fresh subprocess under each environment
 * and reads cookieOptions() directly. It is the same pattern as
 * email.production.test.js, which is how the production-only boot guards
 * (SMTP, APP_URL) are verified there.
 *
 * Each case runs in its own subprocess for a clean module state: config.js
 * reads process.env at import time, and the host's env must not leak in.
 */
function importCookieOptions(env) {
  const root = process.cwd().replace(/\\/g, '/');
  try {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
      const { COOKIE_NAME, cookieOptions } = await import('${root}/server/config.js');
      console.log('NAME=' + COOKIE_NAME);
      console.log('OPTS=' + JSON.stringify(cookieOptions()));
    `], {
      cwd: process.cwd(),
      // Start from a clean slate so the host's own env cannot leak in.
      // JWT_SECRET is required by config.js at import time. The value is
      // unused here — the test only reads cookieOptions() — but a missing or
      // WEAK value throws before the import resolves, and the throw would mask
      // the real test signal (the cookie shape). config.js now rejects a secret
      // under 32 characters in production, so this has to be a realistic one;
      // the previous 30-character placeholder made these cases fail for a reason
      // that had nothing to do with cookies.
      env: { ...process.env, NODE_ENV: '', JWT_SECRET: 'JXAvK3n2Qp7RtY9wLmZbC4dE6fG8hJ1kN5oP0qS2uV4xA7yB9cD3eF5gH8iJ0kLm', ...env },
      stdio: 'pipe',
      encoding: 'utf8'
    });
    const name = out.match(/^NAME=(.*)$/m)?.[1];
    const opts = JSON.parse(out.match(/^OPTS=(.*)$/m)?.[1]);
    return { code: 0, name, opts };
  } catch (err) {
    return { code: err.status ?? 1, out: (err.stdout || '') + (err.stderr || '') };
  }
}

describe('cookieOptions()', () => {
  it('marks the cookie Secure in production', () => {
    const { code, opts } = importCookieOptions({ NODE_ENV: 'production' });
    expect(code).toBe(0);
    expect(opts.secure).toBe(true);
  });

  it('does not mark the cookie Secure outside production', () => {
    // Development runs over plain HTTP through the Vite proxy. A Secure cookie
    // is silently dropped there, which presents as "login works, every later
    // request is 401" — a failure with no visible cause.
    const { code, opts } = importCookieOptions({}); // NODE_ENV unset
    expect(code).toBe(0);
    expect(opts.secure).toBe(false);
  });

  it('keeps the cookie shape constant across environments', () => {
    // httpOnly and sameSite are not environment-dependent. httpOnly is the
    // half of the migration that closes script-readable storage; sameSite=lax
    // is the half of the no-CSRF-token argument that holds. If either ever
    // changes it must be a deliberate edit, not an accidental env leak.
    const dev = importCookieOptions({});
    const prod = importCookieOptions({ NODE_ENV: 'production' });
    for (const opts of [dev.opts, prod.opts]) {
      expect(opts.httpOnly).toBe(true);
      expect(opts.sameSite).toBe('lax');
      expect(opts.path).toBe('/');
    }
  });

  it('sets maxAge to 7 days and the cookie name to wev_session', () => {
    // 7 days must match the JWT's `expiresIn: '7d'`. A cookie that outlives
    // its token produces a confusing 403 on a session the browser still
    // believes in. The cookie name is the contract Task 5 and 6 read against.
    const { code, name, opts } = importCookieOptions({});
    expect(code).toBe(0);
    expect(name).toBe('wev_session');
    expect(opts.maxAge).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
