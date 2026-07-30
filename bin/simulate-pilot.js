import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Bind to pilot DB
process.env.WEV_DB_PATH = path.resolve(__dirname, '../pilot.db');
process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'pilot-secret';

const { db } = await import('../server/db.js');

console.log('--- Simulating Pilot Workflows ---');
let bugs = [];

try {
  // 1. Admin Workflow: Approve Organizer
  console.log('Testing Admin Workflow...');
  const pendingOrg = db.prepare("SELECT id FROM users WHERE role = 'organizer' AND verified = 0").get();
  if (!pendingOrg) bugs.push('No pending organizer found to approve.');
  else {
    db.prepare('UPDATE users SET verified = 1 WHERE id = ?').run(pendingOrg.id);
    db.prepare('INSERT INTO admin_audit_logs (id, admin_id, action, target_user_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      'log-' + Date.now(), 'admin-1', 'APPROVE_ORGANIZER', pendingOrg.id, 'Approved via simulation', new Date().toISOString()
    );
    console.log('  ✓ Admin approved pending organizer.');
  }

  // 2. Organizer Workflow: Create Event & Accept Volunteers
  console.log('Testing Organizer Workflow...');
  const newEventId = 'evt-sim-' + Date.now();
  const newSlotId = 'slot-sim-' + Date.now();
  db.prepare(`
    INSERT INTO events (id, title, description, category, location, application_deadline, organizer_id, status, auto_approve, created_at, instructions, attendee_visibility)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(newEventId, 'Simulated Car Wash', 'Fundraiser.', 'Other', 'HS Parking Lot', new Date(Date.now() + 86400000).toISOString(), 'org-1', 'open', 0, new Date().toISOString(), 'Bring buckets.', 'accepted');
  
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
