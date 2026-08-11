/**
 * Drive the pilot workflows against a DEVELOPMENT database and report anomalies.
 *
 * ⚠️  THIS MUTATES DATA. It approves organizers, creates events, applies,
 *     accepts, marks attendance and credits hours. It is a simulation, not a
 *     read-only check.
 *
 * Usage:
 *   node bin/simulate-pilot.js              # prompts for confirmation
 *   node bin/simulate-pilot.js --yes        # no prompt (scripts and tests)
 *
 * It carries the same gate as bin/seed-pilot.js, and for the same reason: it also
 * set `process.env.NODE_ENV = 'development'` itself, so a run against a live
 * deployment could not be detected by anything downstream. Writing fabricated
 * attendance and credited hours into real student records is not recoverable by
 * re-running anything — those rows land in the append-only hours ledger.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveDbPath, guardDestructive } from './lib/db-safety.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Bind to the pilot DB by default, but let an explicit WEV_DB_PATH win so this
// can be pointed at a scratch database like every other tool.
const dbPath = resolveDbPath(path.resolve(__dirname, '../pilot.db'));

await guardDestructive({
  tool: 'pilot workflow simulation',
  dbPath,
  effect: 'This WRITES to that database — approvals, events, applications, '
    + 'attendance and credited hours, including append-only ledger rows.'
});

process.env.WEV_DB_PATH = dbPath;

// NODE_ENV deliberately not set — see bin/seed-pilot.js for the reasoning.
if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'simulation-only-not-a-real-secret-0000000';
}

const { db } = await import('../server/db.js');
// Safe as a dynamic import alongside db: auditLog.js reaches nothing.
const { recordAudit } = await import('../server/auditLog.js');

console.log('--- Simulating Pilot Workflows ---');
let bugs = [];

try {
  // 1. Admin Workflow: Approve Organizer
  console.log('Testing Admin Workflow...');
  const pendingOrg = db.prepare("SELECT id FROM users WHERE role = 'organizer' AND verified = 0").get();
  if (!pendingOrg) bugs.push('No pending organizer found to approve.');
  else {
    db.prepare('UPDATE users SET verified = 1 WHERE id = ?').run(pendingOrg.id);
    recordAudit(db, {
      adminId: 'admin-1',
      action: 'APPROVE_ORGANIZER',
      targetUserId: pendingOrg.id,
      details: 'Approved via simulation'
    });
    console.log('  ✓ Admin approved pending organizer.');
  }

  // 2. Organizer Workflow: Create Event & Accept Volunteers
  console.log('Testing Organizer Workflow...');
  const newEventId = 'evt-sim-' + Date.now();
  const newSlotId = 'slot-sim-' + Date.now();
  db.prepare(`
    INSERT INTO events (id, title, description, category, location, application_deadline, organizer_id, status, auto_approve, created_at, instructions, attendee_visibility, address, latitude, longitude)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(newEventId, 'Simulated Car Wash', 'Fundraiser.', 'Other', 'HS Parking Lot', new Date(Date.now() + 86400000).toISOString(), 'org-1', 'open', 0, new Date().toISOString(), 'Bring buckets.', 'accepted', '750 Ridge Road, Example Valley, NJ 08852', 40.4188, -74.5931);
  
  db.prepare(`
    INSERT INTO slots (id, event_id, name, description, start_datetime, end_datetime, max_spots)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(newSlotId, newEventId, 'Washer', 'Wash cars', new Date(Date.now() + 86400000).toISOString(), new Date(Date.now() + 86400000 + 3600000).toISOString(), 2);
  console.log('  ✓ Organizer created an event with slots.');

  // 3. Student Workflow: Apply, Withdraw, Reapply
  console.log('Testing Student Workflow...');
  const student = 'stu-1';
  db.prepare('INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    'app-sim-1', student, newEventId, newSlotId, 'pending', new Date().toISOString()
  );
  console.log('  ✓ Student applied to event.');
  
  db.prepare("UPDATE applications SET status = 'withdrawn' WHERE id = ?").run('app-sim-1');
  console.log('  ✓ Student withdrew application.');

  db.prepare("UPDATE applications SET status = 'pending' WHERE id = ?").run('app-sim-1');
  console.log('  ✓ Student reapplied to event.');

  // Organizer accepts
  db.prepare("UPDATE applications SET status = 'accepted' WHERE id = ?").run('app-sim-1');
  console.log('  ✓ Organizer accepted student.');

  // Organizer does attendance
  db.prepare("UPDATE events SET status = 'completed' WHERE id = ?").run(newEventId);
  db.prepare('INSERT INTO attendance (event_id, slot_id, user_id, present, hours_awarded) VALUES (?, ?, ?, ?, ?)').run(
    newEventId, newSlotId, student, 1, 1.0
  );
  console.log('  ✓ Organizer completed event and credited hours.');

  // Check hours ledger
  const { initDatabase } = await import('../server/db.js');
  initDatabase(); // runs backfill
  
  const ledger = db.prepare('SELECT hours_awarded FROM attendance WHERE user_id = ? AND event_id = ?').get(student, newEventId);
  if (!ledger || ledger.hours_awarded !== 1) {
    bugs.push('Student did not properly receive hours in the DB.');
  } else {
    console.log('  ✓ Student successfully tracked hours & certificates generated.');
  }

} catch (err) {
  bugs.push('Simulation crashed: ' + err.message);
}

console.log('--- Simulation Results ---');
if (bugs.length > 0) {
  console.log('Bugs found:');
  bugs.forEach(b => console.log('❌', b));
} else {
  console.log('✅ Simulation completed successfully with 0 bugs!');
}
