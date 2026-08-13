import express from 'express';

import {
  authenticateToken, inTransaction,
  assignWaitlistOrder, promoteFromWaitlist, notifyPromotions
} from '../utils.js';
import { can, requireCap, requireCapAny } from '../authz.js';
import { notificationService } from '../services/notificationService.js';
import { friendsToNotify } from '../relationships.js';
/* Signed-up / attended, batched, and defined identically to the profile's own
   figures — see the header on `participationCountsFor`. */
import { participationCountsFor } from '../volunteerStats.js';
import { eventApplicationEligibility } from '../eventEligibility.js';
import { db } from '../db.js';
import { slotHasStarted } from '../attendance.js';

const router = express.Router();

router.get('/api/applications', authenticateToken, (req, res) => {
  try {
    let rows;
    const BASE_QUERY = `
      SELECT a.*, u.name, u.avatar, u.school, u.grade, u.bio, u.skills,
             e.title as event_title,
             s.name as slot_name, s.description as slot_description, s.start_datetime as slot_start_datetime, s.end_datetime as slot_end_datetime, s.max_spots as slot_max_spots
      FROM applications a
      JOIN users u ON a.user_id = u.id
      JOIN events e ON a.event_id = e.id
      JOIN slots s ON a.slot_id = s.id
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
      rows = db.prepare(BASE_QUERY).all();
    } else if (can(req.principal, 'applicant.review')) {
      // organizer: applications to the events they host.
      rows = db.prepare(`${BASE_QUERY} WHERE e.organizer_id = ?`).all(req.principal.userId);
    } else if (can(req.principal, 'application.withdraw')) {
      // student: their own applications only.
      rows = db.prepare(`${BASE_QUERY} WHERE a.user_id = ?`).all(req.principal.userId);
    } else {
      // No recognised capability (e.g. partner, deliberate correction v1.2a):
      // deny by default rather than falling through to unscoped access. Partner
      // previously fell into the unscoped branch and could read every
      // application in the system — a data leak, not behaviour worth keeping.
      rows = [];
    }

    // Batch the volunteer history lookups once instead of three queries per
    // row — organizers sort and filter on these, so they load on every view.
    const historyByUser = new Map();
    for (const h of db.prepare(`
      SELECT a.user_id,
             COALESCE(SUM(a.hours_awarded), 0) as total_hours,
             COUNT(DISTINCT a.event_id) as completed_events,
             MAX(s.end_datetime) as last_end
      FROM attendance a
      JOIN slots s ON a.slot_id = s.id
      WHERE a.present = 1
      GROUP BY a.user_id
    `).all()) {
      historyByUser.set(h.user_id, h);
    }

    const attendanceByKey = new Map();
    for (const a of db.prepare('SELECT slot_id, user_id, present, hours_awarded FROM attendance').all()) {
      attendanceByKey.set(`${a.slot_id}:${a.user_id}`, a);
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
    const participation = participationCountsFor(db, rows.map(r => r.user_id));

    const conflictsByAppId = new Set();
    for (const c of db.prepare('SELECT application_id FROM application_conflicts').all()) {
      conflictsByAppId.add(c.application_id);
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
      const badgeRows = db.prepare(`
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

    const formattedApps = rows.map(r => {
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
          school: r.school,
          grade: r.grade,
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
          badges: badgesByUser.get(r.user_id) ?? [],
          bio: r.bio,
          skills: r.skills ? JSON.parse(r.skills) : []
        },
        attendance,
        hasConflict: conflictsByAppId.has(r.id)
      };
    });

    res.json(formattedApps);
  } catch (error) {
    console.error('Fetch applications error:', error);
    res.status(500).json({ error: 'Internal server error fetching applications' });
  }
});

// 7. Apply to an Event Slot (Student only)
router.post('/api/events/:id/apply', authenticateToken, requireCap('event.apply'), (req, res) => {
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
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
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
    const eligibility = eventApplicationEligibility(event, req.user.id);
    if (!eligibility.ok) {
      return res.status(eligibility.status).json({
        error: eligibility.error,
        code: eligibility.code,
        ...(eligibility.reason ? { reason: eligibility.reason } : {}),
      });
    }

    // Verify slot belongs to event
    const slot = db.prepare('SELECT * FROM slots WHERE id = ? AND event_id = ?').get(slotId, eventId);
    if (!slot) return res.status(404).json({ error: 'Selected slot does not belong to this event' });

    // Enforce deadline check
    const now = new Date();
    if (now > new Date(event.application_deadline)) {
      return res.status(400).json({ error: 'Application deadline has passed. Sign-ups are closed.' });
    }

    // Schedule Conflict Detection
    // Check if the user has any pending, accepted, or waitlisted slots that overlap
    // with this slot's time. Overlap occurs if existing_start < new_end AND existing_end > new_start.
    const overlap = db.prepare(`
      SELECT a.id as app_id, a.status, e.title, s.name as slot_name, s.start_datetime, s.end_datetime
      FROM applications a
      JOIN slots s ON a.slot_id = s.id
      JOIN events e ON a.event_id = e.id
      WHERE a.user_id = ?
        AND a.status IN ('pending', 'accepted', 'waitlisted')
        AND a.slot_id != ?
        AND s.start_datetime < ?
        AND s.end_datetime > ?
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
    const existing = db.prepare(
      'SELECT id, status FROM applications WHERE slot_id = ? AND user_id = ?'
    ).get(slotId, req.user.id);

    const status = 'pending';
    const appliedAt = new Date().toISOString();
    let appId;

    if (existing && existing.status !== 'withdrawn') {
      return res.status(400).json({ error: 'You have already applied for this time slot' });
    } else if (existing) {
      appId = existing.id;
      db.prepare('UPDATE applications SET status = ?, applied_at = ?, waitlist_order = NULL WHERE id = ?')
        .run(status, appliedAt, appId);
    } else {
      appId = `app-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      db.prepare(`
        INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(appId, req.user.id, eventId, slotId, status, appliedAt);
    }

    if (overlap && req.body.overrideConflict) {
      const conflictId = `conf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      db.prepare(`
        INSERT INTO application_conflicts (id, application_id, conflicting_application_id, conflict_type, acknowledged_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(conflictId, appId, overlap.app_id, overlap.status, appliedAt, appliedAt);

      notificationService.dispatch('SCHEDULE_CONFLICT_WARNING', { eventId: event.id, eventTitle: event.title }, req.user.id);
    }

    // Notify organizer
    notificationService.dispatch('NEW_APPLICATION', { eventId: event.id, eventTitle: event.title }, event.organizer_id);

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
      const recipients = rosterPublic ? friendsToNotify(db, req.user.id) : [];
      if (recipients.length > 0) {
        const actor = db.prepare('SELECT name, username FROM users WHERE id = ?').get(req.user.id);
        const payload = {
          actorName: actor?.name, actorUsername: actor?.username,
          eventId: event.id, eventTitle: event.title,
        };
        for (const friendId of recipients) {
          notificationService.dispatch('FRIEND_SIGNED_UP', payload, friendId, `friend-signup:${req.user.id}:${event.id}`);
        }
      }
    } catch (err) {
      console.error('Friend signup fan-out failed:', err);
    }

    res.status(201).json({
      success: true,
      application: { id: appId, eventId, slotId, userId: req.user.id, status, appliedAt }
    });
  } catch (error) {
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
router.patch('/api/applications/bulk', authenticateToken, requireCapAny(['applicant.review', 'event.moderate']), (req, res) => {
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
      const app = db.prepare(`
        SELECT a.*, e.organizer_id, e.title as event_title, e.auto_approve
        FROM applications a
        JOIN events e ON a.event_id = e.id
        WHERE a.id = ?
      `).get(id);
      if (!app) return res.status(404).json({ error: `Application not found: ${id}` });
      if (!can(req.principal, 'event.moderate') && app.organizer_id !== req.principal.userId) {
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
    if (status === 'accepted') {
      for (const app of apps) {
        if (remainingBySlot[app.slot_id] === undefined) {
          const slot = db.prepare('SELECT max_spots FROM slots WHERE id = ?').get(app.slot_id);
          const slotMaxSpots = slot ? slot.max_spots : 0;
          const slotAccepted = db.prepare(`
            SELECT COUNT(*) as count FROM applications
            WHERE slot_id = ? AND status = 'accepted'
          `).get(app.slot_id).count;
          remainingBySlot[app.slot_id] = Math.max(0, slotMaxSpots - slotAccepted);
        }
      }
    }

    const promotions = [];
    const freedSlots = new Set();
    /* One clock for the whole batch, so a long transaction cannot let two
       applications on the same slot disagree about whether it had started. */
    const removalClock = new Date();
    inTransaction(() => {
      const update = db.prepare('UPDATE applications SET status = ? WHERE id = ?');
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
          const slot = db.prepare('SELECT start_datetime FROM slots WHERE id = ?').get(app.slot_id);
          if (slotHasStarted(slot, removalClock) !== false) {
            skipped.push({ id: app.id, reason: 'shift_started' });
            continue;
          }
        }

        update.run(status, app.id);
        applied.push({ id: app.id, status, userId: app.user_id, eventId: app.event_id, eventTitle: app.event_title });

        if (status === 'waitlisted') {
          assignWaitlistOrder(app.id, app.slot_id);
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
        promotions.push(...promoteFromWaitlist(slotId));
      }
    });

    // Notifications only after the commit — see promoteFromWaitlist.
    notifyPromotions(promotions);
    for (const a of applied) {
      if (status === 'accepted') {
        notificationService.dispatch('APPLICATION_ACCEPTED', { eventId: a.eventId, eventTitle: a.eventTitle }, a.userId);
      } else if (status === 'waitlisted') {
        notificationService.dispatch('APPLICATION_WAITLISTED', { eventId: a.eventId, eventTitle: a.eventTitle }, a.userId);
      } else if (status === 'rejected') {
        notificationService.dispatch('APPLICATION_REJECTED', { eventId: a.eventId, eventTitle: a.eventTitle }, a.userId);
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
  requireCapAny(['applicant.review', 'event.moderate', 'application.withdraw']), (req, res) => {
  const appId = req.params.id;
  const { status } = req.body; // 'accepted', 'waitlisted', 'rejected'

  // Ordered most-privileged-first, per the cascade rule in authz.js:
  // applicant.review (organizer management) and event.moderate (admin-tier
  // oversight) are checked before application.withdraw (student self-service),
  // so a wildcard principal (super_admin) resolves to the broader branch
  // rather than being caught by the narrower one and failing its ownership
  // check below. The cascade ends in an explicit 403, never a bare else.
  if (can(req.principal, 'applicant.review') || can(req.principal, 'event.moderate')) {
    if (!['accepted', 'waitlisted', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status update. Must be accepted, waitlisted, or rejected.' });
    }

    try {
      const app = db.prepare(`
        SELECT a.*, e.organizer_id, e.title as event_title
        FROM applications a
        JOIN events e ON a.event_id = e.id
        WHERE a.id = ?
      `).get(appId);

      if (!app) return res.status(404).json({ error: 'Application not found' });
      if (!can(req.principal, 'event.moderate') && app.organizer_id !== req.principal.userId) {
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

      // Check spots capacity at the slot level if accepting
      if (status === 'accepted') {
        const slot = db.prepare('SELECT max_spots FROM slots WHERE id = ?').get(app.slot_id);
        const slotMaxSpots = slot ? slot.max_spots : 0;
        const slotAccepted = db.prepare(`
          SELECT COUNT(*) as count FROM applications
          WHERE slot_id = ? AND status = 'accepted'
        `).get(app.slot_id).count;

        if (slotAccepted >= slotMaxSpots) {
          return res.status(400).json({ error: `Cannot accept: This slot is full (${slotMaxSpots} spots).` });
        }
      }

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
        const slot = db.prepare('SELECT id, name, start_datetime FROM slots WHERE id = ?').get(app.slot_id);
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
      inTransaction(() => {
        db.prepare('UPDATE applications SET status = ? WHERE id = ?').run(status, appId);

        // Joining the waitlist means joining the back of the queue.
        if (status === 'waitlisted') {
          assignWaitlistOrder(appId, app.slot_id);
        }

        // A spot only opens if this person was actually holding one. Rejecting a
        // pending applicant frees nothing, so promoting then would overfill.
        //
        // No `auto_approve` check: promotion depends on capacity and queue order,
        // not on how the organizer chooses people. See promoteFromWaitlist.
        if (wasAccepted && status !== 'accepted') {
          promotions = promoteFromWaitlist(app.slot_id);
        }
      });
      notifyPromotions(promotions);

      // Notify the volunteer
      if (status === 'accepted') {
        notificationService.dispatch('APPLICATION_ACCEPTED', { eventId: app.event_id, eventTitle: app.event_title }, app.user_id);
      } else if (status === 'waitlisted') {
        notificationService.dispatch('APPLICATION_WAITLISTED', { eventId: app.event_id, eventTitle: app.event_title }, app.user_id);
      } else if (status === 'rejected') {
        notificationService.dispatch('APPLICATION_REJECTED', { eventId: app.event_id, eventTitle: app.event_title }, app.user_id);
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
      const app = db.prepare(`
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
      inTransaction(() => {
        db.prepare('UPDATE applications SET status = ?, waitlist_order = NULL WHERE id = ?')
          .run('withdrawn', appId);

        // Releasing a confirmed spot is the case the waitlist exists for.
        // Previously gated on auto_approve, which left organizer-managed events
        // sitting under capacity with someone waiting and nobody informed.
        if (wasConfirmed) {
          promotions = promoteFromWaitlist(app.slot_id);
        }
      });

      if (wasConfirmed) {
        // Notify student releasing spot
        notificationService.dispatch('SPOT_RELEASED', { eventId: app.event_id, eventTitle: app.event_title }, app.user_id);

        // Notify organizer
        notificationService.dispatch('VOLUNTEER_RELEASED_SPOT', { eventId: app.event_id, eventTitle: app.event_title }, app.organizer_id);

        notifyPromotions(promotions);
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
