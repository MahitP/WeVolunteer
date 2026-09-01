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
| `--latency-profile NAME` | `local` | synthetic database round-trip latency (§2.1) |
| `--db-latency N` | — | a FIXED delay with no jitter, overriding the profile |
| `--soak N` | 0 | run one sustained mixed workload for N seconds instead of the scenarios (§6) |
| `--pool-max N` | — | the application's `DATABASE_POOL_MAX` for this run |
| `--api-limit N` | 1000000 | the blanket API limiter's ceiling for the run |
| `--only A,C,F` | all | run a subset |
| `--json PATH` | — | write the raw results |
| `--label TEXT` | `unlabelled` | a name, printed and stored in the JSON |

### 2.1 Latency profiles

These are **synthetic test conditions**, not measurements of this deployment.
They bracket what published benchmarks report for managed PostgreSQL, read
2026-08-30 — in-region averages of 2.7–3.3 ms across AWS RDS, Azure Flexible
Server and GCP Cloud SQL, with cross-AZ synchronous replication reported to add
2–3 ms on its own.

| profile | round trip | jitter | what it stands for |
|---|---|---|---|
| `local` | 0 ms | — | the database on the same machine; the control |
| `same-region` | 3 ms | ± 1 ms | managed PostgreSQL in the same region |
| `pooled` | 8 ms | ± 4 ms | the same, plus a pooler hop and a cross-AZ leg |
| `distant` | 40 ms | ± 20 ms | application and database in different regions — the configuration to avoid, measured so the cost of drifting into it is legible |

Jitter is a folded normal around the base rather than a uniform band, plus a 1%
chance of a spike five times the jitter standing in for a retransmit. A uniform
± band would understate p99, which is the number a jitter profile exists to
expose.

**Two things the proxy had to get right, and got wrong first.**

*Ordering.* An independent timer per chunk lets a jittered second chunk land
before the first. TCP never does that, and PostgreSQL's wire protocol is a
stream — the first jittered run produced a 500 and then `fetch failed` as the
connection desynchronised. Each chunk's release is now clamped to be no earlier
than the previous one's: delay varies, order cannot.

*Its own event loop.* The proxy first ran inline, in the same event loop as
autocannon, and starved under sustained load. A 15-minute soak at 20 connections
reported **20 req/s, 1,220 timeouts and a p99 of 1,446 ms**; the identical soak
with the proxy removed reported **857 req/s, p99 56 ms and zero errors**. The
application was never the bottleneck — the instrument was, and its failure was
indistinguishable from a real one: saturated pool, climbing latency, timeouts.
It now runs on a worker thread. Moving it there took the same soak from 20 req/s
to 106 req/s, and raising the pool took it the rest of the way (§7).

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

## 6. The latency matrix

All ten scenarios plus the concurrency and fan-out checks, at each profile.
2,015 users / 1,002 events / 8,092 applications / 2,171 attendance rows / 120
appeals, 20 connections, 6 seconds per scenario, `DATABASE_POOL_MAX=25`.

**Every cell below is zero non-2xx, zero uncaught exceptions and zero preflight
failures, and scenario F accepted exactly one of forty concurrent accepts at
every profile.**

Throughput, req/s:

| id | scenario | local | same-region | pooled | distant |
|---|---|---|---|---|---|
| A | public browse | 362.7 | 301.5 | 130.3 | 26.7 |
| B | authentication | 17.3 | 16.5 | 15.5 | 10.3 |
| C | student session | 738.2 | 560.8 | 194.2 | 39.3 |
| C2 | applications, paginated | 969.0 | 599.7 | 175.3 | 34.8 |
| C3 | applications, legacy | 691.5 | 500.8 | 169.8 | 34.3 |
| C4 | certificates, 80-event history | 1,241.2 | 956.8 | 314.3 | 65.3 |
| D | organizer | 970.5 | 549.7 | 190.0 | 38.7 |
| E | admin mix | 315.5 | 121.7 | 41.3 | 9.5 |
| E2 | admin stats | 119.3 | 86.8 | 38.0 | 9.2 |
| E3 | appeals queue | 749.5 | 103.3 | 36.2 | 7.3 |
| G | fan-out to 150 volunteers | 23 ms | 75 ms | 189 ms | 745 ms |

### What the matrix says

**Authentication is the only scenario that barely moves** — 17.3 → 10.3 req/s
across a 40 ms round trip. bcrypt dominates it, which is what bcrypt is for. It
is also the reason B is the floor everywhere: at `local` it is the *slowest*
scenario on the board.

**Everything else is round-trip-bound**, and the ranking is simply how many
statements each endpoint issues. Dividing p50 at `distant` by the 40 ms round
trip gives the count directly:

| endpoint | p50 at `distant` | ≈ round trips |
|---|---|---|
| certificates | 295 ms | ~7 |
| applications (paginated) | 540 ms | ~13 |
| appeals queue | 509 ms | ~13 |
| admin stats | 420 ms | ~10 |
| public browse | 702 ms | ~17 |

Nothing is pathological — these are close to the floor for what each endpoint
has to read, and they are the numbers *after* this pass. The public browse is
the highest because it batch-loads slots, accepted counts, attendance, tags,
bans and memberships for the page, each as its own statement.

**The practical conclusion is about placement, not code.** At 40 ms the entire
application is between 10× and 100× slower than at 3 ms, and no amount of query
work closes that gap. Put the application in the same region as the database.
The `distant` column exists so that the cost of not doing so is a number rather
than an intuition.

---

## 7. Soak, and connection-pool sizing

### The soak

`--soak N` replaces the scenario run with ONE sustained mixed workload — browse,
applications, notifications, profile, certificates — sampled every ten seconds
for resident memory, CPU, pool counts and the pending-job backlog. It answers the
questions a six-second scenario cannot: does memory climb and never come back,
do pooled connections leak, does a queue build faster than it drains.

**15 minutes, 20 connections, `same-region`, 2,015 users / 1,002 events:**

| | result |
|---|---|
| resident memory | 164 MB → 102 MB (fell; no leak) |
| pending notification jobs | 0 → 0 (no queue buildup) |
| pooled connections | never exhausted the pool's own recovery — idle returned to full between runs |

A 120-second soak on `local` at the same concurrency: **857 req/s, p50 17 ms,
p99 56 ms, zero errors, zero timeouts**, with resident memory settling at
255 → 267 MB and staying there.

Nothing leaked in either run. The first 15-minute run *looked* like it had found
something — 20 req/s and 1,220 timeouts — and that turned out to be the harness
starving itself (§2.1), which is why the `local` control matters.

**Re-run on the integrated tree** (Redis + OpenTelemetry + this work), same
15 minutes, same profile, 2,015 users / 1,002 events / 8,092 applications:

| | result |
|---|---|
| resident memory | 241 MB → 229 MB (fell again; no leak) |
| errors | **0**, on every one of the ninety ten-second samples |
| pooled connections | steady at 21 open, **peak waiting 0** for the whole run |
| pending notification jobs | 0 → 0 |
| pool at exit | 25 total, 25 idle, 0 waiting |

Resident memory is higher than the pre-integration run in absolute terms, which
is expected and not a finding: the process now also holds the OpenTelemetry SDK
and its batch processors. What matters is the slope, and the slope is flat to
slightly negative over fifteen minutes — it oscillates in a 224–245 MB band with
no trend.

`waiting` never left zero, which is the number worth watching: it says the pool
was never the constraint at this concurrency, and it is consistent with the
sweep below finding the knee below 25.

### Connection pool sizing

This is what the soak actually found, and it changed a production default.

`DATABASE_POOL_MAX` was 10, on the argument that PostgreSQL gains nothing from
more concurrent connections than it has cores. That is true of CPU-bound queries
and is the wrong model over a network: a pooled client there spends most of its
life waiting on a round trip, so the pool has to be sized for requests in flight.

**`--latency-profile same-region --soak 45 --pool-max N`, 20 connections:**

| pool | req/s | p50 | p95 | p99 | peak waiting |
|---|---|---|---|---|---|
| 5 | 67.7 | 203 ms | 1,027 ms | 1,164 ms | 19 |
| 10 *(old default)* | 127.2 | 120 ms | 481 ms | 526 ms | 17 |
| 15 | 269.2 | 56 ms | 161 ms | 194 ms | 13 |
| 20 | 403.4 | 37 ms | 97 ms | 106 ms | 9 |
| **25** *(new default)* | **486.8** | **29 ms** | **73 ms** | **80 ms** | 5 |
| 40 | 501.8 | 24 ms | 58 ms | 64 ms | 0 |

25 takes ~97% of the achievable throughput and drops p95 by **6.6×** against the
old default; past it the curve is flat.

**The same sweep with no injected latency is noise** — 863 / 1,011 / 706 / 871
req/s at pools of 10 / 20 / 30 / 50 — because loopback makes the application's own
event loop the bottleneck instead. That is exactly why 10 looked defensible for
as long as it did, and it is the strongest argument in this document for
measuring against a latency profile rather than against a database on the same
machine.

**A non-zero `waiting` is not by itself a problem.** A small pool queues by
design, and the healthy loopback runs show waiting of 7–10 with zero errors. It
is sustained waiting *together with* climbing p95 that says the pool is the
constraint.

**Re-validated on the integrated tree** (Redis + OpenTelemetry + this work),
at the `pooled` profile — 8 ms base and 4 ms jitter, the closest thing here to a
real Supavisor path — with scenarios A, C, D and E2:

| pool | A | C | D | E2 | connections actually opened |
|---|---|---|---|---|---|
| 10 | 60.0 | 96 | 92 | 40.8 | 10 of 10 |
| **25** *(default)* | **133.6** | **192** | **184** | **40.2** | 21 of 25 |
| 40 | 134.8 | 192 | 188.2 | 40.6 | 21 of 40 |

Two things worth reading off this. **10 is half the throughput** on every
pool-bound scenario, so the change still earns its place. And **25 and 40 are
identical** — both stop at 21 open connections under 20 concurrent requests — so
25 is not merely better than the old default, it is *sufficient*: the knee is
below it, and raising it further buys nothing.

E2 is flat at ~40 req/s across all three, which is the control. Admin stats is
one consolidated statement, so it is bound by the round trip and not by the
pool; a number that moved there would have meant the sweep was measuring
something other than pool contention.

25 is per process. Supabase's entry sizes allow 60 direct connections and 200
Supavisor pooler clients, so it leaves room for eight instances through the
pooler — and only two through a direct connection, which is another reason to
use the pooler.

**Neither integrated component changes that arithmetic.** Redis speaks the
Upstash REST API over `fetch` and opens no PostgreSQL connection at all;
OpenTelemetry's `instrumentation-pg` wraps the connections that already exist
rather than making its own. The one thing that does add to the count is the
Socket.IO adapter, which opens its **own** pool of 4 on a separate session-mode
connection when enabled — so an adapter-enabled instance is 25 + 4, and two such
instances are 58, still inside the 60 direct-connection ceiling and comfortably
inside the pooler's 200.

---

### 7.3 Instrumentation overhead — measured, not assumed

`startServer` deletes `BETTERSTACK_SOURCE_TOKEN` before spawning the child, so a
developer's shell cannot ship spans from a load run. Correct — and it had a
consequence worth stating plainly: **every number in this document above was
measured with tracing off, while production runs with it on.** The harness was
structurally unable to check its own assumption that instrumentation is cheap.

`--otel` closes that. It stands up a loopback OTLP receiver, points the exporters
at `http://127.0.0.1:<port>` with a synthetic token, and forces
`OTEL_TRACE_SAMPLE_RATE=1` — fifty times the production default of `0.02` — so
the figure is a ceiling rather than a flattering sample. The environment is set
*after* the credential strip, so no ordering change can turn this into a path
that leaks a real token.

The sink counts what arrives and **the run fails if nothing did**. A run
reporting "no measurable overhead" because the exporter was quietly disabled
would be worse than no measurement at all.

Same-region profile, same seed, tracing off versus on:

| | off req/s | on req/s | delta |
|---|---|---|---|
| A public browse | 381.6 | 374.2 | −1.9% |
| B authentication | 32.6 | 32.4 | −0.6% |
| C student activity | 594.2 | 607.0 | +2.2% |
| C2 applications, paginated | 605.8 | 589.0 | −2.8% |
| C3 applications, unpaginated | 573.8 | 557.6 | −2.8% |
| C4 certificates | 1,097.2 | 1,104.4 | +0.7% |
| D organizer | 608.0 | 606.2 | −0.3% |
| E admin dashboard | 127.2 | 129.6 | +1.9% |
| E2 admin stats | 110.2 | 112.2 | +1.8% |
| E3 appeals queue | 106.2 | 112.4 | +5.8% |
| G fan-out, 150 | 65 ms | 69 ms | +6% |

The instrumented run genuinely exported: **1,507 trace requests and 7.9 MB**
reached the sink.

Worst case −2.8%, and several scenarios came out *faster* with tracing on, which
is the shape of run-to-run noise rather than a cost. At the ceiling sampling
ratio, on every scenario. The conclusion is that OpenTelemetry as configured here
is not on the critical path in any measurable way — and it is now a measurement
rather than a hope.

What this does **not** measure is Better Stack's network path. The exporter is
batched and asynchronous by design, so that cost is off the request path; the
loopback sink deliberately removes it so what is left is the SDK's own work —
span creation, attribute building, sampling and serialisation.

---

### 7.4 Redis, exercised rather than stripped

`--redis` points the real client at `bin/lib/upstash-stub.mjs`, a loopback server
speaking Upstash's REST protocol. Every byte the client builds, every Lua script
it sends and every response it parses is the real one; only the host is local.

It speaks real **TLS**, because `redis/redisConfig.js` refuses any non-HTTPS URL
— the token is a bearer credential and a plaintext URL would put it on the wire.
That rule is a security control, so the stub gets a throwaway self-signed
certificate and the child verifies it through `NODE_EXTRA_CA_CERTS`.
`NODE_TLS_REJECT_UNAUTHORIZED=0` would also have worked and is deliberately not
used: it disables verification for every connection the process makes, including
the ones to the database.

**The real Upstash endpoint is refused, not supported.** A load run is bounded in
neither requests nor keys, the free plan is 500,000 commands a month for the
whole application, and the plan allows one database per account — so a load test
against it would spend production's allowance and write into production's
keyspace.

| scenario | result |
|---|---|
| **R1 healthy** | 262 requests, 262 commands (`GET`=131, `DEL`=131) — exactly the login-failure `peek`/`clear` pair the cost table predicts |
| **R2 concurrency** | A 392 req/s, C 589 req/s, zero non-2xx — indistinguishable from Redis off |
| **R3/R4 cache** | the geocode and weather caches are not on these scenarios' paths; their hit/miss behaviour is covered by `redis.lookupCache.test.js` |
| **R5 outage** (`--redis-fail`) | **zero non-2xx**, throughput unchanged (A 390.8 vs 392, C 591.2 vs 589.4), and **one** request attempted in the whole run — the breaker opened and suppressed the rest |
| **R6 recovery** | the breaker reopens after `UPSTASH_BREAKER_MS`; asserted in `rateLimit.multiInstance.test.js` rather than in a load run, because it needs a controllable clock |
| **R7 two instances** | `bin/multi-instance-check.mjs` — see §7.6 |

The outage row is the important one. **A Redis outage is invisible to users**:
every limiter falls back to a correct per-instance limiter, and the breaker means
an outage costs one timeout per window rather than one per request.

**Command economics under load.** With `--api-limit 600`, a run that made
**161,408 requests produced 15 `EVAL`s** — because once a caller is over the
limit, refusal is decided locally and costs nothing. An attacker cannot drain the
command allowance by continuing to knock.

---

### 7.5 Through a real transaction pooler

The runbook tells operators to point `DATABASE_URL` at Supavisor in TRANSACTION
mode, and `postgresConnection.js` leaves `pg`'s named prepared statements off
precisely because such a pooler can put a different backend under a client
between checkouts. That was reasoned and never run.

pgbouncer in transaction mode is the same protocol behaviour, locally:

```
pool_mode = transaction
listen_port = 6543
LOAD_DB_URL=postgres://you@127.0.0.1:6543/wv_load node bin/load-test.mjs
```

The full scenario suite through it: **every scenario zero non-2xx**, capacity held
at 1 of 40 concurrent accepts, fan-out to 150 volunteers in 11 ms, migrations and
seeding all through the pooler. The prepared-statement decision is now evidence
rather than argument.

---

### 7.6 Two real backend instances

`bin/multi-instance-check.mjs` boots two copies of `server/server.js` against one
PostgreSQL and one Redis. This is possible because `instanceLock`'s
`shouldRefuseBoot` refuses only in production, which is exactly the seam it
leaves for a test like this — the production posture is unchanged.

10/10 checks, including: a session minted on A accepted by B; the API limiter
shared (**A allowed 59/60, then B allowed 19/60; combined 78 against a bound of
88, where two independent limiters would have allowed 120**); an unexpired lease
not stolen; both instances declining a sweep held elsewhere; no fail-open; and
the shared state demonstrably passing through Redis.

Contention for the lease has to be **manufactured** — the sweeps acquire, find
nothing to do, and release, so two instances essentially never overlap naturally.
The check inserts a lease owned by an instance that does not exist and asserts
both real instances decline. Waiting for a natural collision proves nothing, and
the first version of this check did exactly that.

---

## 8. What the load test does not cover

- **Real network latency to a real provider.** §5 injects a plausible constant.
  A real link has jitter, occasional retransmits, and a pooler in the path.
- **A long soak.** `--soak` runs for as long as it is told and §7 reports a
  fifteen-minute one, which is enough to expose a leak with a steep slope. It is
  not a term: WAL growth and index bloat over months are still unmeasured.
- **The rate limiters, by default.** `--api-limit` is raised so scenarios measure
  the application. Pass `--api-limit 600` to measure the production ceiling
  instead — a different and also legitimate question.
- **Realistic data distribution.** Applications are spread evenly across events.
  A real pilot has a few popular events with far more than the rest.
- **The client.** This measures the API. Bundle size and render cost are not here.
- **Redis and OpenTelemetry are no longer in this list** — see §7.3 and §7.4.
  Both now have explicit modes, and the credential strip still applies: neither
  ever talks to a real vendor.

- **A real Supabase/Supavisor endpoint.** §7.5 runs through pgbouncer in
  transaction mode, which is the same protocol behaviour, on loopback. What is
  still unmeasured is Supabase's own network path and Supavisor's specific
  implementation.

---

## 9. Performance budgets

Derived from §6 rather than chosen in advance, and stated against the deployment
that exists: one instance, PostgreSQL over a network in the same region,
`DATABASE_POOL_MAX=25`.

| Metric | Budget | Where it comes from |
|---|---|---|
| Read endpoint p50 | < 100 ms | measured 20–65 ms at `same-region` |
| Read endpoint p95 | < 200 ms | measured 26–78 ms at `same-region` |
| Sign-in p95 | < 1,000 ms | measured 850 ms; bcrypt dominates and is meant to |
| Admin surface p95 | < 150 ms | measured 44–52 ms at `same-region` |
| Broadcast to 150 volunteers | < 500 ms | measured 75 ms at `same-region` |
| Error rate under load | 0 non-2xx | every cell of the matrix returned zero |
| Capacity oversell | never | scenario F, 40 concurrent accepts, 1 seat, exactly 1 accepted, at every profile |
| Pool `waiting` after a run | 0 | measured 0 at 20 connections against a pool of 25 |
| Resident memory over 15 min | no upward trend | measured 164 MB → 102 MB |
| Pending notification jobs over 15 min | no growth | measured 0 → 0 |

These are for the **pilot-scale corpus above** and for a same-region database.
The `distant` column of §6 is 10–100× worse across the board and no budget here
survives it; that is a placement decision, not a code one.

The events browse remains linear in event count. It crosses 100 ms at roughly
10,000 events on the unfiltered default sort — see
[postgres-scale-measurements.md](postgres-scale-measurements.md) and
`bin/events-query-probe.mjs`. Filtered browses are now 2–9× faster than they
were, but the unfiltered ceiling is unchanged and is not claimed to have moved.
