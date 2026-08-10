import { describe, it, expect } from 'vitest';
import {
  parseVersion, compareVersions, validateBody, LegalValidationError, MAX_BODY_LENGTH,
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
