#!/usr/bin/env node
/**
 * Measures the read paths a pilot actually exercises, against a synthetic
 * dataset of a chosen size, on PostgreSQL.
 *
 * ── Why this exists ──
 *
 * Every performance number this project had was measured on SQLite, and the
 * production engine is now PostgreSQL. The two do not merely differ in speed:
 * the planner is different, so the SHAPE of the answer differs. A query that
 * SQLite answers with a scan may get an index seek here and vice versa, and the
 * only honest way to know which is to run it and read the plan.
 *
 * It also exists because the obvious version of this measurement is wrong. The
 * default events listing does not sort by a column on `events` — `sort=soonest`
 * orders by `agg.min_start`, an aggregate over `slots` computed in a CTE with no
 * WHERE clause. Measuring `ORDER BY application_deadline` instead, which is what
 * a reasonable person writes first, understates the real cost by about 4.5x at
 * 50,000 events. Both are measured below, side by side, so that trap stays
 * visible rather than being rediscovered.
 *
 * ── Safety ──
 *
 * Refuses any Supabase host outright, and refuses to run unless the target
 * database is empty of users. It CREATES tables and INSERTS hundreds of
 * thousands of rows; pointing it at something real would be a very bad day.
 * Use a throwaway database:
 *
 *   createdb wv_scale
 *   SCALE_DB_URL=postgres://you@localhost:5432/wv_scale \
 *     node bin/scale-probe.mjs 20000 10000
 *   dropdb wv_scale
 *
 * Arguments are user count and event count; slots, applications and
 * notifications are derived from them at pilot-like ratios.
 */
import pg from 'pg';
import { applyPostgresSchema } from '../server/db/postgresSchema.js';
import { PostgresDatabase } from '../server/db/postgresConnection.js';
import { translatePlaceholders } from '../server/db/sqlPlaceholders.js';

const URL = process.env.SCALE_DB_URL;
if (!URL) { console.error('SCALE_DB_URL required'); process.exit(1); }
if (/supabase\.co/.test(URL)) {
  console.error('REFUSING: that is a Supabase host. This tool writes hundreds of');
  console.error('thousands of synthetic rows and is for throwaway databases only.');
  process.exit(1);
}

const USERS = Number(process.argv[2] || 2000);
const EVENTS = Number(process.argv[3] || 1000);

const pool = new pg.Pool({ connectionString: URL, max: 10 });
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;

function iso(offsetDays) {
  return new Date(Date.now() + offsetDays * 86400000).toISOString();
}

async function build() {
  /* Refuses a database that already holds people. `to_regclass` rather than a
     bare SELECT because the table does not exist on a fresh database, and that
     is the normal case rather than an error. */
  const [{ exists }] = await q("SELECT to_regclass('public.users') IS NOT NULL AS exists");
  if (exists) {
    const [{ c }] = await q("SELECT COUNT(*)::int c FROM users WHERE id <> 'system-cli'");
    if (c > 0) {
      console.error(`REFUSING: ${c} users already exist in that database.`);
      console.error('This tool only ever runs against an empty throwaway database.');
      process.exit(1);
    }
  }

  console.log(`[scale] schema…`);
  const db = new PostgresDatabase({ connectionString: URL, max: 10, translate: translatePlaceholders });
  await applyPostgresSchema(db);
  await db.close();

  console.log(`[scale] seeding ${USERS} users / ${EVENTS} events…`);
  const ORGS = Math.max(1, Math.floor(EVENTS / 20));

  await q(`
    INSERT INTO users (id, name, email, password_hash, grade, role, verified, account_status, created_at, token_version, username, school)
    SELECT 'u-'||g, 'User '||g, 'user'||g||'@scale.invalid', 'x',
           (ARRAY['9','10','11','12','Adult'])[1 + (g % 5)],
           CASE WHEN g % 50 = 0 THEN 'organizer' ELSE 'student' END,
           1, 'active', $1, 1, 'user'||g, 'School '||(g % 12)
    FROM generate_series(1, $2) g ON CONFLICT DO NOTHING
  `, [iso(-100), USERS]);

  await q(`
    INSERT INTO organizations (id, name, slug, created_at, updated_at, created_by)
    SELECT 'org-'||g, 'Org '||g, 'org-'||g, $1, $1, 'u-1'
    FROM generate_series(1, $2) g ON CONFLICT DO NOTHING
  `, [iso(-90), ORGS]);

  await q(`
    INSERT INTO events (id, title, description, category, location, application_deadline,
                        organizer_id, organization_id, status, created_at)
    SELECT 'e-'||g, 'Event '||g, 'Description for event '||g,
           (ARRAY['School','5K','Food Pantry','Fundraiser','Other'])[1 + (g % 5)],
           'Location '||(g % 40), $1,
           'u-'||(1 + ((g * 50) % GREATEST(1,$3))),
           'org-'||(1 + (g % $4)), 'open', $2
    FROM generate_series(1, $5) g ON CONFLICT DO NOTHING
  `, [iso(10), iso(-60), USERS, ORGS, EVENTS]);

  await q(`
    INSERT INTO slots (id, event_id, name, description, start_datetime, end_datetime, max_spots)
    SELECT 's-'||g||'-'||n, 'e-'||g, 'Shift '||n, 'Shift '||n||' description', $1, $2, 10
    FROM generate_series(1, $3) g, generate_series(1, 2) n ON CONFLICT DO NOTHING
  `, [iso(14), iso(14), EVENTS]);

  await q(`
    INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at)
    SELECT 'a-'||g||'-'||n,
           'u-'||(1 + ((g * 7 + n * 13) % GREATEST(1,$1))),
           'e-'||g, 's-'||g||'-'||(1 + (n % 2)),
           (ARRAY['pending','accepted','rejected','waitlisted'])[1 + (n % 4)], $2
    FROM generate_series(1, $3) g, generate_series(1, 8) n ON CONFLICT DO NOTHING
  `, [USERS, iso(-30), EVENTS]);

  await q(`
    INSERT INTO notifications (id, user_id, kind, title, body, read, created_at)
    SELECT 'n-'||g||'-'||n, 'u-'||g, 'generic', 'Title '||g, 'Message '||g, (n % 2), $2
    FROM generate_series(1, $1) g, generate_series(1, 3) n ON CONFLICT DO NOTHING
  `, [USERS, iso(-10)]);

  await q('ANALYZE');

  for (const t of ['users', 'events', 'slots', 'applications', 'notifications', 'organizations']) {
    const [{ c }] = await q(`SELECT COUNT(*)::int c FROM ${t}`);
    console.log(`  ${t.padEnd(15)} ${c}`);
  }
}

/** Runs a query N times and reports p50/p95/p99 plus the plan's headline. */
async function measure(label, sql, params = [], runs = 25) {
  await q(sql, params); // warm
  const times = [];
  for (let i = 0; i < runs; i += 1) {
    const t0 = process.hrtime.bigint();
    await q(sql, params);
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  times.sort((a, b) => a - b);
  const at = (p) => times[Math.min(times.length - 1, Math.floor(times.length * p))].toFixed(1);

  const plan = await q(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
  const root = plan[0]['QUERY PLAN'][0];
  const scans = [];
  (function walk(n) {
    if (n['Node Type'] && /Seq Scan/.test(n['Node Type'])) scans.push(`${n['Node Type']} on ${n['Relation Name']} (${n['Actual Rows']} rows)`);
    for (const c of n.Plans || []) walk(c);
  })(root.Plan);

  console.log(`\n${label}`);
  console.log(`  p50=${at(0.5)}ms  p95=${at(0.95)}ms  p99=${at(0.99)}ms   planning=${root['Planning Time']?.toFixed(1)}ms exec=${root['Execution Time']?.toFixed(1)}ms`);
  if (scans.length) console.log(`  SEQ SCANS: ${scans.join('; ')}`);
  else console.log('  (no sequential scans)');
  return { label, p50: Number(at(0.5)), p95: Number(at(0.95)), scans };
}

async function main() {
  await build();
  console.log('\n================ MEASUREMENTS ================');
  const results = [];

  /* The REAL default browse query, reconstructed from eventQuery.js: sort
     `soonest` orders by agg.min_start, which is an aggregate over slots in a
     CTE with no WHERE — so every event and slot is folded before the outer
     LIMIT 50 can discard them. No index on `events` can serve this. */
  results.push(await measure('events list — REAL default browse (soonest, agg CTE)', `
    WITH agg AS (
      SELECT e.id AS event_id,
             MIN(s.start_datetime) AS min_start,
             COALESCE(SUM(s.max_spots), 0) AS total_spots,
             (SELECT COUNT(*) FROM applications a2
               WHERE a2.event_id = e.id AND a2.status = 'accepted') AS accepted
      FROM events e LEFT JOIN slots s ON s.event_id = e.id
      GROUP BY e.id
    )
    SELECT e.*, u.name AS organizer_name, org.name AS organization_name,
           GREATEST(0, agg.total_spots - COALESCE(agg.accepted, 0)) AS spots_remaining,
           COUNT(*) OVER () AS total_count
    FROM events e
    JOIN users u ON e.organizer_id = u.id
    JOIN agg ON agg.event_id = e.id
    LEFT JOIN organizations org ON org.id = e.organization_id
    ORDER BY agg.min_start IS NULL, agg.min_start ASC, e.id ASC
    LIMIT 50
  `));

  results.push(await measure('events list — default browse page (50)', `
    SELECT e.*, u.name AS organizer_name, org.name AS organization_name,
           COUNT(*) OVER () AS total_count
    FROM events e
    JOIN users u ON u.id = e.organizer_id
    LEFT JOIN organizations org ON org.id = e.organization_id
    WHERE e.status = 'open'
    ORDER BY e.application_deadline ASC
    LIMIT 50
  `));

  results.push(await measure('events list — text search', `
    SELECT e.id FROM events e
    WHERE e.status = 'open' AND (e.title ILIKE $1 OR e.description ILIKE $1)
    ORDER BY e.application_deadline ASC LIMIT 50
  `, ['%Event 42%']));

  results.push(await measure('spots remaining per slot (capacity fold)', `
    SELECT s.id, s.max_spots, COUNT(a.id) FILTER (WHERE a.status = 'accepted') AS taken
    FROM slots s LEFT JOIN applications a ON a.slot_id = s.id
    WHERE s.event_id = ANY($1)
    GROUP BY s.id, s.max_spots
  `, [Array.from({ length: 50 }, (_, i) => `e-${i + 1}`)]));

  results.push(await measure('my applications', `
    SELECT a.*, e.title FROM applications a
    JOIN events e ON e.id = a.event_id
    WHERE a.user_id = $1 ORDER BY a.applied_at DESC LIMIT 50
  `, ['u-7']));

  results.push(await measure('unread notification count', `
    SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND read = 0
  `, ['u-7']));

  results.push(await measure('user directory page', `
    SELECT id, name, username, school FROM users
    WHERE account_status = 'active' ORDER BY name ASC LIMIT 50
  `));

  results.push(await measure('admin stats — application status rollup', `
    SELECT status, COUNT(*) FROM applications GROUP BY status
  `));

  results.push(await measure('event roster (accepted volunteers)', `
    SELECT u.id, u.name, a.status FROM applications a
    JOIN users u ON u.id = a.user_id
    WHERE a.event_id = $1 AND a.status = 'accepted'
  `, ['e-5']));

  console.log('\n================ SUMMARY ================');
  const slow = results.filter(r => r.p95 > 100);
  const seq = results.filter(r => r.scans.length);
  console.log(`queries measured : ${results.length}`);
  console.log(`p95 over 100ms   : ${slow.length ? slow.map(s => s.label).join(', ') : 'none'}`);
  console.log(`with seq scans   : ${seq.length ? seq.map(s => s.label).join(', ') : 'none'}`);

  await pool.end();
}

main().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });
