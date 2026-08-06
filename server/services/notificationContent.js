/**
 * The published fallback channel, named in the Community Guidelines and the
 * Privacy Policy. One definition, because a student locked out of their account
 * has nothing else and a typo here is a dead end.
 */
export const SUPPORT_EMAIL = 'wevolunteer.platform@gmail.com';

/**
 * Notices that are served, not sent — the enforcement class.
 *
 * `dispatch` consults `users.email_opt_out` and the per-category notification
 * preference before enqueuing mail. For everything in this set it must not,
 * and the reason is not a product preference:
 *
 *   - A suspended account is refused at `authenticateToken` (utils.js) before
 *     `req.user` exists, so it can never read `GET /api/notifications`. Email is
 *     the ONLY channel that reaches a suspended person. An audit reproduced a
 *     student with `email_opt_out = 1` being suspended and receiving zero email
 *     jobs — an appeal token existed in the database that they had no way to
 *     learn about. That is a permanent lockout with no appeal channel.
 *   - These carry no promotional content. They are transactional messages about
 *     the recipient's own account standing, which is what makes suppressing them
 *     a failure to serve notice rather than an honoured preference.
 *   - `docs/legal/policies/01-privacy-policy.md` already publishes "Security
 *     emails cannot be switched off." This set makes the code match a statement
 *     the product has been making to users all along; it is not a new override.
 *
 * Deliberately a closed literal set rather than an `ignoreOptOut` flag any
 * caller may pass — a flag becomes an override for anything within two
 * releases. Adding a member is a reviewed change, and
 * `notificationContent.coverage.test.js` asserts every member has content.
 *
 * The reciprocal duty is the point: the override is only defensible because the
 * notice is genuinely necessary, which obliges the same treatment for the GOOD
 * news. Reinstatement and a granted appeal are in this set for that reason.
 */
export const MANDATORY_NOTICE_EVENTS = new Set([
  'ACCOUNT_SUSPENDED',
  'ACCOUNT_REINSTATED',
  'APPEAL_DECISION_STANDS',
  'APPEAL_DECISION_REVERSED',
  'APPEAL_REOPENED',
  /**
   * The urgent safety-report alert.
   *
   * `reportService.js` dispatches this to every moderator when a report's DERIVED
   * priority is `urgent` — which a student reporting an adult always is, whatever
   * category they picked. Its own comment calls this notification "the only thing
   * standing between that promise and a queue nobody happened to refresh".
   *
   * It was not in this set, so `dispatch()` fell through to the ordinary preference
   * path and computed
   * `emailEnabled = user.email_opt_out === 1 ? false : getPref('email')`. A
   * moderator who had turned email off — globally, or just for this event's
   * category — received nothing. On a platform whose entire moderator population is
   * one person, that made a user-preference toggle the only thing between a
   * child-safety report and an unread queue.
   *
   * Every other entry here is a notice the recipient must receive whatever their
   * preferences say: being suspended, being reinstated, an appeal outcome. A report
   * that may CAUSE a suspension is at least as consequential as the suspension
   * notice that follows it.
   *
   * Deliberately scoped to the urgent path only. Normal-priority reports still
   * dispatch nothing at all (`reportService.js`), because an alert that fires for
   * everything is an alert people learn to close — and
   * `reportService.alerting.test.js` pins both halves of that.
   */
  'SYSTEM_ALERT',
]);

export const isMandatoryNotice = (event) => MANDATORY_NOTICE_EVENTS.has(event);

export const EVENT_CATEGORIES = {
  // APPLICATION
  APPLICATION_SUBMITTED: 'APPLICATION',
  APPLICATION_ACCEPTED: 'APPLICATION',
  APPLICATION_REJECTED: 'APPLICATION',
  // Was missing entirely, so it resolved to SYSTEM and never showed under the
  // Applications filter. See the getInAppContent case below.
  APPLICATION_WAITLISTED: 'APPLICATION',
  WAITLIST_PROMOTED: 'APPLICATION',
  WAITLIST_PROMOTION_MADE: 'APPLICATION',
  // Organizer-facing "your deadline passed, applicants are waiting". Its content
  // case already hardcoded kind:'APPLICATION'; this makes the preference lookup
  // agree with it instead of falling back to SYSTEM.
  DECISION_NEEDED: 'APPLICATION',
  REMOVED_FROM_EVENT: 'APPLICATION',
  NEW_APPLICATION: 'APPLICATION',
  SPOT_RELEASED: 'APPLICATION',
  VOLUNTEER_RELEASED_SPOT: 'APPLICATION',

  // EVENT
  /**
   * These two were dispatched but never declared here, which had two silent
   * consequences: `dispatch()` resolved their category to 'SYSTEM', so the
   * per-category preference check consulted the wrong switch (a volunteer who
   * had turned Event notifications off still got deadline reminders, and one who
   * had turned System off lost them), and `getInAppContent` derived `kind` from
   * the same lookup — so a deadline reminder was filed under System and never
   * appeared under the Events filter. DECISION_NEEDED hardcoded
   * `kind: 'APPLICATION'` in its own case, which masked half the problem while
   * leaving the preference lookup wrong.
   */
  EVENT_DEADLINE_APPROACHING: 'EVENT',
  EVENT_REMINDER_24H: 'EVENT',
  EVENT_REMINDER_2H: 'EVENT',
  EVENT_CANCELLED: 'EVENT',
  EVENT_UPDATED: 'EVENT',
  EVENT_LOCATION_CHANGED: 'EVENT',
  EVENT_TIME_CHANGED: 'EVENT',
  EVENT_FULL: 'EVENT',
  SPOT_AVAILABLE: 'EVENT',
  SCHEDULE_CONFLICT_WARNING: 'EVENT',

  // VOLUNTEER
  HOURS_APPROVED: 'VOLUNTEER',
  HOURS_ADJUSTED: 'VOLUNTEER',
  CERTIFICATE_AVAILABLE: 'VOLUNTEER',
  CERTIFICATE_REVOKED: 'VOLUNTEER',

  // ACCOUNT
  ORGANIZER_APPROVED: 'ACCOUNT',
  PASSWORD_CHANGED: 'ACCOUNT',
  PASSWORD_RESET: 'ACCOUNT',
  EMAIL_VERIFIED: 'ACCOUNT',
  ACCOUNT_SUSPENDED: 'ACCOUNT',
  ACCOUNT_REINSTATED: 'ACCOUNT',
  APPEAL_DECISION_STANDS: 'ACCOUNT',
  APPEAL_DECISION_REVERSED: 'ACCOUNT',
  APPEAL_REOPENED: 'ACCOUNT',

  // SYSTEM
  MAINTENANCE_NOTICE: 'SYSTEM',
  IMPORTANT_ANNOUNCEMENT: 'SYSTEM',
  // Operational alerts about a request the user made about their own account —
  // today, data-export ready/failed from the export worker. ACCOUNT rather than
  // SYSTEM because it concerns their data, not the platform's health.
  SYSTEM_ALERT: 'ACCOUNT',

  // MESSAGES
  DIRECT_MESSAGE: 'MESSAGES',
  EVENT_COMMENT: 'MESSAGES'
};

export const NOTIFICATION_PRIORITY = {
  CRITICAL: 'CRITICAL',
  IMPORTANT: 'IMPORTANT',
  NORMAL: 'NORMAL',
  LOW: 'LOW'
};

export function getInAppContent(event, payload) {
  // Return { kind, priority, title, body, link }
  const kind = EVENT_CATEGORIES[event] || 'SYSTEM';

  switch (event) {
    case 'APPLICATION_ACCEPTED':
      return {
        kind,
        priority: NOTIFICATION_PRIORITY.IMPORTANT,
        title: 'You were accepted!',
        body: `You are officially scheduled for ${payload.eventTitle}.`,
        link: `event:${payload.eventId}`
      };
    case 'APPLICATION_REJECTED':
      return {
        kind,
        priority: NOTIFICATION_PRIORITY.NORMAL,
        title: 'Application update',
        body: `Your application for ${payload.eventTitle} was not accepted.`,
        link: `event:${payload.eventId}`
      };
    /**
     * Being waitlisted.
     *
     * This case did not exist, and neither did an `APPLICATION_WAITLISTED` entry
     * in EVENT_CATEGORIES — so all three dispatch sites fell through to
     * `default:` and every waitlisted volunteer was told, literally:
     *
     *     SYSTEM · NORMAL · "Notification" · "You have a new notification."
     *
     * with no link. Four things were wrong at once: the copy said nothing, the
     * category was SYSTEM so it never appeared under the Applications filter,
     * there was nothing to tap, and NORMAL priority meant the 30-day retention
     * sweep deleted it — unlike acceptance (IMPORTANT) or cancellation
     * (CRITICAL).
     *
     * IMPORTANT, not NORMAL: waitlisting is one of the three answers an
     * organizer can give, and the volunteer needs it to survive in their history
     * for as long as the acceptance would have.
     */
    case 'APPLICATION_WAITLISTED':
      return {
        kind,
        priority: NOTIFICATION_PRIORITY.IMPORTANT,
        title: 'You are on the waitlist',
        body: payload.waitlistRank
          // Auto Select already computes this rank and used to discard it.
          ? `You are number ${payload.waitlistRank} on the waitlist for ${payload.eventTitle}. `
            + 'A spot may become available if another volunteer withdraws.'
          : `You are on the waitlist for ${payload.eventTitle}. `
            + 'A spot may become available if another volunteer withdraws.',
        link: `event:${payload.eventId}`
      };
    case 'WAITLIST_PROMOTED':
      return {
        kind,
        priority: NOTIFICATION_PRIORITY.IMPORTANT,
        title: 'A spot opened! You are now accepted',
        body: payload.slotName
          ? `You've been moved off the waitlist for ${payload.eventTitle} (${payload.slotName}). You're confirmed!`
          : `You've been moved off the waitlist for ${payload.eventTitle}. You're confirmed!`,
        link: `event:${payload.eventId}`
      };
    /**
     * The organizer's side of a promotion.
     *
     * Previously dispatched as a bare `SYSTEM` event carrying its own title and
     * body through the `default:` passthrough — which worked, but filed an
     * applications event under System and bypassed the one place notification
     * copy is supposed to live. It is a real event with a real category now.
     */
    case 'WAITLIST_PROMOTION_MADE':
      return {
        kind,
        priority: NOTIFICATION_PRIORITY.NORMAL,
        title: 'Waitlist filled a spot',
        body: `${payload.volunteerName} moved off the waitlist into the open spot on `
          + `"${payload.eventTitle}"${payload.slotName ? ` (${payload.slotName})` : ''}.`,
        link: `event:${payload.eventId}`
      };
    case 'NEW_APPLICATION':
      return {
        kind,
        priority: NOTIFICATION_PRIORITY.IMPORTANT,
        title: 'New Volunteer Application',
        body: `Someone applied to your event: ${payload.eventTitle}.`,
        link: `event:${payload.eventId}`
      };
    case 'SPOT_RELEASED':
      return {
        kind,
        priority: NOTIFICATION_PRIORITY.NORMAL,
        title: 'Withdrawal Confirmed',
        body: `You have successfully withdrawn from ${payload.eventTitle}.`,
        link: `event:${payload.eventId}`
      };
    case 'VOLUNTEER_RELEASED_SPOT':
      return {
        kind,
        priority: NOTIFICATION_PRIORITY.IMPORTANT,
        title: 'A volunteer withdrew',
        body: `A volunteer has released their spot for ${payload.eventTitle}.`,
        link: `event:${payload.eventId}`
      };
    case 'EVENT_DEADLINE_APPROACHING':
      return {
        kind,
        priority: NOTIFICATION_PRIORITY.LOW,
        title: 'Applications close soon',
        body: `"${payload.eventTitle}" stops accepting applications ${payload.countdownPhrase}.`,
        link: `event:${payload.eventId}`
      };
    case 'EVENT_REMINDER_24H':
      return {
        kind,
        priority: NOTIFICATION_PRIORITY.IMPORTANT,
        title: 'Your shift starts tomorrow',
        body: `${payload.eventTitle} starts at ${payload.slotName} in ${payload.location}.`,
        link: `event:${payload.eventId}`
      };
    case 'EVENT_REMINDER_2H':
      return {
        kind,
        priority: NOTIFICATION_PRIORITY.IMPORTANT,
        title: 'Your shift starts soon',
        body: `${payload.eventTitle} is starting in less than 2 hours.`,
        link: `event:${payload.eventId}`
      };
    case 'SCHEDULE_CONFLICT_WARNING':
      return {
        kind,
        priority: NOTIFICATION_PRIORITY.CRITICAL,
        title: 'Schedule Conflict Warning',
        body: `You have overlapping volunteer commitments involving ${payload.eventTitle}.`,
        link: `event:${payload.eventId}`
      };
    case 'DECISION_NEEDED':
      return {
        kind: 'APPLICATION',
        priority: NOTIFICATION_PRIORITY.IMPORTANT,
        title: 'Applications closed — decision needed',
        body: `"${payload.eventTitle}" stopped accepting applications. ${payload.applicantsText} are still waiting to hear back.`,
        link: `event:${payload.eventId}`
      };
    case 'HOURS_APPROVED':
      return {
        kind,
        priority: NOTIFICATION_PRIORITY.NORMAL,
        title: 'Volunteer hours added',
        body: `You earned ${payload.hours} hours for ${payload.eventTitle}.`,
        link: `event:${payload.eventId}`
      };
    case 'ORGANIZER_APPROVED':
      return {
        kind,
        priority: NOTIFICATION_PRIORITY.IMPORTANT,
        title: 'Account Approved!',
        body: 'Your organizer account has been verified. You can now post events.',
        link: '/profile'
      };
    /**
     * The link was `/appeal?token=…`. The only client route is `/appeal/:token`,
     * and `isPublicPath` matches segment-for-segment — so `/appeal` (one segment)
     * never matched, fell through to the signed-out catch-all, and every appeal
     * link this product has ever sent led to a 404. The email CTA is built from
     * this same string (notificationWorker.js), so the mail was dead too.
     *
     * `/appeal/${token}` is the single canonical form: client route, server SPA
     * allowlist (clientRoutes.js) and this link now all agree.
     */
    /**
     * ── Why the end date is in the notice ──
     *
     * A person told only that they are suspended cannot tell a week from for
     * ever. Both mistakes that follow are bad ones: waiting indefinitely for
     * something that lapsed weeks ago, or spending an appeal — of which they get
     * one — on a suspension that was going to end on Monday anyway.
     *
     * Falls back to the original wording when `suspendedUntil` is absent, because
     * an indefinite suspension is still a real option and must not be described
     * as having an end.
     */
    case 'ACCOUNT_SUSPENDED': {
      const endsAt = payload.suspendedUntil ? new Date(payload.suspendedUntil) : null;
      const endsOn = endsAt && !Number.isNaN(endsAt.getTime())
        ? endsAt.toLocaleDateString('en-US', {
          weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
        })
        : null;

      return {
        kind,
        priority: NOTIFICATION_PRIORITY.CRITICAL,
        title: 'Your WeVolunteer account is suspended',
        body:
          "You can't sign in to WeVolunteer right now. Here's why:\n\n"
          + `${payload.reason}\n\n`
          + (endsOn
            ? `This suspension ends on ${endsOn}. You do not need to do anything — `
              + 'you will be able to sign in again from that date.\n\n'
            : 'This suspension does not have an end date. It stays in place until an '
              + 'administrator lifts it.\n\n')
          + 'Your volunteer hours, your attendance record and your certificates are all safe. '
          + "Nothing has been deleted, and any certificate code you've already shared still works.\n\n"
          + 'If you think we got this wrong, or there is something we did not know, you can appeal. '
          + `Use the button below${payload.appealDeadline ? ` by ${payload.appealDeadline}` : ''}. `
          + 'An administrator reads every appeal, and we reply within 5 school days with what we '
          + 'decided, why, and who reviewed it.\n\n'
          + `If the link stops working, email ${SUPPORT_EMAIL} from this address.`,
        ctaText: 'Appeal this decision',
        link: `/appeal/${payload.token}`
      };
    }

    /**
     * The good news half of the enforcement class.
     *
     * Nothing told a reinstated student anything, and they cannot discover it by
     * signing in — they have no reason to try. The Privacy Policy commits to
     * telling a student when an account change is made on their behalf.
     */
    case 'ACCOUNT_REINSTATED':
      return {
        kind,
        priority: NOTIFICATION_PRIORITY.CRITICAL,
        title: 'Your WeVolunteer account is back',
        body:
          'Your account works again — you can sign in now.\n\n'
          + (payload.reason ? `${payload.reason}\n\n` : '')
          + 'Your hours, attendance and certificates were kept the whole time.',
        ctaText: 'Sign in',
        link: '/login'
      };

    case 'APPEAL_DECISION_STANDS':
      return {
        kind,
        priority: NOTIFICATION_PRIORITY.CRITICAL,
        title: 'We looked at your appeal',
        body:
          'Thank you for writing to us. An administrator read your appeal, and we are keeping '
          + 'the suspension in place.\n\n'
          + `Here is why:\n\n${payload.reasoning}\n\n`
          + `Reviewed by ${payload.reviewerName}.\n\n`
          + 'Your hours and certificates are still safe. If you think this is still wrong, email '
          + `${SUPPORT_EMAIL} from the address on your account.`,
        ctaText: 'See the decision',
        // The same link they filed through. The token route serves the outcome
        // after the token is spent, which is the only way a still-suspended
        // person can read it — they cannot sign in to find it anywhere else.
        link: payload.token ? `/appeal/${payload.token}` : '/login'
      };

    /**
     * Two versions, because the account is not always back yet.
     *
     * Reversing an appeal does not lift a suspension: reinstatement is a
     * separate action behind `user.suspend`, which the reviewer may not even
     * hold (`appeal.review` is separately grantable so a triage-only helper can
     * exist). This notice used to say "your account is back… you can sign in
     * now" with a Sign in button, unconditionally — so a student whose appeal
     * succeeded was sent to a login screen that refuses a suspended account,
     * with no explanation, having just been told in a CRITICAL notice that they
     * were fine. Telling somebody they are unlocked when they are not is worse
     * than telling them nothing.
     *
     * When the account is genuinely restored, the `ACCOUNT_REINSTATED` notice is
     * what says so — and it already exists, so the second version below promises
     * a message rather than inventing one.
     */
    case 'APPEAL_DECISION_REVERSED':
      return payload.stillSuspended
        ? {
          kind,
          priority: NOTIFICATION_PRIORITY.CRITICAL,
          title: 'Your appeal worked',
          body:
            'We looked at your appeal and we got this wrong. Sorry.\n\n'
            + `Here is what we found:\n\n${payload.reasoning}\n\n`
            + `Reviewed by ${payload.reviewerName}.\n\n`
            + 'Your account is still switched off while an administrator turns it back on. '
            + 'We will send you another message the moment it works again — you do not need '
            + 'to do anything.',
          ctaText: null,
          link: null
        }
        : {
          kind,
          priority: NOTIFICATION_PRIORITY.CRITICAL,
          title: 'Your appeal worked — your account is back',
          body:
            'We looked at your appeal and we got this wrong. Sorry.\n\n'
            + `Here is what we found:\n\n${payload.reasoning}\n\n`
            + `Reviewed by ${payload.reviewerName}.\n\n`
            + 'Your account works again — you can sign in now.',
          ctaText: 'Sign in',
          link: '/login'
        };

    case 'APPEAL_REOPENED':
      return {
        kind,
        priority: NOTIFICATION_PRIORITY.CRITICAL,
        title: 'We are looking at your appeal again',
        body:
          'We had told you the outcome of your appeal. An administrator has reopened it, so that '
          + 'decision is not final after all.\n\n'
          + `Why:\n\n${payload.reason}\n\n`
          + 'We will write again with the new outcome within 5 school days.',
        ctaText: 'See your appeal',
        link: payload.token ? `/appeal/${payload.token}` : '/login'
      };
    case 'REMOVED_FROM_EVENT':
      return {
        kind,
        priority: NOTIFICATION_PRIORITY.CRITICAL,
        title: 'Removed from Event',
        body: `You have been removed from ${payload.eventTitle} by the organizer.`,
        link: `event:${payload.eventId}`
      };
    case 'HOURS_ADJUSTED':
      return {
        kind,
        priority: NOTIFICATION_PRIORITY.NORMAL,
        title: 'Hours Adjusted',
        body: `Your hours for ${payload.eventTitle} were adjusted to ${payload.hours}.`,
        link: `event:${payload.eventId}`
      };
    case 'EVENT_COMMENT':
      return {
        kind,
        priority: NOTIFICATION_PRIORITY.LOW,
        title: 'New discussion',
        body: `A new comment was posted on ${payload.eventTitle}.`,
        link: `event:${payload.eventId}`
      };
    case 'EVENT_CANCELLED':
      return {
        kind,
        priority: NOTIFICATION_PRIORITY.CRITICAL,
        title: `${payload.eventTitle} was cancelled`,
        body: `The organizer has cancelled this event.`,
        link: `event:${payload.eventId}`
      };
    case 'EVENT_UPDATED':
      let changeText = 'The organizer made changes to the event details.';
      if (payload.changes && payload.changes.length > 0) {
        changeText = `Details changed: ${payload.changes.join(', ')}.`;
      }
      return {
        kind,
        priority: NOTIFICATION_PRIORITY.NORMAL,
        title: `${payload.eventTitle} details changed`,
        body: changeText,
        link: `event:${payload.eventId}`
      };
    case 'IMPORTANT_ANNOUNCEMENT':
      return {
        kind,
        priority: NOTIFICATION_PRIORITY.LOW,
        title: `Announcement: ${payload.eventTitle}`,
        body: payload.body || `The organizer posted an important update.`,
        link: `event:${payload.eventId}`
      };
    /**
     * Operational alert about the caller's own request — data export ready or
     * failed. The caller supplies the copy, because only it knows what happened.
     *
     * This is an EXPLICIT passthrough, not the `default:` fallback it used to
     * rely on. It rendered correctly by accident: the worker happened to pass
     * `title`/`body`/`link`, which the fallback happens to read. Anything
     * dispatched without them would have silently become "Notification". The
     * fallbacks below are what the copy is if a caller forgets.
     */
    case 'SYSTEM_ALERT':
      return {
        kind,
        priority: NOTIFICATION_PRIORITY.IMPORTANT,
        title: payload.title || 'Account update',
        body: payload.body || 'Something about your account needs your attention.',
        link: payload.link || '/settings'
      };
    case 'DIRECT_MESSAGE':
      return {
        kind,
        priority: NOTIFICATION_PRIORITY.IMPORTANT,
        title: payload.title,
        body: payload.body,
        link: payload.link
      };
    case 'CERTIFICATE_AVAILABLE':
      return {
        kind,
        priority: NOTIFICATION_PRIORITY.IMPORTANT,
        title: 'Your volunteer certificate is ready',
        body: `A new certificate for ${payload.eventTitle || 'your recent event'} has been generated.`,
        link: '/profile'
      };
    default:
      return {
        kind,
        priority: NOTIFICATION_PRIORITY.NORMAL,
        title: payload.title || 'Notification',
        body: payload.body || 'You have a new notification.',
        link: payload.link || null
      };
  }
}
