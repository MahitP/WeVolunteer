import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { LEGAL_DOCUMENTS, POLICY_DIR } from './legalDocuments.js';

/**
 * Pre-launch, every document is at 1.0 — and the registry, the document's own
 * header and the pinned hash say the same thing.
 *
 * ── The drift this exists to stop ──
 *
 * The Privacy Policy reached 1.1. `386c9e9` bumped it when it added Upstash to
 * the subprocessor table, which is new sharing rather than a wording fix, so
 * under MAJOR/MINOR the bump was a defensible reading. MAJOR/MINOR is not the
 * rule that applies yet:
 *
 *   "Every document is at version 1.0, and stays there until launch… Do not
 *    bump a version to record a pre-launch wording fix. MAJOR/MINOR applies
 *    from the first published release forward."
 *        — docs/legal/policies/README.md, and the header of LEGAL_DOCUMENTS
 *
 * Three sibling documents were edited in the same week and all three kept 1.0.
 * This one did not, and nothing failed — the hash check compares the registry
 * to the FILE and is indifferent to the number beside it, and no test read the
 * versioning rule at all. It survived a full release-gate audit as the only
 * document in the set carrying a version other than 1.0.
 *
 * ── Why this is safe to assert ──
 *
 * Because it is checked against the acceptance records rather than asserted as
 * dogma. The rule holds only while nothing has been accepted; once real people
 * have agreed to a version, a MAJOR bump is not merely allowed but required,
 * and this file must be retired rather than worked around. The last case says
 * exactly that, in a form the next reader will actually see.
 */

/**
 * The version a reader sees, however the date beside it is phrased.
 *
 * Three forms are in use and all three are fine: "Last updated 2026-08-06",
 * a bare "· 2026-08-05" on the Organizer Agreement, and "· Effective
 * 2026-08-13" on the Student Organizer Agreement. Only the NUMBER has to agree
 * with the registry, so only the number is captured — pinning the date wording
 * would be this test having an opinion about prose.
 */
const HEADER = /^\*\*Version\s+([0-9]+\.[0-9]+)/m;

/**
 * The one document that prints no version line in its published half.
 *
 * ── Why this is safe, rather than merely tolerated ──
 *
 * The version a reader sees does not come from the markdown. `LegalDocument.jsx`
 * renders `Version {doc.version} · in effect since …` from the REGISTRY, above
 * the document body, for every document — and its own docstring says that is
 * deliberate: "an acceptance record says 'this user agreed to terms-of-service
 * v2.0'… that record is worth something only if the reader can tell which
 * version they are looking at."
 *
 * So the in-markdown line is a second, hand-maintained copy of a fact the page
 * already states authoritatively. `ai-and-on-device-processing` simply does not
 * carry the copy: it states "Scope at v1.0" in its specification block, above
 * the `## Draft` marker, and nothing below it. Nobody is deprived of the
 * version, which is why this is an exception and not a defect, and why adding
 * a thirteenth duplicate to a hash-enforced published body — changing a legal
 * document for source-file tidiness — is the wrong trade.
 *
 * `LegalDocument.meta.test.jsx` holds the half that makes this true: a document
 * whose markdown carries no version line still renders the registry's version.
 * If that ever stops being true, the exception below stops being safe.
 *
 * ── What the allowlist is for ──
 *
 * It has exactly one member, and a second document losing its line fails the
 * build rather than joining a silent exemption. The case below also fails if
 * this document GAINS a line, so the allowlist cannot quietly outlive its
 * reason.
 */
const NO_PRINTED_VERSION = new Set(['ai-and-on-device-processing']);

/** The published half of a policy file — everything below the `## Draft` marker. */
function publishedText(file) {
  const raw = fs.readFileSync(path.join(POLICY_DIR, file), 'utf8');
  const marker = raw.indexOf('\n## Draft');
  return marker === -1 ? raw : raw.slice(marker);
}

describe('the pre-launch versioning rule', () => {
  it('has documents to check, so this cannot pass by finding none', () => {
    expect(LEGAL_DOCUMENTS.length).toBeGreaterThanOrEqual(13);
  });

  it.each(LEGAL_DOCUMENTS.map(d => [d.slug, d.version]))(
    '%s is at 1.0',
    (slug, version) => {
      expect(
        version,
        `${slug} is at ${version}. Before launch every document stays at 1.0 — see `
        + '"Versioning — read before publishing" in docs/legal/policies/README.md. '
        + 'If this is a genuine post-launch revision, the acceptance records now '
        + 'exist and THIS FILE is what needs retiring, not the version number.',
      ).toBe('1.0');
    },
  );

  /**
   * The header a reader actually sees has to agree with the registry.
   *
   * These are two independent statements of the same fact in two files, which
   * is exactly the shape that drifts — and it did: the registry said 1.1 and so
   * did the document, but they were changed together and nothing would have
   * caught it if only one had been.
   */
  it.each(LEGAL_DOCUMENTS.map(d => [d.slug, d.file, d.version]))(
    '%s prints its registry version in its own header',
    (slug, file, version) => {
      const match = publishedText(file).match(HEADER);

      if (NO_PRINTED_VERSION.has(slug)) {
        expect(
          match,
          `${slug} now prints a version line. That is an improvement — remove it `
          + 'from NO_PRINTED_VERSION so the number is checked against the registry.',
        ).toBeNull();
        return;
      }

      expect(
        match,
        `${slug} has no "**Version X.Y" line in its published body, so a reader `
        + 'cannot tell which version they are looking at',
      ).toBeTruthy();
      expect(
        match[1],
        `${slug} prints version ${match[1]} but the registry says ${version}`,
      ).toBe(version);
    },
  );

  /**
   * `effectiveAt` is the date the version takes effect, not the date somebody
   * last edited the file.
   *
   * The Privacy Policy's had been moved to 2026-08-30 by the edit that bumped
   * it, while the Terms, the Youth Safety Guidelines and the Cookie Notice were
   * edited the same week and kept 2026-08-06. Documents written later carry
   * their own later dates, which is correct and is why this asserts a bound
   * rather than one value.
   */
  it.each(LEGAL_DOCUMENTS.map(d => [d.slug, d.effectiveAt]))(
    '%s takes effect on or before the v1.0 release date it is part of',
    (slug, effectiveAt) => {
      expect(effectiveAt, `${slug} has no effectiveAt`).toBeTruthy();
      expect(
        effectiveAt >= '2026-08-06',
        `${slug} predates the v1.0 release date`,
      ).toBe(true);
    },
  );

  /**
   * The rule's own precondition, asserted rather than assumed.
   *
   * Everything above is correct only while the set is unpublished to real
   * people. This states the dependency in the place somebody will be standing
   * when the cases above start being wrong.
   */
  it('is a PRE-LAUNCH rule, and says so where it will be read', () => {
    const readme = fs.readFileSync(
      path.join(POLICY_DIR, 'README.md'), 'utf8',
    );
    expect(
      readme,
      'the rule this file enforces is no longer written down where the next '
      + 'person editing a policy would find it',
    ).toMatch(/stays there until launch/i);
  });
});
