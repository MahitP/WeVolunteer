#!/usr/bin/env node
/**
 * Differential and benchmark harness for the browse SEARCH box.
 *
 * ── Why a second harness beside `events-query-probe.mjs` ──
 *
 * The probe measures browsing: filters, sorts, pages. It has one text case, and
 * that case searches a corpus whose entire vocabulary is the word "Event" and a
 * number — so every search either matches a tenth of the table or none of it,
 * and the two outcomes a real search box actually produces (a selective term
 * that should touch almost nothing, and a common one that touches everything)
 * do not exist in it.
 *
 * Trigram indexing lives or dies on selectivity, so measuring it against that
 * corpus would have measured nothing. This one seeds text with a vocabulary and
 * a skewed distribution, then reports each query's REAL match count beside its
 * latency, because a search's cost is only interpretable next to how much it
 * matched.
 *
 * ── What it compares ──
 *
 *   position    the pre-064 predicate: four `strpos` tests OR-ed together, with
 *               `users` joined into the scan so the organizer's name is visible
 *   indexed     what ships: `e.id IN (…)` over a UNION ALL of single-relation
 *               branches, each answerable by a `pg_trgm` GIN index
 *
 * Both statements are built by `eventQuery.buildEventListStatement` — the same
 * function the route calls — so neither arm can drift into measuring a query the
 * application does not run. `--drop-indexes` runs the `indexed` arm with the
 * trigram indexes removed, which separates the two things the change did: the
 * new SHAPE, and the INDEX that shape made usable.
 *
 * Every arm must return identical rows, in the same order, with the same exact
 * total, for every query. A faster search that answers differently is a defect
 * with a good stopwatch.
 *
 * ── Safety ──
 *
 * Refuses any Supabase host and any database that already holds users. It
 * CREATES tables and INSERTS hundreds of thousands of rows.
 *
 *   createdb wv_search
 *   SEARCH_DB_URL=postgres://you@localhost:5432/wv_search node bin/search-bench.mjs
 *   dropdb wv_search
 *
 * Options:
 *   --scales 10000,50000,100000   event counts to measure at
 *   --runs 15                     timed runs per case, after a warm-up
 *   --json out.json               also write the measurements as JSON
 *   --drop-indexes                add a third arm with no trigram indexes
 *   --write-cost                  measure what the indexes cost writes
 */
import pg from 'pg';
import { writeFileSync } from 'node:fs';
import { applyPostgresSchema } from '../server/db/postgresSchema.js';
import { PostgresDatabase } from '../server/db/postgresConnection.js';
import { translatePlaceholders } from '../server/db/sqlPlaceholders.js';
import { runPostgresMigrations } from '../server/migrations/index.js';
import { TRIGRAM_INDEXES } from '../server/migrations/064_search_trigram_indexes.js';
import { parseEventFilters, buildEventListStatement } from '../server/eventQuery.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const flag = (name) => process.argv.includes(`--${name}`);

const URL_ = process.env.SEARCH_DB_URL;
if (!URL_) { console.error('SEARCH_DB_URL required (a throwaway database).'); process.exit(1); }
if (/supabase\.co/.test(URL_)) {
  console.error('REFUSING: that is a Supabase host. Throwaway databases only.');
  process.exit(1);
}
if (process.env.NODE_ENV === 'production') { console.error('REFUSING: NODE_ENV=production.'); process.exit(1); }

const SCALES = String(arg('scales', '10000,50000')).split(',').map(Number);
const RUNS = Number(arg('runs', 15));
const JSON_OUT = arg('json', null);
const PAGE = { limit: 60, offset: 0 };

const pool = new pg.Pool({ connectionString: URL_, max: 6 });
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;

/** A stand-in for the `db` handle the dialect helpers branch on. */
const PG = { dialect: 'postgres' };

const iso = (offsetDays) => new Date(Date.now() + offsetDays * 86400000).toISOString();

/* ────────────────────────────────────────────────────────────────────────────
 * A corpus that can be searched
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The vocabulary, ordered so that position IS frequency.
 *
 * Terms are drawn with `floor(card * u²)`, which biases hard towards the front
 * of each list: `Food Pantry` lands on thousands of events and `Career Panel`
 * on a handful. That spread is the entire point — an index that helps a rare
 * term and hurts a common one is a trade, not a win, and both ends have to be
 * in the corpus for the trade to be visible.
 */
const NOUNS = [
  'Food Pantry', 'Beach Cleanup', 'Park Cleanup', 'Animal Shelter', 'Library Reading',
  'Community Garden', 'Blood Drive', 'Homework Help', 'Meal Delivery', 'Toy Drive',
  'Coat Collection', 'Senior Center Visit', 'Tutoring Session', 'Recycling Drive',
  'Trail Restoration', 'Art Mural', 'Music Festival', 'Science Fair', 'Coding Workshop',
  'Soccer Coaching', 'Chess Club', 'Robotics Mentoring', 'Hospital Volunteering',
  'Translation Desk', 'Podcast Production', 'Newsletter Design', 'Career Panel',
];
const ADJECTIVES = [
  'Community', 'Weekend', 'Annual', 'Spring', 'Summer', 'Downtown', 'Riverside',
  'Neighborhood', 'Youth', 'Citywide', 'Regional', 'Autumn', 'Winter', 'Sunrise',
];
const PLACES = [
  'Lincoln High School', 'Riverside Park', 'Downtown Library', 'Oakwood Community Center',
  'Maple Street Church', 'Harbor Point', 'Westfield Mall', 'Central Gymnasium',
  'Pinecrest Elementary', 'Veterans Hall', 'Cedar Ridge Trail', 'Northgate Plaza',
  'Sunset Beach', 'Greenfield Farm', 'Union Station', 'Bayview Hospital',
];
const FIRST = ['Morgan', 'Avery', 'Riley', 'Jordan', 'Casey', 'Quinn', 'Rowan', 'Sasha',
  'Devon', 'Elliot', 'Harper', 'Kendall', 'Marley', 'Noor', 'Priya', 'Tomas'];
const LAST = ['Reyes', 'Okafor', 'Nguyen', 'Silva', 'Kaplan', 'Moreau', 'Adeyemi', 'Kovacs',
  'Lindgren', 'Duarte', 'Haddad', 'Iversen', 'Castillo', 'Petrov', 'Bianchi', 'Osei'];

/**
 * Filler sentences, so a description is prose rather than a label.
 *
 * `volunteers` appears in every one of them deliberately: it is the corpus's
 * one genuinely non-selective term, and a trigram index's worst case is a term
 * that matches most of the table. Measuring only selective terms would have
 * reported an optimisation that made the common case quietly worse.
 */
const FILLER = [
  'We need volunteers to help set up tables and greet families as they arrive.',
  'Volunteers will sort donations, pack boxes and load them for delivery.',
  'Bring water and comfortable shoes; volunteers stay outdoors for most of the shift.',
  'Student volunteers work alongside staff and receive a short orientation first.',
  'This shift suits volunteers who enjoy talking with people and staying busy.',
];

/**
 * Refuses to touch a database that holds anybody real.
 *
 * The corpus is re-seeded on every run, so a plain "must be empty" check would
 * make the harness single-use and the second run would be against a database
 * somebody had to remember to drop. Instead the test is whether every account
 * present is one THIS harness created — `@bench.invalid` is a reserved TLD, so
 * no real address can end in it — which is a stronger statement than emptiness
 * and survives repetition.
 */
async function refuseNonEmpty() {
  const [{ exists }] = await q("SELECT to_regclass('public.users') IS NOT NULL AS exists");
  if (!exists) return;
  const [{ c }] = await q(`
    SELECT COUNT(*)::int c FROM users
     WHERE id <> 'system-cli' AND email NOT LIKE '%@bench.invalid'
  `);
  if (c > 0) {
    console.error(`REFUSING: ${c} users in that database were not created by this harness.`);
    process.exit(1);
  }
}

/* Parenthesised: PostgreSQL will not subscript an array CONSTRUCTOR directly. */
const arrayLiteral = (values) => `(ARRAY[${values.map((v) => `'${v.replace(/'/g, "''")}'`).join(',')}])`;

/**
 * A deterministic uniform in [0,1) from an integer and a salt.
 *
 * `md5` rather than `random()` so two runs of this harness at the same scale
 * produce the same corpus and therefore comparable numbers.
 */
const uniform = (expr, salt) =>
  `((('x' || substr(md5(${expr} || '${salt}'), 1, 8))::bit(32)::bigint)::numeric / 4294967296.0)`;

/** A skewed index into a SQL array: front-loaded, so early entries are common. */
const skewed = (expr, salt, card) =>
  `(1 + floor(${card} * power(${uniform(expr, salt)}, 2))::int)`;

async function seed(events) {
  const users = Math.max(200, Math.floor(events / 5));
  const orgs = Math.max(1, Math.floor(events / 200));

  await q('TRUNCATE applications, slots, events, organization_members, organizations, users CASCADE');

  await q(`
    INSERT INTO users (id, name, email, password_hash, grade, role, verified, account_status,
                       created_at, token_version, username, school)
    SELECT 'u-'||g,
           ${arrayLiteral(FIRST)}[${skewed('g::text', 'f', FIRST.length)}] || ' ' ||
           ${arrayLiteral(LAST)}[${skewed('g::text', 'l', LAST.length)}],
           'user'||g||'@bench.invalid', 'x',
           (ARRAY['9','10','11','12','Adult'])[1 + (g % 5)],
           CASE WHEN g % 10 = 0 THEN 'organizer' ELSE 'student' END,
           1, 'active', $1, 1, 'user'||g, 'School '||(g % 12)
    FROM generate_series(1, $2::int) g
  `, [iso(-100), users]);

  await q(`
    INSERT INTO organizations (id, name, slug, created_at, updated_at, created_by)
    SELECT 'org-'||g, 'Org '||g, 'org-'||g, $1, $1, 'u-1'
    FROM generate_series(1, $2::int) g
  `, [iso(-90), orgs]);

  /**
   * A few hundred events carry non-ASCII text.
   *
   * Not decoration: `lower()` and the trigram opclass both have to agree about
   * accented characters, and the only way to find out that they do on this
   * server's collation is to search for one.
   */
  await q(`
    INSERT INTO events (id, title, description, category, location, application_deadline,
                        organizer_id, organization_id, status, created_at, latitude, longitude)
    SELECT 'e-'||g,
           CASE WHEN g % 400 = 0 THEN 'Café Solidario ' || g
                ELSE ${arrayLiteral(ADJECTIVES)}[${skewed('g::text', 'a', ADJECTIVES.length)}]
                     || ' ' || ${arrayLiteral(NOUNS)}[${skewed('g::text', 'n', NOUNS.length)}]
                     || ' #' || g END,
           CASE WHEN g % 400 = 0 THEN 'Día de servicio para toda la comunidad. '
                ELSE '' END
             || ${arrayLiteral(FILLER)}[1 + (g % ${FILLER.length})]
             || ' Focus: ' || ${arrayLiteral(NOUNS)}[${skewed('g::text', 'n2', NOUNS.length)}]
             || '. Meeting point is the ' || ${arrayLiteral(PLACES)}[${skewed('g::text', 'p2', PLACES.length)}]
             || '. Contact the coordinator with questions about shift ' || g || '.',
           (ARRAY['School','5K','Food Pantry','Fundraiser','Other'])[1 + (g % 5)],
           ${arrayLiteral(PLACES)}[${skewed('g::text', 'p', PLACES.length)}],
           $1,
           'u-'||(1 + 10 * ((g % GREATEST(1, $3::int / 10)))),
           CASE WHEN g % 3 = 0 THEN 'org-'||(1 + (g % $4::int)) ELSE NULL END,
           (ARRAY['open','open','open','closed','completed','cancelled'])[1 + (g % 6)],
           $2,
           CASE WHEN g % 7 = 0 THEN NULL ELSE 40.0 + (g % 100) * 0.01 END,
           CASE WHEN g % 7 = 0 THEN NULL ELSE -74.0 - (g % 100) * 0.01 END
    FROM generate_series(1, $5::int) g
  `, [iso(10), iso(-60), users, orgs, events]);

  await q(`
    INSERT INTO slots (id, event_id, name, description, start_datetime, end_datetime, max_spots)
    SELECT 's-'||g||'-'||n, 'e-'||g, 'Shift '||n, 'Shift '||n,
           $1::timestamptz + (g % 200) * interval '1 day' + n * interval '2 hour',
           $1::timestamptz + (g % 200) * interval '1 day' + n * interval '2 hour' + interval '3 hour',
           2 + (n % 8)
    FROM generate_series(1, $2::int) g, generate_series(1, 1 + (g % 3)) n
    WHERE g % 5 <> 0
  `, [iso(14), events]);

  await q(`
    UPDATE events
       SET first_slot_start = (SELECT MIN(s.start_datetime)::text FROM slots s WHERE s.event_id = events.id)
  `);

  await q(`
    INSERT INTO applications (id, user_id, event_id, slot_id, status, applied_at)
    SELECT 'a-'||s.id||'-'||n,
           'u-'||(1 + ((k.g * 7 + n * 13) % GREATEST(1, $1::int))),
           s.event_id, s.id,
           (ARRAY['pending','accepted','rejected','waitlisted','accepted'])[1 + (n % 5)], $2
    FROM slots s
    CROSS JOIN generate_series(1, 4) n
    CROSS JOIN LATERAL (SELECT (('x'||substr(md5(s.id), 1, 8))::bit(32)::bigint) AS g) k
    ON CONFLICT DO NOTHING
  `, [users, iso(-30)]);

  await q('ANALYZE');
  const [counts] = await q(`
    SELECT (SELECT COUNT(*) FROM events)::int AS events,
           (SELECT COUNT(*) FROM slots)::int AS slots,
           (SELECT COUNT(*) FROM applications)::int AS applications,
           (SELECT COUNT(*) FROM users)::int AS users
  `);
  return counts;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The queries
 * ──────────────────────────────────────────────────────────────────────────── */

const QUERIES = [
  ['no search (control)', {}],
  ['rare term', { q: 'robotics' }],
  ['rare phrase', { q: 'chess club' }],
  ['common noun', { q: 'food pantry' }],
  ['common noun, mixed case', { q: 'FoOd PaNtRy' }],
  ['very common term', { q: 'volunteers' }],
  ['location', { q: 'Riverside Park' }],
  ['organizer name', { q: 'ORGANIZER_NAME' }],
  ['two characters', { q: 'ch' }],
  ['unicode', { q: 'Café' }],
  ['unicode, lowered', { q: 'café solidario' }],
  ['percent literal', { q: '100%' }],
  ['underscore literal', { q: 'a_b' }],
  ['backslash literal', { q: 'back\\slash' }],
  ['no results', { q: 'zzzz-no-such-event-zzzz' }],
  ['long natural language', { q: 'weekend beach cleanup with animals for high school students' }],
  ['search + category', { q: 'volunteers', category: 'Food Pantry' }],
  ['search + open only', { q: 'food pantry', openOnly: 'true' }],
  ['search, deep page', { q: 'volunteers' }, { limit: 60, offset: 600 }],
  ['search + semantic candidates', { q: 'chess club' }, PAGE, 'semantic'],
];

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

async function runArm(textForm, filters, page) {
  const { sql, params } = buildEventListStatement({
    filters, userId: 'u-1', db: PG, paginated: true,
    limit: page.limit, offset: page.offset, hardCap: 500, textForm,
  });
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
  return { rows, p50: at(0.5), p95: at(0.95), p99: at(0.99), text, values };
}

/** The plan, reduced to what a reader of the table needs. */
async function planOf(text, values) {
  const rows = await q(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${text}`, values);
  const root = rows[0]['QUERY PLAN'][0];
  const seq = [];
  const idx = new Set();
  let scanned = 0;
  (function walk(node) {
    const type = node['Node Type'] || '';
    if (/Seq Scan/.test(type)) seq.push(`${node['Relation Name']}(${node['Actual Rows']})`);
    if (node['Index Name']) idx.add(node['Index Name']);
    if (/Scan/.test(type)) scanned += Number(node['Actual Rows'] || 0) * Number(node['Actual Loops'] || 1);
    for (const child of node.Plans || []) walk(child);
  })(root.Plan);
  return {
    exec: root['Execution Time'],
    buffers: root.Plan['Shared Hit Blocks'] + root.Plan['Shared Read Blocks'],
    seq: seq.length ? seq.join(' ') : 'none',
    indexes: [...idx].join(',') || 'none',
    scanned,
  };
}

/** A comparable projection: order matters, values matter, the total matters. */
const shapeOf = (rows) => rows.map((r) => [
  r.id, r.status, r.spots_remaining, r.min_start, r.max_end,
  r.total_spots, Number(r.total_hours), r.accepted, Number(r.total_count),
]);

async function dropTrigramIndexes() {
  for (const [name] of TRIGRAM_INDEXES) await q(`DROP INDEX IF EXISTS ${name}`);
  await q('ANALYZE');
}

async function createTrigramIndexes() {
  const [{ schema }] = await q(`
    SELECT n.nspname AS schema FROM pg_extension e
      JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_trgm'
  `);
  for (const [name, table, column] of TRIGRAM_INDEXES) {
    await q(`CREATE INDEX IF NOT EXISTS ${name} ON ${table} USING gin (lower(${column}) ${schema}.gin_trgm_ops)`);
  }
  await q('ANALYZE');
}

async function indexSizes() {
  return q(`
    SELECT relname AS name, pg_relation_size(oid) AS bytes
      FROM pg_class
     WHERE relname = ANY($1) OR relname IN ('events', 'users')
     ORDER BY bytes DESC
  `, [TRIGRAM_INDEXES.map(([n]) => n)]);
}

/**
 * What the indexes cost writes.
 *
 * An index that halves a read and doubles a write is a decision, not a win, so
 * the number goes in the report next to the read numbers rather than being left
 * for somebody to wonder about. Events are written by organizers a few times a
 * day; the ratio matters more than the milliseconds.
 */
async function writeCost() {
  const insert = async () => {
    const t0 = process.hrtime.bigint();
    await q(`
      INSERT INTO events (id, title, description, category, location, application_deadline,
                          organizer_id, status, created_at)
      SELECT 'wc-'||g, 'Write Cost Probe '||g, 'A description with enough words to make trigrams '||g,
             'Other', 'Somewhere '||g, $1, 'u-1', 'open', $1
      FROM generate_series(1, 2000) g
    `, [iso(5)]);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    await q("DELETE FROM events WHERE id LIKE 'wc-%'");
    return ms;
  };
  const update = async () => {
    await q(`
      INSERT INTO events (id, title, description, category, location, application_deadline,
                          organizer_id, status, created_at)
      SELECT 'wc-'||g, 'Write Cost Probe '||g, 'A description with enough words to make trigrams '||g,
             'Other', 'Somewhere '||g, $1, 'u-1', 'open', $1
      FROM generate_series(1, 2000) g
    `, [iso(5)]);
    const t0 = process.hrtime.bigint();
    await q("UPDATE events SET title = title || ' revised' WHERE id LIKE 'wc-%'");
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    await q("DELETE FROM events WHERE id LIKE 'wc-%'");
    return ms;
  };

  await createTrigramIndexes();
  const withIdx = { insert: await insert(), update: await update() };
  await dropTrigramIndexes();
  const without = { insert: await insert(), update: await update() };
  await createTrigramIndexes();
  return { withIdx, without };
}

async function main() {
  await refuseNonEmpty();

  const db = new PostgresDatabase({ connectionString: URL_, max: 4, translate: translatePlaceholders });
  await applyPostgresSchema(db);
  await runPostgresMigrations(db);
  await db.close();

  const [{ trgm }] = await q("SELECT to_regprocedure('public.show_trgm(text)') IS NOT NULL AS trgm");
  if (!trgm) {
    const [row] = await q(`
      SELECT n.nspname AS schema FROM pg_extension e
        JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_trgm'
    `);
    if (!row) {
      console.error('REFUSING: pg_trgm is not installed, so there is nothing to measure.');
      process.exit(1);
    }
  }

  const report = { scales: [] };
  let differences = 0;

  for (const scale of SCALES) {
    const counts = await seed(scale);
    await createTrigramIndexes();

    /* A real organizer's name from the corpus, so the organizer branch has
       something to find. */
    const [{ name: organizer }] = await q("SELECT name FROM users WHERE id = 'u-11'");

    console.log(`\n================ ${counts.events} events / ${counts.slots} slots / `
      + `${counts.applications} applications / ${counts.users} users ================`);
    console.log('  case                          matched    arm          p50      p95      p99   rows scanned  indexes');

    const scaleReport = { scale: counts.events, counts, cases: [] };

    for (const [label, rawFilters, page = PAGE, mode = null] of QUERIES) {
      const filters = { ...rawFilters };
      if (filters.q === 'ORGANIZER_NAME') filters.q = organizer;

      const parsed = parseEventFilters(filters);
      if (!parsed.ok) { console.log(`  ${label}: FILTER REJECTED ${parsed.error}`); continue; }
      const value = parsed.value;

      if (mode === 'semantic') {
        const ids = (await q("SELECT id FROM events WHERE status = 'open' ORDER BY id LIMIT 60")).map((r) => r.id);
        value.semanticIds = ids;
      }

      const arms = [];
      let baseline = null;
      for (const [armName, textForm, needsIndexes] of [
        ['position', 'position', false],
        ...(flag('union') ? [['union', 'union', true]] : []),
        ['indexed', null, true],
        ...(flag('drop-indexes') ? [['indexed(no idx)', null, false]] : []),
      ]) {
        if (needsIndexes) await createTrigramIndexes(); else if (armName !== 'position') await dropTrigramIndexes();
        const result = await runArm(textForm, value, page);
        const plan = await planOf(result.text, result.values);

        if (!baseline) baseline = result;
        else if (JSON.stringify(shapeOf(baseline.rows)) !== JSON.stringify(shapeOf(result.rows))) {
          differences++;
          console.log(`  !! DIFFERENCE  ${label} / ${armName}: `
            + `${baseline.rows.length} rows vs ${result.rows.length}`);
          const A = shapeOf(baseline.rows); const B = shapeOf(result.rows);
          for (let i = 0; i < Math.max(A.length, B.length); i++) {
            if (JSON.stringify(A[i]) !== JSON.stringify(B[i])) {
              console.log(`     row ${i}: ${JSON.stringify(A[i])}  vs  ${JSON.stringify(B[i])}`);
              break;
            }
          }
        }

        const matched = result.rows.length ? Number(result.rows[0].total_count) : 0;
        console.log(
          `  ${label.padEnd(30)}${String(matched).padStart(7)}    ${armName.padEnd(14)}`
          + `${result.p50.toFixed(1).padStart(6)} ${result.p95.toFixed(1).padStart(8)} `
          + `${result.p99.toFixed(1).padStart(8)}  ${String(plan.scanned).padStart(9)}   `
          + `${plan.seq !== 'none' ? `SEQ ${plan.seq}` : plan.indexes}`
        );
        arms.push({ arm: armName, matched, ...plan, p50: result.p50, p95: result.p95, p99: result.p99 });
      }
      scaleReport.cases.push({ label, arms });
      await createTrigramIndexes();
    }

    scaleReport.indexSizes = await indexSizes();
    console.log('\n  index sizes:');
    for (const row of scaleReport.indexSizes) {
      console.log(`    ${row.name.padEnd(30)} ${(Number(row.bytes) / 1048576).toFixed(1)} MB`);
    }

    if (flag('write-cost')) {
      scaleReport.writeCost = await writeCost();
      const { withIdx, without } = scaleReport.writeCost;
      console.log('\n  write cost (2,000 rows):');
      console.log(`    INSERT  ${without.insert.toFixed(0)} ms without  ->  ${withIdx.insert.toFixed(0)} ms with`
        + `  (${(withIdx.insert / without.insert).toFixed(2)}x)`);
      console.log(`    UPDATE  ${without.update.toFixed(0)} ms without  ->  ${withIdx.update.toFixed(0)} ms with`
        + `  (${(withIdx.update / without.update).toFixed(2)}x)`);
    }

    report.scales.push(scaleReport);
  }

  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));

  console.log(`\n${differences === 0
    ? 'DIFFERENTIAL: every arm returned identical rows for every query.'
    : `DIFFERENTIAL: ${differences} DIFFERENCE(S) — the rewrite is not equivalent.`}`);
  if (differences) process.exitCode = 1;
}

try {
  await main();
} finally {
  await pool.end();
}
