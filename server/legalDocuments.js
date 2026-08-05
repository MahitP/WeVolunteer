import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The legal document registry: what a user is asked to agree to, and what
 * exactly they agreed to when they did.
 *
 * ── The problem this closes ──
 *
 * `Signup.jsx` rendered a privacy checkbox and validated it, and then
 * `baseFields()` — the object actually sent to the server — did not include it.
 * The server never received it and no table stored it. The control was also
 * wrapped in `{PRIVACY_URL && ...}` with an empty default, so a default build
 * rendered no consent control at all.
 *
 * The result was that WeVolunteer held no evidence that any user had ever
 * agreed to anything, which makes every published policy unenforceable: the
 * question that gets litigated is not "was there a checkbox" but "what did this
 * person agree to, and when".
 *
 * ── Why the hash is a pinned constant rather than read at runtime ──
 *
 * The evidentiary value of an acceptance record is the CONTENT it points at. A
 * version string alone is worthless if the document behind it can be edited
 * afterwards.
 *
 * Two ways to bind them. Hash the file at boot — which makes the running server
 * depend on `docs/` being deployed alongside it, and silently changes the
 * recorded hash the moment somebody fixes a typo. Or pin the hash here and
 * verify it against the file in a test — which keeps the runtime free of any
 * filesystem dependency, and turns "a published document changed without a
 * version bump" into a build failure instead of an invisible drift.
 *
 * The second is what the migration registry already does with `canonicalSource`
 * and `schema_migrations.checksum`, for the same reason, so this follows it.
 * `server/legalDocuments.test.js` is the verifier; `bin/legal-hashes.mjs`
 * prints refreshed values when a document legitimately changes.
 *
 * ── Versioning ──
 *
 * MAJOR.MINOR. MAJOR means a reasonable reader of the previous version would be
 * surprised or worse off — new collection, new sharing, a reduced right, a
 * changed retention period — and requires re-acceptance. MINOR is a
 * clarification and requires notice only. The test is consequence, not diff
 * size: "we do not sell your data" becoming "we may sell your data" is one word
 * and unambiguously MAJOR.
 *
 * ── consentType ──
 *
 *   'agree'       — a contract. Needs an affirmative, unambiguous act.
 *   'acknowledge' — a disclosure. You cannot "agree" to a privacy notice, and
 *                   asking a fourteen-year-old to agree implies they could
 *                   disagree and still sign up. The record still proves it was
 *                   put in front of them.
 *   'notice'      — published and linked; no acceptance is collected.
 *
 * Community Guidelines are incorporated by reference into the Terms and share
 * its checkbox: a second box for one contract is friction without legal
 * benefit. They are still registered separately so the acceptance record names
 * both documents and both versions.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Repo-relative path to the published source of each document. */
export const POLICY_DIR = path.join(HERE, '..', 'docs', 'legal', 'policies');

/**
 * ── v1.1, 2026-08-05 — all three MINOR ──
 *
 * Classified MINOR (notice only, no re-consent) because nothing was taken away
 * and nothing new is collected:
 *
 *   - Terms and Community Guidelines lost an internal editorial block that had
 *     marked enforcement powers as unbuilt. Suspension and blocking now ship,
 *     so the user-facing text describes real behaviour and did not change.
 *   - The Privacy Policy gained its under-13 section — a disclosure of a
 *     protection that already exists (the age gate) rather than a new
 *     practice — and a sentence noting that the retention periods are enforced
 *     by a daily job rather than merely stated.
 *
 * A reader of v1.0 is not worse off under v1.1, which is the test. Users who
 * accepted 1.0 stay accepted at 1.0; MINOR requires notice, not re-acceptance.
 */
export const LEGAL_DOCUMENTS = [
  {
    slug: 'terms-of-service',
    version: '1.1',
    title: 'Terms of Service',
    consentType: 'agree',
    file: '02-terms-of-service.md',
    contentHash: 'a9a2f8fc949b09a401d0b3e395f273825c77a6ce84cafc72f7a25426014d4d84',
    /** Presented with, and accepted by, the same control as the Terms. */
    bundledWith: null,
  },
  {
    slug: 'community-guidelines',
    version: '1.1',
    title: 'Community Guidelines',
    consentType: 'agree',
    file: '03-community-guidelines.md',
    contentHash: '85fc34d0ad2deaff5f4ca39810198f0b5ff17e5ef777f3e076c89d882069320b',
    bundledWith: 'terms-of-service',
  },
  {
    slug: 'privacy-policy',
    version: '1.1',
    title: 'Privacy Policy',
    consentType: 'acknowledge',
    file: '01-privacy-policy.md',
    contentHash: 'd5da708de5de29411c9760539b8e710d4e4c35d11113cafb44f762705cd33636',
    bundledWith: null,
  },
];

/** Documents whose acceptance is collected at signup, in presentation order. */
export const SIGNUP_DOCUMENTS = LEGAL_DOCUMENTS.filter(
  d => d.consentType === 'agree' || d.consentType === 'acknowledge'
);

/**
 * The distinct consent controls a signup form must show.
 *
 * A bundled document does not get its own checkbox — it rides on the one for
 * the document it is bundled with — but it DOES get its own acceptance row, so
 * the record names every document and version the person accepted rather than
 * just the one the checkbox was labelled with.
 */
export const CONSENT_CONTROLS = SIGNUP_DOCUMENTS.filter(d => !d.bundledWith).map(d => ({
  key: d.slug,
  consentType: d.consentType,
  covers: [d.slug, ...LEGAL_DOCUMENTS.filter(x => x.bundledWith === d.slug).map(x => x.slug)],
}));

export function documentBySlug(slug) {
  return LEGAL_DOCUMENTS.find(d => d.slug === slug) || null;
}

/** sha256 of a document's published source, for the drift test and the CLI. */
export function hashPolicyFile(file) {
  const source = readFileSync(path.join(POLICY_DIR, file));
  return createHash('sha256').update(source).digest('hex');
}

/**
 * Which acceptance keys a signup request must carry.
 *
 * Derived from the registry rather than restated, so adding a document to
 * LEGAL_DOCUMENTS starts requiring it without a second edit somewhere that
 * could be forgotten — the same reason the signed-out route test derives from
 * PUBLIC_ROUTES instead of listing routes again.
 */
export function requiredConsentKeys() {
  return CONSENT_CONTROLS.map(c => c.key);
}
