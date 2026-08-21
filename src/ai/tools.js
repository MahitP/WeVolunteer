/**
 * The tools the assistant can execute, and their execution policies.
 *
 * ── The model does not choose these ──
 *
 * Every tool here is selected by `router.js`, deterministically, from the
 * wording of the question. The model is never asked which tool to call and is
 * never given the list. That is not caution for its own sake: multi-step tool
 * calling collapses below roughly two billion parameters, and the models that
 * fit in a browser are far smaller than that. A model picking tools here would
 * be wrong often enough to make the feature untrustworthy.
 *
 * So the application decides, the tool executes via `api.js`, and the model's
 * role is to phrase what came back.
 *
 * ── Safe Mutations: The Draft-and-Confirm Lifecycle ──
 *
 * Write tools (`readOnly: false`, `mode: 'write'`, `confirmation: true`) never
 * execute without explicit confirmation from the user on a generated draft.
 * Read tools (`readOnly: true`, `mode: 'read'`) execute immediately to retrieve
 * facts for the user.
 *
 * ── No new server endpoints ──
 *
 * Every tool maps to a call the application already makes, through the same
 * `api.js` client and therefore the same cookie, the same rate limits and the
 * same authorization. There is no AI-specific route, no AI-specific permission,
 * and nothing here that the signed-in person could not already load or perform
 * by opening the relevant page.
 */

import { api } from '../utils/api';
import { can } from '../authz.js';

/**
 * Valid event categories from server/config.js.
 */
export const VALID_CATEGORIES = Object.freeze(['School', '5K', 'Food Pantry', 'Fundraiser', 'Other']);

/**
 * Valid student grades.
 */
export const VALID_GRADES = Object.freeze([
  '6th', '7th', '8th', '9th', '10th', '11th', '12th', 'College', 'Adult', 'Other',
]);

/**
 * Normalize an event category to a canonical server category.
 */
export function normalizeEventCategory(input) {
  if (!input) return 'Other';
  const raw = String(input).trim();
  const directMatch = VALID_CATEGORIES.find(c => c.toLowerCase() === raw.toLowerCase());
  if (directMatch) return directMatch;

  const lower = raw.toLowerCase();
  if (/\b(food|pantry|hunger|meal|soup|canned|grocer)\b/.test(lower)) return 'Food Pantry';
  if (/\b(5k|run|race|walk|marathon|sports?|athletics?|track)\b/.test(lower)) return '5K';
  if (/\b(school|tutor|tutoring|teach|education|class|reading|stem|math|science|club)\b/.test(lower)) return 'School';
  if (/\b(fundrais|charity|gala|auction|benefit|donation)\b/.test(lower)) return 'Fundraiser';
  return 'Other';
}

/**
 * How sensitive a tool's output is.
 *
 *   PUBLIC        already visible to any signed-in member
 *   USER_PRIVATE  this person's own record, and only ever their own
 */
export const PRIVACY = Object.freeze({
  PUBLIC: 'PUBLIC',
  USER_PRIVATE: 'USER_PRIVATE',
});

/**
 * A timestamp the model can repeat without being wrong.
 */
function localMoment(value) {
  if (!value) return null;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return null;
  try {
    return at.toLocaleString(undefined, {
      weekday: 'short', day: 'numeric', month: 'short',
      hour: 'numeric', minute: '2-digit',
    });
  } catch {
    return at.toISOString();
  }
}

/** The same, without a clock, for things that are a day rather than a moment. */
function localDay(value) {
  if (!value) return null;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return null;
  try {
    return at.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

/** Rows handed to the model, per tool. Enough to answer, far short of a dump. */
const MAX_ROWS = 8;

const ok = (kind, data) => ({ ok: true, kind, data });
const failed = reason => ({ ok: false, reason });

/**
 * Map a thrown ApiError onto something the assistant can say.
 */
function reasonFor(err) {
  if (err?.status === 429) return 'rate_limited';
  if (err?.status === 403 || err?.status === 401) return 'not_allowed';
  if (err?.isNetworkError) return 'offline';
  if (err?.status === 404) return 'not_found';
  return 'unavailable';
}

/**
 * Sanitizes an ID string.
 */
function isValidId(id) {
  return typeof id === 'string' && id.trim().length > 0 && id.length <= 100 && /^[a-zA-Z0-9_#-]+$/.test(id.trim());
}

export const TOOLS = {
  /* ── Student / General Read Tools ────────────────────────────────────────── */

  my_hours: {
    description: 'Verified service hours and volunteering totals for the signed-in person.',
    userFacingAbility: 'tell you your verified hours',
    mode: 'read',
    readOnly: true,
    confirmation: false,
    capability: null,
    privacy: PRIVACY.USER_PRIVATE,
    resourceScope: 'own',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      try {
        const stats = await api.fetchVolunteerStats();
        /**
         * ── `record`, because that is where the numbers are ──
         *
         * This read `stats.hours` and `stats.events ?? stats.attended`.
         * `GET /api/stats/volunteer` returns none of those. Its top level is
         * `{monthlyHours, record, milestones, streak, upcomingCount,
         * serviceHourGoal}` and the figures live one level down, in `record`.
         *
         * So both reads were `undefined`, both `??` defaults fired, and Welly
         * answered "You do not have any verified hours yet" to every student who
         * ever asked — including one whose dashboard, on the same screen, read
         * 209 hours. It was never a rounding difference or a stale cache: the
         * tool was reading fields that have never existed.
         *
         * `hoursCredited` and not the raw attendance sum, because that is the
         * platform's one definition of a credited hour — see the note in
         * organizationHours.js. `eventsAttended` and not `eventsSignedUp`,
         * because the card beside this is labelled "Events attended".
         *
         * Nothing is defaulted away any more. A response missing `record` is a
         * broken endpoint, not a student with no hours, and the two must not
         * produce the same answer — that equivalence is what hid this.
         */
        const record = stats?.record;
        if (!record) return failed('unavailable');

        return ok('hours', {
          hours: Number(record.hoursCredited ?? 0),
          events: Number(record.eventsAttended ?? 0),
        });
      } catch (err) {
        return failed(reasonFor(err));
      }
    },
  },

  my_certificates: {
    description: 'Certificates issued to the signed-in person.',
    userFacingAbility: 'list your certificates and organizations',
    mode: 'read',
    readOnly: true,
    confirmation: false,
    capability: null,
    privacy: PRIVACY.USER_PRIVATE,
    resourceScope: 'own',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      try {
        const rows = await api.fetchCertificates();
        const list = Array.isArray(rows) ? rows : [];
        return ok('certificates', {
          total: list.length,
          items: list.slice(0, MAX_ROWS).map(c => ({
            code: c.code,
            eventTitle: c.title || c.eventTitle || c.event_title,
            hours: c.hours,
            issuedAt: localDay(c.endDatetime || c.createdAt || c.created_at),
          })),
        });
      } catch (err) {
        return failed(reasonFor(err));
      }
    },
  },

  my_organizations: {
    description: 'Organizations the signed-in person belongs to.',
    userFacingAbility: null, // Covered by certificates and organizations phrase
    mode: 'read',
    readOnly: true,
    confirmation: false,
    capability: null,
    privacy: PRIVACY.USER_PRIVATE,
    resourceScope: 'own',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      try {
        const res = await api.fetchOrganizations({ mine: true, limit: MAX_ROWS });
        const list = Array.isArray(res) ? res : (res?.organizations || []);
        return ok('organizations', {
          total: list.length,
          items: list.slice(0, MAX_ROWS).map(o => ({
            name: o.name,
            slug: o.slug,
            role: o.viewerRole || o.viewer_role || null,
          })),
        });
      } catch (err) {
        return failed(reasonFor(err));
      }
    },
  },

  my_applications: {
    description: 'Opportunities the signed-in person has applied to.',
    userFacingAbility: 'show what you have applied to and when your next shift is',
    mode: 'read',
    readOnly: true,
    confirmation: false,
    capability: null,
    privacy: PRIVACY.USER_PRIVATE,
    resourceScope: 'own',
    inputSchema: {
      type: 'object',
      properties: {
        /**
         * Which ones, when the question narrowed it.
         *
         * There was no filter here at all, so "Rejected Applications?" returned
         * every application and the answer named accepted ones. The server has
         * no per-status endpoint and the list is already bounded by the
         * reader's own record, so this filters what came back rather than
         * asking for less.
         *
         * `waitlisted` is not offered: `my_waitlists` is a separate tool with a
         * card that shows the place in the queue, and the router reaches it
         * first.
         */
        status: { type: 'string', enum: ['pending', 'accepted', 'rejected', 'withdrawn'] },
      },
      additionalProperties: false,
    },
    async run({ status = null } = {}) {
      try {
        const rows = await api.fetchApplications();
        const all = Array.isArray(rows) ? rows : [];
        const list = status
          ? all.filter(a => String(a.status || '').toLowerCase() === status)
          : all;
        return ok('applications', {
          total: list.length,
          /* Echoed back so the sentence can name what was asked for. Without it
             a filtered empty result reads as "you have not applied to anything
             yet", which is a different and wrong statement. */
          status,
          items: list.slice(0, MAX_ROWS).map(a => ({
            id: a.id,
            eventTitle: a.event?.title || a.eventTitle || a.event_title,
            status: a.status,
            slotName: a.slot?.name || a.slotName || a.slot_name || null,
          })),
        });
      } catch (err) {
        return failed(reasonFor(err));
      }
    },
  },

  search_opportunities: {
    description: 'Open opportunities, optionally filtered by words, tags or distance.',
    userFacingAbility: 'find opportunities',
    mode: 'read',
    readOnly: true,
    confirmation: false,
    capability: null,
    privacy: PRIVACY.PUBLIC,
    resourceScope: 'global',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: 200 },
        tags: { type: 'array', items: { type: 'string' } },
        maxDistance: { type: 'number', minimum: 0, maximum: 500 },
        lat: { type: 'number' },
        lng: { type: 'number' },
      },
      additionalProperties: false,
    },
    async run({ query, tags, maxDistance, lat, lng } = {}) {
      try {
        const res = await api.fetchEventsFiltered({
          q: typeof query === 'string' ? query.slice(0, 200) : '',
          tags: Array.isArray(tags) && tags.length ? tags.map(t => String(t).slice(0, 50)).join(',') : '',
          openOnly: true,
          sort: typeof lat === 'number' && typeof lng === 'number' ? 'distance' : 'soonest',
          lat: typeof lat === 'number' ? lat : undefined,
          lng: typeof lng === 'number' ? lng : undefined,
          maxDistance: typeof maxDistance === 'number' ? maxDistance : undefined,
          limit: MAX_ROWS,
        });
        const list = res?.events || [];
        return ok('opportunities', {
          total: res?.pagination?.total ?? list.length,
          items: list.slice(0, MAX_ROWS).map(e => ({
            id: e.id,
            title: e.title,
            location: e.location,
            category: e.category,
            tags: (e.tags || []).slice(0, 3).map(t => t.label || t),
            distance: typeof e.distance === 'number' ? e.distance : null,
            deadline: localDay(e.applicationDeadline || e.application_deadline),
          })),
        });
      } catch (err) {
        return failed(reasonFor(err));
      }
    },
  },

  my_next_shift: {
    description: 'The next shift the signed-in person is confirmed or waitlisted for.',
    userFacingAbility: null, // Covered by my_applications ability phrase
    mode: 'read',
    readOnly: true,
    confirmation: false,
    capability: null,
    privacy: PRIVACY.USER_PRIVATE,
    resourceScope: 'own',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      try {
        const rows = await api.fetchApplications();
        const list = Array.isArray(rows) ? rows : [];
        const now = Date.now();
        const upcoming = list
          .filter(a => a.status === 'accepted' && a.slot?.startDatetime)
          .filter(a => Date.parse(a.slot.startDatetime) >= now)
          .sort((x, y) => Date.parse(x.slot.startDatetime) - Date.parse(y.slot.startDatetime));

        const next = upcoming[0] || null;
        return ok('next_shift', {
          total: upcoming.length,
          next: next && {
            eventTitle: next.event?.title || null,
            slotName: next.slot?.name || null,
            startsAt: localMoment(next.slot.startDatetime),
            hours: next.slot?.hours ?? null,
          },
        });
      } catch (err) {
        return failed(reasonFor(err));
      }
    },
  },

  my_waitlists: {
    description: 'Shifts the signed-in person is waitlisted for, and their place in the queue.',
    userFacingAbility: null,
    mode: 'read',
    readOnly: true,
    confirmation: false,
    capability: null,
    privacy: PRIVACY.USER_PRIVATE,
    resourceScope: 'own',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      try {
        const rows = await api.fetchApplications();
        const list = (Array.isArray(rows) ? rows : []).filter(a => a.status === 'waitlisted');
        return ok('waitlists', {
          total: list.length,
          items: list.slice(0, MAX_ROWS).map(a => ({
            eventTitle: a.event?.title || null,
            slotName: a.slot?.name || null,
            position: a.waitlistOrder ?? null,
          })),
        });
      } catch (err) {
        return failed(reasonFor(err));
      }
    },
  },

  my_notifications: {
    description: 'Recent notifications for the signed-in person.',
    userFacingAbility: 'show your recent notifications',
    mode: 'read',
    readOnly: true,
    confirmation: false,
    capability: null,
    privacy: PRIVACY.USER_PRIVATE,
    resourceScope: 'own',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      try {
        const res = await api.fetchNotifications(MAX_ROWS);
        const list = Array.isArray(res) ? res : (res?.notifications || []);
        return ok('notifications', {
          total: list.length,
          items: list.slice(0, MAX_ROWS).map(n => ({
            id: n.id,
            title: n.title,
            body: n.body,
            read: Boolean(n.read),
            at: localMoment(n.createdAt || n.created_at),
          })),
        });
      } catch (err) {
        return failed(reasonFor(err));
      }
    },
  },

  my_profile: {
    description: 'Profile details for the signed-in person.',
    userFacingAbility: null,
    mode: 'read',
    readOnly: true,
    confirmation: false,
    capability: null,
    privacy: PRIVACY.USER_PRIVATE,
    resourceScope: 'own',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      try {
        const res = await api.getMe();
        const user = res?.user || res;
        if (!user) return failed('unavailable');
        return ok('profile', {
          name: user.name || null,
          role: user.role || null,
          email: user.email || null,
          bio: user.bio || null,
          school: user.school || null,
          grade: user.grade || null,
          hours: user.hours ?? 0,
        });
      } catch (err) {
        return failed(reasonFor(err));
      }
    },
  },

  event_details: {
    description: 'Look up specific event details including shift slots.',
    userFacingAbility: null,
    mode: 'read',
    readOnly: true,
    confirmation: false,
    capability: null,
    privacy: PRIVACY.PUBLIC,
    resourceScope: 'global',
    inputSchema: {
      type: 'object',
      properties: { eventId: { type: 'string', maxLength: 100 } },
      required: ['eventId'],
      additionalProperties: false,
    },
    async run({ eventId } = {}) {
      if (!isValidId(eventId)) return failed('missing_event_id');
      try {
        const res = await api.fetchEventDetails(eventId.trim());
        const event = res?.event || res;
        if (!event) return failed('not_found');
        return ok('event_details', {
          id: event.id,
          title: event.title,
          description: event.description,
          category: event.category,
          location: event.location,
          deadline: localDay(event.applicationDeadline || event.application_deadline),
          slots: (event.slots || []).slice(0, MAX_ROWS).map(s => ({
            name: s.name,
            startsAt: localMoment(s.startDatetime || s.start_datetime),
            endsAt: localMoment(s.endDatetime || s.end_datetime),
            maxSpots: s.maxSpots ?? s.max_spots ?? 0,
          })),
        });
      } catch (err) {
        return failed(reasonFor(err));
      }
    },
  },

  verify_certificate: {
    description: 'Check a certificate code against the verification service.',
    userFacingAbility: 'check a certificate code',
    mode: 'read',
    readOnly: true,
    confirmation: false,
    capability: null,
    privacy: PRIVACY.PUBLIC,
    resourceScope: 'global',
    inputSchema: {
      type: 'object',
      properties: { code: { type: 'string', pattern: '^WEV-[0-9A-HJ-NP-Z]{4}-[0-9A-HJ-NP-Z]{4}$' } },
      required: ['code'],
      additionalProperties: false,
    },
    async run({ code } = {}) {
      if (!code || typeof code !== 'string') return failed('missing_code');
      const cleanCode = code.trim().toUpperCase();
      try {
        const res = await api.verifyCertificate(cleanCode);
        return ok('certificate', { valid: res?.valid === true, ...res });
      } catch (err) {
        const reason = reasonFor(err);
        if (err?.status === 404) return ok('certificate', { valid: false, code: cleanCode });
        return failed(reason);
      }
    },
  },

  /* ── Organizer Read Tools ────────────────────────────────────────────────── */

  my_events: {
    description: 'Events the signed-in organizer runs, with how full each one is.',
    userFacingAbility: 'show the events you run and how full they are',
    mode: 'read',
    readOnly: true,
    confirmation: false,
    privacy: PRIVACY.USER_PRIVATE,
    capability: 'event.create',
    resourceScope: 'own',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      try {
        const res = await api.fetchEvents({ mine: true, limit: MAX_ROWS });
        const list = Array.isArray(res) ? res : (res?.events || []);
        return ok('my_events', {
          total: list.length,
          items: list.slice(0, MAX_ROWS).map(e => ({
            id: e.id,
            title: e.title,
            status: e.status,
            spotsRemaining: e.spotsRemaining ?? e.spots_remaining ?? null,
            deadline: localDay(e.applicationDeadline || e.application_deadline),
          })),
        });
      } catch (err) {
        return failed(reasonFor(err));
      }
    },
  },

  my_vacant_events: {
    description: 'Events you organize that currently need more volunteers.',
    userFacingAbility: 'find which of your events need more volunteers',
    mode: 'read',
    readOnly: true,
    confirmation: false,
    privacy: PRIVACY.USER_PRIVATE,
    capability: 'event.create',
    resourceScope: 'own',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      try {
        const res = await api.fetchEvents({ mine: true, limit: 50 });
        const list = Array.isArray(res) ? res : (res?.events || []);
        const vacant = list.filter(e => (e.spotsRemaining ?? e.spots_remaining ?? 0) > 0 && e.status === 'open');
        return ok('vacant_events', {
          total: vacant.length,
          items: vacant.slice(0, MAX_ROWS).map(e => ({
            id: e.id,
            title: e.title,
            spotsRemaining: e.spotsRemaining ?? e.spots_remaining ?? 0,
            deadline: localDay(e.applicationDeadline || e.application_deadline),
          })),
        });
      } catch (err) {
        return failed(reasonFor(err));
      }
    },
  },

  organizer_summary: {
    description: 'Totals across the events the signed-in organizer runs.',
    userFacingAbility: null,
    mode: 'read',
    readOnly: true,
    confirmation: false,
    privacy: PRIVACY.USER_PRIVATE,
    capability: 'event.create',
    resourceScope: 'own',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      try {
        const stats = await api.fetchOrganizerStats();
        return ok('organizer_summary', {
          events: Number(stats?.events ?? 0),
          volunteers: Number(stats?.volunteers ?? stats?.totalVolunteers ?? 0),
          hours: Number(stats?.hours ?? stats?.totalHours ?? 0),
          pending: Number(stats?.pendingApplications ?? stats?.pending ?? 0),
        });
      } catch (err) {
        return failed(reasonFor(err));
      }
    },
  },

  event_roster: {
    description: 'Attendee check-in roster for an event you organize.',
    userFacingAbility: 'view attendee check-in rosters for your events',
    mode: 'read',
    readOnly: true,
    confirmation: false,
    privacy: PRIVACY.USER_PRIVATE,
    capability: 'attendance.view',
    resourceScope: 'own',
    inputSchema: {
      type: 'object',
      properties: { eventId: { type: 'string', maxLength: 100 } },
      required: ['eventId'],
      additionalProperties: false,
    },
    async run({ eventId } = {}) {
      if (!isValidId(eventId)) return failed('missing_event_id');
      try {
        const res = await api.fetchCheckins(eventId.trim());
        const list = Array.isArray(res) ? res : (res?.checkins || res?.roster || []);
        return ok('event_roster', {
          eventId: eventId.trim(),
          total: list.length,
          items: list.slice(0, MAX_ROWS).map(r => ({
            name: r.name || r.userName || r.user_name || 'Volunteer',
            status: r.status || (r.present ? 'present' : 'registered'),
            slotName: r.slotName || r.slot_name || null,
          })),
        });
      } catch (err) {
        return failed(reasonFor(err));
      }
    },
  },

  /* ── Admin / Platform Read Tools ─────────────────────────────────────────── */

  platform_stats: {
    description: 'Platform-wide totals for an administrator.',
    userFacingAbility: 'show platform totals',
    mode: 'read',
    readOnly: true,
    confirmation: false,
    privacy: PRIVACY.USER_PRIVATE,
    capability: 'analytics.platform',
    resourceScope: 'global',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      try {
        const stats = await api.fetchAdminStats();
        return ok('platform_stats', {
          users: Number(stats?.users ?? stats?.totalUsers ?? 0),
          events: Number(stats?.events ?? stats?.totalEvents ?? 0),
          hours: Number(stats?.hours ?? stats?.totalHours ?? 0),
          openReports: Number(stats?.openReports ?? stats?.reports ?? 0),
        });
      } catch (err) {
        return failed(reasonFor(err));
      }
    },
  },

  admin_reports_summary: {
    description: 'Summary of open safety reports for an administrator.',
    userFacingAbility: 'summarize open safety reports',
    mode: 'read',
    readOnly: true,
    confirmation: false,
    privacy: PRIVACY.USER_PRIVATE,
    capability: 'report.resolve',
    resourceScope: 'global',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      try {
        const stats = await api.fetchAdminStats();
        return ok('admin_reports', {
          openReports: Number(stats?.openReports ?? stats?.reports ?? 0),
          totalUsers: Number(stats?.users ?? stats?.totalUsers ?? 0),
          totalEvents: Number(stats?.events ?? stats?.totalEvents ?? 0),
        });
      } catch (err) {
        return failed(reasonFor(err));
      }
    },
  },

  admin_appeals_summary: {
    description: 'Summary of pending suspension appeals for an administrator.',
    userFacingAbility: 'summarize pending suspension appeals',
    mode: 'read',
    readOnly: true,
    confirmation: false,
    privacy: PRIVACY.USER_PRIVATE,
    capability: 'appeal.review',
    resourceScope: 'global',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      try {
        const res = await api.fetchAdminAppeals();
        const list = Array.isArray(res) ? res : (res?.appeals || []);
        return ok('admin_appeals', {
          total: list.length,
          items: list.slice(0, MAX_ROWS).map(a => ({
            id: a.id,
            subject: a.subject || 'Appeal',
            status: a.status || 'pending',
            at: localMoment(a.createdAt || a.created_at),
          })),
        });
      } catch (err) {
        return failed(reasonFor(err));
      }
    },
  },

  system_health: {
    description: 'Whether anything is currently failing, for an owner.',
    userFacingAbility: 'check system error health',
    mode: 'read',
    readOnly: true,
    confirmation: false,
    privacy: PRIVACY.USER_PRIVATE,
    capability: 'error.read',
    resourceScope: 'global',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      try {
        const summary = await api.fetchErrorSummary();
        return ok('system_health', {
          openGroups: Number(summary?.openGroups ?? summary?.open ?? 0),
          last24h: Number(summary?.last24h ?? summary?.recent ?? 0),
        });
      } catch (err) {
        return failed(reasonFor(err));
      }
    },
  },

  recent_audit: {
    description: 'The most recent entries in the administrative audit trail.',
    userFacingAbility: 'show the recent audit trail',
    mode: 'read',
    readOnly: true,
    confirmation: false,
    privacy: PRIVACY.USER_PRIVATE,
    capability: 'audit.read',
    resourceScope: 'global',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      try {
        const res = await api.fetchAuditLogs({ limit: MAX_ROWS });
        const list = Array.isArray(res) ? res : (res?.logs || res?.entries || []);
        return ok('recent_audit', {
          total: list.length,
          items: list.slice(0, MAX_ROWS).map(r => ({
            action: r.action,
            at: localMoment(r.createdAt || r.created_at),
          })),
        });
      } catch (err) {
        return failed(reasonFor(err));
      }
    },
  },

  /* ── Student Write Tools (Draft & Confirm Required) ─────────────────────── */

  withdraw_application: {
    description: 'Withdraw your own event application.',
    userFacingAbility: 'withdraw an application you have submitted',
    mode: 'write',
    readOnly: false,
    confirmation: true,
    privacy: PRIVACY.USER_PRIVATE,
    capability: 'application.withdraw',
    resourceScope: 'own',
    inputSchema: {
      type: 'object',
      properties: { applicationId: { type: 'string', maxLength: 100 } },
      required: ['applicationId'],
      additionalProperties: false,
    },
    async run({ applicationId } = {}) {
      if (!isValidId(applicationId)) return failed('missing_application_id');
      try {
        const res = await api.withdrawApplication(applicationId.trim());
        return ok('application_withdrawn', {
          id: applicationId.trim(),
          status: 'withdrawn',
          released: Boolean(res?.released),
        });
      } catch (err) {
        return failed(reasonFor(err));
      }
    },
  },

  update_profile: {
    description: 'Update fields on your volunteer profile.',
    userFacingAbility: 'update your profile information',
    mode: 'write',
    readOnly: false,
    confirmation: true,
    privacy: PRIVACY.USER_PRIVATE,
    capability: 'self.write',
    resourceScope: 'own',
    inputSchema: {
      type: 'object',
      properties: {
        fields: {
          type: 'object',
          properties: {
            name: { type: 'string', maxLength: 100 },
            bio: { type: 'string', maxLength: 500 },
            school: { type: 'string', maxLength: 200 },
            grade: { type: 'string', enum: VALID_GRADES },
            location: { type: 'string', maxLength: 80 },
            skills: { type: 'array', items: { type: 'string', maxLength: 50 } },
            hobbies: { type: 'array', items: { type: 'string', maxLength: 50 } },
          },
          additionalProperties: false,
        },
      },
      required: ['fields'],
      additionalProperties: false,
    },
    async run({ fields = {} } = {}) {
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return failed('missing_fields');

      // Strip prototype pollution keys & whitelist allowed fields
      const cleanPatch = {};
      const allowed = ['name', 'bio', 'school', 'grade', 'avatar', 'avatarColor', 'location', 'skills', 'hobbies'];
      for (const key of allowed) {
        if (Object.prototype.hasOwnProperty.call(fields, key) && fields[key] !== undefined) {
          cleanPatch[key] = fields[key];
        }
      }

      if (Object.keys(cleanPatch).length === 0) return failed('missing_fields');

      try {
        const res = await api.updateProfile(cleanPatch);
        return ok('profile_updated', {
          user: res?.user || null,
          updated: Object.keys(cleanPatch),
        });
      } catch (err) {
        return failed(reasonFor(err));
      }
    },
  },

  update_preferences: {
    description: 'Update your notification channel preferences.',
    userFacingAbility: null,
    mode: 'write',
    readOnly: false,
    confirmation: true,
    privacy: PRIVACY.USER_PRIVATE,
    capability: 'self.write',
    resourceScope: 'own',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', maxLength: 50 },
        channel: { type: 'string', enum: ['email', 'in_app', 'sms'] },
        enabled: { type: 'boolean' },
      },
      required: ['category', 'channel', 'enabled'],
      additionalProperties: false,
    },
    async run({ category, channel, enabled } = {}) {
      if (!category || typeof category !== 'string' || !channel || typeof channel !== 'string' || typeof enabled !== 'boolean') {
        return failed('missing_preference_params');
      }
      try {
        await api.updateUserPreference(category.trim(), channel.trim(), enabled);
        return ok('preferences_updated', { category, channel, enabled });
      } catch (err) {
        return failed(reasonFor(err));
      }
    },
  },

  /* ── Organizer Write Tools (Draft & Confirm Required) ───────────────────── */

  create_event: {
    description: 'Create a new volunteer event with shift slots.',
    userFacingAbility: 'draft and create a new volunteer event',
    mode: 'write',
    readOnly: false,
    confirmation: true,
    privacy: PRIVACY.USER_PRIVATE,
    capability: 'event.create',
    resourceScope: 'own',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 200 },
        category: { type: 'string', enum: VALID_CATEGORIES },
        location: { type: 'string', minLength: 1, maxLength: 300 },
        description: { type: 'string', maxLength: 5000 },
        applicationDeadline: { type: 'string' },
        slots: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', minLength: 1, maxLength: 100 },
              startDatetime: { type: 'string' },
              endDatetime: { type: 'string' },
              maxSpots: { type: 'integer', minimum: 1, maximum: 100 },
            },
            required: ['name', 'startDatetime', 'endDatetime', 'maxSpots'],
            additionalProperties: false,
          },
        },
      },
      required: ['title', 'category', 'location', 'slots'],
      additionalProperties: false,
    },
    async run(eventData = {}) {
      const cleanTitle = typeof eventData.title === 'string' ? eventData.title.trim().slice(0, 200) : '';
      const cleanCategory = normalizeEventCategory(eventData.category);
      const cleanLocation = typeof eventData.location === 'string' ? eventData.location.trim().slice(0, 300) : '';
      const slots = Array.isArray(eventData.slots) && eventData.slots.length ? eventData.slots : null;

      if (!cleanTitle || !cleanCategory || !cleanLocation || !slots) {
        return failed('missing_event_fields');
      }

      const payload = {
        title: cleanTitle,
        category: cleanCategory,
        location: cleanLocation,
        description: typeof eventData.description === 'string' ? eventData.description.trim().slice(0, 5000) : `Volunteer event for ${cleanTitle}.`,
        applicationDeadline: eventData.applicationDeadline || new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
        slots: slots.map(s => ({
          name: typeof s.name === 'string' ? s.name.trim().slice(0, 100) : 'General Shift',
          startDatetime: s.startDatetime || new Date(Date.now() + 8 * 86400000).toISOString(),
          endDatetime: s.endDatetime || new Date(Date.now() + 8 * 86400000 + 3 * 3600000).toISOString(),
          maxSpots: Math.max(1, Math.min(100, Number(s.maxSpots) || 10)),
        })),
      };

      try {
        const res = await api.createEvent(payload);
        return ok('event_created', {
          id: res.id,
          title: res.title || payload.title,
          status: res.status || 'open',
        });
      } catch (err) {
        return failed(reasonFor(err));
      }
    },
  },
};

/** Tool names, for tests and for capability verification. */
export const TOOL_NAMES = Object.keys(TOOLS);

/**
 * Run a tool by name.
 *
 * Refuses an unknown name rather than throwing, because the caller is a router
 * whose job is to keep going.
 */
export async function runTool(name, args = {}, { user = null } = {}) {
  const tool = TOOLS[name];
  if (!tool) return failed('unknown_tool');

  if (tool.capability && !can(user, tool.capability)) return failed('not_allowed');

  return tool.run(args, { user });
}
