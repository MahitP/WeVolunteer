#!/usr/bin/env node
/**
 * Differential and benchmark harness for the events browse query.
 *
 * ── Why this exists ──
 *
 * `docs/operations/postgres-scale-measurements.md` records the events listing as
 * the one query with a scaling limit worth knowing about: linear in event count,
 * crossing 100 ms at about 10,000 events. Its own note says the fix is
 * structural rather than an index, and that it "should be done deliberately with
 * the existing eventQuery tests, not reflexively" — because the sort, the
 * filters and the pagination all hang off the aggregate being rewritten.
 *
 * This is the deliberate part. It builds the REAL query from `eventQuery.js`'s
 * own fragments, builds each candidate rewrite beside it, and then does two
 * things that a benchmark alone would not:
 *
 *   1. **Differential.** Every variant must return byte-identical rows, in the
 *      same order, with the same aggregate values, for every filter and sort
 *      combination below. A faster query that answers differently is not an
 *      optimisation, it is a defect with a good stopwatch.
 *   2. **Plans.** `EXPLAIN (ANALYZE, BUFFERS)` for each, so the reason a variant
 *      is faster is recorded rather than assumed.
 *
 * ── Safety ──
 *
 * Refuses any Supabase host and any database that already holds users. It
 * CREATES tables and INSERTS hundreds of thousands of rows.
 *
 *   createdb wv_eq
 *   EQ_DB_URL=postgres://you@localhost:5432/wv_eq node bin/events-query-probe.mjs
 *   dropdb wv_eq
 *
 * Options:
 *   --scales 100,1000,5000,10000   event counts to measure at
 *   --runs 15                      timed runs per case, after a warm-up
 *   --variants current,restricted  which variants to include
 */
import pg from 'pg';
import { applyPostgresSchema } from '../server/db/postgresSchema.js';
import { PostgresDatabase } from '../server/db/postgresConnection.js';
import { translatePlaceholders } from '../server/db/sqlPlaceholders.js';
import {
  eventQueryFragments, buildEventWhere, buildEventOrder, parseEventFilters, buildAggScope,
} from '../server/eventQuery.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

const URL_ = process.env.EQ_DB_URL;
if (!URL_) { console.error('EQ_DB_URL required (a throwaway database).'); process.exit(1); }
if (/supabase\.co/.test(URL_)) {
  console.error('REFUSING: that is a Supabase host. Throwaway databases only.');
  process.exit(1);
}
if (process.env.NODE_ENV === 'production') { console.error('REFUSING: NODE_ENV=production.'); process.exit(1); }

const SCALES = String(arg('scales', '100,1000,5000,10000')).split(',').map(Number);
const RUNS = Number(arg('runs', 15));
const WANTED = String(arg('variants', 'current,restricted,inline')).split(',');

const pool = new pg.Pool({ connectionString: URL_, max: 6 });
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;

/** A stand-in for the `db` handle the dialect helpers branch on. */
const PG = { dialect: 'postgres' };

const iso = (offsetDays) => new Date(Date.now() + offsetDays * 86400000).toISOString();

/* ────────────────────────────────────────────────────────────────────────────
 * The query, as the route actually assembles it
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The event-only half of the WHERE clause, from the real implementation.
 *
 * `buildAggScope` is what the route uses, so the probe measures the shipped
 * split rather than a copy of it — a copy is how the first version of this
 * harness came to test a filter (`hasSpots`) that does not exist while missing
 * one (`openOnly`) that does.
 */
function splitWhere(filters, userId, db) {
  return {
    full: buildEventWhere(filters, userId, db),
    scope: buildAggScope(filters, userId, db),
  };
}

/** The current shape: one CTE folding every event and every slot. */
function currentSql(filters, userId, limit, offset) {
  const { aggCte, distanceSelect, spotsSelect } = eventQueryFragments({ ...filters, db: PG });
  const { where, params } = buildEventWhere(filters, userId, PG);
  const order = buildEventOrder(filters.sort, filters.semanticIds);
  const sql = `
    WITH ${aggCte}
    SELECT e.id, e.title, e.status,
           ${spotsSelect}, ${distanceSelect},
           agg.min_start, agg.max_end, agg.total_spots, agg.total_hours, agg.accepted,
           COUNT(*) OVER () AS total_count
    FROM events e
    JOIN users u ON e.organizer_id = u.id
    JOIN agg ON agg.event_id = e.id
    LEFT JOIN organizations org ON org.id = e.organization_id
    ${where}
    ${order}
    LIMIT @limit OFFSET @offset
  `;
  return { sql, params: { ...params, limit, offset } };
}

/**
 * The candidate: the aggregate is folded only over events that already survive
 * the event-only predicates.
 *
 * `WHERE e.id IN (SELECT …)` rather than a LATERAL join, because SQLite has no
 * LATERAL and this query has to run identically on both engines. The
 * aggregate-dependent predicates stay in the outer WHERE, where they still see
 * the columns they need.
 */
function restrictedSql(filters, userId, limit, offset) {
  const { distanceSelect, spotsSelect } = eventQueryFragments({ ...filters, db: PG });
  const { full, scope } = splitWhere(filters, userId, PG);
  const order = buildEventOrder(filters.sort, filters.semanticIds);
  const { greatestSql } = fragmentsForAgg();

  const sql = `
    WITH cand AS (
      SELECT e.id
      FROM events e
      JOIN users u ON e.organizer_id = u.id
      ${scope.where}
    ),
    agg AS (
      SELECT e.id AS event_id,
             MIN(s.start_datetime) AS min_start,
             MAX(s.end_datetime)   AS max_end,
             COALESCE(SUM(s.max_spots), 0) AS total_spots,
             COALESCE(SUM(${greatestSql}), 0) AS total_hours,
             (SELECT COUNT(*) FROM applications a2
               WHERE a2.event_id = e.id AND a2.status = 'accepted') AS accepted
      FROM events e
      LEFT JOIN slots s ON s.event_id = e.id
      WHERE e.id IN (SELECT id FROM cand)
      GROUP BY e.id
    )
    SELECT e.id, e.title, e.status,
           ${spotsSelect}, ${distanceSelect},
           agg.min_start, agg.max_end, agg.total_spots, agg.total_hours, agg.accepted,
           COUNT(*) OVER () AS total_count
    FROM events e
    JOIN users u ON e.organizer_id = u.id
    JOIN agg ON agg.event_id = e.id
    LEFT JOIN organizations org ON org.id = e.organization_id
    ${full.where}
    ${order}
    LIMIT @limit OFFSET @offset
  `;
  return { sql, params: { ...full.params, limit, offset } };
}

/** The two dialect fragments the aggregate needs, for PostgreSQL. */
function fragmentsForAgg() {
  const hoursBetweenSql =
    `ROUND((EXTRACT(EPOCH FROM (s.end_datetime::timestamptz - s.start_datetime::timestamptz)) / 3600)::numeric, 2)`;
  return { hoursBetweenSql, greatestSql: `GREATEST(0.1, ${hoursBetweenSql})` };
}

/**
 * The other candidate: the event-only predicates go straight into the aggregate,
 * with no second CTE and no semi-join.
 *
 * `cand` in `restrictedSql` buys selectivity at the cost of an extra pass over
 * `events`, which the default browse — where the scope filter keeps most rows —
 * pays for and never recovers. Folding the predicates into `agg` itself removes
 * that pass.
 *
 * The `users` join is repeated inside the aggregate because the text search
 * matches the organizer's name as well as the event's own columns, so the
 * predicate cannot be split. It is the SAME inner join the outer query makes, so
 * it neither adds nor removes rows: an event whose organizer is missing is
 * absent from both.
 */
function inlineSql(filters, userId, limit, offset) {
  const { distanceSelect, spotsSelect } = eventQueryFragments({ ...filters, db: PG });
  const { full, scope } = splitWhere(filters, userId, PG);
  const order = buildEventOrder(filters.sort, filters.semanticIds);
  const { greatestSql } = fragmentsForAgg();

  const sql = `
    WITH agg AS (
      SELECT e.id AS event_id,
             MIN(s.start_datetime) AS min_start,
             MAX(s.end_datetime)   AS max_end,
             COALESCE(SUM(s.max_spots), 0) AS total_spots,
             COALESCE(SUM(${greatestSql}), 0) AS total_hours,
             (SELECT COUNT(*) FROM applications a2
               WHERE a2.event_id = e.id AND a2.status = 'accepted') AS accepted
      FROM events e
      JOIN users u ON e.organizer_id = u.id
      LEFT JOIN slots s ON s.event_id = e.id
      ${scope.where}
      GROUP BY e.id
    )
    SELECT e.id, e.title, e.status,
           ${spotsSelect}, ${distanceSelect},
           agg.min_start, agg.max_end, agg.total_spots, agg.total_hours, agg.accepted,
           COUNT(*) OVER () AS total_count
    FROM events e
    JOIN users u ON e.organizer_id = u.id
    JOIN agg ON agg.event_id = e.id
    LEFT JOIN organizations org ON org.id = e.organization_id
    ${full.where}
    ${order}
    LIMIT @limit OFFSET @offset
  `;
  return { sql, params: { ...full.params, limit, offset } };
}

/**
 * The third candidate, and the difference that matters: the `users` join inside
 * the aggregate is made CONDITIONAL.
 *
 * `inlineSql` joins `users` unconditionally so the text predicate can reference
 * the organizer's name. Only the text search does — every other predicate
 * constrains `events` alone. On the default browse that join is pure cost, which
 * is exactly where `inline` lost to `current`.
 */
function inline2Sql(filters, userId, limit, offset) {
  const { distanceSelect, spotsSelect } = eventQueryFragments({ ...filters, db: PG });
  const { full, scope } = splitWhere(filters, userId, PG);
  const order = buildEventOrder(filters.sort, filters.semanticIds);
  const { greatestSql } = fragmentsForAgg();
  const needsUsers = scope.needsUsers;

  const sql = `
    WITH agg AS (
      SELECT e.id AS event_id,
             MIN(s.start_datetime) AS min_start,
             MAX(s.end_datetime)   AS max_end,
             COALESCE(SUM(s.max_spots), 0) AS total_spots,
             COALESCE(SUM(${greatestSql}), 0) AS total_hours,
             (SELECT COUNT(*) FROM applications a2
               WHERE a2.event_id = e.id AND a2.status = 'accepted') AS accepted
      FROM events e
      ${needsUsers ? 'JOIN users u ON e.organizer_id = u.id' : ''}
      LEFT JOIN slots s ON s.event_id = e.id
      ${scope.where}
      GROUP BY e.id
    )
    SELECT e.id, e.title, e.status,
           ${spotsSelect}, ${distanceSelect},
           agg.min_start, agg.max_end, agg.total_spots, agg.total_hours, agg.accepted,
           COUNT(*) OVER () AS total_count
    FROM events e
    JOIN users u ON e.organizer_id = u.id
    JOIN agg ON agg.event_id = e.id
    LEFT JOIN organizations org ON org.id = e.organization_id
    ${full.where}
    ${order}
    LIMIT @limit OFFSET @offset
  `;
  return { sql, params: { ...full.params, limit, offset } };
}


/**
 * Two-phase: choose the page's event ids first, aggregate only those.
 *
 * ── The hypothesis ──
 *
 * The `agg` CTE computes, for EVERY event, a MIN, a MAX, two SUMs over slots
 * and a correlated `COUNT(*)` over `applications`. At 50,000 events and 320,000
 * applications that is fifty thousand correlated counts — and then `LIMIT 60`
 * throws away 49,940 of them. The aggregate values are only ever DISPLAYED, so
 * nothing outside the page needs them.
 *
 * Phase 1 selects the page using only what the ordering and the event-only
 * predicates require. `min_start` is still needed to sort by "soonest", but as a
 * correlated scalar subquery it is an index seek on `idx_slots_event` per
 * candidate rather than a hash aggregate over the whole slots table — and,
 * crucially, the four other aggregates and the applications count are not
 * computed at all.
 *
 * Phase 2 folds `agg` over the page's ids only.
 *
 * ── Where it does NOT apply ──
 *
 * When a filter or a sort needs an aggregate the outer query cannot be split:
 * `openOnly` reads spots_remaining, the date range reads min_start/max_end,
 * `minHours` reads total_hours, and the `spots`/`hours` sorts read the fold. In
 * those cases this variant returns the current SQL unchanged, which is what
 * makes it safe to adopt — it can only change the paths where the aggregate is
 * display-only.
 */
function twoPhaseSql(filters, userId, limit, offset) {
  const scope = buildAggScope(filters, userId, PG);
  const { where, params } = buildEventWhere(filters, userId, PG);
  const sort = filters.sort || 'soonest';

  /* The outer WHERE still mentioning `agg` means the split is unavailable. */
  const needsAggInWhere = /\bagg\./.test(where);
  const needsAggInSort = sort === 'spots' || sort === 'hours';
  if (needsAggInWhere || needsAggInSort) return currentSql(filters, userId, limit, offset);

  const { distanceSelect, spotsSelect, aggCte } = eventQueryFragments({ ...filters, db: PG });

  /* Phase 1's ORDER BY, over event columns and a correlated min_start. */
  const PHASE1_SORT = {
    soonest: 'p.min_start IS NULL, p.min_start ASC',
    deadline: 'e.application_deadline ASC',
    alpha: 'e.title COLLATE nocase ASC',
  };
  const order1 = PHASE1_SORT[sort] || PHASE1_SORT.soonest;

  const sql = `
    WITH page AS (
      SELECT e.id AS event_id,
             (SELECT MIN(s.start_datetime) FROM slots s WHERE s.event_id = e.id) AS min_start,
             COUNT(*) OVER () AS total_count
      FROM events e
      ${scope?.needsUsers ? 'JOIN users u ON e.organizer_id = u.id' : ''}
      ${scope?.where ?? ''}
      ORDER BY ${order1.replace(/\bp\.min_start\b/g, '(SELECT MIN(s2.start_datetime) FROM slots s2 WHERE s2.event_id = e.id)')}, e.id ASC
      LIMIT @limit OFFSET @offset
    ),
    ${aggCte.replace('FROM events e', 'FROM events e JOIN page ON page.event_id = e.id')}
    SELECT e.id, e.title, e.status,
           ${spotsSelect}, ${distanceSelect},
           agg.min_start, agg.max_end, agg.total_spots, agg.total_hours, agg.accepted,
           page.total_count
    FROM events e
    JOIN page ON page.event_id = e.id
    JOIN users u ON e.organizer_id = u.id
    JOIN agg ON agg.event_id = e.id
    LEFT JOIN organizations org ON org.id = e.organization_id
    ORDER BY ${SORT_OUTER[sort] || SORT_OUTER.soonest}, e.id ASC
  `;
  return { sql, params: { ...params, limit, offset } };
}

/** The outer ordering, re-applied so the page comes back in the right order. */
const SORT_OUTER = {
  soonest: 'agg.min_start IS NULL, agg.min_start ASC',
  deadline: 'e.application_deadline ASC',
  alpha: 'e.title COLLATE nocase ASC',
};

const VARIANTS = {
  current: currentSql,
  restricted: restrictedSql,
  inline: inlineSql,
  inline2: inline2Sql,
  twophase: twoPhaseSql,
  /* `indexed` and `both` reuse the SQL above; what varies is whether the
     composite index exists when they run. */
  indexed: currentSql,
  both: restrictedSql,
};

const NEEDS_INDEX = new Set(['indexed', 'both']);

/* ────────────────────────────────────────────────────────────────────────────
 * The cases
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Every filter and sort combination the browse screen can produce, plus the
 * boundaries a rewrite is most likely to get wrong.
 *
 * Run through `parseEventFilters` rather than hand-built, so the probe measures
 * the filter objects the route actually constructs.
 */
const CASES = [
  ['default browse (listable, soonest)', {}],
  ['favorites only', { favoritesOnly: 'true' }],
  ['closing soon', { closingSoon: 'true' }],
  ['place', { place: 'Location 3' }],
  ['mine', { mine: 'true' }],
  ['open only', { scope: 'open' }],
  ['text search', { q: 'event 4' }],
  ['category', { category: 'Food Pantry' }],
  ['open only (the real filter)', { openOnly: 'true' }],
  ['date range', { from: '2020-01-01', to: '2030-01-01' }],
  ['min hours', { minHours: '1' }],
  ['sort: deadline', { sort: 'deadline' }],
  ['sort: spots', { sort: 'spots' }],
  ['sort: hours', { sort: 'hours' }],
  ['sort: alpha', { sort: 'alpha' }],
  ['filters + sort combined', { q: 'event', openOnly: 'true', sort: 'spots' }],
  ['date range + min hours + sort hours', { from: '2020-01-01', minHours: '0.5', sort: 'hours' }],
  ['deep page', {}, { limit: 50, offset: 500 }],
  ['page boundary', { }, { limit: 1, offset: 0 }],
  ['empty result', { q: 'zzzz-no-such-event-zzzz' }],
];

/* ────────────────────────────────────────────────────────────────────────────
 * Seeding
 * ──────────────────────────────────────────────────────────────────────────── */

async function refuseNonEmpty() {
  const [{ exists }] = await q("SELECT to_regclass('public.users') IS NOT NULL AS exists");
  if (!exists) return;
  const [{ c }] = await q("SELECT COUNT(*)::int c FROM users WHERE id <> 'system-cli'");
  if (c > 0) {
    console.error(`REFUSING: ${c} users already exist in that database.`);
    process.exit(1);
  }
}

async function seed(events) {
  const users = Math.max(50, Math.floor(events * 2));
  const orgs = Math.max(1, Math.floor(events / 20));

  await q('TRUNCATE applications, slots, events, organization_members, organizations, users CASCADE');

  await q(`
    INSERT INTO users (id, name, email, password_hash, grade, role, verified, account_status,
                       created_at, token_version, username, school)
    SELECT 'u-'||g, 'User '||g, 'user'||g||'@eq.invalid', 'x',
           (ARRAY['9','10','11','12','Adult'])[1 + (g % 5)],
           CASE WHEN g % 50 = 0 THEN 'organizer' ELSE 'student' END,
           1, 'active', $1, 1, 'user'||g, 'School '||(g % 12)
    FROM generate_series(1, $2::int) g ON CONFLICT DO NOTHING
  `, [iso(-100), users]);

  await q(`
    INSERT INTO organizations (id, name, slug, created_at, updated_at, created_by)
    SELECT 'org-'||g, 'Org '||g, 'org-'||g, $1, $1, 'u-1'
    FROM generate_series(1, $2::int) g ON CONFLICT DO NOTHING
  `, [iso(-90), orgs]);

  /* A realistic mix: most events listable, some completed or cancelled, a
     handful with NO slots at all — the null-aggregate case a rewrite is most
     likely to drop. */
  await q(`
    INSERT INTO events (id, title, description, category, location, application_deadline,
                        organizer_id, organization_id, status, created_at, latitude, longitude)
    SELECT 'e-'||g, 'Event '||g, 'Description for event '||g,
           (ARRAY['School','5K','Food Pantry','Fundraiser','Other'])[1 + (g % 5)],
           'Location '||(g % 40), $1,
           'u-'||(50 * (1 + (g % GREATEST(1, $3::int / 50)))),
           CASE WHEN g % 3 = 0 THEN 'org-'||(1 + (g % $4::int)) ELSE NULL END,
           (ARRAY['open','open','open','closed','completed','cancelled'])[1 + (g % 6)],
           $2,
           CASE WHEN g % 7 = 0 THEN NULL ELSE 40.0 + (g % 100) * 0.01 END,
           CASE WHEN g % 7 = 0 THEN NULL ELSE -74.0 - (g % 100) * 0.01 END
    FROM generate_series(1, $5::int) g ON CONFLICT DO NOTHING
  `, [iso(10), iso(-60), users, orgs, events]);

  /* Every fifth event deliberately gets no slots, so `min_start IS NULL`,
     `total_spots = 0` and the LEFT JOIN's null row are all exercised. */
  await q(`
    INSERT INTO slots (id, event_id, name, description, start_datetime, end_datetime, max_spots)
    SELECT 's-'||g||'-'||n, 'e-'||g, 'Shift '||n, 'Shift '||n,
           $1::timestamptz + (g % 200) * interval '1 day' + n * interval '2 hour',
           $1::timestamptz + (g % 200) * interval '1 day' + n * interval '2 hour' + interval '3 hour',
           2 + (n % 8)
    FROM generate_series(1, $2::int) g, generate_series(1, 1 + (g % 3)) n
    WHERE g % 5 <> 0
    ON CONFLICT DO NOTHING
  `, [iso(14), events]);

  await q(`
    INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at)
    SELECT 'a-'||s.id||'-'||n,
           'u-'||(1 + ((g * 7 + n * 13) % GREATEST(1, $1::int))),
           s.event_id, s.id,
           (ARRAY['pending','accepted','rejected','waitlisted','accepted'])[1 + (n % 5)], $2
    FROM slots s
    CROSS JOIN generate_series(1, 4) n
    CROSS JOIN LATERAL (SELECT (('x'||substr(md5(s.id), 1, 8))::bit(32)::bigint) AS g) k
    ON CONFLICT DO NOTHING
  `, [users, iso(-30)]);

  await q('ANALYZE');
  const [{ e }] = await q('SELECT COUNT(*)::int e FROM events');
  const [{ s }] = await q('SELECT COUNT(*)::int s FROM slots');
  const [{ a }] = await q('SELECT COUNT(*)::int a FROM applications');
  return { events: e, slots: s, applications: a };
}

const INDEX_SQL = 'CREATE INDEX IF NOT EXISTS idx_slots_event_start ON slots(event_id, start_datetime)';

/* ────────────────────────────────────────────────────────────────────────────
 * Running
 * ──────────────────────────────────────────────────────────────────────────── */

/** Named parameters (`@name`) to positional, the way the adapter does it. */
function bind(sql, params) {
  const values = [];
  const text = sql.replace(/@([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name) => {
    values.push(params[name]);
    return `$${values.length}`;
  });
  return { text, values };
}

async function runVariant(name, buildSql, filters, page) {
  const { sql, params } = buildSql(filters, 'u-1', page.limit, page.offset);
  const { text, values } = bind(sql, params);
  const rows = await q(text, values);

  await q(text, values); // warm
  const times = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = process.hrtime.bigint();
    await q(text, values);
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  times.sort((a, b) => a - b);
  const at = (p) => times[Math.min(times.length - 1, Math.floor(times.length * p))];

  return { name, rows, p50: at(0.5), p95: at(0.95), text, values };
}

/** A comparable projection of a result set: order matters, values matter. */
const shapeOf = (rows) => rows.map(r => [
  r.id, r.status, r.spots_remaining, r.min_start, r.max_end,
  r.total_spots, Number(r.total_hours), r.accepted, Number(r.total_count),
]);

async function planOf(text, values) {
  const rows = await q(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${text}`, values);
  const root = rows[0]['QUERY PLAN'][0];
  const scans = [];
  (function walk(n) {
    if (/Seq Scan/.test(n['Node Type'] || '')) scans.push(`${n['Relation Name']}(${n['Actual Rows']})`);
    for (const c of n.Plans || []) walk(c);
  })(root.Plan);
  return {
    exec: root['Execution Time'],
    scans: scans.length ? scans.join(' ') : 'none',
  };
}

async function main() {
  await refuseNonEmpty();
  const db = new PostgresDatabase({ connectionString: URL_, max: 4, translate: translatePlaceholders });
  await applyPostgresSchema(db);
  await db.close();

  let differences = 0;

  for (const scale of SCALES) {
    const counts = await seed(scale);
    console.log(`\n================ ${counts.events} events / ${counts.slots} slots / ${counts.applications} applications ================`);
    console.log('  case                                     variant       p50      p95   seq scans');

    for (const [label, rawFilters, page = { limit: 50, offset: 0 }] of CASES) {
      const parsed = parseEventFilters(rawFilters);
      if (!parsed.ok) { console.log(`  ${label}: FILTER REJECTED ${parsed.error}`); continue; }

      let baseline = null;
      for (const variant of WANTED) {
        const build = VARIANTS[variant];
        if (!build) continue;
        if (NEEDS_INDEX.has(variant)) await q(INDEX_SQL);
        else await q('DROP INDEX IF EXISTS idx_slots_event_start');
        await q('ANALYZE');

        const result = await runVariant(variant, build, parsed.value, page);
        const plan = await planOf(result.text, result.values);

        if (variant === WANTED[0]) baseline = result;
        else {
          const a = JSON.stringify(shapeOf(baseline.rows));
          const b = JSON.stringify(shapeOf(result.rows));
          if (a !== b) {
            differences++;
            console.log(`  !! DIFFERENCE  ${label} / ${variant}`);
            console.log(`     baseline rows=${baseline.rows.length} candidate rows=${result.rows.length}`);
            const A = shapeOf(baseline.rows); const B = shapeOf(result.rows);
            for (let i = 0; i < Math.max(A.length, B.length); i++) {
              if (JSON.stringify(A[i]) !== JSON.stringify(B[i])) {
                console.log(`     row ${i}: ${JSON.stringify(A[i])}  vs  ${JSON.stringify(B[i])}`);
                break;
              }
            }
          }
        }

        console.log(
          `  ${label.padEnd(40)} ${variant.padEnd(11)} `
          + `${result.p50.toFixed(1).padStart(7)} ${result.p95.toFixed(1).padStart(8)}   ${plan.scans}`
        );
      }
    }
  }

  console.log(`\n${differences === 0
    ? 'DIFFERENTIAL: every variant returned identical rows for every case.'
    : `DIFFERENTIAL: ${differences} DIFFERENCE(S) — the candidate is not equivalent.`}`);
  if (differences) process.exitCode = 1;
}

try {
  await main();
} finally {
  await pool.end();
}
