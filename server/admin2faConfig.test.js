import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `REQUIRE_ADMIN_2FA` — the switch that decides whether an administrator must
 * hold a second factor.
 *
 * ── Why this boots a SUBPROCESS instead of re-importing config.js ──
 *
 * The first version of this file did `vi.resetModules()` plus a `?test=N`
 * query-string cache-buster and wrote `NODE_ENV`, `JWT_SECRET` and
 * `TFA_ENCRYPTION_KEY` onto `process.env` — restoring only `REQUIRE_ADMIN_2FA`
 * in `afterEach`. Everything else was left behind for whatever else shared the
 * worker, including a `NODE_ENV` of `production` or `development` depending on
 * which case ran last. That is a cross-file flake generator, and it is exactly
 * why `config.jwtSecret.test.js` and `config.cookieOptions.test.js` spawn a
 * child process for the same job. This does what they do.
 *
 * It also means the assertions are about a real boot rather than a re-import,
 * which is the thing the production guard actually has to survive.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* 43 base64 characters → exactly 32 bytes, which is what resolveTfaKey demands.
   Required because the key is resolved ABOVE the block under test, so a bad one
   would fail this file on the wrong error. */
const TFA_KEY = 'c3VwZXJzZWNyZXRrZXkxMjM0NTY3ODkwYWJjZGVmZ2g=';
const STRONG_JWT = 'JXAvK3n2Qp7RtY9wLmZbC4dE6fG8hJ1kN5oP0qS2uV4xA7yB9cD3eF5gH8iJ0kLm';

/**
 * Boots config.js in a child process and reports what it decided.
 *
 * `REQUIRE_ADMIN_2FA` is deleted from the inherited environment unless the case
 * supplies one — otherwise the developer's own `.env` would decide the result of
 * the "unset" cases, which are the ones that matter most here.
 */
function boot(env) {
  const childEnv = { ...process.env, JWT_SECRET: STRONG_JWT, TFA_ENCRYPTION_KEY: TFA_KEY };
  delete childEnv.REQUIRE_ADMIN_2FA;
  delete childEnv.DEMO_MODE;
  Object.assign(childEnv, env);

  try {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
      const { REQUIRE_ADMIN_2FA } = await import('${root}/server/config.js');
      console.log('BOOTED:' + REQUIRE_ADMIN_2FA);
    `], { env: childEnv, stdio: 'pipe', encoding: 'utf8' });
    return { booted: true, value: out.includes('BOOTED:true') };
  } catch (err) {
    return { booted: false, stderr: String(err.stderr || err.message) };
  }
}

describe('REQUIRE_ADMIN_2FA', () => {
  /**
   * The default, and the reason it is the default.
   *
   * It shipped as `=== 'true'`, so an unset variable meant DISABLED, guarded
   * only by the production throw. Production was therefore safe and every other
   * environment — staging, CI, a pilot with real students on it, a demo in
   * front of a district — silently ran with administrator 2FA off, on a
   * variable no env template mentioned.
   *
   * A security control that is off wherever somebody forgot is off in the
   * places with the least review. The default is now ON, and switching it off
   * is a visible line in an env file.
   */
  it('is ON when the variable is not set at all', () => {
    const res = boot({ NODE_ENV: 'development' });
    expect(res.booted, res.stderr).toBe(true);
    expect(res.value).toBe(true);
  });

  it('is ON when the variable is not set, in production too', () => {
    const res = boot({ NODE_ENV: 'production', APP_URL: 'https://volunteers.example.org' });
    expect(res.booted, res.stderr).toBe(true);
    expect(res.value).toBe(true);
  });

  it('can be switched off outside production', () => {
    const res = boot({ NODE_ENV: 'development', REQUIRE_ADMIN_2FA: 'false' });
    expect(res.booted, res.stderr).toBe(true);
    expect(res.value).toBe(false);
  });

  /**
   * The guard that survives the default.
   *
   * The default now satisfies production on its own, so this case is not about
   * an operator who forgot — it is about the one who set `false` for a local
   * reason and let that value reach the production environment file.
   */
  it('refuses to boot production when it is switched off', () => {
    const res = boot({
      NODE_ENV: 'production',
      REQUIRE_ADMIN_2FA: 'false',
      APP_URL: 'https://volunteers.example.org',
    });
    expect(res.booted).toBe(false);
    expect(res.stderr).toMatch(/REQUIRE_ADMIN_2FA must not be "false" in production/);
  });

  /**
   * A typo is a boot error, not a silent `false`.
   *
   * `Boolean('yes')` and `'yes' === 'true'` disagree, and the second is what a
   * hand-written parser usually does — so `REQUIRE_ADMIN_2FA=yes`, written by
   * somebody trying to turn the control ON, would have turned it off. Naming
   * the received value in the message is what makes that a five-second fix.
   */
  it.each(['yes', 'TRUE', '1', ''])('refuses the unparseable value %o', (value) => {
    const res = boot({ NODE_ENV: 'development', REQUIRE_ADMIN_2FA: value });
    expect(res.booted).toBe(false);
    expect(res.stderr).toMatch(/REQUIRE_ADMIN_2FA must be "true", "false", or undefined/);
  });
});
