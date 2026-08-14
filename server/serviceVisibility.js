/**
 * Who may see somebody's service history, and who may see their certificates.
 *
 * ── Why this is one module and not a condition at each call site ──
 *
 * There are four places that answer the question — the public profile, the
 * volunteer profile endpoint, the public certificate collection, and the
 * directory card — and a privacy rule spread across four `if` statements is a
 * rule that will be enforced in three of them. The one that gets missed is the
 * one an attacker uses, and nothing about the other three failing to catch it
 * looks wrong in review.
 *
 * So the decision is made here, once, and every surface asks.
 *
 * ── The rule ──
 *
 *   The subject always sees their own.
 *   Staff who may already read contact PII see it (they can already read the
 *     ledger through the administrative surfaces; hiding it here would be a
 *     control that protects nothing while making moderation harder).
 *   Everybody else sees it only if the subject has left it public.
 *
 * Deliberately NOT tied to `profile_visibility`. That setting governs school,
 * year group and bio, and its 'friends' value has a meaning — "people I have
 * accepted" — that does not transfer: a student may be happy for the whole
 * school to see they volunteered 40 hours while keeping their year group to
 * friends, or exactly the reverse. Two questions, two answers.
 *
 * ── Why unknown reads as public ──
 *
 * Anything that is not exactly `'private'` is public. The opposite convention
 * sounds safer and is worse: a typo, a missed migration or a NULL would blank
 * the service record of every student at once, silently, and none of them could
 * tell a bug from a product decision. Failing towards the behaviour that was
 * already in place is the recoverable direction.
 */

/** The values a visibility column may hold. */
export const VISIBILITY_VALUES = Object.freeze(['public', 'private']);

/** Normalises anything to one of the two values. See the header on direction. */
export function normaliseVisibility(value) {
  return value === 'private' ? 'private' : 'public';
}

/** True when the value is one a client may store. */
export function isValidVisibility(value) {
  return VISIBILITY_VALUES.includes(value);
}

/**
 * May this viewer see this subject's service history (shifts, hours, totals)?
 *
 * @param {object} subjectRow  the subject's `users` row
 * @param {object} opts
 * @param {string|null} opts.viewerId
 * @param {boolean} opts.canSeeContact  viewer holds `user.contact.read`
 */
export function canSeeHours(subjectRow, { viewerId = null, canSeeContact = false } = {}) {
  if (viewerId && subjectRow?.id === viewerId) return true;
  if (canSeeContact) return true;
  return normaliseVisibility(subjectRow?.hours_visibility) === 'public';
}

/** May this viewer see this subject's certificates? Same rule, own column. */
export function canSeeCertificates(subjectRow, { viewerId = null, canSeeContact = false } = {}) {
  if (viewerId && subjectRow?.id === viewerId) return true;
  if (canSeeContact) return true;
  return normaliseVisibility(subjectRow?.certificates_visibility) === 'public';
}

/**
 * The shape every surface reports so the client can say WHY something is absent.
 *
 * The setting itself is disclosed; the data behind it is not. That is not a
 * leak — "this student keeps their hours private" is what the page has to say
 * instead of rendering an empty list that reads as "this student has never
 * volunteered". Silently showing zero would be a worse answer than the truth,
 * and it would be a lie about a person.
 */
export function visibilityState(subjectRow, opts) {
  return {
    hours: canSeeHours(subjectRow, opts) ? 'visible' : 'private',
    certificates: canSeeCertificates(subjectRow, opts) ? 'visible' : 'private',
  };
}
