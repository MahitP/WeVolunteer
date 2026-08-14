import crypto from 'node:crypto';
import { ADDRESSES } from './emailIdentity.js';

/**
 * Reporting a problem with the platform.
 *
 * Distinct from `moderation.js`, which is for reporting a PERSON. See the
 * header on migration 051 for why the two must not share a queue.
 *
 * This module is the vocabulary and the rules; the route does the I/O. The
 * client imports the categories from `src/issueReports.js`, which re-exports
 * this file, so the dropdown and the server validation cannot drift — the same
 * arrangement `src/moderation.js` already uses, and for the same reason.
 *
 * It imports `node:crypto` and the address book, and nothing else. Keep it that
 * way: it is bundled into the browser.
 */

/**
 * The categories.
 *
 * Written as things a student would recognise about their own experience, not
 * as an engineering triage taxonomy. "Something isn't working" is what somebody
 * types; "Bug" is what we would call it afterwards.
 *
 * `replyTo` is which departmental mailbox a reply belongs in. It is here rather
 * than at the send site so that adding a category cannot silently route
 * somewhere wrong — a category with no `replyTo` fails the completeness test.
 */
export const ISSUE_CATEGORIES = Object.freeze([
  { value: 'bug', label: "Something isn't working", replyTo: 'support' },
  { value: 'account', label: 'Account or sign-in problem', replyTo: 'support' },
  { value: 'event', label: 'Problem with an opportunity', replyTo: 'support' },
  { value: 'organization', label: 'Problem with an organization', replyTo: 'support' },
  { value: 'profile', label: 'Problem with my profile', replyTo: 'support' },
  { value: 'accessibility', label: 'Accessibility problem', replyTo: 'support' },
  { value: 'information', label: 'Incorrect or out-of-date information', replyTo: 'support' },
  /**
   * Deliberately routed to `admin@` and NOT into the moderation queue.
   *
   * Somebody reporting a person should use Report on that person or event,
   * which preserves evidence and escalates a student reporting an adult. This
   * category exists because people will reach for the general form anyway, and
   * an enforcement address is a better landing place than a support inbox — but
   * the page also says where the proper control is.
   */
  { value: 'conduct', label: 'Inappropriate content or behaviour', replyTo: 'admin' },
  { value: 'privacy', label: 'Privacy concern', replyTo: 'privacy' },
  { value: 'security', label: 'Security concern', replyTo: 'security' },
  { value: 'legal', label: 'Legal or policy question', replyTo: 'legal' },
  { value: 'other', label: 'Something else', replyTo: 'support' },
]);

export const ISSUE_CATEGORY_VALUES = Object.freeze(ISSUE_CATEGORIES.map(c => c.value));

/** Categories whose contents must not be shown to ordinary staff surfaces. */
export const SENSITIVE_CATEGORIES = Object.freeze(['security', 'privacy']);

export const MIN_DESCRIPTION = 20;
export const MAX_DESCRIPTION = 4000;

/** The reply-to address for a category, from the one address book. */
export function replyToFor(category) {
  const found = ISSUE_CATEGORIES.find(c => c.value === category);
  return ADDRESSES[found?.replyTo || 'support'];
}

/** True when this category's contents deserve the narrower audience. */
export const isSensitive = (category) => SENSITIVE_CATEGORIES.includes(category);

/**
 * A human-quotable reference.
 *
 * `WV-` then eight characters from an unambiguous alphabet — no O/0, no I/1/L,
 * because this gets read down a phone and typed back. 32^8 is far more than
 * enough for a platform this size, and the UNIQUE column catches a collision
 * rather than trusting the arithmetic.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function newReference() {
  const bytes = crypto.randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return `WV-${out}`;
}

export const newIssueId = () => `issue-${crypto.randomUUID()}`;

/**
 * Validates a submission.
 *
 * @returns {{ok: true, value: object} | {ok: false, error: string, field: string}}
 */
export function validateIssue({ category, description } = {}) {
  if (!ISSUE_CATEGORY_VALUES.includes(category)) {
    return { ok: false, error: 'Choose what kind of problem this is.', field: 'category' };
  }

  const text = typeof description === 'string' ? description.trim() : '';
  /* Trimmed BEFORE measuring, so a field of spaces is empty rather than long. */
  if (!text) {
    return { ok: false, error: 'Tell us what happened.', field: 'description' };
  }
  if (text.length < MIN_DESCRIPTION) {
    return {
      ok: false,
      field: 'description',
      error: `Please add a little more — at least ${MIN_DESCRIPTION} characters, so we can act on it.`,
    };
  }
  if (text.length > MAX_DESCRIPTION) {
    return {
      ok: false,
      field: 'description',
      error: `Keep it to ${MAX_DESCRIPTION} characters or fewer.`,
    };
  }

  return { ok: true, value: { category, description: text } };
}

/**
 * The technical context worth keeping.
 *
 * An allowlist, not a filter. The client sends an object and this decides what
 * survives — so a future client that starts attaching something sensitive
 * cannot widen what is stored by changing only its own code.
 *
 * Everything here is about the SOFTWARE: which screen, how big the window, what
 * browser, which build. Nothing identifies the person beyond the account they
 * are already signed in as.
 */
export function sanitiseContext(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
  const num = (v) => (Number.isFinite(v) ? Math.round(v) : undefined);

  const out = {
    route: str(raw.route, 200),
    viewport: str(raw.viewport, 20),
    userAgent: str(raw.userAgent, 300),
    appVersion: str(raw.appVersion, 40),
    /* Only ids the reporter was already looking at, and only their shape. */
    eventId: str(raw.eventId, 80),
    organizationId: str(raw.organizationId, 80),
    screenWidth: num(raw.screenWidth),
  };

  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return Object.keys(out).length ? out : null;
}
