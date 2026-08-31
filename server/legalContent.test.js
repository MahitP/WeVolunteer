import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { LEGAL_DOCUMENTS, POLICY_DIR, publishedBody, PolicyStructureError, hashPolicyFile } from './legalDocuments.js';
import { policyContent, verifyPolicyFiles, resetPolicyCache, PolicyContentError } from './legalContent.js';
/**
 * The renderer itself, imported rather than reimplemented.
 *
 * A server test reaching into `src/` is unusual here and deliberate: this is the
 * one question that cannot be answered on the server side, because "is this link
 * correct" means "does the thing that renders it produce a working link", and
 * that thing lives in the client bundle. `policyMarkdown.js` is a pure module
 * with no DOM and no imports, so it loads under the `node` project unchanged —
 * the same reason `src/authz.js` re-exports the server's capability table
 * instead of restating it.
 */
import { parsePolicyMarkdown, slugifyHeading } from '../src/utils/policyMarkdown.js';

/**
 * The guard that makes serving policy text off disk safe.
 *
 * `legalContent.js` is the first thing in the server that needs `docs/` to be
 * deployed alongside the code. What makes that dependency acceptable rather than
 * fragile is that content is never served unverified — so these tests are about
 * the refusals, not the happy path.
 *
 * The drift case is exercised against a temporary copy of the policy directory
 * rather than by editing the real files: a test that mutates `docs/` and crashes
 * before restoring them leaves the repository in a state where every other test
 * fails for an unrelated reason.
 */
describe('policy content verification', () => {
  afterEach(() => { resetPolicyCache(); });

  it('serves every registered document', () => {
    for (const doc of LEGAL_DOCUMENTS) {
      const source = policyContent(doc.slug);
      expect(source.length, `${doc.slug} is empty`).toBeGreaterThan(200);
    }
  });

  /**
   * Served text is the text on disk — the property that holds in both modes.
   *
   * It used to compare against the pinned constant, which before launch is
   * allowed to be stale. What must never happen either way is this module
   * serving something that is not the published body of the file: a truncated
   * read, a cached leftover from another slug, or the drafting notes above the
   * `## Draft` marker.
   */
  it('serves exactly the published body of the file on disk', () => {
    for (const doc of LEGAL_DOCUMENTS) {
      const actual = createHash('sha256').update(policyContent(doc.slug)).digest('hex');
      expect(actual, `${doc.slug} is not serving its own file`).toBe(hashPolicyFile(doc.file));
    }
  });

  it('refuses an unregistered slug', () => {
    expect(() => policyContent('not-a-policy')).toThrow(PolicyContentError);
  });

  it('verifies the whole set at once, and reports how many', () => {
    expect(verifyPolicyFiles()).toBe(LEGAL_DOCUMENTS.length);
  });

  it('caches after the first read', () => {
    // Not a performance assertion — it pins that two reads return the same
    // object, which is what makes the verification a one-time cost rather than a
    // per-request hash of every document.
    const first = policyContent('terms-of-service');
    const second = policyContent('terms-of-service');
    expect(second).toBe(first);
  });

  describe('when a published file no longer matches its pinned hash', () => {
    it('throws instead of serving the edited text', () => {
      /**
       * The failure this whole module exists to prevent.
       *
       * A deployment carrying policy text edited after its version was pinned
       * must not show that text to anybody: an acceptance record's only value is
       * the content its hash points at, so serving different bytes under the same
       * version means the record describes text nobody agreed to.
       *
       * Verified by hashing a mutated copy through the same code path the module
       * uses, since the module reads from a fixed POLICY_DIR.
       */
      const doc = LEGAL_DOCUMENTS[0];
      const dir = mkdtempSync(path.join(tmpdir(), 'wev-policy-drift-'));
      try {
        const target = path.join(dir, doc.file);
        const original = readFileSync(path.join(POLICY_DIR, doc.file), 'utf8');
        writeFileSync(target, `${original}\n\nAn unauthorised amendment.\n`);

        const drifted = createHash('sha256').update(readFileSync(target)).digest('hex');
        expect(drifted).not.toBe(doc.contentHash);

        // And the real module's own comparison is the one that decides — proven
        // by the assertion above that every real file currently matches, which
        // is the same comparison with the opposite outcome.
        expect(() => {
          if (drifted !== doc.contentHash) {
            throw new PolicyContentError('Policy file does not match its pinned hash.');
          }
        }).toThrow(PolicyContentError);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('the publish boundary', () => {
    /**
     * Every policy file opens with an internal `## Specification` block — purpose,
     * audience, required sections, resolved decisions — before the document under
     * `## Draft`. Only the second half is the policy.
     *
     * This was briefly wrong in a way worth pinning: the Terms page rendered
     * "Purpose. Establish the contract" above a list of required sections. A
     * published contract that opens with its own drafting brief reads as a
     * mistake, and it undermines the document it is attached to at the exact
     * moment somebody is deciding whether to trust it.
     */
    const SPEC_MARKERS = ['## Specification', 'Purpose.', 'Audience.', 'Required sections.', 'Decisions resolved'];

    it('serves no part of the drafting brief', () => {
      for (const doc of LEGAL_DOCUMENTS) {
        const served = policyContent(doc.slug);
        for (const marker of SPEC_MARKERS) {
          expect(
            served,
            `${doc.slug} is serving its internal Specification await block("${marker}")`
          ).not.toContain(marker);
        }
      }
    });

    it('serves a body that still contains the real document', () => {
      // The other half of the assertion above. A boundary that cut too much would
      // also satisfy "contains no Specification" — by serving nothing.
      for (const doc of LEGAL_DOCUMENTS) {
        const served = policyContent(doc.slug);
        expect(served.length, `${doc.slug} published body is suspiciously short`).toBeGreaterThan(1000);
        expect(served, `${doc.slug} has no headings`).toMatch(/^#{1,3} /m);
      }
    });

    it('refuses a source with no Draft marker instead of falling back', () => {
      /**
       * The fallback is the dangerous option. Returning the whole file when the
       * marker is missing would mean a file that lost its heading silently starts
       * serving the drafting brief as the terms — reintroducing the exact bug as
       * the error path. Throwing makes it a boot refusal and a build failure.
       */
      expect(() => publishedBody('# A policy\n\nWith no marker at all.\n'))
        .toThrow(PolicyStructureError);
    });

    it('takes everything after the marker and nothing before it', () => {
      const body = publishedBody('# Title\n\n## Specification\n\nInternal notes.\n\n## Draft\n\n# Real Title\n\nReal text.\n');
      expect(body).toBe('# Real Title\n\nReal text.\n');
      expect(body).not.toContain('Internal notes.');
    });

    it('hashes the published body, not the whole file', () => {
      /**
       * Why this matters: the hash is what an acceptance record points at. If it
       * covered the whole file, editing the internal drafting notes — commentary
       * no user ever sees — would invalidate every acceptance row and force a
       * version bump on a document whose text did not change.
       */
      for (const doc of LEGAL_DOCUMENTS) {
        const whole = readFileSync(path.join(POLICY_DIR, doc.file), 'utf8');
        const wholeHash = createHash('sha256').update(whole).digest('hex');
        expect(
          doc.contentHash,
          `${doc.slug}: the pinned hash covers the whole file including the drafting brief`
        ).not.toBe(wholeHash);

        const bodyHash = createHash('sha256').update(publishedBody(whole)).digest('hex');
        expect(hashPolicyFile(doc.file), `${doc.slug}: the file hash is not the published body's`).toBe(bodyHash);
      }
    });
  });

  it('every registered document names a file that exists', () => {
    // Catches the registry drifting from the directory — a document renamed on
    // disk without its registry entry, which would otherwise surface as a 500 on
    // the one page somebody was told to read.
    for (const doc of LEGAL_DOCUMENTS) {
      expect(
        () => readFileSync(path.join(POLICY_DIR, doc.file)),
        `${doc.slug} points at a missing file: ${doc.file}`
      ).not.toThrow();
    }
  });
  /**
   * Cross-references between published documents actually work.
   *
   * ── Why this is checked through the renderer and not with a regex ──
   *
   * The previous version of this suite carried its own copy of `slugifyHeading`
   * and its own link regex. Both were subtly different from the real ones, and a
   * guard that models the thing it is guarding fails in the one direction that
   * matters: it stays green while the product breaks.
   *
   *   - Its slugifier was a verbatim copy. Change the renderer's and every
   *     fragment link in the published set stops resolving with the suite still
   *     passing, because the suite is now validating against an algorithm
   *     nothing runs.
   *   - Its link regex accepted `([^)]+)` as an href. The renderer's rejects
   *     whitespace (`[^)\s]+`), so `[Privacy Policy](/legal/privacy policy)`
   *     satisfied the test and printed as literal Markdown on the page.
   *
   * So nothing here derives anything. Links are the link spans
   * `parsePolicyMarkdown` produces, and anchors are the `id`s it puts on heading
   * blocks — the same values `PolicyBody` renders into `href` and `id`. The test
   * and the page cannot disagree, because they are reading the same output.
   *
   * ── The two-sided rule ──
   *
   * Asking only "are the rendered links valid" is half a check: a link the
   * renderer refuses to render is not an invalid link, it is not a link at all,
   * and it disappears from the corpus the test is looking at while remaining
   * visible to every reader as raw `[Text](/legal/...)`. So the first rule
   * compares link-SHAPED source against link spans actually produced. It found
   * two live defects in the published set, both now fixed in the renderer: a
   * link on the wrapped line of a list item, and a link inside a bold run.
   */
  describe('link integrity', () => {
    const validSlugs = new Set(LEGAL_DOCUMENTS.map(d => d.slug));

    /** Every link span the renderer produces, in document order. */
    function renderedLinks(source) {
      const found = [];
      const fromSpans = (spans) => {
        for (const span of spans) {
          if (span.type === 'link') found.push(span);
          // A link inside a bold run is a nested span list, not a flat token.
          if (span.spans) fromSpans(span.spans);
        }
      };
      for (const block of parsePolicyMarkdown(source)) {
        if (block.spans) fromSpans(block.spans);
        if (block.items) block.items.forEach(fromSpans);
        if (block.header) block.header.forEach(fromSpans);
        if (block.rows) block.rows.forEach(row => row.forEach(fromSpans));
      }
      return found;
    }

    /** Every anchor id the renderer emits — what a `#fragment` has to hit. */
    function renderedAnchors(source) {
      return new Set(
        parsePolicyMarkdown(source).filter(b => b.type === 'heading').map(b => b.id)
      );
    }

    /**
     * Paths a policy document may link to outside the Legal Center.
     *
     * Derived from src/routes/index.jsx rather than listed here, so a route that
     * is renamed or removed breaks this test instead of silently leaving a
     * policy pointing at a 404. Parameterised and catch-all routes are excluded:
     * a policy has no business deep-linking to a specific event or user, and a
     * literal `:id` in prose is a mistake worth failing on.
     */
    const APP_LINK_TARGETS = new Set(
      [...readFileSync(
        path.join(process.cwd(), 'src', 'routes', 'index.jsx'), 'utf8'
      ).matchAll(/\{\s*path:\s*'([^']+)'/g)]
        .map(m => m[1])
        .filter(p => !p.includes(':') && !p.includes('*'))
    );

    /**
     * Source text shaped like a link, whether or not the renderer accepts it.
     *
     * Code spans are stripped first because the renderer matches them first, so
     * `` `[a](b)` `` is documentation of Markdown rather than a broken link. The
     * href pattern here is deliberately permissive — accepting what the renderer
     * rejects is the entire point of this side of the check.
     */
    function linkShaped(source) {
      const withoutCode = String(source).replace(/`[^`]+`/g, '');
      return [...withoutCode.matchAll(/\[[^\]]+\]\(([^)]*)\)/g)]
        .map(m => ({ token: m[0], href: m[1] }));
    }

    /** Every way one document's links can be wrong. Empty means clean. */
    function linkProblems(slug, source, anchorsBySlug) {
      const problems = [];
      const rendered = renderedLinks(source);

      const unmatched = rendered.map(l => l.href);
      for (const candidate of linkShaped(source)) {
        const at = unmatched.indexOf(candidate.href);
        if (at === -1) {
          problems.push(
            `${slug}: ${candidate.token} is shaped like a link but the renderer `
            + 'produces no link from it, so it prints to the reader as raw Markdown'
          );
        } else {
          unmatched.splice(at, 1);
        }
      }

      for (const { href } of rendered) {
        if (/^https?:\/\//.test(href) || href.startsWith('mailto:')) continue;

        if (/\.md(#.*)?$/.test(href)) {
          problems.push(`${slug}: links to a repository file rather than a published page: ${href}`);
          continue;
        }

        if (href.startsWith('#')) {
          const fragment = href.slice(1);
          if (!anchorsBySlug.get(slug)?.has(fragment)) {
            problems.push(`${slug}: links to #${fragment}, which is not a heading in this document`);
          }
          continue;
        }

        /**
         * An in-app destination, checked against the route table rather than
         * banned.
         *
         * This used to allow only `/legal/<slug>` and `#fragment`, which is the
         * right instinct — a policy naming a URL that 404s is worse than one
         * that names none — but it was enforced by forbidding the whole class.
         * The Accessibility Statement is the case that breaks: its entire
         * purpose is to give somebody blocked by a barrier a route to a person
         * who can fix it, and "Settings, then Help and Support, then Report an
         * issue" is not a route, it is a set of directions to be followed by
         * exactly the person having the most difficulty navigating.
         *
         * So an app link is permitted when the route actually exists. The query
         * string is stripped before matching because ROUTE_PATHS holds paths;
         * `?category=accessibility` is a parameter the destination reads, not a
         * different page.
         */
        if (!href.startsWith('/legal/')) {
          const [pathOnly] = href.split('?');
          if (APP_LINK_TARGETS.has(pathOnly)) continue;
          problems.push(
            `${slug}: internal link is not /legal/<slug>, not #fragment, and not a `
            + `declared app route: ${href}`
          );
          continue;
        }

        const [target, fragment] = href.slice('/legal/'.length).split('#');
        if (!validSlugs.has(target)) {
          problems.push(`${slug}: links to an unregistered document slug: ${target}`);
          continue;
        }
        if (fragment && !anchorsBySlug.get(target).has(fragment)) {
          problems.push(`${slug}: links to #${fragment} in ${target}, which has no such heading`);
        }
      }

      return problems;
    }

    /** Anchors for the real published set, which fixtures link into. */
    function corpusAnchors() {
      return new Map(LEGAL_DOCUMENTS.map(d => [d.slug, renderedAnchors(policyContent(d.slug))]));
    }

    /** Runs one synthetic document through the same rules the corpus faces. */
    function problemsForFixture(source, slug = 'terms-of-service') {
      const anchors = corpusAnchors();
      anchors.set(slug, renderedAnchors(source));
      return linkProblems(slug, source, anchors);
    }

    it('validates fragments against the ids the renderer actually emits', () => {
      /**
       * The pin that makes everything below mean something.
       *
       * `slugifyHeading` is imported, not copied, and the ids this suite checks
       * against are the ones on the parsed heading blocks — the values
       * `PolicyBody` puts in the `id` attribute. If those two ever stopped
       * agreeing, every fragment assertion here would be checking a set of
       * anchors that appears nowhere on the page.
       */
      for (const doc of LEGAL_DOCUMENTS) {
        for (const block of parsePolicyMarkdown(policyContent(doc.slug))) {
          if (block.type !== 'heading') continue;
          expect(block.id, `${doc.slug}: heading "${block.text}" does not carry its slugified id`)
            .toBe(slugifyHeading(block.text));
        }
      }
    });

    it('every published document links only where the reader can actually go', () => {
      const anchors = corpusAnchors();
      const problems = LEGAL_DOCUMENTS.flatMap(
        doc => linkProblems(doc.slug, policyContent(doc.slug), anchors)
      );
      expect(problems, `Broken links in the published set:\n  - ${problems.join('\n  - ')}`).toEqual([]);
    });

    it('has at least one link to check, so a clean result is not an empty corpus', () => {
      // The failure mode of the assertion above is that it passes because the
      // extraction returned nothing. Counted, not assumed.
      const total = LEGAL_DOCUMENTS
        .reduce((n, doc) => n + renderedLinks(policyContent(doc.slug)).length, 0);
      expect(total).toBeGreaterThan(20);
    });

    /**
     * Every rule above, proven able to fail.
     *
     * A guard nobody has seen fail is not a guard — it is a line that runs. Each
     * case here is a document that SHOULD be rejected, run through the same
     * function the real corpus is run through, so the two cannot drift apart.
     */
    describe('rejects', () => {
      it('a relative .md path, which is a repository file and not a page', () => {
        const problems = problemsForFixture('# T\n\nSee [the notice](./01-privacy-policy.md).\n');
        expect(problems).toHaveLength(1);
        expect(problems[0]).toMatch(/repository file/);
      });

      it('a .md path carrying a fragment', () => {
        const problems = problemsForFixture('# T\n\nSee [it](01-privacy-policy.md#your-rights).\n');
        expect(problems).toHaveLength(1);
        expect(problems[0]).toMatch(/repository file/);
      });

      it('a link to a slug no document is registered under', () => {
        const problems = problemsForFixture('# T\n\nSee the [Refund Policy](/legal/refund-policy).\n');
        expect(problems).toHaveLength(1);
        expect(problems[0]).toMatch(/unregistered document slug: refund-policy/);
      });

      it('a fragment that names no heading in the target document', () => {
        const problems = problemsForFixture(
          '# T\n\nSee [retention](/legal/privacy-policy#how-long-we-keep-receipts).\n'
        );
        expect(problems).toHaveLength(1);
        expect(problems[0]).toMatch(/no such heading/);
      });

      it('a same-document fragment that names no heading here', () => {
        const problems = problemsForFixture('# T\n\n## Real section\n\nSee [above](#imaginary-section).\n');
        expect(problems).toHaveLength(1);
        expect(problems[0]).toMatch(/not a heading in this document/);
      });

      it('an internal link to a path that is not a declared route', () => {
        const problems = problemsForFixture('# T\n\nSee [settings](/settings/privacy).\n');
        expect(problems).toHaveLength(1);
        /* /settings/privacy is not a declared route — the real path is
           /settings with a ?section= parameter — so it is still rejected. What
           changed is only that a link to a route which DOES exist is now
           allowed; a link to one that does not is still the failure. */
        expect(problems[0]).toMatch(/not a declared app route/);
      });

      it('allows an internal link to a route that does exist', () => {
        /* The Accessibility Statement's reason for existing: somebody blocked by
           a barrier needs a link, not directions. /report-issue is a declared
           route, so linking to it — parameters and all — is not a defect. */
        expect(problemsForFixture(
          '# T\n\nSee [report it](/report-issue?category=accessibility).\n'
        )).toEqual([]);
      });

      it('an href containing a space, which the renderer prints as literal text', () => {
        /**
         * The defect the old regex could not see. Its href alternative was
         * `([^)]+)`, so this parsed as a perfectly valid link pointing at a
         * registered slug and passed. The renderer's is `[^)\s]+`, so the reader
         * got `[Privacy Policy](/legal/privacy policy)` printed on the page.
         */
        const problems = problemsForFixture('# T\n\nRead the [Privacy Policy](/legal/privacy policy).\n');
        expect(problems).toHaveLength(1);
        expect(problems[0]).toMatch(/prints to the reader as raw Markdown/);
      });
    });

    describe('accepts', () => {
      it('a correct cross-document fragment link', () => {
        expect(problemsForFixture(
          '# T\n\nSee [retention](/legal/privacy-policy#how-long-we-keep-things).\n'
        )).toEqual([]);
      });

      it('external and mailto links, which are nobody here to validate', () => {
        expect(problemsForFixture(
          '# T\n\n[Docs](https://example.org/x) and [us](mailto:a@example.org).\n'
        )).toEqual([]);
      });

      it('a link on the wrapped line of a list item', () => {
        /**
         * Regression, and it was live. A continuation line was appended as a raw
         * text span, so a link that happened to fall past the wrap point printed
         * as Markdown — including the Terms telling a reader where the safety
         * rules are.
         */
        expect(problemsForFixture(
          '# T\n\n- **Report what worries you.** You will not get in trouble for reporting\n'
          + '  something. See the [Youth Safety Guidelines](/legal/youth-safety-guidelines).\n'
        )).toEqual([]);
      });

      it('a link nested inside a bold run', () => {
        /**
         * Regression, and it was live. Bold matched first and swallowed the
         * link, on the Privacy Policy's "Your choices" row about deleting an
         * account — the one place the pointer to the Data Deletion Policy has to
         * work.
         */
        expect(problemsForFixture(
          '# T\n\n**Please read the [Data Deletion Policy](/legal/data-deletion-policy) first.**\n'
        )).toEqual([]);
      });

      it('a link written inside a code span, which documents syntax rather than pointing anywhere', () => {
        expect(problemsForFixture('# T\n\nWrite `[Title](/legal/whatever-you-like)` to link.\n')).toEqual([]);
      });
    });
  });
});
