import express from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { sendVerificationEmail, sendPasswordResetEmail } from '../email.js';
import { VALID_GRADES } from '../server.js';
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

    // Check if already signed up for this specific slot
    const exists = db.prepare('SELECT COUNT(*) as count FROM applications WHERE slot_id = ? AND user_id = ?').get(slotId, req.user.id);
    if (exists.count > 0) {
      return res.status(400).json({ error: 'You have already applied for this time slot' });
    }

    let status = 'pending';

    const appId = `app-${Date.now()}`;
    db.prepare(`
      INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(appId, req.user.id, eventId, slotId, status, new Date().toISOString());

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
      application: {
        id: appId,
        eventId,
        slotId,
        userId: req.user.id,
        status,
        appliedAt: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Apply error:', error);
    res.status(500).json({ error: 'Internal server error applying to event' });
  }
});

// 8. Update Application Status (Organizer: accept/waitlist/reject · Student: withdraw own)
router.patch('/api/applications/:id', authenticateToken, (req, res) => {
  const appId = req.params.id;
  const { status } = req.body; // 'accepted', 'waitlisted', 'rejected'

  // Students can only withdraw (set to rejected) their own pending applications
  if (req.user.role === 'student') {
    if (status !== 'rejected') {
      return res.status(403).json({ error: 'Students may only withdraw (reject) their own applications.' });
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

      db.prepare('UPDATE applications SET status = ? WHERE id = ?').run('rejected', appId);

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
        application: { id: appId, status: 'rejected' }
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
