import express from 'express';

import { authenticateToken } from '../utils.js';
import { runInTransaction } from '../db/connectionContext.js';
import { can, requireCap } from '../authz.js';
import { recordAudit } from '../auditLog.js';
import { notificationService } from '../services/notificationService.js';
import { emitToUser } from '../realtime/events.js';
import { db } from '../db.js';
import { canRunEvent, EVENT_STAFF_CAPABILITIES } from '../organizations.js';
import { eventQueryFragments } from '../eventQuery.js';
import { normaliseTag, tagsForEvents } from '../eventTags.js';
/* Derived from the Silver tier, so the meter and the milestone cannot disagree
   about what Silver means. See server/milestones.js. */
import '../milestones.js';
import { volunteerInsights } from '../volunteerInsights.js';
import { commentHasLiveReport, COMMENT_HELD_MESSAGE } from '../evidenceHolds.js';
import { nullSafeNotEquals } from '../db/dialectSql.js';

const router = express.Router();

router.get('/api/notifications', authenticateToken, async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const rows = await db.prepare(`
      SELECT * FROM notifications WHERE user_id = ?
      ORDER BY created_at DESC LIMIT ? OFFSET ?
    `).all(req.user.id, limit, offset);
    const unread = (await db.prepare(`
      SELECT COUNT(*) as c FROM notifications WHERE user_id = ? AND read = 0
    `).get(req.user.id)).c;
    res.json({
      notifications: rows.map(r => ({
        id: r.id, kind: r.kind, priority: r.priority, title: r.title, body: r.body,
        link: r.link, read: r.read === 1,
        createdAt: r.created_at
      })),
      unreadCount: unread
    });
  } catch (err) {
    console.error('Notifications list error:', err);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

// 16. Mark notifications as read
router.patch('/api/notifications', authenticateToken, async (req, res) => {
  try {
    const { ids, all } = req.body;
    if (all) {
      await db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(req.user.id);
      emitToUser(req.user.id, 'notification.read', null, { all: true });
    } else if (Array.isArray(ids) && ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      await db.prepare(`UPDATE notifications SET read = 1 WHERE id IN (${placeholders}) AND user_id = ?`)
        .run(...ids, req.user.id);
      emitToUser(req.user.id, 'notification.read', null, { ids });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Update notifications error:', err);
    res.status(500).json({ error: 'Failed to update notifications' });
  }
});

// 17. Comments on an event

router.get('/api/events/:id/comments', authenticateToken, async (req, res) => {
  try {
    const rows = await db.prepare(`
      SELECT c.*, u.name as author_name, u.avatar as author_avatar, u.role as author_role
      FROM event_comments c
      JOIN users u ON c.user_id = u.id
      WHERE c.event_id = ?
      ORDER BY c.created_at ASC
    `).all(req.params.id);
    res.json(rows.map(r => ({
      id: r.id, eventId: r.event_id, userId: r.user_id,
      body: r.body, createdAt: r.created_at,
      author: {
        id: r.user_id, name: r.author_name, avatar: r.author_avatar, role: r.author_role
      }
    })));
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch comments' });
  }
});

/** Named so the cap and the message it produces cannot drift apart. */
const MAX_COMMENT_LENGTH = 1000;

router.post('/api/events/:id/comments', authenticateToken, async (req, res) => {
  try {
    const { body } = req.body;
    /**
     * `typeof`, not just truthiness.
     *
     * `!body` alone let `42`, `true`, `['hi']` and `{a:1}` reach `body.trim()`,
     * which is not a function on a number or a plain object — so the request
     * threw, landed in the catch below, and answered 500. The server said it was
     * broken when the request was.
     *
     * Same defect and same fix as the `slotId` guard in `applicationRoutes.js`
     * and the non-string `targetId` in `reportService.js`;
     * `routes.malformed.test.js` is where that class is asserted.
     */
    if (typeof body !== 'string' || !body.trim()) {
      return res.status(400).json({ error: 'Comment cannot be empty' });
    }
    if (body.length > MAX_COMMENT_LENGTH) {
      return res.status(400).json({ error: `Comment is too long (max ${MAX_COMMENT_LENGTH} chars)` });
    }

    const event = await db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const id = `cmt-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
    await db.prepare(`
      INSERT INTO event_comments (id, event_id, user_id, body, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, req.params.id, req.user.id, body.trim(), new Date().toISOString());

    // Notify the organizer of the new comment (if not the commenter)
    if (event.organizer_id !== req.user.id) {
      const commenterRow = await db.prepare('SELECT name FROM users WHERE id = ?').get(req.user.id);
      const commenterName = commenterRow ? commenterRow.name : 'Someone';
      await notificationService.dispatch('EVENT_COMMENT', { eventId: event.id, eventTitle: event.title }, event.organizer_id);
    } else {
      // The organizer is the commenter. Notify all pending or accepted applicants.
      const applicants = await db.prepare(`
        SELECT DISTINCT user_id FROM applications
        WHERE event_id = ? AND status IN ('accepted', 'pending')
      `).all(req.params.id);

      for (const app of applicants) {
        if (app.user_id !== req.user.id) {
          await notificationService.dispatch('EVENT_COMMENT', { eventId: event.id, eventTitle: event.title }, app.user_id);
        }
      }
    }

    const created = await db.prepare(`
      SELECT c.*, u.name as author_name, u.avatar as author_avatar, u.role as author_role
      FROM event_comments c JOIN users u ON c.user_id = u.id
      WHERE c.id = ?
    `).get(id);
    res.status(201).json({
      id: created.id, eventId: created.event_id, userId: created.user_id,
      body: created.body, createdAt: created.created_at,
      author: { id: created.user_id, name: created.author_name, avatar: created.author_avatar, role: created.author_role }
    });
  } catch (err) {
    console.error('Comment create error:', err);
    res.status(500).json({ error: 'Failed to post comment' });
  }
});

router.delete('/api/comments/:id', authenticateToken, async (req, res) => {
  try {
    const cmt = await db.prepare('SELECT * FROM event_comments WHERE id = ?').get(req.params.id);
    if (!cmt) return res.status(404).json({ error: 'Comment not found' });
    // Own comment, or moderation reach — never an unscoped `else`.
    if (cmt.user_id !== req.principal.userId && !can(req.principal, 'event.moderate')) {
      return res.status(403).json({ error: 'Access denied' });
    }
    /**
     * A comment under a live report is evidence, and this route hard-deletes.
     * The author is the person most motivated to reach it and needs no
     * privilege to do so — it is their own comment. The moderator path is held
     * too, for the reason the event hold is: the refusal is about the evidence,
     * not about who is asking.
     */
    if (await commentHasLiveReport(db, req.params.id)) {
      return res.status(409).json({ error: COMMENT_HELD_MESSAGE, code: 'under_review' });
    }
    /**
     * A moderator deleting somebody ELSE's comment is recorded; an author
     * deleting their own is not.
     *
     * `admin_audit_logs` answers "what did an administrator do to a person", and
     * this route had no entry at all — so an administrator could remove a
     * student's words from an event page and nothing anywhere said it had
     * happened, let alone who did it. The student sees their comment gone and has
     * no way to ask about it.
     *
     * Not logged when the author deletes their own, deliberately: that is a
     * person editing their own contribution, not an exercise of power over
     * somebody, and filling the administrative trail with it would bury the rows
     * that matter.
     *
     * The comment BODY is not copied into the row. It is a student's words about
     * a school event, `admin_audit_logs` is read for operational questions, and
     * the trail should record that a deletion happened without republishing what
     * was deleted into a second table with a different retention period.
     */
    const moderating = cmt.user_id !== req.principal.userId;

    await runInTransaction(db, async (tx) => {
      await tx.prepare('DELETE FROM event_comments WHERE id = ?').run(req.params.id);

      if (moderating) {
        await recordAudit(tx, {
          adminId: req.principal.userId,
          action: 'COMMENT_DELETED',
          targetUserId: cmt.user_id,
          details: `Deleted a comment on event ${cmt.event_id}`,
        });
      }
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete comment' });
  }
});

// ── Attendees ───────────────────────────────────────────────────────
// Who else is coming. Visibility is enforced here, not in the client:
//   • organizers and admins always see the roster
//   • a student sees it only once they are accepted for the event, and only
//     if the organizer left attendee visibility public

router.get('/api/events/:id/attendees', authenticateToken, async (req, res) => {
  try {
    const event = await db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const isStaff = EVENT_STAFF_CAPABILITIES.some(c => can(req.principal, c))
      && await canRunEvent(db, event, req.principal.userId, { hasModerate: can(req.principal, 'event.moderate') });

    if (!isStaff) {
      const mine = await db.prepare(`
        SELECT 1 FROM applications
        WHERE event_id = ? AND user_id = ? AND status = 'accepted'
      `).get(req.params.id, req.user.id);

      if (!mine) {
        return res.json({ visible: false, reason: 'not_accepted', attendees: [] });
      }
      if ((event.attendee_visibility || 'accepted') !== 'accepted') {
        return res.json({ visible: false, reason: 'private', attendees: [] });
      }
    }

    const rows = await db.prepare(`
      SELECT DISTINCT u.id, u.name, u.avatar, u.grade, u.school
      FROM applications a
      JOIN users u ON a.user_id = u.id
      WHERE a.event_id = ? AND a.status = 'accepted'
      ORDER BY u.name
    `).all(req.params.id);

    /**
     * A co-attendee sees who else is coming. They do not see school and grade.
     *
     * The access gate above is right — a non-staff caller needs an accepted
     * application and the organizer must have left the roster visible — but it
     * decided only WHETHER to answer, not WHAT to include, and the row carried
     * both of a volunteer's `PUBLIC_ONLY_FIELDS` (profileSerializer.js).
     * `users.profile_visibility` defaults to 'private', so for a student who
     * never opened the setting those two columns are withheld from every peer,
     * friends included: `GET /api/users/:id/public-profile` refuses them and
     * `directory.privacy.test.js` pins that refusal. This roster answered them
     * to anyone who had applied to the same shift, which made it the effective
     * policy and the directory's refusal cosmetic.
     *
     * Staff keep both, because reviewing applicants is what those fields are
     * for and that path is gated on hosting the event.
     */
    res.json({
      visible: true,
      attendees: rows.map(r => (isStaff
        ? { id: r.id, name: r.name, avatar: r.avatar, grade: r.grade, school: r.school }
        : { id: r.id, name: r.name, avatar: r.avatar }))
    });
  } catch (err) {
    console.error('Attendees error:', err);
    res.status(500).json({ error: 'Failed to fetch attendees' });
  }
});

// ── Announcements ───────────────────────────────────────────────────
// One-way updates from the organizer. Not a messaging system: no replies,
// no direct messages. Questions go to the event discussion instead.

router.get('/api/events/:id/announcements', authenticateToken, async (req, res) => {
  try {
    const event = await db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const isStaff = EVENT_STAFF_CAPABILITIES.some(c => can(req.principal, c))
      && await canRunEvent(db, event, req.principal.userId, { hasModerate: can(req.principal, 'event.moderate') });

    if (!isStaff) {
      const mine = await db.prepare(`
        SELECT 1 FROM applications
        WHERE event_id = ? AND user_id = ? AND status = 'accepted'
      `).get(req.params.id, req.user.id);

      if (!mine) return res.json([]);
    }

    const rows = await db.prepare(`
      SELECT n.*, u.name as author_name, u.avatar as author_avatar, u.role as author_role
      FROM event_announcements n
      JOIN users u ON n.author_id = u.id
      WHERE n.event_id = ?
      ORDER BY n.created_at DESC
    `).all(req.params.id);

    res.json(rows.map(r => ({
      id: r.id,
      eventId: r.event_id,
      body: r.body,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      author: { id: r.author_id, name: r.author_name, avatar: r.author_avatar, role: r.author_role }
    })));
  } catch (err) {
    console.error('Announcements list error:', err);
    res.status(500).json({ error: 'Failed to fetch announcements' });
  }
});

router.post('/api/events/:id/announcements', authenticateToken, async (req, res) => {
  try {
    const { body } = req.body;
    if (!body || !body.trim()) return res.status(400).json({ error: 'Announcement cannot be empty' });
    if (body.length > 2000) return res.status(400).json({ error: 'Announcement is too long (max 2000 characters)' });

    const event = await db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    /**
     * `announcement.post` is the kind-of-actor check (organizer, and super_admin
     * via the wildcard); `event.moderate` is admin's bypass of the ownership
     * comparison, same pattern as eventRoutes.js's broadcast route.
     *
     * `organization.event.manage.own` is here because the host of a club's event
     * holds it and neither of the other two. Without it a Student Organizer was
     * refused the in-app announcement on their own event while
     * `POST /api/events/:id/broadcast` — which emails the same roster — accepted
     * them, and the composer rendered for them and 403'd on save.
     */
    if (!can(req.principal, 'announcement.post') && !can(req.principal, 'event.moderate')
        && !can(req.principal, 'organization.event.manage.own')) {
      return res.status(403).json({ error: 'Only the event organizer can post announcements' });
    }
    if (!await canRunEvent(db, event, req.principal.userId, { hasModerate: can(req.principal, 'event.moderate') })) {
      return res.status(403).json({ error: 'Only the event organizer can post announcements' });
    }

    const id = `ann-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await db.prepare(`
      INSERT INTO event_announcements (id, event_id, author_id, body, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, req.params.id, req.user.id, body.trim(), new Date().toISOString());

    // Tell everyone who is actually going
    const recipients = await db.prepare(`
      SELECT DISTINCT user_id FROM applications
      WHERE event_id = ? AND status = 'accepted'
    `).all(req.params.id);

    for (const r of recipients) {
      await notificationService.dispatch('IMPORTANT_ANNOUNCEMENT', { eventId: event.id, eventTitle: event.title, body: body.trim().slice(0, 140) }, r.user_id);
    }

    const created = await db.prepare(`
      SELECT n.*, u.name as author_name, u.avatar as author_avatar, u.role as author_role
      FROM event_announcements n JOIN users u ON n.author_id = u.id WHERE n.id = ?
    `).get(id);

    res.status(201).json({
      id: created.id,
      eventId: created.event_id,
      body: created.body,
      createdAt: created.created_at,
      updatedAt: created.updated_at,
      author: { id: created.author_id, name: created.author_name, avatar: created.author_avatar, role: created.author_role },
      notified: recipients.length
    });
  } catch (err) {
    console.error('Announcement create error:', err);
    res.status(500).json({ error: 'Failed to post announcement' });
  }
});

router.patch('/api/announcements/:id', authenticateToken, async (req, res) => {
  try {
    const { body } = req.body;
    if (!body || !body.trim()) return res.status(400).json({ error: 'Announcement cannot be empty' });

    const ann = await db.prepare('SELECT * FROM event_announcements WHERE id = ?').get(req.params.id);
    if (!ann) return res.status(404).json({ error: 'Announcement not found' });
    if (!can(req.principal, 'announcement.post') && !can(req.principal, 'event.moderate')) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (ann.author_id !== req.principal.userId && !can(req.principal, 'event.moderate')) {
      return res.status(403).json({ error: 'Access denied' });
    }

    await db.prepare('UPDATE event_announcements SET body = ?, updated_at = ? WHERE id = ?')
      .run(body.trim(), new Date().toISOString(), req.params.id);

    res.json({ success: true });
  } catch (err) {
    console.error('Announcement update error:', err);
    res.status(500).json({ error: 'Failed to update announcement' });
  }
});

router.delete('/api/announcements/:id', authenticateToken, async (req, res) => {
  try {
    const ann = await db.prepare('SELECT * FROM event_announcements WHERE id = ?').get(req.params.id);
    if (!ann) return res.status(404).json({ error: 'Announcement not found' });
    if (!can(req.principal, 'announcement.post') && !can(req.principal, 'event.moderate')) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (ann.author_id !== req.principal.userId && !can(req.principal, 'event.moderate')) {
      return res.status(403).json({ error: 'Access denied' });
    }
    await db.prepare('DELETE FROM event_announcements WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('Announcement delete error:', err);
    res.status(500).json({ error: 'Failed to delete announcement' });
  }
});

// ── Volunteer profile ───────────────────────────────────────────────
// A record of service, not a social page. Anyone signed in can view it:
// organizers need it to judge applications, and students see their own.

router.get('/api/favorites', authenticateToken, async (req, res) => {
  try {
    const rows = await db.prepare(`
      SELECT event_id, created_at FROM user_favorites WHERE user_id = ?
      ORDER BY created_at DESC
    `).all(req.user.id);
    res.json(rows.map(r => ({ eventId: r.event_id, createdAt: r.created_at })));
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch favorites' });
  }
});

router.post('/api/favorites/:eventId', authenticateToken, async (req, res) => {
  try {
    const eventId = req.params.eventId;
    const event = await db.prepare('SELECT id FROM events WHERE id = ?').get(eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const existing = await db.prepare(`
      SELECT 1 FROM user_favorites WHERE user_id = ? AND event_id = ?
    `).get(req.user.id, eventId);
    if (existing) {
      await db.prepare('DELETE FROM user_favorites WHERE user_id = ? AND event_id = ?').run(req.user.id, eventId);
      return res.json({ favorited: false });
    }
    await db.prepare(`
      INSERT INTO user_favorites (user_id, event_id, created_at) VALUES (?, ?, ?)
    `).run(req.user.id, eventId, new Date().toISOString());
    res.json({ favorited: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to toggle favorite' });
  }
});

// 19. Profile update (self only)

/**
 * Everything the dashboard's insight section shows a volunteer about themselves.
 *
 * ── Why the body is one call ──
 *
 * The queries lived here, inline, which is why two of them were wrong in ways
 * nothing could see: `upcoming` scanned every slot in the database to answer a
 * question about one student and counted commitments to cancelled events, and
 * `monthlyHours` omitted quiet months so the chart's axis was a list of
 * qualifying months rather than a timeline. They are definitions, so they now
 * live in `volunteerInsights.js` where they can be tested without HTTP and
 * where the milestone derivation can be shared with the profile route.
 *
 * ── What was removed, deliberately ──
 *
 * `categoryHours` and `applications` were computed on every request and had
 * never been rendered by anything. `routes.volunteerInsights.test.js` asserts
 * they are gone, so adding either back is a decision somebody makes rather than
 * a shape that drifts.
 *
 * `serviceHourGoal` stays. It is the district's Silver Award threshold, derived
 * from `server/milestones.js` rather than restated, and it replaced two
 * hardcoded copies in two client views that could disagree with the milestone
 * rendered beside them.
 */
router.get('/api/stats/volunteer', authenticateToken, requireCap('stats.self'), async (req, res) => {
  try {
    res.json(await volunteerInsights(db, req.user.id));
  } catch (err) {
    console.error('Volunteer stats error:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// 21. Statistics endpoint for an organizer
router.get('/api/stats/organizer', authenticateToken, requireCap('analytics.own_events'), async (req, res) => {
  try {
    const eventCount = (await db.prepare(`
      SELECT COUNT(*) as c FROM events WHERE organizer_id = ?
    `).get(req.user.id)).c;
    const totalAccepted = (await db.prepare(`
      SELECT COUNT(*) as c FROM applications a
      JOIN events e ON a.event_id = e.id
      WHERE e.organizer_id = ? AND a.status = 'accepted'
    `).get(req.user.id)).c;
    const totalPending = (await db.prepare(`
      SELECT COUNT(*) as c FROM applications a
      JOIN events e ON a.event_id = e.id
      WHERE e.organizer_id = ? AND a.status = 'pending'
    `).get(req.user.id)).c;
    const hoursAwarded = (await db.prepare(`
      SELECT COALESCE(SUM(a.hours_awarded), 0) as h
      FROM attendance a
      JOIN events e ON a.event_id = e.id
      WHERE e.organizer_id = ? AND a.present = 1
    `).get(req.user.id)).h;

    // Per-event roster counts. Capacity is the sum of the event's slots —
    // there is no max_spots column on events.
    const perEvent = (await db.prepare(`
      SELECT e.id, e.title, e.status,
        (SELECT COUNT(*) FROM applications a WHERE a.event_id = e.id AND a.status = 'accepted') as accepted,
        (SELECT COUNT(*) FROM applications a WHERE a.event_id = e.id AND a.status = 'pending') as pending,
        (SELECT COALESCE(SUM(s.max_spots), 0) FROM slots s WHERE s.event_id = e.id) as maxSpots
      FROM events e WHERE e.organizer_id = ?
      ORDER BY e.created_at DESC
    `).all(req.user.id)).map(r => ({
      id: r.id,
      title: r.title,
      status: r.status,
      accepted: r.accepted,
      pending: r.pending,
      maxSpots: Number(r.maxSpots)
    }));

    res.json({
      eventCount, totalAccepted, totalPending,
      hoursAwarded: Number(hoursAwarded),
      perEvent
    });
  } catch (err) {
    console.error('Organizer stats error:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// 22. Leaderboard (requires login — prevents public student data exposure)
router.get('/api/leaderboard', authenticateToken, async (req, res) => {
  try {
    /**
     * The deleted-account clause is part of the identity check, not a filter.
     *
     * Deleting an account renames the row and keeps its role, its opt-in and
     * its attendance — so a tombstoned student went on holding a rank here,
     * under their anonymised name, with their hours intact, on a board they can
     * no longer ask to be removed from because the account is gone.
     */
    const rows = await db.prepare(`
      SELECT u.id, u.name, u.avatar,
             COALESCE(SUM(a.hours_awarded), 0) as hours,
             COUNT(DISTINCT a.slot_id) as shifts
      FROM users u
      LEFT JOIN attendance a ON a.user_id = u.id AND a.present = 1
      WHERE u.role = 'student' AND u.leaderboard_opt_in = 1
        AND u.account_status <> 'deleted'
        /**
         * And the service history is not private.
         *
         * Two opt-ins could otherwise point opposite ways: a student who joined
         * the leaderboard last term and has since set their hours to "Only me"
         * would still have their name and hour total published here — through a
         * different endpoint from the one the privacy setting guards, which is
         * exactly how a privacy control ends up being technically enforced and
         * practically useless.
         *
         * The narrower, more recent, more explicit answer wins. "Only me" is
         * not ambiguous, and a board is the most public surface on the platform.
         * Turning hours back to public restores the rank; nothing is lost.
         *
         * IS NOT 'private' rather than = 'public', matching
         * normaliseVisibility: anything unrecognised reads as public, so a NULL
         * on an older row keeps the behaviour it already had. (No backticks in
         * this comment: it lives inside a template literal, and one would end
         * the string mid-SQL — the same trap migration 046 records.)
         */
        AND ${nullSafeNotEquals(db, 'u.hours_visibility', "'private'")}
      GROUP BY u.id
      ORDER BY hours DESC, shifts DESC
      LIMIT 25
    `).all();
    res.json(rows.map((r, i) => ({
      rank: i + 1, id: r.id, name: r.name, avatar: r.avatar,
      hours: Number(r.hours), shifts: r.shifts
    })));
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
});

/**
 * How strongly each signal counts, in one place.
 *
 * Ordered by how much a student's own choice is behind it. A tag they picked as
 * a skill or hobby matching a tag an organizer put on an event is the strongest
 * evidence available here — both sides said the same word on purpose. A keyword
 * appearing somewhere in a description is the weakest, because "food" matches a
 * food pantry and also "food provided".
 *
 * Distance is deliberately small. It is worth surfacing and worth breaking ties
 * with, but a nearby event a student has no interest in is not a better
 * suggestion than an interesting one two miles further away.
 */
const RECOMMENDATION_WEIGHTS = Object.freeze({
  tag: 4,
  skillKeyword: 3,
  pastCategory: 2,
  nearby: 1,
});

/** Distance under which an event earns the proximity point, in miles. */
const NEARBY_MILES = 5;

/** Candidates scored in JS. Bounded so the work does not grow with the platform. */
const RECOMMENDATION_CANDIDATES = 60;

/**
 * The interests a student actually chose, as normalised tag keys.
 *
 * `skills` and `hobbies` are both JSON arrays of free text, and event tags are
 * stored normalised. Running both through `normaliseTag` is what lets
 * "Environment", "environment" and "#environment" match each other — the same
 * function the tag input and the browse filter use, so a match here means the
 * same thing it means there.
 */
function interestKeys(userRow) {
  const out = new Set();
  for (const field of ['skills', 'hobbies']) {
    let list = [];
    try {
      list = userRow?.[field] ? JSON.parse(userRow[field]) : [];
    } catch {
      /* A hand-edited or truncated value is not worth failing a page over. */
      list = [];
    }
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const normalised = normaliseTag(String(raw || ''));
      if (normalised) out.add(normalised.tag);
    }
  }
  return out;
}

// 23. Skill-based recommendations
router.get('/api/recommendations', authenticateToken, async (req, res) => {
  // Not a gate: recommendations are a student-only feature, but a non-student
  // caller gets an empty list, never a 403 — that is intentional, existing
  // behaviour (capability-mapping.md's Task 7d note), not an oversight to fix.
  if (!can(req.principal, 'event.apply')) return res.json([]);
  /**
   * Coordinates are optional, and validated on exactly the rules the browse
   * list uses — together or not at all, and in range. Rejecting rather than
   * ignoring a malformed pair matters because the failure would otherwise be
   * silent: distances would simply stop appearing, with nothing to say why.
   *
   * The client sends a coarsened centre (2 decimal places, about 1.1 km), the
   * same figure the browse filter sends, and recomputes the number it displays
   * from the exact position that never leaves the device.
   */
  const hasLat = req.query.lat != null && String(req.query.lat) !== '';
  const hasLng = req.query.lng != null && String(req.query.lng) !== '';
  if (hasLat !== hasLng) {
    return res.status(400).json({ error: 'lat and lng must be supplied together.' });
  }

  let lat = null;
  let lng = null;
  if (hasLat) {
    lat = Number(req.query.lat);
    lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      return res.status(400).json({ error: 'lat must be between -90 and 90.' });
    }
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
      return res.status(400).json({ error: 'lng must be between -180 and 180.' });
    }
  }

  try {
    const userRow = await db.prepare('SELECT skills, hobbies FROM users WHERE id = ?').get(req.user.id);
    const userSkills = (() => {
      try {
        const parsed = userRow?.skills ? JSON.parse(userRow.skills) : [];
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    })();
    const interests = interestKeys(userRow);

    // Get past categories the user has volunteered in
    const pastCategories = (await db.prepare(`
      SELECT DISTINCT e.category
      FROM applications a
      JOIN events e ON a.event_id = e.id
      WHERE a.user_id = ? AND a.status = 'accepted'
    `).all(req.user.id)).map(r => r.category);

    /**
     * Events a student could actually still apply to.
     *
     * This was `WHERE e.status = 'open'` and nothing more. `status` stays 'open'
     * for an event's whole life — it only becomes 'completed' when an organizer
     * finalises attendance, which many never do — so events whose shifts had
     * ended weeks ago kept being suggested on the Opportunities page. Verified
     * against a live server: an event with a deadline 5 days past and a shift
     * that ended 3 days ago was correctly excluded from `?openOnly=true` and
     * still came back from here.
     *
     * "Open" means the same three things it means everywhere else in the app
     * (see `openOnly` in eventQuery.js): posted open, deadline not passed, and a
     * free spot. Checking only the first also meant a full event could be
     * suggested — an invitation to apply for nothing.
     *
     * The remaining-shift check is belt-and-braces rather than redundant:
     * validateEventPayload enforces deadline <= first shift start, so a passed
     * shift implies a passed deadline for anything created through the API — but
     * seeded and migrated rows do not go through that validator.
     */
    /**
     * Candidates, filtered and bounded in SQL.
     *
     * The already-applied-to exclusion used to happen in JavaScript, after
     * every open event on the platform had been loaded into memory and scored.
     * That is the same shape as the problem `eventQuery.js` was written to fix
     * — a predicate the database can answer being answered by the application
     * instead — and adding distance and tag scoring on top of it would have
     * made a known throughput ceiling worse.
     *
     * `ORDER BY deadline` before the LIMIT means the bound falls on the events
     * furthest from closing, which are the least urgent ones to suggest. The
     * distance expression comes from `eventQueryFragments`, so there is one
     * haversine in this codebase rather than two that can disagree.
     */
    const { distanceSelect } = eventQueryFragments({ lat, lng, db });
    const params = { now: new Date().toISOString(), userId: req.user.id, limit: RECOMMENDATION_CANDIDATES };
    if (lat != null) { params.lat = lat; params.lng = lng; }

    const events = await db.prepare(`
      SELECT e.*, u.name as organizer_name, ${distanceSelect}
      FROM events e
      JOIN users u ON e.organizer_id = u.id
      WHERE e.status = 'open'
        AND e.application_deadline > @now
        AND EXISTS (
          SELECT 1 FROM slots s WHERE s.event_id = e.id AND s.end_datetime > @now
        )
        AND (
          SELECT COALESCE(SUM(s.max_spots), 0) FROM slots s WHERE s.event_id = e.id
        ) > (
          SELECT COUNT(*) FROM applications a
          WHERE a.event_id = e.id AND a.status = 'accepted'
        )
        AND NOT EXISTS (
          SELECT 1 FROM applications a2
          WHERE a2.event_id = e.id AND a2.user_id = @userId
        )
      ORDER BY e.application_deadline ASC
      LIMIT @limit
    `).all(params);

    /* Batched, so adding tag scoring does not add a query per candidate. */
    const tagsByEvent = await tagsForEvents(db, events.map(e => e.id));

    /**
     * Score, and record why.
     *
     * Every reason is emitted only when the term that produced it actually
     * fired, so the explanation shown to a student is the real basis for the
     * ranking rather than a plausible-sounding restatement of it. That is the
     * whole point of returning reasons instead of a number: a suggestion a
     * person cannot account for is one they cannot disagree with.
     */
    const scoredAll = events.map(e => {
      let score = 0;
      const reasons = [];

      const eventTags = tagsByEvent[e.id] || [];
      for (const tag of eventTags) {
        if (interests.has(tag.tag)) {
          score += RECOMMENDATION_WEIGHTS.tag;
          reasons.push({ kind: 'tag', value: tag.label });
        }
      }

      const desc = (e.description || '').toLowerCase();
      const title = (e.title || '').toLowerCase();
      for (const skill of userSkills) {
        const k = String(skill || '').toLowerCase();
        /* Skipped when the tag term already matched the same word, so one
           interest cannot be counted twice and listed twice. */
        if (!k || interests.has(normaliseTag(k)?.tag)) continue;
        if (desc.includes(k) || title.includes(k)) {
          score += RECOMMENDATION_WEIGHTS.skillKeyword;
          reasons.push({ kind: 'skill', value: skill });
        }
      }

      if (pastCategories.includes(e.category)) {
        score += RECOMMENDATION_WEIGHTS.pastCategory;
        reasons.push({ kind: 'category', value: e.category });
      }

      const distance = typeof e.distance_miles === 'number' ? e.distance_miles : null;
      if (distance != null && distance <= NEARBY_MILES) {
        score += RECOMMENDATION_WEIGHTS.nearby;
        reasons.push({ kind: 'distance', miles: Math.round(distance * 10) / 10 });
      }

      return { event: e, score, reasons, distance, tags: eventTags };
    });

    let scored = scoredAll
      .filter(s => s.score > 0)
      /* Distance breaks ties, so two equally relevant events are ordered by
         which one a student could actually get to. Nulls sort last. */
      .sort((a, b) => b.score - a.score
        || (a.distance ?? Infinity) - (b.distance ?? Infinity))
      .slice(0, 6);

    if (scored.length === 0) {
      /* Nothing matched. The candidates are already ordered by soonest
         deadline, so the first three are the fallback — and they carry no
         reasons, because there are none. */
      scored = scoredAll.slice(0, 3).map(s => ({ ...s, score: 0, reasons: [] }));
    }

    /**
     * `score` is kept alongside `reasons`.
     *
     * It is what `BrowseEvents` reads to decide between the "Suggested for you"
     * and "Upcoming opportunities" headings, and removing it would silently
     * change that heading for everyone. The two say different things: the score
     * ranks, the reasons explain.
     *
     * Coordinates are not echoed back. The client already knows where it is,
     * and the distance it displays is recomputed from the exact position rather
     * than from this figure, which is measured from the coarsened centre and
     * can be off by up to about half a mile.
     */
    res.json(scored.map(s => ({
      id: s.event.id, title: s.event.title, description: s.event.description,
      category: s.event.category, location: s.event.location,
      applicationDeadline: s.event.application_deadline,
      organizerName: s.event.organizer_name, score: s.score,
      reasons: s.reasons,
      distance: s.distance,
      tags: s.tags,
      latitude: s.event.latitude, longitude: s.event.longitude,
    })));
  } catch (err) {
    console.error('Recommendations error:', err);
    res.status(500).json({ error: 'Failed to fetch recommendations' });
  }
});

// 24. Duplicate an event (organizer only)



export default router;
