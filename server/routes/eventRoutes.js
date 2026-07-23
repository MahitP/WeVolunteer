import express from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { sendVerificationEmail, sendPasswordResetEmail } from '../email.js';
import { VALID_GRADES, VALID_CATEGORIES } from '../config.js';
import { createRandom, performWeightedSelection } from '../weighting.js';
import { recordCheckins, getCheckins, finalizeAttendance, computeEventCompletion, attendanceOnSlots, eventAttendanceCount } from '../attendance.js';
import { authenticateToken, formatUserResponse, inTransaction, createNotification, runNotificationSweep, countdownPhrase, notifyConfirmedVolunteers, handleWaitlistPromotion, certificateCode } from '../utils.js';
import { db } from '../db.js';
import { validateEventPayload } from '../validation.js';

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

router.get('/api/events', authenticateToken, (req, res) => {
  try {
    const events = db.prepare(`
      SELECT e.*, u.name as organizer_name, u.verified as organizer_verified,
             u.school as organizer_school
      FROM events e
      JOIN users u ON e.organizer_id = u.id
    `).all();

    // Arrival details (instructions) are only for people who are actually
    // going, or who run the event — not the open internet, and not every
    // other signed-in student. Batch-loaded once so the per-event mapping
    // below stays free of an N+1.
    const acceptedEventIds = new Set(
      db.prepare("SELECT DISTINCT event_id FROM applications WHERE user_id = ? AND status = 'accepted'")
        .all(req.user.id).map(r => r.event_id)
    );

    // Batch-load slots and accepted counts once instead of per-event queries
    const slotsByEvent = new Map();
    for (const s of db.prepare('SELECT * FROM slots').all()) {
      if (!slotsByEvent.has(s.event_id)) slotsByEvent.set(s.event_id, []);
      slotsByEvent.get(s.event_id).push(s);
    }
    const acceptedBySlot = new Map();
    for (const r of db.prepare(`
      SELECT slot_id, COUNT(*) as count FROM applications
      WHERE status = 'accepted' GROUP BY slot_id
    `).all()) {
      acceptedBySlot.set(r.slot_id, r.count);
    }

    // Whether any hours have been recorded against this event. The client needs
    // it to stop offering a delete button the server will refuse — an action
    // that is always going to fail should not be presented as available.
    const withAttendance = new Set(
      db.prepare('SELECT DISTINCT event_id FROM attendance').all().map(r => r.event_id)
    );

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

      const canSeeInstructions = req.user.role === 'admin' ||
        event.organizer_id === req.user.id ||
        acceptedEventIds.has(event.id);

      return {
        id: event.id,
        title: event.title,
        description: event.description,
        category: event.category,
        location: event.location,
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
        selectionSummary: event.selection_summary ? JSON.parse(event.selection_summary) : null,
        slots: formattedSlots
      };
    });
    res.json(formattedEvents);
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
             u.school as organizer_school
      FROM events e JOIN users u ON e.organizer_id = u.id
      WHERE e.id = ?
    `).get(req.params.id);

    if (!event) return res.status(404).json({ error: 'Event not found' });

    const isStaff = req.user.role === 'admin' ||
      (req.user.role === 'organizer' && event.organizer_id === req.user.id);
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
        instructions: event.instructions || '',
        applicationDeadline: event.application_deadline,
        organizerId: event.organizer_id,
        organizerName: event.organizer_name,
        status: event.status,
        autoApprove: event.auto_approve === 1,
        slots: formattedSlots
      },
      applications
    });
  } catch (err) {
    console.error('Fetch event error:', err);
    res.status(500).json({ error: 'Failed to load event' });
  }
});

router.post('/api/events', authenticateToken, (req, res) => {
  if (req.user.role !== 'organizer') {
    return res.status(403).json({ error: 'Access denied: Only organizers can list events' });
  }

  // Check if organizer is verified by Admin
  const organizer = db.prepare('SELECT verified FROM users WHERE id = ?').get(req.user.id);
  if (!organizer || organizer.verified !== 1) {
    return res.status(403).json({ error: 'Organizer account pending admin approval. You cannot create events yet.' });
  }

  const {
    title, description, category, location, applicationDeadline, slots,
    autoApprove, instructions, attendeeVisibility
  } = req.body;

  if (!title || !description || !category || !location || !applicationDeadline || !slots || !Array.isArray(slots) || slots.length === 0) {
    return res.status(400).json({ error: 'Required fields missing: Title, description, category, location, deadline, and slots are required.' });
  }

  // Ensure category is strictly valid
  if (!VALID_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `Invalid category. Must be one of: ${VALID_CATEGORIES.join(', ')}` });
  }

  const validation = validateEventPayload({ title, description, location, instructions, applicationDeadline, slots });
  if (!validation.ok) return res.status(400).json({ error: validation.error });

  try {
    const eventId = `event-${Date.now()}`;
    const nowStr = new Date().toISOString();
    
    inTransaction(() => {
      // A. Insert Event
      db.prepare(`
        INSERT INTO events (id, title, description, category, location, application_deadline,
                            organizer_id, status, created_at, auto_approve, instructions, attendee_visibility)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)
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
        attendeeVisibility === 'private' ? 'private' : 'accepted'
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
    });


    res.status(201).json({
      success: true,
      id: eventId,
      title,
      description,
      category,
      location,
      applicationDeadline,
      organizerId: req.user.id,
      status: 'open',
      autoApprove: !!autoApprove
    });
  } catch (error) {
    console.error('Create event error:', error);
    res.status(500).json({ error: 'Internal server error creating event' });
  }
});

// 6. Fetch All Applications (Enriched with Student profile, Slot, and Event details)

router.put('/api/events/:id', authenticateToken, (req, res) => {
  if (req.user.role !== 'organizer') {
    return res.status(403).json({ error: 'Access denied' });
  }

  const eventId = req.params.id;
  const {
    title, description, category, location, applicationDeadline, slots,
    autoApprove, instructions, attendeeVisibility
  } = req.body;

  if (!title || !description || !category || !location || !applicationDeadline || !slots || !Array.isArray(slots)) {
    return res.status(400).json({ error: 'Required fields missing' });
  }
  if (!VALID_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `Invalid category. Must be one of: ${VALID_CATEGORIES.join(', ')}` });
  }

  const validation = validateEventPayload({ title, description, location, instructions, applicationDeadline, slots });
  if (!validation.ok) return res.status(400).json({ error: validation.error });

  try {
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (event.organizer_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied: You do not host this event' });
    }

    if (event.status === 'completed') {
      return res.status(409).json({
        error: 'This event is complete and its details can no longer be changed. Attendance can still be corrected.',
        code: 'event_completed'
      });
    }

    // A moved meeting place is the change most likely to make someone turn up
    // at the wrong address, so confirmed volunteers are told about it.
    const locationChanged = event.location !== location;

    // Removing a shift used to take its attendance rows with it, silently
    // destroying hours volunteers had already earned. Credited service is not
    // something an event edit gets to delete as a side effect.
    const payloadIds = slots.filter(s => s.id && !s.id.startsWith('new-')).map(s => s.id);
    const existingIds = db.prepare('SELECT id FROM slots WHERE event_id = ?').all(eventId).map(s => s.id);
    const removedIds = existingIds.filter(id => !payloadIds.includes(id));
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
        SET title = ?, description = ?, category = ?, location = ?, application_deadline = ?
        WHERE id = ?
      `).run(title, description, category, location, applicationDeadline, eventId);

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
          db.prepare(`
            UPDATE slots
            SET name = ?, description = ?, start_datetime = ?, end_datetime = ?, max_spots = ?
            WHERE id = ?
          `).run(slot.name, slot.description, slot.startDatetime, slot.endDatetime, Number(slot.maxSpots), slot.id);
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
    if (locationChanged) {
      notified = notifyConfirmedVolunteers(eventId, {
        kind: 'location',
        title: `New location: ${title}`,
        body: `The meeting place moved to ${location}. Check the event page before you go.`
      });
    }


    res.json({ success: true, notified });
  } catch (error) {
    console.error('Update event details error:', error);
    res.status(500).json({ error: 'Internal server error editing event details' });
  }
});

// 11. Run Equalizer Hour Sorting (Organizer only)
router.post('/api/events/:id/auto-approve', authenticateToken, (req, res) => {
  if (req.user.role !== 'organizer') {
    return res.status(403).json({ error: 'Access denied' });
  }

  const eventId = req.params.id;

  try {
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (event.organizer_id !== req.user.id) {
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
        createNotification({
          userId: app.user_id,
          kind: 'accepted',
          title: 'Application accepted',
          body: `You were auto-approved for "${event.title}" — ${slot.name}.`,
          link: `event:${event.id}`
        });
      }
    }

    res.json({ success: true, approvedCount });
  } catch (error) {
    console.error('Equalizer error:', error);
    res.status(500).json({ error: 'Internal server error running equalizer' });
  }
});

// 12. Update Event Settings (Organizer only)
router.patch('/api/events/:id', authenticateToken, (req, res) => {
  if (req.user.role !== 'organizer') {
    return res.status(403).json({ error: 'Access denied' });
  }

  const eventId = req.params.id;
  const { autoApprove, attendeeVisibility } = req.body;

  try {
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (event.organizer_id !== req.user.id) {
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

router.delete('/api/events/:id', authenticateToken, (req, res) => {
  const eventId = req.params.id;

  try {
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    // Allow Admin OR the organizer who hosted it to delete it
    if (req.user.role !== 'admin' && event.organizer_id !== req.user.id) {
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
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Remove event error:', error);
    res.status(500).json({ error: 'Internal server error removing event listing' });
  }
});

// A5. Toggle Event Status (Organizer only)
router.patch('/api/events/:id/status', authenticateToken, (req, res) => {
  if (req.user.role !== 'organizer' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied' });
  }

  const eventId = req.params.id;
  const { status } = req.body;

  if (!['open', 'closed', 'cancelled'].includes(status)) {
    return res.status(400).json({ error: 'Status must be open, closed, or cancelled' });
  }

  try {
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (req.user.role === 'organizer' && event.organizer_id !== req.user.id) {
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
      notified = notifyConfirmedVolunteers(eventId, {
        kind: 'cancelled',
        title: `Cancelled: ${event.title}`,
        body: `${event.title} has been called off. You no longer need to attend.`,
        dedupeKey: `cancelled:${eventId}`
      });
    }

    res.json({ success: true, status, notified });
  } catch (error) {
    console.error('Toggle status error:', error);
    res.status(500).json({ error: 'Internal server error toggling event status' });
  }
});

// A6. Export Accepted Roster as CSV (Organizer only)

router.post('/api/events/:id/duplicate', authenticateToken, (req, res) => {
  if (req.user.role !== 'organizer') {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (event.organizer_id !== req.user.id) {
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

router.get('/api/events/:id/auto-select/runs', authenticateToken, (req, res) => {
  const eventId = req.params.id;
  try {
    const event = db.prepare('SELECT organizer_id FROM events WHERE id = ?').get(eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    if (req.user.role !== 'admin' && event.organizer_id !== req.user.id) {
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
      waitlistIds: JSON.parse(run.waitlist_ids)
    }));

    res.json(formattedRuns);
  } catch (err) {
    console.error('Fetch auto select runs error:', err);
    res.status(500).json({ error: 'Failed to fetch runs' });
  }
});

// A27. Execute Draft Auto Select Draw (Organizer only)
router.post('/api/events/:id/auto-select/run', authenticateToken, (req, res) => {
  const eventId = req.params.id;
  if (req.user.role !== 'organizer' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied' });
  }

  try {
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    if (req.user.role !== 'admin' && event.organizer_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Ensure it is an Auto Select event
    if (event.auto_approve !== 1) {
      return res.status(400).json({ error: 'This event is not configured for Auto Select' });
    }

    // Check if there is already a confirmed selection
    const confirmedExists = db.prepare('SELECT COUNT(*) as count FROM auto_select_runs WHERE event_id = ? AND is_confirmed = 1').get(eventId).count;
    if (confirmedExists > 0) {
      return res.status(400).json({ error: 'Selection has already been confirmed and locked for this event' });
    }

    // Determine the next run number
    const runCount = db.prepare('SELECT COUNT(*) as count FROM auto_select_runs WHERE event_id = ?').get(eventId).count;
    const nextRunNumber = runCount + 1;

    // Gather pending applicants for each slot
    const slots = db.prepare('SELECT * FROM slots WHERE event_id = ?').all(eventId);
    const selectedIds = [];
    const waitlistIds = [];

    for (const slot of slots) {
      const pendingApps = db.prepare(`
        SELECT a.id, a.user_id,
               COALESCE(SUM(att.hours_awarded), 0) as total_hours
        FROM applications a
        LEFT JOIN attendance att ON att.user_id = a.user_id AND att.present = 1
        WHERE a.slot_id = ? AND a.status = 'pending'
        GROUP BY a.id
      `).all(slot.id);

      if (pendingApps.length === 0) continue;

      const acceptedSlotCount = db.prepare(`
        SELECT COUNT(*) as count FROM applications WHERE slot_id = ? AND status = 'accepted'
      `).get(slot.id).count;

      const remainingSpots = Math.max(0, slot.max_spots - acceptedSlotCount);

      if (remainingSpots <= 0) {
        // All waitlisted
        pendingApps.forEach(app => {
          waitlistIds.push(app.id);
        });
      } else {
        // Run selection using seed incorporating the run number
        const seed = `${event.id}:${slot.id}:run-${nextRunNumber}`;
        const randomFn = createRandom(seed);
        const draw = performWeightedSelection(pendingApps, remainingSpots, randomFn);
        selectedIds.push(...draw.selectedIds);
        waitlistIds.push(...draw.waitlistIds);
      }
    }

    const runId = `run-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
    const nowStr = new Date().toISOString();

    db.prepare(`
      INSERT INTO auto_select_runs (id, event_id, run_number, created_at, selected_ids, waitlist_ids, is_confirmed)
      VALUES (?, ?, ?, ?, ?, ?, 0)
    `).run(runId, eventId, nextRunNumber, nowStr, JSON.stringify(selectedIds), JSON.stringify(waitlistIds));

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
router.post('/api/events/:id/auto-select/confirm', authenticateToken, (req, res) => {
  const eventId = req.params.id;
  if (req.user.role !== 'organizer' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied' });
  }

  try {
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    if (req.user.role !== 'admin' && event.organizer_id !== req.user.id) {
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

    const selectedIds = JSON.parse(latestRun.selected_ids);
    const waitlistIds = JSON.parse(latestRun.waitlist_ids);

    inTransaction(() => {
      // 1. Confirm this run
      db.prepare('UPDATE auto_select_runs SET is_confirmed = 1 WHERE id = ?').run(latestRun.id);

      // 2. Set statuses for selected applicants
      const acceptStmt = db.prepare("UPDATE applications SET status = 'accepted', waitlist_order = NULL WHERE id = ?");
      for (const id of selectedIds) {
        acceptStmt.run(id);

        const appRow = db.prepare(`
          SELECT a.user_id, s.name as slot_name
          FROM applications a
          JOIN slots s ON a.slot_id = s.id
          WHERE a.id = ?
        `).get(id);

        if (appRow) {
          createNotification({
            userId: appRow.user_id,
            kind: 'accepted',
            title: 'Application accepted',
            body: `You were auto-selected and accepted for "${event.title}" — ${appRow.slot_name}!`,
            link: `event:${event.id}`
          });
        }
      }

      // 3. Set statuses and ranks for waitlisted applicants
      const waitlistApps = db.prepare(`
        SELECT id, slot_id, user_id FROM applications
        WHERE id IN (${waitlistIds.map(() => '?').join(',')})
      `).all(...waitlistIds);

      const waitlistStmt = db.prepare("UPDATE applications SET status = 'waitlisted', waitlist_order = ? WHERE id = ?");
      
      // Slot-specific waitlist counters
      const slotWaitlistIndex = {};

      for (const id of waitlistIds) {
        const app = waitlistApps.find(a => a.id === id);
        if (!app) continue;

        slotWaitlistIndex[app.slot_id] = (slotWaitlistIndex[app.slot_id] || 0) + 1;
        const rank = slotWaitlistIndex[app.slot_id];

        waitlistStmt.run(rank, id);

        const slot = db.prepare('SELECT name FROM slots WHERE id = ?').get(app.slot_id);
        const slotName = slot ? slot.name : 'Shift';

        createNotification({
          userId: app.user_id,
          kind: 'waitlisted',
          title: 'Waitlisted',
          body: `You were placed on the waitlist (Rank #${rank}) for "${event.title}" — ${slotName}.`,
          link: `event:${event.id}`
        });
      }

      // 4. Compute selection summary
      const totalApplicants = selectedIds.length + waitlistIds.length;
      let acceptedHoursSum = 0;
      let waitlistedHoursSum = 0;

      if (selectedIds.length > 0) {
        const rows = db.prepare(`
          SELECT COALESCE(SUM(att.hours_awarded), 0) as total_hours
          FROM applications a
          LEFT JOIN attendance att ON att.user_id = a.user_id AND att.present = 1
          WHERE a.id IN (${selectedIds.map(() => '?').join(',')})
          GROUP BY a.id
        `).all(...selectedIds);
        acceptedHoursSum = rows.reduce((sum, r) => sum + r.total_hours, 0);
      }

      if (waitlistIds.length > 0) {
        const rows = db.prepare(`
          SELECT COALESCE(SUM(att.hours_awarded), 0) as total_hours
          FROM applications a
          LEFT JOIN attendance att ON att.user_id = a.user_id AND att.present = 1
          WHERE a.id IN (${waitlistIds.map(() => '?').join(',')})
          GROUP BY a.id
        `).all(...waitlistIds);
        waitlistedHoursSum = rows.reduce((sum, r) => sum + r.total_hours, 0);
      }

      const avgAcceptedHours = selectedIds.length > 0 ? Number((acceptedHoursSum / selectedIds.length).toFixed(1)) : 0;
      const avgWaitlistedHours = waitlistIds.length > 0 ? Number((waitlistedHoursSum / waitlistIds.length).toFixed(1)) : 0;

      const summary = {
        totalApplicants,
        acceptedVolunteers: selectedIds.length,
        waitlistedVolunteers: waitlistIds.length,
        avgAcceptedHours,
        avgWaitlistedHours,
        timestamp: new Date().toISOString()
      };

      db.prepare(`
        UPDATE events
        SET selection_summary = ?, status = 'closed'
        WHERE id = ?
      `).run(JSON.stringify(summary), eventId);
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Confirm Auto Select error:', err);
    res.status(500).json({ error: 'Failed to confirm selection results' });
  }
});

// Unknown API routes get JSON instead of an HTML 404 page

export default router;
