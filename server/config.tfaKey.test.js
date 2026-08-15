import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import crypto from 'node:crypto';

/**
 * The two-factor encryption-key guard.
 *
 * ── The hole this closes ──
 *
 * `TFA_ENCRYPTION_KEY` encrypts every stored two-factor secret. It was validated
 * for base64 validity and for decoding to 32 bytes, and for nothing else — while
 * `JWT_SECRET`, a hundred lines above in the same file, refused placeholders and
 * low-entropy values.
 *
 * The development key is `AAAA…=`. That is valid base64, decodes to exactly 32
 * bytes, and every one of those bytes is ZERO. So an operator who copied it out
 * of `config.js` — where it is published — into
 * `/etc/wevolunteer/wevolunteer.env` would have booted production with AES-256
 * keyed on a constant of all zeros, and nothing anywhere would have complained.
 *
 * The consequence is not subtle: anyone who reads the database can then decrypt
 * every TOTP secret and mint valid codes for any account, including an
 * administrator. That is precisely what the second factor exists to prevent.
 *
 * `config.js` validates at import time, so each case runs in its own subprocess.
 */
/**
 * `spawnSync`, not `execFileSync`, so BOTH streams are captured on success.
 *
 * The development warning is written to stderr, and `execFileSync` returns only
 * stdout when the process exits cleanly — so the test asserting that a weak dev
 * key warns had nothing to look at and failed against working code. Found by
 * writing the assertion and watching it fail for the wrong reason.
 */
function boot(env) {
  const root = process.cwd().replace(/\\/g, '/');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const { TFA_ENCRYPTION_KEY } = await import('${root}/server/config.js');
      console.log('BOOTED:' + Buffer.from(TFA_ENCRYPTION_KEY, 'base64').length);
    `], { env: { ...process.env, ...env }, encoding: 'utf8' });
  return { booted: r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/** A strong JWT secret, so these tests reach the guard they are actually about. */
const STRONG_JWT = 'JXAvK3n2Qp7RtY9wLmZbC4dE6fG8hJ1kN5oP0qS2uV4xA7yB9cD3eF5gH8iJ0kLm';

/** The key published in config.js as the development fallback. 32 zero bytes. */
const DEV_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

const realKey = () => crypto.randomBytes(32).toString('base64');

const prod = (env) => boot({ NODE_ENV: 'production', JWT_SECRET: STRONG_JWT, ...env });

describe('TFA_ENCRYPTION_KEY validation in production', () => {
  it('boots with a freshly generated 32-byte key', () => {
    /* The positive case first: a guard that refuses everything is not a guard,
       and this is what a correctly configured deployment supplies. */
    const r = prod({ TFA_ENCRYPTION_KEY: realKey() });
    expect(r.booted, r.stderr).toBe(true);
    expect(r.stdout).toContain('BOOTED:32');
  });

  it('REFUSES the development key published in the source', () => {
    /**
     * The realistic failure, and the one that was passing. Nobody invents
     * `AAAA…=`; they copy it from the file that documents it.
     */
    const r = prod({ TFA_ENCRYPTION_KEY: DEV_KEY });
    expect(r.booted, 'production booted with the published development key').toBe(false);
    expect(r.stderr).toMatch(/development key published in this source file/);
  });

  it('refuses a key with no real entropy, whatever its value', () => {
    /**
     * Not just the dev key by name. A hand-typed key of repeated characters is
     * the same defect wearing a different value, and an equality check on one
     * constant would miss it.
     */
    const repeated = Buffer.alloc(32, 0x41).toString('base64'); // 32 × 'A'
    const r = prod({ TFA_ENCRYPTION_KEY: repeated });
    expect(r.booted, 'a 32-byte key of one repeated byte was accepted').toBe(false);
    expect(r.stderr).toMatch(/distinct byte values/);
  });

  it('still refuses a missing key', () => {
    const r = prod({ TFA_ENCRYPTION_KEY: '' });
    expect(r.booted).toBe(false);
    expect(r.stderr).toMatch(/TFA_ENCRYPTION_KEY is not set/);
  });

  it('still refuses a key of the wrong length', () => {
    const r = prod({ TFA_ENCRYPTION_KEY: crypto.randomBytes(16).toString('base64') });
    expect(r.booted).toBe(false);
    expect(r.stderr).toMatch(/must decode to 32 bytes/);
  });

  it('never prints the key it is refusing', () => {
    /**
     * A boot guard that echoes the value writes it into every log, CI transcript
     * and terminal-scrollback the failure passes through — which is a worse
     * disclosure than the weak key itself, because a real key would be echoed
     * the same way by any later message that copied this shape.
     */
    const key = realKey();
    const r = prod({ TFA_ENCRYPTION_KEY: key.slice(0, 20) }); // wrong length: refused
    expect(r.booted).toBe(false);
    expect(r.stderr, 'the refusal echoed the key').not.toContain(key.slice(0, 20));
  });

  it('accepts the development key in development, so local work is unaffected', () => {
    /**
     * Deliberately NOT fatal outside production. Refusing to boot locally over
     * the documented development key is how somebody ends up pasting a real
     * production key into their `.env` to get past it — which is the outcome
     * this whole guard exists to avoid.
     */
    const r = boot({ NODE_ENV: 'development', TFA_ENCRYPTION_KEY: DEV_KEY });
    expect(r.booted, r.stderr).toBe(true);
  });

  it('warns loudly in development rather than passing in silence', () => {
    const r = boot({ NODE_ENV: 'development', TFA_ENCRYPTION_KEY: DEV_KEY });
    expect(r.stdout + (r.stderr || '')).toMatch(/WARNING|not usable/);
  });
});
