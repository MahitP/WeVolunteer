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

  it('refuses a loopback host even over https', () => {
    /* `https://localhost:5173` passes every other check — absolute, parseable,
       https — and is exactly what a development value looks like after someone
       adds a certificate to it. Every verification, reset, invitation and
       email-change link would then point at the recipient's own machine, and
       the mail would still send successfully, so nothing would report a fault. */
    for (const value of ['https://localhost:5173', 'https://127.0.0.1', 'https://[::1]:5173']) {
      const r = bootEmail({ APP_URL: value });
      expect(r.booted, `${value} was accepted`).toBe(false);
      expect(r.out).toMatch(/points at localhost in production/);
    }
  });
});

/**
 * The CORS development default must not survive into production.
 *
 * `CORS_ORIGINS` fell back to `http://localhost:5173,http://localhost:4173`
 * unconditionally, so a production process started without it granted those
 * origins credentialed cross-origin access to the live API — anything the
 * user happened to be running on those ports could act as them and read the
 * replies, on a deployment whose operator never configured CORS at all.
 */
describe('REQUIRE_EMAIL_VERIFICATION in production', () => {
  /**
   * A deployment may switch the gate off — it is a documented opt-out — but it
   * must not do so silently. With the gate off nothing in the sign-in path ever
   * consults `email_verified`, so an account registered against an address its
   * holder does not own works completely, and the only record is a line in an
   * env file. A warning, not a refusal, because refusing would overrule an
   * operator who meant it.
   */
  it('warns, and still boots', () => {
    const r = bootConfig({ REQUIRE_EMAIL_VERIFICATION: 'false' });
    expect(r.booted, r.out.slice(0, 300)).toBe(true);
    expect(r.out).toMatch(/REQUIRE_EMAIL_VERIFICATION=false in production/);
  });

  it('says nothing when the gate is left on', () => {
    const r = bootConfig({});
    expect(r.booted, r.out.slice(0, 300)).toBe(true);
    expect(r.out).not.toMatch(/REQUIRE_EMAIL_VERIFICATION=false/);
  });

  it('leaves development alone', () => {
    const r = bootConfig({ NODE_ENV: 'development', REQUIRE_EMAIL_VERIFICATION: 'false' });
    expect(r.booted, r.out.slice(0, 300)).toBe(true);
    expect(r.out).not.toMatch(/WARNING: REQUIRE_EMAIL_VERIFICATION/);
  });
});

describe('CORS_ORIGINS in production', () => {
  const origins = async (env) => {
    const root = process.cwd().replace(/\\/g, '/');
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
        const m = await import('${root}/server/config.js');
        console.log('ORIGINS:' + JSON.stringify(m.ALLOWED_ORIGINS));
      `], { env: { ...PRODUCTION, ...env }, encoding: 'utf8' });
    const line = ((r.stdout || '') + (r.stderr || '')).split('\n').find((l) => l.startsWith('ORIGINS:'));
    return { list: line ? JSON.parse(line.slice('ORIGINS:'.length)) : null, out: (r.stdout || '') + (r.stderr || '') };
  };

  it('does not grant localhost when CORS_ORIGINS is unset', async () => {
    const { list, out } = await origins({ CORS_ORIGINS: undefined });
    expect(list, out.slice(0, 400)).toEqual([]);
  });

  it('still applies the development default outside production', async () => {
    /* Removing the default in dev would break every Vite session. */
    const { list, out } = await origins({ NODE_ENV: 'development', CORS_ORIGINS: undefined });
    expect(list, out.slice(0, 400)).toContain('http://localhost:5173');
  });

  it('honours an explicit public origin', async () => {
    const { list } = await origins({ CORS_ORIGINS: 'https://volunteers.example.org' });
    expect(list).toEqual(['https://volunteers.example.org']);
  });

  it('refuses a loopback origin rather than ignoring it', async () => {
    /* Dropping it silently would leave the operator believing a configured
       origin is in force. */
    const r = bootConfig({ CORS_ORIGINS: 'https://volunteers.example.org,http://localhost:5173' });
    expect(r.booted).toBe(false);
    expect(r.out).toMatch(/loopback origin in production/);
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

/**
 * DEMO_MODE must not survive a production boot.
 *
 * The refusal lives in `server.js`, and it was the only one of the four
 * production refusals with no test behind it — APP_URL, TRUST_PROXY, the
 * encryption key, the email provider and OAUTH_ALLOW_MOCK all had one.
 *
 * What it prevents is not subtle. `completeDatabaseInit()` seeds the demo
 * accounts, and `db.js` prints a banner about them saying they "share a
 * PUBLISHED password". A production process that reached that call would stand
 * up a set of known-credential logins on a platform used by minors.
 *
 * ── Ordering, which the test also pins ──
 *
 * `import { app } from './app.js'` is hoisted above the check, so the database
 * handle is already open by the time the guard runs. That is tolerable because
 * the seeding is not at import time — it happens in `completeDatabaseInit()`,
 * further down `server.js`, and the process has exited before then. The
 * assertion on the seeding banner is what holds that ordering in place: if
 * seeding were ever moved into a module's import, this test fails rather than
 * the guard quietly becoming decorative.
 *
 * Runs `server.js` itself rather than a module, because the guard is there.
 * WEV_DB_PATH points at a throwaway file — a privileged boot must never be
 * pointed at a real database by a test.
 */
describe('DEMO_MODE cannot be enabled in production', () => {
  const bootServer = (env) => {
    const root = process.cwd().replace(/\\/g, '/');
    const r = spawnSync(process.execPath, [`${root}/server/server.js`], {
      env: {
        ...PRODUCTION,
        WEV_DB_PATH: `/tmp/wev-demo-guard-${process.pid}.db`,
        ...env,
      },
      encoding: 'utf8',
      timeout: 30_000,
    });
    return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
  };

  it('refuses to boot, and exits non-zero', () => {
    const r = bootServer({ DEMO_MODE: 'true' });

    expect(r.out).toMatch(/FATAL: DEMO_MODE cannot be enabled in production/);
    expect(r.status, 'a refusal that exits 0 is not a refusal').toBe(1);
  });

  it('exits before the demo accounts are seeded', () => {
    /* The banner `db.js` prints when it creates them. Its absence is the
       evidence that no published-password login was stood up. */
    const r = bootServer({ DEMO_MODE: 'true' });

    expect(r.out).not.toMatch(/PUBLISHED password/i);
  });
});

/**
 * The accessibility harness's volume-limiter exemption must not survive
 * production either.
 *
 * `WEV_A11Y_HARNESS=1` makes `apiLimiter` — the blanket 600-per-fifteen-minutes
 * volume control on `/api` — skip every request, so that `npm run a11y` can
 * complete in one invocation instead of exhausting the ceiling partway through.
 * In production that same flag would remove the only bound on how fast one
 * device may call the API.
 *
 * Two independent things stop it, and both are asserted here because either one
 * alone would be a single point of failure:
 *
 *   1. `config.js` requires `!IS_PRODUCTION` before `A11Y_HARNESS` is ever true,
 *      so even a process that somehow got past the boot check applies the
 *      limiter normally.
 *   2. `server.js` refuses to boot at all, so an operator who set the variable
 *      is told rather than left believing an exemption is active.
 */
describe('WEV_A11Y_HARNESS cannot be enabled in production', () => {
  const bootServer = (env) => {
    const root = process.cwd().replace(/\\/g, '/');
    const r = spawnSync(process.execPath, [`${root}/server/server.js`], {
      env: {
        ...PRODUCTION,
        WEV_DB_PATH: `/tmp/wev-a11y-guard-${process.pid}.db`,
        ...env,
      },
      encoding: 'utf8',
      timeout: 30_000,
    });
    return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
  };

  it('refuses to boot, and exits non-zero', () => {
    const r = bootServer({ WEV_A11Y_HARNESS: '1' });

    expect(r.out).toMatch(/FATAL: WEV_A11Y_HARNESS cannot be enabled in production/);
    expect(r.status, 'a refusal that exits 0 is not a refusal').toBe(1);
  });

  /**
   * The constant itself, evaluated in a production environment.
   *
   * Belt and braces against the boot guard being the only thing holding this:
   * if `A11Y_HARNESS` were ever computed without the `!IS_PRODUCTION` term, a
   * process that reached `app.js` by any path would silently have no volume
   * limiter.
   */
  it('is false in a production process even when the variable is set', () => {
    const root = process.cwd().replace(/\\/g, '/');
    const r = spawnSync(process.execPath, [
      '--input-type=module', '-e',
      `const c = await import('${root}/server/config.js');`
      + 'process.stdout.write(String(c.A11Y_HARNESS));',
    ], {
      env: { ...PRODUCTION, WEV_A11Y_HARNESS: '1', WEV_DB_PATH: `/tmp/wev-a11y-const-${process.pid}.db` },
      encoding: 'utf8',
      timeout: 30_000,
    });

    expect(r.stdout, r.stderr).toBe('false');
  });

  it('is true outside production when the variable is set', () => {
    /* The other half: a flag that is always false would make the case above
       pass while the harness stayed broken. */
    const root = process.cwd().replace(/\\/g, '/');
    const r = spawnSync(process.execPath, [
      '--input-type=module', '-e',
      `const c = await import('${root}/server/config.js');`
      + 'process.stdout.write(String(c.A11Y_HARNESS));',
    ], {
      env: {
        ...PRODUCTION,
        NODE_ENV: 'development',
        WEV_A11Y_HARNESS: '1',
        WEV_DB_PATH: `/tmp/wev-a11y-dev-${process.pid}.db`,
      },
      encoding: 'utf8',
      timeout: 30_000,
    });

    expect(r.stdout, r.stderr).toBe('true');
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Demo mode over a database that is somewhere else
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The gap the guard above leaves, and the one that actually bites.
 *
 * `IS_PRODUCTION && DEMO_MODE` keys on `NODE_ENV`, which a developer's laptop
 * does not set. `npm run dev` sets `DEMO_MODE=true` and reads the same `.env`
 * the server does — so the moment that file holds a real `DATABASE_URL`, the
 * command somebody types from muscle memory provisions a remote database and
 * seeds accounts whose shared password is published in the README, one of them
 * an administrator that demo mode exempts from the 2FA policy.
 *
 * Every case below runs WITHOUT `NODE_ENV=production`, because that is the
 * whole point: the existing refusal cannot fire, and this one must.
 *
 * No database is reachable in any of them. It does not need to be — the guard
 * sits above `initDatabase()`, and a `pg.Pool` does not connect until something
 * queries it. That ordering is itself an assertion: if the guard ever moved
 * below the first write, these cases would hang or fail instead of passing.
 */
describe('DEMO_MODE is refused when the database is not on this machine', () => {
  const DEV = {
    JWT_SECRET: STRONG_JWT,
    TFA_ENCRYPTION_KEY: STRONG_TFA,
    APP_URL: 'http://localhost:5173',
    WEV_DB_PATH: `/tmp/wev-remote-guard-${process.pid}.db`,
  };

  const bootServer = (env) => {
    const root = process.cwd().replace(/\\/g, '/');
    const r = spawnSync(process.execPath, [`${root}/server/server.js`], {
      env: { ...DEV, ...env },
      encoding: 'utf8',
      timeout: 30_000,
    });
    return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
  };

  const REMOTE = 'postgresql://postgres.abcdefghijklmnop:irrelevant@aws-0-us-east-2.pooler.supabase.com:5432/postgres';

  it('refuses, and exits non-zero, with no NODE_ENV=production in sight', () => {
    const r = bootServer({ DEMO_MODE: 'true', DATABASE_ENGINE: 'postgres', DATABASE_URL: REMOTE });

    expect(r.out).toMatch(/FATAL: DEMO_MODE is set and the database is not on this machine/);
    expect(r.status, 'a refusal that exits 0 is not a refusal').toBe(1);
  });

  it('names the database it refused to seed, so the message is actionable', () => {
    const r = bootServer({ DEMO_MODE: 'true', DATABASE_ENGINE: 'postgres', DATABASE_URL: REMOTE });
    expect(r.out).toMatch(/aws-0-us-east-2\.pooler\.supabase\.com:5432\/postgres/);
  });

  it('never reaches the seeding banner', () => {
    /* The banner `db.js` prints as it creates the published-password accounts.
       Its absence is the evidence that no such login was stood up. */
    const r = bootServer({ DEMO_MODE: 'true', DATABASE_ENGINE: 'postgres', DATABASE_URL: REMOTE });
    expect(r.out).not.toMatch(/seeding demo accounts/i);
  });

  it('does not print the password it was given', () => {
    const r = bootServer({
      DEMO_MODE: 'true',
      DATABASE_ENGINE: 'postgres',
      DATABASE_URL: 'postgresql://postgres.abc:sup3rs3cr3t-do-not-log@db.example.pooler.supabase.com:5432/postgres',
    });
    expect(r.out).not.toContain('sup3rs3cr3t-do-not-log');
  });

  it('leaves a LOCAL postgres alone, because that is the development loop', () => {
    const r = bootServer({
      DEMO_MODE: 'true',
      DATABASE_ENGINE: 'postgres',
      DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/wv_dev',
    });
    /* It may well fail for other reasons — nothing is listening — but it must
       not fail for THIS one. */
    expect(r.out).not.toMatch(/DEMO_MODE is set and the database is not on this machine/);
  });

  it('leaves SQLite alone even when a DATABASE_URL is lying around', () => {
    const r = bootServer({ DEMO_MODE: 'true', DATABASE_URL: REMOTE });
    expect(r.out).not.toMatch(/DEMO_MODE is set and the database is not on this machine/);
  });

  it('says so when DATABASE_URL is set but nothing will use it', () => {
    const r = bootServer({ DATABASE_URL: REMOTE });
    expect(r.out).toMatch(/DATABASE_URL is set but DATABASE_ENGINE is not "postgres"/);
  });
});
