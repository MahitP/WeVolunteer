/**
 * The only things the assistant can look up, and how.
 *
 * ── The model does not choose these ──
 *
 * Every tool here is selected by `router.js`, deterministically, from the
 * wording of the question. The model is never asked which tool to call and is
 * never given the list. That is not caution for its own sake: multi-step tool
 * calling collapses below roughly two billion parameters, and the models that
 * fit in a browser are far smaller than that. A model picking tools here would
 * be wrong often enough to make the feature untrustworthy, and the failure
 * would look like the assistant confidently answering the wrong question.
 *
 * So the application decides, the tool returns facts, and the model's only job
 * is to phrase what came back.
 *
 * ── No new server endpoints ──
 *
 * Every tool maps to a call the application already makes, through the same
 * `api.js` client and therefore the same cookie, the same rate limits and the
 * same authorization. There is no AI-specific route, no AI-specific permission,
 * and nothing here that the signed-in person could not already load by opening
 * the relevant page.
 *
 * That is what makes "the assistant cannot see anything you cannot" a property
 * of the architecture rather than a promise about behaviour. The server refuses
 * a request it would refuse anyway, before the assistant is involved.
 *
 * ── Note on what is deliberately absent ──
 *
 * There is no `get_opportunity` tool. `GET /api/events/:id` is staff-only and
 * answers 403 to a student even for an event they applied to, so the list
 * endpoint is the only read path a volunteer has. Adding a tool that 403s for
 * most users would be a worse answer than not having one.
 *
 * Nothing here writes. Every tool is read-only, and that is asserted by a test
 * rather than left as an intention.
 */

import { api } from '../utils/api';
import { can } from '../authz.js';

/**
 * How sensitive a tool's output is.
 *
 *   PUBLIC        already visible to any signed-in member
 *   USER_PRIVATE  this person's own record, and only ever their own
 *
 * There is deliberately no SENSITIVE class. Authentication material, security
 * codes and another person's private record are not reachable from here at all,
 * so a classification for them would imply a door that does not exist.
 */
export const PRIVACY = Object.freeze({
  PUBLIC: 'PUBLIC',
  USER_PRIVATE: 'USER_PRIVATE',
});

/**
 * A timestamp the model can repeat without being wrong.
 *
 * Dates reach the model as ISO strings in UTC — `2026-08-31T11:30:00.000Z` — and
 * a model has no timezone and no reason to convert one. Asked when their next
 * shift was, the 1.5B model read those digits and answered "11:30 AM" for a
 * shift the rest of the app correctly shows as 7:30 AM. Four hours out, stated
 * with complete confidence, and nothing in the sentence to suggest doubt.
 *
 * That is the same class of error the whole design avoids elsewhere: the tool
 * returns facts and the model only phrases them. A UTC instant is not a fact a
 * student can act on — the local time is — so the conversion belongs here,
 * where `Intl` does it correctly, rather than in a prompt asking a small model
 * to do arithmetic.
 *
 * Returns null for anything unparseable, because a wrong date is worse than an
 * absent one and the callers already handle null.
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

/**
 * A failure and an empty result are different answers and must never collapse
 * into one. "I could not find any opportunities" when the request actually
 * failed is a false statement about the world, and it is the single most
 * likely way this feature would mislead somebody.
 */
const ok = (kind, data) => ({ ok: true, kind, data });
const failed = reason => ({ ok: false, reason });

/**
 * Map a thrown ApiError onto something the assistant can say.
 *
 * 429 is called out because certificate verification is rate limited and the
 * endpoint's own copy is explicit that a 429 is not a verdict on the
 * certificate. Reporting "not valid" there would be actively harmful.
 */
function reasonFor(err) {
  if (err?.status === 429) return 'rate_limited';
  if (err?.status === 403 || err?.status === 401) return 'not_allowed';
  if (err?.isNetworkError) return 'offline';
  return 'unavailable';
}

export const TOOLS = {
  my_hours: {
    description: 'Verified service hours and volunteering totals for the signed-in person.',
    privacy: PRIVACY.USER_PRIVATE,
    readOnly: true,
    async run() {
      try {
        const stats = await api.fetchVolunteerStats();
        return ok('hours', {
          hours: Number(stats?.hours ?? 0),
          events: Number(stats?.events ?? stats?.attended ?? 0),
        });
      } catch (err) {
        return failed(reasonFor(err));
      }
    },
  },

  my_certificates: {
    description: 'Certificates issued to the signed-in person.',
    privacy: PRIVACY.USER_PRIVATE,
    readOnly: true,
    async run() {
      try {
        const rows = await api.fetchCertificates();
        const list = Array.isArray(rows) ? rows : [];
        return ok('certificates', {
          total: list.length,
          items: list.slice(0, MAX_ROWS).map(c => ({
            code: c.code,
            /* `/api/certificates` returns the event name as a flat `title` —
               see the mapping in attendanceRoutes.js. Reading `eventTitle` or
               `event_title` found neither, so every row reached the card with
               an undefined name and the model with a nameless row. The two
               camelCase spellings are kept as fallbacks; `title` is the one
               that actually arrives. */
            eventTitle: c.title || c.eventTitle || c.event_title,
            hours: c.hours,
            /* That response carries no created/issued timestamp. The end of the
               service is the date the certificate is actually about. */
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
    privacy: PRIVACY.USER_PRIVATE,
    readOnly: true,
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
    privacy: PRIVACY.USER_PRIVATE,
    readOnly: true,
    async run() {
      try {
        const rows = await api.fetchApplications();
        const list = Array.isArray(rows) ? rows : [];
        return ok('applications', {
          total: list.length,
          /**
           * The event name and shift are NESTED on this response.
           *
           * `/api/applications` returns `event: { title, … }` and
           * `slot: { name, … }` — applicationRoutes.js builds them that way.
           * Reading a flat `eventTitle` found nothing, so every application
           * arrived with an undefined name: the card listed bare statuses with
           * no events beside them, and the model, handed rows with nothing in
           * them, answered "You have not participated in any events yet" to
           * somebody who had two applications. Observed 2026-08-19.
           */
          items: list.slice(0, MAX_ROWS).map(a => ({
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
    privacy: PRIVACY.PUBLIC,
    readOnly: true,
    /**
     * Filters go to the server, which owns every predicate in SQL. Nothing is
     * filtered here afterwards — a client-side narrowing of a server page is a
     * wrong answer rather than a slow one, because it can only ever see the
     * rows that happened to be fetched.
     */
    async run({ query, tags, maxDistance, lat, lng } = {}) {
      try {
        const res = await api.fetchEventsFiltered({
          q: query || '',
          tags: Array.isArray(tags) && tags.length ? tags.join(',') : '',
          openOnly: true,
          sort: lat != null && lng != null ? 'distance' : 'soonest',
          lat, lng, maxDistance,
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

  /* ── Student: their own record, asked the way people actually ask ────────── */

  my_next_shift: {
    description: 'The next shift the signed-in person is confirmed or waitlisted for.',
    privacy: PRIVACY.USER_PRIVATE,
    readOnly: true,
    async run() {
      try {
        const rows = await api.fetchApplications();
        const list = Array.isArray(rows) ? rows : [];
        const now = Date.now();
        /* Accepted first, then soonest. A pending application is not a shift
           somebody has — saying "your next shift" about one would promise a
           place the organizer has not given. */
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
    privacy: PRIVACY.USER_PRIVATE,
    readOnly: true,
    async run() {
      try {
        const rows = await api.fetchApplications();
        const list = (Array.isArray(rows) ? rows : []).filter(a => a.status === 'waitlisted');
        return ok('waitlists', {
          total: list.length,
          items: list.slice(0, MAX_ROWS).map(a => ({
            eventTitle: a.event?.title || null,
            slotName: a.slot?.name || null,
            /* Surfaced because "am I on a waitlist" is nearly always followed by
               "where am I in it", and the answer is already on the row. */
            position: a.waitlistOrder ?? null,
          })),
        });
      } catch (err) {
        return failed(reasonFor(err));
      }
    },
  },

  /* ── Organizer ───────────────────────────────────────────────────────────── */

  my_events: {
    description: 'Events the signed-in organizer runs, with how full each one is.',
    privacy: PRIVACY.USER_PRIVATE,
    capability: 'event.create',
    readOnly: true,
    async run() {
      try {
        const res = await api.fetchEvents({ mine: true, limit: MAX_ROWS });
        const list = Array.isArray(res) ? res : (res?.events || []);
        return ok('my_events', {
          total: list.length,
          items: list.slice(0, MAX_ROWS).map(e => ({
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

  organizer_summary: {
    description: 'Totals across the events the signed-in organizer runs.',
    privacy: PRIVACY.USER_PRIVATE,
    capability: 'event.create',
    readOnly: true,
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

  /* ── Admin ───────────────────────────────────────────────────────────────── */

  platform_stats: {
    description: 'Platform-wide totals for an administrator.',
    /* USER_PRIVATE rather than PUBLIC: these are aggregates over other people's
       records, and the fact that they are counts does not make them public. */
    privacy: PRIVACY.USER_PRIVATE,
    capability: 'analytics.platform',
    readOnly: true,
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

  /* ── Owner ───────────────────────────────────────────────────────────────── */

  system_health: {
    description: 'Whether anything is currently failing, for an owner.',
    privacy: PRIVACY.USER_PRIVATE,
    capability: 'error.read',
    readOnly: true,
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
    privacy: PRIVACY.USER_PRIVATE,
    capability: 'audit.read',
    readOnly: true,
    async run() {
      try {
        const res = await api.fetchAuditLogs({ limit: MAX_ROWS });
        const list = Array.isArray(res) ? res : (res?.logs || res?.entries || []);
        return ok('recent_audit', {
          total: list.length,
          items: list.slice(0, MAX_ROWS).map(r => ({
            action: r.action,
            at: localMoment(r.createdAt || r.created_at),
            /* Deliberately no target name or details. The audit trail names
               people, and "what happened today" does not need to put somebody's
               name into a model prompt to be answered. */
          })),
        });
      } catch (err) {
        return failed(reasonFor(err));
      }
    },
  },

  verify_certificate: {
    description: 'Check a certificate code against the verification service.',
    privacy: PRIVACY.PUBLIC,
    readOnly: true,
    /**
     * The assistant never decides whether a certificate is genuine. It asks the
     * same verification service anyone else would and repeats the answer. A
     * model-formed opinion here would be a claim about a real document.
     */
    async run({ code } = {}) {
      if (!code) return failed('missing_code');
      try {
        const res = await api.verifyCertificate(code);
        return ok('certificate', { valid: res?.valid === true, ...res });
      } catch (err) {
        const reason = reasonFor(err);
        /* A 404 from this endpoint is a real answer — no certificate matches —
           and is not a failure to look. */
        if (err?.status === 404) return ok('certificate', { valid: false, code });
        return failed(reason);
      }
    },
  },
};

/** Tool names, for tests and for the capability explanation. */
export const TOOL_NAMES = Object.keys(TOOLS);

/**
 * Run a tool by name.
 *
 * Refuses an unknown name rather than throwing, because the caller is a router
 * whose job is to keep going — and because an unknown tool is a bug in this
 * file, not something to surface to a student as a crash.
 */
export async function runTool(name, args = {}, { user = null } = {}) {
  const tool = TOOLS[name];
  if (!tool) return failed('unknown_tool');

  /**
   * The capability is checked here as well as on the server.
   *
   * The server is what actually protects the data and always was — every tool
   * goes through the same `api.js` client, the same cookie and the same
   * authorization as the rest of the app, so a student asking an organizer
   * question has never been able to READ anything they should not.
   *
   * This check is about the answer rather than the data. Without it a student
   * whose question happened to match an organizer pattern would get a 403
   * rendered as "something went wrong", which reads as a broken assistant
   * rather than as a question that was never theirs to ask. Refusing here says
   * the true thing.
   *
   * `can` is the client half of the same decision function the server uses, and
   * intersects with the real role, so a forged `preview` can only ever take
   * capabilities away.
   */
  if (tool.capability && !can(user, tool.capability)) return failed('not_allowed');

  return tool.run(args);
}
