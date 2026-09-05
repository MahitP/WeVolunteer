import { LEGAL_DOCUMENTS } from './legalDocuments.js';
import { compareVersions, legalDay, parseVersion } from './legalStore.js';
import { tableExists } from './db/dialectSql.js';

/**
 * How serious a legal-document change is, and what the platform does about it.
 *
 * ── Why this is one module and not a condition at each surface ──
 *
 * There are three places that need the answer to "has this document changed for
 * this person, and does it matter": the banner, the mandatory acceptance modal,
 * and the capability gate that makes the modal non-optional. If each decided for
 * itself, the interesting failure is not that they disagree — it is the specific
 * way they would: one showing an ordinary "we updated a document" notice for a
 * change the other is withholding capabilities over. The user would be told a
 * change was routine while the platform treated it as material, which is worse
 * than either behaviour on its own.
 *
 * So the rule lives here once, as pure functions over (document, version the
 * user last saw, today), and the three callers route on the answer.
 *
 * ── The rule is not invented here; it is published ──
 *
 * §13 of the Terms of Service says, in the product's own words:
 *
 *     "A change that leaves you worse off — new collection, new sharing, a right
 *      taken away, a longer retention period — gets a new major version and we
 *      ask you to accept it again. A clarification gets a minor version and
 *      notice only."
 *
 * And above it: "If a change matters, we will tell you in the app at least
 * **30 days** before it takes effect."
 *
 * Those two sentences fix the whole design:
 *
 *   MAJOR bump  → the user is asked to accept again.
 *   MINOR/PATCH → notice only.
 *   Either way  → the notice comes first, and the obligation attaches on the
 *                 date the version takes effect, not the day it was published.
 *
 * The MAJOR/MINOR distinction is therefore a decision an owner makes when they
 * choose a version number in the Legal Center, which is exactly where the
 * judgement belongs — a human reading the change against the test at the top of
 * `legalDocuments.js`. Nothing here tries to infer materiality from the text. A
 * heuristic over a diff would be a machine deciding whether a legal change
 * disadvantages a reader, and it would be wrong in the direction that matters:
 * "we do not sell your data" becoming "we may sell your data" is one word.
 *
 * ── Why `effective_at` gates the ENFORCEMENT and not the TEXT ──
 *
 * `legalStore.js`'s EFFECTIVE_DATE_MODEL note is emphatic that publication is
 * immediate and that `effective_at` is "a RECORDED LEGAL FACT, not an
 * instruction to the software". That stays true: which text is served is still
 * decided by insertion order, and a future-dated revision is public the moment
 * it is saved.
 *
 * What this module adds is narrower, and it is the only reading under which the
 * 30-day promise is implementable at all: the date on which the platform starts
 * REQUIRING the new acceptance is the date the document itself says it takes
 * effect. Between publication and that date the change is announced — the
 * ordinary banner, saying what is changing and when — and nobody is blocked.
 * From that date the acceptance is required.
 *
 * The alternative is to require acceptance the instant a major version is
 * published, which would make the product break its own published promise every
 * time an owner used the feature correctly.
 */

/* ────────────────────────────────────────────────────────────────────────────
   Severity
   ──────────────────────────────────────────────────────────────────────────── */

/** A change a reasonable reader of the old version would be worse off under. */
export const MATERIAL = 'material';
/** A clarification: the version moved, the meaning did not. */
export const MINOR = 'minor';

/**
 * MAJOR moved, or it did not.
 *
 * ── An unreadable version is treated as MINOR, on purpose ──
 *
 * `parseNewVersion` refuses anything that is not `MAJOR.MINOR.PATCH` on the way
 * in and `parseVersion` reads the registry's two-component numbers, so both
 * sides of this comparison are parseable for every row the application can
 * write. A version that will not parse can therefore only come from a row
 * somebody put in the database by hand.
 *
 * The two failure directions are not symmetric. Guessing MATERIAL on an
 * unreadable version withholds capabilities from a real student because of a
 * malformed string — they lose the ability to sign up for a shift and the only
 * way out is a modal offering them a document that may not have changed
 * materially at all. Guessing MINOR still tells them the document moved and
 * still links them to it; what is lost is a re-acceptance record.
 *
 * The second is recoverable and the first is a lockout, so the fallback is
 * MINOR and it is loud in the log rather than silent.
 */
export function changeSeverity(seenVersion, currentVersion) {
  const seen = parseVersion(seenVersion);
  const current = parseVersion(currentVersion);

  if (!seen || !current) {
    console.warn(
      `[legal] cannot compare versions ("${seenVersion}" → "${currentVersion}"), `
      + 'so the change is treated as a clarification and notice only. '
      + 'One of these is not MAJOR.MINOR[.PATCH] and was not written by this application.'
    );
    return MINOR;
  }

  return current.major > seen.major ? MATERIAL : MINOR;
}

/* ────────────────────────────────────────────────────────────────────────────
   Which surface owns a change
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * Documents every account agrees to or acknowledges at registration.
 *
 * `scope`, not `consentType`, for the reason `SIGNUP_DOCUMENTS` gives: the
 * Organizer Agreement is also `consentType: 'agree'` and is not a signup
 * document, and conflating the two is how it would acquire a second, competing
 * re-acceptance flow.
 */
const SIGNUP_SCOPE = 'signup';

/**
 * Scopes that already have their own dedicated re-acceptance screen.
 *
 * `hasAcceptedOrganizerAgreement` and its student-organizer twin match on
 * `(slug, version)`, so ANY version bump — major or minor — already withholds
 * the gated capabilities and sends the holder to `/organizer-agreement` or
 * `/student-organizer-agreement`, which renders the full text with its
 * itemised undertakings.
 *
 * That is a better flow than anything a banner or a generic modal could offer,
 * and it is already enforced. So these documents are removed from this
 * subsystem entirely rather than being given a second surface. An organizer who
 * saw "Organizer Agreement updated — View document" and then hit a wall of seven
 * checkboxes has been told the same thing twice, the second time with more
 * authority, which teaches them the first notice was noise.
 */
const AGREEMENT_SCOPES = new Set(['organizer-onboarding', 'student-organizer-onboarding']);

/** An existing dedicated agreement screen owns this change; say nothing here. */
export const CHANNEL_AGREEMENT = 'agreement';
/** Mandatory: the account must accept the new version before continuing. */
export const CHANNEL_ACCEPTANCE = 'acceptance';
/** Ordinary: tell them, link them to it, let them get on with their day. */
export const CHANNEL_NOTICE = 'notice';

/**
 * Which of the three surfaces should carry this change, for this reader.
 *
 * Pure, and the single reason there is exactly one notification per document
 * per reader. `legalNotices.js` calls it to label each pending change;
 * `signupConsentWithholdingsFor` below calls it to decide what to withhold. Two
 * callers, one answer, so the banner cannot describe as routine a change the
 * gate is enforcing.
 *
 * @param {{slug: string, scope: string, effectiveAt: string|null, version: string}} doc
 *   a document already RESOLVED by `legalStore` — the version and effective date
 *   have to be the ones actually in effect, not the registry's
 * @param {string} seenVersion the newest version this account has accepted or
 *   acknowledged
 * @param {string} today `YYYY-MM-DD`, from `legalDay`
 */
export function noticeChannelFor(doc, seenVersion, today) {
  if (AGREEMENT_SCOPES.has(doc.scope)) return CHANNEL_AGREEMENT;

  if (
    doc.scope === SIGNUP_SCOPE
    && changeSeverity(seenVersion, doc.version) === MATERIAL
    && inEffect(doc.effectiveAt, today)
  ) {
    return CHANNEL_ACCEPTANCE;
  }

  return CHANNEL_NOTICE;
}

/**
 * Whether a version's own effective date has arrived.
 *
 * A missing date means the document has never carried one, which no registered
 * document does — every entry has an `effectiveAt` and
 * `legalVersioning.test.js` fails the build on one that does not. Treated as in
 * effect rather than as pending, because "we cannot tell when this took effect"
 * must not become "so it never does", which would silently disable the gate for
 * the one document whose metadata was broken.
 */
function inEffect(effectiveAt, today) {
  if (!effectiveAt) return true;
  return String(effectiveAt).slice(0, 10) <= today;
}

/**
 * The newest version an account has been shown, across both records of it.
 *
 * ── Why MAXIMUM and not "whichever row came back last" ──
 *
 * This replaced `acknowledged.get(slug) ?? accepted.get(slug)`, which was wrong
 * in three ways that all produce the same symptom — a notice that will not go
 * away, or one that never appears:
 *
 *   1. `legal_change_notices` holds ONE ROW PER VERSION by design, so a reader
 *      who dismissed 1.1 and then 1.2 has two rows. Building the map by
 *      iterating and overwriting took whichever the database happened to return
 *      last, with no ORDER BY anywhere. Dismissing the newer notice could leave
 *      the older version recorded as "what they last saw", and the notice for
 *      1.2 would come back on the next page load, for ever.
 *
 *   2. Acknowledgement took precedence over acceptance unconditionally. So a
 *      reader who dismissed the banner for 1.1 and then ACCEPTED 2.0 was still
 *      recorded as having last seen 1.1 — the stronger act was ignored in favour
 *      of the weaker one, and the mandatory modal would reopen after they had
 *      already accepted.
 *
 *   3. Version skips. Somebody away for a term comes back to 1.3 having last
 *      seen 1.0; the answer has to be "1.0", not "some row".
 *
 * A maximum by `compareVersions` is the only answer that is stable regardless of
 * row order, respects the stronger record, and survives skipped versions.
 *
 * Unparseable versions are ignored rather than allowed to throw: `compareVersions`
 * raises on one, and a single hand-written row must not be able to take down the
 * request that renders the application shell.
 */
/**
 * Whether `seen` is genuinely older than `current`.
 *
 * ── Why not `seen !== current` ──
 *
 * That is what this was, and it answers a slightly different question:
 * "different from" rather than "behind". The two coincide for every state
 * `publishRevision` can produce, because `legal_document_revisions` is
 * append-only and every version it accepts is strictly greater than the last —
 * so an account's recorded version can never overtake the effective one.
 *
 * They stop coinciding the moment anything reaches the table by another route:
 * a revision removed by hand, a database restored from a backup taken before a
 * publish, a scratch database seeded out of order. Then an account holding an
 * acceptance of 2.0.0 against a document now serving 1.0 is reported as BEHIND
 * on a change that has not happened, which under the acceptance channel means a
 * dialog demanding agreement to a version older than the one already agreed to.
 *
 * Found while setting up browser fixtures, where deleting a revision left
 * exactly that state. Not reachable through the application, which is precisely
 * why it is worth an ordering comparison rather than an equality test: the
 * cases that produce it are the operational ones nobody is watching.
 *
 * Falls back to inequality when either side will not parse, which preserves
 * the old behaviour for a hand-written version rather than silently reporting
 * "not behind" for anything malformed.
 */
export function isBehind(seen, current) {
  if (!parseVersion(seen) || !parseVersion(current)) return seen !== current;
  return compareVersions(seen, current) < 0;
}

export function newestSeenVersion(versions) {
  let best = null;
  for (const candidate of versions) {
    if (typeof candidate !== 'string' || !parseVersion(candidate)) continue;
    if (best === null || compareVersions(candidate, best) > 0) best = candidate;
  }
  return best;
}

/* ────────────────────────────────────────────────────────────────────────────
   Enforcement
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * What is withheld from an account that owes a re-acceptance.
 *
 * ── Why anything is withheld at all ──
 *
 * A modal is a client. A client can be edited, and the account holder is the
 * one person with every incentive and every opportunity to edit it. If the modal
 * were the whole mechanism then "you must accept the updated terms to continue"
 * would be a sentence the product says rather than a rule it keeps, and the
 * acceptance record for the population that skipped it would be missing exactly
 * where it matters.
 *
 * So the gate is derived per request from the acceptance rows, in the same place
 * and by the same mechanism as the Organizer Agreement's — see
 * `withheldCapabilitiesFor`. The modal is not the enforcement; it is the only
 * way out of the gated state.
 *
 * ── Why this list and not "everything" ──
 *
 * Withholding everything is a lockout, and a lockout has three specific costs
 * that each argue for a named capability out of the list:
 *
 *   • READING has to keep working. Somebody deciding whether to accept a new
 *     Privacy Policy needs to read it, see what they have already agreed to, and
 *     look at their own record. `event.view`, `self.read`, `directory.read` and
 *     `stats.self` stay.
 *
 *   • LEAVING has to keep working. §13 says "you can close your account if you
 *     do not agree", so the export-and-delete path has to survive the gate that
 *     exists to enforce §13. `self.write` stays for that reason and no other.
 *
 *   • OTHER PEOPLE must not pay for it. An organizer standing at a check-in desk
 *     is recording hours a student has already earned; a moderator resolving a
 *     safety report is protecting somebody who is not party to this. Withholding
 *     `attendance.mark`, `attendance.scan`, `attendance.view`, `qr.present`,
 *     `report.resolve`, `appeal.review`, `user.warn` or `user.suspend` would
 *     make an unaccepted policy into a safety incident. They stay.
 *
 *   • And `legal.edit` stays, which is the one that would otherwise be
 *     unrecoverable: the owner who publishes a MAJOR revision by mistake is the
 *     first person the gate catches, and taking the editor away from them would
 *     leave nobody on the platform able to publish the correction.
 *
 * What is left is participation — the acts that create new obligations between
 * this account and other people, which is precisely what the terms govern.
 */
export const SIGNUP_CONSENT_GATED_CAPABILITIES = Object.freeze([
  /* Volunteering. The core act the Terms describe. */
  'event.apply',
  'application.withdraw',
  /* Running things. */
  'event.create',
  'event.edit.own',
  'announcement.post',
  /* Talking to people. */
  'message.send',
  'relationship.manage',
  /* Organizations, including the helper capabilities granted per person. */
  'organization.create',
  'organization.join',
  'organization.manage.own',
  'organization.post.create',
  'organization.post.manage',
  'organization.event.create',
  'organization.event.manage.own',
  /* Adding to the record: external hours, portfolio entries, uploads. */
  'portfolio.write',
  /* The assistant, which answers questions about the product using the account's
     own data — a processing activity the Privacy Policy is what discloses. */
  'assistant.use',
]);

/**
 * True once, cached for the process: the revisions table exists.
 *
 * `tableExists` is a query, and this runs inside `buildPrincipal` — on every
 * authenticated request. The answer can only change in one direction (migration
 * 34 creates the table and nothing drops it), so a false is worth re-asking and
 * a true never is.
 */
let revisionsTableSeen = false;

/** Test seam: module state must not leak between suites. See `__resetModalStack`. */
export function __resetGateCache() {
  revisionsTableSeen = false;
}

/**
 * The versions of signup documents that have been superseded by a revision.
 *
 * ── One query, and usually zero rows ──
 *
 * This is the fast path, and it is the reason the gate is affordable on a hot
 * request path. Signup documents ship at the registry's version and stay there
 * until an owner publishes through the Legal Center, which is a rare and
 * deliberate act. With no revision row for any signup document, NOBODY can be
 * behind on one: an acceptance is written at the version resolved at signup, and
 * the registry's version does not move at runtime.
 *
 * So the common answer is an empty map from a single indexed lookup, and the
 * per-user acceptance query is never issued at all.
 */
async function revisedSignupDocuments(db) {
  if (!revisionsTableSeen) {
    if (!await tableExists(db, 'legal_document_revisions')) return new Map();
    revisionsTableSeen = true;
  }

  const slugs = LEGAL_DOCUMENTS.filter(d => d.scope === SIGNUP_SCOPE).map(d => d.slug);
  if (slugs.length === 0) return new Map();

  /**
   * Newest row per slug, by id.
   *
   * `MAX(id)` and not `MAX(version)`, for the reason `currentRevision` gives:
   * SQLite compares version strings lexicographically and would rank '1.9.0'
   * above '1.10.0'. Insertion order is correct by construction because
   * `publishRevision` refuses any version that is not strictly greater than
   * every version already recorded.
   */
  const placeholders = slugs.map(() => '?').join(', ');
  const rows = await db.prepare(`
    SELECT r.slug, r.version, r.effective_at
    FROM legal_document_revisions r
    JOIN (
      SELECT slug, MAX(id) AS id FROM legal_document_revisions
      WHERE slug IN (${placeholders}) GROUP BY slug
    ) newest ON newest.slug = r.slug AND newest.id = r.id
  `).all(...slugs);

  return new Map(rows.map(r => [r.slug, { version: r.version, effectiveAt: r.effective_at }]));
}

/**
 * Signup documents this account owes an acceptance on, right now.
 *
 * Returns registry entries merged with the resolved version and effective date,
 * so a caller can name the document and the version without resolving again.
 * Empty for the overwhelming majority of requests, and cheap to establish so —
 * see `revisedSignupDocuments`.
 *
 * ── An account with no acceptance row is not behind ──
 *
 * The same rule `pendingNoticesFor` applies, and for the same reason: an absent
 * acceptance means the account predates the consent record (every seeded
 * account, and every account created before `legalDocuments.js` existed) or its
 * scope changed. There is no previous version they were shown, so there is
 * nothing they can be asked to re-accept — and treating absence as "behind"
 * would gate every seeded and legacy account out of the product on the first
 * major revision, which is a data-migration problem wearing a consent gate's
 * clothes.
 */
export async function pendingSignupAcceptances(db, userId, { now = new Date() } = {}) {
  if (!userId) return [];

  const revised = await revisedSignupDocuments(db);
  if (revised.size === 0) return [];

  const seenBySlug = new Map();
  for (const row of await db.prepare(
    'SELECT document_slug AS slug, version FROM legal_acceptances WHERE user_id = ?'
  ).all(userId)) {
    const list = seenBySlug.get(row.slug) ?? [];
    list.push(row.version);
    seenBySlug.set(row.slug, list);
  }

  const today = legalDay(now);
  const owed = [];

  for (const registered of LEGAL_DOCUMENTS) {
    const current = revised.get(registered.slug);
    if (!current) continue;

    /**
     * Acceptances only — acknowledgements are deliberately not consulted here.
     *
     * `pendingNoticesFor` reads both, because its question is "has this person
     * been TOLD". This question is "has this person AGREED", and dismissing a
     * banner is not agreement. Letting an acknowledgement satisfy this gate is
     * the exact defect `migration 039` was written to make impossible: a
     * dismissed popup becoming evidence of consent.
     */
    const seen = newestSeenVersion(seenBySlug.get(registered.slug) ?? []);
    if (!seen) continue;
    if (!isBehind(seen, current.version)) continue;

    const doc = { ...registered, version: current.version, effectiveAt: current.effectiveAt };
    if (noticeChannelFor(doc, seen, today) !== CHANNEL_ACCEPTANCE) continue;

    owed.push({ ...doc, previousVersion: seen });
  }

  return owed;
}

/**
 * The signup-consent arm of `withheldCapabilitiesFor`.
 *
 * ── Why no role is exempt ──
 *
 * The organizer arm returns `[]` for admins because the Organizer Agreement does
 * not bind them. The Terms of Service, the Privacy Policy and the Community
 * Guidelines bind every account on the platform including the owner's, so an
 * exemption here would be an exemption from the thing itself.
 *
 * That is safe to say only because of what is NOT in the gated list: no
 * administrative capability is withheld, `legal.edit` least of all, so an owner
 * who publishes a major revision keeps every power they need to correct it and
 * loses only the ability to volunteer and post while they have not accepted it.
 *
 * ── `actualRole` is not consulted, and that is not an omission ──
 *
 * The organizer arm reads it to keep an admin previewing as an organizer from
 * being gated by that organizer's missing acceptance. Here the question is about
 * the acceptance rows of the account making the request, which a preview does
 * not change, so there is no role to compare.
 */
export async function signupConsentWithholdingsFor(db, userRow) {
  if (!userRow?.id) return [];

  const owed = await pendingSignupAcceptances(db, userRow.id);
  return owed.length === 0 ? [] : [...SIGNUP_CONSENT_GATED_CAPABILITIES];
}
