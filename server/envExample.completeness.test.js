import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Everything a production boot REFUSES to start without must be in .env.example.
 *
 * ── What went wrong ──
 *
 * `.env.example` documented 22 variables; the server read 76. Among the missing
 * was `TRUST_PROXY`, which `app.js` makes a fatal boot error in production — so
 * an operator configuring a deployment from this file alone could not start the
 * application, and the file gave no hint why. `DATABASE_ENGINE` and
 * `DATABASE_URL` were missing too, which meant the entire PostgreSQL cutover had
 * no entry in the one file an operator reads to configure the system.
 *
 * ── Why this rule and not "document all 76" ──
 *
 * Most of the rest are tuning knobs with defaults that are correct — rate-limit
 * windows, worker intervals, retention timers. Listing them would bury the
 * handful that a deployment genuinely has to decide. The line drawn here is the
 * one the code itself draws: if a missing value stops the boot, the operator
 * must be told it exists.
 *
 * The list is derived from the FATAL messages rather than hand-maintained, so a
 * new production requirement is caught the day it is added.
 */
function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (name.endsWith('.js') && !name.includes('.test.')) out.push(full);
  }
  return out;
}

describe('.env.example covers what production requires', () => {
  const example = readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  const documented = new Set(
    [...example.matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]*)\s*=/gm)].map(m => m[1])
  );

  /* Variables named in a message that stops a production boot. */
  const required = new Set();
  for (const file of sourceFiles(path.join(ROOT, 'server'))) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/FATAL:[^'"`]*?\b([A-Z][A-Z0-9_]{3,})\b/g)) {
      required.add(m[1]);
    }
  }

  /* Not configuration: these appear inside FATAL text as prose or as values. */
  const notVariables = new Set([
    'AES', 'FATAL', 'CLI', 'URL', 'SQL', 'WEV', 'API', 'HTTP', 'HTTPS', 'JSON',
    'NODE_ENV', 'VITE', 'OFF', 'ON', 'AND', 'THE', 'NOT', 'SET', 'ONE',
  ]);

  it('names every variable whose absence is a fatal production error', () => {
    const missing = [...required]
      .filter(v => !notVariables.has(v) && !documented.has(v))
      .sort();

    expect(
      missing,
      'these stop a production boot when unset, and an operator configuring from '
      + '.env.example would never learn they exist. Add them with the reason, or '
      + 'stop making them fatal.',
    ).toEqual([]);
  });

  it('documents the engine selection and its connection string', () => {
    /* Not derived from a FATAL — DATABASE_ENGINE is optional and defaults to
       sqlite — but it is the switch the entire PostgreSQL cutover turns on, and
       an operator cannot find it by reading the code. */
    for (const v of ['DATABASE_ENGINE', 'DATABASE_URL']) {
      expect(documented.has(v), `${v} is missing from .env.example`).toBe(true);
    }
  });

  it('warns that DEMO_MODE must not reach production', () => {
    expect(documented.has('DEMO_MODE')).toBe(true);
    /* The reason matters more than the entry: the demo accounts share a password
       published in this repository. */
    /* The explanation sits ABOVE the entry, as it does for every other variable
       in this file, so the window has to look both ways around the name. */
    const block = example.slice(
      Math.max(0, example.indexOf('DEMO_MODE') - 400),
      example.indexOf('DEMO_MODE') + 400,
    );
    expect(block).toMatch(/refuses to start/i);
  });
});
