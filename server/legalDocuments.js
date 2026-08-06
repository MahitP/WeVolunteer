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
 *
 * ── scope ──
 *
 * WHEN a document is put in front of somebody, which is a different question
 * from whether it is a contract.
 *
 *   'signup'  — every account agrees or acknowledges at registration.
 *   'notice'  — published and linked; no acceptance collected.
 *   'organizer-onboarding'
 *             — a contract, but only for the people it binds. The Organizer
 *               Agreement is `consentType: 'agree'`; demanding it from every
 *               fourteen-year-old at signup would be asking students to accept
 *               undertakings about handling other students' contact details.
 *               Spelled with the suffix because `'organizer'` alone is a ROLE
 *               name, and comparing against a quoted role literal fails the
 *               build — see ORGANIZER_DOCUMENTS below for why renaming beats
 *               taking the guard's exemption.
 *
 * `scope` and not `consentType` is what drives the signup form, because the two
 * genuinely differ for exactly one document and conflating them is how the
 * Organizer Agreement would end up as a fourth mandatory signup checkbox.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Repo-relative path to the published source of each document. */
export const POLICY_DIR = path.join(HERE, '..', 'docs', 'legal', 'policies');

/**
 * ── v2.0, 2026-08-05 — the three signup documents, MAJOR ──
 *
 * MAJOR, so every existing acceptance is stale and re-consent is required. Three
 * independent reasons, any one of which would be enough:
 *
 *   - **The counterparty is now named.** v1.1 shipped with a literal
 *     `[[LEGAL_ENTITY_NAME]]` in the text. A reader could not tell who they were
 *     contracting with, which is not a detail — it is the identity of the other
 *     party. It is now "Mahit Pulavarthi, a sole proprietor doing business as
 *     WeVolunteer".
 *   - **The Terms gained obligations and a liability cap.** New organizer
 *     duties, an intellectual-property section, a dispute process, a governing
 *     law and venue clause, and a limit on recoverable loss. A reader of v1.1 is
 *     unambiguously worse off in at least one respect, which is the test.
 *   - **The Privacy Policy corrected a retention period and withdrew a stated
 *     option.** It had published error-diagnostics retention as 90 days when the
 *     code sweeps at 30/30/180/7, and it had described certificate voiding at
 *     deletion as available when it is not built. A policy describing a right the
 *     software does not offer is the version worth invalidating.
 *
 * The other seven documents are registered here for the first time, at v1.0.
 * They have never been published, so there is no prior version for a reader to be
 * worse off than.
 *
 * ── The previous entry, kept for the version history ──
 *
 * v1.1 was classified MINOR: the Terms and Community Guidelines lost an internal
 * editorial block that had marked enforcement powers as unbuilt (suspension and
 * blocking shipped, so the user-facing text described real behaviour and did not
 * change), and the Privacy Policy gained its under-13 section — a disclosure of a
 * protection that already existed rather than a new practice.
 */
export const LEGAL_DOCUMENTS = [
  {
    slug: 'terms-of-service',
    version: '2.1',
    title: 'Terms of Service',
    consentType: 'agree',
    scope: 'signup',
    summary: 'The agreement between you and WeVolunteer: what you may do here, what we owe you, and how an account ends.',
    effectiveAt: '2026-08-05',
    file: '02-terms-of-service.md',
    contentHash: 'a45b6fe830900c33915d6be48e10f9ed5f5f5e28c00a2de92bfb72c38de43e21',
    /** Presented with, and accepted by, the same control as the Terms. */
    bundledWith: null,
  },
  {
    slug: 'community-guidelines',
    version: '2.2',
    title: 'Community Guidelines',
    consentType: 'agree',
    scope: 'signup',
    summary: 'How people are expected to behave here, what is not allowed, and what happens when someone breaks the rules.',
    effectiveAt: '2026-08-05',
    file: '03-community-guidelines.md',
    contentHash: '1cfff36cf7cb5441a61143209f9db957c9d83217011970a547d508611694a107',
    bundledWith: 'terms-of-service',
  },
  {
    /**
     * 3.0 — MAJOR, and by the letter of the rule above: "a changed retention
     * period". Safety reports and the messages saved with them became a third
     * indefinitely-kept class, and the account shell's flat three years gained
     * two exceptions. A reader of 2.0 was told in terms that only hours and
     * certificates outlive everything; that is no longer true, and it is
     * exactly the kind of statement someone decides whether to sign up on.
     */
    slug: 'privacy-policy',
    version: '3.0',
    title: 'Privacy Policy',
    consentType: 'acknowledge',
    scope: 'signup',
    summary: 'What we collect, why, who can see it, how long we keep it, and how to get it back or have it deleted.',
    effectiveAt: '2026-08-05',
    file: '01-privacy-policy.md',
    contentHash: '717282f9ed4e62dede535ecae3541c037f09c906c048a8fac57fee1bf93d33ec',
    bundledWith: null,
  },
  {
    slug: 'organizer-agreement',
    version: '1.0',
    title: 'Organizer Agreement',
    consentType: 'agree',
    scope: 'organizer-onboarding',
    summary: 'The undertakings an organizer makes before receiving students\' contact details: protect it, use it only for the event, record attendance honestly.',
    effectiveAt: '2026-08-05',
    file: '09-organizer-agreement.md',
    contentHash: '3267acbae5de9732bc44ec6843565d13755dc8bda11ffd2e993b724046e3d60c',
    bundledWith: null,
  },
  {
    slug: 'youth-safety-guidelines',
    version: '1.1',
    title: 'Youth Safety Guidelines',
    consentType: 'notice',
    scope: 'notice',
    summary: 'How to stay safe volunteering, what an adult here should never ask you for, and how to report it when they do.',
    effectiveAt: '2026-08-05',
    file: '08-youth-safety-guidelines.md',
    contentHash: 'f0a01025c6d875a037b7c7875be754324742777beba5ad5cb97c2b57d8892656',
    bundledWith: null,
  },
  {
    slug: 'certificate-verification-policy',
    version: '1.0',
    title: 'Certificate Verification Policy',
    consentType: 'notice',
    scope: 'notice',
    summary: 'What a WeVolunteer certificate proves, what it does not, and how anyone can check whether one is real.',
    effectiveAt: '2026-08-05',
    file: '06-certificate-verification-policy.md',
    contentHash: '30aa3b6b09a022b63697092794c69a1748b99b89d0461de67d2caf95861a3e4d',
    bundledWith: null,
  },
  {
    slug: 'volunteer-record-policy',
    version: '1.0',
    title: 'Volunteer Record Policy',
    consentType: 'notice',
    scope: 'notice',
    summary: 'How your service hours are recorded, why a confirmed hour is never re-priced, and what happens if a record is wrong.',
    effectiveAt: '2026-08-05',
    file: '07-volunteer-record-policy.md',
    contentHash: '50fba883942d0aee6a98aa4d903547aab60b7722e7d288b1845ea9ab8e3eb092',
    bundledWith: null,
  },
  {
    /**
     * 2.0 — MAJOR. A new exception to deletion, which is the one thing this
     * document exists to enumerate: the Terms make it the exclusive register of
     * what survives an account deletion ("except where we have said in the Data
     * Deletion Policy that something is kept, and why"), and until now it did
     * not mention safety reports at all. Code that kept a report past deletion
     * while this document stayed silent would be an unstated exception to a
     * published promise, at the exact moment a student decides to press delete.
     */
    slug: 'data-deletion-policy',
    version: '2.0',
    title: 'Data Deletion Policy',
    consentType: 'notice',
    scope: 'notice',
    summary: 'What deleting your account removes, what survives and why, and how to ask for something to be erased.',
    effectiveAt: '2026-08-05',
    file: '04-data-deletion-policy.md',
    contentHash: '3a5a984454ae36e26116bcf163012cc1df7477d552b0409c19ee98d584749c9e',
    bundledWith: null,
  },
  {
    slug: 'cookie-and-tracking-notice',
    version: '1.0',
    title: 'Cookie and Tracking Notice',
    consentType: 'notice',
    scope: 'notice',
    summary: 'The cookies this site sets, all of which are needed to keep you signed in. No advertising or analytics trackers.',
    effectiveAt: '2026-08-05',
    file: '05-cookie-and-tracking-notice.md',
    contentHash: 'efe5466cdd8cbf3bedb8f1b4d9e2ccc9ee965a0de8f9079408cf8f8723ab3ddb',
    bundledWith: null,
  },
  {
    slug: 'admin-responsibilities-policy',
    version: '1.0',
    title: 'Admin Responsibilities Policy',
    consentType: 'notice',
    scope: 'notice',
    summary: 'What administrators may do, what is logged when they do it, and the limits on looking at a student\'s record.',
    effectiveAt: '2026-08-05',
    file: '10-admin-responsibilities-policy.md',
    contentHash: '1c57c1a9e0ea44876992288861257753b90f760cbe15e93e95da632565830ee2',
    bundledWith: null,
  },
];

/**
 * Documents whose acceptance is collected at signup, in presentation order.
 *
 * Keyed on `scope` and not `consentType`. The Organizer Agreement is a contract
 * — `consentType: 'agree'` — but it binds organizers, not students, so a filter
 * on consentType would silently make it a fourth mandatory signup checkbox the
 * moment it was registered.
 */
export const SIGNUP_DOCUMENTS = LEGAL_DOCUMENTS.filter(d => d.scope === 'signup');

/**
 * Documents an organizer accepts before receiving applicants' contact details.
 *
 * The scope value is `'organizer-onboarding'` and not `'organizer'` on purpose.
 * `'organizer'` is a ROLE NAME, and `authz.completeness.test.js` fails the build
 * on any comparison against a quoted role literal anywhere in `server/` or
 * `src/` — a guard that exists because role-string comparisons are how
 * authorization decisions drift out of the capability table.
 *
 * `d.scope === 'organizer'` in a view is not an authorization decision (it asks
 * about a document, not a person) and the guard offers a declared-exemption
 * escape hatch for exactly that case. Renaming the value is better than taking
 * it: an exemption is a permanent hole in a security guard, added to preserve a
 * word — and the longer name is more accurate anyway, since it names WHEN the
 * document is collected rather than who the reader is.
 */
export const ORGANIZER_DOCUMENTS = LEGAL_DOCUMENTS.filter(d => d.scope === 'organizer-onboarding');

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

/**
 * The marker separating the drafting brief from the document itself.
 *
 * Each file in `docs/legal/policies/` opens with a `## Specification` block —
 * purpose, audience, required sections, the decisions that were resolved and why
 * — and then the real document under `## Draft`. Keeping the two together is
 * deliberate and worth preserving: the reasoning behind a clause is most useful
 * next to the clause.
 *
 * But only the second half is the policy. The first half is an internal editorial
 * artifact, and it was briefly served to users: the Terms page opened with
 * "Purpose. Establish the contract" and a list of required sections, which reads
 * as a draft somebody published by accident, and undermines the document it is
 * attached to.
 */
const PUBLISHED_MARKER = '\n## Draft\n';

/** Thrown when a policy file has no publishable body. */
export class PolicyStructureError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PolicyStructureError';
  }
}

/**
 * The publishable half of a policy file.
 *
 * Throws rather than falling back to the whole file. A fallback would mean a file
 * that lost its marker silently starts serving the drafting brief as the terms —
 * the exact failure this function exists to prevent, reintroduced as the error
 * path. Failing loudly turns it into a boot refusal and a build failure instead.
 */
export function publishedBody(source) {
  const text = String(source).replace(/\r\n/g, '\n');
  const at = text.indexOf(PUBLISHED_MARKER);
  if (at === -1) {
    throw new PolicyStructureError(
      `Policy source has no "## Draft" marker, so its publishable body cannot be `
      + 'identified. Every file in docs/legal/policies/ must separate its internal '
      + 'Specification block from the document with that heading.'
    );
  }
  return text.slice(at + PUBLISHED_MARKER.length).replace(/^\n+/, '');
}

/**
 * sha256 of a document's PUBLISHED body, for the drift test and the CLI.
 *
 * Over the published half and not the whole file, which matters for the reason the
 * module header gives: an acceptance record's hash is what proves what somebody
 * agreed to. Hashing the whole file would mean editing the drafting notes — pure
 * internal commentary no user ever sees — invalidates every acceptance row and
 * forces a version bump on a document whose text did not change. Hashing the body
 * makes the hash mean exactly "the words the user read", so it moves when those
 * words move and not otherwise.
 */
export function hashPolicyFile(file) {
  const source = readFileSync(path.join(POLICY_DIR, file), 'utf8');
  return createHash('sha256').update(publishedBody(source)).digest('hex');
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
