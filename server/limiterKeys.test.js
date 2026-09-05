/**
 * Every IP-keyed limiter must actually vary by IP.
 *
 * ── The defect this pins ──
 *
 * `express-rate-limit@8` exports `ipKeyGenerator(ip: string, ipv6Subnet?)`. It
 * takes an ADDRESS. Seven call sites in this server called it as
 * `ipKeyGenerator(req, res)` — the shape a key generator itself has — and it
 * returned the request object back, unchanged. Interpolated into a template,
 * that object became the literal string `[object Object]`, identical for every
 * caller on the internet:
 *
 *     login:[object Object]:<email-hash>      loginKeyGenerator
 *     ip:[object Object]                      mailLimiter's anonymous fallback
 *
 * So the address dimension of every one of those keys was a constant. Two
 * consequences, both live:
 *
 *   - `mailLimiter`'s anonymous fallback put EVERY anonymous verification and
 *     password-reset request worldwide into ONE bucket. A few dozen requests
 *     from anywhere would block those emails for everybody.
 *   - `loginKeyGenerator`'s ip+account design collapsed to account-only, so the
 *     per-address isolation it was built for did not exist: one attacker could
 *     exhaust any chosen account's budget from anywhere.
 *
 * Nothing caught it. The limiters were exercised, the middleware ran, and the
 * suite asserted behaviour without ever asserting the KEY. That is why these
 * cases assert the produced string.
 *
 * ── The other half: IPv6 ──
 *
 * `ipKeyGenerator` exists to collapse IPv6 to a /56, because a residential
 * allocation is a /64 — an attacker rotating inside their own prefix would
 * otherwise draw a fresh budget per request. Called with a request object it
 * normalised nothing, so that protection was absent too.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ipKeyGenerator } from 'express-rate-limit';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Blanks whole-line comments so the scan cannot match prose.
 *
 * ── Why this is needed ──
 *
 * The scan below is line-oriented and looks for the literal call shape. Without
 * this it also matches any COMMENT that writes that shape down — and the
 * comment most likely to do so is the one explaining why the shape is wrong,
 * beside the call site that was corrected. This repository documents defects
 * next to the code they were found in, so a guard that fires on that
 * documentation is a guard that discourages it. `app.js` tripped exactly this
 * during the perf-scaling merge: the fix was right, and the paragraph
 * describing it was the offender.
 *
 * Same line-oriented approach as `stripComments` in
 * `src/serverModuleBoundary.test.js` and `server/authz.completeness.test.js`,
 * for the reason recorded there: a regex that looks INSIDE a line for a comment
 * opener gets opened by a string literal and swallows everything after it. A
 * line is blanked only when the line ITSELF begins with `//`, `/*` or `*`,
 * which cannot misfire on real code and keeps line numbers exact.
 *
 * It deliberately does NOT blank a trailing comment on a line of code —
 * `foo(); // ipKeyGenerator(req, res)` still reports, because a line that
 * contains real code is a line worth reading closely.
 */
function stripComments(source) {
  return source.split('\n').map((line) => {
    const t = line.trim();
    return (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) ? '' : line;
  }).join('\n');
}

describe('ipKeyGenerator is called with an address, never a request', () => {
  /**
   * A source scan rather than a behavioural probe, deliberately: the call sites
   * live inside seven different key generators, several of them behind
   * conditions that need a fully-built request to reach. The mistake is
   * textual and uniform, so catching it textually catches all of it — including
   * the next one somebody writes.
   */
  it('no server source passes (req, res) to it', () => {
    const offenders = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.js') || entry.name.includes('.test.')) continue;
        const src = stripComments(readFileSync(full, 'utf8'));
        src.split('\n').forEach((line, i) => {
          if (/ipKeyGenerator\(\s*req\s*,/.test(line)) {
            offenders.push(`${path.relative(HERE, full)}:${i + 1}`);
          }
        });
      }
    };
    walk(HERE);

    expect(
      offenders,
      'ipKeyGenerator takes an IP string. Passing the request returns the request,\n'
      + 'which stringifies to "[object Object]" — one shared bucket for the whole\n'
      + 'internet, and no IPv6 normalisation. Use ipKeyGenerator(req.ip).'
    ).toEqual([]);
  });

  it('finds the call sites at all, so the scan cannot pass over an empty set', () => {
    let found = 0;
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.js') || entry.name.includes('.test.')) continue;
        found += (readFileSync(full, 'utf8').match(/ipKeyGenerator\(/g) || []).length;
      }
    };
    walk(HERE);
    expect(found).toBeGreaterThanOrEqual(7);
  });
});

/**
 * The library's own behaviour, pinned so an upgrade that changes the signature
 * fails here rather than silently reinstating one global bucket.
 */
describe('ipKeyGenerator, called correctly', () => {
  it('returns distinct keys for distinct IPv4 addresses', () => {
    expect(ipKeyGenerator('203.0.113.10')).not.toBe(ipKeyGenerator('198.51.100.99'));
  });

  it('collapses IPv6 to a /56, so a residential /64 cannot rotate for a fresh budget', () => {
    const a = ipKeyGenerator('2001:db8:1234:5678:9abc:def0:1234:5678');
    const b = ipKeyGenerator('2001:db8:1234:5600:ffff:ffff:ffff:ffff');
    expect(a).toBe(b);
    expect(a).toMatch(/\/56$/);
  });

  it('separates different /56 prefixes', () => {
    expect(ipKeyGenerator('2001:db8:1234:5678::1'))
      .not.toBe(ipKeyGenerator('2001:db8:9999:5678::1'));
  });

  /** The shape of the original mistake, kept as an explicit negative. */
  it('returns the argument unchanged when handed a request object', () => {
    const req = { ip: '203.0.113.10' };
    expect(`ip:${ipKeyGenerator(req, {})}`).toBe('ip:[object Object]');
  });
});
