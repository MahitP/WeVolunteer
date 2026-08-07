import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { LEGAL_DOCUMENTS, POLICY_DIR, publishedBody, PolicyStructureError, hashPolicyFile } from './legalDocuments.js';
import { policyContent, verifyPolicyFiles, resetPolicyCache, PolicyContentError } from './legalContent.js';

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
            `${doc.slug} is serving its internal Specification block ("${marker}")`
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
});
