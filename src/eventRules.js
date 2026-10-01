/**
 * The event rules, re-exported from the server module that owns them.
 *
 * Re-exported, never copied — the same arrangement as `src/externalHoursRules.js`,
 * `src/eventCategories.js` and `src/authz.js`, and for the reason recorded in
 * all three: a duplicated rule stops matching the original without anything
 * failing, and the bug shows up much later as data being quietly refused or
 * quietly accepted.
 *
 * ── Why Welly needs this and the form does not ──
 *
 * `CreateEvent.jsx` checks the same rules field by field, because a form has
 * fields to attach a message to and a "Set an application deadline" belongs
 * beside the deadline input. Welly has no fields. It has a payload it is about
 * to POST and one question to answer about it — "can this be created?" — which
 * is exactly what `validateEventPayload` answers, and answers with the same
 * verdict the server will reach a moment later.
 *
 * That matters more here than anywhere else in the client. Welly SAYS whether
 * an event can be created before it tries, so a check of its own that drifted
 * from the server's would make it confidently wrong in both directions: an
 * organizer told their event is fine and then refused, or told it is impossible
 * when it is not.
 *
 * The server is still the authority. This is the same function, run early, so
 * the answer given in conversation is the answer the API will give — and the
 * API runs it again on the request regardless of anything decided here.
 *
 * `server/validation.js` is a pure function with no imports at all, which is
 * what makes this safe to pull into the browser bundle.
 * `serverModuleBoundary.test.js` is what keeps that true.
 */
export { validateEventPayload, deadlineAfterFirstShift, MAX_SLOT_HOURS } from '../server/validation.js';
