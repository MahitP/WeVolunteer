# Load testing

**Status:** implemented and run. Numbers below were measured on 2026-08-30.

`bin/load-test.mjs` drives the real server over HTTP against a throwaway
PostgreSQL database. It is the counterpart to
[`bin/scale-probe.mjs`](postgres-scale-measurements.md), which measures SQL and
nothing else.

---

## 1. Why both tools exist

`scale-probe.mjs` opens a connection pool and times the queries the application
would run. Everything it reports is true, and none of it involves Express, JWT
verification, bcrypt, capability checks, JSON serialisation, compression, the
rate limiters, or two requests happening at once. Those are most of what a
request actually costs.

They are complements, and the split is diagnostic: a regression here with **no**
matching regression in `scale-probe` is in the application layer rather than in
the database.

---

## 2. Running it

```bash
createdb wv_load
LOAD_DB_URL=postgres://you@localhost:5432/wv_load node bin/load-test.mjs
dropdb wv_load
```

| Option | Default | What it does |
|---|---|---|
| `--users N` | 2000 | synthetic accounts |
| `--events N` | 1000 | synthetic events (slots, applications and attendance derive from this) |
| `--duration N` | 5 | seconds per scenario |
| `--connections N` | 20 | concurrent connections |
| `--db-latency N` | 0 | milliseconds of artificial database round-trip latency (§5) |
| `--api-limit N` | 1000000 | the blanket API limiter's ceiling for the run |
| `--only A,C,F` | all | run a subset |
| `--json PATH` | — | write the raw results |
| `--label TEXT` | `unlabelled` | a name, printed and stored in the JSON |

### The one dependency it adds

`autocannon`, as a **devDependency**. It is a Node HTTP benchmarking library, so
the harness shares this repository's own seeding code and `PostgresDatabase`
adapter rather than reimplementing them, and it reports real latency percentiles.

`npm audit --omit=dev` reports **0 vulnerabilities**; `npm audit` reports three
moderate ones, all in `uuid` and reached only through autocannon.

On the production host that matters for one step of a deploy and not afterwards.
The runbook installs with `npm ci --include=dev` because the client build needs
Vite, then runs `npm prune --omit=dev` once the build is done — so autocannon is
present while the bundle is being built and gone before the service is
restarted. It is never loaded by the running server.

k6 is the better tool in the abstract and is the escalation path if this ever
needs to gate CI: it is a single Go binary with built-in thresholds. It cannot
import this repository's modules, which is why it is not what got built first.

### Safety

The tool refuses to run when any of these is true, and each refusal is a hard
exit rather than a warning:

- the connection string names a **Supabase** host
- `NODE_ENV=production`
- the target database already contains users other than `system-cli`

The child server is started with mail in mock mode, `TELEMETRY_ENABLED=false`,
and `PINECONE_API_KEY` / `RESEND_API_KEY` / `UPSTASH_*` / `BETTERSTACK_*` /
`SMTP_HOST` **deleted from its environment**, so an ambient key in a developer's
shell cannot be inherited into a load run. Nothing leaves the machine and no
metered third-party allowance is spent.

### Every scenario is preflighted

Each scenario issues its requests once and checks the status before measuring. A
load generator is very good at going fast when the server is saying no, and
"3,061 req/s at p50 0 ms, all of it 401" is what the first version of this
harness proudly reported. A preflight failure aborts that scenario instead of
publishing a number, because a published number gets believed.

---

## 3. Scenarios

| id | Scenario | What it exercises |
|---|---|---|
| A | public browse — list, search, sort | the events query and its aggregate CTE |
| B | authentication — sign in, fetch profile | bcrypt, which is CPU-bound by design |
| C | student — browse, applications, notifications, profile | the common session |
| C4 | `GET /api/certificates` for a student with 80 completed events | a list that grows with a volunteer's service record |
| C2 | `GET /api/applications?limit=20` | the paginated form |
| C3 | `GET /api/applications` | the legacy unpaginated form every current client uses |
| D | organizer — applications, events, notifications | write-path-adjacent reads |
| E | admin — stats, reports, appeals queue | the aggregate and moderation surfaces |
| E2 | `GET /api/admin/stats` alone | the consolidated whole-table aggregate |
| E3 | `GET /api/admin/appeals` alone | the batched conflict-of-interest check |
| F | concurrency — 40 simultaneous accepts on one capacity-1 slot | the capacity guard |
| G | notification fan-out — cancelling an event with 150 confirmed volunteers | work done per recipient inside one request |

**Scenario G is timed once, not driven by autocannon.** Cancelling an event is a
one-shot state change: the second request finds an event that is already
cancelled and does no work, so a throughput number would average one real
broadcast with hundreds of no-ops. It verifies the broadcast by counting the rows
written, and reports itself INCONCLUSIVE if none were — the first version counted
by notification kind, found zero because the kind is mapped from the event name,
and would have reported a broadcast that happened as one that had not.

**Scenario F is a correctness test, not a benchmark.** It fires forty concurrent
`PATCH /api/applications/:id` calls at forty applications on one seat and then
asks the database how many ended up accepted. An oversell fails the run
(exit 1). So does *zero* accepted — that means every accept was refused and the
race never happened, which an earlier version of this scenario reported as
"capacity held".

---

## 4. Results — loopback PostgreSQL

2,015 users / 1,002 events / 8,092 applications / 2,171 credited attendance rows
/ 120 open appeals, plus one student with an 80-event service history. 20
connections, 8 seconds per scenario, PostgreSQL 17 on the same machine.

**Before** is `main` at `a579b86`; **after** is this branch. Both runs used the
identical harness against the identical corpus, so the columns are comparable.

| id | scenario | before req/s | after req/s | before p50 | after p50 |
|---|---|---|---|---|---|
| A | public browse | 685.6 | 685.8 | 28 ms | 28 ms |
| B | authentication | 35.8 | 35.8 | 217 ms | 217 ms |
| C | student session | 983 | **1,658** | 20 ms | **11 ms** |
| C2 | applications, paginated | 408 | **1,821** | 48 ms | **10 ms** |
| C3 | applications, legacy | 405 | **1,270** | 49 ms | **15 ms** |
| C4 | certificates, 80-event history | 649 | **2,343** | 30 ms | **8 ms** |
| D | organizer | 806 | **1,657** | 23 ms | **7 ms** |
| E | admin mix | 196.5 | **638** | 18 ms | **2 ms** |
| E2 | admin stats | 236.6 | 247.4 | 16 ms | 16 ms |
| E3 | appeals queue | 90.9 | **1,501** | 43 ms | **2 ms** |

A and B are unchanged code and measure flat to within noise. That is the control
this table needs: it says the harness is not simply reporting a faster machine.

**`GET /api/admin/stats` is flat here, and that is the honest result.** Its change
was consolidating fourteen serial statements into five. A loopback round trip
costs about a tenth of a millisecond, so removing nine of them removes almost
nothing. §5 is the measurement that actually tests it.

Scenario F — 40 simultaneous accepts on a one-seat slot — accepted **exactly
one** on both branches, with 39 refusals. The capacity guard holds over HTTP, and
it held before this pass too; the scenario exists so that stays true.

---

## 5. Results — with 5 ms of database round-trip latency

`--db-latency 5` puts a delaying TCP proxy between the application and
PostgreSQL. It does not parse the protocol; it holds each chunk for half the
configured latency in each direction, so a statement costs 5 ms more than it did.
Only the application goes through it — seeding uses the direct connection.

This is the deployment that matters: production is a managed provider reached
over a network, not a database on the same machine. 5 ms is a plausible
same-region figure. 6 seconds per scenario.

| id | scenario | before req/s | after req/s | before p50 | after p50 | before p97.5 | after p97.5 |
|---|---|---|---|---|---|---|---|
| A | public browse | 116.7 | 116.7 | 167 ms | 165 ms | 206 ms | 210 ms |
| C | student session | 170 | 173 | 130 ms | **93 ms** | 181 ms | 189 ms |
| C2 | applications, paginated | 146 | **160** | 133 ms | **122 ms** | 160 ms | 133 ms |
| C4 | certificates, 80-event history | **21.2** | **297** | **921 ms** | **66 ms** | 1,098 ms | 74 ms |
| E | admin mix | 8.7 | **70** | 193 ms | **59 ms** | **1,308 ms** | **90 ms** |
| E2 | admin stats | 30 | **75.2** | 130 ms | **52 ms** | 143 ms | 65 ms |
| E3 | appeals queue | **2.7** | **68** | **1,226 ms** | **58 ms** | 1,409 ms | 65 ms |

The three numbers worth stating plainly:

- **A volunteer's certificates page took 921 ms and now takes 66 ms** — 14× the
  throughput. It issued a get-or-create per completed event inside a
  `Promise.all`, so the page cost more the more somebody had volunteered, and
  eighty concurrent statements per request against a pool of ten made it a pool
  problem as well as a latency one. **This one was found by the load test, not by
  reading the code**, which is the whole argument for having one.
- **The appeals queue answered in 1.23 seconds and now answers in 58 ms** — 25×
  the throughput. It issued six statements per appeal against a 120-appeal queue;
  it now issues five for the whole page.
- **`GET /api/admin/stats` is 2.5× faster once a round trip costs anything**,
  which is the change the loopback run could not see. Reporting the loopback
  result alone would have understated a real improvement to zero; reporting only
  this one would have overstated it for a single-machine deployment. Both are
  here, and the difference between them is the point.

Scenario A is flat in both tables. Its cost is the events aggregate CTE, which
this pass deliberately did not restructure.

### Scenario G — the notification fan-out

Timed separately, at 5 ms of database latency, cancelling an event with **150
confirmed volunteers**:

| | before | after |
|---|---|---|
| whole request | **4,440 ms** | **943 ms** |
| per recipient | 29.6 ms | 6.3 ms |
| in-app rows written | 150 | 150 |
| outbox jobs written | 150 | 150 |

`notificationService.dispatch` costs four to five round trips per recipient — the
opt-out lookup, the dedupe probe, the preference read, and two inserts — and the
loop was strictly sequential, inside the organizer's request. It now dispatches
five recipients at a time.

**Five, not "all of them".** An unbounded `Promise.all` over 150 recipients would
queue 150 statements against a pool of ten and starve every other request on the
server for the duration, trading one slow request for a slow everything. Half the
pool is a real speed-up with headroom left over.

The email SENDING was already asynchronous — the outbox worker does that — so
what this measures, and what improved, is only the enqueueing.

---

## 6. What the load test does not cover

- **Real network latency to a real provider.** §5 injects a plausible constant.
  A real link has jitter, occasional retransmits, and a pooler in the path.
- **Sustained soak.** Scenarios run for seconds, not hours, so this says nothing
  about leaks, WAL growth, or index bloat over a term.
- **The rate limiters, by default.** `--api-limit` is raised so scenarios measure
  the application. Pass `--api-limit 600` to measure the production ceiling
  instead — a different and also legitimate question.
- **Realistic data distribution.** Applications are spread evenly across events.
  A real pilot has a few popular events with far more than the rest.
- **The client.** This measures the API. Bundle size and render cost are not here.
- **Redis and OpenTelemetry.** Neither is on this branch; a deployment running
  them should re-measure.

---

## 7. Performance budgets

Derived from the measurements above rather than chosen in advance, and stated
against the deployment that exists: one instance, PostgreSQL over a network.

| Metric | Budget | Where it comes from |
|---|---|---|
| Read endpoint p50 | < 200 ms | measured 52–165 ms at 5 ms RTT |
| Read endpoint p95 | < 400 ms | measured 65–210 ms at 5 ms RTT |
| Sign-in p95 | < 800 ms | measured 432 ms; bcrypt dominates and is meant to |
| Admin surface p95 | < 300 ms | measured 65–90 ms at 5 ms RTT |
| Error rate under load | 0 non-2xx | every scenario above returned zero |
| Capacity oversell | never | scenario F, 40 concurrent accepts, 1 seat, exactly 1 accepted |
| Pool `waiting` after a run | 0 | measured 0 at 20 connections against a pool of 10 |

The read-endpoint budget deliberately accommodates scenario A, the events
browse, at 165 ms. That is the aggregate-CTE cost this pass did not restructure,
and setting a budget it already breaches would make the budget the first thing
anyone ignores.

Budgets are for the **pilot-scale corpus above**. The events browse query is
linear in event count and crosses 100 ms at about 10,000 events
([postgres-scale-measurements.md](postgres-scale-measurements.md)); these budgets
do not survive that and are not claimed to.
