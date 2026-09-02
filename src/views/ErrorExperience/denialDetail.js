/**
 * What a permission refusal says on top of its themed copy.
 *
 * ── Why the themed body is not enough ──
 *
 * The six themes each explain a 403 in their own vocabulary — a corridor with a
 * steward, a sheet pinned for somebody else — and that is deliberate: a locked
 * door is mildly annoying and warmth is welcome. What none of them can say is
 * WHICH door, because copy is written per theme and the route is known only at the
 * moment of the refusal.
 *
 * So every denial read identically no matter what the reader had tried to open,
 * and a person who had clicked a stale bookmark, followed a link a colleague sent,
 * or lost a capability got the same three sentences. "Limited to certain accounts"
 * is true and useless: it does not say what was limited, why this account is not
 * one of them, or who could change that.
 *
 * This adds the three facts, flatly, under the themed body. Flat on purpose —
 * personality belongs in the part that acknowledges the situation, not in the part
 * somebody is going to quote in an email asking for access.
 *
 * ── Why the vocabulary is keyed by capability and not by path ──
 *
 * `deniedRoute()` returns the matched route, so the path is available. But the path
 * is not the reason: `/events/new` refuses for two different reasons —
 * `requiresVerified` and `event.create` — and a reader told "this is the new event
 * page" when the real problem is that their organizer account is still awaiting
 * approval has been told the one thing they already knew.
 *
 * A capability with no entry falls back to naming nothing rather than printing
 * `event.moderate` at a fifteen-year-old. `capabilityNames.test.js` guards the
 * other direction — that every name declared in `src/` is a real capability.
 */

/**
 * Plain-language names for the capabilities that gate a route.
 *
 * Only the ones `APP_ROUTES` actually declares need to be here; the rest of the
 * table gates API calls, which never reach this screen.
 */
const FEATURE_NAMES = Object.freeze({
  'event.view': 'browsing volunteer opportunities',
  'event.create': 'posting a new opportunity',
  'attendance.mark': 'the check-in scanner',
  'message.send': 'messages',
  /* The assistant's own name, because that is what the reader clicked and what
     the navigation calls it. "the on-device assistant" would describe how it is
     built to somebody who only wanted to know why it is gone. */
  'assistant.use': 'Welly',
  'portfolio.write': 'your volunteer portfolio',
  /* Named for the thing the reader was trying to do, not for the capability.
     "the member directory" would be accurate and would tell a fifteen-year-old
     refused at /users/@someone nothing at all. */
  'directory.read': 'member profiles and search',
  'organization.create': 'creating an organization',
  'organization.join': 'joining organizations',
  'organization.manage.own': 'managing an organization',
  'error.read': 'the error dashboard',
  'appeal.review': 'the appeals queue',
  /* "the Admin area", matching the rail entry, the page title and the page's own
     heading. A refusal that names a destination by a name the product no longer
     shows anywhere sends the reader looking for something they cannot find. */
  'report.resolve': 'the Admin area',
  'audit.read': 'the Audit Explorer',
  'analytics.impact': 'the community impact figures',
  'admin.create': 'the Administrator Roster',
  /* Named distinctly from `analytics.impact` above. Both are "impact figures"
     and they are not the same page: one is the community view an administrator
     can open, this is the platform-wide one, which only the platform owner can.
     A refusal that named them identically would read as the product refusing a
     page the reader can demonstrably already see — which is exactly what an
     administrator who holds `analytics.impact` and not `analytics.platform`
     would experience. */
  'analytics.platform': 'the platform-wide impact figures',
  /* Named for the destination the reader typed, which is the Settings entry
     they would have seen if they held it. "editing legal documents" would
     describe the power rather than the page, and somebody who reached here by
     guessing a URL is looking for a page. */
  'legal.edit': 'the Legal Center editor',
  'self.read': 'the Welly assistant and personal account records',
  /* Named for the page, which is what somebody who typed `/owner` was looking
     for. "third-party service status" would describe what is on it and leave
     the reader unsure whether they had found the right address at all. */
  'owner.console': 'the Owner Center',
});

/**
 * Who can change this, in the reader's terms.
 *
 * NOT "your school administrator", which is what three of the themes said and
 * what the suspension notice used to say before `authRoutes.js` corrected it for
 * exactly this reason: WeVolunteer is an independent platform rather than a school
 * district service, so a school administrator has no access to it, cannot see the
 * refusal, and cannot do anything about it. Sending somebody to a person who is
 * powerless is worse than saying nothing.
 *
 * `error.read` is SUPER_ONLY — `can()` refuses it before it consults per-user
 * grants — so no capability grant can reach it and saying an administrator could
 * help would be false.
 */
const UNREACHABLE_BY_GRANT = new Set(['error.read', 'error.write']);

/**
 * The factual half of a refusal, or null when there is nothing honest to add.
 *
 * @param {{ requiredCap?: string, requiresVerified?: boolean }} [route]
 *   The route `deniedRoute()` matched. Absent for a refusal that did not come from
 *   the route table — the router's own backstop, or a forced render in the gallery.
 * @returns {{ feature: string|null, reason: string, remedy: string|null }|null}
 */
export function denialDetail(route) {
  if (!route) return null;

  const feature = FEATURE_NAMES[route.requiredCap] ?? null;

  /**
   * `requiresVerified` is reported FIRST, and the order is the whole point.
   *
   * An organizer awaiting approval holds `event.create` and is still refused
   * `/events/new`. Reporting the capability would tell them they lack a permission
   * they actually have, sending them to ask for something they already hold — the
   * mirror of `deniedRoute()`'s own ordering, which tests `requiresVerified` first
   * for the same reason.
   */
  if (route.requiresVerified) {
    return {
      feature,
      reason: 'Your organizer account has not been approved yet.',
      remedy: 'An administrator reviews new organizer requests, usually within a '
        + 'day. Nothing else is needed from you.',
    };
  }

  if (!route.requiredCap) return null;

  return {
    feature,
    reason: feature
      ? `This account does not have permission for ${feature}.`
      : 'This account does not have permission for this area.',
    remedy: UNREACHABLE_BY_GRANT.has(route.requiredCap)
      ? 'This one is reserved for the platform owner and cannot be granted.'
      : 'A WeVolunteer administrator can grant it. If you think you should already '
        + 'have it, signing out and back in picks up a recent change.',
  };
}
