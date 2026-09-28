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

/**
 * The document registry.
 *
 * ── What is authoritative here, and what is not (v1.4) ──
 *
 * This array is still the closed set of documents and the sole owner of
 * everything that is NOT content: `slug`, `title`, `summary`, `scope`,
 * `consentType`, `file`, `bundledWith`. The Legal Center editor cannot change
 * any of them, and that boundary is load-bearing rather than incidental —
 * `SIGNUP_DOCUMENTS`, `ORGANIZER_DOCUMENTS` and `CONSENT_CONTROLS` are all
 * computed from those fields once at module load, so a `scope` that could move
 * at runtime would silently drop a document out of the signup consent block.
 *
 * `version`, `effectiveAt` and the text itself are now the value a document
 * SHIPPED with, not necessarily the one being served. A row in
 * `legal_document_revisions` supersedes all three, and `server/legalStore.js` is
 * the one place that decides. Read those three fields off this array only when
 * you specifically mean "as originally published"; everywhere else, resolve.
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
    /**
     * Re-pinned twice in this pass, both pre-launch corrections, so 1.0 stands.
     *
     * First for the appeals paragraph. §9 promised an appeal is "always"
     * reviewed by a different administrator; the Community Guidelines say the
     * software REFUSES a self-review and there is currently one administrator,
     * so the contract was the more-read document making a promise the
     * operational document says cannot be kept.
     *
     * Then for the acceptable-use review. §4 already covered scraping, bots,
     * probing and multi-accounting — it is where an Acceptable Use Policy would
     * have gone, which is why no separate one was written. What it did not cover
     * was rate-limit circumvention, deliberate disruption, exploiting a bug
     * rather than reporting it, or malware; "overload" was one word inside
     * another bullet. §4.1 states the automation policy, and §4.2 gives a
     * security report somewhere to go and a promise not to punish it — neither
     * existed anywhere in the set. §8's copyright paragraph became a procedure
     * with a counter-notice and a repeat-infringer consequence, and says
     * plainly that no agent is registered rather than implying a safe harbour
     * that has not been claimed.
     */
    contentHash: '1b836c654ef924490c420b1dbe1f4ff2f93abb90af8edaf19cfc01791c2a8514',
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
    /**
     * 1.0, like every other document, and it did not stay that way by itself.
     *
     * 386c9e9 took this to 1.1 when it added Upstash to the subprocessor table.
     * That is new sharing rather than a wording fix, so the bump was a
     * defensible reading of MAJOR/MINOR — but MAJOR/MINOR is not the rule that
     * applies yet. The one that does is two paragraphs up and in
     * docs/legal/policies/README.md: "Every document is at version 1.0, and
     * stays there until launch."
     *
     * The reasoning behind the reset decides this. A version number exists to
     * answer "what did this person agree to, and when", and nobody has agreed to
     * any version of this document — measured on the pilot database, which holds
     * one acceptance row in total and it belongs to the Organizer Agreement.
     * Shipping a Privacy Policy at 1.1 would tell the first real reader they are
     * looking at the second revision of a document whose first revision nobody
     * can produce, which is the exact misleading answer the collapse to 1.0 was
     * performed to avoid.
     *
     * The Upstash text itself is untouched and stays. It is correct and it is
     * the sort of thing a guardian should be able to read; what is wrong is
     * numbering it as a revision of something nobody was shown. Three sibling
     * documents were edited in the same week by 16a7a1d — the Terms, the Youth
     * Safety Guidelines and the Cookie Notice — and all three kept 1.0 and
     * 2026-08-06 for this reason. This was the only one that did not, and the
     * only document in the set carrying a version other than 1.0.
     *
     * `effectiveAt` returns to 2026-08-06 with it: the field is the date the
     * version takes effect, not the date of the last edit, which is why the
     * documents written later carry their own dates (08-13, 08-15, 08-22) and
     * the ones edited later do not move.
     *
     * `legalVersioning.test.js` now fails the build if any document leaves 1.0
     * while `LEGAL_HASHES_ENFORCED` describes a set nobody has accepted, so this
     * cannot drift back in quietly the next time a policy changes.
     */
    version: '1.0',
    title: 'Privacy Policy',
    consentType: 'acknowledge',
    scope: 'signup',
    summary: 'What we collect, why, who can see it, how long we keep it, and how to get it back or have it deleted.',
    effectiveAt: '2026-08-06',
    file: '01-privacy-policy.md',
    /* Re-pinned because the Auto Select disclosure was false. It said the draw
       uses "only" total credited hours; v1.3 added the attendance term, which
       the Volunteer Record Policy documents in full. This is the document a
       guardian reads about automated decision-making, so of the two it was the
       worse one to be wrong. Pre-launch correction, so 1.0 stands.

       Re-pinned once more on integration: this document also gained the
       Upstash subprocessor entry on another branch, so the published body
       now carries both edits and hashes to neither branch's value. Computed
       from the merged file with `hashPolicyFile`, which is what
       `legalContent.test.js` checks it against.

       And re-pinned a third time for one bullet in the guardian section.
       "We do not send a confirmation link to anybody, and nothing waits for an
       approval" was scoped to guardian consent by its own "Specifically:"
       lead-in and absolute when read alone — and the application does send
       links (verification, password reset, organization invitations) and does
       have approval workflows (event applications, and now organization
       join requests). The bullet now says "we do not send A GUARDIAN a
       confirmation link, and no part of your account waits for a guardian's
       approval", which is the same commitment without the broader claim.
       Pre-launch clarification of unpublished text, so 1.0 stands and
       `effectiveAt` is unchanged: nothing was revised, the draft was corrected.
       `legalContent.guardianScope.test.js` is what stops the absolute form
       coming back. */
    contentHash: '852d6369d484511f29aed6b7f72a4807ce327ced481b42200e2143c1b02f3b05',
    bundledWith: null,
  },
  {
    slug: 'organizer-agreement',
    version: '1.0',
    title: 'Organizer Agreement',
    consentType: 'agree',
    scope: 'organizer-onboarding',
    summary: 'The undertakings an organizer makes before receiving students\' contact details: protect it, use it only for the event, record attendance honestly.',
    effectiveAt: '2026-08-06',
    file: '09-organizer-agreement.md',
    contentHash: 'e3da0fe2e897651bb7e4254a428bebec636890775e5167203aa0bcd5057ae192',
    bundledWith: null,
  },
  {
    slug: 'student-organizer-agreement',
    version: '1.0',
    title: 'Student Organizer Agreement',
    consentType: 'agree',
    scope: 'student-organizer-onboarding',
    summary: 'What a student promoted to help run a club takes on: use what you can see to run the events, share it with nobody, credit hours honestly.',
    effectiveAt: '2026-08-13',
    file: '11-student-organizer-agreement.md',
    contentHash: '1e7d904c8096482437aaa3f8a66890b0844e751127d8f4766bfcdc9834026764',
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
    /* Re-pinned for the deletion deadline. Rule 6 said "when the event is over";
       the Organizer Agreement §5 — the document that actually binds an organizer
       — says within 30 days. This file already defers to §4 for the sharing
       rule, so it now defers to §5 here for the same reason rather than
       restating a deadline it does not own. Pre-launch correction, 1.0 stands. */
    contentHash: '9e624189f900a3b700f13777f43c676cdef341ba1b756415a5973bcc74a58f54',
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
    /* Re-pinned for the close-out sentence added under "If your certificate is
       wrong". The section told a student to ask the organizer and named no point
       after which that stops working, while `finalizeAttendance` has refused every
       correction on a closed-out event since 32e6880. Version left at 1.0 on the
       same grounds as the record policy below: `notice`, no acceptance collected,
       nothing published to a reader yet, so this is a correction before first
       publication. Decided during the 2026-09-21 audit (owner decision 1). */
    contentHash: '9484d1789dcf5869aaf83e22f673df3b96228033aad81ae486de6d80a351f012',
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
    /* Re-pinned again for the close-out section. The document predates close-out
       by three weeks (d79a984, 2026-08-05 vs 32e6880, 2026-08-26) and was never
       revisited, so "Who can change what" offered an administrator correction the
       software has always refused after close-out, and the disputes path named no
       end. Same reasoning as above for leaving the version at 1.0. Decided during
       the 2026-09-21 audit (owner decision 1).

       And again for "If an event is cancelled". That a cancelled event's hours
       stop counting has been true and enforced at ~30 call sites since b8cfb09,
       and was stated nowhere a reader could find it — while this document's
       stated purpose is to make the invariants "a promise to the user rather
       than an internal convention". Owner decision 4B needed it published before
       a notification could assert it. */
    contentHash: 'dba7b507659e65169ef8fdb961ac653f82dbbabea64716ac98bd5dec520eae70',
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
    contentHash: '2c930a316bc840c3d3b5b57bf0bad2d22c81f70ff7d98b7cca598afed58aa8b1',
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
    /* Re-pinned twice, both pre-launch corrections, so 1.0 stands.
       1. To remove a dangling clause: "Previous versions are kept at"
          introduced a URL that had been deleted, leaving the sentence spliced
          into the v1.0 paragraph mid-clause. 01 and 02 carry the same passage
          without it, so the clean form already existed.
       2. 2026-09-27 — the map section described tiles loading in the reader's
          browser directly from CARTO, which could therefore see their IP
          address and roughly which event they were looking at, and ended by
          saying we were considering serving the images ourselves. That work was
          done: `server/routes/tileRoutes.js` proxies every tile, and with
          MAP_TILES_CARTO_KEY unset the upstream is OpenStreetMap. The notice
          was describing a third-party exposure that no longer exists, which is
          the safe direction to be wrong in and still wrong. */
    contentHash: 'e88c163b85ce29e90d10a6742c379f6b48f13d7649a3928341ae23bbec104572',
    bundledWith: null,
  },
  {
    slug: 'admin-responsibilities-policy',
    version: '1.0',
    title: 'Admin Responsibilities Policy',
    /**
     * An AGREEMENT since 2026-09-27, not a notice.
     *
     * It was published as a notice, which meant it bound administrators in its
     * own words and nothing enforced it — the launch-checklist audit found both
     * owners holding every capability with zero acceptance rows. The Organizer
     * Agreement has withheld capabilities until acceptance since it shipped; the
     * document governing the MORE powerful role was the one with no gate.
     *
     * Only the registry metadata moves. `contentHash` is the sha256 of the
     * published body, which is untouched, so no existing acceptance is
     * invalidated and no repair migration is needed. The stored `consent_type`
     * on the published row stays 'notice' — `syncLegalDocuments` never rewrites
     * a published row — and nothing reads it for enforcement:
     * `hasAcceptedAdminResponsibilities` matches on `(slug, version)` in
     * `legal_acceptances`, exactly as the organizer gate does.
     */
    consentType: 'agree',
    scope: 'admin-onboarding',
    summary: 'What administrators may do, what is logged when they do it, and the limits on looking at a student\'s record.',
    effectiveAt: '2026-08-06',
    file: '10-admin-responsibilities-policy.md',
    contentHash: '63d42b5c1d4e41a0ffd3c8aa81c6b2972ad92b6351407ef058c390f79fb5e458',
    bundledWith: null,
  },
  {
    /**
     * `notice`, not `acknowledge`.
     *
     * The assistant is opt-in and off by default, and the enable screen states
     * what is downloaded and from whom before anybody agrees to anything. That
     * screen is where the decision is actually made, so collecting a second
     * acceptance here would record a consent nobody gave in this context — and
     * `scope: 'signup'` would put it in front of every student at registration
     * for a feature most will never switch on.
     */
    slug: 'ai-and-on-device-processing',
    /**
     * Back to 1.0, deliberately.
     *
     * This was briefly bumped to 2.0 because the document had gained a section
     * on dictation — audio sent to a browser vendor's speech service, which is
     * new sharing and therefore MAJOR by the test at the top of this file.
     *
     * That capability is no longer exposed. The control was withdrawn before
     * release: it is the only third-party audio path in a platform used by
     * minors, the vendor relationship has not been reviewed by anyone, and the
     * page cannot observe what is retained — a poor trade for a convenience,
     * given typing works and the questions are short. The section describing it
     * came out with it, because a policy that describes an unavailable feature
     * is inaccurate in the direction that matters least excusably.
     *
     * With the section gone the document says what 1.0 said, so 1.0 is what it
     * is. Nothing was invalidated by the round trip: this is a `notice`, no
     * acceptance is collected in any version, and the document has never been
     * deployed. A 2.0 sitting in the registry describing a capability nobody
     * can use would be the worse record.
     */
    version: '1.0',
    title: 'AI and On-Device Processing Policy',
    consentType: 'notice',
    scope: 'notice',
    summary: 'Where the optional assistant runs, what is downloaded and from whom, what stays on your device, and what it is not permitted to decide.',
    effectiveAt: '2026-08-15',
    file: '12-ai-and-on-device-processing.md',
    contentHash: '10239aee73d74a7d20bbe75489bd3e2d365319634fcf15798757b2313adbd924',
    bundledWith: null,
  },
  {
    slug: 'accessibility-statement',
    /**
     * `notice` / `notice`, and it matters which.
     *
     * This document grants nothing and asks for nothing: it states an
     * accessibility target, what was tested, what is known to be broken, and how
     * to report a barrier. `scope: 'signup'` would put a checkbox in front of
     * every new account and prompt every existing one to re-accept a document
     * that makes no demands of them — which is both pointless and the way people
     * learn to click through consent screens without reading them.
     *
     * It is also the document most likely to change often, because it names
     * current known limitations. A `notice` can be revised without invalidating
     * anybody's acceptance, which is the property that makes honest revision
     * cheap enough to actually do.
     */
    version: '1.0',
    title: 'Accessibility Statement',
    consentType: 'notice',
    scope: 'notice',
    summary: 'The accessibility standard WeVolunteer is built and tested against, what has actually been verified and how, what is known to be unfinished, and how to report a barrier.',
    effectiveAt: '2026-08-22',
    file: '13-accessibility-statement.md',
    contentHash: '8a2e2f8f9dda72b997e15270529320e63334bd020284672ef20e5ef728de8726',
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
 * What a student accepts before the Student Organizer rank does anything.
 *
 * ── Why a separate scope, and not a second document under the organizer one ──
 *
 * `ORGANIZER_DOCUMENTS` is read by `withheldCapabilitiesFor`, which withholds
 * from accounts whose role is `organizer`. Adding this document there would
 * start demanding it from every adult organizer — people it does not bind and
 * whose acceptance of it would be a false record — and would silently make the
 * adult agreement a precondition for a student rank.
 *
 * ── Why the two documents are separate at all ──
 *
 * The Organizer Agreement asks its reader to confirm things a student cannot
 * truthfully confirm: that they understand most students here are minors
 * (addressed to somebody who is not one), that New Jersey mandated-reporter law
 * binds them personally, and that at least two adults will be present at their
 * events. A record of undertakings the signer cannot perform is weaker evidence
 * than no record.
 *
 * The `-onboarding` suffix is deliberate, for the reason given above:
 * `'student-organizer'` alone reads as a role name, and this codebase fails the
 * build on authorization decisions made by comparing role strings.
 */
export const STUDENT_ORGANIZER_DOCUMENTS =
  LEGAL_DOCUMENTS.filter(d => d.scope === 'student-organizer-onboarding');

/**
 * The documents an administrator must accept before holding power over anyone.
 *
 * Derived by scope like its two siblings, so adding a second admin-facing
 * agreement later needs no change here or in the gate that reads it.
 */
export const ADMIN_DOCUMENTS = LEGAL_DOCUMENTS.filter(d => d.scope === 'admin-onboarding');

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
 * ── It is now on ──
 *
 * Flipped at the end of the release-candidate audit, once the thing it protects
 * existed. The audit is also the argument for it: three published documents had
 * drifted out of agreement with the application — the Cookie Notice promised no
 * analytics while an Amplitude SDK was bundled, and the Privacy Policy's
 * subprocessor table omitted the email provider that receives every message —
 * and advisory mode is precisely why nobody noticed. The server rewrote each
 * recorded hash to match the new text on every boot and said so in a log line
 * that reads like routine housekeeping.
 *
 * That was the correct trade while the documents were being drafted and there
 * were no acceptance rows to protect. It stops being correct the moment a real
 * student agrees to something.
 *
 * ── What this now costs, and it is the intended cost ──
 *
 * Editing a published policy is no longer an edit. It is: change the file, run
 * `node bin/legal-hashes.mjs`, paste the printed constant into LEGAL_DOCUMENTS,
 * and decide whether the change is MAJOR (re-acceptance) or MINOR (notice only)
 * by the rule above. A production server refuses to boot in between. That
 * friction is the feature — it is what makes a consent record mean something.
 *
 * To go back to advisory mode, set this to `false`. Do not do it to make a typo
 * fix easier; do it only if the documents genuinely re-enter drafting and the
 * acceptance rows are known to be disposable.
 */
export const LEGAL_HASHES_ENFORCED = true;

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
