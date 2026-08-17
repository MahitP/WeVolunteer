import { CAPABILITIES, ROLE } from './authz.js';
import { runInTransaction } from './db/connectionContext.js';
import { transactionOn } from './db/connectionContext.js';
import { STUDENT_ORGANIZER_DOCUMENTS } from './legalDocuments.js';
import { recordAcceptances } from './consent.js';
import { resolveDocument } from './legalStore.js';
import { STUDENT_ORGANIZER_CAPABILITIES, helpsRunAnywhere } from './organizationRoles.js';

/**
 * The Student Organizer Agreement, and what the rank cannot do until it is
 * accepted.
 *
 * ── The gap this closes ──
 *
 * A Student Organizer sees the people who apply to their club's events: names,
 * usernames, grade, school, whether they turned up, and the hours credited to
 * them. They are handed that by another student — a club manager — and until
 * now nothing recorded that they had ever undertaken anything about handling it.
 *
 * The Organizer Agreement does not reach them. `withheldCapabilitiesFor` in
 * `organizerAgreement.js` applies to accounts whose role is `organizer`, and a
 * Student Organizer is a `student`. That was noted as accepted debt when the
 * rank shipped; this closes it.
 *
 * ── Why a second agreement rather than extending the first ──
 *
 * The Organizer Agreement asks its reader to confirm three things a student
 * cannot truthfully confirm: that they understand most students here are minors
 * (addressed to somebody who is not one), that New Jersey mandated-reporter law
 * binds them personally, and that at least two adults will be present at their
 * events. An acceptance record of undertakings the signer cannot perform is
 * weaker evidence than no record at all — it is the one thing that would be read
 * out in a dispute, and it would not survive being read.
 *
 * ── Promotion grants; acceptance releases ──
 *
 * The four capabilities are written to `user_capabilities` when a manager
 * promotes somebody (`syncOrganizerCapabilities`), and withheld here until an
 * acceptance row exists. Deliberately not the other way round — granting on
 * acceptance would mean the promotion had no effect anybody could see, and the
 * demotion path would have to hunt for capabilities that may or may not exist.
 * Grant on the rank, release on the undertaking, and the acceptance record stays
 * the single source of truth for whether the undertaking was made.
 */

/**
 * Roles bound by a different instrument, and therefore never by this one.
 *
 * Named as a set rather than tested inline, because `authz.completeness.test.js`
 * fails the build on an authorization decision written as a comparison against a
 * quoted role literal — and this is one.
 */
const ROLES_BOUND_ELSEWHERE = new Set([ROLE.ORGANIZER, ROLE.ADMIN, ROLE.SUPER_ADMIN]);

/**
 * Whether this user has accepted every current Student Organizer document.
 *
 * Matched on `(slug, version)` against the RESOLVED version, for the same reason
 * `hasAcceptedOrganizerAgreement` does: the registry's version is computed once
 * at module load, so an owner republishing this document through the Legal
 * Center would otherwise keep the gate measuring against the version that
 * shipped. A reader shown 1.1 and measured against 1.0 accepts something that
 * does not clear their block.
 */
export async function hasAcceptedStudentOrganizerAgreement(db, userId) {
  if (STUDENT_ORGANIZER_DOCUMENTS.length === 0) return true;

  const accepted = new Set(
    (await db.prepare('SELECT document_slug, version FROM legal_acceptances WHERE user_id = ?')
      .all(userId))
      .map(r => `${r.document_slug}@${r.version}`)
  );

  /* A loop, not `.every`: the resolver is async, and `.every` does not await —
     it would see a truthy promise for every document and report the agreement
     as accepted by somebody who never accepted it. */
  for (const registered of STUDENT_ORGANIZER_DOCUMENTS) {
    const doc = await resolveDocument(db, registered) ?? registered;
    if (!accepted.has(`${doc.slug}@${doc.version}`)) return false;
  }
  return true;
}

/**
 * What to withhold from this principal on account of the Student Organizer
 * Agreement, as a plain array.
 *
 * Returns `[]` for anybody who does not hold the rank anywhere: withholding from
 * an ordinary student would be a no-op costing a query per request, since they
 * hold none of these capabilities to begin with.
 *
 * ── Why the role's own capabilities are subtracted ──
 *
 * `organizer` and `admin` hold some or all of the four from their ROLE, not from
 * a grant. An adult organizer who is also seated as a Student Organizer in some
 * club must not lose the capabilities their own role gives them because they
 * have not accepted a document written for students — they are bound by the
 * Organizer Agreement instead, which withholds the same four already.
 *
 * So this withholds only what the rank actually added.
 */
export async function studentOrganizerWithholdingsFor(db, userRow) {
  if (!userRow) return [];

  /**
   * Only the roles this document actually binds.
   *
   * ── The lockout this closes ──
   *
   * The first version subtracted `CAPABILITIES[role]` and withheld the rest,
   * which read sensibly and was wrong at both ends. `super_admin` holds `'*'`
   * — a wildcard, not the four literals — so the subtraction removed nothing
   * and all four were withheld from the platform owner. `can()` tests
   * `withheld` BEFORE the wildcard, deliberately, so the owner created an
   * organization, was seated as its manager, and was immediately refused
   * posting to their own club and told to accept an agreement that opens "you
   * are a student who has been asked to help run a club". An administrator
   * seated in a club got the same in part.
   *
   * ── The rule instead ──
   *
   * Every account is bound by exactly one instrument. Organizers have the
   * Organizer Agreement, which withholds these same four already. Administrators
   * and the owner have the Admin Responsibilities Policy. This document is for
   * everybody else — which is the students it was written for, and a `partner`
   * account that somehow held the rank.
   *
   * A student MANAGER is still bound, and that is the point: their role gives
   * them nothing, so they hold all four by grant exactly as a helper does.
   */
  if (ROLES_BOUND_ELSEWHERE.has(userRow.role)) return [];

  if (!await helpsRunAnywhere(db, userRow.id)) return [];
  if (await hasAcceptedStudentOrganizerAgreement(db, userRow.id)) return [];

  /* Whatever the role does NOT already give them — belt and braces under the
     role test above, so a future role list that gains one of the four cannot
     have it withheld against a document that does not bind its holder. */
  const fromRole = new Set(CAPABILITIES[userRow.role] || []);
  return STUDENT_ORGANIZER_CAPABILITIES.filter(c => !fromRole.has(c));
}

/**
 * Records acceptance, transactionally.
 *
 * The transaction is opened here rather than through `utils.js`'s
 * `inTransaction` for the reason `acceptOrganizerAgreement` gives: that helper
 * closes over the module-level connection, and this module takes `db` as an
 * argument so it can be driven against a throwaway handle.
 *
 * Idempotent by returning `already` rather than writing a second set of rows.
 * "When did this person accept v1.0" must have one answer.
 */
export async function acceptStudentOrganizerAgreement(db, { userId, req = null, now = null }) {
  if (await hasAcceptedStudentOrganizerAgreement(db, userId)) {
    return { recorded: 0, already: true };
  }

  /* `transactionOn` rather than `db.exec('BEGIN')`, for the reason set out in
     organizerAgreement.js: BEGIN on a pooled handle starts a transaction on one
     client while the writes inside land on others, so the acceptance rows stop
     being atomic and the rollback discards nothing — silently. The handle is
     still a parameter, so this module remains drivable against a throwaway
     database in a test. */
  return runInTransaction(db, async (tx) => {
    const recorded = await recordAcceptances(tx, {
      userId,
      method: 'student_organizer_agreement',
      context: 'student-organizer-onboarding',
      documents: STUDENT_ORGANIZER_DOCUMENTS,
      req,
      now,
    });
    return { recorded, already: false };
  });
}

/**
 * The document to accept, and the state of this person's acceptance.
 *
 * `required` is "you hold the rank somewhere", not "you are a student": an
 * ordinary member is told `required: false` rather than refused, because the
 * client asks this on load to decide whether to show the prompt and an error
 * would make "nothing to accept" indistinguishable from "the request failed".
 *
 * `withheld` comes from the same function `can()` is fed, so this endpoint and
 * the gate cannot disagree about what is currently being withheld.
 */
export async function studentOrganizerAgreementStatus(db, userRow) {
  return {
    /* "Are you asked to accept this", which is not the same as "do you help run
       a club": an organizer or an administrator who does is bound by their own
       instrument instead, and telling them otherwise is what produced a screen
       inviting the platform owner to sign a student's agreement. */
    required: !ROLES_BOUND_ELSEWHERE.has(userRow.role) && await helpsRunAnywhere(db, userRow.id),
    accepted: await hasAcceptedStudentOrganizerAgreement(db, userRow.id),
    documents: await Promise.all(STUDENT_ORGANIZER_DOCUMENTS.map(async (registered) => {
      const d = await resolveDocument(db, registered) ?? registered;
      return { slug: d.slug, title: d.title, version: d.version, effectiveAt: d.effectiveAt };
    })),
    withheld: await studentOrganizerWithholdingsFor(db, userRow),
  };
}
