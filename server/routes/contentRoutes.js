import express from 'express';
import crypto from 'crypto';

import { authenticateToken, inTransaction } from '../utils.js';
import { can, requireCap } from '../authz.js';
import { recordAudit } from '../auditLog.js';
import { notificationService } from '../services/notificationService.js';
import { emitToUser } from '../realtime/events.js';
import { db } from '../db.js';
/* Derived from the Silver tier, so the meter and the milestone cannot disagree
   about what Silver means. See server/milestones.js. */
import { SERVICE_HOUR_GOAL } from '../milestones.js';
import { commentHasLiveReport, COMMENT_HELD_MESSAGE } from '../evidenceHolds.js';

const router = express.Router();

router.get('/api/notifications', authenticateToken, (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const rows = db.prepare(`
      SELECT * FROM notifications WHERE user_id = ?
      ORDER BY created_at DESC LIMIT ? OFFSET ?
    `).all(req.user.id, limit, offset);
    const unread = db.prepare(`
      SELECT COUNT(*) as c FROM notifications WHERE user_id = ? AND read = 0
    `).get(req.user.id).c;
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
router.patch('/api/notifications', authenticateToken, (req, res) => {
  try {
    const { ids, all } = req.body;
    if (all) {
      db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(req.user.id);
      emitToUser(req.user.id, 'notification.read', null, { all: true });
    } else if (Array.isArray(ids) && ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      db.prepare(`UPDATE notifications SET read = 1 WHERE id IN (${placeholders}) AND user_id = ?`)
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

router.get('/api/events/:id/comments', authenticateToken, (req, res) => {
  try {
    const rows = db.prepare(`
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

router.post('/api/events/:id/comments', authenticateToken, (req, res) => {
  try {
    const { body } = req.body;
    if (!body || !body.trim()) return res.status(400).json({ error: 'Comment cannot be empty' });
    if (body.length > 1000) return res.status(400).json({ error: 'Comment is too long (max 1000 chars)' });

    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const id = `cmt-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
    db.prepare(`
      INSERT INTO event_comments (id, event_id, user_id, body, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, req.params.id, req.user.id, body.trim(), new Date().toISOString());

    // Notify the organizer of the new comment (if not the commenter)
    if (event.organizer_id !== req.user.id) {
      const commenterRow = db.prepare('SELECT name FROM users WHERE id = ?').get(req.user.id);
      const commenterName = commenterRow ? commenterRow.name : 'Someone';
      notificationService.dispatch('EVENT_COMMENT', { eventId: event.id, eventTitle: event.title }, event.organizer_id);
    } else {
      // The organizer is the commenter. Notify all pending or accepted applicants.
      const applicants = db.prepare(`
        SELECT DISTINCT user_id FROM applications
        WHERE event_id = ? AND status IN ('accepted', 'pending')
      `).all(req.params.id);

      for (const app of applicants) {
        if (app.user_id !== req.user.id) {
          notificationService.dispatch('EVENT_COMMENT', { eventId: event.id, eventTitle: event.title }, app.user_id);
        }
      }
    }

    const created = db.prepare(`
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

router.delete('/api/comments/:id', authenticateToken, (req, res) => {
  try {
    const cmt = db.prepare('SELECT * FROM event_comments WHERE id = ?').get(req.params.id);
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
    if (commentHasLiveReport(db, req.params.id)) {
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

    inTransaction(() => {
      db.prepare('DELETE FROM event_comments WHERE id = ?').run(req.params.id);

      if (moderating) {
        recordAudit(db, {
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

router.get('/api/events/:id/attendees', authenticateToken, (req, res) => {
  try {
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const isStaff = can(req.principal, 'event.moderate') || event.organizer_id === req.principal.userId;

    if (!isStaff) {
      const mine = db.prepare(`
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

    const rows = db.prepare(`
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

router.get('/api/events/:id/announcements', authenticateToken, (req, res) => {
  try {
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const isStaff = can(req.principal, 'event.moderate') || event.organizer_id === req.principal.userId;

    if (!isStaff) {
      const mine = db.prepare(`
        SELECT 1 FROM applications
        WHERE event_id = ? AND user_id = ? AND status = 'accepted'
      `).get(req.params.id, req.user.id);

      if (!mine) return res.json([]);
    }

    const rows = db.prepare(`
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

router.post('/api/events/:id/announcements', authenticateToken, (req, res) => {
  try {
    const { body } = req.body;
    if (!body || !body.trim()) return res.status(400).json({ error: 'Announcement cannot be empty' });
    if (body.length > 2000) return res.status(400).json({ error: 'Announcement is too long (max 2000 characters)' });

    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    // `announcement.post` is the kind-of-actor check (organizer, and
    // super_admin via the wildcard); `event.moderate` is admin's bypass of the
    // ownership comparison, same pattern as eventRoutes.js's broadcast route.
    if (!can(req.principal, 'announcement.post') && !can(req.principal, 'event.moderate')) {
      return res.status(403).json({ error: 'Only the event organizer can post announcements' });
    }
    if (event.organizer_id !== req.principal.userId && !can(req.principal, 'event.moderate')) {
      return res.status(403).json({ error: 'Only the event organizer can post announcements' });
    }

    const id = `ann-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    db.prepare(`
      INSERT INTO event_announcements (id, event_id, author_id, body, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, req.params.id, req.user.id, body.trim(), new Date().toISOString());

    // Tell everyone who is actually going
    const recipients = db.prepare(`
      SELECT DISTINCT user_id FROM applications
      WHERE event_id = ? AND status = 'accepted'
    `).all(req.params.id);

    for (const r of recipients) {
      notificationService.dispatch('IMPORTANT_ANNOUNCEMENT', { eventId: event.id, eventTitle: event.title, body: body.trim().slice(0, 140) }, r.user_id);
    }

    const created = db.prepare(`
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

router.patch('/api/announcements/:id', authenticateToken, (req, res) => {
  try {
    const { body } = req.body;
    if (!body || !body.trim()) return res.status(400).json({ error: 'Announcement cannot be empty' });

    const ann = db.prepare('SELECT * FROM event_announcements WHERE id = ?').get(req.params.id);
    if (!ann) return res.status(404).json({ error: 'Announcement not found' });
    if (!can(req.principal, 'announcement.post') && !can(req.principal, 'event.moderate')) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (ann.author_id !== req.principal.userId && !can(req.principal, 'event.moderate')) {
      return res.status(403).json({ error: 'Access denied' });
    }

    db.prepare('UPDATE event_announcements SET body = ?, updated_at = ? WHERE id = ?')
      .run(body.trim(), new Date().toISOString(), req.params.id);

    res.json({ success: true });
  } catch (err) {
    console.error('Announcement update error:', err);
    res.status(500).json({ error: 'Failed to update announcement' });
  }
});

router.delete('/api/announcements/:id', authenticateToken, (req, res) => {
  try {
    const ann = db.prepare('SELECT * FROM event_announcements WHERE id = ?').get(req.params.id);
    if (!ann) return res.status(404).json({ error: 'Announcement not found' });
    if (!can(req.principal, 'announcement.post') && !can(req.principal, 'event.moderate')) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (ann.author_id !== req.principal.userId && !can(req.principal, 'event.moderate')) {
      return res.status(403).json({ error: 'Access denied' });
    }
    db.prepare('DELETE FROM event_announcements WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('Announcement delete error:', err);
    res.status(500).json({ error: 'Failed to delete announcement' });
  }
});

// ── Volunteer profile ───────────────────────────────────────────────
// A record of service, not a social page. Anyone signed in can view it:
// organizers need it to judge applications, and students see their own.

router.get('/api/favorites', authenticateToken, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT event_id, created_at FROM user_favorites WHERE user_id = ?
      ORDER BY created_at DESC
    `).all(req.user.id);
    res.json(rows.map(r => ({ eventId: r.event_id, createdAt: r.created_at })));
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch favorites' });
  }
});

router.post('/api/favorites/:eventId', authenticateToken, (req, res) => {
  try {
    const eventId = req.params.eventId;
    const event = db.prepare('SELECT id FROM events WHERE id = ?').get(eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const existing = db.prepare(`
      SELECT 1 FROM user_favorites WHERE user_id = ? AND event_id = ?
    `).get(req.user.id, eventId);
    if (existing) {
      db.prepare('DELETE FROM user_favorites WHERE user_id = ? AND event_id = ?').run(req.user.id, eventId);
      return res.json({ favorited: false });
    }
    db.prepare(`
      INSERT INTO user_favorites (user_id, event_id, created_at) VALUES (?, ?, ?)
    `).run(req.user.id, eventId, new Date().toISOString());
    res.json({ favorited: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to toggle favorite' });
  }
});

// 19. Profile update (self only)

router.get('/api/stats/volunteer', authenticateToken, requireCap('stats.self'), (req, res) => {
  try {
    // Hours by month for last 6 months
    const monthlyHours = db.prepare(`
      SELECT strftime('%Y-%m', s.end_datetime) as month,
             SUM(a.hours_awarded) as hours
      FROM attendance a
      JOIN slots s ON a.slot_id = s.id
      WHERE a.user_id = ? AND a.present = 1
        AND s.end_datetime >= date('now', '-6 months')
      GROUP BY month
      ORDER BY month ASC
    `).all(req.user.id);

    // Hours by category
    const categoryHours = db.prepare(`
      SELECT e.category as category, SUM(a.hours_awarded) as hours
      FROM attendance a
      JOIN slots s ON a.slot_id = s.id
      JOIN events e ON s.event_id = e.id
      WHERE a.user_id = ? AND a.present = 1
      GROUP BY e.category
    `).all(req.user.id);

    // Application stats
    const appStats = db.prepare(`
      SELECT status, COUNT(*) as c FROM applications
      WHERE user_id = ? GROUP BY status
    `).all(req.user.id);

    // Upcoming vs completed
    const upcoming = db.prepare(`
      SELECT COUNT(*) as c FROM applications
      WHERE user_id = ? AND status = 'accepted'
        AND slot_id IN (SELECT id FROM slots WHERE end_datetime > ?)
    `).get(req.user.id, new Date().toISOString()).c;

    res.json({
      monthlyHours: monthlyHours.map(m => ({ month: m.month, hours: Number(m.hours) })),
      categoryHours: categoryHours.map(c => ({ category: c.category, hours: Number(c.hours) })),
      applications: appStats.reduce((acc, s) => ({ ...acc, [s.status]: s.c }), {}),
      upcomingCount: upcoming,
      /**
       * The hours figure the dashboard draws its progress meter against.
       *
       * Sent rather than known, because it was `const HOUR_GOAL = 25` in
       * VolunteerDashboard.jsx and again in VolunteerProfile.jsx — two copies of
       * the district's Silver Award threshold, in a different language from the
       * server that decides whether the milestone is earned. Nothing could check
       * them against it, so the meter could read "8 hours to go" beside a
       * milestone already rendered as achieved. It is derived from the Silver
       * tier in server/milestones.js, so there is one number.
       */
      serviceHourGoal: SERVICE_HOUR_GOAL
    });
  } catch (err) {
    console.error('Volunteer stats error:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// 21. Statistics endpoint for an organizer
router.get('/api/stats/organizer', authenticateToken, requireCap('analytics.own_events'), (req, res) => {
  try {
    const eventCount = db.prepare(`
      SELECT COUNT(*) as c FROM events WHERE organizer_id = ?
    `).get(req.user.id).c;
    const totalAccepted = db.prepare(`
      SELECT COUNT(*) as c FROM applications a
      JOIN events e ON a.event_id = e.id
      WHERE e.organizer_id = ? AND a.status = 'accepted'
    `).get(req.user.id).c;
    const totalPending = db.prepare(`
      SELECT COUNT(*) as c FROM applications a
      JOIN events e ON a.event_id = e.id
      WHERE e.organizer_id = ? AND a.status = 'pending'
    `).get(req.user.id).c;
    const hoursAwarded = db.prepare(`
      SELECT COALESCE(SUM(a.hours_awarded), 0) as h
      FROM attendance a
      JOIN events e ON a.event_id = e.id
      WHERE e.organizer_id = ? AND a.present = 1
    `).get(req.user.id).h;

    // Per-event roster counts. Capacity is the sum of the event's slots —
    // there is no max_spots column on events.
    const perEvent = db.prepare(`
      SELECT e.id, e.title, e.status,
        (SELECT COUNT(*) FROM applications a WHERE a.event_id = e.id AND a.status = 'accepted') as accepted,
        (SELECT COUNT(*) FROM applications a WHERE a.event_id = e.id AND a.status = 'pending') as pending,
        (SELECT COALESCE(SUM(s.max_spots), 0) FROM slots s WHERE s.event_id = e.id) as maxSpots
      FROM events e WHERE e.organizer_id = ?
      ORDER BY e.created_at DESC
    `).all(req.user.id).map(r => ({
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
router.get('/api/leaderboard', authenticateToken, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT u.id, u.name, u.avatar,
             COALESCE(SUM(a.hours_awarded), 0) as hours,
             COUNT(DISTINCT a.slot_id) as shifts
      FROM users u
      LEFT JOIN attendance a ON a.user_id = u.id AND a.present = 1
      WHERE u.role = 'student' AND u.leaderboard_opt_in = 1
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

// 23. Skill-based recommendations
router.get('/api/recommendations', authenticateToken, (req, res) => {
  // Not a gate: recommendations are a student-only feature, but a non-student
  // caller gets an empty list, never a 403 — that is intentional, existing
  // behaviour (capability-mapping.md's Task 7d note), not an oversight to fix.
  if (!can(req.principal, 'event.apply')) return res.json([]);
  try {
    // Get user's skills
    const userRow = db.prepare('SELECT skills FROM users WHERE id = ?').get(req.user.id);
    const userSkills = userRow && userRow.skills ? JSON.parse(userRow.skills) : [];

    // Get events user has already applied to
    const appliedEventIds = db.prepare(`
      SELECT DISTINCT event_id FROM applications WHERE user_id = ?
    `).all(req.user.id).map(r => r.event_id);

    // Get past categories the user has volunteered in
    const pastCategories = db.prepare(`
      SELECT DISTINCT e.category
      FROM applications a
      JOIN events e ON a.event_id = e.id
      WHERE a.user_id = ? AND a.status = 'accepted'
    `).all(req.user.id).map(r => r.category);

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
    const events = db.prepare(`
      SELECT e.*, u.name as organizer_name FROM events e
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
    `).all({ now: new Date().toISOString() });

    // Score each event
    let scored = events
      .filter(e => !appliedEventIds.includes(e.id))
      .map(e => {
        let score = 0;
        const desc = (e.description || '').toLowerCase();
        const title = (e.title || '').toLowerCase();
        // Match by skill keyword
        for (const skill of userSkills) {
          const k = skill.toLowerCase();
          if (k && (desc.includes(k) || title.includes(k))) score += 3;
        }
        // Match by past category
        if (pastCategories.includes(e.category)) score += 2;
        return { event: e, score };
      })
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);

    if (scored.length === 0) {
      // Fallback: next 3 open events not applied to yet, sorted by deadline (soonest first)
      const fallbacks = events
        .filter(e => !appliedEventIds.includes(e.id))
        .sort((a, b) => new Date(a.application_deadline) - new Date(b.application_deadline))
        .slice(0, 3);

      scored = fallbacks.map(e => ({ event: e, score: 0 }));
    }

    res.json(scored.map(s => ({
      id: s.event.id, title: s.event.title, description: s.event.description,
      category: s.event.category, location: s.event.location,
      applicationDeadline: s.event.application_deadline,
      organizerName: s.event.organizer_name, score: s.score
    })));
  } catch (err) {
    console.error('Recommendations error:', err);
    res.status(500).json({ error: 'Failed to fetch recommendations' });
  }
});

// 24. Duplicate an event (organizer only)



export default router;
