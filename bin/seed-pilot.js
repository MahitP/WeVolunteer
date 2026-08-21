/**
 * Seed the demo/pilot dataset into a DEVELOPMENT database.
 *
 * ⚠️  THIS IS DESTRUCTIVE. It deletes the target database file and replaces it
 *     with 26 accounts that share one password (see
 *     docs/operations/pilot-credentials.md), one of them an administrator.
 *
 * Usage:
 *   node bin/seed-pilot.js              # prompts for confirmation
 *   node bin/seed-pilot.js --yes        # no prompt (scripts and tests)
 *
 * ── Why the guards below are not optional ──
 *
 * This script used to resolve WEV_DB_PATH, then set
 * `process.env.NODE_ENV = 'development'` itself, then `fs.unlinkSync()` the file
 * with no confirmation. Setting NODE_ENV was the worst part: it overwrote the one
 * signal that identifies a real deployment before anything could check it, so
 * every downstream guard was blind by the time it ran.
 *
 * `bin/` is present on the production host — the backup timer invokes
 * `/srv/wevolunteer/bin/backup.sh` — which made this a one-command wipe:
 *
 *     WEV_DB_PATH=/var/lib/wevolunteer/wevolunteer.db node bin/seed-pilot.js
 *
 * That would have destroyed the live service-hour records and installed a
 * known-password admin login in their place. The gate is shared with
 * bin/simulate-pilot.js and bin/reset-dev-db.mjs via bin/lib/db-safety.mjs, so
 * the three cannot drift apart the way the old DROP TABLE list did (finding F-1).
 */
import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import { fileURLToPath } from 'url';
import { resolveDbPath, guardDestructive } from './lib/db-safety.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// A dedicated DB file by default, so seeding the pilot never touches local dev
// data — but an explicit WEV_DB_PATH still wins, so this can seed a scratch
// database without editing the script. Overriding the variable unconditionally
// meant the one way to redirect any other tool silently did nothing here.
const dbPath = resolveDbPath(path.resolve(__dirname, '../pilot.db'));

await guardDestructive({
  tool: 'pilot data seed',
  dbPath,
  effect: 'This DELETES that database and reseeds 26 demo accounts sharing one '
    + 'published password, including an administrator.'
});

process.env.WEV_DB_PATH = dbPath;

// NODE_ENV is deliberately NOT set here — see the header. The guard above has
// already refused a production process, and anything else (unset, development,
// test) is a non-production posture as far as config.js is concerned.
//
// JWT_SECRET only needs to satisfy config.js's presence check; no token minted
// with it outlives this script, and nothing signed by it is stored. Set only if
// absent, so a real .env value is left alone rather than silently shadowed.
if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'seed-script-only-not-a-real-secret-000000';
}

// 1. Reset the pilot DB if it exists
if (fs.existsSync(dbPath)) {
  fs.unlinkSync(dbPath);
  console.log(`Deleted existing ${path.basename(dbPath)}`);
}
// Also delete WAL files if any
if (fs.existsSync(dbPath + '-wal')) fs.unlinkSync(dbPath + '-wal');
if (fs.existsSync(dbPath + '-shm')) fs.unlinkSync(dbPath + '-shm');

// 2. Initialize the schema
const { initDatabase, completeDatabaseInit, db } = await import('../server/db.js');
// Temporarily disable DEMO_MODE so it doesn't insert the default seeds
process.env.DEMO_MODE = '';
initDatabase();

console.log('Database schema initialized for pilot.');

const salt = bcrypt.genSaltSync(10);
const sharedPassword = 'pilotpassword2026'; // Safe shared password for demo
const passwordHash = bcrypt.hashSync(sharedPassword, salt);
const nowStr = new Date().toISOString();

const insertUser = db.prepare(`
  INSERT INTO users (id, name, email, password_hash, grade, role, verified, avatar, bio, school, skills, created_at, email_verified)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
`);

const insertEvent = db.prepare(`
  INSERT INTO events (id, title, description, category, location, application_deadline, organizer_id, status, auto_approve, created_at, instructions, attendee_visibility, address, latitude, longitude)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertSlot = db.prepare(`
  INSERT INTO slots (id, event_id, name, description, start_datetime, end_datetime, max_spots)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const insertApp = db.prepare(`
  INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const insertAttendance = db.prepare(`
  INSERT INTO attendance (event_id, slot_id, user_id, present, hours_awarded)
  VALUES (?, ?, ?, ?, ?)
`);

// --- Users ---
console.log('Seeding accounts...');

// 1 Admin
insertUser.run('admin-1', 'Pilot Admin', 'pilot-admin@example.org', passwordHash, 'N/A', 'admin', 1, '🛡️', 'System Administrator', 'District', '[]', nowStr);

// 5 Organizers
insertUser.run('org-1', 'Sarah Jenkins', 'sjenkins@hs.org', passwordHash, 'Adult', 'organizer', 1, '👩‍🏫', 'Student Council Advisor', 'High School', '[]', nowStr);
insertUser.run('org-2', 'Mark Robinson', 'second.organizer@example.org', passwordHash, 'Adult', 'organizer', 1, '📚', 'Library Coordinator', 'Public Library', '[]', nowStr);
insertUser.run('org-3', 'Elena Rodriguez', 'erodriguez@foodpantry.org', passwordHash, 'Adult', 'organizer', 1, '🥫', 'Community Food Pantry Director', 'Food Pantry', '[]', nowStr);
insertUser.run('org-4', 'David Kim', 'dkim@parks.gov', passwordHash, 'Adult', 'organizer', 1, '🌳', 'Parks & Rec Coordinator', 'Township', '[]', nowStr);
insertUser.run('org-5', 'Pending Organizer', 'pending@org.com', passwordHash, 'Adult', 'organizer', 0, '⏳', 'Awaiting approval', 'Unknown', '[]', nowStr);

// 20 Students
const students = [
  { id: 'stu-1', name: 'Alex Thompson', email: 'alex.t@student.org', grade: '10' },
  { id: 'stu-2', name: 'Mia Patel', email: 'mia.p@student.org', grade: '11' },
  { id: 'stu-3', name: 'Ethan Wright', email: 'ethan.w@student.org', grade: '12' },
  { id: 'stu-4', name: 'Sophia Lee', email: 'sophia.l@student.org', grade: '9' },
  { id: 'stu-5', name: 'Jackson Hall', email: 'jackson.h@student.org', grade: '10' },
  { id: 'stu-6', name: 'Olivia Garcia', email: 'olivia.g@student.org', grade: '11' },
  { id: 'stu-7', name: 'Lucas Martin', email: 'lucas.m@student.org', grade: '12' },
  { id: 'stu-8', name: 'Ava White', email: 'ava.w@student.org', grade: '9' },
  { id: 'stu-9', name: 'Noah Clark', email: 'noah.c@student.org', grade: '10' },
  { id: 'stu-10', name: 'Isabella Lewis', email: 'isabella.l@student.org', grade: '11' },
  { id: 'stu-11', name: 'Liam Walker', email: 'liam.w@student.org', grade: '12' },
  { id: 'stu-12', name: 'Emma Young', email: 'emma.y@student.org', grade: '9' },
  { id: 'stu-13', name: 'Mason King', email: 'mason.k@student.org', grade: '10' },
  { id: 'stu-14', name: 'Charlotte Scott', email: 'charlotte.s@student.org', grade: '11' },
  { id: 'stu-15', name: 'Elijah Green', email: 'elijah.g@student.org', grade: '12' },
  { id: 'stu-16', name: 'Amelia Baker', email: 'amelia.b@student.org', grade: '9' },
  { id: 'stu-17', name: 'James Adams', email: 'james.a@student.org', grade: '10' },
  { id: 'stu-18', name: 'Harper Nelson', email: 'harper.n@student.org', grade: '11' },
  { id: 'stu-19', name: 'Benjamin Carter', email: 'benjamin.c@student.org', grade: '12' },
  { id: 'stu-20', name: 'Evelyn Mitchell', email: 'evelyn.m@student.org', grade: '9' }
];

for (const s of students) {
  insertUser.run(s.id, s.name, s.email, passwordHash, s.grade, 'student', 1, '🧑‍🎓', 'High School Student', 'Example Valley HS', '[]', nowStr);
}

// --- Events ---
console.log('Seeding events...');

const future30 = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
const future2 = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
const past5 = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();

/**
 * Coordinates are invented places in one invented town, spread over roughly six
 * miles so each of the 5 / 10 / 25 / 50-mile filters returns a different count.
 * `evt-animal` is deliberately left without them — see below.
 */

// 1. Food Drive (Open, Auto-select off) - org-3
insertEvent.run('evt-food', 'Community Food Drive', 'Help sort canned goods and pack boxes for families in need. Wear closed-toe shoes.', 'Food Pantry', 'Community Center', future30, 'org-3', 'open', 0, nowStr, 'Check in at the loading dock.', 'accepted', '45 Civic Center Way, Example Valley, NJ 08824', 40.3921, -74.5487);
insertSlot.run('slot-food-1', 'evt-food', 'Box Packer', 'Pack boxes', future30, new Date(Date.now() + 30 * 24 * 60 * 60 * 1000 + 3 * 3600000).toISOString(), 5);

// 2. Park Cleanup (Open, Auto-select on) - org-4
// Shares Reichler Park with the demo seed's softball event on purpose: two
// events at one pin is the case where the forecast cache should be hit twice.
insertEvent.run('evt-park', 'Spring Park Cleanup', 'Picking up litter along the trails. Gloves and bags provided.', 'Other', 'Reichler Park', future30, 'org-4', 'open', 1, nowStr, 'Meet by the playground.', 'everyone', '100 Reichler Park Drive, Example Valley, NJ 08824', 40.3860, -74.5560);
insertSlot.run('slot-park-1', 'evt-park', 'Litter collection', 'Walk trails', future30, new Date(Date.now() + 30 * 24 * 60 * 60 * 1000 + 4 * 3600000).toISOString(), 15);

// 3. Library Assistant (Near deadline, Waitlisted) - org-2
insertEvent.run('evt-library', 'Weekend Library Shelver', 'Help organize returned books.', 'Other', 'Public Library', future2, 'org-2', 'open', 0, nowStr, 'Ask for Mark at the front desk.', 'accepted', '8 Library Road, Example Valley, NJ 08824', 40.3744, -74.5205);
insertSlot.run('slot-lib-1', 'evt-library', 'Shelver', 'Shelve children books', future2, new Date(Date.now() + 2 * 24 * 60 * 60 * 1000 + 2 * 3600000).toISOString(), 2);

// 4. Elementary School Tutoring (Closed/Completed) - org-1
// Has a pin AND is in the past, so it exercises the forecast's `past_event`
// refusal (which must render nothing at all) separately from the no-pin case.
insertEvent.run('evt-tutor', 'After School Math Tutoring', 'Tutoring 4th graders in math.', 'School', 'Elementary School', past5, 'org-1', 'completed', 1, past5, 'Room 101', 'accepted', '300 Schoolhouse Road, Example Valley, NJ 08852', 40.4102, -74.5834);
insertSlot.run('slot-tut-1', 'evt-tutor', 'Math Tutor', 'Fractions', past5, new Date(Date.now() - 5 * 24 * 60 * 60 * 1000 + 1 * 3600000).toISOString(), 5);

// 5. School Event Setup (Open) - org-1
insertEvent.run('evt-setup', 'Homecoming Dance Setup', 'Setting up tables and decorations in the gym.', 'School', 'HS Gym', future30, 'org-1', 'open', 0, nowStr, 'Enter through back gym doors.', 'accepted', '750 Ridge Road, Example Valley, NJ 08852', 40.4188, -74.5931);
insertSlot.run('slot-set-1', 'evt-setup', 'Decorator', 'Hang streamers', future30, new Date(Date.now() + 30 * 24 * 60 * 60 * 1000 + 2 * 3600000).toISOString(), 8);

/**
 * 6. Animal Shelter Support (Open) - org-3
 *
 * Deliberately has NO coordinates. An organizer who typed a place name and
 * never opened the picker is an ordinary case, and every location surface has
 * to degrade for it: no map, no distance, no forecast, and a directions link
 * that falls back to the text address. A seed where every event has a pin is a
 * seed where nobody ever sees that path until a user finds it.
 */
insertEvent.run('evt-animal', 'Animal Shelter Helper', 'Walking dogs and cleaning cages.', 'Other', 'Local Shelter', future30, 'org-3', 'open', 0, nowStr, 'Wear old clothes.', 'accepted', null, null, null);
insertSlot.run('slot-ani-1', 'evt-animal', 'Dog Walker', 'Walk dogs', future30, new Date(Date.now() + 30 * 24 * 60 * 60 * 1000 + 3 * 3600000).toISOString(), 3);

// --- Applications & Attendance ---
console.log('Seeding applications...');

// Event 1 (Food drive): Some pending, some accepted
insertApp.run('app-1', 'stu-1', 'evt-food', 'slot-food-1', 'pending', nowStr);
insertApp.run('app-2', 'stu-2', 'evt-food', 'slot-food-1', 'accepted', nowStr);

// Event 3 (Library): Waitlist scenario (2 spots max)
insertApp.run('app-3', 'stu-3', 'evt-library', 'slot-lib-1', 'accepted', nowStr);
insertApp.run('app-4', 'stu-4', 'evt-library', 'slot-lib-1', 'accepted', nowStr);
insertApp.run('app-5', 'stu-5', 'evt-library', 'slot-lib-1', 'waitlisted', nowStr); // Waitlisted

// Event 4 (Tutoring - Completed): Everyone attended
for (let i = 6; i <= 10; i++) {
  insertApp.run(`app-${i}`, `stu-${i}`, 'evt-tutor', 'slot-tut-1', 'accepted', past5);
  insertAttendance.run('evt-tutor', 'slot-tut-1', `stu-${i}`, 1, 1.5);
}

// Student 1 has a withdrawn app
insertApp.run('app-wd', 'stu-1', 'evt-setup', 'slot-set-1', 'withdrawn', nowStr);

// Backfill hours ledger & certificates to make everything consistent
initDatabase();
await completeDatabaseInit(); // hours ledger backfill + parity, now async

console.log('---');
console.log('Pilot seeding complete!');
console.log('Database written to:', dbPath);
console.log('All accounts use password:', sharedPassword);
console.log('Admin account: pilot-admin@example.org');
