import { grantCapability, revokeCapability } from './userCapabilities.js';

/**
 * Keeping a Student Organizer's capabilities equal to the ranks they actually
 * hold.
 *
 * ── Why the capabilities are granted per person instead of per role ──
 *
 * A Student Organizer is a rank inside one organization. The account behind it
 * is an ordinary `student`, and it stays one: they do not become an organizer of
 * the platform because a club president asked them to put the bake-sale shift
 * up.
 *
 * That leaves the four helper capabilities nowhere to live in the role table.
 * Adding them to `student` would give them to every student on the platform and
 * make the membership lookup inside each handler the only thing standing between
 * any student and posting as any club — one route written without its second
 * layer and the whole rank is a platform-wide promotion. So they are written to
 * `user_capabilities` for the person who was promoted, and deleted when they are
 * not a Student Organizer anywhere any more.
 *
 * ── Why "anywhere", and not "for this organization" ──
 *
 * `can(principal, capability)` takes no scope argument, and `grantCapability`
 * refuses a scoped grant outright rather than writing a row the kernel would
 * silently honour platform-wide. So the grant can only mean "somewhere". That is
 * exactly why it is only half the check: every route behind these capabilities
 * also asks `canHelpRun(db, organizationId, userId)`, which reads the membership
 * row for the organization in front of it. Somebody who helps run the Chess Club
 * passes the middleware on a Robotics Club route and is refused by the second
 * layer, one line into the handler.
 *
 * ── Why one function called after every membership change ──
 *
 * There are four ways to stop being a Student Organizer — demotion, removal,
 * being banned, and leaving — and a fifth if somebody adds one. A revoke written
 * at each site is four chances to write it once and forget the fifth, and the
 * failure is silent: the row stays, the person keeps a capability whose only
 * remaining protection is a lookup they will now fail, until a route is added
 * that forgets it. Recomputing from the membership table means the answer cannot
 * drift from the thing it is meant to describe.
 */

/**
 * The capabilities the rank confers. Each is the middleware half of a two-layer
 * check; none of them decides anything on its own.
 */
export const STUDENT_ORGANIZER_CAPABILITIES = Object.freeze([
  'organization.post.create',
  'organization.post.manage',
  'organization.event.create',
  'organization.event.manage.own',
]);

/** Does this person hold the Student Organizer rank in any organization? */
export function isStudentOrganizerAnywhere(db, userId) {
  if (!userId) return false;
  return Boolean(db.prepare(`
    SELECT 1 FROM organization_members
     WHERE user_id = ? AND member_role = 'student_organizer' LIMIT 1
  `).get(userId));
}

/**
 * Grants or revokes the four, to match the membership table as it stands now.
 *
 * Call after ANY change to a person's membership rows. Idempotent, and cheap
 * enough to call when nothing changed — one indexed lookup plus at most four
 * upserts or deletes.
 *
 * Revoking is safe for an organizer or an administrator who happened to be
 * promoted inside a club: their capabilities come from the role table, which
 * this never touches. `revokeCapability` deletes a `user_capabilities` row that
 * in their case was never there.
 *
 * @param {object} db
 * @param {string} userId whose capabilities to recompute
 * @param {string|null} grantedBy who caused the change, recorded on the grant
 * @returns {'granted'|'revoked'} what the recomputation decided
 */
export function syncOrganizerCapabilities(db, userId, grantedBy = null) {
  if (!userId) return 'revoked';
  const holds = isStudentOrganizerAnywhere(db, userId);

  for (const capability of STUDENT_ORGANIZER_CAPABILITIES) {
    if (holds) grantCapability({ db, userId, capability, grantedBy });
    else revokeCapability({ db, userId, capability });
  }

  return holds ? 'granted' : 'revoked';
}
