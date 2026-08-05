import { requiredConsentKeys } from './legalDocuments.js';
import { slugToKey } from './consent.js';

/**
 * A complete, valid consent block for signup requests, in a module that never
 * reaches `db.js`.
 *
 * ── Why this is its own file ──
 *
 * Signup now requires server-side consent, so every suite that creates an
 * account needs this object. The obvious home is `testServer.js`, and for most
 * suites that works — but `testServer.js` starts a real server and therefore
 * reaches `db.js`, which opens its database at module scope. Suites that must
 * control the database path (routes.verification.test.js,
 * routes.identityChange.test.js) import `testServer.js` *dynamically inside a
 * hook* for exactly that reason, which leaves the constant out of scope in
 * their test bodies.
 *
 * This module imports only `legalDocuments.js` and `consent.js`, neither of
 * which touches the database, so it is safe as a static top-level import in any
 * server test file. `testServer.js` re-exports it so suites that already import
 * from there do not need a second import.
 *
 * Derived from the document registry rather than hard-coded, so adding a
 * document that needs its own consent control does not silently leave every
 * suite constructing a payload the server will reject.
 */
export const TEST_CONSENT = {
  consent: Object.fromEntries(requiredConsentKeys().map(k => [slugToKey(k), true])),
};

/**
 * Everything a valid signup payload needs beyond the account's own fields.
 *
 * Consent plus a date of birth: both are now server-enforced requirements of
 * `POST /api/auth/signup`, so a suite that omits either is not testing its own
 * subject, it is constructing an invalid request.
 *
 * Kept separate from `TEST_CONSENT` rather than folded into it, because the two
 * answer different questions and a suite asserting on the consent record should
 * not silently be handed an age as well.
 *
 * The date is a fixed, comfortably-eligible one rather than "18 years before
 * now": a relative value makes the fixture drift with the clock, and a suite
 * that starts failing in 2043 for no visible reason is worse than one that
 * needs an obvious edit.
 */
export const TEST_SIGNUP_DEFAULTS = {
  ...TEST_CONSENT,
  dateOfBirth: '2007-06-15',
};
