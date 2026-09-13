# WeVolunteer — $0 production infrastructure, and what merge readiness actually depends on

**Date:** 2026-09-09
**Scope:** re-research the production architecture from current sources, implement
what wins, and give a single merge verdict.
**Branch produced:** `claude/trunk-security-port`, branched from `main` at `2446aaf`.

> **Status, 2026-09-13 — read this before the verdict.** This report describes
> the repository and the infrastructure as they stood on 2026-09-09, and it is
> kept as that record. Three things have changed since:
>
> - **Production is deployed** on `app.wevolunteers.org`. The owner actions in
>   §21 were the pre-deployment list; `2026-09-10-deployment-gate.md` and the
>   `deploy/` commits after it are the later record.
> - **The branch's work is on `main`**, carried across in the 2026-09-13 branch
>   completion pass rather than merged: see `docs/operations/branch-reconciliation.md`.
>   Its dependency fixes were already there; `vitest` 4.1.11, the template
>   corrections and this report were not.
> - **§11 describes a placement that was corrected on the way.** The middleware
>   was mounted beside cookie-parser and described as covering responses that
>   never reach a router. The CORS 403 and the 413/400 body refusals are
>   produced above that point and did not carry the header — shown by mutation,
>   not argued. On `main` it sits ahead of CORS and both parsers, with seven
>   cases rather than four.

---

## 1. Verdict

> ### NOT READY TO MERGE

Not because of anything in the code. The application, the schema, the backup
path, the security controls and the test matrix are all in the state this report
describes as verified. It is not ready because **the architecture cannot be
finished without four owner actions that no amount of repository work
substitutes for**: a Cloudflare account, an origin host to point DNS at, a Google
Cloud console change, and an email-provider account. Until those exist there is
no domain, no TLS, no OAuth and no outbound mail — and a merge that claims
production readiness while those are missing is a claim about a system that has
never run.

What *is* ready is the branch. `claude/trunk-security-port` is a clean
fast-forward onto `main`, it closes three high-severity advisories on code paths
that handle uploaded files and outbound mail, and it adds the one security
control this pass found genuinely missing. Merging it is a good idea. Merging it
does not make the platform launchable.

Section 21 splits every remaining item into **owner action**, **I can finish it**,
and **external limitation**.

---

## 2. The finding that reframes the rest

The brief states that the current release candidate is
`claude/release-candidate`. **That stopped being true before this pass began.**

`main` contains the commit `40957a5 Merge branch 'claude/release-candidate'`.
The release candidate was merged into the trunk, and the trunk then moved on —
including `6f4ae1f Merge perf-scaling`, and roughly a hundred commits in total
that the release-candidate branch does not have.

Measured, not inferred:

| Question | Answer | How measured |
|---|---|---|
| Commits on `main` not on `claude/release-candidate` | **100** | `git rev-list --count` |
| Commits on `claude/release-candidate` not on `main` | 40 | `git rev-list --count` |
| …already upstream by patch-id | **31** | `git cherry main claude/release-candidate` |
| …of the remaining 5, present on `main` in equivalent or better form under a different SHA | 3 | file-by-file comparison |
| …**genuinely new** | **2** | the email research; a dependency bump |

The three carried across under different SHAs are worth naming, because the
pattern is what matters: one test fix had been re-done on `main` by another
session, and two more had been fixed independently on `main` — one of them in a
*better* form. That last one is a live example of why merging the stale branch
would have been a regression rather than an improvement:

- `claude/release-candidate` sets `DATABASE_POOL_MAX ?? 10`, argued from "PostgreSQL
  does not go faster when handed more concurrent connections than it has cores".
- `main` sets `?? 25`, and replaces that argument with a measured sweep — at a 3 ms
  round trip, 10 gives 127 req/s and a 481 ms p95; 25 gives 487 req/s and a 73 ms
  p95. The old reasoning models CPU-bound queries; a pooled client over a network
  spends most of its life waiting on a round trip.

Merging the release candidate into `main` would have taken the pool back to 10.
So this pass did not merge it. It **ported the two genuinely-new commits, plus
this pass's own work, onto a branch off `main`** — where the trunk's measured
values survive untouched.

`claude/release-candidate` should now be treated as absorbed. It is retained,
not deleted, and `checkpoint/pre-productionization-20260908` still pins its
history.

---

## 3. Scope and method

The brief's instruction was to research first and not assume prior choices were
correct. Concretely, that meant re-checking the free-tier limits that the
existing architecture rests on, against the providers' own current documentation
rather than the numbers recorded when the decision was made, and being willing
to change the answer.

The answer changed in exactly one place — email — and that change requires no
code. Everything else was re-verified and kept. Section 6 states the
disqualifying fact for each alternative, so "we kept what we had" is a
conclusion with reasons rather than inertia.

Nothing in this report is marked verified unless it was executed. Where a claim
could not be tested from here, it says so and says why.

---

## 4. What the research changed, and what it did not

| Decision | Re-checked against | Outcome |
|---|---|---|
| Compute: Oracle Always Free Ampere A1 | Oracle's Always Free resource page | **Keep** — but the allowance was halved to 2 OCPU / 12 GB on 15 June 2026 with no announcement. Plan against 2/12, and re-read before provisioning. |
| Frontend hosting | Cloudflare Pages, Vercel, Netlify free tiers | **Keep Nginx on the VM.** See §8. |
| Edge / DNS / TLS | Cloudflare free plan | **Keep.** |
| Database | Supabase free plan | **Keep.** See §12. |
| Redis | Upstash free plan | **Keep**, with the ceiling named. See §13. |
| Vectors | Pinecone Starter | **Keep.** See §14. |
| Scheduling | QStash, Cloudflare Queues | **Reject both.** The process is always on; three DB-backed queues already claim atomically. Adding a queue is a downgrade. |
| Object storage / backups | Cloudflare R2 free | **Keep.** |
| Transactional email | Resend, Brevo, Mailgun, SendGrid | **Change: Brevo over SMTP.** See §15. |

---

## 5. The chosen architecture, and why it won

```
                         INTERNET
                            │
                      CLOUDFLARE (Free)
              DNS · TLS · CDN · WAF · DDoS · bot
                            │  proxied, Full (strict)
                            ▼
                ORACLE ALWAYS FREE VM ($0)
                 Ubuntu 24.04 · Ampere A1 ARM
                 ┌──────────┴──────────┐
              NGINX                EXPRESS (systemd)
        dist/ static bundle     API · workers · Socket.IO
                                ┌────────┼────────┐
                          SUPABASE   UPSTASH   PINECONE
                                │
                       nightly encrypted pg_dump → CLOUDFLARE R2
```

It wins for one structural reason, and one economic one.

**Structural.** The application is a stateful singleton: one process holding
eight interval workers, a Socket.IO server, an instance lock and in-process rate
limiters. That is not technical debt to be refactored away — it is the correct
shape for one always-on host, and every part of it works here unchanged. The
serverless alternative does not cost less; it costs four subsystems being
rewritten, each of which is currently correct.

**Economic, and easy to miss.** Supabase pauses a free project after 7 days of
inactivity. A school volunteering platform is seasonally quiet — a summer is
longer than seven days. Because this host holds a connection pool and answers a
health probe every minute, the project never goes idle. The always-on VM is not
just compatible with the free database tier; it is what keeps the free database
tier viable.

**The honest risk.** Oracle reclaims Always Free instances judged idle. The
criteria are **AND-ed** over a 7-day window — CPU p95 < 20%, network < 20%, and
(on A1) memory < 20% — so failing any single one protects the instance. Memory
is the reliable one: Node with OpenTelemetry, a `pg` pool, Socket.IO and `sharp`
loaded sits well above 20% of a 6 GB allocation, which is why the runbook
specifies **1 OCPU / 6 GB rather than 2 / 12**. This is the single largest
availability risk in the architecture and it is not fully eliminable. It is
survivable only because no state that matters lives on the VM — it is in
Supabase and R2.

---

## 6. Alternatives, and the fact that disqualified each

| Option | Disqualifying fact |
|---|---|
| **Vercel** for the application | The eight interval workers, the instance lock and Socket.IO all require a held process. Vercel functions do not hold one. Socket.IO is technically possible and economically not. |
| **Cloudflare Pages** for the frontend | Also free, and rejected on coupling rather than cost: it adds a second deploy target and a second place for the API origin and the CORS allowlist to drift, in exchange for edge caching that Cloudflare already provides in front of the VM. |
| **Cloudflare Workers** for the API | Same held-process problem, plus `sharp` and `pg`. |
| **Neon** instead of Supabase | No reason to migrate a working, provisioned database (§16 of the brief). Neon's free tier also scales to zero, which reintroduces the idle problem the VM was solving. |
| **QStash / Cloudflare Queues** | QStash free is 1,000 messages/day. A single event's reminder fan-out can exceed that. The DB-backed queues already claim atomically, retry, reclaim stale jobs and cost nothing. |
| **Fly.io / Render free tiers** | Both now sleep or bill for an always-on process; sleeping reintroduces the Supabase-pause problem. |

---

## 7. Cost table

Free-tier figures verified 2026-09-05 and spot-checked for this pass. Usage
assumes the stated pilot: ~300 students, ~30 organizers.

| Service | Plan | Cost | Free limit | Expected use | Headroom | Accidental billing? |
|---|---|---|---|---|---|---|
| Oracle Compute | Always Free | **$0** | 2 OCPU / 12 GB, 200 GB disk, 10 TB egress | 1 VM, ~20 GB, <50 GB egress | Very large | **Yes if the tenancy is Pay-As-You-Go** |
| Cloudflare | Free | **$0** | Unlimited DNS/CDN/DDoS; managed WAF; 10 firewall rules | 3 records, ~5 rules | Large | No |
| Supabase | Free | **$0** | 500 MB DB, 5 GB egress, 2 active projects | ~50 MB, <1 GB | Moderate | No — Free stops at the limit |
| Cloudflare R2 | Free | **$0** | 10 GB, 1M Class A, 10M Class B, no egress fee | ~2 GB, ~30 writes/mo | Very large | Only past 10 GB |
| Upstash Redis | Free | **$0** | 256 MB, **500K commands/month** | ~100K requests/mo at ~5 commands each | **Tight** | Yes, if pay-as-you-go is enabled |
| Pinecone | Starter | **$0** | 1 index, 2 GB, 2M write + 1M read units | Small | Large | No |
| Better Stack | Free | **$0** | 10 monitors, 10 heartbeats, 1 status page | 4 + 3 | Adequate | No |
| Amplitude | Free | **$0** | 2M events/mo, 10K MTU | Well under | Large | No |
| **Brevo** (email) | Free | **$0** | 9,000/mo, **300/day**, custom domain | See §15 | Adequate | No |
| **Total** | | **$0/month** | | | | |

**The one real billing exposure is Oracle.** An Always Free tenancy cannot be
charged. A Pay-As-You-Go tenancy keeps the same free allowances but *will* bill
beyond them — and people upgrade to PAYG specifically to avoid idle reclamation.
If you do, set a **$1 budget alert immediately.**

**The tight constraint that remains is Upstash's 500K commands/month.** Rate
limiting touches Redis on most API requests. It is a degradation rather than an
outage — the limiters fall back to per-process counters and the application keeps
working — but it should be watched.

---

## 8. Domain split, and where the frontend lives

Decided shape: `https://wevolunteers.org` is marketing; `https://app.wevolunteers.org`
is the application. Both sit behind Cloudflare; both resolve to the same VM;
Nginx serves the static bundle and proxies `/api`, `/socket.io`, `/uploads` and
the health endpoints to Express on 127.0.0.1.

Frontend cost is $0 because the bundle is static files, and serving them needs no
service the VM is not already running. Cloudflare caches the content-hashed
assets at the edge, so the origin serves each asset approximately once — ~2.5 MB
per cold visitor, ~0 for repeat visitors, under 50 GB/month at pilot scale
against a 10 TB allowance.

**The split has three consequences that are already handled in code**, and each
one is a security control rather than a preference:

1. **`wevolunteers.org` and `app.wevolunteers.org` are the same site.** `SameSite=Lax`
   therefore still attaches the session cookie to a POST from one to the other,
   which is precisely the CSRF case Lax does not cover. `server/csrfGuard.js`
   closes it using `Sec-Fetch-Site` — a browser-set forbidden header name that
   page script cannot forge — and refuses unsafe methods that arrive
   `same-site`/`cross-site` **with** a session cookie. It is mounted before the
   rate limiters, so a blocked CSRF attempt cannot become a denial of service
   against the account it failed to attack.
2. **The session cookie must stay host-scoped.** Verified: `cookieOptions()` in
   `server/config.js` sets no `domain` attribute at all, so the cookie is scoped
   to `app.wevolunteers.org` and is never sent to the marketing apex. Do not add
   `domain=.wevolunteers.org` — that would hand the session to every present and
   future sibling host.
3. **`/api` lives on the `app.` host, and three config files said otherwise.**
   Fixed in this pass: `APP_URL`, the `OAUTH_REDIRECT_URI` example and the mail
   webhook URL in `deploy/wevolunteer.env.example` all pointed at the apex or a
   placeholder domain. A webhook registered against `https://wevolunteers.org/api/...`
   would have 404'd against a marketing site.

---

## 9. DNS plan

Values in `<…>` come from a provider dashboard and **must not be invented**.

| Host | Type | Destination | Proxy | Purpose |
|---|---|---|---|---|
| `wevolunteers.org` | A | `<origin-vm-ipv4>` | **Proxied** | Marketing site |
| `www` | CNAME | `wevolunteers.org` | **Proxied** | Redirect to apex |
| `app` | A | `<origin-vm-ipv4>` | **Proxied** | Application; hides the origin IP |
| `app` | AAAA | `<origin-vm-ipv6>` | **Proxied** | Only if the origin truly has IPv6 |
| `status` | CNAME | `<betterstack-status-target>` | **DNS-only** | Must not depend on your infrastructure |
| `mail` | TXT | `v=spf1 include:<provider-spf> ~all` | DNS-only | SPF for the sending subdomain |
| `<selector>._domainkey.mail` | CNAME/TXT | `<provider-dkim-value>` | DNS-only | DKIM |
| `_dmarc` | TXT | `v=DMARC1; p=none; rua=mailto:dmarc@wevolunteers.org` | DNS-only | Start at `p=none` |
| `@` | TXT | `<domain-verification-tokens>` | DNS-only | As issued by each provider |
| — | DS | at the **registrar** | — | DNSSEC |

Two rules that cause real outages when broken:

1. **`status` must be DNS-only and off your infrastructure.** A status page that
   goes down with the thing it reports on is worse than not having one.
2. **Never proxy mail records.** Cloudflare's proxy is HTTP-only; proxying MX or
   TXT breaks mail silently.

During launch week set TTL to 300s on anything you might need to revert, then
raise it once stable.

---

## 10. Cloudflare configuration

| Setting | Value | Why it is not optional |
|---|---|---|
| SSL/TLS mode | **Full (strict)** | Flexible leaves Cloudflare→origin as plaintext HTTP. The session cookie is `Secure`, so it would cross that hop in clear. |
| Origin certificate | Cloudflare Origin CA, installed on the VM | What makes "strict" verifiable. |
| Origin firewall | 443 open **only to Cloudflare ranges** | Without it, `CF-Connecting-IP` is forgeable — and every per-IP rate limiter is keyed on it. |
| `real_ip` restoration | `/etc/nginx/cloudflare-real-ip.conf`, generated from `cloudflare.com/ips` | Without it every request appears to come from a Cloudflare address and every per-IP limiter collapses into one bucket for the entire internet. This is a security control, not a logging nicety. |
| DNSSEC | Enabled in Cloudflare, DS record at the registrar | |
| Caching, `/assets/*` | Immutable, long max-age | Vite content-hashes them; this is what holds origin egress at ~0. |
| Caching, `index.html` | `no-cache` | It names the current hashed bundles; a stale copy points browsers at assets that no longer exist. |
| Caching, `/api/*` | **Never** | §11. |
| WebSocket idle | Cloudflare free closes an idle proxied socket at ~100 s | The application's own ping interval must stay under that. |

---

## 11. Cache isolation — the one control this pass found missing

The brief requires that Cloudflare never serve one user's private API response
to another. Auditing that turned up a real gap, and the gap was not in the
Cloudflare configuration.

**What was true before this pass.** The property was carried by three separate
things agreeing:

- `deploy/nginx/wevolunteers.conf` added `no-store` at the reverse proxy;
- Cloudflare's free-plan default caches by file extension, and an extensionless
  `/api` path is not a candidate;
- two individual handlers (`certificateRoutes`, `privacyRoutes`) set the header
  by hand, each added after somebody found a specific leak.

All three are real. **None of them is the application's own guarantee.** The
Nginx file is deployment configuration and can be edited, replaced, or absent if
the app is ever fronted by something else. The Cloudflare default inverts the
moment anybody adds a "Cache Everything" rule — a one-click performance change
that silently becomes a cross-account data leak. And a per-handler header covers
the handlers somebody thought of.

**What this pass changed.** `server/app.js` now sets `Cache-Control: no-store` on
every `/api` request, mounted before the routers so it also covers responses that
never reach one — rate-limiter refusals, CSRF refusals, and the error handler.
Handlers that want something stricter still win, and `send`/`res.download` will
not overwrite a header that is already present, so the reasoning in
`privacyRoutes` continues to hold.

**Tested, on the wire** (`server/apiCacheIsolation.test.js`, 4 tests):

- two accounts request the same URL, receive different people, and both responses
  are `no-store` — this is the leak stated as the attack rather than as a header;
- an anonymous `/api` response is covered too;
- a 401 and a 404 carry it, proving the middleware really does precede the routers;
- the content-hashed bundle is **not** caught by it — asserted, because a blanket
  `no-store` across the whole app would be a performance regression disguised as
  a security fix, and immutable asset caching is what keeps origin egress inside
  the free tier.

**Mutation-tested**, because a check that cannot fail is not a check: with the
middleware neutered, 3 of the 4 fail. The one that still passes is the
scope guard, which is correct — it should pass either way.

**What was NOT tested, and cannot be from here.** No Cloudflare zone exists, so
the end-to-end assertion — request as user A through the real edge, then request
the same URL as user B and confirm A's body is not returned — has not been run.
It is listed in §21 as an owner-gated item. The origin-side guarantee is now
strong enough that the edge test should confirm rather than discover.

---

## 12. Database — Supabase, kept

Provisioned and verified on 2026-09-08 against the real project: 67 migrations
applied, schema compared field-by-field against a fresh local build (614 columns,
193 indexes, 226 constraints, 20 triggers — all identical). Re-checked read-only
for this report: the ledger still holds exactly the 67 migrations this branch
carries, and the database holds **3 users (2 of them owner/super_admin), 0 events
and 0 applications**.

Operational points that are easy to get wrong and are guarded in code:

- **Leave the database empty at creation.** The application builds its own schema
  on first boot via `completeDatabaseInit()`, idempotently.
- **Do not run `supabase/migrations/*_baseline_schema.sql`.** It is a historical
  artefact of the SQLite migration and disagrees with the application's schema on
  ~150 columns. `CREATE TABLE IF NOT EXISTS` cannot repair an existing table, so
  the wrong types survive and the platform fails — at best on
  `operator does not exist: boolean = integer`, at worst by crediting every
  attending volunteer **zero hours**, because `pg` returns `BOOLEAN` as JavaScript
  `true` while the hours ledger credits on `present === 1`.
  `assertSchemaSourceCompatible()` refuses to boot against such a database.
- **Use the Supavisor transaction pooler, not the direct host.** `db.<ref>.supabase.co`
  is IPv6-only; the pooler is IPv4-only. Named prepared statements are disabled
  specifically because a transaction-mode pooler may swap the backend under a client.
- **`DATABASE_SSL_CA` is pinned** to `deploy/certs/supabase-root-2021.crt`, and the
  path resolves against the repository root rather than the cwd — the same string
  otherwise means two different files under systemd and under `npm start --prefix server`.
- **Environment separation** is enforced by fingerprint (SHA-256 over
  `host:port/database`, credentials excluded, so rotating a password cannot
  silently disable the guard). Set `WEV_PRODUCTION_DB_FINGERPRINT` in every
  environment that is *not* production.

---

## 13. Redis — Upstash, kept, with the ceiling stated

Free tier: 256 MB, **500,000 commands/month**. Rate limiting touches Redis on most
API requests at roughly 5 commands each, so ~100K requests/month fits.

Redis here is **auxiliary and non-authoritative**. If it is exhausted or
unreachable the limiters degrade to per-process counters and the platform keeps
serving. That is why exhaustion is a degradation rather than an outage — and why
it was measured and rejected as a read cache: a warm Upstash round trip is
~222 ms, several hundred times the SQL queries it would have replaced.

---

## 14. Vectors — Pinecone Starter, kept

Used for semantic event discovery, under a hard invariant: **Pinecone returns
candidate ids only.** Every field a user sees is read from PostgreSQL, so a stale
or wrong vector index can change which events are *offered* but can never change
a row, an hour, or a permission.

Hardened in an earlier pass and unchanged here: a SHA-256-keyed candidate cache
with TTL/LRU and single-flight, and a circuit breaker that opens on outage codes
only, with a half-open probe. Both are incapable of altering data.

---

## 15. Email — the one decision that changed

This is where re-researching paid for itself. The prior recommendation was Resend
with the advice to "stagger onboarding". That was an operational workaround for
something that has a free technical fix.

Two facts settled it:

- **What actually happens at Resend's cap.** Sending **pauses**. It does not queue,
  and the free tier is not auto-upgraded or billed. So the failure mode is a
  password reset that never arrives, with no bill and no bounce to notice it by —
  on day one of a pilot, on the exact messages you cannot afford to lose.
- **A larger free tier exists and this codebase already speaks its protocol.**
  `server/email.js` prefers `RESEND_API_KEY` and otherwise falls back to
  `nodemailer` over `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS`.

All four candidates were re-checked against the providers' own pages on
2026-09-09 rather than taken from the earlier note.

| | Resend free | **Brevo free** | Mailgun free | SendGrid |
|---|---|---|---|---|
| Monthly | 3,000 | **9,000** | ~3,000 | — |
| **Daily** | **100** | **300** | **100** | — |
| Permanent? | yes | yes | yes | **no — 60-day trial** |
| At the cap | sending pauses | sending pauses | sending pauses | pauses at trial end |
| Custom domain, SPF/DKIM/DMARC | yes | yes | yes (1 domain) | n/a |
| Card required | no | no | no | n/a |
| Code change needed here | none (`RESEND_API_KEY`) | **none (`SMTP_*`)** | none (`SMTP_*`) | n/a |

**Recommendation: send through Brevo over SMTP** (`smtp-relay.brevo.com`, port 587).
Three times the daily headroom on the exact constraint that binds, for the same
$0, over a path the application already supports and tests.

The other two are disposed of on facts, not preference. **SendGrid is
disqualified**: Twilio converted the free plan into a 60-day trial effective
27 May 2025, after which sending is paused on all free accounts — it is not a $0
option any more. **Mailgun is permanent and genuinely free, but caps at the same
100/day as Resend**, so it does not move the constraint that binds. (An earlier
draft of this report said Mailgun was trial-only and card-gated. That was wrong,
and checking it is what caught it.)

**One caveat before relying on Brevo:** the 300/day is shared across marketing
*and* transactional sending on the same account. This application sends
everything through one path, so all 300 are available to it — but a Brevo
marketing campaign run from the same account later would eat the budget that
password resets draw on.

Keep Resend configured instead if its API and dashboard are preferred — but then
plan onboarding around 100/day, because the cap is a pause, not a queue.

---

## 16. OAuth configuration

`/oauth/callback` is an SPA route served by the application origin. Under the
domain split the redirect URI is therefore:

```
https://app.wevolunteers.org/oauth/callback
```

This must be registered **exactly** — scheme, host, port, path — in the Google
Cloud console and, if Microsoft sign-in is enabled, in the Entra App Registration
as a "Web" redirect URI. The delegated scopes needed are `openid`, `profile` and
`email`; `User.Read` is deliberately not required, because the identity comes
from the ID token rather than a Graph lookup.

Two guards already in code, both from real incidents:

- With client credentials set, the server **refuses to start** unless
  `OAUTH_REDIRECT_URI` names this deployment. Its built-in default is the
  development value `http://localhost:5173/oauth/callback`, and shipping that
  sends every user who presses "Continue with Google" to their own machine — and,
  if localhost is still registered on the OAuth client, delivers a live
  authorization code there over plain HTTP.
- `getAuthUrl` refuses to mint a URL with an empty client id, so a missing
  credential is a visible error rather than a "Continue with Google" button that
  fails at the provider.

This pass corrected the deployment template, which still showed a placeholder
domain. **Registering the URI in the Google console remains an owner action.**

---

## 17. Dependency security

`npm audit --omit=dev` against `main` reported **three high-severity advisories**,
all on code paths this platform actually exercises:

| Package | Advisories | Why it matters here |
|---|---|---|
| `multer` ≤2.2.0 | 4 — DoS via crafted multipart field names, file-descriptor leak on aborted uploads, file-size-limit bypass via an async `fileFilter` race, DoS via oversized array index | This is the code path that receives **every uploaded file**. |
| `sharp` <0.35.4 | libheif (GHSA-g89c-p67h-r497, GHSA-2jg2-4ch7-h545) | This is the code path that **decodes every uploaded image**, on a platform whose users are minors. |
| `nodemailer` ≤9.1.0 | 4 — IDN/punycode and RFC 5322 comment mis-parsing allow **delivery to an attacker-controlled domain**; `resolveContent()` bypasses `disableFileAccess`/`disableUrlAccess`; quadratic addressparser DoS | Password-reset and verification mail. |

All three were already permitted by the declared ranges (`^2.2.0`, `^0.35.3`,
`^9.0.3`), so the fix is a lockfile refresh with **no manifest change**.

Updated with a targeted `npm update multer sharp nodemailer` rather than
`npm audit fix`, because regenerating this lockfile wholesale destroys the
cross-platform entries — and the deployment target is ARM64, so losing them
breaks the build on the box rather than on any machine we develop on. Verified
after: **119 arm64 entries, unchanged**; `package.json` and `server/package.json`
untouched; `npm audit --omit=dev` reports **0 vulnerabilities**.

`vitest` was also updated 4.1.10 → 4.1.11 for a moderate development-only advisory.

**Three moderate advisories remain, and are deliberately not fixed:** `uuid` via
`hyperid` via `autocannon`, the load-testing tool. They are development-only —
`--omit=dev` is clean — and the only offered remedy is a **major downgrade** of
autocannon to 2.0.1. Downgrading a dev tool by six majors to silence a transitive
advisory that never ships is a worse trade than recording it.

`multer` moved 2.2.0 → **2.3.0**, a minor rather than a patch. That is the one
behavioural risk in this change, and it is on the upload path; the full test
matrix in §19 is what covers it.

---

## 18. Git reconciliation

Because this repository has previously lost work to worktree and branch deletion,
git integrity is treated as a production requirement rather than housekeeping.

| Ref | State |
|---|---|
| `origin/main` | trunk; contains the release candidate via `40957a5` and perf-scaling via `6f4ae1f` |
| `main` (local) | `origin/main` + 2 commits (two test fixes carried across from the RC). **Not pushed.** |
| `claude/release-candidate` | absorbed into `main`; 2 genuinely-new commits ported in this pass |
| `claude/wevolunteer-production-architecture-89e97f` | fully contained in the RC and therefore in `main` |
| `claude/owner-center-certificate-upgrade-7eef59` | fully contained |
| `claude/wevolunteer-perf-scaling-ad3613` | 49 commits not in the RC — but merged into `main` via `6f4ae1f`; the branch tip has since diverged |
| `claude/trunk-security-port` | this pass's work, branched from `main` at `2446aaf` |

28 tags exist, including `checkpoint/main-20260908` and
`checkpoint/pre-productionization-20260908`. Nothing has been pushed, nothing
deleted, and no history rewritten in this pass.

**One thing the owner should know:** the perf-scaling branch was merged into
`main` before this freeze, notwithstanding the earlier decision that it should
not be. That merge is on `origin/main` and is therefore already published. This
report does not attempt to undo it — the measured pool-size change discussed in
§2 is one of the things it brought, and reverting it would be a regression — but
it is recorded here because a decision that was quietly overtaken should not stay
quiet.

---

## 19. Verification performed


Everything below was executed on `claude/trunk-security-port`. Nothing here is
inferred.

### Test matrix — zero failures

| Suite | Result |
|---|---|
| Lint (`oxlint`) | clean |
| Build (`vite`) | ✓ built in 479 ms |
| **SQLite suite** | **621 files passed, 5 skipped; 10,458 tests passed, 45 skipped, 0 failed** |
| **PostgreSQL suite** | **394 files passed, 3 skipped; 6,811 tests passed, 53 skipped, 0 failed** |
| `npm audit --omit=dev` | **0 vulnerabilities** |
| `npm run scan:bundle` | 163 files scanned, **CLEAN** (`VITE_AMPLITUDE_API_KEY` public by design) |

### Live service verification — real Supabase, not a fixture

`bin/supabase-check.mjs`, read-only, against the production project:

```
host:     aws-0-us-east-2.pooler.supabase.com:5432  (Supavisor, session mode)
 ok   password survives URI decoding      what is written is what is sent
 ok   DNS resolves                        3 IPv4, 0 IPv6
 ok   reachable from an IPv4-only host
 ok   TCP connect                         47–64 ms (median 61)
 ok   TLS verifies against the pinned CA  certificate and hostname accepted
 ok   the pin is load-bearing             the system CA store REJECTS it
 ok   authenticates                       363 ms to an open session
 ok   server version                      PostgreSQL 17.6
 ok   extensions installed                pg_trgm, pgcrypto, pg_stat_statements, …
 ok   server limits                       max_connections=60, statement_timeout=2min
 ok   no named prepared statements survive
 ok   query round trip                    44–76 ms (median 58)
Every check passed.
```

"The pin is load-bearing" matters more than it reads: the system CA store rejects
this certificate, so `DATABASE_SSL_CA` is not belt-and-braces — remove it and the
connection stops verifying, or stops working.

### Migration ledger — checked before booting, not after

Read-only comparison of the production `schema_migrations` table against this
branch's migration files:

```
ledger rows:                        67
migration files on this branch:     67
would be APPLIED on boot:           none
in ledger but not on this branch:   none
rows — users: 3 | events: 0 | applications: 0 | owner/super_admin: 2
```

This was run **first**, deliberately. It is what made the production boot below a
safe thing to do rather than a hopeful one: with the ledger and the branch in
exact agreement, `completeDatabaseInit()` had nothing to apply.

### Production boot — the documented command, against the real database

`node --import ./server/observability/register.mjs server/server.js`, with
`NODE_ENV=production` and the production `DATABASE_URL`.

**Two guards refused the boot before it succeeded, and both were right:**

1. `OAUTH_REDIRECT_URI` still pointed at `http://localhost:5173/oauth/callback` —
   the development default. The server refused to start and explained that
   shipping it sends every user who presses "Continue with Google" to their own
   machine.
2. `TRUST_PROXY` was unset. The server refused and explained that without it
   Express reads the proxy's address as the client's, and every per-IP limiter —
   sign-in, mail, export, re-auth — shares one bucket for the whole site.

With the intended production values supplied, it booted:

```
[db] using postgres aws-0-us-east-2.pooler.supabase.com:5432/postgres
[db] postgres: schema applied
[legal] 13 published documents verified against their pinned hashes.
[Worker] Notification outbox processor started.
[AutoSelect] Scheduler started — every 15 min, 24h grace period after the deadline.
[realtime] no adapter — Socket.IO rooms are per-process, correct for one instance
WeVolunteer API Server listening on 127.0.0.1:5050
[telemetry] Better Stack enabled.
[otel] Traces and metrics enabled (sampling 0.02, budget 200000 spans/day).
[search] Pinecone enabled (index wevolunteer-discover-v1)
```

| Probe | Result |
|---|---|
| `GET /live` | `200 {"status":"ok","version":"1.2.0"}` |
| `GET /ready` | `200 {"status":"ok","database":"connected","writable":true,"dependenciesNonGating":{"redis":{"configured":true,"reason":"ok"},"pinecone":{"configured":true}}}` |
| `GET /health` | `200 {"status":"ok","database":"connected","writable":true}` |
| `GET /api/auth/check-email` (200) | `Cache-Control: no-store` |
| `GET /api/auth/me` (401) | `Cache-Control: no-store` |
| `GET /` (index.html) | `Cache-Control: no-cache` — correctly **not** `no-store` |
| `SIGTERM` | drained in-flight requests, stopped both workers, closed the database, **exit 0 after 3 s** |

The cache-control rows are the §11 control observed on a real production boot
rather than only in a test harness.

**One production-configuration note from the boot log:** Pinecone came up on
namespace `development`, because that is what the local environment file carries.
The production environment file must set `PINECONE_NAMESPACE` to the production
namespace, or discovery will search the wrong index partition. This is a
configuration item for §21 item 7, not a code defect.

### Not verified, and why

| Claim | Status |
|---|---|
| Cloudflare edge does not serve user A's `/api` response to user B | **Not tested.** No zone exists. Origin-side guarantee is now asserted and tested; the edge test remains owner-gated. |
| `nginx -t` on the real configuration | **Not run.** Nginx is not installed here. Must be run before any reload. |
| Oracle idle reclamation | **Not observable.** Needs a running instance over 7 days. |
| Live R2 upload | **Not run.** No credentials. Proven against a local S3-compatible endpoint and AWS's published SigV4 vector. |
| Restore drill against real production data | **Not meaningful yet.** The production database holds 0 events and 0 applications. |
| A real transactional email through Brevo | **Not sent.** No account. |

---

## 20. What this pass changed

| File | Change |
|---|---|
| `server/app.js` | `Cache-Control: no-store` on every `/api` response, before the routers |
| `server/apiCacheIsolation.test.js` | **new** — 4 tests, mutation-tested |
| `package-lock.json` | `multer` 2.2.0→2.3.0, `sharp` 0.35.3→0.35.4, `nodemailer` 9.0.3→9.1.1, `vitest` 4.1.10→4.1.11. Manifests untouched; 119 arm64 entries preserved |
| `deploy/wevolunteer.env.example` | `APP_URL`, `OAUTH_REDIRECT_URI` and the mail webhook now name `app.wevolunteers.org` instead of the apex or a placeholder domain |
| `deploy/nginx/wevolunteers.conf` | Comment records that the origin now asserts `no-store` itself, and why the proxy rule stays anyway |
| `docs/operations/oracle-zero-cost-deployment.md` | Email provider decision carried through the checklist and DNS table; cache-isolation control documented; a duplicated row removed |
| `.env.example` | Brevo SMTP recommendation beside `SMTP_HOST` |
| `CHANGELOG.md` | Security entries for both changes |
| `docs/audits/2026-09-09-…md` | This report |

Email research was re-run against all four candidate providers' own pages
(§15) and the deployment document's comparison table extended from two to four.

Nothing was pushed. Nothing was deleted. No test was weakened or skipped.

---

## 21. Remaining work

### Owner action required — I cannot do these, and will not fabricate them

| # | Item | Why it is yours |
|---|---|---|
| 1 | **Create the Oracle tenancy and the Ampere A1 VM** (1 OCPU / 6 GB) | Account creation. If it becomes Pay-As-You-Go, set a **$1 budget alert** the same day. |
| 2 | **Add the Cloudflare zone, move nameservers, enable DNSSEC** | No Cloudflare credentials exist in this session. |
| 3 | **Create the DNS records in §9** | Every destination is `<origin-vm-ipv4>` or a provider-issued value. **There is no origin to point at yet** — this is blocked on item 1, not on willingness. |
| 4 | **Set SSL/TLS to Full (strict)** and install the Origin CA certificate | Dashboard + host action. Never Flexible: it carries the `Secure` session cookie over plaintext. |
| 5 | **Register `https://app.wevolunteers.org/oauth/callback`** in the Google Cloud console (and Entra, if used) | Google console access. |
| 6 | **Create the Brevo account and verify `mail.wevolunteers.org`** (SPF/DKIM/DMARC) | Account creation + DNS. |
| 7 | **Write `/etc/wevolunteer/wevolunteer.env`** (0600, owned by the service user) | Holds every secret. Never a repo-adjacent `.env` — that file reaches the test suite and every privileged `bin/` script. |
| 8 | **Generate the backup keypair off the server**; upload only the certificate | A backup you cannot decrypt is not a backup, and the host must not hold the private key. |
| 9 | **Set owner passwords through the normal reset flow** | Both owner accounts exist in the production database. Passwords are set by the humans who own them, not seeded. |
| 10 | **Run `nginx -t` before reloading**, and **reboot the VM once** | The first catches a config typo before it takes the site down; the second is the only proof systemd actually brings the service back. |
| 11 | **Run the restore drill against the real production backup** | This is the launch gate. A backup that has never been restored is a hypothesis. |

### I can complete these once the owner actions above unblock them

| Item | Blocked on |
|---|---|
| Cloudflare cache-isolation test end-to-end through the real edge (§11) | items 2–4 |
| Production smoke test: student / organizer / admin / owner workflows through the real UI | items 1–4 |
| Socket.IO verified through the Cloudflare proxy (the ~100 s idle close) | items 2–4 |
| A real transactional email, checked into the inbox and the spam folder | item 6 |
| First live R2 upload and the object confirmed in the bucket | R2 credentials |
| `node bin/db-fingerprint.mjs` on production, then setting `WEV_PRODUCTION_DB_FINGERPRINT` everywhere else | item 7 |
| `node server/verifyHours.js` against production | item 1 |
| Better Stack monitors pointed at the live domain | item 3 |

### External limitations — nobody can close these here

| Item | Why |
|---|---|
| Oracle idle-reclamation behaviour over a 7-day window | Needs a running instance and seven days. Mitigated, not eliminated. |
| Deliverability of a brand-new sending subdomain | A new domain lands in spam first regardless of configuration. Warm it. |
| Cloudflare free-plan WebSocket idle timeout (~100 s) | Provider behaviour; the application's ping already sits under it. |
| The three moderate `autocannon`→`hyperid`→`uuid` advisories | Dev-only; the only offered fix is a six-major downgrade of the load-test tool (§17). |
| Restore drill against *real production data* | The production database holds 0 application rows. A drill against it would prove nothing the local drill did not. It becomes meaningful after the pilot has data. |

---

## Closing

The repository is in good shape and this pass improved it in two specific ways —
a cross-account cache leak that was one Cloudflare click away from being real, and
three high-severity advisories sitting on the upload and mail paths of a platform
whose users are minors. Both are fixed, tested, and on a branch that
fast-forwards onto the trunk.

The verdict is **NOT READY TO MERGE** in the sense the brief asks about —
production readiness — and it stays there until items 1–11 above are done, because
every one of them is a thing only an account holder can do. It is not a code
verdict. If the question is narrower — "should `claude/trunk-security-port` land
on `main`?" — the answer is yes, and the evidence is §19.

One correction to carry forward: the brief's premise that
`claude/release-candidate` is the current release candidate was already false when
this pass started. The trunk is `main`. Working from the wrong branch for another
pass would have quietly reverted measured performance work, and that is the kind
of mistake that only shows up in production.
