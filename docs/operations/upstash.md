# Upstash Redis

**Status:** implemented, optional, off by default.
**Free-tier figures read:** 2026-08-28 (Upstash pricing and documentation).
**Live validation against a real database:** not yet performed — see
[Owner actions](#owner-actions).

WeVolunteer uses Upstash Redis for two things, and deliberately not for a third
list of things that Redis is famous for. This document is the whole picture: why
it exists, what it holds, what happens when it disappears, and what it costs.

---

## 1. Why Redis exists here

Two problems, and neither of them is "the database is slow".

**The login-failure counter was a bare `Map`.** `instanceLock.js` says so in terms:
"every throttle is in-process memory — the `express-rate-limit` default store
plus the `loginFailures` map in authRoutes." That is correct for exactly one
process, and it has one property nobody chose: **a restart clears it.** A deploy
in the middle of a password spray hands the attempt a fresh budget, and an
account two failures from lockout goes back to ten. Those counters are also the
things a second application instance would silently double, which is why
`docs/plans/supabase-vercel-migration-plan.md` §4.4 names shared-store rate
limiting as the *first* prerequisite for running more than one instance.

**Third-party lookup caches died on every deploy.** The weather and geocode
routes each kept an in-process `Map`. Emptying the geocode cache and re-warming
it costs minutes of pressure against Nominatim's published limit of **one
request per second for this application in total** — and the consequence of
breaching that is not a 500, it is OSM blocking the User-Agent for every school
at once.

### 1.1 Why nothing else moved to Redis

The measurement that decided it, from
[`postgres-scale-measurements.md`](postgres-scale-measurements.md), at **50×
pilot scale**:

| query | p95 |
|---|---|
| unread notification count | 0.3 ms |
| my applications | 0.5 ms |
| event roster | 0.4 ms |
| spots remaining per slot | 2.0 ms |

An Upstash call is an HTTPS round trip to another host. Putting any of those
behind it makes them **slower**, adds a dependency that can fail, and spends a
metered allowance to do it. "Cache the hot reads in Redis" is the intuition this
integration exists to have measured and rejected.

`npm run redis:ping` prints the measured round trip beside those numbers, so the
comparison is available on the deployment rather than only in this document.

---

## 2. What is in Redis, and what is in SQL

**The relational database is authoritative for everything.** Nothing in Redis is
a source of truth, nothing is read as one, and every key is reconstructible by
doing the work again. `server/redis.privacy.test.js` enforces that structurally:
no module under `server/redis/` may import the database.

| Concern | Source of truth | Redis holds |
|---|---|---|
| Users, events, applications, attendance, hours | SQL | nothing |
| Messages, conversations, unread state | SQL | nothing |
| Sessions and revocation (`revoked_sessions`, `token_version`) | SQL + the JWT | nothing |
| Leaderboard rankings | SQL, derived per read | nothing |
| Two-factor attempt counters (`tfa_login_attempts`) | SQL | nothing |
| Sign-in failure counts | — (ephemeral) | the counter |
| `express-rate-limit` windows | — (ephemeral) | the counters |
| Weather forecasts (Open-Meteo) | the vendor | a cached copy |
| Address lookups (Nominatim) | the vendor | a cached copy |
| The Nominatim pacing reservation | — (ephemeral) | one timestamp |

---

## 3. The keyspace

The free plan allows **one database per account**, so development, test and
production share a keyspace. The prefix is the only thing separating them, and
it is therefore load-bearing rather than tidy. It defaults to `NODE_ENV`
(`server/redis/redisConfig.js`), so a developer who sets only the credentials
cannot write test counters into production's.

```
wev:{env}:{domain}:{...}
```

| Key | Type | TTL | Written by | Contents |
|---|---|---|---|---|
| `wev:{env}:cache:weather:{sha256(lat,lon,hour)}` | string (JSON) | 1 h | `routes/weatherRoutes.js` | a forecast |
| `wev:{env}:cache:geocode:{sha256(query)}` | string (JSON) | 24 h | `routes/geocodeRoutes.js` | a list of public places |
| `wev:{env}:rl:{limiter}:{sha256(client)}:{window}` | counter | window + 5 s | `redis/limitStore.js` | an integer |
| `wev:{env}:cnt:login-failure:{sha256(account)}` | counter | 15 min from the first failure | `routes/authRoutes.js` | an integer |
| `wev:{env}:throttle:nominatim` | string (ms) | 3 s | `redis/upstreamThrottle.js` | one timestamp |
| `wev:{env}:validation:*` | mixed | 10 s | `bin/upstash-redis.mjs validate` | test values, deleted on exit |

**Every caller-supplied key segment is hashed** (`hashSegment`, sha256 truncated
to 128 bits). Two reasons, and the second is the one that matters: hashing
removes every character that could change the command being sent, and a
rate-limiter key built from an email address would otherwise make the keyspace a
list of who tried to sign in, stored on somebody else's infrastructure.
`redis.privacy.test.js` scans every key-construction site for this.

**Nothing is written without a TTL.** On a 256 MB shared plan a key that never
expires is not a leak, it is the whole budget. That is why the counter
increments are Lua scripts rather than `INCR` followed by `PEXPIRE` — a pipeline
interrupted between the two leaves a counter that never resets.

### 3.1 Invalidation

There is none to get wrong, by design. Every key expires on its own TTL and
nothing depends on being told that the underlying data changed. That is a direct
consequence of the rule in §2: none of these keys mirrors a database row, so
there is no row whose update could leave one stale.

---

## 4. Rate limits

Five limiters and one hand-rolled counter use the shared store.

| Control | Limit (production) | Window | Key | Counts |
|---|---|---|---|---|
| **login-failure throttle** | `LOGIN_FAILURE_LIMIT`, default 10 | 15 min from the first failure | account | failed passwords |
| `mailLimiter` | `MAIL_RATE_LIMIT`, default 5 | 15 min | target address | every send |
| `mailIpCeilingLimiter` | `MAIL_IP_CEILING`, default 120 | 15 min | IP | every send |
| `verifyLimiter` | 20 | 15 min | IP | every check |
| `reauthLimiter` | `REAUTH_RATE_LIMIT`, default 5 | 15 min | IP | failures |
| `appealLimiter` | 5 | 15 min | IP | every filing |

The login-failure throttle is first in that list because it is the one that
matters most: it caps ten failed passwords per **account** across every device,
it is keyed on the resolved account rather than on what was typed, and it was
the only one of these that lived in a bare `Map` with no durability at all.

**Deliberately still in process memory**, each with a note at its definition in
`server/app.js`:

| Control | Why not shared |
|---|---|
| `authLimiter`, `loginLimiter`, `loginIpCeilingLimiter` | **The measured decision, and the most important one here.** These were the obvious candidates. They sit on the highest-volume authentication paths (`/api/auth/login`, `/api/oauth`, signup, reset) and all three set `skipSuccessfulRequests`, which bills an increment on every request *and* a decrement on every success — so the common case, somebody signing in correctly, is the expensive one. At the traffic modelled in §7.3, sharing them costs ~536 commands per user per month against an allowance of 500,000: **107% of the monthly budget at 1,000 users, before anything else spends a command.** Leaving them in memory brings the whole integration to ~98. What is given up is the per-device layer, which a single-instance deployment already enforces correctly; the per-account layer that actually bounds guessing is shared. |
| `apiLimiter` (600 / 15 min / device) | The highest-volume limiter in the application. Metering it would spend the monthly allowance in an afternoon and then fail open for everything else. |
| `lookupLimiter` | Counts availability probes at keystroke volume during signup. |
| `errorReportLimiter` | A broken build makes every client report at once — precisely when spending the allowance would be worst. Storage is bounded durably by `errorReporter.js`. |
| `appealReadLimiter` | Counts page *reads*, which it is deliberately generous about. |
| geocode / weather / travel / legal / issue / export limiters | Per-route volume controls, not credential controls. |
| socket typing bucket | Per-connection and ephemeral by nature. |

### 4.1 The window semantics, which differ on purpose

The `express-rate-limit` stores use **epoch-aligned fixed windows**, so the reset
time is arithmetic and costs no command, and two instances agree on the boundary
without coordinating. That matches `express-rate-limit`'s own `MemoryStore`,
which expires keys on a shared timer.

The login-failure counter uses a **window measured from the first failure**,
because copying the aligned scheme would have weakened it: ten failures at 14:59
would unlock at 15:00. That is why its script pays for an extra `PTTL`.
`redis.limitStore.test.js` asserts both behaviours.

---

## 5. Sessions, chat and the leaderboard — why they did not move

Recorded here because the obvious next question is "why not those too", and the
answers should not have to be rediscovered.

**Sessions stay as they are.** WeVolunteer already has per-session revocation: a
`jti` per session, a `revoked_sessions` table, `users.token_version` for
account-wide invalidation, and the step-up re-authentication system built on
top. Moving the revocation check to Redis would add a network round trip **to
every authenticated request** and make sign-in depend on a third party's uptime,
to replace an indexed local read. Strictly worse on every axis.

**Chat stays in SQL.** Durable messages belong in the relational database and
this is not a close call: retention, deletion, subject-access export and
moderation are all built on those rows. Redis could plausibly carry realtime
*transport* — but with one application instance `io.emit` already reaches every
client, in-process, faster, and without an outage that could drop a message.

**The leaderboard stays in SQL.** `GET /api/leaderboard` is double-opt-in
(`leaderboard_opt_in` **and** `hours_visibility` not private), excludes deleted
accounts, returns no school or grade, requires a session, and is `LIMIT 25`. A
Redis sorted set would be a derived index that can drift from the hours ledger —
against `INV-001`, the rule that credited hours are derived on read and never
stored — to fix a scan that an index fixes for free. Two genuine defects were
found while reading it and are logged as separate work: the tie-break is
non-deterministic, and there is no index on `users(role, leaderboard_opt_in)`
(audit finding P-2).

**Travel time is excluded from the cache, and this is the most important
exclusion.** `routes/travelRoutes.js` promises that a volunteer's origin — a
minor's location — is "never persisted. No column, no row, nowhere." Hashing the
key does not rescue it: the promise is about where the data goes, not how it is
encoded, and a hash still answers "was this exact journey looked up". That route
keeps a process-local cache that dies with the process, and
`redis.privacy.test.js` fails the build if it ever imports `server/redis/`.

---

## 6. Failure behaviour

**Redis is never required to serve a request.** Every caller has a correct answer
without it, which is what makes the following safe.

| Subsystem | Redis unavailable |
|---|---|
| Transport | One failure opens a circuit breaker for 30 s. While open, calls return immediately instead of waiting 800 ms — an outage costs one timeout per window, not one per request. |
| Weather / geocode cache | A miss. The route calls upstream exactly as it would with no cache at all. Writes still land in the in-process tier, so an outage costs an entry's durability, not the entry. |
| Rate limiters | Fall back to an in-process counter **that has been incremented in lockstep all along**, so a fallback is today's behaviour resuming rather than a reset. |
| Login-failure throttle | Same. A lockout in progress is not cleared by an outage. |
| Nominatim reservation | Adds nothing; the unchanged process-local reservation still applies, so the guarantee degrades from application-wide back to per-process. |
| Admin status panel | Reports `degraded: true`. |

Two rules govern all of it:

- **Never fail closed.** A school locked out of sign-in because Upstash had a
  bad minute is a worse outcome than the attack the limiter exists to stop.
- **Never fail silently open.** The in-process counter never stopped counting,
  so the limits are still enforced — at their pre-Redis strength.

`server/redis.limitStore.test.js` and `redis.lookupCache.test.js` assert both
against an injected fault. `redis.client.test.js` asserts that no failure shape —
HTTP error, network error, timeout, unparseable body, refused command — can
produce a thrown exception, because `express-rate-limit` turns a rejected store
promise into a 500 on `/api/auth/login`.

---

## 7. Cost, and the free tier

### 7.1 The documented limits

| Resource | Free plan | Consumed by |
|---|---|---|
| Commands | **500,000 / month** | every command, *including each command inside a pipeline or a Lua script* |
| Storage | 256 MB | all keys |
| Bandwidth | 10 GB / month | request + response bytes |
| Databases | **1** | — |
| Max commands / second | 10,000 | — |
| Max request / record | 10 MB / 100 MB | — |
| Idle policy | archived after **≥30 days** with no traffic; data is backed up first, and restorable from the console | — |

> **One documented conflict.** Upstash's pricing page says 500K commands per
> month; its FAQ page still says "10,000 requests per day" (≈300K/month). The FAQ
> appears stale, but this integration is sized against the tighter figure, so it
> does not matter which is current. Re-read both if the design ever approaches
> the ceiling.

**Use a regional database, never global.** Upstash replicates writes to read
regions and **counts each replication as a command**, so one read region doubles
the spend for a deployment that is one server in one place.

### 7.2 What this integration costs per operation

Measured as commands, the way Upstash bills:

| Operation | Commands | When it happens |
|---|---|---|
| Limiter check (`increment`) | 2–3 | a mail send, an appeal, a re-authentication failure, a certificate check |
| Limiter `decrement` (skipped success) | 2–3 | only on `reauthLimiter`, and only on success |
| Login-failure `peek` | **1** | every sign-in attempt |
| Login-failure `peek`, after a restart while an account is locked | 2 | rare — see below |
| Login-failure `hit` | 3–4 | a wrong password |
| Login-failure `clear` | 1 | a successful sign-in |
| Cache read (L1 miss) | 1 | a forecast or address not already in process memory |
| Cache write | 1 | after an upstream call |
| Nominatim reservation | 3 | only on a geocode cache miss |

`peek` runs on every sign-in attempt, which makes it the most frequent Redis
call in the application, so it is deliberately one command rather than the
obvious `GET` + `PTTL` pipeline. The exact reset time is only ever *used* to
write "try again in about N minutes", so the second command is paid only when
the count is non-zero and this process has no local record of the window — which
means after a restart, for an account that is mid-lockout. Guessing instead
would overstate the wait to somebody who is locked out, which is the wrong
direction for a message a person reads.

### 7.3 Estimated monthly usage

**These are estimates, clearly marked as such.** The documented limits above are
facts; the traffic model below is an assumption, stated so it can be checked
against the console rather than believed.

Assumptions per user per school day: 1.2 sign-in attempts (10% of them failing),
0.15 mail-sending actions, 3 weather views, 0.3 address lookups; 22 school days
a month; an in-process cache hit rate of 80% for weather and 90% for geocode.
That works out at **~98 commands per user per month**.

| Users | As built | Against 500,000 | If the three sign-in limiters were also shared |
|---|---|---|---|
| 20 | ~2,000 | 0.4% — comfortable | ~10,700 (2%) |
| 50 | ~4,900 | 1.0% — comfortable | ~26,800 (5%) |
| 100 | ~9,800 | 2.0% — comfortable | ~53,600 (11%) |
| 250 | ~24,400 | 4.9% — comfortable | ~134,000 (27%) |
| 500 | ~48,800 | 9.8% — comfortable | ~268,000 (54%) — **warning** |
| 1,000 | ~97,600 | 19.5% — comfortable | ~535,800 (107%) — **exceeded** |

The right-hand column is the version of this integration that was built first
and then measured. It is kept here because it is the whole argument for §4's
scoping: the intuitive choice — share every security limiter — breaks the free
plan somewhere between 500 and 1,000 users, and does so by spending most of the
allowance on *successful* sign-ins.

**As built, the first bottleneck is not the command allowance.** At 1,000 users
this uses a fifth of it, and storage and bandwidth are nowhere near their limits
(a few thousand small keys against 256 MB). The constraint that binds first is
the one in §7.1 with no headroom at all: **one database**. A second environment —
a staging deployment that is not simply a prefix on the same instance — needs a
paid plan or a second account.

The other thing that would change the picture is migrating a high-volume
limiter, which is why §4 lists what stayed in memory and why. `apiLimiter` alone
at 1,000 users would be several times the whole table above.

### 7.4 Guardrails already in place

- Bounded TTLs on every key; no key can be created without one.
- The in-process tier absorbs the common case, so quota is spent only on genuine
  misses.
- A circuit breaker, so an outage cannot turn into a retry storm.
- The high-volume limiters were deliberately not migrated.
- `bin/upstash-redis.mjs validate` cleans up every key it writes, including
  after a failure.

---

## 8. Setup

### 8.1 Local development

Nothing to do. With the variables unset the application behaves exactly as it
did before Redis existed, and the whole test suite runs in that state.

To exercise the Redis paths locally, create a free database (§8.2) and put the
two variables in `.env`. **Do not point a development machine at the production
database** — the free plan has only one, so the separation is the key prefix, and
running with `NODE_ENV=development` is what keeps you out of production's
counters.

### 8.2 Creating the database

1. Sign in at <https://console.upstash.com>.
2. **Create Database.** Choose **Regional**, not Global — see §7.1.
3. Pick the region nearest the application host. This is the single biggest
   factor in the latency `npm run redis:ping` will report.
4. Leave eviction **off**. Nothing here should be evicted under pressure; every
   key has a TTL and the working set is a few megabytes.
5. Open the **REST API** tab and copy `UPSTASH_REDIS_REST_URL` and
   `UPSTASH_REDIS_REST_TOKEN`.
6. Put both in `/etc/wevolunteer/wevolunteer.env` (mode 0600, root-owned) —
   never in the repository, and never in `.env.production`, which is compiled
   into the browser bundle.
7. Restart the service and run the validation below.

### 8.3 Validating

```bash
npm run redis:status     # configuration, prefix, plan limits — no network call
npm run redis:ping       # reachability and round-trip latency
npm run redis:validate   # end-to-end: set/get/TTL/expiry/counter/script/pipeline
npm run redis:keys       # what this environment currently holds
```

`validate` spends roughly twenty commands out of 500,000 and deletes every key
it writes, including after a failure. It is the command to run immediately after
creating the database, and again after rotating the token.

### 8.4 Rotating the token

Rotate in the Upstash console, update
`/etc/wevolunteer/wevolunteer.env`, restart, then `npm run redis:ping`. A stale
token surfaces as `http_401` from every call — and because every caller falls
back, **the application keeps working**, which means nothing will page you. The
admin status panel's `degraded` flag is what shows it.

---

## 9. Monitoring

`GET /api/admin/system/status` (capability `analytics.school`) includes a
`redis` object: whether it is configured, whether it is currently degraded, this
process's command and latency counters since boot, the plan limits, and per-cache
hit rates. **Counts and configuration only** — no key names, no key contents, no
identifiers, and never the token. `server/redis/status.js` owns that decision so
the route cannot become a second place that makes it.

It is deliberately **not** on `/health`, which is unauthenticated. "The shared
rate-limit store is down" is knowledge that the limits have fallen back to
per-process, and that is not something an anonymous caller should be able to
poll for.

The authoritative monthly usage figure is on the Upstash console. The process
counter resets on every restart and only ever describes one process.

---

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `not available to this process (unconfigured)` | Neither variable is set | Expected on a deployment not using Redis |
| `(incomplete)` | One of the pair is set | Set both, or neither — half a configuration produces a 401 on every call, which looks like a revoked token |
| `(insecure_url)` | URL is not `https` | The token is a bearer credential; it is refused rather than quietly upgraded |
| `http_401` | Wrong or rotated token | Re-copy from the console's REST API tab |
| `http_429` | The plan's per-second ceiling | Not reachable at this application's volume; check for a runaway caller |
| `timeout` on every call | Region far from the host, or Upstash degraded | Compare `npm run redis:ping` with §1.1; consider a nearer region |
| `degraded: true` in the status panel | Breaker open | Rate limits are enforced per-process meanwhile; nothing is broken for users |
| Database vanished from the console | ≥30 days idle → archived | Data is backed up; restore from the console. Nothing here is a source of truth, so a fresh empty database is also a complete recovery |

---

## 11. Rollback

Unset `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`, and restart.

That is the whole procedure. Every limiter returns to its in-process counter,
both caches return to their in-process tier, the Nominatim reservation returns to
its process-local timestamp, and the status panel reports `configured: false`.
**No data is lost, because no data lives there** — the keys left behind expire on
their own TTLs, or can be removed with `node bin/upstash-redis.mjs purge --yes`.

There is no migration to reverse: this change added no tables, no columns and no
schema of any kind.

---

## 12. Owner actions

1. **Create the Upstash database** (§8.2) and add the two variables to
   `/etc/wevolunteer/wevolunteer.env`.
2. **Run `npm run redis:validate`** on the host and keep the output. Until that
   has run against a real database, the live-validation step of this work is
   unfinished — everything here has been verified against an in-process double
   and fault injection, which proves the logic and not the vendor.
3. **Record the measured latency** from `npm run redis:ping` in §1.1, so the
   comparison against the 0.3–0.5 ms database figures is a measurement on this
   deployment rather than an estimate.
4. **Add Upstash to the Privacy Policy's subprocessor table** before it holds any
   production traffic. It will hold hashed rate-limit keys, cached public
   forecasts and cached public address lookups — no names, no emails, no
   messages, no service history — but it is a processor and the table must be
   accurate. See the constraint recorded in
   `docs/plans/supabase-vercel-migration-plan.md` §5.

---

## 13. Deferred, with the trigger that would justify it

| Feature | Trigger |
|---|---|
| Socket.IO Redis adapter | A second application instance. Needs a persistent TCP connection, so it is a different transport from everything here. |
| Migrating `apiLimiter` and the volume limiters | A paid plan, or a second instance making per-instance limits wrong enough to justify the cost. |
| A distributed lock replacing `instanceLock.js` | Multi-instance, with leader election for the workers and the auto-select scheduler. |
| Cached leaderboard or impact snapshots | A population in the thousands *and* a measurement showing the aggregate past ~100 ms. |

---

## See also

- [`ENGINEERING_GUIDE.md`](../ENGINEERING_GUIDE.md) §10.2 — the adoption decision
- [`postgres-scale-measurements.md`](postgres-scale-measurements.md) — the query timings that shaped it
- [`pinecone.md`](pinecone.md) — the sibling integration this one copies its shape from
- [`betterstack.md`](betterstack.md) — the other optional third-party service
