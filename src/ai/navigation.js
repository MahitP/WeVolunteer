/**
 * Navigation destination mapper for Welly.
 *
 * Maps natural language navigation requests ("take me to my applications",
 * "open settings", "go to calendar") to verified, allowlisted application routes.
 */

import { can } from '../authz.js';

export const DESTINATIONS = Object.freeze({
  /**
   * The one destination that was missing, and the reasoning for the one that
   * still is.
   *
   * "Take me to my dashboard" is the most ordinary navigation request in the
   * product — Dashboard is the first entry in the rail — and it resolved to
   * nothing, so the router's `navigate` rule failed and the sentence fell
   * through to `unknown`.
   *
   * `self.read` rather than no capability: a partner has no dashboard at all
   * (see `DASHBOARD_NAV` and the explicit no-dashboard state in App.jsx), and
   * `self.read` is precisely the capability partners lack.
   *
   * There is deliberately no `welly` destination. Welly is a destination now,
   * but the only place to ask Welly to open Welly is the page itself, so the
   * entry would resolve to where the reader already is.
   */
  dashboard: {
    path: '/',
    label: 'Your Dashboard',
    capability: 'self.read',
    patterns: [/\bdashboard\b/i, /\bhome (page|screen)\b/i],
  },
  applications: {
    /**
     * The dashboard, because that is where a student's applications are.
     *
     * This was `/discover?find=applications`, and `find` is a SCOPE:
     * `BrowseEvents` accepts `all | events | people | organizations` and
     * silently falls back to `all` for anything else. So Welly said
     * "Navigating to Your Applications" and delivered the generic Discover
     * page — reachable through any explicit phrasing ("take me to my
     * applications", "open my sign-ups"), which is what the `navigate` intent
     * matches on.
     *
     * There is no applications page to point at instead. A student's pending
     * and confirmed applications are sections of the volunteer dashboard
     * ("Waiting on a reply", "Confirmed shifts"), so the dashboard is the
     * honest destination. The label still describes what they asked for.
     */
    path: '/',
    label: 'Your Applications',
    capability: null,
    patterns: [/\b(my\s+)?applications?\b/i, /\b(my\s+)?sign-?ups?\b/i, /\bwhat i applied to\b/i],
  },
  discover: {
    path: '/discover',
    label: 'Discover Opportunities',
    capability: 'event.view',
    patterns: [/\b(discover|opportunities|find events|browse events|volunteer opportunities)\b/i],
  },
  calendar: {
    path: '/calendar',
    label: 'Calendar',
    capability: 'event.view',
    patterns: [/\bcalendar\b/i, /\bschedule\b/i],
  },
  settings: {
    path: '/settings',
    label: 'Settings',
    capability: null,
    patterns: [/\bsettings\b/i, /\bpreferences\b/i],
  },
  privacy: {
    path: '/settings?section=privacy',
    label: 'Privacy Settings',
    capability: null,
    patterns: [/\bprivacy(\s+settings)?\b/i],
  },
  security: {
    path: '/settings?section=security',
    label: 'Security & 2FA Settings',
    capability: null,
    patterns: [/\bsecurity(\s+settings)?\b/i, /\bpassword\b/i, /\b2fa\b/i, /\btwo-?factor\b/i],
  },
  profile: {
    path: '/profile',
    label: 'Your Profile',
    capability: null,
    patterns: [/\b(my\s+)?profile\b/i, /\babout me\b/i, /\bmy account\b/i],
  },
  hours: {
    path: '/hours',
    label: 'Service Hours',
    capability: 'portfolio.write',
    patterns: [/\b(my\s+)?hours\b/i, /\bvolunteer hours\b/i, /\bservice log\b/i],
  },
  external_hours: {
    path: '/hours/external',
    label: 'Log External Hours',
    capability: 'portfolio.write',
    patterns: [/\b(log|add)\s+(external\s+)?hours\b/i, /\bexternal hours\b/i],
  },
  certificates: {
    path: '/certificates',
    label: 'Your Certificates',
    capability: 'portfolio.write',
    patterns: [/\b(my\s+)?certificates\b/i],
  },
  badges: {
    path: '/profile/badges',
    label: 'Your Badges',
    capability: 'portfolio.write',
    patterns: [/\b(my\s+)?badges\b/i, /\bachievements\b/i],
  },
  organizations: {
    path: '/organizations',
    label: 'Organizations & Clubs',
    capability: 'organization.join',
    patterns: [/\b(my\s+)?(organizations|clubs|groups)\b/i],
  },
  new_organization: {
    path: '/organizations/new',
    label: 'Create an Organization',
    capability: 'organization.create',
    patterns: [/\b(create|start|new)\s+(organization|club|group)\b/i],
  },
  messages: {
    path: '/messages',
    label: 'Messages',
    capability: 'message.send',
    patterns: [/\b(my\s+)?(messages|inbox|chats)\b/i],
  },
  notifications: {
    path: '/notifications',
    label: 'Notifications',
    capability: null,
    patterns: [/\b(my\s+)?notifications\b/i],
  },
  directory: {
    path: '/discover?find=people',
    label: 'Member Directory',
    capability: 'directory.read',
    patterns: [/\b(member\s+)?directory\b/i, /\bfind people\b/i, /\bsearch users\b/i],
  },
  create_event: {
    path: '/events/new',
    label: 'Create an Event',
    capability: 'event.create',
    patterns: [/\b(create|new|post|add)\s+event\b/i, /\bcreate event page\b/i],
  },
  admin_moderation: {
    path: '/admin/moderation',
    label: 'Moderation Center',
    capability: 'report.resolve',
    patterns: [/\bmoderation(\s+center)?\b/i, /\breports\b/i],
  },
  admin_appeals: {
    path: '/admin/appeals',
    label: 'Appeals Review',
    capability: 'appeal.review',
    patterns: [/\badmin\s+appeals\b/i, /\breview appeals\b/i],
  },
  admin_roster: {
    path: '/admin/roster',
    label: 'Administrator Roster',
    capability: 'admin.create',
    patterns: [/\b(admin(istrator)?\s+)?roster\b/i],
  },
  admin_audit: {
    path: '/admin/audit-logs',
    label: 'Audit Explorer',
    capability: 'audit.read',
    patterns: [/\baudit(\s+logs?|\s+trail|\s+explorer)?\b/i],
  },
  admin_impact: {
    path: '/admin/impact',
    label: 'Platform Impact Analytics',
    capability: 'analytics.platform',
    patterns: [/\b(platform\s+)?impact\b/i, /\banalytics\b/i],
  },
});

/**
 * Identify destination from natural language.
 *
 * Returns `{ key, path, label, allowed }` or `null`.
 */
export function resolveNavigation(text, user = null) {
  const clean = String(text || '').trim();
  if (!clean) return null;

  for (const [key, dest] of Object.entries(DESTINATIONS)) {
    const matches = dest.patterns.some(p => p.test(clean));
    if (matches) {
      const allowed = !dest.capability || can(user, dest.capability);
      return {
        key,
        path: dest.path,
        label: dest.label,
        allowed,
        capability: dest.capability,
      };
    }
  }

  return null;
}
