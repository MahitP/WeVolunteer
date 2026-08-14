import { CAPABILITIES } from './authz.js';
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
 * Whether this user has accepted every current Student Organizer document.
 *
 * Matched on `(slug, version)` against the RESOLVED version, for the same reason
 * `hasAcceptedOrganizerAgreement` does: the registry's version is computed once
 * at module load, so an owner republishing this document through the Legal
 * Center would otherwise keep the gate measuring against the version that
 * shipped. A reader shown 1.1 and measured against 1.0 accepts something that
 * does not clear their block.
 */
export function hasAcceptedStudentOrganizerAgreement(db, userId) {
  if (STUDENT_ORGANIZER_DOCUMENTS.length === 0) return true;

  const accepted = new Set(
    db.prepare('SELECT document_slug, version FROM legal_acceptances WHERE user_id = ?')
      .all(userId)
      .map(r => `${r.document_slug}@${r.version}`)
  );

  return STUDENT_ORGANIZER_DOCUMENTS.every((registered) => {
    const doc = resolveDocument(db, registered) ?? registered;
    return accepted.has(`${doc.slug}@${doc.version}`);
  });
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
export function studentOrganizerWithholdingsFor(db, userRow) {
  if (!userRow) return [];
  if (!helpsRunAnywhere(db, userRow.id)) return [];
  if (hasAcceptedStudentOrganizerAgreement(db, userRow.id)) return [];

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
export function acceptStudentOrganizerAgreement(db, { userId, req = null, now = null }) {
  if (hasAcceptedStudentOrganizerAgreement(db, userId)) {
    return { recorded: 0, already: true };
  }

  db.exec('BEGIN');
  try {
    const recorded = recordAcceptances(db, {
      userId,
      method: 'student_organizer_agreement',
      context: 'student-organizer-onboarding',
      documents: STUDENT_ORGANIZER_DOCUMENTS,
      req,
      now,
    });
    db.exec('COMMIT');
    return { recorded, already: false };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
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
export function studentOrganizerAgreementStatus(db, userRow) {
  return {
    required: helpsRunAnywhere(db, userRow.id),
    accepted: hasAcceptedStudentOrganizerAgreement(db, userRow.id),
    documents: STUDENT_ORGANIZER_DOCUMENTS.map((registered) => {
      const d = resolveDocument(db, registered) ?? registered;
      return { slug: d.slug, title: d.title, version: d.version, effectiveAt: d.effectiveAt };
    }),
    withheld: studentOrganizerWithholdingsFor(db, userRow),
  };
}
