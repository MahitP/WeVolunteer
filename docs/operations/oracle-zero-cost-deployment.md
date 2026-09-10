# WeVolunteer — the $0 production deployment

**Researched and implemented 2026-09-05.** Everything marked *Verified* was executed in this repository. Everything marked *Human action* requires an account, DNS, or a provisioned host and has **not** been done.

This document describes the **merged release candidate** — `claude/release-candidate`, built from `main` with both feature branches merged in. It is not a proposal, and it is not a description of either branch alone.

---

## The architecture

```
                         INTERNET
                            │
                            ▼
                      CLOUDFLARE  (Free)
              DNS · TLS · CDN · WAF · DDoS · bot
                            │  proxied, Full (strict)
                            ▼
                ORACLE ALWAYS FREE VM  ($0)
                  Ubuntu 24.04 · Ampere A1 ARM
                            │
                 ┌──────────┴──────────┐
                 ▼                     ▼
              NGINX                EXPRESS  (systemd)
        dist/ static bundle     API · workers · Socket.IO
        SPA fallback · cache             │
                                ┌────────┼────────┐
                                ▼        ▼        ▼
                          SUPABASE   UPSTASH   PINECONE
                          Postgres    Redis     vectors
                          (Free)     (Free)     (Free)
                                │
                                ▼
                       nightly pg_dump
                       encrypted (openssl cms)
                                │
                                ▼
                       CLOUDFLARE R2  (Free)
                          off-site copy
```

### Why this shape

The application is a **stateful singleton**: one process holding eight interval workers, a Socket.IO server, an instance lock, and in-process rate limiters. That is not a defect to be refactored away — it is the correct design for one always-on host, and every part of it works here unchanged. The serverless alternative would have required replacing four subsystems that are currently correct.

An always-on VM also solves a problem that would otherwise be fatal on the free tier: **Supabase pauses a free project after 7 days of inactivity.** A school platform is seasonally quiet. Because this host holds a connection pool and answers a health probe every minute, the project never goes idle.

---

## Oracle Cloud

*Verified against [Oracle's Always Free documentation](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm) on 2026-09-05.*

| Resource | Always Free allowance |
|---|---|
| Ampere A1 (ARM) | 1,500 OCPU-hours + 9,000 GB-hours per month = **2 OCPU / 12 GB** run continuously |
| AMD E2.1.Micro | 2 instances, 1/8 OCPU, **1 GB RAM** each |
| Block storage | 200 GB total, 5 volume backups |
| Outbound transfer | 10 TB/month |

**Take the Ampere A1 shape.** 2 OCPU / 12 GB runs Node, Nginx and a connection pool comfortably; 1 GB on the AMD micro does not, once `sharp` is decoding images.

> **This allowance was halved on 15 June 2026** (from 4 OCPU / 24 GB) with no announcement. Plan against 2/12, and re-read the page before provisioning — the same thing can happen again.

### ARM is safe for this codebase — verified

The only reason to hesitate about Ampere is native modules. Checked against the actual dependency tree:

| Dependency | Used for | linux-arm64 |
|---|---|---|
| `sharp` | avatar + organization image encoding (server) | ✅ `@img/sharp-linux-arm64` prebuilt |
| `@napi-rs/canvas` | optional peer of `pdfjs-dist` | ✅ `@napi-rs/canvas-linux-arm64-gnu` |
| `bcryptjs` | password hashing | ✅ pure JavaScript, nothing to compile |
| database driver | `pg` + Node's built-in `node:sqlite` | ✅ no native build |

There is **no `node-gyp` compilation step in the server dependency tree** (`sharp` ships prebuilds). ARM is not a risk here.

### Idle reclamation — a real risk, stated honestly

Oracle reclaims Always Free instances judged idle. The criteria are **AND-ed**, and all three must hold across a 7-day window:

- CPU (95th percentile) < 20%
- Network < 20%
- Memory < 20% *(A1 only)*

Failing **any one** protects the instance. In practice memory is the reliable one: Node with OpenTelemetry, a pg pool, Socket.IO and `sharp` loaded, plus Nginx and the OS, sits well above 20% of a 6 GB allocation.

**Mitigations, in order of reliability**
1. Allocate 1 OCPU / 6 GB rather than 2/12 — the same workload is a much larger fraction of the memory ceiling.
2. Better Stack probes `/health` every minute, which is continuous network activity.
3. Watch it. If the instance is reclaimed the data is safe — it is in Supabase and R2, not on the box — and the runbook below rebuilds the host.

This is the single largest availability risk in the $0 architecture, and it is not fully eliminable. It is survivable because **no state that matters lives on the VM.**

---

## Cost audit

*Free-tier figures verified 2026-09-05. Usage estimates assume a pilot of roughly 300 students and 30 organizers.*

| Service | Plan | Cost | Free limit | Expected use | Headroom | Accidental billing? |
|---|---|---|---|---|---|---|
| Oracle Compute | Always Free | **$0** | 2 OCPU / 12 GB, 200 GB disk, 10 TB egress | 1 VM, ~20 GB, <50 GB egress | Very large | **Yes if account is PAYG** — see below |
| Cloudflare | Free | **$0** | Unlimited DNS/CDN/DDoS; WAF managed rules; 10 firewall rules | 3 records, ~5 rules | Large | No |
| Supabase | Free | **$0** | 500 MB DB, 5 GB egress, 2 active projects | ~50 MB, <1 GB | Moderate | No — Free stops at the limit |
| Cloudflare R2 | Free | **$0** | 10 GB, 1M Class A, 10M Class B, **no egress fee** | ~2 GB (14 dailies), ~30 writes/mo | Very large | Only past 10 GB |
| Upstash Redis | Free | **$0** | 256 MB, **500K commands/month** | See note | **Tight** | Pay-as-you-go if enabled |
| Pinecone | Starter | **$0** | 1 index, 2 GB, 2M write + 1M read units | Small | Large | No |
| Better Stack | Free | **$0** | 10 monitors, 10 heartbeats, 1 status page | 4 + 3 | Adequate | No |
| Amplitude | Free | **$0** | 2M events/mo, 10K MTU | Well under | Large | No |
| Resend | Free | **$0** | 3,000/mo, **100/day**, 3 domains | See note | **Tight** | No |
| **Total** | | **$0/month** | | | | |

### The two tight constraints, named

**Resend's 100/day cap** is the first ceiling you will hit, and it hits password resets and verification emails — the worst possible thing to have fail on day one of a pilot. 300 students onboarding in one afternoon exceeds it.

*Researched again 2026-09-08, and the earlier advice here — "stagger onboarding" — was an operational workaround for something with a free technical fix.*

Two things were open and are now settled:

- **What happens at the cap.** Resend does not queue and does not silently drop: on the free plan **sending pauses**, and the free tier is not auto-upgraded or billed. So the failure mode is a password reset that never arrives, with no bill and no bounce to notice it by.
- **There is a larger free tier, and this codebase already speaks its protocol.** Brevo's free plan is **300/day (9,000/month)**, forever, no card, with transactional API *and* SMTP, and SPF/DKIM/DMARC on a custom domain. `server/email.js` prefers `RESEND_API_KEY` and otherwise falls back to `nodemailer` over `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS` — so Brevo needs **no code change at all**, only environment variables.

**Recommendation: send through Brevo over SMTP.** Three times the daily headroom on the exact constraint that binds, for the same $0, using a path the application already supports and tests. Keep Resend configured as the alternative if its API and dashboard are preferred — but then plan the onboarding around 100/day, because the cap is a pause, not a queue.

| | Resend free | Brevo free |
|---|---|---|
| Monthly | 3,000 | 9,000 |
| **Daily** | **100** | **300** |
| At the cap | sending pauses | sending pauses |
| Custom domain, SPF/DKIM/DMARC | yes | yes |
| Card required | no | no |
| Code change needed here | none (`RESEND_API_KEY`) | none (`SMTP_*`) |

**Upstash's 500K commands/month.** Rate limiting touches Redis on most API requests; at ~5 commands/request that is ~100K requests/month. Redis is an *optional* dependency here — the limiters degrade to per-process counters and the application keeps working — so exhaustion is a degradation, not an outage. Watch it.

### Accidental billing

Oracle is the only real exposure. An **Always Free** tenancy cannot be charged. A **Pay-As-You-Go** tenancy keeps the same free allowances but *will* bill for anything beyond them. If you upgrade to PAYG (people do, to avoid reclamation), set a **budget alert at $1** immediately.

---

## Frontend: $0, and how

```
FRONTEND COST:   $0/month
FRONTEND HOST:   Nginx on the Oracle VM, serving dist/
WHY:             The bundle is static files. Serving them needs no service the
                 VM is not already running, and Cloudflare caches them at the
                 edge, so the origin serves each asset approximately once.
FREE LIMIT:      Oracle 10 TB/month egress; Cloudflare CDN unmetered
EXPECTED USAGE:  ~2.5 MB of hashed assets per cold visitor, ~0 for repeat
                 visitors. <50 GB/month at pilot scale.
HEADROOM:        >200x
```

Cloudflare Pages was considered and **rejected**: it is also free, but it adds a second deploy target and a second place for the API origin and CORS allowlist to drift out of step, in exchange for caching that Cloudflare already provides in front of the VM.

`deploy/nginx/wevolunteers.conf` implements this. The parts that are load-bearing rather than decorative:

- **`real_ip` from `CF-Connecting-IP`** — without it every request appears to come from a Cloudflare address, and every per-IP rate limiter collapses into one bucket for the entire internet. This is a security control, not a logging nicety. It requires the origin firewall to accept 443 **only from Cloudflare ranges**, otherwise the header is forgeable.
- **`proxy_set_header Host $host`** — `app.js` compares `Origin` against `Host` to decide whether a write is same-origin. Passing `$proxy_host` would make every legitimate write look cross-origin and 403.
- **Immutable caching for `/assets` only.** Vite content-hashes those (126 of 140 files); `index.html` gets `no-cache`, because it names the current hashed bundles and a stale copy points browsers at assets that no longer exist.
- **`no-store` on `/api`.** One cached authenticated response served to a second user is a cross-account data leak.
- **SPA fallback last**, so it cannot shadow `/api`, `/uploads` or the asset rules.

> `nginx -t` has **not** been run — nginx is not installed in this environment. Validate before reloading; a syntax error takes the site down.

---

## Backups — implemented and proven

`bin/backup-postgres.sh` → `bin/backup-upload.mjs` → R2, verified by `bin/verify-restore-postgres.sh`.

| Property | How |
|---|---|
| Consistent dump | `pg_dump --format=custom` |
| Compression | `--compress=9` |
| Encryption | `openssl cms`, **public key** — the host encrypts and cannot decrypt |
| Integrity | `pg_restore --list` parses the archive before it is kept |
| Completeness | invariant counts recorded from the live DB into a manifest |
| Off-site | R2, independent of both Oracle and Supabase |
| Retention | 14 days, pruned **only after** a successful new backup |
| Failure detection | non-zero exit on every failure path |

**The version trap, found by testing rather than by reading.** `pg_dump` 16 against a PostgreSQL 17 server exits non-zero **and leaves a zero-byte file**. A script checking only a pipeline's status would compress that, encrypt it, prune the previous generation and report success. Supabase runs PostgreSQL 17; Homebrew and Debian default to older clients. The script compares major versions first and names the fix:

```
WEV_PG_BIN=/opt/homebrew/opt/postgresql@17/bin bin/backup-postgres.sh
```

### What was actually proven — *Verified*

Against a real 65-table schema with seeded data, not a fixture:

| Test | Result |
|---|---|
| Backup with a compatible client | exit 0, invariants `users=2 hours=3.50 certs=1` |
| Backup with an incompatible client | exit 1, no partial file left behind |
| Encrypt → decrypt round-trip | byte-identical, plaintext removed |
| Upload to an S3-compatible endpoint | archive + manifest, correctly prefixed |
| **Restore from the off-site copy after deleting all local backups** | **69 tables, 96 validated FKs, 185 indexes, counts matching the manifest exactly** |

And the guards were mutation-tested, because a check that cannot fail is not a check:

| Mutation | Result |
|---|---|
| Manifest says 99 users | exit 1 — `users(99->2)` |
| Truncated archive | exit 1 |
| Wrong decryption key | exit 1 |
| No archive present | exit 1 |
| Restore URL == production URL | exit 1, **live database untouched** |

### Free-tier arithmetic

A compressed dump of the pilot database is ~1–5 MB (the 65-table schema with test data compressed to 176 KB). At 14 dailies that is well under 100 MB against R2's 10 GB. Roughly 30 Class A operations per month against 1,000,000. **Not close to any limit.**

---

## Scheduling: cron, not QStash

Because the VM is always on, the eight interval workers keep running in-process exactly as designed — including the Auto Select scheduler, whose missed draw is a correctness failure, and the retention worker, which is what makes the published Privacy Policy true rather than a representation nothing implements.

**QStash was evaluated and rejected.** It exists to give scheduled execution to platforms that cannot hold a process. This platform holds a process. Adding it would introduce a network dependency, an authentication surface and duplicate-delivery semantics in exchange for solving a problem that does not exist here.

`deploy/wevolunteer-backup.timer` runs the nightly backup. It currently invokes the SQLite `bin/backup.sh`; **point it at `bin/backup-postgres.sh`** when provisioning — see human actions.

---

## Environment separation

`server/db/productionDatabaseGuard.js` refuses to let a non-production process reach the production database.

It compares a **fingerprint** — SHA-256 over `host:port/database`, credentials excluded — because it has to work in environments that must *not* hold the production URL. The fingerprint is not a secret, so a staging host can be told what production looks like without being told how to reach it. Excluding credentials means rotating the password cannot silently disable the guard.

Obtain it once, from production:

```bash
node bin/db-fingerprint.mjs
```

then set `WEV_PRODUCTION_DB_FINGERPRINT` in **every other** environment.

Environment identity is read from `VERCEL_ENV` in preference to `NODE_ENV`, which matters even here: copying production environment variables anywhere copies `NODE_ENV=production` with them.

---

## Security additions

**CSRF (`server/csrfGuard.js`).** `config.js` documents that `sameSite: 'lax'` without a CSRF token is safe *only* while the SPA and API share one origin, and names the condition that invalidates it. The planned `wevolunteers.org` + `app.wevolunteers.org` split is that condition — those are the **same site**, so Lax attaches the session cookie to a POST from one to the other.

The guard refuses unsafe methods when the browser reports `Sec-Fetch-Site: same-site` or `cross-site` **and** the request carries a session cookie. `Sec-Fetch-Site` is set by the browser and is a forbidden header name, so page script cannot forge it. Only cookie-bearing requests are guarded, because CSRF is an ambient-credential attack and refusing the rest would break the non-browser callers the CORS layer deliberately admits.

Mounted **before** the rate limiters: after them, a blocked CSRF attempt becomes a denial of service against the account it failed to attack.

**Bundle secret scanning (`npm run scan:bundle`).** Runs in CI after the build. The real bundle is clean across 143 files; six planted positive controls were each detected.

**Uploads.** `WEV_UPLOADS_DIR` is **required** on this host. The default is inside the read-only mount created by `ProtectSystem=strict`, and the directory is created at import time — so leaving it unset does not break uploads, it stops the service from starting.

---

## Human actions

Everything below needs an account, DNS, or a provisioned host. None of it has been done.

### 1. Oracle
Create the tenancy. Provision **Ampere A1, Ubuntu 24.04, 1 OCPU / 6 GB** (see reclamation). Open 443 to Cloudflare ranges only. If the account is Pay-As-You-Go, **set a $1 budget alert.**

### 2. Cloudflare
Add the zone, move nameservers, enable DNSSEC. Set SSL/TLS to **Full (strict)** — never Flexible, which would carry the `secure` session cookie over plaintext to the origin. Install a Cloudflare Origin CA certificate on the VM. Generate `/etc/nginx/cloudflare-real-ip.conf` from `https://www.cloudflare.com/ips/`.

| Host | Type | Target | Proxy |
|---|---|---|---|
| `wevolunteers.org` | A | VM IP | Proxied |
| `app` | A | VM IP | Proxied |
| `status` | CNAME | Better Stack | **DNS-only** |
| mail records | TXT/CNAME | from Resend | **DNS-only** |

### 3. Supabase

Create the production project. Confirm `deploy/certs/supabase-root-2021.crt` is still the current root for your region — a rotated root fails closed, correctly, at the worst moment.

> **Do NOT run `supabase/migrations/*_baseline_schema.sql`.**
>
> An earlier draft of this document said to, and that was wrong. That file is a
> historical artefact of the SQLite migration, generated from `pilot.db` and
> translated into idiomatic PostgreSQL types. It disagrees with the schema the
> application actually uses on **150 columns** — ~130 timestamps (`TEXT` vs
> `TIMESTAMPTZ`) and ~20 booleans (`INTEGER 0/1` vs `BOOLEAN`) — because the
> application's types are deliberately SQLite-compatible so one codebase serves
> both engines.
>
> Running it does not merely differ, it breaks the platform.
> `CREATE TABLE IF NOT EXISTS` cannot repair an existing table, so the wrong
> types survive and the application fails on
> `operator does not exist: boolean = integer` — or, worse, credits every
> attending volunteer **zero hours**, because `pg` returns `BOOLEAN` as
> JavaScript `true` and the hours ledger credits on `present === 1`.

**Leave the database empty.** The application creates its own schema on first
boot, via `completeDatabaseInit()`. It is idempotent, so restarts are no-ops.

`assertSchemaSourceCompatible()` refuses to boot against a database created from
the baseline, naming the cause and the fix — so this is guarded in code, not only
here.

### 4. Environment file

`/etc/wevolunteer/wevolunteer.env`, mode 0600, owned by the service user. Never a repo-adjacent `.env` — that file reaches the test suite and every privileged `bin/` script.

```
WEV_UPLOADS_DIR=/var/lib/wevolunteer/uploads     # REQUIRED — see above
WEV_PRODUCTION_DB_FINGERPRINT=                   # from bin/db-fingerprint.mjs
WEV_PG_BIN=/usr/lib/postgresql/17/bin            # must match the server major
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=
WEV_BACKUP_PUBKEY=/etc/wevolunteer/backup-cert.pem
TRUST_PROXY=1
BIND_ADDRESS=127.0.0.1
```

Plus the existing `DATABASE_URL`, `JWT_SECRET`, `TFA_ENCRYPTION_KEY`, `APP_URL` and provider keys from `deploy/wevolunteer.env.example`.

**Do not paste any of these values into a chat or a commit.**

### 5. Backup keypair

The host encrypts; only you can decrypt. Generate the private key **off the server** and never copy it there:

```bash
openssl req -x509 -newkey rsa:4096 -keyout backup-key.pem -out backup-cert.pem \
  -days 3650 -nodes -subj "/CN=wevolunteer-backup"
```

Upload only `backup-cert.pem`. Store `backup-key.pem` somewhere you will still have it after losing the server — a backup you cannot decrypt is not a backup.

### 6. Before serving traffic

```bash
sudo install -d -o wev -g wev -m 750 /var/lib/wevolunteer/uploads
sudo nginx -t                                    # never skip
sudo systemctl enable --now wevolunteer
```

Point `deploy/wevolunteer-backup.service` at `bin/backup-postgres.sh`, then **run the restore drill against the real production backup** before launch. It is the only step that converts a backup into a proven one.

---

## Deployment checklist — strict dependency order

Each step is marked **HUMAN** (needs an account, console or shell), **CLAUDE**
(repository work, already done or doable here), or **BOTH**.

Do not reorder. Several steps exist only to catch a failure before it becomes
expensive — 17 and 30 in particular.

| # | Step | Who | Notes |
|---|---|---|---|
| 1 | Create Oracle tenancy | HUMAN | If it becomes Pay-As-You-Go, set a **$1 budget alert** immediately |
| 2 | Create Always Free Ampere A1 VM, Ubuntu 24.04 | HUMAN | **1 OCPU / 6 GB** — smaller resists idle reclamation better |
| 3 | Configure VCN / security list | HUMAN | 443 from **Cloudflare ranges only**; 22 from your IP only |
| 4 | Configure SSH access | HUMAN | Key-only; disable password auth |
| 5 | Install Node 24, Nginx, `postgresql-client-17` | HUMAN | Client major **must match** the Supabase server major |
| 6 | Create directories and service user | HUMAN | `/srv/wevolunteer`, `/var/lib/wevolunteer{,/uploads,/exports}`, user `wev` |
| 7 | Create Supabase project | HUMAN | **Leave the database empty** — do not run the baseline migration |
| 8 | Create Upstash Redis database | HUMAN | Note the 500K commands/month ceiling |
| 9 | Create Resend account, verify sending subdomain | HUMAN | `mail.wevolunteers.org`; DKIM/SPF/DMARC as issued |
| 10 | Create R2 bucket + scoped credentials | HUMAN | Object read/write on one bucket; nothing wider |
| 11 | Generate the backup keypair **off the server** | HUMAN | Upload only the certificate; keep the private key elsewhere |
| 12 | Write `/etc/wevolunteer/wevolunteer.env` (0600, owned by `wev`) | HUMAN | Template in §4 above |
| 13 | Obtain the production DB fingerprint | BOTH | `node bin/db-fingerprint.mjs`, then set it in every **other** environment |
| 14 | Deploy the application code and `npm ci --omit=dev` | HUMAN | ARM verified: all native deps ship linux-arm64 prebuilds |
| 15 | `npm run build` | BOTH | Produces `dist/`, which Nginx serves |
| 16 | Install systemd unit; `daemon-reload` | HUMAN | `deploy/wevolunteer.service` |
| 17 | Install Nginx config and run **`nginx -t`** | HUMAN | Never skip — a syntax error takes the site down on reload |
| 18 | Install Cloudflare Origin cert + `cloudflare-real-ip.conf` | HUMAN | Without real-IP restoration every rate limiter shares one bucket |
| 19 | Configure Cloudflare DNS + **Full (strict)** | HUMAN | Never Flexible — it carries the `secure` cookie over plaintext |
| 20 | `systemctl enable --now wevolunteer` | HUMAN | First boot creates the schema; watch for the legal-hash and lock lines |
| 21 | Verify `/live` returns 200 | BOTH | Liveness — no dependencies |
| 22 | Verify `/ready` returns 200 | BOTH | Readiness — database gating, dependencies reported only |
| 23 | Verify `/health` returns 200 | BOTH | Unchanged contract; the Better Stack monitor depends on it |
| 24 | Verify frontend loads and deep links refresh | BOTH | `/dashboard`, `/certificates`, `/owner` — SPA fallback |
| 25 | Verify API, authentication, 2FA | BOTH | Real login flow, not a direct URL |
| 26 | Verify Socket.IO connects through Cloudflare | BOTH | Free plan closes idle proxied sockets ~100s |
| 27 | Send a real transactional email | HUMAN | Check spam; a new domain lands there first |
| 28 | Run `bin/backup-postgres.sh` and confirm the R2 object | BOTH | First real off-site copy |
| 29 | **Reboot the VM** | HUMAN | The only way to prove systemd persistence |
| 30 | Run the restore drill against the real backup | BOTH | `bin/verify-restore-postgres.sh` — **the launch gate** |
| 31 | Run `node server/verifyHours.js` against production | BOTH | Proves ledger parity on the real database |
| 32 | Configure Better Stack monitors; confirm one alert reaches a human | HUMAN | Unpause only once the domain resolves |
| 33 | Production browser workflows: student, organizer, admin, owner | BOTH | Navigate through the UI, not by URL |
| 34 | Final security check: anonymous 401, student 403, owner 200, IDOR | BOTH | |
| 35 | **Only then** begin the pilot | HUMAN | Stagger onboarding — Resend allows 100 emails/day |

### The three steps most often skipped, and what they cost

- **17 (`nginx -t`)** — a config typo takes the whole site down at reload, including the page that would tell you why.
- **29 (reboot)** — the only proof that the service actually comes back. A unit that starts by hand and not at boot looks identical until the first unplanned restart.
- **30 (restore drill)** — a backup that has never been restored is a hypothesis. Everything in this document is arranged so this step is possible; it is the one that makes the rest true.

---

## What the release candidate contains

`claude/release-candidate` is `main` with both feature branches merged:

| Source | Brings |
|---|---|
| `main` (15 commits newer than either branch) | the improved production-database fingerprint guard, roster-export authorization fix, bundle mailbox-key fix, badge administration, message search |
| `claude/wevolunteer-production-architecture-89e97f` | PostgreSQL backup + restore, R2 off-site upload, schema-source guard, CSRF guard, `/live` + `/ready`, `WEV_UPLOADS_DIR`, Nginx config, bundle secret scanner |
| `claude/owner-center-certificate-upgrade-7eef59` | Owner Center, CertificateView / CertificateDocument / CertificateShareDialog, certificate double-`h1` fix, dark-mode contrast fix, focus-ring cascade fix, telemetry IP redaction |

**Nothing was discarded.** Where `main` and the architecture branch both carried
a production-database guard, `main`'s version was kept: it hashes the username
alongside host and database, which the earlier version did not, and without it
every Supabase project in a region fingerprints identically — they share a
pooler hostname and the `postgres` database name.

---

## Still open

Grouped by what each item actually needs, so nothing here reads as a code defect.

### Requires Oracle infrastructure
| Item | Why it cannot be done here |
|---|---|
| `nginx -t` validation | nginx is not installed in this environment |
| Reboot / systemd persistence | no VM exists |
| Idle-reclamation behaviour over a 7-day window | needs a running instance |

### Requires Supabase
| Item | Why |
|---|---|
| Restore drill against real production data | no production database exists |
| First-boot schema creation on the real project | the guard is proven locally against three databases; the real one has not been created |

### Requires Cloudflare / R2
| Item | Why |
|---|---|
| Live R2 upload | no credentials. Proven against a local S3-compatible endpoint and AWS's published SigV4 derivation vector |
| Full (strict) TLS and real-IP restoration | needs the zone and the origin certificate |

### Requires Resend
| Item | Why |
|---|---|
| Deliverability of a new sending subdomain | needs DNS |

The 100/day behaviour is no longer open: sending **pauses**, and Brevo's 300/day
free tier is reachable with no code change — see the cost audit above.

### Repository verified — no further work
Backup and restore including every failure path, the schema-source guard, the
production-database guard, CSRF including the sibling-subdomain case, `/live`
and `/ready`, `WEV_UPLOADS_DIR` against a real read-only directory, the bundle
secret scanner with six planted controls, Owner Center authorization, and the
full test matrix below.

### One a11y note
`LocationDisplay.jsx` — a keyboard-inaccessible `<div onClick>` — was confirmed
still unreferenced after the merge and has been **removed** along with its barrel
export. Its stylesheet stays; five other components import it.

The candidates checked and found **not** to be defects, recorded so the next
audit does not re-litigate them: modal overlays have Escape via `useModal`;
`LocationThumbnail` duplicates an action `EventCard` already exposes through a
real `<button>`; and `DatePicker` is a full `role="grid"` with a focus trap and
roving tabindex.
