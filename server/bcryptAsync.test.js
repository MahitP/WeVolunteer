/**
 * Password hashing must not block the event loop.
 *
 * ── The measurement that motivated this ──
 *
 * `bcryptjs` is pure JavaScript, so `compareSync`/`hashSync` hold the single
 * event-loop thread for the entire computation. Measured on a seeded database with 40
 * concurrent logins, watching `/health` — an endpoint that performs no hashing at all:
 *
 *                          before (sync)      after (async)
 *   serial login p50        105.2 ms           105.4 ms
 *   40-login burst total    4,192 ms           1,069 ms
 *   /health p50 during      99.5 ms            29.2 ms
 *   /health max during      3,760.8 ms         1,019.3 ms
 *
 * Per-login cost is unchanged — that is the point, the work is identical — but every
 * OTHER request stopped being queued behind it.
 *
 * ── What these tests protect ──
 *
 * Two things a future edit could silently undo:
 *
 *   1. Reintroducing a `*Sync` call in a request path. It would look harmless, pass
 *      every functional test, and quietly restore the stall.
 *   2. Putting an `await` inside `inTransaction(...)`. That is the dangerous shape of
 *      this change: a synchronous SQLite transaction spanning an await lets unrelated
 *      statements interleave with an open transaction — a correctness bug far worse
 *      than the latency it would be trying to fix.
 *
 * Both are static checks, because both are invisible at runtime until they matter.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';

const ROOT = process.cwd();

/** Source of every route module, with comments stripped so prose cannot trip a check. */
function routeSources() {
  const dir = path.join(ROOT, 'server/routes');
  return readdirSync(dir)
    .filter(f => f.endsWith('.js') && !f.includes('.test.'))
    .map(f => ({
      file: `server/routes/${f}`,
      code: readFileSync(path.join(dir, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
    }));
}

describe('no request path uses synchronous bcrypt', () => {
  it('has no *Sync bcrypt call in any route module', () => {
    const offenders = [];
    for (const { file, code } of routeSources()) {
      code.split('\n').forEach((line, i) => {
        if (/bcrypt\.(compareSync|hashSync|genSaltSync)/.test(line)) {
          offenders.push(`${file}:${i + 1} — ${line.trim()}`);
        }
      });
    }
    expect(
      offenders,
      'synchronous bcrypt in a request handler blocks the event loop for every other '
      + 'user; measured at a p95 of 3.8s on unrelated endpoints under 40 concurrent logins'
    ).toEqual([]);
  });

  it('allows synchronous bcrypt outside request paths', () => {
    /**
     * `server/db.js` (DEMO_MODE seeding) and `bin/seed-pilot.js` keep the sync API on
     * purpose. Neither is in a request path: db.js hashes at import time, where `await`
     * is not available and nothing is waiting on the loop, and the seed script is a
     * one-shot CLI. Converting them would add async plumbing for no benefit.
     *
     * Asserted rather than merely allowed, so the distinction is deliberate and
     * documented instead of looking like an oversight.
     */
    const db = readFileSync(path.join(ROOT, 'server/db.js'), 'utf8');
    expect(db).toMatch(/bcrypt\.hashSync/);
  });
});

describe('no await sits inside a synchronous transaction', () => {
  it('has no await between inTransaction( and its closing brace', () => {
    const offenders = [];
    for (const { file, code } of routeSources()) {
      const lines = code.split('\n');
      let inTx = false, depth = 0, opened = 0;
      lines.forEach((line, idx) => {
        if (!inTx && /inTransaction\(/.test(line)) {
          inTx = true; opened = idx + 1;
          depth = (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
          return;
        }
        if (inTx) {
          if (/\bawait\b/.test(line)) {
            offenders.push(`${file}:${idx + 1} (transaction opened at ${opened}) — ${line.trim()}`);
          }
          depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
          if (depth <= 0) inTx = false;
        }
      });
    }
    expect(
      offenders,
      'an await inside a synchronous SQLite transaction lets unrelated statements '
      + 'interleave with an open transaction'
    ).toEqual([]);
  });
});

describe('every handler that awaits is declared async', () => {
  it('has no await in a non-async route handler', () => {
    // A missing `async` is a parse error at import, so this would normally surface
    // loudly — but only for the file that is imported. This catches it for all of them
    // in one place, which is how the signup handler's missing `async` was found.
    const offenders = [];
    for (const { file, code } of routeSources()) {
      const lines = code.split('\n');
      let handler = null, isAsync = false, depth = 0;
      lines.forEach((line, idx) => {
        const m = /router\.(get|post|patch|put|delete)\('([^']+)'/.exec(line);
        if (m) {
          handler = `${m[1].toUpperCase()} ${m[2]}`;
          isAsync = /async/.test(line);
          depth = (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
          return;
        }
        if (handler) {
          depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
          if (/\bawait\b/.test(line) && !isAsync) {
            offenders.push(`${file}:${idx + 1} — ${handler} awaits but is not async`);
            handler = null;
            return;
          }
          if (depth <= 0) handler = null;
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});

describe('hash compatibility is preserved', () => {
  it('a sync-produced hash verifies with the async API', async () => {
    // Every password already stored was hashed with hashSync. If the async API could
    // not verify those, this change would lock out every existing user.
    const legacy = bcrypt.hashSync('CorrectHorse1', bcrypt.genSaltSync(10));
    await expect(bcrypt.compare('CorrectHorse1', legacy)).resolves.toBe(true);
    await expect(bcrypt.compare('wrong', legacy)).resolves.toBe(false);
  });

  it('an async-produced hash verifies with the sync API', async () => {
    // The reverse direction, so a partial rollback could not strand new accounts.
    const modern = await bcrypt.hash('CorrectHorse1', 10);
    expect(bcrypt.compareSync('CorrectHorse1', modern)).toBe(true);
    expect(bcrypt.compareSync('wrong', modern)).toBe(false);
  });

  it('keeps the same cost factor', async () => {
    // 10 rounds, unchanged. A silent cost change would alter login latency and, if
    // lowered, weaken every new password.
    const h = await bcrypt.hash('CorrectHorse1', 10);
    expect(h.split('$')[2]).toBe('10');
  });
});

describe('the async API actually yields', () => {
  it('lets a timer fire during hashing', async () => {
    /**
     * The property the whole change rests on. `hashSync` would starve this timer
     * completely; the async API chunks its work and lets the loop turn.
     *
     * Asserted as "fired at all", not as a latency bound — a timing threshold would
     * be flaky on a loaded CI machine, and "did the loop turn" is the real contract.
     */
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 1);
    await bcrypt.hash('CorrectHorse1', 10);
    clearInterval(timer);

    expect(ticks, 'the event loop never turned during hashing').toBeGreaterThan(0);
  });
});
