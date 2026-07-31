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
