# PostgreSQL scale measurements

Measured 2026-08-19 with `bin/scale-probe.mjs` against PostgreSQL 17.9 on a
throwaway local database. Reproduce with:

```bash
createdb wv_scale
SCALE_DB_URL=postgres://you@localhost:5432/wv_scale node bin/scale-probe.mjs 20000 10000
dropdb wv_scale
```

Every number below is the p95 of 25 runs after a warm-up, with `EXPLAIN
(ANALYZE, BUFFERS)` behind it. Local disk, warm cache, no network — so these
are a **lower bound**. Supabase adds round-trip latency per query on top.

## The headline

Everything the pilot will do is comfortably fast. One query has a scaling limit
worth knowing about, and it is not the one that looks slow.

| rows (users / events / slots / applications) | default browse p95 |
|---|---|
| 2,000 / 1,000 / 2,000 / 8,000 | **11.5 ms** |
| 20,000 / 10,000 / 20,000 / 80,000 | **112.9 ms** |
| 100,000 / 50,000 / 100,000 / 400,000 | **571.6 ms** |

Roughly linear in event count, crossing 100 ms at about **10,000 events**. The
pilot is nowhere near that, so this is a documented ceiling rather than a
launch blocker.

## Why measuring this correctly is not obvious

The natural way to benchmark the events list — `ORDER BY application_deadline`
with a `status` filter — is **not the query the application runs**, and it
understates the real cost by about 4.5× at 50,000 events (126 ms vs 572 ms).

The default sort is `soonest`, and in `server/eventQuery.js` that maps to
`agg.min_start ASC` — an aggregate over `slots`, computed in a CTE that has **no
WHERE clause of its own**:

```sql
agg AS (
  SELECT e.id AS event_id, MIN(s.start_datetime) AS min_start, …,
         (SELECT COUNT(*) FROM applications a2
           WHERE a2.event_id = e.id AND a2.status = 'accepted') AS accepted
  FROM events e LEFT JOIN slots s ON s.event_id = e.id
  GROUP BY e.id
)
```

So every event and every slot is folded, and one correlated subquery runs per
event, before the outer `LIMIT 50` can discard almost all of it. `bin/scale-probe.mjs`
measures both shapes side by side so this stays visible.

## No index is warranted

At 10,000 events the plan for the real query contains **no sequential scans** —
it is already using indexes. The cost is the unfiltered fold itself, and an
index cannot make a full aggregate cheaper. Adding one here would be
speculative, would slow every write to `events` and `slots`, and would not move
the number.

The sequential scans that *do* appear elsewhere (`users` for the directory,
`applications` for the admin status rollup) are the planner correctly choosing a
scan over an index for a query that touches most of the table anyway. They are
also all under 30 ms at 50× pilot scale.

**If this ever needs fixing**, the fix is structural, not an index: restrict
`agg` to the filtered event set so the fold happens over the page rather than
the table. That is a real change to the listing query with pagination and
sorting correctness at stake on two engines, and it should be done deliberately
with the existing `eventQuery` tests, not reflexively.

## Everything else, at 50× pilot scale

| query | p95 | plan |
|---|---|---|
| spots remaining per slot (capacity fold) | 2.0 ms | no seq scans |
| my applications | 0.5 ms | no seq scans |
| unread notification count | 0.3 ms | no seq scans |
| event roster (accepted volunteers) | 0.4 ms | no seq scans |
| admin stats — status rollup | 25.0 ms | seq scan, appropriate |
| user directory page | 29.8 ms | seq scan, appropriate |
| events list — text search (`ILIKE`) | 41.6 ms | seq scan |

The text search is `ILIKE '%term%'` on title and description. A leading wildcard
cannot use a btree index; if it ever matters, the answer is a trigram or
full-text index, not an ordinary one. At 41 ms over 50,000 events it does not
matter yet.

## What this does not cover

- **Network latency.** All of the above is loopback. Against Supabase, add the
  round trip per query.
- **Write throughput.** This measures reads. The concurrency and capacity
  behaviour under simultaneous writes is covered by
  `server/capacity.postgresConcurrency.test.js` and
  `server/application.postgresConcurrency.test.js`.
- **Pool behaviour under saturation.** Covered by `server/db.poolExhaustion.test.js`.
- **Real data distribution.** The synthetic set spreads applications evenly
  across events. A real pilot will have a few popular events with far more
  applications than the rest, which the per-event index paths handle but the
  aggregate fold does not care about either way.
