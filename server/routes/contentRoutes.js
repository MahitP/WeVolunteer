import express from 'express';
import crypto from 'crypto';

import { authenticateToken, createNotification } from '../utils.js';
import { db } from '../db.js';

const router = express.Router();

router.get('/api/notifications', authenticateToken, (req, res) => {
  try {
    // The centre asks for more than the bell does
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const rows = db.prepare(`
      SELECT * FROM notifications WHERE user_id = ?
      ORDER BY created_at DESC LIMIT ?
    `).all(req.user.id, limit);
    const unread = db.prepare(`
      SELECT COUNT(*) as c FROM notifications WHERE user_id = ? AND read = 0
    `).get(req.user.id).c;
    res.json({
      notifications: rows.map(r => ({
        id: r.id, kind: r.kind, title: r.title, body: r.body,
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
    } else if (Array.isArray(ids) && ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      db.prepare(`UPDATE notifications SET read = 1 WHERE id IN (${placeholders}) AND user_id = ?`)
        .run(...ids, req.user.id);
    }
    res.json({ success: true });
  } catch (err) {
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
      createNotification({
        userId: event.organizer_id,
        kind: 'comment',
        title: 'New question on your event',
        body: `${commenterName} commented on "${event.title}".`,
        link: `event:${event.id}`
      });
    } else {
      // The organizer is the commenter. Notify all pending or accepted applicants.
      const applicants = db.prepare(`
        SELECT DISTINCT user_id FROM applications
        WHERE event_id = ? AND status IN ('accepted', 'pending')
      `).all(req.params.id);

      for (const app of applicants) {
        if (app.user_id !== req.user.id) {
          createNotification({
            userId: app.user_id,
            kind: 'comment',
            title: 'Host posted an update',
            body: `The coordinator commented on "${event.title}": "${body.substring(0, 60)}${body.length > 60 ? '...' : ''}"`,
            link: `event:${event.id}`
          });
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
    if (cmt.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }
    db.prepare('DELETE FROM event_comments WHERE id = ?').run(req.params.id);
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

    const isStaff = req.user.role === 'admin' ||
      (req.user.role === 'organizer' && event.organizer_id === req.user.id);

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

    res.json({
      visible: true,
      attendees: rows.map(r => ({
        id: r.id, name: r.name, avatar: r.avatar, grade: r.grade, school: r.school
      }))
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

    const isStaff = req.user.role === 'admin' ||
      (req.user.role === 'organizer' && event.organizer_id === req.user.id);

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
    if (event.organizer_id !== req.user.id && req.user.role !== 'admin') {
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
      createNotification({
        userId: r.user_id,
        kind: 'announcement',
        title: `Update: ${event.title}`,
        body: body.trim().slice(0, 140),
        link: `event:${event.id}`
      });
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
    if (ann.author_id !== req.user.id && req.user.role !== 'admin') {
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
    if (ann.author_id !== req.user.id && req.user.role !== 'admin') {
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
  } catch {
    res.status(500).json({ error: 'Failed to toggle favorite' });
  }
});

// 19. Profile update (self only)

router.get('/api/stats/volunteer', authenticateToken, (req, res) => {
  if (req.user.role !== 'student') {
    return res.status(403).json({ error: 'Volunteer stats only available for students' });
  }
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
        AND slot_id IN (SELECT id FROM slots WHERE end_datetime > datetime('now'))
    `).get(req.user.id).c;

    res.json({
      monthlyHours: monthlyHours.map(m => ({ month: m.month, hours: Number(m.hours) })),
      categoryHours: categoryHours.map(c => ({ category: c.category, hours: Number(c.hours) })),
      applications: appStats.reduce((acc, s) => ({ ...acc, [s.status]: s.c }), {}),
      upcomingCount: upcoming
    });
  } catch (err) {
    console.error('Volunteer stats error:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// 21. Statistics endpoint for an organizer
router.get('/api/stats/organizer', authenticateToken, (req, res) => {
  if (req.user.role !== 'organizer') {
    return res.status(403).json({ error: 'Organizer stats only available for organizers' });
  }
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
  } catch {
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
});

// 23. Skill-based recommendations
router.get('/api/recommendations', authenticateToken, (req, res) => {
  if (req.user.role !== 'student') return res.json([]);
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

    // Get all open events
    const events = db.prepare(`
      SELECT e.*, u.name as organizer_name FROM events e
      JOIN users u ON e.organizer_id = u.id
      WHERE e.status = 'open'
    `).all();

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

// 31. Submit a Report
router.post('/api/reports', authenticateToken, (req, res) => {
  const { targetType, targetId, reason } = req.body;
  if (!targetType || !targetId || !reason) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  if (targetType !== 'event' && targetType !== 'comment') {
    return res.status(400).json({ error: 'Invalid target type' });
  }

  // A non-string targetId/reason passes the presence check above (an object is
  // truthy) but cannot be bound by node:sqlite, which would surface a client
  // mistake as a 500.
  if (typeof targetId !== 'string' || typeof reason !== 'string') {
    return res.status(400).json({ error: 'targetId and reason must be text' });
  }
  if (reason.length > 1000) {
    return res.status(400).json({ error: 'Reason is too long (max 1000 characters)' });
  }

  try {
    const id = 'rep_' + crypto.randomBytes(8).toString('hex');
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO reports (id, reporter_id, target_type, target_id, reason, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'open', ?)
    `).run(id, req.user.id, targetType, targetId, reason, now);

    res.json({ success: true, message: 'Report submitted successfully' });
  } catch (err) {
    console.error('Submit report error:', err);
    res.status(500).json({ error: 'Failed to submit report' });
  }
});

export default router;
