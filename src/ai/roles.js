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
 * told where to do a thing their role cannot do.
 *
 * And it was reached only after routing, so the decision lived in two places:
 * the router chose an intent, then something else decided whether it was
 * allowed. One table, consulted once, before anything runs, is easier to be
 * sure about than a check scattered across tools.
 *
 * ── Structured Results & Role-Aware Guidance ──
 *
 * `checkRole` returns structured verdicts `{ allowed, capability, reason }`
 * so the assistant can distinguish between missing permissions, out-of-scope
 * resources, and unrecognised intents.
 */

import { can } from '../authz.js';
import { TOOLS } from './tools.js';

/**
 * The capability each intent needs, or null when anyone signed in may ask.
 *
 * Every intent the router can produce appears here. That is enforced by a test
 * rather than by convention: an intent added to the router and forgotten here
 * would otherwise default to open, and the failure would be silent.
 */
export const INTENT_CAPABILITY = Object.freeze({
  /* Anyone's own record. `can` still requires a signed-in user. */
  my_hours: null,
  my_certificates: null,
  my_organizations: null,
  my_applications: null,
  my_next_shift: null,
  my_waitlists: null,
  my_notifications: null,
  my_profile: null,
  event_details: null,
  search_opportunities: null,
  verify_certificate: null,
  verify_certificate_missing_code: null,

  /* Informational platform questions — anyone may ask */
  info_how_events_work: null,
  info_how_applications_work: null,
  info_role_capabilities: null,
  info_selection: null,
  info_hours: null,
  info_certificates: null,
  info_organizations: null,

  /* Navigation — anyone signed in may ask to navigate */
  navigate: null,

  /* Student write actions (draft & confirm required) */
  withdraw_application: 'application.withdraw',
  update_profile: 'self.write',
  update_preferences: 'self.write',

  /* Running events & organizer tools */
  my_events: 'event.create',
  my_vacant_events: 'event.create',
  organizer_summary: 'event.create',
  event_roster: 'attendance.view',
  create_event: 'event.create',

  /* Looking after the platform & admin tools */
  platform_stats: 'analytics.platform',
  admin_reports_summary: 'report.resolve',
  admin_appeals_summary: 'appeal.review',
  system_health: 'error.read',
  recent_audit: 'audit.read',

  /* Conversation and confirmations */
  /**
   * `followup_why` and `reaction` answer from what was said a moment ago rather
   * than from a lookup, so they carry no capability.
   *
   * They were missing from this table while `assistant.js` already listed them
   * as conversational and `getConversationalReply` already handled them. An
   * intent absent here is not merely unrouted — `checkRole` returns
   * `unknownIntent` and the turn is REFUSED — so routing anything to them
   * before now would have answered "that is not something your account can ask
   * me for" to somebody typing "why?".
   *
   * `talk_check` is deliberately NOT here. It was, briefly, added alongside
   * these two on the assumption that it was the third of a set — but the router
   * has never emitted it and does not now: smalltalk ("can you talk?", "are you
   * a bot?") is folded into `greeting` by SMALLTALK, and answered by
   * `getConversationalReply` from there. An entry for an intent nothing produces
   * says a path exists when it does not, which is how the mistake propagates.
   * `intentCoverage.test.js` holds both directions of this now.
   */
  followup_why: null,
  reaction: null,
  confirm_action: null,
  cancel_action: null,
  greeting: null,
  affirmation: null,
  capabilities: null,
  /* Who Welly is, what this place is, and who the reader is. Everyone may ask;
     `my_name` reads the session's own user and nobody else's. */
  /* Arithmetic over what is already on screen — no record is read, so there is
     nothing here to authorise. */
  distance_to_event: null,
  identity_self: null,
  identity_platform: null,
  my_name: null,
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
 * Supports both positional `checkRole(user, intent)` and object
 * `checkRole({ user, intent, resource, context })`.
 *
 * Returns `{ allowed, capability, reason, unknownIntent }`:
 * - When allowed: `{ allowed: true, capability, reason: null }`
 * - When intent unknown: `{ allowed: false, capability: null, unknownIntent: true, reason: 'unknown_intent' }`
 * - When denied: `{ allowed: false, capability, reason: 'role_not_permitted' | 'resource_out_of_scope' }`
 */
export function checkRole(param1, param2) {
  let user = null;
  let intent = null;
  let resource = null;

  if (param1 && typeof param1 === 'object' && 'intent' in param1) {
    user = param1.user || null;
    intent = param1.intent || null;
    resource = param1.resource || null;
  } else {
    user = param1;
    intent = param2;
  }

  if (!Object.prototype.hasOwnProperty.call(INTENT_CAPABILITY, intent)) {
    return { allowed: false, capability: null, unknownIntent: true, reason: 'unknown_intent' };
  }

  const capability = INTENT_CAPABILITY[intent];
  if (!capability) {
    return { allowed: true, capability: null, reason: null };
  }

  if (!can(user, capability)) {
    return { allowed: false, capability, reason: 'role_not_permitted' };
  }

  /* Resource-level ownership check */
  if (resource && resource.userId && user && String(resource.userId) !== String(user.id)) {
    return { allowed: false, capability, reason: 'resource_out_of_scope' };
  }

  return { allowed: true, capability, reason: null };
}

/**
 * The things this person could actually ask for, derived from the tool registry and capabilities.
 */
export function abilitiesFor(user) {
  const out = [
    'find opportunities',
    'tell you your verified hours',
    'list your certificates and organizations',
    'show what you have applied to and when your next shift is',
    'show your recent notifications',
    'navigate to any page in the app',
    'explain how events, applications, hours, and Auto Select work',
  ];

  if (can(user, 'application.withdraw') && TOOLS.withdraw_application) {
    out.push(TOOLS.withdraw_application.userFacingAbility || 'withdraw an application you have submitted');
  }
  if (can(user, 'self.write') && TOOLS.update_profile) {
    out.push(TOOLS.update_profile.userFacingAbility || 'update your profile information');
  }

  if (can(user, 'event.create') && TOOLS.my_events) {
    out.push(TOOLS.my_events.userFacingAbility || 'show the events you run and how full they are');
    if (TOOLS.my_vacant_events) out.push(TOOLS.my_vacant_events.userFacingAbility || 'find which of your events need more volunteers');
    if (TOOLS.create_event) out.push(TOOLS.create_event.userFacingAbility || 'draft and create a new volunteer event');
  }
  if (can(user, 'attendance.view') && TOOLS.event_roster) {
    out.push(TOOLS.event_roster.userFacingAbility || 'view attendee check-in rosters for your events');
  }
  if (can(user, 'applicant.review')) {
    out.push('show who has applied to your events');
  }
  if (can(user, 'report.resolve') && TOOLS.admin_reports_summary) {
    out.push(TOOLS.admin_reports_summary.userFacingAbility || 'summarize open safety reports');
  }
  if (can(user, 'appeal.review') && TOOLS.admin_appeals_summary) {
    out.push(TOOLS.admin_appeals_summary.userFacingAbility || 'summarize pending suspension appeals');
  }
  if (can(user, 'analytics.platform') && TOOLS.platform_stats) {
    out.push(TOOLS.platform_stats.userFacingAbility || 'show platform totals');
  }
  if (can(user, 'audit.read') && TOOLS.recent_audit) {
    out.push(TOOLS.recent_audit.userFacingAbility || 'show the recent audit trail');
  }
  if (can(user, 'error.read') && TOOLS.system_health) {
    out.push(TOOLS.system_health.userFacingAbility || 'check system error health');
  }

  return out.filter(Boolean);
}

/**
 * What to say when somebody asks Welly to DO something without an automated workflow.
 */
export function actionReplyFor(user, { kind = 'event' } = {}) {
  const cannotAct = "I can look things up, but I can't create or change anything myself.";

  if (kind === 'event') {
    /**
     * An organizer CAN have Welly create an event now — `eventDraft.js` gathers
     * the details and `TOOLS.create_event` posts them — so this line is
     * reached for them only when the request was not a create-event request at
     * all. Saying "I can't create anything myself" to somebody who has just
     * been offered exactly that would be false, so it says what is true of the
     * thing they actually asked for.
     */
    return can(user, 'event.create')
      ? 'I can set up a new event with you — just say "create an event" and I will ask for the '
        + 'details. Editing or cancelling one already running is done from your dashboard.'
      : `${cannotAct} Creating events is something organizers do, so an organizer at your school would need to set it up. I can help you find one that already exists.`;
  }

  if (kind === 'decision') {
    return can(user, 'applicant.review')
      ? `${cannotAct} Applications are decided from the event's applicant list.`
      : `${cannotAct} Who gets a place is decided by the organizer running the event.`;
  }

  return `${cannotAct} I can show you what already exists, though.`;
}
