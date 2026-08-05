/**
 * Every rate limit the server enforces must be documented where an operator
 * will look for it.
 *
 * ── Why this is a build-failing guard and not a checklist item ──
 *
 * A rate limit is a security control with a default chosen for a reason. An
 * operator who does not know the knob exists cannot tune it after a bad day,
 * cannot audit it when a district asks what throttles sign-in attempts, and
 * cannot tell the difference between "we chose 20" and "nobody thought about
 * it". The v1.2c final release review found four such limits —
 * `ERROR_REPORT_RATE_LIMIT`, `REAUTH_RATE_LIMIT`, `EXPORT_RATE_LIMIT` and
 * `LOGIN_FAILURE_LIMIT` — enforced in production and named in no operations
 * document at all, `ERROR_REPORT_RATE_LIMIT` having shipped that way in the
 * very release that introduced it.
 *
 * Documentation drift is invisible: nothing breaks, so nothing tells you. The
 * only thing that reliably catches it is a test that reads the code and the
 * document and compares them.
 *
 * ── Scope, deliberately narrow ──
 *
 * RATE LIMITS ONLY, not every `process.env` read. There are ~45 of those, most
 * of them internal timings (`EXPORT_STALE_MS`, `SOCKET_SESSION_CHECK_INTERVAL_MS`)
 * that an operator has no business setting and that would turn this guard into
 * a documentation chore nobody believes in. A guard that fires for things that
 * do not matter is a guard people delete.
 *
 * The scan is over the source text rather than a hand-kept list, for the same
 * reason `tokens.test.js` scans `index.css`: a list would be a second place to
 * forget, which is the failure being prevented.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..');
const ENV_TEMPLATE = path.join(repoRoot, 'deploy', 'wevolunteer.env.example');

/** Names matching this are operator-facing controls, not internal timings. */
const LIMIT_NAME = /^[A-Z0-9_]*(?:RATE_LIMIT|_LIMIT|_CEILING)$/;

/** Source files only — a name that appears solely in a test is a fixture. */
function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'scratch' || entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) { sourceFiles(full, out); continue; }
    if (!entry.endsWith('.js')) continue;
    if (entry.includes('.test.')) continue;
    if (entry === 'testServer.js') continue;
    out.push(full);
  }
  return out;
}

describe('every enforced rate limit is documented for operators', () => {
  it('names each one in deploy/wevolunteer.env.example', () => {
    const template = readFileSync(ENV_TEMPLATE, 'utf8');

    const found = new Map();   // name -> the file that reads it
    for (const file of sourceFiles(here)) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
        const name = match[1];
        if (!LIMIT_NAME.test(name)) continue;
        if (!found.has(name)) found.set(name, path.relative(repoRoot, file));
      }
    }

    // If this is ever empty the scan has stopped working and the guard would
    // pass vacuously — which is how a static guard rots into decoration.
    expect(found.size, 'the scan found no rate limits at all — it is broken').toBeGreaterThan(3);

    const undocumented = [...found].filter(([name]) => !template.includes(name));

    expect(
      undocumented.map(([name, file]) => `${name} (enforced in ${file})`),
      'these rate limits are enforced in production and named in no operations '
      + 'document. Add each to deploy/wevolunteer.env.example with its default '
      + 'and the reason for that default — a control an operator cannot find is '
      + 'a control nobody can tune, audit, or explain to a district.'
    ).toEqual([]);
  });

  /**
   * The client build template must not become a second, wrong home for them.
   *
   * Vite only reads `VITE_*`, so a server tunable written into
   * `.env.production.example` does nothing whatsoever while looking configured
   * — a worse failure than omitting it, because there is no error to notice.
   */
  it('keeps them out of the VITE-only client template', () => {
    const client = readFileSync(path.join(repoRoot, '.env.production.example'), 'utf8');
    const assignments = [...client.matchAll(/^\s*#?\s*([A-Z0-9_]+)=/gm)].map(m => m[1]);
    const nonVite = assignments.filter(n => !n.startsWith('VITE_'));
    expect(
      nonVite,
      '.env.production.example is compiled into the browser bundle and only '
      + 'VITE_* names are read at all. A server variable here is silently inert.'
    ).toEqual([]);
  });
});
