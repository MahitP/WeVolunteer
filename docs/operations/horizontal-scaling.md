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

### The rate limiters' STORE — all of them are shared now, by two mechanisms

This section has said three different things across three passes, which is worth
noting because each change was a measurement rather than a change of mind. It
was "every limiter is per-process". Then it was a split: the security ones
shared, the volume ones not, on the arithmetic below. It is now a split between
two ways of sharing, and nothing is left unshared by accident.

**Exact sharing** (`redis/limitStore.js`) — every increment metered, 3 commands
each. Used where a limiter ticks rarely and the thing it bounds is abuse:
`mailLimiter`, `mailIpCeilingLimiter`, `verifyLimiter`, `reauthLimiter`,
`appealLimiter`, `signupLimiter`, `appealReadLimiter`, `errorReportLimiter`,
`lookupLimiter`, `exportLimiter`, `issueLimiter`, `reportLimiter`,
`applicationLimiter`, `checkinScanLimiter`, `checkinCodeLimiter` — and the
`loginFailures` counter, which is not middleware but is the control that
actually bounds guessing at one account.

`checkinCodeLimiter` deserves its name in that list. Guessing a check-in code is
credential guessing, so it is metered exactly rather than approximately, even
though it looks like a volume limiter from the route table.

**Approximate sharing** (`redis/volumeLimit.js`) — exact locally, reconciled
through Redis only once a caller approaches the ceiling. Used for `apiLimiter`
and the message send throttle, and the reason is arithmetic:

> `apiLimiter` allows 600 requests a quarter hour and sits on every `/api` call.
> At the traffic modelled in [`upstash.md`](upstash.md) §7.3 — about 2,200 API
> requests per user per month — metering each one costs 3 commands, so **6,600
> commands per user per month**. The free plan is 500,000 a month, which at
> 1,000 users is 500 per user. The naive design is off by more than **thirteen
> times**. No amount of pipelining fixes a factor of thirteen.

So the volume limiters keep an exact local count, share nothing below a
threshold, and above it report in batches taking `max(local, shared)` — which
can only tighten a limit, never loosen one. At the ceiling, refusal is decided
locally, so a caller being refused cannot drain the allowance by knocking.

**What this guarantees, honestly.** It is not exact across instances. Each
instance may serve up to `escalateAt - 1` unreported requests, so the global
ceiling is bounded by `limit + N x (escalateAt - 1)` against `N x limit` before.
Measured on two real backend instances with `bin/multi-instance-check.mjs` at a
limit of 60: instance A allowed 59, instance B then allowed 19, **combined 78
against a bound of 88 — where two independent limiters would have allowed 120.**

That trade is right for a volume brake and wrong for a credential control, which
is why the credential controls are in the exact list.

**Still per-process, deliberately:** `authLimiter`, `loginLimiter` and
`loginIpCeilingLimiter`. All three set `skipSuccessfulRequests`, which bills an
increment on every request and a decrement on every success — so the common case,
somebody signing in correctly, is the expensive one, and sharing them comes to
107% of the monthly allowance at 1,000 users on its own (upstash.md §7.3). They
are the per-device layer over `loginFailures`, which IS shared.

**And the keying interacts with this.** `apiLimiter` is keyed on the verified
session rather than the address, so the live bucket count tracks concurrent
users rather than egress addresses — more buckets, each smaller. That makes
sharing more expensive, not less, which is another reason the volume path
coordinates on approach instead of on every request.

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
| `checkinScanLimiter`'s token bucket | `checkinLimiters.js` | **per-process, deliberately.** A token bucket — burst capacity plus sustained refill — not a fixed window, so the shared store cannot express it without changing the policy. Keyed per organizer device, and it protects a kiosk from a scanner held down rather than an account from being guessed at. On a second instance this becomes per-instance burst; a distributed token bucket is expressible in Lua if that ever matters. |
| `typingBuckets` | `realtime/socketServer.js` | **safe, and not what its name suggests.** Declared inside the per-connection handler, so it is per SOCKET rather than per process — a user with two tabs gets two typing budgets today, on one instance. Typing indicators are ephemeral and unlogged; distributing them would cost commands to bound something nobody can abuse meaningfully. |
| Nominatim pacing reservation | `redis/upstreamThrottle.js` | **shared — done.** The limit is one request per second *for this application in total*, so a per-process reservation was wrong with one instance too. |
| Rerank budget (`rerankMonth`, `rerankSpent`) | `search/discoverSearch.js` | **safe today, would need attention if reranking is ever switched on.** See below. |
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
   limiter, which is right for one instance and multiplies for several. This is
   now a setting, not a build.
2. **Turn the Socket.IO adapter on** — `REALTIME_ADAPTER=postgres` plus a
   session-mode or direct `REALTIME_ADAPTER_URL`. Built and tested; see above.
3. **Lower `escalateAt` if the approximation is too loose for the population.**
   The volume limiters' bound is `limit + N x (escalateAt - 1)`; the default
   threshold is a quarter of the limit. Halving it halves the slop and roughly
   doubles the commands spent by heavy callers. Re-read upstash.md §7.3 against
   the real population before moving it.
4. **A shared rerank counter**, but only if reranking is enabled by then.
5. **Re-check `DATABASE_POOL_MAX` against the real concurrency**, not against
   this document. The knee moves with concurrent requests — §5.
6. **Lift the refusal in `instanceLock.js`**, which is one line and must be last,
   not first.

Everything above except step 6 is now a setting rather than a build. The
scheduler leases, the job queues, the capacity guard, the realtime adapter and
the shared limiters are all ready — and `bin/multi-instance-check.mjs` boots two
real instances against one database and one Redis and asserts it, rather than
this document asserting it.

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
