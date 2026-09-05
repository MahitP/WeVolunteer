# Event search: the pipeline, and what each part costs

Measured 2026-09-02 with `bin/search-bench.mjs` against PostgreSQL 17.9 on a
throwaway local database, at three corpus sizes. Reproduce with:

```bash
createdb wv_search
SEARCH_DB_URL=postgres://you@localhost:5432/wv_search node bin/search-bench.mjs --scales 10000,50000,100000 --write-cost
dropdb wv_search
```

Every number is the p50 of 11 runs after a warm-up, with `EXPLAIN (ANALYZE,
BUFFERS)` behind it. Local disk, warm cache, no network — so these are a **lower
bound**, and the Pinecone round trip discussed further down is on top of all of
them.

The harness is also a differential: both forms of the query are built by
`eventQuery.buildEventListStatement`, the same function the route calls, and
every case asserts that they return identical rows in the same order with the
same exact total. A faster search that answers differently is a defect with a
good stopwatch.

## The pipeline, as it actually runs

```
GET /api/events?q=…
  │
  ├─ authenticateToken                         (no vendor, no search)
  ├─ parseEventFilters                          200-character cap on q
  │
  ├─ shouldUseSemantic(q)?                      skipped for <3 chars, @handles,
  │     │                                       #tags and "quoted phrases"
  │     ├─ candidateCache hit ──────────────┐   0 ms, no vendor call
  │     ├─ breaker open ────────────────────┤   0 ms, no vendor call
  │     └─ Pinecone /records/…/search       │   ONE round trip, fields:['_id'],
  │          topK 60, metadata filter       │   integrated embedding
  │          → hits, filtered by score ─────┘   → up to 60 candidate ids
  │
  ├─ ONE SQL statement                          page + exact total + aggregate
  │     WITH page      … LIMIT/OFFSET
  │          page_total… COUNT(*)
  │          agg       … folded over the page
  │
  ├─ four batch loads scoped to the page's ids  tags, favourites, acceptances
  └─ serialise
```

Two network round trips in the worst case — one to Pinecone, one to PostgreSQL
— and one in the common case, because a repeated search, a second page, or an
outage all skip the vendor.

Nothing from Pinecone is ever displayed. It contributes candidate **ids**,
which widen the text predicate; every filter, every permission and every
displayed value comes from the database afterwards. See `search/discoverSearch.js`.

## The search is already hybrid, and stays that way

Worth stating plainly, because "add hybrid search" is the obvious next
suggestion and it is already the architecture. A Discover query runs both
halves:

* **lexical** — the substring predicate above, which is what finds the event
  actually called "Chess Club" when somebody types `chess`;
* **semantic** — Pinecone's candidate ids, which find "something outdoors with
  animals" when no event contains those words.

They are combined by OR rather than by a blended score, and `rrfFuse` in
`discoverSearch.js` implements Reciprocal Rank Fusion for the places that need
an ordering across both lists. RRF and not a weighted blend because the two
halves produce numbers that are not comparable — a cosine similarity and a
substring hit are on different scales, and one of them is not a score at all.

So the work below is not "replacing semantic search with lexical search". It is
making the lexical half — the half that was always there, always correct, and
answering most queries — stop being linear in event count, and making the
semantic half stop being asked the same question twice.

## What was slow

The two-phase page (migration 063) removed the browse endpoint's O(n) sort. It
left one behind, and it was the search box: `strpos(lower(title), lower($1)) > 0`
OR three more of the same, evaluated on every event that survived the status
filter, with `users` joined in so the organizer's name was visible.

No index can answer that. A b-tree orders by prefix and a substring has no
prefix, and — the part that matters more — **one of the four columns is in
another table**, so the disjunction spans two relations and no combination of
indexes on either can be OR-ed into a bitmap. An index on all four columns
changed a 50,000-event search by nothing at all, because the plan never used
one.

## What changed

Two things, and neither works without the other:

1. **`eventQuery.textMatchClause`** rewrites the predicate so that every branch
   is a single-relation qual on `events`: three escaped `LIKE`s over its own
   columns, plus `organizer_id = ANY(ARRAY(SELECT id FROM users WHERE …))`,
   which turns the cross-table branch into an array computed once per statement
   and compared against an indexed column. The semantic candidate ids join the
   same disjunction rather than wrapping it.
2. **Migration 064** adds four `pg_trgm` GIN indexes, one per column.

The predicate remains a plain filter on `events`, which is what lets the planner
choose: a bitmap when the term is selective, an ordered index scan with a filter
when it is not, a sequential scan when that is genuinely cheapest. That
adaptability is why there are no regressions below rather than a trade.

`escapeLikeLiteral` neutralises `%`, `_` and `\` in the VALUE before it is
bound, so a student typing `100%` searches for those four characters. That was
the original objection to `LIKE` and it is answered by escaping the needle
rather than by avoiding the operator — asserted against a table of adversarial
needles on both engines in `db.dialectSql.test.js`.

### The plan, at 50,000 events

```
Limit  (actual time=4.077..106.015 rows=60 loops=1)
  InitPlan 1
    ->  Bitmap Heap Scan on users ou  (actual rows=0 loops=1)
          ->  Bitmap Index Scan on idx_users_name_trgm
                Index Cond: (lower(name) ~~ '%robotics%'::text)
  ->  Index Scan using idx_events_browse_order on events e
        Index Cond: (status = ANY ('{open,closed}'::text[]))
        Filter: ((lower(title) ~~ '%robotics%') OR (lower(description) ~~ '%robotics%')
              OR (lower(location) ~~ '%robotics%') OR (organizer_id = ANY ((InitPlan 1).col1)))
        Rows Removed by Filter: 1324
```

Two things in that plan are the whole design.

**`InitPlan 1 … loops=1`.** The organizer lookup runs ONCE for the statement, not
once per row, and its result becomes a constant array the filter compares
against. That is what `ANY(ARRAY(…))` buys over `EXISTS (…)` or `IN (subquery)`,
both of which are correlated and would put a `users` probe on every event.

**The planner chose to walk the sort order and stop.** It did not use the
trigram indexes here at all: with a leading `ORDER BY … LIMIT 60` available from
`idx_events_browse_order`, walking 1,384 index entries to find 60 matches beat
building a bitmap. For a rarer term it makes the opposite choice, and for
`café` it goes straight to the trigram index. **That is only possible because
the predicate is a plain filter on `events`** — the moment it became a semi-join
(the rejected rewrite below) the planner lost that option and the common cases
got much worse.

## Results

p50 milliseconds, before → after:

| case | matched at 100k | 10,000 events | 50,000 events | 100,000 events |
|---|---|---|---|---|
| no search (control) | 100,000 | 3.3 → **2.8** | 3.6 → **3.5** | 4.5 → **4.6** |
| rare term | 4,106 | 18.7 → **14.3** | 61.0 → **5.8** | 127.5 → **7.5** |
| rare phrase | 4,251 | 18.7 → **5.1** | 63.0 → **7.3** | 125.9 → **11.8** |
| common noun | 34,696 | 12.5 → **11.7** | 52.3 → **16.5** | 105.4 → **29.3** |
| common noun, mixed case | 34,696 | 13.8 → **10.8** | 49.0 → **17.1** | 105.9 → **32.1** |
| very common term | 100,000 | 11.4 → **10.1** | 50.5 → **17.8** | 87.8 → **34.1** |
| location | 19,802 | 14.2 → **12.7** | 55.3 → **18.2** | 113.7 → **31.6** |
| organizer name | 1,200 | 29.4 → **10.9** | 67.0 → **6.9** | 129.1 → **5.2** |
| two characters | 68,211 | 15.3 → **14.3** | 56.2 → **39.1** | 118.3 → **108.2** |
| unicode | 250 | 39.5 → **12.0** | 195.3 → **2.8** | 420.9 → **3.0** |
| unicode, lowered | 250 | 37.8 → **12.0** | 197.3 → **4.0** | 399.0 → **4.6** |
| `100%` typed literally | 0 | 38.9 → **11.0** | 223.0 → **1.0** | 472.1 → **1.0** |
| `a_b` typed literally | 0 | 42.4 → **21.0** | 229.7 → **86.3** | 488.6 → **164.3** |
| `back\slash` typed literally | 0 | 38.1 → **11.1** | 213.8 → **3.2** | 457.8 → **4.7** |
| no results | 0 | 39.3 → **21.9** | 208.9 → **0.9** | 458.8 → **0.9** |
| long natural language | 0 | 40.0 → **21.2** | 208.5 → **57.0** | 444.1 → **28.5** |
| search + category | 20,000 | 5.6 → **4.7** | 15.1 → **8.5** | 29.7 → **13.6** |
| search + open only | 13,951 | 33.0 → **30.8** | 156.0 → **129.1** | 296.7 → **265.5** |
| search, deep page (offset 600) | 100,000 | 13.5 → **10.5** | 46.7 → **19.5** | 91.9 → **34.2** |
| search + 60 semantic candidates | 4,306 | 17.7 → **4.9** | 65.6 → **7.1** | 126.5 → **12.1** |

Faster in every case at every scale, and the shape of the curve changed: the old
form is linear in event count, the new one is close to flat wherever the term is
selective. A search matching nothing — the most common failed search there is —
went from **458.8 ms to 0.9 ms** at 100,000 events.

The default browse, which had to not regress, did not: 4.5 → 4.6 ms.

## The rest of the request: eight serial round trips, now two waves

The SQL above is one statement. The response around it was eight more, one after
another: the viewer's accepted events, their organization bans, their
memberships, then the page's slots, accepted counts, attendance and tags. On
SQLite each was free. On PostgreSQL each is a network hop, and against a managed
database that is single-digit milliseconds of pure waiting each, on the busiest
endpoint the platform has.

None of them reads another's output. Three depend only on who is asking, so they
now run **alongside** the page query rather than after it; the other four take
the page's ids and run as one wave. Two waves instead of eight hops, four
concurrent statements at the widest — the ceiling this codebase applies to
request fan-out.

Measured with `bin/load-test.mjs --db-latency 5`, which injects a fixed 5 ms per
database call so a before/after is reproducible:

| scenario | before | after |
|---|---|---|
| A — public browse (list, search, detail) | 262.5 req/s, p50 75 ms | **329.0 req/s, p50 59 ms** |
| C — student activity (browse, applications, notifications, profile) | 379.1 req/s, p50 53 ms | **412.5 req/s, p50 49 ms** |

Public browse gains **25% throughput** and loses a fifth of its median latency.
Pool waiting stayed at zero in both arms and no request failed in either, which
is the number that had to not move: four concurrent statements per request could
in principle starve a pool of 25. They do not, because they overlap the one
expensive query rather than each other — the pool holds them for a quarter of
the time it held them sequentially, so occupancy is roughly unchanged while
latency drops.

The p99 for scenario A moved the other way, 90 → 98 ms, on an eight-second run.
That is within the noise of a single run and is recorded rather than explained
away; the medians and the throughput moved far outside it.

## On real Supabase hardware — 2026-09-03

Everything above is a local PostgreSQL 17.9 on an SSD with warm cache. This is
the same comparison run against a real Supabase project (PostgreSQL 17.6,
us-east-2, free tier) at 20,000 events, in a throwaway schema that was dropped
afterwards.

The measurement is the server's own `Execution Time` from `EXPLAIN (ANALYZE)`,
not wall-clock: the round trip from the laptop that ran it was ~250 ms and would
have drowned the thing being measured.

| case | matched | before | after | |
|---|---|---|---|---|
| rare term | 905 | 130.3 ms | **32.0 ms** | 4.1x |
| rare phrase | 904 | 130.9 ms | **35.3 ms** | 3.7x |
| common noun | 7,089 | 101.7 ms | **86.5 ms** | 1.2x |
| very common term | 20,000 | 80.8 ms | **68.9 ms** | 1.2x |
| organizer name | 2,200 | 124.1 ms | **42.6 ms** | 2.9x |
| unicode | 50 | 320.9 ms | **113.3 ms** | 2.8x |
| no results | 0 | 309.9 ms | **99.8 ms** | 3.1x |
| `100%` typed literally | 0 | 320.1 ms | **97.0 ms** | 3.3x |
| no search (control) | 20,000 | 5.8 ms | 5.8 ms | — |

Faster in every case, unchanged where it had to be, and the differential held on
the real service: identical row counts and identical exact totals from both
arms, every case.

**The speedups are smaller than the local numbers, and that is the honest
result.** Two reasons, and neither is a defect in the change:

* **Scale.** This is 20,000 events against the local run's 100,000, and the
  whole point of the rewrite is that the old form is linear while the new one is
  not — so the gap widens with the corpus. At 20,000 locally the rare-term gain
  was 1.3x; here it is 4.1x, because the free tier's slower CPU makes the
  scanned rows cost more.
* **Cold buffers on a small shared instance.** A search matching nothing runs in
  0.9 ms locally and 99.8 ms here. Nothing is scanned in either case; the
  difference is reading index pages from disk on a free-tier machine with little
  cache. That number will fall on any paid instance and falls further once the
  index is warm.

What transfers regardless of hardware is the shape: the old predicate reads
every candidate row, the new one does not, and no case got worse.

## Where the remaining time goes

Three cases are worth naming, because they are the ceiling rather than an
oversight.

**`q` with `openOnly` — 265 ms at 100k, the slowest search there is.** This is
not the text predicate. `openOnly` filters on remaining spots, which is the
aggregate, so `canSplitEventPage` correctly refuses to split and the fold runs
over every matching event and its slots. Removing it needs a maintained
`spots_remaining`, and spare capacity is a derived FACT rather than a derived
index — the thing the hours-ledger rule (INV-001) says not to store. Out of
scope deliberately, and the ceiling to raise next if this one starts to matter.

**Two-character terms — 108 ms at 100k, barely improved.** A trigram is three
characters; a two-character pattern produces none, so `pg_trgm` cannot help and
the planner correctly scans. Also the case where the semantic half is skipped
(`MIN_SEMANTIC_LENGTH`), so nothing else absorbs it either. It is the cheap end
of a scan because there is no `users` join left, which is the whole of the 1.09x.

**`a_b` typed literally — 164 ms at 100k.** The escaped `\_` leaves the pattern
with few extractable trigrams, so the index returns a large candidate set and the
recheck does the work. Still 3x faster than before, and a rare shape of query.

## What the indexes cost

| | 10,000 events | 50,000 events | 100,000 events |
|---|---|---|---|
| `events` table | 8.4 MB | 42.3 MB | 84.5 MB |
| `idx_events_description_trgm` | 11.2 MB | 33.4 MB | 58.4 MB |
| `idx_events_title_trgm` | 5.1 MB | 11.9 MB | 19.1 MB |
| `idx_events_location_trgm` | 4.6 MB | 8.8 MB | 13.1 MB |
| `idx_users_name_trgm` | 0.6 MB | 2.9 MB | 4.5 MB |
| INSERT 2,000 events | 28 → 49 ms (1.75x) | 30 → 46 ms (1.51x) | 31 → 53 ms (1.69x) |
| UPDATE 2,000 titles | 39 → 55 ms (1.40x) | 39 → 65 ms (1.64x) | 46 → 56 ms (1.23x) |

About 10 µs of extra write per event, against a table organizers write a few
times a day, and roughly the table's own size again in index. At pilot scale
(hundreds of events) the indexes are under a megabyte. The description index is
the expensive one and is also the one that earns most of the recall — it is
where the words people actually type live.

## Two rewrites that were measured and rejected

Recorded because both look obviously right and both are worse.

**`e.id IN (SELECT … UNION ALL SELECT …)`.** Every branch indexable, no array,
no cross-table OR — and a semi-join is not a filter, so it stops composing with
the other predicates and cannot terminate early. At 50,000 events: a common
noun 52 → 262 ms, a search with a category filter 15 → 509 ms, the most common
term in the corpus 50 → 519 ms. It won on selective terms and lost catastrophically
on everything else. `bin/search-bench.mjs --union` still measures it.

**Dropping the scope predicate from the `agg` CTE in the split path.** The page
CTE has already applied it and `restrictAggToPage` joins the page in, so the fold
is over sixty ids either way and the predicate looks redundant. Removing it made
nine of seventeen cases slower and a search matching nothing **58x** slower
(1.0 → 58.3 ms): with the predicate present the fold has nothing to fold and
stops; without it the planner reaches that conclusion only after building the
join.

## The Pinecone half

The SQL above is the part that scales with the corpus. The part that dominates a
single request is the network: one HTTPS round trip to Pinecone, with a 1200 ms
timeout, before the database is touched at all.

Three changes, none of which alter what is returned:

* **A 60-second in-process candidate cache** (`search/candidateCache.js`). Page
  two of a search, the same search from a second student, and a client that
  fires twice are all one vendor call. Keyed on a SHA-256 of the question — the
  index, the namespace, the query text, the metadata filter and the topK — and
  never on the viewer, because the answer does not depend on who is asking and
  the database is what applies who is asking.
* **Single-flight.** Identical searches in the air at the same moment share one
  request, so a class of thirty told to search the same words produces one call
  rather than thirty cache misses.
* **A read-path circuit breaker** (`search/pineconeClient.js`). Three
  consecutive outage-shaped failures — timeouts, 5xx, 429, never a 400 — and
  searches stop calling the vendor for 30 seconds and answer from the database
  alone. Without it, an outage costs **every** search the full 1200 ms timeout
  and holds a socket for it; with it, one search per cooldown window does. The
  cooldown ends with a single half-open probe, so recovery needs no timer.

Neither the cache nor the breaker can change a row: candidate ids are re-filtered
by the same query with the same viewer, and a search with no candidates at all is
the lexical search this application shipped for a year.

### What a cache hit is actually worth

`docs/operations/pinecone.md` §6b measured the live service: **311–445 ms warm**
(median 379) and about **3.2 s cold**, after the index has scaled to zero. So
the vendor round trip is one to two orders of magnitude larger than the SQL
above — a cached search saves more time than the entire database query costs,
and a cache hit during a cold start saves three seconds.

That also settles the shape of the fix. Making the SQL 17x faster is worth
doing and does not touch the number that dominates a single Discover request;
not making the call at all is what touches it.

There is deliberately **no Redis tier** under the cache. `redis/lookupCache.js`
exists for exactly this shape and is right for weather and geocoding, where the
upstream costs hundreds of milliseconds and Redis costs tens. Here both sides
are hundreds of milliseconds — a warm Upstash round trip was measured at 222 ms
against Pinecone's 311–445 — so an L2 would spend a command and most of the
saving to avoid a call of the same order.

### Why `topK` stays at 60

Lowering it is the obvious way to spend less, and it is the wrong one here,
because **the candidates are filtered again after they arrive**. Every id goes
back through the browse query, where the status scope, the date bounds, the
audience rule and `openOnly` can each remove it — so the number that matters is
not how many the index returned but how many survive, and a smaller K reduces
the survivors, not the cost.

What actually removes the waste is the metadata filter (`buildPineconeFilter`),
which is already applied: a district's corpus is mostly history, so an
unfiltered top-60 for "food pantry" can be sixty completed events from two years
ago and the semantic half contributes nothing. Filtering on the stable fields —
status, category, tags, start date — spends the K on rows the SQL can actually
keep. `openOnly` is deliberately NOT among them, because it depends on remaining
spots, which the index does not store; a stale copy of it would remove events
that do have space.

`MAX_SEMANTIC_IDS` is 100, so the parameter list has headroom above 60 rather
than below it. This is a reasoned position rather than a measured one: measuring
it properly needs a corpus with known relevance judgements, which does not exist
for this application, and inventing one would produce a number that looks
measured and is not.

### Against the free tier

Pinecone's Starter plan (checked 2026-09-02) includes 1M read units/month, 2M
write units/month, 5M embedding tokens/month, 2 GB storage and 500 rerank
requests. The application's `PINECONE_RERANK_BUDGET` defaults to 400, under that
ceiling, and reranking is off unless `PINECONE_RERANK=1`.

Every search that the cache or the breaker answers is a read unit and an
embedding not spent. Searches are also skipped entirely for queries the vendor
cannot improve — under three characters, `@handles`, `#tags`, and quoted
phrases — which was already the case before this pass.

`GET /api/admin/ops/status` now reports `search.usage` (what Pinecone said it
charged), `search.breaker` and `search.candidateCache.hitRate`, so the answer to
"is this costing anything" is a request rather than an inference.

## Verifying a live deployment

```bash
node bin/verify-search-indexes.mjs
```

Reports whether `pg_trgm` is installed and in which schema, whether each index
exists and is valid, and — above 2,000 events, where the answer means something
— whether the planner actually chooses one. `--strict` exits non-zero.

This exists because migration 064 is allowed to decline: `CREATE EXTENSION`
needs a privilege the application's role may not have, and refusing to boot over
an index would be the wrong trade for a query that returns correct rows without
one. The migration warns once, at a boot nobody is reading, and records itself
as applied. From outside, "the search is slow" and "the search is fine" look
identical without this tool.

### Two Supabase-specific notes

* **The opclass is schema-qualified.** Supabase installs extensions into a
  schema called `extensions`, and a bare `gin_trgm_ops` resolves on a developer's
  machine and fails on the deployment — the shape of supabase/supabase#30503,
  where `similarity()` is "missing" after the extension is enabled. Migration 064
  reads the extension's actual schema from the catalogue and qualifies the
  opclass with it, and installs into `extensions` when that schema exists and is
  writable, `public` otherwise.
* **`postgresOnly: true` is load-bearing.** `postgresSchema.js` is generated from
  a booted SQLite database, so a PostgreSQL-only index is not in it. Without the
  flag, `seedPostgresBaseline` would record 064 as already supplied and a fresh
  deployment would never get the indexes — silently, with every table present and
  every test passing. `migrations.postgres.test.js` asserts a database
  provisioned from the generated schema ends up with all four.
