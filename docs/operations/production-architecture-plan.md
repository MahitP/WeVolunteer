# WeVolunteer — Production Hosting & Launch Architecture

**Status:** planning document. Nothing in here has been deployed.
**Date of research:** 2026-09-05. Pricing and platform limits verified on that date against primary sources; re-verify anything older than ~60 days before acting.
**Scope:** where WeVolunteer should run, how it should be secured, operated, monitored, backed up, and launched.

---

## EXECUTIVE SUMMARY

Five findings drive every recommendation below. The first three change the plan you came in with.

**1. The Express backend cannot run on Vercel. This is not a configuration gap — it is a designed-in conflict.**

`server/instanceLock.js` exists specifically to guarantee that exactly one process serves a given database, and `server/server.js:159` calls `process.exit(1)` when a second instance is detected in production. Vercel's execution model is many concurrent function instances. The second concurrent instance would refuse to boot. Alongside that: eight `setInterval` background workers, a Socket.IO server, two local-filesystem write paths (avatars, exports), and an OpenTelemetry `--import` preload that Vercel functions cannot receive. Details and line references in **VERCEL ARCHITECTURE**.

**2. The Supabase free plan is disqualified for this data.** It has no automatic backups, no point-in-time recovery, and pauses projects after one week of inactivity ([supabase.com/pricing](https://supabase.com/pricing)). WeVolunteer is the system of record for service hours that students use toward graduation requirements. A platform that goes quiet over winter break would have its database paused, and there would be no backup to restore from. This is the one place I recommend spending money.

**3. Splitting to `app.wevolunteers.org` invalidates the codebase's documented CSRF threat model.** `server/config.js:846-861` sets `sameSite: 'lax'` with **no CSRF token**, and justifies that by the SPA and API sharing one origin. The same comment says, verbatim: *"REVISIT THIS if the app is ever served from a subdomain alongside another application."* Your proposed split is exactly that condition. `SameSite=Lax` does not treat a sibling subdomain as cross-site. The split is the right long-term shape, but it must be gated on shipping CSRF tokens.

**4. Backup and disaster recovery do not currently exist.** `bin/backup.sh` and `bin/verify-restore.sh` are `sqlite3`-only (`bin/backup.sh:32,40`; `bin/verify-restore.sh:48`). Production is now PostgreSQL. Combined with finding 2, the current recoverability of production data is zero.

**5. Cloudflare's security features and Vercel are mutually exclusive.** Vercel advises against reverse proxies in front of it, and the CNAME must be DNS-only ([vercel.com/guides/using-cloudflare-with-vercel](https://vercel.com/guides/using-cloudflare-with-vercel)). Choosing Vercel means giving up Cloudflare WAF, rate limiting, and bot protection. Choosing a container/VM origin keeps all of them, free.

### The recommendation in one line

Run the application as what it is — **one always-on process on a small VM or container, behind a proxied Cloudflare zone** — put the marketing site on static hosting, and pay for a managed Postgres with real backups.

**Realistic cost: $6–31/month.** A true $0 configuration exists (§ COST ANALYSIS, Architecture C) but requires accepting either no database backups or meaningfully more operator burden. I do not recommend $0 for a platform holding minors' academic records.

---

## CURRENT STATE

Verified by inspection of the working tree at commit `c170a26`.

| Aspect | Finding | Evidence |
|---|---|---|
| Frontend | React 19 + Vite 8, SPA | `package.json` |
| Backend | Express 4, single long-running Node ≥24 process | `server/package.json` |
| Database | PostgreSQL via `pg` 8.23; SQLite path still present | `package.json`, `server/db.js` |
| Realtime | Socket.IO 4.8 server attached to the HTTP server | `server/server.js:196` |
| Background work | 8 `setInterval` loops | see table in **VERCEL ARCHITECTURE** |
| Singleton enforcement | DB-backed lock + 15s heartbeat; fatal in prod | `server/instanceLock.js`, `server/server.js:148-160` |
| Filesystem writes | avatar uploads, export archives | `server/routes/profilePictureRoutes.js:362`, `server/workers/exportWorker.js:73` |
| Observability | OpenTelemetry, preloaded via `--import` | `server/package.json` `start` script |
| Deployment artefacts | systemd units for a Linux VM | `deploy/*.service`, `deploy/*.timer` |
| Vercel config | **none** — no `vercel.json`, no `.vercel/` | verified absent |
| Backups | SQLite-only scripts | `bin/backup.sh`, `bin/verify-restore.sh` |
| CI | one GitHub Actions workflow | `.github/workflows/ci.yml` |
| Env surface | 118 server variables, 21 client (`VITE_`) | grep of `process.env` / `import.meta.env` |

The repository is internally consistent and unusually well-documented — the code explains its own invariants in prose, and those comments turned out to be accurate everywhere I checked them. **What it is consistent with is a single-host systemd deployment**, which is what `deploy/` builds. It is not consistent with the Vercel/Supabase plan.

One correction to prior project notes: an earlier internal note recorded the deployment conflict as "SQLite vs Supabase." The PostgreSQL port has since landed and that half is resolved. The process-model half — singleton, workers, sockets, filesystem — has not, and is the live blocker.

---

## RESEARCH METHODOLOGY

- **Primary sources** for every platform limit and price: Vercel docs (`/docs/functions/limitations`, `/docs/functions/websockets`, `/docs/plans/hobby`), Supabase pricing page, Cloudflare/Vercel integration guidance.
- **Secondary sources** only for cross-provider price comparison where no single primary page exists.
- **Repository evidence** cited as `path:line`. Every architectural claim about WeVolunteer traces to a file I read, not to inference.
- **Claim types are labelled** throughout: *Verified* (primary source or code read), *Inferred* (reasoned from verified facts), *Recommendation*, *Open question*.

**Limits of this research.** I did not have credentials for your Vercel, Supabase, Cloudflare, Resend, Better Stack, Amplitude, or Pinecone accounts, so nothing about *your* current account state is verified — only published limits. I did not run the test suite, so the "~9,000 tests passing" figure is your report, not my measurement. No production infrastructure was created, modified, or contacted.

---

## RECOMMENDED ARCHITECTURE

```text
Domain        wevolunteers.org (apex) + app.wevolunteers.org + status.wevolunteers.org
DNS           Cloudflare, proxied for app + apex, DNS-only for mail records
Frontend      Marketing: Cloudflare Pages (static). App SPA: served by Express, same origin as API
Backend       One always-on container/VM. Node 24, systemd or Fly machine. Instance count: exactly 1
Database      Managed PostgreSQL with daily backups (Supabase Pro) OR on-box Postgres + off-site dumps
Redis         Upstash, optional dependency, degrades to in-process limiters
AI            Welly: model runs in the browser; Pinecone server-side, optional
Email         Resend, sending subdomain mail.wevolunteers.org; inbox via forwarding
Monitoring    Better Stack: 4 HTTP monitors + 3 heartbeats + 1 status page
Analytics     Amplitude, pseudonymous ids only
CI/CD         GitHub Actions gate -> manual production promotion
Backups       Nightly pg_dump, encrypted, off-site, with a scheduled restore drill
Security      Cloudflare WAF + app-layer limiters + CSRF tokens before any domain split
Status page   status.wevolunteers.org, Better Stack hosted
```

### Why each piece

**One always-on process, not functions.** Because the application already enforces it (`instanceLock.js`) and depends on it: eight interval workers, Socket.IO fan-out, and in-process rate limiters. Making it serverless-safe is a multi-week rewrite of correctness-critical code (Auto Select draws, hours crediting, retention). Hosting it as designed is a day.

**Cloudflare proxied.** With a VM origin, the orange cloud gives you WAF, rate limiting, bot management, DDoS absorption, and HSTS at no cost. These are exactly the controls a platform serving minors should have, and they are unavailable behind Vercel.

**Managed Postgres with backups.** See finding 2 and **BACKUP / DISASTER RECOVERY**.

**Marketing static and separate.** Static hosting for the apex is free, fast, independently deployable, and cannot leak application state. It also lets the marketing site be indexed while the app is not.

### Alternatives considered
Rejected: Vercel functions (§ VERCEL ARCHITECTURE), Render free tier (spins down after 15 minutes — kills the Auto Select scheduler), Supabase free (no backups, pauses).

### Risks
Single instance is a single point of failure; a VM is more operator surface than a PaaS; Cloudflare proxying adds a hop that must be configured correctly or it breaks WebSockets. All addressed below.

---

## DOMAIN ARCHITECTURE

### The decision

**Recommended: Option A (`wevolunteers.org` marketing + `app.wevolunteers.org` app) — but gated on a prerequisite.**

**Prerequisite: implement CSRF tokens before the split goes live.** Launch on Option B (everything on the apex) if you want to ship sooner; move to A afterwards.

### Why the gate is not optional

`server/config.js:846-861`:

> `sameSite: 'lax'` and NO CSRF token, deliberately. […] It is, by the topology: production serves the SPA and the API from one Express process […] A double-submit token would add nothing against that threat model — it defends against a same-site attacker on a sibling subdomain, **which this deployment does not have**. […] **REVISIT THIS if the app is ever served from a subdomain alongside another application, or if the API moves to a different origin from the SPA.**

*Verified.* The reasoning is correct, and the proposed architecture is precisely the condition it names. `SameSite=Lax` is scoped to the registrable domain: `wevolunteers.org` and `app.wevolunteers.org` are **same-site**. A cross-origin `POST` from the marketing site to the app API would therefore carry the session cookie. Today the app is immune to CSRF because there is no sibling origin. Introduce one and the immunity is gone — for a platform where a forged request can accept a student into a shift, credit hours, or change an account.

The marketing site being static and low-risk mitigates but does not close this: any XSS or supply-chain compromise on the marketing site becomes a full CSRF vector into the application.

**Work required:** double-submit cookie or synchroniser token on all state-changing routes, plus an `Origin`/`Sec-Fetch-Site` check. This is well-understood, testable work — a day or two, not a rewrite. It should be a launch-gate item.

### Second consequence of the split: CSP

`server/app.js:307` sets `connectSrc: ["'self'", …]`. If the SPA is served from one origin and the API from another, `'self'` no longer covers the API and every request is blocked by CSP. Under the recommended shape (SPA and API both served by Express at `app.wevolunteers.org`) this stays correct and needs no change. **Do not** split the SPA away from the API.

### Everything else the split touches

| Concern | Effect | Action |
|---|---|---|
| Cookie scope | Cookie is host-only (no `domain` set, `config.js:868-874`). Set at `app.`, not sent to apex. | Correct as-is. Do **not** add `domain: .wevolunteers.org` — that would widen exposure for no benefit. |
| CORS | Same-origin SPA+API means no CORS needed for the app. | Leave `CORS_ORIGINS` unset in production; `server/config.js:679` already treats that as the normal case. |
| Password reset / verification / certificate links | All must point at `app.wevolunteers.org`. Driven by `APP_URL`. | Single env var; verify every template. |
| SEO | Marketing indexed, app not. | See **SEO**. |
| Analytics | Two origins = two sessions in Amplitude unless configured. | Accept it; do not add cross-domain tracking for a marketing funnel this small. |
| Future mobile / public API | A stable `api.` or versioned path is easier from a split. | Argues for A long-term. |
| OAuth | `GOOGLE_CLIENT_ID` / `MICROSOFT_CLIENT_ID` redirect URIs are origin-bound. | Register `app.` redirect URIs; this is a manual console step. |

### Verdict

Option A, after CSRF tokens. Option B is a legitimate launch-now choice and is what the code is currently correct for. Option C (separate `api.` origin) is worse — it adds CORS, breaks the CSP `'self'`, and buys nothing at this scale.

---

## VERCEL ARCHITECTURE

*This section exists to document why Vercel is not the answer, not how to configure it.*

### The disqualifying facts

**1. The singleton lock hard-fails under concurrency.** *Verified.*

`server/server.js:148-160`:
```js
const lockResult = await acquireInstanceLock(db);
if (shouldRefuseBoot(lockResult, IS_PRODUCTION)) {
  console.error('FATAL: refusing to start a second instance.');
  process.exit(1);
}
```
Vercel auto-scales to as many as 30,000 concurrent instances on Hobby and Pro ([docs](https://vercel.com/docs/functions/limitations)). Instance #2 exits. Users get 500s. Removing the lock does not fix it — the lock is documentation of a real constraint (per-process rate limiters, in-memory login-failure map at `server/app.js`), and deleting it would silently multiply every security limit by the instance count.

**2. Eight interval-driven workers.** *Verified.* Serverless functions are frozen between invocations; `setInterval` does not survive.

| Worker | Location | What breaks |
|---|---|---|
| Notification sweep (15 min) | `server/server.js:174` | Time-based notifications stop |
| Notification delivery | `server/workers/notificationWorker.js:573` | Email/notification queue stalls |
| Export worker | `server/workers/exportWorker.js` | Data exports never complete |
| Retention worker | `server/workers/retentionWorker.js:498` | **Published privacy retention periods stop being enforced** |
| Auto Select scheduler | `server/services/autoSelectScheduler.js:250` | **Draws miss their deadline — a correctness failure, not a delay** |
| Pinecone index worker | `server/search/indexWorker.js:79` | Search index drifts |
| Telemetry tail sampler | `server/observability/tailSampler.js:164` | Traces leak memory / stop flushing |
| Instance-lock heartbeat | `server/instanceLock.js:185` | Lock goes stale |

The retention worker is the sharpest one: `server/server.js` comments that it "makes the Privacy Policy true rather than a representation nothing implements." On Vercel it would not run, and the published policy would become false.

**3. Local filesystem writes.** *Verified.* `server/routes/profilePictureRoutes.js:362` writes avatars with `fs.writeFileSync`; `server/workers/exportWorker.js:73` creates an export directory. Vercel's filesystem is ephemeral per invocation. Avatars would vanish. Fixing this means object storage (R2/S3) plus a rewrite of the static mount at `server/app.js` `/uploads`.

**4. The OTel preload cannot be delivered.** *Verified.* `server/package.json` starts with `node --import ./observability/register.mjs`. `server/server.js:13-27` explains this ordering is load-bearing — instrumentation must patch `http`, `express`, and `pg` before `app.js` imports them. Vercel functions do not accept custom Node CLI flags.

**5. Boot-time gates run per cold start.** `verifyPolicyFiles()` hashes 11 legal documents (`server/server.js:126`); schema assertion; owner-count query. Per-invocation cost and per-invocation failure surface.

### Socket.IO: technically possible, economically not

*Verified.* Vercel shipped native WebSocket support in public beta on 2026-06-22 and explicitly documents Socket.IO ([docs](https://vercel.com/docs/functions/websockets)). But the same page states:

> A single WebSocket connection is pinned to one Vercel Function instance.
> New WebSocket connections are not guaranteed to reach the same Vercel Function instance. […] Store durable state, presence, counters, rooms, and pub/sub coordination in an external data store.

WeVolunteer's realtime layer broadcasts to users across connections. With per-instance pinning and no fan-out, you would need a Redis pub/sub adapter and a rewrite of `server/realtime/socketServer.js`.

**And the cost is prohibitive.** *Inferred from verified numbers.* Hobby includes 360 GB-hrs of provisioned memory per month; functions run at 2 GB. Connections bill for the whole time they are open. One instance held open continuously for a month is 730 h × 2 GB = **1,460 GB-hrs — roughly 4× the entire monthly Hobby allowance.** A single always-connected user exhausts the free tier in about a week.

### Plan terms

*Verified.* Vercel Hobby is "restricted to non-commercial personal use only"; commercial use requires Pro ([docs/plans/hobby](https://vercel.com/docs/plans/hobby)). Hobby also allows one team member. If WeVolunteer is ever offered to a school as a service — funded, contracted, or staffed by anyone paid — Hobby is not licensable and Pro at $20/month is the floor.

### What Vercel *is* good for here

Serving the **static marketing site**. That use is genuinely free, fast, and appropriate — subject to the same commercial-use clause, which is why I recommend Cloudflare Pages instead (no equivalent restriction, and you are already in Cloudflare for DNS).

### If you insist on Vercel for the app

The honest scope: remove the instance lock and replace every in-process limiter with Redis-backed ones; move all eight workers to Vercel Cron or an external scheduler; move avatars and exports to object storage; drop the OTel preload for the SDK's programmatic init; add a Redis adapter to Socket.IO or replace realtime with polling; and move to Pro for the licence and the duration ceiling. That is a substantial re-architecture of code that is currently correct, and it buys you a platform whose main advantage — elastic scale — this application does not need.

---

## CLOUDFLARE ARCHITECTURE

### Proxy decision

*Verified.* Vercel's own guidance is that reverse proxies in front of Vercel "limit Vercel's traffic visibility for security measures, introduce latency […] and create cache management issues," and that the CNAME must not be proxied.

This makes the choice cleanly binary:

- **VM/container origin (recommended)** → proxy everything. You get WAF, rate limiting, bot management, DDoS absorption, HSTS, and origin IP concealment, all on the free plan.
- **Vercel origin** → DNS-only. You get DNS and nothing else, and rely on Vercel Firewall instead.

This is a genuine argument for the container architecture that has nothing to do with cost.

### Configuration for the recommended shape

| Setting | Value | Why |
|---|---|---|
| SSL/TLS mode | **Full (strict)** | Encrypts Cloudflare→origin and validates the origin cert. Never use Flexible — it makes `secure` cookies arrive over plaintext at the origin. |
| Origin certificate | Cloudflare Origin CA cert on the VM | Free, 15-year, trusted by Cloudflare only. |
| Always Use HTTPS | On | Redirects HTTP→HTTPS at the edge. |
| HSTS | On, `max-age=31536000`, includeSubDomains, preload | Enable **after** every subdomain is confirmed HTTPS-only. Preload is hard to undo. |
| Minimum TLS | 1.2 | |
| DNSSEC | On | Registrar must accept the DS record. |
| WebSockets | On | Required for Socket.IO through the proxy. |
| Bot Fight Mode | On | Free tier. Watch for false positives on the certificate-verify endpoint. |
| WAF managed rules | Cloudflare Free managed ruleset | |
| Rate limiting | One rule on `/api/auth/*` | Defence in depth over the app limiters. |
| Origin firewall | Only Cloudflare IPs may reach the VM on 443 | Otherwise the origin is reachable directly, bypassing all of the above. |
| `BIND_ADDRESS` | `127.0.0.1` | `server/server.js:213` documents this: the default `0.0.0.0` leaves Node publicly reachable, bypassing TLS and HSTS. |

### Caching

Default to **cache nothing** for the application origin. The app serves per-user authenticated data; a cache misconfiguration is a cross-user data leak. Cache only immutable, hashed build assets. `/uploads` is already `immutable` and safe because filenames carry `Date.now()` (`server/app.js`).

---

## SUPABASE / DATABASE ARCHITECTURE

### The free plan is not viable

*Verified* ([supabase.com/pricing](https://supabase.com/pricing)):

| | Free | Pro ($25/mo) |
|---|---|---|
| Database | 500 MB | 8 GB |
| **Automatic backups** | **None** | **Daily, 7-day retention** |
| **PITR** | **Not available** | Add-on (~$100/mo) |
| **Inactivity** | **Paused after 1 week** | No pause |
| Egress | 5 GB | 250 GB |
| Active projects | 2 | — |

Two of these are disqualifying for WeVolunteer specifically:

- **No backups.** The database holds attendance records and derived service hours that students submit toward graduation requirements. There is no reconstruction path if it is lost.
- **Pausing.** A school platform is seasonally quiet. Seven days of no traffic over a break pauses production. Recovery is manual and requires someone to notice.

**Recommendation: Supabase Pro, $25/month.** Categorised as **worth paying for** — see § CHALLENGING THE $0 REQUIREMENT.

### Connection architecture

Because the app is a **single long-lived process**, it should use a **direct session-mode connection with `pg`'s own pool** — not the transaction-mode pooler. Transaction pooling exists for serverless callers with many short-lived connections; it disables prepared statements and session state, which a persistent pool does not need and which `pg` may rely on.

*Recommendation:* modest pool (`max: 10`), `DATABASE_SSL_CA` set to the Supabase root cert already committed at `deploy/certs/supabase-root-2021.crt`, full certificate verification on. **Never** `rejectUnauthorized: false`; **never** `NODE_TLS_REJECT_UNAUTHORIZED=0`. You have already done this correctly — keep it.

*Open question:* whether the committed `supabase-root-2021.crt` is still the current root for your project's region. Verify before launch; a rotated root would fail closed (correctly) but at the worst moment.

### Staging / preview database architecture

The free plan allows **2 active projects**. That is exactly production + staging, with nothing left for per-PR preview databases — and the staging project will pause constantly because it is idle by nature.

*Recommendation:*
- **Production:** Supabase Pro.
- **Staging:** separate free project, accepted as pause-prone; resume it when you need it.
- **Local + CI:** ephemeral PostgreSQL (the repo already has `TEST_POSTGRES_URL` and scratch-database tooling).
- **Preview deployments:** point at **staging, never production.** Enforce this with a boot-time guard, not discipline — refuse to start if `NODE_ENV !== 'production'` and `DATABASE_URL` matches the production host. This is the single highest-value guard rail on the list; the repo already has the pattern in `server/config.js`'s production guards.

### Migrations

*Recommendation: do not run migrations automatically on deploy.* Deploy-time migration is safe only when migrations are guaranteed backward-compatible with the running code, and this project's migration set includes schema-shaping changes. Instead:

1. Back up (verified, not assumed).
2. Run migrations as an explicit, logged step against a quiesced app.
3. Verify schema (`assertSchemaReady()` already exists, `server/server.js:81`).
4. Deploy code.
5. Smoke test.

Destructive migrations (column/table drops) should be **two-phase**: deploy code that stops using the column, ship it, then drop in a later release. That way application rollback never requires database rollback.

---

## BACKUP / DISASTER RECOVERY

### Current state: none

*Verified.* `bin/backup.sh:32` requires `sqlite3`; `bin/backup.sh:40` runs `sqlite3 .backup`; `bin/verify-restore.sh:48` likewise. Both operate on `WEV_DB_PATH`. Production is PostgreSQL. The systemd timer at `deploy/wevolunteer-backup.timer` would run a script that cannot back up the production database.

Combined with Supabase Free having no backups of its own: **if production data were lost today, it would be unrecoverable.** This is the most serious operational finding in this report and it is a hard launch gate.

### Target

- **RPO ≤ 24 h** (daily dump) — tightened to ~0 by Supabase Pro's daily managed backup plus dumps.
- **RTO ≤ 2 h** for a full restore by one person following a written runbook.

### Design

**Layer 1 — managed.** Supabase Pro daily backups, 7-day retention. Zero effort, but same-vendor: it does not protect against account loss or an accidental `DROP` propagated into every backup.

**Layer 2 — independent off-site.** Nightly `pg_dump -Fc`, encrypted with `age` or `gpg` to a public key whose private half is *not* on the server, uploaded to Cloudflare R2 (10 GB free) or Backblaze B2. Retain 14 daily + 8 weekly. This is the layer that survives a compromised or closed Supabase account.

**Layer 3 — restore drill.** *A backup strategy is not complete until restoration has been tested* — your words, and they are correct. Schedule a **quarterly restore drill**: pull the latest encrypted dump, restore into a scratch database, and assert the same invariants `bin/verify-restore.sh` already checks — user count, credited hours, certificate count, ledger rows, foreign-key integrity. Record the date and the numbers.

**Work required:** port `bin/backup.sh` and `bin/verify-restore.sh` to `pg_dump`/`pg_restore`, keeping the existing invariant checks. The logic is already written; only the engine changes. This is a Claude-can-do-now task.

### What is *not* backed up today

- **Uploaded avatars** (`server/public/uploads`) — on the VM filesystem, outside the database dump. Include in the backup or accept the loss explicitly.
- **Environment variables / secrets** — see **ROLLBACK**.
- **Pinecone index** — rebuildable from Postgres via `npm run pinecone:reindex`. Correctly treated as derived state.

---

## SERVICE DEPENDENCY MATRIX

| Service | Purpose | Criticality | Failure behaviour | Free limit (verified 2026-09-05) | Monitor |
|---|---|---|---|---|---|
| **PostgreSQL** | System of record | **Critical** | `/health` → 503; app unusable | Free: 500 MB, no backups, pauses | HTTP monitor on `/health` |
| **Node process** | Everything | **Critical** | Total outage | — | HTTP monitor |
| **Cloudflare** | DNS + edge | **Critical** | Site unreachable | Free plan sufficient | External uptime |
| **Resend** | Password reset, verification, notifications | **Important** | Reset/verification blocked; queue retries | 3,000/mo, **100/day**, 3 domains | Heartbeat on mail queue |
| **Upstash Redis** | Shared rate-limit state, lookup caches | **Important** | Falls back to per-process limiters; limits loosen | 256 MB, **500k commands/mo** | Dependency health, P2 |
| **Pinecone** | Discover/search for Welly | **Optional** | Search degrades; core platform unaffected | 1 index, 2 GB, 2M WU + 1M RU/mo | Dependency health, P3 |
| **Better Stack** | Monitoring + logs | **Optional** | Blind, but app runs | 10 monitors, 10 heartbeats, 1 status page | Self-monitoring |
| **Amplitude** | Product analytics | **Optional** | Analytics gap only | 2M events/mo, 10k MTU | Quota check monthly |
| **Hugging Face** | Welly model download (browser) | **Optional** | Welly unavailable; cached models still work | Public CDN | None |

**Rule to enforce:** nothing in the Optional or Important rows may take down the application. *Verified* that Pinecone, Redis, and telemetry are already written defensively. **Open question I could not fully verify:** whether Resend's 100/day cap causes silent notification loss or queued retry — worth a deliberate test, because a password-reset email that never arrives on day one of a pilot is the worst possible first impression.

### The Redis quota is tight

*Verified:* 500,000 commands/month free. Rate limiting touches Redis on effectively every API request. At ~5 commands/request that is 100,000 requests/month before exhaustion. Prior internal measurement put exact metering at roughly 13× over the free tier, which matches. **This is why the limiters are an approximation** — and it is the correct trade-off, but it means Redis quota should be actively watched, and the degradation path (fall back to in-process) must be tested, not assumed.

---

## COST ANALYSIS

### Architecture A — Recommended: "one box, proxied"

| Item | Provider | Cost |
|---|---|---|
| App host | Hetzner CX22 (2 vCPU / 4 GB) or DigitalOcean $6 droplet | €3.79–$6 |
| Database | Supabase Pro | $25 |
| DNS + WAF + CDN | Cloudflare Free | $0 |
| Marketing site | Cloudflare Pages | $0 |
| Redis / Pinecone / Resend / Better Stack / Amplitude | free tiers | $0 |
| Off-site backups | Cloudflare R2 (<10 GB) | $0 |
| **Total** | | **≈ $29–31/month** |

### Architecture B — Your original proposal: Vercel + Supabase

Not costed, because it does not run. If made to run: Vercel Pro $20 (commercial-use clause + duration), Supabase Pro $25, plus function/WebSocket usage that scales with concurrent connections — **≥ $45/month and less reliable**, after weeks of re-architecture. **Rejected.**

### Architecture C — Genuine $0

| Item | Provider | Cost | Trade-off |
|---|---|---|---|
| App host | Oracle Cloud Always Free ARM VM | $0 | Capacity often unavailable; instances reclaimed if idle; no support |
| Database | PostgreSQL on the same box | $0 | You are the DBA; a disk failure loses everything not backed up |
| Backups | `pg_dump` → Cloudflare R2 | $0 | Entirely on you to verify |
| Everything else | as Architecture A | $0 | |
| **Total** | | **$0** | |

This is a **real** option and the existing `deploy/` systemd units already target it. It is "free but risky": co-locating the database with the app means one host failure is a total data-loss event unless the off-site backup discipline is genuinely maintained. For a pilot with a handful of schools, defensible. For the system of record on students' graduation requirements, I would not.

### Recommended middle path

Start at **Architecture C with off-site backups proven by a restore drill**, and move the database to Supabase Pro the moment real student data lands. The $25 buys managed daily backups and removes the pause risk — the two things that would actually hurt you.

### When free tiers run out

| Service | Threshold | Next step |
|---|---|---|
| Resend 100/day | ~50 active users doing resets/notifications on a busy day | Resend Pro $20/mo (50k/mo) |
| Upstash 500k cmd/mo | ~100k API requests/month | Pay-as-you-go $0.20/100k — cheap; budget $2–5 |
| Supabase Free 500 MB | Low thousands of users with attendance history | Pro $25 |
| Amplitude 2M events | Unlikely at pilot scale | Reduce event volume before paying |
| Better Stack 10 monitors | Immediately, if you over-monitor | Design restraint (below) |
| Pinecone 2 GB / 1M RU | Thousands of events indexed | Pinecone Standard |

---

## MONITORING ARCHITECTURE

Better Stack free gives **10 monitors, 10 heartbeats, 1 status page**. That is enough if you spend it deliberately. Over-monitoring produces alert fatigue, which is worse than under-monitoring.

### Monitoring matrix

| Component | Check | Interval | Failure = | Severity | User impact | Recovery |
|---|---|---|---|---|---|---|
| Marketing site | HTTP 200 on `/` | 5 min | 2 consecutive fails | P2 | Cannot learn about product | Redeploy static site |
| App | HTTP 200 on `/` at `app.` | 1 min | 2 consecutive fails | **P1** | Total outage | Restart service; check host |
| API + DB | `GET /health` = 200 | 1 min | any 503 | **P1** | Cannot use app | See incident: DB unavailable |
| TLS certificate | Expiry < 14 days | daily | — | P2 | Future outage | Renew / check Cloudflare |
| Domain expiry | Registrar | monthly | — | **P1 if <30d** | Catastrophic | Renew immediately |
| Notification worker | Heartbeat | 30 min | missed 2 | P2 | Notifications stall | Restart worker |
| Auto Select scheduler | Heartbeat | 30 min | missed 2 | **P1** | **Draws miss deadline** | Manual draw; investigate |
| Retention worker | Heartbeat | daily | missed 1 | P2 | Privacy policy unenforced | Investigate |
| Mail queue depth | Telemetry threshold | 15 min | depth > 50 | P2 | Emails delayed | Check Resend quota |
| Redis / Pinecone | Dependency status in `/health` detail | 5 min | unavailable | P3 | Degraded search/limits | Verify graceful degradation |

That is 4 HTTP monitors + 3 heartbeats + supporting telemetry alerts — comfortably inside the free allowance, with room to add.

### The health endpoint needs splitting

*Verified.* `server/app.js:1240` implements a single `/health` that checks database read **and** performs a write probe, returning 503 on failure. That is **readiness** semantics on the path monitors treat as **liveness**, and it writes to the database on every poll.

*Recommendation:*
- **`/health`** — liveness. Process is up. Returns 200 with no database access. Cheap, pollable every 10s.
- **`/ready`** — readiness. Database readable + writable, plus *reported* (not gating) status of Redis/Pinecone/mail.

The key rule, which the current implementation already respects and must keep respecting: **an optional dependency must never make the application look dead.** Pinecone being down must not turn `/health` red — otherwise a Welly search outage pages you at 3am for a platform that is working fine.

---

## SECURITY ARCHITECTURE

### What is already right

Genuinely strong, and I want to be specific rather than complimentary in general terms:

- **Session cookie** is `httpOnly`, `secure` in production, `sameSite: 'lax'` (`server/config.js:868-874`) — token is out of reach of script.
- **CSP** is a real allowlist, not `unsafe-inline` theatre (`server/app.js:226-320`), with `wasm-unsafe-eval` scoped for Welly and explicit `connectSrc` entries.
- **Helmet** applied, ordered deliberately relative to compression and body parsing.
- **Rate limiting** is layered and per-surface: auth, signup, login, login-IP-ceiling, mail, application, check-in scan/code, report, export, travel.
- **Login limiter keyed on ip+email with an IP ceiling** — the correct answer to shared-IP school networks, which is a mistake most projects make.
- **Capacity races closed properly**: `SELECT … FOR UPDATE` inside the transaction (`server/utils.js:1334`, `server/db/dialectSql.js:271`), after a real concurrency test demonstrated the bug (`server/application.postgresConcurrency.test.js`).
- **Log/telemetry redaction is centralised** (`redactMessage`, `server/observability/spanAttributes.js`) with a field allowlist rather than a denylist.
- **Production guards refuse to boot** on `DEMO_MODE`, a11y harness flags, loopback `CORS_ORIGINS`, missing `JWT_SECRET`, and unverified legal documents.
- **Profile serialisation is an allowlist** — new database columns are invisible to the API until explicitly named.

### Launch-gate security items

| # | Item | Status | Note |
|---|---|---|---|
| 1 | **CSRF tokens before any domain split** | **FAIL if split** | § DOMAIN ARCHITECTURE. Not needed for Option B. |
| 2 | **Backups exist and a restore has been tested** | **FAIL** | § BACKUP. Hard gate. |
| 3 | `BIND_ADDRESS=127.0.0.1` + origin firewall | NEEDS MANUAL VERIFICATION | `server/server.js:213` |
| 4 | Cloudflare SSL mode = Full (strict) | NEEDS MANUAL VERIFICATION | Flexible would break `secure` cookies |
| 5 | HSTS enabled after all subdomains are HTTPS | NEEDS MANUAL VERIFICATION | |
| 6 | Preview cannot reach production DB | **FAIL** — guard not implemented | Highest-value guard rail |
| 7 | Secrets absent from git history | NEEDS MANUAL VERIFICATION | `bin/pre-commit-secret-scan.sh` exists; run over full history |
| 8 | No secret in a `VITE_` variable | PASS (reviewed) | 21 client vars, all non-secret; `VITE_AMPLITUDE_API_KEY` is a public write key by design |
| 9 | 2FA enforced for admin/owner | NEEDS MANUAL VERIFICATION | `REQUIRE_ADMIN_2FA` |
| 10 | `TFA_ENCRYPTION_KEY` and `JWT_SECRET` unique to production | NEEDS MANUAL VERIFICATION | Must differ from `.env` |
| 11 | `security.txt` published | **FAIL** — not present | Trivial; § THINGS WE FORGOT |
| 12 | Certificate URLs carry no PII and are non-enumerable | PASS | Random `crypto.randomBytes` codes, stored not derived |
| 13 | App pages excluded from indexing | **FAIL** — needs `robots.txt` + headers | § SEO |

### `.env` is a production hazard

Prior project notes flag that `.env` is development-only and that putting production credentials there would reach the test suite and every privileged `bin/` script. **This remains true and is worth restating as a rule:** production secrets live in the host's systemd `EnvironmentFile` (`/etc/wevolunteer/wevolunteer.env`, mode 0600), never in a repo-adjacent `.env`. The `deploy/wevolunteer.env.example` template already anticipates this.

---

## PRIVACY / STUDENT DATA

WeVolunteer processes personal data about **minors**. That raises the floor on everything.

### Data flow

| Destination | Receives | Assessment |
|---|---|---|
| PostgreSQL | Names, emails, school, applications, attendance, hours, certificates, 2FA secrets (encrypted) | Necessary. Access-controlled. |
| Resend | Email address + message body | Necessary for transactional mail. Minimise content. |
| Amplitude | Event names + pseudonymous id | **Must never receive** names, emails, or free text. |
| Better Stack | Logs, traces, metrics | Redacted via `redactMessage`; IP treated as personal data per `spanAttributes.js:25`. |
| Pinecone | **Event/opportunity text only** | Prior design decision: candidate-ids-only, no student PII. **Preserve this invariant.** |
| Hugging Face | Nothing — model download only | Welly runs in the browser; conversations do not leave the device. |

**The Welly privacy story is genuinely good** and worth stating publicly: inference is on-device, so a student's questions never reach a server or a model vendor.

### Flags for human/legal review — not legal advice

1. **Under-13 users.** `VITE_PRIVACY_UNDER13` exists, so this has been considered. If any user is under 13, COPPA verifiable parental consent applies. **Requires counsel.**
2. **FERPA.** If a school district supplies rosters or treats hours as education records, the district's obligations may extend to you as a "school official." **Requires a district agreement.**
3. **Subprocessor list.** The privacy policy previously recorded the hosting provider as "not yet chosen." Once you deploy, that becomes a false statement. **Update the subprocessor table as part of the launch, not after.** Naming providers before they are real is the exact error to avoid — but so is leaving them unnamed once they are.
4. **Historical PII in published references.** Prior notes flag nine references pinning real minors' data. That gates *publishing* those documents, not launching. Confirm before anything is made public.

### Retention

Retention is implemented by `retentionWorker.js` and, per `server/server.js`, is what "makes the Privacy Policy true." **This is a second, independent reason the workers must actually run** — on a host where they don't, the published policy becomes a misrepresentation.

---

## WELLY PRODUCTION ARCHITECTURE

| Concern | Finding | Action |
|---|---|---|
| Where inference runs | Browser, via wllama WASM | Excellent for privacy; state it publicly |
| Model delivery | Hugging Face CDN, `.gguf` Q4_K_M, 135M–1.5B (`src/ai/models.js`) | First load is a large download. Verify cache behaviour and show honest progress UI |
| Mobile | A 1.5B Q4 model is heavy on phones | Default mobile to the 135M/0.5B model; test on a mid-range Android |
| CSP | `wasm-unsafe-eval` + `huggingface.co` in `connectSrc` | Correct today; re-verify after any domain change |
| Pinecone down | Search degrades | Confirm Welly still answers without it — **must not 500** |
| Authorization | Server-side, capability-gated read-only tools | **The invariant: Welly must never be a path around authz.** Every tool call must re-check permissions server-side, never trust a client-supplied role |
| Prompt injection | Event descriptions are user-authored and reach the model | Treat retrieved text as data. A malicious event description must not be able to make Welly call a tool the user lacks rights to |
| Cost | $0 — no inference API | Strong architectural choice |

**Recommendation:** keep Welly strictly optional. `VITE_LOCAL_AI=false` should produce a fully working platform. Prior notes record that Welly's wrong answers are usually caused by runtime state rather than the model — keep that debugging order.

---

## CI/CD, STAGING, AND ROLLBACK

### Pipeline

```
feature branch → PR → [tests · lint · build · a11y · secret scan] → preview (staging DB)
                                                                          ↓
                                          manual verification → merge to main
                                                                          ↓
                                              MANUAL PROMOTION → production
```

**Production deploys should be manually promoted, not automatic on merge.** *Reasoning:* the boot sequence has fatal gates (legal hashes, schema assert, instance lock) and migrations are deliberately not automatic. A green test suite is not evidence that a deploy is safe at a given moment. Use GitHub branch protection on `main` plus a protected `production` environment with a required reviewer.

### Rollback — four different things

| Kind | Mechanism | Caveat |
|---|---|---|
| **Application** | Redeploy previous git tag / restart previous release directory | Fast. Safe *only* if the schema is compatible |
| **Database** | Restore from backup | **Loses data written since the backup.** Never routine |
| **Configuration** | Keep `/etc/wevolunteer/wevolunteer.env` under encrypted version control | Undocumented env changes are a common silent outage |
| **DNS** | Revert the record | Bounded by TTL — **keep TTL low (300s) during launch week**, raise afterwards |

**The one rule that matters:** application rollback and database rollback are not the same operation, and a deploy that requires a database rollback is a much worse incident. This is why destructive migrations must be two-phase (§ SUPABASE).

---

## PRODUCTION SMOKE TEST

Run in order. Do not mark a section passed on partial evidence.

**Infrastructure** — DNS resolves for apex/app/status; HTTP→HTTPS redirects; certificate valid and not self-signed; `/health` 200; `/ready` 200 with dependency detail; origin unreachable except via Cloudflare; WebSocket upgrade succeeds through the proxy.

**Public site** — homepage renders; nav works; mobile 375px; no console errors; OG preview renders when pasted into a chat app; `robots.txt` and `sitemap.xml` correct.

**Auth** — signup; verification email arrives (**check spam**); login; 2FA enrol and challenge; recovery code consumes once and only once; password reset email arrives and the link works; logout clears the cookie; expired-token path behaves.

**Student** — discover; apply; withdraw; see acceptance; check in; hours appear and equal the sum of `present` attendance rows; certificate renders; public verify URL resolves; Welly answers with and without Pinecone.

**Organizer** — create opportunity; view applications; accept/waitlist/reject; Auto Select draw executes at the deadline; attendance marking credits hours.

**Admin/Owner** — admin functions; Owner Center; provider health reflects reality; every external link resolves.

**Security** — anonymous access to a protected route 401s; a student calling an organizer route 403s; **IDOR: user A cannot read user B's application, certificate, or profile by id**; role escalation via request body rejected; rate limiter actually triggers.

**Performance** — homepage LCP; API p95; Welly first-token latency; model download on a cold cache over mobile network.

---

## LAUNCH GATE

### NOT READY FOR PRODUCTION while any of these is true

1. No tested restore of a PostgreSQL backup. *(currently true)*
2. Backup tooling still SQLite-only. *(currently true)*
3. Preview/staging can reach the production database. *(currently true — no guard)*
4. Domain split shipped without CSRF tokens.
5. Production database on a plan with no backups or an inactivity pause. *(currently true on Supabase Free)*
6. Workers not verified running in the production topology.
7. No owner account, or `super_admin` count is 0.
8. Legal documents fail hash verification at boot.
9. Monitoring not receiving real signal.
10. Application pages indexable by search engines.

### READY when

All ten cleared, the full smoke test passes **against the production URL**, a restore drill is recorded with date and row counts, alerts have been received by a human at least once, and a rollback has been rehearsed.

**The build passing is not a launch gate. It is a precondition for starting one.**

---

## POST-LAUNCH CHECKLIST

| When | Check |
|---|---|
| **5 min** | `/health` green; login works from a clean browser; no 5xx in logs; certificate valid |
| **30 min** | Error rate ~0; p95 latency sane; DB connections stable; a real email delivered end-to-end |
| **2 h** | Workers have each run at least once; notification queue draining; no memory growth |
| **24 h** | First backup ran and is non-empty; Auto Select draw fired correctly; quota usage across all six providers; no alert storms |
| **7 d** | Restore drill executed; retention worker did its first pass; review Amplitude funnel; review any user reports; confirm nothing is paused |

---

## THINGS WE DID NOT THINK OF

Ordered by how much they would hurt.

1. **`bin/backup.sh` is SQLite-only.** The single most serious gap. *(§ BACKUP)*
2. **No guard preventing preview/staging from using production credentials.** One pasted env var away from writing to production.
3. **The CSRF precondition the code documents** — and which the proposed domain split breaks. *(§ DOMAIN)*
4. **Supabase free projects pause after 7 days.** School calendars have long quiet stretches.
5. **Domain expiry and registrar lock.** `wevolunteers.org` expiring is a total, embarrassing, entirely preventable outage. Auto-renew on, registrar lock on, calendar reminder, and card expiry watched.
6. **Vercel Hobby is non-commercial only.** A licensing problem, not a technical one.
7. **`security.txt`** at `/.well-known/security.txt` — how a researcher reports a vulnerability instead of tweeting it.
8. **`robots.txt` + `X-Robots-Tag`** — otherwise app pages get indexed. A public search result exposing a student's name is a privacy incident.
9. **Custom 404 / 500 / maintenance pages** that match the Field Notes identity.
10. **Favicon, OG image, apple-touch-icon** — the app will be shared in group chats; a blank preview reads as untrustworthy.
11. **Uploaded avatars are not in the database backup.**
12. **Resend's 100/day cap** is the first ceiling you will hit, and it hits password resets.
13. **Secret rotation procedure.** `JWT_SECRET` rotation invalidates every session — decide in advance whether that is acceptable and how to communicate it.
14. **Cloudflare Bot Fight Mode false positives** on certificate verification, which is used by people who are not logged in.
15. **Email deliverability warm-up.** A brand-new sending domain lands in spam. Verification emails failing on day one looks like the app is broken.
16. **Support workflow.** Where does a student email when something breaks, and who reads it?
17. **Account deletion end-to-end** — including Pinecone, Amplitude, logs, and backups. "Deleted" must be true.
18. **Orphaned records and abandoned accounts** after a school year ends.
19. **Timezone.** `TZ` is read from the environment. A server in UTC and a school in America/New_York will disagree about what "the deadline" means — and Auto Select draws on deadlines.
20. **Browser support floor.** Decide it, state it, and check Welly's WASM requirements against it.
21. **The `admin` bootstrap path.** `bin/grant-ownership.mjs` requires host access — document it before you need it at 11pm.

---

## PWA / MOBILE

**Classification: post-launch improvement. Not a launch blocker.**

The app is already responsive, and installability adds a service worker — which is a caching layer over authenticated pages, i.e. a new class of cross-user data-leak bug. Push notifications are the genuinely valuable part, and they are also the part that requires the most care. Ship the web app, learn whether students actually want notifications, then decide.

---

## EMAIL ARCHITECTURE

**Sending:** use a dedicated subdomain — `mail.wevolunteers.org` — not the apex. A deliverability problem then damages the subdomain's reputation, not the root domain you also use for the marketing site. Resend's free plan now allows three domains, so this costs nothing.

**DNS records (Resend generates the exact values — do not invent them):** SPF `TXT` on the sending subdomain, DKIM `CNAME`/`TXT` as issued, and a DMARC `TXT` at `_dmarc.wevolunteers.org` starting at `p=none` with an aggregate report address, moving to `p=quarantine` then `p=reject` once reports are clean. **Start at `p=none`.** Going straight to `p=reject` on an unwarmed domain silently destroys deliverability.

**Receiving is a different problem.** Resend sends; it is not an inbox. For `hello@` / `support@` / `privacy@`, use **Cloudflare Email Routing** (free) to forward to a real mailbox. Publish `support@` and `privacy@`; the privacy address is likely required by your own policy.

---

## SEO

| Surface | Indexing | Mechanism |
|---|---|---|
| `wevolunteers.org` | **Index** | `robots.txt` allow, `sitemap.xml`, canonical tags, OG/Twitter cards, real metadata |
| `app.wevolunteers.org` | **Do not index** | `robots.txt` disallow **and** `X-Robots-Tag: noindex` header — the header is what actually enforces it |
| Certificate verify URLs | **Do not index** | `noindex`; these can carry a student's name |
| `status.wevolunteers.org` | Either | Harmless |

`robots.txt` is a request, not a control. **Use the header for anything that must not be indexed.** The split architecture is genuinely better here: it makes the boundary a domain boundary rather than a path rule.

---

## WHO DOES WHAT

### Claude can do now (repository work, no accounts needed)
- Port `bin/backup.sh` / `bin/verify-restore.sh` to `pg_dump`/`pg_restore`, keeping the invariant checks.
- Implement the production-database guard for non-production environments.
- Split `/health` into liveness and readiness.
- Implement CSRF tokens (prerequisite for the domain split).
- Add `robots.txt`, `X-Robots-Tag`, `security.txt`, custom error pages.
- Write `Dockerfile` / updated systemd units for the chosen host.
- Extend the CI workflow with the a11y and secret-scan gates.
- Produce the environment-variable matrix as a committed document.
- Audit Amplitude event payloads for PII.

### You must do (account, billing, DNS access)
- Register/confirm `wevolunteers.org`; enable auto-renew and registrar lock.
- Create the Cloudflare zone; move nameservers; enable DNSSEC.
- Provision the host (Hetzner/DO/Oracle) and create the Supabase production project.
- Create Resend, Better Stack, Amplitude, Pinecone, Upstash production credentials.
- Set production secrets on the host — **never paste them into this chat.**
- Register OAuth redirect URIs for the production origin.
- Decide the paid-tier question for Supabase.
- Obtain legal review for COPPA/FERPA exposure.

### Claude can do after you provide context (not secrets)
- Verify DNS/TLS/headers against the live domain once it exists.
- Run the production smoke test and report results honestly.
- Configure Better Stack monitors if the API token is available to the environment (not to the transcript).
- Drive the first restore drill and record the numbers.

---

## OPEN QUESTIONS

1. **Is WeVolunteer commercial?** Determines whether free tiers are licensable at all.
2. **Will any user be under 13?** Determines COPPA applicability.
3. **Will a district supply rosters or consume hours officially?** Determines FERPA posture.
4. **Expected pilot scale** — number of students, events, emails/day. Every free-tier threshold depends on it.
5. **Is the committed Supabase root certificate current for your region?**
6. **Does the Resend 100/day cap fail loudly or silently?** Untested.
7. **Who is the second operator?** A single-person operation with a singleton service has no failover for the person.

---

## EXACT NEXT STEPS

In order. Steps 1–4 are code and can start immediately; nothing before step 6 touches infrastructure.

1. **Port backup/restore to PostgreSQL.** Highest severity, no dependencies.
2. **Add the production-database guard.** Cheapest large risk reduction available.
3. **Split `/health` and `/ready`.**
4. **Implement CSRF tokens** if you want the `app.` subdomain at launch. Skip if launching on the apex.
5. **Decide Architecture A vs C** — i.e. whether you are paying $25/month for managed backups. Everything else follows.
6. **Provision the domain and Cloudflare zone.** No traffic yet.
7. **Provision the host and database. Deploy to staging.**
8. **Run the restore drill on staging.** Record the numbers. This is the launch gate that is currently failing.
9. **Configure monitoring; verify a real alert reaches a human.**
10. **Deploy production; run the full smoke test against the production URL.**
11. **Launch, then work the post-launch checklist.**

---

## DNS RECORDS

Placeholders marked `<…>` depend on your accounts and must come from the provider's own dashboard. **Do not invent these values** — in particular, Resend generates DKIM selectors and Cloudflare Pages/your host issue their own targets.

### Recommended architecture (VM/container origin)

| Host | Type | Destination | Proxy | Purpose |
|---|---|---|---|---|
| `wevolunteers.org` | A | `<marketing-host-ip>` or CNAME-flattened to Pages | **Proxied** | Marketing site |
| `www` | CNAME | `wevolunteers.org` | **Proxied** | Redirect to apex |
| `app` | A | `<origin-vm-ipv4>` | **Proxied** | Application (hides origin IP) |
| `app` | AAAA | `<origin-vm-ipv6>` | **Proxied** | Optional, only if the origin truly has IPv6 |
| `status` | CNAME | `<betterstack-status-target>` | **DNS-only** | Status page must not depend on your infra |
| `mail` | MX | `<resend-mx>` (only if using Resend inbound) | DNS-only | Usually not needed |
| `mail` | TXT | `v=spf1 include:<resend-spf> ~all` | DNS-only | SPF for the sending subdomain |
| `<selector>._domainkey.mail` | CNAME/TXT | `<resend-dkim-value>` | DNS-only | DKIM |
| `_dmarc` | TXT | `v=DMARC1; p=none; rua=mailto:dmarc@wevolunteers.org` | DNS-only | Start at `p=none` |
| `@` | MX | `<cloudflare-email-routing>` | DNS-only | Inbound `support@`, `privacy@` |
| `@` | TXT | `<domain-verification-tokens>` | DNS-only | As issued by each provider |
| — | DS | at the **registrar** | — | DNSSEC |

**Two rules that cause real outages if broken:**
1. **`status` must be DNS-only and off your infrastructure.** A status page that goes down with the thing it reports on is worse than none.
2. **Never proxy mail records.** Cloudflare's proxy is HTTP-only; proxying MX or TXT breaks mail silently.

If you host on Vercel instead, every application record above becomes **DNS-only** and you lose the proxy column entirely (§ CLOUDFLARE ARCHITECTURE).

**During launch week, set TTL to 300s** on the records you might need to revert, then raise them once stable.

---

## ENVIRONMENT VARIABLES

118 server variables and 21 client variables are referenced in code. Full classification below by class; the tuning knobs are grouped rather than listed individually because they share a policy.

### Secrets — production-only, server-only, never in git, never logged

| Variable | Local | Preview | Production | Client-visible | Required |
|---|---|---|---|---|---|
| `JWT_SECRET` | dev value | **distinct** | **unique** | No | **Yes** — `config.js` refuses to boot without it |
| `TFA_ENCRYPTION_KEY` | dev value | **distinct** | **unique** | No | Yes, if 2FA enabled |
| `DATABASE_URL` | local PG | **staging only** | prod | No | **Yes** |
| `DATABASE_SSL_CA` | optional | yes | **yes** | No | Yes in production |
| `RESEND_API_KEY` | unset/test | test key | live key | No | Yes for mail |
| `RESEND_WEBHOOK_SECRET` | unset | test | live | No | If webhooks used |
| `PINECONE_API_KEY` | optional | test index | prod index | No | No (optional dep) |
| `UPSTASH_REDIS_REST_TOKEN` | optional | staging db | prod db | No | No (optional dep) |
| `BETTERSTACK_SOURCE_TOKEN`, `BETTERSTACK_API_TOKEN`, `BETTERSTACK_QUERY_PASSWORD` | unset | unset | set | No | No |
| `GOOGLE_CLIENT_SECRET`, `MICROSOFT_CLIENT_SECRET` | dev app | dev app | prod app | No | If OAuth enabled |
| `SMTP_PASS` | unset | unset | only if SMTP fallback | No | No |
| `ROUTING_API_KEY` | optional | optional | set | No | No |

**Where they live in production:** the host's systemd `EnvironmentFile` at `/etc/wevolunteer/wevolunteer.env`, mode 0600, owned by the service user. **Not** in a repo-adjacent `.env` — that file reaches the test suite and every privileged `bin/` script, so production credentials there would let a stray `npm test` or a CLI tool operate on production.

### Configuration — non-secret but environment-specific

`NODE_ENV`, `APP_URL`, `API_PORT`, `BIND_ADDRESS`, `CORS_ORIGINS`, `TRUST_PROXY`, `TZ`, `EMAIL_FROM`, `MAIL_DOMAIN`, `APP_NAME`, `APP_RELEASE`, `PLATFORM_OWNER_USERNAME`, `WEV_DB_PATH`, `WEV_EXPORT_DIR`, `WEV_BACKUP_DIR`.

Three that matter disproportionately:
- **`BIND_ADDRESS=127.0.0.1`** in production. The default `0.0.0.0` leaves Node publicly reachable, bypassing TLS and HSTS (`server/server.js:213`).
- **`TRUST_PROXY`** must be set correctly behind Cloudflare, or every rate limiter keys on the proxy's IP and effectively stops working.
- **`TZ`** — Auto Select draws on deadlines. A UTC server and an America/New_York school disagree about when a deadline passed.

### Feature flags and safety switches — must be false/unset in production

`DEMO_MODE`, `WEV_A11Y_HARNESS`, `OAUTH_ALLOW_MOCK`, `WEV_ALLOW_DESTROYING_REAL_DATA`, `WEV_ALLOW_UNSUPPORTED_NODE`, `WEV_REAL_DB`, `PROBE_DB`, `WEV_POSTGRES_APP_TEST`, `WEV_PINECONE_TEST_SINK`, `WEV_TELEMETRY_TEST_SINK`, `TEST_POSTGRES_URL`, `SCALE_DB_URL`.

**These already refuse to boot in production**, which is the right pattern and is more thoroughly applied than I expected: `DEMO_MODE` (`server/server.js:41`), `WEV_A11Y_HARNESS` (`server/server.js:57`), and `OAUTH_ALLOW_MOCK` (`server/config.js:492`). `WEV_ALLOW_DESTROYING_REAL_DATA` is not a server flag at all — it is a CLI escape hatch gated by `bin/lib/db-safety.mjs:194`, which is the correct place for it.

*No new boot guards are needed here.* The remaining flags in this group are test-harness variables that have no production meaning. The residual risk is not a missing guard but an **operator setting one of these on the production host by hand** — which is why the production env file should be reviewed as a whole, not just diffed.

### Tuning knobs — safe defaults, override only with reason

~60 variables of the form `*_RATE_LIMIT`, `*_LIMIT`, `*_MS`, `*_INTERVAL_MS`, `*_TIMEOUT_MS` (e.g. `LOGIN_RATE_LIMIT`, `MAIL_RETRY_DELAY_MS`, `INSTANCE_LOCK_STALE_MS`, `PINECONE_TOP_K`, `TELEMETRY_SAMPLE_RATE`). All have code defaults. Leave unset in production unless a measurement justifies a change, and record the reason when you do.

### Client-visible (`VITE_`) — assume public

All 21 are compiled into the browser bundle and are **world-readable**. Reviewed: none carries a secret.

`VITE_AMPLITUDE_API_KEY` is a write-only ingest key and is public by design — this is correct, not a leak. `VITE_LOCAL_AI` toggles Welly. The `VITE_PRIVACY_*`, `VITE_SUPPORT_EMAIL`, and `VITE_DOCUMENT_SIGNATORY*` values are published contact/legal metadata and must be accurate at launch because they appear in policy text.

**Standing rule: never add a secret behind a `VITE_` prefix.** Vite inlines those at build time; there is no runtime boundary.

---

## INCIDENT RESPONSE

Every procedure follows: **Detect → Diagnose → Contain → Recover → Verify → Document → Prevent.**

| Incident | Detect | Diagnose | Contain | Recover | Prevent |
|---|---|---|---|---|---|
| **App down** | App HTTP monitor P1 | `systemctl status`, journal, host reachable? | Cloudflare "Always Online" / maintenance page | Restart service; if boot-gated, read the FATAL line — it names the cause | Boot gates are deliberately loud; keep them that way |
| **API down, site up** | `/health` 503 | Is it DB or process? | — | Restart; check DB | Split `/health` and `/ready` so this is unambiguous |
| **Database unavailable** | `/health` 503, `database: disconnected` | Supabase status; connection count; paused project? | Read-only messaging to users | Resume project / restart pool / restore | Pro plan removes the pause failure mode |
| **Redis unavailable** | Dependency check P2 | Upstash quota exhausted? | None needed | Degrades to in-process limiters | Quota alert at 70% |
| **Pinecone unavailable** | Dependency check P3 | Quota or outage | None | Welly degrades; core unaffected | Verify degradation in smoke test |
| **Email not delivering** | Queue depth alert | Resend quota? DNS/DKIM? Spam-foldered? | Warn users password reset is delayed | Raise plan or fix DNS | Watch the **100/day** cap |
| **Bad deployment** | Errors spike post-deploy | Diff the release | **Roll back first, diagnose after** | Redeploy previous tag | Manual promotion + smoke test |
| **Bad migration** | Errors referencing schema | Which migration | **Stop writes immediately** | Restore from backup — expect data loss | Two-phase destructive migrations |
| **Leaked credential** | Secret scan / report | What did it reach? | **Rotate first, investigate second** | New secret; note `JWT_SECRET` rotation logs everyone out | Pre-commit scan; secrets never in `.env` |
| **Security incident** | Report / anomaly | Scope: what data, whose | Suspend affected accounts; preserve logs | Patch; notify per policy and law | `security.txt` gives researchers a path |
| **DNS failure** | External monitor | Registrar vs Cloudflare | Revert the record | Wait out TTL | Low TTL during changes; auto-renew on |
| **Certificate failure** | TLS monitor (14-day warning) | Cloudflare edge vs origin cert | — | Reissue | Origin CA cert is 15-year |
| **Domain expiry** | Registrar + calendar | — | Emergency renewal | — | Auto-renew, registrar lock, watch card expiry |

**Two standing rules.** *Roll back before you diagnose* — restoring service is not the same as understanding the failure, and users are waiting for the first. *Rotate before you investigate* on a credential leak, for the same reason.

---

## LONG-TERM ROADMAP

### P0 — before launch
Port backups to PostgreSQL and prove a restore. Add the production-database guard. Split `/health` / `/ready`. Add `robots.txt` + `X-Robots-Tag` on app routes. CSRF tokens if splitting domains.

### P1 — first month
`security.txt`. Custom 404/500. Favicon and OG images. Quota alerts across all six providers. Rehearse a rollback. Document the owner-bootstrap path. Confirm account deletion reaches every downstream service.

### P2 — first term
Object storage for avatars and exports (removes the last filesystem dependency and makes the app portable). Move remaining in-process limiters to Redis. Automate the restore drill. Consider PWA + push if students ask for notifications.

### Future scaling — only when justified by measurement
Prior scale probing measured the events endpoint at 11ms @ 1k, 113ms @ 10k, and 572ms @ 50k events on PostgreSQL, with no index that changes the shape. **That is your capacity signal.** If event counts approach 50k, the fix is pagination and query redesign, not a bigger server.

Beyond that: a read replica, a real job queue to replace the interval workers, a second app instance (which requires retiring the instance lock and moving *all* limiter state to Redis first), and paid observability retention. None of these are justified at pilot scale, and adopting them early would add failure modes without removing any.

---

## SOURCES

- [Vercel Functions Limits](https://vercel.com/docs/functions/limitations) — duration, memory, payload, concurrency, file descriptors
- [Vercel WebSockets](https://vercel.com/docs/functions/websockets) — instance pinning, fan-out limits, billing
- [Vercel Hobby Plan](https://vercel.com/docs/plans/hobby) — non-commercial restriction, included usage
- [Vercel Fair Use Guidelines](https://vercel.com/docs/limits/fair-use-guidelines)
- [Should I use Cloudflare in front of Vercel?](https://vercel.com/guides/using-cloudflare-with-vercel)
- [Supabase Pricing](https://supabase.com/pricing) — free-tier backups, PITR, pausing, project limits
- [Upstash Redis Pricing](https://upstash.com/pricing/redis)
- [Cloudflare Error 526](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-526/)
- Resend, Better Stack, Amplitude, Pinecone free-tier figures cross-checked across multiple 2026 pricing summaries; **re-verify on the vendors' own pricing pages before committing**, as these were the least authoritative sources used here.
