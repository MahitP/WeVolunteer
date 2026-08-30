# Horizontal scaling

**Status: one instance today, deliberately.** `server/instanceLock.js` refuses a
second production instance and that has not changed. What changed is that the
list of reasons it must is now short, evidenced, and written down.

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

### Socket.IO has no adapter — the one genuine blocker

`realtime/socketServer.js` creates a plain `new Server(httpServer)`. Rooms are
per-process, so with two instances `emitToUser` reaches only the clients attached
to the instance that handled the write. Notifications, messages and read receipts
would be delivered to roughly half the connected users, silently and
unpredictably.

**Deliberately not fixed here.** Every adapter needs a backing store this
deployment does not run, and adding an unused dependency to make a document
tidier is the infrastructure sprawl this whole pass exists to avoid. When a
second instance is genuinely wanted, this is the first thing to build, and the
Redis work on the `claude/wevolunteer-upstash-redis-06b1e9` branch is the natural
home for it — with one caveat carried over from that branch's own measurements:
it records a **222 ms warm round trip** to the database as configured, which an
adapter sitting on the message path cannot afford. A regional database is a
prerequisite there, not a nicety.

> **Forward reference.** `docs/operations/upstash.md` is cited below and is **not
> present on this branch** — it lives on the Redis branch, unmerged. The figures
> quoted from it were read there; if that branch has moved, re-read rather than
> trusting these.

### The rate limiters' STORE is still per-process

Every limiter uses `express-rate-limit`'s default `MemoryStore`. With N instances
each enforces its own copy and the effective limit is N×.

This is a known, costed decision rather than an oversight, and it belongs to the
Redis branch: its `docs/operations/upstash.md` §7.3 measures that sharing the
high-volume limiters would exceed Upstash's 500,000-command free tier somewhere
between 500 and 1,000 users, and that `apiLimiter` alone would be several times
the entire allowance. The keying fix above is orthogonal — it makes the buckets
correct, whoever stores them.

### Other process-local state, and why it is fine

| State | Where | Verdict |
|---|---|---|
| `loginFailures` map | `routes/authRoutes.js` | per-process; N× looser with N instances. Moved to Redis on the Redis branch. |
| `sendBuckets` | `routes/messageRoutes.js` | per-process message throttle; same class as the limiters. |
| Legal content cache | `legalContent.js` | derived from files on disk and hash-verified at boot. Safe: every instance computes the same answer. |
| Weather / geocode / travel caches | their route files | third-party response caches. Safe but wasteful — each instance re-warms. Handled on the Redis branch. |
| Instance lock heartbeat | `instanceLock.js` | the thing enforcing one instance. |

---

## 4. If a second instance is ever wanted

In order, because each depends on the one before it:

1. **A Socket.IO adapter**, on a store with a round trip the message path can
   afford. Until this exists, realtime is broken across instances rather than
   degraded.
2. **A shared rate-limit store**, with the cost table in the Redis branch's
   `docs/operations/upstash.md` §7.3 re-read against the real population — the
   free tier does not carry `apiLimiter`.
3. **Lift the refusal in `instanceLock.js`**, which is one line and must be last,
   not first.

The scheduler leases and the job queues need no further work; they are ready now.

---

## 5. Connection pooling under multiple instances

`DATABASE_POOL_MAX` is **per process**. Two instances at the default of 10 open
20 connections, not 10. See
[postgres-cutover-and-rollback.md](postgres-cutover-and-rollback.md) for the
provider's ceilings and how to size against them. The short version, checked
against Supabase's compute documentation on 2026-08-30: the Nano (free) and Micro
sizes allow **60 direct connections and 200 Supavisor pooler clients**, and the
application should use the pooler in transaction mode. Six instances at the
default pool size would sit exactly on the direct ceiling — the arithmetic has
room, but it is not unbounded, and it is per process.
