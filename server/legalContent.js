import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  LEGAL_DOCUMENTS, POLICY_DIR, hashPolicyFile, publishedBody, PolicyStructureError,
  LEGAL_HASHES_ENFORCED,
} from './legalDocuments.js';

/**
 * Reads published policy text off disk so the API can serve it.
 *
 * ── Why this is a separate module from legalDocuments.js ──
 *
 * `legalDocuments.js` pins each document's hash as a constant and explains at
 * length why it does NOT read the filesystem at runtime: hashing at boot would
 * make the recorded hash change silently the moment somebody fixed a typo, and
 * the whole evidentiary value of an acceptance row is that its hash cannot move
 * under it.
 *
 * Serving the text is a different job with a different hazard, so it lives in a
 * different file. The registry stays a pure data module that anything can import
 * without touching a disk; this module is the one place that reads `docs/`.
 *
 * ── The dependency this introduces, and why it is safe ──
 *
 * Until now the server did not need `docs/` to be deployed. A Legal Center that
 * serves the actual published text does, and pretending otherwise by inlining
 * six thousand lines of Markdown into a JS module would be worse.
 *
 * What makes it safe is that content is never served unverified. Every read is
 * hash-checked against the registry's pinned constant, and a mismatch throws
 * instead of returning the file. So the failure mode of a stale or edited
 * deployment is a loud 500 and a boot-time refusal — not a user reading terms
 * that differ from the ones their acceptance record points at, which is the
 * outcome that would actually cost something in a dispute.
 *
 * That check makes the runtime dependency strictly stronger than no dependency:
 * previously a published document could drift from its hash and only a test
 * would notice, and only in CI. Now production refuses to start.
 *
 * ── Cached after first read ──
 *
 * The documents are immutable for the life of the process — a version bump is a
 * deploy — so re-reading and re-hashing ~8 KB of Markdown per request would buy
 * nothing. The cache is keyed by slug and populated on demand.
 */

/** slug -> verified Markdown source. */
const cache = new Map();

/** Slugs already warned about for hash drift — see the advisory branch below. */
const warnedDrift = new Set();

/** Thrown when a policy file is missing or does not match its pinned hash. */
export class PolicyContentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PolicyContentError';
  }
}

/**
 * The verified Markdown source of one document.
 *
 * Throws `PolicyContentError` rather than returning partial or unverified text.
 * A caller that cannot show the real document must show an error, never a
 * plausible substitute.
 */
export function policyContent(slug) {
  if (cache.has(slug)) return cache.get(slug);

  const doc = LEGAL_DOCUMENTS.find(d => d.slug === slug);
  if (!doc) throw new PolicyContentError(`No such legal document: ${slug}`);

  let source;
  try {
    source = readFileSync(path.join(POLICY_DIR, doc.file), 'utf8');
  } catch (err) {
    throw new PolicyContentError(
      `Policy file missing for ${slug} (${doc.file}): ${err.code || err.message}. `
      + 'docs/legal/policies must be deployed alongside the server.'
    );
  }

  /**
   * Only the publishable half is served.
   *
   * Each file opens with an internal `## Specification` block — purpose,
   * audience, required sections — before the document itself. That block was
   * briefly served to users, so the Terms page began "Purpose. Establish the
   * contract" above a list of required sections. A published policy that opens
   * with its own drafting brief undermines the document.
   */
  let body;
  try {
    body = publishedBody(source);
  } catch (err) {
    if (err instanceof PolicyStructureError) {
      throw new PolicyContentError(`${doc.file}: ${err.message}`);
    }
    throw err;
  }

  const actual = hashPolicyFile(doc.file);
  if (actual !== doc.contentHash) {
    const detail = `Policy file for ${slug} does not match its pinned hash. `
      + `Expected ${doc.contentHash}, read ${actual}.`;

    if (LEGAL_HASHES_ENFORCED) {
      throw new PolicyContentError(
        `${detail} `
        + 'Refusing to serve text that differs from what acceptance records point at. '
        + 'Run node bin/legal-hashes.mjs and bump the version if the change is intentional.'
      );
    }

    /**
     * Advisory before launch — the owner's decision, recorded at
     * LEGAL_HASHES_ENFORCED in legalDocuments.js.
     *
     * Warned rather than silent, and warned ONCE per slug rather than on every
     * read: the drift is expected while the documents are being drafted, so a
     * line per request would be noise that trains everybody to ignore the
     * channel this will use again when it matters. Once per process is enough to
     * answer "did I forget to refresh the constants?".
     */
    if (!warnedDrift.has(slug)) {
      warnedDrift.add(slug);
      console.warn(`[legal] ${detail} Serving the file as written (pre-launch; hashes advisory).`);
    }
  }

  cache.set(slug, body);
  return body;
}

/**
 * Verifies every registered document at boot.
 *
 * Called from `server.js` so a deployment missing `docs/` or carrying edited
 * policy text fails closed at startup, in the same spirit as the production
 * guards in `config.js`. Returns the number of documents verified so the caller
 * can log something meaningful; throws on the first problem.
 *
 * Aggregates rather than stopping at the first failure, because "three
 * documents are missing" and "one document is missing" call for different
 * responses and finding that out one redeploy at a time is miserable.
 */
export function verifyPolicyFiles() {
  const problems = [];

  for (const doc of LEGAL_DOCUMENTS) {
    try {
      policyContent(doc.slug);
    } catch (err) {
      problems.push(err.message);
    }
  }

  if (problems.length > 0) {
    throw new PolicyContentError(
      `${problems.length} legal document(s) failed verification:\n  - ${problems.join('\n  - ')}`
    );
  }

  return LEGAL_DOCUMENTS.length;
}

/** Drops the cache. Tests only — the documents cannot change in production. */
export function resetPolicyCache() {
  cache.clear();
  /* The drift warning is once-per-process, which in a test file means the second
     case would see no warning from the first case's edit. Cleared with the cache
     so each test starts from the same state. */
  warnedDrift.clear();
}
