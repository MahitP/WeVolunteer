import express from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { sendVerificationEmail, sendPasswordResetEmail } from '../email.js';
import { VALID_GRADES } from '../config.js';
import { createRandom, performWeightedSelection } from '../weighting.js';
import { recordCheckins, getCheckins, finalizeAttendance, computeEventCompletion, attendanceOnSlots, eventAttendanceCount } from '../attendance.js';
import { authenticateToken, formatUserResponse, inTransaction, createNotification, runNotificationSweep, countdownPhrase, notifyConfirmedVolunteers, handleWaitlistPromotion } from '../utils.js';
import { getOrCreateCertificateCode } from '../certificates.js';
import { db } from '../db.js';

const router = express.Router();

router.post('/api/events/:id/checkin', authenticateToken, (req, res) => {
  if (req.user.role !== 'organizer' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied' });
  }

  try {
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (req.user.role === 'organizer' && event.organizer_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied: You do not host this event' });
    }

    const result = recordCheckins(db, {
      event,
      checkinMap: req.body.checkinMap,
      actor: req.user,
      now: new Date().toISOString()
    });

    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Check-in error:', error);
    res.status(500).json({ error: 'Internal server error saving check-in' });
  }
});

router.get('/api/events/:id/checkin', authenticateToken, (req, res) => {
  try {
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (req.user.role === 'organizer' && event.organizer_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied: You do not host this event' });
    }
    if (req.user.role === 'student') return res.status(403).json({ error: 'Access denied' });

    res.json(getCheckins(db, req.params.id).map(c => ({
      slotId: c.slot_id, userId: c.user_id, present: c.present === 1, markedAt: c.marked_at
    })));
  } catch (error) {
    console.error('Check-in fetch error:', error);
    res.status(500).json({ error: 'Internal server error loading check-in' });
  }
});

// 9b. Finalise attendance and credit hours (Organizer only)
//
// The only path that changes a volunteer's credited hours. It touches only the
// records named in the request — never the rest — so a partial or stale submission
// can no longer mark anyone absent, and a credit can only be removed by an
// explicit instruction that carries a reason.
router.post('/api/events/:id/attendance', authenticateToken, (req, res) => {
  if (req.user.role !== 'organizer') {
    return res.status(403).json({ error: 'Access denied: Only organizers can confirm attendance' });
  }

  const eventId = req.params.id;
  const { attendanceMap, reason } = req.body;

  if (!attendanceMap || typeof attendanceMap !== 'object' || Array.isArray(attendanceMap)) {
    return res.status(400).json({ error: 'attendanceMap is required' });
  }

  try {
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (event.organizer_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied: You do not host this event' });
    }
    if (event.status === 'cancelled') {
      return res.status(409).json({ error: 'This event was cancelled, so hours cannot be credited for it.' });
    }

    const now = new Date().toISOString();
    let outcome;

    inTransaction(() => {
      outcome = finalizeAttendance(db, { event, attendanceMap, reason, actor: req.user, now });
      if (!outcome.ok) throw new AttendanceRefused(outcome);

      // Completion is what makes an event immutable, so it is only reached when
      // every shift has ended and every accepted volunteer has been accounted
      // for. A multi-day event is no longer frozen after its first morning.
      const completion = computeEventCompletion(db, eventId, now);
      outcome.completion = completion;
      if (completion.complete && event.status !== 'completed') {
        db.prepare("UPDATE events SET status = 'completed' WHERE id = ?").run(eventId);
        outcome.eventCompleted = true;
      }
    });

    for (const c of outcome.credited) {
      createNotification({
        userId: c.userId,
        kind: 'hours',
        title: `${Number(c.hours).toFixed(1)} hours credited`,
        body: `Your attendance was confirmed for "${event.title}" — ${c.slotName}.`,
        link: `event:${event.id}`
      });
    }
    for (const r of outcome.revoked) {
      if (!r.wasCredited) continue; // never credited, so nothing was taken away
      createNotification({
        userId: r.userId,
        kind: 'hours',
        title: 'Attendance record corrected',
        body: `Your attendance for "${event.title}" — ${r.slotName} was updated to absent. Speak to the organizer if that looks wrong.`,
        link: `event:${event.id}`
      });
    }

    res.json({ success: true, ...outcome });
  } catch (error) {
    if (error instanceof AttendanceRefused) {
      const { error: code, message, ...rest } = error.outcome;
      return res.status(code === 'reason_required' ? 400 : 409).json({ error: message, code, ...rest });
    }
    console.error('Confirm attendance error:', error);
    res.status(500).json({ error: 'Internal server error confirming attendance records' });
  }
});

/** Thrown to roll the transaction back when finalisation is refused. */
class AttendanceRefused extends Error {
  constructor(outcome) {
    super(outcome.message);
    this.outcome = outcome;
  }
}

// 10. Edit Event Details and Slots (Organizer only)

router.get('/api/events/:id/roster.csv', authenticateToken, (req, res) => {
  if (req.user.role !== 'organizer' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied' });
  }

  const eventId = req.params.id;

  try {
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (req.user.role === 'organizer' && event.organizer_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const rows = db.prepare(`
      SELECT u.name, u.email, u.school, u.grade, s.name as slot_name,
             s.start_datetime, s.end_datetime, a.status, a.applied_at
      FROM applications a
      JOIN users u ON a.user_id = u.id
      JOIN slots s ON a.slot_id = s.id
      WHERE a.event_id = ? AND a.status = 'accepted'
      ORDER BY s.start_datetime, u.name
    `).all(eventId);

    const calcHours = (start, end) => Math.max(0.1, Number(((new Date(end) - new Date(start)) / 3600000).toFixed(2)));
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

    const csvLines = [
      'Name,Email,School,Grade,Slot,Start,End,Hours,Status,Applied At',
      ...rows.map(r => [
        cell(r.name),
        cell(r.email),
        cell(r.school),
        cell(r.grade),
        cell(r.slot_name),
        cell(new Date(r.start_datetime).toLocaleString()),
        cell(new Date(r.end_datetime).toLocaleString()),
        calcHours(r.start_datetime, r.end_datetime),
        r.status,
        cell(new Date(r.applied_at).toLocaleString())
      ].join(','))
    ];

    const filename = `${event.title.replace(/[^a-z0-9]/gi, '_')}_roster.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csvLines.join('\n'));
  } catch (error) {
    console.error('CSV export error:', error);
    res.status(500).json({ error: 'Internal server error exporting roster' });
  }
});

router.get('/api/certificates', authenticateToken, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT e.id as event_id, e.title, e.category, e.location,
             u.name as organizer_name, u.verified as organizer_verified,
             COALESCE(SUM(at.hours_awarded), 0) as hours,
             COUNT(*) as shifts,
             MIN(s.start_datetime) as first_start,
             MAX(s.end_datetime) as last_end
      FROM attendance at
      JOIN slots s ON at.slot_id = s.id
      JOIN events e ON at.event_id = e.id
      JOIN users u ON e.organizer_id = u.id
      WHERE at.user_id = ? AND at.present = 1
      GROUP BY e.id
      ORDER BY last_end DESC
    `).all(req.user.id);

    res.json(rows.map(r => ({
      eventId: r.event_id,
      title: r.title,
      category: r.category,
      location: r.location,
      organizerName: r.organizer_name,
      organizerVerified: r.organizer_verified === 1,
      hours: Number(r.hours),
      shifts: r.shifts,
      startDatetime: r.first_start,
      endDatetime: r.last_end,
      code: getOrCreateCertificateCode(db, req.user.id, r.event_id)
    })));
  } catch (err) {
    console.error('Certificates error:', err);
    res.status(500).json({ error: 'Failed to load certificates' });
  }
});


// Public check of a certificate code — how a school office verifies a
// printout. A single indexed lookup by the stored code — never a scan over
// every certificate — and deliberately omits grade from the response: the
// code is a bearer credential handed to whoever is verifying, not proof of
// who they are, so it should disclose only what a printed certificate
// itself would (name, event, organizer, hours, date).
router.get('/api/certificates/verify/:code', (req, res) => {
  try {
    const code = String(req.params.code || '').toUpperCase();
    const cert = db.prepare('SELECT user_id, event_id FROM certificates WHERE code = ?').get(code);
    if (!cert) return res.status(404).json({ valid: false, error: 'No certificate matches that code' });

    const row = db.prepare(`
      SELECT u.name AS volunteer_name, e.title, org.name AS organizer_name,
             COALESCE(SUM(at.hours_awarded),0) AS hours, MAX(s.end_datetime) AS last_end
      FROM attendance at
      JOIN slots s ON at.slot_id = s.id
      JOIN events e ON at.event_id = e.id
      JOIN users u ON at.user_id = u.id
      JOIN users org ON e.organizer_id = org.id
      WHERE at.user_id = ? AND at.event_id = ? AND at.present = 1
      GROUP BY at.user_id, e.id
    `).get(cert.user_id, cert.event_id);
    if (!row) return res.status(404).json({ valid: false, error: 'No certificate matches that code' });

    res.json({
      valid: true,
      volunteerName: row.volunteer_name,
      eventTitle: row.title,
      organizerName: row.organizer_name,
      hours: Number(row.hours),
      completedAt: row.last_end
    });
  } catch (err) {
    res.status(500).json({ error: 'Verification failed' });
  }
});

// ── Organizer profile ───────────────────────────────────────────────
// The page a student checks before trusting an event.

export default router;
