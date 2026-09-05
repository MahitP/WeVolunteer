/**
 * Who a message is from, and where a reply to it goes.
 *
 * ── Why this is a module and not a constant ──
 *
 * Every outbound message in this codebase used the same `EMAIL_FROM` string —
 * one address for the login code, the suspension notice, the privacy-policy
 * update and the "someone commented on your event" digest alike. That is not a
 * cosmetic problem. A recipient uses the From line to decide whether a message
 * is worth opening and whether it is genuine, and a support mailbox that
 * receives bounces from bulk notification mail is a support mailbox nobody
 * reads.
 *
 * So the sender is now a function of what the message IS.
 *
 * ── The rule that is not negotiable ──
 *
 * Every authentication message is from `noreply@wevolunteers.org`, displayed as
 * `WeVolunteer`. Verification, password reset, reset confirmation, email change
 * in both directions, the login 2FA code, the admin invitation, and the
 * security notices that tell somebody their recovery code was used — all of it.
 *
 * That set is `AUTH_FLOWS` below, and `identityFor` throws if an auth flow ever
 * resolves to anything else. The check is not decoration: the failure it guards
 * against is a future edit adding a flow to the wrong category and nothing
 * noticing until a password-reset mail goes out from an address the domain's
 * SPF record was never set up to send.
 *
 * ── Why auth mail has no Reply-To ──
 *
 * Because a reply to it carries a live credential. People do reply to these —
 * "it says my code is 418294 and it still won't let me in" — and a Reply-To
 * would deliver that code, or a single-use reset link, into a shared mailbox
 * with a much longer life than the token was designed to have. The body tells
 * them where to get help instead. `noreply@` is not laziness here; it is the
 * accurate description of what should happen to a reply.
 *
 * Every other category sets a Reply-To on purpose, because for those a reply is
 * the point.
 *
 * ── Why `mahit@` is barely used ──
 *
 * It identifies a named human being. It belongs on mail that is genuinely from
 * that person, and on nothing else. An automated message signed by a person is
 * a small lie that costs trust when the recipient replies and gets silence.
 */

/** The domain the platform actually sends as. One place. */
export const MAIL_DOMAIN = process.env.MAIL_DOMAIN || 'wevolunteers.org';

const at = (local) => `${local}@${MAIL_DOMAIN}`;

/**
 * The official addresses. Named rather than spelled out at each use site so a
 * domain move is one edit and a typo is a missing export rather than a message
 * silently sent from a mailbox that does not exist.
 */
export const ADDRESSES = {
  admin: at('admin'),
  security: at('security'),
  legal: at('legal'),
  privacy: at('privacy'),
  platform: at('platform'),
  contact: at('contact'),
  support: at('support'),
  noreply: at('noreply'),
  owner: at('mahit'),
};

/** The one display name users should learn to recognise. */
export const BRAND = 'WeVolunteer';

/** RFC 5322 display-name quoting. A comma or a quote in the name breaks the header. */
function formatAddress(displayName, address) {
  if (!displayName) return address;
  const escaped = String(displayName).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}" <${address}>`;
}

/**
 * The categories, and what each one means.
 *
 * `replyTo: null` is a deliberate statement, not an omission — see the header.
 */
const CATEGORIES = {
  /** Anything that proves, grants, changes or protects access to an account. */
  auth: { from: ADDRESSES.noreply, display: BRAND, replyTo: null },

  /** Ordinary platform activity: applications, shifts, reminders, comments. */
  notification: { from: ADDRESSES.contact, display: BRAND, replyTo: ADDRESSES.support },

  /** A person asked for help, or the message invites them to ask. */
  support: { from: ADDRESSES.support, display: `${BRAND} Support`, replyTo: ADDRESSES.support },

  /** Suspensions, bans, removals, appeals, administrator role changes. */
  enforcement: { from: ADDRESSES.admin, display: `${BRAND} Admin`, replyTo: ADDRESSES.admin },

  /** Policy and agreement changes. */
  legal: { from: ADDRESSES.legal, display: `${BRAND} Legal`, replyTo: ADDRESSES.legal },

  /** Data access, correction and deletion. */
  privacy: { from: ADDRESSES.privacy, display: `${BRAND} Privacy`, replyTo: ADDRESSES.privacy },

  /** Safety and security reports and escalations. */
  security: { from: ADDRESSES.security, display: `${BRAND} Security`, replyTo: ADDRESSES.security },

  /** Mail to the people who run the deployment, never to a user. */
  platform: { from: ADDRESSES.platform, display: `${BRAND} Platform`, replyTo: ADDRESSES.platform },

  /** Genuinely from the named owner, as a person. */
  owner: { from: ADDRESSES.owner, display: 'Mahit Pulavarthi', replyTo: ADDRESSES.owner },
};

/**
 * Every flow that authenticates, or that tells somebody their access changed.
 *
 * `email-change-notice` is in here even though it is a notification in tone: it
 * goes to the OLD address to say "somebody is moving your account", which is the
 * last warning a person gets before losing it. That is authentication mail.
 *
 * `recovery-code-used` likewise — it is the message that tells you a second
 * factor you did not use has just been spent.
 */
export const AUTH_FLOWS = new Set([
  'verification',
  'admin-invitation',
  'password-reset',
  'password-reset-confirmed',
  'email-change-confirm',
  'email-change-notice',
  '2fa-code',
  'account-linked',
  'recovery-code-used',
]);

/** Flow → category. Anything not named here is `notification`. */
const FLOW_CATEGORY = {
  'notification-direct': 'notification',
  'error-alert': 'platform',
  'legal-document-updated': 'legal',
};

/**
 * Notification EVENTS that are not ordinary activity. The outbox worker passes
 * its event name through here, so an enforcement notice does not go out looking
 * like a shift reminder.
 */
const EVENT_CATEGORY = {
  LEGAL_DOCUMENT_UPDATED: 'legal',
  LEGAL_ACCEPTANCE_REQUIRED: 'legal',

  ACCOUNT_SUSPENDED: 'enforcement',
  ACCOUNT_WARNED: 'enforcement',
  ACCOUNT_REINSTATED: 'enforcement',
  APPEAL_DECISION_STANDS: 'enforcement',
  APPEAL_DECISION_REVERSED: 'enforcement',
  APPEAL_REOPENED: 'enforcement',
  ORGANIZATION_BANNED: 'enforcement',
  ORGANIZATION_BAN_APPEAL_STANDS: 'enforcement',
  ORGANIZATION_BAN_APPEAL_REVERSED: 'enforcement',
  ORGANIZATION_BAN_LIFTED: 'enforcement',
  ORGANIZATION_MEMBERSHIP_REMOVED: 'enforcement',
  REMOVED_FROM_EVENT: 'enforcement',
  ADMIN_PROMOTED: 'enforcement',
  ADMIN_REVOKED: 'enforcement',

  /* An authentication event that happens to arrive through the notification
     outbox. It is still authentication mail, and `identityFor` enforces that. */
  RECOVERY_CODE_USED: 'auth',
};

/** The category a notification event belongs to. */
export function categoryForEvent(event) {
  return EVENT_CATEGORY[event] || 'notification';
}

/**
 * The From and Reply-To for a flow.
 *
 * @param {string} flow    a transactional flow tag, or a category name
 * @param {object} [opts]
 * @param {string} [opts.event]  a notification event name, when the flow is the
 *                               generic outbox one
 * @returns {{from: string, replyTo: string|null, category: string}}
 */
export function identityFor(flow, { event } = {}) {
  let category;
  if (event) category = categoryForEvent(event);
  else if (CATEGORIES[flow]) category = flow;
  else if (AUTH_FLOWS.has(flow)) category = 'auth';
  else category = FLOW_CATEGORY[flow] || 'notification';

  const spec = CATEGORIES[category];
  if (!spec) throw new Error(`No email identity for category "${category}" (flow "${flow}")`);

  /**
   * The guard the whole file exists for. If a flow is authentication, it sends
   * as noreply or it does not send. A wrong category here is not a cosmetic
   * slip — it is a password-reset mail leaving from an address the domain never
   * authorised, which lands in spam for the people least able to work around it.
   */
  const isAuth = AUTH_FLOWS.has(flow) || (event && categoryForEvent(event) === 'auth');
  if (isAuth && spec.from !== ADDRESSES.noreply) {
    throw new Error(
      `"${flow}" is an authentication flow, so it must send from ${ADDRESSES.noreply}, `
      + `not ${spec.from}. Either it belongs in a different category or AUTH_FLOWS is wrong.`
    );
  }

  return {
    from: formatAddress(spec.display, spec.from),
    replyTo: spec.replyTo,
    category,
  };
}

export const __testing = { formatAddress, CATEGORIES };
