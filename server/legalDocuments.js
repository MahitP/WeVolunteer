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
 *
 * The verifier is `server/consent.test.js` — the "pins a content hash that
 * matches the published file" case in its `the document registry` block, which
 * is `skipIf`'d while `LEGAL_HASHES_ENFORCED` is false and re-arms itself the
 * moment it is flipped. `bin/legal-hashes.mjs` prints refreshed values when a
 * document legitimately changes, and reports drift in both modes.
 * There is no `server/legalDocuments.test.js`, and there never was — this
 * comment named one for a while, and so did the policy README. A pointer to a
 * verifier that does not exist is worse than no pointer: it reads as "this is
 * already covered" to the next person deciding whether to add the coverage.
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
 * ── v1.0, 2026-08-06 — the initial public release. All ten documents. ──
 *
 * Every document is v1.0, because this is the first version any user will ever
 * be shown. Nine carry 2026-08-06; the Organizer Agreement carries 2026-08-05,
 * which is the date printed in its own published body and therefore the date it
 * has to claim.
 *
 * ── Why the pre-launch draft numbering was reset rather than continued ──
 *
 * These documents reached 2.1, 2.2 and 3.0 during drafting, and each of those
 * bumps was correctly classified at the time. None of them was ever published.
 * WeVolunteer has not launched, `legal_acceptances` holds no row belonging to a
 * real person, and no human has agreed to any version of anything here.
 *
 * A version number in this registry exists for exactly one purpose: to answer
 * "what did this person agree to, and when". Numbers that describe revisions of
 * an unpublished draft answer that question about nobody. Worse, they answer it
 * misleadingly — shipping a Terms of Service at v2.1 tells the first reader they
 * are looking at the second major revision of a contract, and invites the
 * question of what the first one said and who accepted it. Nobody accepted it,
 * and there is no archive of it to show them, because there is nothing to
 * archive.
 *
 * So the drafting history stops being version history and becomes what it always
 * was: git history. It is preserved there in full, with the reasoning for every
 * change, which is a better record than a version string could carry anyway.
 *
 * ── The rule this does NOT change ──
 *
 * MAJOR.MINOR and its consequences apply from this release forward, unchanged.
 * The next change to a signup document is judged against v1.0 by the ordinary
 * test — would a reasonable reader of v1.0 be surprised or worse off — and a
 * MAJOR bump from here re-consents real users who really did accept something.
 * This reset is available exactly once, because it depends on there being no
 * acceptance to invalidate. It must not be repeated after launch, and the
 * absence of a second reset is the whole point of having the rule.
 *
 * ── What changed in the documents themselves for this release ──
 *
 * Corrections, not new terms. Four documents had printed a version string in
 * their body that disagreed with the one recorded here, so a reader saw two
 * different answers on one page. The Data Deletion Policy published a section
 * offering a choice about certificates that the software does not implement —
 * contradicting the Privacy Policy in the same set — and it is removed. The
 * Community Guidelines described suspensions as lasting "for a stated period"
 * when nothing expires one, promised a review by "a different administrator"
 * without saying what happens when there is only one, and called a single person
 * a "moderation team". The Youth Safety Guidelines claimed reports are "not
 * triaged by software" when software derives their priority. The Privacy Policy
 * published an applications retention period nothing enforced — now enforced in
 * `retentionWorker.js` rather than weakened — and said safety-report retention
 * was awaiting a decision, which it no longer is.
 *
 * Two placeholders remain, both marked in the published text as blocking
 * publication, because neither can be answered from the repository: the
 * production hosting provider, and the hours one person can commit to reading
 * the safety inbox.
 *
 * ── Why six documents came back from 1.1 to 1.0 ──
 *
 * The v1.0 renumbering was published against a database that had already
 * published five of these documents at v1.0 during drafting, so
 * `syncLegalDocuments` hit its immutability guard and `initDatabase()` threw at
 * startup. The fix at the time gave the four genuinely-changed documents the
 * MINOR bump the rule calls for — 1.1 — which was the correct move for a set
 * that had really been published.
 *
 * It had not. Those publications were development boots of a product that has
 * never launched, and the acceptance rows pointing at them were local test
 * signups from this machine. Shipping 1.1 would have told the first real reader
 * they were looking at the second revision of a document whose first revision
 * nobody can produce, which is the same misleading answer the reset was
 * performed to avoid — just one decimal place smaller.
 *
 * So the collapse to 1.0 is completed rather than half-made: the registry is
 * uniformly 1.0, and the development database's stale `legal_documents` rows and
 * test `legal_acceptances` were cleared so the clean baseline could publish. The
 * hashes did not move — `hashPolicyFile` covers the published body, which these
 * edits did not touch.
 *
 * NOTHING about the integrity system changed. The immutability guard, the hash
 * pinning, the fail-closed boot and acceptance tracking are all exactly as they
 * were; what changed is the data they were guarding, which was drafting
 * residue. `legalRepublish.test.js` still pins that editing a published version
 * throws. This remains available exactly once, and it has now been used.
 */
export const LEGAL_DOCUMENTS = [
  {
    slug: 'terms-of-service',
    version: '1.0',
    title: 'Terms of Service',
    consentType: 'agree',
    scope: 'signup',
    summary: 'The agreement between you and WeVolunteer: what you may do here, what we owe you, and how an account ends.',
    effectiveAt: '2026-08-06',
    file: '02-terms-of-service.md',
    contentHash: '59dd2cb44ced3c5ee4e3a983ef868fc85c79ddcb990a37abf3cb574a496f5242',
    /** Presented with, and accepted by, the same control as the Terms. */
    bundledWith: null,
  },
  {
    slug: 'community-guidelines',
    version: '1.0',
    title: 'Community Guidelines',
    consentType: 'agree',
    scope: 'signup',
    summary: 'How people are expected to behave here, what is not allowed, and what happens when someone breaks the rules.',
    effectiveAt: '2026-08-06',
    file: '03-community-guidelines.md',
    contentHash: '46dccf33eb7e17ba2ba1b13296299470c8b034d53ea251b5568382e9fbbbacef',
    bundledWith: 'terms-of-service',
  },
  {
    slug: 'privacy-policy',
    version: '1.0',
    title: 'Privacy Policy',
    consentType: 'acknowledge',
    scope: 'signup',
    summary: 'What we collect, why, who can see it, how long we keep it, and how to get it back or have it deleted.',
    effectiveAt: '2026-08-06',
    file: '01-privacy-policy.md',
    contentHash: '0bfc976497fadbc231138363c73e556d21860435c4d1673d827536533c1a0c33',
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
    version: '1.0',
    title: 'Youth Safety Guidelines',
    consentType: 'notice',
    scope: 'notice',
    summary: 'How to stay safe volunteering, what an adult here should never ask you for, and how to report it when they do.',
    effectiveAt: '2026-08-06',
    file: '08-youth-safety-guidelines.md',
    contentHash: '4b4cd1aaf9e8e6b0da562e81a6e0357690307db50187da90ca955960164c4471',
    bundledWith: null,
  },
  {
    slug: 'certificate-verification-policy',
    version: '1.0',
    title: 'Certificate Verification Policy',
    consentType: 'notice',
    scope: 'notice',
    summary: 'What a WeVolunteer certificate proves, what it does not, and how anyone can check whether one is real.',
    effectiveAt: '2026-08-06',
    file: '06-certificate-verification-policy.md',
    contentHash: 'a8c022d0813d685eab3cbd491238a8b875ab98dc89cb98ea4d416486ffa747db',
    bundledWith: null,
  },
  {
    slug: 'volunteer-record-policy',
    version: '1.0',
    title: 'Volunteer Record Policy',
    consentType: 'notice',
    scope: 'notice',
    summary: 'How your service hours are recorded, why a confirmed hour is never re-priced, and what happens if a record is wrong.',
    effectiveAt: '2026-08-06',
    file: '07-volunteer-record-policy.md',
    /* Refreshed for the v1.3 Auto Select section — the file was edited to
       describe the attendance term and the pinned constant was not moved with
       it, so every boot warned about drift. Version left at 1.0: the document is
       `notice` (no acceptance is collected) and nothing here has been published
       to a reader yet, so this is a correction before first publication rather
       than a revision of something somebody read. */
    contentHash: '1c1eb6c86943378ab20dd373071fef47759951d7db5aba54603e653bb1e1406f',
    bundledWith: null,
  },
  {
    slug: 'data-deletion-policy',
    version: '1.0',
    title: 'Data Deletion Policy',
    consentType: 'notice',
    scope: 'notice',
    summary: 'What deleting your account removes, what survives and why, and how to ask for something to be erased.',
    effectiveAt: '2026-08-06',
    file: '04-data-deletion-policy.md',
    contentHash: 'f80350653dd607035aaf08fd6fa2e9c1b5815533145d8d3a45ec995df132e653',
    bundledWith: null,
  },
  {
    slug: 'cookie-and-tracking-notice',
    version: '1.0',
    title: 'Cookie and Tracking Notice',
    consentType: 'notice',
    scope: 'notice',
    summary: 'The cookies this site sets, all of which are needed to keep you signed in. No advertising or analytics trackers.',
    effectiveAt: '2026-08-06',
    file: '05-cookie-and-tracking-notice.md',
    contentHash: '10e7ed5f16f6c1773f41a8c52ce8611174dea13029c67f99ae179f863815cf1b',
    bundledWith: null,
  },
  {
    slug: 'admin-responsibilities-policy',
    version: '1.0',
    title: 'Admin Responsibilities Policy',
    consentType: 'notice',
    scope: 'notice',
    summary: 'What administrators may do, what is logged when they do it, and the limits on looking at a student\'s record.',
    effectiveAt: '2026-08-06',
    file: '10-admin-responsibilities-policy.md',
    contentHash: 'da264f205032cf796e10eed11019faba64732f113155fa834e1f56cc444f189c',
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

/**
 * Whether a published document's text is pinned to its recorded hash.
 *
 * ── Owner decision, 2026-08-07: not before launch ──
 *
 * The enforcement below is correct and stays in the codebase, because after
 * launch it is the thing that makes an acceptance record mean something: a user
 * agreed to a specific text, and nobody gets to change that text underneath the
 * record afterwards.
 *
 * Before launch it costs more than it protects. The documents are still being
 * drafted, there are no real acceptance records to protect, and every wording fix
 * — a typo, a clarified sentence — meant editing a policy file, running
 * `bin/legal-hashes.mjs`, pasting a new constant, and rebooting a server that had
 * refused to start in the meantime. The owner's instruction is to stop paying
 * that until there is something to protect, and to keep every document at
 * version 1.0 until release.
 *
 * ── What changes, and what deliberately does not ──
 *
 * Advisory mode relaxes exactly one comparison: file text against recorded hash.
 * It does NOT relax:
 *
 *   - a missing policy file, or one that has lost its `## Draft` marker. Those
 *     still throw and still stop a production boot, because they mean the
 *     document cannot be shown at all — which is a different failure from the
 *     document having been edited.
 *   - the ORGANIZER AGREEMENT version gate. That is keyed on `(slug, version)`,
 *     not on the hash, and bumping a version still re-withholds eleven
 *     capabilities until the organizer re-accepts. Versions stay at 1.0, so
 *     nothing moves — but the mechanism is untouched and still works.
 *
 * ── Flipping it back ──
 *
 * Set this to `true` at launch. Run `node bin/migration-checksums.mjs`'s sibling,
 * `node bin/legal-hashes.mjs`, paste the printed constants into LEGAL_DOCUMENTS,
 * and the enforcement is live again with no other change. Everything that reads
 * a hash keeps reading one the whole time; the difference is only whether a
 * mismatch is fatal.
 */
export const LEGAL_HASHES_ENFORCED = false;

/**
 * The hash to RECORD for a document — what was actually published.
 *
 * Enforced, this is the pinned constant, and it is equal to the file's hash by
 * definition because the check would have thrown otherwise.
 *
 * Advisory, it is the live file hash. That distinction is the whole reason this
 * function exists rather than each caller reaching for `doc.contentHash`: while
 * the text is allowed to move, a stored hash copied from a stale constant is a
 * record that claims somebody agreed to bytes they never saw. Recording what was
 * really served keeps `legal_documents` and `legal_acceptances` honest even in
 * the mode that stops checking them.
 *
 * Falls back to the pinned constant if the file cannot be read, so a caller in a
 * half-installed checkout gets a value rather than an exception — the missing
 * file is reported by `policyContent`, which is where that failure belongs.
 */
export function publishedHash(doc) {
  if (LEGAL_HASHES_ENFORCED) return doc.contentHash;
  try {
    return hashPolicyFile(doc.file);
  } catch {
    return doc.contentHash;
  }
}
