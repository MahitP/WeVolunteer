import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import { createHoursLedgerTable, backfillHoursLedger, verifyLedgerParity } from './hoursLedger.js';
import { createCertificatesTable, backfillCertificates } from './certificates.js';
import { createCheckinTable } from './attendance.js';
import { DEMO_MODE, REQUIRE_EMAIL_VERIFICATION } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// SBV_DB_PATH lets tests point at a throwaway file. Unset in normal operation.
const dbPath = process.env.SBV_DB_PATH || path.join(__dirname, 'sbvolunteers.db');

const db = new DatabaseSync(dbPath);

// Connection durability/concurrency settings, applied before any statement runs.
//
// WAL lets readers continue while a write is in progress, instead of the
// default rollback journal where a writer locks the whole file. busy_timeout
// gives a blocked writer a retry window rather than failing instantly with
// SQLITE_BUSY — the default is 0. The app is single-process, but the boot
// backfills, the 15-minute notification sweep, and the standalone scripts
// (verify:hours, bin/make-admin.mjs) can all open this file, so a zero-length
// window is an avoidable failure mode.
//
// WAL is written into the database header and persists; it also creates -wal
// and -shm sidecar files, which any backup must copy alongside the .db (see
// the runbook in README.md).
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 5000');

/**
 * Adds a column only if it isn't already present. `ALTER TABLE ... ADD COLUMN`
 * throws on a duplicate, so existing databases would fail to boot otherwise.
 */
function addColumnIfMissing(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some(c => c.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  console.log(`Migration: added ${table}.${column}`);
  return true;
}

/**
 * Reconciles pre-existing case-variant email duplicates (F-11) before the
 * case-insensitive unique index is created.
 *
 * A fresh seeded database has zero case-insensitive collisions, so this is a
 * no-op there — it only does work defensively, against a production database
 * that already has duplicates from the case-sensitive era.
 *
 * For each colliding group, the account with the most CREDITED hours
 * (attendance.present = 1) survives unchanged; ties broken by oldest
 * created_at, then lowest rowid. Every other account in the group is
 * RENAMED (never merged, never deleted) to a reserved `local+dup-<rowid>@domain`
 * form and has its token_version bumped so its existing sessions drop. No
 * user_id ever changes, no application/attendance row is ever moved, and no
 * user is ever deleted — merging risks colliding with attendance's
 * PRIMARY KEY(slot_id, user_id) / applications' UNIQUE(user_id, slot_id), and
 * deleting would cascade away the account's credited hours. The renamed
 * account's records stay intact-but-parked for an admin to reconcile by hand.
 */
function dedupeCaseInsensitiveEmails(db) {
  const groups = db.prepare(
    'SELECT LOWER(email) AS key FROM users GROUP BY key HAVING COUNT(*) > 1'
  ).all();
  if (groups.length === 0) return;

  db.exec('BEGIN TRANSACTION');
  try {
    const hoursForUser = db.prepare(
      'SELECT COALESCE(SUM(hours_awarded), 0) AS hours FROM attendance WHERE user_id = ? AND present = 1'
    );
    const renameStmt = db.prepare(
      'UPDATE users SET email = ?, token_version = token_version + 1 WHERE rowid = ?'
    );

    for (const { key } of groups) {
      const members = db.prepare(
        'SELECT rowid, id, email, created_at FROM users WHERE LOWER(email) = ?'
      ).all(key);

      const withHours = members.map(m => ({
        ...m,
        hours: hoursForUser.get(m.id).hours
      }));

      // Survivor: most credited hours, then oldest created_at, then lowest rowid.
      withHours.sort((a, b) => {
        if (b.hours !== a.hours) return b.hours - a.hours;
        if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
        return a.rowid - b.rowid;
      });
      const survivor = withHours[0];

      for (const member of withHours) {
        if (member.rowid === survivor.rowid) continue;

        const at = member.email.lastIndexOf('@');
        const newEmail = at === -1
          ? `${member.email}+dup-${member.rowid}`
          : `${member.email.slice(0, at)}+dup-${member.rowid}${member.email.slice(at)}`;

        renameStmt.run(newEmail, member.rowid);
        console.log(`[Email dedupe] ${member.email} -> ${newEmail} (id ${member.id})`);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
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
      leaderboard_opt_in INTEGER DEFAULT 0,
      username TEXT UNIQUE,
      profile_visibility TEXT CHECK(profile_visibility IN ('private', 'friends', 'public')) DEFAULT 'private',
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
      status TEXT CHECK(status IN ('pending', 'accepted', 'waitlisted', 'rejected', 'withdrawn')) DEFAULT 'pending',
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

  db.exec(`
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      reporter_id TEXT NOT NULL,
      target_type TEXT NOT NULL CHECK(target_type IN ('event', 'comment')),
      target_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT DEFAULT 'open' CHECK(status IN ('open', 'resolved', 'dismissed')),
      created_at TEXT NOT NULL,
      FOREIGN KEY(reporter_id) REFERENCES users(id) ON DELETE CASCADE
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
      reason TEXT,
      FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS email_verification_tokens (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
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
  addColumnIfMissing('auto_select_runs', 'reason', 'TEXT');
  addColumnIfMissing('users', 'leaderboard_opt_in', 'INTEGER DEFAULT 0');
  addColumnIfMissing('users', 'token_version', 'INTEGER NOT NULL DEFAULT 0');

  const addedEmailVerified = addColumnIfMissing('users', 'email_verified', 'INTEGER DEFAULT 0');
  if (addedEmailVerified) {
    // The first time this column exists, every current account predates email
    // verification — none of their 0s is a real pending confirmation. Backfill
    // them verified regardless of REQUIRE_EMAIL_VERIFICATION, or enabling
    // verification on an existing database would lock out every current user.
    // This runs before seeding, so on a fresh database it touches no rows.
    db.exec('UPDATE users SET email_verified = 1');
  }

  // Migrate applications table to allow 'withdrawn' status
  // SQLite doesn't support ALTER TABLE DROP CONSTRAINT, so we check if the schema has 'withdrawn'
  const appSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='applications'").get();
  if (appSchema && !appSchema.sql.includes("'withdrawn'")) {
    console.log("Migrating 'applications' table to support 'withdrawn' status...");
    db.exec(`
      BEGIN TRANSACTION;
      CREATE TABLE applications_new (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        slot_id TEXT NOT NULL,
        status TEXT CHECK(status IN ('pending', 'accepted', 'waitlisted', 'rejected', 'withdrawn')) DEFAULT 'pending',
        applied_at TEXT NOT NULL,
        waitlist_order INTEGER,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE,
        FOREIGN KEY(slot_id) REFERENCES slots(id) ON DELETE CASCADE,
        UNIQUE(user_id, slot_id)
      );
      INSERT INTO applications_new SELECT * FROM applications;
      DROP TABLE applications;
      ALTER TABLE applications_new RENAME TO applications;
      COMMIT;
    `);
  }

  // Pre-pilot social/profile prep
  addColumnIfMissing('users', 'username', 'TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username) WHERE username IS NOT NULL');
  addColumnIfMissing('users', 'profile_visibility', "TEXT CHECK(profile_visibility IN ('private', 'friends', 'public')) DEFAULT 'private'");

  // F-11: email uniqueness was case-sensitive while forgot-password already
  // matched COLLATE NOCASE, so one person could hold leo@x and Leo@x with
  // service hours split across them. Reconcile any pre-existing case-variant
  // duplicates BEFORE the unique index is created below — CREATE UNIQUE INDEX
  // would otherwise fail (or silently forbid) on a database that already has
  // colliding rows.
  dedupeCaseInsensitiveEmails(db);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_nocase ON users(email COLLATE NOCASE)');

  // Indexes for performance
  db.exec(`CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_comments_event ON event_comments(event_id, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_announcements_event ON event_announcements(event_id, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_applications_event ON applications(event_id, status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_attendance_user ON attendance(user_id, present)`);

  // Added after a query-plan audit found these filters running full table scans.
  // Each one is on a path the app hits constantly, so at district scale they
  // would degrade together rather than one at a time.
  //   slots(event_id)              — every event render, edit, and completion check
  //   applications(slot_id, status)— per-slot capacity counting, in loops
  //   events(organizer_id)         — every organizer dashboard and stats call
  //   attendance(event_id)         — deletion guard and per-event hours rollups
  // applications(user_id) is already covered by the UNIQUE(user_id, slot_id)
  // index as a leftmost prefix, so it is deliberately not repeated here.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_slots_event ON slots(event_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_applications_slot ON applications(slot_id, status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_events_organizer ON events(organizer_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_attendance_event ON attendance(event_id)`);

  // Seed data is a demo affordance, never a production one: the seed accounts
  // share a password that is printed in the README. A real deployment comes up
  // empty, and its first admin is made with `node bin/make-admin.mjs <email>`
  // after that person has signed up normally.
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get();
  if (userCount.count > 0) {
    console.log('Database already initialized.');
  } else if (DEMO_MODE) {
    console.log('Seeding database...');
    seedDatabase();
    console.log('Seeding complete.');
  } else {
    console.log('Empty database initialized. DEMO_MODE is off, so no demo accounts were created.');
  }

  if (!REQUIRE_EMAIL_VERIFICATION) {
    // Runs after seeding: freshly seeded/inserted rows default to
    // email_verified = 0, and nothing to confirm while the feature is off, so
    // a stale 0 would put an otherwise-fine account behind a wall it cannot
    // get past. Idempotent, and it stops applying the moment verification is
    // switched on.
    db.exec('UPDATE users SET email_verified = 1 WHERE email_verified = 0');
  }

  // Check-in marks taken during an event. Separate from `attendance` so that
  // marking someone off on the day never credits hours by itself.
  createCheckinTable(db);

  initHoursLedger();
  initCertificates();
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

/**
 * Creates the certificates table and issues codes for any credited
 * attendance that doesn't have one yet.
 *
 * Safe to run on every boot: creation is IF NOT EXISTS and the backfill is
 * idempotent (skips any (user, event) pair that already has a stored code).
 * Never writes to `attendance`.
 */
function initCertificates() {
  createCertificatesTable(db);

  const { inserted } = backfillCertificates(db);
  if (inserted > 0) {
    console.log(`[Certificates] Issued ${inserted} code(s).`);
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
