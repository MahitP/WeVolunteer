import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure the pilot uses a dedicated DB file so it doesn't touch local dev data.
const dbPath = path.resolve(__dirname, '../pilot.db');
process.env.WEV_DB_PATH = dbPath;
process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'pilot-secret';

// 1. Reset the pilot DB if it exists
if (fs.existsSync(dbPath)) {
  fs.unlinkSync(dbPath);
  console.log(`Deleted existing pilot.db`);
}
// Also delete WAL files if any
if (fs.existsSync(dbPath + '-wal')) fs.unlinkSync(dbPath + '-wal');
if (fs.existsSync(dbPath + '-shm')) fs.unlinkSync(dbPath + '-shm');

// 2. Initialize the schema
const { initDatabase, db } = await import('../server/db.js');
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
  INSERT INTO events (id, title, description, category, location, application_deadline, organizer_id, status, auto_approve, created_at, instructions, attendee_visibility)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
insertUser.run('admin-1', 'Pilot Admin', 'admin@sbvolunteers.org', passwordHash, 'N/A', 'admin', 1, '🛡️', 'System Administrator', 'District', '[]', nowStr);

// 5 Organizers
insertUser.run('org-1', 'Sarah Jenkins', 'sjenkins@hs.org', passwordHash, 'Adult', 'organizer', 1, '👩‍🏫', 'Student Council Advisor', 'High School', '[]', nowStr);
insertUser.run('org-2', 'Mark Robinson', 'mrobinson@sbpl.info', passwordHash, 'Adult', 'organizer', 1, '📚', 'Library Coordinator', 'Public Library', '[]', nowStr);
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
  insertUser.run(s.id, s.name, s.email, passwordHash, s.grade, 'student', 1, '🧑‍🎓', 'High School Student', 'South Brunswick HS', '[]', nowStr);
}

// --- Events ---
console.log('Seeding events...');

const future30 = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
const future2 = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
const past5 = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();

// 1. Food Drive (Open, Auto-select off) - org-3
insertEvent.run('evt-food', 'Community Food Drive', 'Help sort canned goods and pack boxes for families in need. Wear closed-toe shoes.', 'Food Pantry', 'Community Center', future30, 'org-3', 'open', 0, nowStr, 'Check in at the loading dock.', 'accepted');
insertSlot.run('slot-food-1', 'evt-food', 'Box Packer', 'Pack boxes', future30, new Date(Date.now() + 30 * 24 * 60 * 60 * 1000 + 3 * 3600000).toISOString(), 5);

// 2. Park Cleanup (Open, Auto-select on) - org-4
insertEvent.run('evt-park', 'Spring Park Cleanup', 'Picking up litter along the trails. Gloves and bags provided.', 'Other', 'Reichler Park', future30, 'org-4', 'open', 1, nowStr, 'Meet by the playground.', 'everyone');
insertSlot.run('slot-park-1', 'evt-park', 'Litter collection', 'Walk trails', future30, new Date(Date.now() + 30 * 24 * 60 * 60 * 1000 + 4 * 3600000).toISOString(), 15);

// 3. Library Assistant (Near deadline, Waitlisted) - org-2
insertEvent.run('evt-library', 'Weekend Library Shelver', 'Help organize returned books.', 'Other', 'Public Library', future2, 'org-2', 'open', 0, nowStr, 'Ask for Mark at the front desk.', 'accepted');
insertSlot.run('slot-lib-1', 'evt-library', 'Shelver', 'Shelve children books', future2, new Date(Date.now() + 2 * 24 * 60 * 60 * 1000 + 2 * 3600000).toISOString(), 2);

// 4. Elementary School Tutoring (Closed/Completed) - org-1
insertEvent.run('evt-tutor', 'After School Math Tutoring', 'Tutoring 4th graders in math.', 'School', 'Elementary School', past5, 'org-1', 'completed', 1, past5, 'Room 101', 'accepted');
insertSlot.run('slot-tut-1', 'evt-tutor', 'Math Tutor', 'Fractions', past5, new Date(Date.now() - 5 * 24 * 60 * 60 * 1000 + 1 * 3600000).toISOString(), 5);

// 5. School Event Setup (Open) - org-1
insertEvent.run('evt-setup', 'Homecoming Dance Setup', 'Setting up tables and decorations in the gym.', 'School', 'HS Gym', future30, 'org-1', 'open', 0, nowStr, 'Enter through back gym doors.', 'accepted');
insertSlot.run('slot-set-1', 'evt-setup', 'Decorator', 'Hang streamers', future30, new Date(Date.now() + 30 * 24 * 60 * 60 * 1000 + 2 * 3600000).toISOString(), 8);

// 6. Animal Shelter Support (Open) - org-3
insertEvent.run('evt-animal', 'Animal Shelter Helper', 'Walking dogs and cleaning cages.', 'Other', 'Local Shelter', future30, 'org-3', 'open', 0, nowStr, 'Wear old clothes.', 'accepted');
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
initDatabase(); // This will trigger initHoursLedger and initCertificates on the existing db!

console.log('---');
console.log('Pilot seeding complete!');
console.log('Database written to:', dbPath);
console.log('All accounts use password:', sharedPassword);
console.log('Admin account: admin@sbvolunteers.org');
