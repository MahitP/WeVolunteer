import { ROLE } from './authz.js';
import { runInTransaction } from './db/connectionContext.js';
import { ADMIN_DOCUMENTS } from './legalDocuments.js';
import { recordAcceptances } from './consent.js';
import { resolveDocument } from './legalStore.js';

/**
 * The Admin Responsibilities Policy, and what an administrator cannot do until
 * they have accepted it.
 *
 * ── The gap this closes ──
 *
 * The policy was published as a NOTICE. It told administrators what they may do,
 * what is logged, and that browsing a student's record without a task is misuse —
 * and nothing enforced any of it. The launch-checklist audit on 2026-09-27 found
 * both owner accounts holding every capability with zero acceptance rows against
 * it.
 *
 * The asymmetry is what makes that worth fixing rather than noting. The Organizer
 * Agreement has withheld capabilities until acceptance since it shipped, so an
 * organizer cannot see who applied to their own event without first undertaking
 * how to handle it. An administrator can see every student on the platform. The
 * document governing the MORE powerful role was the one with no gate.
 *
 * ── What is withheld, and what deliberately is not ──
 *
 * `ADMIN_GATED_CAPABILITIES` is the power to act on, or read, another person's
 * record. It is not "everything an admin holds", and the exclusions are the
 * point:
 *
 *   - `self.read` / `self.write` stay, so an administrator who has not accepted
 *     can still sign in, open Settings, and reach the policy. Withholding them
 *     would be the lockout `organizerAgreement.js` argues against in its own note.
 *   - `owner.console`, `admin.create`, `legal.edit` and `audit.read` stay. They
 *     are how an owner recovers an instance, and a bug in the acceptance path
 *     must not also remove the tools for digging out of it.
 *   - Ordinary participation — `message.send`, `event.view`, `assistant.use` —
 *     stays. This policy governs power over people, not membership.
 *
 * ── This one really does apply to the owner ──
 *
 * `can()` checks `withheld` BEFORE the `'*'` wildcard, so a `super_admin` is
 * gated by this exactly like an `admin`. That is deliberate and it is the whole
 * value: a rule the platform owner is exempt from is not a rule, and the owner is
 * the account with the most access to students' records.
 *
 * The escape hatch is the acceptance route itself, which is gated on
 * `authenticateToken` alone — no capability, no step-up — for the reason the
 * organizer route gives: gating the one action that restores an account is how a
 * gate becomes a lockout. Below that, `bin/` operates on the database directly.
 */

/**
 * Roles this policy binds.
 *
 * A set rather than an inline comparison, because `authz.completeness.test.js`
 * fails the build on an authorization decision written as a comparison against a
 * quoted role literal.
 */
const BOUND_ROLES = new Set([ROLE.ADMIN, ROLE.SUPER_ADMIN]);

/**
 * Whether this policy binds the account — exported so there is ONE answer.
 *
 * The withholding arm decides who loses capabilities; the accept route decides
 * who may record an acceptance. Written separately they agree today, and a role
 * added to one and not the other produces an account that is withheld fourteen
 * capabilities and refused at the only route that restores them. That is the
 * lockout this module is otherwise careful to avoid, arriving through a
 * duplicated predicate rather than a gated one.
 */
export function boundByAdminResponsibilities(role) {
  return BOUND_ROLES.has(role);
}

/**
 * The power to act on, or read, another person's record.
 *
 * Frozen, and named here rather than derived from `CAPABILITIES.admin`, because
 * a derived list would silently grow every time the admin role gained a
 * capability — and the day it grew would be the day an unreviewed capability
 * started being withheld from the only account that can fix it.
 */
export const ADMIN_GATED_CAPABILITIES = Object.freeze([
  // Acting on a person.
  'user.suspend',
  'user.warn',
  'organizer.approve',
  'capability.grant',
  // The moderation queues, and the evidence inside them.
  'report.resolve',
  'report.evidence.read',
  'appeal.review',
  'event.moderate',
  'organization.moderate',
  // Reading a student's record — "the limits on looking" the policy is about.
  'user.contact.read',
  'application.read_all',
  'analytics.school',
  'roster.export',
  'impersonation.start',
]);

/**
 * Whether this user has accepted every current admin document.
 *
 * Compared against the RESOLVED version, not the registry's, for the reason
 * `hasAcceptedOrganizerAgreement` gives: an owner can republish this document
 * through the Legal Center, and a gate measured against the version that shipped
 * would keep passing for somebody who accepted text that has since been replaced.
 *
 * The consequence is worth stating plainly, because it is sharper here than for
 * the organizer document: publishing a new version of this policy withholds
 * fourteen capabilities from EVERY administrator, including the owner, until each
 * one accepts again.
 */
export async function hasAcceptedAdminResponsibilities(db, userId) {
  if (ADMIN_DOCUMENTS.length === 0) return true;

  const accepted = new Set(
    (await db.prepare('SELECT document_slug, version FROM legal_acceptances WHERE user_id = ?')
      .all(userId))
      .map(r => `${r.document_slug}@${r.version}`)
  );

  /* A loop, not `.every`: the resolver is async and `.every` does not await, so
     it would see a truthy promise per document and report the policy as accepted
     by somebody who never accepted it. */
  for (const registered of ADMIN_DOCUMENTS) {
    const doc = await resolveDocument(db, registered) ?? registered;
    if (!accepted.has(`${doc.slug}@${doc.version}`)) return false;
  }
  return true;
}

/**
 * The withholding arm, for `withheldCapabilitiesFor`.
 *
 * `actualRole`, not `effectiveRole`, for the same reason the organizer arm uses
 * it: an owner previewing as a student must not be gated by, or released from,
 * this policy on the strength of the role they are pretending to hold. The
 * question is about the person acting.
 */
export async function adminResponsibilitiesWithholdings(db, userRow) {
  if (!userRow || !BOUND_ROLES.has(userRow.role)) return [];
  if (await hasAcceptedAdminResponsibilities(db, userRow.id)) return [];
  return [...ADMIN_GATED_CAPABILITIES];
}

/**
 * Records acceptance, transactionally and idempotently.
 *
 * Mirrors `acceptOrganizerAgreement`: a half-written acceptance is worse than
 * none because it looks like a record, and a double submit must not produce two
 * rows at the same version — "when did they accept 1.0" must have one answer.
 */
export async function acceptAdminResponsibilities(db, { userId, req = null, now = null }) {
  if (await hasAcceptedAdminResponsibilities(db, userId)) {
    return { recorded: 0, already: true };
  }

  /* Registry entries, not pre-resolved ones: `recordAcceptances` resolves each
     itself so the row records the version and hash the person was SHOWN, which
     is the whole point of that call site. Resolving here too would be a second
     implementation of the same rule. */
  return runInTransaction(db, async (tx) => {
    const recorded = await recordAcceptances(tx, {
      userId,
      method: 'admin_responsibilities',
      context: 'admin-onboarding',
      documents: ADMIN_DOCUMENTS,
      req,
      now,
    });
    return { recorded, already: false };
  });
}

/** Status for the acceptance screen: what to show, and whether it is already done. */
export async function adminResponsibilitiesStatus(db, userId) {
  const documents = [];
  for (const registered of ADMIN_DOCUMENTS) {
    documents.push(await resolveDocument(db, registered) ?? registered);
  }
  /* `required` mirrors the organizer endpoint's shape so the two screens read
     the same way: false for somebody the policy does not bind, which the screen
     renders as "nothing for you to accept" rather than as a refusal. */
  const row = await db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
  return {
    required: boundByAdminResponsibilities(row?.role),
    accepted: await hasAcceptedAdminResponsibilities(db, userId),
    documents: documents.map(d => ({
      slug: d.slug, version: d.version, title: d.title, effectiveAt: d.effectiveAt ?? null,
    })),
    withheld: [...ADMIN_GATED_CAPABILITIES],
  };
}
