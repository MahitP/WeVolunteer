#!/usr/bin/env node
/**
 * A profile carrying every badge the platform currently confers, for looking at.
 *
 * ── What this is for ──
 *
 * The badge catalogue has twenty-three entries across four shapes — hour tiers,
 * streak tiers, reliability, and the standalone ones — and no real account has
 * ever held more than a handful. So nobody has seen what the profile actually
 * looks like when the ordering rules have something to order, whether twelve
 * hour badges wrap sanely at 320px, or whether the "and N more" cap reads
 * correctly. This builds an account that does.
 *
 * ── The safety rule, which is the whole reason this is a script ──
 *
 * It REFUSES to touch a database it was not pointed at explicitly, and refuses
 * outright if that path looks like the pilot or production database. Seeding
 * fabricated attendance into real data would put hours on a real student's
 * transcript, which is the one thing this repository is most careful about.
 *
 *     WEV_DB_PATH=/tmp/qa.db node bin/seed-qa-profile.mjs --email you@example.org
 *
 * ── Why it builds real history rather than inserting badges ──
 *
 * Four of the criteria types cannot be satisfied by writing a `user_badges` row
 * and hoping: `evaluateBadges` withdraws any automatic award whose criteria no
 * longer hold, so hand-inserted hour badges would vanish on the next
 * evaluation. The honest way to hold a 500-hour badge is to have 500 hours, so
 * this creates events, slots, applications and attendance, and then asks the
 * real evaluator to do what it would do.
 *
 * That also means the profile is TRUE: every figure on it is derived from the
 * same ledger a real account's would be.
 */

import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const emailArg = args.indexOf('--email');
const email = emailArg === -1 ? null : args[emailArg + 1];

const dbPath = process.env.WEV_DB_PATH;
if (!dbPath) {
  console.error('Refusing to run: set WEV_DB_PATH to a disposable database first.');
  console.error('  WEV_DB_PATH=/tmp/qa.db node bin/seed-qa-profile.mjs --email you@example.org');
  process.exit(1);
}

/**
 * The names that mean "this is not a scratch database".
 *
 * Checked on the resolved basename so `../pilot.db`, `./pilot.db` and an
 * absolute path all trip it. A refusal here costs a rerun with a different
 * path; a false negative costs somebody's real service record.
 */
const FORBIDDEN = ['pilot.db', 'production.db', 'wevolunteer.db'];
const base = path.basename(path.resolve(dbPath));
if (FORBIDDEN.includes(base)) {
  console.error(`Refusing to run against ${base}. This script fabricates attendance.`);
  console.error('Point WEV_DB_PATH at a throwaway copy instead.');
  process.exit(1);
}

const { db } = await import('../server/db.js');
const { badgeService } = await import('../server/services/badgeService.js');
const { HOUR_BADGE_TIERS, STREAK_BADGE_TIERS } = await import('../server/scripts/seed_badges.js');

const subject = email
  ? db.prepare('SELECT id, name, email, role FROM users WHERE email = ?').get(email)
  : db.prepare("SELECT id, name, email, role FROM users WHERE role = 'student' AND email NOT LIKE '%invalid%' LIMIT 1").get();

if (!subject) {
  console.error(email ? `No account with the email ${email}.` : 'No student account to use.');
  process.exit(1);
}

const iso = (d) => new Date(d).toISOString();
const MONTH = 30 * 86400000;

/* An organizer to host the fabricated events, so `organizer_id` is a real row
   and the foreign keys hold. */
const organizer = db.prepare("SELECT id FROM users WHERE role IN ('organizer','admin','super_admin') LIMIT 1").get()
  ?? { id: subject.id };

const eventTemplate = db.prepare('SELECT * FROM events LIMIT 1').get();
const slotTemplate = db.prepare('SELECT * FROM slots LIMIT 1').get();
if (!eventTemplate || !slotTemplate) {
  console.error('This database has no event to copy a shape from. Seed it first.');
  process.exit(1);
}

const eventCols = db.prepare('PRAGMA table_info(events)').all().map(c => c.name);
const slotCols = db.prepare('PRAGMA table_info(slots)').all().map(c => c.name);

/** Clones a real row so every NOT NULL column is satisfied without listing them. */
function insertFrom(table, cols, template, overrides) {
  const row = { ...template, ...overrides };
  const names = cols.filter(c => row[c] !== undefined);
  db.prepare(`INSERT OR REPLACE INTO ${table} (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`)
    .run(...names.map(c => row[c]));
}

/**
 * The target: the top hour tier, and a run of consecutive months long enough
 * for the longest streak badge.
 *
 * Read from the published tier lists rather than restated, so this script
 * cannot fall behind the catalogue it exists to exercise.
 */
const TOP_HOURS = Math.max(...HOUR_BADGE_TIERS);
const TOP_STREAK = Math.max(...STREAK_BADGE_TIERS);

/* Spread across TOP_STREAK consecutive months so the streak is unbroken, with
   enough hours per shift to clear the top hour tier. */
const shifts = TOP_STREAK + 2;
const hoursEach = Math.ceil((TOP_HOURS + 20) / shifts);

let made = 0;
for (let i = 0; i < shifts; i += 1) {
  const when = Date.now() - (i * MONTH) - 86400000;
  const ev = `qa-badge-ev-${subject.id}-${i}`;
  const sl = `qa-badge-sl-${subject.id}-${i}`;

  insertFrom('events', eventCols, eventTemplate, {
    id: ev,
    title: `QA service record ${i + 1}`,
    organizer_id: organizer.id,
    status: 'open',
    application_deadline: iso(when - 2 * 86400000),
  });
  insertFrom('slots', slotCols, slotTemplate, {
    id: sl,
    event_id: ev,
    name: 'Shift',
    start_datetime: iso(when),
    end_datetime: iso(when + hoursEach * 3600000),
  });
  db.prepare(`INSERT OR REPLACE INTO applications (id, user_id, event_id, slot_id, status, applied_at)
              VALUES (?,?,?,?,'accepted',?)`)
    .run(`qa-badge-ap-${subject.id}-${i}`, subject.id, ev, sl, iso(when - 3 * 86400000));
  db.prepare(`INSERT OR REPLACE INTO attendance (event_id, slot_id, user_id, present, hours_awarded)
              VALUES (?,?,?,1,?)`)
    .run(ev, sl, subject.id, hoursEach);
  made += 1;
}

/**
 * One organized event, so the Leadership badges are reachable too.
 *
 * `events_created` counts non-cancelled events with this account as organizer,
 * and it is the one criterion that needs no attendance at all.
 */
for (let i = 0; i < 10; i += 1) {
  insertFrom('events', eventCols, eventTemplate, {
    id: `qa-badge-hosted-${subject.id}-${i}`,
    title: `QA hosted event ${i + 1}`,
    organizer_id: subject.id,
    status: 'open',
    application_deadline: iso(Date.now() + 7 * 86400000),
  });
}

/* `early_adopter` ranks by registration order, so an account created today is
   not in the first 250 of a large database. Moving the row back is the only
   honest way to satisfy a criterion that is genuinely about when you joined. */
db.prepare('UPDATE users SET created_at = ? WHERE id = ?')
  .run(iso(Date.now() - 400 * 86400000), subject.id);

badgeService.evaluateBadges(subject.id);

const held = db.prepare(`
  SELECT b.name, b.category FROM user_badges ub
  JOIN badges b ON b.id = ub.badge_id
  WHERE ub.user_id = ? ORDER BY b.category, b.criteria_value
`).all(subject.id);

const total = db.prepare('SELECT COUNT(*) c FROM badges WHERE active = 1').get().c;
const hours = db.prepare('SELECT COALESCE(SUM(hours_awarded),0) h FROM attendance WHERE user_id = ? AND present = 1')
  .get(subject.id).h;

console.log(`Database : ${dbPath}`);
console.log(`Account  : ${subject.name} <${subject.email}> (${subject.role})`);
console.log(`Shifts   : ${made} attended, ${hours} hours credited`);
console.log(`Badges   : ${held.length} of ${total} active`);
for (const b of held) console.log(`   ${b.category.padEnd(16)} ${b.name}`);

const missing = db.prepare(`
  SELECT name, criteria_type FROM badges
  WHERE active = 1 AND id NOT IN (SELECT badge_id FROM user_badges WHERE user_id = ?)
`).all(subject.id);
if (missing.length) {
  console.log('\nNot held, with the reason:');
  for (const m of missing) console.log(`   ${m.name} (${m.criteria_type})`);
}
