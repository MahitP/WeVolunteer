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
in the `scheduler_leases` table (migration 061). The lease is taken by a
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

### The rate limiters' STORE is shared for the security ones, per-process for the volume ones

This was "every limiter is per-process" until the Redis integration merged. It is
now a split, and the split is the interesting part.

**Shared, through `redis/limitStore.js`:** `mailLimiter`, `mailIpLimiter`,
`certVerifyLimiter`, `reauthLimiter`, `appealLimiter` — and, not middleware but
the same class of control, the `loginFailures` counter in `routes/authRoutes.js`.
These survive a restart, which is the property that matters: before, a deploy in
the middle of a password spray handed the attempt a fresh budget.

**Still `express-rate-limit`'s default `MemoryStore`:** `apiLimiter`,
`lookupLimiter`, `errorReportLimiter`, `appealReadLimiter`, `signupLimiter`, and
the per-route limiters in geocode, weather, travel, legal, issues and exports.
With N instances each enforces its own copy and the effective limit is N×.

That is a costed decision, not an oversight. `operations/upstash.md` §7.3
measures sharing the high-volume limiters at more than Upstash's 500,000-command
free tier somewhere between 500 and 1,000 users, with `apiLimiter` alone several
times the entire allowance.

**And the keying fix makes that split more right, not less.** `apiLimiter` is now
keyed on the verified session rather than the address, so the live bucket count
tracks concurrent *users* rather than egress addresses — more buckets, each
smaller, which makes a shared store more expensive rather than less. Store and
key are orthogonal: the key change makes the buckets correct wherever they live,
and it would have been the wrong fix to share the store without it, because that
would have distributed the defect rather than removed it.

The residual risk is bounded and worth naming plainly: these are volume brakes,
not credential controls. Every control that actually limits credential guessing —
`loginFailures`, `mailLimiter` — is in the shared set.

### Other process-local state, classified

Re-audited after the adapter work. Every piece of module-level mutable state in
`server/` was read and placed in one of four boxes.

| State | Where | Verdict |
|---|---|---|
| `loginFailures` counter | `routes/authRoutes.js` | **shared — done.** `createSharedCounter` in `redis/limitStore.js`. Survives a restart, and is the control that actually bounds guessing at one account. |
| `sendBuckets` | `routes/messageRoutes.js` | **must be shared — still open.** A per-process message throttle, same class as the volume limiters, and the one piece of this table that is neither done nor deliberately deferred. |
| `express-rate-limit` stores | five security limiters | **shared — done.** See above for which, and why the rest are not. |
| `express-rate-limit` stores | the volume limiters | **per-process, deliberately.** Costed against the free tier; see above. |
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

1. **Turn the Socket.IO adapter on** — `REALTIME_ADAPTER=postgres` plus a
   session-mode or direct `REALTIME_ADAPTER_URL`. Built and tested; see above.
2. **A shared rate-limit store**, with the cost table in the Redis branch's
   `docs/operations/upstash.md` §7.3 re-read against the real population — the
   free tier does not carry `apiLimiter`. This is the remaining piece of work.
3. **A shared rerank counter**, but only if reranking is enabled by then.
4. **Lift the refusal in `instanceLock.js`**, which is one line and must be last,
   not first.

The scheduler leases, the job queues, the capacity guard and the realtime adapter
need no further work; they are ready now. Step 2 is the only one that is still a
build rather than a setting.

---

## 5. Connection pooling under multiple instances

`DATABASE_POOL_MAX` is **per process**, and the default is now **25** (raised
from 10 on a measurement — see `deploy/wevolunteer.env.example` for the sweep).
Two instances open 50 connections, not 25. See
[postgres-cutover-and-rollback.md](postgres-cutover-and-rollback.md) for the
provider's ceilings and how to size against them. The short version, checked
against Supabase's compute documentation on 2026-08-30: the Nano (free) and Micro
sizes allow **60 direct connections and 200 Supavisor pooler clients**, and the
application should use the pooler in transaction mode. Six instances at the
default pool size would sit exactly on the direct ceiling — the arithmetic has
room, but it is not unbounded, and it is per process.
