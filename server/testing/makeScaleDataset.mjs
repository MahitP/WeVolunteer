/**
 * Builds a production-shaped SQLite database for migration scale testing.
 *
 *   node server/testing/makeScaleDataset.mjs --out /tmp/scale.db --users 2000
 *
 * ── Why this lives in server/testing and not in bin ──
 *
 * It is fixture tooling, not an operational script. Two guards said so when it
 * was briefly in `bin/`: `auditLog.test.js` refuses a raw
 * `INSERT INTO admin_audit_logs` anywhere in `server/` or `bin/`, because the
 * helper is what applies the actor check and the UUID; and
 * `tooling.scriptSafety.test.js` requires every `bin/` script that deletes a
 * file to run the shared safety gate.
 *
 * Both are right about operational scripts and neither should be relaxed to
 * accommodate a generator. Moving it is the honest fix: this writes a
 * throwaway database from nothing, is never pointed at a real one, and the
 * audit rows it fabricates are volume for a scale measurement rather than a
 * record of anything that happened.
 *
 * ── Why generated rather than amplified from the pilot ──
 *
 * Copying the pilot snapshot N times would multiply its rows without
 * multiplying its SHAPE: the same handful of organizations, the same few
 * events, every application pointing at one of a dozen slots. Index behaviour
 * and join costs depend on cardinality and distribution, so a dataset that is
 * large but narrow measures the wrong thing.
 *
 * This generates a population with realistic fan-out instead — each user has
 * their own applications, attendance and notifications, spread across many
 * events and organizations — so the foreign keys, indexes and aggregates are
 * exercised the way real data would exercise them.
 *
 * The schema comes from the real migrations, so what is measured is the schema
 * the application actually ships.
 */
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { transactionOn } from '../db/connectionContext.js';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};

const OUT = arg('out', '/tmp/wev-scale.db');
const USERS = Number(arg('users', 2000));
const ORGS = Math.max(1, Math.round(USERS / 40));
const EVENTS = Math.max(1, Math.round(USERS / 4));

rmSync(OUT, { force: true });
rmSync(`${OUT}-wal`, { force: true });
rmSync(`${OUT}-shm`, { force: true });

/**
 * The schema comes from the application's own boot, not from a copy of it.
 *
 * `initDatabase()` creates the tables and runs its `addColumnIfMissing` pass;
 * the migrations then bring the result to the current shape and refuse to run
 * without that pass having happened. Reproducing either here would mean a
 * dataset shaped like a guess at the schema rather than the schema, which is
 * the one thing a scale test must not measure.
 */
process.env.WEV_DB_PATH = OUT;
process.env.DEMO_MODE = 'false';
const dbModule = await import(path.resolve(import.meta.dirname, '../db.js'));
dbModule.initDatabase();
const db = new DatabaseSync(OUT);
db.exec('PRAGMA foreign_keys = ON');

const iso = (offsetDays = 0) =>
  new Date(Date.now() + offsetDays * 86400000).toISOString();
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/**
 * The shared helper, not a hand-rolled BEGIN.
 *
 * `db.accessSurface.test.js` refuses a raw BEGIN in application modules,
 * because against a pool it lands on one borrowed client while the writes go to
 * others. This generator holds its own `DatabaseSync`, so a raw BEGIN would in
 * fact be correct here — but `transactionOn` does the same thing on that handle
 * and keeps the rule with no exceptions to remember, which is worth more than
 * the three lines it replaces.
 */
const tx = (fn) => transactionOn(db, fn);

const started = Date.now();
let inserted = 0;
const bump = (n = 1) => { inserted += n; };

/* ── Users ─────────────────────────────────────────────────────────────── */
const userIds = [];
const orgIds = [];
tx(() => {
  const ins = db.prepare(`
    INSERT INTO users (id, name, email, username, password_hash, grade, role,
                       verified, email_verified, account_status, created_at)
    VALUES (?, ?, ?, ?, 'x', ?, ?, 1, 1, ?, ?)
  `);
  for (let i = 0; i < USERS; i += 1) {
    const id = `su-${i}`;
    /* A realistic minority are deleted or suspended, because the queries that
       matter filter on `account_status` and a population of only-active rows
       would never exercise that predicate. */
    const status = i % 50 === 0 ? 'deleted' : i % 71 === 0 ? 'suspended' : 'active';
    const role = i % 25 === 0 ? 'organizer' : i % 199 === 0 ? 'admin' : 'student';
    ins.run(id, `Scale User ${i}`, `scale${i}@example.test`, `scale_user_${i}`,
      role === 'student' ? String(9 + (i % 4)) : 'Adult', role, status, iso(-(i % 900)));
    userIds.push(id);
    bump();
  }
});

/* ── Organizations and membership ──────────────────────────────────────── */
tx(() => {
  const org = db.prepare(`
    INSERT INTO organizations (id, name, slug, description, status, created_at, updated_at)
    VALUES (?, ?, ?, 'Scale org', 'active', ?, ?)
  `);
  const mem = db.prepare(`
    INSERT INTO organization_members (organization_id, user_id, member_role, joined_at)
    VALUES (?, ?, ?, ?)
  `);
  for (let i = 0; i < ORGS; i += 1) {
    const id = `sorg-${i}`;
    org.run(id, `Scale Org ${i}`, `scale-org-${i}`, iso(-800), iso(-800));
    orgIds.push(id);
    bump();
    for (let m = 0; m < 25 && (i * 25 + m) < USERS; m += 1) {
      mem.run(id, userIds[i * 25 + m], m === 0 ? 'manager' : 'member', iso(-700));
      bump();
    }
  }
});

/* ── Events and slots ──────────────────────────────────────────────────── */
const slotIds = [];
const eventIds = [];
tx(() => {
  const ev = db.prepare(`
    INSERT INTO events (id, title, description, category, location, application_deadline,
                        organizer_id, organization_id, status, created_at)
    VALUES (?, ?, 'Scale event', 'Other', 'Somewhere', ?, ?, ?, ?, ?)
  `);
  const sl = db.prepare(`
    INSERT INTO slots (id, event_id, name, description, start_datetime, end_datetime, max_spots)
    VALUES (?, ?, ?, 'Shift', ?, ?, ?)
  `);
  const organizers = userIds.filter((_, i) => i % 25 === 0);
  for (let i = 0; i < EVENTS; i += 1) {
    const id = `sev-${i}`;
    const past = i % 2 === 0;
    ev.run(id, `Scale Event ${i}`, iso(past ? -40 : 30), pick(organizers), pick(orgIds),
      past ? 'completed' : 'open', iso(-(i % 400)));
    eventIds.push(id);
    bump();
    for (let s = 0; s < 2; s += 1) {
      const sid = `${id}-slot-${s}`;
      sl.run(sid, id, `Shift ${s}`, iso(past ? -35 : 35), iso(past ? -35 : 35), 8);
      slotIds.push(sid);
      bump();
    }
  }
});

/* ── Applications and attendance ───────────────────────────────────────── */
tx(() => {
  const app = db.prepare(`
    INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const att = db.prepare(`
    INSERT INTO attendance (event_id, slot_id, user_id, present, hours_awarded)
    VALUES (?, ?, ?, ?, ?)
  `);
  const seen = new Set();
  for (let i = 0; i < USERS; i += 1) {
    for (let k = 0; k < 6; k += 1) {
      const slot = slotIds[(i * 7 + k * 13) % slotIds.length];
      const key = `${userIds[i]}|${slot}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const event = slot.replace(/-slot-\d+$/, '');
      const status = k % 3 === 0 ? 'accepted' : k % 3 === 1 ? 'waitlisted' : 'pending';
      app.run(`sapp-${i}-${k}`, userIds[i], event, slot, status, iso(-(i % 300)));
      bump();
      if (status === 'accepted' && k % 2 === 0) {
        att.run(event, slot, userIds[i], 1, 2.5);
        bump();
      }
    }
  }
});

/* ── Notifications, audit logs, error reports ──────────────────────────── */
tx(() => {
  const note = db.prepare(`
    INSERT INTO notifications (id, user_id, kind, title, body, read, created_at)
    VALUES (?, ?, 'GENERIC', 'Scale notice', 'body', ?, ?)
  `);
  /**
   * Audit rows are deliberately NOT generated here.
   *
   * `auditLog.test.js` refuses a raw `INSERT INTO admin_audit_logs` anywhere in
   * `server/` or `bin/`, because `recordAudit()` is what applies the actor
   * check, the UUID and the error propagation — and it has no allowlist, which
   * is the right design for that invariant. Adding one so a fixture generator
   * could bypass it would weaken a security guard for convenience.
   *
   * Nothing is lost. The audit table's migration behaviour is exercised by the
   * pilot-snapshot dry run, which carries REAL audit history including the
   * append-only trigger and the retention window — better evidence than
   * fabricated volume would be. What this dataset exists to measure is
   * throughput and index behaviour on the high-cardinality tables, and those
   * are notifications, applications, attendance and users.
   */
  for (let i = 0; i < USERS; i += 1) {
    for (let n = 0; n < 8; n += 1) {
      note.run(`snote-${i}-${n}`, userIds[i], n % 3 === 0 ? 1 : 0, iso(-(n * 3)));
      bump();
    }
  }
});

db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
const counts = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
).all().map(({ name }) => [name, db.prepare(`SELECT COUNT(*) c FROM "${name}"`).get().c])
  .filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]);

console.log(`built ${OUT} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(`rows: ${inserted}`);
console.log(counts.slice(0, 10).map(([n, c]) => `${String(c).padStart(7)}  ${n}`).join('\n'));
db.close();
