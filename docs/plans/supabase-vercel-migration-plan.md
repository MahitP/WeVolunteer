# Supabase / Vercel migration assessment

**Status:** assessment only. Nothing in this document has been implemented.
**Date:** 2026-08-06
**Question it answers:** what would it actually take to run WeVolunteer with the
frontend on Vercel and the backend/database on Supabase, and is that the right
target for launch?

**Short answer:** the frontend can move to Vercel more or less immediately. The
backend cannot move to Supabase without a rewrite whose central task is
converting every database call in the application from synchronous to
asynchronous. That is not a deployment change; it is a port. Recommendation is
**Option C for launch, Option A as a later project** — reasoning in §4.

---

## 1. Current architecture, as measured

| Fact | Measurement |
|---|---|
| Database driver | `node:sqlite` (`DatabaseSync`), a local file |
| Files reaching the database layer | **65** |
| `PRAGMA` statements | **93** across `server/` and `server/migrations/` |
| Versioned migrations | **16**, plus the `addColumnIfMissing` additive path |
| In-process background workers | 3 — `notificationWorker`, `exportWorker`, `retentionWorker` |
| In-process schedulers | 1 — `autoSelectScheduler` |
| Realtime | `socket.io` 4.8 server (`realtime/socketServer.js`) |
| Process model | **exactly one**, enforced by `instanceLock.js` |
| File storage | local filesystem, `0o700` export directory |
| What `deploy/` actually contains | **systemd** units for a Linux host |

There is no `vercel.json`, no Supabase configuration, and no Postgres driver
anywhere in the repository. The stated plan and the built system currently have
nothing in common.

---

## 2. Blockers, in descending order of cost

### 2.1 `node:sqlite` is synchronous — this is the whole migration

Every data access in this codebase is written in the synchronous style the driver
provides:

```js
const row = db.prepare('SELECT …').get(id);
inTransaction(() => { db.prepare('INSERT …').run(…); });
```

Every Postgres client for Node is asynchronous. Porting means every one of those
call sites becomes `await`, which means every function containing one becomes
`async`, which propagates outward until it reaches a route handler — across **65
files**. The mechanical part is large but tractable; the dangerous part is that
it changes concurrency semantics that other code silently depends on.

`instanceLock.js` documents one such dependency in terms: capacity checks read
outside their transaction and are safe *only* because "`node:sqlite` is
synchronous and the handler never awaits, so the read and the write cannot
interleave." Introducing `await` into those handlers reintroduces exactly the
overselling bug that comment says one process prevents. Each such site needs to
be found and given a real transaction or a constraint.

This is the reason a "swap the driver" framing is wrong.

### 2.2 The migration registry is SQLite-specific

Sixteen migrations, checksum-verified on every boot, written against SQLite
semantics. `001_authz_roles.js` is a full table rebuild that exists because
SQLite cannot drop a column — carrying six documented safety guards including a
`PRAGMA foreign_keys` assertion that only means anything in SQLite. In Postgres
that migration is `ALTER TABLE … DROP COLUMN` and the guards are moot.

They cannot be replayed against Postgres. A port needs a single baseline schema
generated from the current one, with `schema_migrations` restarted — and the
checksum system rebuilt around it.

### 2.3 Long-running work has nowhere to run on Vercel or Edge Functions

Three workers and a scheduler run in-process for the life of the server, and
`shutdown.js` drains them before closing the database. `socket.io` needs a
persistent connection with sticky routing.

Serverless functions are request-scoped. Supabase Edge Functions are Deno,
short-lived, and cannot hold a WebSocket server or a drain-on-shutdown lifecycle.
Moving here means replacing the workers with scheduled jobs (`pg_cron`, a queue)
and the socket server with Supabase Realtime — a redesign of four subsystems, not
a redeployment.

### 2.4 Single-instance assumptions become false

`instanceLock.js` enforces one process per database because rate limiting is
in-process memory: the `express-rate-limit` default store plus the
`loginFailures` map in `authRoutes.js`. Any horizontally-scaled host makes the
login brute-force limit, the mail limit, and the certificate-verify limit N×
looser than configured, silently. A shared store (Redis, or a Postgres table) is
a prerequisite for *any* multi-instance deployment, independent of Supabase.

### 2.5 Local filesystem for exports

`exportWorker` writes export archives to a `0o700` directory beside the database
and serves them from disk. Serverless filesystems are ephemeral and not shared
between invocations; this becomes object storage (Supabase Storage or S3), with
signed URLs replacing the current download path — which is itself
capability-gated and step-up-protected, so the replacement has to preserve
`data.download`'s AAL2 gate and its single-use semantics.

### 2.6 Authentication is ours, and should stay ours

Sessions are our own JWT in an HttpOnly cookie, with `users.token_version` for
global invalidation, a `jti` per session, and the whole step-up re-auth system
(`reauth.js`, `sensitiveActions.js`) built on top. Supabase Auth is a different
model. Adopting it would mean rebuilding step-up, the capability spine's
`buildPrincipal` re-read-on-every-request, and OAuth account linking.

**Recommendation: do not migrate auth.** Use Supabase as a database only. Nothing
about moving storage requires changing who issues sessions.

### 2.7 Environment and boot guards

`config.js` fails closed on missing `JWT_SECRET`, incomplete `SMTP_*`, missing
`APP_URL`, `DEMO_MODE` in production, and a loopback `OAUTH_REDIRECT_URI`. These
are asserted at module load. On a serverless host they would run per cold start —
which is fine, but the failure surfaces as a 500 per request rather than a
refused boot, losing the "it will not start misconfigured" property that several
of them exist to provide. On a VPS that property is preserved.

---

## 3. The three options

### Option A — Supabase Postgres + a separate backend host

The Node server keeps running as a long-lived process (Fly, Render, Railway, a
VPS) and talks to Supabase Postgres over the network.

- Requires: §2.1 (the async port), §2.2 (schema baseline), §2.5 (object storage).
- Avoids: §2.3 entirely — workers and sockets keep working unchanged.
- Cost: high, concentrated almost entirely in §2.1.
- Gains: managed backups, PITR, a real concurrent database, and the ability to
  scale past one process once §2.4 is also addressed.

### Option B — Supabase Edge Functions

Infeasible without redesigning the product's runtime. Deno, request-scoped, no
persistent workers, no socket server, no shutdown drain. Every subsystem in §2.3
would be rebuilt, on top of everything Option A requires.

**Not recommended at any horizon.**

### Option C — keep the backend on a VPS

What `deploy/` already builds: systemd units, a backup service and timer, one
process, SQLite on local disk.

- Requires: nothing. It exists and is tested.
- Costs: single point of failure; backups are the operator's responsibility
  (`wevolunteer-backup.timer` exists and needs a verified restore drill); no
  horizontal scaling.
- SQLite is genuinely adequate at this scale. A school volunteering platform is
  not a write-heavy workload, and WAL mode handles concurrent readers fine.

---

## 4. Recommendation

**Launch on Option C. Put the frontend on Vercel now. Treat Option A as a
separate project with its own plan.**

Reasoning:

1. **The frontend move is free and the backend move is not.** `npm run build`
   already produces a static bundle; Vercel hosts it with no code change. The
   only work is pointing it at the API origin and adding that origin to the CORS
   allowlist — `app.js` already scopes CORS to `/api`. Do this whenever you like;
   it is independent of everything else here.

2. **§2.1 is a port, and ports are where invariants die.** This codebase's most
   valuable properties are its guards — the authz completeness scan, the legal
   hash chain, the derived-hours invariant, evidence immutability. Rewriting 65
   files' worth of data access immediately before a first launch is the single
   most effective way to break one of them silently. Do it when there is a
   production baseline to regress against, not before there are any users.

3. **Nothing about launching forces the decision.** SQLite on one VPS is a real
   deployment, already scripted, already documented. The migration buys managed
   backups and headroom — both valuable, neither urgent at zero users.

4. **When Option A does happen, sequence it:** shared-store rate limiting (§2.4)
   → object storage for exports (§2.5) → schema baseline (§2.2) → the async port
   (§2.1), with auth left alone throughout (§2.6). The first three are
   independently useful and independently testable. The fourth is the one that
   needs a branch, a full suite, and a rollback plan.

---

## 5. What must NOT happen in the meantime

The Privacy Policy's subprocessor table currently says the hosting provider is
"not yet chosen", and adds: *if that row still says not yet chosen, it means the
service is not yet running anywhere that holds your information.*

That statement is accurate today and must stay accurate. **Naming Vercel or
Supabase in a published legal document before the deployment exists would be a
false statement about where user data lives** — the precise failure the policy
audit was performed to eliminate. The table gets updated when the deployment is
real, in the same change that makes it real, and the effective date moves with
it.
