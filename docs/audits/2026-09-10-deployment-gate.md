# WeVolunteer — Deployment Gate

**Date:** 2026-09-10
**Commit:** `a14688d` (local == `origin/main`)
**Verdict:** READY — HUMAN OPERATIONAL ACTION REQUIRED

---

## 1. What this pass was asked to do, and what it could actually do

The task was to take the repository through production deployment and verify it
end to end. **No deployment happened, because there is no host.** There is no
Oracle tenancy, no VM, no domain pointed anywhere, and no R2 bucket. Creating
those needs an account, a payment-method decision and DNS control, none of which
this session has.

So this pass did the part that was possible, and it turned out to be more than
"prepare instructions":

- **Re-verified the release baseline.** No regression.
- **Fixed the `pilot.db` foot-gun** — the one substantive engineering item on the
  list. It was real, and worse than the previous report described.
- **Closed the pooler gate.** Two reports called it blocked on provider access.
  It was not. Eight tests, now run against a real transaction-mode pooler.
- **Corrected the deployment plan** on the one point that is permanent and
  irreversible if you get it wrong at signup.
- **Fixed two test defects** surfaced as fallout.

Everything genuinely blocked is in §6, with exact instructions.

---

## 2. Repository state — measured, not assumed

The state named in the task brief was already out of date, so this was
established from scratch first.

The brief said `main` was `7bd462c`, clean, one branch, one worktree. Reality on
arrival: `origin/main` was indeed `7bd462c`, but **local `main` was 7 commits
ahead and unpushed**, with **5 local branches and 3 worktrees** — two of them
checked out and in use by concurrent sessions.

Those 7 commits are legitimate work from another session: patched `sharp`,
`nodemailer` and `multer`, a timezone-dependent share-link test fix, a
week-simulation test, and release documentation. Two of those documents matter
enough to restate here, because they govern what may be deployed:

- **`main` is the release.** The branch called `claude/release-candidate` is
  **not** — merging it *deletes* 45 files of perf-scaling work (scheduler leases,
  migrations 065–067, the Redis volume limiter, the Socket.IO adapter seam).
- **`claude/trunk-security-port` holds unmerged security work** — `Cache-Control:
  no-store` set by `server/app.js` on every `/api` response. Deliberately not
  taken: `deploy/nginx/wevolunteers.conf` already sets `no-store` with `always`
  on `location /api/`, and that file ships in this release. It should be merged
  on its own terms afterwards.

**Nothing was deleted.** No branch, no worktree — two are another session's live
workspaces, and the previous "single branch" goal is superseded by the fact that
concurrent sessions are active.

Final state:

```
branch          : main
HEAD            : a14688d
LOCAL  SHA      : a14688d9972f699de348b8f5e7efd68425ff6c9a
REMOTE SHA      : a14688d9972f699de348b8f5e7efd68425ff6c9a
MATCH           : YES
working tree    : 0 changes (0 untracked, -uall)
local branches  : 5   (4 are concurrent sessions' — deliberately left)
worktrees       : 3   (2 in active use — deliberately left)
```

Three pushes, all fast-forward. No force-push, no history rewrite, no AI
attribution trailer added.

---

## 3. Verification — exact numbers on `a14688d`

```
npm test (SQLite)          10,327 passed ·  176 skipped · 0 failed
npm test (PostgreSQL 17.9) 10,470 passed ·   33 skipped · 0 failed
npm run test:postgres       6,823 passed ·   41 skipped · 0 failed
pooler.behaviour                8 passed ·    0 skipped · 0 failed   ← newly closed
npm run lint               clean
npm run build              green (664 ms)
npm run a11y               64 passed · 0 failed
npm audit --omit=dev       0 vulnerabilities
npm audit (incl. dev)      3 moderate — dev-only (uuid < 11.1.1)
npm ci                     567 packages, clean
bin/scan-bundle-secrets    CLEAN
lifecycle smoke            31/31
```

The SQLite count rose from 10,293 to 10,327: the week-simulation test plus the
four new guard cases below. No test was skipped, weakened or deleted.

---

## 4. The `pilot.db` foot-gun — fixed, and it was worse than reported

`pilot.db` at the repository root holds the real pilot's records — 18 users,
5 events, and per the schema-source guard: two owner accounts, two
deleted-account tombstones, eighteen administrative audit records.

`.env` carried `WEV_DB_PATH=../pilot.db`. Both the server and
`bin/resolveDb.mjs` read that file, and `bin/` scripts anchor a relative path at
`server/` — so those six characters named the live database. **Live data was the
default target of every privileged command**: grant ownership, revoke ownership,
promote an administrator, suspend an account, clear a second factor.

Each was protected only by whatever guard it had thought to add for itself. Two
had a typed confirmation. `seed-qa-profile.mjs` had a blocklist of file *names*.
Three had nothing.

**Fixed at the cause and with a backstop.**

1. **`.env` no longer sets `WEV_DB_PATH`.** Unset, the server and the resolver
   both fall back to `server/wevolunteer.db`, which is disposable. The absence
   of configuration is now the safe state instead of the dangerous one. Safe to
   change because nothing serves `pilot.db` (untouched since 2026-08-30) and
   production is PostgreSQL. A copy of the previous `.env` is in `$HOME`.
2. **`bin/resolveDb.mjs` fails closed on real data it was not pointed at.** If
   the resolved SQLite file carries markers a fresh demo seed cannot produce and
   the path arrived from `.env` or the built-in default rather than from this
   invocation, the command refuses and names what it found.

**Provenance, not the filename.** A name blocklist answers "is this called
`pilot.db`", and a copy defeats it. The question worth asking is whether anybody
*chose* the file. An operator who types the path has chosen it — and that is the
emergency path this tooling exists to keep working, because `bin/reset-2fa.mjs`
is the only way to clear a locked-out administrator's second factor. A guard
that refused it would be the outage. `WEV_ALLOW_REAL_DATA=1` covers a runbook
step that cannot pass a path, and is deliberately *not*
`WEV_ALLOW_DESTROYING_REAL_DATA` — operating on live data and destroying it are
different decisions.

Four cases in `server/tooling.privilegedDbPath.test.js`: refusal when inherited,
passage when named, passage under the override, silence for a disposable
database that arrived the same way. **Verified to fail on the first when the
guard is removed.** Safe procedure documented in
`docs/operations/pilot-deployment-runbook.md`.

**Legitimate operations re-verified after the change:** a privileged CLI against
an explicitly named database (works), `bin/backup.sh` (works — 72 tables,
invariants recorded, 48 K archive, correct unencrypted-backup warning), and
`bin/verify-restore.sh` (restore rehearsal passed, booted an instance, healthy
`/health`, live database never touched).

### Two test defects this surfaced

- The case proving `.env` is parsed with no `--env-file` flag asserted the
  resolved path was *not* the fallback — using the developer's own `.env` as its
  fixture. The hazardous default *was* the fixture, so removing it broke the
  test. Rewritten against a temp copy with a `.env` the test writes: same
  property, stated positively, immune to local configuration.
- The new fixture's synthetic schema contained `INSERT INTO admin_audit_logs`,
  which `auditLog.test.js` correctly refuses anywhere in `server/` or `bin/`. It
  now seeds two markers instead of three. Neither an allowlist entry nor
  assembling the string dynamically was worth weakening that guard for.

---

## 5. The pooler gate — closed, and it was never blocked

Two release reports listed `server/pooler.behaviour.test.js` as an outstanding
human action needing a real Supavisor endpoint. Re-reading the suite's own
header is what showed that to be wrong: **the thing under test is transaction
pooling as a protocol behaviour**, not one vendor's build of it — and its own
example points at a local pgbouncer.

Run against **pgbouncer 1.25.2, `pool_mode = transaction`, in front of
PostgreSQL 17.9: 8 passed.** Ordinary statements; connection reuse without
pinning; no named prepared statements left behind; a transaction held on one
backend start to finish; concurrent transactions serialised on the same row; a
rolled-back transaction leaving nothing; pool recovery after a failed statement;
more concurrent work than the pool has clients.

Confirmed to be evidence rather than the absence of it: without
`TEST_POOLER_URL` the same eight report as **skipped**, and pgbouncer's own log
shows the client connections being opened and returned. Reproduction in
`docs/operations/horizontal-scaling.md`. Cost: $0, no provider.

**Still open, and far narrower than the reports claimed:** Supavisor's own
implementation and Supabase's network path.

**A live deviation found on the way.** The production `DATABASE_URL` points at
the Supavisor host on port **5432 — session mode**, not the **6543** transaction
mode `deploy/wevolunteer.env.example` recommends. Session mode is the *safer* of
the two here (`LISTEN`/`NOTIFY` needs it, and the realtime adapter depends on
that) but it holds a server connection per client and spends the free tier's
connection budget much faster. Worth making deliberate rather than inherited.

---

## 6. HUMAN ACTION REQUIRED

Four items. Everything else that could be done without you has been done.

### 6.1 Rotate the production database credentials — LAUNCH GATE

Still outstanding. Confirmed the repository side is clean: `.env` has **never**
been committed in any ref, 400 revisions contain zero Supabase project refs and
zero JWTs, and `DATABASE_URL`/`DATABASE_ENGINE` are absent from `.env` (they
live only in the gitignored `.env.operator`). The Supabase project **does
exist** — its pooler host resolves in DNS.

**Removal is not rotation**, and production migrations were once applied by a
test run under these credentials, so they must be replaced.

1. Go to **supabase.com → your project → Settings → Database**.
2. Under **Database password**, choose **Reset database password**. Copy the new
   one straight into your password manager — it is shown once.
3. Update `DATABASE_URL` in **`.env.operator` only**. Never `.env`, never a
   tracked file, never chat.
4. Verify the old one fails and the new one works:
   ```bash
   # New — expect: 1
   psql "$NEW_URL" -tAc 'select 1'
   # Old — expect: password authentication failed
   psql "$OLD_URL" -tAc 'select 1'
   ```
5. Tell me only **"rotated"** — never the value. I will then re-run the
   privileged-CLI suites and the production-database fingerprint guard against
   the new endpoint.

**Do not paste either credential anywhere in this conversation.**

### 6.2 Create the Oracle tenancy — read this before you click

**The home region is permanent.** Oracle's own documentation: *"Can I change my
home region? No. Oracle assigns your home region and you can't change it."* And
*"You must create the Always Free compute instances in your home region."*

Those two sentences are the whole risk. Ampere A1 is the only free shape this
application fits on — 1 GB on the AMD micro is not enough once `sharp` is
decoding images — and A1 capacity is exhausted in the popular regions. A tenancy
created in a contended region can be left **permanently unable to provision the
host**, with no remedy inside that account.

At signup:

1. **Prefer a region with three availability domains.** "Try a different
   availability domain" is Oracle's own first suggestion for the capacity error,
   and it only helps if the region has more than one.
2. **Weigh contention against latency.** Frankfurt and Singapore are reported to
   provision reliably; US East is under sustained pressure. For a Santa Barbara
   pilot a US region is far better placed — this is a real trade-off, not a
   lookup.
3. **Then** provision Ampere A1, Ubuntu 24.04, **1 OCPU / 6 GB** (not 2/12 — see
   the idle-reclamation section: the same workload is a larger fraction of a
   smaller memory ceiling, which is what protects the instance).
4. If the account is Pay-As-You-Go, **set a $1 budget alert** before anything
   else.

The full step-by-step — firewall, SSH, Node, nginx, TLS, systemd, migrations,
DNS — is `docs/operations/oracle-zero-cost-deployment.md`, which is current and
was re-verified against Oracle's documentation today. Give me SSH access when
the VM is up and I will execute the deployment checklist against it.

### 6.3 Cloudflare R2 — create the bucket and credentials

Needed to convert the proven upload *integration* into a real provider drill.

1. **Cloudflare dashboard → R2 → Create bucket.** Name it `wevolunteer-backups`.
   Location: automatic. **Do not enable public access.**
2. **R2 → Manage API Tokens → Create API Token.** Permissions: **Object
   Read & Write**, scoped to that one bucket. Not account-wide.
3. Put these four in **`.env.operator`** (not `.env`):
   `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
   `R2_BUCKET=wevolunteer-backups`.
4. Generate the backup keypair — **the private key must never go into R2**:
   ```bash
   openssl req -x509 -newkey rsa:4096 -keyout backup-key.pem \
     -out backup-cert.pem -days 3650 -nodes -subj "/CN=wevolunteer-backup"
   chmod 600 backup-key.pem
   ```
   `WEV_BACKUP_PUBKEY=backup-cert.pem` on the host;
   `WEV_BACKUP_TESTKEY=backup-key.pem` kept **off** the host, in your password
   manager. (The runbook said `age`; it is OpenSSL CMS and wants an X.509
   certificate — corrected on 2026-09-06.)
5. Tell me **"R2 configured"**. I will then run backup → encrypt → upload →
   retrieve → decrypt → restore against the real bucket and verify byte identity
   and row counts.

### 6.4 Merge `claude/trunk-security-port` after launch

Four commits, one of them a genuine security improvement (`Cache-Control:
no-store` from the application rather than only the proxy). Not urgent — the
shipped nginx config already sets it — and should be merged on its own terms
rather than cherry-picked.

---

## 7. Deployment checklist status

Everything below `Repository` is honestly unreachable until §6.2 gives us a host.

| Gate | Status |
|---|---|
| Repository clean · `main` synchronized · release commit identified | **PASS** |
| SQLite / PostgreSQL / `test:postgres` suites | **PASS** |
| Pooler tests | **PASS** (8/8, local transaction pooler) |
| Lint · build · accessibility · prod audit · secret scan · lifecycle smoke | **PASS** |
| `pilot.db` foot-gun resolved | **PASS** |
| Production DB credentials rotated · old invalid · new verified | **BLOCKED — §6.1** |
| R2 configured · real R2 drill · production backup verified | **BLOCKED — §6.3** |
| Host created / hardened / HTTPS / domain / Cloudflare | **BLOCKED — §6.2** |
| Backend persistent · automatic restart · production env verified | **BLOCKED — no host** |
| Production URL reachable | **BLOCKED — no host** |
| Anonymous / student / organizer / pending-organizer / admin / owner production smoke | **BLOCKED — no host** |
| Welly · notifications · hours · certificates in production | **BLOCKED — no host** |
| Production mobile + accessibility check | **BLOCKED — no host** |
| Production performance · error handling | **BLOCKED — no host** |
| Monitoring receives a real event | **BLOCKED — no host** |
| Rollback procedure documented | **PASS** (§8) |
| Deployed SHA == verified SHA | **N/A — nothing deployed** |

Every workflow in the "no host" rows *was* verified against a disposable local
instance (31/31 lifecycle smoke, 64 accessibility cases, 10,470 PostgreSQL
tests). That is not the same claim as verifying production, and is not reported
as one.

---

## 8. Rollback procedure

| Situation | Action |
|---|---|
| Verified commit | `a14688d` — `git rev-parse origin/main` to confirm |
| Redeploy it | `git fetch && git checkout a14688d && npm ci && npm run build`, then restart the service |
| Restart backend | `sudo systemctl restart wevolunteer` |
| Revert application code | `git revert <sha>` — **never** force-push; the remote is shared with concurrent sessions |
| Failed migration | `docs/operations/postgres-cutover-and-rollback.md` |
| Restore the database | `bin/verify-restore-postgres.sh <archive>` into a scratch database first, always; promote only after its counts match the manifest |
| Restore from R2 | download the object, then the same script — proven end to end against a local S3-compatible endpoint, **not yet against R2** (§6.3) |
| Rotate secrets | §6.1; `.env.operator` only |
| Recover host access | Oracle console → Cloud Shell → instance serial console. **Confirm this works before you tighten SSH**, not after |
| Recover this session's `.env` | copy in `$HOME/.wevolunteer-env-backup-*` |
| Undo the local branch cleanup | nothing was deleted; `backup/pre-coauthor-strip-2026-09-06` → `5bfb17e` still exists |

---

## 9. Known non-blocking issues

- **3 moderate dev-only vulnerabilities** (`uuid` < 11.1.1). `npm audit
  --omit=dev` is 0 — none ship.
- **Filtered browse at 10,000 events**: 90–180 ms p50, still scans `slots`. No
  candidate rewrite is uniformly faster across fourteen cases. Single-digit
  milliseconds at pilot scale.
- **Session-mode pooler** (§5) — safer, but spends connections faster.
- **Two attribution trailers** in squash-merges already on GitHub (PRs #7, #8).
  Removing them needs a force-push; not done.
- **Idle reclamation** is the largest availability risk in the $0 architecture
  and is not fully eliminable. Survivable because no state that matters lives on
  the VM — it is in Supabase and R2.
- **`wev_audit`, `wev_audit_test`, `wev_release_check`** local PostgreSQL
  databases predate this session and were left alone.

---

## 10. Verdict

```
RELEASE STATUS: READY — HUMAN OPERATIONAL ACTION REQUIRED
```

The codebase is release-ready and the repository is consistent and synchronized.
Nothing is deployed, and nothing about a deployment has been verified, because
no host exists — that is §6.2 and it needs your account.

Two observations worth keeping.

The `pilot.db` hazard had been described in three previous reports as a
"foot-gun" and left in place. It was not a foot-gun; it was live data configured
as the default target of six privileged commands, and the reason it never fired
is that nobody happened to run the wrong one. Naming a risk is not the same as
closing it.

And the pooler gate had been recorded as blocked on provider access twice. It
took twenty minutes and a locally-installed pgbouncer. It is worth being
suspicious of any item whose blocker is described in terms of *who* is needed
rather than *what* is needed — the second framing is checkable, and this one did
not survive the check.
