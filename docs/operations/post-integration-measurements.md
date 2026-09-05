# Performance after the branch integration — measured, 2026-09-05

Every number in the perf-scaling branch's documentation was measured before
trunk gained migrations 062–066 and the organization work. Those figures are
**stale and are not repeated here**. This is a fresh measurement of the merged
tree.

**Environment.** Local PostgreSQL 17.9, macOS, throwaway databases created and
dropped for the run. Production was not touched. A local laptop is not a
deployment host: treat the SHAPE of these results — what scans, what is
index-backed, what grows with row count — as the finding, and the absolute
milliseconds as indicative only.

**Tools.** `bin/scale-probe.mjs` (read paths at scale, with plans) and
`bin/events-query-probe.mjs` (the browse query built from `eventQuery.js`'s own
fragments, compared against candidate rewrites). Both refuse a Supabase host and
refuse any database that already holds people.

---

## Read paths at 20,000 users / 10,000 events

| Query | p50 | p95 | Sequential scans |
|---|---:|---:|---|
| unread notification count | 0.1 ms | 0.2 ms | none |
| my applications | 0.3 ms | 0.5 ms | none |
| event roster (accepted volunteers) | 0.5 ms | 1.1 ms | none |
| spots remaining per slot (capacity fold) | 1.8 ms | 2.2 ms | none |
| events list — text search | 8.1 ms | 16.1 ms | events (111) |
| user directory page | 13.7 ms | 19.2 ms | users (20,000) |
| admin stats — application status rollup | 16.9 ms | 38.9 ms | applications (80,000) |
| **events list — default browse page (50)** | **17.9 ms** | **24.4 ms** | events (10,000) |
| events list — the OLD agg-CTE shape | 95.6 ms | 150.6 ms | slots (20,000), events (10,000) |

The last row is the baseline the probe keeps deliberately: the pre-066 query
shape, where `soonest` sorted by `MIN(start_datetime)` computed per row, so
every event and slot had to be folded before the outer `LIMIT 50` could discard
any of them. **No index could serve it, because the value did not exist to
index.**

Migration 066 stores it as `events.first_slot_start` and indexes it, which is
what turns that sort into a range scan. Measured difference on the default
browse page: **95.6 ms → 17.9 ms at p50**, on the same data, in the same run.

Verified before believing it: both probe databases carry the
`first_slot_start` column and both `idx_events_first_slot_start` and
`idx_events_browse_order`, so this is the optimised schema and not an
accidental measurement of the old one.

---

## The browse query's filter and sort variants

`bin/events-query-probe.mjs` builds the real query and two candidate rewrites,
runs all three against identical data, and compares the ROWS before comparing
the clocks.

**At pilot scale — 100 events, 159 slots, 636 applications:** every variant of
every filter and sort answers in **1–6 ms p50**. Nothing on this page is a
concern at the size this platform is about to run at.

**At 10,000 events:** the filtered and sorted variants sit at **93–179 ms p50**
and still scan `slots`. The default sort is index-backed; the *filters* are not,
because they fold slot aggregates to decide `spots_remaining` and `min hours`.

The probe's own conclusion is the useful one, and it is negative: across
fourteen filter and sort cases, **no candidate rewrite is uniformly faster**.
Some are better on text search and category (31 ms vs 137 ms), some are worse on
date range (228 ms vs 176 ms). There is no rewrite to adopt on this evidence.

The differential is clean — *"every variant returned identical rows for every
case"* — which is the part worth keeping. A faster query that answers
differently is a defect with a good stopwatch.

---

## What this does and does not license saying

**Supported by measurement**

- The default browse sort is index-backed and no longer linear in event count.
- Every non-events read path is comfortably fast at 20,000 users.
- At pilot scale the whole browse surface is single-digit milliseconds.

**NOT supported, and not claimed**

- That filtered browse is fixed at scale. It is not. It costs 90–180 ms p50 at
  10,000 events, and the honest position is that no proposed rewrite earns its
  place yet.
- That any of this reflects production. Different host, different data
  distribution, a connection pooler in the path, and network latency the
  measurement excludes entirely.
- Anything about throughput or concurrency. `bin/load-test.mjs` exists and was
  not run here; the numbers above are latency for a single caller.

**When to re-measure:** before launch against production-shaped data, and after
any migration that changes `events`, `slots` or `applications`.
