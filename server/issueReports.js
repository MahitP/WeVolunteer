import crypto from 'node:crypto';

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
 * ── This file runs in the browser, and that is a hard constraint ──
 *
 * It used to import `ADDRESSES` from `./emailIdentity.js`, whose first
 * statement is `process.env.MAIL_DOMAIN`. Under Vite's dev server that module
 * is served to the browser as written, `process` does not exist there, and the
 * read threw at import time — which took down `/report-issue` completely: the
 * page never rendered, the crash boundary caught it, and the one screen a
 * student reaches when everything else is broken showed "This page came off the
 * board".
 *
 * It survived a production BUILD only by accident (the bundler rewrites
 * `process.env` to `{}`, so the domain silently became the hardcoded fallback
 * rather than the configured one), and it survived the test suite because
 * Vitest runs under Node, where `process` exists.
 *
 * So the rule is stronger than "no database, no config": **nothing reachable
 * from here may touch a Node global at module scope.** `node:crypto` is fine —
 * the bundler stubs the import and the functions below are only ever called on
 * the server. A bare `process.env` read is not. `src/serverModuleBoundary.test.js`
 * enforces this.
 *
 * The routing value is therefore a KEY (`'support'`, `'security'`), not
 * an address. `server/routes/issueRoutes.js` resolves it against the address
 * book, which keeps the mail identity where the mail is sent and keeps the
 * address book out of the browser bundle entirely.
 */

/**
 * The categories.
 *
 * Written as things a student would recognise about their own experience, not
 * as an engineering triage taxonomy. "Something isn't working" is what somebody
 * types; "Bug" is what we would call it afterwards.
 *
 * Which departmental mailbox a reply belongs in lives in
 * `server/issueRouting.js` rather
 * than at the send site so that adding a category cannot silently route
 * somewhere wrong — a category missing from that map fails the completeness
 * test. That module is server-only ON PURPOSE: this one is compiled into the
 * browser bundle, and the mailbox keys must not be.
 */
export const ISSUE_CATEGORIES = Object.freeze([
  { value: 'bug', label: "Something isn't working" },
  { value: 'account', label: 'Account or sign-in problem' },
  { value: 'event', label: 'Problem with an opportunity' },
  { value: 'organization', label: 'Problem with an organization' },
  { value: 'profile', label: 'Problem with my profile' },
  { value: 'accessibility', label: 'Accessibility problem' },
  { value: 'information', label: 'Incorrect or out-of-date information' },
  /**
   * Deliberately routed to `admin@` and NOT into the moderation queue.
   *
   * Somebody reporting a person should use Report on that person or event,
   * which preserves evidence and escalates a student reporting an adult. This
   * category exists because people will reach for the general form anyway, and
   * an enforcement address is a better landing place than a support inbox — but
   * the page also says where the proper control is.
   */
  { value: 'conduct', label: 'Inappropriate content or behavior' },
  { value: 'privacy', label: 'Privacy concern' },
  { value: 'security', label: 'Security concern' },
  { value: 'legal', label: 'Legal or policy question' },
  { value: 'other', label: 'Something else' },
]);

/* Reply routing lives in `server/issueRouting.js`, which nothing under `src/`
   imports — see that file for why the two earlier attempts to keep these keys
   out of the browser bundle both failed. */

export const ISSUE_CATEGORY_VALUES = Object.freeze(ISSUE_CATEGORIES.map(c => c.value));

/** Categories whose contents must not be shown to ordinary staff surfaces. */
export const SENSITIVE_CATEGORIES = Object.freeze(['security', 'privacy']);

export const MIN_DESCRIPTION = 20;
export const MAX_DESCRIPTION = 4000;


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
