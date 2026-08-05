import { ROLE } from './authz.js';
import { ORGANIZER_DOCUMENTS } from './legalDocuments.js';
import { recordAcceptances } from './consent.js';

/**
 * The Organizer Agreement, and what an organizer cannot do until they accept it.
 *
 * ── The gap this closes ──
 *
 * An organizer sees the students who applied to their event: names, email
 * addresses, grades, attendance. The Organizer Agreement is the undertaking they
 * make about handling that — protect it, use it only for the event, record
 * attendance honestly, never repurpose the contact details.
 *
 * Nothing recorded whether they had ever made it. An admin clicked approve, the
 * role's capabilities arrived, and adults held minors' contact details under no
 * recorded obligation. The document existed; it bound nobody. This was the oldest
 * open RED finding in the compliance register (R-04).
 *
 * ── Approval and acceptance are two different acts, by two different people ──
 *
 * The important design point. An admin approving an organizer is the platform
 * saying "we believe this person is who they say they are". The organizer
 * accepting the agreement is that person saying "I accept these obligations".
 *
 * One cannot stand in for the other, and it is specifically the second that a
 * dispute turns on. So approval no longer grants the capabilities by itself:
 * approval makes acceptance possible, and acceptance completes it.
 *
 * ── Why capabilities are withheld rather than the role changed ──
 *
 * The obvious implementation is to leave the account as a student until they
 * accept. That is wrong in a way that matters: it would hand an adult the
 * STUDENT capability set — `event.apply`, `portfolio.write`, `stats.self` — so
 * failing to accept an agreement would make an adult look like a minor to every
 * part of the system that scopes on role, including the messaging rules.
 *
 * Withholding is subtractive and cannot do that. The account stays an organizer;
 * it simply holds none of the capabilities that reach a student until the
 * undertaking is on record.
 */

/**
 * The capabilities an organizer does not hold until the agreement is accepted.
 *
 * Chosen by asking one question of each: does it reach a student, their
 * information, or their record? Everything that does is withheld.
 *
 * What is deliberately NOT withheld is as considered as what is. `event.view`,
 * `self.read`, `self.write` and `geocode.use` remain, because the organizer has
 * to be able to sign in, reach their own settings, read the agreement and accept
 * it. Withholding those would produce an account that cannot perform the one
 * action that would fix it — which is how a consent requirement becomes a
 * lockout, and a lockout is what makes people click through without reading.
 */
export const ORGANIZER_GATED_CAPABILITIES = Object.freeze([
  // Creating and running events — an event is what produces applicants.
  'event.create',
  'event.edit.own',
  // Seeing who applied, and their details. The heart of R-04.
  'applicant.review',
  // Rosters, check-in, and the hours record.
  'attendance.mark',
  'attendance.view',
  'attendance.scan',
  'service.verify.own_event',
  // Reaching a student directly, or broadcasting to all of them.
  'announcement.post',
  'message.send',
  // Aggregates over their events, which are aggregates over students.
  'analytics.own_events',
]);

/**
 * Whether this user has accepted every current organizer document.
 *
 * Matches on `(slug, version)` and not on the slug alone. An acceptance of v1.0
 * is not an acceptance of v2.0 — that is the entire reason the registry records a
 * version — so a version bump correctly withholds the capabilities again until
 * the new text is accepted.
 *
 * Takes `db` rather than importing it, so this is testable against a throwaway
 * handle and so the module stays importable without opening a database.
 */
export function hasAcceptedOrganizerAgreement(db, userId) {
  if (ORGANIZER_DOCUMENTS.length === 0) return true;

  const accepted = new Set(
    db.prepare('SELECT document_slug, version FROM legal_acceptances WHERE user_id = ?')
      .all(userId)
      .map(r => `${r.document_slug}@${r.version}`)
  );

  return ORGANIZER_DOCUMENTS.every(d => accepted.has(`${d.slug}@${d.version}`));
}

/**
 * What to withhold from this principal, as a plain array.
 *
 * Pure and role-aware in one place, so `authz.js` stays free of both the database
 * and this policy. Returns `[]` for everyone who is not an organizer:
 *
 *   - Students never held these capabilities, so withholding is a no-op that
 *     would only cost a query per request.
 *   - Admins and super_admins are covered by the Admin Responsibilities Policy
 *     rather than the Organizer Agreement, and withholding from the operator
 *     would be a way to lock the platform owner out of their own instance.
 *
 * `actualRole`, not `effectiveRole`: an admin impersonating an organizer (v2.0,
 * behind its own policy) must not acquire that organizer's ungated capabilities,
 * and must not be gated by that organizer's missing acceptance either. The
 * question is about the person acting, which is `actualRole`.
 */
export function withheldCapabilitiesFor(db, userRow) {
  if (!userRow || userRow.role !== ROLE.ORGANIZER) return [];
  if (hasAcceptedOrganizerAgreement(db, userRow.id)) return [];
  return [...ORGANIZER_GATED_CAPABILITIES];
}

/**
 * Records acceptance, transactionally.
 *
 * Wrapped in a transaction for the reason `consent.js`'s header gives about
 * signup: a half-written acceptance is worse than none, because it looks like a
 * record. Here the transaction spans only the acceptance rows, since nothing else
 * changes — the capabilities are derived on the next request rather than written
 * anywhere, which is what makes this the single source of truth.
 *
 * Idempotent by returning `already` rather than writing a second set of rows. An
 * organizer who double-submits the form should not produce two acceptance
 * records at the same version: the question "when did they accept v1.0" must
 * have one answer.
 */
export function acceptOrganizerAgreement(db, { userId, req = null, now = null }) {
  if (hasAcceptedOrganizerAgreement(db, userId)) {
    return { recorded: 0, already: true };
  }

  /**
   * The transaction is opened here rather than through `utils.js`'s
   * `inTransaction`.
   *
   * Two reasons. `inTransaction` closes over the module-level `db` in `utils.js`,
   * and `utils.js` imports THIS module for `withheldCapabilitiesFor` — importing
   * it back would be a cycle. And this module takes `db` as an argument precisely
   * so it can be driven against a throwaway handle in a test, which a helper
   * bound to the live connection defeats.
   *
   * `node:sqlite` has no `db.transaction(fn)` wrapper — that is better-sqlite3's
   * API, and reaching for it here failed on every boot.
   */
  db.exec('BEGIN');
  try {
    const recorded = recordAcceptances(db, {
      userId,
      method: 'organizer_agreement',
      context: 'organizer-onboarding',
      documents: ORGANIZER_DOCUMENTS,
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
 * The documents an organizer must accept, and the state of their acceptance.
 *
 * `withheld` is computed by `withheldCapabilitiesFor` rather than from `accepted`
 * directly, and the difference is not cosmetic. An administrator has no
 * acceptance row — the agreement does not bind them — so deriving the list from
 * `accepted` alone reported the full withheld set to every admin while nothing
 * was actually being withheld from them. One function answering "what is withheld
 * from this person" means the status endpoint cannot disagree with `can()`.
 */
export function organizerAgreementStatus(db, userRow) {
  const accepted = hasAcceptedOrganizerAgreement(db, userRow.id);
  return {
    required: userRow.role === ROLE.ORGANIZER,
    accepted,
    documents: ORGANIZER_DOCUMENTS.map(d => ({
      slug: d.slug,
      title: d.title,
      version: d.version,
      effectiveAt: d.effectiveAt,
    })),
    withheld: withheldCapabilitiesFor(db, userRow),
  };
}
