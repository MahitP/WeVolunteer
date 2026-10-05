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
 * That is enforced, not described: `runTool` refuses anything that is not a
 * read, and the one path that runs a write is `runConfirmedDraft` in
 * `confirm.js`.
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
import { VALID_CATEGORIES } from '../eventCategories.js';

/**
 * Valid event categories — the platform's own vocabulary, re-exported.
 *
 * Declared as a literal here until the list grew past five, at which point a
 * copy is a copy that can disagree with the CHECK constraint. `runTool` sends
 * whatever this says straight to `POST /api/events`, so a value here that the
 * server does not admit is a 400 the model cannot explain.
 */
export { VALID_CATEGORIES };

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

  /**
   * Ordered most specific first, because several of these overlap: "animal
   * shelter" is both an animal and a shelter, "charity 5K" is both a fundraiser
   * and a race, and a "school food drive" is all three. Whichever line comes
   * first wins, so the more particular reading is written above the more
   * general one, and `School` — the broadest word in the list, matching "class"
   * and "club" — sits near the bottom.
   */
  const lower = raw.toLowerCase();
  if (/\b(food|pantry|hunger|meal|soup|kitchen|canned|grocer)\b/.test(lower)) return 'Food Pantry';
  if (/\b(animal|animals|shelter dog|dog|dogs|cat|cats|kennel|wildlife|humane)\b/.test(lower)) return 'Animals';
  if (/\b(homeless|shelter|housing|habitat|rebuild)\b/.test(lower)) return 'Housing & Shelter';
  if (/\b(senior|seniors|elder|elderly|nursing|retirement|hospice)\b/.test(lower)) return 'Seniors';
  if (/\b(blood|health|clinic|hospital|medical|first ?aid|wellness|vaccin\w*)\b/.test(lower)) return 'Health';
  if (/\b(environment\w*|clean-?up|cleanup|litter|park|beach|river|trail|garden|tree|trees|recycl\w*|conservation)\b/.test(lower)) return 'Environment';
  if (/\b(5k|10k|run|race|marathon|track)\b/.test(lower)) return '5K';
  if (/\b(sports?|athletics?|coach\w*|soccer|softball|basketball|baseball|tournament)\b/.test(lower)) return 'Sports';
  if (/\b(art|arts|music|band|choir|theat\w*|museum|gallery|festival|performance)\b/.test(lower)) return 'Arts & Culture';
  if (/\b(drive|collection|toy|coat|clothing|canned goods|supplies)\b/.test(lower)) return 'Donation Drive';
  if (/\b(fundrais\w*|charity|gala|auction|benefit|donation|sponsor\w*)\b/.test(lower)) return 'Fundraiser';
  if (/\b(tutor\w*|mentor\w*|homework|literacy|reading buddy)\b/.test(lower)) return 'Tutoring';
  if (/\b(youth|kids|children|camp|scouts?|after-?school)\b/.test(lower)) return 'Youth Programs';
  if (/\b(office|admin\w*|filing|data entry|reception|mailing|clerical)\b/.test(lower)) return 'Administrative';
  if (/\b(school|teach\w*|education|class|classroom|reading|stem|math|science|club)\b/.test(lower)) return 'School';
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
/**
 * A coordinate, or null.
 *
 * The API sends these as numbers, but an event created without a geocoded
 * address has them absent, and a few older rows carry them as strings. `Number`
 * on `undefined` is `NaN`, which is a number that would sail through a
 * `typeof` check and come out of the haversine as `NaN` miles — a distance the
 * interface would then render as "NaN miles away". Null is the only honest
 * answer for "we do not know where this is".
 */
function coord(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const MAX_ROWS = 8;

const ok = (kind, data) => ({ ok: true, kind, data });

/**
 * A failure, and optionally what the server said about it.
 *
 * `detail.serverMessage` is set only where the endpoint's own refusals are
 * written to be read by the person who caused them — `POST /api/events`
 * answers "The application deadline must be on or before the first shift
 * starts.", not a code — and only for the statuses that carry one. It exists so
 * a new server-side rule reaches the organizer as a sentence instead of as
 * "I couldn't look that up just now", which is what every unmapped `reason`
 * becomes.
 *
 * Never set for 5xx: "Internal server error creating event" is a sentence about
 * the server, not about the event, and repeating it tells the reader nothing.
 */
const failed = (reason, detail = null) => (detail ? { ok: false, reason, detail } : { ok: false, reason });

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
            /* The endpoint lists issued documents, so a cancelled event's
               certificate is in here and its hours are not in any total. The
               card says so rather than printing "4 hours" beside a figure the
               hours tool reports without them. */
            eventCancelled: c.eventCancelled === true,
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
        /* The days the question named ("this weekend"), from `dateWindow`. */
        from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      },
      additionalProperties: false,
    },
    async run({ query, tags, maxDistance, lat, lng, from, to } = {}) {
      try {
        const res = await api.fetchEventsFiltered({
          q: typeof query === 'string' ? query.slice(0, 200) : '',
          tags: Array.isArray(tags) && tags.length ? tags.map(t => String(t).slice(0, 50)).join(',') : '',
          openOnly: true,
          /**
           * Nearest when the question was about distance, most relevant when it
           * was about meaning, soonest when it was neither.
           *
           * Welly asks this endpoint the same question BrowseEvents does, and
           * gets the same semantic search for free — the intelligence lives in
           * `GET /api/events`, not in the assistant. That is the reason there is
           * no vector search inside Welly to keep in step with the one in
           * Discover: a question typed at an assistant is natural language
           * almost by definition, which is precisely the case `relevance` is
           * for, and `relevance` degrades to `soonest` whenever there are no
           * semantic candidates — so this is never worse than what it replaced.
           */
          sort: typeof lat === 'number' && typeof lng === 'number'
            ? 'distance'
            : (typeof query === 'string' && query.trim().length >= 3 ? 'relevance' : 'soonest'),
          lat: typeof lat === 'number' ? lat : undefined,
          lng: typeof lng === 'number' ? lng : undefined,
          maxDistance: typeof maxDistance === 'number' ? maxDistance : undefined,
          from: typeof from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : undefined,
          to: typeof to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(to) ? to : undefined,
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
            /**
             * Where the event is, so a later "how far is it?" can be answered
             * without another request.
             *
             * `distance` above is only populated when the SEARCH carried
             * coordinates. Somebody who searched before granting location — and
             * then granted it from the offer under the answer — has a list on
             * screen with no distances in it, and asking is the obvious next
             * move. Carrying the point rather than the answer is what makes
             * that work.
             *
             * These are public event locations, already sent to Discover for
             * exactly this calculation. Nothing about the READER is added here.
             */
            latitude: coord(e.latitude ?? e.lat),
            longitude: coord(e.longitude ?? e.lng),
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
          /* Same reason as the search card: a follow-up about distance should
             not need a second lookup. See the note there. */
          latitude: coord(event.latitude ?? event.lat),
          longitude: coord(event.longitude ?? event.lng),
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
    /**
     * ── Every field here is one the API refuses without ──
     *
     * `description` and `applicationDeadline` were optional in this schema and
     * are not optional at the endpoint, and `slots[].description` was absent
     * altogether while `server/validation.js` requires it to BE a string —
     * `typeof slot.description !== 'string'` is a 400. So the tool's own
     * contract disagreed with the API's, and the disagreement was invisible
     * until somebody confirmed a draft and was told "I couldn't look that up
     * just now". They are required here now, so an incomplete event is refused
     * where it can be explained rather than 400ed where it cannot.
     */
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 200 },
        category: { type: 'string', enum: VALID_CATEGORIES },
        location: { type: 'string', minLength: 1, maxLength: 300 },
        description: { type: 'string', minLength: 1, maxLength: 5000 },
        applicationDeadline: { type: 'string', minLength: 1 },
        slots: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', minLength: 1, maxLength: 100 },
              description: { type: 'string', maxLength: 1000 },
              startDatetime: { type: 'string', minLength: 1 },
              endDatetime: { type: 'string', minLength: 1 },
              maxSpots: { type: 'integer', minimum: 1, maximum: 100 },
            },
            required: ['name', 'startDatetime', 'endDatetime', 'maxSpots'],
            additionalProperties: false,
          },
        },
      },
      required: ['title', 'description', 'category', 'location', 'applicationDeadline', 'slots'],
      additionalProperties: false,
    },
    /**
     * ── Nothing here invents a value ──
     *
     * This used to fill in a title, a location, a description, a deadline a
     * week out, a shift eight days out and ten spots — every one of them a fact
     * about somebody's event that nobody had stated. An event created from
     * those defaults is not the event the organizer asked for, and it is
     * published to students under their name.
     *
     * So the defaults are gone and the field is required instead. Collecting
     * the values is `eventDraft.js`'s job, and it asks.
     */
    async run(eventData = {}) {
      const text = (value, limit) => (typeof value === 'string' ? value.trim().slice(0, limit) : '');

      const cleanTitle = text(eventData.title, 200);
      const cleanLocation = text(eventData.location, 300);
      const cleanDescription = text(eventData.description, 5000);
      const cleanDeadline = text(eventData.applicationDeadline, 100);
      const cleanCategory = normalizeEventCategory(eventData.category);
      const slots = Array.isArray(eventData.slots) ? eventData.slots : [];

      const missing = [];
      if (!cleanTitle) missing.push('title');
      if (!cleanLocation) missing.push('location');
      if (!cleanDescription) missing.push('description');
      if (!cleanDeadline) missing.push('applicationDeadline');
      if (!slots.length) missing.push('slots');
      for (const s of slots) {
        if (!s || typeof s !== 'object') { missing.push('slots'); break; }
        if (!s.startDatetime || !s.endDatetime) { missing.push('shift times'); break; }
        if (!Number.isInteger(Number(s.maxSpots)) || Number(s.maxSpots) < 1) { missing.push('shift capacity'); break; }
      }
      if (missing.length) return failed('missing_event_fields', { missing });

      const payload = {
        title: cleanTitle,
        category: cleanCategory,
        location: cleanLocation,
        description: cleanDescription,
        applicationDeadline: cleanDeadline,
        slots: slots.map(s => ({
          name: text(s.name, 100) || cleanTitle,
          /* A string, always. The server type-checks this field and a missing
             one is a 400 — which is exactly how confirming a draft used to
             fail. */
          description: text(s.description, 1000),
          startDatetime: s.startDatetime,
          endDatetime: s.endDatetime,
          /* Sent as stated. Clamping to the server's range here would create an
             event for a number the organizer never chose — `server/validation.js`
             refuses one outside it, and that refusal is a sentence they can read
             (see `serverDetail`). */
          maxSpots: Number(s.maxSpots),
        })),
      };

      try {
        const res = await api.createEvent(payload);
        /* Only a response carrying an id is a created event. Anything else is
           reported as a failure rather than announced as a success. */
        if (!res?.id) return failed('unavailable');
        return ok('event_created', {
          id: res.id,
          title: res.title || payload.title,
          status: res.status || 'open',
          location: payload.location,
          /* Formatted here, where `localDay` lives, so the sentence upstairs
             repeats a date rather than deriving one. */
          startsOn: localDay(payload.slots.map(s => s.startDatetime).sort()[0]),
          shifts: payload.slots.length,
        });
      } catch (err) {
        return failed(reasonFor(err), serverDetail(err));
      }
    },
  },
};

/**
 * The server's own explanation, when it wrote one for the reader.
 *
 * 400 and 409 on the event routes are validation refusals phrased as sentences
 * ("The application deadline must be on or before the first shift starts."),
 * and 403 says which permission is missing ("Organizer account pending admin
 * approval."). Those are worth repeating verbatim. A 5xx is not: its message
 * describes the server's trouble, not the organizer's event.
 */
function serverDetail(err) {
  const status = Number(err?.status) || 0;
  if (status !== 400 && status !== 403 && status !== 409) return null;
  const message = typeof err?.message === 'string' ? err.message.trim() : '';
  if (!message) return null;
  return { status, serverMessage: message, field: err?.data?.field || null, code: err?.data?.code || null };
}

/** Tool names, for tests and for capability verification. */
export const TOOL_NAMES = Object.keys(TOOLS);

/**
 * Whether a tool may run the moment it is asked for.
 *
 * Only when it says so in all three fields. Anything else — a write, or a tool
 * added with one of them forgotten — is treated as a write, because the cost of
 * being wrong is not symmetrical: a read wrongly held for confirmation is a
 * failing test, and a write wrongly run immediately is a change nobody agreed
 * to.
 */
export function isReadTool(tool) {
  return tool?.mode === 'read' && tool.readOnly === true && tool.confirmation === false;
}

/**
 * Run a read tool by name.
 *
 * Refuses an unknown name rather than throwing, because the caller is a router
 * whose job is to keep going.
 *
 * ── Writes are refused here, not merely not sent here ──
 *
 * `update_preferences` was routed, given no drafting branch in `ask()`, and
 * fell through to the read path, which called this with whatever the router
 * had — and this checked the capability and ran it. It wrote nothing only
 * because the router supplied no arguments; a slot parser would have made it
 * an immediate preference change. Keeping writes out of the read path was a
 * convention every caller had to remember, so it is a rule here instead.
 *
 * A write runs through `runConfirmedDraft` in `confirm.js`, which takes the
 * draft `confirmDraft` handed out — not a tool name — so the only way to run
 * one is to have been told "confirm".
 */
export async function runTool(name, args = {}, { user = null } = {}) {
  const tool = TOOLS[name];
  if (!tool) return failed('unknown_tool');

  if (!isReadTool(tool)) return failed('confirmation_required');

  if (tool.capability && !can(user, tool.capability)) return failed('not_allowed');

  return tool.run(args, { user });
}
