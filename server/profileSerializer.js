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
 * The distinguished presentation an account carries, or null for a member.
 *
 * ── Derived from role, never from an identity ──
 *
 * The platform owner's profile and a partner organization's profile need to look
 * and read differently from a student's: they are not people with a service
 * record, they are the platform and the organizations it works with, and a
 * student profile with a badge stuck on it says neither thing. The obvious wrong
 * way to build this is a check on a name — the account that prompted it belongs
 * to a real person — and that would be a rule nobody else can inherit, invisible
 * to `authz.js`, and wrong the day the account changes hands.
 *
 * So it is a pure function of `users.role`, which is the same field every gate in
 * this application already reads. A second owner, a tenth partner, or a change of
 * role tomorrow all get the right presentation with nothing to remember.
 *
 * ── It is presentation, and nothing else ──
 *
 * No capability is derived from this, no gate consults it, and a client that
 * ignores it is not thereby allowed to do anything. `authz.js` remains the only
 * answer to what an account may DO; this answers only how it is introduced.
 *
 * ── Why a member profile is still rendered underneath ──
 *
 * The distinction is additive. The owner of this platform is a high-school
 * student who volunteers, so their hours, skills and hobbies are real and belong
 * on their profile exactly as anybody else's do. Returning a distinction instead
 * of the member fields would hide a genuine service record behind a job title;
 * returning it alongside is what makes one page describe one person.
 */
/**
 * ── The copy here is platform-authored, and every line of it has to be TRUE ──
 *
 * These strings are written by this repository, not by the account they
 * describe, and they appear on a page a reader will treat as the platform
 * vouching for somebody. So they say only what this codebase can actually
 * demonstrate from the role: what the account can do, and how it got here.
 *
 * They deliberately claim nothing about legal structure, incorporation,
 * charitable status, funding, staff, endorsement or the size of any
 * relationship, because none of that is knowledge this system holds. A partner
 * row is a `users.role` value; it is not a signed agreement, and copy that
 * implied one would be the platform asserting something on somebody else's
 * behalf.
 *
 * `blurb` is the one-line form used in tight places. `description` is the
 * paragraph a profile page can afford, and it exists so that "what IS a
 * community partner?" is answered on the page rather than left to a reader who
 * has never seen the word used this way. `contributionLabel` and
 * `interestsLabel` name the sections beneath, because "Volunteering" and
 * "Interests" are student words and an organization does not have hobbies.
 */
const DISTINCTIONS = {
  super_admin: {
    kind: 'owner',
    label: 'Platform owner',
    blurb: 'Runs WeVolunteer for the district.',
    description:
      'This account runs WeVolunteer — the person responsible for how the '
      + 'platform works, what it does with your information, and the policies in '
      + 'the Legal Center. If something here is wrong or unfair, this is the '
      + 'account that can change it.',
    contributionLabel: 'Volunteering',
    interestsLabel: 'Interests',
    highlightsLabel: 'What this account does here',
  },
  partner: {
    kind: 'partner',
    label: 'Community partner',
    blurb: 'An outside organization that works with WeVolunteer.',
    description:
      'A community partner is an organization outside the school that takes part '
      + 'in WeVolunteer. Partner accounts can see what is posted across the '
      + 'district, and deliberately cannot browse student profiles or search the '
      + 'member directory.',
    contributionLabel: 'On WeVolunteer',
    interestsLabel: 'Areas of involvement',
    highlightsLabel: 'What we do',
  },
};

export function distinctionFor(role) {
  return DISTINCTIONS[role] ?? null;
}

/**
 * `profile_highlights` as an array of short strings, defensively.
 *
 * Stored as JSON in a TEXT column, so a hand-edited row or a half-written value
 * has to be survivable: a profile that throws is a profile nobody can look at,
 * including the moderator who came to look at it.
 */
export function parseHighlights(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(h => typeof h === 'string' && h.trim())
      .slice(0, 8)
      .map(h => h.trim().slice(0, 160));
  } catch {
    return [];
  }
}

/**
 * Fields a caller may read about someone else regardless of that person's
 * privacy setting. Kept as an exported constant because the leakage test
 * asserts against it rather than against a hand-copied list.
 */
export const PUBLIC_BASELINE_FIELDS = Object.freeze([
  'id', 'username', 'name', 'avatar', 'profilePictureUrl', 'role',
  'location', 'hobbies', 'skills', 'joinedAt', 'lastVolunteeredAt',
  'stats', 'organizations', 'visibility', 'isSelf',
  /* `distinction` is `role` restated in words, so it discloses nothing the
     baseline did not already carry. `externalService` used to be here and is
     NOT any more — it is emitted to the subject alone; see the note at its
     emission site. */
  'distinction',
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
  /* Derived once: it decides both what is emitted and whether the two
     free-text fields below are exempt from the privacy setting. */
  const distinction = distinctionFor(row.role);

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
    /**
     * How the account is INTRODUCED, for every reader.
     *
     * Always visible, at every privacy setting, because it is not a personal
     * particular: it is the answer to "what is this account", and withholding it
     * from a member who can already see the name and the role would hide nothing
     * while making a partner organization's page unreadable.
     */
    distinction,
    visibility: stated,
    isSelf,
  };

  /**
   * `headline` and `highlights` follow the privacy setting, EXCEPT on a
   * distinguished account.
   *
   * The first version put them on the baseline, reasoning that they are written
   * by the account holder for exactly this audience. That is true of a partner
   * organization and false of a fourteen-year-old: they are free text under a
   * name, which is what `bio` is, and `bio` is gated. Leaving them ungated gave
   * a student with a PRIVATE profile a second bio that privacy did not cover —
   * "Sophomore at SBHS, I walk home down Elm after 4pm" is the shape of the
   * problem, and it would have been returned to every holder of
   * `directory.read`.
   *
   * On an owner or partner account they stay unconditional, because there the
   * fields are the point: an official account whose one-line introduction
   * disappeared behind a privacy toggle would be unreadable, and such an
   * account is an institution rather than a child. `distinctionFor` decides
   * which case applies, from `users.role` and nothing else.
   */
  if (distinction || sensitiveVisible) {
    profile.headline = row.profile_headline || null;
    profile.highlights = parseHighlights(row.profile_highlights);
  }

  /**
   * ── `bio` follows the headline onto an institutional account ──
   *
   * `bio` was gated by `profile_visibility` for everybody, and that column
   * defaults to `'private'`. So a community partner's own description of itself
   * — the paragraph explaining who they are and what they do here — was
   * invisible to every reader until somebody found a privacy setting written
   * for a fourteen-year-old and changed it.
   *
   * That is the same asymmetry the headline note above resolves, applied to the
   * same kind of text, and it was simply not carried across: the argument is
   * word for word the one already made there. An institution's public
   * description disappearing behind a child-safety toggle is not privacy, it is
   * a page that fails to say what it is for.
   *
   * Emitted in this branch and NOT on the public baseline, which is the
   * distinction that matters. A student's `bio` keeps its gate exactly as it
   * was — the block below still owns that case — and nothing here widens what
   * is disclosed about a minor.
   */
  if (distinction && !sensitiveVisible) {
    profile.bio = row.bio || '';
  }

  /**
   * External service is emitted to the SUBJECT and to nobody else.
   *
   * It used to be on every profile, split into a verified figure and a
   * self-reported one — and the verified half is gone, because nobody reviews
   * these any more. What is left is a number the subject typed in, which does
   * not belong on a page other people read as a record of what somebody has
   * done: an unverifiable total sitting beside a credited one invites exactly
   * the reading the two are kept apart to prevent, and it would reward typing.
   *
   * The student's own log is where a complete personal history belongs, and it
   * is reached from their dashboard. This field stays on the payload for the
   * subject so their own profile can link there with a count.
   */
  if (isSelf) {
    profile.externalService = externalHoursSummary(db, row.id);
  }

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
    /* Derived from `role`, which is already on this shape — so it discloses
       nothing new, and it lets a search result show a partner organization as
       one rather than as an unexplained account among schoolchildren. */
    distinction: distinctionFor(row.role),
  };
}
