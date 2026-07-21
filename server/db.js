import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import { createHoursLedgerTable, backfillHoursLedger, verifyLedgerParity } from './hoursLedger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, 'sbvolunteers.db');

const db = new DatabaseSync(dbPath);

/**
 * Adds a column only if it isn't already present. `ALTER TABLE ... ADD COLUMN`
 * throws on a duplicate, so existing databases would fail to boot otherwise.
 */
function addColumnIfMissing(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some(c => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  console.log(`Migration: added ${table}.${column}`);
}

export function initDatabase() {
  // Safe for restarts — only creates tables if they don't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      grade TEXT CHECK(grade IN ('9', '10', '11', '12', 'Adult', 'N/A')) NOT NULL,
      role TEXT CHECK(role IN ('student', 'organizer', 'admin')) NOT NULL,
      verified INTEGER DEFAULT 1,
      avatar TEXT,
      bio TEXT,
      school TEXT,
      skills TEXT,
      created_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT CHECK(category IN ('School', '5K', 'Food Pantry', 'Fundraiser', 'Other')) NOT NULL,
      location TEXT NOT NULL,
      application_deadline TEXT NOT NULL,
      organizer_id TEXT NOT NULL,
      status TEXT CHECK(status IN ('open', 'closed', 'completed', 'cancelled')) DEFAULT 'open',
      auto_approve INTEGER DEFAULT 0,
      selection_summary TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(organizer_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS slots (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      start_datetime TEXT NOT NULL,
      end_datetime TEXT NOT NULL,
      max_spots INTEGER NOT NULL,
      FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS applications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      slot_id TEXT NOT NULL,
      status TEXT CHECK(status IN ('pending', 'accepted', 'waitlisted', 'rejected')) DEFAULT 'pending',
      applied_at TEXT NOT NULL,
      waitlist_order INTEGER,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE,
      FOREIGN KEY(slot_id) REFERENCES slots(id) ON DELETE CASCADE,
      UNIQUE(user_id, slot_id)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS attendance (
      event_id TEXT NOT NULL,
      slot_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      present INTEGER CHECK(present IN (0, 1)) NOT NULL,
      hours_awarded REAL NOT NULL,
      PRIMARY KEY(slot_id, user_id),
      FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE,
      FOREIGN KEY(slot_id) REFERENCES slots(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // ── V2: New tables for enhanced features ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      link TEXT,
      read INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS event_comments (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS user_favorites (
      user_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(user_id, event_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
    )
  `);

  // Announcements: one-way updates from the organizer to everyone signed up —
  // location changes, what to bring, weather calls. Deliberately not a
  // messaging system: no replies, no direct messages between users.
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_announcements (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE,
      FOREIGN KEY(author_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS auto_select_runs (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      run_number INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      selected_ids TEXT NOT NULL,
      waitlist_ids TEXT NOT NULL,
      is_confirmed INTEGER DEFAULT 0,
      FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
    )
  `);

  // Columns added after the first release. CREATE TABLE IF NOT EXISTS won't
  // add them to an existing database, so they're applied explicitly.
  // Lets a repeating sweep (deadline reminders, shift reminders) know it has
  // already told this user about this thing, so notifications never duplicate.
  addColumnIfMissing('notifications', 'dedupe_key', 'TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe ON notifications(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL');

  addColumnIfMissing('events', 'instructions', 'TEXT');
  addColumnIfMissing('events', 'attendee_visibility', "TEXT NOT NULL DEFAULT 'accepted'");
  addColumnIfMissing('applications', 'waitlist_order', 'INTEGER');
  addColumnIfMissing('events', 'selection_summary', 'TEXT');

  // Indexes for performance
  db.exec(`CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_comments_event ON event_comments(event_id, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_announcements_event ON event_announcements(event_id, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_applications_event ON applications(event_id, status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_attendance_user ON attendance(user_id, present)`);

  // Only seed if the database is empty
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get();
  if (userCount.count === 0) {
    console.log('Seeding database...');
    seedDatabase();
    console.log('Seeding complete.');
  } else {
    console.log('Database already initialized.');
  }

  initHoursLedger();
}

/**
 * Creates the hours ledger and backfills it from existing attendance.
 *
 * Safe to run on every boot: creation is IF NOT EXISTS and the backfill is
 * idempotent on a deterministic id. It is additive only — it never writes to
 * `attendance`, so a failure here cannot alter a single volunteer's hours.
 *
 * Parity is checked and reported but does not halt startup. The ledger is not
 * yet read by any hours calculation, so a mismatch is a signal to investigate,
 * not a reason to take the platform down for every user. `npm run verify:hours`
 * is the blocking gate for operators and CI.
 */
function initHoursLedger() {
  createHoursLedgerTable(db);

  const { inserted, skipped, total } = backfillHoursLedger(db);
  if (inserted > 0) {
    console.log(`[Hours ledger] Backfilled ${inserted} entr${inserted === 1 ? 'y' : 'ies'} from ${total} attendance record(s).`);
  }

  const parity = verifyLedgerParity(db);
  if (parity.ok) {
    if (inserted > 0 || skipped > 0) {
      console.log(`[Hours ledger] Parity verified against attendance for ${parity.usersChecked} volunteer(s).`);
    }
  } else {
    console.error('[Hours ledger] PARITY MISMATCH — ledger disagrees with attendance:');
    for (const m of parity.mismatches) {
      console.error(`  ${m.userId}: ledger ${m.ledgerTotal} vs attendance ${m.attendanceTotal}`);
    }
    console.error('[Hours ledger] Credited hours are unaffected (attendance is still the source of truth). Investigate before wiring ledger writes.');
  }
}

function seedDatabase() {
  const salt = bcrypt.genSaltSync(10);
  const passwordHash = bcrypt.hashSync('password123', salt);
  const nowStr = new Date().toISOString();

  const insertUser = db.prepare(`
    INSERT INTO users (id, name, email, password_hash, grade, role, verified, avatar, bio, school, skills, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Admins & Organizers
  insertUser.run('user-admin', 'System Admin', 'admin@sbvolunteers.gov', passwordHash, 'N/A', 'admin', 1, '🛠️', 'Platform administrator.', 'South Brunswick', JSON.stringify(['Moderation']), nowStr);
  insertUser.run('user-org-1', 'Jacquelyn Katzenback', 'jkatzenback@vikings.org', passwordHash, 'Adult', 'organizer', 1, '👩‍💼', 'Coordinator for Vikings Softball.', 'Vikings Softball', JSON.stringify(['Coordination']), nowStr);
  insertUser.run('user-org-pending', 'Robert Miller', 'rmiller@sbpl.info', passwordHash, 'Adult', 'organizer', 0, '👨‍🏫', 'Library Director. Pending admin approval.', 'SBPL', JSON.stringify(['Events']), nowStr);

  // Softball volunteers
  insertUser.run('user-diana', 'Diana Sanger', 'diana.sanger@gmail.com', passwordHash, 'Adult', 'student', 1, '👩', 'Parent volunteer.', 'SB Softball Booster', JSON.stringify(['Cooking']), nowStr);
  insertUser.run('user-matthew', 'Matthew Polizzotto', 'mpolizzotto@outlook.com', passwordHash, 'Adult', 'student', 1, '👨', 'Parent volunteer.', 'SB Softball Booster', JSON.stringify(['Grilling']), nowStr);
  insertUser.run('user-norma', 'Norma Carbin', 'ncarbin@comcast.net', passwordHash, 'Adult', 'student', 1, '👩', 'Parent volunteer, glad to restock and reset.', 'SB Softball Booster', JSON.stringify(['Restocking']), nowStr);
  insertUser.run('user-colin', 'Colin Carbin', 'colin.carbin29@outlook.com', passwordHash, '11', 'student', 1, '🧑', 'High school volunteer.', 'South Brunswick HS', JSON.stringify(['Cashier']), nowStr);
  insertUser.run('user-alexia', 'Alexia Burnett', 'aburnett@gmail.com', passwordHash, 'Adult', 'student', 1, '👩', 'Parent volunteer.', 'SB Softball Booster', JSON.stringify(['Cooking']), nowStr);
  insertUser.run('user-advait', 'Advaitkrishna G.', 'advait.g@yahoo.com', passwordHash, '10', 'student', 1, '🧑', 'High school volunteer.', 'South Brunswick HS', JSON.stringify(['Food Prep']), nowStr);
  insertUser.run('user-david', 'David Sanger', 'dsanger@outlook.com', passwordHash, 'Adult', 'student', 1, '👨', 'Parent volunteer, usually on clean-up.', 'SB Softball Booster', JSON.stringify(['Cleanup']), nowStr);
  insertUser.run('user-pranathi', 'Pranathi Sukumar', 'pranathi.s@gmail.com', passwordHash, '11', 'student', 1, '👩', 'Interested in environmental clean-ups.', 'South Brunswick HS', JSON.stringify(['Litter cleanup']), nowStr);

  // Core simulated students
  insertUser.run('user-student-1', 'Leo Chen', 'leo.chen28@gmail.com', passwordHash, '10', 'student', 1, '🧑‍💻', 'First year volunteering — keen to try everything.', 'South Brunswick HS', JSON.stringify(['Setup', 'Math']), nowStr);
  insertUser.run('user-student-2', 'Priya Patel', 'priya.patel.nhs@outlook.com', passwordHash, '11', 'student', 1, '👩‍⚕️', 'Happy to help with anything hands-on.', 'South Brunswick HS', JSON.stringify(['First Aid']), nowStr);
  insertUser.run('user-student-3', 'Ethan Miller', 'emiller2027@gmail.com', passwordHash, '12', 'student', 1, '🧑‍🎨', 'Enjoys set-up and anything creative.', 'South Brunswick HS', JSON.stringify(['Art']), nowStr);

  // Seed Events
  const insertEvent = db.prepare(`
    INSERT INTO events (id, title, description, category, location, application_deadline, organizer_id, status, auto_approve, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertEvent.run(
    'event-softball',
    'Softball Tournament Snack Shack',
    'Every shift must have an adult volunteer due to cooking/grilling. The remaining slots can be taken by either high school volunteers, or additional parents. We are requesting that each family signs up for at least one time slot. Thank you!',
    'Other',
    'Reichler Park',
    '2026-07-24T18:00:00.000Z',
    'user-org-1',
    'open',
    0,
    nowStr
  );

  insertEvent.run(
    'event-pantry-past',
    'Food Pantry Boxing & Distribution',
    'Load delivery boxes and sort food cans for South Brunswick families.',
    'Food Pantry',
    'SB Food Pantry Hall',
    '2026-07-04T17:00:00.000Z',
    'user-org-1',
    'completed',
    0,
    nowStr
  );

  // Seed Slots
  const insertSlot = db.prepare(`
    INSERT INTO slots (id, event_id, name, description, start_datetime, end_datetime, max_spots)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  // Softball slots
  insertSlot.run('slot-softball-1', 'event-softball', 'Adult', 'Grilling & cooking helper (Adult volunteer).', '2026-07-11T07:30:00.000Z', '2026-07-11T09:30:00.000Z', 1);
  insertSlot.run('slot-softball-2', 'event-softball', 'Volunteer (any age)', 'High school volunteer or additional parent help.', '2026-07-11T07:30:00.000Z', '2026-07-11T09:30:00.000Z', 2);
  insertSlot.run('slot-softball-3', 'event-softball', 'Adult', 'Grilling & cooking helper (Adult volunteer).', '2026-07-11T09:30:00.000Z', '2026-07-11T11:30:00.000Z', 1);
  insertSlot.run('slot-softball-4', 'event-softball', 'Volunteer (any age)', 'High school volunteer or additional parent help.', '2026-07-11T09:30:00.000Z', '2026-07-11T11:30:00.000Z', 2);
  insertSlot.run('slot-softball-5', 'event-softball', 'Adult', 'Grilling & cooking helper (Adult volunteer).', '2026-07-11T11:30:00.000Z', '2026-07-11T13:30:00.000Z', 1);
  insertSlot.run('slot-softball-6', 'event-softball', 'Volunteer (any age)', 'High school volunteer or additional parent help.', '2026-07-11T11:30:00.000Z', '2026-07-11T13:30:00.000Z', 2);
  insertSlot.run('slot-softball-7', 'event-softball', 'Check park for litter', 'Walk around entire softball area. Pick up and throw away any litter.', '2026-07-11T11:30:00.000Z', '2026-07-11T13:30:00.000Z', 2);

  // Past event slots
  insertSlot.run('slot-pantry-1', 'event-pantry-past', 'Box Packer', 'Sort and pack grocery boxes.', '2026-07-05T09:00:00.000Z', '2026-07-05T12:00:00.000Z', 2);

  // Seed Applications
  const insertApp = db.prepare(`
    INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  insertApp.run('app-sb-1', 'user-diana',    'event-softball', 'slot-softball-1', 'accepted', nowStr);
  insertApp.run('app-sb-2', 'user-matthew',  'event-softball', 'slot-softball-3', 'accepted', nowStr);
  insertApp.run('app-sb-3', 'user-norma',    'event-softball', 'slot-softball-4', 'accepted', nowStr);
  insertApp.run('app-sb-4', 'user-colin',    'event-softball', 'slot-softball-4', 'accepted', nowStr);
  insertApp.run('app-sb-5', 'user-alexia',   'event-softball', 'slot-softball-5', 'accepted', nowStr);
  insertApp.run('app-sb-6', 'user-student-1','event-softball', 'slot-softball-6', 'accepted', nowStr);
  insertApp.run('app-sb-7', 'user-advait',   'event-softball', 'slot-softball-6', 'accepted', nowStr);
  insertApp.run('app-sb-8', 'user-david',    'event-softball', 'slot-softball-7', 'accepted', nowStr);
  insertApp.run('app-sb-9', 'user-pranathi', 'event-softball', 'slot-softball-7', 'accepted', nowStr);
  insertApp.run('app-sb-10','user-student-2','event-softball', 'slot-softball-2', 'pending',  nowStr);

  insertApp.run('app-past-p1', 'user-student-2', 'event-pantry-past', 'slot-pantry-1', 'accepted', nowStr);
  insertApp.run('app-past-p2', 'user-student-3', 'event-pantry-past', 'slot-pantry-1', 'accepted', nowStr);

  // Seed Attendance
  const insertAttendance = db.prepare(`
    INSERT INTO attendance (event_id, slot_id, user_id, present, hours_awarded)
    VALUES (?, ?, ?, ?, ?)
  `);

  insertAttendance.run('event-pantry-past', 'slot-pantry-1', 'user-student-2', 1, 3.0);
  insertAttendance.run('event-pantry-past', 'slot-pantry-1', 'user-student-3', 0, 3.0);

  // ── Seed a few notifications and a sample comment so the new features
  // don't look empty on first run ──
  const insertNotif = db.prepare(`
    INSERT INTO notifications (id, user_id, kind, title, body, link, read, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertNotif.run('notif-1', 'user-student-1', 'reminder', 'Upcoming shift tomorrow',
    'Softball Tournament Snack Shack — Adult shift at 7:30 AM. Don\'t forget!',
    null, 0, nowStr);
  insertNotif.run('notif-2', 'user-student-1', 'hours', 'New hours credited',
    'You earned 2.0 hrs from Softball Tournament Snack Shack.',
    null, 0, nowStr);
  insertNotif.run('notif-3', 'user-org-1', 'application', 'New volunteer application',
    'A student applied to your Softball Tournament — General Shift.',
    null, 0, nowStr);

  const insertComment = db.prepare(`
    INSERT INTO event_comments (id, event_id, user_id, body, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  insertComment.run('cmt-1', 'event-softball', 'user-org-1',
    'Please arrive 15 minutes before your shift for setup. Wear closed-toe shoes!', nowStr);
  insertComment.run('cmt-2', 'event-softball', 'user-diana',
    'Thanks for organizing this! Looking forward to helping out.', nowStr);

  const insertAnnouncement = db.prepare(`
    INSERT INTO event_announcements (id, event_id, author_id, body, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  insertAnnouncement.run('ann-1', 'event-softball', 'user-org-1',
    'Park at the Reichler Park south lot and check in at the snack shack window. ' +
    'Wear closed-toe shoes — anyone on the grill also needs long sleeves.', nowStr);
}

export { db };
