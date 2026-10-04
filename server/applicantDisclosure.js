/**
 * What the people running an event may read about the people applying to it.
 *
 * ── Two agreements, two answers ──
 *
 * An event's staff are not one kind of reader, and the two documents they
 * accepted say different things:
 *
 *   The Organizer Agreement (§2), accepted by ADULT organizers, gives them the
 *   applicant's grade level and "anything they chose to put on their profile",
 *   for the events they run. That reader holds `applicant.review`.
 *
 *   The Student Organizer Agreement (§3), accepted by a STUDENT who helps run a
 *   club — a Student Organizer, or a student the club made a manager — gives
 *   them grade and school only "where they chose to share it". That reader
 *   holds `organization.event.manage.own` and not `applicant.review`, because
 *   the rank is a per-person grant to an account whose role is still `student`.
 *
 * The applicant surfaces used to answer every reader as if they were the first
 * kind. A Student Organizer listing their applicants was served the school,
 * grade and bio of a classmate who keeps all three private, and the whole of
 * their service record — while the same Student Organizer opening that
 * classmate's profile was refused every one of those fields. The Privacy Policy
 * tells students that other students "see only what your profile visibility
 * setting allows", and the owner's ruling 17 says grade in private mode is
 * hidden from other students. A second endpoint returning the same rows is the
 * recurring shape of this bug; see the header of profileSerializer.js.
 *
 * ── The rule ──
 *
 * A reader who may see an applicant's particulars anyway — an adult organizer
 * (`applicant.review`) or staff who may read contact detail
 * (`user.contact.read`) — sees everything, as before. That is the same pair
 * `GET /api/users/:id/profile` folds into its `canSeeContact`.
 *
 * Everybody else sees what the DIRECTORY would show them of that person, and
 * not one field more:
 *
 *   bio, school, grade   `sensitiveFieldsVisible` — `profile_visibility`, with
 *                        'friends' opening to an accepted friend
 *   the service figures  `canSeeHours` — `hours_visibility`
 *
 * Both are the functions the profile itself calls, so the two surfaces cannot
 * come to disagree about a person.
 *
 * ── What it does NOT change ──
 *
 * Which applications a reader may list at all is the route's question, asked in
 * SQL before this runs. Name, avatar, skills and badges are the directory's
 * public baseline and stay on every row. The attendance a reader records on
 * their own event is theirs to see whatever the volunteer's setting: that is
 * the event being run, not the volunteer's record. And Auto Select is
 * untouched — it weighs hours on the server, from the ledger, not from what a
 * reader was shown.
 */

import { can } from './authz.js';
import { sensitiveFieldsVisible, statedProfileVisibility } from './profileSerializer.js';
import { canSeeHours } from './serviceVisibility.js';
import { areFriends } from './relationships.js';

/**
 * Whether this reader sees every applicant's particulars, whatever their
 * settings. See the header for why these two capabilities and no others.
 */
export function readsApplicantsInFull(principal) {
  return can(principal, 'applicant.review') || can(principal, 'user.contact.read');
}

/**
 * Decides, once per person, what each applicant discloses to this reader.
 *
 * @param {object} db
 * @param {object} principal  `req.principal`
 * @param {Array<{id: string, profile_visibility?: string, hours_visibility?: string}>} subjects
 *   the applicants' `users` rows, or enough of them to carry the two settings
 * @returns {Promise<Map<string, {particulars: boolean, hours: 'visible'|'private'}>>}
 *   keyed by user id. `particulars` covers bio, school and grade; `hours` covers
 *   every service figure and is emitted to the client as-is, so a row can say
 *   "keeps their record private" rather than read as somebody with none.
 *
 * ── Why `areFriends` is asked per person ──
 *
 * It is the single gate on the friends-only tier — it alone knows that a block
 * ends a friendship for disclosure purposes, and that only peers can be friends
 * — so a batched copy would be a second gate to keep in step with the first.
 * The cost is bounded to what needs it: never asked for a reader who sees
 * everything, and only for applicants whose setting is 'friends'.
 */
export async function applicantDisclosure(db, principal, subjects) {
  const viewerId = principal?.userId ?? null;
  const full = readsApplicantsInFull(principal);
  const decided = new Map();

  for (const subject of subjects) {
    if (!subject?.id || decided.has(subject.id)) continue;

    const isFriend = !full
      && statedProfileVisibility(subject) === 'friends'
      && await areFriends(db, viewerId, subject.id);

    decided.set(subject.id, {
      particulars: sensitiveFieldsVisible(subject, { viewerId, canSeeContact: full, isFriend }),
      hours: canSeeHours(subject, { viewerId, canSeeContact: full }) ? 'visible' : 'private',
    });
  }

  return decided;
}
