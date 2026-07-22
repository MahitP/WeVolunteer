import express from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { sendVerificationEmail, sendPasswordResetEmail } from '../email.js';
import { VALID_GRADES } from '../config.js';
import { createRandom, performWeightedSelection } from '../weighting.js';
import { recordCheckins, getCheckins, finalizeAttendance, computeEventCompletion, attendanceOnSlots, eventAttendanceCount } from '../attendance.js';
import { authenticateToken, formatUserResponse, inTransaction, createNotification, runNotificationSweep, countdownPhrase, notifyConfirmedVolunteers, handleWaitlistPromotion, certificateCode } from '../utils.js';
import { db } from '../db.js';

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
    
    if (req.user.role === 'student') {
      rows = db.prepare(`${BASE_QUERY} WHERE a.user_id = ?`).all(req.user.id);
    } else if (req.user.role === 'organizer') {
      rows = db.prepare(`${BASE_QUERY} WHERE e.organizer_id = ?`).all(req.user.id);
    } else {
      rows = db.prepare(BASE_QUERY).all();
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
          bio: r.bio,
          skills: r.skills ? JSON.parse(r.skills) : []
        },
        attendance
      };
    });

    res.json(formattedApps);
  } catch (error) {
    console.error('Fetch applications error:', error);
    res.status(500).json({ error: 'Internal server error fetching applications' });
  }
});

// 7. Apply to an Event Slot (Student only)
router.post('/api/events/:id/apply', authenticateToken, (req, res) => {
  if (req.user.role !== 'student') {
    return res.status(403).json({ error: 'Access denied: Only students can apply for events' });
  }

  const eventId = req.params.id;
  const { slotId } = req.body;

  if (!slotId) {
    return res.status(400).json({ error: 'Required slotId missing' });
  }

  try {
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (event.status !== 'open') return res.status(400).json({ error: 'Event registrations are closed' });

    // Verify slot belongs to event
    const slot = db.prepare('SELECT * FROM slots WHERE id = ? AND event_id = ?').get(slotId, eventId);
    if (!slot) return res.status(404).json({ error: 'Selected slot does not belong to this event' });

    // Enforce deadline check
    const now = new Date();
    if (now > new Date(event.application_deadline)) {
      return res.status(400).json({ error: 'Application deadline has passed. Sign-ups are closed.' });
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

    // Notify organizer
    createNotification({
      userId: event.organizer_id,
      kind: 'application',
      title: 'New volunteer application',
      body: `A student applied to "${event.title}".`,
      link: `event:${event.id}`
    });

    res.status(201).json({
      success: true,
      application: { id: appId, eventId, slotId, userId: req.user.id, status, appliedAt }
    });
  } catch (error) {
    console.error('Apply error:', error);
    res.status(500).json({ error: 'Internal server error applying to event' });
  }
});

// 8a. Bulk update application status (Organizer only).
//
// Registered BEFORE /api/applications/:id, because that route's :id parameter
// would otherwise capture the literal "bulk". Mirrors the single-application
// organizer branch below exactly — same allowed statuses, same ownership and
// capacity rules — so the two cannot diverge. All writes happen in one
// transaction; notifications and waitlist promotion run only after it commits,
// because createNotification performs its own writes.
router.patch('/api/applications/bulk', authenticateToken, (req, res) => {
  if (req.user.role !== 'organizer') {
    return res.status(403).json({ error: 'Access denied: Only organizers can manage application status' });
  }

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
      if (app.organizer_id !== req.user.id) {
        return res.status(403).json({ error: 'Access denied: You do not host this event' });
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
        update.run(status, app.id);
        applied.push({ id: app.id, status, userId: app.user_id, eventId: app.event_id, eventTitle: app.event_title });

        if (wasAccepted && status !== 'accepted' && app.auto_approve === 1) {
          promotions.push({ slotId: app.slot_id, eventId: app.event_id, eventTitle: app.event_title, organizerId: app.organizer_id });
        }
      }
    });

    // After the commit: fill any spots freed by a demotion, then notify.
    for (const p of promotions) {
      handleWaitlistPromotion(p.slotId, p.eventId, p.eventTitle, p.organizerId);
    }
    for (const a of applied) {
      createNotification({
        userId: a.userId,
        kind: status === 'accepted' ? 'accepted' : status === 'waitlisted' ? 'waitlisted' : 'declined',
        title: `Application ${status}`,
        body: `Your application for "${a.eventTitle}" was ${status}.`,
        link: `event:${a.eventId}`
      });
    }

    res.json({ success: true, updated: applied.length, applied, skipped });
  } catch (error) {
    console.error('Bulk update app status error:', error);
    res.status(500).json({ error: 'Internal server error updating applications' });
  }
});

// 8. Update Application Status (Organizer: accept/waitlist/reject · Student: withdraw own)
router.patch('/api/applications/:id', authenticateToken, (req, res) => {
  const appId = req.params.id;
  const { status } = req.body; // 'accepted', 'waitlisted', 'rejected'

  // Students can only withdraw their own applications
  if (req.user.role === 'student') {
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
      if (app.user_id !== req.user.id) {
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

      db.prepare('UPDATE applications SET status = ?, waitlist_order = NULL WHERE id = ?')
        .run('withdrawn', appId);

      if (wasConfirmed) {
        // Notify student releasing spot
        createNotification({
          userId: app.user_id,
          kind: 'application',
          title: 'Spot released',
          body: `You successfully released your spot for "${app.event_title}" — ${app.slot_name}.`,
          link: `event:${app.event_id}`
        });

        // Notify organizer
        createNotification({
          userId: app.organizer_id,
          kind: 'application',
          title: 'A volunteer released their spot',
          body: `${req.user.name || 'A volunteer'} can no longer make "${app.event_title}" — ${app.slot_name}. The spot has been filled or reopened.`,
          link: `event:${app.event_id}`
        });

        // Auto Select waitlist promotion check
        const event = db.prepare('SELECT auto_approve FROM events WHERE id = ?').get(app.event_id);
        if (event && event.auto_approve === 1) {
          handleWaitlistPromotion(app.slot_id, app.event_id, app.event_title, app.organizer_id);
        }
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

  if (req.user.role !== 'organizer') {
    return res.status(403).json({ error: 'Access denied: Only organizers can manage application status' });
  }

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
    if (app.organizer_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied: You do not host this event' });
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

    db.prepare('UPDATE applications SET status = ? WHERE id = ?').run(status, appId);

    // If they were accepted and are no longer accepted, trigger waitlist promotion
    if (wasAccepted && status !== 'accepted') {
      const event = db.prepare('SELECT auto_approve FROM events WHERE id = ?').get(app.event_id);
      if (event && event.auto_approve === 1) {
        handleWaitlistPromotion(app.slot_id, app.event_id, app.event_title, app.organizer_id);
      }
    }

    // Notify the volunteer
    createNotification({
      userId: app.user_id,
      kind: status === 'accepted' ? 'accepted' : status === 'waitlisted' ? 'waitlisted' : 'declined',
      title: `Application ${status}`,
      body: `Your application for "${app.event_title}" was ${status}.`,
      link: `event:${app.event_id}`
    });

    res.json({
      success: true,
      application: {
        id: appId,
        status
      }
    });
  } catch (error) {
    console.error('Update app status error:', error);
    res.status(500).json({ error: 'Internal server error updating application' });
  }
});

// 9a. Check-in (Organizer only)
//
// Marking people off as they arrive. Deliberately not the same act as awarding
// hours: check-in marks are freely editable, credit nothing, and are available
// while a shift is still running. Hours are finalised separately, afterwards.

export default router;
