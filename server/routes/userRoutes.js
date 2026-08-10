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
import { can } from '../authz.js';
/* The milestone ladder. One definition, in a module — it was inline here, and
   duplicated byte-for-byte in utils.js where nothing imported it. See
   server/milestones.js for the badge/milestone boundary this sits on. */
import { buildMilestones } from '../milestones.js';
import { db, initDatabase } from '../db.js';
import { distinctionFor } from '../profileSerializer.js';
import { validateAccountFields, validatePassword, validateUsername, validateEmail, validateProfilePatch } from '../accountValidation.js';
import { issueVerificationToken, sendVerificationMail, purgeExpiredVerificationTokens } from '../services/verification.js';

const router = express.Router();

/**
 * ── Why `directory.read`, on a route that predates the directory ──
 *
 * This handler carried no capability gate at all: the PII fields are gated
 * inline by `canSeeContact`, and the reasoning recorded in the completeness
 * registry was that the remaining stats are non-PII and may be read by any
 * authenticated caller.
 *
 * That reasoning had one hole, and v1.3 opened it. `partner` is deliberately
 * denied `directory.read` (see the note in authz.js: a partner is an EXTERNAL
 * organization and the member directory is a searchable list of schoolchildren)
 * — and every NEW directory route enforces that, while this older one, which
 * returns a student's name, avatar, skills, credited hours, milestones and
 * service counts, did not. The exclusion was therefore a front door that was
 * locked while this window stood open beside it.
 *
 * The capability is held by student, organizer and admin, and by super_admin
 * through its wildcard, so this narrows exactly one role — the one it was
 * supposed to narrow.
 *
 * ── An inline `can()`, deliberately, and not `requireCap` ──
 *
 * `requireCap` refuses on `principal.tfaRequired` as well as on the capability,
 * so mounting it here would ALSO make this route unreadable to an organizer or
 * administrator who has not yet enrolled a second factor. That may well be
 * right, but it is a different decision about a different role, and quietly
 * attaching it to a partner fix would change behaviour nobody reviewed — a
 * pending organizer reading a volunteer's profile is not the hole being closed.
 * The route was already registered INLINE_GATED for its `canSeeContact` logic,
 * so this is the gate joining the one that is there rather than a new layer.
 */
router.get('/api/users/:id/profile', authenticateToken, (req, res) => {
  if (!can(req.principal, 'directory.read')) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    // `account_status <> 'deleted'` is part of the identity check, not a filter
    // bolted on afterwards: a deleted account is anonymised in place rather than
    // removed — the row survives so that audit history and foreign keys still
    // resolve — so without this a tombstone answers 200 as a live profile.
    // Suspended is deliberately NOT excluded: a suspended member still exists
    // and their profile is still theirs.
    const row = db.prepare(
      "SELECT * FROM users WHERE id = ? AND role = 'student' AND account_status <> 'deleted'"
    ).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Volunteer not found' });

    const isSelf = req.params.id === req.principal.userId;

    // Organizers only see contact/PII fields for students who have applied
    // to an event they host — not for every student on the platform.
    // `applicant.review` is the "kind of actor" check (organizer, and
    // super_admin via the wildcard); the subquery is the ownership check —
    // an actual applicant of an event this principal actually hosts.
    const hostsApplicant = can(req.principal, 'applicant.review') && !!db.prepare(`
      SELECT 1 FROM applications a
      JOIN events e ON a.event_id = e.id
      WHERE a.user_id = ? AND e.organizer_id = ?
      LIMIT 1
    `).get(req.params.id, req.principal.userId);
    const canSeeContact = isSelf || can(req.principal, 'user.contact.read') || hostsApplicant;

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
      /**
       * The itemised service record is NOT public.
       *
       * Each row carries a past event's title, its LOCATION and its exact start
       * and end times. For a fifteen-year-old that is a week-by-week record of
       * where they have been, and it was returned to every authenticated caller
       * with nothing gating it — the single most sensitive thing this endpoint
       * disclosed. The counts above say how much somebody has volunteered
       * without saying where they were on Saturday.
       *
       * Self, or staff holding `user.contact.read`, which is the capability
       * that already names the power to see a student's particulars.
       */
      /**
       * The itemised service record is NOT public, and the gate is
       * `canSeeContact`.
       *
       * Each row carries a past event's title, its LOCATION and its exact start
       * and end times. Before v1.3 this was returned to EVERY authenticated
       * caller with nothing gating it — for a fifteen-year-old, a week-by-week
       * record of where they have been, handed to anybody with a login. That is
       * the leak this closes.
       *
       * `hostsApplicant` is deliberately inside the gate, and it is narrower
       * than it looks: it requires that this student applied to an event THIS
       * organizer hosts. An organizer cannot manufacture that. Reviewing an
       * applicant's service history is the applicant-review workflow — it is
       * how an organizer decides who to accept — and it is pinned by
       * "does not regress the organizer applicant-review workflow" in
       * routes.auth.test.js. Narrowing it would break a reviewed decision, not
       * fix a leak.
       *
       * `/api/users/:id/service-record` applies the identical rule, so the two
       * endpoints cannot disagree about the same rows.
       */
      completed: canSeeContact ? completed.map(formatServiceRow) : [],
      completedRedacted: !canSeeContact,
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


// ── Certificates ────────────────────────────────────────────────────
// One certificate per completed event. The verification code is derived
// from the record itself, so the same service always produces the same code
// and a school office can check a printed copy against the platform.

/**
 * Intentionally open to every authenticated role — declared as such in
 * authz.completeness.test.js's ROUTE_REGISTRY, not gated by a capability.
 *
 * This used to carry `requireCap('event.view')`, which every one of the five
 * roles holds. A gate no role can fail is indistinguishable from no gate, but
 * it is worse than no gate: it looks like a decision was made, and it removed
 * this route from Guard 2's reviewed registry — the one place where "why is
 * this open?" is actually written down and re-read. `GET /api/events` is the
 * identical case (every role holds event.view) and is handled the other way,
 * so the two now match. Whichever way a future reader looks, they find one
 * mechanism, and the reasoning lives with the route rather than in a
 * capability that only pretends to discriminate.
 */
router.get('/api/organizers/:id/profile', authenticateToken, (req, res) => {
  try {
    // See the sibling volunteer profile above: a deleted account keeps its row
    // and its role, so the role predicate alone matches tombstones. The demo
    // administrator removed from the pilot database is exactly such a row — it
    // is `account_status = 'deleted'` and still `role = 'admin'`, and without
    // this it answered 200 here instead of 404.
    const row = db.prepare(
      "SELECT * FROM users WHERE id = ? AND role IN ('organizer','admin') AND account_status <> 'deleted'"
    ).get(req.params.id);
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
    if (check.value.hobbies !== undefined) {
      updates.push('hobbies = ?'); values.push(JSON.stringify(check.value.hobbies));
    }
    /**
     * The headline and highlights belong to a DISTINGUISHED account.
     *
     * They are the one-line introduction and the short list under an official
     * account's name. Refused for everybody else rather than merely hidden,
     * because a field that stores what it will not show is a field somebody
     * will later decide to show: the safe version of "a student's headline is
     * private" is a student having no headline at all. Ordinary accounts have
     * `bio`, which is the same kind of text and is gated by
     * `profile_visibility`.
     *
     * Derived from `distinctionFor(role)` — the same single source the profile
     * presentation reads — so this is not a role comparison living in a route.
     */
    const writingDistinguishedFields =
      check.value.headline !== undefined || check.value.highlights !== undefined;
    if (writingDistinguishedFields) {
      const self = db.prepare('SELECT role FROM users WHERE id = ?').get(req.user.id);
      if (!distinctionFor(self?.role)) {
        return res.status(403).json({
          error: 'Your account does not have a profile headline. Use "About you" instead.',
          field: check.value.headline !== undefined ? 'headline' : 'highlights',
          code: 'not_distinguished',
        });
      }
    }
    if (check.value.headline !== undefined) {
      updates.push('profile_headline = ?'); values.push(check.value.headline || null);
    }
    if (check.value.highlights !== undefined) {
      updates.push('profile_highlights = ?');
      values.push(check.value.highlights.length ? JSON.stringify(check.value.highlights) : null);
    }
    if (check.value.location !== undefined) {
      updates.push('location = ?'); values.push(check.value.location || null);
    }

    /**
     * The two privacy switches this screen owns.
     *
     * `profileVisibility` had no write path at all before v1.3 — the column
     * existed, defaulted to 'private', and nothing could change it or read it.
     * Validated against the same closed set as the column's CHECK, so an
     * unexpected value is a 400 rather than a constraint error surfacing as a
     * 500.
     */
    if (req.body.profileVisibility !== undefined) {
      if (!['private', 'friends', 'public'].includes(req.body.profileVisibility)) {
        return res.status(400).json({ error: 'Choose private, friends, or public.', field: 'profileVisibility' });
      }
      updates.push('profile_visibility = ?'); values.push(req.body.profileVisibility);
    }
    if (req.body.friendActivityVisible !== undefined) {
      updates.push('friend_activity_visible = ?'); values.push(req.body.friendActivityVisible ? 1 : 0);
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
