import jwt from 'jsonwebtoken';
import { db } from './db.js';
import { JWT_SECRET, REQUIRE_EMAIL_VERIFICATION, EMAIL_GATE_ALLOWLIST } from './config.js';

// --- AUTHENTICATION MIDDLEWARE ---
export function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Format: Bearer TOKEN

  if (!token) return res.status(401).json({ error: 'Access token required' });

  jwt.verify(token, JWT_SECRET, (err, decodedUser) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });

    // Re-derive identity from the database on every request rather than
    // trusting the (up to 7-day-old) token payload, so a deleted user's
    // token stops working and a role/email change takes effect immediately.
    const userRow = db.prepare(
      'SELECT id, role, email, name, email_verified, token_version FROM users WHERE id = ?'
    ).get(decodedUser.id);

    if (!userRow) return res.status(401).json({ error: 'Account no longer exists' });

    if ((decodedUser.tokenVersion ?? 0) !== userRow.token_version) {
      return res.status(401).json({ error: 'Session expired, please sign in again' });
    }

    req.user = {
      id: userRow.id,
      role: userRow.role,
      email: userRow.email,
      name: userRow.name,
      email_verified: userRow.email_verified
    };

    if (
      REQUIRE_EMAIL_VERIFICATION &&
      userRow.email_verified !== 1 &&
      !EMAIL_GATE_ALLOWLIST.includes(req.path)
    ) {
      return res.status(403).json({
        error: 'Please verify your email address to continue.',
        code: 'email_unverified'
      });
    }

    next();
  });
}

// Helper to format database user row (calculating hours dynamically from Attendance)
export function formatUserResponse(row) {
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
    username: row.username || null,
    email: row.email,
    grade: row.grade,
    role: row.role,
    verified: row.verified === 1,
    emailVerified: row.email_verified === 1,
    leaderboardOptIn: row.leaderboard_opt_in === 1,
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
export function inTransaction(fn) {
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
export const NOTIFICATION_KINDS = [
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
export function createNotification({ userId, kind, title, body, link = null, dedupeKey = null }) {
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
export function runNotificationSweep() {
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
          WHERE a.event_id = e.id AND a.user_id = f.user_id AND a.status NOT IN ('rejected', 'withdrawn')
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
export function countdownPhrase(iso) {
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const days = Math.round((startOfDay(new Date(iso)) - startOfDay(new Date())) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

/** Notify every confirmed volunteer on an event. Returns how many were told. */
export function notifyConfirmedVolunteers(eventId, { kind, title, body, dedupeKey = null }) {
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
export function handleWaitlistPromotion(slotId, eventId, eventTitle, organizerId) {
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

export const MILESTONE_TIERS = [
  { id: 'first-shift', label: 'First shift', hint: 'Completed your first volunteer shift', test: (h, e) => e >= 1 },
  { id: 'ten-hours', label: '10 hours', hint: 'Ten hours of service', test: (h) => h >= 10 },
  { id: 'five-events', label: '5 events', hint: 'Helped at five different events', test: (h, e) => e >= 5 },
  { id: 'silver', label: 'Silver Award', hint: '25 hours — the district Silver Award target', test: (h) => h >= 25 },
  { id: 'fifty-hours', label: '50 hours', hint: 'Fifty hours of service', test: (h) => h >= 50 },
  { id: 'ten-events', label: '10 events', hint: 'Helped at ten different events', test: (h, e) => e >= 10 },
  { id: 'century', label: '100 hours', hint: 'One hundred hours of service', test: (h) => h >= 100 }
];

export function buildMilestones(hours, events) {
  return MILESTONE_TIERS.map(m => ({
    id: m.id,
    label: m.label,
    hint: m.hint,
    earned: m.test(hours, events)
  }));
}

export function certificateCode(userId, eventId) {
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

