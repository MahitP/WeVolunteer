/**
 * The product events this application deliberately sends to Amplitude.
 *
 * ── Why a registry now, when `src/utils/analytics.js` argued against one ──
 *
 * That module's header says it is "deliberately small… no event registry. There
 * is one event today", and that was the right call for one event. Two things
 * changed it. The Owner Center has to ASK Amplitude for these events by name,
 * so a second copy of every string would otherwise appear on the server — and a
 * typo in that copy produces a chart that reads zero, which is
 * indistinguishable from a feature nobody uses. And the certificate work below
 * adds three events, which is the point at which "the list" becomes a thing
 * rather than a line.
 *
 * So this stays a LIST OF NAMES, not an analytics layer. `trackAmplitudeEvent`
 * is unchanged and still takes a string; this is what the two callers agree on.
 *
 * ── The privacy rule these are chosen under ──
 *
 * `src/utils/analytics.js` states it: nothing identifying a person may go in an
 * event's properties — no names, no addresses, no school, no year group, no
 * tokens, no free text a user typed. Every event here is a bare verb with no
 * properties at all, which is the strongest form of that rule and the reason
 * none of them needed a privacy argument of its own. On a platform whose users
 * are minors, "how many certificates were downloaded" is a fact about the
 * product; "who downloaded one" is not ours to collect for a usage chart.
 *
 * Analytics is opt-in and off by default (see `useAnalyticsConsent.js`), so
 * every one of these fires only for somebody who said yes.
 *
 * ── Free-plan note ──
 *
 * Amplitude's free Starter plan allows 10,000 monthly tracked users and 2
 * million events. These are all low-frequency, deliberate actions — a
 * certificate is viewed once in a while, not on every render — so the registry
 * cannot become the reason a deployment outgrows the free tier. Anything that
 * would fire on scroll, on keystroke or on every page paint does not belong
 * here; autocapture already covers page views, and it is the SDK's own budget.
 *
 * Pure: this module imports nothing and reads no environment, because
 * `src/serverModuleBoundary.test.js` requires that of any server module the
 * browser bundle pulls in.
 */

/**
 * @typedef {{ name: string, label: string, description: string }} AnalyticsEvent
 */

/** @type {readonly AnalyticsEvent[]} */
export const ANALYTICS_EVENTS = Object.freeze([
  Object.freeze({
    name: 'Viewed Home Page',
    label: 'Home page',
    description: 'The installation marker — a consenting member arriving at the dashboard.',
  }),
  Object.freeze({
    name: 'Viewed Certificate',
    label: 'Certificates opened',
    description: 'A volunteer opened one of their own certificates in the viewer.',
  }),
  Object.freeze({
    name: 'Downloaded Certificate',
    label: 'Certificates downloaded',
    description: 'A certificate PDF was downloaded, or sent to the printer.',
  }),
  Object.freeze({
    name: 'Shared Certificate',
    label: 'Certificates shared',
    description: 'A verification link was copied, or handed to the device share sheet.',
  }),
]);

/** The names alone, for the Amplitude query and for a test to assert against. */
export const ANALYTICS_EVENT_NAMES = Object.freeze(ANALYTICS_EVENTS.map(e => e.name));

/**
 * Addressable names, so a caller writes `EVENT.VIEWED_CERTIFICATE` rather than a
 * string literal. Same argument as `ROLE` in authz.js: a typo in an identifier
 * is a build failure, a typo in a string literal is a silent absence.
 */
export const EVENT = Object.freeze({
  VIEWED_HOME_PAGE: 'Viewed Home Page',
  VIEWED_CERTIFICATE: 'Viewed Certificate',
  DOWNLOADED_CERTIFICATE: 'Downloaded Certificate',
  SHARED_CERTIFICATE: 'Shared Certificate',
});
