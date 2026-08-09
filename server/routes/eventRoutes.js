import express from 'express';
// Explicit, rather than leaning on the Node global, so this matches authRoutes
// and accountRoutes and cannot break if the module is ever loaded somewhere the
// global is not present.
import crypto from 'crypto';

import { VALID_CATEGORIES, MAX_AUTO_SELECT_DRAWS } from '../config.js';
import { computeDraw, recordRun, applyRun } from '../services/autoSelect.js';
import { attendanceOnSlots, eventAttendanceCount } from '../attendance.js';
import { authenticateToken, inTransaction, notifyConfirmedVolunteers } from '../utils.js';
import { can, requireCap, requireCapAny } from '../authz.js';
import { recordAudit } from '../auditLog.js';
import { notificationService } from '../services/notificationService.js';
import { db } from '../db.js';
import { validateTags, replaceEventTags, tagsForEvent, tagsForEvents, tagVocabulary } from '../eventTags.js';
import { validateEventPayload } from '../validation.js';
import { buildShiftIcs } from '../ics.js';
import { parseEventFilters, eventQueryFragments, buildEventWhere, buildEventOrder } from '../eventQuery.js';
import { eventHasLiveReport, EVENT_HELD_MESSAGE } from '../evidenceHolds.js';
import { canManage, memberIds } from '../organizations.js';

const router = express.Router();

/**
 * One slot as the client consumes it. Shared by the list and single-event
 * routes so the two can never disagree about what a slot looks like.
 *
 * `acceptedCount` is passed in rather than queried here: callers already
 * batch-load it, and doing it per slot would reintroduce an N+1.
 */
export function formatSlot(s, acceptedCount = 0) {
  const hours = Math.max(0.1, Number(
    ((new Date(s.end_datetime) - new Date(s.start_datetime)) / (1000 * 60 * 60)).toFixed(2)
  ));
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    startDatetime: s.start_datetime,
    endDatetime: s.end_datetime,
    maxSpots: Number(s.max_spots),
    spotsRemaining: Math.max(0, s.max_spots - acceptedCount),
    hours
  };
}

/**
 * Largest page a caller may request. Above this, `limit` is clamped, not rejected.
 *
 * 500 rather than a smaller number, chosen from measurement. Any client that
 * needs the COMPLETE list — which the SPA does, because it filters on the client
 * and resolves applications against the list — is best served by one request:
 * at 150ms RTT a single unbounded response took 169ms, while three pages fetched
 * with maximum concurrency took 327ms. The extra round trips buy nothing, since
 * compression already takes 502 events to 6.7KB.
 *
 * A 500-row page therefore means a realistic deployment — a school year is on the
 * order of a hundred events — completes in exactly one request and pays no
 * round-trip penalty at all, while a pathologically large dataset still pages
 * instead of returning without bound. 500 events is roughly 13KB compressed.
 */
export const EVENTS_MAX_LIMIT = 500;

/**
 * Above this many rows, an unpaginated response is logged as a warning.
 *
 * Not a cap. Silently truncating the default would be the worst outcome
 * available here: the SPA uses this response as a complete local index — the
 * calendar resolves every application to its event, the organizer dashboard
 * filters for its own events, and opening an event from a notification looks it
 * up by id — so a short response would not error, it would quietly show a
 * student the wrong calendar. The warning exists so the ceiling is visible
 * before it is reached.
 */
const EVENTS_WARN_THRESHOLD = 400;

/**
 * List events.
 *
 * Pagination is OPT-IN. With no `limit`, the response is the bare array it has
 * always been, because every current client consumer treats it as a complete
 * index (see the note on EVENTS_WARN_THRESHOLD). Pass `limit` and the response
 * becomes an envelope with `{ events, pagination }` instead.
 *
 *   GET /api/events                    -> Event[]                (legacy)
 *   GET /api/events?limit=50           -> { events, pagination }
 *   GET /api/events?limit=50&offset=50 -> { events, pagination }
 *
 * Ordering is by soonest shift, then id. The id tiebreak is not cosmetic: two
 * events starting at the same moment have no inherent order, and without a
 * stable tiebreak SQLite may return them in a different sequence on each query —
 * which makes `offset` unsound and lets a row appear on two pages or on none.
 * The previous query had no ORDER BY at all, so pagination could not have been
 * added on top of it correctly.
 */
router.get('/api/events', authenticateToken, (req, res) => {
  try {
    const paginated = req.query.limit !== undefined;

    let limit = null;
    let offset = 0;
    if (paginated) {
      const rawLimit = Number(req.query.limit);
      const rawOffset = Number(req.query.offset ?? 0);
      if (!Number.isFinite(rawLimit) || rawLimit < 1) {
        return res.status(400).json({ error: '`limit` must be a positive integer.', field: 'limit' });
      }
      if (!Number.isFinite(rawOffset) || rawOffset < 0) {
        return res.status(400).json({ error: '`offset` must be zero or greater.', field: 'offset' });
      }
      // Clamped rather than rejected: a caller asking for too much should get a
      // valid page, not an error it has to learn to handle.
      limit = Math.min(Math.floor(rawLimit), EVENTS_MAX_LIMIT);
      offset = Math.floor(rawOffset);
    }

    const parsed = parseEventFilters(req.query);
    if (!parsed.ok) {
      return res.status(400).json({ error: parsed.error, field: parsed.field });
    }
    const filters = parsed.value;

    /**
     * Filtering, sorting and the distance calculation all run in SQL now.
     *
     * BrowseEvents used to receive every event and do this in JavaScript, which
     * is exactly why the endpoint could not paginate: a text search over "the
     * pages loaded so far" is a wrong answer, not a partial one. See
     * ../eventQuery.js for each predicate and how it maps to the client behaviour
     * it replaces.
     *
     * The aggregate CTE exists because `spots_remaining` and `total_hours` are
     * derived rather than stored, and both the WHERE and the ORDER BY need to
     * reference them.
     */
    const { aggCte, distanceSelect, spotsSelect } = eventQueryFragments(filters);
    const { where, params } = buildEventWhere(filters, req.user.id);
    const order = buildEventOrder(filters.sort);

    const FROM = `
      FROM events e
      JOIN users u ON e.organizer_id = u.id
      JOIN agg ON agg.event_id = e.id
      LEFT JOIN acc ON acc.event_id = e.id
      /* LEFT, not JOIN: most events belong to no organization, and an inner
         join here would silently empty the entire opportunities list. */
      LEFT JOIN organizations org ON org.id = e.organization_id
      ${where}
    `;

    // `total` counts the rows MATCHING THE FILTERS, not the whole table — a
    // pagination total that ignored the filters would make hasMore and the "N
    // events" count disagree with what the caller can actually page through.
    const total = db.prepare(`WITH ${aggCte} SELECT COUNT(*) AS c ${FROM}`).get(params).c;

    const SELECT = `
      SELECT e.*, u.name as organizer_name, u.verified as organizer_verified,
             u.school as organizer_school,
             /* One LEFT JOIN rather than a lookup per event. An event card shows
                the organization's name, and fetching it per row is the N+1 the
                whole list query is shaped to avoid. */
             org.name as organization_name, org.slug as organization_slug,
             ${spotsSelect},
             ${distanceSelect}
    `;

    /**
     * The row query needs lat/lng for the distance expression in its SELECT list;
     * the COUNT above does not, and node:sqlite refuses a bound parameter that
     * the statement never references.
     */
    const rowParams = filters.lat != null
      ? { ...params, lat: filters.lat, lng: filters.lng }
      : params;

    /**
     * Even the unpaginated response is bounded.
     *
     * Omitting `limit` returns the bare array every existing consumer expects,
     * and that shape is kept. What changed is that it no longer means "every row
     * in the table": it is capped at EVENTS_MAX_LIMIT, the same ceiling a caller
     * that DOES paginate is clamped to.
     *
     * Without the cap this was the largest payload the app sends and it grew
     * without limit — measured at 690 KB for 503 events, fetched on every session
     * restore. One forgotten query parameter was the difference between a small
     * response and a district-sized one, which is not a property worth keeping.
     *
     * Nothing observable changes below the ceiling, which is every realistic
     * pilot deployment, and the SPA already paginates at 60. Above it, a caller
     * that needs everything must page — which is what the warning below has been
     * telling them to do.
     */
    const events = paginated
      ? db.prepare(`WITH ${aggCte} ${SELECT} ${FROM} ${order} LIMIT @limit OFFSET @offset`)
          .all({ ...rowParams, limit, offset })
      : db.prepare(`WITH ${aggCte} ${SELECT} ${FROM} ${order} LIMIT @hardCap`)
          .all({ ...rowParams, hardCap: EVENTS_MAX_LIMIT });

    if (!paginated && total > EVENTS_WARN_THRESHOLD) {
      console.warn(
        `[events] Serialised ${Math.min(total, EVENTS_MAX_LIMIT)} of ${total} events `
        + `unpaginated for user ${req.user.id}. `
        + `Above ${EVENTS_WARN_THRESHOLD} this response is the largest payload the app sends; `
        + `migrate the caller to ?limit=&offset=.`
      );
    }

    // Says out loud when the cap actually removed rows, so a caller silently
    // seeing a truncated list is visible in the log rather than a mystery.
    if (!paginated && total > EVENTS_MAX_LIMIT) {
      console.warn(
        `[events] TRUNCATED: ${total} events matched but an unpaginated request is `
        + `capped at ${EVENTS_MAX_LIMIT}. The caller is missing ${total - EVENTS_MAX_LIMIT} `
        + `row(s) and must use ?limit=&offset=.`
      );
    }

    // Arrival details (instructions) are only for people who are actually
    // going, or who run the event — not the open internet, and not every
    // other signed-in student. Batch-loaded once so the per-event mapping
    // below stays free of an N+1.
    const acceptedEventIds = new Set(
      db.prepare("SELECT DISTINCT event_id FROM applications WHERE user_id = ? AND status = 'accepted'")
        .all(req.user.id).map(r => r.event_id)
    );

    /**
     * The three batch loads below are scoped to the rows actually being
     * returned.
     *
     * They previously read `slots`, every accepted application, and every
     * attendance row for the WHOLE table regardless of what was being sent —
     * so a paginated request for 20 events would still have loaded a district's
     * entire slot and attendance history to answer it, and the page would have
     * cost the same as the full list. A parameter list is built from the page's
     * event ids instead.
     */
    const pageIds = events.map(e => e.id);
    const placeholders = pageIds.length ? pageIds.map(() => '?').join(',') : null;

    const slotsByEvent = new Map();
    if (placeholders) {
      for (const s of db.prepare(`SELECT * FROM slots WHERE event_id IN (${placeholders})`).all(...pageIds)) {
        if (!slotsByEvent.has(s.event_id)) slotsByEvent.set(s.event_id, []);
        slotsByEvent.get(s.event_id).push(s);
      }
    }

    const acceptedBySlot = new Map();
    if (placeholders) {
      for (const r of db.prepare(`
        SELECT slot_id, COUNT(*) as count FROM applications
        WHERE status = 'accepted' AND event_id IN (${placeholders})
        GROUP BY slot_id
      `).all(...pageIds)) {
        acceptedBySlot.set(r.slot_id, r.count);
      }
    }

    // Whether any hours have been recorded against this event. The client needs
    // it to stop offering a delete button the server will refuse — an action
    // that is always going to fail should not be presented as available.
    const withAttendance = new Set(
      placeholders
        ? db.prepare(`SELECT DISTINCT event_id FROM attendance WHERE event_id IN (${placeholders})`)
            .all(...pageIds).map(r => r.event_id)
        : []
    );

    /* Tags for the whole page in ONE query, beside the other per-page batch
       loads above. Per-event reads here would be an N+1 on the endpoint the
       browse screen calls on every keystroke. */
    const tagsByEvent = tagsForEvents(db, pageIds);

    const formattedEvents = events.map(event => {
      const slots = slotsByEvent.get(event.id) || [];

      const formattedSlots = slots.map(s => formatSlot(s, acceptedBySlot.get(s.id) || 0));

      // Bounding datetimes based on slots
      const startDatetime = formattedSlots.length > 0
        ? formattedSlots.map(s => s.startDatetime).sort()[0]
        : event.created_at;

      const endDatetime = formattedSlots.length > 0
        ? formattedSlots.map(s => s.endDatetime).sort().reverse()[0]
        : event.created_at;

      const maxSpots = formattedSlots.reduce((sum, s) => sum + s.maxSpots, 0);
      const totalAccepted = formattedSlots.reduce((sum, s) => sum + (s.maxSpots - s.spotsRemaining), 0);
      const spotsRemaining = Math.max(0, maxSpots - totalAccepted);
      const hoursAwarded = formattedSlots.length > 0
        ? Number(formattedSlots.reduce((sum, s) => sum + s.hours, 0).toFixed(2))
        : 0;

      const canSeeInstructions = can(req.principal, 'event.moderate') ||
        event.organizer_id === req.principal.userId ||
        acceptedEventIds.has(event.id);

      return {
        id: event.id,
        title: event.title,
        description: event.description,
        category: event.category,
        location: event.location,
        address: event.address || null,
        latitude: event.latitude != null ? Number(event.latitude) : null,
        longitude: event.longitude != null ? Number(event.longitude) : null,
        startDatetime: startDatetime,
        endDatetime: endDatetime,
        hoursAwarded: hoursAwarded,
        maxSpots: maxSpots,
        spotsRemaining: spotsRemaining,
        applicationDeadline: event.application_deadline,
        instructions: canSeeInstructions ? (event.instructions || '') : '',
        organizerId: event.organizer_id,
        organizerName: event.organizer_name,
        organizerVerified: event.organizer_verified === 1,
        organizerSchool: event.organizer_school || '',
        status: event.status,
        hasAttendance: withAttendance.has(event.id),
        autoApprove: event.auto_approve === 1,
        attendeeVisibility: event.attendee_visibility || 'accepted',
        /**
         * `creditsHours: false` means "this event does not measure service in
         * hours" — a donation drive, a supply sort. It is NOT "zero hours". The
         * client reads the flag before formatting any number, so a
         * participation event shows "Participation" where an hours event shows
         * a duration. Defaulting `!== 0` rather than `=== 1` keeps every event
         * that predates the column crediting hours.
         */
        creditsHours: event.credits_hours !== 0,
        organizationId: event.organization_id || null,
        organizationName: event.organization_name || null,
        organizationSlug: event.organization_slug || null,
        selectionSummary: event.selection_summary ? JSON.parse(event.selection_summary) : null,
        /**
         * Distance in MILES, computed in SQL when the caller supplied lat/lng.
         *
         * Null when no coordinates were given, or when the event has none — the
         * client's EventCard already treats null as "no distance to show", and
         * the sort places nulls last, matching the `?? Infinity` it replaced.
         */
        distance: event.distance_miles != null ? Number(event.distance_miles) : null,
        /* Organizer-created tags: `{tag, label}` pairs. `tag` is the normalised
           key a filter uses, `label` is what the organizer typed and what the
           reader sees. Always an array, never absent, so the client never has to
           distinguish "no tags" from "field missing". */
        tags: tagsByEvent[event.id] || [],
        slots: formattedSlots
      };
    });

    /**
     * Two shapes, chosen by whether the caller asked to paginate.
     *
     * A bare array for a legacy caller and an envelope for a paginated one keeps
     * this backward compatible without a version bump or a second route. The
     * envelope carries everything a caller needs to walk the pages without
     * guessing: the total, the clamp that was actually applied, and an explicit
     * `hasMore` so nobody has to infer the end from a short page.
     */
    if (!paginated) {
      return res.json(formattedEvents);
    }

    /**
     * `places` is computed over the whole listable set, deliberately ignoring the
     * filters.
     *
     * It populates the location dropdown, and a dropdown whose options are
     * filtered by the current selection is a trap: choosing a place would remove
     * every other option and the user could not get back without clearing. The
     * client built this list from the full event array it used to hold, so it has
     * to come from somewhere now that the array is a filtered page.
     */
    const places = db.prepare(`
      SELECT DISTINCT location FROM events
      WHERE status IN ('open', 'closed') AND location IS NOT NULL AND location != ''
      ORDER BY location COLLATE NOCASE
    `).all().map(r => r.location);

    /**
     * The tag vocabulary, computed over everything and NOT over the current page.
     *
     * Same argument as `places` above, and it bites harder here: a tag facet whose
     * options are narrowed by the current selection removes every option the
     * moment one is ticked, so a reader can neither add a second tag nor see what
     * they have excluded. It is a vocabulary, not a result count.
     *
     * Served alongside the results rather than from its own endpoint so the
     * browse screen renders its filter bar from the response it already makes,
     * instead of a second round trip on first paint.
     */
    const tags = tagVocabulary(db);

    res.json({
      events: formattedEvents,
      pagination: {
        total,
        limit,
        offset,
        returned: formattedEvents.length,
        hasMore: offset + formattedEvents.length < total,
        // Null at the end of the list, so a caller can loop until it is null
        // rather than doing the arithmetic itself.
        nextOffset: offset + formattedEvents.length < total ? offset + formattedEvents.length : null,
        maxLimit: EVENTS_MAX_LIMIT
      },
      places,
      tags,
      // Echoed back so a client can tell which filters the server actually
      // applied, rather than assuming its request was understood verbatim.
      filters
    });
  } catch (error) {
    console.error('Fetch events error:', error);
    res.status(500).json({ error: 'Internal server error fetching events' });
  }
});

/**
 * One event with its applications, for the organizer's own screens.
 *
 * Staff-only: it carries the applicant roster, which is not something a
 * student may enumerate for an event they are not running.
 */
router.get('/api/events/:id', authenticateToken, (req, res) => {
  try {
    const event = db.prepare(`
      SELECT e.*, u.name as organizer_name, u.verified as organizer_verified,
             u.school as organizer_school,
             org.name as organization_name, org.slug as organization_slug
      FROM events e JOIN users u ON e.organizer_id = u.id
      LEFT JOIN organizations org ON org.id = e.organization_id
      WHERE e.id = ?
    `).get(req.params.id);

    if (!event) return res.status(404).json({ error: 'Event not found' });

    const isStaff = can(req.principal, 'event.moderate') ||
      event.organizer_id === req.principal.userId;
    if (!isStaff) return res.status(403).json({ error: 'Access denied: You do not host this event' });

    const slots = db.prepare('SELECT * FROM slots WHERE event_id = ?').all(event.id);
    const acceptedBySlot = new Map();
    for (const r of db.prepare(`
      SELECT slot_id, COUNT(*) as count FROM applications
      WHERE event_id = ? AND status = 'accepted' GROUP BY slot_id
    `).all(event.id)) {
      acceptedBySlot.set(r.slot_id, r.count);
    }

    const formattedSlots = slots.map(s => formatSlot(s, acceptedBySlot.get(s.id) || 0));

    const applications = db.prepare(`
      SELECT a.id, a.user_id, a.event_id, a.slot_id, a.status, a.applied_at,
             u.name, u.avatar, u.grade, u.school
      FROM applications a JOIN users u ON a.user_id = u.id
      WHERE a.event_id = ?
      ORDER BY u.name
    `).all(event.id).map(a => ({
      id: a.id,
      userId: a.user_id,
      eventId: a.event_id,
      slotId: a.slot_id,
      status: a.status,
      appliedAt: a.applied_at,
      volunteer: { id: a.user_id, name: a.name, avatar: a.avatar, grade: a.grade, school: a.school }
    }));

    res.json({
      event: {
        id: event.id,
        title: event.title,
        description: event.description,
        category: event.category,
        location: event.location,
        address: event.address || null,
        latitude: event.latitude != null ? Number(event.latitude) : null,
        longitude: event.longitude != null ? Number(event.longitude) : null,
        instructions: event.instructions || '',
        applicationDeadline: event.application_deadline,
        organizerId: event.organizer_id,
        organizerName: event.organizer_name,
        status: event.status,
        autoApprove: event.auto_approve === 1,
        creditsHours: event.credits_hours !== 0,
        organizationId: event.organization_id || null,
        organizationName: event.organization_name || null,
        organizationSlug: event.organization_slug || null,
        /* Same shape as the list response, so a client that renders chips from
           one can render them from the other without a second code path. */
        tags: tagsForEvent(db, event.id),
        slots: formattedSlots
      },
      applications
    });
  } catch (err) {
    console.error('Fetch event error:', err);
    res.status(500).json({ error: 'Failed to load event' });
  }
});

/**
 * GET /api/events/tags — the tag vocabulary, for reuse rather than reinvention.
 *
 * ── Why a route of its own ──
 *
 * The list endpoint already returns this alongside its results, which is right for
 * the browse screen's filter bar. The event FORM needs it too and has no reason to
 * fetch a page of events to get it — so this is the same data without the payload
 * the caller would throw away.
 *
 * ── Why it is authenticated but ungated ──
 *
 * The vocabulary is the words organizers have used on events that are already
 * visible to every signed-in account, so it discloses nothing a reader cannot see
 * by browsing. It is behind `authenticateToken` because there is no reason for it
 * to be the one event endpoint answering anonymously, and it carries no capability
 * because every signed-in role can already read the tags on an event.
 *
 * Declared ABOVE `/api/events/:id`: Express matches in order, so registering it
 * after would make `tags` be read as an event id and answer 404.
 */
router.get('/api/events/tags', authenticateToken, (req, res) => {
  try {
    res.json({ tags: tagVocabulary(db, { limit: req.query.limit }) });
  } catch (err) {
    console.error('Failed to load the tag vocabulary:', err);
    res.status(500).json({ error: 'Could not load tags.' });
  }
});

router.post('/api/events', authenticateToken, requireCap('event.create'), (req, res) => {
  // Check if organizer is verified by Admin
  const organizer = db.prepare('SELECT verified FROM users WHERE id = ?').get(req.user.id);
  if (!organizer || organizer.verified !== 1) {
    return res.status(403).json({ error: 'Organizer account pending admin approval. You cannot create events yet.' });
  }

  const {
    title, description, category, location, applicationDeadline, slots,
    autoApprove, instructions, attendeeVisibility,
    address, latitude, longitude, tags, organizationId, creditsHours
  } = req.body;

  if (!title || !description || !category || !location || !applicationDeadline || !slots || !Array.isArray(slots) || slots.length === 0) {
    return res.status(400).json({ error: 'Required fields missing: Title, description, category, location, deadline, and slots are required.' });
  }

  // Ensure category is strictly valid
  if (!VALID_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `Invalid category. Must be one of: ${VALID_CATEGORIES.join(', ')}` });
  }

  const validation = validateEventPayload({ title, description, location, instructions, applicationDeadline, slots, address, latitude, longitude });
  if (!validation.ok) return res.status(400).json({ error: validation.error });

  /* Tags are OPTIONAL — absent and `[]` both mean "none". Validated server-side
     regardless of what the form checked, because the form is not the boundary:
     see server/eventTags.js for the limits and why a bad tag is an error rather
     than silently dropped. */
  const tagCheck = validateTags(tags);
  if (!tagCheck.ok) return res.status(400).json({ error: tagCheck.error, field: tagCheck.field });

  /**
   * Attaching the event to an organization is a MEMBERSHIP question, not a
   * capability one.
   *
   * `event.create` says this account may create events. It does not say this
   * account may publish under the National Honor Society's name and notify its
   * three hundred members. Only a manager of that organization may do that, and
   * that check is `canManage`, the same one organizationRoutes uses — so there
   * is one answer to "may you act for this organization" rather than two.
   */
  let organization = null;
  if (organizationId != null && organizationId !== '') {
    organization = db.prepare('SELECT * FROM organizations WHERE id = ?').get(organizationId);
    if (!organization || organization.status !== 'active') {
      return res.status(400).json({ error: 'That organization does not exist.', field: 'organizationId' });
    }
    if (!canManage(db, organization.id, req.user.id, { hasModerate: can(req.principal, 'organization.moderate') })) {
      return res.status(403).json({
        error: 'You are not a manager of that organization.',
        field: 'organizationId', code: 'not_manager',
      });
    }
  }

  /**
   * `creditsHours` defaults to TRUE when absent.
   *
   * Every existing client sends no such field, and every existing event awards
   * hours. Defaulting the other way would silently turn the whole back catalogue
   * of organizer habits into participation-only events. Only an explicit
   * `false` opts out.
   */
  const awardsHours = creditsHours !== false;

  try {
    /**
     * randomUUID, not Date.now().
     *
     * This was `event-${Date.now()}` — a bare millisecond timestamp used as the
     * PRIMARY KEY. Two events created in the same millisecond produced the same
     * id, the second INSERT violated the key, and the request returned 500 having
     * created nothing. Measured before this change: 25 concurrent creations lost
     * 8, and 40 sequential ones lost 2.
     *
     * In production that is an organizer double-submitting, or two organizers
     * saving at once — they lose the event and see a server error for something
     * they did nothing wrong in.
     *
     * Every other id in the app already does this; accountRoutes.js even carries
     * the note "randomUUID, not Date.now(): two deletions in the same
     * millisecond". Events were the one place the lesson had not been applied.
     */
    const eventId = `event-${crypto.randomUUID()}`;
    const nowStr = new Date().toISOString();
    
    inTransaction(() => {
      // A. Insert Event
      db.prepare(`
        INSERT INTO events (id, title, description, category, location, application_deadline,
                            organizer_id, status, created_at, auto_approve, instructions, attendee_visibility,
                            address, latitude, longitude, organization_id, credits_hours)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        eventId,
        title,
        description,
        category,
        location,
        applicationDeadline,
        req.user.id,
        nowStr,
        autoApprove ? 1 : 0,
        instructions || '',
        attendeeVisibility === 'private' ? 'private' : 'accepted',
        address || null,
        latitude != null ? latitude : null,
        longitude != null ? longitude : null,
        organization ? organization.id : null,
        awardsHours ? 1 : 0
      );

      // B. Insert slots
      for (const slot of slots) {
        const slotId = `slot-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        db.prepare(`
          INSERT INTO slots (id, event_id, name, description, start_datetime, end_datetime, max_spots)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          slotId,
          eventId,
          slot.name,
          slot.description,
          slot.startDatetime,
          slot.endDatetime,
          Number(slot.maxSpots)
        );
      }

      /* C. Tags. Inside the same transaction as the event and its slots: an
         event that saved without the tags the organizer typed is a silent partial
         write, and they would have no way to tell other than reopening it. */
      replaceEventTags(db, eventId, tagCheck.value);
    });

    /**
     * Tell the organization's members, in one pass, after the commit.
     *
     * `memberIds` is a single query returning ids; the loop then writes rows
     * through the notification service. That is one query for the roster plus
     * the per-recipient writes the service must do anyway — never a query per
     * member to discover who they are, which for a club of three hundred would
     * be three hundred round trips inside the request that created the event.
     *
     * The creator is excluded: they know, they just did it.
     *
     * Dedupe key is per (member, event), so a member who also qualifies through
     * some future mechanism gets one notification about one event, not two.
     * `dispatch` consults each recipient's preferences individually, so a member
     * who has turned Events off is not told.
     *
     * After the transaction and inside its own try/catch: a fan-out failure must
     * never destroy an event the organizer successfully created.
     */
    if (organization) {
      try {
        const recipients = memberIds(db, organization.id, { excluding: [req.user.id] });
        /**
         * One transaction around the whole fan-out.
         *
         * Each `dispatch` is several statements, and outside a transaction
         * every one of them autocommits — for a three-hundred-member club that
         * is hundreds of separate fsyncs inside the request that created the
         * event, before the 201 is written. Wrapping them makes it one commit.
         *
         * Still AFTER the event's own transaction, and still inside its own
         * try/catch: a fan-out failure must roll back only the notifications,
         * never the event the organizer successfully created.
         */
        inTransaction(() => {
          for (const memberId of recipients) {
            notificationService.dispatch(
              'ORGANIZATION_EVENT_POSTED',
              { eventId, eventTitle: title, organizationName: organization.name, organizationSlug: organization.slug },
              memberId,
              `org-event:${eventId}`
            );
          }
        });
      } catch (err) {
        console.error('Organization fan-out failed:', err);
      }
    }

    res.status(201).json({
      success: true,
      id: eventId,
      title,
      description,
      category,
      location,
      address: address || null,
      latitude: latitude != null ? latitude : null,
      longitude: longitude != null ? longitude : null,
      applicationDeadline,
      organizerId: req.user.id,
      status: 'open',
      autoApprove: !!autoApprove,
      organizationId: organization ? organization.id : null,
      creditsHours: awardsHours
    });
  } catch (error) {
    console.error('Create event error:', error);
    res.status(500).json({ error: 'Internal server error creating event' });
  }
});

// 6. Fetch All Applications (Enriched with Student profile, Slot, and Event details)

router.put('/api/events/:id', authenticateToken, requireCap('event.edit.own'), async (req, res) => {
  const eventId = req.params.id;
  const {
    title, description, category, location, applicationDeadline, slots,
    autoApprove, instructions, attendeeVisibility,
    address, latitude, longitude, tags
  } = req.body;

  if (!title || !description || !category || !location || !applicationDeadline || !slots || !Array.isArray(slots)) {
    return res.status(400).json({ error: 'Required fields missing' });
  }
  if (!VALID_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `Invalid category. Must be one of: ${VALID_CATEGORIES.join(', ')}` });
  }

  const validation = validateEventPayload({ title, description, location, instructions, applicationDeadline, slots, address, latitude, longitude });
  if (!validation.ok) return res.status(400).json({ error: validation.error });

  /* Validated before the ownership check below runs, which is only about
     ordering of error messages: a caller who does not host this event is refused
     either way, and `validateTags` reads nothing from the database. */
  const tagCheck = validateTags(tags);
  if (!tagCheck.ok) return res.status(400).json({ error: tagCheck.error, field: tagCheck.field });

  try {
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!can(req.principal, 'event.moderate') && event.organizer_id !== req.principal.userId) {
      return res.status(403).json({ error: 'Access denied: You do not host this event' });
    }

    if (event.status === 'completed') {
      return res.status(409).json({
        error: 'This event is complete and its details can no longer be changed. Attendance can still be corrected.',
        code: 'event_completed'
      });
    }

    const changes = [];
    if (event.title !== title) changes.push('title');
    if (event.location !== location || event.address !== address) changes.push('location');
    if (event.application_deadline !== applicationDeadline) changes.push('deadline');
    if (event.description !== description) changes.push('description');

    // Removing a shift used to take its attendance rows with it, silently
    // destroying hours volunteers had already earned. Credited service is not
    // something an event edit gets to delete as a side effect.
    const payloadIds = slots.filter(s => s.id && !s.id.startsWith('new-')).map(s => s.id);
    const existingIds = db.prepare('SELECT id FROM slots WHERE event_id = ?').all(eventId).map(s => s.id);
    const removedIds = existingIds.filter(id => !payloadIds.includes(id));
    /**
     * Every slot id in the body must belong to THIS event.
     *
     * ── The hole this closes ──
     *
     * The ownership check above proves the caller owns the event named in the
     * PATH. It says nothing about the slot ids in the BODY, and the update below
     * was `WHERE id = ?` with no event scope — so an organizer editing their own
     * event could name a slot belonging to somebody else's and rewrite it.
     *
     * Slot ids are not secret: `GET /api/events` returns every event's slots to
     * every signed-in user, so there was nothing to guess.
     *
     * And this is not a cosmetic write. Credited hours are `end_datetime -
     * start_datetime` at the moment attendance is confirmed (`attendance.js`), so
     * moving a foreign slot's times changes what ANOTHER organizer's volunteers
     * will be credited — the one number this platform exists to get right, and the
     * one thing `hours_ledger` cannot warn about because the ledger faithfully
     * records the wrong duration. Pushing `end_datetime` into the future makes
     * that event's attendance impossible to finalise at all; lowering `max_spots`
     * breaks waitlist promotion.
     *
     * ── Refused, not silently ignored ──
     *
     * Scoping the UPDATE alone would turn this into a no-op, which is safe and
     * dishonest: a legitimate client bug would then look like a successful save
     * that changed nothing. A malformed edit is a 400.
     */
    const foreignIds = payloadIds.filter(id => !existingIds.includes(id));
    if (foreignIds.length > 0) {
      return res.status(400).json({
        error: 'That edit names shifts which do not belong to this event.',
        code: 'slot_not_on_event',
        slots: foreignIds,
      });
    }

    const protectedRows = attendanceOnSlots(db, removedIds);

    if (protectedRows.length > 0) {
      const names = [...new Set(protectedRows.map(r => r.user_name).filter(Boolean))];
      return res.status(409).json({
        error: `Those shifts have attendance recorded against them, so they cannot be removed. `
             + `${names.length} volunteer${names.length === 1 ? '' : 's'} would lose credited hours: ${names.join(', ')}.`,
        code: 'attendance_exists',
        volunteers: names,
        slots: [...new Set(protectedRows.map(r => r.slot_name).filter(Boolean))]
      });
    }

    inTransaction(() => {
      // 1. Update event details
      db.prepare(`
        UPDATE events
        SET title = ?, description = ?, category = ?, location = ?, application_deadline = ?,
            address = ?, latitude = ?, longitude = ?
        WHERE id = ?
      `).run(title, description, category, location, applicationDeadline, address || null, latitude != null ? latitude : null, longitude != null ? longitude : null, eventId);

      if (autoApprove !== undefined) {
        db.prepare('UPDATE events SET auto_approve = ? WHERE id = ?').run(autoApprove ? 1 : 0, eventId);
      }
      if (instructions !== undefined) {
        db.prepare('UPDATE events SET instructions = ? WHERE id = ?').run(instructions || '', eventId);
      }
      if (attendeeVisibility !== undefined) {
        db.prepare('UPDATE events SET attendee_visibility = ? WHERE id = ?')
          .run(attendeeVisibility === 'private' ? 'private' : 'accepted', eventId);
      }

      /**
       * Tags, only when the caller actually sent the field.
       *
       * `tags: []` means "remove them all" and is honoured; OMITTING `tags` means
       * "I am not editing tags" and must leave them alone. The distinction
       * matters because this endpoint is also used by clients that were written
       * before tags existed — treating absent as empty would silently strip every
       * tag off an event the moment such a client saved anything else about it.
       */
      if (tags !== undefined) {
        replaceEventTags(db, eventId, tagCheck.value);
      }

      // 2. Differential sync slots.
      //
      // `removedIds` was computed above and has already been checked for
      // attendance, so nothing credited can be reached from here. There is
      // deliberately no "payload named no existing slots, so delete them all"
      // branch: an edit that names no slots is a malformed request, not an
      // instruction to erase every sign-up on the event.
      for (const slotId of removedIds) {
        db.prepare('DELETE FROM attendance_checkin WHERE slot_id = ?').run(slotId);
        db.prepare('DELETE FROM applications WHERE slot_id = ?').run(slotId);
        db.prepare('DELETE FROM slots WHERE id = ?').run(slotId);
      }

      // 3. Insert new or update existing slots
      for (const slot of slots) {
        if (slot.id && !slot.id.startsWith('new-')) {
          /* `AND event_id = ?` as well as the refusal above — belt and braces on
             purpose. The check above is the one that produces a good error; this
             is what still holds if a future edit reorders the handler and moves
             the validation after the transaction, which is exactly the kind of
             refactor that reintroduces this class of bug. */
          db.prepare(`
            UPDATE slots
            SET name = ?, description = ?, start_datetime = ?, end_datetime = ?, max_spots = ?
            WHERE id = ? AND event_id = ?
          `).run(slot.name, slot.description, slot.startDatetime, slot.endDatetime, Number(slot.maxSpots), slot.id, eventId);
        } else {
          const slotId = `slot-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
          db.prepare(`
            INSERT INTO slots (id, event_id, name, description, start_datetime, end_datetime, max_spots)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(slotId, eventId, slot.name, slot.description, slot.startDatetime, slot.endDatetime, Number(slot.maxSpots));
        }
      }
    });

    let notified = 0;
    if (changes.length > 0) {
      notified = await notifyConfirmedVolunteers(eventId, 'EVENT_UPDATED', { eventId: eventId, eventTitle: title, changes: changes });
    }

    res.json({ success: true, notified });
  } catch (error) {
    console.error('Update event details error:', error);
    res.status(500).json({ error: 'Internal server error editing event details' });
  }
});

// 11. Run Equalizer Hour Sorting (Organizer only)
router.post('/api/events/:id/auto-approve', authenticateToken, requireCap('event.edit.own'), (req, res) => {
  const eventId = req.params.id;

  try {
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!can(req.principal, 'event.moderate') && event.organizer_id !== req.principal.userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Approve slot-by-slot: each slot has its own capacity, and within a slot
    // priority goes to students with the fewest credited hours (tie: earliest applied)
    const slots = db.prepare('SELECT id, name, max_spots FROM slots WHERE event_id = ?').all(eventId);
    const approveStmt = db.prepare("UPDATE applications SET status = 'accepted' WHERE id = ?");
    const hoursStmt = db.prepare(`
      SELECT SUM(hours_awarded) as total FROM attendance WHERE user_id = ? AND present = 1
    `);

    let approvedCount = 0;
    for (const slot of slots) {
      const accepted = db.prepare(`
        SELECT COUNT(*) as count FROM applications WHERE slot_id = ? AND status = 'accepted'
      `).get(slot.id).count;
      const remaining = slot.max_spots - accepted;
      if (remaining <= 0) continue;

      const pendingApps = db.prepare(`
        SELECT id, user_id, applied_at FROM applications
        WHERE slot_id = ? AND status = 'pending'
      `).all(slot.id);
      if (pendingApps.length === 0) continue;

      const enriched = pendingApps.map(app => {
        const hoursRow = hoursStmt.get(app.user_id);
        return { ...app, totalHours: hoursRow && hoursRow.total ? Number(hoursRow.total) : 0.0 };
      });
      enriched.sort((a, b) => {
        if (a.totalHours !== b.totalHours) return a.totalHours - b.totalHours;
        return new Date(a.applied_at) - new Date(b.applied_at);
      });

      for (const app of enriched.slice(0, remaining)) {
        approveStmt.run(app.id);
        approvedCount++;
        notificationService.dispatch('APPLICATION_ACCEPTED', { eventId: event.id, eventTitle: event.title }, app.user_id);
      }
    }

    res.json({ success: true, approvedCount });
  } catch (error) {
    console.error('Equalizer error:', error);
    res.status(500).json({ error: 'Internal server error running equalizer' });
  }
});

// 12. Update Event Settings (Organizer only)
router.patch('/api/events/:id', authenticateToken, requireCap('event.edit.own'), (req, res) => {
  const eventId = req.params.id;
  const { autoApprove, attendeeVisibility } = req.body;

  try {
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!can(req.principal, 'event.moderate') && event.organizer_id !== req.principal.userId) {
      return res.status(403).json({ error: 'Access denied: You do not host this event' });
    }
    if (event.status === 'completed') {
      return res.status(409).json({
        error: 'This event is complete and its settings can no longer be changed.',
        code: 'event_completed'
      });
    }

    if (autoApprove !== undefined) {
      db.prepare('UPDATE events SET auto_approve = ? WHERE id = ?').run(autoApprove ? 1 : 0, eventId);
    }
    if (attendeeVisibility !== undefined) {
      db.prepare('UPDATE events SET attendee_visibility = ? WHERE id = ?')
        .run(attendeeVisibility === 'private' ? 'private' : 'accepted', eventId);
    }

    const updated = db.prepare('SELECT auto_approve, attendee_visibility FROM events WHERE id = ?').get(eventId);
    res.json({
      success: true,
      autoApprove: updated.auto_approve === 1,
      attendeeVisibility: updated.attendee_visibility
    });
  } catch (error) {
    console.error('Update event settings error:', error);
    res.status(500).json({ error: 'Internal server error updating settings' });
  }
});

// --- ADMIN SPECIFIC ENDPOINTS ---

// A1. Fetch Pending Organizer accounts

router.delete('/api/events/:id', authenticateToken, requireCapAny(['event.moderate', 'event.edit.own']), (req, res) => {
  const eventId = req.params.id;

  try {
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    // Allow Admin OR the organizer who hosted it to delete it
    if (!can(req.principal, 'event.moderate') && event.organizer_id !== req.principal.userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // An event that produced service hours is part of a student's record, and a
    // record is not something a delete button gets to remove. Cancellation is
    // the way to call an event off; corrections go through attendance.
    const attendanceRows = eventAttendanceCount(db, eventId);
    if (attendanceRows > 0) {
      return res.status(409).json({
        error: 'This event has attendance recorded against it and can no longer be deleted, '
             + 'because volunteers\' service hours depend on it. Cancel it instead.',
        code: 'attendance_exists',
        attendanceRecords: attendanceRows
      });
    }
    if (event.status === 'completed') {
      return res.status(409).json({
        error: 'This event is complete and can no longer be deleted.',
        code: 'event_completed'
      });
    }

    /**
     * An event is not only an event. Deleting it takes every comment on it and —
     * by cascade through `conversations` — every private thread held under it,
     * which is where a safety report and its evidence snapshot live.
     *
     * The guards above did not cover this. Attendance is zero before an event
     * runs, and grooming happens before an event runs, so the window in which
     * the evidence was destructible was precisely the window in which the harm
     * occurs — and the reported organizer needed no privilege beyond owning
     * their own event.
     *
     * The hold applies to administrators too, and that is deliberate rather than
     * an oversight about `event.moderate`: the refusal is about the evidence, not
     * about who is asking, and an administrator named in a report is exactly the
     * case where trusting the administrator is the wrong default.
     */
    if (eventHasLiveReport(db, eventId)) {
      return res.status(409).json({
        error: EVENT_HELD_MESSAGE,
        code: 'report_evidence_held'
      });
    }

    inTransaction(() => {
      // No `DELETE FROM attendance` here on purpose: the guard above means this
      // point is only reachable when the event has none, so the statement could
      // only ever be a no-op — and leaving a destructive statement in the file
      // invites someone to move the guard later.
      db.prepare('DELETE FROM attendance_checkin WHERE event_id = ?').run(eventId);
      db.prepare('DELETE FROM applications WHERE event_id = ?').run(eventId);
      db.prepare('DELETE FROM event_comments WHERE event_id = ?').run(eventId);
      db.prepare('DELETE FROM user_favorites WHERE event_id = ?').run(eventId);
      db.prepare('DELETE FROM event_announcements WHERE event_id = ?').run(eventId);
      db.prepare('DELETE FROM slots WHERE event_id = ?').run(eventId);
      db.prepare('DELETE FROM events WHERE id = ?').run(eventId);

      /**
       * An administrator deleting somebody ELSE's event is recorded.
       *
       * This route had no audit row at all, so an administrator could remove
       * another organizer's event — and with it every comment, application and
       * announcement under it — and nothing anywhere said who did it. The
       * organizer sees their event gone and has nobody to ask.
       *
       * Not recorded when an organizer deletes their own: that is somebody
       * withdrawing their own listing, not an exercise of power over another
       * person, and filling the administrative trail with it would bury the rows
       * that matter.
       *
       * Inside the transaction, so the deletion and its record commit or fail
       * together. An audit row for a deletion that rolled back is a false record;
       * a deletion with no row is an unattributable one.
       */
      if (event.organizer_id !== req.principal.userId) {
        recordAudit(db, {
          adminId: req.principal.userId,
          action: 'EVENT_DELETED',
          targetUserId: event.organizer_id,
          details: `Deleted "${event.title}" (${eventId}), hosted by another organizer`,
        });
      }
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Remove event error:', error);
    res.status(500).json({ error: 'Internal server error removing event listing' });
  }
});

// A5. Toggle Event Status (Organizer only)
router.patch('/api/events/:id/status', authenticateToken, requireCapAny(['event.moderate', 'event.edit.own']), async (req, res) => {
  const eventId = req.params.id;
  const { status } = req.body;

  if (!['open', 'closed', 'cancelled'].includes(status)) {
    return res.status(400).json({ error: 'Status must be open, closed, or cancelled' });
  }

  try {
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!can(req.principal, 'event.moderate') && event.organizer_id !== req.principal.userId) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (event.status === 'completed') {
      return res.status(409).json({
        error: 'This event is complete. Its status can no longer be changed.',
        code: 'event_completed'
      });
    }

    db.prepare('UPDATE events SET status = ? WHERE id = ?').run(status, eventId);

    // Calling off an event is the one change every confirmed volunteer must
    // hear about immediately — they may have arranged a ride around it.
    let notified = 0;
    if (status === 'cancelled' && event.status !== 'cancelled') {
      notified = await notifyConfirmedVolunteers(eventId, 'EVENT_CANCELLED', { eventId: event.id, eventTitle: event.title }, `cancelled:${eventId}`);
    }

    res.json({ success: true, status, notified });
  } catch (error) {
    console.error('Toggle status error:', error);
    res.status(500).json({ error: 'Internal server error toggling event status' });
  }
});

// A6. Export Accepted Roster as CSV (Organizer only)

router.post('/api/events/:id/duplicate', authenticateToken, requireCap('event.create'), (req, res) => {
  try {
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!can(req.principal, 'event.moderate') && event.organizer_id !== req.principal.userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Create a new event with the same data but as 'open' status and shifted dates by default
    // We shift dates forward by 7 days; the organizer can edit afterwards.
    const newEventId = `event-${Date.now()}`;
    const shiftDays = 7;
    const shiftIso = (iso) => {
      const d = new Date(iso);
      d.setDate(d.getDate() + shiftDays);
      return d.toISOString();
    };
    db.prepare(`
      INSERT INTO events (id, title, description, category, location, application_deadline, organizer_id, status, created_at, auto_approve)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
    `).run(
      newEventId,
      `${event.title} (Copy)`,
      event.description,
      event.category,
      event.location,
      shiftIso(event.application_deadline),
      req.user.id,
      new Date().toISOString(),
      event.auto_approve
    );

    // Clone slots
    const slots = db.prepare('SELECT * FROM slots WHERE event_id = ?').all(event.id);
    for (const s of slots) {
      const newSlotId = `slot-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
      db.prepare(`
        INSERT INTO slots (id, event_id, name, description, start_datetime, end_datetime, max_spots)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(newSlotId, newEventId, s.name, s.description,
        shiftIso(s.start_datetime), shiftIso(s.end_datetime), s.max_spots);
    }

    res.status(201).json({ success: true, id: newEventId });
  } catch (err) {
    console.error('Duplicate event error:', err);
    res.status(500).json({ error: 'Failed to duplicate event' });
  }
});

// 25. Quick stats (admin) — used to enrich the admin panel

router.get('/api/events/:id/auto-select/runs', authenticateToken, requireCapAny(['event.moderate', 'applicant.review']), (req, res) => {
  const eventId = req.params.id;
  try {
    const event = db.prepare('SELECT organizer_id FROM events WHERE id = ?').get(eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    if (!can(req.principal, 'event.moderate') && event.organizer_id !== req.principal.userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const runs = db.prepare(`
      SELECT * FROM auto_select_runs
      WHERE event_id = ?
      ORDER BY run_number ASC
    `).all(eventId);

    const formattedRuns = runs.map(run => ({
      id: run.id,
      runNumber: run.run_number,
      createdAt: run.created_at,
      isConfirmed: run.is_confirmed === 1,
      selectedIds: JSON.parse(run.selected_ids),
      waitlistIds: JSON.parse(run.waitlist_ids),
      reason: run.reason ?? null
    }));

    res.json(formattedRuns);
  } catch (err) {
    console.error('Fetch auto select runs error:', err);
    res.status(500).json({ error: 'Failed to fetch runs' });
  }
});

// A27. Execute Draft Auto Select Draw (Organizer only)
router.post('/api/events/:id/auto-select/run', authenticateToken, requireCapAny(['event.moderate', 'applicant.review']), (req, res) => {
  const eventId = req.params.id;

  try {
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    if (!can(req.principal, 'event.moderate') && event.organizer_id !== req.principal.userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Ensure it is an Auto Select event
    if (event.auto_approve !== 1) {
      return res.status(400).json({ error: 'This event is not configured for Auto Select' });
    }

    // A draw before the deadline would exclude students who have every right
    // to apply until then — refuse rather than let a fairness mechanism run early.
    if (new Date() < new Date(event.application_deadline)) {
      return res.status(400).json({
        error: 'Applications are still open; selection can run after the deadline.',
        code: 'deadline_not_passed'
      });
    }

    // Check if there is already a confirmed selection
    const confirmedExists = db.prepare('SELECT COUNT(*) as count FROM auto_select_runs WHERE event_id = ? AND is_confirmed = 1').get(eventId).count;
    if (confirmedExists > 0) {
      return res.status(400).json({ error: 'Selection has already been confirmed and locked for this event' });
    }

    // Determine the next run number
    const runCount = db.prepare('SELECT COUNT(*) as count FROM auto_select_runs WHERE event_id = ?').get(eventId).count;

    // A re-drawable "fairness" mechanism with no audit trail can be shopped
    // until the organizer likes the outcome. Cap total draws and require a
    // typed reason on every re-draw (the first draw needs none).
    const { reason } = req.body;
    if (runCount >= MAX_AUTO_SELECT_DRAWS) {
      return res.status(409).json({
        error: 'The maximum number of re-draws has been reached for this event.',
        code: 'draw_cap_reached'
      });
    }
    if (runCount >= 1 && !String(reason || '').trim()) {
      return res.status(400).json({ error: 'A re-draw requires a reason.', code: 'reason_required' });
    }
    const cleanReason = String(reason || '').trim().slice(0, 500);

    const nextRunNumber = runCount + 1;

    /**
     * The draw itself lives in services/autoSelect.js.
     *
     * Moved out of this handler so the Auto Select scheduler runs the SAME code
     * rather than a second copy of the weighting, the seed formula and the capacity
     * arithmetic. A fairness algorithm with two implementations diverges silently —
     * both copies keep producing plausible-looking winners — which is the shape of
     * audit finding F-1. Behaviour here is unchanged; this is a delegation.
     */
    const { selectedIds, waitlistIds } = computeDraw(db, eventId, { runNumber: nextRunNumber });
    const { runId, createdAt: nowStr } = recordRun(
      db, eventId,
      { selectedIds, waitlistIds },
      { runNumber: nextRunNumber, reason: runCount >= 1 ? cleanReason : null }
    );

    res.json({
      id: runId,
      runNumber: nextRunNumber,
      createdAt: nowStr,
      selectedIds,
      waitlistIds
    });
  } catch (err) {
    console.error('Run Auto Select error:', err);
    res.status(500).json({ error: 'Failed to execute Auto Select draw' });
  }
});

// A28. Confirm and Lock Auto Select Results (Organizer only)
router.post('/api/events/:id/auto-select/confirm', authenticateToken, requireCapAny(['event.moderate', 'applicant.review']), (req, res) => {
  const eventId = req.params.id;

  try {
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    if (!can(req.principal, 'event.moderate') && event.organizer_id !== req.principal.userId) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (event.status === 'completed') {
      return res.status(409).json({
        error: 'This event is complete. Selection can no longer be confirmed for it.',
        code: 'event_completed'
      });
    }

    // Fetch the latest run
    const latestRun = db.prepare(`
      SELECT * FROM auto_select_runs
      WHERE event_id = ?
      ORDER BY run_number DESC LIMIT 1
    `).get(eventId);

    if (!latestRun) {
      return res.status(400).json({ error: 'No draft runs found to confirm. Run selection first.' });
    }

    if (latestRun.is_confirmed === 1) {
      return res.status(400).json({ error: 'Selection is already confirmed and locked' });
    }

    /**
     * Applying the run lives in services/autoSelect.js — same reason as the draw
     * above: the scheduler confirms runs too, and one implementation cannot drift
     * from itself. `executedBy` records who caused it so a district can tell an
     * organizer's selection from an automatic one.
     */
    applyRun(db, eventId, latestRun, { executedBy: 'organizer' });

    res.json({ success: true });
  } catch (err) {
    console.error('Confirm Auto Select error:', err);
    res.status(500).json({ error: 'Failed to confirm selection results' });
  }
});

// Broadcast email to confirmed roster
router.post('/api/events/:id/broadcast', authenticateToken, requireCapAny(['event.moderate', 'announcement.post']), async (req, res) => {
  const { id: eventId } = req.params;
  const { subject, message } = req.body;

  if (!subject || !message) {
    return res.status(400).json({ error: 'Subject and message are required' });
  }

  try {
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    
    if (!can(req.principal, 'event.moderate') && event.organizer_id !== req.principal.userId) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const confirmedApps = db.prepare(`
      SELECT DISTINCT u.id, u.email 
      FROM applications a
      JOIN users u ON a.user_id = u.id
      WHERE a.event_id = ? 
        AND a.status = 'accepted'
    `).all(eventId);

    if (confirmedApps.length === 0) {
      return res.status(400).json({ error: 'No confirmed volunteers to email' });
    }

    const { sendNotificationEmail } = await import('../email.js');
    const { notificationService } = await import('../services/notificationService.js');
    
    const emailPromises = [];
    for (const u of confirmedApps) {
      // Create in-app notification
      notificationService.dispatch('IMPORTANT_ANNOUNCEMENT', { eventId: event.id, eventTitle: event.title, body: message }, u.id);
      // Send email if not opted out
      if (u.email && u.email_opt_out === 0) {
        emailPromises.push(sendNotificationEmail(u.email, `Update: ${event.title} - ${subject}`, message));
      }
    }

    Promise.allSettled(emailPromises).catch(err => console.error('Broadcast error:', err));

    res.json({ success: true, count: confirmedApps.length });
  } catch (err) {
    console.error('Broadcast route error:', err);
    res.status(500).json({ error: 'Failed to broadcast message' });
  }
});



// 12. ICS Calendar Export (Authenticated)
// Allows volunteers to download ICS files for slots they've applied to.
router.get('/api/events/:eventId/slots/:slotId/ics', authenticateToken, (req, res) => {
  const { eventId, slotId } = req.params;
  
  try {
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    const slot = db.prepare('SELECT * FROM slots WHERE id = ? AND event_id = ?').get(slotId, eventId);
    
    if (!event || !slot) {
      return res.status(404).send('Event or slot not found');
    }

    /**
     * Serialisation lives in ../ics.js so it can be tested against RFC 5545
     * rather than against substrings of its own output. The version that was
     * inline here joined its lines with a literal `\r\n` TEXT sequence and
     * produced a one-line file no calendar application could parse.
     */
    const icsContent = buildShiftIcs({
      uid: `${slot.id}@wevolunteer.org`,
      start: slot.start_datetime,
      end: slot.end_datetime,
      summary: `${event.title} (${slot.name})`,
      // A blank line between the event blurb and the shift-specific note. The
      // escaping in buildShiftIcs turns these into the `\n` TEXT escape.
      description: `${event.description}\n\n${slot.description}`,
      location: event.location
    });

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="wevolunteer-${event.title.replace(/[^a-z0-9]/gi, '-').toLowerCase()}-${slot.name.replace(/[^a-z0-9]/gi, '-').toLowerCase()}.ics"`);
    res.send(icsContent);
  } catch (err) {
    console.error('ICS Export error:', err);
    res.status(500).send('Internal server error generating calendar file');
  }
});

// Unknown API routes get JSON instead of an HTML 404 page

export default router;
