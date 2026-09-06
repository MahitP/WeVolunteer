#!/usr/bin/env node
/**
 * The backup drill, end to end, against a SYNTHETIC database of a chosen size.
 *
 * ── Why this exists ──
 *
 * `docs/operations/backup-and-restore.md` recorded a drill that proved the
 * mechanism on two rows and named three things it did NOT prove: the encryption
 * round-trip, the off-host upload, and a restore at anything like production
 * size. "We have backups" was therefore still resting on a two-row sample.
 *
 * This closes the first and third here, and hands the second to
 * `bin/lib/r2-upload.test.mjs`, which is a test seam rather than a live drill —
 * a distinction the report must keep, because proving that an artifact is handed
 * to the upload interface correctly is not the same as proving a provider
 * accepted it.
 *
 * ── Safety ──
 *
 * Refuses any host that is not loopback, and refuses any database that already
 * contains people. It CREATES tables and INSERTS hundreds of thousands of rows.
 * Every row it writes is generated here: there is no path by which real data can
 * enter, and no fixture is copied from a live database.
 *
 * Names are drawn from a fixed synthetic vocabulary and addresses all land on
 * `example.invalid`, which is reserved by RFC 6761 and can never be delivered
 * to. Nothing here is, or resembles, a real person — which matters more than
 * usual for this product, because the real database holds minors' records.
 *
 * ── Usage ──
 *
 *   DRILL_DB_URL=postgres://you@localhost:5432/wev_drill \
 *     node bin/backup-drill.mjs [users] [events]
 *
 * Requires a pg_dump whose major version matches the server; see the version
 * trap in the runbook.
 */
import pg from 'pg';
import { applyPostgresSchema } from '../server/db/postgresSchema.js';
import { PostgresDatabase } from '../server/db/postgresConnection.js';
import { translatePlaceholders } from '../server/db/sqlPlaceholders.js';
import { recordAudit } from '../server/auditLog.js';

const URL = process.env.DRILL_DB_URL;
if (!URL) { console.error('DRILL_DB_URL required'); process.exit(1); }

/* Loopback only. An allowlist rather than a Supabase denylist: the denylist in
   the sibling probes answers the question "is this the one host we know about",
   and the question worth asking is "is this my own machine". */
{
  const host = URL_(URL).hostname;
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    console.error(`REFUSING: ${host} is not loopback. This tool writes hundreds of`);
    console.error('thousands of synthetic rows and then DROPS things. Point it at a');
    console.error('throwaway database on your own machine.');
    process.exit(1);
  }
}
function URL_(u) { return new globalThis.URL(u); }

const USERS = Number(process.argv[2] || 20000);
const EVENTS = Number(process.argv[3] || 10000);

const pool = new pg.Pool({ connectionString: URL, max: 10 });
const q = (sql, params) => pool.query(sql, params);
const ms = (t) => `${(Number(process.hrtime.bigint() - t) / 1e6).toFixed(0)} ms`;
const now = () => process.hrtime.bigint();
const log = (s) => console.log(s);

/* ── Synthetic vocabulary ─────────────────────────────────────────────────── */
const GIVEN = ['Ash', 'Blue', 'Cyan', 'Dove', 'Echo', 'Fern', 'Gray', 'Haze', 'Iris', 'Jade'];
const FAMILY = ['Archer', 'Bell', 'Cross', 'Dale', 'Ember', 'Frost', 'Grove', 'Hollow'];
/* Must satisfy `events_category_check`; taken from the constraint itself. */
const CAUSES = ['Environment', 'Food Pantry', 'Tutoring', 'Seniors', 'Animals', 'Health', 'Sports'];

/* Ratios chosen to resemble the pilot's own shape rather than to flatter the
   clock: eight applications per event, two slots, one attendance row per slot,
   two notifications per user. */
const SLOTS = EVENTS * 2;
const APPS = EVENTS * 8;
const ATTEND = SLOTS;
const NOTIFS = USERS * 2;
const CERTS = Math.floor(ATTEND / 2);
const CONVOS = Math.floor(EVENTS / 2);
const MSGS = CONVOS * 6;
const AUDIT = Math.floor(USERS / 10);

async function seed(db) {
  log(`\nseeding synthetic data — ${USERS.toLocaleString()} users / ${EVENTS.toLocaleString()} events`);
  const t = now();

  await q(`INSERT INTO organizations (id, name, slug, status, created_at, updated_at)
           SELECT 'org-' || g, 'Synthetic Org ' || g, 'org-' || g, 'active', now()::text, now()::text
           FROM generate_series(1, $1) g`, [Math.max(1, Math.floor(EVENTS / 50))]);

  await q(`INSERT INTO users (id, name, email, password_hash, grade, role, username, created_at)
           SELECT 'u-' || g,
                  ($2::text[])[1 + (g % array_length($2::text[],1))] || ' ' || ($3::text[])[1 + (g % array_length($3::text[],1))],
                  'user' || g || '@example.invalid',
                  'not-a-real-hash',
                  (9 + (g % 4))::text,
                  CASE WHEN g % 97 = 0 THEN 'organizer' ELSE 'student' END,
                  'user' || g,
                  now()::text
           FROM generate_series(1, $1) g`, [USERS, GIVEN, FAMILY]);

  await q(`INSERT INTO events (id, title, description, category, location, application_deadline,
                               organizer_id, status, created_at)
           SELECT 'e-' || g, 'Synthetic Event ' || g, 'Generated for a backup drill.',
                  ($3::text[])[1 + (g % array_length($3::text[],1))], 'Somewhere ' || g,
                  (now() + (g % 300) * interval '1 day')::text,
                  'u-' || (1 + (g % $2)), 'open', now()::text
           FROM generate_series(1, $1) g`, [EVENTS, USERS, CAUSES]);

  await q(`INSERT INTO slots (id, event_id, name, description, start_datetime, end_datetime, max_spots)
           SELECT 's-' || g, 'e-' || (1 + (g % $2)), 'Shift ' || g, 'Synthetic shift.',
                  (now() + (g % 365) * interval '1 day')::text,
                  (now() + (g % 365) * interval '1 day' + interval '3 hours')::text,
                  5 + (g % 20)
           FROM generate_series(1, $1) g`, [SLOTS, EVENTS]);

  /* `applications` is UNIQUE on (user_id, slot_id) — a student applies to a shift
     once. A naive `g % users` collides immediately, so each round through the
     slots draws its applicants from a disjoint band of users. That holds while
     APPS/SLOTS rounds times the band width stays inside USERS, which the
     assertion below states rather than leaves to be rediscovered. */
  const ROUNDS = Math.ceil(APPS / SLOTS);
  const BAND = Math.floor(USERS / ROUNDS);
  if (BAND < 1) throw new Error(`cannot place ${APPS} applications over ${SLOTS} slots with ${USERS} users`);
  await q(`INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at)
           SELECT 'a-' || g,
                  'u-' || (1 + (((g - 1) % $3) + ((g - 1) / $3) * $5) % $4),
                  'e-' || (1 + (((g - 1) % $3) % $2)),
                  's-' || (1 + ((g - 1) % $3)),
                  CASE WHEN g % 3 = 0 THEN 'accepted' WHEN g % 3 = 1 THEN 'pending' ELSE 'rejected' END,
                  now()::text
           FROM generate_series(1, $1) g`, [APPS, EVENTS, SLOTS, USERS, BAND]);

  /* present = 1 and hours_awarded together, because the derived-hours invariant
     reads both and a restore that loses either is the failure worth catching. */
  await q(`INSERT INTO attendance (event_id, slot_id, user_id, present, hours_awarded)
           SELECT 'e-' || (1 + (g % $2)), 's-' || g, 'u-' || (1 + (g % $3)), 1, 3.0
           FROM generate_series(1, $1) g`, [ATTEND, EVENTS, USERS]);

  await q(`INSERT INTO hours_ledger (id, user_id, event_id, slot_id, action, delta, source, created_at)
           SELECT 'hl-' || g, 'u-' || (1 + (g % $3)), 'e-' || (1 + (g % $2)), 's-' || g,
                  'credited', 3.0, 'attendance_screen', now()::text
           FROM generate_series(1, $1) g`, [ATTEND, EVENTS, USERS]);

  await q(`INSERT INTO notifications (id, user_id, kind, title, body, created_at)
           SELECT 'n-' || g, 'u-' || (1 + (g % $2)), 'application_accepted',
                  'Synthetic notification', 'Generated for a backup drill.', now()::text
           FROM generate_series(1, $1) g`, [NOTIFS, USERS]);

  await q(`INSERT INTO certificates (user_id, event_id, code, created_at, hours_snapshot)
           SELECT 'u-' || (1 + (g % $3)), 'e-' || (1 + (g % $2)),
                  'WEV-' || lpad(to_hex(g), 4, '0') || '-' || lpad(to_hex(g * 7), 4, '0'),
                  now()::text, 3.0
           FROM generate_series(1, $1) g`, [CERTS, EVENTS, USERS]);

  /* `student_organizer` requires event_id, student_id AND organizer_id together
     (conversations_check). Seeding a shape the schema forbids would prove
     nothing about a restore. */
  await q(`INSERT INTO conversations (id, kind, event_id, student_id, organizer_id, created_by, created_at)
           SELECT 'c-' || g, 'student_organizer', 'e-' || (1 + (g % $2)),
                  'u-' || (1 + (g % $3)), 'u-' || (1 + ((g * 3) % $3)),
                  'u-' || (1 + (g % $3)), now()::text
           FROM generate_series(1, $1) g`, [CONVOS, EVENTS, USERS]);

  await q(`INSERT INTO messages (id, conversation_id, sender_id, body, created_at)
           SELECT 'm-' || g, 'c-' || (1 + (g % $2)), 'u-' || (1 + (g % $3)),
                  'Synthetic message body.', now()::text
           FROM generate_series(1, $1) g`, [MSGS, CONVOS, USERS]);

  /* Through `recordAudit`, one row at a time, and NOT as a bulk INSERT.
     `server/auditLog.test.js` asserts that the helper is the only writer of
     `admin_audit_logs` anywhere in `server/` or `bin/`, with no allowlist — and
     it is right to. The rule exists so the actor check, the UUID id and the
     error propagation always apply, and a seed script is exactly the kind of
     caller that would quietly grow into a second writer.
     
     It also makes the fixture more faithful: these rows are shaped by the same
     code path that writes the real ones, so a restore is verified against what
     the application actually stores. Two thousand sequential round trips
     against a local server cost well under a second. */
  for (let g = 1; g <= AUDIT; g += 1) {
    await recordAudit(db, {
      adminId: 'u-1',
      action: 'ROSTER_EXPORTED',
      targetUserId: `u-${1 + (g % USERS)}`,
      details: 'Synthetic audit row generated for a backup drill.',
    });
  }

  log(`  seeded in ${ms(t)}`);
}

const TABLES = ['users', 'events', 'slots', 'applications', 'attendance', 'hours_ledger',
  'notifications', 'certificates', 'conversations', 'messages', 'admin_audit_logs', 'organizations'];

async function counts() {
  const out = {};
  for (const t of TABLES) {
    const r = await q(`SELECT count(*)::int AS n FROM ${t}`);
    out[t] = r.rows[0].n;
  }
  return out;
}

async function main() {
  const db = new PostgresDatabase({ connectionString: URL, max: 10, translate: translatePlaceholders });
  await applyPostgresSchema(db);
  log('schema applied');

  /* "Holds people", not "holds rows". `applyPostgresSchema` bootstraps its own
     `system-cli@wevolunteer.invalid` account, so a count of zero is never the
     state a fresh database is actually in — and a guard that can never pass is a
     guard somebody deletes. Reserved domains cannot belong to a real person:
     `.invalid` is reserved by RFC 6761 for exactly this. */
  const existing = await q(
    `SELECT count(*)::int AS n FROM users WHERE email NOT LIKE '%.invalid'`
  );
  if (existing.rows[0].n > 0) {
    console.error(`REFUSING: this database already holds ${existing.rows[0].n} real accounts.`);
    console.error('This tool is for throwaway databases only.');
    process.exit(1);
  }

  await seed(db);
  const before = await counts();
  log('\nrow counts:');
  for (const [k, v] of Object.entries(before)) log(`  ${k.padEnd(16)} ${v.toLocaleString()}`);

  const total = Object.values(before).reduce((a, b) => a + b, 0);
  log(`  ${'TOTAL'.padEnd(16)} ${total.toLocaleString()}`);

  await pool.end();
  await db.close?.();

  console.log(JSON.stringify({ counts: before, total }));
}

main().catch((e) => { console.error(e); process.exit(1); });
