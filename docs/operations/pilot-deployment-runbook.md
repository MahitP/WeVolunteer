# WeVolunteer — Pilot Deployment & Operations Runbook

**Document version:** 1.1
**Written:** 2026-07-26 · **Revised:** 2026-07-31 (release-preparation pass)
**Audience:** the engineer responsible for deploying and operating WeVolunteer, who has never seen this project before.
**Status of the code this revision describes:** the `v1.1-security-accessibility-ux` working tree as prepared for release on 2026-07-31.

> ### ⚠ Read this before trusting any earlier copy of this document
>
> Version 1.0 was pinned to `main` @ `8604fe3` — **a commit that no longer exists in
> this repository** (`git cat-file -t 8604fe3` → *"Not a valid object name"*). It had
> drifted five days and ~47 commits behind the code, and several of its statements
> were not merely stale but wrong in ways that would have changed an operator's
> decisions. Corrected in this revision:
>
> | v1.0 said | Reality | Why it mattered |
> |---|---|---|
> | `API_PORT`: "the bind address is hardcoded to `127.0.0.1`" | The server binds **`0.0.0.0`** by default (`server.js`) | An operator had no reason to firewall the port. On a host with a public IP the app was directly reachable, bypassing nginx, TLS and HSTS. Now configurable via `BIND_ADDRESS`, and §3 covers the firewall requirement. |
> | `REQUIRE_EMAIL_VERIFICATION` "defaults to `false`" | Defaults to **`true`** (`config.js`) | An operator would not prove SMTP before inviting students, then every signup gates behind an untested email. |
> | §14 M2: "helmet is configured with `contentSecurityPolicy: false` … set CSP at the reverse proxy" | The app ships a **full CSP** (`app.js`) | Following it adds a second CSP header; the two policies intersect and can break the app. |
> | §14 H1: "no backup automation in this repository" | `deploy/wevolunteer-backup.{service,timer}` + `bin/backup.sh` ship with it | An operator would rebuild what already exists. |
> | §14 H6: "Email is not the notification channel; the app is … in-app only" | Notifications **do** send email, via the `notification_jobs` outbox | Wrong expectation set with students and staff. |
> | §14 H3: "no error boundary anywhere in `src/`" | `src/components/ErrorBoundary.jsx` exists and is used in three places | Understated the client's resilience. |
> | §14 M1: "`APP_URL` … not checked at startup" | `email.js` exits(1) without it in production | — |
> | §15: "241 tests pass" | **963** tests pass | — |
> | §4 documented `MAX_AUTO_SELECT_APPLICANTS` and `SCHOOL_NAME` | Both removed as dead exports (`config.js`) | Suggested knobs that do nothing. |
>
> OAuth was **entirely absent** from v1.0 — zero mentions in 2,954 lines — while the
> code refuses to boot in production if a provider is configured without
> `OAUTH_REDIRECT_URI`. See the new §4a.

Everything in this document was derived by reading the code at that commit and by
actually running it — the test suite, a production build, and a real production
boot against a throwaway database. Where a claim was verified by execution, it
says so. Where something is a recommendation rather than a fact about the code,
it says that too.

> **Scope note.** This document does not implement anything. The Product Quality
> Roadmap (`docs/superpowers/plans/2026-07-25-product-quality-roadmap.md`) is
> written but **not implemented**; several of its findings appear below as
> operational risks precisely because they are still open.

---

## Table of contents

1. [Executive summary](#1-executive-summary)
2. [Architecture overview](#2-architecture-overview)
3. [Production requirements](#3-production-requirements)
4. [Environment variables](#4-environment-variables)
5. [Initial deployment procedure](#5-initial-deployment-procedure)
6. [Database operations](#6-database-operations)
7. [Backup strategy](#7-backup-strategy)
8. [Email operations](#8-email-operations)
9. [Security checklist](#9-security-checklist)
10. [Production smoke test](#10-production-smoke-test)
11. [Monitoring](#11-monitoring)
12. [Incident response](#12-incident-response)
13. [First pilot checklist](#13-first-pilot-checklist)
14. [Known operational risks](#14-known-operational-risks)
15. [Launch readiness assessment](#15-launch-readiness-assessment)

---

## 1. Executive summary

### What is being deployed

The `v1.0.0-pilot` release (`7fc79cd`), plus one documentation-only commit
(`8604fe3`) on top. There is no code difference between the tag and current
`main` — the only change is the roadmap document. **Deploy `main`.**

Be aware of one cosmetic inconsistency you will trip over immediately:
`GET /health` reports the version from `server/package.json`, so it tracks the
released version automatically. For the exact build, `git rev-parse HEAD` on the
server remains the authoritative answer.

### What the system consists of

A single-process Node.js application serving a React single-page app and a JSON
API from the same Express server, backed by one SQLite file on local disk.
There is no separate database server, no cache, no queue, and no container
orchestration. In production the process binds **loopback only** and must sit
behind a reverse proxy that terminates TLS.

Five things make up a running deployment:

| Piece | What it is |
|---|---|
| Static client | `dist/` — a Vite build of the React app, served by Express |
| API | Express 4, ~60 JSON endpoints under `/api` |
| Database | One SQLite file (`server/wevolunteer.db`) in WAL mode, plus two sidecar files |
| Mail | Outbound SMTP via nodemailer — password reset and email confirmation only |
| Scheduler | An in-process 15-minute `setInterval` that writes reminder notifications |

### What has already been verified

Verified by running it, on 2026-07-31, against the release-preparation working tree
(the 2026-07-26 figures at commit `8604fe3` are superseded):

- **Test suite: 963 tests across 81 files, all passing** (`npm test`, ~19s wall
  clock). Coverage spans auth and sessions, privacy/PII scoping, rate limiting,
  email verification, the case-insensitive email dedupe migration, attendance
  and check-in, the hours ledger and its parity invariant, certificates,
  Auto Select, payload validation, malformed-input handling, SQLite pragmas,
  route ordering, and the production SMTP boot policy.
- **Production client build succeeds**: `dist/assets/index-*.js` 476.09 kB
  (130.35 kB gzipped), CSS 41.60 kB (8.51 kB gzipped), built in 284 ms.
- **Production startup guards all fire correctly** (each observed as a
  non-zero exit): missing `SMTP_*` → `FATAL: SMTP is not configured`;
  missing `JWT_SECRET` → `FATAL: JWT_SECRET must be set.` (thrown in every
  environment, not only production);
  `DEMO_MODE=true` with `NODE_ENV=production` → `FATAL: DEMO_MODE cannot be
  enabled in production`.
- **A real production boot on an empty database works**: migrations apply, no
  demo accounts are seeded, the server listens, `/health` returns
  `{"status":"ok","database":"connected"}`, `/` returns the SPA as
  `text/html`, `/api/<unknown>` returns JSON 404 (not HTML), and the demo
  password does not authenticate against anything.
- **The first-admin procedure works**, with a caveat documented in §5.
- **WAL sidecars are real and load-bearing**: on the freshly booted database
  the main `.db` file was 4 KB while `.db-wal` was 519 KB. A backup that copies
  only the `.db` would have captured almost nothing.
- **`node server/verifyHours.js` passes** (ledger/attendance parity), and
  `PRAGMA integrity_check` returns `ok`.

### What has *not* been proven

Everything about real-world usage. Specifically:

- **No real user has ever used this system.** Every test is synthetic; every
  seeded account is fictional. There is no production traffic history.
- **No SMTP provider has ever been connected.** The boot-time SMTP guard is
  tested, but no email has been delivered to a real inbox by this codebase.
  Deliverability, SPF/DKIM alignment, and spam placement are entirely unproven.
- **No real deployment exists.** There is no reverse proxy config, no TLS
  certificate, no process supervisor unit, and no backup job in this repository.
  All of §5 and §7 are procedures to perform, not procedures that have been
  performed.
- **Concurrency at scale is untested.** SQLite in WAL mode with a 5-second
  busy timeout is correct for one process; nothing has been load-tested. There
  is no evidence about what happens with 200 students refreshing during a
  selection announcement.
- **The full event lifecycle has never run against wall-clock time.** Tests
  manipulate dates; no event has actually gone open → deadline → Auto Select →
  attendance → certificate over real days.
- **Accessibility and mobile usability are known-incomplete**, not merely
  unproven — see §14.

---

## 2. Architecture overview

### Frontend

React 19 + Vite 8, `react-router-dom` 7 with `BrowserRouter`, `lucide-react`
icons, and one hand-written stylesheet (`src/index.css`) implementing the
"Field Notes" design system. No UI framework, no state library — `App.jsx`
holds `currentUser`, `events`, `applications`, and `favorites`, and a
`refreshKey` counter re-fetches everything on any mutation.

Routing matters operationally because the app uses **real paths, not hashes**:
`/login`, `/signup`, `/reset-password`, `/events`, `/events/:id/edit`,
`/checkin/:eventId`, `/calendar`, `/notifications`, `/profile`, `/portfolio`,
and the public `/verify/:code`. Any of these can be loaded cold by a user
pasting a link, so the server (or proxy) **must** return `index.html` for
unknown non-API paths. Express already does this when `NODE_ENV=production`
([server/app.js:110-119](../../server/app.js#L110)) — do not add a proxy rule
that 404s them first.

`/verify/:code` is deliberately reachable without a session: it is what a
school office loads to check a printed certificate.

Build-time flags live in `src/config.js`. The important one is `VITE_DEMO_MODE`,
which gates the demo account switcher and one-click seeded logins. It is set
only in `.env.development`, which `vite build` does not read — so a production
bundle cannot contain it.

### Backend

Express 4 on Node, ESM throughout. The composition is deliberate and worth
understanding before you change anything:

- `server/config.js` — every environment-derived value, with **no side effects**.
- `server/app.js` — builds and exports the Express app: helmet, CORS, JSON body
  limit, four rate limiters, six routers, `/health`, the API 404, the
  production static/SPA block, and the error handler (registered last).
- `server/server.js` — the only file that starts anything. It runs the
  production guards, calls `initDatabase()`, kicks off the notification sweep,
  and calls `app.listen(PORT, '127.0.0.1')`.

That split is why route tests can import a router without booting a listener or
touching the production database.

Routers under `server/routes/`: `authRoutes`, `eventRoutes`,
`applicationRoutes`, `attendanceRoutes`, `adminRoutes`, `contentRoutes`.
Domain logic lives in `attendance.js`, `hoursLedger.js`, `certificates.js`,
`weighting.js`, `validation.js`, and `utils.js`.

**The binding address is operationally critical:** `app.listen(PORT,
'127.0.0.1')`. The process is unreachable from any other host. A reverse proxy
on the same machine is mandatory, not optional.

### SQLite database

`node:sqlite`'s `DatabaseSync` — the Node built-in, not `better-sqlite3`. One
file, default `server/wevolunteer.db`, overridable with `WEV_DB_PATH`.

Two pragmas are applied at connection time, before any statement
([server/db.js:29-30](../../server/db.js#L29)):

- `journal_mode = WAL` — readers proceed during writes. **Persists in the file
  header** and creates `-wal` / `-shm` sidecars.
- `busy_timeout = 5000` — the default is `0`, which fails instantly on
  contention. The app is single-process, but boot backfills, the notification
  sweep, and the standalone scripts all open the same file.

Tables: `users`, `events`, `slots`, `applications`, `attendance`,
`attendance_checkin`, `hours_ledger`, `certificates`, `notifications`,
`event_comments`, `event_announcements`, `user_favorites`, `reports`,
`auto_select_runs`, `email_verification_tokens`, `password_reset_tokens`.

**The central invariant:** volunteer hours are never stored on the user row.
Every total in the product is `SUM(hours_awarded) FROM attendance WHERE
present = 1`. `hours_ledger` is an append-only audit log of changes; it is
written but **not read by any hours calculation**. Do not "fix" a disagreement
by editing `attendance` to match the ledger — `attendance` is the source of
truth and the ledger is the record of how it got there.

### Email system

`server/email.js`, nodemailer, two messages only: **email verification** and
**password reset**. Nothing else is emailed. Application results, waitlist
promotions, cancellations, and hours credits are **in-app notifications only**.

Transport selection happens at module import time:

- `SMTP_HOST` + `SMTP_USER` + `SMTP_PASS` all set → a real transport.
- Any missing **and `NODE_ENV=production`** → `process.exit(1)`. This is
  deliberate: the console fallback would print reset tokens to the log and
  deliver nothing.
- Any missing outside production → a console mock that logs the message body.

Both this and the `JWT_SECRET` check run at import time, so the order is
decided by module evaluation order rather than by `server.js`. `config.js` is
imported by `app.js` before the routers that pull in `email.js`, so
**`JWT_SECRET` is checked first**. Verified: with both missing, the error you
see is `FATAL: JWT_SECRET must be set.` Set the secret, and the next boot tells
you about SMTP.

Links are built from `APP_URL`. In production it is **required** — the server
refuses to boot without it (`FATAL: APP_URL must be set in production.`). It
used to fall back to `https://wevolunteer.org`, which meant a deployment that
forgot it kept sending live reset tokens to a domain the operator did not own,
with nothing failing and nothing logged. Development keeps a localhost default.

### Authentication

Email + bcrypt (cost 10) + JWT, 7-day expiry, token in a secure `HttpOnly` cookie under
`wev_session`. `authenticateToken`
([server/utils.js:6-50](../../server/utils.js#L6)) does not trust the token
payload for authorization — it re-reads the user row on every request, so a
deleted account's token stops working and a role change takes effect
immediately.

Session invalidation works through `users.token_version`: the token carries the
version it was minted with, and a mismatch returns 401. Password reset bumps it
(logging out every other session); so does the email-dedupe migration.

Roles are `student`, `organizer`, `admin`. Self-registration is limited to the
first two. Organizers start `verified = 0` and cannot create events until an
admin approves them. Admins can only be made server-side via
`bin/make-admin.mjs`.

Email verification is **off by default** (`REQUIRE_EMAIL_VERIFICATION`). When
on, unverified users are blocked from everything except a four-path allowlist
(`/api/auth/me`, `/api/auth/verify-email`, `/api/auth/resend-verification`,
`/api/notifications`).

### Certificates

One certificate per (volunteer, event) with credited attendance. The code is
`WEV-XXXX-XXXX`, generated from `crypto.randomBytes` and **stored** in the
`certificates` table — it is a bearer credential, not a derivable hash. Codes
are backfilled at every boot for any credited attendance that lacks one, and
issued on demand by `GET /api/certificates`.

Verification is `GET /api/certificates/verify/:code` — unauthenticated by
design (a school office has no account), rate-limited to 20 requests per 15
minutes, a single indexed lookup, and it deliberately omits the student's grade.

> A hard cutover happened before this release: certificates printed under the
> old derivable scheme no longer verify. **For a first pilot on an empty
> database this is irrelevant** — no such certificates exist.

### Notification scheduler

There is no cron and no external scheduler. `server.js` calls
`runNotificationSweep()` once at boot and then every 15 minutes via
`setInterval`. The sweep writes exactly two kinds of notification:

- `deadline` — an event you starred closes within 48h and you have not applied.
- `reminder` — a shift you are confirmed for starts within 24h.

Both are deduplicated by a unique index on `(user_id, dedupe_key)`, so restarts
and re-runs never duplicate.

**Auto Select is not scheduled.** Nothing runs a draw when a deadline passes.
An organizer must click Run Auto Select, then Confirm. If they forget,
applicants sit in `pending` forever and are never told. See §14.

### Static assets

`vite build` writes `dist/` at the repository root. When `NODE_ENV=production`,
Express serves it with `express.static` and falls back to `dist/index.html` for
non-API paths. `public/favicon.svg` and `public/icons.svg` are copied in by the
build.

The build must be run on the server (or the artifact shipped there) **before**
starting in production — the static block does not check that `dist/` exists,
so a missing build produces 404s on the SPA while `/api` and `/health` keep
working.

### Health endpoint

`GET /health` (note: **not** `/api/health`). Registered before the SPA
catch-all specifically so a load balancer can never receive `index.html` from
it. It runs `SELECT 1` against the database.

- `200 {"status":"ok","database":"connected","version":"1.0.0"}`
- `500 {"status":"error","database":"disconnected"}`

It is unauthenticated and not rate-limited (it sits outside the `/api` limiter).

### Diagram

```
                          Internet (HTTPS :443)
                                  │
                                  ▼
                  ┌───────────────────────────────┐
                  │   Reverse proxy (nginx/Caddy) │
                  │   · TLS termination           │
                  │   · HTTP→HTTPS redirect       │
                  │   · X-Forwarded-For           │
                  └───────────────┬───────────────┘
                                  │  http://127.0.0.1:5050
                                  ▼
      ┌───────────────────────────────────────────────────────┐
      │  Node process — server/server.js  (loopback only)     │
      │                                                       │
      │   guards: JWT_SECRET · !DEMO_MODE · SMTP configured   │
      │                                                       │
      │   ┌─────────────────── app.js ───────────────────┐    │
      │   │ helmet → CORS → json(100kb) → rate limiters  │    │
      │   │                                              │    │
      │   │  /api/auth        authRoutes                 │    │
      │   │  /api/events      eventRoutes                │    │
      │   │  /api/applications applicationRoutes         │    │
      │   │  /api/…attendance attendanceRoutes           │    │
      │   │  /api/admin       adminRoutes                │    │
      │   │  /api/…content    contentRoutes              │    │
      │   │                                              │    │
      │   │  GET /health   ──► SELECT 1                  │    │
      │   │  /api/*  404 JSON                            │    │
      │   │  static dist/  +  SPA fallback index.html    │    │
      │   │  error handler (last)                        │    │
      │   └──────────────────────────────────────────────┘    │
      │                                                       │
      │   setInterval 15 min ─► runNotificationSweep()        │
      └───────┬───────────────────────────────┬───────────────┘
              │                               │
              ▼                               ▼
   ┌────────────────────────┐      ┌────────────────────────┐
   │ SQLite (node:sqlite)   │      │ SMTP relay (external)  │
   │  wevolunteer.db       │      │  · verification mail   │
   │  wevolunteer.db-wal   │      │  · password reset mail │
   │  wevolunteer.db-shm   │      └────────────────────────┘
   │  WAL · busy_timeout 5s │
   └────────────────────────┘

   Read by, but never bundled with, the server process:
     bin/make-admin.mjs · server/verifyHours.js · server/migrate_usernames.js
```

---

## 3. Production requirements

### Node

**Use Node 24.x.** Verified on **v24.14.0**.

The hard constraint is `node:sqlite`. On Node 22.x it is behind
`--experimental-sqlite`; on Node 24 it is available without a flag but still
prints `ExperimentalWarning: SQLite is an experimental feature` on every boot.
**That warning is expected. It is not an error.** Do not suppress it globally —
you would also suppress warnings you want to see.

Because the API is experimental, **pin the Node minor version** and treat a
Node upgrade as a change requiring the full smoke test in §10.

### npm

**11.x.** Verified on **11.9.0** (the version bundled with Node 24.14.0). The unified
`package-lock.json` file is lockfileVersion 3. Use `npm ci`, never
`npm install`, on the server.

### Operating system

Linux x86-64 or arm64, or macOS. Verified on macOS (Darwin 27.0). Requirements
the code actually imposes:

- A POSIX filesystem that supports SQLite's locking. **Do not put the database
  on NFS, SMB, or any network share** — WAL requires shared-memory locking that
  network filesystems do not provide correctly.
- A writable directory for the database and its two sidecars.
- Correct system time (event deadlines, token expiry, and shift-ended checks
  are all wall-clock comparisons). Run NTP.
- Timezone: all timestamps are stored as ISO-8601 UTC strings. Set the server
  to UTC to keep logs unambiguous; the client renders local time.

### Disk

- Application + `node_modules` (root and `server/`): ~350 MB.
- `dist/` build output: <1 MB.
- Database at pilot scale: **tens of MB at most.** All content is text; there
  are no uploads, no images, no binary blobs anywhere in the schema.
- The `-wal` file is the one that surprises people. On a freshly initialised
  database it was **519 KB against a 4 KB main file**. WAL grows between
  checkpoints and is truncated on clean shutdown.
- `hours_ledger` and `notifications` are append-only and never pruned. They
  grow with activity, not with users.

**Provision 20 GB minimum**, and alert at 80%. The real consumer is logs, not
data — see the next point.

### Memory

- **1 GB minimum, 2 GB recommended.** A single Node process holding one SQLite
  connection; the resident set is modest.
- Two things scale with rows rather than requests and are the reason not to go
  below 1 GB: `GET /api/events` batch-loads **all** slots and **all** accepted
  application counts into Maps, and `GET /api/applications` loads **every**
  attendance row into a Map on every call
  ([applicationRoutes.js:51](../../server/routes/applicationRoutes.js#L51)).
  Both are fine at pilot scale and both are known items on the roadmap.
- Do not run multiple instances (see §9 and §14) — so do not size for a cluster.

### Network

- **Inbound:** 443 from the public internet to the proxy. Optionally 80 for an
  HTTPS redirect and ACME challenges. **Do not expose 5050** — the process
  binds loopback, so you cannot anyway, but do not "fix" that by changing the
  bind address.
- **Outbound:** SMTP to your relay (587 STARTTLS or 465 implicit TLS) and DNS.
  Nothing else. The app makes no other outbound calls — no CDN, no analytics,
  no third-party APIs.
- Bandwidth is trivial: the client bundle is 130 kB gzipped and API responses
  are small JSON.

### HTTPS

**HTTPS is mandatory, not advisory**, for reasons specific to this codebase:

- The JWT is stored in an `HttpOnly` cookie and sent automatically by the browser. Over plaintext HTTP, it could still be captured or exposed to downgrade attacks.
- Password reset and email verification tokens travel in URLs. A plaintext link
  in an email is an account takeover.
- The data is about minors: names, grades, schools, email addresses, and
  confirmed future whereabouts.

Requirements:

- Valid certificate from a real CA (Let's Encrypt is fine) with auto-renewal.
- Redirect all HTTP to HTTPS at the proxy.
- HSTS. Helmet sets `Strict-Transport-Security` on API responses, but the proxy
  should set it too so it covers everything, including redirects.
- TLS 1.2 minimum; prefer 1.3.

### Network exposure and the firewall

⚠️ **Corrected 2026-07-31.** Read this before the reverse-proxy section below,
which used to open with "the app binds loopback". **It does not.** `server.js`
binds `0.0.0.0` unless told otherwise, so `API_PORT` is open on every interface
the host has. On a cloud VM with a public IP and a default-open security group,
that means anyone on the internet can reach the Node process directly on port
5050 — bypassing nginx, and therefore bypassing TLS, HSTS, and anything you
configured at the proxy.

Close it with **both** of these, not one:

```bash
# 1 — bind loopback only. Add to /etc/wevolunteer/wevolunteer.env:
BIND_ADDRESS=127.0.0.1

# 2 — and firewall the port anyway, so a future config change cannot re-expose it.
sudo ufw default deny incoming
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose        # 5050 must NOT appear
```

Verify from **another machine** — not from the host, where loopback always answers:

```bash
# Must fail (connection refused or timeout):
curl -m 5 http://<host-public-ip>:5050/health

# Must succeed:
curl -sS https://volunteers.sbschools.example.org/health
```

If the first command returns JSON, the app is publicly exposed. Stop and fix it
before going further. The boot log will also tell you: in production, binding
`0.0.0.0` emits `[Security] Listening on 0.0.0.0 in production …`.

### Reverse proxy

With `BIND_ADDRESS=127.0.0.1` set as above, the app binds loopback and the proxy
is the only route in. Whatever you use (nginx, Caddy, Apache), it must:

1. Proxy **everything** to `http://127.0.0.1:5050` — API, SPA routes, and
   static assets alike. Express serves all three. Do not try to serve `dist/`
   from the proxy as well; you will get a stale copy after the next deploy.
2. Preserve `X-Forwarded-For`, and set `TRUST_PROXY` to the number of proxies
   in front of the app. **This pairing is load-bearing**: rate limiting is
   per-IP, and without it every request looks like it comes from `127.0.0.1`,
   collapsing all users into one bucket. Setting `TRUST_PROXY` when there is
   *no* proxy is the opposite failure — clients can then spoof the header and
   bypass the limiter entirely. Set it to exactly the number of hops.
3. Not rewrite paths. The client calls absolute `/api/...` paths.
4. Allow request bodies of at least 100 kB (Express's own limit) — proxy
   defaults are usually 1 MB, which is fine.
5. Not add its own SPA fallback or 404 page for unknown paths.

A minimal nginx location block:

```nginx
location / {
    proxy_pass http://127.0.0.1:5050;
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

With that in place, set `TRUST_PROXY=1`.

**Process supervision.** There is none in this repository. Use systemd (or your
platform's equivalent) with `Restart=on-failure`. Note that a restart re-runs
`initDatabase()` — migrations, ledger backfill, certificate backfill, parity
check — and a `runNotificationSweep()`. All are idempotent, so a crash loop
does not corrupt data, but it does spam the log. Set `RestartSec=5` and a
`StartLimitBurst` so a persistent failure stops rather than thrashing.

---

## 4. Environment variables

### Server (read by `server/config.js`, `server/email.js`, `server/app.js`, `server/db.js`)

#### `NODE_ENV`

| | |
|---|---|
| **Required** | **Yes for production.** Optional otherwise. |
| **Purpose** | The master switch. Enables the startup guards, enables serving `dist/` and the SPA fallback, and changes the `APP_URL` default. |
| **Example** | `production` |
| **Security** | Without it you get **none** of the production guards: the dev JWT fallback secret is used, `DEMO_MODE` is permitted, and a missing SMTP config silently logs reset tokens to stdout instead of refusing to boot. |
| **If missing** | Boots "successfully" in a development posture. This is the most dangerous possible misconfiguration, because nothing complains. |

#### `JWT_SECRET`

| | |
|---|---|
| **Required** | **Yes, always** — enforced in every environment, not only production. |
| **Purpose** | Signs and verifies every session token. |
| **Example** | `openssl rand -hex 32` → `9f2c…` (64 hex chars) |
| **Security** | Anyone holding it can mint a token for any user, including an admin. Treat it as the crown jewel. Never commit it; never log it; never pass it on a shell command line that lands in shell history. Changing it invalidates every session (users must sign in again) — which is also how you respond to a suspected leak. **There is no fallback secret** — an earlier version fell back to a hardcoded literal outside production, which meant a deployment that forgot `NODE_ENV=production` signed real tokens with a value published in the repository. That fallback has been removed. |
| **If missing** | `FATAL: JWT_SECRET must be set.` thrown at import from [config.js:14](../../server/config.js#L14), in **every** environment — **verified**. This is the first guard to fire; it precedes the SMTP check. `npm run dev` supplies a clearly-labelled development value so local work is unaffected. |

#### `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS`

| | |
|---|---|
| **Required** | **Yes in production** — all three, enforced. |
| **Purpose** | Outbound mail relay for verification and password-reset messages. |
| **Example** | `smtp.sendgrid.net` / `apikey` / `SG.xxxxx` |
| **Security** | A relay credential. If leaked, someone can send mail as your district's domain — the highest-value phishing asset in this deployment. Scope the credential to sending only, and rotate it if the host is ever compromised. |
| **If missing** | In production: `FATAL: SMTP is not configured …` and `exit(1)` — **verified**. This check runs at import time, and fires **after** the `JWT_SECRET` check (`config.js` is evaluated before the routers that import `email.js`). Outside production: a console mock that prints message bodies (including live reset tokens) to stdout. |

#### `SMTP_PORT`

| | |
|---|---|
| **Required** | No — defaults to `587`. |
| **Purpose** | Relay port. **The value also selects the TLS mode**: `465` sets `secure: true` (implicit TLS); anything else uses STARTTLS. |
| **Example** | `587` |
| **Security** | Setting `465` while the server expects STARTTLS (or vice versa) produces connection failures, not silent plaintext — but confirm with your provider. |
| **If missing** | `587` + STARTTLS. Correct for most providers. |

#### `APP_URL`

| | |
|---|---|
| **Required** | **Yes in production** — enforced; the server refuses to boot without it. Optional in development. |
| **Purpose** | Base URL for links in emails: `${APP_URL}/?verify=<token>` and `${APP_URL}/?reset=<token>`. |
| **Example** | `https://volunteers.sbschools.example.org` |
| **Security** | A wrong value sends your users' password-reset tokens to a hostname you do not control. No trailing slash. |
| **If missing** | In production: `FATAL: APP_URL must be set in production.` and `exit(1)` — **verified**. This is the third guard to fire, after `JWT_SECRET` and SMTP. Outside production it defaults to `http://localhost:5173`. |

#### `CORS_ORIGINS`

| | |
|---|---|
| **Required** | **Yes in production, in practice.** |
| **Purpose** | Comma-separated allowlist of browser origins permitted to call `/api`. Requests with no `Origin` header (curl, same-origin GETs) always pass, as do same-origin requests. |
| **Example** | `https://volunteers.sbschools.example.org` |
| **Security** | ⚠️ **Corrected 2026-07-26.** An earlier revision of this document called this "largely inert" in the same-origin topology. **That was wrong.** Browsers attach `Origin` to `POST`/`PATCH`/`DELETE` even same-origin, so a wrong value used to return 403 on every login and every write while reads kept working. The app now (a) mounts CORS on `/api` only, so a bad value can never blank the SPA, and (b) always accepts requests whose `Origin` host matches the request's `Host`, so a correct same-origin deployment works even if this is unset. **Set it anyway** — it is your only control if the client is ever served from a different host, and the same-origin fallback depends on the proxy passing the real Host (`proxy_set_header Host $host`). |
| **If missing** | Defaults to `http://localhost:5173,http://localhost:4173` — **development values, in production, with no warning.** See §14. A rejected origin returns 403 `{"error":"Origin not allowed."}` and logs a warning. |

#### `TRUST_PROXY`

| | |
|---|---|
| **Required** | **Yes when behind a reverse proxy** (which production always is). |
| **Purpose** | Number of proxy hops, passed to Express's `trust proxy`. Determines which address the rate limiters see. |
| **Example** | `1` |
| **Security** | Cuts both ways. Unset behind a proxy → every client shares one rate-limit bucket, so ten failed logins from anyone locks out everyone. Set without a proxy → clients forge `X-Forwarded-For` and bypass rate limiting entirely. Set it to the exact hop count. |
| **If missing** | `trust proxy` stays off; all requests appear to originate from `127.0.0.1`. |

#### `WEV_DB_PATH`

| | |
|---|---|
| **Required** | No — defaults to `server/wevolunteer.db`. |
| **Purpose** | Absolute path to the SQLite file. Honoured by `db.js`, `verifyHours.js`, `migrate_usernames.js`, and `bin/make-admin.mjs`. |
| **Example** | `/var/lib/wevolunteer/wevolunteer.db` |
| **Security** | Point it at a dedicated, backed-up volume outside the deploy directory. Leaving it inside the checkout means a careless `git clean -xdf` deletes your production data. The directory must be writable by the service user and readable by nobody else (`chmod 700`). |
| **If missing** | Uses the path inside the checkout. **Every operational script must be run with the same value** — otherwise you will "successfully" promote an admin in a database nobody is using. |

#### `API_PORT`

| | |
|---|---|
| **Required** | No — defaults to `5050`. |
| **Purpose** | TCP listen port. |
| **Example** | `5050` |
| **Security** | ⚠️ **Corrected 2026-07-31.** An earlier revision claimed "the bind address is hardcoded to `127.0.0.1`". **It never was** — `server.js` binds `0.0.0.0` by default, so this port is reachable on every interface the host has. See `BIND_ADDRESS` below and the firewall step in §3. |
| **If missing** | `5050`. A non-numeric value also falls back to `5050` (`Number(...) \|\| 5050`). |

#### `BIND_ADDRESS`

| | |
|---|---|
| **Required** | No — defaults to `0.0.0.0`. **Set it to `127.0.0.1` for the single-host topology in §3.** |
| **Purpose** | The interface the HTTP server binds. |
| **Example** | `127.0.0.1` |
| **Security** | The default (`0.0.0.0`) accepts connections on every interface. Behind the nginx setup in §3 that means the app is *also* reachable directly on `API_PORT`, bypassing TLS, HSTS and any rate limiting you added at the proxy. Setting `127.0.0.1` makes the reverse proxy the only route in. The default is left as `0.0.0.0` because container and port-forward deployments depend on it. |
| **If missing** | `0.0.0.0`, and in production the boot log carries `[Security] Listening on 0.0.0.0 in production …`. That line is your reminder to either set this or confirm a firewall rule. |

#### `INSTANCE_LOCK_STALE_MS` / `INSTANCE_LOCK_HEARTBEAT_MS`

| | |
|---|---|
| **Required** | No — default 45000 / 15000. |
| **Purpose** | The single-instance lock. One instance holds a row in `instance_lock` and refreshes it every `HEARTBEAT_MS`; a second production instance whose holder is still heartbeating **refuses to boot**. |
| **Security** | This is a data-integrity control, not a convenience. Two instances multiply every rate limit (all limiter state is per-process memory) and can interleave a slot-capacity read with another instance's write. |
| **If missing** | The defaults, which give three missed heartbeats before a holder is presumed dead. A crashed predecessor does not delay a restart: a dead pid on the same host is reclaimed at once. |

#### `WEV_ALLOW_UNSUPPORTED_NODE`

| | |
|---|---|
| **Required** | No. Leave unset. |
| **Purpose** | Overrides the boot-time Node major check. |
| **Security** | The data layer is `node:sqlite`, which Node still marks experimental, so its API may change between majors. The check refuses to start on anything but v24.x. Setting this to `true` accepts running the database layer untested. |
| **If missing** | The check is enforced and fatal, which is what you want. |

#### `HEALTH_WRITE_PROBE_MS`

| | |
|---|---|
| **Required** | No — default 60000. |
| **Purpose** | How often `/health` performs its WRITE probe (a `PRAGMA user_version` round-trip). The read probe runs on every request. |
| **Security** | None. The write probe is what makes `/health` able to detect a full disk or a read-only remount, which a read-only probe cannot. |
| **If missing** | 60s. Measured: with the interval forced to 1ms, 200 polls grew the WAL to 2.9 MB — bounded and checkpointed on shutdown, but needless churn. 60s still surfaces an outage inside the alerting window. |

#### `WEV_EXPORT_DIR`

| | |
|---|---|
| **Required** | No — defaults to an `exports/` directory beside `WEV_DB_PATH`. |
| **Purpose** | Where completed data-export archives are written. |
| **Security** | Each archive is one student's complete personal record. The directory is created `0700`. It must be on backed-up, durable storage — **not** `/tmp`, which `PrivateTmp=true` destroys on every restart while the database still promises the file for seven days. |
| **If missing** | `<database directory>/exports`, which the service unit can already write (`ReadWritePaths=/var/lib/wevolunteer`). |

#### `BIND_ADDRESS`

Documented above with `API_PORT`. Set it to `127.0.0.1`.

#### `DEMO_MODE`

| | |
|---|---|
| **Required** | No. **Must be absent or `false` in production.** |
| **Purpose** | Registers `POST /api/auth/reset` (drops and reseeds every table), seeds demo accounts on an empty database, and raises rate limits ~100×. |
| **Example** | *(unset)* |
| **Security** | Catastrophic if enabled: an unauthenticated endpoint that destroys the database, plus demo accounts whose shared password (`password123`) is published in the README. |
| **If missing** | Off. With `NODE_ENV=production` and `DEMO_MODE=true` together, the server refuses to start: `FATAL: DEMO_MODE cannot be enabled in production.` — **verified**. When off, boot logs `[Security] DEMO_MODE is off — the database reset endpoint is not registered.` |

#### `REQUIRE_EMAIL_VERIFICATION`

| | |
|---|---|
| **Required** | No — **defaults to `true`.** |
| **Purpose** | A new account must click a confirmation link before using anything outside the allowlist in `config.js` (`EMAIL_GATE_ALLOWLIST`). |
| **Example** | `false` to opt out deliberately |
| **Security** | ⚠️ **Corrected 2026-07-31.** An earlier revision said this defaulted to `false`. **It defaults to ON** (`config.js`: `process.env.REQUIRE_EMAIL_VERIFICATION !== 'false'`). The default was inverted because nothing in the login path consulted `email_verified` — only the SPA refused to render, and the SPA is not a security boundary, so anyone able to type an address they did not own got a working account on a platform holding minors' records. |
| **If missing** | **ON.** This makes §8 (prove SMTP end to end) a hard prerequisite rather than a nice-to-have: if mail does not work, no new account can be used. The allowlist deliberately includes the email-*change* routes so a mistyped address is escapable rather than a permanent dead end. |
| **To opt out** | `REQUIRE_EMAIL_VERIFICATION=false`. Boot then runs `UPDATE users SET email_verified = 1 WHERE email_verified = 0`, so existing accounts are not stranded. |

#### `MAIL_RATE_LIMIT`

| | |
|---|---|
| **Required** | No — defaults to `5` per 15 minutes (1000 in demo mode). |
| **Purpose** | Cap on `/api/auth/forgot-password` and `/api/auth/resend-verification`. Counts **every** request, not just failures. |
| **Example** | `5` |
| **Security** | The only thing preventing the app being used to flood someone's inbox. `forgot-password` always returns 200 by design (so it cannot leak whether an address exists), which is exactly why the normal failures-only limiter cannot guard it. Raise it cautiously. |
| **If missing** | `5`. Reasonable; leave it. |

#### `MAX_AUTO_SELECT_DRAWS`

| | |
|---|---|
| **Required** | No — defaults to `5`. |
| **Purpose** | Total Auto Select draws permitted per event. Beyond it, the endpoint returns 409 `draw_cap_reached`. Every re-draw after the first also requires a typed reason. |
| **Example** | `5` |
| **Security** | This is a fairness control, not a performance one. Raising it lets an organizer re-roll until they like the result. Lowering it to `1` removes re-draws entirely. |
| **If missing** | `5`. |

#### `APP_NAME` / `SCHOOL_NAME`

| | |
|---|---|
| **Required** | No — default to `WeVolunteer` and `WeVolunteer Community`. |
| **Purpose** | `APP_NAME` appears in email subjects, bodies, and the default `From` name. `SCHOOL_NAME` is exported from `config.js` but not consumed by any server code at this commit — the client has its own `VITE_SCHOOL_NAME`. |
| **Example** | `WeVolunteer` |
| **Security** | None. Cosmetic. |
| **If missing** | The defaults, which are already correct for this district. |

#### `EMAIL_FROM`

| | |
|---|---|
| **Required** | No, but **set it in production**. |
| **Purpose** | The literal `From` header on every outbound message. |
| **Example** | `"WeVolunteer" <noreply@sbschools.example.org>` |
| **Security** | Must be an address your SMTP relay is authorised to send as, and one covered by your SPF/DKIM records. A mismatch is the single most common cause of mail landing in spam. |
| **If missing** | `"WeVolunteer" <noreply@wevolunteer.org>` — a domain you probably do not control, which will fail SPF/DKIM alignment. Set it. |

#### `MAX_AUTO_SELECT_APPLICANTS`

Declared in `config.js` (default `100`) but **not imported or used anywhere** at
this commit. Setting it does nothing. Listed here so you do not assume it is
protecting you from anything.

### Client (build-time only — baked into `dist/` by `vite build`)

These are read at build time. Changing them requires a rebuild and redeploy;
setting them on the running server has no effect.

| Variable | Required | Purpose | Example | Security | If missing |
|---|---|---|---|---|---|
| `VITE_DEMO_MODE` | No | Shows the demo account switcher and one-click seeded logins | *(never set)* | **Must never be set for a production build.** It surfaces sign-in-as-anyone shortcuts. It lives only in `.env.development`, which `vite build` does not read — so the safe default is structural. | Off. Correct. |
| `VITE_APP_NAME` | No | Product name in the UI | `WeVolunteer` | None | `WeVolunteer` |
| `VITE_SCHOOL_NAME` | No | District name in the UI | `WeVolunteer Community` | None | `WeVolunteer Community` |
| `VITE_ENABLE_LEADERBOARD` | No | Set to `false` to hide the leaderboard entirely | `false` | The leaderboard is already opt-in per student and default-off. Setting this to `false` is the belt-and-braces option if the district would rather not have one at all. | Enabled (but empty until students opt in) |
| `VITE_PRIVACY_URL` | **Set once the district publishes a privacy notice** | URL of the district's privacy notice. When set, signup shows a required acknowledgement checkbox linking to it. | `https://sbschools.example.org/privacy` | This platform holds minors' names, grades, schools and email addresses and shows some of it to organizers. The consent gate is deliberately inert until a real notice exists — a checkbox pointing at nothing would manufacture the appearance of a reviewed policy. | Unset: no checkbox, and Vite tree-shakes the block out of the bundle entirely. **This is a launch-gate item, not a code gap** — see §14 P0-11. |

---

### Variables that must NEVER carry a development default into production

These are the ones to check twice. The first three are enforced by the code;
**the last three are not enforced by anything**, and their defaults are wrong
in a way that produces no error message.

| Variable | Why | Enforced? |
|---|---|---|
| `JWT_SECRET` | No fallback exists — the secret must be supplied. An earlier version fell back to a hardcoded literal outside production, so a deployment that forgot `NODE_ENV=production` signed real tokens with a published value. | ✅ Refuses to boot, in every environment |
| `DEMO_MODE` | Registers an unauthenticated database-destroying endpoint and seeds accounts with a published password. | ✅ Refuses to boot |
| `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` | The console fallback prints live reset tokens to the log and delivers nothing. | ✅ Refuses to boot |
| `NODE_ENV` | Not setting it to `production` disables all three guards above **and** stops the SPA being served. | ❌ **Nothing checks this** |
| `APP_URL` | Would send live password-reset tokens to a domain you do not control. | ✅ Refuses to boot |
| `CORS_ORIGINS` | Defaults to two `localhost` dev ports. The same-origin fallback means the recommended single-host topology works anyway; a split client/API host fails visibly with 403s on every write. | ⚠️ Silent, but no longer able to cause a blank app |
| `VITE_DEMO_MODE` | Would expose sign-in-as-anyone controls in the shipped bundle. | ⚠️ Structurally safe (`vite build` ignores `.env.development`), but do not add it to a production `.env` |

## 4a. Provider sign-in (OAuth)

**New in revision 1.1.** The previous revision of this runbook did not mention OAuth
anywhere in 2,954 lines, while the code has had a working Google and Microsoft
implementation — with a boot-time guard that **refuses to start** if it is
misconfigured. An operator following the old document had no way to know the feature
existed, let alone that it could stop the service from starting.

**Email-only is a fully supported deployment.** If the district does not want
provider sign-in, set none of these variables and skip this section entirely; the
buttons do not render and `/api/oauth/providers` reports each provider as
`enabled: false`.

### The failure this section exists to prevent

`OAUTH_REDIRECT_URI` has a built-in default of `http://localhost:5173/oauth/callback`
— correct for development, catastrophic in production. Verified during the pre-pilot
review: with real Google credentials set and this variable forgotten, the server
booted without complaint, reported the provider as enabled so the "Continue with
Google" button rendered for everyone, and minted authorize URLs pointing at
`localhost`. Every student pressing that button then got one of two outcomes —
`redirect_uri_mismatch` (a dead end on an advertised sign-in path), or, if localhost
was still registered on the OAuth client, **Google handing a live authorization code
to `http://localhost:5173` on the student's own machine over plain HTTP.**

The code now fails closed on this. Understand that before you configure it:

| Condition | Behaviour |
|---|---|
| No client credentials set | Provider disabled, button hidden. No error. |
| Client credentials set **and** `OAUTH_REDIRECT_URI` points at localhost, in production | **FATAL — the server refuses to boot.** |
| Client credentials set **and** `OAUTH_REDIRECT_URI` is not a valid URL, in production | **FATAL — refuses to boot.** |
| Client credentials set **and** `OAUTH_REDIRECT_URI` is `http://` (non-localhost) | Boots, with a loud warning. Both providers reject non-HTTPS redirect URIs, so sign-in fails at the provider. |
| `OAUTH_ALLOW_MOCK=true` in production | **FATAL — refuses to boot.** |

That last one deserves emphasis. Both providers carry a test transport that takes
the identity straight from the `code` parameter, skipping the real exchange. It is
opt-in and impossible to reach in production, and it must stay that way — with it
enabled, `POST /api/oauth/google/callback` with a body of
`{"code": "{\"email\":\"admin@district.org\"}"}` is an unauthenticated
sign-in-as-anyone endpoint. **Never set `OAUTH_ALLOW_MOCK` outside local development.**

### Environment variables

| Variable | Required | Notes |
|---|---|---|
| `GOOGLE_CLIENT_ID` | With Google | Ends `.apps.googleusercontent.com` |
| `GOOGLE_CLIENT_SECRET` | With Google | Treat as a credential; rotate if the host is compromised |
| `MICROSOFT_CLIENT_ID` | With Microsoft | Application (client) ID from the Entra app registration |
| `MICROSOFT_CLIENT_SECRET` | With Microsoft | Entra client secrets **expire** — note the date, it will outlive the pilot |
| `OAUTH_REDIRECT_URI` | **Whenever any provider is configured** | Absolute callback URL of *this* deployment. Must match a URI registered with the provider **exactly** — scheme, host, port, path. Must be `https` outside localhost. |
| `OAUTH_ALLOW_MOCK` | Never in production | Fatal if combined with `NODE_ENV=production` |

Set the client id and secret **together, or neither**. A provider is considered
configured only when both are present, so setting just the id silently leaves the
provider disabled.

Apple has no implementation behind it and is always reported unavailable, whatever
is set.

### Google setup

1. Google Cloud Console → **APIs & Services → Credentials**.
2. **Create Credentials → OAuth client ID → Web application.**
3. Under **Authorised redirect URIs**, add exactly your deployment's callback:
   ```
   https://volunteers.sbschools.example.org/oauth/callback
   ```
   Nothing else. In particular do **not** leave `http://localhost:5173/oauth/callback`
   registered on the client the district will use — that registration is what turns a
   forgotten `OAUTH_REDIRECT_URI` from a dead end into a leaked authorization code.
   Keep a separate client for development.
4. Configure the **OAuth consent screen**. For a district on Google Workspace, set
   the user type to **Internal** so only district accounts can use it.
5. Copy the client id and secret into `/etc/wevolunteer/wevolunteer.env`.

### Microsoft setup

1. Entra admin centre → **App registrations → New registration**.
2. Redirect URI: platform **Web**, value exactly as above.
3. **Certificates & secrets → New client secret.** Record the expiry.
4. Under **API permissions**, `openid`, `email` and `profile` are sufficient.
5. Copy the application id and secret into the env file.

Note a real difference between the two: Google asserts `email_verified`, so a
Google sign-in auto-confirms the address. Microsoft does not assert it, and the
code honestly does not pretend otherwise — a Microsoft user still receives a
confirmation mail, which matters because `REQUIRE_EMAIL_VERIFICATION` defaults on.

### Smoke test

Run this after `systemctl start` and before inviting anyone. It is not optional:
misconfigured OAuth fails on the student's screen, at the provider, where you
cannot see it.

```bash
# 1 — the server booted at all. A fatal OAuth misconfiguration exits non-zero,
#     so check this first and read the journal if it is not running.
systemctl is-active wevolunteer
journalctl -u wevolunteer -n 30 --no-pager | grep -i oauth

# 2 — the provider reports itself enabled
curl -s https://volunteers.sbschools.example.org/api/oauth/providers | jq
# → google: {"id":"google","enabled":true,...}   apple: {"enabled":false,...}

# 3 — the authorize URL carries YOUR redirect_uri, not localhost.
#     This is the check that catches the failure described above.
curl -s "https://volunteers.sbschools.example.org/api/oauth/google/url" | jq -r .url
# → must contain redirect_uri=https%3A%2F%2Fvolunteers.sbschools.example.org%2Foauth%2Fcallback
#   If you see localhost here, STOP. Fix OAUTH_REDIRECT_URI and restart.

# 4 — the mock transport is not reachable. Must NOT mint a session.
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  https://volunteers.sbschools.example.org/api/oauth/google/callback \
  -H 'Content-Type: application/json' \
  -d '{"code":"{\"email\":\"probe@example.org\",\"sub\":\"1\"}"}'
# → 400 (missing/invalid state). Anything that returns a session cookie means
#   OAUTH_ALLOW_MOCK is set — stop the service immediately.

# 5 — finally, in a real browser: press "Continue with Google" and complete a
#     sign-in with a district account. Confirm you land back on the app signed in.
```

If step 5 fails with `redirect_uri_mismatch`, the value in `OAUTH_REDIRECT_URI` and
the value registered with the provider differ. They must match character for
character, including the trailing path and the absence of a trailing slash.

---

## 5. Initial deployment procedure

From an empty Linux server to a running production deployment. Commands assume
Ubuntu/Debian and a service user named `wev`; adapt as needed. Every step
either has been verified locally or is flagged as environment-specific.

### Step 0 — Prerequisites

```bash
node --version   # must be v24.x
npm --version    # must be 11.x
git --version
sqlite3 --version   # required for backup
```

Install Node 24 via NodeSource. Do **not** use nvm (which puts Node in a user's home directory, breaking systemd's ability to find `/usr/bin/node`) and do **not** use the distro's `nodejs`
package unless it is genuinely 24.x — `node:sqlite` will not exist on older
lines and the app will fail at import with a module-not-found error.

### Step 1 — Create the service user and directories

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin wev
sudo mkdir -p /srv/wevolunteer /var/lib/wevolunteer /var/backups/wevolunteer
sudo chown -R wev:wev /srv/wevolunteer /var/lib/wevolunteer /var/backups/wevolunteer
sudo chmod 700 /var/lib/wevolunteer /var/backups/wevolunteer
```

The database lives in `/var/lib/wevolunteer`, **deliberately outside the code
checkout**, so a redeploy or a `git clean` cannot touch it.

### Step 2 — Clone

```bash
sudo -u wev git clone <your-remote-url> /srv/wevolunteer
cd /srv/wevolunteer
sudo -u wev git checkout main
sudo -u wev git rev-parse HEAD    # record this — it is your build identity
```

If you deploy from the tag instead: `git checkout v1.0.0-pilot`. The only
difference from `main` is the roadmap document.

### Step 3 — Install dependencies

This is an npm workspace: the `server` package is a workspace member, so a
single install at the root covers both the client and the server. There is no
separate install step for `server/`.

```bash
sudo -u wev npm ci --include=dev
```

Use `npm ci`, not `npm install` — it installs exactly the locked versions and
fails loudly if a lockfile is stale.

**`--include=dev` on the root install is load-bearing, not decoration.** Vite,
`@vitejs/plugin-react`, vitest and oxlint are all *devDependencies*, and npm
omits devDependencies automatically whenever `NODE_ENV=production` is exported
— which is a natural thing to have done while setting up a production host.
Verified on npm 11: with `NODE_ENV=production` set, `npm config get omit`
returns `dev`; adding `--include=dev` clears it. Without the flag, Step 4 fails
with `vite: not found`, which reads like a broken repository rather than a
shell-environment problem.

**Order matters, and it is the opposite of what you might expect:**

1. Install and build **without** `NODE_ENV=production` in your shell — the
   build needs the dev toolchain.
2. Set `NODE_ENV=production` only for the **runtime**, where systemd supplies
   it from `/etc/wevolunteer/wevolunteer.env`.

Never export `NODE_ENV=production` in the deploying shell and then run Step 4.
The flags above make that survivable, but the cleanest habit is to leave it
unset until the service starts.

### Step 4 — Build the client

```bash
sudo -u wev npm run build

# Remove development dependencies like Vite to save space and reduce surface area
sudo -u wev npm prune --omit=dev
ls -la dist/            # index.html, assets/, favicon.svg, icons.svg
```

Expected output (verified): `dist/assets/index-*.js` ≈ 476 kB
(130 kB gzipped), `dist/assets/index-*.css` ≈ 42 kB, `dist/index.html` ≈ 0.5 kB.

`vite build` does **not** read `.env.development`, so demo mode cannot reach
this bundle. Confirm anyway:

```bash
grep -rc "one-click\|Demo account" dist/assets/*.js || echo "no demo strings — good"
```

### Step 5 — Write the environment files

There are **two** environment files and they must never be merged. The frontend requires variables prefixed with `VITE_` and `NODE_ENV`, which are baked into the bundle at build time. The server requires its secrets in a separate file read by systemd.

**1. Create the frontend environment file:**

```bash
sudo -u wev tee /srv/wevolunteer/.env.production >/dev/null <<'EOF'
NODE_ENV=production
# Add any required VITE_* variables here
EOF
```

**2. Create the server environment file:**

```bash
sudo install -d -m 750 -o root -g wev /etc/wevolunteer
sudo install -m 640 -o root -g wev deploy/wevolunteer.env.example /etc/wevolunteer/wevolunteer.env
sudo nano /etc/wevolunteer/wevolunteer.env
```

Ensure you set all required values:

```
NODE_ENV=production
API_PORT=5050
JWT_SECRET=REPLACE_ME
WEV_DB_PATH=/var/lib/wevolunteer/wevolunteer.db
TRUST_PROXY=1
APP_URL=https://volunteers.sbschools.example.org
CORS_ORIGINS=https://volunteers.sbschools.example.org
SMTP_HOST=smtp.example.net
SMTP_PORT=587
SMTP_USER=REPLACE_ME
SMTP_PASS=REPLACE_ME
EMAIL_FROM="WeVolunteer <noreply@sbschools.example.org>"
APP_NAME=WeVolunteer
MAIL_RATE_LIMIT=5
MAX_AUTO_SELECT_DRAWS=5
# REQUIRE_EMAIL_VERIFICATION=true   # ← only after §8 proves mail works
# DEMO_MODE must never appear in this file
```

Generate the secret and write it in without it landing in shell history:

```bash
openssl rand -hex 32     # copy the output into JWT_SECRET via an editor
```

Then verify permissions: `ls -l /etc/wevolunteer/wevolunteer.env` must show
`-rw-r----- root wev`.

**Checklist before continuing.** Confirm every one of these in `/etc/wevolunteer/wevolunteer.env`:

- [ ] `NODE_ENV=production` is present
- [ ] `JWT_SECRET` is 64 random hex characters, and is not the development value used by `npm run dev`
- [ ] `DEMO_MODE` does not appear anywhere in the file
- [ ] `APP_URL` is *your* hostname (the server refuses to start without it)
- [ ] `CORS_ORIGINS` is *your* hostname, not `localhost`
- [ ] `WEV_DB_PATH` is an absolute path outside the checkout
- [ ] `TRUST_PROXY` matches your actual proxy hop count
- [ ] `EMAIL_FROM` is an address your relay may send as

### Step 6 — Initialise the database

There is no separate migration command. **`initDatabase()` runs on every boot**
and does all schema work: creates tables, applies additive column migrations,
rebuilds `applications` if needed, reconciles case-variant duplicate emails,
creates indexes, creates and backfills the hours ledger and certificates, and
runs a parity check.

So initialisation *is* the first startup. Do it once in the foreground so you
can read the output:

```bash
cd /srv/wevolunteer
sudo -u wev node --env-file=/etc/wevolunteer/wevolunteer.env server/server.js
```

Expected output on an empty database (**verified**):

```
(node:NNNN) ExperimentalWarning: SQLite is an experimental feature and might change at any time
[Email] Configured to send via smtp.example.net
[Security] DEMO_MODE is off — the database reset endpoint is not registered.
Migration: added notifications.dedupe_key
Migration: added events.instructions
Migration: added events.attendee_visibility
Migration: added users.token_version
Migration: added users.email_verified
Empty database initialized. DEMO_MODE is off, so no demo accounts were created.
WeVolunteer API Server listening on port 5050
```

Read that output carefully:

- `Empty database initialized. DEMO_MODE is off…` — **this is the line you
  want.** If you instead see `Seeding database...`, `DEMO_MODE` leaked in.
  Stop, delete the database file and both sidecars, fix the environment, start
  over.
- The `Migration: added …` lines are expected on a fresh database and will not
  appear again.
- The `ExperimentalWarning` is expected.

`Ctrl-C` once you have read it.

### Step 7 — Migrations

There are exactly two things `initDatabase()` does **not** do:

**a) Username backfill** — only needed when upgrading a database created before
usernames existed. On a fresh pilot database there is nothing to backfill, but
the script is safe and idempotent:

```bash
cd /srv/wevolunteer
sudo -u wev env WEV_DB_PATH=/var/lib/wevolunteer/wevolunteer.db \
  node server/migrate_usernames.js
```

Expect `Found 0 users needing a username.` on a fresh install.

**b) The first administrator.** A production database starts empty — there are
no accounts at all, including no admin. The bootstrap is two steps:

1. Have that person **sign up through the normal form** (they will be a
   `student`), or create the account via the API once the service is up.
2. Promote them:

```bash
cd /srv/wevolunteer
sudo -u wev env WEV_DB_PATH=/var/lib/wevolunteer/wevolunteer.db \
  node bin/make-admin.mjs ops.admin@district.example.org
```

> **Verified gotcha — pass the email in lowercase.** Signup normalises the
> stored address to lowercase and trimmed, but `make-admin.mjs` matches with a
> case-**sensitive** `WHERE email = ?`. Promoting
> `Ops.Admin@District.Example.org` fails with
> `Error: User with email … not found`, while
> `ops.admin@district.example.org` succeeds. If the promotion "cannot find" a
> user you just created, lowercase the address and try again before assuming
> anything is broken.

Success looks like: `Successfully promoted ops.admin@district.example.org to admin.`
Re-running is safe: `User … is already an admin.` and exit 0.

The promoted user must sign out and back in for the new role to appear in the
UI, since the client caches the user object — though the API itself re-reads
the role from the database on every request, so authorization is correct
immediately.

### Step 8 — Install the service unit

The unit is shipped in the repository as
[`deploy/wevolunteer.service`](../../deploy/wevolunteer.service) — install it
rather than copying one out of this document, so there is exactly one
definition to keep correct:

```bash
sudo install -m 644 /srv/wevolunteer/deploy/wevolunteer.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now wevolunteer
sudo systemctl status wevolunteer
sudo journalctl -u wevolunteer -n 50 --no-pager
```

Unit names are case-sensitive: it is `wevolunteer`, not `WeVolunteer`.

The unit assumes the runbook's layout (`/srv/wevolunteer`, service user `wev`,
`EnvironmentFile=/etc/wevolunteer/wevolunteer.env`). If yours differs, edit the
file in `deploy/` and reinstall it, so the repository stays the source of truth.

It uses `ExecStart=/usr/bin/env node server/server.js` rather than a hardcoded
`/usr/bin/node`, so it works wherever a system-wide NodeSource install puts the
binary. Confirm before enabling:

```bash
/usr/bin/env node --version    # must be v24.x
```

Note `Type=simple` and no `KillSignal` override: systemd sends `SIGTERM`, which
Node handles by default. **The app installs no shutdown handler and does not
explicitly close the database**, so a clean stop relies on the process exiting
and the OS releasing the file. SQLite is crash-safe in WAL mode, so this is
correct but not elegant — it does mean the `-wal` file may not be checkpointed
after every stop. Backups must account for that (§7).

### Step 9 — Reverse proxy and TLS

Install nginx (or Caddy), point a server block at
`http://127.0.0.1:5050` using the location block from §3, obtain a certificate
(`certbot --nginx -d volunteers.sbschools.example.org`), and confirm the HTTP→HTTPS
redirect works.

Then confirm `TRUST_PROXY` matches reality — if there is exactly one nginx in
front, `TRUST_PROXY=1`.

### Step 10 — Production verification

Run these in order. Every expected result below was observed on a real
production boot except where noted as environment-specific.

```bash
# 1 — health, through the proxy, over TLS
curl -sS https://volunteers.sbschools.example.org/health
# → {"status":"ok","database":"connected","version":"1.0.0"}
```

```bash
# 2 — the SPA is served, as HTML
curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' https://volunteers.sbschools.example.org/
# → 200 text/html; charset=UTF-8
```

```bash
# 3 — a deep SPA route returns index.html, not a 404
curl -sS -o /dev/null -w '%{http_code}\n' https://volunteers.sbschools.example.org/events
# → 200
```

```bash
# 4 — unknown API paths return JSON, never HTML
curl -sS https://volunteers.sbschools.example.org/api/nope
# → {"error":"Not found: GET /api/nope"}
```

```bash
# 5 — the demo reset endpoint must NOT exist
curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://volunteers.sbschools.example.org/api/auth/reset
# → 404   (anything else means DEMO_MODE is on — stop and fix immediately)
```

```bash
# 6 — no demo accounts exist
curl -sS -X POST https://volunteers.sbschools.example.org/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.gov","password":"password123"}'
# → {"error":"Invalid email or password"}
```

```bash
# 7 — HTTPS redirect
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' http://volunteers.sbschools.example.org/
# → 301 https://volunteers.sbschools.example.org/
```

```bash
# 8 — security headers present (helmet)
curl -sSI https://volunteers.sbschools.example.org/health | grep -iE 'strict-transport|x-content-type|x-frame'
```

```bash
# 9 — the database is where you think it is, and the process is using it
sudo ls -la /var/lib/wevolunteer/
# → wevolunteer.db, wevolunteer.db-wal, wevolunteer.db-shm
sudo lsof -p "$(systemctl show -p MainPID --value wevolunteer)" | grep wevolunteer.db
```

```bash
# 10 — hours ledger parity
cd /srv/wevolunteer && sudo -u wev env WEV_DB_PATH=/var/lib/wevolunteer/wevolunteer.db \
  node server/verifyHours.js /var/lib/wevolunteer/wevolunteer.db
# → PASS — ledger matches attendance for all N volunteer(s) with recorded hours.
```

```bash
# 11 — schema integrity
sudo -u wev sqlite3 /var/lib/wevolunteer/wevolunteer.db 'PRAGMA integrity_check; PRAGMA foreign_key_check;'
# → ok   (and no output from foreign_key_check)
```

Then proceed to the full workflow smoke test in §10.

---

## 6. Database operations

### Migrations

There is no migration tool, no versions table, and no up/down scripts.
**`initDatabase()` in `server/db.js` is the migration system, and it runs on
every boot.** Understand the order, because it matters:

1. `CREATE TABLE IF NOT EXISTS` for the core and V2 tables.
2. `addColumnIfMissing()` for columns added after the first release —
   `notifications.dedupe_key`, `events.instructions`,
   `events.attendee_visibility`, `applications.waitlist_order`,
   `events.selection_summary`, `auto_select_runs.reason`,
   `users.leaderboard_opt_in`, `users.token_version`, `users.email_verified`,
   `users.username`, `users.profile_visibility`.
3. **First-time `email_verified` backfill.** The first time that column is
   created, every existing account is set to verified. Without this, switching
   verification on would lock out every current user.
4. **`applications` table rebuild**, if the stored schema lacks `'withdrawn'` in
   its CHECK constraint — SQLite cannot alter a constraint, so the table is
   recreated inside a transaction and the rows copied.
5. **Case-insensitive email dedupe** (`dedupeCaseInsensitiveEmails`), then
   `CREATE UNIQUE INDEX idx_users_email_nocase`. Order is load-bearing: the
   index creation would fail on a database that already contains colliding rows.
6. Performance indexes.
7. Seeding — **only if the database is empty and `DEMO_MODE` is on**.
8. If `REQUIRE_EMAIL_VERIFICATION` is off: `UPDATE users SET email_verified = 1
   WHERE email_verified = 0`.
9. Check-in table, hours ledger (create + backfill + parity), certificates
   (create + backfill).

All of it is idempotent. Restarting repeatedly is safe.

**The one migration that can modify data unexpectedly** is step 5. If two
accounts differ only by capitalisation (`leo@x` and `Leo@x`), the account with
**fewer credited hours** is renamed to `local+dup-<rowid>@domain` and its
`token_version` bumped. It is never deleted and never merged, no user id
changes, and every rename is logged as `[Email dedupe] old -> new (id …)`. On a
fresh pilot database this is a guaranteed no-op — but **back up before the
first boot on new code** so any rename can be reviewed and reversed by hand.

The two manual migrations are covered in §5 step 7: `migrate_usernames.js` and
`bin/make-admin.mjs`.

### WAL mode

Applied at connection open, before any statement:

```js
db.exec('PRAGMA journal_mode = WAL');
```

Consequences you must operate around:

- **WAL is written into the database header and persists.** Every tool that
  opens the file — `sqlite3`, your backup script, `verifyHours.js` — sees WAL
  mode.
- **Two sidecar files appear:** `wevolunteer.db-wal` (committed pages not yet
  checkpointed into the main file) and `wevolunteer.db-shm` (the shared-memory
  index). Both are gitignored.
- **The `-wal` file can be far larger than the `.db` file.** Verified on a
  fresh boot: 519 KB of WAL against 4 KB of main database. A backup that copies
  only the `.db` is not a backup.
- **WAL requires real filesystem shared-memory locking.** Never place the
  database on NFS or SMB.

Check the current mode:

```bash
sqlite3 /var/lib/wevolunteer/wevolunteer.db 'PRAGMA journal_mode;'   # → wal
```

Force a checkpoint (folds the WAL into the main file — useful before a copy):

```bash
sqlite3 /var/lib/wevolunteer/wevolunteer.db 'PRAGMA wal_checkpoint(TRUNCATE);'
```

### busy_timeout

```js
db.exec('PRAGMA busy_timeout = 5000');
```

The SQLite default is `0` — a blocked writer fails **immediately** with
`SQLITE_BUSY`. Five seconds gives it a retry window. This matters because
several things open the same file: the server process, the 15-minute
notification sweep (same process, but interleaved), `verifyHours.js`,
`migrate_usernames.js`, and `bin/make-admin.mjs`.

`busy_timeout` is **per-connection**, so it applies only to connections that set
it. `db.js` does; the `sqlite3` CLI does not. If you run a long-running write
from the CLI while the server is up, the *server* will wait 5 s and then error.
**Keep CLI writes short, or stop the service first.**

Verify:

```bash
sqlite3 /var/lib/wevolunteer/wevolunteer.db 'PRAGMA busy_timeout;'   # CLI shows 0 — that is the CLI's own connection
```

To observe the app's value you need the app's connection; the pragma test in
`server/db.pragmas.test.js` asserts `>= 1000` and passes.

### Certificate backfill

Runs at every boot via `initCertificates()`. For every distinct
`(user_id, event_id)` in `attendance WHERE present = 1` without a stored code,
it generates a random `WEV-XXXX-XXXX` code and inserts it. Idempotent — a
second run finds nothing to do. It logs `[Certificates] Issued N code(s).` only
when N > 0.

Codes are also issued on demand by `GET /api/certificates`, so a certificate
that somehow lacks one gets it the first time the student opens the page.

Never writes to `attendance`.

Inspect:

```bash
sqlite3 /var/lib/wevolunteer/wevolunteer.db \
  'SELECT COUNT(*) FROM certificates;
   SELECT COUNT(DISTINCT user_id || ":" || event_id) FROM attendance WHERE present = 1;'
```

The two numbers should match after a boot. A shortfall means the backfill did
not complete — check the boot log for an exception.

### Schema verification

After any deploy, confirm the migrations actually landed:

```bash
sqlite3 /var/lib/wevolunteer/wevolunteer.db <<'SQL'
.headers on
SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;
SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name;
PRAGMA table_info(users);
SQL
```

Expect 16 tables (listed in §2) and these indexes:
`idx_users_username`, `idx_users_email_nocase`, `idx_notifications_dedupe`,
`idx_notifications_user`, `idx_comments_event`, `idx_announcements_event`,
`idx_applications_event`, `idx_applications_slot`, `idx_attendance_user`,
`idx_attendance_event`, `idx_slots_event`, `idx_events_organizer`,
`idx_checkin_event`, `idx_ledger_user`, `idx_ledger_event`, `idx_ledger_slot`.

`users` must include `token_version`, `email_verified`, `username`,
`leaderboard_opt_in`, and `profile_visibility`.

### Integrity checks

Run these weekly and after any incident:

```bash
# Structural integrity — the important one. "ok" is the only acceptable answer.
sqlite3 /var/lib/wevolunteer/wevolunteer.db 'PRAGMA integrity_check;'

# Referential integrity — no output means no violations
sqlite3 /var/lib/wevolunteer/wevolunteer.db 'PRAGMA foreign_key_check;'

# Hours parity — the application-level invariant
cd /srv/wevolunteer && sudo -u wev node server/verifyHours.js /var/lib/wevolunteer/wevolunteer.db
```

`verifyHours.js` is the blocking gate: it exits `1` on a mismatch and prints
every disagreeing user. Note the asymmetry with boot — **boot logs a parity
mismatch and carries on**, deliberately, because the ledger is additive and
taking the platform down for every user over a reporting discrepancy would be
worse than the discrepancy. The script is the version that fails hard. Wire it
into your deploy pipeline, not into the service's startup.

A useful ad-hoc sanity query — credited hours per volunteer, straight from the
source of truth:

```sql
SELECT u.name, ROUND(SUM(a.hours_awarded), 2) AS hours
FROM users u JOIN attendance a ON a.user_id = u.id
WHERE a.present = 1 GROUP BY u.id ORDER BY hours DESC;
```

---

## 7. Backup strategy

SQLite on local disk with no replica means **backups are your entire disaster
recovery story.** Treat this section as mandatory, not optional.

### When to back up

| Trigger | Why |
|---|---|
| **Before every deploy** | `initDatabase()` runs migrations on boot, including the email dedupe that can rename accounts. Non-negotiable. |
| **Before running any manual migration** | `migrate_usernames.js`, `make-admin.mjs`, or any manual SQL. |
| **Nightly, automated** | The baseline. Schedule outside event hours (e.g. 03:00 local). |
| **Immediately after each event's attendance is finalised** | That is when credited hours — the highest-value data in the system — are created. |
| **Before any incident-response action in §12** | Especially anything involving `.recover` or a restore. |
| **Before enabling `REQUIRE_EMAIL_VERIFICATION`** | It changes the access posture for every account. |

Retention suggestion for a pilot: 14 nightly, 8 weekly, 6 monthly. Keep at
least one copy off the server.

### What must be copied

**All three files, or none.** The main `.db` alone is not a backup —
verified: a fresh database was 4 KB of `.db` against 519 KB of `-wal`.

```
/var/lib/wevolunteer/wevolunteer.db
/var/lib/wevolunteer/wevolunteer.db-wal
/var/lib/wevolunteer/wevolunteer.db-shm
```

There are two correct approaches. **Prefer the first.**

#### Method A — `.backup` on the live database (recommended, no downtime)

SQLite's online backup API produces a single consistent file while the server
keeps running. It handles the WAL for you, so the output needs no sidecars.

**This is implemented and tested as [`bin/backup.sh`](../../bin/backup.sh).** Use
it rather than hand-rolling the commands:

```bash
WEV_DB_PATH=/var/lib/wevolunteer/wevolunteer.db \
WEV_BACKUP_DIR=/var/backups/wevolunteer \
  /srv/wevolunteer/bin/backup.sh
```

**Schedule it with the systemd timer in [`deploy/`](../../deploy/README.md)** —
that directory holds `wevolunteer-backup.service` and `.timer`, with install and
verification steps:

```bash
sudo install -m 644 /srv/wevolunteer/deploy/wevolunteer-backup.service /etc/systemd/system/
sudo install -m 644 /srv/wevolunteer/deploy/wevolunteer-backup.timer   /etc/systemd/system/
sudo install -d -o wev -g wev -m 700 /var/backups/wevolunteer
sudo systemctl daemon-reload
sudo systemctl enable --now wevolunteer-backup.timer
sudo systemctl start wevolunteer-backup.service   # prove it works now, not at 03:00
```

The timer sets `Persistent=true`, so a host that was off at 03:00 runs the
backup when it comes back rather than skipping the night. A failed integrity
check exits non-zero, which systemd records as a failed unit — add an
`OnFailure=` drop-in so a human hears about it.

If you prefer cron, the equivalent line as the `wev` user is:

```bash
0 3 * * * /srv/wevolunteer/bin/backup.sh >> /var/log/wevolunteer-backup.log 2>&1
```

The script integrity-checks every backup **before keeping it**, deletes and
fails loudly if the check does not return `ok`, logs a users / credited-hours /
certificates count so a structurally-valid-but-empty backup is also caught, and
prunes old files only *after* a successful new one — so a run of failures can
never age out the last good copy.

> **Why not `cp`.** Verified on a live database during the pilot readiness work:
> with a record written and the WAL not yet checkpointed, `cp` of the `.db`
> alone captured **0 rows** of that record, while `.backup` captured it. The
> `cp` output opened cleanly and reported no error. That is the failure mode
> this script exists to prevent.

#### Method B — cold file copy (for a pre-deploy snapshot)

Stop the service so writes cease, checkpoint the WAL, then copy all three:

```bash
sudo systemctl stop wevolunteer
sudo -u wev sqlite3 /var/lib/wevolunteer/wevolunteer.db 'PRAGMA wal_checkpoint(TRUNCATE);'
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
sudo -u wev cp /var/lib/wevolunteer/wevolunteer.db     "/var/backups/wevolunteer/pre-deploy-$STAMP.db"
sudo -u wev cp /var/lib/wevolunteer/wevolunteer.db-wal "/var/backups/wevolunteer/pre-deploy-$STAMP.db-wal" 2>/dev/null || true
sudo -u wev cp /var/lib/wevolunteer/wevolunteer.db-shm "/var/backups/wevolunteer/pre-deploy-$STAMP.db-shm" 2>/dev/null || true
sudo systemctl start wevolunteer
```

The `|| true` on the sidecars is deliberate: after a clean shutdown and a
`TRUNCATE` checkpoint they may legitimately be absent or empty.

> **Never** `cp` the `.db` alone while the server is running. You will get a
> file that opens without error and is missing the most recent writes — the
> worst possible failure mode, because nothing tells you.

### How to verify a backup

A backup you have not restored is a hypothesis. Verify every one automatically,
and do a full restore rehearsal before the pilot starts and monthly after.

**Per-backup automated check** (already in the script above, expanded here):

```bash
WORK=$(mktemp -d)
gunzip -c /var/backups/wevolunteer/wevolunteer-<stamp>.db.gz > "$WORK/check.db"

# 1. Structural integrity
sqlite3 "$WORK/check.db" 'PRAGMA integrity_check;'      # → ok
sqlite3 "$WORK/check.db" 'PRAGMA foreign_key_check;'    # → (no output)

# 2. The data is actually there
sqlite3 "$WORK/check.db" "
  SELECT 'users',        COUNT(*) FROM users
  UNION ALL SELECT 'events',       COUNT(*) FROM events
  UNION ALL SELECT 'applications', COUNT(*) FROM applications
  UNION ALL SELECT 'attendance',   COUNT(*) FROM attendance
  UNION ALL SELECT 'certificates', COUNT(*) FROM certificates
  UNION ALL SELECT 'ledger',       COUNT(*) FROM hours_ledger;"

# 3. Credited hours match the live system
sqlite3 "$WORK/check.db" \
  'SELECT ROUND(SUM(hours_awarded),2) FROM attendance WHERE present = 1;'

# 4. The application-level invariant holds in the backup
cd /srv/wevolunteer && node server/verifyHours.js "$WORK/check.db"   # → PASS

rm -rf "$WORK"
```

Compare (3) against the same query on the live database. A backup whose total
credited hours differs from production without an explanation is a backup you
cannot trust.

### Restore procedure

```bash
# 1. Stop the service. Nothing may be writing.
sudo systemctl stop wevolunteer

# 2. Preserve the current state — even if you believe it is corrupt.
#    You may need it to recover writes made after the backup.
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
sudo -u wev mkdir -p /var/backups/wevolunteer/incident-$STAMP
sudo -u wev mv /var/lib/wevolunteer/wevolunteer.db*  /var/backups/wevolunteer/incident-$STAMP/

# 3. Restore.
sudo -u wev gunzip -c /var/backups/wevolunteer/wevolunteer-<stamp>.db.gz \
  > /var/lib/wevolunteer/wevolunteer.db
sudo chown wev:wev /var/lib/wevolunteer/wevolunteer.db
sudo chmod 600     /var/lib/wevolunteer/wevolunteer.db

# 4. Verify BEFORE starting the service.
sudo -u wev sqlite3 /var/lib/wevolunteer/wevolunteer.db 'PRAGMA integrity_check;'
cd /srv/wevolunteer && sudo -u wev node server/verifyHours.js /var/lib/wevolunteer/wevolunteer.db

# 5. Start, and re-run the §10 smoke test.
sudo systemctl start wevolunteer
curl -sS https://volunteers.sbschools.example.org/health
```

Notes:

- **Do not restore the `-wal`/`-shm` from a Method A backup** — there are none,
  and the restored file is already consistent. If you are restoring a Method B
  cold copy, restore all three files together or none.
- The first boot after a restore re-runs `initDatabase()`. On a restored
  database this is a no-op for schema, but the ledger and certificate backfills
  will re-issue anything missing, and the parity check will report on the
  restored data. Read the boot log.
- **Everything after the backup timestamp is gone.** Applications submitted,
  attendance finalised, and hours credited in that window must be re-entered by
  hand. Tell the affected organizers explicitly; do not let students discover
  missing hours themselves.

### Rollback considerations

Rolling back *code* and rolling back *data* are different operations with
different risks.

**Code rollback is straightforward** — `git checkout <previous-sha>`,
`npm ci --include=dev`, `npm run build`, `npm prune --omit=dev`, restart. There
is no build-time coupling to the database.

**Schema rollback is not supported.** Migrations are forward-only:
`addColumnIfMissing` has no `removeColumn`, the `applications` rebuild has no
inverse, and there is no version marker to roll back *to*. In practice this is
survivable because every migration in this release is **additive** — an older
build simply ignores columns it does not know about. But:

- **Never roll back code across the email-dedupe migration without also
  restoring the database.** Renamed accounts stay renamed; older code has no
  concept of the rename and the affected users cannot sign in with their
  original address.
- **Never roll back across the certificate re-keying.** Not applicable to a
  fresh pilot (no pre-existing certificates), but if you ever restore a
  database from before it, previously issued codes stop verifying.
- **If you must roll back both**, restore the pre-deploy backup from §7
  Method B *and* check out the matching commit. Record the SHA in the backup
  filename so the pairing is unambiguous:
  `pre-deploy-<stamp>-<git-sha>.db`.

**Order matters on a rollback:** stop the service → restore the database →
check out the old code → reinstall and rebuild → verify → start. Starting new
code against an old database, even briefly, applies migrations you were trying
to avoid.

---

## 8. Email operations

### What the system actually sends

Two messages, both from `server/email.js`:

| Message | Trigger | Link |
|---|---|---|
| **Email verification** | Signup, when `REQUIRE_EMAIL_VERIFICATION=true`; and `POST /api/auth/resend-verification` | `${APP_URL}/?verify=<64 hex chars>`, expires in **24 hours** |
| **Password reset** | `POST /api/auth/forgot-password` | `${APP_URL}/?reset=<64 hex chars>`, expires in **1 hour** |

**Nothing else is emailed.** Selection results, waitlist promotions, event
cancellations, location changes, shift reminders, and hours credits are all
**in-app notifications only**. Plan the pilot's communication around that (§13).

Both links land on `/` with a query parameter; the client detects it and
redirects: `?verify=` is consumed by an effect in `App.jsx`, and `?reset=`
redirects to `/reset-password?token=…`. That works only if the SPA fallback is
serving `/` correctly — which is why §5 step 10 checks it.

Tokens are single-use and single-live-per-user: issuing a new one deletes the
previous one for that user.

### SMTP setup

1. **Choose a relay.** Any SMTP provider works — SendGrid, Postmark, Amazon
   SES, Mailgun, or the district's own Exchange/Google Workspace relay. For a
   school district, using the district's own relay is usually the right call:
   deliverability to `@student.district.org` addresses is already solved.

2. **Get a sending credential** scoped to send-only.

3. **Decide the From address** and make sure the relay is authorised to send as
   it. Set `EMAIL_FROM` accordingly.

4. **Set up DNS before sending anything:**
   - **SPF** — a TXT record on the sending domain authorising the relay.
   - **DKIM** — the selector record your provider gives you.
   - **DMARC** — at minimum `v=DMARC1; p=none; rua=mailto:…` so you get
     reports. Tighten to `quarantine` once you see clean alignment.

   These are not optional for a domain that has never sent mail. Password reset
   mail that lands in spam is indistinguishable, to the user, from a broken
   account.

5. **Set the port and TLS mode.** `SMTP_PORT=587` gives STARTTLS;
   `SMTP_PORT=465` sets `secure: true`. There is no third option.

6. **Restart the service.** The transport is created at import time, so
   configuration changes require a restart, not just a reload.

Confirm the boot log shows `[Email] Configured to send via <host>`. If it says
`Running in mock mode`, `NODE_ENV` is not `production` — and in production it
would have refused to boot instead.

### Testing SMTP

**Test before enabling `REQUIRE_EMAIL_VERIFICATION`, not after.**

```bash
# 1. Connectivity from the server itself
nc -zv smtp.example.net 587

# 2. End-to-end through the app: request a reset for a real account you control
curl -sS -X POST https://volunteers.sbschools.example.org/api/auth/forgot-password \
  -H 'Content-Type: application/json' \
  -d '{"email":"ops.admin@district.example.org"}'
# → {"success":true,"message":"If that address has an account, a reset link is on its way."}
```

**That 200 tells you nothing about delivery.** The endpoint returns the same
response whether or not the address exists — that is deliberate, to avoid an
account-enumeration oracle — and `sendPasswordResetEmail` catches its own
errors and returns `false` without changing the response. The **only** signals
of a send failure are:

- The inbox (or absence of mail in it).
- `Error sending password reset email:` in the service log.

So the real test is: check the inbox, and check the log.

Verify all of the following on the received message:

- [ ] It arrives within a minute, in the **inbox**, not spam
- [ ] The `From` matches `EMAIL_FROM`
- [ ] The link hostname is **your** domain (catches a wrong `APP_URL`)
- [ ] The link is `https://`
- [ ] Clicking it opens the reset form, not a 404 (catches a broken SPA fallback)
- [ ] Both the plain-text and HTML parts render (the app sends both)
- [ ] Headers show SPF `pass` and DKIM `pass`

Then test on the platforms your users actually have — Gmail, Outlook/Office 365,
and the district's own mail — plus one mobile client.

### Password reset validation

Walk the full flow once, on a throwaway account, before the pilot:

1. `POST /api/auth/forgot-password` with the address → 200 with the neutral message.
2. Mail arrives; open the link → the reset form loads at `/reset-password?token=…`.
3. Submit a new password of **≥ 6 characters** (anything shorter is rejected
   with a 400).
4. → `{"success":true}`. Sign in with the new password: works.
5. Sign in with the old password: fails.
6. **Any other session for that user is now signed out** — `token_version` is
   incremented, so old tokens return 401 `Session expired, please sign in
   again`. Verify this by having a second browser signed in as that user before
   step 3; it should be kicked out.
7. Click the same link again: `That reset link is not valid. Request a new one.`
   (single use).
8. Request a link, wait > 1 hour, use it: `That reset link has expired.`
9. `POST /api/auth/forgot-password` for an address that does not exist: the
   **same** 200 message, and no mail. This is the enumeration guard — confirm it.
10. Request six resets in 15 minutes: the sixth returns **429**
    (`MAIL_RATE_LIMIT`, default 5).

### Email verification validation

Only relevant if you enable `REQUIRE_EMAIL_VERIFICATION`. Do this on a staging
copy or a throwaway account first.

1. Set `REQUIRE_EMAIL_VERIFICATION=true`, restart, confirm the boot log.
2. Sign up a new account → 201, with a token, but `emailVerified: false`.
3. The client shows the "Verify your email" wall. Any API call outside the
   allowlist (`/api/auth/me`, `/api/auth/verify-email`,
   `/api/auth/resend-verification`, `/api/notifications`) returns **403** with
   `code: "email_unverified"`.
4. Mail arrives; open the link → the client consumes `?verify=` and confirms.
5. `GET /api/auth/me` now reports `emailVerified: true`; the app is usable.
6. Re-use the same link → `That confirmation link is not valid.`
7. `POST /api/auth/resend-verification` issues a fresh token and invalidates the
   old one. Rate-limited by `MAIL_RATE_LIMIT`.
8. Tokens expire after **24 hours**.

**Two behaviours to know before you flip this flag:**

- **Existing accounts are safe.** The first time `email_verified` is created,
  every existing row is set to `1`, regardless of the flag. Turning verification
  on does not lock out current users.
- **Turning it back off retroactively verifies everyone.** With the flag off,
  boot runs `UPDATE users SET email_verified = 1 WHERE email_verified = 0`. If
  you enable it, some users sign up but do not confirm, and you then disable it,
  those accounts become verified at the next restart. That is intentional (a
  stale `0` would be an inescapable wall), but it means the flag is not a clean
  on/off switch for an audit trail.

### Failure handling

**What the code does on a send failure:** `sendVerificationEmail` and
`sendPasswordResetEmail` both wrap `transporter.sendMail` in try/catch, log
`Error sending … email:`, and return `false`. **No caller checks the return
value.** There is no retry, no queue, and no dead-letter. A failed send is a
lost message, and the user sees a success response.

Practical consequences and responses:

| Symptom | What is happening | What to do |
|---|---|---|
| Users report no reset mail; log shows `Error sending password reset email:` | The relay is rejecting or unreachable | Fix the relay. There is no retry — affected users must request a new link. |
| No mail, and **no** error in the log | The relay accepted it; it is a deliverability problem downstream | Check the provider's dashboard, SPF/DKIM alignment, and spam placement. |
| `FATAL: SMTP is not configured` on boot | One of `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS` is missing or empty | Fix the env file and restart. The app will not start until you do — this is by design. |
| Users get 429 on forgot-password | `MAIL_RATE_LIMIT` (default 5 / 15 min) | Usually correct behaviour. If a whole school shares one NAT IP and `TRUST_PROXY` is wrong, everyone shares a bucket — check that first before raising the limit. |
| Verification mail never arrives and users are locked out | SMTP broke *after* `REQUIRE_EMAIL_VERIFICATION` was enabled | **Set `REQUIRE_EMAIL_VERIFICATION=false` and restart.** Boot verifies everyone pending, which unblocks them immediately. Re-enable once mail is fixed. |

**During an SMTP outage, password reset is the loss that matters.** It is the
only self-service account-recovery path in the product. There is no admin
"reset this user's password" endpoint and no password-change endpoint for a
signed-in user. If mail is down and someone is locked out, the only recovery is
direct database intervention (see §12).

---

## 9. Security checklist

Work through this before opening the pilot to real users. Each item names the
check, not just the goal.

### HTTPS

- [ ] Valid CA certificate installed; `curl https://…/health` succeeds with no
      `-k`
- [ ] HTTP → HTTPS redirect returns 301
- [ ] Auto-renewal configured **and tested** (`certbot renew --dry-run`)
- [ ] HSTS present on responses (helmet sets it; confirm the proxy does not
      strip it)
- [ ] TLS 1.2 minimum
- [ ] `APP_URL` is `https://` — otherwise every reset link you email is plaintext
- [ ] The app is reachable **only** through the proxy; `curl http://<public-ip>:5050/health`
      from another host must fail

### JWT secret

- [ ] `JWT_SECRET` set, 32 bytes of randomness (`openssl rand -hex 32`)
- [ ] It is **not** the development value `npm run dev` supplies (`dev-only-insecure-secret-do-not-use-in-production`)
- [ ] Stored only in the systemd `EnvironmentFile`, mode `600`, owned by `wev`
- [ ] Not in git — `git log -S 'JWT_SECRET=' --oneline` returns nothing meaningful
- [ ] Not visible in `ps` output (it comes from `EnvironmentFile`, not the
      command line)
- [ ] Rotation procedure understood: changing it signs everyone out; there is no
      dual-key grace period

### SMTP credentials

- [ ] `SMTP_PASS` in the `600` env file only
- [ ] Credential is send-only, scoped to this application
- [ ] Rotation procedure known (change env file → restart; transport is built at
      import)
- [ ] SPF, DKIM, DMARC published
- [ ] `EMAIL_FROM` is an address the relay is authorised to use

### CORS

- [ ] `CORS_ORIGINS` set to your real origin — **not** the `localhost` default
- [ ] No wildcard; the implementation has no wildcard support, so verify you did
      not add one
- [ ] Understood: requests with **no** `Origin` header always pass (curl,
      same-origin navigation). CORS is a browser control, not an authentication
      control — it is not protecting your API from scripted access.
- [ ] A rejected origin returns 403 `{"error":"Origin not allowed."}` — test it:
      `curl -H 'Origin: https://evil.example' https://…/api/events`

### Rate limits

Four limiters, all **in-memory and per-process** (`express-rate-limit` default
store):

- [ ] `authLimiter` — 10 / 15 min on login, signup, reset-password, verify-email
      (**failures only**)
- [ ] `mailLimiter` — 5 / 15 min on forgot-password and resend-verification
      (**every request**)
- [ ] `verifyLimiter` — 20 / 15 min on the public certificate verify endpoint
      (**every request**, deliberately: a successful lookup is what enumeration
      looks like)
- [ ] `apiLimiter` — 600 / 15 min across `/api`
- [ ] `TRUST_PROXY` set correctly — **without it every user shares one bucket**
- [ ] Understood: **a restart resets all counters**, and running more than one
      instance breaks limiting entirely (see §14)
- [ ] `DEMO_MODE` off, so limits are not the ~100× demo values

Verify: eleven bad logins in a row should produce a 429.

### Privacy protections

This system holds data about minors. These behaviours are implemented and
tested — confirm they still hold after any change:

- [ ] **Hours and totals never expose contact details.** Student `grade`, `bio`,
      `school`, and `email` on `/api/users/:id/profile` are visible only to the
      student themselves, an admin, or an organizer who **hosts an event that
      student applied to**.
- [ ] **Upcoming shifts are self-only.** A confirmed future shift discloses a
      minor's location at a known time; the `upcoming` array is returned only to
      the student themselves.
- [ ] **The leaderboard is opt-in and default-off** (`leaderboard_opt_in = 0`).
      Verify a new account does not appear on it.
- [ ] **Arrival instructions are gated** to the organizer, admins, and accepted
      volunteers.
- [ ] **The certificate verify endpoint omits grade** and returns only what a
      printed certificate already shows.
- [ ] **All API endpoints except `/health` and `/api/certificates/verify/:code`
      require authentication.** Verify: `curl https://…/api/events` without a
      token → 401.
- [ ] Roster CSV export contains student emails and schools — confirm organizers
      understand it is a controlled document.

### Certificate verification

- [ ] Codes are random (`crypto.randomBytes`) and stored — not derivable from
      user/event ids
- [ ] `/api/certificates/verify/:code` is public **and** rate-limited to 20 / 15 min
- [ ] It is a single indexed lookup (`UNIQUE(code)`), not a scan
- [ ] Response omits grade
- [ ] A bad code returns 404 `{"valid":false,…}` with no distinguishing detail
- [ ] The public `/verify/:code` SPA route loads without a session — test it in
      a private window

### Admin permissions

- [ ] Exactly one admin exists at launch; you know who it is
      (`SELECT id, name, email FROM users WHERE role = 'admin';`)
- [ ] Admins cannot be self-registered — signup rejects any role but `student`
      and `organizer`
- [ ] Promotion requires shell access to the server (`bin/make-admin.mjs`)
- [ ] The admin account has a strong, unique password (minimum enforced is only
      **6 characters** — do not rely on it)
- [ ] Understood: **admins can delete any event and any comment**, approve or
      deny organizers, and see platform-wide stats
- [ ] Understood: organizer *denial* deliberately only deletes an
      **unapproved** organizer — the scoped query exists so a mistyped id
      cannot cascade-delete a student and their credited hours
- [ ] A second admin exists, or the recovery procedure in §12 is documented and
      the on-call engineer has server access

### Organizer permissions

- [ ] New organizers start `verified = 0` and **cannot create events** — verify
      with a test account: `POST /api/events` → 403 `Organizer account pending
      admin approval`
- [ ] Organizers can only act on **their own** events; ownership is checked
      per-resource
- [ ] Only organizers can finalise attendance, and only for events they host
- [ ] An organizer sees student PII only for students who applied to their events
- [ ] Attendance corrections require a typed reason and are recorded in
      `hours_ledger` with the actor
- [ ] Events with recorded attendance **cannot be deleted** (409
      `attendance_exists`) — cancellation is the only way to call one off
- [ ] Auto Select cannot run before the deadline, is capped at
      `MAX_AUTO_SELECT_DRAWS`, and every re-draw requires a reason

### Logging

Current state, so you know what you are working with:

- [ ] Understood: **there is no HTTP request logging.** No morgan, no access
      log. You cannot reconstruct who called what over the API.
- [ ] Understood: **there is no log rotation** in the app. Output goes to
      stdout/stderr; use `journald` to manage logs.
- [ ] Configure journald retention explicitly — an unbounded journal is the most
      likely cause of a disk-full incident on this deployment. Ensure you edit `/etc/systemd/journald.conf` and set `SystemMaxUse=1G` (or an appropriate limit) and restart the daemon with `sudo systemctl restart systemd-journald`.
- [ ] Be aware the log contains **email addresses** in some paths — the
      `[Email dedupe]` migration logs old and new addresses. Treat logs as
      containing PII: restrict read access, and set a retention limit.
- [ ] Confirm no secret is logged. `[Email] Configured to send via <host>` logs
      the host only, never the password. In **non-production** the console mock
      prints full message bodies **including live reset tokens** — one more
      reason `NODE_ENV=production` matters.
- [ ] The audit trail that *does* exist is `hours_ledger`: every change to
      credited hours, with actor, source, reason, and timestamp. It is
      append-only and has **no foreign keys by design**, so it survives deletion
      of the user or event it describes. Do not "fix" that.

---

## 10. Production smoke test

Run this end-to-end after the initial deployment and after every subsequent
deploy. It exercises every major workflow. Budget about 45 minutes, plus a
~10-minute wait in section F.

**Setup.** Use throwaway accounts on a domain you control. Record the base URL
and keep tokens in shell variables.

```bash
BASE=https://volunteers.sbschools.example.org
```

### A — Infrastructure

| # | Action | Expected outcome |
|---|---|---|
| A1 | `curl -sS $BASE/health` | `{"status":"ok","database":"connected","version":"1.0.0"}` |
| A2 | `curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' $BASE/` | `200 text/html; charset=UTF-8` |
| A3 | `curl -sS -o /dev/null -w '%{http_code}\n' $BASE/events` | `200` — SPA fallback works for deep links |
| A4 | `curl -sS $BASE/api/nope` | `{"error":"Not found: GET /api/nope"}` — JSON, not HTML |
| A5 | `curl -sS $BASE/api/events` (no token) | `401 {"error":"Access token required"}` |
| A6 | `curl -sS -X POST $BASE/api/auth/reset` | `404` — demo reset endpoint absent |
| A7 | `curl -sS -o /dev/null -w '%{http_code}\n' http://volunteers…/` | `301` to HTTPS |
| A8 | Open `$BASE` in a browser; check the console | No errors; no demo account switcher visible |

### B — Accounts and authentication

| # | Action | Expected outcome |
|---|---|---|
| B1 | Sign up a student via the UI (`smoke.student@…`, username `smokestudent`, grade 11) | 201; signed in; dashboard renders with 0 hours |
| B2 | Sign up with the **same email**, different case | `400 Email address already registered` |
| B3 | Sign up with the **same username**, different case | `400 That username is already taken` |
| B4 | Sign up with a 5-character password | `400 Password must be at least 6 characters long` |
| B5 | Sign up with `role: "admin"` via curl | `400 Role must be student or organizer` |
| B6 | Log in with the wrong password | `401 Invalid email or password` |
| B7 | Log in with the **email in a different case** | Succeeds — matching is `COLLATE NOCASE` |
| B8 | `GET /api/auth/me` with the token | Own profile; `volunteeredHours: 0` |
| B9 | `GET /api/auth/me` with a mangled token | `403 Invalid or expired token` |
| B10 | 11 failed logins in a row | The 11th returns `429` |

### C — Roles and approval gate

| # | Action | Expected outcome |
|---|---|---|
| C1 | Sign up an organizer (`smoke.org@…`) | 201; `verified: false` |
| C2 | As that organizer, `POST /api/events` | `403 Organizer account pending admin approval. You cannot create events yet.` |
| C3 | As admin, `GET /api/admin/organizers/pending` | The new organizer is listed |
| C4 | As the **student**, `GET /api/admin/organizers/pending` | `403 Access denied: Administrators only` |
| C5 | As admin, `POST /api/admin/organizers/<id>/approve` | `{"success":true}`; organizer receives an `approval` notification |
| C6 | As the organizer, retry `POST /api/events` | Now permitted (proceed to D) |

### D — Event creation and validation

Create the event with tight timings so the rest of the test can complete in one
sitting — **deadline `now + 5 min`, shift start `now + 6 min`, end `now + 7 min`.**
This matters: the API refuses a deadline in the past at creation *and* refuses
an Auto Select draw before the deadline, so the only way to exercise the full
lifecycle is to let a few real minutes elapse.

| # | Action | Expected outcome |
|---|---|---|
| D1 | Create an event: category `Other`, 1 slot, `maxSpots: 1`, **`autoApprove: true`**, deadline +5 min, slot +6/+7 min | `201` with an event id |
| D2 | Create an event with a deadline **in the past** | `400 The application deadline must be a valid date in the future.` |
| D3 | Create an event whose slot **ends before it starts** | `400 Each shift must end after it starts.` |
| D4 | Create an event with `maxSpots: 10000` | `400 Each shift must allow between 1 and 100 volunteers.` |
| D5 | Create an event with a deadline **after** the first shift starts | `400 The application deadline must be on or before the first shift starts.` |
| D6 | Create an event with category `Bogus` | `400 Invalid category…` |
| D7 | `POST /api/events` with malformed JSON | `400 {"error":"Invalid JSON"}` — not a 500 |
| D8 | As the student, `GET /api/events` | The event appears; `instructions` is `""` (not accepted yet) |

### E — Applications

| # | Action | Expected outcome |
|---|---|---|
| E1 | As the student, apply to the slot | `201`; status `pending`; organizer gets an `application` notification |
| E2 | Apply to the **same slot** again | `400 You have already applied for this time slot` |
| E3 | Withdraw the application, then re-apply | Succeeds — the withdrawn row is revived, not blocked |
| E4 | Sign up a **second** student and apply to the same 1-spot slot | `201` — two pending applicants for one spot |
| E5 | As the organizer, `GET /api/applications` | Both applicants, each with volunteer history |
| E6 | As the **first student**, `GET /api/applications` | **Only their own** application |
| E7 | Apply as the **organizer** account | `403 Access denied: Only students can apply for events` |

### F — Auto Select (wait for the deadline)

| # | Action | Expected outcome |
|---|---|---|
| F1 | Before the deadline, run Auto Select | `400 Applications are still open; selection can run after the deadline.` (`deadline_not_passed`) |
| F2 | Wait until the deadline passes (~5 min from D1), then run it | `200` with `selectedIds` (1) and `waitlistIds` (1) |
| F3 | Run it **again with no reason** | `400 A re-draw requires a reason.` (`reason_required`) |
| F4 | Run again **with** a reason | `200`, `runNumber: 2` |
| F5 | Run a 6th time | `409 The maximum number of re-draws has been reached…` (`draw_cap_reached`) |
| F6 | `GET /api/events/:id/auto-select/runs` | Every draft run, with `reason` on the re-draws — the audit trail |
| F7 | Confirm the latest run | `200`; one applicant `accepted`, one `waitlisted`; both notified; event closes |
| F8 | Confirm again | `400 Selection is already confirmed and locked` |
| F9 | As the accepted student, `GET /api/events` | `instructions` now **visible** for this event |

### G — Check-in (during the shift)

| # | Action | Expected outcome |
|---|---|---|
| G1 | As the organizer, open `/checkin/<eventId>` | The roster of accepted volunteers loads |
| G2 | Mark the accepted student present | `{"success":true,"marked":1,…}` |
| G3 | `GET /api/events/:id/checkin` | The mark is recorded |
| G4 | `GET /api/auth/me` as that student | `volunteeredHours` is **still 0** — check-in credits nothing |
| G5 | As a **student**, `GET /api/events/:id/checkin` | `403 Access denied` |

### H — Attendance and hours (after the shift ends)

| # | Action | Expected outcome |
|---|---|---|
| H1 | **Before** the slot end time, finalise attendance | `409` `shift_not_ended` — "use check-in for those" |
| H2 | After the end time (~7 min from D1), finalise with the student present | `200`; `credited` lists them; student notified "X hours credited" |
| H3 | `GET /api/auth/me` as the student | `volunteeredHours` now equals the slot duration |
| H4 | Event status | Now `completed` (all shifts ended, all accepted volunteers accounted for) |
| H5 | Re-submit the **same** attendance | `unchanged: 1`; nothing rewritten |
| H6 | Change the student to **absent with no reason** | `400` `reason_required`, listing the affected record |
| H7 | Change to absent **with** a reason | `200`; hours revoked; student notified "Attendance record corrected" |
| H8 | Restore to present with a reason | `200`; hours restored |
| H9 | `node server/verifyHours.js <db>` | `PASS — ledger matches attendance…` |
| H10 | `SELECT * FROM hours_ledger WHERE user_id = '<id>' ORDER BY rowid;` | One row per change, each with actor, source, and reason |
| H11 | As a **different organizer**, finalise attendance on this event | `403 Access denied: You do not host this event` |
| H12 | `DELETE /api/events/<id>` | `409` `attendance_exists` — the event cannot be deleted |

### I — Certificates

| # | Action | Expected outcome |
|---|---|---|
| I1 | As the student, `GET /api/certificates` | One certificate with hours and a `WEV-XXXX-XXXX` code |
| I2 | Call it again | **The same code** — codes are stable |
| I3 | `curl $BASE/api/certificates/verify/<code>` (no auth) | `{"valid":true, volunteerName, eventTitle, organizerName, hours, completedAt}` — and **no grade** |
| I4 | Open `$BASE/verify/<code>` in a **private window** | The verification page renders without a login |
| I5 | Verify a made-up code | `404 {"valid":false,"error":"No certificate matches that code"}` |
| I6 | 21 verify requests in 15 minutes | The 21st returns `429` |

### J — Privacy

| # | Action | Expected outcome |
|---|---|---|
| J1 | As the **hosting organizer**, `GET /api/users/<studentId>/profile` | `email`, `grade`, `school`, `bio` are present |
| J2 | As an **unrelated organizer**, same call | Those fields are `null` |
| J3 | As **another student**, same call | Those fields are `null` |
| J4 | Any caller other than the student, check `upcoming` | Empty array — future whereabouts are self-only |
| J5 | As the student themselves | `upcoming` is populated |
| J6 | `GET /api/leaderboard` | The new student does **not** appear (opt-in defaults to off) |
| J7 | Opt in via profile edit, re-check | Now appears |
| J8 | As a student, `GET /api/events/<id>` (organizer view) | `403` — students cannot enumerate an applicant roster |

### K — Content, notifications, moderation

| # | Action | Expected outcome |
|---|---|---|
| K1 | Student posts a comment on the event | `201`; organizer gets a `comment` notification |
| K2 | Organizer posts an announcement | Confirmed volunteers get an `announcement` notification |
| K3 | Student `GET /api/notifications` | Their notifications, newest first, unread flagged |
| K4 | Mark all read | Unread count → 0 |
| K5 | Student reports the event | `201`; visible in `GET /api/admin/reports` as admin |
| K6 | Admin resolves the report | `{"success":true}` |
| K7 | Student tries to delete another user's comment | `403` |
| K8 | Organizer exports `GET /api/events/<id>/roster.csv` | CSV downloads with correct headers and quoted fields |

### L — Cancellation and admin views

| # | Action | Expected outcome |
|---|---|---|
| L1 | Create a second event; a student applies and is accepted | Baseline state |
| L2 | Organizer sets status to `cancelled` | `{"success":true,"status":"cancelled","notified":N}`; volunteers get a `cancelled` notification |
| L3 | Try to change a **completed** event's status | `409` `event_completed` |
| L4 | `GET /api/admin/stats` as admin | Totals, attendance/completion/participation rates, monthly charts, top organizers |
| L5 | `GET /api/admin/stats` as an organizer | `403 Access denied` |

### M — Post-test cleanup and final state

| # | Action | Expected outcome |
|---|---|---|
| M1 | `PRAGMA integrity_check` | `ok` |
| M2 | `PRAGMA foreign_key_check` | No output |
| M3 | `node server/verifyHours.js <db>` | `PASS` |
| M4 | `journalctl -u wevolunteer` for the test window | No `Unhandled error:` entries |
| M5 | Remove the smoke-test accounts and events, **or** note them as known test data | Decide deliberately — deleting a user cascades to their applications; an event with attendance cannot be deleted at all |
| M6 | Take a backup and verify it (§7) | `PASS` |

---

## 11. Monitoring

### Health endpoint

`GET /health` — unauthenticated, outside the `/api` rate limiter, and
registered before the SPA catch-all so it can never return HTML.

```bash
curl -sf https://volunteers.sbschools.example.org/health
```

- `200 {"status":"ok","database":"connected","version":"1.0.0"}` — the process
  is up **and** SQLite answered `SELECT 1`.
- `500 {"status":"error","database":"disconnected"}` — the process is up but the
  database is not answering. This is the serious one: it means the file is
  locked, missing, or corrupt.
- Connection refused / timeout — the process is down, or the proxy is broken.

Poll every 30–60 s from your uptime monitor. **Alert on two consecutive
failures**, not one — a single miss during a checkpoint is not an incident.

Note what it does **not** cover: it does not check SMTP, does not check disk,
does not check ledger parity, and it reports a hardcoded version string. Treat
it as liveness plus a shallow database probe, nothing more.

### Logs to monitor

Everything goes to stdout/stderr → journald. `journalctl -u wevolunteer -f`.

**Fatal — the process will not start:**

```
FATAL: JWT_SECRET must be set.
FATAL: DEMO_MODE cannot be enabled in production.
FATAL: SMTP is not configured (SMTP_HOST, SMTP_USER, SMTP_PASS are required in production).
```

**Errors — always investigate:**

| Log line | Meaning |
|---|---|
| `Unhandled error:` | An unexpected exception reached the error handler. The user got a 500. |
| `[Hours ledger] PARITY MISMATCH` | The ledger disagrees with attendance. Boot continues deliberately. **Page someone.** |
| `Error sending password reset email:` | A user asked for a reset and did not get one. No retry exists. |
| `Error sending verification email:` | Same, for confirmations. |
| `Notification sweep failed:` | The 15-minute sweep threw. Reminders are not being sent. |
| `Database error:` | From `bin/make-admin.mjs`. |

**Warnings — note but do not page:**

| Log line | Meaning |
|---|---|
| `Origin not allowed by CORS: …` | Either a misconfigured `CORS_ORIGINS` or someone probing. A burst of these right after a deploy means you broke your own frontend. |
| `[Email dedupe] old -> new (id …)` | A migration renamed a duplicate-email account. **Review every one of these by hand.** |
| `Unknown notification kind "…"` | A code path is emitting a kind outside the closed set; it fell back to `info`. |
| `Failed to create notification:` | A notification write failed for a reason other than the dedupe UNIQUE. |

**Expected at every boot — not problems:**

```
ExperimentalWarning: SQLite is an experimental feature…
[Email] Configured to send via <host>
[Security] DEMO_MODE is off — the database reset endpoint is not registered.
Database already initialized.
WeVolunteer API Server listening on port 5050
```

**Expected only on a fresh database:** the `Migration: added …` lines and
`Empty database initialized. DEMO_MODE is off…`.

> **`Seeding database...` in production is an incident.** It means `DEMO_MODE`
> was on against an empty database. Stop the service immediately.

### Operational metrics

There is **no metrics endpoint and no instrumentation.** Everything below is
collected by querying the database or reading the log. Run these on a schedule
and record the numbers — a trend is far more useful than a snapshot.

**Platform activity** (`GET /api/admin/stats` as an admin, or directly):

```sql
SELECT
  (SELECT COUNT(*) FROM users WHERE role='student')                   AS students,
  (SELECT COUNT(*) FROM users WHERE role='organizer' AND verified=1)  AS organizers,
  (SELECT COUNT(*) FROM users WHERE role='organizer' AND verified=0)  AS pending_organizers,
  (SELECT COUNT(*) FROM events WHERE status='open')                   AS open_events,
  (SELECT COUNT(*) FROM applications WHERE status='pending')          AS pending_applications,
  (SELECT ROUND(SUM(hours_awarded),1) FROM attendance WHERE present=1) AS credited_hours,
  (SELECT COUNT(DISTINCT user_id) FROM attendance WHERE present=1)    AS active_volunteers,
  (SELECT COUNT(*) FROM certificates)                                 AS certificates_issued;
```

**The most important operational query** — events whose deadline has passed but
whose applicants are still `pending`. Nothing in the system does this
automatically, and it is the leading indicator of the biggest workflow hole
(§14):

```sql
SELECT e.id, e.title, e.application_deadline,
       (SELECT COUNT(*) FROM applications a
        WHERE a.event_id = e.id AND a.status = 'pending') AS stuck
FROM events e
WHERE e.status = 'open'
  AND e.application_deadline < datetime('now')
  AND stuck > 0
ORDER BY e.application_deadline;
```

**System metrics** (standard host monitoring):

- Process up/down, RSS, CPU
- Disk free on the database volume **and** the journal volume
- Database file sizes: `ls -la /var/lib/wevolunteer/`
- Backup job exit status and the age of the newest backup
- TLS certificate expiry

### Warning signs

| Signal | What it probably means |
|---|---|
| `-wal` file growing steadily and never shrinking | Checkpoints are not completing — usually a long-lived reader. Investigate before it fills the disk. |
| Ledger parity mismatch at boot | Something wrote to `attendance` outside `finalizeAttendance`. Manual SQL is the usual cause. |
| Rising `Origin not allowed by CORS` | Misconfiguration after a deploy, or scanning. |
| Health check flapping | Database contention, or the process restarting under memory pressure. |
| Sustained 429s on `/api/auth/login` | Either a credential-stuffing attempt, or `TRUST_PROXY` is wrong and a whole school shares one bucket. Check `TRUST_PROXY` first. |
| Events with passed deadlines and pending applicants | An organizer has forgotten to run Auto Select. Students are in limbo. |
| Disk above 80% | Almost always the journal, not the data. Check `journalctl --disk-usage`. |
| No `[Notifications] Sent N…` lines for days | Could be normal (nothing due) or could be a stalled sweep. Correlate with upcoming shifts. |
| Response times climbing on `/api/applications` | The known full-table attendance scan is starting to bite. |

### Failure conditions

| Condition | Symptom | Severity |
|---|---|---|
| Process down | Connection refused | **Critical** — total outage |
| Database file unreadable/corrupt | `/health` returns 500 | **Critical** — §12 |
| Disk full | Writes fail; 500s on any mutation | **Critical** — reads may still work, masking it |
| SMTP down | No error to users; log shows send failures | **High** — account recovery is broken |
| Ledger parity mismatch | Boot log; `verifyHours.js` exits 1 | **High** — hours reporting is suspect |
| Proxy/TLS failure | Browser errors; `/health` unreachable externally | **Critical** |
| Certificate expired | TLS errors for everyone | **Critical**, and entirely preventable |
| Rate limiter collapse (bad `TRUST_PROXY`) | Legitimate users get 429 | **High** |
| Memory exhaustion | OOM kill, systemd restart loop | **High** |

### Recommended alerts

| Alert | Condition | Priority |
|---|---|---|
| Service down | `/health` fails twice consecutively | **Page** |
| Database disconnected | `/health` returns 500 | **Page** |
| Disk > 85% on `/var/lib` or `/var/log` | Threshold | **Page** |
| Ledger parity mismatch | `PARITY MISMATCH` in log, or `verifyHours.js` exit 1 | **Page** |
| Unhandled errors | > 5 `Unhandled error:` in 15 min | **Page** |
| TLS expiry | < 14 days remaining | **Page** |
| Backup failed or stale | Job non-zero, or newest backup > 26 h old | **Page** |
| Mail send failures | Any `Error sending … email:` | Ticket |
| Restart loop | > 3 restarts in 10 min | **Page** |
| Auth 429 spike | > 50 in 15 min | Ticket |
| CORS rejections | > 20 in 15 min | Ticket |
| Stuck selections | The "pending past deadline" query returns rows | **Daily digest to the programme owner, not to engineering** |
| Pending organizers | Unapproved > 48 h | Weekly digest to the admin |

### Measured performance at pilot scale (2026-07-31)

Measured against a seeded database of **554 users (500 students, 40 organizers),
122 events, 368 slots and 2,892 applications** — the pilot's stated shape — on a
single instance. Latencies are per request, over 20–50 samples each.

| Endpoint | p50 | p95 | max |
|---|---|---|---|
| `GET /api/events?limit=60` (what the SPA calls) | 5 ms | 7 ms | 13 ms |
| `GET /api/events` (unpaged) | 7 ms | 7 ms | 7 ms |
| `GET /api/auth/me` | 1 ms | 1 ms | 1 ms |
| `GET /api/applications` | 1 ms | 2 ms | 2 ms |
| `GET /api/stats/volunteer` | 1 ms | 1 ms | 1 ms |
| `GET /api/recommendations` | 1 ms | 2 ms | 2 ms |
| `GET /api/leaderboard` | 1 ms | 1 ms | 1 ms |
| `GET /api/events/:id` (detail + applicants) | 1 ms | 2 ms | 2 ms |
| `GET /api/events/:id/roster.csv` | 1 ms | 17 ms | 17 ms |
| `GET /health` | 0 ms | 1 ms | 1 ms |

Other measurements from the same run:

- **60 concurrent** paged event-list reads completed in **226 ms** total.
- **80 concurrent** applications to one slot: **66 ms**, all correct, capacity respected.
- The 15-minute `runNotificationSweep` takes **2–3 ms** at this scale, and three
  consecutive passes produced **zero** duplicate `(user_id, dedupe_key)` pairs — the
  dedupe holds.
- Payloads: paged (60 events) **71 KB**, unpaged (all 122) **139 KB**.

Nothing here is close to a limit. The N+1 work and the SQL-side filtering are
holding up.

**The one throughput characteristic worth knowing:** password hashing is
`bcryptjs` at 10 rounds and every call site is **synchronous** (`compareSync` /
`hashSync`) on a single-threaded event loop. Measured at **~27 ms per login** — 80
concurrent logins took 2.15 s wall clock, and during that window every other
request queues behind them.

For 500 students arriving across a morning this is invisible. For a burst — a
teacher telling one class of 30 to sign in simultaneously — expect a stall of
roughly 800 ms before everything completes. That is tolerable, and it is
deliberately **not** being changed in this release: converting seven
authentication call sites from sync to async is not a small change, and an error in
that code is an authentication defect rather than a slow page. Recorded here so the
number is known rather than rediscovered. If login latency ever becomes a real
complaint, that conversion (plus moving hashing to a worker thread) is the fix, and
it needs its own focused pass with its own test coverage.

---

---

## 12. Incident response

**Before any destructive action in this section: take a backup** (§7 Method B),
even if you believe the data is already broken. You cannot recover what you
overwrote while trying to recover.

### Database corruption

**Symptoms:** `/health` returns 500; `SQLITE_CORRUPT` / `database disk image is
malformed` in the log; queries fail on specific tables.

```bash
# 1. Stop writes immediately.
sudo systemctl stop wevolunteer

# 2. Preserve everything, exactly as it is.
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
sudo -u wev mkdir -p /var/backups/wevolunteer/corrupt-$STAMP
sudo -u wev cp -a /var/lib/wevolunteer/wevolunteer.db* /var/backups/wevolunteer/corrupt-$STAMP/

# 3. Assess.
sudo -u wev sqlite3 /var/lib/wevolunteer/wevolunteer.db 'PRAGMA integrity_check;'
```

- **`ok`** → the database is fine; the problem is elsewhere (permissions, disk
  full, the file moved). Check `df -h`, `ls -la`, and that `WEV_DB_PATH` still
  points where you think.
- **Errors listed** → decide between recovery and restore.

**Option A — restore from backup (preferred).** Follow §7 *Restore procedure*.
You lose everything since the last backup, but you get a known-good file.

**Option B — attempt recovery** (only if the backup is old enough that the lost
window matters):

```bash
sudo -u wev sqlite3 /var/backups/wevolunteer/corrupt-$STAMP/wevolunteer.db \
  ".recover" > /tmp/recovered.sql
sudo -u wev sqlite3 /var/lib/wevolunteer/recovered.db < /tmp/recovered.sql
sudo -u wev sqlite3 /var/lib/wevolunteer/recovered.db 'PRAGMA integrity_check;'
cd /srv/wevolunteer && sudo -u wev node server/verifyHours.js /var/lib/wevolunteer/recovered.db
```

`.recover` may silently drop rows. **Before putting a recovered file into
service, reconcile it against the last good backup**, especially:

```sql
SELECT COUNT(*), ROUND(SUM(hours_awarded),2) FROM attendance WHERE present = 1;
SELECT COUNT(*) FROM users;
SELECT COUNT(*) FROM certificates;
```

If credited hours dropped, **do not** put it into service silently — students'
service records are the one thing that must not quietly shrink. Restore from
backup instead and re-enter the delta by hand.

After either option: restart, run §10 sections A, H9–H10, and I, then take a
fresh backup.

**Post-incident:** corruption on a single-node SQLite deployment usually means
hardware, an unclean host shutdown, or a network filesystem. Check `dmesg`,
confirm the volume is local, and confirm you are not on NFS.

### SMTP outage

**Symptoms:** `Error sending … email:` in the log; users report no reset mail;
the provider's dashboard shows failures.

**Assess and mitigate:**

```bash
# Is the relay reachable from this host?
nc -zv "$SMTP_HOST" "$SMTP_PORT"

# What is the actual error?
sudo journalctl -u wevolunteer --since '1 hour ago' | grep -i 'error sending'
```

1. **If `REQUIRE_EMAIL_VERIFICATION=true`, turn it off now.** New signups are
   otherwise stranded behind a wall with no way through.
   ```bash
   # edit /srv/wevolunteer/.env.production → REQUIRE_EMAIL_VERIFICATION=false
   sudo systemctl restart wevolunteer
   ```
   Boot then runs `UPDATE users SET email_verified = 1 WHERE email_verified = 0`,
   unblocking everyone immediately.

2. **Communicate.** Password reset is the only self-service recovery path.
   Tell users through whatever channel the district actually uses that reset
   email is delayed, and give them a person to contact.

3. **Fix the transport.** Credential expiry, provider outage, IP reputation
   block, or a DNS change. Update the env file and **restart** — the transport
   is built at import time, so a reload is not enough.

4. **Recover.** There is **no retry queue.** Every message attempted during the
   outage is lost. Users who requested a reset must request another. Say so
   explicitly rather than letting them wait.

**If someone is locked out and mail is down**, the only path is direct
intervention. Generate a bcrypt hash and set it, then bump `token_version` so
existing sessions die:

```bash
cd /srv/wevolunteer/server
sudo -u wev node -e "console.log(require('bcryptjs').hashSync(process.argv[1], 10))" 'a-temporary-password'
```

```sql
UPDATE users
SET password_hash = '<hash>', token_version = token_version + 1
WHERE email = 'user@example.org';
```

Do this only for a positively identified user, record it, and require them to
change it once mail is back. (Note: there is currently **no** password-change
endpoint for a signed-in user — they change it via the reset flow.)

### Certificate verification failure

**Symptom:** a code on a printed certificate returns `404 {"valid":false}`.

Work through the causes in order:

1. **Typo.** The alphabet deliberately excludes `0`, `O`, `1`, and `I`. Check
   for those substitutions first. The endpoint uppercases input, so case is not
   the problem.
2. **The code exists but attendance does not.**
   ```sql
   SELECT * FROM certificates WHERE code = 'WEV-XXXX-XXXX';
   SELECT * FROM attendance WHERE user_id = '<uid>' AND event_id = '<eid>';
   ```
   A certificate row with no `present = 1` attendance returns 404 by design.
   That means the attendance was revoked after the certificate was printed —
   check `hours_ledger` for the change, its actor, and its reason, then talk to
   the organizer. **This is a data question, not a bug.**
3. **Rate limited.** 20 requests / 15 min. A school office checking a stack of
   certificates can hit it. The response is 429, not 404 — check the status code
   before assuming the code is bad.
4. **A pre-cutover certificate.** Codes issued before the random-code migration
   do not verify. Not possible on a fresh pilot database. The remedy is for the
   student to re-download the certificate from their certificates page.
5. **The backfill did not run.** Compare the counts:
   ```sql
   SELECT COUNT(DISTINCT user_id || ':' || event_id) FROM attendance WHERE present = 1;
   SELECT COUNT(*) FROM certificates;
   ```
   A shortfall means `initCertificates()` failed at boot. Restart and read the
   log; the backfill is idempotent and will fill the gap.

### Unexpected 500 errors

**Symptom:** users report failures; `Unhandled error:` appears in the log.

```bash
sudo journalctl -u wevolunteer --since '30 minutes ago' | grep -A 20 'Unhandled error:'
```

The error handler ([app.js:121-131](../../server/app.js#L121)) distinguishes
three cases:

- CORS rejection → 403 `Origin not allowed.` (logged as a warning, not an error)
- `entity.parse.failed` → 400 `Invalid JSON`
- Everything else → 500 `Internal server error`, with the full error logged
  server-side and **no internals returned to the client**

Triage:

1. **One endpoint, reproducible** → a code defect. Capture the request shape
   (method, path, body) and the stack. Most route handlers have their own
   try/catch with a specific message (`Fetch events error:`, `Apply error:`,
   etc.) — that prefix tells you exactly which handler failed.
2. **Every endpoint** → the database is the usual cause. Check `/health`; if it
   is 500, go to *Database corruption*.
3. **After a deploy** → roll back (§7 *Rollback considerations*) before
   debugging in production.
4. **Under load** → check memory and whether systemd is restarting the process.

**Immediate mitigation** if the cause is not obvious and users are blocked:
restart the service. It is safe — `initDatabase()` is idempotent — and it clears
transient state. Then investigate from the logs rather than in production.

Note the diagnostic gap: **there is no request logging**, so you cannot
correlate a 500 with the request that caused it beyond what the handler's own
`console.error` prints. If 500s are frequent and opaque, adding request logging
is the highest-value change you can make.

### Accidental admin lockout

**Symptom:** no working admin account. Nobody can approve organizers or moderate.

Diagnose:

```sql
SELECT id, name, email, role, verified FROM users WHERE role = 'admin';
```

**Case 1 — an admin exists but cannot sign in.** Use the password-reset flow.
If mail is down, use the direct hash procedure under *SMTP outage*.

**Case 2 — no admin exists at all** (demoted, or the account was deleted):

```bash
# Promote an existing account. Pass the email in LOWERCASE — verified gotcha.
cd /srv/wevolunteer
sudo -u wev env WEV_DB_PATH=/var/lib/wevolunteer/wevolunteer.db \
  node bin/make-admin.mjs person@district.example.org
```

If nobody suitable exists, have the person sign up normally first, then promote.

**Case 3 — no shell access to the server.** There is no recovery path. Admin
promotion requires filesystem access to the database. Make sure at least two
people can reach the server, and document it outside this repository.

**Prevention:** create **two** admin accounts at launch, held by different
people. It costs one command and removes an entire failure mode.

**Note on organizer denial:** `POST /api/admin/organizers/:id/deny` is
deliberately scoped to `role = 'organizer' AND verified = 0`. A mistyped or
guessed id cannot delete a student — which would cascade away their attendance
rows and destroy credited hours. If someone reports "the deny button says not
found", that guard is working as intended: an already-approved organizer cannot
be deleted through it.

### Deployment rollback

Use when a deploy is actively breaking the pilot. Decide fast; debug later.

```bash
# 1. Stop.
sudo systemctl stop wevolunteer

# 2. Back up the CURRENT database before touching anything.
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
sudo -u wev sqlite3 /var/lib/wevolunteer/wevolunteer.db \
  ".backup '/var/backups/wevolunteer/pre-rollback-$STAMP.db'"

# 3. Check out the previous known-good commit.
cd /srv/wevolunteer
sudo -u wev git log --oneline -10
sudo -u wev git checkout <previous-sha>

# 4. Reinstall and rebuild — dependency versions may differ.
#    --include=dev is required: the build needs Vite, which is a devDependency,
#    and npm omits devDependencies when NODE_ENV=production is set.
sudo -u wev npm ci --include=dev
sudo -u wev npm run build
sudo -u wev npm prune --omit=dev

# 5. Verify before starting.
sudo -u wev sqlite3 /var/lib/wevolunteer/wevolunteer.db 'PRAGMA integrity_check;'
sudo -u wev node server/verifyHours.js /var/lib/wevolunteer/wevolunteer.db

# 6. Start and smoke test.
sudo systemctl start wevolunteer
curl -sS https://volunteers.sbschools.example.org/health
```

**Whether you also need to roll back the database:**

- **Additive migrations only** (all of them in this release) → **no**. Older
  code ignores columns it does not know about. Code rollback alone is enough.
- **The email dedupe renamed accounts** → **yes**, restore the pre-deploy
  backup, or those users cannot sign in with their original address under older
  code.
- **You are crossing the certificate re-keying** → **yes**. Not applicable to a
  fresh pilot.

Never start new code against an old database, or old code against a migrated
database, without deciding this deliberately. Record the git SHA in every
pre-deploy backup filename so the correct pairing is never in doubt.

---

## 13. First pilot checklist

Chronological. Do not skip ahead — each step's expected outcome is the
precondition for the next.

### Before anyone is invited

- [ ] §5 complete; §10 smoke test passed end to end
- [ ] Backups running and **one restore rehearsed** (§7)
- [ ] Monitoring and alerts live (§11)
- [ ] SMTP validated with a real inbox (§8)
- [ ] **Two** admin accounts created, held by different people
- [ ] The programme owner knows that **selection results are in-app only** and
      has a plan for telling students to check the app
- [ ] The programme owner knows **Auto Select must be triggered manually** after
      the deadline
- [ ] Someone owns the daily "pending past deadline" query (§11)

### 1 — First organizer

- [ ] The organizer signs up through the normal form, choosing role
      **Organizer**
      → *Expected:* account created; `verified: false`; they can sign in but
      cannot create events
- [ ] They attempt to create an event
      → *Expected:* `Organizer account pending admin approval. You cannot create
      events yet.` **Confirm they see this** — it is the gate working, not a bug,
      and the first thing they will ask about
- [ ] The admin sees them in the pending queue and approves
      → *Expected:* `{"success":true}`; the organizer receives an `approval`
      notification in the app
- [ ] The organizer signs out and back in
      → *Expected:* event-creation controls now visible

### 2 — First student

- [ ] A student signs up (real name, grade, school, username)
      → *Expected:* 201; signed in; dashboard shows **0 hours**; no leaderboard
      entry (opt-in defaults off)
- [ ] They edit their profile — avatar, bio, skills
      → *Expected:* saved and reflected immediately
- [ ] **Explicitly verify** the leaderboard opt-in is off unless they chose it
      → *Expected:* `SELECT leaderboard_opt_in FROM users WHERE id = '<id>'` → `0`

### 3 — First event

- [ ] The organizer creates a real event: title, description, category,
      location, arrival instructions, application deadline, and one or more
      shifts with realistic times and `maxSpots`
      → *Expected:* 201; status `open`; visible to students in `/events`
- [ ] Check the deadline is **on or before** the first shift start
      → *Expected:* accepted (the server enforces this; a rejection means the
      dates are wrong)
- [ ] As a student, confirm the arrival instructions are **not** visible before
      acceptance
      → *Expected:* `instructions` is `""`
- [ ] Decide and record: **Manual Review or Auto Select?** If Auto Select, put a
      calendar reminder on the deadline **now** — nothing will remind you

### 4 — First application

- [ ] The student applies to a shift
      → *Expected:* 201; status `pending`; the organizer receives an
      `application` notification
- [ ] The student sees their own application in "My applications"
      → *Expected:* status `pending`
- [ ] The organizer sees the applicant **with volunteer history** (hours, events
      completed, last served)
      → *Expected:* history renders; for a first-time volunteer, zeros
- [ ] Have the student withdraw and re-apply once
      → *Expected:* the re-application succeeds — a withdrawal is recoverable
      while applications are open

### 5 — First Auto Select

Only if the event was created with Auto Select. **The deadline must have
passed.**

- [ ] Try running the draw **before** the deadline
      → *Expected:* `400 Applications are still open; selection can run after
      the deadline.`
- [ ] After the deadline, run the draw
      → *Expected:* 200 with `selectedIds` and `waitlistIds`; **nothing is
      applied yet** — this is a draft
- [ ] Review the preview with the organizer. Explain the weighting: a
      zero-hour volunteer gets weight 10.0, a 500-hour volunteer about 1.7, and
      **nobody ever reaches zero**
- [ ] If they re-draw, a **reason is required** and the cap is 5 total draws
      → *Expected:* `reason_required` on a reasonless re-draw;
      `draw_cap_reached` at the cap
- [ ] Confirm the run
      → *Expected:* statuses applied; every selected and waitlisted student
      notified **in-app**; the event closes; a `selection_summary` is written
- [ ] `GET /api/events/:id/auto-select/runs`
      → *Expected:* every draft, including re-draws and their reasons — the
      audit trail. **Save this** if any student questions the outcome
- [ ] **Tell students to check the app.** They will not get an email

### 6 — First attendance

- [ ] **On the day**, the organizer opens `/checkin/<eventId>` on a phone
      → *Expected:* the roster of accepted volunteers loads
- [ ] Mark arrivals during the shift
      → *Expected:* marks save; **no hours are credited** — verify a student's
      total is still unchanged
- [ ] Try to finalise attendance **before the shift ends**
      → *Expected:* `409 shift_not_ended` — "use check-in for those." Warn the
      organizer about this in advance; it is the most likely day-of surprise
- [ ] **After the shift ends**, finalise attendance
      → *Expected:* 200; hours credited from slot duration; each student
      notified "X hours credited"
- [ ] Verify a student's total
      → *Expected:* matches the shift duration exactly
- [ ] Make one deliberate correction (mark someone absent, then present again)
      → *Expected:* a reason is **required**; both changes appear in
      `hours_ledger` with actor and reason
- [ ] Confirm the event auto-completed
      → *Expected:* status `completed` once every shift has ended and every
      accepted volunteer is accounted for
- [ ] `node server/verifyHours.js <db>`
      → *Expected:* `PASS`

### 7 — First certificate

- [ ] The student opens their certificates page
      → *Expected:* one certificate with the correct hours and a
      `WEV-XXXX-XXXX` code
- [ ] Reload
      → *Expected:* the **same** code (stable per certificate)
- [ ] Print or download it, then verify the printed code at `/verify/<code>`
      **in a private window**
      → *Expected:* valid; shows volunteer name, event, organizer, hours, date;
      **no grade**
- [ ] Verify a deliberately wrong code
      → *Expected:* "No certificate matches that code"
- [ ] Confirm the printed verification URL matches your real hostname
      → *Expected:* it does. **If it says `wevolunteer.org`, `APP_URL` is
      wrong** — fix before any certificate leaves the building

### 8 — First report

- [ ] A student reports an event or comment
      → *Expected:* 201; it appears in the admin's report queue, open reports
      first
- [ ] The admin resolves or dismisses it
      → *Expected:* status updates; the queue reorders
- [ ] The admin opens platform stats
      → *Expected:* totals, attendance rate, completion rate, participation
      rate, monthly hours, and top organizers all populate. **Record these
      numbers — they are your week-one baseline**
- [ ] The organizer exports the roster CSV
      → *Expected:* correct headers, quoted fields, accepted volunteers only.
      Remind them it contains student emails and is a controlled document

### 9 — First leaderboard opt-in

- [ ] A student opts in via the profile-edit modal
      → *Expected:* `leaderboard_opt_in = 1`; they now appear in
      `GET /api/leaderboard`
- [ ] A student who has **not** opted in
      → *Expected:* absent. Confirm this explicitly — it is a privacy
      commitment, not a preference
- [ ] Opt back out
      → *Expected:* removed immediately
- [ ] **Be aware:** with everyone defaulted off, the leaderboard section is
      currently invisible in the UI with no explanation (roadmap P2-2). If a
      student asks where it went, this is why — not a bug you need to chase

### End of week one

- [ ] Re-run §11's metrics queries and compare to the baseline
- [ ] Check for events with passed deadlines and pending applicants
- [ ] Review every `Unhandled error:` in the week's logs
- [ ] Confirm backups ran nightly and verify the newest one
- [ ] Ask the first organizer and three students what confused them — write it
      down verbatim
- [ ] Decide, deliberately, whether to widen the pilot (§15)

---

## 14. Known operational risks

Only risks that genuinely remain at `8604fe3`, after the Phase 1–3 hardening
work. Items closed by that work are **not** listed. Roadmap references point to
`docs/superpowers/plans/2026-07-25-product-quality-roadmap.md`, which is written
but **not implemented**.

### High

**H1 — Single disk. Backups are automated but still same-host.**
*Revised 2026-07-31.* The previous wording — "no backup automation in this
repository" — is out of date: `bin/backup.sh` plus
`deploy/wevolunteer-backup.{service,timer}` ship with the project and run nightly at
03:00, using SQLite's online `.backup` API, integrity-checking each archive before
keeping it, and pruning only after a successful new one. `bin/verify-restore.sh`
rehearses a full restore.

What remains true, and is the actual risk: `WEV_BACKUP_DIR` defaults to
`/var/backups/wevolunteer`, **on the same disk as the database**. A volume failure
loses the records and all 14 days of archives together. Credited service hours are
the highest-value data here — a student's college application may depend on them.
*Mitigation:* **copy archives off-host** (this is the one piece still not automated
— see the release checklist), and run `bin/verify-restore.sh` before the pilot opens.

**H2 — Deadlines pass with no automatic selection. The organizer IS told, once.**
*Revised 2026-07-31.* The previous wording — "nothing tells anyone" — is wrong, and
was repeated from an earlier revision without being checked. `runNotificationSweep`
(every 15 minutes) dispatches `DECISION_NEEDED` to the organizer for any event whose
`application_deadline` has passed with applications still `pending`, naming the
applicant count and the next step. It is mapped, carries a link, and is not
placeholder copy — verified against `getInAppContent`.

What remains true: there is still no scheduler that RUNS the draw, and the
notification is deduped on `awaiting-decision:<eventId>`, so the organizer is told
**once** and then never again. If they miss that one notification, applicants stay
pending indefinitely.
*Mitigation:* run the "pending past deadline" query (§11) daily and route it to the
programme owner — the dedupe is why a daily human check is still required. Put a
calendar reminder on every event's deadline at creation time.

**H3 — ~~No error boundary in the client~~ RESOLVED.**
*Revised 2026-07-31.* `src/components/ErrorBoundary.jsx` exists and is mounted in
three places (`main.jsx`, and twice in `App.jsx` — the inner one deliberately inside
the lazy-loading boundary so a chunk that fails to load is caught too). A render
error no longer blanks the application.
*Residual:* `EventModal.jsx` is still large and handles view, edit, attendance,
applicant review and Auto Select. A throw inside it is now contained rather than
fatal, but organizers should still know that a reload recovers the view.

**H4 — Bulk applicant actions report a count the server did not perform.**
Roadmap P2-1. The client toasts `${appIds.length} volunteer(s) accepted` while
the server legitimately skips applicants when a shift hits capacity and returns
`{updated, applied, skipped}`. An organizer accepting 40 for a 30-spot shift is
told 40 were confirmed. They will not find out until ten people do not arrive.
*Mitigation:* until fixed, tell organizers to re-open the applicant list and
count accepted volunteers after any bulk action. Do not rely on the toast.

**H5 — Rate limiting is in-memory and reset by every restart. Multi-instance is now BLOCKED.**
*Revised 2026-07-31.* Still true: the limiters use `express-rate-limit`'s default
memory store plus an in-process `loginFailures` map, so a restart clears every
counter and a restart loop is a rate-limit bypass.

What changed: "run exactly one instance" was documented in three places and enforced
nowhere — verified by booting two servers against one `WEV_DB_PATH`, both of which
reported healthy and served traffic with no warning. A second instance in production
now **refuses to boot** and names the holder (`server/instanceLock.js`). A crashed
predecessor never blocks a restart: a dead pid on the same host is reclaimed
immediately, and any holder whose heartbeat is stale is reclaimed after
`INSTANCE_LOCK_STALE_MS` (45s default).

*Mitigation:* one instance, now enforced. Consider rate limiting at the proxy as a
second layer, which also survives restarts. If you ever genuinely need two
instances, a shared limiter store is a prerequisite — and so is auditing every
capacity check, because they read outside their write transaction.

**H6 — Email notifications exist, but delivery is best-effort.**
*Revised 2026-07-31.* The previous wording — "in-app only" — is wrong. Notifications
are dispatched to an outbox (`notification_jobs`) and delivered by email as well as
in-app, with five attempts and exponential backoff, subject to each user's
per-category preferences and the global `email_opt_out` flag.

What remains true: **email is not guaranteed.** A student who has opted out, whose
address bounces, or whose notification exhausts its five attempts (~62 minutes of
backoff) will not be told by mail. Permanently failed jobs are now logged and
counted on `/api/admin/system/status`, so this is visible rather than silent, but it
is still not a delivery guarantee.
*Mitigation:* for anything genuinely time-critical — a same-day cancellation — have
the organizer also use their existing channel (school email, Remind). Check the
admin status panel's `notificationQueue.failed` during the first week.

### Medium

**M1 — ~~`APP_URL` unchecked~~ RESOLVED; `CORS_ORIGINS` still defaults to localhost.**
*Revised 2026-07-31.* `APP_URL` no longer has a dangerous default: `email.js` exits
non-zero in production if it is unset, so a deployment cannot silently email
password-reset tokens to a domain it does not control.

What remains: `CORS_ORIGINS` still defaults to two `localhost` ports with no startup
check. Its blast radius is much smaller than it was — CORS is mounted on `/api` only
(so a wrong value can never blank the SPA), and same-origin requests always pass (so
the single-host topology works regardless). A split client/API host would fail
visibly with 403s on every write.
*Mitigation:* set it anyway; it is your only control if the client is ever served
elsewhere. Still verify `APP_URL` by reading a real password-reset email before
launch, not by reading the config.

**M2 — ~~No Content-Security-Policy~~ RESOLVED. Do NOT add one at the proxy.**
*Revised 2026-07-31.* This entry was not merely stale, it was actively harmful
advice. `helmet` is **no longer** configured with `contentSecurityPolicy: false`;
`app.js` ships a full directive set, including `script-src 'self'` with **no
`unsafe-inline`** (the theme pre-paint script was moved to an external file in
`public/` specifically to earn that), plus `frame-ancestors 'none'`,
`object-src 'none'`, `base-uri 'self'` and `form-action 'self'`.

**Adding a second CSP at the reverse proxy is a mistake.** When two
`Content-Security-Policy` headers are present the browser enforces the
intersection of both, so a proxy policy that omits, say, `fonts.gstatic.com` will
break font loading with no obvious cause.
*Mitigation:* none needed. Verify the header is present with the §10 smoke test and
do not duplicate it.

**M3 — No HTTP request logging.**
No morgan, no access log. During an incident you cannot correlate a 500 with the
request that caused it, and there is no record of who called what. The
`hours_ledger` audit trail covers hours changes specifically; nothing else is
audited at the HTTP layer.
*Mitigation:* enable access logging at the proxy immediately — it is free and
gives you method, path, status, and client IP.

**M4 — No log rotation, and logs contain PII.**
Output goes to stdout with no rotation in the app. The `[Email dedupe]` path
logs old and new email addresses. An unbounded journal is the most likely cause
of a disk-full incident on this deployment.
*Mitigation:* set `SystemMaxUse=1G` in `/etc/systemd/journald.conf`, restrict log read access, and set
a retention limit consistent with the district's data policy.

**M5 — Accessibility gaps with a legal floor.**
Roadmap P2-4, P2-5, P2-6, P2-8. Incomplete ARIA tab pattern (roles without
`aria-controls` or arrow-key handling — worse than no ARIA at all), no
`role="progressbar"` on the hours meter, touch targets below 44 px on the
accept/decline and check-in controls, and charts with no text alternative. A New
Jersey public school district is subject to Section 504/ADA expectations; a
student or organizer using a screen reader is not an edge case.
*Mitigation:* this is a genuine compliance exposure, not a polish item. Know
about it before someone else raises it, and have an answer for when it will be
addressed.

**M6 — `make-admin.mjs` matches email case-sensitively.**
**Verified.** Signup lowercases stored addresses; the script uses
`WHERE email = ?`. Promoting `Ops.Admin@District.Example.org` fails with "not
found" even though the account exists.
*Mitigation:* always pass the address in lowercase. Documented in §5 step 7.

**M7 — `/health` version. Resolved in v1.0.0.**
It previously reported a hardcoded `"2.0.0"` against a `v1.0.0` release, which
actively misled during incident triage. It now reads the version from
`server/package.json` and cannot drift.
*Still true:* for the exact build, `git rev-parse HEAD` on the server is
authoritative — the version alone does not identify a commit.

**M8 — No password change for a signed-in user, and no admin password reset.**
The reset-by-email flow is the only path. If SMTP is down, the only recovery is
direct database manipulation (§12).
*Mitigation:* keep SMTP healthy; keep the manual bcrypt procedure documented and
tested.

**M9 — `node:sqlite` is an experimental Node API.**
It prints `ExperimentalWarning` on every boot and may change between Node
versions.
*Mitigation:* pin the Node minor version. Treat any Node upgrade as a change
requiring the full §10 smoke test.

**M10 — No graceful shutdown handler.**
The app installs no `SIGTERM` handler and never explicitly closes the database.
SQLite in WAL mode is crash-safe, so this does not risk corruption, but the WAL
may not be checkpointed on stop, and in-flight requests are cut off.
*Mitigation:* use §7 Method A (online `.backup`) rather than relying on a clean
shutdown to checkpoint before a file copy.

### Low

**L1 — `/api/applications` loads every attendance row on every request.**
Roadmap P3-1. Fine at pilot scale (hundreds of rows). Watch response times as
volume grows.

**L2 — Full client refetch on every mutation.**
Roadmap P3-2. `App.jsx` refetches all events and all applications after any
change. Correct, simple, and wasteful at scale.

**L3 — 476 kB unsplit bundle (130 kB gzipped).**
Roadmap P3-5. Notably, `/verify/:code` — the page a school office loads cold —
pulls the entire application.

**L4 — `EventModal.jsx` is over 1,500 lines.**
Roadmap P3-3. A maintainability risk rather than an operational one, but it is
why H3 (no error boundary) matters as much as it does.

**L5 — Eight `window.confirm` dialogs for destructive actions.**
Roadmap P2-7. Unstyled, poor on mobile, and with no room to explain
consequences ("this will remove 12 sign-ups").

**L6 — Check-in payload includes non-attending applicants.**
Roadmap P2-9. `GET /api/events/:id` returns all applications; the client filters
to accepted. Correct today, but more student data reaches the device than the
screen needs.

**L7 — Organizer mobile navigation crowding; tables scroll horizontally.**
Roadmap P3-4.

**L8 — `MAX_AUTO_SELECT_APPLICANTS` is declared but unused.**
Setting it does nothing. Do not assume it caps anything.

**L9 — Notification and ledger tables are never pruned.**
Both are append-only by design (the ledger deliberately so). Growth is
proportional to activity, not users, and is negligible at pilot scale. Revisit
after a full school year.

---

## 15. Launch readiness assessment

### Is WeVolunteer technically ready for a limited pilot?

**Yes — for a limited, supervised pilot with a named operator. Not for
unsupervised district-wide rollout.**

The reasoning, plainly:

> **Revision note (2026-07-31).** The assessment below was written for the v1.0
> code. It has not been rewritten, because its *reasoning* still holds — but the
> specifics have moved: the test count is now 963, and several §14 risks it cites as
> open (no backup automation, no error boundary, no CSP, unchecked `APP_URL`) have
> since been closed. See `docs/operations/release-checklist.md` for the current
> pre-launch gate and the up-to-date recommendation.

**What justifies "yes":** the things that would be unrecoverable are correct.
Credited hours cannot be silently destroyed — attendance changes require a
reason, are recorded in an append-only ledger with an actor, and an event with
attendance cannot be deleted at all. Minors' contact details and future
whereabouts are scoped server-side and tested. Certificates are unforgeable
bearer credentials, not derivable hashes. The production posture is enforced by
the code rather than by documentation: three separate misconfigurations refuse
to boot, and I verified all three. 963 tests pass, the build is clean, and a
real production boot on an empty database does exactly what it should.

**What justifies the limits:** nothing here has met a real user. Every risk in
§14's High tier is either an operational gap (no automated backups, no
scheduler for selection) or a client-side reliability gap (no error boundary,
a misleading bulk-action toast) — and each of them needs a human paying
attention rather than a system that copes on its own. A pilot with a named
operator watching absorbs those. A district-wide rollout would not.

### What assumptions remain

Deploying on this basis means accepting all of these. If any is false, revisit
before launching:

1. **Somebody owns this daily.** Specifically: they check for events whose
   deadline has passed with applicants still pending, and they nudge the
   organizer. Without that, H2 turns into students being silently ignored.
2. **Backups are automated and verified before the first real event.** §7 is
   procedure, not history — nothing in this repository runs a backup.
3. **The pilot is small.** Tens of students, a handful of organizers, one
   school. No load testing has been done, and two endpoints do full-table scans
   that are fine at that scale and unproven beyond it.
4. **SMTP is proven to a real inbox before launch**, not assumed from a 200
   response. `forgot-password` returns success regardless of delivery.
5. **Organizers are briefed on three specific behaviours** that will otherwise
   generate support requests: attendance cannot be finalised before a shift
   ends; Auto Select must be triggered manually after the deadline; and the
   bulk-accept toast may overstate what happened (H4).
6. **Students are told that results arrive in the app, not by email.**
7. **Exactly one instance runs.** Rate limiting is per-process memory.
8. **The database is on local disk**, not a network filesystem, and the host
   clock is synchronised.
9. **Two people can reach the server**, because admin recovery requires shell
   access and there is no other path.
10. **Someone accepts the accessibility gap knowingly** (M5) and can say when it
    will be addressed.

### What to watch most closely during the first week

In priority order:

1. **Events whose deadline has passed with applicants still `pending`.** Run the
   query in §11 every morning. This is the failure that damages trust fastest,
   because to a student it is indistinguishable from being ignored.
2. **Hours parity.** `verifyHours.js` after every attendance session, and the
   boot log for `PARITY MISMATCH`. Hours are the product; a discrepancy here is
   a credibility event, not a bug report.
3. **Backup success and freshness.** A backup job that has been silently failing
   is discovered at the worst possible moment.
4. **`Unhandled error:` in the logs.** With no request logging and no error
   boundary, a server 500 and a client white-screen both surface first as a
   confused user. Read every one.
5. **Email delivery.** Watch for `Error sending …` and, more importantly, ask
   the first few users whether the mail arrived and where it landed.
6. **The day-of check-in experience.** This is the one moment the app is used
   on a phone, under time pressure, by someone who cannot stop to debug. Touch
   targets are undersized (M5) and a render error has no recovery (H3). Ask the
   organizer how it went, the same day.
7. **Anything an organizer had to ask about.** Every question is a design
   defect you have not written down yet. Capture them verbatim.
8. **Disk usage** on both the data and journal volumes.

### What metrics determine success

Set these targets before the pilot, so success is not decided retrospectively.

**Technical (the platform works):**

| Metric | Target |
|---|---|
| Uptime (`/health`) | ≥ 99% over the pilot |
| Unhandled 500s | 0 that a user noticed |
| Ledger parity | 100% pass, every check |
| Backup success | 100%, with at least one verified restore |
| Data loss | Zero credited hours lost or disputed |
| Email delivery | ≥ 95% to inbox, not spam |

**Product (people can actually use it):**

| Metric | Target |
|---|---|
| Organizer completes create → select → attendance → hours **unaided** | Yes/No — this is the single most important outcome |
| Students who apply after signing up | ≥ 60% |
| Accepted volunteers who actually attend | ≥ 80% |
| Events reaching attendance finalisation | 100% |
| Certificates verifying correctly on first attempt | 100% |
| Support requests per event | Trending down; **each one classified** |

**Programme (it is worth running):**

| Metric | Target |
|---|---|
| Total credited hours | Any non-zero number is a real outcome |
| Organizers who want to run a second event | ≥ 80% |
| Students who apply to a second event | ≥ 50% |
| Fairness complaints about Auto Select | 0 — and if any, the run audit trail resolves it |

**The single question that decides it:** did an organizer take an event all the
way from creation to credited hours without needing an engineer? Everything else
is diagnostic detail.

### What should happen before expanding beyond the pilot

Ordered. Do not widen the pilot until all of the **Required** items are done.

**Required — these are the ones that stop scaling from hurting:**

1. **Automate and monitor backups** (H1). Nightly `.backup`, integrity-verified,
   off-host copy, alert on failure or staleness. Non-negotiable at any scale
   above one supervised school.
2. **Add a client error boundary** (H3, roadmap P2-3). One boundary around the
   shell, ideally a second around `EventModal`. Small change; removes the worst
   day-of failure mode.
3. **Fix the bulk-action count** (H4, roadmap P2-1). Use the server's `updated`
   and surface `skipped` with its reason. One file. It is currently telling
   organizers something untrue about who is confirmed.
4. **Solve the deadline gap** (H2). Either a scheduled Auto Select trigger, or —
   at minimum — a notification to the organizer when a deadline passes with
   applicants pending. A manual daily query does not scale past a handful of
   events.
5. **Add HTTP request logging** (M3). Without it, incident response at scale is
   guesswork.
6. **Add CSP at the proxy** (M2). The server now serves HTML; the policy gap is
   real.
7. **Address the accessibility floor** (M5, roadmap P2-4/5/6/8). Compliance
   exposure grows with every additional user.

**Strongly recommended before a second school:**

8. Fix the silent production defaults (M1) — fail fast on a production
   `APP_URL` or `CORS_ORIGINS` that still holds a development value.
9. Make the leaderboard discoverable or remove it (roadmap P2-2) — right now it
   is dead code for every user.
10. Replace `window.confirm` on destructive actions (roadmap P2-7).
11. Correct the `/health` version string (M7).
12. Load-test at 10× expected concurrency and fix whatever the two full-table
    scans do under it (L1, L2).

**Before district-wide rollout:**

13. Decide on SQLite's ceiling. It is genuinely fine for one school. Before
    thousands of students across many schools, either commit to a
    single-instance design with strong backups or plan the move to a client-server
    database — and note that horizontal scaling additionally requires a shared
    rate-limit store (H5).
14. Build an email notification path for selection results and cancellations
    (H6), or formally accept in-app-only as the programme's communication model
    and document it for families.
15. Independent security review, focused on the minors' data model.
16. A documented data-retention and deletion policy — there is currently no
    account deletion and no pruning of the append-only tables (L9).
17. A support runbook for non-engineers: the five most common user problems and
    their answers.

---

**Document ends.** Every executed verification in this document was performed on
2026-07-26 against `main` @ `8604fe3` on macOS with Node v24.14.0 and npm 11.9.0.
Re-verify after any change to Node, dependencies, or the deployment topology.
