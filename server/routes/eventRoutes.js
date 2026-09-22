import express from 'express';
// Explicit, rather than leaning on the Node global, so this matches authRoutes
// and accountRoutes and cannot break if the module is ever loaded somewhere the
// global is not present.
import crypto from 'crypto';

import { VALID_CATEGORIES, MAX_AUTO_SELECT_DRAWS } from '../config.js';
import { computeDraw, recordRun, applyRun } from '../services/autoSelect.js';
import { attendanceOnSlots, eventAttendanceCount } from '../attendance.js';
import { authenticateToken, notifyConfirmedVolunteers } from '../utils.js';
import { runInTransaction } from '../db/connectionContext.js';
import { can, requireCapAny } from '../authz.js';
import { recordAudit } from '../auditLog.js';
import { notificationService } from '../services/notificationService.js';
import { db } from '../db.js';
import { validateTags, replaceEventTags, tagsForEvent, tagsForEvents, tagVocabulary, BROWSE_TAG_LIMIT } from '../eventTags.js';
import { refreshEventSummary } from '../eventSummary.js';
import { EVENT_AUDIENCES, DEFAULT_AUDIENCE, isMemberOf } from '../eventEligibility.js';
import { validateEventPayload } from '../validation.js';
import { buildShiftIcs } from '../ics.js';
import { parseEventFilters, buildEventListStatement } from '../eventQuery.js';
import { shouldUseSemantic, semanticCandidates, similarEventCandidates } from '../search/discoverSearch.js';
import { markEventDirty, removeEventFromIndex } from '../search/eventIndexer.js';
import { recommendationsFor, explanationText } from '../search/recommendations.js';
import { eventHasLiveReport, EVENT_HELD_MESSAGE } from '../evidenceHolds.js';
import { canHelpRun, canRunEvent, EVENT_STAFF_CAPABILITIES, memberIds } from '../organizations.js';
import { MAIL_DOMAIN } from '../emailIdentity.js';
import { badgeService } from '../services/badgeService.js';

const router = express.Router();

/**
 * The caller's own active ban from an organization, with any appeal they filed.
 *
 * Returns `null` for "nothing to say" — no organization on the event, no
 * session, or no active ban — so a client can render on truthiness alone.
 *
 * The appeal is looked up by the same `(subject, subject_ref, user_id)` triple
 * `POST /api/appeals` writes, which is what keeps the button on the event and
 * the row in the organization's inbox describing one thing.
 */
/**
 * Every organization this reader is currently banned from, with the reason and
 * their latest appeal — as a Map keyed by organization id.
 *
 * Built once per list response. The per-event form below would otherwise run
 * two queries for each of sixty cards, and a list is the surface where that
 * cost is actually paid.
 */
/**
 * The organizations this reader belongs to, as a Set of ids.
 *
 * One query for the whole page rather than one per card, for the same reason
 * `viewerBansFor` is batched: a browse list is up to sixty events, and a
 * membership lookup per card is sixty round trips to answer one question.
 *
 * Used only to decide what a members-only event SAYS. It is not the
 * enforcement — `eventApplicationEligibility` re-reads the membership row when
 * an application is actually made, and would refuse regardless of what this
 * told the browser.
 */
async function viewerMembershipsFor(userId) {
  if (!userId) return new Set();
  return new Set((await db.prepare('SELECT organization_id FROM organization_members WHERE user_id = ?')
    .all(userId)).map(r => r.organization_id));
}

async function viewerBansFor(userId) {
  if (!userId) return new Map();

  const bans = await db.prepare(`
    SELECT organization_id, reason FROM organization_bans
     WHERE user_id = ? AND lifted_at IS NULL
  `).all(userId);
  if (bans.length === 0) return new Map();

  const appeals = await db.prepare(`
    SELECT subject_ref, id, status, decision FROM appeals
     WHERE subject = 'organization_ban' AND user_id = ?
     ORDER BY created_at ASC
  `).all(userId);
  /* Last write wins, and the rows arrive oldest-first, so this keeps the most
     recent appeal per organization — the one belonging to the ban they are
     under now rather than one from a ban already lifted. */
  const latest = new Map(appeals.map(a => [a.subject_ref, a]));

  return new Map(bans.map(b => [b.organization_id, {
    banned: true,
    reason: b.reason,
    appeal: latest.has(b.organization_id)
      ? {
        id: latest.get(b.organization_id).id,
        status: latest.get(b.organization_id).status,
        decision: latest.get(b.organization_id).decision,
      }
      : null,
  }]));
}

async function viewerBanFor(organizationId, userId) {
  if (!organizationId || !userId) return null;

  const ban = await db.prepare(`
    SELECT reason FROM organization_bans
     WHERE organization_id = ? AND user_id = ? AND lifted_at IS NULL
  `).get(organizationId, userId);
  if (!ban) return null;

  /* The most recent, so a reader who appealed, was refused, and was banned
     again sees the appeal that belongs to the ban they are under. */
  const appeal = await db.prepare(`
    SELECT id, status, decision FROM appeals
     WHERE subject = 'organization_ban' AND subject_ref = ? AND user_id = ?
     ORDER BY created_at DESC LIMIT 1
  `).get(organizationId, userId);

  return {
    banned: true,
    /* Their own ban reason. They were sent it when it happened; withholding it
       here would mean the one place they act on it is the one place it is not
       stated. */
    reason: ban.reason,
    appeal: appeal
      ? { id: appeal.id, status: appeal.status, decision: appeal.decision }
      : null,
  };
}

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
router.get('/api/events', authenticateToken, async (req, res) => {
  try {
    /**
     * `recommended=true` always answers in the envelope shape.
     *
     * The bare-array response is kept for callers written before pagination
     * existed, and it has nowhere to put the explanation that makes a
     * recommendation a recommendation rather than a list. A client asking for
     * suggestions without a `limit` would otherwise get the events and silently
     * lose the "because you saved …" that justifies them.
     */
    const paginated = req.query.limit !== undefined || req.query.recommended != null;

    let limit = null;
    let offset = 0;
    if (paginated) {
      /* A recommendation with no stated limit gets a screenful. */
      const rawLimit = req.query.limit === undefined ? 12 : Number(req.query.limit);
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
    /**
     * ── The semantic half of Discover ──
     *
     * Pinecone is asked for candidate event ids, and the ids are handed to the
     * query below as an extra OR on the text predicate. Nothing else changes:
     * the filters, the sort, the `COUNT(*) OVER ()`, the paging and the
     * serialiser are the same code that ran before this existed, so an event
     * found by meaning is subject to exactly the rules an event found by
     * substring has always been subject to.
     *
     * Failure is ordinary. `semanticCandidates` resolves with an empty list when
     * Pinecone is unconfigured, slow, or down, and the request then runs the
     * pure-SQL search — a complete answer rather than a degraded one. Nothing is
     * awaited that can take longer than `SEARCH_TIMEOUT_MS`.
     */
    if (filters.q && shouldUseSemantic(filters.q)) {
      const semantic = await semanticCandidates(filters.q, filters);
      if (semantic.ok && semantic.ids.length) filters.semanticIds = semantic.ids;
    }

    /**
     * ── Recommendations are a MODE of this endpoint, not a second one ──
     *
     * `?recommended=true` resolves a set of suggested event ids and hands them
     * to the very same query, filters, serialiser and response shape as an
     * ordinary browse. That is deliberate and it is the whole design: the
     * serialisation below is a hundred lines of batched loads — slots, accepted
     * counts, attendance, tags, viewer bans, memberships — and a recommendations
     * endpoint that reimplemented it would be a second read path that drifts,
     * misses a ban check, and has to be fixed twice.
     *
     * So a recommendation cannot show anything a browse would not show. It is a
     * browse in a different order.
     *
     * With no ids — a brand-new student, or Pinecone unavailable — nothing is
     * restricted and the caller gets soonest-first open opportunities, which is
     * a good answer rather than an empty one.
     */
    /**
     * ── "Opportunities like this one" ──
     *
     * Another MODE of this endpoint, for the same reason recommendations are:
     * the hundred lines of serialisation below, and every filter and ban check
     * above them, are the things a related-events list must not reimplement.
     *
     * It costs no embedding tokens. `similarEventCandidates` queries with the
     * vector the event already has, so the only charge is read units, on a
     * request a student made by opening one event.
     *
     * Scoped to `listable`: a completed or cancelled event is not a "similar
     * opportunity", it is history. `openOnly` is deliberately NOT forced —
     * unlike a recommendation, this is a lateral browse, and an event whose
     * sign-ups have closed is still worth seeing next to the one you are
     * reading.
     */
    if (filters.similarTo) {
      filters.scope = 'listable';
      const similar = await similarEventCandidates(filters.similarTo, filters);
      /* Fail closed. With no candidates this must return nothing, not the whole
         listable table — the caller asked "what is like this", and "everything"
         is not an answer to that. */
      filters.semanticIds = similar.ids;
      filters.restrictToSemanticIds = true;
      if (similar.ids.length && filters.sort === 'soonest') filters.sort = 'relevance';
    }

    let recommendation = null;
    if (filters.recommended) {
      /**
       * A suggestion is an invitation to act, so it is always scoped to things
       * that can be acted on.
       *
       * This is forced rather than defaulted. `parseEventFilters` defaults
       * `scope` to `all` — correct for the endpoint, because the dashboards and
       * the calendar need completed and cancelled events to render service
       * history — and inheriting that default here meant a cold-start
       * recommendation could suggest an event that was cancelled last spring.
       * Nothing in the ranking would catch it, because ranking is not a filter.
       *
       * `openOnly` comes with it, and is three conditions rather than one:
       * posted as open, a free place, and the deadline not yet passed. Suggesting
       * a full event is the same failure in a politer form.
       */
      filters.scope = 'listable';
      filters.openOnly = true;

      recommendation = await recommendationsFor(db, req.user.id, {
        limit: Math.max(limit ?? 12, 12),
      });
      if (recommendation.ids.length) {
        filters.semanticIds = recommendation.ids;
        filters.restrictToSemanticIds = true;
        if (filters.sort === 'soonest') filters.sort = 'relevance';
      }
    }

    /**
     * The statement itself is built by `eventQuery.buildEventListStatement`.
     *
     * It moved out of this route so that the harnesses which measure it —
     * `bin/events-query-probe.mjs` and `bin/search-bench.mjs` — build the
     * statement the application actually runs instead of a copy that drifts
     * away from it. The reasoning for every part of it is documented there.
     */
    const { sql, params } = buildEventListStatement({
      filters,
      userId: req.user.id,
      db,
      paginated,
      limit,
      offset,
      hardCap: EVENTS_MAX_LIMIT,
    });

    /**
     * Three lookups about the VIEWER, run alongside the page query rather than
     * after it.
     *
     * They depend on `req.user.id` and on nothing the page query returns, so
     * waiting for the page before asking them is a round trip spent for no
     * reason. On SQLite that was free; on PostgreSQL every one of them is a
     * network hop, and against a managed database that is single-digit
     * milliseconds each, on the busiest endpoint the platform has.
     *
     * Started here and handed straight to `Promise.all` below with no `await`
     * in between, which is what keeps a rejection from being unhandled: only
     * synchronous code separates the two, so the handlers are attached before
     * anything else can throw.
     *
     * Four concurrent statements at their widest, which is the ceiling this
     * codebase applies to fan-out on a request — see
     * `docs/operations/load-testing.md`. They also overlap the ONE expensive
     * query rather than each other, so the pool holds them for a quarter of the
     * time it held them sequentially and total occupancy barely moves.
     */
    const viewerContext = Promise.all([
      // Arrival details (instructions) are only for people who are actually
      // going, or who run the event — not the open internet, and not every
      // other signed-in student.
      db.prepare("SELECT DISTINCT event_id FROM applications WHERE user_id = ? AND status = 'accepted'")
        .all(req.user.id),
      /* One lookup for the page rather than two per card — see viewerBansFor. */
      viewerBansFor(req.user?.id),
      viewerMembershipsFor(req.user?.id),
    ]);

    const [events, [acceptedRows, viewerBans, viewerOrgs]] = await Promise.all([
      db.prepare(sql).all(params),
      viewerContext,
    ]);
    const acceptedEventIds = new Set(acceptedRows.map(r => r.event_id));

    /**
     * Zero rows carries no window value, so an empty page reports a zero total.
     *
     * That is correct rather than a special case: the window function is
     * computed per returned row, so with no rows there is nothing to read it
     * from — and a filter matching nothing genuinely has a total of nothing. An
     * OFFSET past the end also lands here, which is the same answer the separate
     * COUNT gave for a filter that matched nothing.
     */
    const total = events.length ? Number(events[0].total_count) : 0;

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

    /**
     * The four batch loads below are scoped to the rows actually being
     * returned, and run together.
     *
     * They previously read `slots`, every accepted application, and every
     * attendance row for the WHOLE table regardless of what was being sent —
     * so a paginated request for 20 events would still have loaded a district's
     * entire slot and attendance history to answer it, and the page would have
     * cost the same as the full list. A parameter list is built from the page's
     * event ids instead.
     *
     * They all take the same input and none reads another's output, so they are
     * one wave rather than four round trips. Not folded into a single statement
     * with subqueries: they return four different SHAPES — rows, a grouped
     * count, a distinct id list and a tag map — and a union of those is a query
     * nobody can read for a saving of one hop.
     *
     * The last of them is the page's tags, in one query. Per-event tag reads
     * here would be an N+1 on the endpoint the browse screen calls on every
     * keystroke.
     */
    const pageIds = events.map(e => e.id);
    const placeholders = pageIds.length ? pageIds.map(() => '?').join(',') : null;

    const [slotRows, acceptedSlotRows, attendanceRows, tagsByEvent] = placeholders
      ? await Promise.all([
        db.prepare(`SELECT * FROM slots WHERE event_id IN (${placeholders})`).all(...pageIds),
        db.prepare(`
          SELECT slot_id, COUNT(*) as count FROM applications
          WHERE status = 'accepted' AND event_id IN (${placeholders})
          GROUP BY slot_id
        `).all(...pageIds),
        // Whether any hours have been recorded against this event. The client
        // needs it to stop offering a delete button the server will refuse — an
        // action that is always going to fail should not be presented as
        // available.
        db.prepare(`SELECT DISTINCT event_id FROM attendance WHERE event_id IN (${placeholders})`)
          .all(...pageIds),
        tagsForEvents(db, pageIds),
      ])
      : [[], [], [], new Map()];

    const slotsByEvent = new Map();
    for (const s of slotRows) {
      if (!slotsByEvent.has(s.event_id)) slotsByEvent.set(s.event_id, []);
      slotsByEvent.get(s.event_id).push(s);
    }

    const acceptedBySlot = new Map(acceptedSlotRows.map(r => [r.slot_id, r.count]));
    const withAttendance = new Set(attendanceRows.map(r => r.event_id));

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

      /**
       * Deliberately NOT `canRunEvent` here, unlike every other authority
       * question about an event.
       *
       * This runs once per card, up to sixty per request, on the busiest
       * endpoint the platform has — and `canRunEvent`'s manager branch is a
       * membership lookup, so asking it here would add sixty queries to a
       * request that already carries a documented throughput ceiling. What it
       * would buy is arrival instructions on a browse card for a manager who
       * did not create the event; they read them on the event itself, where
       * `canRunEvent` IS asked, one query for one event.
       */
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
        /**
         * "Verified organizer" means an administrator approved this ACCOUNT to
         * run events. `users.verified` alone does not mean that: signup writes
         * it as 1 for every non-organizer, and it was harmless only while a
         * student could never be an event's host. Since the Student Organizer
         * rank, every event a student posts for their club was rendering the
         * approval shield.
         */
        organizerVerified: event.organizer_verified === 1
          && ['organizer', 'admin', 'super_admin'].includes(event.organizer_role),
        organizerSchool: event.organizer_school || '',
        status: event.status,
        /* When the organizer closed the hours out, or null while they are
           still correctable. The client uses it to stop offering an edit whose
           only outcome is a 409; the rule itself is `finalizeAttendance`'s. */
        hoursClosedOutAt: event.hours_closed_out_at || null,
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
        /* Who may apply. The client labels members-only events and explains
           ineligibility rather than showing a button that will be refused. */
        audience: event.audience || 'everyone',
        /**
         * Whether THIS reader is on the inside of that restriction.
         *
         * A members-only event is still listed to everybody and still says
         * whose it is — hiding it would mean somebody who would happily join
         * the club never learns the club exists. What changes is what the card
         * says: "members only, and you are not one" instead of a button that
         * 403s.
         *
         * Presentation only. The server re-reads the membership row on the
         * application itself and refuses there.
         */
        viewerIsMember: event.organization_id
          ? viewerOrgs.has(event.organization_id)
          : null,
        /* The reader's own ban from the organization running this event, if
           any — see `viewerBansFor`. Only ever theirs; there is no parameter
           that could point it at somebody else. */
        viewerBan: viewerBans.get(event.organization_id) || null,
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

    /* The explanation describes the whole suggestion rather than any one card,
       so it rides on the envelope. `basis` is the machine-readable half — it is
       how a client can tell a cold-start list from a personalised one without
       parsing prose. */
    const recommendationEnvelope = recommendation
      ? { recommendation: { text: explanationText(recommendation.explanation ?? {}), basis: recommendation.reason } }
      : null;

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
    /* The DISTINCT is taken first, in a subquery, and the sort applied outside
       it. PostgreSQL requires every `ORDER BY` expression of a `SELECT DISTINCT`
       to appear in the select list, and `location COLLATE nocase` is a different
       expression from `location` — so the flat form is a syntax error there
       while SQLite accepts it. Nesting keeps the case-insensitive ordering
       rather than dropping the collation, which would reorder the filter menu
       for every deployment that has a lower-case place name. */
    const places = (await db.prepare(`
      SELECT location FROM (
        SELECT DISTINCT location FROM events
        WHERE status IN ('open', 'closed') AND location IS NOT NULL AND location != ''
      ) AS distinct_locations
      ORDER BY location COLLATE nocase
    `).all()).map(r => r.location);

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
    /* The fifteen most used, not the fifty this defaults to — see
       BROWSE_TAG_LIMIT. Ordered by usage with a deterministic tie-break, so the
       bar does not reshuffle between requests. */
    const tags = await tagVocabulary(db, { limit: BROWSE_TAG_LIMIT });

    res.json({
      events: formattedEvents,
      ...(recommendationEnvelope ?? {}),
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
router.get('/api/events/tags', authenticateToken, async (req, res) => {
  try {
    res.json({ tags: await tagVocabulary(db, { limit: req.query.limit }) });
  } catch (err) {
    console.error('Failed to load the tag vocabulary:', err);
    res.status(500).json({ error: 'Could not load tags.' });
  }
});

/**
 * One event with its applications, for the organizer's own screens.
 *
 * Staff-only: it carries the applicant roster, which is not something a
 * student may enumerate for an event they are not running.
 */
router.get('/api/events/:id', authenticateToken, async (req, res) => {
  try {
    const event = await db.prepare(`
      SELECT e.*, u.name as organizer_name, u.verified as organizer_verified,
             u.school as organizer_school,
             org.name as organization_name, org.slug as organization_slug
      FROM events e JOIN users u ON e.organizer_id = u.id
      LEFT JOIN organizations org ON org.id = e.organization_id
      WHERE e.id = ?
    `).get(req.params.id);

    if (!event) return res.status(404).json({ error: 'Event not found' });

    /* BOTH halves. `canRunEvent` says the event is yours; the capability list is
       what consults `principal.withheld`, so a promoted student who has not
       accepted the Student Organizer Agreement is refused here as they are on
       every write route. Membership alone left this one open. */
    const isStaff = EVENT_STAFF_CAPABILITIES.some(c => can(req.principal, c))
      && await canRunEvent(db, event, req.principal.userId, {
        hasModerate: can(req.principal, 'event.moderate'),
      });
    if (!isStaff) return res.status(403).json({ error: 'Access denied: You do not host this event' });

    /* This route is staff-only (the `isStaff` gate above), so the reader always
       runs the event and `viewerIsMember` is not a question anybody is asking
       here. The field is still emitted for shape parity with the list, computed
       from the one membership row rather than a sweep of the whole table. */
    const viewerOrgs = event.organization_id
      ? new Set(await isMemberOf(event.organization_id, req.user?.id) ? [event.organization_id] : [])
      : new Set();
    const slots = await db.prepare('SELECT * FROM slots WHERE event_id = ?').all(event.id);
    const acceptedBySlot = new Map();
    for (const r of await db.prepare(`
      SELECT slot_id, COUNT(*) as count FROM applications
      WHERE event_id = ? AND status = 'accepted' GROUP BY slot_id
    `).all(event.id)) {
      acceptedBySlot.set(r.slot_id, r.count);
    }

    const formattedSlots = slots.map(s => formatSlot(s, acceptedBySlot.get(s.id) || 0));

    const applications = (await db.prepare(`
      SELECT a.id, a.user_id, a.event_id, a.slot_id, a.status, a.applied_at,
             u.name, u.avatar, u.grade, u.school
      FROM applications a JOIN users u ON a.user_id = u.id
      WHERE a.event_id = ?
      ORDER BY u.name
    `).all(event.id)).map(a => ({
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
        /* When the organizer closed the hours out, or null while they are
           still correctable. The client uses it to stop offering an edit whose
           only outcome is a 409; the rule itself is `finalizeAttendance`'s. */
        hoursClosedOutAt: event.hours_closed_out_at || null,
        autoApprove: event.auto_approve === 1,
        creditsHours: event.credits_hours !== 0,
        organizationId: event.organization_id || null,
        /* Who may apply. The client labels members-only events and explains
           ineligibility rather than showing a button that will be refused. */
        audience: event.audience || 'everyone',
        /**
         * Whether THIS reader is on the inside of that restriction.
         *
         * A members-only event is still listed to everybody and still says
         * whose it is — hiding it would mean somebody who would happily join
         * the club never learns the club exists. What changes is what the card
         * says: "members only, and you are not one" instead of a button that
         * 403s.
         *
         * Presentation only. The server re-reads the membership row on the
         * application itself and refuses there.
         */
        viewerIsMember: event.organization_id
          ? viewerOrgs.has(event.organization_id)
          : null,
        organizationName: event.organization_name || null,
        organizationSlug: event.organization_slug || null,
        /**
         * Whether THIS reader is banned from the organization running this
         * event, and what became of any appeal they have already filed.
         *
         * ── Why it lives on the event ──
         *
         * Being told you are banned only through a notification means being
         * told once, in a list that fills up. Somebody who comes back to the
         * event a week later and finds they cannot join deserves to learn why
         * where they are standing, and to be able to do something about it
         * without hunting through their notifications.
         *
         * ── Whose ban ──
         *
         * Only the caller's. It is keyed on `req.user.id` and there is no
         * parameter to change that, so this cannot be turned into a way to ask
         * whether somebody else is banned. Managers read bans through the
         * organization's own surfaces, which are separately authorized.
         *
         * `null` when there is no organization, no ban, or no session — the
         * absence of a ban and the absence of an organization look the same to
         * a reader, and neither needs explaining.
         */
        viewerBan: await viewerBanFor(event.organization_id, req.user?.id),
        /* Same shape as the list response, so a client that renders chips from
           one can render them from the other without a second code path. */
        tags: await tagsForEvent(db, event.id),
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
 * Creating an event.
 *
 * ── Why the gate accepts two capabilities ──
 *
 * `event.create` is the account-level power: this person may put a shift up
 * anywhere, under their own name. `organization.event.create` is the smaller
 * one: this person may put a shift up FOR A CLUB THEY HELP RUN, and nothing
 * else. Students hold the second so that a Student Organizer can reach this
 * handler at all; the block below is what stops a student who helps run nothing
 * from getting any further than the door.
 */
router.post('/api/events', authenticateToken, requireCapAny(['event.create', 'organization.event.create']), async (req, res) => {
  // Check if organizer is verified by Admin
  const organizer = await db.prepare('SELECT verified FROM users WHERE id = ?').get(req.user.id);
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
  /**
   * Who the event is for.
   *
   * `organization` is only meaningful with an organization behind it — a shift
   * "for members" of nothing is a shift nobody can join, and silently treating
   * it as open would be a different event from the one the organizer described.
   * So it is refused rather than corrected.
   */
  /**
   * An audience the server does not recognise is REFUSED, not corrected.
   *
   * It used to coerce silently to `everyone`, which meant a client with a typo
   * published a public event where its organizer had asked for a restricted one
   * — the failure mode being quiet is what makes it bad, not the default being
   * wrong. `PUT` already answered 400 for the same value, so the two halves of
   * the same field also disagreed about their own contract.
   */
  const audience = req.body?.audience === undefined ? DEFAULT_AUDIENCE : req.body.audience;
  if (!EVENT_AUDIENCES.includes(audience)) {
    return res.status(400).json({
      error: 'That is not a valid audience for an event.',
      field: 'audience', code: 'invalid_audience',
    });
  }
  if (audience === 'organization' && (organizationId == null || organizationId === '')) {
    return res.status(400).json({
      error: 'Choose the organization whose members can apply.',
      field: 'organizationId', code: 'organization_required',
    });
  }

  /**
   * An account with no `event.create` may ONLY create for an organization.
   *
   * This is the whole of what keeps `organization.event.create` from being a
   * quiet promotion. A Student Organizer reached this handler because they help
   * run one club; without this line the same request with `organizationId`
   * omitted would produce a personal event under their own name, which is the
   * `organizer` role, granted by a club president who was only choosing who
   * posts the bake-sale shift.
   */
  const orgScopedOnly = !can(req.principal, 'event.create');
  if (orgScopedOnly && (organizationId == null || organizationId === '')) {
    return res.status(403).json({
      error: 'You can only create events for an organization you help run.',
      field: 'organizationId', code: 'organization_required',
    });
  }

  let organization = null;
  if (organizationId != null && organizationId !== '') {
    organization = await db.prepare('SELECT * FROM organizations WHERE id = ?').get(organizationId);
    if (!organization || organization.status !== 'active') {
      return res.status(400).json({ error: 'That organization does not exist.', field: 'organizationId' });
    }
    /* `canHelpRun`, not `canManage` — a Student Organizer posting their club's
       shift is the point of the rank. Managers and moderators are included by
       that function, so nobody loses anything they had. */
    if (!await canHelpRun(db, organization.id, req.user.id, { hasModerate: can(req.principal, 'organization.moderate') })) {
      return res.status(403).json({
        error: 'You do not help run that organization.',
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
    
    await runInTransaction(db, async (tx) => {
      // A. Insert Event
      await tx.prepare(`
        INSERT INTO events (id, title, description, category, location, application_deadline,
                            organizer_id, status, created_at, auto_approve, instructions, attendee_visibility,
                            address, latitude, longitude, organization_id, credits_hours, audience)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        awardsHours ? 1 : 0,
        /* An event with no organization is always open, whatever was asked for
           — the validation above refuses the combination, so this is belt and
           braces against a future caller skipping it. */
        organization ? audience : DEFAULT_AUDIENCE
      );

      // B. Insert slots
      for (const slot of slots) {
        const slotId = `slot-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        await tx.prepare(`
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

      /* B2. The slot summary, in the SAME transaction as the slots.
         Outside it, a concurrent reader sees slots and summary disagreeing —
         and the browse list's ordering is exactly what that corrupts. */
      await refreshEventSummary(tx, eventId);

      /* C. Tags. Inside the same transaction as the event and its slots: an
         event that saved without the tags the organizer typed is a silent partial
         write, and they would have no way to tell other than reopening it. */
      await replaceEventTags(tx, eventId, tagCheck.value);
    });

    /**
     * Queue the new event for the search index.
     *
     * After the commit and outside the transaction, because it is bookkeeping
     * about a fact that is now true rather than part of the fact itself — and
     * because a search index must never be able to roll back the creation of an
     * event. `markEventDirty` is one local upsert and cannot throw.
     */
    await markEventDirty(db, eventId);

    /**
     * Re-evaluate the organizer's own badges, now that the count has moved.
     *
     * `events_created` — Organizer at one, Community Builder at ten — is the
     * only criterion decided by the actor's own activity rather than by
     * attendance, and `evaluateBadges` had exactly two production callers, both
     * in the attendance route and both for the VOLUNTEER being credited. So an
     * organizer who never volunteered was never evaluated: measured at twelve
     * non-cancelled events and zero badges, with all three arriving at once the
     * moment that account was credited as a volunteer somewhere else.
     *
     * Creation is the right moment rather than completion, and `collectStats`
     * says why it counts `status != 'cancelled'` instead of `completed`:
     * requiring completion would withhold the badge "until that opportunity had
     * already finished — which is not what it says, and is not when the
     * recognition is worth anything."
     *
     * After the commit, and it cannot fail the request: `evaluateBadges`
     * catches its own errors by design, for the same reason the notification
     * fan-out below is wrapped — a badge must never be able to destroy an event
     * the organizer successfully created. Repeat calls are safe: an award is
     * inserted only when no row exists, `user_badges` carries
     * UNIQUE(user_id, badge_id), and the announcement dedupe key is permanent.
     */
    await badgeService.evaluateBadges(req.user.id);

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
        const recipients = await memberIds(db, organization.id, { excluding: [req.user.id] });
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
        await runInTransaction(db, async () => {
          await notificationService.dispatchMany(
            'ORGANIZATION_EVENT_POSTED',
            { eventId, eventTitle: title, organizationName: organization.name, organizationSlug: organization.slug },
            recipients,
            () => `org-event:${eventId}`
          );
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

router.put('/api/events/:id', authenticateToken, requireCapAny(['event.edit.own', 'organization.event.manage.own']), async (req, res) => {
  const eventId = req.params.id;
  const {
    title, description, category, location, applicationDeadline, slots,
    autoApprove, instructions, attendeeVisibility, audience,
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
    const event = await db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!await canRunEvent(db, event, req.principal.userId, { hasModerate: can(req.principal, 'event.moderate') })) {
      return res.status(403).json({ error: 'Access denied: You do not host this event' });
    }

    if (event.status === 'completed') {
      return res.status(409).json({
        error: 'This event is complete and its details can no longer be changed. Attendance can still be corrected.',
        code: 'event_completed'
      });
    }

    /**
     * An absent geo field means "not editing it", not "clear it".
     *
     * The UPDATE below wrote `address`, `latitude` and `longitude`
     * unconditionally from the body. `OrganizerDashboard`'s quick-edit form
     * sends title, description, location and category and nothing else — so
     * every quick save silently nulled the coordinates an organizer had picked
     * on the map, and with them that event's distance filtering, its directions
     * link and its forecast. The map data disappeared through the form that
     * never mentions maps.
     *
     * Same distinction the `tags` block below makes, for the same reason: a
     * client written before a field existed must not strip that field by saving
     * something else. Explicit `null` still clears, so a deliberate "remove the
     * pin" is still expressible.
     *
     * The coordinates move as a pair — `validateEventPayload` refuses one
     * without the other — so they are kept or replaced together and never left
     * half-written.
     */
    const nextAddress = address === undefined ? event.address : (address || null);
    const editingCoords = latitude !== undefined || longitude !== undefined;
    const nextLatitude = editingCoords ? (latitude ?? null) : event.latitude;
    const nextLongitude = editingCoords ? (longitude ?? null) : event.longitude;

    const changes = [];
    if (event.title !== title) changes.push('title');
    if (event.location !== location || event.address !== nextAddress) changes.push('location');
    if (event.application_deadline !== applicationDeadline) changes.push('deadline');
    if (event.description !== description) changes.push('description');

    // Removing a shift used to take its attendance rows with it, silently
    // destroying hours volunteers had already earned. Credited service is not
    // something an event edit gets to delete as a side effect.
    const payloadIds = slots.filter(s => s.id && !s.id.startsWith('new-')).map(s => s.id);
    const existingIds = (await db.prepare('SELECT id FROM slots WHERE event_id = ?').all(eventId)).map(s => s.id);
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

    /**
     * ── Times are locked on a shift somebody has already been credited for ──
     *
     * The guard below covers slot REMOVAL only. Changing the times on a slot
     * that was kept was completely unguarded, and the comment above already
     * explains why that matters: credited hours are priced from the slot's
     * duration at the moment attendance is confirmed. Editing the times
     * afterwards leaves the stored credit describing a shift that did not
     * happen — the certificate prints dates the volunteer was not there, and any
     * volunteer on the same slot not yet finalised is priced from the NEW
     * duration, so two people on one shift get different hours with nothing
     * anywhere to explain it. No ledger row is written, because from the
     * ledger's point of view nothing happened.
     *
     * An incidental brake existed — an edit naming a slot that has already
     * started fails the deadline rule — but that is a side effect of a rule
     * about deadlines, phrased in terms of deadlines, which would vanish the day
     * anybody relaxed it. This is the explicit version.
     *
     * Keyed on attendance EXISTING, so a slot with none stays fully editable:
     * fixing a typo before anybody is credited is the common case and is
     * untouched. Only the times are locked — a name, description or spot count
     * can still be corrected on a finalised shift.
     */
    const retained = slots.filter(sl => sl.id && existingIds.includes(sl.id));
    const storedById = new Map(
      (await db.prepare('SELECT id, name, start_datetime, end_datetime FROM slots WHERE event_id = ?')
        .all(eventId)).map(row => [row.id, row])
    );
    const retimed = retained.filter(sl => {
      const stored = storedById.get(sl.id);
      if (!stored) return false;
      /* Compared as INSTANTS, not as strings: the client may legitimately send
         `2026-06-01T09:00` where the column holds `2026-06-01T09:00:00.000Z`,
         and a string comparison would report a change nobody made. */
      const sameStart = Date.parse(sl.startDatetime) === Date.parse(stored.start_datetime);
      const sameEnd = Date.parse(sl.endDatetime) === Date.parse(stored.end_datetime);
      return !(sameStart && sameEnd);
    }).map(sl => sl.id);

    const lockedRows = await attendanceOnSlots(db, retimed);
    if (lockedRows.length > 0) {
      const names = [...new Set(lockedRows.map(r => r.user_name).filter(Boolean))];
      return res.status(409).json({
        error: 'Those shifts already have attendance recorded, so their times cannot be changed. '
          + `${names.length} volunteer${names.length === 1 ? '' : 's'} ${names.length === 1 ? 'was' : 'were'} `
          + `credited from the times as they stand: ${names.join(', ')}. `
          + 'Correct the hours on the attendance screen instead.',
        code: 'attendance_exists',
        reason: 'slot_times_locked',
        volunteers: names,
        slots: [...new Set(lockedRows.map(r => r.slot_name).filter(Boolean))],
      });
    }

    const protectedRows = await attendanceOnSlots(db, removedIds);

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

    await runInTransaction(db, async (tx) => {
      // 1. Update event details
      await tx.prepare(`
        UPDATE events
        SET title = ?, description = ?, category = ?, location = ?, application_deadline = ?,
            address = ?, latitude = ?, longitude = ?
        WHERE id = ?
      `).run(title, description, category, location, applicationDeadline, nextAddress, nextLatitude, nextLongitude, eventId);

      if (autoApprove !== undefined) {
        await tx.prepare('UPDATE events SET auto_approve = ? WHERE id = ?').run(autoApprove ? 1 : 0, eventId);
      }
      if (instructions !== undefined) {
        await tx.prepare('UPDATE events SET instructions = ? WHERE id = ?').run(instructions || '', eventId);
      }
      if (attendeeVisibility !== undefined) {
        await tx.prepare('UPDATE events SET attendee_visibility = ? WHERE id = ?')
          .run(attendeeVisibility === 'private' ? 'private' : 'accepted', eventId);
      }

      /**
       * Changing who the event is for.
       *
       * ── Only when the field is sent ──
       *
       * Omitting `audience` leaves it alone, the same rule `tags` follows below.
       * A client that predates this field must not silently reopen a
       * members-only shift by saving an unrelated edit.
       *
       * ── The organization is not editable here, so narrowing is safe ──
       *
       * `PUT` never accepted `organizationId` and still does not, so an event
       * cannot be pointed at a different club. Narrowing to `organization`
       * therefore restricts the event to the members of the club it already
       * belonged to, which is the only club it was ever announced under.
       *
       * ── Existing applications are NOT invalidated ──
       *
       * Somebody who applied while the event was open keeps their place when it
       * narrows. They applied to something that was genuinely open at the time,
       * and revoking it silently would take a place away with no notice and no
       * record. The audience governs who may apply from now on; an organizer who
       * wants a specific person off the shift has a control for that.
       *
       * ── An event with no organization cannot be narrowed ──
       *
       * "Members only" of nothing is a shift nobody can join. Refused rather
       * than corrected, so the organizer finds out now.
       */
      if (audience !== undefined) {
        if (!EVENT_AUDIENCES.includes(audience)) {
          throw Object.assign(new Error('bad audience'), { httpStatus: 400, field: 'audience' });
        }
        if (audience === 'organization' && !event.organization_id) {
          throw Object.assign(new Error('no organization'), { httpStatus: 400, field: 'audience', code: 'organization_required' });
        }
        await tx.prepare('UPDATE events SET audience = ? WHERE id = ?').run(audience, eventId);
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
        await replaceEventTags(tx, eventId, tagCheck.value);
      }

      /* The edit changed title, description, category, location, tags or
         audience — every one of which is embedded or filtered on. Marked inside
         the transaction here because, unlike creation, there is no post-commit
         block to hang it from and the mark is idempotent: a rolled-back edit
         leaves an event queued for a re-index that will compute the same hash it
         already has and send nothing. */
      await markEventDirty(tx, eventId);

      // 2. Differential sync slots.
      //
      // `removedIds` was computed above and has already been checked for
      // attendance, so nothing credited can be reached from here. There is
      // deliberately no "payload named no existing slots, so delete them all"
      // branch: an edit that names no slots is a malformed request, not an
      // instruction to erase every sign-up on the event.
      for (const slotId of removedIds) {
        await tx.prepare('DELETE FROM attendance_checkin WHERE slot_id = ?').run(slotId);
        await tx.prepare('DELETE FROM applications WHERE slot_id = ?').run(slotId);
        await tx.prepare('DELETE FROM slots WHERE id = ?').run(slotId);
      }

      // 3. Insert new or update existing slots
      for (const slot of slots) {
        if (slot.id && !slot.id.startsWith('new-')) {
          /* `AND event_id = ?` as well as the refusal above — belt and braces on
             purpose. The check above is the one that produces a good error; this
             is what still holds if a future edit reorders the handler and moves
             the validation after the transaction, which is exactly the kind of
             refactor that reintroduces this class of bug. */
          await tx.prepare(`
            UPDATE slots
            SET name = ?, description = ?, start_datetime = ?, end_datetime = ?, max_spots = ?
            WHERE id = ? AND event_id = ?
          `).run(slot.name, slot.description, slot.startDatetime, slot.endDatetime, Number(slot.maxSpots), slot.id, eventId);
        } else {
          const slotId = `slot-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
          await tx.prepare(`
            INSERT INTO slots (id, event_id, name, description, start_datetime, end_datetime, max_spots)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(slotId, eventId, slot.name, slot.description, slot.startDatetime, slot.endDatetime, Number(slot.maxSpots));
        }
      }

      /* 4. The slot summary, last and inside the same transaction.
         Last because it reads the slots this block has just finished changing;
         inside because a reader that saw the new slots and the old summary
         would order the browse list by a value that no longer describes the
         event. An edit can move the earliest slot later, delete it outright, or
         introduce a new earliest one, so all three branches above reach here. */
      await refreshEventSummary(tx, eventId);
    });

    let notified = 0;
    if (changes.length > 0) {
      notified = await notifyConfirmedVolunteers(eventId, 'EVENT_UPDATED', { eventId: eventId, eventTitle: title, changes: changes });
    }

    res.json({ success: true, notified });
  } catch (error) {
    /* A validation failure raised from inside the transaction carries its own
       status. Without this it would roll back correctly and then be reported as
       a server fault, telling an organizer their edit broke the site when they
       had simply asked for something the event cannot be. */
    if (error?.httpStatus) {
      return res.status(error.httpStatus).json({
        error: error.field === 'audience' && error.code === 'organization_required'
          ? 'Only an event that belongs to an organization can be limited to its members.'
          : 'That is not a valid audience for an event.',
        field: error.field,
        ...(error.code ? { code: error.code } : {}),
      });
    }
    console.error('Update event details error:', error);
    res.status(500).json({ error: 'Internal server error editing event details' });
  }
});

// 11. Run Equalizer Hour Sorting (Organizer only)
router.post('/api/events/:id/auto-approve', authenticateToken, requireCapAny(['event.edit.own', 'organization.event.manage.own']), async (req, res) => {
  const eventId = req.params.id;

  try {
    const event = await db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!await canRunEvent(db, event, req.principal.userId, { hasModerate: can(req.principal, 'event.moderate') })) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Approve slot-by-slot: each slot has its own capacity, and within a slot
    // priority goes to students with the fewest credited hours (tie: earliest applied)
    const slots = await db.prepare('SELECT id, name, max_spots FROM slots WHERE event_id = ?').all(eventId);
    const approveStmt = await db.prepare("UPDATE applications SET status = 'accepted' WHERE id = ?");
    /* Credited hours, matching `creditedHoursFor` and the Auto Select draw.
       Without the events join this counts hours from CANCELLED events, which the
       student's own profile excludes — so the Equalizer ordered by a number
       nobody could see, and since it sorts lowest-hours-first, a student whose
       event was cancelled was pushed down the queue for it. */
    const hoursStmt = await db.prepare(`
      SELECT COALESCE(SUM(a.hours_awarded), 0) as total
      FROM attendance a
      JOIN events e ON e.id = a.event_id
      WHERE a.user_id = ? AND a.present = 1 AND e.status <> 'cancelled'
    `);

    let approvedCount = 0;
    for (const slot of slots) {
      const accepted = (await db.prepare(`
        SELECT COUNT(*) as count FROM applications WHERE slot_id = ? AND status = 'accepted'
      `).get(slot.id)).count;
      const remaining = slot.max_spots - accepted;
      if (remaining <= 0) continue;

      const pendingApps = await db.prepare(`
        SELECT id, user_id, applied_at FROM applications
        WHERE slot_id = ? AND status = 'pending'
      `).all(slot.id);
      if (pendingApps.length === 0) continue;

      /* Built with a loop rather than `.map`: the callback reads each
         applicant's hours from the database, so an arrow returning a promise
         would leave `enriched` an array of promises and the sort below would
         compare wrappers. */
      const enriched = [];
      for (const app of pendingApps) {
        const hoursRow = await hoursStmt.get(app.user_id);
        enriched.push({ ...app, totalHours: hoursRow && hoursRow.total ? Number(hoursRow.total) : 0.0 });
      }
      enriched.sort((a, b) => {
        if (a.totalHours !== b.totalHours) return a.totalHours - b.totalHours;
        return new Date(a.applied_at) - new Date(b.applied_at);
      });

      for (const app of enriched.slice(0, remaining)) {
        await approveStmt.run(app.id);
        approvedCount++;
        await notificationService.dispatch('APPLICATION_ACCEPTED', { eventId: event.id, eventTitle: event.title }, app.user_id);
      }
    }

    res.json({ success: true, approvedCount });
  } catch (error) {
    console.error('Equalizer error:', error);
    res.status(500).json({ error: 'Internal server error running equalizer' });
  }
});

// 12. Update Event Settings (Organizer only)
router.patch('/api/events/:id', authenticateToken, requireCapAny(['event.edit.own', 'organization.event.manage.own']), async (req, res) => {
  const eventId = req.params.id;
  const { autoApprove, attendeeVisibility } = req.body;

  try {
    const event = await db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!await canRunEvent(db, event, req.principal.userId, { hasModerate: can(req.principal, 'event.moderate') })) {
      return res.status(403).json({ error: 'Access denied: You do not host this event' });
    }
    if (event.status === 'completed') {
      return res.status(409).json({
        error: 'This event is complete and its settings can no longer be changed.',
        code: 'event_completed'
      });
    }

    if (autoApprove !== undefined) {
      await db.prepare('UPDATE events SET auto_approve = ? WHERE id = ?').run(autoApprove ? 1 : 0, eventId);
    }
    if (attendeeVisibility !== undefined) {
      await db.prepare('UPDATE events SET attendee_visibility = ? WHERE id = ?')
        .run(attendeeVisibility === 'private' ? 'private' : 'accepted', eventId);
    }

    const updated = await db.prepare('SELECT auto_approve, attendee_visibility FROM events WHERE id = ?').get(eventId);
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

router.delete('/api/events/:id', authenticateToken, requireCapAny(['event.moderate', 'event.edit.own', 'organization.event.manage.own']), async (req, res) => {
  const eventId = req.params.id;

  try {
    const event = await db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    // Allow Admin OR the organizer who hosted it to delete it
    if (!await canRunEvent(db, event, req.principal.userId, { hasModerate: can(req.principal, 'event.moderate') })) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // An event that produced service hours is part of a student's record, and a
    // record is not something a delete button gets to remove. Cancellation is
    // the way to call an event off; corrections go through attendance.
    const attendanceRows = await eventAttendanceCount(db, eventId);
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
    if (await eventHasLiveReport(db, eventId)) {
      return res.status(409).json({
        error: EVENT_HELD_MESSAGE,
        code: 'report_evidence_held'
      });
    }

    await runInTransaction(db, async (tx) => {
      // No `DELETE FROM attendance` here on purpose: the guard above means this
      // point is only reachable when the event has none, so the statement could
      // only ever be a no-op — and leaving a destructive statement in the file
      // invites someone to move the guard later.
      await tx.prepare('DELETE FROM attendance_checkin WHERE event_id = ?').run(eventId);
      await tx.prepare('DELETE FROM applications WHERE event_id = ?').run(eventId);
      await tx.prepare('DELETE FROM event_comments WHERE event_id = ?').run(eventId);
      await tx.prepare('DELETE FROM user_favorites WHERE event_id = ?').run(eventId);
      await tx.prepare('DELETE FROM event_announcements WHERE event_id = ?').run(eventId);
      await tx.prepare('DELETE FROM slots WHERE event_id = ?').run(eventId);
      await tx.prepare('DELETE FROM events WHERE id = ?').run(eventId);

      /**
       * The one index operation that cannot wait for the drain.
       *
       * `event_search_index` has a foreign key to `events`, so this DELETE
       * cascades the bookkeeping row away — and with it every trace of which
       * Pinecone record belonged to this event. A queued deletion would have
       * nothing left to find. Done here, while the id is still in hand.
       *
       * It never throws and its failure does not roll the deletion back: an
       * orphaned vector is a candidate that hydrates to nothing, which the
       * reconciler reports and `pinecone:reconcile --remove-orphans` clears.
       * A failed event deletion, by contrast, is a user-visible bug.
       */
      await removeEventFromIndex(eventId);

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
        await recordAudit(tx, {
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
router.patch('/api/events/:id/status', authenticateToken, requireCapAny(['event.moderate', 'event.edit.own', 'organization.event.manage.own']), async (req, res) => {
  const eventId = req.params.id;
  const { status } = req.body;

  if (!['open', 'closed', 'cancelled'].includes(status)) {
    return res.status(400).json({ error: 'Status must be open, closed, or cancelled' });
  }

  try {
    const event = await db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!await canRunEvent(db, event, req.principal.userId, { hasModerate: can(req.principal, 'event.moderate') })) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (event.status === 'completed') {
      return res.status(409).json({
        error: 'This event is complete. Its status can no longer be changed.',
        code: 'event_completed'
      });
    }

    await db.prepare('UPDATE events SET status = ? WHERE id = ?').run(status, eventId);

    /* Status is indexed metadata: it is how a search skips the years of
       completed history a district accumulates, and how a cancelled event stops
       being offered at all. `shouldIndex` turns the cancelled case into a
       deletion when the queue drains. */
    await markEventDirty(db, eventId);

    /**
     * The mirror of the award on creation.
     *
     * `events_created` counts events that are NOT cancelled, so cancelling one
     * can take an organizer back below a threshold — and `evaluateBadges`
     * withdraws an automatic award as readily as it grants one. Evaluating only
     * on the way up would leave the badge reporting a count that no longer
     * exists, which is the same asymmetry the attendance route fixed by
     * evaluating its `revoked` list as well as its `credited` one.
     *
     * The event's own organizer, not the actor: an administrator cancelling
     * somebody else's event changes THAT organizer's count, not their own.
     */
    await badgeService.evaluateBadges(event.organizer_id, {
      actorId: req.user.id,
      reason: `event ${status}`,
    });

    /**
     * And the volunteers, which this route never did.
     *
     * `collectStats` excludes cancelled events from a volunteer's hours and
     * event counts — that is settled and documented. Applying it only to the
     * organizer meant an attendee kept an hours badge the evaluator would no
     * longer award, until some unrelated action of their own triggered a
     * re-evaluation, which might be next week or never. Two students with
     * identical records could hold different badges depending on whether they
     * happened to volunteer again.
     *
     * The argument is the one already made ten lines up for the organizer:
     * "the criterion is the current count of non-cancelled events, so a badge
     * that only ever moves upwards is not reporting that count."
     *
     * Runs for EVERY status change, not only cancellations, because
     * `cancelled -> open` is a legal transition and a re-evaluation that only
     * ever removed would be the same one-directional fault mirrored.
     *
     * ── Who is affected, which is not just the people who turned up ──
     *
     * This selected `present = 1`, which is the right set for the hours and
     * events criteria — those are the people the event contributed a figure
     * for. It is the wrong set for RELIABILITY. `reliabilityOf`'s query runs
     * over ACCEPTED APPLICATIONS left-joined to attendance and excludes
     * cancelled events, so cancelling removes the commitment from the
     * denominator for everyone who was accepted — including somebody marked
     * absent, whose rate therefore RISES.
     *
     * So the set is the union: anyone with an attendance row at this event
     * whatever it says, and anyone holding an accepted application. Bounded by
     * who signed up rather than by the platform, and sequential, like the
     * attendance route's own loop over its revoked list.
     *
     * Decided during the 2026-09-21 audit (owner decision 5A); the union is the
     * post-implementation audit of it.
     */
    const affected = await db.prepare(`
      SELECT DISTINCT user_id FROM attendance WHERE event_id = ?
      UNION
      SELECT DISTINCT user_id FROM applications
       WHERE event_id = ? AND status = 'accepted'
    `).all(eventId, eventId);
    for (const row of affected) {
      if (row.user_id === event.organizer_id) continue; // already done, above
      await badgeService.evaluateBadges(row.user_id, {
        actorId: req.user.id,
        reason: `event ${status}`,
      });
    }

    /**
     * Calling off an event is the change confirmed volunteers most need to
     * hear about — they may have arranged a ride around it.
     *
     * ── It is NOT a mandatory notice, and that is a decision ──
     *
     * This comment used to say "the one change every confirmed volunteer MUST
     * hear about immediately", which read as a requirement the delivery model
     * does not meet: `EVENT_CANCELLED` is not in `MANDATORY_NOTICE_EVENTS`, so
     * a volunteer who has turned the Events category off, or opted out of
     * email, is not told. `CRITICAL` priority governs retention and display,
     * not delivery.
     *
     * Owner decision 4A of the 2026-09-21 audit left that as it is, on the
     * evidence rather than on inertia. The preference this notice answers to is
     * labelled "Event Updates & Reminders" and described to the reader as "When
     * an event you applied to changes, or to remind you of a shift"
     * (`NotificationPreferences.jsx`) — a cancellation is squarely inside the
     * words somebody is shown when they switch it off, and it defaults to on,
     * so silence is a choice that was accurately offered. The eleven members of
     * `MANDATORY_NOTICE_EVENTS` are a different class and say so in their own
     * comments: suspension, warnings, reinstatement, bans, appeal outcomes,
     * legal changes — notices about the person's own standing and rights, where
     * a preference would become a way to not be served notice.
     *
     * So the comment is corrected to describe what happens, rather than the
     * requirement being invented to match the comment.
     */
    let notified = 0;
    if (status === 'cancelled' && event.status !== 'cancelled') {
      /**
       * Two dispatches over disjoint sets, because two different things are
       * true of the recipients.
       *
       * Everybody accepted onto the event needs to know it is off. The people
       * whose CREDITED hours have just stopped counting need to know that too,
       * and they are not the same set in either direction:
       *
       *   · an accepted volunteer who never turned up has lost nothing, and
       *     `HOURS_ADJUSTED`'s guard already records why they must not be told
       *     their hours changed;
       *   · somebody credited who later withdrew their application is NOT in
       *     the accepted set at all, and their credited total is moving.
       *     Attendance is deliberately independent of application status, so
       *     the hours are theirs whatever the application says, and the old
       *     recipient query told them nothing.
       *
       * So the credited set is derived from `attendance`, the plain set is the
       * accepted applications minus it, and `getInAppContent` picks the body
       * from `hadCreditedHours`. Content is rendered once per fan-out, which is
       * why this is two calls rather than one with a per-recipient clause.
       *
       * The dedupe key is unchanged and shared, so the two sets cannot overlap
       * into a double send even if the queries ever did.
       *
       * Decided during the 2026-09-21 audit (owner decision 4B).
       */
      const creditedRows = await db.prepare(`
        SELECT DISTINCT user_id FROM attendance
         WHERE event_id = ? AND present = 1 AND hours_awarded > 0
      `).all(eventId);
      const credited = creditedRows.map(r => r.user_id);
      const creditedSet = new Set(credited);

      const acceptedRows = await db.prepare(`
        SELECT DISTINCT user_id FROM applications
         WHERE event_id = ? AND status = 'accepted'
      `).all(eventId);
      const plain = acceptedRows.map(r => r.user_id).filter(id => !creditedSet.has(id));

      const base = { eventId: event.id, eventTitle: event.title };
      const key = (userId) => `cancelled:${eventId}:${userId}`;
      const delivered = async (recipients, payload) => {
        if (recipients.length === 0) return 0;
        const outcomes = await notificationService.dispatchMany(
          'EVENT_CANCELLED', payload, recipients, key,
        );
        /* Only a genuine delivery counts, exactly as `notifyConfirmedVolunteers`
           has always counted it. */
        return [...outcomes.values()].filter(Boolean).length;
      };

      notified = await delivered(credited, { ...base, hadCreditedHours: true })
        + await delivered(plain, base);
    }

    res.json({ success: true, status, notified });
  } catch (error) {
    console.error('Toggle status error:', error);
    res.status(500).json({ error: 'Internal server error toggling event status' });
  }
});

// A6. Export Accepted Roster as CSV (Organizer only)

router.post('/api/events/:id/duplicate', authenticateToken, requireCapAny(['event.create', 'organization.event.manage.own']), async (req, res) => {
  try {
    const event = await db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!await canRunEvent(db, event, req.principal.userId, { hasModerate: can(req.principal, 'event.moderate') })) {
      return res.status(403).json({ error: 'Access denied' });
    }

    /**
     * ── Duplicating carries the organization and the audience ──
     *
     * It did not, and that was two defects wearing one omission.
     *
     * For an organizer it silently detached the copy: duplicate a members-only
     * NHS shift and you got a public event belonging to nobody, which is not
     * the event anybody asked for and is exactly the setting they had just
     * chosen against.
     *
     * For a Student Organizer it was an escalation. `POST /api/events` refuses
     * them an event with no organization behind it — that refusal is the whole
     * of what keeps the rank from being a promotion — and duplicate was a
     * second create path that had never learned the rule. Create one legitimate
     * club event, duplicate it, and the copy came out with `organization_id`
     * NULL: a platform-wide event hosted by a student, outside the club's
     * sight, with no ban check and no membership check, carrying every
     * organizer power the ownership check confers.
     *
     * So the copy keeps the parent's organization, and the same two questions
     * the create route asks are asked again about the copy. A caller who could
     * not have created this event cannot arrive at it by copying one.
     */
    if (!can(req.principal, 'event.create') && !event.organization_id) {
      return res.status(403).json({
        error: 'You can only create events for an organization you help run.',
        code: 'organization_required',
      });
    }
    /* An archived club is out of circulation, and duplicate is the third create
       path that had to learn it — create refuses one, joining refuses one, and
       this would have published a brand-new open event under a club that had
       been wound up. */
    if (event.organization_id) {
      const org = await db.prepare('SELECT status FROM organizations WHERE id = ?').get(event.organization_id);
      if (!org || org.status !== 'active') {
        return res.status(409).json({
          error: 'That organization is archived.', code: 'organization_archived',
        });
      }
    }
    if (event.organization_id && !await canHelpRun(db, event.organization_id, req.user.id, {
      hasModerate: can(req.principal, 'organization.moderate'),
    })) {
      return res.status(403).json({
        error: 'You do not help run that organization.',
        code: 'not_manager',
      });
    }

    // Create a new event with the same data but as 'open' status and shifted dates by default
    // We shift dates forward by 7 days; the organizer can edit afterwards.
    const newEventId = `event-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const shiftDays = 7;
    const shiftIso = (iso) => {
      const d = new Date(iso);
      d.setDate(d.getDate() + shiftDays);
      return d.toISOString();
    };
    await db.prepare(`
      INSERT INTO events (id, title, description, category, location, application_deadline, organizer_id, status, created_at, auto_approve,
                          organization_id, audience)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)
    `).run(
      newEventId,
      `${event.title} (Copy)`,
      event.description,
      event.category,
      event.location,
      shiftIso(event.application_deadline),
      req.user.id,
      new Date().toISOString(),
      event.auto_approve,
      event.organization_id || null,
      /* Belt and braces against the column drifting: an audience of
         `organization` on a copy with no organization would be a shift nobody
         can join, which is the state the create route refuses outright. */
      event.organization_id ? (event.audience || DEFAULT_AUDIENCE) : DEFAULT_AUDIENCE
    );

    // Clone slots
    const slots = await db.prepare('SELECT * FROM slots WHERE event_id = ?').all(event.id);
    for (const s of slots) {
      const newSlotId = `slot-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
      await db.prepare(`
        INSERT INTO slots (id, event_id, name, description, start_datetime, end_datetime, max_spots)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(newSlotId, newEventId, s.name, s.description,
        shiftIso(s.start_datetime), shiftIso(s.end_datetime), s.max_spots);
    }
    await refreshEventSummary(db, newEventId);

    /* The other way an event comes into existence, so the same re-evaluation.
       See the note on the create route above. */
    await badgeService.evaluateBadges(req.user.id);

    res.status(201).json({ success: true, id: newEventId });
  } catch (err) {
    console.error('Duplicate event error:', err);
    res.status(500).json({ error: 'Failed to duplicate event' });
  }
});

// 25. Quick stats (admin) — used to enrich the admin panel

router.get('/api/events/:id/auto-select/runs', authenticateToken, requireCapAny(['event.moderate', 'applicant.review', 'organization.event.manage.own']), async (req, res) => {
  const eventId = req.params.id;
  try {
    /* The whole row, not just `organizer_id`: `canRunEvent` also asks which
       organization the event belongs to, and a projection that omits it makes
       the function throw rather than quietly refuse the club's manager. */
    const event = await db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    if (!await canRunEvent(db, event, req.principal.userId, { hasModerate: can(req.principal, 'event.moderate') })) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const runs = await db.prepare(`
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
router.post('/api/events/:id/auto-select/run', authenticateToken, requireCapAny(['event.moderate', 'applicant.review', 'organization.event.manage.own']), async (req, res) => {
  const eventId = req.params.id;

  try {
    const event = await db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    if (!await canRunEvent(db, event, req.principal.userId, { hasModerate: can(req.principal, 'event.moderate') })) {
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
    const confirmedExists = (await db.prepare('SELECT COUNT(*) as count FROM auto_select_runs WHERE event_id = ? AND is_confirmed = 1').get(eventId)).count;
    if (confirmedExists > 0) {
      return res.status(400).json({ error: 'Selection has already been confirmed and locked for this event' });
    }

    // Determine the next run number
    const runCount = (await db.prepare('SELECT COUNT(*) as count FROM auto_select_runs WHERE event_id = ?').get(eventId)).count;

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
    const { selectedIds, waitlistIds } = await computeDraw(db, eventId, { runNumber: nextRunNumber });
    const { runId, createdAt: nowStr } = await recordRun(
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
router.post('/api/events/:id/auto-select/confirm', authenticateToken, requireCapAny(['event.moderate', 'applicant.review', 'organization.event.manage.own']), async (req, res) => {
  const eventId = req.params.id;

  try {
    const event = await db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    if (!await canRunEvent(db, event, req.principal.userId, { hasModerate: can(req.principal, 'event.moderate') })) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (event.status === 'completed') {
      return res.status(409).json({
        error: 'This event is complete. Selection can no longer be confirmed for it.',
        code: 'event_completed'
      });
    }

    // Fetch the latest run
    const latestRun = await db.prepare(`
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
    await applyRun(db, eventId, latestRun, { executedBy: 'organizer' });

    res.json({ success: true });
  } catch (err) {
    console.error('Confirm Auto Select error:', err);
    res.status(500).json({ error: 'Failed to confirm selection results' });
  }
});

// Broadcast email to confirmed roster
router.post('/api/events/:id/broadcast', authenticateToken, requireCapAny(['event.moderate', 'announcement.post', 'organization.event.manage.own']), async (req, res) => {
  const { id: eventId } = req.params;
  const { subject, message } = req.body;

  if (!subject || !message) {
    return res.status(400).json({ error: 'Subject and message are required' });
  }

  try {
    const event = await db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    
    if (!await canRunEvent(db, event, req.principal.userId, { hasModerate: can(req.principal, 'event.moderate') })) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const confirmedApps = await db.prepare(`
      SELECT DISTINCT u.id, u.email, u.email_opt_out 
      FROM applications a
      JOIN users u ON a.user_id = u.id
      WHERE a.event_id = ? 
        AND a.status = 'accepted'
    `).all(eventId);

    if (confirmedApps.length === 0) {
      return res.status(400).json({ error: 'No confirmed volunteers to email' });
    }

    const { notificationService } = await import('../services/notificationService.js');

    /**
     * `dispatch` is the whole broadcast. It used not to be.
     *
     * This loop also called `sendNotificationEmail` directly, alongside
     * `dispatch` — and `dispatch` already queues an email job of its own. So one
     * broadcast produced TWO emails per volunteer, from two different code paths
     * with two different rules:
     *
     *   - the direct send tested `email_opt_out === 0`, while dispatch tests
     *     `!== 1`, so a row with a NULL opt-out got one email from dispatch and
     *     none from here — the two halves disagreed about who had opted out;
     *   - only the queued half retried; the direct half had three in-process
     *     attempts and then vanished;
     *   - `Promise.allSettled` never rejects, so the `.catch` that followed it
     *     was dead code and no per-recipient failure was ever observed.
     *
     * Removing the direct send fixes the duplicate, puts every recipient under
     * one opt-out rule, and puts every message in the durable outbox.
     */
    for (const u of confirmedApps) {
      await notificationService.dispatch(
        'IMPORTANT_ANNOUNCEMENT',
        { eventId: event.id, eventTitle: event.title, body: message },
        u.id
      );
    }

    res.json({ success: true, count: confirmedApps.length });
  } catch (err) {
    console.error('Broadcast route error:', err);
    res.status(500).json({ error: 'Failed to broadcast message' });
  }
});



// 12. ICS Calendar Export (Authenticated)
// Allows volunteers to download ICS files for slots they've applied to.
router.get('/api/events/:eventId/slots/:slotId/ics', authenticateToken, async (req, res) => {
  const { eventId, slotId } = req.params;
  
  try {
    const event = await db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    const slot = await db.prepare('SELECT * FROM slots WHERE id = ? AND event_id = ?').get(slotId, eventId);
    
    if (!event || !slot) {
      return res.status(404).send('Event or slot not found');
    }

    /**
     * Serialisation lives in ../ics.js so it can be tested against RFC 5545
     * rather than against substrings of its own output. The version that was
     * inline here joined its lines with a literal `\r\n` TEXT sequence and
     * produced a one-line file no calendar application could parse.
     */
    /**
     * `?remind=<minutes>` adds a VALARM that many minutes before the shift.
     *
     * The volunteer chooses it, because they are the only one who knows whether
     * they walk, cycle, take a bus or get driven — a difference of a factor of
     * five that no distance we hold can resolve. Absent or unparseable means no
     * alarm, so a bookmarked URL without the parameter behaves as it always did.
     */
    const reminderMinutes = Number.parseInt(req.query.remind, 10);

    const icsContent = buildShiftIcs({
      /* The UID domain has to be one the platform controls: a calendar client
         uses it to match an update to the entry it already holds, and it is
         visible in the downloaded file. `MAIL_DOMAIN` rather than a literal so
         this and the client-side exporter in src/utils/helpers.js cannot drift
         apart — they mint UIDs for the same shifts. */
      uid: `${slot.id}@${MAIL_DOMAIN}`,
      start: slot.start_datetime,
      end: slot.end_datetime,
      summary: `${event.title} (${slot.name})`,
      // A blank line between the event blurb and the shift-specific note. The
      // escaping in buildShiftIcs turns these into the `\n` TEXT escape.
      description: `${event.description}\n\n${slot.description}`,
      /* The street address was being dropped, so a calendar entry said
         "Reichler Park" and left the volunteer to work out which one. */
      location: [event.location, event.address].filter(Boolean).join(', '),
      latitude: event.latitude,
      longitude: event.longitude,
      reminderMinutes: Number.isFinite(reminderMinutes) ? reminderMinutes : null,
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
