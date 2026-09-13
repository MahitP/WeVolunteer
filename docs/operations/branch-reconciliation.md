# Branch reconciliation

**Originally written:** 2026-09-06, for `claude/release-candidate`
**Superseded:** 2026-09-06 — the work of every branch below reached `main`.
**Corrected and closed:** 2026-09-09 at the release freeze.
**Completed:** 2026-09-13 — the last branch holding unmerged work was carried to
`main`. See the first section; that is the current record. The 2026-09-09
section follows it; the 2026-09-06 header claimed the branches had been *deleted* and that
`main` was the only ref, and that is not true of this clone.

---

## 2026-09-13 — branch completion pass

**Base:** `main` at `abfa9df` (three commits ahead of `origin/main` at `6b1c1d6`,
unpushed). Production was live and was not touched: no deploy, no restart, no
database, DNS, Cloudflare, OCI or firewall change.

Every ref was compared by **patch-id and by file-by-file content**, not by name
or commit graph, because this repository's histories were rewritten and
identical work carries different hashes on each side.

### What was found

| Ref | Unique by patch-id | Disposition |
|---|---|---|
| `claude/trunk-security-port` | 4 | **Carried to `main`** — see below. The only ref holding work `main` did not have. |
| `claude/release-candidate` | 5 | **Superseded.** All five verified present on `main` by content: the share-link timezone assertion and `TZ=America/New_York` in CI, `insertionTiebreak` in the roster-export audit test, the cwd/ROOT CA resolution in `engine.js`, the Brevo email research, and the `sharp`/`nodemailer` lockfile versions (`main` also has `multer` 2.3.0, which the branch lacks). Merging it would still delete the perf-scaling work. |
| `claude/wevolunteer-perf-scaling-ad3613` | 2 | **Superseded.** `migrations.convergence.test.js`, the environment × database matrix in `productionDatabaseGuard.test.js` and the three-key `idx_events_browse_order` are all on `main`; the only differences in migration 066 are comment wording. The share-link assertion is the same fix as above. |
| `claude/wevolunteer-production-architecture-89e97f` | 0 | **Merged** (via the release candidate). |
| `claude/owner-center-certificate-upgrade-7eef59` | 0 | **Merged** (via the release candidate). |
| Closed PR #4, `feature/social-directory-and-organizations` | 0 of 332 | **Superseded.** Every commit is on `main` by patch-id. The files it has that `main` lacks were deleted on `main` deliberately (`CertificateModal.jsx` in `ea4df89`, `LocationDisplay.jsx` in `11a26c7`, the unwired e2e harness in `4045712`). |
| `.claude/worktrees/rc-final` (on `claude/release-candidate`) | — | **Superseded, left untouched.** Six uncommitted changes, last modified 2026-09-09. Its `server/app.js` hunk and `server/apiCacheIsolation.test.js` are byte-identical to `trunk-security-port`'s `cfa5be8`, so it is a second copy of work now on `main`. It belongs to another session and was neither modified nor cleaned. |

The files that branches carry and `main` lacks — `LegalUpdateModal.jsx`,
`LocationDisplay.jsx`, `CertificateModal.jsx` — were each deleted on `main` in a
named commit, not lost.

The 28 tags are rollback and pre-rewrite snapshots (`backup/*`, `checkpoint/*`,
`preintegration/*`, releases). They are archives by design and were not
treated as unfinished work.

### What `claude/trunk-security-port` held, and how each piece landed

| Branch commit | On `main` as | Notes |
|---|---|---|
| `cfa5be8` origin `no-store` | `3b4dd72` | **Not verbatim.** The branch mounted it beside cookie-parser and said it covered responses that never reach a router. The CORS 403 and the 413/400 body refusals are produced above that point and did not carry it — shown by mutation: at the branch's position three new cases fail. Moved ahead of the `/api` CORS layer; seven on-the-wire cases, plus a production-boot probe that the hashed bundle keeps `immutable`. |
| `f5c9db2` dependency advisories | `ad0dac3` | `multer`/`sharp`/`nodemailer` were already on `main`. `vitest` 4.1.11 was not, and closes the advisory the freeze note said needed a major bump. The remaining `uuid` advisory is assessed in ENGINEERING_GUIDE §6.7 item 4. |
| `0dc9080` deploy template and email research | `10f1d29` | Reconciled against `main`'s document (one conflict, resolved to `main`'s row). `CORS_ORIGINS` and `docs/operations/resend-mcp.md` carried the same wrong host and were fixed too. |
| `a31aa02` $0 infrastructure report | `87821b8` | Added with a status note; the report's own record of a production boot on Pinecone namespace `development` produced a template comment. |

`security-review` was run over the integrated diff before it reached `main`: no
finding at the reporting threshold. Two below-threshold observations about
`deploy/provision.sh` are recorded in "Still open" below rather than dropped.

### Verification on the integrated tree

| Check | Result |
|---|---|
| `npm test` (SQLite) | 618 files passed, 10 skipped; **10,400 passed, 0 failed**, 176 skipped |
| `npm run test:postgres` | 397 files passed, 2 skipped; **6,896 passed, 0 failed**, 41 skipped |
| `npm run lint` | clean |
| `npm run build` | clean |
| `npm run scan:bundle` | 172 files, CLEAN (`VITE_AMPLITUDE_API_KEY` public by design) |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `npm ci --ignore-scripts` from a clean copy | installs; lockfile byte-identical |
| `bash -n` on every tracked shell script | all nine parse |

The skips are environment-gated rather than ignored: PostgreSQL-only cases in the
SQLite run and SQLite-only cases in the PostgreSQL run, live-service checks that
need real vendor credentials, the Supavisor pooler case, and the legal-hash
enforcement mode.

### Still open — none of it autonomous

- **Confirm the live host's values match the corrected template.** If
  `/etc/wevolunteer/wevolunteer.env` was written from the old template, check
  `APP_URL`, `CORS_ORIGINS` and `OAUTH_REDIRECT_URI` name `app.wevolunteers.org`,
  and that `PINECONE_NAMESPACE` is unset or `production`. If a Resend webhook was
  created, confirm its endpoint is `https://app.wevolunteers.org/api/webhooks/resend`.
  Reading a production secret file is an owner action, not a repository one.
- **Two hardening notes on `deploy/provision.sh`** (below the security-review
  threshold, and in commits another session landed today): `ensure_cf_chain`
  recognises an existing blanket 443 rule only as `iptables -L` renders the
  `-m state --state NEW --dport 443` spelling (`provision.sh`, the awk match), so a hand-written rule in another spelling would sit above the
  Cloudflare jump and keep 443 open; and `cmd_host` edits only the IPv4 table,
  where the `ufw default deny incoming` it replaced also governed IPv6 under
  ufw's default `IPV6=yes`. Neither is exploitable
  as written — real-IP trust stays limited to Cloudflare's ranges, and OCI's
  Security List filters in front — but both belong in that script's next change.
- **Branch deletion** is a separate decision. Every non-`main` branch above is
  either merged or superseded; none holds work that `main` lacks.

---

## 2026-09-09 — final reconciliation at the release freeze

The 2026-09-06 note above said the branches were deleted. They are not: six
local branches exist — `main` and five others — and `claude/release-candidate`
is still receiving commits from a concurrent working session; it moved
repeatedly during the freeze pass, most recently while this section was being
written.
That is not a problem to fix by deleting anything. It is a reason to state, once
and precisely, what the relationship between that branch and the trunk actually
is, so nobody merges it on the strength of its name.

### `claude/release-candidate` is a subset of `main`, not a superset

Compared as trees, not as commit graphs — the histories were rewritten, so
identical work carries different SHAs on each side and `git log main..RC` is
misleading:

| Measure | Result |
|---|---|
| Files on the branch that `main` lacks | **0** |
| Files on `main` that the branch lacks | **45** |
| `git diff --shortstat main <branch>` | 134 files, 928 insertions, **20,269 deletions** |

The 45 files are the perf-scaling work: scheduler leases, the event-slot summary
and trigram-index migrations (065–067), the Redis volume limiter, the Socket.IO
adapter seam, `bin/load-test.mjs`, and their tests. **Merging that branch into
`main` would delete them.** It must not be merged.

### The five commits that were only on the branch, and where each went

Subjects, not SHAs — the histories diverge by hash for identical content.

| Branch commit | Disposition |
|---|---|
| `test: a simulated week…` | Already on `main` as `2446aaf`. `server/weekSimulation.test.js` is **byte-identical** on both sides. |
| `fix(test): the roster-export audit assertion ordered by a column PostgreSQL does not have` | Already on `main`: `server/routes.admin.test.js` uses `insertionTiebreak(db)` there too. |
| `fix(db): the TLS certificate path resolved against the cwd…` | Already on `main`: `server/db/engine.js` resolves the CA as `[cwd, ROOT].find(existsSync) ?? ROOT` on both sides. Only the comment wording differs. |
| `docs(email): the daily cap is the constraint…` | **Taken.** Cherry-picked here — it was genuine operator research that `main` did not carry. One hunk was *not* taken: it asserted that the production Supabase project is provisioned and verified, which is another session's claim that this pass cannot confirm and which must not enter release documentation unverified. |
| `fix(deps): take the patched sharp and nodemailer releases` | **Applied independently**, not cherry-picked: the two lockfiles have diverged too far for the patch to mean the same thing. `main` additionally fixes **multer**, which the branch does not — see below. |

### The dependency advisories, reconciled

`npm audit --omit=dev` on `main` at the start of the freeze reported three HIGH
advisories in the *shipped* tree:

| Package | Locked | Advisory | Now |
|---|---|---|---|
| `sharp` | 0.35.3 | `<0.35.4` — libheif decoder bugs | **0.35.4** |
| `nodemailer` | 9.0.3 | `<=9.1.0` — `resolveContent()` bypasses `disableFileAccess` | **9.1.1** |
| `multer` | 2.2.0 | `<=2.2.0` — DoS via crafted multipart field names | **2.3.0** |

`sharp` is the material one: it decodes user-uploaded images on a platform whose
users are minors. All three were already inside the declared ranges, so this is a
lockfile refresh — `package.json` and `server/package.json` are untouched, and
the update was a targeted `npm update sharp nodemailer multer`, never
`npm audit fix`, because regenerating the lockfile wholesale drops the
cross-platform entries and the deployment target is ARM64. The 26 `@img/sharp-*`
platform entries were compared before and after: none were lost.

Production tree afterwards: **0 vulnerabilities.** Five moderate advisories
remain in dev-only tooling (`vitest`, `@vitest/mocker`, `autocannon`, `hyperid`,
`uuid`); none of it ships, and the fix for the vitest pair is a major-version
bump of the test runner, which is not a thing to do during a freeze.

### `claude/trunk-security-port` — live, and carrying work this release does not

This branch was at `main`'s commit when the paragraph above was first written
and had moved four commits ahead ninety minutes later, mid-freeze. That is the
state of it: another session is working there now. Its content as of the freeze:

| Commit | What | Disposition |
|---|---|---|
| `fix(deps): three high-severity advisories on the upload and mail paths` | The same `sharp` / `nodemailer` / `multer` advisories | **Already fixed here**, independently and identically, plus `multer`. |
| `security: say no-store at the origin, instead of hoping three things agree` | `Cache-Control: no-store` set by `server/app.js` on every `/api` response, with `server/apiCacheIsolation.test.js` | **Not merged.** See below. |
| `docs(deploy)`, `docs(audit)` | A 749-line zero-cost infrastructure report and deployment notes | **Not merged.** Another session's document; it can land with its branch. |

**Why the `no-store` commit is not a release blocker, and was still not taken.**

It is good work — it removes the release's dependency on three separate things
agreeing about whether `/api` may be cached, and it is mutation-tested. But the
property it protects is not open in this release: `deploy/nginx/wevolunteers.conf`
already sets `Cache-Control: no-store, no-cache, must-revalidate, private` with
`always` on `location /api/`, and that file ships with the release. The branch's
own commit message says as much and keeps the nginx rule as defence in depth.

So the choice was between shipping a leak and shipping defence in depth, and it
is the second. Against that, cherry-picking it here would have meant taking
application code out of another session's branch minutes after it landed,
without its author's gates, into a tree where `server/app.js`,
`package-lock.json` and this very file have all diverged — and would have left a
duplicate commit to conflict with when that branch merges properly. That is the
blind merge this pass exists to avoid, wearing a security fix's clothes.

**Recommendation:** merge `claude/trunk-security-port` on its own terms, after
this release, as its own pass with its own gates. Nothing in it is urgent
enough to justify taking it during a freeze; nothing in it should be lost.

### The other three branches

The perf-scaling, production-architecture and owner-center branches are all
behind `main` and their work is integrated, as the 2026-09-06 record below
describes. None of them needs another merge; none of them is deleted here,
because deleting a branch somebody else may be working from is not this pass's
call to make.

> **Read the status table first; the reasoning below it is history.**
>
> This document was written during a freeze pass that deliberately excluded the
> perf-scaling branch, and it says so at length — including "this branch should
> not be deleted". That decision was **reversed** in the same 24 hours, on
> instruction, and the branch was integrated in full. The argument for excluding
> it is kept below because it is a good argument and it records what the risk
> actually was; it is no longer the decision.

---

## Final status

| Branch | Unique vs `main` | Outcome |
|---|---|---|
| `claude/release-candidate` | 0 | **Merged and deleted.** The integration branch: it had already folded in production-architecture and owner-center, plus four of its own fixes. |
| `claude/wevolunteer-production-architecture-89e97f` | 0 | **Merged and deleted**, via the release candidate. |
| `claude/owner-center-certificate-upgrade-7eef59` | 0 | **Merged and deleted**, via the release candidate. |
| `claude/wevolunteer-perf-scaling-ad3613` | 0 | **Merged and deleted** — in full, reversing the decision recorded below. Seven conflicts, resolved deliberately. |
| `mahit/wevolunteer-legal-notifications-banner-aa4769` | 2 commits, **0 tree difference** | **Deleted.** Its tree was byte-identical to `origin/main`, which is an ancestor of `main`, so PR #8's squash carried it verbatim. Nothing was lost. |

### What the full perf-scaling merge actually cost

The concerns below were real and were answered rather than dismissed:

- **Limiter storage and worker coordination** — merged. `apiLimiter` moved onto
  the coordinated volume store; the Redis privacy allowlist became the UNION of
  both sides (seven modules) rather than either.
- **Migrations** — reconciled. The branch had already merged `main` and given up
  its own colliding numbers; a convergence test now compares the fresh and
  upgraded provisioning paths and found one index that disagreed between them.
- **`ipKeyGenerator`** — the defect named at the bottom of this document was
  fixed on trunk, and the merge exposed that the branch's own copy still passed
  `(req, res)`. Trunk's `req.ip` won. The branch's guard for it now strips
  comments, because it was firing on the paragraph explaining the bug.

Re-measured after integration rather than trusting the numbers quoted below:
see `docs/operations/post-integration-measurements.md`. The headline held —
migration 066 takes the default browse page from 95.6 ms to 17.9 ms at p50 at
10,000 events — and the filtered variants did **not**: they still cost
90–180 ms, and no candidate rewrite is uniformly faster.

---

## Original record, from the freeze pass

*Everything below is the 2026-09-06 freeze-pass reasoning, kept unedited.*

## Branch inventory

| Branch | Last commit | Unique vs RC | Status | Action |
|---|---|---|---|---|
| `main` | 2026-09-05 | 0 | Trunk | **Merged** — RC is built from it |
| `claude/wevolunteer-production-architecture-89e97f` | 2026-09-05 | 0 | Complete | **Merged** |
| `claude/owner-center-certificate-upgrade-7eef59` | 2026-09-04 | 0 | Complete | **Merged** |
| `mahit/wevolunteer-legal-notifications-banner-aa4769` | 2026-09-05 | 2 | Superseded | **Excluded** — its feature is in the RC via PR #8; the branch is otherwise behind |
| `claude/wevolunteer-perf-scaling-ad3613` | 2026-09-04 | **46** | Active, unmerged | **Two fixes ported; the rest excluded** — see below |

---

## `claude/wevolunteer-perf-scaling-ad3613`

46 commits that are not in the release candidate, and it is itself 17 commits
behind `main`. It is substantial work — distributed rate limiters, leader leases
for the periodic sweeps, N+1 elimination across events, applications, admin,
appeals and certificates, a Socket.IO adapter seam, an HTTP load test, and
verification against the real Supabase and Upstash services.

### Why it was not merged wholesale

Not because the work is wrong. Because merging it is a different kind of change
from the one this pass is for:

- It rewrites **worker coordination** (leader leases) and **limiter storage**
  (moving the last process-local limiters to Redis). Both are correctness-
  critical subsystems that the release candidate has just been verified against.
  Merging them re-opens that verification.
- It carries **schema and migration** changes that would need their own
  reconciliation against migration 61–64 history.
- It is 17 commits behind `main`, so merging it means merging *and* reconciling
  it forward first.

A final freeze pass is the wrong moment to integrate a branch of that shape. It
should be reconciled as its own project, after the pilot, with its own testing.

### What was taken, and why those two

Both are defects that affect the release candidate as it will actually be
deployed, and both are small and self-contained enough to port without dragging
the architecture behind them.

**`12adb5a` — `apiLimiter` had no key generator.**
The broadest limiter in the application keyed on a bare address: 600 requests
per fifteen minutes for a whole school's shared egress. A few dozen students
browsing at lunchtime exhausted the building's budget and the next person got a
429. That is the pilot's own topology, so it would have shown up on day one.
Ported with its verified-session keying intact — the token is checked, not
merely read, because trusting the cookie would let an attacker mint a fresh
bucket per request.

**`50a25b0` — `applyPostgresSchema` ran the DDL before the migrations.**
The generated DDL describes the finished schema, so on an existing database
`CREATE TABLE IF NOT EXISTS` is a no-op that does not add a column while the
`CREATE INDEX` over that column is not, and the boot dies with
`column "…" does not exist`. That is every upgrade across a migration that adds
a column and indexes it — found on the real Supabase database. It does not
affect the first deployment, which starts from an empty database; it affects the
second. Ported into the generator template so it survives regeneration.

### What was left, and what that costs

Everything else, including:

- distributed rate limiting via Redis (the RC keeps process-local limiters,
  which is correct for a single always-on instance and is what the deployment is)
- leader leases for the periodic sweeps (same reasoning: one instance, one leader)
- the N+1 and pagination work
- the Socket.IO adapter seam
- `bin/load-test.mjs`

**The cost is performance headroom, not correctness.** Prior measurement put the
events endpoint at 11 ms at 1,000 events, 113 ms at 10,000 and 572 ms at 50,000;
a pilot is far below the point where that matters. The limiter and worker
changes only become necessary when there is a second instance, which this
architecture deliberately does not have.

**This branch should not be deleted.** It is the right starting point for the
first scaling project after the pilot, and it holds real verification against
Supabase and Upstash that is worth keeping.

> **Superseded.** The branch was merged in full and then deleted — its history
> is in `main`, so the verification work it holds is kept rather than lost. See
> the status table at the top.

---

## One defect found in neither branch

`ipKeyGenerator(req, res)` — seven call sites, present on `main` and on every
branch including perf-scaling. `express-rate-limit@8` takes an address, not a
request; handed a request it returns it unchanged, which stringifies to
`[object Object]`. Every IP-keyed limiter therefore shared one bucket with the
entire internet, and IPv6 was never normalised to a /56.

Fixed on the release candidate. It is still present on `main` and on
perf-scaling, and should be carried to any branch that outlives this release.
`server/limiterKeys.test.js` catches it textually so the next one is caught too.


---

## One harness observation, recorded so it is not re-diagnosed

The accessibility sweep produced **45 failed / 18 passed** on one run and
**63 passed** on a clean re-run of the identical tree, minutes apart.

The difference was the scratch database. The failing run reused a
`scratch/a11y.db` left behind by an earlier sweep in the same working
directory; the passing run began with `rm -rf scratch`.

This is a harness sensitivity, not an application defect — but it can
manufacture a mass failure that looks exactly like a regression, and chasing it
costs an hour. **Start every sweep from a clean scratch directory:**

```bash
rm -rf scratch && mkdir -p scratch
WEV_DB_PATH="$PWD/scratch/a11y.db" npm run a11y -- --grep-invert @local
```

CI is unaffected: `.github/workflows/ci.yml` runs on a fresh checkout, so the
stale database cannot exist there.
