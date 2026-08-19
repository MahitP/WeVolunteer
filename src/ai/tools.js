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
            issuedAt: c.endDatetime || c.createdAt || c.created_at,
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
            deadline: e.applicationDeadline || e.application_deadline,
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
export async function runTool(name, args = {}) {
  const tool = TOOLS[name];
  if (!tool) return failed('unknown_tool');
  return tool.run(args);
}
