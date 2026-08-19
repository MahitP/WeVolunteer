/**
 * What the signed-in person may ask Welly to do.
 *
 * ── Why this is a layer and not a check inside each tool ──
 *
 * The capability was originally declared on the tool and checked inside
 * `runTool`. That was right as far as it went and had two gaps.
 *
 * It only covered intents that RUN a tool, so "create an event" — which runs
 * nothing — was answered identically for a student and an organizer: "Events
 * are set up from the Create event page." True for one of them. The student was
 * told where to do a thing their role cannot do, which is how the original
 * complaint started ("I was on a student account and it said it'll make an
 * event for me").
 *
 * And it was reached only after routing, so the decision lived in two places:
 * the router chose an intent, then something else decided whether it was
 * allowed. One table, consulted once, before anything runs, is easier to be
 * sure about than a check scattered across nine tools and a switch.
 *
 * ── What this is NOT ──
 *
 * It is not the security boundary. The server is, and always was: every tool
 * goes through `api.js` with the same cookie and the same authorization as the
 * rest of the app, so a student has never been able to READ an organizer's
 * data by asking nicely. What this decides is what Welly SAYS — whether the
 * answer is the data, or an honest "that is not something your account can do".
 *
 * The difference matters because the alternative is a 403 rendered as
 * "something went wrong", which reads as a broken assistant rather than as a
 * question that was never theirs to ask.
 */

import { can } from '../authz.js';

/**
 * The capability each intent needs, or null when anyone signed in may ask.
 *
 * Every intent the router can produce appears here. That is enforced by a test
 * rather than by convention: an intent added to the router and forgotten here
 * would otherwise default to open, and the failure would be silent.
 *
 * Only intents that EXIST. An earlier draft listed `event_roster`,
 * `open_reports` and `draft_event` — none of them built — which reads as a
 * description of what Welly can do and is not one. When those are added, their
 * capability goes here in the same commit.
 */
export const INTENT_CAPABILITY = Object.freeze({
  /* Anyone's own record. `can` still requires a signed-in user. */
  my_hours: null,
  my_certificates: null,
  my_organizations: null,
  my_applications: null,
  my_next_shift: null,
  my_waitlists: null,
  search_opportunities: null,
  verify_certificate: null,
  verify_certificate_missing_code: null,

  /* Running events. */
  my_events: 'event.create',
  organizer_summary: 'event.create',

  /* Looking after the platform. */
  platform_stats: 'analytics.platform',
  system_health: 'error.read',
  recent_audit: 'audit.read',

  /* Conversation and fixed answers need no capability — they read nothing. */
  greeting: null,
  capabilities: null,
  chat: null,
  unknown: null,
  empty: null,
  eligibility_question: null,
  action_request: null,
  refuse_other_user_data: null,
  refuse_credentials: null,
  refuse_account_action: null,
});

/**
 * Whether this person may ask for this intent.
 *
 * Returns `{ allowed, capability }` rather than a bare boolean so the caller can
 * say WHICH permission was missing when that is worth saying.
 *
 * An unknown intent is refused rather than allowed. A typo in a router matcher
 * should fail closed and be obvious, not quietly open a path — the same
 * reasoning `authz.js` gives for refusing an unrecognised capability string.
 */
export function checkRole(user, intent) {
  if (!Object.prototype.hasOwnProperty.call(INTENT_CAPABILITY, intent)) {
    return { allowed: false, capability: null, unknownIntent: true };
  }

  const capability = INTENT_CAPABILITY[intent];
  if (!capability) return { allowed: true, capability: null };

  return { allowed: can(user, capability), capability };
}

/**
 * The things this person could actually ask for, in the order worth offering.
 *
 * Used to answer "what can you do" and to tell somebody who asked for something
 * out of reach what IS in reach — a refusal that names an alternative is worth
 * several that do not.
 */
export function abilitiesFor(user) {
  const out = [
    'find opportunities',
    'tell you your verified hours',
    'list your certificates and organizations',
    'show what you have applied to and when your next shift is',
  ];

  if (can(user, 'event.create')) {
    out.push('show the events you run and how full they are');
  }
  if (can(user, 'applicant.review')) {
    out.push('show who has applied to your events');
  }
  if (can(user, 'analytics.platform')) {
    out.push('show platform totals');
  }
  if (can(user, 'audit.read')) {
    out.push('show the recent audit trail');
  }
  return out;
}

/**
 * What to say when somebody asks Welly to DO something.
 *
 * Role-aware, because "Events are set up from the Create event page" is a
 * helpful sentence for an organizer and a misleading one for a student — it
 * describes a door they cannot open. The student is told plainly that this is
 * not something their account does, and who to ask instead.
 */
export function actionReplyFor(user, { kind = 'event' } = {}) {
  const cannotAct = "I can look things up, but I can't create or change anything myself.";

  if (kind === 'event') {
    return can(user, 'event.create')
      ? `${cannotAct} You can set one up on the Create event page — I can show you what already exists if that helps.`
      : `${cannotAct} Creating events is something organizers do, so an organizer at your school would need to set it up. I can help you find one that already exists.`;
  }

  if (kind === 'decision') {
    return can(user, 'applicant.review')
      ? `${cannotAct} Applications are decided from the event's applicant list.`
      : `${cannotAct} Who gets a place is decided by the organizer running the event.`;
  }

  return `${cannotAct} I can show you what already exists, though.`;
}
