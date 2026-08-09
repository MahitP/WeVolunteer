/**
 * The one place a user row becomes something another member is allowed to see.
 *
 * ── Why this file exists as an allowlist ──
 *
 * Every profile endpoint in this repository used to do `SELECT *` and then hand
 * a shape out by naming the fields it wanted. That works right up until somebody
 * adds a column. A denylist is wrong by default the moment the schema grows: the
 * new column ships visible, and the review that would have caught it is a review
 * of a migration, not of a serializer. `date_of_birth`, `graduation_year`,
 * `suspension_reason`, `tfa_secret` and `password_hash` all arrived on `users`
 * after those handlers were written.
 *
 * So the rule here is inverted and absolute: a field is invisible unless this
 * file names it. A new column on `users` is private until somebody edits this
 * file to say otherwise, and `profileSerializer.leakage.test.js` asserts that
 * the emitted key set is exactly the expected one — so widening it silently is
 * not possible either.
 *
 * ── The visibility model ──
 *
 * `users.profile_visibility` is 'public' or 'private' ('friends' is accepted by
 * the column's CHECK and treated as 'private' plus friend access — see below).
 * What changed in v1.3 is what those words protect.
 *
 * A private profile used to mean an invisible one. That made the directory
 * useless and, worse, made privacy an all-or-nothing choice a student had to
 * make between being findable by the people they volunteer with and exposing
 * their school and grade to everybody. Now the profile is always discoverable
 * and the SENSITIVE fields are what privacy withholds:
 *
 *   Always visible   name, username, avatar, role, location, hobbies, skills,
 *                    joined, last volunteered, participation counts, credited
 *                    hours, organizations
 *   Public only      bio, school, grade, graduation year
 *   Never here       email, date of birth, phone, address, coordinates,
 *                    password hash, TFA secret, suspension state, token
 *                    version, the detailed service history
 *
 * The always-visible set is the smallest thing that makes a volunteer profile
 * worth opening, and every field in it is either chosen by the student
 * (hobbies, skills, a general location) or a count.
 *
 * ── The service history is not in the public baseline, at all ──
 *
 * The pre-v1.3 `GET /api/users/:id/profile` returned `completed[]` to any
 * authenticated caller: every past event's title, its LOCATION, and its exact
 * start and end datetimes. For a fifteen-year-old that is a published record of
 * where they have been and when, week by week — a pattern-of-life, assembled by
 * the platform and handed to anybody with a login. It is the single most
 * sensitive thing the old endpoint disclosed and nothing gated it.
 *
 * Counts replace it publicly. The itemised history stays available to the
 * student themselves and to staff holding `user.contact.read`, which is the
 * capability that already names the power to see a student's particulars.
 */

import { volunteerStats, externalHoursSummary } from './volunteerStats.js';

/**
 * Fields a caller may read about someone else regardless of that person's
 * privacy setting. Kept as an exported constant because the leakage test
 * asserts against it rather than against a hand-copied list.
 */
export const PUBLIC_BASELINE_FIELDS = Object.freeze([
  'id', 'username', 'name', 'avatar', 'profilePictureUrl', 'role',
  'location', 'hobbies', 'skills', 'joinedAt', 'lastVolunteeredAt',
  'stats', 'organizations', 'externalService', 'visibility', 'isSelf',
]);

/** Fields added only when the profile is public. */
export const PUBLIC_ONLY_FIELDS = Object.freeze(['bio', 'school', 'grade', 'graduationYear']);

/** Fields added only for the account itself, or for staff who may see PII. */
export const PRIVILEGED_FIELDS = Object.freeze(['email', 'emailVerified', 'friendActivityVisible']);

const parseList = (raw) => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(v => typeof v === 'string') : [];
  } catch {
    return [];
  }
};

/**
 * Organizations this member belongs to.
 *
 * Membership is public. An organization is a club somebody joined, its page
 * lists its members, and hiding the same fact on the profile side would be a
 * privacy control that protects nothing while making the two pages disagree.
 */
function organizationsFor(db, userId) {
  return db.prepare(`
    SELECT o.id, o.slug, o.name, m.member_role AS memberRole
    FROM organization_members m
    JOIN organizations o ON o.id = m.organization_id
    WHERE m.user_id = ? AND o.status = 'active'
    ORDER BY o.name COLLATE NOCASE
  `).all(userId);
}

/**
 * Builds the profile one caller may see of one subject.
 *
 * @param {object} db
 * @param {object} row            the `users` row of the SUBJECT
 * @param {object} opts
 * @param {string|null} opts.viewerId
 * @param {boolean} opts.canSeeContact  viewer holds `user.contact.read`
 * @param {boolean} opts.isFriend       an ACCEPTED friendship exists both ways
 */
export function publicProfile(db, row, { viewerId = null, canSeeContact = false, isFriend = false } = {}) {
  const isSelf = Boolean(viewerId) && viewerId === row.id;

  /**
   * 'friends' behaves as 'public' to an accepted friend and as 'private' to
   * everybody else. Deciding it here, once, is what stops each consumer
   * inventing its own reading of a three-valued column.
   */
  const stated = row.profile_visibility === 'public' ? 'public'
    : row.profile_visibility === 'friends' ? 'friends'
      : 'private';
  const sensitiveVisible = isSelf || canSeeContact
    || stated === 'public'
    || (stated === 'friends' && isFriend);

  const stats = volunteerStats(db, row.id);

  const profile = {
    id: row.id,
    username: row.username || null,
    name: row.name,
    avatar: row.avatar || null,
    profilePictureUrl: row.profile_picture_url || null,
    role: row.role,
    location: row.location || null,
    hobbies: parseList(row.hobbies),
    skills: parseList(row.skills),
    joinedAt: row.created_at,
    lastVolunteeredAt: stats.lastVolunteeredAt,
    /**
     * The counts, and deliberately no percentage.
     *
     * A rate is emitted nowhere on a public profile. "1 of 2 — 50%" reads as a
     * damning fact about a person when the underlying evidence is one missed
     * shift, and a reader cannot un-see the number once it is on the page. The
     * raw counts carry their own sample size, which is the whole point.
     * `eventsAwaitingRecord` is published alongside them so that a low
     * attended-versus-signed-up gap is legible as "not confirmed yet" rather
     * than as absence.
     */
    stats: {
      eventsSignedUp: stats.eventsSignedUp,
      eventsAttended: stats.eventsAttended,
      eventsAwaitingRecord: stats.eventsAwaitingRecord,
      hours: stats.hoursCredited,
    },
    organizations: organizationsFor(db, row.id),
    externalService: externalHoursSummary(db, row.id),
    visibility: stated,
    isSelf,
  };

  if (sensitiveVisible) {
    profile.bio = row.bio || '';
    profile.school = row.school || null;
    profile.grade = row.grade || null;
    profile.graduationYear = row.graduation_year ?? null;
  }

  /**
   * Contact detail is a strictly narrower gate than "sensitive fields".
   *
   * A public profile shows a school and a grade to other members; it never
   * shows an email address. Making these two the same test would have meant
   * that setting your profile public published your email, which is not
   * something anybody choosing that setting is agreeing to.
   */
  if (isSelf || canSeeContact) {
    profile.email = row.email;
    profile.emailVerified = row.email_verified === 1;
  }
  if (isSelf) {
    profile.friendActivityVisible = row.friend_activity_visible !== 0;
  }

  return profile;
}

/**
 * The compact shape used in search results and member lists.
 *
 * A strict subset of the baseline. It carries no field the full profile would
 * withhold, which is the property that stops search becoming the alternate
 * route to private data — the recurring shape of this class of bug is an
 * endpoint that was never thought of as a profile endpoint.
 *
 * `stats` is deliberately absent: three aggregate queries per row would make a
 * twenty-result page sixty queries, and a search result does not need them.
 */
export function profileSummary(row) {
  return {
    kind: 'user',
    id: row.id,
    username: row.username || null,
    name: row.name,
    avatar: row.avatar || null,
    profilePictureUrl: row.profile_picture_url || null,
    role: row.role,
    location: row.location || null,
  };
}
