import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import crypto from 'node:crypto';

/**
 * The production boot guards that had no test.
 *
 * ── What a release audit found ──
 *
 * `JWT_SECRET` and `TFA_ENCRYPTION_KEY` are validated thoroughly and each has a
 * file of its own. Three more values decide whether this deployment is safe, and
 * between them they had one truthiness check:
 *
 *   - `APP_URL` was checked for PRESENCE only. It is concatenated into every
 *     password-reset and verification link, so a missing scheme, a stray quote,
 *     or an unexpanded shell variable all passed — and then mailed a live
 *     single-use token to whatever that string resolved to. `OAUTH_REDIRECT_URI`
 *     in the same codebase gets a full parse and a loopback refusal.
 *
 *   - `TRUST_PROXY` had NO production guard at all, while
 *     `deploy/wevolunteer.env.example` called it required. Unset behind a proxy,
 *     Express reads the proxy's address as the client's, so the sign-in, mail,
 *     export and re-auth limiters all share one bucket for the entire site: one
 *     person fumbling a password locks out a school, and a real attacker is
 *     throttled together with the people they are attacking.
 *
 *   - `TFA_ENCRYPTION_KEY`'s base64 check was unreachable. Node's decoder drops
 *     characters outside the alphabet rather than throwing, so the `try/catch`
 *     around it could never fire.
 *
 * Each case boots a subprocess, because these are import-time and process-exit
 * behaviours that cannot be observed in-process.
 */

const STRONG_JWT = 'JXAvK3n2Qp7RtY9wLmZbC4dE6fG8hJ1kN5oP0qS2uV4xA7yB9cD3eF5gH8iJ0kLm';
const STRONG_TFA = crypto.randomBytes(32).toString('base64');

/** Everything a production boot needs, so each case fails for its own reason. */
const PRODUCTION = {
  NODE_ENV: 'production',
  JWT_SECRET: STRONG_JWT,
  TFA_ENCRYPTION_KEY: STRONG_TFA,
  SMTP_HOST: 'smtp.example.org',
  SMTP_USER: 'mailer',
  SMTP_PASS: 'irrelevant-to-these-cases',
  APP_URL: 'https://volunteers.example.org',
  TRUST_PROXY: '1',
  WEV_DB_PATH: '/tmp/wev-guard-probe.db',
  REQUIRE_ADMIN_2FA: 'true',
};

/** Imports a module in a clean subprocess and reports whether it survived. */
function boot(moduleRelPath, env) {
  const root = process.cwd().replace(/\\/g, '/');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
      await import('${root}/${moduleRelPath}');
      console.log('BOOTED');
    `], { env: { ...PRODUCTION, ...env }, encoding: 'utf8' });
  return { booted: r.status === 0 && (r.stdout || '').includes('BOOTED'), out: (r.stdout || '') + (r.stderr || '') };
}

const bootEmail = (env) => boot('server/email.js', env);
const bootConfig = (env) => boot('server/config.js', env);

describe('APP_URL is validated, not merely present', () => {
  it('boots on a well-formed https URL', () => {
    const r = bootEmail({});
    expect(r.booted, r.out.slice(0, 400)).toBe(true);
  });

  it('refuses production with no APP_URL at all', () => {
    const r = bootEmail({ APP_URL: '' });
    expect(r.booted).toBe(false);
    expect(r.out).toMatch(/APP_URL must be set/);
  });

  it('refuses a value that is not a URL', () => {
    /* The unexpanded-shell-variable case, and the typo case. Both used to pass
       a truthiness check and then be concatenated into a reset link. */
    for (const value of ['$APP_URL', 'volunteers.example.org', 'not a url at all']) {
      const r = bootEmail({ APP_URL: value });
      expect(r.booted, `${value} was accepted`).toBe(false);
      expect(r.out).toMatch(/not a valid absolute URL/);
    }
  });

  it('refuses plaintext http in production', () => {
    /* These links carry single-use credentials. */
    const r = bootEmail({ APP_URL: 'http://volunteers.example.org' });
    expect(r.booted).toBe(false);
    expect(r.out).toMatch(/must use https/);
  });

  it('leaves development alone', () => {
    /* A local http URL is how everybody develops; the guard is production-only. */
    const r = bootEmail({ NODE_ENV: 'development', APP_URL: 'http://localhost:5173' });
    expect(r.booted, r.out.slice(0, 300)).toBe(true);
  });
});

describe('TRUST_PROXY is required in production', () => {
  it('refuses production when it is unset', () => {
    /**
     * The failure it prevents is silent and total: every per-IP limiter collapses
     * into one bucket, and nothing in the logs says so.
     */
    const r = boot('server/app.js', { TRUST_PROXY: '' });
    expect(r.booted).toBe(false);
    expect(r.out).toMatch(/TRUST_PROXY must be set in production/);
    expect(r.out, 'the message must say what to set it to').toMatch(/TRUST_PROXY=1/);
  });

  it('boots when it is set', () => {
    const r = boot('server/app.js', {});
    expect(r.booted, r.out.slice(0, 400)).toBe(true);
  });

  it('leaves development alone', () => {
    const r = boot('server/app.js', { NODE_ENV: 'development', TRUST_PROXY: '' });
    expect(r.booted, r.out.slice(0, 300)).toBe(true);
  });
});

describe('TFA_ENCRYPTION_KEY base64 validation actually runs', () => {
  it('refuses a non-base64 string that DECODES TO 32 BYTES ANYWAY', () => {
    /**
     * The only case that isolates this guard, and the dangerous one.
     *
     * `Buffer.from(x, 'base64')` never throws — it silently drops characters
     * outside the alphabet — so the original `try/catch` was unreachable. Junk
     * that decodes to the wrong LENGTH was caught by the 32-byte check by luck;
     * junk that happens to decode to exactly 32 bytes was not caught by anything,
     * and the process came up encrypting every stored two-factor secret with a
     * key the operator never configured and cannot reproduce.
     *
     * Built by injecting characters the decoder drops into a real key, so the
     * decoded length is unchanged and only the round-trip can tell.
     */
    const real = crypto.randomBytes(32).toString('base64');
    const junk = `${real.slice(0, 10)}!!!!${real.slice(10)}`;
    expect(Buffer.from(junk, 'base64').length, 'fixture must reach the guard under test').toBe(32);

    const r = bootConfig({ TFA_ENCRYPTION_KEY: junk });
    expect(r.booted, 'a key the operator never configured was accepted').toBe(false);
    expect(r.out).toMatch(/not valid base64/);
  });

  it('refuses junk of the wrong length too', () => {
    const r = bootConfig({ TFA_ENCRYPTION_KEY: '!!!! this is not base64 at all !!!!****' });
    expect(r.booted).toBe(false);
    expect(r.out).toMatch(/not valid base64|must decode to 32 bytes/);
  });

  it('still accepts a legitimately padded key', () => {
    /* Padding and line wrapping are cosmetic and must not be rejected. */
    const r = bootConfig({ TFA_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64') });
    expect(r.booted, r.out.slice(0, 300)).toBe(true);
  });

  it('still refuses the published development key', () => {
    /* The pre-existing guard, asserted here so the base64 rewrite cannot have
       quietly moved the all-zero key back into the accepted set. */
    const r = bootConfig({ TFA_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64') });
    expect(r.booted).toBe(false);
  });
});
