import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';

/**
 * The signing-secret guard.
 *
 * Every session cookie is signed with JWT_SECRET, so a guessable value lets
 * anyone mint a token for any account — including an administrator — which
 * defeats every other access control in the codebase.
 *
 * The previous check only caught a MISSING secret. That is not the realistic
 * failure: the realistic failure is shipping with `your-super-secret-jwt-key`
 * copied out of .env.example, which passed silently and was found in the working
 * tree during the audit.
 *
 * config.js validates at import time, so each case runs in its own subprocess.
 */
function boot(env) {
  const root = process.cwd().replace(/\\/g, '/');
  try {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
      const { JWT_SECRET } = await import('${root}/server/config.js');
      console.log('BOOTED:' + JWT_SECRET.length);
    `], { env: { ...process.env, REQUIRE_ADMIN_2FA: 'true', ...env }, stdio: 'pipe', encoding: 'utf8' });
    return { booted: true, stdout: out };
  } catch (err) {
    return { booted: false, stderr: String(err.stderr || err.message) };
  }
}

/** 64 chars, high entropy — what `openssl rand -base64 48` produces. */
/**
 * A valid AES-256 key for the production boots below.
 *
 * `config.js` requires `TFA_ENCRYPTION_KEY` in production — an absent one is a
 * fatal boot guard, the same as a missing `JWT_SECRET`. These tests are about
 * other guards entirely, so they supply a real key for the same reason they
 * supply `STRONG` above: to reach the thing they are actually testing.
 */
const TFA_KEY = 'c3VwZXJzZWNyZXRrZXkxMjM0NTY3ODkwYWJjZGVmZ2g=';

const STRONG = 'JXAvK3n2Qp7RtY9wLmZbC4dE6fG8hJ1kN5oP0qS2uV4xA7yB9cD3eF5gH8iJ0kLm';

describe('JWT_SECRET validation in production', () => {
  it('boots with a strong secret', () => {
    const r = boot({ NODE_ENV: 'production', TFA_ENCRYPTION_KEY: TFA_KEY, JWT_SECRET: STRONG });
    expect(r.booted).toBe(true);
  });

  it('refuses to boot when the secret is missing', () => {
    const r = boot({ NODE_ENV: 'production', TFA_ENCRYPTION_KEY: TFA_KEY, JWT_SECRET: '' });
    expect(r.booted).toBe(false);
    expect(r.stderr).toMatch(/JWT_SECRET must be set/);
  });

  /** The exact value sitting in .env.example — the one that shipped. */
  it('refuses the placeholder from the template', () => {
    const r = boot({ NODE_ENV: 'production', TFA_ENCRYPTION_KEY: TFA_KEY, JWT_SECRET: 'your-super-secret-jwt-key' });
    expect(r.booted).toBe(false);
    expect(r.stderr).toMatch(/placeholder/i);
  });

  it('refuses the development fallback', () => {
    const r = boot({ NODE_ENV: 'production', TFA_ENCRYPTION_KEY: TFA_KEY, JWT_SECRET: 'dev-only-insecure-secret-do-not-use-in-production' });
    expect(r.booted).toBe(false);
  });

  it('refuses a secret shorter than 32 characters', () => {
    const r = boot({ NODE_ENV: 'production', TFA_ENCRYPTION_KEY: TFA_KEY, JWT_SECRET: 'abc123' });
    expect(r.booted).toBe(false);
    expect(r.stderr).toMatch(/32/);
  });

  /**
   * A repeated character passes a naive length check while carrying no entropy —
   * the shape a hurried "make the error go away" fix produces.
   */
  it('refuses a long but low-entropy secret', () => {
    const r = boot({ NODE_ENV: 'production', TFA_ENCRYPTION_KEY: TFA_KEY, JWT_SECRET: 'a'.repeat(64) });
    expect(r.booted).toBe(false);
    expect(r.stderr).toMatch(/entropy/i);
  });

  it('is case-insensitive about placeholders', () => {
    const r = boot({ NODE_ENV: 'production', TFA_ENCRYPTION_KEY: TFA_KEY, JWT_SECRET: 'YOUR-SUPER-SECRET-JWT-KEY' });
    expect(r.booted).toBe(false);
  });
});

describe('JWT_SECRET validation in development', () => {
  /**
   * Warn, never crash. Refusing to boot locally over a weak secret pushes people
   * to paste a real production secret into their dev .env to get past it, which
   * is a worse outcome than a warning.
   */
  it('warns but still boots on a weak secret', () => {
    const r = boot({ NODE_ENV: 'development', JWT_SECRET: 'your-super-secret-jwt-key' });
    expect(r.booted).toBe(true);
  });

  it('falls back and boots when nothing is set', () => {
    const r = boot({ NODE_ENV: 'development', JWT_SECRET: '' });
    expect(r.booted).toBe(true);
  });

  it('uses a strong secret unchanged when one is provided', () => {
    const r = boot({ NODE_ENV: 'development', JWT_SECRET: STRONG });
    expect(r.booted).toBe(true);
    expect(r.stdout).toContain(`BOOTED:${STRONG.length}`);
  });
});
