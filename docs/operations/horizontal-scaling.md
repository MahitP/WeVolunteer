# Horizontal scaling

**Status: one instance today, deliberately.** Updated 2026-08-30 after the
Socket.IO adapter work — the section that used to say realtime was the one
genuine blocker now says it is a setting, and §3 carries a full re-audit of every
piece of process-local state in `server/`.

`server/instanceLock.js` still refuses a second production instance, and that has
not changed. What changed is that the list of reasons it must is now short,
evidenced, and written down.

This document is the honest inventory: what is safe for multiple instances, what
is not, and what each remaining item would cost to fix.

---

## 0. What is proven, and how

Claims in this document are not all backed by the same strength of evidence, and
conflating them is how a deployment gets surprised. Four levels:

| Level | Meaning | Examples |
|---|---|---|
| **Production-proven** | Executed against the real third-party service | The Upstash path: 11/11 checks live, including the token-bucket Lua spending atomically and refilling by elapsed time (3.0000 of 5 tokens after two spends 1 ms apart). Latency avg **234 ms**, max 332 ms — which is the number the Socket.IO adapter decision rests on. |
| **Integration-proven** | Two real processes, real database, real protocol | Two backend instances against one PostgreSQL and one Redis (`bin/multi-instance-check.mjs`, 10/10). The transaction pooler (`pooler.behaviour.test.js`, 8/8 through pgbouncer). Cross-instance Socket.IO broadcast through real PostgreSQL LISTEN/NOTIFY. |
| **Locally proven** | Real code, simulated dependency | The limiter bounds across 2–4 simulated instances; the abuse-cost ceilings; Redis outage and breaker behaviour. |
| **Unverified** | Stated, not measured | **Nothing, as of 2026-09-03.** Supavisor's transaction-pooling behaviour was the last item and is now production-proven: `pooler.behaviour.test.js` 8/8 against a real Supabase project on port 6543 — see below. |

The honest summary: every claim in this document is now proven at one of the top
three levels, against the services the deployment actually uses.

### Supabase, end to end — 2026-09-03

A real Supabase project (PostgreSQL **17.6**, us-east-2, free tier) was
provisioned into a throwaway schema, exercised, and dropped. `public` was never
touched and the project was left byte-for-byte as it was found, `pg_trgm`
included.

| | Result |
|---|---|
| `applyPostgresSchema` + all 64 migrations, against the real service | **67 tables**, 64 migration rows, in 23.3 s over a 250 ms link |
| `pg_trgm` install path | Installed **1.6 into the `extensions` schema** — the Supabase convention migration 064 targets, now confirmed rather than inferred |
| The four trigram indexes | All four created, in the migration's own run |
| `search_path` as Supabase serves it | `"$user", public, extensions` — which is why the opclass is schema-qualified |
| **`pooler.behaviour.test.js` through Supavisor, port 6543** | **8/8.** Ordinary statements; connections reused without pinning; **120 statements leaving zero named prepared statements**; a transaction pinned to one backend so `FOR UPDATE` means what it says; concurrent transactions serialised on one row; rollback leaving nothing; the pool recovering after a failed statement; more concurrent work than the pool has clients |
| Free-tier server limits | `max_connections=60`, `statement_timeout=2min`, `idle_in_transaction=0` |

The prepared-statement result is the one that matters most, because it is the
reason `postgresConnection.js` leaves `pg`'s statement caching off. Until now
that decision rested on pgbouncer behaving the way the documentation says
Supavisor does. It now rests on Supavisor.

One caveat worth carrying: the timeouts in `pooler.behaviour.test.js` are sized
for a local pooler. Over a real network the 120-round-trip case takes ~30 s and
needs `--testTimeout=240000`. The test was not weakened to accommodate a slow
link; the run was given a longer clock.

### What the connection path proved before authentication ever succeeded

A disposable Supabase project was pointed at with `DATABASE_ENGINE=postgres` and
a `DATABASE_URL`. The credential in it is rejected (`28P01`) on both of the two
projects offered, so the *behavioural* half of the validation is still open. But
everything the connection needs BEFORE the password was exercised for real, and
three of those were assumptions until now:

| Checked against the live service | Result |
|---|---|
| The pinned CA in `deploy/certs/supabase-root-2021.crt` still validates Supabase's pooler certificate | **Yes**, with `rejectUnauthorized: true` on both 5432 and 6543. The connection reaches authentication. |
| Whether the pin is load-bearing or decoration | **Load-bearing.** The system CA store rejects the same certificate: `SELF_SIGNED_CERT_IN_CHAIN`. Without `DATABASE_SSL_CA` a verified connection fails. |
| Whether `db.<ref>.supabase.co` is reachable | **Not on IPv4.** AAAA only, no A record. From a host without global IPv6 the application's own driver fails at `ENOTFOUND`, before TLS. |
| Which pooler shard a project lives on | Not guessable, and the wrong one answers `Tenant or user not found` rather than a password error — a useful way to tell "wrong host" from "wrong password" apart during an incident. |
| `pg`'s handling of an un-encoded `@` in a password | **Correct.** `pg-connection-string` splits the authority at the LAST `@`, so an un-encoded password parses to the same value as a percent-encoded one. Checked because the credential offered contains one, and it is not the explanation for the auth failure. |
| Round trip from a developer laptop (India) to us-east-2 | TCP **231 ms** median, TLS handshake **458 ms**. Not a production number — the VM sits beside the database — but it is the number for anyone running migrations, `pg_dump` or the load test from a laptop. |

So the ladder now reads: DNS, address family, TLS, certificate pinning, hostname
verification, Supavisor tenant routing and the application's own driver are all
**production-proven** against the real service. What remains unverified is what
happens *after* a successful login, which needs a working password.

`bin/supabase-check.mjs` walks that ladder and reports which rung broke, because
every one of those failures presents identically from the outside — "it will not
connect" — and each is diagnosed completely differently:

```bash
SUPABASE_CHECK_URL='postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres' \
  node bin/supabase-check.mjs --write-probe
```

It reads `SUPABASE_CHECK_URL` and deliberately NOT `DATABASE_URL`: a tool that
picks up the deployment's own configuration is a tool that eventually runs
against production because somebody had a shell open in the wrong directory. The
write probe refuses any database holding real users, creates one randomly-named
table, and drops it.

Once it reaches `authenticates`, the behavioural half is two existing suites
pointed at the same target:

```bash
TEST_POOLER_URL=…   npx vitest run server/pooler.behaviour.test.js
TEST_POSTGRES_URL=… WEV_POSTGRES_APP_TEST=1 npx vitest run --project server
```

---

## 1. Why one instance is still the answer

The deployment is a single systemd unit on one VM (`deploy/wevolunteer.service`).
At pilot scale that is not a compromise — the load test measures 790 req/s on the
public browse path and 3,000 req/s on a student's applications list from one
process. Nothing about the current population needs a second instance.

The reason to care anyway is that the *cost of discovering* you cannot scale
horizontally is highest exactly when you need to. So the seams exist; the switch
is off.

---

## 2. What is already safe for multiple instances

### The three job queues — safe, and were already

`workers/notificationWorker.js`, `workers/exportWorker.js` and the mail outbox in
`emailService.js` claim work with a conditional `UPDATE … WHERE status =
'pending'` and branch on `changes`. Two processes racing for the same job produce
exactly one winner. Each also reclaims rows stranded in `processing` by a crashed
predecessor, caps attempts, and classifies terminal failures.

**Do not "fix" these into something else.** They already have the property a
queue is bought for, they cost nothing, and no hosted queue's free tier
(QStash is 1,000 messages/day) survives a single event's reminder fan-out.

### Slot capacity — safe

Capacity is counted **inside** the transaction behind `SELECT … FOR UPDATE` on
the slot, with multi-slot batches locking in sorted id order to avoid deadlock.
Proven in-process by `application.postgresConcurrency.test.js` and
`capacity.postgresConcurrency.test.js`, and now proven over HTTP: scenario F of
`bin/load-test.mjs` fires forty simultaneous accepts at a one-seat slot and
exactly one succeeds.

### The four periodic sweeps — safe as of this change

The notification sweep, Auto Select, retention and the search indexer each do a
whole scan on a timer. There is no row for a sweep to claim, so two processes
both did the whole scan.

Each now runs inside `withLease()` (`server/schedulerLease.js`), a leader lease
in the `scheduler_leases` table (migration 062). The lease is taken by a
conditional upsert claimed by `WHERE expires_at <= …`, which is the same idiom
`instanceLock.js` and `notificationWorker.reclaimStaleJobs` already use: the
**write is the claim**, so two processes issuing it at the same moment produce
one winner.

| property | value |
|---|---|
| TTL | 10 minutes (`SCHEDULER_LEASE_TTL_MS`) |
| owner token | `pid:uuid`, unique per process |
| release | predicated on the owner, so a superseded holder cannot delete its successor's lease |
| expiry | mandatory; there is no unbounded lease by construction |
| failure mode | **fails open** — see below |

**It fails open on purpose.** If the lease cannot be taken, the sweep runs
anyway. This is not a security boundary: it is a "do not do this twice" guard on
a deployment that already refuses to run twice. Failing closed would let a
transient database error silently stop retention and notification reminders,
which is a much worse outcome than doing the work twice.

Retention is the sweep that most needed this, and the reason is asymmetry: the
other three are idempotent by construction (a `dedupe_key` unique index, a
confirmed `auto_select_runs` row, a pending queue). Retention **deletes**.

Nothing observable changes on one instance: the sole holder always acquires.

### The API rate limiter's key — fixed here, and it was a live defect

`apiLimiter` covers every `/api` request and had no key generator, so
`express-rate-limit` keyed it on `req.ip`: **600 requests per fifteen minutes for
a whole school's shared egress address.** A signed-in session makes several
requests per screen, so a few dozen students browsing at lunchtime exhausted the
building's budget and the next person to open the app was refused.

This is the same failure already found and fixed twice — `loginLimiter` was
re-keyed onto `ip + account` after ten students mistyping once locked out a
building, and `mailLimiter` onto the target address. `apiLimiter` was the one
left on a bare address.

It is now keyed on the **verified session** when there is one, and on the address
otherwise. The per-bucket number is unchanged, so nothing gained budget: an
anonymous caller is bounded identically, one account is bounded identically, and
a building stops sharing one bucket. The token is verified rather than parsed —
keying on an unverified cookie would let an attacker rotate it per request and
buy an unlimited budget. Covered by `routes.apiLimiterScope.test.js`.

---

## 3. What is NOT safe for multiple instances

### Socket.IO — the adapter now exists, and is off

**Was the one genuine blocker. It is now a setting.**

`@socket.io/postgres-adapter` broadcasts over `LISTEN`/`NOTIFY`, so the bus is
the database this application already cannot run without: no new service, no new
credential, no new free-tier ceiling, and `pg` was already a dependency. The
Redis adapter was rejected on a measurement — the Redis branch records a **222 ms
warm round trip** to the Upstash database as configured, and an adapter sits on
the message path.

It is **disabled by default and nothing about the current deployment changes**.
With `REALTIME_ADAPTER` unset the package is never even imported.

**Activation, when a second instance is genuinely wanted:**

```
REALTIME_ADAPTER=postgres
REALTIME_ADAPTER_URL=postgres://…@aws-0-<region>.pooler.supabase.com:5432/postgres
```

**The constraint that matters, and it is easy to get wrong.** `LISTEN` holds
state on a connection between statements. Supavisor in **transaction** mode
(port 6543) returns the connection to the pool after every transaction, so a
registered `LISTEN` is simply gone — no error, no notifications, and a cluster
that looks healthy while broadcasting nothing. `DATABASE_URL` is meant to point
at exactly that pooler, which is why `REALTIME_ADAPTER_URL` is deliberately not
defaulted to it, and why setting the adapter without one stops the boot. Use the
**session**-mode pooler (port 5432 on the pooler host) or a direct connection.

The adapter creates its own `socket_io_attachments` table on first enabled boot,
the way `instanceLock.js` creates its own table. It is not a migration: a
PostgreSQL-only migration is skipped on a freshly provisioned database, because
`applyPostgresSchema` records every registry version as already supplied.

Proved rather than asserted: `realtime.adapter.test.js` starts two independent
Socket.IO servers over a real PostgreSQL and checks that a broadcast made on one
reaches a client attached to the other — which is precisely the delivery a second
instance cannot do without it.

### The rate limiters — all shared, by three mechanisms

This section has now said four things across four passes, each a measurement
rather than a change of mind: every limiter per-process; then a split by
security-versus-volume; then a split between two ways of sharing; and now three,
with nothing left unshared by accident.

**Exact sharing** (`redis/limitStore.js`) — every increment metered, 3 commands
each. For limiters that tick rarely and bound abuse: `mailLimiter`,
`mailIpCeilingLimiter`, `verifyLimiter`, `reauthLimiter`, `appealLimiter`,
`signupLimiter`, `appealReadLimiter`, `errorReportLimiter`, `lookupLimiter`,
`exportLimiter`, `issueLimiter`, `reportLimiter`, `applicationLimiter`,
`checkinCodeLimiter` — plus the `loginFailures` counter and, new here, the
**login IP-failure ceiling**.

**Approximate sharing** (`redis/volumeLimit.js`) — exact locally, reconciled
only once a caller approaches the ceiling. For `apiLimiter` and the message send
throttle, because metering every `/api` request costs about 6,600 commands per
user per month against a plan that allows 500 at a thousand users.

**A distributed token bucket** (`redis/volumeLimit.js`) — for
`checkinScanLimiter`, whose policy is burst-plus-refill and cannot be expressed
by a fixed window without changing it. One Lua script, because refill is
read-compute-write and two instances doing that with GET/SET issue two tokens
for one — and the second write restores the first's spent token, so a sustained
two-instance attack would refill *faster* than configured.

#### The approximation is a setting, not a property of the code

`RATE_LIMIT_MODE` chooses the strength:

| mode | across N instances | cost |
|---|---|---|
| `coordinated` *(default)* | bounded by `limit + N x (escalateAt - 1)` | zero for callers below the threshold |
| `exact` | **exactly `limit`**, for any N | 3 commands per request |
| `local` | `N x limit` | zero |

The default is approximate for **one** reason: Upstash bills per COMMAND, and
`apiLimiter` sits on every request. That is the provider's pricing model, not a
fact about Redis — Aiven's and Layerbase's free Valkey tiers meter connections
and storage instead, and on one of those `exact` costs nothing extra. Moving to
such a provider is therefore one environment variable, not a rewrite, and
`rateLimit.multiInstance.test.js` proves the exact path works today across two,
three and four instances.

`local` exists so an operator can take a limiter out of a Redis incident without
a deploy. An unrecognised value stops the boot rather than defaulting.

#### Abuse cannot buy commands

Asserted, not intended: a caller already refused costs nothing to refuse again
(5,000 further requests spent zero); one key's spend in a window is capped at
`(limit - escalateAt) / batch + 1` reports however much traffic it sends; spend
scales with distinct KEYS rather than volume, and minting a key means holding a
verified session or another address; and an attack during a Redis outage cannot
amplify, because the breaker costs one timeout per window.

#### The sign-in path is a LAYERED system, and the layering is the security argument

Four controls guard sign-in, and the two in-process ones are safe under any
number of instances for a specific, testable reason rather than by assumption:

| Control | Scope | Where |
|---|---|---|
| `authLimiter` | 10 failures / 15 min per address | in-process |
| `loginLimiter` | ~5 failures / 15 min per address+account | in-process |
| `loginFailures` | 10 failures / 15 min per **account** | **shared** |
| IP-failure ceiling | 200 failures / 15 min per **address block** | **shared** |

Each in-process limiter is strictly *tighter* than a shared control covering the
same dimension. With N instances a local limiter degrades to N × its budget, but
the global bound is `min(N × local, shared)` and the shared cap does not move:

```
per account        min(N x 5, 10)    <=  10, whatever N is
per address block  min(N x 10, 200)  <= 200, whatever N is
```

So the local limiters are a free, fast rejection path in front of an
authoritative cap — not a security boundary of their own. Distributing them
would spend Redis commands on `skipSuccessfulRequests` traffic (an increment on
every request and a decrement on every success) to buy a bound that already
holds. `auth.abuseArchitecture.test.js` asserts it: twenty instances attacking
one account still stop at ten; five instances credential-stuffing from one
address still stop at two hundred.

**Address keying is `ipKeyGenerator`, everywhere.** A raw `req.ip` is a correct
key for IPv4 and no control at all for IPv6 — a residential allocation is a /64,
so an attacker rotating inside their own prefix would draw a fresh ceiling per
attempt. The shared ceiling keyed on `req.ip` for one pass and that was a real
bypass; it now collapses IPv6 to a 56-bit prefix like every other IP-keyed
limiter here, and the module's own key function is tested rather than the
library's.

#### Still per-process, deliberately

`authLimiter` and `loginLimiter`. Both set `skipSuccessfulRequests`, which bills
an increment on every request and a decrement on every success — so the common
case, somebody signing in correctly, is the expensive one, and sharing the
sign-in limiters that way comes to 107% of the monthly allowance at a thousand
users (`upstash.md` §7.3). They are the per-device fast path in front of two
controls that ARE shared: `loginFailures` per account, and the IP-failure
ceiling. Counting failures explicitly costs commands only when a sign-in fails —
about ten per user per month for an identical security property.

### Other process-local state, classified

Re-audited after the adapter work. Every piece of module-level mutable state in
`server/` was read and placed in one of four boxes.

| State | Where | Verdict |
|---|---|---|
| `loginFailures` counter | `routes/authRoutes.js` | **shared — done.** `createSharedCounter` in `redis/limitStore.js`. Survives a restart, and is the control that actually bounds guessing at one account. |
| Message send throttle | `messageThrottle.js` | **shared — done.** Was `sendBuckets`, a Map in `messageRoutes.js`, and the last item here that was neither done nor deferred. 20 a minute per sender on a SLIDING window, coordinated above half the limit. |
| `express-rate-limit` stores | five security limiters | **shared — done.** See above for which, and why the rest are not. |
| `express-rate-limit` stores | the volume limiters | **shared, approximately — done.** `redis/volumeLimit.js`; bounded error, see above. |
| `express-rate-limit` stores | the three sign-in limiters | **per-process, deliberately.** Sharing them alone is 107% of the monthly allowance; the per-account control they sit over IS shared. |
| `checkinScanLimiter`'s token bucket | `checkinLimiters.js` | **shared — done.** A distributed token bucket in one Lua script, preserving burst capacity and refill rate exactly. The in-process bucket remains as the fallback, so a Redis outage is a continuation rather than a fresh capacity. |
| Login IP-failure ceiling | `routes/authRoutes.js` | **shared — done.** Was `loginIpCeilingLimiter`'s in-process store, so N instances allowed N x 200 failures per address — the gap that matters for credential stuffing, which never trips a per-account cap. |
| `events.first_slot_start` | `eventSummary.js` | **safe — it is derived, not shared state.** A maintained MIN over each event's slots, written in the same transaction as every slot mutation and identical on every instance because it is a function of rows they all see. `bin/verify-event-summaries.mjs` detects and repairs drift. |
| `typingBuckets` | `realtime/socketServer.js` | **safe, and not what its name suggests.** Declared inside the per-connection handler, so it is per SOCKET rather than per process — a user with two tabs gets two typing budgets today, on one instance. Typing indicators are ephemeral and unlogged; distributing them would cost commands to bound something nobody can abuse meaningfully. |
| Nominatim pacing reservation | `redis/upstreamThrottle.js` | **shared — done.** The limit is one request per second *for this application in total*, so a per-process reservation was wrong with one instance too. |
| Rerank budget (`rerankMonth`, `rerankSpent`) | `search/discoverSearch.js` | **safe today, would need attention if reranking is ever switched on.** See below. |
| Search candidate cache | `search/candidateCache.js` | **safe — performance only, and deliberately not shared.** It remembers which event ids the vector index proposed for a question, for 60 seconds. Two instances keep two copies and each pays its own vendor call; nobody sees a different row, because every id goes back through the same query with the same viewer. A Redis tier was rejected on measurement, not principle: a warm Upstash round trip (222 ms) is the same order as the Pinecone call it would be saving. |
| Pinecone read-path breaker | `search/pineconeClient.js` | **safe — performance only.** Each instance discovers an outage for itself, at a cost of three timeouts. Sharing it would let one instance's bad minute suppress another's working searches, which is worse than the duplication. |
| Trigram index usability | migration 064 | **safe — it is schema, not state.** Every instance queries the same indexes. `bin/verify-search-indexes.mjs` answers whether they exist on the database rather than on any one instance. |
| `lastBackupAlertAt` | `alerting.js` | **safe** — an alert-dedupe timestamp. N instances means up to N copies of a backup alert. Noisy, never wrong, and the alert is rare. |
| Legal content cache | `legalContent.js` | **safe** — derived from files on disk and hash-verified at boot. Every instance computes the same answer. |
| Weather / geocode caches | their route files | **shared — done.** Two tiers: the in-process cache is still first, with Redis behind it, so a deploy no longer discards a warm cache. |
| Travel-time cache | `routes/travelRoutes.js` | **safe, and deliberately NOT shared.** Its key derives from a minor's location, and that module promises the coordinate is never persisted. `redis.privacy.test.js` fails the build if this route ever imports `server/redis/`. |
| Telemetry sink and buffers | `telemetry.js`, `telemetrySink.js` | **safe** — each instance ships its own records, which is what a per-instance access log should do. |
| OpenTelemetry SDK, tail sampler, meters | `observability/` | **safe** — a per-process exporter is what the collector expects; traces are correlated by trace id, not by process. Instance identity rides on the resource attributes. |
| Pinecone config cache, SMTP provider handle, outbox handle | `search/pineconeConfig.js`, `emailService.js` | **safe** — connection handles and parsed config, per process by nature. |
| Boot flags (`postgresSchemaPending`, `demoSeedPending`, `shuttingDown`) | `db.js`, `shutdown.js` | **safe** — per-process lifecycle, meaningless to share. |
| Async-context connection (`defaultConnection`) | `db/connectionContext.js` | **safe** — the process's own database handle. |
| Worker/scheduler timers and `isRunning` flags | the four workers | **safe now** — each instance runs its own timer, and the leader lease decides which one does the work. |
| Socket.IO adapter pool | `realtime/adapter.js` | **safe** — one per process by construction, and its whole job is to connect them. |

**The rerank budget deserves its own note**, because it is the one item whose
classification depends on a setting. `search/discoverSearch.js` counts Pinecone
rerank calls in memory against a monthly allowance of 500. With N instances that
becomes N × 500 before the soft limit bites.

It is still classified safe, and deliberately not moved:

- Reranking is **off by default** (`PINECONE_RERANK=1` is required).
- Its own header already accepts that a restart resets the counter, for a stated
  reason: the alternative is a database write on the read path of every search.
- The real ceiling is Pinecone's own 429, and a 429 degrades to the unreranked
  order rather than failing the search.

So the honest statement is: if reranking is ever enabled **and** a second
instance is deployed, this needs a shared counter first. Not before.

---

## 4. If a second instance is ever wanted

In order, because each depends on the one before it:

1. **Configure Redis.** `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.
   Without them every shared limiter falls back to a correct PER-INSTANCE
   limiter, which is right for one instance and multiplies across several.
2. **Turn the Socket.IO adapter on** — `REALTIME_ADAPTER=postgres` plus a
   session-mode or direct `REALTIME_ADAPTER_URL`. Built and tested; see above.
3. **Decide the limiter strength.** `RATE_LIMIT_MODE=coordinated` (the default)
   is bounded by `limit + N x (escalateAt - 1)`; `exact` is exactly `limit` for
   any N and costs 3 commands a request, which the Upstash free plan cannot
   carry and a connection-metered provider would not notice.
4. **A shared rerank counter**, but only if reranking is enabled by then.
5. **Re-check `DATABASE_POOL_MAX` against the real concurrency**, not against
   this document. The knee moves with concurrent requests — §5.
6. **Lift the refusal in `instanceLock.js`**, which is one line and must be last,
   not first.

Every step except the last is a setting rather than a build. The scheduler
leases, the job queues, the capacity guard, the realtime adapter, the shared
limiters, the distributed token bucket and the login ceiling are all ready — and
`bin/multi-instance-check.mjs` boots two real instances against one database and
one Redis and asserts it, rather than this document asserting it.

**What is left is a judgement, not an implementation.** Running two instances
means choosing between a bounded approximation and a per-request Redis cost, and
that choice depends on the population and the plan. Both are implemented and
both are tested; the setting is `RATE_LIMIT_MODE`.

---

## 5. Connection pooling under multiple instances

`DATABASE_POOL_MAX` is **per process**, and the default is now **25** (raised
from 10 on a measurement — see `deploy/wevolunteer.env.example` for the sweep).

**The knee moves with concurrency, and that is the part to carry away.** Swept
through a real transaction-mode pooler (pgbouncer standing in for Supavisor),
scenario A, requests per second:

| pool | at 20 concurrent | at 50 concurrent |
|---|---|---|
| 20 | 136 | 125 |
| **25** | 135 | 158 |
| 40 | 134 | 267 |

At the harness's default 20 connections the curve is flat above 20, which reads
as "25 is more than needed" — and that reading is wrong. It is the load
generator's ceiling, not the application's. At 50 concurrent requests the
ordering reverses and more pool is straightforwardly better.

25 is kept because it is right for the modelled concurrency and keeps the
arithmetic intact (8 instances x 25 = the pooler's 200 clients). But a
deployment that genuinely sustains more concurrent requests than this should
re-measure rather than inherit the number.
Two instances open 50 connections, not 25. See
[postgres-cutover-and-rollback.md](postgres-cutover-and-rollback.md) for the
provider's ceilings and how to size against them. The short version, checked
against Supabase's compute documentation on 2026-08-30: the Nano (free) and Micro
sizes allow **60 direct connections and 200 Supavisor pooler clients**, and the
application should use the pooler in transaction mode. Six instances at the
default pool size would sit exactly on the direct ceiling — the arithmetic has
room, but it is not unbounded, and it is per process.
