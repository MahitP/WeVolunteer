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
import { isAvatarColor } from './avatarColors.js';

/** Roles a person may give themselves. Admin is seeded or promoted, never self-assigned. */
export const SELF_ASSIGNABLE_ROLES = ['student', 'organizer'];

export const LOCATION_MAX = 80;
export const USERNAME_MIN = 3;
export const USERNAME_MAX = 20;
const NAME_MAX = 100;
const BIO_MAX = 500;
const SCHOOL_MAX = 200;
const SKILL_MAX = 50;
/* One line under a name, and a short list beside it. Both are read at a glance
   on a profile header, which is what bounds them rather than storage. */
const HEADLINE_MAX = 120;
const HIGHLIGHT_MAX = 160;
const MAX_HIGHLIGHTS = 8;
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

  /**
   * A general area, and emphatically not an address.
   *
   * The bound is short on purpose — 80 characters holds "Example Valley, NJ"
   * with room to spare and does not comfortably hold a street address. That is
   * a nudge rather than a control, and the real work is done by the field's
   * placeholder and hint in ProfileEditModal, which say plainly not to use an
   * exact address. Nothing here is geocoded and there is no coordinate column
   * on `users`: an event's coordinates are a meeting point an organizer chose
   * to publish, a student's would be a minor's whereabouts, and no feature
   * needs one.
   */
  if (patch.location !== undefined) {
    if (patch.location !== null && typeof patch.location !== 'string') {
      return { ok: false, field: 'location', error: 'That must be text.' };
    }
    const location = (patch.location ?? '').trim();
    if (location.length > LOCATION_MAX) {
      return { ok: false, field: 'location', error: `Keep this to ${LOCATION_MAX} characters — a town or area, not an address.` };
    }
    out.location = location;
  }

  if (patch.hobbies !== undefined) {
    if (!Array.isArray(patch.hobbies)) {
      return { ok: false, field: 'hobbies', error: 'Hobbies must be a list.' };
    }
    if (patch.hobbies.length > MAX_SKILLS) {
      return { ok: false, field: 'hobbies', error: `Please list ${MAX_SKILLS} hobbies or fewer.` };
    }
    if (patch.hobbies.some(h => typeof h !== 'string' || h.length > SKILL_MAX)) {
      return { ok: false, field: 'hobbies', error: `Each hobby must be text of ${SKILL_MAX} characters or fewer.` };
    }
    out.hobbies = patch.hobbies.map(h => h.trim()).filter(Boolean);
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

  /**
   * The two fields a distinguished profile is written with.
   *
   * SHAPE is validated for everybody; whether the account may HOLD one at all is
   * decided by the route, from `distinctionFor(role)`.
   *
   * The split is deliberate. This function answers "is this a well-formed
   * headline", which does not depend on who is asking, and keeping a role
   * comparison out of it is the same discipline the rest of the repository
   * keeps. The route then refuses the write for an account with no distinction —
   * see the note there for why a student must not have one of these at all
   * rather than merely have it hidden.
   */
  if (patch.headline !== undefined) {
    if (patch.headline !== null && typeof patch.headline !== 'string') {
      return { ok: false, field: 'headline', error: 'That must be text.' };
    }
    const headline = (patch.headline ?? '').trim();
    if (headline.length > HEADLINE_MAX) {
      return { ok: false, field: 'headline', error: `Keep this to ${HEADLINE_MAX} characters — it is one line under your name.` };
    }
    out.headline = headline;
  }

  if (patch.highlights !== undefined) {
    if (!Array.isArray(patch.highlights)) {
      return { ok: false, field: 'highlights', error: 'Highlights must be a list.' };
    }
    if (patch.highlights.length > MAX_HIGHLIGHTS) {
      return { ok: false, field: 'highlights', error: `Please list ${MAX_HIGHLIGHTS} highlights or fewer.` };
    }
    if (patch.highlights.some(h => typeof h !== 'string' || h.length > HIGHLIGHT_MAX)) {
      return { ok: false, field: 'highlights', error: `Each highlight must be text of ${HIGHLIGHT_MAX} characters or fewer.` };
    }
    out.highlights = patch.highlights.map(h => h.trim()).filter(Boolean);
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

/* ── Graduation year ("Class of ____") ───────────────────────────────────── */

/**
 * The grades that have a graduation year, lowest first.
 *
 * `VALID_GRADES` also contains 'Adult' and 'N/A', which are the two values that
 * mean "not enrolled in high school". Neither has a class year, which is why
 * this list is separate rather than derived by trimming that one.
 */
export const HIGH_SCHOOL_GRADES = ['9', '10', '11', '12'];

/**
 * The calendar year the school year *currently in progress* ends in.
 *
 * A class is named for the year it graduates, not the year it started, so in
 * August 2026 the seniors are the Class of 2027. July is the boundary: months
 * January–June belong to a school year that ends in this calendar year, and
 * July–December to one that ends in the next.
 *
 * UTC throughout, matching `ageOn` above — a local-time read would move this
 * boundary by a day depending on where the server sits, and on 30 June or 1 July
 * that is a whole class year.
 */
export function schoolYearEndYear(now = new Date()) {
  const year = now.getUTCFullYear();
  return now.getUTCMonth() <= 5 ? year : year + 1;
}

/**
 * The class years a person may register with, computed from the clock.
 *
 * Derived, never written down, because a literal range is right for one school
 * year and quietly wrong for every one after it — "2027–2030" would still be
 * accepted in 2031, when it means "already graduated". The two ends come from
 * the eligibility rule itself:
 *
 *   - `min` — the current seniors. Anyone earlier has already graduated, so they
 *     are not a student here.
 *   - `max` — this year's incoming freshmen, i.e. `min` plus the number of grades
 *     above ninth. Anyone later is not in high school yet.
 *
 * The 13-year minimum age is NOT a term in this range, and deliberately: the
 * birth date answers that question exactly (`validateDateOfBirth`), and a class
 * year cannot — a ninth grader is usually 14 but may be 13, and folding an age
 * assumption in here would either duplicate the gate or contradict it.
 */
export function graduationYearRange(now = new Date()) {
  const min = schoolYearEndYear(now);
  return { min, max: min + HIGH_SCHOOL_GRADES.length - 1 };
}

/** The class year a person in `grade` graduates in, or null for a non-student grade. */
export function graduationYearForGrade(grade, now = new Date()) {
  const i = HIGH_SCHOOL_GRADES.indexOf(String(grade));
  if (i === -1) return null;
  return schoolYearEndYear(now) + (HIGH_SCHOOL_GRADES.length - 1 - i);
}

/**
 * The grade a class year puts someone in today, or null if that year is outside
 * the eligible range.
 *
 * This is the authoritative expression of grade level. See
 * `validateGraduationYear` for why it, and not a stored grade, is the truth.
 */
export function gradeForGraduationYear(year, now = new Date()) {
  const { min, max } = graduationYearRange(now);
  if (!Number.isInteger(year) || year < min || year > max) return null;
  return HIGH_SCHOOL_GRADES[HIGH_SCHOOL_GRADES.length - 1 - (year - min)];
}

/**
 * The class year, and the grade that follows from it.
 *
 * ── Which of the two is stored, and why it is this one ──
 *
 * Grade level and graduation year are the same fact expressed two ways, and
 * storing both as independently-editable columns would guarantee they eventually
 * disagree. Only one can be the truth, and it is the class year:
 *
 *   - A stored **grade** is wrong every August. Nothing advances it — no job, no
 *     login hook — so a tenth grader who signed up in 2026 is still recorded as
 *     a tenth grader when they graduate, and every eligibility question asked of
 *     that column gets a stale answer that looks perfectly valid.
 *   - A stored **class year** never changes and never needs to. "Class of 2029"
 *     is as true in 2031 as the day it was typed, and today's grade falls out of
 *     it with one subtraction.
 *
 * So `users.graduation_year` is the source of truth (migration 010) and grade is
 * DERIVED from it by `gradeForGraduationYear`. `users.grade` predates this and is
 * NOT NULL, so it still holds a value — but it is a materialisation of the
 * derived answer, and this function is the only thing that decides what goes in
 * it at signup. Recomputing it from `graduation_year` is always safe; the reverse
 * is not.
 *
 * ── Why a client-supplied grade is overridden rather than trusted ──
 *
 * A payload carrying both a class year and a grade is carrying one fact and one
 * claim. The claim loses: whatever `grade` says, the stored grade is recomputed
 * from the class year. That is the eligibility enforcement the product asked for
 * — it is what stops a request hand-written with `grade: '12'` and
 * `graduationYear: <freshman year>` from registering a ninth grader as a senior
 * and reaching whatever a school scopes to seniors. It also means the two columns
 * cannot be written in contradiction, because only one input decided both.
 *
 * ── Why an absent year is derived instead of refused ──
 *
 * Only at account creation, and only from the grade the applicant just picked:
 * at that instant "the grade I am in" is true by construction, so the class year
 * it implies is exact. This is the one-time conversion of a perishable claim
 * into the durable fact, not an ongoing fallback — nothing recomputes
 * `graduation_year` later, because after signup there is no fresh grade to
 * compute it from. A supplied year is still checked, and a supplied *bad* year is
 * refused rather than quietly replaced by the derived one.
 *
 * ── Adults ──
 *
 * Organizers register as `grade: 'Adult'`, and 'N/A' exists for the same reason.
 * A graduation year is meaningless for them, so it is null — never zero, never
 * the current year. A field mandatory for one role and meaningless for another
 * cannot be mandatory in a shared path, and supplying one anyway is refused
 * rather than ignored, so a stored year always means "this person is in school".
 *
 * @returns {{ok: true, value: number|null, grade?: string}
 *          | {ok: false, field: string, error: string}}
 */
export function validateGraduationYear(raw, { grade, now = new Date() } = {}) {
  const isStudentGrade = HIGH_SCHOOL_GRADES.includes(String(grade));
  const supplied = raw !== undefined && raw !== null && raw !== '';

  if (!supplied) {
    return { ok: true, value: isStudentGrade ? graduationYearForGrade(grade, now) : null };
  }

  if (!isStudentGrade) {
    return {
      ok: false,
      field: 'graduationYear',
      error: 'Only students in grades 9 through 12 have a graduation year.',
    };
  }

  // A number or a four-digit string, and nothing else. `Number('')` is 0 and
  // `Number('2027abc')` is NaN, so parsing is done by shape first: an accepted
  // year has to look like a year before it is compared to anything.
  const year = typeof raw === 'number' ? raw : (/^\d{4}$/.test(String(raw).trim()) ? Number(String(raw).trim()) : NaN);
  if (!Number.isInteger(year)) {
    return { ok: false, field: 'graduationYear', error: 'Choose the year you expect to graduate.' };
  }

  const { min, max } = graduationYearRange(now);
  const derivedGrade = gradeForGraduationYear(year, now);
  if (!derivedGrade) {
    // The range is named, because unlike the age gate there is nothing to teach
    // someone by naming it — a class year is not a secret, and a person who
    // mistyped one needs to know which years the platform serves.
    return {
      ok: false,
      field: 'graduationYear',
      error: `WeVolunteer is for students graduating between ${min} and ${max}. Choose one of those years.`,
    };
  }

  return { ok: true, value: year, grade: derivedGrade };
}

export function validateAccountFields({ name, username, email, role, grade, bio, school, skills, avatar, avatarColor, dateOfBirth, graduationYear }) {
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

  // Checked against the CLAIMED grade — the 'Adult'/'N/A' refusal needs to know
  // what the applicant said they were — and then it decides the grade that is
  // actually stored. See validateGraduationYear for why the claim does not win.
  const gradYear = validateGraduationYear(graduationYear, { grade });
  if (!gradYear.ok) return gradYear;
  const effectiveGrade = gradYear.grade ?? grade;

  if (bio != null && (typeof bio !== 'string' || bio.length > BIO_MAX)) {
    return { ok: false, field: 'bio', error: `Your bio must be ${BIO_MAX} characters or fewer.` };
  }
  if (school != null && (typeof school !== 'string' || school.length > SCHOOL_MAX)) {
    return { ok: false, field: 'school', error: `That must be ${SCHOOL_MAX} characters or fewer.` };
  }
  if (avatarColor !== undefined && !isAvatarColor(avatarColor)) {
    /* A key from the fixed palette, never a colour — see server/avatarColors.js. */
    return { ok: false, field: 'avatarColor', error: 'Pick one of the available colours.' };
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
    avatarColor: avatarColor === undefined ? undefined : avatarColor,
    value: {
      name: name.trim(),
      email: emailResult.value,
      username: usernameResult.value,
      role,
      grade: effectiveGrade,
      graduationYear: gradYear.value,
      dateOfBirth: dobResult.value,
      bio: bio == null ? '' : bio,
      school: school == null ? '' : school,
      avatar: avatar || '👤',
      skills: cleanSkills
    }
  };
}
