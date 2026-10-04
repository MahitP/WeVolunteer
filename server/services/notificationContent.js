import { ADDRESSES } from '../emailIdentity.js';

/**
 * The published fallback channel, named in the Community Guidelines and the
 * Privacy Policy. One definition, because a student locked out of their account
 * has nothing else and a typo here is a dead end.
 *
 * ── Why this is now `admin@` and not a support address ──
 *
 * All three messages that name it are enforcement notices: a suspension, a ban,
 * an appeal whose link has stopped working. What they say is "if you think this
 * is wrong, write to us" — that is an adjudication channel, not a help desk, and
 * the person reading it is contesting a decision somebody made about their
 * account. `admin@` is where that belongs.
 *
 * It used to be a personal-tier Gmail address hard-coded here and in two more
 * places in the client, none of which was the env-driven `SUPPORT_EMAIL` the
 * config already exported. Now it comes from the same address book as every
 * sender, so a domain move is one edit.
 */
export const SUPPORT_EMAIL = ADDRESSES.admin;

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
  /**
   * A legal document changing is a mandatory notice because the product has
   * published a promise to give one: "If a change matters, we will tell you in
   * the app at least 30 days before it takes effect… We will not change them
   * quietly" (Terms of Service). A notification preference is a choice about
   * how much the product talks to you; it cannot be a way to opt out of being
   * told that the agreement you are held to has been rewritten.
   */
  'LEGAL_DOCUMENT_UPDATED',
  /**
   * And its material sibling, for the same reason and more strongly: this is
   * the notice that a document the reader is held to has changed in a way that
   * will require their agreement. A notification preference cannot be a way to
   * arrive at a blocking dialog with no warning.
   */
  'LEGAL_ACCEPTANCE_REQUIRED',
  /**
   * Being banned from an organization is a mandatory notice for the same reason
   * a suspension is: it is an enforcement decision recorded against the person,
   * it is what an appeal is heard against, and it is worthless if they do not
   * receive it. A notification preference is a choice about how much the
   * product talks to you; it cannot be a way to not be told you were banned.
   *
   * An ordinary removal is NOT mandatory. Leaving a club is routine, and a
   * volunteer who has muted membership chatter has made a reasonable choice.
   */
  'ORGANIZATION_BANNED',
  /**
   * A formal warning is a mandatory notice for the same reason a suspension is:
   * it is an enforcement action recorded against the person, it is the step that
   * precedes suspension, and it is worthless — worse than worthless — if they do
   * not receive it. A warning nobody read still counts against them next time.
   */
  'ACCOUNT_WARNED',
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
  /**
   * A recovery code was spent.
   *
   * This is the one signal an account takeover produces from the inside: the
   * codes exist precisely for the case where the ordinary factors are gone, so
   * somebody else using one is what a stolen account looks like. Suppressing it
   * on a preference would silence the only warning the real owner gets, and the
   * privacy policy already publishes that security email cannot be switched off.
   *
   * It also carries the remaining count, which is how somebody learns they have
   * just spent their last one — before they discover it at the next sign-in with
   * an authenticator they no longer have.
   */
  'RECOVERY_CODE_USED',
]);

export const isMandatoryNotice = (event) => MANDATORY_NOTICE_EVENTS.has(event);

/**
 * The sentence a volunteer is owed when a machine decided, and not otherwise.
 *
 * R-06: Auto Select is disclosed where somebody APPLIES ("Applications stay open
 * until the deadline, then Auto Select helps assign spots fairly" —
 * EventDetailsExperience), and was disclosed nowhere at the moment it actually
 * decided about them. A volunteer read "You are on the waitlist" and had no way
 * to tell an organizer's judgement from an automated draw.
 *
 * ── Why this is keyed on a payload flag rather than the template ──
 *
 * Both outcomes are reachable two ways. `applicationRoutes.js` is an organizer
 * choosing; `autoSelect.js` is the draw. Only the draw sets `decidedBy`, so a
 * human decision never claims to be automated and an automated one never hides.
 *
 * ── Why the decline notice is NOT covered ──
 *
 * The finding says "on decline", and taken literally that would have been wrong.
 * Auto Select never rejects: unselected applicants are WAITLISTED, deliberately,
 * because "the organizer did not reject them" (autoSelect.js). Every
 * APPLICATION_REJECTED is a person's decision, so naming Auto Select there would
 * attribute a human refusal to a machine — the opposite of the disclosure this
 * exists to make.
 */
export const AUTO_SELECT_NOTE =
  ' This was decided automatically by Auto Select when the deadline passed, not by an organizer.';

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
  /**
   * A student asking to join a club, filed under APPLICATION rather than
   * ACCOUNT.
   *
   * It is the same shape as `NEW_APPLICATION`: somebody applied to a thing you
   * run, and it is sitting in a queue waiting for you to decide it. A manager
   * who has turned Applications on and Account off has said "tell me about
   * things awaiting my decision", and this is one.
   *
   * The two OUTCOMES go the other way, under ACCOUNT, beside
   * `ORGANIZATION_MEMBERSHIP_REMOVED` — from the student's side they are news
   * about where they stand, not about an application queue.
   */
  ORGANIZATION_JOIN_REQUEST_RECEIVED: 'APPLICATION',
  /**
   * An invitation into a club.
   *
   * APPLICATION rather than ACCOUNT, alongside the join request it mirrors:
   * both are "somebody is waiting for you to decide about a club", and a
   * student who has turned Application notifications on has said that is what
   * they want to hear about. ACCOUNT is for things that happened TO their
   * account and cannot be declined.
   */
  ORGANIZATION_INVITATION_RECEIVED: 'APPLICATION',

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
  // A badge award. VOLUNTEER, alongside hours and certificates, because it is a
  // statement about the recipient's service record — so a volunteer who has
  // turned that category off is not told about badges either, which is the
  // point: badgeService used to INSERT into `notifications` directly and no
  // preference reached it at all.
  BADGE_EARNED: 'VOLUNTEER',
  /**
   * A friend signed up for something you could sign up for too. VOLUNTEER
   * rather than a new SOCIAL category, because that is what it is for: the
   * feature exists to surface opportunities, and filing it under Volunteering
   * puts it beside hours and certificates where a volunteer already looks.
   *
   * It also means one existing preference switch already turns it off, rather
   * than a sixth category appearing in everybody's settings.
   */
  FRIEND_SIGNED_UP: 'VOLUNTEER',
  /** A new event from an organization you joined. */
  ORGANIZATION_EVENT_POSTED: 'EVENT',

  /**
   * A recovery code was spent. ACCOUNT, and a MANDATORY notice — see
   * MANDATORY_NOTICE_EVENTS above for why a preference may not suppress it.
   */
  RECOVERY_CODE_USED: 'ACCOUNT',

  // ACCOUNT — the two relationship notices. ACCOUNT, not VOLUNTEER: these are
  // about who may see your activity, which is an account matter.
  FRIEND_REQUEST: 'ACCOUNT',
  FRIEND_ACCEPTED: 'ACCOUNT',

  // ACCOUNT
  ORGANIZER_APPROVED: 'ACCOUNT',
  ORGANIZER_APPROVAL_REVOKED: 'ACCOUNT',
  PASSWORD_CHANGED: 'ACCOUNT',
  PASSWORD_RESET: 'ACCOUNT',
  EMAIL_VERIFIED: 'ACCOUNT',
  /**
   * ACCOUNT, not SYSTEM.
   *
   * It was briefly changed to SYSTEM during the M1c work with no stated reason.
   * That is the same defect `APPLICATION_WAITLISTED` caused: a notice filed
   * under the wrong category is invisible under the filter the reader would
   * actually use. Someone who has just been locked out opens their notifications
   * and filters by Account to find out why — a suspension notice sitting under
   * System is one they have to already know to look for.
   */
  ACCOUNT_SUSPENDED: 'ACCOUNT',
  /**
   * A legal document you accepted has changed.
   *
   * ACCOUNT rather than SYSTEM: it is a fact about this person's relationship
   * with the platform — the terms they agreed to are not the terms in force —
   * and it belongs beside suspensions and appeals in the Account filter, not
   * beside maintenance notices.
   */
  LEGAL_DOCUMENT_UPDATED: 'ACCOUNT',
  LEGAL_ACCEPTANCE_REQUIRED: 'ACCOUNT',
  /* Membership of a club is a relationship with the platform, not an event. */
  ORGANIZATION_MEMBERSHIP_REMOVED: 'ACCOUNT',
  ORGANIZATION_JOIN_REQUEST_ACCEPTED: 'ACCOUNT',
  ORGANIZATION_JOIN_REQUEST_REJECTED: 'ACCOUNT',
  ORGANIZATION_BANNED: 'ACCOUNT',
  ORGANIZATION_BAN_APPEAL_STANDS: 'ACCOUNT',
  ORGANIZATION_BAN_APPEAL_REVERSED: 'ACCOUNT',
  ORGANIZATION_BAN_LIFTED: 'ACCOUNT',
  ACCOUNT_WARNED: 'ACCOUNT',
  ACCOUNT_REINSTATED: 'ACCOUNT',
  APPEAL_DECISION_STANDS: 'ACCOUNT',
  APPEAL_DECISION_REVERSED: 'ACCOUNT',
  APPEAL_REOPENED: 'ACCOUNT',

  // SYSTEM
  ADMIN_PROMOTED: 'SYSTEM',
  ADMIN_REVOKED: 'SYSTEM',
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
        body: `You are officially scheduled for ${payload.eventTitle}.`
          + (payload.decidedBy === 'auto-select' ? AUTO_SELECT_NOTE : ''),
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
        body: (payload.waitlistRank
          // Auto Select already computes this rank and used to discard it.
          ? `You are number ${payload.waitlistRank} on the waitlist for ${payload.eventTitle}. `
            + 'A spot may become available if another volunteer withdraws.'
          : `You are on the waitlist for ${payload.eventTitle}. `
            + 'A spot may become available if another volunteer withdraws.')
          + (payload.decidedBy === 'auto-select' ? AUTO_SELECT_NOTE : ''),
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
    /**
     * `slotName` is a SHIFT NAME, not a time.
     *
     * This read "Food Drive starts at Morning Setup in Community Center" —
     * grammar written for a value that never went in that slot. The shift name
     * belongs in apposition, and the place belongs after "at".
     */
    case 'EVENT_REMINDER_24H':
      return {
        kind,
        priority: NOTIFICATION_PRIORITY.IMPORTANT,
        title: 'Your shift starts tomorrow',
        body: [
          `${payload.eventTitle}`,
          payload.slotName ? ` (${payload.slotName})` : '',
          ' is tomorrow',
          payload.location ? ` at ${payload.location}` : '',
          '.',
        ].join(''),
        link: `event:${payload.eventId}`
      };
    /**
     * The two-hour reminder never named the place, though the one the day
     * before did — so the message that arrives when somebody is deciding
     * whether to set off was the one carrying least. It also arrives at exactly
     * the moment check-in opens (`CHECKIN_OPENS_BEFORE_MS` is the same two
     * hours), which is worth saying out loud rather than leaving as a
     * coincidence only the code knows about.
     */
    case 'EVENT_REMINDER_2H':
      return {
        kind,
        priority: NOTIFICATION_PRIORITY.IMPORTANT,
        title: 'Your shift starts soon',
        body: [
          `${payload.eventTitle} starts in under 2 hours`,
          payload.location ? ` at ${payload.location}` : '',
          '. Check-in is open.',
        ].join(''),
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
      /**
       * An event that credits no hours gets a sentence with no number in it.
       *
       * `credits_hours = 0` means "this event does not measure service in
       * hours" — a donation drive, a supply sort — and attendance is still
       * recorded and still counts toward events attended. Printing the figure
       * anyway produced "You earned 0 hours for the Winter Coat Drive", which
       * reads as a refusal to somebody who turned up and did the work.
       *
       * `awardsHours !== false` rather than a truthiness test, so an older
       * payload that predates the field keeps the hours wording it was written
       * for instead of silently losing its number.
       */
      return payload.awardsHours === false
        ? {
          kind,
          priority: NOTIFICATION_PRIORITY.NORMAL,
          title: 'Attendance confirmed',
          body: `Your attendance at ${payload.eventTitle} was confirmed. `
            + 'This event does not award service hours.',
          link: `event:${payload.eventId}`
        }
        : {
          kind,
          priority: NOTIFICATION_PRIORITY.NORMAL,
          title: 'Volunteer hours added',
          body: `You earned ${payload.hours} hours for ${payload.eventTitle}.`,
          link: `event:${payload.eventId}`
        };
    /* "You can now post events" was untrue on the day it arrived: posting also
       waits on the Organizer Agreement, which a new organizer has not seen yet
       (final audit, Phase 5). The notice now says so and opens it. */
    case 'ORGANIZER_APPROVED':
      return {
        kind,
        priority: NOTIFICATION_PRIORITY.IMPORTANT,
        title: 'Your organizer account is approved',
        body: 'Read and accept the Organizer Agreement, and you can post events.',
        link: '/organizer-agreement'
      };
    /* P2-12. Says what changed and what did not: their events and the hours
       volunteers earned at them are untouched. */
    case 'ORGANIZER_APPROVAL_REVOKED':
      return {
        kind,
        priority: NOTIFICATION_PRIORITY.IMPORTANT,
        title: 'Organizer approval removed',
        body: 'An administrator has removed your approval to post new events. Your past events and the hours volunteers earned at them are unchanged.',
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
    /**
     * ── The two legal-change notices, and why there are exactly two ──
     *
     * §13 of the published Terms draws one line and this pair is it: "A change
     * that leaves you worse off … gets a new major version and we ask you to
     * accept it again. A clarification gets a minor version and notice only."
     *
     * `LEGAL_DOCUMENT_UPDATED` is the second sentence; `LEGAL_ACCEPTANCE_REQUIRED`
     * is the first. `dispatchLegalChangeNotices` in `legalNotices.js` picks
     * between them from the version number and sends EXACTLY ONE per person per
     * document version — an ordinary "we updated something" mail followed by a
     * "you must accept this" mail about the same change would teach the reader
     * that the first kind means nothing.
     *
     * Neither may state or imply that the reader has accepted anything. Only
     * `POST /api/legal/updates/accept` records that, and the wording here is
     * chosen so that a reader who does nothing at all is described accurately.
     */
    case 'LEGAL_DOCUMENT_UPDATED': {
      /**
       * The excerpt is a SAMPLE, and the copy says so.
       *
       * `buildExcerpt` quotes one sentence that is new. It cannot know which
       * change matters most, so presenting it as "what changed" would overstate
       * it — "among other changes" is the honest frame when there is more than
       * one, and the link is what actually discharges the obligation.
       */
      const quoted = payload.excerpt
        ? `\n\n\u201c${payload.excerpt}\u201d`
        : '';
      const others = payload.changeCount > 1
        ? `\n\nThat is one of ${payload.changeCount} changes.`
        : '';
      /* Stated because it is what an acceptance record points at, and because a
         reader comparing this mail to the page should be able to tell whether
         they are looking at the same revision. */
      const version = payload.version ? ` (version ${payload.version})` : '';

      return {
        kind,
        /* IMPORTANT, not NORMAL: the retention sweep is allowed to delete
           NORMAL notices, and a mandatory notice that can be swept is a notice
           the product only pretended to give. */
        priority: NOTIFICATION_PRIORITY.IMPORTANT,
        title: `${payload.title} has been updated`,
        body:
          `We have updated the ${payload.title}${version}.${quoted}${others}\n\n`
          + 'This was a clarification, so there is nothing you need to do and '
          + 'nothing has been recorded as accepted on your behalf — this is a '
          + 'notice that the document changed. Please read it when you have a '
          + 'moment. If you do not agree with the changes, you can close your '
          + 'account at any time.',
        link: `/legal/${payload.slug}`,
        ctaText: `Read the ${payload.title}`,
      };
    }

    /**
     * A material change: the reader will be asked to accept it.
     *
     * ── Why this is sent during the notice period rather than on the day ──
     *
     * The Terms promise notice "at least 30 days before it takes effect", and
     * the ICO's guidance on the right to be informed says the same thing in the
     * general case: a change to how personal data is used has to be
     * communicated BEFORE the new processing begins, actively rather than by
     * quietly editing a page. So the mail goes out when the revision is
     * published, names the date, and says what will be asked for then.
     *
     * The effective date arriving is not a second email. It is the in-app
     * dialog, which is unavoidable by construction — see
     * `SIGNUP_CONSENT_GATED_CAPABILITIES`. A reminder mail on the day would be
     * a second message about one change, which is the duplication this pair is
     * designed to avoid.
     *
     * ── What it must not say ──
     *
     * Not "you have accepted", not "by continuing to use WeVolunteer you
     * agree", and not "click here to accept". The link goes to the document.
     * Acceptance happens in the application, behind a session, through a POST —
     * never from a link in an email.
     */
    case 'LEGAL_ACCEPTANCE_REQUIRED': {
      const quoted = payload.excerpt
        ? `\n\n\u201c${payload.excerpt}\u201d`
        : '';
      const others = payload.changeCount > 1
        ? `\n\nThat is one of ${payload.changeCount} changes.`
        : '';
      const version = payload.version ? ` (version ${payload.version})` : '';

      /**
       * Two tenses, because this notice is sent in both situations.
       *
       * Normally the revision is dated at least thirty days ahead and this is
       * advance notice. It can also be in effect already — a change published
       * under the notice-period override in the Legal Center, which requires an
       * owner to give a written reason and is audited. The same message has to
       * be truthful in both cases, so the sentence about WHEN is built from the
       * date rather than assumed.
       */
      const when = payload.effectiveDateLabel;
      const timing = payload.alreadyInEffect
        ? 'This change is now in effect, so the next time you open WeVolunteer we '
          + 'will ask you to review the new version and accept it.'
        : when
          ? `This change takes effect on ${when}. From that date, WeVolunteer will `
            + 'ask you to review the new version and accept it before you carry on '
            + 'volunteering, messaging or posting.'
          : 'When this change takes effect, WeVolunteer will ask you to review the '
            + 'new version and accept it before you carry on volunteering, messaging '
            + 'or posting.';

      return {
        kind,
        priority: NOTIFICATION_PRIORITY.CRITICAL,
        title: `An important update to the ${payload.title}`,
        body:
          `We have made a significant change to the ${payload.title}${version} — one `
          + `that a reasonable reader of the previous version would want to know `
          + `about.${quoted}${others}\n\n${timing}\n\n`
          + 'Nothing has been recorded as accepted on your behalf, and reading the '
          + 'document does not accept it. You can read it now, and if you would '
          + 'rather not agree you can close your account at any time.',
        link: `/legal/${payload.slug}`,
        ctaText: `Read the ${payload.title}`,
      };
    }

    /**
     * Somebody wants in, and a manager has to answer.
     *
     * ── Why the body names one person and nothing else ──
     *
     * This is dispatched to every manager, which means it is also enqueued as
     * email, which means it leaves the building. `FRIEND_SIGNED_UP` makes the
     * same argument and lands the same way: the recipient is being told that
     * something needs their attention, and the detail lives behind the link,
     * where the reader is authenticated and the disclosure is already governed.
     *
     * So: a name and a club. Not a grade, not a school, not an email address,
     * and not a message. A request may now carry a short note (migration 063),
     * but the note is not repeated here: it was written for the club's managers
     * to read on the page, and copying it into a notification would also copy
     * it into an email, which leaves the platform. What this says is that
     * somebody is waiting; the page says who and why.
     */
    /**
     * Every organization deep link below is the canonical `@handle` form.
     *
     * A notification row persists its `link`, so these strings outlive the
     * request that wrote them — which is exactly why the handle stopped moving
     * when a club is renamed. Before that change, a rename silently dead-linked
     * every historical notification a club had ever sent; now the address in a
     * row from last term still resolves. See `organizationHandles.js`.
     */
    case 'ORGANIZATION_JOIN_REQUEST_RECEIVED': {
      const org = payload.organizationName || 'your organization';
      const who = payload.actorName || 'Somebody';
      return {
        kind,
        priority: NOTIFICATION_PRIORITY.NORMAL,
        title: `Someone asked to join ${org}`,
        body: `${who} asked to join ${org}. It is waiting for a manager to accept or decline.`,
        link: payload.organizationSlug
          ? `/organizations/@${payload.organizationSlug}#requests`
          : '/organizations',
        ctaText: 'Review the request',
      };
    }

    /**
     * You have been invited.
     *
     * ── What this does NOT say ──
     *
     * **Who invited you.** The club invites, not the individual member who
     * pressed the button. Naming them would make declining an answer to a
     * classmate rather than to a club, which is precisely the pressure a
     * thirteen-year-old should not be under.
     *
     * **The note, if there is one.** A notification body is copied into an
     * email, which leaves the platform; a note written to one person stays on
     * the page they open. The body says there is one, so nobody misses it.
     *
     * The invitation lapses, so the body says so without printing a date — the
     * page shows the date, and a body that hardcoded one would be wrong the
     * moment the row was read a fortnight later.
     */
    case 'ORGANIZATION_INVITATION_RECEIVED': {
      const org = payload.organizationName || 'an organization';
      return {
        kind,
        priority: NOTIFICATION_PRIORITY.NORMAL,
        title: `You have been invited to join ${org}`,
        body: `${org} invited you to join. Open it to accept or decline — `
          + 'the invitation does not last for ever.',
        link: payload.organizationSlug ? `/organizations/@${payload.organizationSlug}` : '/organizations',
        ctaText: `Go to ${org}`,
      };
    }

    case 'ORGANIZATION_JOIN_REQUEST_ACCEPTED': {
      const org = payload.organizationName || 'the organization';
      return {
        kind,
        priority: NOTIFICATION_PRIORITY.NORMAL,
        title: `You are now a member of ${org}`,
        body:
          `A manager accepted your request to join ${org}. `
          + 'You will be told when it posts a new opportunity.',
        link: payload.organizationSlug ? `/organizations/@${payload.organizationSlug}` : '/organizations',
        ctaText: `Go to ${org}`,
      };
    }

    /**
     * Declined — and carrying no reason, on purpose.
     *
     * The alternative is a free-text field in which a club manager writes a
     * judgement about a named minor, which is then copied into an email that
     * leaves the platform. A ban carries a reason because a ban is an
     * enforcement decision with an appeal heard against it; declining a request
     * is neither, and it is reversible by simply asking again.
     *
     * It says the door is not locked for that reason: without that sentence the
     * message reads as permanent, which it is not — the partial unique index is
     * scoped to `pending`, so a declined student may ask again.
     */
    case 'ORGANIZATION_JOIN_REQUEST_REJECTED': {
      const org = payload.organizationName || 'the organization';
      return {
        kind,
        priority: NOTIFICATION_PRIORITY.NORMAL,
        title: `${org} did not accept your request`,
        body:
          `Your request to join ${org} was not accepted. `
          + 'Nothing about your account, your hours or any other organization changes, '
          + 'and you can ask again later.',
        /* No CTA. The decision is made, and a button back to a club that has
           just said no is not something to press. */
      };
    }

    case 'ORGANIZATION_MEMBERSHIP_REMOVED': {
      const org = payload.organizationName || 'an organization';
      const actor = payload.actorName || 'A manager';
      const why = payload.reason ? `\n\nReason: ${payload.reason}` : '';
      return {
        kind,
        priority: NOTIFICATION_PRIORITY.NORMAL,
        title: `You were removed from ${org}`,
        body:
          `${actor} removed you from ${org}.${why}`
          + '\n\nYou can still join this organization again.',
        link: payload.organizationSlug ? `/organizations/@${payload.organizationSlug}` : '/organizations',
        ctaText: `View ${org}`,
      };
    }

    case 'ORGANIZATION_BANNED': {
      /* Named defensively. This is delivered over the recipient's opt-out, so
         "You were banned from undefined" is not a cosmetic slip — it is the
         one message they cannot choose not to receive. */
      const org = payload.organizationName || 'an organization';
      const actor = payload.actorName || 'A manager';
      /**
       * The reason is not decoration here — it is what the appeal is heard
       * against, and a person told they are banned without being told why has
       * nothing to answer. The route refuses a ban with no reason, so this
       * fallback should be unreachable; it exists because a notification that
       * renders "Reason: undefined" to somebody being excluded is worse than
       * one that admits the record is incomplete.
       */
      const why = payload.reason
        ? `\n\nReason: ${payload.reason}`
        : '\n\nNo reason was recorded.';
      return {
        kind,
        priority: NOTIFICATION_PRIORITY.IMPORTANT,
        title: `You were banned from ${org}`,
        body:
          `${actor} banned you from ${org}.${why}`
          + '\n\nYou cannot rejoin this organization while this ban is active. '
          + 'If you think this is wrong, you can make an appeal.',
        /* The organization travels in the link so the form knows what is being
           appealed without asking somebody to identify it themselves — and the
           server re-checks that this ban is theirs regardless of what the query
           string says. */
        link: payload.organizationId
          ? `/appeals/new?subject=organization_ban&organization=${encodeURIComponent(payload.organizationId)}`
          : '/appeals/new?subject=organization_ban',
        ctaText: 'Make an appeal',
      };
    }

    case 'ORGANIZATION_BAN_APPEAL_STANDS': {
      /**
       * Written for a BAN, not borrowed from the suspension wording.
       *
       * `APPEAL_DECISION_STANDS` says "we are keeping the suspension in place"
       * and offers a link to the suspension appeal page. Sent to somebody
       * appealing a club ban, that names a punishment they are not under and
       * points at a page about it. Two decisions, two vocabularies.
       */
      const org = payload.organizationName || 'the organization';
      const why = payload.reasoning ? `\n\nWhat they said: ${payload.reasoning}` : '';
      return {
        kind,
        priority: NOTIFICATION_PRIORITY.IMPORTANT,
        title: `Your appeal to ${org} was not upheld`,
        body:
          `A manager of ${org} has looked at your appeal, and the ban stays in place.${why}`
          + '\n\nThis does not affect your account, your hours, or any other organization.',
        /* No CTA. There is nothing useful to press: the decision is made, and a
           link back to the organization they cannot rejoin would be a taunt. */
      };
    }

    case 'ORGANIZATION_BAN_APPEAL_REVERSED': {
      const org = payload.organizationName || 'the organization';
      const why = payload.reasoning ? `\n\nWhat they said: ${payload.reasoning}` : '';
      return {
        kind,
        priority: NOTIFICATION_PRIORITY.IMPORTANT,
        title: `Your appeal to ${org} was upheld`,
        body:
          `A manager of ${org} has looked at your appeal and lifted the ban. `
          + 'You can join again whenever you like.' + why,
        link: payload.organizationSlug ? `/organizations/@${payload.organizationSlug}` : undefined,
        ctaText: payload.organizationSlug ? `Go to ${org}` : undefined,
      };
    }

    /**
     * A manager lifted the ban without an appeal having been made.
     *
     * Distinct from `ORGANIZATION_BAN_APPEAL_REVERSED`, which answers something
     * the person wrote. This one arrives unprompted, so it says why it is
     * arriving — somebody told they are banned and then never told otherwise has
     * no way to discover that the door reopened, and would keep believing the
     * club is closed to them.
     *
     * It deliberately does not claim the ban was a mistake. The manager may have
     * simply changed their mind, and putting an admission in their mouth is not
     * this message's to make.
     */
    case 'ORGANIZATION_BAN_LIFTED': {
      const org = payload.organizationName || 'an organization';
      return {
        kind,
        priority: NOTIFICATION_PRIORITY.IMPORTANT,
        title: `The ban on ${org} has been lifted`,
        body:
          `A manager of ${org} has lifted the ban. You can join again whenever `
          + 'you like.',
        link: payload.organizationSlug ? `/organizations/@${payload.organizationSlug}` : '/organizations',
        ctaText: `Go to ${org}`,
      };
    }

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
     * A formal warning.
     *
     * ── What this is careful about ──
     *
     * The recipient is frequently a teenager who is about to feel accused, and the
     * two failure modes are opposite: wording so soft they do not realise anything
     * has been recorded, or so severe they think they have been thrown off the
     * platform. So it says exactly three things — what was decided, that nothing
     * has been taken away, and what happens next.
     *
     * It deliberately does NOT carry an appeal link. Appeal tokens are minted for
     * suspensions (`appeal_tokens`, migration 014) and a warning is not a loss of
     * access to restore; issuing one here would create a token that the appeal
     * routes — which require `account_status = 'suspended'` — would refuse, i.e. a
     * button that reliably fails. The support address is offered instead, which is
     * a route a human actually answers.
     */
    case 'ACCOUNT_WARNED':
      return {
        kind,
        priority: NOTIFICATION_PRIORITY.CRITICAL,
        title: 'A note about your WeVolunteer account',
        body:
          'An administrator has recorded a formal warning on your account. '
          + "Here's what it says:\n\n"
          + `${payload.reason}\n\n`
          + 'Nothing has been removed. You can still sign in, sign up for shifts, and '
          + 'your hours, attendance and certificates are untouched.\n\n'
          + 'This is on your record, and it is taken into account if something similar '
          + 'happens again — which is why we are telling you rather than only writing it '
          + 'down.\n\n'
          + `If you think this is wrong, or there is something we did not know, email ${SUPPORT_EMAIL} `
          + 'from this address and a person will read it.',
        ctaText: 'Community Guidelines',
        link: '/legal/community-guidelines'
      };

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
      /**
       * Two bodies, one kind, chosen by a payload flag — the shape
       * `HOURS_APPROVED` above already uses, for the same reason: `dispatchMany`
       * renders content ONCE for a fan-out, so a clause that applies to some
       * recipients and not others cannot live inside a single dispatch. The
       * cancellation route makes two calls over disjoint sets.
       *
       * ── Why only the credited are told about hours ──
       *
       * Because that is already the rule for hour-impact messages here.
       * `HOURS_ADJUSTED` is dispatched only past a `wasCredited` guard, whose
       * note says "Somebody who was never credited has had nothing taken from
       * them and should not be told their hours changed". A cancellation takes
       * credit away from exactly those people and no others.
       *
       * ── What the sentence may and may not claim ──
       *
       * Not that the hours were removed: they are not. The attendance row, its
       * ledger entry and any issued certificate all survive, and the Volunteer
       * Record Policy now says so in those words under "If an event is
       * cancelled". What changed is that the event is no longer part of the
       * record the product presents — so the sentence names the total, and says
       * the record is intact, which is the pair a student needs.
       *
       * Decided during the 2026-09-21 audit (owner decision 4B).
       */
      return {
        kind,
        priority: NOTIFICATION_PRIORITY.CRITICAL,
        title: `${payload.eventTitle} was cancelled`,
        body: payload.hadCreditedHours
          ? 'The organizer has cancelled this event. The hours you were credited for it '
            + 'no longer count towards your totals — your attendance record and any '
            + 'certificate you were issued are unchanged.'
          : 'The organizer has cancelled this event.',
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
    /**
     * ── The link was `/admin`, which is not a route ──
     *
     * There is no `/admin` page. The administrative destinations are
     * `/admin/moderation` (the hub), `/admin/appeals`, `/admin/roster`,
     * `/admin/audit-logs`, `/admin/legal` and `/admin/impact`; the bare prefix
     * has never been declared in any of the three route tables. So the very
     * first thing a newly promoted administrator pressed — the notification
     * telling them they now hold the role — answered "Page not found".
     *
     * `/admin/moderation` is the hub that indexes every administrative area, so
     * it is the right landing place for "you now have access to these": it is
     * the one destination that explains what the new role can reach rather than
     * dropping them into one arbitrary corner of it.
     *
     * Nothing caught this because `internalLinks.test.js` scanned `src/` for
     * `href=`/`to=` attributes only. `serverLinks.test.js` now covers the
     * `link:` field on every notification in this file, which is what makes the
     * fix hold.
     */
    case 'ADMIN_PROMOTED':
      return {
        kind,
        priority: NOTIFICATION_PRIORITY.IMPORTANT,
        title: 'You are now a platform administrator',
        body: payload.reason ? `Reason: ${payload.reason}` : 'Your account has been granted administrative access.',
        link: '/admin/moderation'
      };
    case 'ADMIN_REVOKED':
      return {
        kind,
        priority: NOTIFICATION_PRIORITY.IMPORTANT,
        title: 'Administrative access revoked',
        body: 'Your administrative access has been removed by the platform owner.',
        link: '/'
      };
    case 'DIRECT_MESSAGE':
      return {
        kind,
        priority: NOTIFICATION_PRIORITY.IMPORTANT,
        title: payload.title,
        body: payload.body,
        link: payload.link
      };
    /**
     * A badge was awarded.
     *
     * NORMAL priority, and that is deliberate rather than an oversight: a badge
     * is the least consequential thing this system says to anybody, and the
     * 30-day retention sweep clearing it is correct. The badge itself is
     * permanent and visible on the profile; only the congratulation expires.
     *
     * `/profile`, not `/profile?tab=badges`. There is no `tab` query handling in
     * VolunteerProfile, so the parameter was decoration on a link that already
     * went to the right page — and decoration that reads like a promise.
     */
    case 'BADGE_EARNED':
      return {
        kind,
        priority: NOTIFICATION_PRIORITY.NORMAL,
        title: 'You earned a badge',
        body: payload.badgeName
          ? `Your profile now shows the "${payload.badgeName}" badge.`
          : 'Your profile now shows a new badge.',
        link: '/profile'
      };
    /**
     * A friend signed up for something.
     *
     * The body names the friend and the event and nothing else — not the shift,
     * not the time, not the location. The recipient is being told an
     * opportunity exists, and the link takes them to the event where the public
     * detail already lives. Putting a named person's schedule into a
     * notification body would put it into an email too, which is a copy of a
     * minor's whereabouts sitting in an inbox outside anybody's control.
     */
    case 'FRIEND_SIGNED_UP':
      return {
        kind,
        priority: NOTIFICATION_PRIORITY.LOW,
        title: 'A friend signed up',
        body: `${payload.actorName || 'A friend'} signed up for ${payload.eventTitle}. There may still be places.`,
        link: `event:${payload.eventId}`
      };
    case 'ORGANIZATION_EVENT_POSTED':
      return {
        kind,
        priority: NOTIFICATION_PRIORITY.NORMAL,
        title: `New from ${payload.organizationName || 'your organization'}`,
        body: `${payload.eventTitle} is open for applications.`,
        link: `event:${payload.eventId}`
      };
    case 'RECOVERY_CODE_USED':
      return {
        kind,
        priority: NOTIFICATION_PRIORITY.IMPORTANT,
        title: 'A recovery code was used to sign in',
        body: typeof payload.remaining === 'number'
          ? (payload.remaining === 0
            ? 'That was your last recovery code. Generate a new set in Settings — without one you '
              + 'cannot get back in if you lose your authenticator.'
            : `You have ${payload.remaining} recovery code${payload.remaining === 1 ? '' : 's'} left. `
              + 'If this was not you, change your password now.')
          : 'If this was not you, change your password now.',
        link: '/settings?section=security'
      };
    case 'FRIEND_REQUEST':
      return {
        kind,
        priority: NOTIFICATION_PRIORITY.NORMAL,
        title: 'New friend request',
        body: `${payload.actorName || 'Someone'} wants to add you as a friend.`,
        link: payload.actorUsername ? `/users/@${payload.actorUsername}` : '/notifications'
      };
    case 'FRIEND_ACCEPTED':
      return {
        kind,
        priority: NOTIFICATION_PRIORITY.LOW,
        title: 'Friend request accepted',
        body: `${payload.actorName || 'Someone'} is now your friend.`,
        link: payload.actorUsername ? `/users/@${payload.actorUsername}` : '/notifications'
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
