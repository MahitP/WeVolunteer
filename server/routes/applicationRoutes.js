import express from 'express';

import {
  authenticateToken,
  assignWaitlistOrder, promoteFromWaitlist, notifyPromotions
} from '../utils.js';
import { runInTransaction } from '../db/connectionContext.js';
import { forUpdate } from '../db/dialectSql.js';
import { can, requireCap, requireCapAny } from '../authz.js';
import { notificationService } from '../services/notificationService.js';
import { friendsToNotify } from '../relationships.js';
/* Signed-up / attended, batched, and defined identically to the profile's own
   figures — see the header on `participationCountsFor`. */
import { participationCountsFor } from '../volunteerStats.js';
import { eventApplicationEligibility } from '../eventEligibility.js';
import { OVERLAPS_SHIFT_SQL } from '../shiftOverlap.js';
import { db } from '../db.js';
import { canRunEvent } from '../organizations.js';
import { slotHasStarted } from '../attendance.js';
import { PENDING_APPLICATION_LIMIT } from '../config.js';
import { applicationLimiter } from '../applicationLimiter.js';
import { applicantDisclosure } from '../applicantDisclosure.js';

const router = express.Router();

/**
 * The most applications one response may carry, paginated or not.
 *
 * Mirrors `EVENTS_MAX_LIMIT` in eventRoutes.js, and exists for the same reason.
 * Until this cap, `GET /api/applications` had no `LIMIT` of any kind: an admin
 * holding `application.read_all` was served **every application in the system**
 * in a single response, and each row carries a volunteer's name, school, grade,
 * bio, skills and badge list. The deployment runbook already named this endpoint
 * as a reason not to size the host below 1 GB.
 *
 * 500 rows is chosen the way the events ceiling was: a realistic organizer's
 * queue for a school year is on the order of a few hundred, so a normal caller
 * completes in one request and pays no paging round trip, while a district-sized
 * dataset pages instead of returning without bound.
 */
export const APPLICATIONS_MAX_LIMIT = 500;

/**
 * Above this many rows, an unpaginated response is logged.
 *
 * Not a cap — the cap is above. This is the warning that makes the ceiling
 * visible *before* it truncates somebody's queue, which is the failure mode
 * worth catching: the organizer screen filters and sorts client-side, so a short
 * response does not error, it quietly shows a shorter list.
 */
const APPLICATIONS_WARN_THRESHOLD = 400;

/**
 * List applications, scoped to what the caller may see.
 *
 * Pagination is OPT-IN, exactly as on `GET /api/events`:
 *
 *   GET /api/applications                    -> Application[]              (legacy)
 *   GET /api/applications?limit=50           -> { applications, pagination }
 *   GET /api/applications?limit=50&offset=50 -> { applications, pagination }
 *
 * The bare array is kept because `src/utils/api.js` calls this with no
 * parameters and the SPA treats the result as a complete local index.
 *
 * ── The ORDER BY is new, and it is load-bearing ──
 *
 * This query had no `ORDER BY` at all, so row order was whatever the engine
 * happened to produce. That is survivable for a response that returns
 * everything and fatal for one that pages: without a total order, `OFFSET` can
 * show the same application twice and skip another entirely. `applied_at DESC`
 * is the order the organizer screen wants anyway (newest first), and `a.id`
 * breaks ties so the sequence is identical on both engines and between calls.
 */
router.get('/api/applications', authenticateToken, async (req, res) => {
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
      // Clamped rather than rejected, matching the events endpoint: a caller
      // asking for too much should get a valid page, not an error to handle.
      limit = Math.min(Math.floor(rawLimit), APPLICATIONS_MAX_LIMIT);
      offset = Math.floor(rawOffset);
    }

    let rows;
    const BASE_QUERY = `
      SELECT a.*, u.name, u.avatar, u.school, u.grade, u.bio, u.skills,
             u.profile_visibility, u.hours_visibility,
             e.title as event_title,
             s.name as slot_name, s.description as slot_description, s.start_datetime as slot_start_datetime, s.end_datetime as slot_end_datetime, s.max_spots as slot_max_spots,
             /* Evaluated across the whole filtered set, before LIMIT, so one
                statement answers both "this page" and "how many in total".
                A second COUNT query would double the work and could disagree
                with the page under concurrent writes. */
             COUNT(*) OVER () AS total_count
      FROM applications a
      JOIN users u ON a.user_id = u.id
      JOIN events e ON a.event_id = e.id
      JOIN slots s ON a.slot_id = s.id
    `;

    /* Appended to whichever scope branch is chosen below. The unpaginated form
       still carries a LIMIT — the cap — so no branch can return without bound. */
    const PAGE = paginated
      ? 'ORDER BY a.applied_at DESC, a.id ASC LIMIT ? OFFSET ?'
      : 'ORDER BY a.applied_at DESC, a.id ASC LIMIT ?';
    const pageParams = paginated ? [limit, offset] : [APPLICATIONS_MAX_LIMIT];

    /**
     * The rows somebody who RUNS events may see: their own events, plus the
     * events of any organization they manage.
     *
     * The second half is what `canRunEvent` authorizes on the write paths, and
     * this list is what feeds the screen those writes are made from. Scoped in
     * SQL rather than filtered afterwards, so a club with four hundred
     * applications does not load them all to discard most.
     *
     * ── Why hosting is not enough on its own ──
     *
     * It mirrors `stillWelcomeIn` in `canRunEvent`, and it has to. Without it
     * this list reopened exactly what that function closed: an organizer removed
     * or banned from a club was refused `GET /api/events/:id` and
     * `roster.csv` — and kept listing every application to the club's events
     * here, names, schools, grades, bios and all. The reads have to agree with
     * the writes or the tighter one is decoration.
     */
    const ORGANIZATION_SCOPE = `
      WHERE (
              e.organizer_id = ?
              AND (
                e.organization_id IS NULL
                OR (
                  EXISTS (SELECT 1 FROM organization_members m
                           WHERE m.organization_id = e.organization_id AND m.user_id = ?)
                  AND NOT EXISTS (SELECT 1 FROM organization_bans b
                                   WHERE b.organization_id = e.organization_id
                                     AND b.user_id = ? AND b.lifted_at IS NULL)
                )
              )
            )
         OR e.organization_id IN (
              SELECT organization_id FROM organization_members
               WHERE user_id = ? AND member_role = 'manager'
            )
    `;

    // Result scoping, not a gate — every authenticated role reaches this route;
    // the capability only chooses which rows come back.
    //
    // Ordered most-privileged-first, and deliberately: `can()` treats a
    // super_admin principal as satisfying EVERY capability (the '*' wildcard
    // in authz.js), so a wildcard principal always matches whichever branch
    // is tested first. Testing `application.withdraw`
    // (student) before the broader checks let super_admin fall into the
    // "own rows" branch and see an all-but-empty result — a real content bug
    // a status-code-only test could never catch. Broadest access is checked
    // first here so the wildcard resolves to the same (correct) branch an
    // admin would.
    //
    // `application.read_all` is admin-only among named roles (organizer/student/partner
    // do not hold it) and reads as "platform-wide oversight", which is what
    // seeing every application unscoped actually is — so it, not an `else`,
    // is the unscoped branch's gate. The cascade ends in an explicit empty
    // result, not a bare unscoped `else`: "no recognised capability" must
    // default to seeing nothing, never to seeing everything.
    if (can(req.principal, 'application.read_all')) {
      // admin, and super_admin via the wildcard: every application.
      rows = await db.prepare(`${BASE_QUERY} ${PAGE}`).all(...pageParams);
    } else if (can(req.principal, 'applicant.review')) {
      // organizer: applications to the events they host.
      rows = await db.prepare(`${BASE_QUERY} ${ORGANIZATION_SCOPE} ${PAGE}`)
        .all(req.principal.userId, req.principal.userId, req.principal.userId, req.principal.userId, ...pageParams);
    } else if (can(req.principal, 'organization.event.manage.own')) {
      /**
       * A Student Organizer, or a student who manages a club.
       *
       * They hold neither `application.read_all` nor `applicant.review`, so
       * without this branch they fell through to "your own applications" and
       * could not list the applicants to the events they run at all — they could
       * accept and reject through `PATCH /api/applications/:id`, blind, from a
       * list that did not include the rows.
       *
       * Scoped by the same rule `canRunEvent` applies: events they host, plus
       * events belonging to a club they manage.
       */
      rows = await db.prepare(`${BASE_QUERY} ${ORGANIZATION_SCOPE} ${PAGE}`)
        .all(req.principal.userId, req.principal.userId, req.principal.userId, req.principal.userId, ...pageParams);
    } else if (can(req.principal, 'application.withdraw')) {
      // student: their own applications only.
      rows = await db.prepare(`${BASE_QUERY} WHERE a.user_id = ? ${PAGE}`)
        .all(req.principal.userId, ...pageParams);
    } else {
      // No recognised capability (e.g. partner, deliberate correction v1.2a):
      // deny by default rather than falling through to unscoped access. Partner
      // previously fell into the unscoped branch and could read every
      // application in the system — a data leak, not behaviour worth keeping.
      rows = [];
    }

    /**
     * Everything below is scoped to the rows actually being returned.
     *
     * The three loads here used to read the WHOLE of `attendance` (twice) and
     * the whole of `application_conflicts`, regardless of who was asking or how
     * many rows came back — so a student fetching their own four applications
     * pulled a district's entire attendance history into two `Map`s to answer
     * it. The same correction `eventRoutes.js` already applied to its own batch
     * loads, and for the same reason: a page should cost the page.
     */
    const pageUserIds = [...new Set(rows.map(r => r.user_id))];
    const pageSlotIds = [...new Set(rows.map(r => r.slot_id))];
    const pageAppIds = rows.map(r => r.id);
    const marks = (ids) => ids.map(() => '?').join(',');

    // Batch the volunteer history lookups once instead of three queries per
    // row — organizers sort and filter on these, so they load on every view.
    const historyByUser = new Map();
    if (pageUserIds.length > 0) {
      for (const h of await db.prepare(`
        SELECT a.user_id,
               COALESCE(SUM(a.hours_awarded), 0) as total_hours,
               COUNT(DISTINCT a.event_id) as completed_events,
               MAX(s.end_datetime) as last_end
        FROM attendance a
        JOIN slots s ON a.slot_id = s.id
        WHERE a.present = 1 AND a.user_id IN (${marks(pageUserIds)})
        GROUP BY a.user_id
      `).all(...pageUserIds)) {
        historyByUser.set(h.user_id, h);
      }
    }

    /**
     * Attendance for the page's (slot, user) pairs.
     *
     * Filtered on both columns rather than on the pair itself: a row is only
     * ever read back through the `slot_id:user_id` key below, so the extra
     * cross-product rows a two-column filter can admit are simply never looked
     * up. Both columns are indexed (`idx_attendance_user`, `attendance(slot_id)`
     * via its uniqueness constraint), which a row-value `IN` would not use.
     */
    const attendanceByKey = new Map();
    if (pageSlotIds.length > 0 && pageUserIds.length > 0) {
      const attRows = await db.prepare(`
        SELECT slot_id, user_id, present, hours_awarded FROM attendance
        WHERE slot_id IN (${marks(pageSlotIds)}) AND user_id IN (${marks(pageUserIds)})
      `).all(...pageSlotIds, ...pageUserIds);
      for (const a of attRows) {
        attendanceByKey.set(`${a.slot_id}:${a.user_id}`, a);
      }
    }

    /**
     * Follow-through, at a glance, for every applicant on the page.
     *
     * An organizer deciding who gets a place wants one thing this list did not
     * carry: does this person turn up? `completedEvents` above is only half of
     * it — it counts the events somebody attended and says nothing about how
     * many they committed to, so a volunteer with four completed events looks
     * identical whether they signed up for four or fourteen.
     *
     * Two queries for the whole page rather than six per row. The definitions
     * are the SAME ones the student sees on their own profile, which matters
     * more than the performance: a figure used to decide who gets a place has
     * to be a figure the person it describes can look at.
     *
     * Deliberately NOT a percentage. "1 of 2 — 50%" reads as a verdict on a
     * person when the evidence behind it is one missed shift, and a reader
     * cannot un-see the number. The same argument the profile counts are built
     * on; see the note in volunteerStats.js.
     */
    const participation = await participationCountsFor(db, rows.map(r => r.user_id));

    const conflictsByAppId = new Set();
    if (pageAppIds.length > 0) {
      for (const c of await db.prepare(
        `SELECT application_id FROM application_conflicts WHERE application_id IN (${marks(pageAppIds)})`
      ).all(...pageAppIds)) {
        conflictsByAppId.add(c.application_id);
      }
    }

    /**
     * Conferred badges, for the handful the organizer view actually shows.
     *
     * One query for the page, in keeping with the two above — a per-row read
     * would be twenty round trips to render three chips. `UNIQUE(user_id,
     * badge_id)` makes this a covering index search on `user_id`, so no index
     * was added for it; `EXPLAIN QUERY PLAN` confirms `SEARCH ub USING COVERING
     * INDEX ... (user_id=?)`.
     *
     * Everything sent here is already public on the volunteer's profile. The
     * client decides WHICH of them to show — `organizerBadges` in
     * `src/utils/badgeOrder.js` keeps it to the status badge and the top of each
     * progression, because a row of nine hour tiers buries the two badges an
     * organizer is actually reading for.
     *
     * `active = 1` only. A retired definition stays in `user_badges` on purpose
     * (nobody's record is edited when the catalogue changes) but it should not
     * be presented as current standing.
     */
    const badgesByUser = new Map();
    if (rows.length > 0) {
      const userIds = [...new Set(rows.map(r => r.user_id))];
      const placeholders = userIds.map(() => '?').join(',');
      const badgeRows = await db.prepare(`
        SELECT ub.user_id, b.name, b.icon, b.category, b.criteria_type, b.criteria_value, ub.earned_at
        FROM user_badges ub
        JOIN badges b ON b.id = ub.badge_id
        WHERE ub.user_id IN (${placeholders}) AND b.active = 1
      `).all(...userIds);

      for (const b of badgeRows) {
        if (!badgesByUser.has(b.user_id)) badgesByUser.set(b.user_id, []);
        badgesByUser.get(b.user_id).push({
          name: b.name,
          icon: b.icon,
          category: b.category,
          criteria_type: b.criteria_type,
          criteria_value: b.criteria_value,
          earnedAt: b.earned_at,
        });
      }
    }

    /**
     * What each applicant discloses to THIS reader.
     *
     * The capability cascade above decides which rows come back; it says
     * nothing about what is on them. A Student Organizer and an adult organizer
     * reach this list through the same organization scope and accepted
     * different agreements about it — see applicantDisclosure.js.
     */
    const disclosure = await applicantDisclosure(db, req.principal, rows.map(r => ({
      id: r.user_id,
      profile_visibility: r.profile_visibility,
      hours_visibility: r.hours_visibility,
    })));

    const formattedApps = rows.map(r => {
      const shown = disclosure.get(r.user_id);
      const history = historyByUser.get(r.user_id);
      const totalHours = history ? Number(history.total_hours) : 0.0;
      const completedEvents = history ? history.completed_events : 0;
      const lastVolunteeredDate = history && history.last_end ? history.last_end : null;

      const start = new Date(r.slot_start_datetime);
      const end = new Date(r.slot_end_datetime);
      const slotHours = Math.max(0.1, Number(((end - start) / (1000 * 60 * 60)).toFixed(2)));

      // Attendance for this specific application, if it's been recorded
      const attRow = attendanceByKey.get(`${r.slot_id}:${r.user_id}`);
      const attendance = attRow
        ? { present: attRow.present === 1, hoursAwarded: Number(attRow.hours_awarded) }
        : null;

      return {
        id: r.id,
        eventId: r.event_id,
        slotId: r.slot_id,
        userId: r.user_id,
        status: r.status,
        appliedAt: r.applied_at,
        waitlistOrder: r.waitlist_order,
        event: {
          title: r.event_title,
          startDatetime: r.slot_start_datetime,
          endDatetime: r.slot_end_datetime,
          hoursAwarded: slotHours
        },
        slot: {
          id: r.slot_id,
          name: r.slot_name,
          description: r.slot_description,
          startDatetime: r.slot_start_datetime,
          endDatetime: r.slot_end_datetime,
          maxSpots: Number(r.slot_max_spots),
          hours: slotHours
        },
        volunteer: {
          id: r.user_id,
          name: r.name,
          avatar: r.avatar,
          /* Bio, school, grade and skills follow the applicant's profile
             setting for a reader who is not an adult organizer — OMITTED, as the
             profile omits them, rather than nulled into "not on file". Skills
             joined on 2026-10-04, when they left the directory baseline. */
          ...(shown.particulars ? {
            school: r.school, grade: r.grade, bio: r.bio,
            skills: r.skills ? JSON.parse(r.skills) : [],
          } : {}),
          /* The service record follows `hours_visibility` the same way. Omitted
             rather than zeroed: a zero is a claim, and here a false one. */
          ...(shown.hours === 'visible' ? {
            volunteeredHours: totalHours,
            completedEvents,
            lastVolunteeredDate,
            /* Counts, never a rate — see `participationCountsFor`. `signedUp`
               counts commitments whose shift has ENDED, so an upcoming shift is
               not held against somebody who has not had the chance to attend it
               yet.

               `eventsAbsent` was computed and then dropped here, which left the
               organizer unable to tell "8 of 9, one missed" from "8 of 9, one the
               organizer never got round to confirming". Those are a fact about
               the volunteer and a fact about the paperwork, and reading the
               second as the first is the specific unfairness this whole set of
               definitions exists to prevent. `eventsAwaitingRecord` is the
               remainder, published alongside so the gap is legible rather than
               assumed. */
            eventsSignedUp: participation.get(r.user_id)?.signedUp ?? 0,
            eventsAttended: participation.get(r.user_id)?.attended ?? 0,
            eventsAbsent: participation.get(r.user_id)?.absent ?? 0,
            eventsAwaitingRecord: Math.max(
              0,
              (participation.get(r.user_id)?.signedUp ?? 0)
              - (participation.get(r.user_id)?.attended ?? 0)
              - (participation.get(r.user_id)?.absent ?? 0),
            ),
          } : {}),
          /* The setting is disclosed; the figures behind it are not. Without it
             the row cannot tell a volunteer who keeps their record private from
             a first-timer, and would call them one. Same shape as the
             profile's `serviceVisibility`, which the client already reads. */
          serviceVisibility: { hours: shown.hours },
          badges: badgesByUser.get(r.user_id) ?? [],
        },
        attendance,
        hasConflict: conflictsByAppId.has(r.id)
      };
    });

    /**
     * Zero rows carries no window value, so an empty page reports a zero total.
     *
     * Correct rather than a special case, and the same reasoning `GET /api/events`
     * records: the window function is computed per returned row, so with no rows
     * there is nothing to read it from — and a scope matching nothing genuinely
     * has a total of nothing.
     */
    const total = rows.length ? Number(rows[0].total_count) : 0;

    if (!paginated && total > APPLICATIONS_WARN_THRESHOLD) {
      console.warn(
        `[applications] Serialised ${Math.min(total, APPLICATIONS_MAX_LIMIT)} of ${total} applications `
        + `unpaginated for user ${req.user.id}. `
        + `Each row carries a volunteer's name, school, grade, bio and badges; `
        + `migrate the caller to ?limit=&offset=.`
      );
    }

    // Says out loud when the cap actually removed rows, so a caller silently
    // seeing a truncated queue is visible in the log rather than a mystery.
    if (!paginated && total > APPLICATIONS_MAX_LIMIT) {
      console.warn(
        `[applications] TRUNCATED: ${total} applications matched but an unpaginated request is `
        + `capped at ${APPLICATIONS_MAX_LIMIT}. The caller is missing ${total - APPLICATIONS_MAX_LIMIT} `
        + `row(s) and must use ?limit=&offset=.`
      );
    }

    if (!paginated) return res.json(formattedApps);

    res.json({
      applications: formattedApps,
      pagination: {
        total,
        limit,
        offset,
        returned: formattedApps.length,
        hasMore: offset + formattedApps.length < total,
        // Null at the end of the list, so a caller can loop until it is null
        // rather than doing the arithmetic itself.
        nextOffset: offset + formattedApps.length < total ? offset + formattedApps.length : null,
        maxLimit: APPLICATIONS_MAX_LIMIT
      }
    });
  } catch (error) {
    console.error('Fetch applications error:', error);
    res.status(500).json({ error: 'Internal server error fetching applications' });
  }
});

// 7. Apply to an Event Slot (Student only)
router.post('/api/events/:id/apply', authenticateToken, requireCap('event.apply'), applicationLimiter, async (req, res) => {
  const eventId = req.params.id;
  const { slotId } = req.body;

  /**
   * A slot id is a string, and anything else is a malformed request.
   *
   * `!slotId` alone let `true`, `{a:{b:1}}` and `['slot-1']` through to the
   * lookup below, where node:sqlite refuses to bind them — a boolean raises
   * "Provided value cannot be bound to SQLite parameter 1", and any non-null
   * object is read as a bag of NAMED parameters, so `{a:…}` raises "Unknown
   * named parameter 'a'". Both landed in the catch and answered 500, which
   * says the server is broken when the request was.
   *
   * Same rule and same reason as the non-string report `targetId` in
   * reportService.js; `routes.malformed.test.js` is where that class of defect
   * is asserted, and this one is asserted there too.
   */
  if (typeof slotId !== 'string' || slotId.trim() === '') {
    return res.status(400).json({ error: 'Required slotId missing' });
  }

  try {
    const event = await db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (event.status !== 'open') return res.status(400).json({ error: 'Event registrations are closed' });

    /**
     * May this person take part at all — banned, not a member, or it is their
     * own event.
     *
     * ── Why it is here, before everything else ──
     *
     * This is the only production path that creates an application, and both
     * branches below run through it: the INSERT for a first application and the
     * UPDATE that revives a withdrawn one. So one check covers both, and every
     * downstream state — waitlisted, promoted, accepted by a draw — is covered
     * too, because none of them can happen to somebody who never got a row.
     *
     * Placed above the deadline and conflict checks deliberately. Eligibility
     * precedes them: telling a banned person that they have a schedule clash,
     * or that the deadline passed, answers a question they were never allowed to
     * ask and tells them something about the event's state they should not
     * learn from a refusal.
     *
     * Nothing here is taken from the request. The organization comes from the
     * event row, so a client cannot nominate the organization it would like to
     * be measured against.
     */
    const eligibility = await eventApplicationEligibility(event, req.user.id);
    if (!eligibility.ok) {
      return res.status(eligibility.status).json({
        error: eligibility.error,
        code: eligibility.code,
        ...(eligibility.reason ? { reason: eligibility.reason } : {}),
      });
    }

    // Verify slot belongs to event
    const slot = await db.prepare('SELECT * FROM slots WHERE id = ? AND event_id = ?').get(slotId, eventId);
    if (!slot) return res.status(404).json({ error: 'Selected slot does not belong to this event' });

    // Enforce deadline check
    const now = new Date();
    if (now > new Date(event.application_deadline)) {
      return res.status(400).json({ error: 'Application deadline has passed. Sign-ups are closed.' });
    }

    // Schedule Conflict Detection
    // Check if the user has any pending, accepted, or waitlisted slots that overlap
    // with this slot's time.
    /* `OVERLAPS_SHIFT_SQL` rather than the predicate written out here, so that
       where a clash begins and ends is defined once. This warning and the two
       automatic paths — the Auto Select draw and waitlist promotion — must agree
       about the same pair of times, because a student who is told two shifts are
       back-to-back and is then passed over by a draw for clashing has been given
       two different answers. The statuses stay wider here on purpose: this is
       advice to a human who may override it, not a refusal. */
    const overlap = await db.prepare(`
      SELECT a.id as app_id, a.status, e.title, s.name as slot_name, s.start_datetime, s.end_datetime
      FROM applications a
      JOIN slots s ON a.slot_id = s.id
      JOIN events e ON a.event_id = e.id
      WHERE a.user_id = ?
        AND a.status IN ('pending', 'accepted', 'waitlisted')
        AND a.slot_id != ?
        AND ${OVERLAPS_SHIFT_SQL}
      LIMIT 1
    `).get(req.user.id, slotId, slot.end_datetime, slot.start_datetime);

    if (overlap && !req.body.overrideConflict) {
      return res.status(409).json({ 
        error: 'Schedule conflict detected', 
        details: `You already have a volunteer commitment during this time: ${overlap.title} (${overlap.slot_name}).`,
        conflict: {
          level: overlap.status === 'accepted' ? 2 : 1,
          existingAppId: overlap.app_id,
          title: overlap.title,
          slotName: overlap.slot_name,
          start: overlap.start_datetime,
          end: overlap.end_datetime,
          status: overlap.status
        }
      });
    }

    // A withdrawn application is not a live one. Withdrawing by mistake should
    // cost the student nothing while applications are still open, so the old
    // row is revived rather than blocking — UNIQUE(user_id, slot_id) means a
    // second INSERT is not an option.
    const existing = await db.prepare(
      'SELECT id, status FROM applications WHERE slot_id = ? AND user_id = ?'
    ).get(slotId, req.user.id);

    /**
     * How many opportunities this student already has outstanding.
     *
     * ── Placement ──
     *
     * Below the deadline and conflict checks, and below the `existing` lookup,
     * both deliberately. A student re-applying to a slot they already hold gets
     * "you have already applied", not a quota refusal — they are not adding
     * anything. And if the deadline has passed or the shift clashes, that is the
     * real reason and the one to give; a quota message would send them to
     * withdraw something for no benefit.
     *
     * ── Counting ──
     *
     * DISTINCT event, excluding THIS event, so extra shifts of an opportunity
     * already applied to are free — the unit is the opportunity, not the row.
     * Excluding this event also makes the comparison correct in both directions:
     * after this application the student holds `n + 1` distinct events either
     * way, so `n >= limit` is the refusal in both the first-shift and the
     * second-shift case.
     *
     * Cancelled events are left out. A pending application on a cancelled event
     * cannot be made to resolve by the person holding it, and they did not cause
     * it; charging it against their quota is a penalty for somebody else's
     * decision.
     *
     * Only `pending`. `accepted` is a commitment rather than an outstanding
     * request, and counting it would freeze out a student for succeeding.
     * `waitlisted` is done TO an applicant by a draw and can be promoted without
     * them acting, so counting it would let other people's decisions lock
     * somebody out.
     */
    if (!existing || existing.status === 'withdrawn') {
      const outstanding = await db.prepare(`
        SELECT COUNT(DISTINCT a.event_id) AS n
        FROM applications a
        JOIN events e ON e.id = a.event_id
        WHERE a.user_id = ?
          AND a.status = 'pending'
          AND a.event_id != ?
          AND e.status <> 'cancelled'
      `).get(req.user.id, eventId);

      const pending = outstanding?.n ?? 0;
      if (pending >= PENDING_APPLICATION_LIMIT) {
        /**
         * 409 rather than 429.
         *
         * 429 would say "come back later", and later changes nothing — the
         * budget is not a window that refills. What clears it is withdrawing
         * something, so the status has to be the one that means "this conflicts
         * with the state you are in" and the message has to name the action.
         */
        return res.status(409).json({
          error:
            `You already have ${pending} opportunities waiting for a decision, which is the `
            + `limit of ${PENDING_APPLICATION_LIMIT}. Withdraw one you no longer want, or wait `
            + 'for an organizer to decide, and then apply to this one.',
          code: 'application_limit_reached',
          limit: PENDING_APPLICATION_LIMIT,
          pending,
        });
      }
    }

    const status = 'pending';
    const appliedAt = new Date().toISOString();
    let appId;

    if (existing && existing.status !== 'withdrawn') {
      return res.status(400).json({ error: 'You have already applied for this time slot' });
    } else if (existing) {
      appId = existing.id;
      await db.prepare('UPDATE applications SET status = ?, applied_at = ?, waitlist_order = NULL WHERE id = ?')
        .run(status, appliedAt, appId);
    } else {
      appId = `app-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await db.prepare(`
        INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(appId, req.user.id, eventId, slotId, status, appliedAt);
    }

    if (overlap && req.body.overrideConflict) {
      const conflictId = `conf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await db.prepare(`
        INSERT INTO application_conflicts (id, application_id, conflicting_application_id, conflict_type, acknowledged_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(conflictId, appId, overlap.app_id, overlap.status, appliedAt, appliedAt);

      await notificationService.dispatch('SCHEDULE_CONFLICT_WARNING', { eventId: event.id, eventTitle: event.title }, req.user.id);
    }

    // Notify organizer
    await notificationService.dispatch('NEW_APPLICATION', { eventId: event.id, eventTitle: event.title }, event.organizer_id);

    /**
     * Tell this volunteer's friends, if this volunteer allows it.
     *
     * The privacy decision is made entirely inside `friendsToNotify`, which
     * returns an empty list unless the signer-up has `friend_activity_visible`
     * on AND the friendship is accepted on both sides AND the recipient has not
     * muted them AND neither has restricted or blocked the other. The list is
     * built before any row exists, so a notification that should not be sent is
     * never written — there is nothing for a later endpoint to leak by
     * forgetting to re-filter, and nothing for an audit to find.
     *
     * Dedupe key is per (friend, event), NOT per application. A volunteer who
     * signs up for three shifts of the same festival is one piece of news, and
     * three identical bell entries is how a useful feature becomes one people
     * turn off.
     *
     * Wrapped in its own try/catch and placed after every write: a signup must
     * never fail because a notification could not be created.
     */
    try {
      /**
       * An organizer who set the roster private gets to mean it.
       *
       * `attendee_visibility: 'private'` already refuses the roster even to an
       * accepted co-attendee (contentRoutes.js). Telling this volunteer's
       * friends "X signed up for <title>" would disclose exactly the
       * participation that setting exists to withhold, to people who are not on
       * the event at all — so the fan-out is skipped entirely for such events.
       * The organizer's control and the volunteer's control are both honoured;
       * either one alone empties the list.
       */
      const rosterPublic = (event.attendee_visibility || 'accepted') === 'accepted';
      const recipients = rosterPublic ? await friendsToNotify(db, req.user.id) : [];
      if (recipients.length > 0) {
        const actor = await db.prepare('SELECT name, username FROM users WHERE id = ?').get(req.user.id);
        const payload = {
          actorName: actor?.name, actorUsername: actor?.username,
          eventId: event.id, eventTitle: event.title,
        };
        await notificationService.dispatchMany(
          'FRIEND_SIGNED_UP', payload, recipients,
          () => `friend-signup:${req.user.id}:${event.id}`
        );
      }
    } catch (err) {
      console.error('Friend signup fan-out failed:', err);
    }

    res.status(201).json({
      success: true,
      application: { id: appId, eventId, slotId, userId: req.user.id, status, appliedAt }
    });
  } catch (error) {
    /**
     * A lost race on `UNIQUE(user_id, slot_id)` is the client's answer, not ours.
     *
     * The duplicate check above reads, and then the insert writes, with awaits in
     * between. On PostgreSQL every statement is a promise, so two taps on the
     * same button interleave inside one process: one INSERT wins and the other
     * violates the constraint. `instanceLock.js` predicts exactly this shape for
     * handlers that read-then-write without `FOR UPDATE`, and this is one.
     *
     * The constraint is doing its job — no duplicate row is created — so the
     * outcome is correct and only the status was wrong. Reporting 500 told the
     * student the server was broken when what happened is that they already have
     * this shift, which is the same thing the check above says with a 400.
     *
     * Detected by constraint name rather than by pre-checking again, because a
     * second read would race the same way.
     */
    const violation = String(error?.code ?? '') === '23505'
      || /UNIQUE constraint failed: applications\.(user_id|slot_id)/i.test(String(error?.message ?? ''));
    if (violation) {
      return res.status(400).json({ error: 'You have already applied for this time slot' });
    }

    console.error('Apply error:', error);
    res.status(500).json({ error: 'Internal server error applying to event' });
  }
});

// 8a. Bulk update application status (hosting organizer, or admin-tier oversight).
//
// Registered BEFORE /api/applications/:id, because that route's :id parameter
// would otherwise capture the literal "bulk". Mirrors the single-application
// organizer branch below exactly — same allowed statuses, same ownership and
// capacity rules — so the two cannot diverge. All writes happen in one
// transaction; notifications and waitlist promotion run only after it commits,
// because createNotification performs its own writes.
router.patch('/api/applications/bulk', authenticateToken, requireCapAny(['applicant.review', 'event.moderate', 'organization.event.manage.own']), async (req, res) => {
  const { applicationIds, status } = req.body;

  if (!Array.isArray(applicationIds) || applicationIds.length === 0) {
    return res.status(400).json({ error: 'applicationIds must be a non-empty array' });
  }
  if (!['accepted', 'waitlisted', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status update. Must be accepted, waitlisted, or rejected.' });
  }

  try {
    // Load every named application with its event owner. A missing id, or one on
    // an event this organizer does not host, fails the whole request rather than
    // applying part of it — a half-done bulk action is worse than a refused one.
    const apps = [];
    for (const id of applicationIds) {
      const app = await db.prepare(`
        SELECT a.*, e.organizer_id, e.organization_id, e.title as event_title, e.auto_approve
        FROM applications a
        JOIN events e ON a.event_id = e.id
        WHERE a.id = ?
      `).get(id);
      if (!app) return res.status(404).json({ error: `Application not found: ${id}` });
      if (!await canRunEvent(db, app, req.principal.userId, { hasModerate: can(req.principal, 'event.moderate') })) {
        return res.status(403).json({ error: 'Access denied: You do not host this event' });
      }
      // A withdrawn application is the volunteer's own choice to leave; an
      // organizer cannot pull them back in. Refuse the whole batch rather than
      // silently reactivating them as a side effect of a bulk action.
      if (app.status === 'withdrawn') {
        return res.status(409).json({
          error: 'One or more of these volunteers withdrew their application. Only they can re-apply.',
          code: 'withdrawn'
        });
      }
      apps.push(app);
    }

    // When accepting, capacity is counted per slot across the whole batch so the
    // combined effect can never overfill a slot — the single route only guards
    // one at a time. Applications beyond a slot's remaining spots are skipped and
    // reported, never accepted over capacity.
    const applied = [];
    const skipped = [];
    const remainingBySlot = {};

    const promotions = [];
    const freedSlots = new Set();
    /* One clock for the whole batch, so a long transaction cannot let two
       applications on the same slot disagree about whether it had started. */
    const removalClock = new Date();
    await runInTransaction(db, async (tx) => {
      /**
       * Capacity is counted INSIDE the transaction, behind a row lock per slot.
       *
       * It used to be counted just above, before the transaction opened. That was
       * safe for exactly as long as `instanceLock.js` says it was: one process,
       * `node:sqlite` synchronous, and a handler that never awaited between the
       * read and the write. PostgreSQL removes that premise — every statement is
       * a promise now — so the interleaving stopped needing a second instance to
       * happen. Three concurrent bulk calls on a two-spot slot each read
       * "2 remaining" and each accepted 2: six volunteers into two places, three
       * 200s, and nothing anywhere said the roster was overfull.
       *
       * Slots are locked in a deterministic order — sorted by id — rather than in
       * whatever order the applications arrived. Two batches spanning the same two
       * slots in opposite orders would otherwise be able to take the locks
       * head-on and deadlock; a total order on acquisition removes that outright.
       */
      if (status === 'accepted') {
        const slotIds = [...new Set(apps.map(a => a.slot_id))].sort();
        for (const slotId of slotIds) {
          const slot = await tx.prepare(
            `SELECT max_spots FROM slots WHERE id = ?${forUpdate(db)}`
          ).get(slotId);
          const slotMaxSpots = slot ? slot.max_spots : 0;
          const slotAccepted = Number((await tx.prepare(`
            SELECT COUNT(*) as count FROM applications
            WHERE slot_id = ? AND status = 'accepted'
          `).get(slotId)).count);
          remainingBySlot[slotId] = Math.max(0, slotMaxSpots - slotAccepted);
        }
      }

      const update = await tx.prepare('UPDATE applications SET status = ? WHERE id = ?');
      for (const app of apps) {
        if (app.status === 'accepted' && status === 'accepted') {
          // Already accepted — a no-op that must not consume a fresh spot.
          skipped.push({ id: app.id, reason: 'already_accepted' });
          continue;
        }
        if (status === 'accepted') {
          if (remainingBySlot[app.slot_id] <= 0) {
            skipped.push({ id: app.id, reason: 'slot_full' });
            continue;
          }
          remainingBySlot[app.slot_id] -= 1;
        }

        const wasAccepted = app.status === 'accepted';

        /**
         * Removing somebody from a shift that has already started is refused
         * here too, and skipped rather than failing the batch.
         *
         * Setting an accepted volunteer to `rejected` IS removal: it frees
         * their place and promotes from the waitlist. Doing that after the
         * shift has run is not roster management, it is editing the past —
         * somebody turned up and worked. Skipping matches how this route
         * already handles a full slot: the rest of the batch is honest work
         * and should not be lost to one application that cannot move.
         */
        if (wasAccepted && status !== 'accepted') {
          const slot = await tx.prepare('SELECT start_datetime FROM slots WHERE id = ?').get(app.slot_id);
          if (slotHasStarted(slot, removalClock) !== false) {
            skipped.push({ id: app.id, reason: 'shift_started' });
            continue;
          }
        }

        await update.run(status, app.id);
        applied.push({ id: app.id, status, userId: app.user_id, eventId: app.event_id, eventTitle: app.event_title });

        if (status === 'waitlisted') {
          await assignWaitlistOrder(app.id, app.slot_id);
        }

        // Slots whose capacity this batch may have freed. Collected rather than
        // promoted inline so each slot is filled ONCE after every demotion in
        // the batch has been applied — promoting per-application would refill a
        // spot from the waitlist and then free another, cascading oddly.
        //
        // The `auto_approve === 1` condition that used to be here is gone:
        // promotion follows capacity, not the selection method.
        if (wasAccepted && status !== 'accepted') {
          freedSlots.add(app.slot_id);
        }
      }

      // Still inside the transaction, so a promotion cannot be visible without
      // the demotion that made room for it.
      for (const slotId of freedSlots) {
        promotions.push(...await promoteFromWaitlist(slotId));
      }
    });

    // Notifications only after the commit — see promoteFromWaitlist.
    await notifyPromotions(promotions);
    /* A loop rather than `dispatchMany` for the reason `notifyPromotions` gives:
       one volunteer may hold two applications to different slots of the same
       event, and a bulk decision owes them a notice for each. `dispatchMany`
       deduplicates its recipient list, which would drop the second. */
    for (const a of applied) {
      if (status === 'accepted') {
        await notificationService.dispatch('APPLICATION_ACCEPTED', { eventId: a.eventId, eventTitle: a.eventTitle }, a.userId);
      } else if (status === 'waitlisted') {
        await notificationService.dispatch('APPLICATION_WAITLISTED', { eventId: a.eventId, eventTitle: a.eventTitle }, a.userId);
      } else if (status === 'rejected') {
        await notificationService.dispatch('APPLICATION_REJECTED', { eventId: a.eventId, eventTitle: a.eventTitle }, a.userId);
      }
    }

    res.json({ success: true, updated: applied.length, applied, skipped });
  } catch (error) {
    console.error('Bulk update app status error:', error);
    res.status(500).json({ error: 'Internal server error updating applications' });
  }
});

// 8. Update Application Status
// (Hosting organizer or admin-tier oversight: accept/waitlist/reject ·
//  Student: withdraw own)
//
// The gate names all THREE capabilities this route serves, not just the two
// management ones. Students reach this same route to withdraw their own
// application (the `application.withdraw` branch far below), so a gate of
// ['applicant.review', 'event.moderate'] alone would 403 every student at the
// middleware and break withdrawal outright. What the gate still excludes is
// `partner`, which holds none of the three — the same 403 it already received
// from the explicit deny at the end of the cascade, now delivered before the
// handler runs. Its other purpose is visibility: a `capabilityGate` on the
// stack is what puts this route in front of Guard 2's scanner instead of
// leaving it to a hand-written ROUTE_REGISTRY entry.
router.patch('/api/applications/:id', authenticateToken,
  requireCapAny(['applicant.review', 'event.moderate', 'organization.event.manage.own', 'application.withdraw']), async (req, res) => {
  const appId = req.params.id;
  const { status } = req.body; // 'accepted', 'waitlisted', 'rejected'

  // Ordered most-privileged-first, per the cascade rule in authz.js:
  // applicant.review (organizer management) and event.moderate (admin-tier
  // oversight) are checked before application.withdraw (student self-service),
  // so a wildcard principal (super_admin) resolves to the broader branch
  // rather than being caught by the narrower one and failing its ownership
  // check below. The cascade ends in an explicit 403, never a bare else.
  /**
   * A Student Organizer reaches the review branch only for THEIR OWN event.
   *
   * `organization.event.manage.own` cannot be tested on its own here the way the
   * other two are. The person holding it is a student, and a student also has
   * applications of their own to withdraw — so an unconditional branch on the
   * capability would send them into the organizer path for every application
   * they touch, including their own, and refuse it with "you do not host this
   * event". Asking whether they host THIS one is what keeps both doors open,
   * and it is the same ownership question the branch itself asks two lines
   * below, moved up so the cascade can use its answer.
   *
   * `canRunEvent` and not a bare `organizer_id` compare, so this gate gives the
   * same answer as `PATCH /api/applications/bulk` — which asks `canRunEvent`
   * directly. Written the narrow way, a club's manager could accept an
   * applicant in bulk and be told "students may only withdraw their own
   * applications" for the identical act on the identical row.
   */
  const appForGate = await db.prepare(`
    SELECT a.id, e.organizer_id, e.organization_id
      FROM applications a JOIN events e ON e.id = a.event_id
     WHERE a.id = ?
  `).get(appId);
  const runsThisEvent = can(req.principal, 'organization.event.manage.own')
    && await canRunEvent(db, appForGate, req.principal.userId, {
      hasModerate: can(req.principal, 'event.moderate'),
    });

  if (can(req.principal, 'applicant.review') || can(req.principal, 'event.moderate') || runsThisEvent) {
    if (!['accepted', 'waitlisted', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status update. Must be accepted, waitlisted, or rejected.' });
    }

    try {
      const app = await db.prepare(`
        SELECT a.*, e.organizer_id, e.organization_id, e.title as event_title
        FROM applications a
        JOIN events e ON a.event_id = e.id
        WHERE a.id = ?
      `).get(appId);

      if (!app) return res.status(404).json({ error: 'Application not found' });
      if (!await canRunEvent(db, app, req.principal.userId, { hasModerate: can(req.principal, 'event.moderate') })) {
        return res.status(403).json({ error: 'Access denied: You do not host this event' });
      }

      // A withdrawal is the volunteer's own decision to leave. The organizer must
      // not be able to silently pull them back in — re-committing someone who
      // stepped down, without their knowledge, to a shift they may no longer be
      // able to attend. Re-entry only happens if the student re-applies.
      if (app.status === 'withdrawn') {
        return res.status(409).json({
          error: 'This volunteer withdrew their own application. Only they can re-apply.',
          code: 'withdrawn'
        });
      }

      /* The capacity check moved INSIDE the transaction below, behind a row
         lock on the slot. Checking here read the count on the ambient handle
         and wrote several statements later, so two organizers pressing Accept
         together both saw room: five simultaneous accepts put five volunteers
         into a two-spot shift. SQLite's process-wide write queue hid it. */

      const wasAccepted = app.status === 'accepted';

      /**
       * An organizer may remove somebody from a shift, but only before it
       * starts.
       *
       * ── What this closes ──
       *
       * Setting an accepted volunteer to `rejected` IS removal — it frees their
       * place and promotes from the waitlist. Nothing stopped an organizer
       * doing it after the shift had run, which meant somebody who turned up
       * and worked could be taken off the roster afterwards. That is not
       * managing a roster; it is editing the past.
       *
       * The bound is per SLOT, not per event, and matches check-in: on a
       * two-day festival a volunteer holding Sunday's shift can still be
       * removed on Saturday, because their own commitment has not begun.
       *
       * Declining a PENDING application is untouched. That is not removing a
       * participant — nobody held a place — and organizers reconcile
       * applications after the fact all the time.
       *
       * Hours are unreachable from here by construction: this route writes
       * `applications.status` and nothing else. Attendance and credited hours
       * live in their own tables and are not read, written, or cascaded to.
       * A removed volunteer keeps every hour they earned.
       */
      if (wasAccepted && status !== 'accepted') {
        const slot = await db.prepare('SELECT id, name, start_datetime FROM slots WHERE id = ?').get(app.slot_id);
        const started = slotHasStarted(slot, new Date());

        if (started === null) {
          return res.status(409).json({
            error: "This shift's start time cannot be read, so it is not clear whether it has begun.",
            code: 'slot_unreadable',
          });
        }
        if (started === true) {
          return res.status(409).json({
            error: 'This shift has already started, so volunteers can no longer be removed from it. '
              + 'Attendance is recorded on the check-in screen.',
            code: 'shift_started',
            startedAt: slot.start_datetime,
          });
        }
      }

      // The status change and any resulting promotion must land together: a spot
      // freed but not refilled, or refilled twice, are both worse than neither.
      let promotions = [];
      let slotFull = null;
      await runInTransaction(db, async (tx) => {
        if (status === 'accepted') {
          /* Lock the SLOT, then count. The lock is on the slot rather than the
             applications because the rows counted are not the rows locked — an
             application can be inserted between the two. */
          const slot = await tx.prepare(
            `SELECT max_spots FROM slots WHERE id = ?${forUpdate(db)}`
          ).get(app.slot_id);
          const slotMaxSpots = slot ? slot.max_spots : 0;
          const slotAccepted = (await tx.prepare(`
            SELECT COUNT(*) as count FROM applications
            WHERE slot_id = ? AND status = 'accepted'
          `).get(app.slot_id)).count;

          if (Number(slotAccepted) >= Number(slotMaxSpots)) {
            slotFull = slotMaxSpots;
            return;
          }
        }

        await tx.prepare('UPDATE applications SET status = ? WHERE id = ?').run(status, appId);

        // Joining the waitlist means joining the back of the queue.
        if (status === 'waitlisted') {
          await assignWaitlistOrder(appId, app.slot_id);
        }

        // A spot only opens if this person was actually holding one. Rejecting a
        // pending applicant frees nothing, so promoting then would overfill.
        //
        // No `auto_approve` check: promotion depends on capacity and queue order,
        // not on how the organizer chooses people. See promoteFromWaitlist.
        if (wasAccepted && status !== 'accepted') {
          promotions = await promoteFromWaitlist(app.slot_id);
        }
      });

      /* Refused inside the transaction, answered outside it: returning from the
         callback would have committed a no-op rather than sending a response. */
      if (slotFull !== null) {
        return res.status(400).json({ error: `Cannot accept: This slot is full (${slotFull} spots).` });
      }

      await notifyPromotions(promotions);

      // Notify the volunteer
      if (status === 'accepted') {
        await notificationService.dispatch('APPLICATION_ACCEPTED', { eventId: app.event_id, eventTitle: app.event_title }, app.user_id);
      } else if (status === 'waitlisted') {
        await notificationService.dispatch('APPLICATION_WAITLISTED', { eventId: app.event_id, eventTitle: app.event_title }, app.user_id);
      } else if (status === 'rejected') {
        await notificationService.dispatch('APPLICATION_REJECTED', { eventId: app.event_id, eventTitle: app.event_title }, app.user_id);
      }

      return res.json({
        success: true,
        application: {
          id: appId,
          status
        }
      });
    } catch (error) {
      console.error('Update app status error:', error);
      return res.status(500).json({ error: 'Internal server error updating application' });
    }
  }

  // Students can only withdraw their own applications
  if (can(req.principal, 'application.withdraw')) {
    // 'rejected' is still accepted so an older client build keeps working.
    // Both mean the same act; only 'withdrawn' is stored, because a student
    // leaving is not the same event as an organizer turning them down.
    if (status !== 'withdrawn' && status !== 'rejected') {
      return res.status(403).json({ error: 'Students may only withdraw their own applications.' });
    }
    try {
      const app = await db.prepare(`
        SELECT a.*, e.title as event_title, e.organizer_id, s.name as slot_name, s.start_datetime
        FROM applications a
        JOIN events e ON a.event_id = e.id
        JOIN slots s ON a.slot_id = s.id
        WHERE a.id = ?
      `).get(appId);
      if (!app) return res.status(404).json({ error: 'Application not found' });
      if (app.user_id !== req.principal.userId) {
        return res.status(403).json({ error: 'Access denied: This is not your application.' });
      }

      // A confirmed volunteer can still release their spot, but only before
      // the shift starts. Forcing people to no-show instead of cancelling is
      // worse for the organizer than an early, notified cancellation.
      const wasConfirmed = app.status === 'accepted';
      if (wasConfirmed && new Date() >= new Date(app.start_datetime)) {
        return res.status(400).json({
          error: 'This shift has already started, so it can no longer be released. Speak to the organizer.'
        });
      }

      let promotions = [];
      await runInTransaction(db, async (tx) => {
        await tx.prepare('UPDATE applications SET status = ?, waitlist_order = NULL WHERE id = ?')
          .run('withdrawn', appId);

        // Releasing a confirmed spot is the case the waitlist exists for.
        // Previously gated on auto_approve, which left organizer-managed events
        // sitting under capacity with someone waiting and nobody informed.
        if (wasConfirmed) {
          promotions = await promoteFromWaitlist(app.slot_id);
        }
      });

      if (wasConfirmed) {
        // Notify student releasing spot
        await notificationService.dispatch('SPOT_RELEASED', { eventId: app.event_id, eventTitle: app.event_title }, app.user_id);

        // Notify organizer
        await notificationService.dispatch('VOLUNTEER_RELEASED_SPOT', { eventId: app.event_id, eventTitle: app.event_title }, app.organizer_id);

        await notifyPromotions(promotions);
      }

      return res.json({
        success: true,
        released: wasConfirmed,
        application: { id: appId, status: 'withdrawn' }
      });
    } catch (err) {
      console.error('Withdraw error:', err);
      return res.status(500).json({ error: 'Internal server error withdrawing application' });
    }
  }

  return res.status(403).json({ error: 'Access denied: Only organizers can manage application status' });
});

// 9a. Check-in (Organizer only)
//
// Marking people off as they arrive. Deliberately not the same act as awarding
// hours: check-in marks are freely editable, credit nothing, and are available
// while a shift is still running. Hours are finalised separately, afterwards.

export default router;
