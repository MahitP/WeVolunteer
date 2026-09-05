import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  parseVersion, compareVersions, validateBody, LegalValidationError, MAX_BODY_LENGTH,
  parseEffectiveAt,
} from './legalStore.js';
import { isSafeHref } from '../src/utils/policyMarkdown.js';

/**
 * The rules a legal revision has to satisfy, tested without a server.
 *
 * These are pure — `legalStore.js` reaches node builtins, the document registry
 * and the Markdown parser, and never `db.js` — so this file may import it
 * statically. The endpoint behaviour that needs a database (version
 * monotonicity against stored rows, authorization, audit) lives in
 * `routes.legalEditor.test.js`.
 *
 * The version rules are worth testing at this level rather than only through
 * HTTP because they are not a validation preference. `legal_documents` is keyed
 * by `(slug, version)` and a published row is immutable, so a version that fails
 * to move forward is a catalogue that disagrees with the acceptance records
 * pointing at it — and, once hash enforcement is switched on at launch, a server
 * that refuses to boot.
 */

describe('legal document version numbers', () => {
  describe('parsing', () => {
    it('reads MAJOR.MINOR.PATCH', () => {
      expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
    });

    /**
     * The migration path, not sloppiness.
     *
     * Every document in the registry ships at '1.0'. A strict three-part parser
     * would make the CURRENT version unreadable, so the first save would have
     * nothing to compare against.
     */
    it('reads a two-part registry version as its .0 patch', () => {
      expect(parseVersion('1.0')).toEqual({ major: 1, minor: 0, patch: 0 });
      expect(compareVersions('1.0', '1.0.0')).toBe(0);
    });

    it('refuses anything that is not a version', () => {
      for (const bad of ['', '1', 'v1.0.0', '1.0.0.0', 'one.two.three', '1.0.x', null, undefined, 1.0]) {
        expect(parseVersion(bad)).toBeNull();
      }
    });

    /**
     * Leading zeros are refused in both directions: '1.01.0' and '1.1.0' would
     * compare equal while displaying differently, and a version a reader cannot
     * tell apart from another is not a version.
     */
    it('refuses leading zeros', () => {
      expect(parseVersion('1.01.0')).toBeNull();
      expect(parseVersion('01.0.0')).toBeNull();
      expect(parseVersion('1.0.00')).toBeNull();
    });
  });

  describe('comparison', () => {
    it('orders by major, then minor, then patch', () => {
      expect(compareVersions('2.0.0', '1.9.9')).toBeGreaterThan(0);
      expect(compareVersions('1.1.0', '1.0.9')).toBeGreaterThan(0);
      expect(compareVersions('1.0.1', '1.0.0')).toBeGreaterThan(0);
      expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
      expect(compareVersions('1.0.0', '2.0.0')).toBeLessThan(0);
    });

    /**
     * The case a string comparison gets wrong, and the reason
     * `legal_document_revisions` is ordered by `id` rather than by `version`:
     * lexicographically '1.9.0' sorts above '1.10.0'.
     */
    it('orders 1.10.0 above 1.9.0, which a string sort does not', () => {
      const [tenth, ninth] = ['1.10.0', '1.9.0'];
      expect(compareVersions(tenth, ninth)).toBeGreaterThan(0);
      /* The comparison this exists to be different from. Held in variables
         rather than written as two literals, which oxlint reads — correctly, in
         any other context — as a constant expression somebody left behind. */
      expect(tenth > ninth).toBe(false);
    });

    /**
     * ── The bug this comparator was rewritten to remove ──
     *
     * It used to be `(major - major) || (minor - minor) || (patch - patch)`, over
     * components produced by `Number()` with no bound on digits. Both halves were
     * needed to break it and both were present:
     *
     *   - `Number('9'.repeat(400))` is `Infinity`, so two long versions gave
     *     `Infinity - Infinity`, which is `NaN`;
     *   - `NaN` is falsy, so the `||` cascade fell through it and the major
     *     number stopped participating in the comparison at all.
     *
     * A strictly LOWER version then compared as greater, which is the one thing
     * this function exists to make impossible — and because
     * `legal_document_revisions` is append-only, a single publish at an absurd
     * version would have made every later publication of that document compare
     * as not-greater for ever, recoverable only by editing production SQL.
     *
     * Fixed in two places, and both are asserted: components are length-bounded
     * so they stay exactly representable, and the comparison is key-by-key
     * equality rather than arithmetic, so no arithmetic result can be falsy.
     */
    it('bounds each component so it stays exactly representable', () => {
      expect(parseVersion('999999.0.0')).toEqual({ major: 999999, minor: 0, patch: 0 });
      expect(parseVersion('1000000.0.0')).toBeNull();
      expect(parseVersion(`${'9'.repeat(400)}.0.0`)).toBeNull();
    });

    it('never reports a lower version as greater, however large the components', () => {
      expect(compareVersions('999999.0.0', '1.0.0')).toBeGreaterThan(0);
      expect(compareVersions('1.0.0', '999999.0.0')).toBeLessThan(0);
      /* The precise shape of the old defect: equal-length huge majors differing
         only in a later component. Under `Infinity - Infinity` this returned NaN
         and the minor comparison silently decided the answer. */
      expect(compareVersions('999999.1.0', '999999.0.0')).toBeGreaterThan(0);
      expect(compareVersions('999999.0.0', '999999.1.0')).toBeLessThan(0);
    });

    /* No comparison may ever return a falsy non-zero — that is what let the old
       `||` cascade skip a component. */
    it('returns a usable sign for every ordered pair', () => {
      for (const [a, b] of [
        ['1.0.0', '2.0.0'], ['2.0.0', '1.0.0'], ['999999.0.0', '999998.0.0'],
        ['1.2.3', '1.2.4'], ['1.0', '1.0.1'],
      ]) {
        const result = compareVersions(a, b);
        expect(Number.isNaN(result), `${a} vs ${b}`).toBe(false);
        expect(result === 0 || Math.abs(Math.sign(result)) === 1).toBe(true);
      }
    });
  });
});

describe('legal document content validation', () => {
  const ok = '# Title\n\nA paragraph that says something.\n';

  it('accepts an ordinary document', () => {
    expect(validateBody(ok).body).toBe(ok.trim());
  });

  it('normalises CRLF and trims', () => {
    expect(validateBody('# T\r\n\r\nBody.\r\n').body).toBe('# T\n\nBody.');
  });

  it('refuses an empty document', () => {
    for (const empty of ['', '   ', '\n\n', null, undefined]) {
      expect(() => validateBody(empty)).toThrow(LegalValidationError);
    }
  });

  it('refuses a document over the length limit', () => {
    expect(() => validateBody('x'.repeat(MAX_BODY_LENGTH + 1))).toThrow(/over the/);
  });

  /**
   * Only the published half of a document is stored. A body still carrying the
   * `## Draft` marker means somebody pasted a whole file in, which would publish
   * the internal specification block to every reader.
   */
  it('refuses a whole policy file pasted in', () => {
    expect(() => validateBody('## Specification\n\nbrief\n\n## Draft\n\n# Real\n'))
      .toThrow(/## Draft/);
  });

  describe('link safety', () => {
    /**
     * The reason this validation exists at all.
     *
     * `PolicyBody.jsx` puts the parsed href straight into an anchor, and until
     * the editor shipped, policy text could only come from this repository. It
     * can now come from an account, and `/legal/:slug` is unauthenticated and is
     * where the signup form sends fourteen-year-olds.
     */
    it('refuses a javascript: link', () => {
      expect(() => validateBody('# T\n\n[click me](javascript:alert(1))\n'))
        .toThrow(/not an allowed kind of link/);
    });

    it('refuses other executable and exotic schemes', () => {
      for (const href of ['data:text/html;base64,PHNjcmlwdD4=', 'vbscript:msgbox(1)', 'file:///etc/passwd']) {
        expect(() => validateBody(`# T\n\n[x](${href})\n`), href)
          .toThrow(LegalValidationError);
      }
    });

    /* Protocol-relative: starts with a slash and leaves the site anyway. */
    it('refuses a protocol-relative link', () => {
      expect(() => validateBody('# T\n\n[x](//evil.example/steal)\n'))
        .toThrow(LegalValidationError);
    });

    it('accepts https, mailto, app paths and same-document anchors', () => {
      const body = '# Title\n\n'
        + '[site](https://example.org)\n\n'
        + '[mail](mailto:privacy@example.org)\n\n'
        + '[app](/legal/privacy-policy)\n\n'
        + '[here](#title)\n';
      expect(() => validateBody(body)).not.toThrow();
    });

    it('refuses a link to a document that does not exist', () => {
      expect(() => validateBody('# T\n\n[x](/legal/not-a-real-policy)\n'))
        .toThrow(/not a document here/);
    });

    /* A fragment that scrolls nowhere is worse than a missing link, because it
       looks like it worked. */
    it('refuses an anchor with no matching heading', () => {
      expect(() => validateBody('# Title\n\n[x](#nowhere)\n'))
        .toThrow(/no such heading/);
    });

    it('refuses a link to a Markdown file', () => {
      expect(() => validateBody('# T\n\n[x](/docs/legal/policies/01-privacy-policy.md)\n'))
        .toThrow(/links to a file/);
    });

    /* Links nested inside bold runs are reachable and must be checked too —
       `parseInline` gives a bold span its own `spans` array in that case. */
    it('checks links nested inside bold text', () => {
      expect(() => validateBody('# T\n\n**[x](javascript:alert(1))**\n'))
        .toThrow(LegalValidationError);
    });

    it('reports every bad link at once rather than one per save', () => {
      const body = '# T\n\n[a](/legal/nope-one)\n\n[b](/legal/nope-two)\n';
      expect(() => validateBody(body)).toThrow(/2 links need fixing/);
    });
  });
});

describe('isSafeHref', () => {
  it('allows the schemes a policy needs', () => {
    expect(isSafeHref('https://example.org')).toBe(true);
    expect(isSafeHref('http://example.org')).toBe(true);
    expect(isSafeHref('mailto:a@b.org')).toBe(true);
    expect(isSafeHref('/legal/terms-of-service')).toBe(true);
    expect(isSafeHref('#a-heading')).toBe(true);
  });

  it('refuses executable and protocol-relative targets', () => {
    for (const bad of [
      'javascript:alert(1)', 'JavaScript:alert(1)', ' javascript:alert(1)',
      'data:text/html,<script>', 'vbscript:x', '//evil.example', '#', '', null, undefined,
    ]) {
      expect(isSafeHref(bad), String(bad)).toBe(false);
    }
  });

  /* Case and leading whitespace are both ways a filter gets walked past, so both
     are pinned rather than left to the implementation's current shape. */
  it('is case-insensitive and ignores surrounding whitespace', () => {
    expect(isSafeHref('  HTTPS://example.org  ')).toBe(true);
    expect(isSafeHref('\tjavascript:alert(1)')).toBe(false);
  });
});

/**
 * ── The two ways the version rule could be defeated ──
 *
 * `legal_document_revisions` is append-only: one INSERT, no UPDATE, no DELETE.
 * So "a published version can never be reused or walked backwards" is not a
 * validation preference — it is the only thing standing between a mistake and a
 * row nobody can correct without hand-editing production SQL.
 */
describe('version comparison cannot be defeated by magnitude', () => {
  it('refuses a component long enough to become Infinity', () => {
    /* `Number('9'.repeat(400))` is Infinity. Two Infinities subtract to NaN,
       NaN is falsy, and the `||` cascade the comparator used to be would fall
       through to the next component — so the MAJOR number stopped being
       compared at all. */
    expect(parseVersion('9'.repeat(400) + '.0.0')).toBeNull();
    expect(parseVersion('1000000.0.0')).toBeNull();
    expect(parseVersion('999999.0.0')).toEqual({ major: 999999, minor: 0, patch: 0 });
  });

  it('never returns NaN, so a lower version can never compare as greater', () => {
    for (const [a, b] of [
      ['2.0.0', '1.9.9'], ['1.10.0', '1.9.0'], ['1.0.1', '1.0.0'], ['0.0.1', '0.0.0'],
    ]) {
      const forward = compareVersions(a, b);
      const back = compareVersions(b, a);
      expect(Number.isNaN(forward)).toBe(false);
      expect(forward).toBeGreaterThan(0);
      expect(back).toBeLessThan(0);
    }
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  /* A comparator that is not a total order sorts unpredictably, and
     `highestVersion` picks its answer with `.sort().pop()`. */
  it('orders a shuffled set the same way every time', () => {
    const versions = ['1.0.0', '1.0.1', '1.2.0', '2.0.0', '1.10.0', '0.9.9'];
    const sorted = [...versions].sort(compareVersions);
    expect(sorted).toEqual(['0.9.9', '1.0.0', '1.0.1', '1.2.0', '1.10.0', '2.0.0']);
    expect([...versions].reverse().sort(compareVersions)).toEqual(sorted);
  });
});

/**
 * ── A link that reads as internal and is not ──
 *
 * `isSafeHref` treated any slash-leading href as an internal path unless it
 * began `//`. But in the WHATWG URL spec's relative-slash state, `\` and `/`
 * are interchangeable for special schemes, so a second character of `\` opens
 * an authority exactly as a second `/` does:
 *
 *     new URL('/\\evil.example.com/x', 'https://wevolunteer.example/')
 *       -> https://evil.example.com/x
 *
 * Every layer read it as internal: `validateBody` stored it, `isSafeHref`
 * passed it, and `PolicyBody`'s external test (`/^https?:\/\//`) was false — so
 * the anchor rendered with no `rel="noopener noreferrer"` and no new tab. Same
 * tab, full Referer, on `/legal/:slug`, which is served unauthenticated and is
 * where signup sends children.
 *
 * The check resolves the href now instead of matching prefixes, so the whole
 * class goes rather than the one spelling somebody thought of.
 */
describe('a slash-leading link must actually stay on this origin', () => {
  const ESCAPES = [
    '/\\evil.example.com/phish',
    '/\\/evil.example.com',
    '//evil.example.com',
    '/\\\\evil.example.com',
  ];

  it.each(ESCAPES)('refuses %s, which resolves off-origin', (href) => {
    expect(isSafeHref(href)).toBe(false);
  });

  it('still allows the internal paths policies genuinely use', () => {
    for (const href of ['/legal/privacy-policy', '/about', '/legal', '#a-section']) {
      expect(isSafeHref(href)).toBe(true);
    }
  });

  /* The body validator is the layer that gives the owner an error message, so
     it has to refuse the same thing rather than relying on the renderer. */
  it('refuses such a link at save time', () => {
    expect(() => validateBody('# T\n\nRead the [rules](/\\evil.example.com/x) now.\n'))
      .toThrow(LegalValidationError);
  });
});

/**
 * ── The effective-date model ──
 *
 * Publishing makes a revision the current public text IMMEDIATELY; resolution is
 * by insertion order and never by date. `effective_at` is therefore a recorded
 * legal fact rather than an instruction to the software, and what it owes is
 * coherence: a real date, not before the day it was published, not absurdly far
 * ahead, and not before the version it replaces.
 *
 * These are unit tests against the parser because every date test before this
 * was an HTTP round trip — a slow way to assert a calendar rule, and an easy way
 * to leave the boundaries untested.
 */
describe('parseEffectiveAt', () => {
  const NOW = '2026-08-10T09:00:00.000Z';
  const on = (raw, opts = {}) => parseEffectiveAt(raw, { now: NOW, ...opts });

  it('accepts a well-formed date and returns it unchanged', () => {
    expect(on('2026-09-01')).toBe('2026-09-01');
    expect(on('  2026-09-01  ')).toBe('2026-09-01');
  });

  /**
   * The boundary most likely to break, and the reason the comparison is done on
   * date strings in JavaScript rather than in SQL.
   *
   * `effective_at` is ten characters; `created_at` is a 24-character ISO
   * timestamp. `'2026-08-10' < '2026-08-10T09:00:00.000Z'` is TRUE, because the
   * date is a strict prefix — so a naive SQL `effective_at >= created_at` would
   * refuse every same-day publication, which is the ordinary case.
   */
  it('accepts today — the ordinary case, not an edge one', () => {
    expect(on('2026-08-10')).toBe('2026-08-10');
  });

  /**
   * ── One day of slack, because the two clocks disagree by design ──
   *
   * The server reads "today" in UTC; the browser prefills the field and sets the
   * picker's `min` from the OWNER's local calendar. In America/New_York the UTC
   * date rolls over at 20:00 local, so without slack the editor would offer a
   * default it was about to be refused for, for four hours every evening.
   *
   * `effective_at` is a calendar date with no zone, so making the server read
   * local time is not available. One day covers every inhabited offset.
   */
  it('accepts the owner\'s local yesterday, so no timezone can refuse a same-day publish', () => {
    expect(on('2026-08-09')).toBe('2026-08-09');
  });

  it('refuses a date genuinely in the past', () => {
    expect(() => on('2026-08-08')).toThrow(LegalValidationError);
    expect(() => on('1970-01-01')).toThrow(/cannot take effect before it is published/i);
    try { on('2026-08-08'); } catch (e) { expect(e.field).toBe('effectiveAt'); }
  });

  /**
   * ── The two bounds must never argue ──
   *
   * `value >= previousEffectiveAt` and `value <= today + 365` have no common
   * solution when a revision published before this validation existed carries a
   * date beyond the bound — `9999-12-31` was accepted right up until it was
   * added. `legal_document_revisions` is append-only, so a document in that
   * state could never be revised again by anybody.
   */
  it('ignores a previous effective date that is itself out of range', () => {
    expect(on('2026-09-01', { previousEffectiveAt: '9999-12-31' })).toBe('2026-09-01');
    expect(on('2026-08-10', { previousEffectiveAt: '3026-01-01' })).toBe('2026-08-10');
  });

  /* A year is past every real notice period and every school-year alignment,
     and still catches the error these fields actually attract — a mistyped
     leading digit. */
  it('accepts a date up to a year ahead and refuses one beyond it', () => {
    expect(on('2027-08-10')).toBe('2027-08-10');
    expect(() => on('2027-08-11')).toThrow(/more than a year/i);
    for (const typo of ['2062-01-01', '9026-01-01', '2126-05-05', '9999-12-31']) {
      expect(() => on(typo), `${typo} must be refused`).toThrow(LegalValidationError);
    }
  });

  it('refuses a date earlier than the version it replaces', () => {
    expect(() => on('2026-08-15', { previousEffectiveAt: '2026-09-01' }))
      .toThrow(/only move forward/i);
  });

  /* Equality is allowed on purpose: two corrections sharing one effective date
     is ordinary — a typo fixed twice in an afternoon. */
  it('allows the same effective date as the version it replaces', () => {
    expect(on('2026-09-01', { previousEffectiveAt: '2026-09-01' })).toBe('2026-09-01');
  });

  it('still refuses malformed and impossible dates', () => {
    for (const bad of ['01/09/2026', '2026-9-1', '2026-09-01T00:00:00Z', '', 'soon', null, 42]) {
      expect(() => on(bad), `${JSON.stringify(bad)} must be refused`).toThrow(LegalValidationError);
    }
    expect(() => on('2026-02-30')).toThrow(/not a real date/i);
    expect(() => on('2026-13-01')).toThrow(LegalValidationError);
  });
});

/**
 * No test may hand a WRITTEN-DOWN effective date to a publish.
 *
 * ── The failure this exists to prevent, which already happened ──
 *
 * `parseEffectiveAt` floors an effective date at yesterday-in-UTC. A literal
 * date in a test is therefore valid for exactly two days and invalid for ever
 * afterwards. `legalEditor.adversarial.test.js` and `routes.legalEditor.test.js`
 * carried `effectiveAt: '2026-09-01'` thirty times between them, and on
 * 2026-09-03 the calendar turned all thirty into HTTP 400s.
 *
 * The count is not the interesting part. `validatePublication` runs before the
 * body sanitizer and before the step-up grant is checked, so the date refusal
 * PREEMPTED everything those cases were about: thirteen link-injection tests
 * reported `expected 'effectiveAt' to be 'body'`, two grant-mismatch tests
 * reported `expected 400 to be 409`, and a unique-constraint test reported a
 * constraint not firing — against a row whose publish had been refused, so there
 * was nothing to collide with. Twenty-eight failures, and four of them mentioned
 * a date. Anybody reading that output would have gone looking in the wrong
 * dozen places first.
 *
 * ── Why a scan and not a convention ──
 *
 * The fix was to compute the dates from today. Nothing stops the next
 * date-carrying test from writing a literal, and it would pass for two days —
 * long enough to be reviewed, merged, and forgotten. This file owns the date
 * rules, so it owns the guard.
 *
 * It earned its place immediately, twice. It found the same bug with a longer
 * fuse in `legalUpgradeBoot.test.js` — `2027-01-01` and `2027-02-01`, which pass
 * today and become past dates in four months — and it holds against the version
 * of the two editor suites that was fixed in parallel on `main`, which uses its
 * own local helpers rather than `server/testing/dates.js`. That is the point of
 * asserting the property instead of the mechanism: two independent fixes, one
 * guarantee, and neither has to know about the other.
 *
 * Two files are exempt, both because the real clock never reaches them: this
 * one pins `now` explicitly (`NOW` above), and `legalConsentGate.test.js` tests
 * a function that takes the date as an argument. Pinning the clock is the other
 * correct way to test a date rule, and is why those literals are safe. Each
 * exemption carries its reason in `EXEMPT` below.
 * The registry in `legalDocuments.js` is not a test and is not scanned — its
 * dates are a record of when published documents took effect, which is a fact
 * about the past and does not move.
 */
describe('effective dates in tests are computed, not written down', () => {
  const SERVER = path.resolve(import.meta.dirname);

  /** Test files that legitimately hold a literal date, each with its reason. */
  const EXEMPT = new Map([
    /* Pins `now`, so its dates are relative to a fixed clock rather than to the
       real one. That is the other correct pattern and this file uses it. */
    ['legalStore.test.js', 'pins `now` explicitly'],
    /* Stronger than pinning a clock: `noticeChannelFor(doc, seen, today)` takes
       the date as an ARGUMENT and compares two strings, so no clock is reached
       at all and its `TODAY` is a fixture like any other. Exempting the file
       rather than the call is the same trade this list already makes above —
       a future test here that does read the real clock would need its own
       computed date, and the reason is written down so that is visible. */
    ['legalConsentGate.test.js', 'passes `today` explicitly to a clock-free function'],
  ]);

  it('finds no literal effectiveAt in any server test', () => {
    const offenders = [];
    for (const name of readdirSync(SERVER)) {
      if (!name.endsWith('.test.js') || EXEMPT.has(name)) continue;
      const src = readFileSync(path.join(SERVER, name), 'utf8')
        /* Comments stripped, because this file's own header quotes the literal
           it is warning about — and so will the next one. */
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');

      for (const m of src.matchAll(/effectiveAt:\s*'(\d{4}-\d{2}-\d{2})'/g)) {
        offenders.push(`${name}: effectiveAt: '${m[1]}'`);
      }
    }

    expect(
      offenders,
      'a written-down effective date is valid for two days and refused for ever '
      + 'after — see the note above this test. Compute it instead:\n'
      + "  const daysAhead = (n = 0) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);\n"
      + 'or pin `now` if you are unit-testing the rule itself.',
    ).toEqual([]);
  });

  it('scans the real directory, so it cannot pass by scanning nothing', () => {
    const tests = readdirSync(SERVER).filter(n => n.endsWith('.test.js'));
    expect(tests.length).toBeGreaterThan(50);
    expect(tests).toContain('routes.legalEditor.test.js');
  });
});
