export const EVENT_CATEGORIES = {
  // APPLICATION
  APPLICATION_SUBMITTED: 'APPLICATION',
  APPLICATION_ACCEPTED: 'APPLICATION',
  APPLICATION_REJECTED: 'APPLICATION',
  WAITLIST_PROMOTED: 'APPLICATION',
  REMOVED_FROM_EVENT: 'APPLICATION',
  NEW_APPLICATION: 'APPLICATION',
  SPOT_RELEASED: 'APPLICATION',
  VOLUNTEER_RELEASED_SPOT: 'APPLICATION',

  // EVENT
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
    case 'WAITLIST_PROMOTED':
      return {
        kind,
        priority: NOTIFICATION_PRIORITY.IMPORTANT,
        title: 'A spot opened! You are now accepted',
        body: `You've been moved off the waitlist for ${payload.eventTitle}. You're confirmed!`,
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
