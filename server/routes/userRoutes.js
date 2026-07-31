import express from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import {
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendEmailChangeConfirmation,
  sendEmailChangeNotice
} from '../email.js';
import { VALID_GRADES, JWT_SECRET, DEMO_MODE, COOKIE_NAME, cookieOptions, clearCookieOptions } from '../config.js';

import { authenticateToken, formatUserResponse, inTransaction } from '../utils.js';
import { db, initDatabase } from '../db.js';
import { validateAccountFields, validatePassword, validateUsername, validateEmail, validateProfilePatch } from '../accountValidation.js';
import { issueVerificationToken, sendVerificationMail, purgeExpiredVerificationTokens } from '../services/verification.js';

const router = express.Router();

router.get('/api/users/:id/profile', authenticateToken, (req, res) => {
  try {
    const row = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'student'").get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Volunteer not found' });

    const isSelf = req.params.id === req.user.id;

    // Organizers only see contact/PII fields for students who have applied
    // to an event they host — not for every student on the platform.
    const hostsApplicant = req.user.role === 'organizer' && !!db.prepare(`
      SELECT 1 FROM applications a
      JOIN events e ON a.event_id = e.id
      WHERE a.user_id = ? AND e.organizer_id = ?
      LIMIT 1
    `).get(req.params.id, req.user.id);
    const canSeeContact = isSelf || req.user.role === 'admin' || hostsApplicant;

    const totals = db.prepare(`
      SELECT COALESCE(SUM(hours_awarded), 0) as hours,
             COUNT(DISTINCT event_id) as events,
             COUNT(*) as shifts
      FROM attendance WHERE user_id = ? AND present = 1
    `).get(req.params.id);

    // Completed service, newest first
    const completed = db.prepare(`
      SELECT e.id as event_id, e.title, e.category, e.location, u.name as organizer_name,
             s.name as slot_name, s.start_datetime, s.end_datetime, at.hours_awarded
      FROM attendance at
      JOIN slots s ON at.slot_id = s.id
      JOIN events e ON at.event_id = e.id
      JOIN users u ON e.organizer_id = u.id
      WHERE at.user_id = ? AND at.present = 1
      ORDER BY s.start_datetime DESC
    `).all(req.params.id);

    // Upcoming confirmed shifts
    const upcoming = db.prepare(`
      SELECT e.id as event_id, e.title, e.category, e.location, s.name as slot_name,
             s.start_datetime, s.end_datetime
      FROM applications a
      JOIN slots s ON a.slot_id = s.id
      JOIN events e ON a.event_id = e.id
      WHERE a.user_id = ? AND a.status = 'accepted'
        AND s.start_datetime > ? AND e.status != 'cancelled'
      ORDER BY s.start_datetime ASC
    `).all(req.params.id, new Date().toISOString());

    const pendingCount = db.prepare(`
      SELECT COUNT(*) as c FROM applications
      WHERE user_id = ? AND status IN ('pending', 'waitlisted')
    `).get(req.params.id).c;

    // Hours by category — what kind of volunteer someone is
    const byCategory = db.prepare(`
      SELECT e.category, COALESCE(SUM(at.hours_awarded), 0) as hours
      FROM attendance at
      JOIN events e ON at.event_id = e.id
      WHERE at.user_id = ? AND at.present = 1
      GROUP BY e.category ORDER BY hours DESC
    `).all(req.params.id);

    res.json({
      volunteer: {
        id: row.id,
        name: row.name,
        avatar: row.avatar,
        grade: canSeeContact ? row.grade : null,
        bio: canSeeContact ? row.bio : null,
        school: canSeeContact ? row.school : null,
        skills: row.skills ? JSON.parse(row.skills) : [],
        joinedAt: row.created_at,
        // Contact details stay with the person and the adults coordinating them
        email: canSeeContact ? row.email : null
      },
      stats: {
        hours: Number(totals.hours) || 0,
        eventsCompleted: totals.events || 0,
        shiftsCompleted: totals.shifts || 0,
        // The count alone carries no whereabouts, so staff who legitimately
        // see contact info may see it too — the array itself (event location,
        // exact times) is self-only, below.
        upcomingCount: isSelf || canSeeContact ? upcoming.length : 0,
        pendingCount
      },
      milestones: buildMilestones(Number(totals.hours) || 0, totals.events || 0),
      byCategory: byCategory.map(c => ({ category: c.category, hours: Number(c.hours) })),
      completed: completed.map(formatServiceRow),
      // A confirmed future shift discloses a minor's physical whereabouts at a
      // known time — visible to the student themselves only, never to other
      // students, organizers, or admins.
      upcoming: isSelf ? upcoming.map(u => ({
        eventId: u.event_id, title: u.title, category: u.category, location: u.location,
        slotName: u.slot_name, startDatetime: u.start_datetime, endDatetime: u.end_datetime
      })) : []
    });
  } catch (err) {
    console.error('Volunteer profile error:', err);
    res.status(500).json({ error: 'Failed to load profile' });
  }
});

function formatServiceRow(r) {
  return {
    eventId: r.event_id,
    title: r.title,
    category: r.category,
    location: r.location,
    organizerName: r.organizer_name,
    slotName: r.slot_name,
    startDatetime: r.start_datetime,
    endDatetime: r.end_datetime,
    hours: Number(r.hours_awarded)
  };
}

/**
 * Milestones mark real service already completed — they are never targets to
 * chase, and there are no points or streaks. Each one is either earned or not.
 */
const MILESTONE_TIERS = [
  { id: 'first-shift', label: 'First shift', hint: 'Completed your first volunteer shift', test: (h, e) => e >= 1 },
  { id: 'ten-hours', label: '10 hours', hint: 'Ten hours of service', test: (h) => h >= 10 },
  { id: 'five-events', label: '5 events', hint: 'Helped at five different events', test: (h, e) => e >= 5 },
  { id: 'silver', label: 'Silver Award', hint: '25 hours — the district Silver Award target', test: (h) => h >= 25 },
  { id: 'fifty-hours', label: '50 hours', hint: 'Fifty hours of service', test: (h) => h >= 50 },
  { id: 'ten-events', label: '10 events', hint: 'Helped at ten different events', test: (h, e) => e >= 10 },
  { id: 'century', label: '100 hours', hint: 'One hundred hours of service', test: (h) => h >= 100 }
];

function buildMilestones(hours, events) {
  return MILESTONE_TIERS.map(m => ({
    id: m.id,
    label: m.label,
    hint: m.hint,
    earned: m.test(hours, events)
  }));
}

// ── Certificates ────────────────────────────────────────────────────
// One certificate per completed event. The verification code is derived
// from the record itself, so the same service always produces the same code
// and a school office can check a printed copy against the platform.

router.get('/api/organizers/:id/profile', authenticateToken, (req, res) => {
  try {
    const row = db.prepare("SELECT * FROM users WHERE id = ? AND role IN ('organizer','admin')").get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Organizer not found' });

    const totals = db.prepare(`
      SELECT COUNT(DISTINCT e.id) as events_hosted,
             COUNT(DISTINCT a.user_id) as volunteers_helped
      FROM events e
      LEFT JOIN applications a ON a.event_id = e.id AND a.status = 'accepted'
      WHERE e.organizer_id = ?
    `).get(req.params.id);

    const hoursAwarded = db.prepare(`
      SELECT COALESCE(SUM(at.hours_awarded), 0) as h
      FROM attendance at
      JOIN events e ON at.event_id = e.id
      WHERE e.organizer_id = ? AND at.present = 1
    `).get(req.params.id).h;

    const events = db.prepare(`
      SELECT e.id, e.title, e.category, e.location, e.status, e.application_deadline,
             (SELECT MIN(s.start_datetime) FROM slots s WHERE s.event_id = e.id) as start_datetime,
             (SELECT COALESCE(SUM(s.max_spots), 0) FROM slots s WHERE s.event_id = e.id) as max_spots,
             (SELECT COUNT(*) FROM applications a WHERE a.event_id = e.id AND a.status = 'accepted') as accepted
      FROM events e WHERE e.organizer_id = ?
      ORDER BY start_datetime DESC
    `).all(req.params.id);

    const now = new Date().toISOString();
    const shape = (e) => ({
      id: e.id, title: e.title, category: e.category, location: e.location,
      status: e.status, startDatetime: e.start_datetime,
      applicationDeadline: e.application_deadline,
      maxSpots: Number(e.max_spots), accepted: e.accepted
    });

    res.json({
      organizer: {
        id: row.id,
        name: row.name,
        avatar: row.avatar,
        bio: row.bio,
        organization: row.school,
        verified: row.verified === 1,
        joinedAt: row.created_at,
        email: row.email
      },
      stats: {
        eventsHosted: totals.events_hosted || 0,
        volunteersHelped: totals.volunteers_helped || 0,
        hoursAwarded: Number(hoursAwarded) || 0
      },
      upcoming: events.filter(e => e.start_datetime && e.start_datetime > now && e.status !== 'cancelled').reverse().map(shape),
      past: events.filter(e => !e.start_datetime || e.start_datetime <= now || e.status === 'cancelled').map(shape)
    });
  } catch (err) {
    console.error('Organizer profile error:', err);
    res.status(500).json({ error: 'Failed to load organizer profile' });
  }
});

// 18. Favorites toggle and list

router.patch('/api/auth/profile', authenticateToken, (req, res) => {
  try {
    const { grade, leaderboardOptIn, emailOptOut } = req.body;

    /**
     * The text fields go through the same validator signup uses.
     *
     * This handler previously called `name.trim()` on an unvalidated value — so
     * a non-string `name` threw and answered 500 — accepted `"   "` as a
     * display name, and applied no length or type limit to bio, school or
     * avatar, all three of which are bounded at signup.
     */
    const check = validateProfilePatch(req.body);
    if (!check.ok) {
      return res.status(400).json({ error: check.error, field: check.field });
    }

    const updates = [];
    const values = [];

    for (const [column, value] of [
      ['name', check.value.name],
      ['avatar', check.value.avatar],
      ['bio', check.value.bio],
      ['school', check.value.school]
    ]) {
      if (value !== undefined) { updates.push(`${column} = ?`); values.push(value); }
    }
    if (check.value.skills !== undefined) {
      updates.push('skills = ?'); values.push(JSON.stringify(check.value.skills));
    }

    if (grade !== undefined) {
      if (!VALID_GRADES.includes(grade)) {
        return res.status(400).json({ error: `Grade must be one of: ${VALID_GRADES.join(', ')}`, field: 'grade' });
      }
      updates.push('grade = ?'); values.push(grade);
    }
    if (leaderboardOptIn !== undefined) { updates.push('leaderboard_opt_in = ?'); values.push(leaderboardOptIn ? 1 : 0); }
    if (emailOptOut !== undefined) { updates.push('email_opt_out = ?'); values.push(emailOptOut ? 1 : 0); }

    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
    values.push(req.user.id);
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    res.json({ user: formatUserResponse(row) });
  } catch (err) {
    console.error('Profile update error:', err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// 20. Statistics endpoint for a volunteer

router.get('/api/user/preferences', authenticateToken, (req, res) => {
  try {
    const prefs = db.prepare('SELECT category, channel, enabled FROM notification_preferences WHERE user_id = ?').all(req.user.id);
    const userRow = db.prepare('SELECT email_opt_out FROM users WHERE id = ?').get(req.user.id);

    res.json({
      globalEmailOptOut: userRow ? userRow.email_opt_out === 1 : false,
      preferences: prefs
    });
  } catch (error) {
    console.error('Fetch preferences error:', error);
    res.status(500).json({ error: 'Failed to fetch preferences' });
  }
});

router.post('/api/user/preferences', authenticateToken, (req, res) => {
  try {
    const { category, channel, enabled } = req.body;
    
    if (category === 'global' && channel === 'email') {
      db.prepare('UPDATE users SET email_opt_out = ? WHERE id = ?').run(enabled ? 0 : 1, req.user.id);
      return res.json({ success: true });
    }

    db.prepare(`
      INSERT INTO notification_preferences (user_id, category, channel, enabled)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, category, channel) DO UPDATE SET enabled = excluded.enabled
    `).run(req.user.id, category, channel, enabled ? 1 : 0);

    res.json({ success: true });
  } catch (error) {
    console.error('Update preference error:', error);
    res.status(500).json({ error: 'Failed to update preferences' });
  }
});


export default router;
