import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { db, initDatabase } from './db.js';
import { createRandom, performWeightedSelection } from './weighting.js';
import {
  recordCheckins, getCheckins, finalizeAttendance,
  computeEventCompletion, attendanceOnSlots, eventAttendanceCount
} from './attendance.js';

const app = express();
// Namespaced env var: tooling often injects a generic PORT for the frontend
const PORT = Number(process.env.API_PORT) || 5050;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

/**
 * Demo scaffolding — the account switcher and the database reset — is opt-in,
 * never opt-out.
 *
 * Keying this to `NODE_ENV !== 'production'` would fail open: NODE_ENV is unset
 * on a plain `node server.js`, so a real deployment that forgot to set it would
 * silently expose a route that drops every table. An explicit flag fails closed
 * instead — absent it, the route is never registered at all.
 */
const DEMO_MODE = process.env.DEMO_MODE === 'true';

/**
 * In production the signing secret must come from the environment. A committed
 * fallback means every deployment shares a key that is readable on GitHub, and
 * anyone holding it can mint a token for any user — including an admin.
 */
const JWT_SECRET = process.env.JWT_SECRET || 'sbvolunteers_secret_key_12345';
if (IS_PRODUCTION && !process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET must be set in production. Refusing to start.');
  process.exit(1);
}
if (IS_PRODUCTION && DEMO_MODE) {
  console.error('FATAL: DEMO_MODE cannot be enabled in production. Refusing to start.');
  process.exit(1);
}

const VALID_GRADES = ['9', '10', '11', '12', 'Adult', 'N/A'];
const VALID_CATEGORIES = ['School', '5K', 'Food Pantry', 'Fundraiser', 'Other'];

// Initialize SQLite database schema and seed data
initDatabase();

/**
 * Rate limiters key on client IP, which behind a reverse proxy is the proxy's.
 * Trusting `X-Forwarded-For` unconditionally is worse than not trusting it at
 * all: any client could then spoof the header and get a fresh bucket per
 * request. So this is opt-in and must match the actual hop count.
 */
if (process.env.TRUST_PROXY) {
  const value = Number(process.env.TRUST_PROXY);
  app.set('trust proxy', Number.isNaN(value) ? process.env.TRUST_PROXY : value);
}

// Baseline security headers. CSP is deliberately omitted: this server returns
// JSON only, and the client's stylesheet pulls fonts from Google. A policy
// belongs wherever the HTML is served — see roadmap item 1.18.
app.use(helmet({
  contentSecurityPolicy: false,
  // Default is same-origin, which breaks any deployment serving the client
  // from a different origin than the API.
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

/**
 * CORS allowlist. Requests with no Origin header — curl, server-to-server, and
 * same-origin browser requests — are always allowed; only cross-origin browser
 * traffic is checked against the list.
 */
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:4173')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error(`Origin not allowed by CORS: ${origin}`));
  },
  credentials: true
}));

app.use(express.json({ limit: '100kb' }));

/**
 * Two tiers. The strict one guards credential endpoints, where an attacker
 * gets unlimited guesses against six-character passwords on accounts holding
 * minors' service records. The loose one is a blunt ceiling on everything else.
 *
 * In-memory storage is correct for a single-process SQLite deployment. Running
 * more than one instance would need a shared store.
 */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: DEMO_MODE ? 1000 : 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // Failed sign-ins are what we are counting; a correct password shouldn't
  // burn the budget of someone sharing a school's NAT address.
  skipSuccessfulRequests: true,
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' }
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: DEMO_MODE ? 10000 : 600,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' }
});

app.use('/api/auth/login', authLimiter);
app.use('/api/auth/signup', authLimiter);
app.use('/api', apiLimiter);

// --- AUTHENTICATION MIDDLEWARE ---
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Format: Bearer TOKEN

  if (!token) return res.status(401).json({ error: 'Access token required' });

  jwt.verify(token, JWT_SECRET, (err, decodedUser) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = decodedUser;
    next();
  });
}

// Helper to format database user row (calculating hours dynamically from Attendance)
function formatUserResponse(row) {
  if (!row) return null;

  // Calculate hours dynamically from confirmed attendance records where student was present
  const hoursRow = db.prepare(`
    SELECT SUM(hours_awarded) as total
    FROM attendance
    WHERE user_id = ? AND present = 1
  `).get(row.id);

  const totalHours = hoursRow && hoursRow.total ? Number(hoursRow.total) : 0.0;

  return {
    id: row.id,
    name: row.name,
    email: row.email,
    grade: row.grade,
    role: row.role,
    verified: row.verified === 1,
    avatar: row.avatar,
    volunteeredHours: totalHours,
    bio: row.bio,
    school: row.school,
    skills: row.skills ? JSON.parse(row.skills) : [],
    createdAt: row.created_at
  };
}

// Helper to push a notification to a user
/**
 * Runs `fn` inside a transaction, rolling back if it throws.
 *
 * `node:sqlite`'s DatabaseSync has no `.transaction()` helper — that belongs to
 * better-sqlite3 — so multi-statement writes have to drive BEGIN/COMMIT
 * directly or they fail at runtime and leave partial data behind.
 */
function inTransaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

/**
 * Notification kinds. Kept as a closed set so the client can map each to an
 * icon and a filter without guessing.
 */
const NOTIFICATION_KINDS = [
  'accepted',      // selected for a shift
  'waitlisted',    // placed on the waitlist
  'promoted',      // moved off the waitlist into a spot
  'declined',      // not selected this time
  'deadline',      // applications close soon on something you starred
  'reminder',      // your shift is coming up
  'announcement',  // organizer posted an update
  'location',      // the meeting place changed
  'hours',         // attendance confirmed / hours credited
  'cancelled',     // the event was called off
  'application',   // organizer-facing: someone applied
  'approval',      // organizer account approved
  'comment',       // someone asked a question on your event
  'info'
];

/**
 * Writes a notification.
 *
 * `dedupeKey` makes the write idempotent per user: the repeating sweep can run
 * every few minutes and re-attempt the same reminder without ever producing a
 * duplicate, because a unique index rejects the second insert.
 */
function createNotification({ userId, kind, title, body, link = null, dedupeKey = null }) {
  try {
    if (!NOTIFICATION_KINDS.includes(kind)) {
      console.warn(`Unknown notification kind "${kind}" — falling back to info.`);
      kind = 'info';
    }
    const id = `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    db.prepare(`
      INSERT INTO notifications (id, user_id, kind, title, body, link, read, created_at, dedupe_key)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(id, userId, kind, title, body || '', link, new Date().toISOString(), dedupeKey);
    return id;
  } catch (e) {
    // A UNIQUE violation means we already sent this one — that's success.
    if (String(e.message).includes('UNIQUE')) return null;
    console.error('Failed to create notification:', e);
    return null;
  }
}

/**
 * Time-based notifications, generated by a sweep rather than by a user action.
 *
 * Two kinds, both deliberately conservative so the bell stays worth checking:
 *   • deadline — applications close within 48h on an event you starred but
 *     have not applied to. Only useful to someone who showed intent.
 *   • reminder — a shift you are confirmed for starts within 24h.
 */
function runNotificationSweep() {
  const now = new Date();
  const in48h = new Date(now.getTime() + 48 * 3600 * 1000).toISOString();
  const in24h = new Date(now.getTime() + 24 * 3600 * 1000).toISOString();
  let created = 0;

  try {
    // Deadline approaching on a starred event the student hasn't applied to
    const closingSoon = db.prepare(`
      SELECT f.user_id, e.id as event_id, e.title, e.application_deadline
      FROM user_favorites f
      JOIN events e ON f.event_id = e.id
      WHERE e.status = 'open'
        AND e.application_deadline > ?
        AND e.application_deadline <= ?
        AND NOT EXISTS (
          SELECT 1 FROM applications a
          WHERE a.event_id = e.id AND a.user_id = f.user_id AND a.status != 'rejected'
        )
    `).all(now.toISOString(), in48h);

    for (const row of closingSoon) {
      if (createNotification({
        userId: row.user_id,
        kind: 'deadline',
        title: 'Applications close soon',
        body: `"${row.title}" stops accepting applications ${countdownPhrase(row.application_deadline)}.`,
        link: `event:${row.event_id}`,
        dedupeKey: `deadline:${row.event_id}`
      })) created++;
    }

    // Shift starting within 24h for confirmed volunteers
    const upcoming = db.prepare(`
      SELECT a.user_id, e.id as event_id, e.title, e.location, s.id as slot_id,
             s.name as slot_name, s.start_datetime
      FROM applications a
      JOIN slots s ON a.slot_id = s.id
      JOIN events e ON a.event_id = e.id
      WHERE a.status = 'accepted'
        AND e.status != 'cancelled'
        AND s.start_datetime > ?
        AND s.start_datetime <= ?
    `).all(now.toISOString(), in24h);

    for (const row of upcoming) {
      if (createNotification({
        userId: row.user_id,
        kind: 'reminder',
        title: 'Your shift is tomorrow',
        body: `${row.title} — ${row.slot_name} at ${row.location}.`,
        link: `event:${row.event_id}`,
        dedupeKey: `reminder:${row.slot_id}`
      })) created++;
    }
  } catch (err) {
    console.error('Notification sweep failed:', err);
  }

  if (created > 0) console.log(`[Notifications] Sent ${created} time-based notification(s).`);
  return created;
}

/** "in 3 days" / "tomorrow" / "today", for notification copy. */
function countdownPhrase(iso) {
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const days = Math.round((startOfDay(new Date(iso)) - startOfDay(new Date())) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

/** Notify every confirmed volunteer on an event. Returns how many were told. */
function notifyConfirmedVolunteers(eventId, { kind, title, body, dedupeKey = null }) {
  const recipients = db.prepare(`
    SELECT DISTINCT user_id FROM applications
    WHERE event_id = ? AND status = 'accepted'
  `).all(eventId);
  let sent = 0;
  for (const r of recipients) {
    if (createNotification({
      userId: r.user_id, kind, title, body,
      link: `event:${eventId}`,
      dedupeKey: dedupeKey ? `${dedupeKey}:${r.user_id}` : null
    })) sent++;
  }
  return sent;
}

// Automatically promotes the first student on the waitlist for a slot
function handleWaitlistPromotion(slotId, eventId, eventTitle, organizerId) {
  try {
    const nextInLine = db.prepare(`
      SELECT a.*, u.name as volunteer_name
      FROM applications a
      JOIN users u ON a.user_id = u.id
      WHERE a.slot_id = ? AND a.status = 'waitlisted'
      ORDER BY a.waitlist_order ASC LIMIT 1
    `).get(slotId);

    if (!nextInLine) return;

    // Promote next in line
    db.prepare("UPDATE applications SET status = 'accepted', waitlist_order = NULL WHERE id = ?").run(nextInLine.id);

    // Get slot details
    const slot = db.prepare('SELECT name FROM slots WHERE id = ?').get(slotId);
    const slotName = slot ? slot.name : 'Shift';

    // Notify promoted student
    createNotification({
      userId: nextInLine.user_id,
      kind: 'promoted',
      title: 'Promoted from waitlist!',
      body: `A spot opened up. You have been promoted to accepted for "${eventTitle}" — ${slotName}!`,
      link: `event:${eventId}`
    });

    // Notify organizer of promotion
    createNotification({
      userId: organizerId,
      kind: 'application',
      title: 'Waitlist promotion occurred',
      body: `${nextInLine.volunteer_name} was automatically promoted from the waitlist for "${eventTitle}" — ${slotName}.`,
      link: `event:${eventId}`
    });

    // Shift ranks of remaining waitlisted applications for this slot
    const remaining = db.prepare(`
      SELECT id FROM applications
      WHERE slot_id = ? AND status = 'waitlisted'
      ORDER BY waitlist_order ASC
    `).all(slotId);

    const updateRank = db.prepare('UPDATE applications SET waitlist_order = ? WHERE id = ?');
    remaining.forEach((r, idx) => {
      updateRank.run(idx + 1, r.id);
    });
  } catch (err) {
    console.error('Waitlist promotion error:', err);
  }
}

// --- API ENDPOINTS ---

// 1. Sign Up
app.post('/api/auth/signup', (req, res) => {
  const { email, password, name, role, grade, avatar, bio, school, skills } = req.body;

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
  if (String(password).length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters long' });
  }

  try {
    const salt = bcrypt.genSaltSync(10);
    const passwordHash = bcrypt.hashSync(password, salt);
    const userId = `user-${Date.now()}`;
    const skillsJSON = JSON.stringify(skills || []);

    // Organizers start unverified (verified = 0) and require admin approval. 
    // Students and admins start verified (1).
    const verifiedVal = role === 'organizer' ? 0 : 1;

    const stmt = db.prepare(`
      INSERT INTO users (id, name, email, password_hash, grade, role, verified, avatar, bio, school, skills, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(userId, name, email, passwordHash, grade, role, verifiedVal, avatar || '👤', bio || '', school || '', skillsJSON, new Date().toISOString());

    const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    const user = formatUserResponse(userRow);
    const token = jwt.sign({ id: user.id, role: user.role, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '7d' });

    res.status(201).json({ user, token });
  } catch (error) {
    console.error('Signup error:', error);
    if (error.message.includes('UNIQUE')) {
      return res.status(400).json({ error: 'Email address already registered' });
    }
    res.status(500).json({ error: 'Internal server error during registration' });
  }
});

// 2. Login
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const userRow = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    
    if (!userRow) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const isMatch = bcrypt.compareSync(password, userRow.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = formatUserResponse(userRow);
    const token = jwt.sign({ id: user.id, role: user.role, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '7d' });

    res.json({ user, token });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error during login' });
  }
});

// 3. Get Authenticated User Details (Me)
app.get('/api/auth/me', authenticateToken, (req, res) => {
  try {
    const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!userRow) return res.status(404).json({ error: 'User not found' });
    
    res.json(formatUserResponse(userRow));
  } catch (error) {
    console.error('Auth check error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 4. Fetch All Events (Calculating remaining spots and attaching organizers)
app.get('/api/events', (req, res) => {
  try {
    const events = db.prepare(`
      SELECT e.*, u.name as organizer_name, u.verified as organizer_verified,
             u.school as organizer_school
      FROM events e
      JOIN users u ON e.organizer_id = u.id
    `).all();
    
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


    const formattedEvents = events.map(event => {
      const slots = slotsByEvent.get(event.id) || [];

      const formattedSlots = slots.map(s => {
        const acceptedCount = acceptedBySlot.get(s.id) || 0;

        const start = new Date(s.start_datetime);
        const end = new Date(s.end_datetime);
        const hours = Math.max(0.1, Number(((end - start) / (1000 * 60 * 60)).toFixed(2)));

        return {
          id: s.id,
          name: s.name,
          description: s.description,
          startDatetime: s.start_datetime,
          endDatetime: s.end_datetime,
          maxSpots: Number(s.max_spots),
          spotsRemaining: Math.max(0, s.max_spots - acceptedCount),
          hours: hours
        };
      });

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
        instructions: event.instructions || '',
        organizerId: event.organizer_id,
        organizerName: event.organizer_name,
        organizerVerified: event.organizer_verified === 1,
        organizerSchool: event.organizer_school || '',
        status: event.status,
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

app.post('/api/events', authenticateToken, (req, res) => {
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
app.get('/api/applications', authenticateToken, (req, res) => {
  try {
    let rows;
    if (req.user.role === 'student') {
      rows = db.prepare(`
        SELECT a.*, u.name, u.avatar, u.school, u.grade, u.bio, u.skills,
               e.title as event_title,
               s.name as slot_name, s.description as slot_description, s.start_datetime as slot_start_datetime, s.end_datetime as slot_end_datetime, s.max_spots as slot_max_spots
        FROM applications a
        JOIN users u ON a.user_id = u.id
        JOIN events e ON a.event_id = e.id
        JOIN slots s ON a.slot_id = s.id
        WHERE a.user_id = ?
      `).all(req.user.id);
    } else if (req.user.role === 'organizer') {
      rows = db.prepare(`
        SELECT a.*, u.name, u.avatar, u.school, u.grade, u.bio, u.skills,
               e.title as event_title,
               s.name as slot_name, s.description as slot_description, s.start_datetime as slot_start_datetime, s.end_datetime as slot_end_datetime, s.max_spots as slot_max_spots
        FROM applications a
        JOIN users u ON a.user_id = u.id
        JOIN events e ON a.event_id = e.id
        JOIN slots s ON a.slot_id = s.id
        WHERE e.organizer_id = ?
      `).all(req.user.id);
    } else {
      // Admin sees everything
      rows = db.prepare(`
        SELECT a.*, u.name, u.avatar, u.school, u.grade, u.bio, u.skills,
               e.title as event_title,
               s.name as slot_name, s.description as slot_description, s.start_datetime as slot_start_datetime, s.end_datetime as slot_end_datetime, s.max_spots as slot_max_spots
        FROM applications a
        JOIN users u ON a.user_id = u.id
        JOIN events e ON a.event_id = e.id
        JOIN slots s ON a.slot_id = s.id
      `).all();
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
app.post('/api/events/:id/apply', authenticateToken, (req, res) => {
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
app.patch('/api/applications/:id', authenticateToken, (req, res) => {
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
app.post('/api/events/:id/checkin', authenticateToken, (req, res) => {
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

app.get('/api/events/:id/checkin', authenticateToken, (req, res) => {
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
app.post('/api/events/:id/attendance', authenticateToken, (req, res) => {
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
app.put('/api/events/:id', authenticateToken, (req, res) => {
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
app.post('/api/events/:id/auto-approve', authenticateToken, (req, res) => {
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
app.patch('/api/events/:id', authenticateToken, (req, res) => {
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
app.get('/api/admin/organizers/pending', authenticateToken, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied: Administrators only' });
  }

  try {
    const rows = db.prepare("SELECT * FROM users WHERE role = 'organizer' AND verified = 0").all();
    const formatted = rows.map(r => formatUserResponse(r));
    res.json(formatted);
  } catch (error) {
    console.error('Pending organizers error:', error);
    res.status(500).json({ error: 'Internal server error fetching pending organizer queue' });
  }
});

// A2. Verify Organizer account
app.post('/api/admin/organizers/:id/approve', authenticateToken, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied: Administrators only' });
  }

  const orgId = req.params.id;

  try {
    db.prepare('UPDATE users SET verified = 1 WHERE id = ?').run(orgId);
    createNotification({
      userId: orgId,
      kind: 'approval',
      title: 'Account approved!',
      body: 'Your organizer account is verified. You can now post events.'
    });
    res.json({ success: true });
  } catch (error) {
    console.error('Verify organizer error:', error);
    res.status(500).json({ error: 'Internal server error verifying account' });
  }
});

// A3. Deny Organizer account
app.post('/api/admin/organizers/:id/deny', authenticateToken, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied: Administrators only' });
  }

  const orgId = req.params.id;

  try {
    // Scoped deliberately. An unscoped delete by id lets a mistyped or guessed
    // id remove a student — and ON DELETE CASCADE takes their attendance rows
    // with them, silently destroying credited service hours. Denial only ever
    // applies to an organizer who has not been approved yet, and who therefore
    // has no events and no volunteers attached.
    const target = db.prepare(
      "SELECT id FROM users WHERE id = ? AND role = 'organizer' AND verified = 0"
    ).get(orgId);

    if (!target) {
      return res.status(404).json({
        error: 'No pending organizer request matches that id. Approved organizers cannot be deleted here.'
      });
    }

    db.prepare("DELETE FROM users WHERE id = ? AND role = 'organizer' AND verified = 0").run(orgId);
    res.json({ success: true });
  } catch (error) {
    console.error('Deny organizer error:', error);
    res.status(500).json({ error: 'Internal server error denying registration request' });
  }
});

// A4. Remove Event Listing
app.delete('/api/events/:id', authenticateToken, (req, res) => {
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
      db.prepare('DELETE FROM attendance WHERE event_id = ?').run(eventId);
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
app.patch('/api/events/:id/status', authenticateToken, (req, res) => {
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
app.get('/api/events/:id/roster.csv', authenticateToken, (req, res) => {
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


// 14. Reset Database (demo facility — registered only when DEMO_MODE is on)
//
// This drops every table in the database. It exists so the demo can be
// restored to its seed state, and it must never reach a real deployment: one
// unauthenticated request would destroy every student's service record.
// Registering it conditionally means production returns the standard /api 404
// rather than advertising that the route exists at all.
if (DEMO_MODE) {
  app.post('/api/auth/reset', (req, res) => {
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
app.get('/api/notifications', authenticateToken, (req, res) => {
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
app.patch('/api/notifications', authenticateToken, (req, res) => {
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
app.get('/api/events/:id/comments', authenticateToken, (req, res) => {
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

app.post('/api/events/:id/comments', authenticateToken, (req, res) => {
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

app.delete('/api/comments/:id', authenticateToken, (req, res) => {
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
app.get('/api/events/:id/attendees', authenticateToken, (req, res) => {
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
app.get('/api/events/:id/announcements', authenticateToken, (req, res) => {
  try {
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

app.post('/api/events/:id/announcements', authenticateToken, (req, res) => {
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

app.patch('/api/announcements/:id', authenticateToken, (req, res) => {
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

app.delete('/api/announcements/:id', authenticateToken, (req, res) => {
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
app.get('/api/users/:id/profile', authenticateToken, (req, res) => {
  try {
    const row = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'student'").get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Volunteer not found' });

    const isSelf = req.params.id === req.user.id;
    const isStaff = req.user.role === 'admin' || req.user.role === 'organizer';

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
        grade: row.grade,
        bio: row.bio,
        school: row.school,
        skills: row.skills ? JSON.parse(row.skills) : [],
        joinedAt: row.created_at,
        // Contact details stay with the person and the adults coordinating them
        email: isSelf || isStaff ? row.email : null
      },
      stats: {
        hours: Number(totals.hours) || 0,
        eventsCompleted: totals.events || 0,
        shiftsCompleted: totals.shifts || 0,
        upcomingCount: upcoming.length,
        pendingCount
      },
      milestones: buildMilestones(Number(totals.hours) || 0, totals.events || 0),
      byCategory: byCategory.map(c => ({ category: c.category, hours: Number(c.hours) })),
      completed: completed.map(formatServiceRow),
      upcoming: upcoming.map(u => ({
        eventId: u.event_id, title: u.title, category: u.category, location: u.location,
        slotName: u.slot_name, startDatetime: u.start_datetime, endDatetime: u.end_datetime
      }))
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
app.get('/api/certificates', authenticateToken, (req, res) => {
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
      code: certificateCode(req.user.id, r.event_id)
    })));
  } catch (err) {
    console.error('Certificates error:', err);
    res.status(500).json({ error: 'Failed to load certificates' });
  }
});

/**
 * Deterministic, human-readable verification code (e.g. "SBV-4KD9-2M7X").
 * Not a secret — it identifies a record so it can be checked, the same way a
 * receipt number does.
 */
function certificateCode(userId, eventId) {
  const source = `sbv::${userId}::${eventId}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < source.length; i++) {
    h1 = Math.imul(h1 ^ source.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 + source.charCodeAt(i) * (i + 1), 0x85ebca6b) >>> 0;
  }
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // no 0/O/1/I
  const block = (n) => Array.from({ length: 4 }, (_, i) =>
    alphabet[(n >>> (i * 5)) % alphabet.length]).join('');
  return `SBV-${block(h1)}-${block(h2)}`;
}

// Public check of a certificate code — how a school office verifies a printout
app.get('/api/certificates/verify/:code', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT at.user_id, u.name as volunteer_name, u.grade,
             e.id as event_id, e.title, org.name as organizer_name,
             COALESCE(SUM(at.hours_awarded), 0) as hours,
             MAX(s.end_datetime) as last_end
      FROM attendance at
      JOIN slots s ON at.slot_id = s.id
      JOIN events e ON at.event_id = e.id
      JOIN users u ON at.user_id = u.id
      JOIN users org ON e.organizer_id = org.id
      WHERE at.present = 1
      GROUP BY at.user_id, e.id
    `).all();

    const match = rows.find(r => certificateCode(r.user_id, r.event_id) === req.params.code.toUpperCase());
    if (!match) return res.status(404).json({ valid: false, error: 'No certificate matches that code' });

    res.json({
      valid: true,
      volunteerName: match.volunteer_name,
      grade: match.grade,
      eventTitle: match.title,
      organizerName: match.organizer_name,
      hours: Number(match.hours),
      completedAt: match.last_end
    });
  } catch (err) {
    res.status(500).json({ error: 'Verification failed' });
  }
});

// ── Organizer profile ───────────────────────────────────────────────
// The page a student checks before trusting an event.
app.get('/api/organizers/:id/profile', authenticateToken, (req, res) => {
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
app.get('/api/favorites', authenticateToken, (req, res) => {
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

app.post('/api/favorites/:eventId', authenticateToken, (req, res) => {
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
app.patch('/api/auth/profile', authenticateToken, (req, res) => {
  try {
    const { name, avatar, bio, school, skills, grade } = req.body;
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
app.get('/api/stats/volunteer', authenticateToken, (req, res) => {
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
app.get('/api/stats/organizer', authenticateToken, (req, res) => {
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
app.get('/api/leaderboard', authenticateToken, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT u.id, u.name, u.avatar, u.school, u.grade,
             COALESCE(SUM(a.hours_awarded), 0) as hours,
             COUNT(DISTINCT a.slot_id) as shifts
      FROM users u
      LEFT JOIN attendance a ON a.user_id = u.id AND a.present = 1
      WHERE u.role = 'student'
      GROUP BY u.id
      ORDER BY hours DESC, shifts DESC
      LIMIT 25
    `).all();
    res.json(rows.map((r, i) => ({
      rank: i + 1, id: r.id, name: r.name, avatar: r.avatar,
      school: r.school, grade: r.grade,
      hours: Number(r.hours), shifts: r.shifts
    })));
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
});

// 23. Skill-based recommendations
app.get('/api/recommendations', authenticateToken, (req, res) => {
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
app.post('/api/events/:id/duplicate', authenticateToken, (req, res) => {
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
app.get('/api/admin/stats', authenticateToken, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Access denied' });
  try {
    const totals = {
      users: db.prepare('SELECT COUNT(*) as c FROM users').get().c,
      students: db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'student'").get().c,
      organizers: db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'organizer'").get().c,
      events: db.prepare('SELECT COUNT(*) as c FROM events').get().c,
      applications: db.prepare('SELECT COUNT(*) as c FROM applications').get().c,
      hours: db.prepare('SELECT COALESCE(SUM(hours_awarded),0) as h FROM attendance WHERE present = 1').get().h,
      pendingOrganizers: db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'organizer' AND verified = 0").get().c
    };

    // ── Rates that tell staff whether the programme is healthy ──
    const attendance = db.prepare(`
      SELECT COUNT(*) as total, SUM(CASE WHEN present = 1 THEN 1 ELSE 0 END) as present
      FROM attendance
    `).get();
    const attendanceRate = attendance.total > 0
      ? Math.round((attendance.present / attendance.total) * 100) : null;

    const eventStatus = db.prepare(`
      SELECT status, COUNT(*) as c FROM events GROUP BY status
    `).all().reduce((acc, r) => ({ ...acc, [r.status]: r.c }), {});
    const finishedEvents = (eventStatus.completed || 0) + (eventStatus.cancelled || 0);
    const completionRate = finishedEvents > 0
      ? Math.round(((eventStatus.completed || 0) / finishedEvents) * 100) : null;

    // How many students actually volunteered vs merely registered
    const activeVolunteers = db.prepare(`
      SELECT COUNT(DISTINCT user_id) as c FROM attendance WHERE present = 1
    `).get().c;
    const participationRate = totals.students > 0
      ? Math.round((activeVolunteers / totals.students) * 100) : null;

    // Hours per month, last 6 months
    const monthlyHours = db.prepare(`
      SELECT strftime('%Y-%m', s.end_datetime) as month,
             COALESCE(SUM(at.hours_awarded), 0) as hours,
             COUNT(DISTINCT at.user_id) as volunteers
      FROM attendance at
      JOIN slots s ON at.slot_id = s.id
      WHERE at.present = 1 AND s.end_datetime >= date('now', '-6 months')
      GROUP BY month ORDER BY month ASC
    `).all();

    // Volunteers joining over time
    const signupsByMonth = db.prepare(`
      SELECT strftime('%Y-%m', created_at) as month, COUNT(*) as c
      FROM users WHERE role = 'student' AND created_at >= date('now', '-6 months')
      GROUP BY month ORDER BY month ASC
    `).all();

    const topOrganizers = db.prepare(`
      SELECT u.id, u.name, u.avatar, u.verified,
             COUNT(DISTINCT e.id) as events,
             COALESCE(SUM(at.hours_awarded), 0) as hours
      FROM users u
      JOIN events e ON e.organizer_id = u.id
      LEFT JOIN attendance at ON at.event_id = e.id AND at.present = 1
      WHERE u.role = 'organizer'
      GROUP BY u.id
      ORDER BY hours DESC, events DESC
      LIMIT 5
    `).all();

    const selectionSplit = db.prepare(`
      SELECT COALESCE(auto_approve, 0) as auto, COUNT(*) as c
      FROM events GROUP BY auto
    `).all().reduce((acc, r) => ({ ...acc, [r.auto === 1 ? 'autoSelect' : 'manual']: r.c }), {});

    res.json({
      ...totals,
      activeVolunteers,
      attendanceRate,
      completionRate,
      participationRate,
      eventStatus,
      monthlyHours: monthlyHours.map(m => ({
        month: m.month, hours: Number(m.hours), volunteers: m.volunteers
      })),
      signupsByMonth: signupsByMonth.map(m => ({ month: m.month, count: m.c })),
      topOrganizers: topOrganizers.map(o => ({
        id: o.id, name: o.name, avatar: o.avatar, verified: o.verified === 1,
        events: o.events, hours: Number(o.hours)
      })),
      selectionSplit: { manual: selectionSplit.manual || 0, autoSelect: selectionSplit.autoSelect || 0 }
    });
  } catch (err) {
    console.error('Admin stats error:', err);
    res.status(500).json({ error: 'Failed to fetch admin stats' });
  }
});

// A26. Fetch Auto Select Runs (Organizer & Admin only)
app.get('/api/events/:id/auto-select/runs', authenticateToken, (req, res) => {
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
app.post('/api/events/:id/auto-select/run', authenticateToken, (req, res) => {
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
app.post('/api/events/:id/auto-select/confirm', authenticateToken, (req, res) => {
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
app.use('/api', (req, res) => {
  res.status(404).json({ error: `Not found: ${req.method} ${req.originalUrl}` });
});

// Last-resort error handler (e.g. malformed JSON bodies)
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // A blocked cross-origin request is a configuration answer, not a crash —
  // reporting it as a 500 sends whoever deploys this hunting in the wrong place.
  if (String(err.message).startsWith('Origin not allowed by CORS')) {
    console.warn(err.message);
    return res.status(403).json({ error: 'Origin not allowed. Check the CORS_ORIGINS setting.' });
  }
  console.error('Unhandled error:', err);
  const status = err.type === 'entity.parse.failed' ? 400 : 500;
  res.status(status).json({ error: status === 400 ? 'Invalid JSON in request body' : 'Internal server error' });
});

// Start Express Server
// Time-based notifications: once at boot so a fresh database is current,
// then every 15 minutes. The dedupe key makes repeat runs harmless.
runNotificationSweep();
setInterval(runNotificationSweep, 15 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`SBVolunteers API Server listening on port ${PORT}`);
});
