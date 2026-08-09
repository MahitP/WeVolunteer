import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * OAuth must never invent a user.
 *
 * ── The incident ──
 *
 * A developer with working Google credentials in `.env` pressed "Continue with
 * Google", was redirected to Google, authenticated for real, and came back to a
 * signup form prefilled with **"Mock User"** and **"mock@example.com"**.
 *
 * Two independent defects had to line up, and both are fixed:
 *
 *   1. `OAUTH_ALLOW_MOCK` defaulted to `!IS_PRODUCTION` — on in every process
 *      that was not production. `verifyCallback` tests that flag BEFORE
 *      attempting the code exchange, so the mock shadowed the real credentials
 *      and the real integration could not be exercised at all.
 *   2. The mock branch ended in `catch { return { name: 'Mock User', … } }`, so a
 *      `code` it could not parse — which is exactly what a genuine opaque
 *      authorization code is — produced a fabricated identity instead of an
 *      error.
 *
 * Either alone is a bug; together they silently converted a real sign-in into a
 * fake account. The first defect is the one that mattered in production terms:
 * the same shape of mistake had already been fixed once, when the mock switched
 * itself on whenever the client id was absent, and it came back as a default.
 *
 * This file is the regression guard for the class, not just the instance.
 */

/** Source files that could reach a user, i.e. everything but tests and this file. */
function productionSources() {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'scratch') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(js|jsx|mjs)$/.test(entry.name)) continue;
      if (/\.test\.(js|jsx)$/.test(entry.name)) continue;
      files.push(full);
    }
  };
  walk(path.join(ROOT, 'server'));
  walk(path.join(ROOT, 'src'));
  walk(path.join(ROOT, 'bin'));
  return files;
}

/**
 * Removes comments, keeping line numbering intact.
 *
 * Block comments are replaced newline-for-newline so a reported line number
 * still points at the right line of the original file. Not a JS parser — it does
 * not understand a `//` inside a string literal — and it does not need to be: a
 * false negative here is a comment that mentions the strings, which is exactly
 * what is allowed, and the assertion below proves the scan still detects real
 * code.
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('no fabricated OAuth identity exists in the product', () => {
  /**
   * The literal strings, gone from CODE.
   *
   * Asserted by scanning rather than by exercising a code path, because the
   * defect was a FALLBACK — a branch nothing ran until a real authorization code
   * arrived. The only reliable way to know it is not lurking in a third provider
   * is that the strings are absent.
   *
   * Comments are STRIPPED before scanning rather than whole files being
   * excluded. Two reasons, and the second is the important one:
   *   - `config.js` and `mockTransport.js` both quote the removed code in their
   *     postmortems, and a guard that forbids describing the bug it prevents
   *     makes the codebase worse.
   *   - Excluding those files by name would have exempted `mockTransport.js` —
   *     the one file most able to reintroduce this — from its own guard.
   */
  it('contains no placeholder identity strings in executable code', () => {
    const FORBIDDEN = /Mock User|mock@example\.com|Mock MS User|mock_ms@example\.com/;
    const offenders = [];

    for (const file of productionSources()) {
      const code = stripComments(readFileSync(file, 'utf8'));
      code.split('\n').forEach((line, i) => {
        if (FORBIDDEN.test(line)) {
          offenders.push(`${path.relative(ROOT, file)}:${i + 1} — ${line.trim().slice(0, 80)}`);
        }
      });
    }

    expect(offenders, 'a fabricated OAuth identity is reachable from product code').toEqual([]);
  });

  /**
   * And the scan can fail. A guard nobody has watched fail is a guard nobody
   * knows the shape of.
   */
  it('would notice a placeholder identity in code, and ignore one in prose', () => {
    const FORBIDDEN = /Mock User|mock@example\.com/;
    /* Real code: caught. */
    expect(FORBIDDEN.test(stripComments("return { name: 'Mock User' };"))).toBe(true);
    /* A postmortem describing it: allowed, both comment forms. */
    expect(FORBIDDEN.test(stripComments("// it returned 'Mock User' before"))).toBe(false);
    expect(FORBIDDEN.test(stripComments("/* returned mock@example.com */"))).toBe(false);
    /* And an ordinary line is not a false positive. */
    expect(FORBIDDEN.test(stripComments("return { name: payload.name };"))).toBe(false);
  });
});

/**
 * The flag's default, proved by booting config.js rather than by reading it.
 *
 * A subprocess because `config.js` decides everything at module scope and the
 * sibling config suites spawn for the same reason — mutating `process.env` in a
 * shared worker leaks into whatever else runs there.
 */
function bootConfig(env) {
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
    const c = await import('${ROOT}/server/config.js');
    console.log('MOCK:' + c.OAUTH_ALLOW_MOCK);
  `], {
    env: {
      ...process.env,
      JWT_SECRET: 'JXAvK3n2Qp7RtY9wLmZbC4dE6fG8hJ1kN5oP0qS2uV4xA7yB9cD3eF5gH8iJ0kLm',
      TFA_ENCRYPTION_KEY: 'c3VwZXJzZWNyZXRrZXkxMjM0NTY3ODkwYWJjZGVmZ2g=',
      OAUTH_ALLOW_MOCK: undefined,
      ...env,
    },
    encoding: 'utf8',
    stdio: 'pipe',
  });
  return out.includes('MOCK:true');
}

describe('OAUTH_ALLOW_MOCK', () => {
  /**
   * The regression that produced "Mock User" for a developer holding real
   * credentials. Development is the environment where somebody is most likely to
   * have working credentials AND be testing the real flow, so it is the worst
   * possible place for the mock to be on by default.
   */
  it('is OFF when unset in development', () => {
    expect(bootConfig({ NODE_ENV: 'development' })).toBe(false);
  });

  it('is OFF when unset with no NODE_ENV at all', () => {
    expect(bootConfig({ NODE_ENV: '' })).toBe(false);
  });

  it('is on only when explicitly asked for', () => {
    expect(bootConfig({ NODE_ENV: 'development', OAUTH_ALLOW_MOCK: 'true' })).toBe(true);
  });

  it('treats any other value as off rather than guessing', () => {
    for (const value of ['1', 'yes', 'TRUE', '']) {
      expect(bootConfig({ NODE_ENV: 'development', OAUTH_ALLOW_MOCK: value }), value).toBe(false);
    }
  });

  /**
   * The production refusal, unchanged and re-pinned here.
   *
   * The default now satisfies production on its own, so this is about the
   * operator who set the flag for a local reason and let the value reach a
   * production environment file.
   */
  it('refuses to boot a production process that enables it', () => {
    let threw = false;
    try {
      bootConfig({
        NODE_ENV: 'production',
        OAUTH_ALLOW_MOCK: 'true',
        APP_URL: 'https://volunteers.example.org',
      });
    } catch (err) {
      threw = true;
      expect(String(err.stderr)).toMatch(/OAUTH_ALLOW_MOCK=true is set in a production process/);
    }
    expect(threw, 'production booted with the mock transport enabled').toBe(true);
  });
});

describe('the mock transport refuses to invent an identity', () => {
  /**
   * Imported dynamically, and the flag is forced on for this suite only.
   *
   * `mockTransport.js` reads `OAUTH_ALLOW_MOCK` from config.js at import time, so
   * the environment has to be set before the first import — and `db.js` must not
   * be reached at module scope by anything here (it is not; this module imports
   * only config.js).
   */
  async function transport() {
    process.env.OAUTH_ALLOW_MOCK = 'true';
    return (await import('./oauth/mockTransport.js')).mockVerifyCallback;
  }

  it('throws on a real authorization code instead of fabricating a user', async () => {
    const mockVerifyCallback = await transport();
    /* What Google actually sends back: an opaque string. This is the exact input
       that used to produce "Mock User". */
    expect(() => mockVerifyCallback('google', '4/0AeanS0bQ-realish-opaque-code'))
      .toThrow(/expected a JSON identity/);
  });

  it('names the remedy in the error, because this is what a misconfigured dev hits', async () => {
    const mockVerifyCallback = await transport();
    expect(() => mockVerifyCallback('google', 'not-json'))
      .toThrow(/Unset OAUTH_ALLOW_MOCK to use the real google flow/);
  });

  it('requires both an email and a subject id', async () => {
    const mockVerifyCallback = await transport();
    expect(() => mockVerifyCallback('google', JSON.stringify({ email: 'a@b.org' })))
      .toThrow(/requires both "email" and "sub"/);
    expect(() => mockVerifyCallback('google', JSON.stringify({ sub: '1' })))
      .toThrow(/requires both "email" and "sub"/);
  });

  it('refuses a JSON value that is not an object', async () => {
    const mockVerifyCallback = await transport();
    expect(() => mockVerifyCallback('google', '"a string"')).toThrow(/must be a JSON object/);
    expect(() => mockVerifyCallback('google', '[]')).toThrow(/must be a JSON object/);
  });

  it('returns exactly the identity a test supplied', async () => {
    const mockVerifyCallback = await transport();
    const identity = mockVerifyCallback('google', JSON.stringify({
      email: 'real.person@school.org', sub: 'sub-1', name: 'Real Person', emailVerified: true,
    }));
    expect(identity.email).toBe('real.person@school.org');
    expect(identity.name).toBe('Real Person');
  });
});
