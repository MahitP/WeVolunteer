/**
 * Shared validation for the fields that create an account.
 *
 * This exists because there are two doors into `INSERT INTO users` — the
 * ordinary POST /api/auth/signup, and the OAuth callback's auto-signup path —
 * and only the first one was checking anything. The OAuth path took `role`
 * straight from a client-supplied blob and wrote it into the row, so:
 *
 *     POST /api/oauth/google/url  { signupData: { ..., role: "admin" } }
 *
 * self-registered an administrator, bypassing the explicit
 * `['student','organizer'].includes(role)` guard that the normal signup route
 * has always had. Both doors now call the same function.
 *
 * Pure: no database access. Uniqueness (email/username already taken) is a
 * property of the data, not of the payload, and stays with the routes.
 *
 * `isCurrentPassword` below is the one function here that needs bcrypt. It is
 * still a rule about a payload rather than a lookup — see its own docstring for
 * why a hash comparison belongs in this module and not in a route.
 */

import bcrypt from 'bcryptjs';
import { VALID_GRADES } from './config.js';

/** Roles a person may give themselves. Admin is seeded or promoted, never self-assigned. */
export const SELF_ASSIGNABLE_ROLES = ['student', 'organizer'];

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 20;
const NAME_MAX = 100;
const BIO_MAX = 500;
const SCHOOL_MAX = 200;
const SKILL_MAX = 50;
const MAX_SKILLS = 20;
const EMAIL_MAX = 254; // RFC 5321 practical maximum.

/** Requirements shown live on the signup form. Kept here so the copy cannot drift from the check. */
export const PASSWORD_RULES = [
  { id: 'length', label: 'At least 8 characters', test: (p) => p.length >= 8 },
  { id: 'upper', label: 'At least 1 uppercase letter', test: (p) => /[A-Z]/.test(p) },
  { id: 'lower', label: 'At least 1 lowercase letter', test: (p) => /[a-z]/.test(p) },
  { id: 'number', label: 'At least 1 number', test: (p) => /[0-9]/.test(p) }
];

/**
 * @returns {{ok: true} | {ok: false, field: string, error: string}}
 */
export function validatePassword(password) {
  if (typeof password !== 'string' || !password) {
    return { ok: false, field: 'password', error: 'Choose a password.' };
  }
  // Bcrypt silently truncates at 72 bytes, so anything longer gives a false
  // sense of strength and makes two different passwords equivalent.
  if (Buffer.byteLength(password, 'utf8') > 72) {
    return { ok: false, field: 'password', error: 'That password is too long. Use 72 characters or fewer.' };
  }
  const failed = PASSWORD_RULES.filter(r => !r.test(password));
  if (failed.length > 0) {
    return {
      ok: false,
      field: 'password',
      error: `Your password still needs: ${failed.map(r => r.label.toLowerCase()).join(', ')}.`
    };
  }
  return { ok: true };
}

/**
 * Whether a candidate password is the one the account already stores.
 *
 * ── Why a password rule and not an authorization check ──
 *
 * "Choose a different password from the one you have" is policy, in the same
 * family as the length and character rules above: it constrains what the new
 * value may be, and it answers the same way whoever is asking. It is NOT the
 * gate that decides whether the caller may change the password at all — that is
 * `requireAAL2('password.change')` plus the grant the handler spends, and
 * conflating the two is exactly what v1.2b removed. `POST
 * /api/auth/change-password` used to prove the current password inline and then
 * reuse that same comparison for this rule, so removing the credential check
 * looked like it should remove the policy too. It should not.
 *
 * ── Why it lives here rather than in the route ──
 *
 * So that no route module contains a `bcrypt.compare` at all. `authRoutes.js`'s
 * login is the only place in this application that compares a password to decide
 * who someone is, and a one-line grep over `server/routes/` is the cheapest way
 * to keep it that way; a policy rule that happens to need a hash comparison
 * would defeat that grep while looking, line for line, exactly like the inline
 * credential checks the refactor deleted.
 *
 * ── The sentinel ──
 *
 * A provider-only account stores `'!OAUTH_ONLY!'`, which is not a bcrypt hash:
 * `bcrypt.compare` against it resolves FALSE rather than throwing, which would
 * read here as "not your current password" — the right answer by luck, since
 * such an account is setting a first password and has no current one to clash
 * with. Asserted rather than left to luck, by refusing any hash that is not
 * bcrypt's `$2…` format. Named by shape, not by the sentinel's value, so this
 * module needs no import from the routes and stays correct if the sentinel is
 * ever spelled differently.
 *
 * Pure in the sense that matters for this module: no database, no request.
 */
export async function isCurrentPassword(candidate, storedHash) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  if (typeof storedHash !== 'string' || !storedHash.startsWith('$2')) return false;
  return bcrypt.compare(candidate, storedHash);
}

export function validateUsername(username) {
  const clean = String(username ?? '').trim();
  if (!clean) return { ok: false, field: 'username', error: 'Choose a username.' };
  if (clean.length < USERNAME_MIN || clean.length > USERNAME_MAX) {
    return { ok: false, field: 'username', error: `Username must be between ${USERNAME_MIN} and ${USERNAME_MAX} characters.` };
  }
  if (!/^[a-zA-Z0-9_]+$/.test(clean)) {
    return { ok: false, field: 'username', error: 'Username may use letters, numbers, and underscores only.' };
  }
  if (!/^[a-zA-Z]/.test(clean)) {
    return { ok: false, field: 'username', error: 'Username must start with a letter.' };
  }
  // `deleted_<id>` is what account deletion renames a username to. Letting
  // someone register it would collide with a tombstone and let them wear a
  // deleted person's handle.
  if (/^deleted_/i.test(clean)) {
    return { ok: false, field: 'username', error: 'That username is reserved.' };
  }
  return { ok: true, value: clean };
}

export function validateEmail(email) {
  const clean = String(email ?? '').trim().toLowerCase();
  if (!clean) return { ok: false, field: 'email', error: 'Enter your email address.' };
  if (clean.length > EMAIL_MAX) {
    return { ok: false, field: 'email', error: 'That email address is too long.' };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
    return { ok: false, field: 'email', error: 'That does not look like an email address.' };
  }
  // Reserved for deletion tombstones — see the users table anonymisation.
  if (clean.endsWith('@system.local')) {
    return { ok: false, field: 'email', error: 'That email address cannot be used.' };
  }
  return { ok: true, value: clean };
}

/**
 * Validates a partial profile update.
 *
 * PATCH /api/auth/profile writes the same columns signup does, and was checking
 * almost none of them: it called `name.trim()` on whatever arrived, so a
 * non-string `name` threw and answered 500, `"   "` stored an empty display
 * name, and `bio` / `school` / `avatar` had no type or length limit at all
 * despite `validateAccountFields` enforcing all three at the front door. One
 * field cannot have two sets of rules where the looser set is the one reachable
 * after signup.
 *
 * Partial by design: only the keys actually present are validated and returned,
 * so the caller can keep building its dynamic UPDATE. `grade` and the two
 * boolean preferences stay with the route — they are already checked there
 * against VALID_GRADES and coerced to 0/1.
 *
 * @returns {{ok: true, value: object} | {ok: false, field: string, error: string}}
 */
export function validateProfilePatch(patch) {
  const out = {};

  if (patch.name !== undefined) {
    if (typeof patch.name !== 'string' || !patch.name.trim()) {
      return { ok: false, field: 'name', error: 'Enter your full name.' };
    }
    if (patch.name.trim().length > NAME_MAX) {
      return { ok: false, field: 'name', error: `Your name must be ${NAME_MAX} characters or fewer.` };
    }
    out.name = patch.name.trim();
  }

  if (patch.bio !== undefined) {
    // Explicitly clearing a bio is a legitimate edit, so null becomes ''
    // rather than being rejected as the wrong type.
    if (patch.bio !== null && typeof patch.bio !== 'string') {
      return { ok: false, field: 'bio', error: 'That must be text.' };
    }
    const bio = patch.bio ?? '';
    if (bio.length > BIO_MAX) {
      return { ok: false, field: 'bio', error: `Your bio must be ${BIO_MAX} characters or fewer.` };
    }
    out.bio = bio;
  }

  if (patch.school !== undefined) {
    if (patch.school !== null && typeof patch.school !== 'string') {
      return { ok: false, field: 'school', error: 'That must be text.' };
    }
    const school = patch.school ?? '';
    if (school.length > SCHOOL_MAX) {
      return { ok: false, field: 'school', error: `That must be ${SCHOOL_MAX} characters or fewer.` };
    }
    out.school = school;
  }

  if (patch.avatar !== undefined) {
    // Same rule as signup: a single emoji from a fixed palette. Anything longer
    // is a mistake or an attempt to smuggle a payload into a rendered field.
    if (typeof patch.avatar !== 'string' || !patch.avatar || patch.avatar.length > 8) {
      return { ok: false, field: 'avatar', error: 'Pick one of the available avatars.' };
    }
    out.avatar = patch.avatar;
  }

  if (patch.skills !== undefined) {
    if (!Array.isArray(patch.skills)) {
      return { ok: false, field: 'skills', error: 'Skills must be a list.' };
    }
    if (patch.skills.length > MAX_SKILLS) {
      return { ok: false, field: 'skills', error: `Please list ${MAX_SKILLS} skills or fewer.` };
    }
    if (patch.skills.some(s => typeof s !== 'string' || s.length > SKILL_MAX)) {
      return { ok: false, field: 'skills', error: `Each skill must be text of ${SKILL_MAX} characters or fewer.` };
    }
    out.skills = patch.skills.map(s => s.trim()).filter(Boolean);
  }

  return { ok: true, value: out };
}

/**
 * Validates everything about a new account except the password, which is
 * optional on the OAuth path and so is checked separately by the caller.
 *
 * Returns normalised values so callers write the same shape to the database
 * regardless of which door the request came through.
 */
/** Minimum age for a WeVolunteer account. Not a preference — see below. */
export const MINIMUM_AGE = 13;

/**
 * Whole years between `dob` and `asOf`, by calendar — never by dividing days.
 *
 * `(now - dob) / 365.25` is off by a day around leap years, which on a hard
 * 13-year boundary means a child is admitted or an eligible teenager refused
 * depending on which February they were born in. Comparing month and day is the
 * only version that is right on the birthday itself.
 */
export function ageOn(dob, asOf = new Date()) {
  let age = asOf.getUTCFullYear() - dob.getUTCFullYear();
  const monthDelta = asOf.getUTCMonth() - dob.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && asOf.getUTCDate() < dob.getUTCDate())) age -= 1;
  return age;
}

/**
 * The age gate.
 *
 * ── Why the refusal message says so little ──
 *
 * It reports one thing — too young — and never echoes the computed age or how
 * far off the person was. A gate that says "you must be 13, you are 12" teaches
 * the child exactly which year to retype, which is how an age screen becomes a
 * formality. The client is expected to make the refusal terminal for the same
 * reason.
 *
 * ── Why this refuses a missing value rather than defaulting ──
 *
 * COPPA attaches on actual knowledge of a user under 13, and as an independent
 * platform there is no district between WeVolunteer and the child. An absent
 * birth date is not "probably an adult"; it is the state in which the platform
 * cannot answer the only question that matters. It is also what makes the
 * indefinite retention of certificates and hours lawful — the amended Rule
 * forbids retaining a child's data indefinitely, so "no child is here" is the
 * load-bearing premise of that decision.
 */
export function validateDateOfBirth(raw, { now = new Date() } = {}) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, field: 'dateOfBirth', error: 'Enter your date of birth.' };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) {
    return { ok: false, field: 'dateOfBirth', error: 'Enter your date of birth as YYYY-MM-DD.' };
  }

  const dob = new Date(`${raw.trim()}T00:00:00Z`);
  if (Number.isNaN(dob.getTime())) {
    return { ok: false, field: 'dateOfBirth', error: 'That is not a real date.' };
  }
  if (dob.getTime() > now.getTime()) {
    return { ok: false, field: 'dateOfBirth', error: 'That date is in the future.' };
  }

  const age = ageOn(dob, now);

  // An implausible age is a typo (a mistyped year) far more often than a
  // supercentenarian signing up to volunteer, and letting it through puts a
  // meaningless birth date on the record for ever.
  if (age > 120) {
    return { ok: false, field: 'dateOfBirth', error: 'Please check the year.' };
  }

  if (age < MINIMUM_AGE) {
    return {
      ok: false,
      field: 'dateOfBirth',
      code: 'under_minimum_age',
      error: `You need to be ${MINIMUM_AGE} or older to use WeVolunteer.`,
    };
  }

  return { ok: true, value: raw.trim(), age };
}

export function validateAccountFields({ name, username, email, role, grade, bio, school, skills, avatar, dateOfBirth }) {
  if (typeof name !== 'string' || !name.trim()) {
    return { ok: false, field: 'name', error: 'Enter your full name.' };
  }
  if (name.trim().length > NAME_MAX) {
    return { ok: false, field: 'name', error: `Your name must be ${NAME_MAX} characters or fewer.` };
  }

  const emailResult = validateEmail(email);
  if (!emailResult.ok) return emailResult;

  const dobResult = validateDateOfBirth(dateOfBirth);
  if (!dobResult.ok) return dobResult;

  const usernameResult = validateUsername(username);
  if (!usernameResult.ok) return usernameResult;

  if (!SELF_ASSIGNABLE_ROLES.includes(role)) {
    return { ok: false, field: 'role', error: 'Role must be student or organizer.' };
  }
  if (!VALID_GRADES.includes(grade)) {
    return { ok: false, field: 'grade', error: `Grade must be one of: ${VALID_GRADES.join(', ')}` };
  }

  if (bio != null && (typeof bio !== 'string' || bio.length > BIO_MAX)) {
    return { ok: false, field: 'bio', error: `Your bio must be ${BIO_MAX} characters or fewer.` };
  }
  if (school != null && (typeof school !== 'string' || school.length > SCHOOL_MAX)) {
    return { ok: false, field: 'school', error: `That must be ${SCHOOL_MAX} characters or fewer.` };
  }
  if (avatar != null && (typeof avatar !== 'string' || avatar.length > 8)) {
    // Avatars are single emoji from a fixed palette. Anything longer is either
    // a mistake or an attempt to smuggle a payload into a rendered field.
    return { ok: false, field: 'avatar', error: 'Pick one of the available avatars.' };
  }

  let cleanSkills = [];
  if (skills != null) {
    if (!Array.isArray(skills)) {
      return { ok: false, field: 'skills', error: 'Skills must be a list.' };
    }
    if (skills.length > MAX_SKILLS) {
      return { ok: false, field: 'skills', error: `Please list ${MAX_SKILLS} skills or fewer.` };
    }
    if (skills.some(s => typeof s !== 'string' || s.length > SKILL_MAX)) {
      return { ok: false, field: 'skills', error: `Each skill must be text of ${SKILL_MAX} characters or fewer.` };
    }
    cleanSkills = skills.map(s => s.trim()).filter(Boolean);
  }

  return {
    ok: true,
    value: {
      name: name.trim(),
      email: emailResult.value,
      username: usernameResult.value,
      role,
      grade,
      dateOfBirth: dobResult.value,
      bio: bio == null ? '' : bio,
      school: school == null ? '' : school,
      avatar: avatar || '👤',
      skills: cleanSkills
    }
  };
}
