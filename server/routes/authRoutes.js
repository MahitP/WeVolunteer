import express from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { sendVerificationEmail, sendPasswordResetEmail } from '../email.js';
import { VALID_GRADES, JWT_SECRET, DEMO_MODE, REQUIRE_EMAIL_VERIFICATION, COOKIE_NAME, cookieOptions } from '../config.js';

import { authenticateToken, formatUserResponse, inTransaction } from '../utils.js';
import { db, initDatabase } from '../db.js';

const router = express.Router();

/** Issues a fresh email-confirmation token, replacing any previous one. */
function issueVerificationToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  db.prepare('DELETE FROM email_verification_tokens WHERE user_id = ?').run(userId);
  db.prepare('INSERT INTO email_verification_tokens (token, user_id, expires_at) VALUES (?, ?, ?)')
    .run(token, userId, expiresAt);
  return token;
}

router.post('/api/auth/signup', (req, res) => {
  const { email, password, name, username, role, grade, avatar, bio, school, skills } = req.body;

  if (!email || !password || !name || !role || !grade) {
    return res.status(400).json({ error: 'Required fields missing: email, password, name, role, grade' });
  }

  // Admin accounts can only be seeded/promoted server-side, never self-registered
  if (!['student', 'organizer'].includes(role)) {
    return res.status(400).json({ error: 'Role must be student or organizer' });
  }
  if (!VALID_GRADES.includes(grade)) {
    return res.status(400).json({ error: `Grade must be one of: ${VALID_GRADES.join(', ')}` });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters long' });
  }

  // Normalise on write: case and surrounding whitespace are not meaningful
  // parts of an email address, so the stored form is always lowercase/trimmed.
  const normEmail = String(email).trim().toLowerCase();

  const cleanUsername = String(username || '').trim();
  if (!cleanUsername) {
    return res.status(400).json({ error: 'Choose a username' });
  }
  if (cleanUsername.length < 3 || cleanUsername.length > 20) {
    return res.status(400).json({ error: 'Username must be between 3 and 20 characters' });
  }
  if (!/^[a-zA-Z0-9_]+$/.test(cleanUsername)) {
    return res.status(400).json({ error: 'Username may use letters, numbers, and underscores only' });
  }

  // The unique index is case-sensitive, but two people cannot meaningfully be
  // told apart by capitalisation alone — check the way a person would read it.
  const usernameTaken = db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(cleanUsername);
  if (usernameTaken) {
    return res.status(400).json({ error: 'That username is already taken' });
  }

  // The unique index is case-insensitive too, but check explicitly for a
  // clean 400 message — the UNIQUE-violation catch below is only the race backstop.
  const emailTaken = db.prepare('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE').get(normEmail);
  if (emailTaken) {
    return res.status(400).json({ error: 'Email address already registered' });
  }

  try {
    const salt = bcrypt.genSaltSync(10);
    const passwordHash = bcrypt.hashSync(password, salt);
    const userId = `user-${Date.now()}`;
    const skillsJSON = JSON.stringify(skills || []);

    // Organizers start unverified (verified = 0) and require admin approval. 
    // Students and admins start verified (1).
    const verifiedVal = role === 'organizer' ? 0 : 1;

    // When verification is not required there is nothing to confirm, so the
    // address counts as settled. Task 6 sends the confirmation mail when it is.
    const emailVerifiedVal = REQUIRE_EMAIL_VERIFICATION ? 0 : 1;

    const stmt = db.prepare(`
      INSERT INTO users (id, name, email, username, password_hash, grade, role, verified, email_verified, avatar, bio, school, skills, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(userId, name, normEmail, cleanUsername, passwordHash, grade, role, verifiedVal, emailVerifiedVal, avatar || '👤', bio || '', school || '', skillsJSON, new Date().toISOString());

    const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    const user = formatUserResponse(userRow);
    if (REQUIRE_EMAIL_VERIFICATION) {
      const verifyToken = issueVerificationToken(userId);
      sendVerificationEmail(normEmail, verifyToken).catch(err =>
        console.error('Verification email failed to send:', err)
      );
    }
    const token = jwt.sign({ id: user.id, role: user.role, email: user.email, name: user.name, tokenVersion: userRow.token_version ?? 0 }, JWT_SECRET, { expiresIn: '7d' });

    res.cookie(COOKIE_NAME, token, cookieOptions());
    res.status(201).json({ user });
  } catch (error) {
    console.error('Signup error:', error);
    if (error.message.includes('UNIQUE')) {
      const field = error.message.includes('username') ? 'Username' : 'Email address';
      return res.status(400).json({ error: `${field} already registered` });
    }
    res.status(500).json({ error: 'Internal server error during registration' });
  }
});

// 2. Login
router.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    // COLLATE NOCASE: existing mixed-case rows (pre-normalisation, or
    // dedupe survivors) still authenticate during the transition.
    const userRow = db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(String(email).trim());

    if (!userRow) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const isMatch = bcrypt.compareSync(password, userRow.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = formatUserResponse(userRow);
    const token = jwt.sign({ id: user.id, role: user.role, email: user.email, name: user.name, tokenVersion: userRow.token_version ?? 0 }, JWT_SECRET, { expiresIn: '7d' });

    res.cookie(COOKIE_NAME, token, cookieOptions());
    res.json({ user });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error during login' });
  }
});

// 3. Get Authenticated User Details (Me)
router.get('/api/auth/me', authenticateToken, (req, res) => {
  try {
    const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!userRow) return res.status(404).json({ error: 'User not found' });
    
    res.json(formatUserResponse(userRow));
  } catch (error) {
    console.error('Auth check error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/api/auth/logout', authenticateToken, (req, res) => {
  try {
    db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(req.user.id);
    res.clearCookie(COOKIE_NAME);
    res.json({ success: true });
  } catch (err) {
    console.error('Logout error:', err);
    res.status(500).json({ error: 'Failed to logout' });
  }
});

/**
 * Step 1 of password reset: issue a single-use, expiring token and mail it.
 *
 * The response is identical whether or not the address is registered — a
 * differing response here is an account-enumeration oracle, and this endpoint
 * is unauthenticated.
 */
router.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  const SAME_ANSWER = {
    success: true,
    message: 'If that address has an account, a reset link is on its way.'
  };

  if (!email) return res.status(400).json({ error: 'Email is required' });

  try {
    // COLLATE NOCASE: someone typing Leo.Chen@… who registered leo.chen@…
    // should still get their mail, not silence.
    const user = db.prepare('SELECT id, email FROM users WHERE email = ? COLLATE NOCASE').get(String(email).trim());

    if (user) {
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

      // One live token per user: issuing a new link invalidates the old one.
      db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run(user.id);
      db.prepare('INSERT INTO password_reset_tokens (token, user_id, expires_at) VALUES (?, ?, ?)')
        .run(token, user.id, expiresAt);

      await sendPasswordResetEmail(user.email, token);
    }

    res.json(SAME_ANSWER);
  } catch (err) {
    console.error('Forgot password error:', err);
    res.json(SAME_ANSWER);
  }
});

/** Step 2: exchange the token for a new password. Single use. */
router.post('/api/auth/reset-password', (req, res) => {
  const { token, password } = req.body;

  if (!token || !password) {
    return res.status(400).json({ error: 'Token and password are required' });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters long' });
  }

  try {
    const row = db.prepare('SELECT * FROM password_reset_tokens WHERE token = ?').get(token);
    if (!row) {
      return res.status(400).json({ error: 'That reset link is not valid. Request a new one.' });
    }

    if (new Date(row.expires_at) < new Date()) {
      db.prepare('DELETE FROM password_reset_tokens WHERE token = ?').run(token);
      return res.status(400).json({ error: 'That reset link has expired. Request a new one.' });
    }

    const passwordHash = bcrypt.hashSync(password, bcrypt.genSaltSync(10));

    inTransaction(() => {
      db.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?').run(passwordHash, row.user_id);
      db.prepare('DELETE FROM password_reset_tokens WHERE token = ?').run(token);
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Could not reset the password' });
  }
});

/** Confirms an address from the link in the welcome email. Single use. */
router.post('/api/auth/verify-email', (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token is required' });

  try {
    const row = db.prepare('SELECT * FROM email_verification_tokens WHERE token = ?').get(token);
    if (!row) {
      return res.status(400).json({ error: 'That confirmation link is not valid. Request a new one.' });
    }
    if (new Date(row.expires_at) < new Date()) {
      db.prepare('DELETE FROM email_verification_tokens WHERE token = ?').run(token);
      return res.status(400).json({ error: 'That confirmation link has expired. Request a new one.' });
    }

    inTransaction(() => {
      db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(row.user_id);
      db.prepare('DELETE FROM email_verification_tokens WHERE token = ?').run(token);
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Verify email error:', err);
    res.status(500).json({ error: 'Could not confirm that address' });
  }
});

/** Sends a fresh confirmation link to the signed-in user's own address. */
router.post('/api/auth/resend-verification', authenticateToken, async (req, res) => {
  try {
    const user = db.prepare('SELECT id, email, email_verified FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.email_verified === 1) {
      return res.json({ success: true, message: 'That address is already confirmed.' });
    }

    const token = issueVerificationToken(user.id);
    await sendVerificationEmail(user.email, token);

    res.json({ success: true });
  } catch (err) {
    console.error('Resend verification error:', err);
    res.status(500).json({ error: 'Could not resend the confirmation email' });
  }
});

if (DEMO_MODE) {
  router.post('/api/auth/reset', (req, res) => {
    try {
      console.log('Resetting database tables to seeds...');
      // Drop children before parents; includes V2 tables so re-seeding never
      // collides with stale rows (seed ids are fixed strings). auto_select_runs
      // is in the list because its rows reference those fixed event ids — left
      // behind, a stale confirmed run attaches itself to a freshly seeded event
      // and blocks Auto Select from running on it.
      db.exec('DROP TABLE IF EXISTS hours_ledger');
      db.exec('DROP TABLE IF EXISTS attendance_checkin');
      db.exec('DROP TABLE IF EXISTS auto_select_runs');
      db.exec('DROP TABLE IF EXISTS event_announcements');
      db.exec('DROP TABLE IF EXISTS user_favorites');
      db.exec('DROP TABLE IF EXISTS event_comments');
      db.exec('DROP TABLE IF EXISTS notifications');
      db.exec('DROP TABLE IF EXISTS attendance');
      db.exec('DROP TABLE IF EXISTS applications');
      db.exec('DROP TABLE IF EXISTS slots');
      db.exec('DROP TABLE IF EXISTS events');
      db.exec('DROP TABLE IF EXISTS users');

      initDatabase();
      res.json({ success: true });
    } catch (error) {
      console.error('Reset database error:', error);
      res.status(500).json({ error: 'Internal server error resetting database' });
    }
  });
} else {
  console.log('[Security] DEMO_MODE is off — the database reset endpoint is not registered.');
}

// ────────────────────────────────────────────────────────────────────
// V2 ENHANCED FEATURES — Notifications, Comments, Favorites, etc.
// ────────────────────────────────────────────────────────────────────

// 15. List my notifications

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
        AND s.start_datetime > datetime('now') AND e.status != 'cancelled'
      ORDER BY s.start_datetime ASC
    `).all(req.params.id);

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
    const { name, avatar, bio, school, skills, grade, leaderboardOptIn } = req.body;
    const updates = [];
    const values = [];

    if (name !== undefined) { updates.push('name = ?'); values.push(name.trim()); }
    if (avatar !== undefined) { updates.push('avatar = ?'); values.push(avatar); }
    if (bio !== undefined) { updates.push('bio = ?'); values.push(bio); }
    if (school !== undefined) { updates.push('school = ?'); values.push(school); }
    if (grade !== undefined) {
      if (!VALID_GRADES.includes(grade)) {
        return res.status(400).json({ error: `Grade must be one of: ${VALID_GRADES.join(', ')}` });
      }
      updates.push('grade = ?'); values.push(grade);
    }
    if (skills !== undefined) { updates.push('skills = ?'); values.push(JSON.stringify(skills || [])); }
    if (leaderboardOptIn !== undefined) { updates.push('leaderboard_opt_in = ?'); values.push(leaderboardOptIn ? 1 : 0); }

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

export default router;
