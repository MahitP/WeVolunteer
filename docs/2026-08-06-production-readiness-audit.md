# Production Readiness Audit — v1.2c

**Date:** 2026-08-06
**Branch:** `fix/v1.2c-review-findings`
**Baseline commit at start:** `440e3ad`
**Verdict:** **NOT READY — BLOCKERS REMAIN** (see §9; no blocker is a code defect)

This audit re-derived its conclusions from the current repository rather than
from the reviews that preceded it. Where a previous document asserted something,
that assertion was re-checked. Everything below is either backed by a command
whose output is quoted, or is explicitly marked as not verified.

---

## 1. Repository state

```
branch  fix/v1.2c-review-findings   (up to date with origin, working tree clean)
HEAD    440e3ad  docs: align policies with in-app appeals workflow
```

The six Trust & Safety commits are present and are the most recent work:

| Commit | Subject |
|---|---|
| `440e3ad` | docs: align policies with in-app appeals workflow |
| `64dc7b9` | feat: add user appeals workflow |
| `6bfb21d` | fix: restore development OAuth mock providers |
| `c669604` | feat: complete unified reporting and moderation workflow |
| `5b1a74b` | feat: make safety evidence outlive the people who want it gone |
| `6defd7e` | docs: plan Phase 3 against the spec that already existed |

**No unexpected modifications.** The tree was clean at start.

**Temporary artifacts:** `server.log`, `server2.log`, `test_output.txt` (92 kB),
`playwright-report/`, `test-results/`, `scratch/`, `backups/`, `dist/`, and six
`*.db` files are present in the working directory. Every one is matched by
`.gitignore` (verified with `git status --porcelain --ignored`), so none is a
repository risk. They are local debris, not release debris.

**Lockfiles:** exactly one tracked (`/package-lock.json`). The two others on disk
are inside `.claude/worktrees/`, which is ignored and absent from a CI checkout —
so the CI guard against nested lockfiles is satisfied.

### Branch topology (consolidated after the audit)

`main` was 61 commits behind the release branch and every feature branch was
unmerged, so "which branch is the truth" had no answer. `fix/v1.2c-review-findings`
turned out to contain `main` in full — `git rev-list --count HEAD..main` was **0** —
so `main` was fast-forwarded onto it with `--ff-only`. No merge commit, no
conflict, nothing rewritten.

| Branch | Disposition |
|---|---|
| `main` | **The source of truth.** Contains all finalized work. |
| `fix/v1.2c-review-findings` | Kept. Fully contained in `main`, but tracks `origin` with unpushed commits, so deleting it would strand the remote copy. |
| `feature/error-dashboard` | Deleted — 0 unique commits vs `main`. |
| `feature/error-experience` | Deleted — 0 unique commits vs `main`. |
| `feature/v1.2c-documentation` | Local copy deleted — 0 unique commits; `origin`'s copy remains as the record. |
| `refine/error-experience-visual-polish` | Deleted — 0 unique commits vs `main`. |
| `claude/admiring-mayer-6a892f` | **Kept.** Its one commit (dead OAuth harness deletion) was cherry-picked; content verified absent from `main`'s tree. |
| `claude/xenodochial-heyrovsky-66b8d2` | **Kept.** Its one commit (brace-expansion advisory) was cherry-picked; lockfile verified identical apart from the version stamp, where `main`'s 1.2.0 is correct and the branch's stale 1.1.0 is not. |

Every deletion used `git branch -d`, never `-D`, so git itself refused anything
it could not confirm was merged. The two `claude/*` branches are kept precisely
because it could not: cherry-picking changes the SHA, so their *content* is
verified present in `main` while git still reports them unmerged. Force-deleting
on the strength of a content check is the one step in this cleanup that is not
reversible, so it is left for the owner. Tip SHAs of all eight pre-cleanup
branches are recorded in the cleanup commit message.

**Version consistency:** root and `server/package.json` both `1.2.0`. `/health`
reads from `server/package.json`; the two do not drift.

### Inventory

| | Component | Detail |
|---|---|---|
| **A** | Application code | React 19 SPA (`src/`, 35 dirs) + Express 4 API (`server/`, 168 top-level modules incl. tests), 18 route modules, one process serves both |
| **B** | Database | SQLite via `node:sqlite` (experimental — Node 24.x enforced by `preflight.js`), WAL, `busy_timeout=5000`, 15 versioned migrations + additive `addColumnIfMissing` guards, checksums re-verified on boot |
| **C** | Authentication | JWT in an HttpOnly cookie (7d), bcrypt, OAuth (Google/Microsoft; Apple stubbed off), step-up AAL2 over 7 sensitive actions, `token_version` session invalidation, identity re-read from DB per request |
| **D** | Email | nodemailer; SMTP required in production (hard exit otherwise), console mock in dev; outbox table with backoff and attempt ceiling; separate transactional-mail health record |
| **E** | Background workers | `notificationWorker`, `exportWorker`, `retentionWorker`, `autoSelectScheduler`, notification sweep interval, `socketServer`; all drained by `shutdown.js` |
| **F** | Deployment | systemd unit + backup service/timer, nginx reverse proxy (runbook §3), two separate env files, GitHub Actions CI running all four gates |
| **G** | Monitoring/ops | `/health` (read **and** write probe), `error_groups`/`error_events` dashboard, email alerting on new server/worker errors, `admin_audit_logs`, request log, `verify:hours` parity check, `verify-restore.sh` rehearsal |

---

## 2. Security findings

### Verified clean

- **Secrets.** No credential material in tracked files. Scanned for AWS keys, PEM
  private keys, Slack tokens, `sk-`/`ghp_` tokens and `GOCSPX-` client secrets
  across all tracked content; the only `GOCSPX` hits are the secret scanner's own
  pattern and audit prose. No env file with real values is tracked
  (`.env.example`, `.env.development`, `.env.production.example`,
  `deploy/wevolunteer.env.example` only). Pre-commit secret scan hook installed.
- **SQL injection.** Every string-interpolated SQL fragment was traced to its
  source. All of them interpolate table names from fixed module-level arrays,
  column names from hardcoded literal lists, `?` placeholder runs sized from
  array length, or an `ORDER BY` looked up in the closed `SORTS` map in
  `eventQuery.js` (an unknown sort falls back rather than reaching SQL). No
  caller-supplied value reaches a query as text. `RETAINABLE_MESSAGE_PREDICATE`
  interpolates only module-local literals.
- **XSS.** Zero occurrences of `dangerouslySetInnerHTML` or `innerHTML` in `src/`
  — the only two matches are comments in `policyMarkdown.js` and
  `PolicyBody.jsx` stating that neither is used. No `eval` or `Function`
  constructor anywhere. CSP is set with `scriptSrc: ["'self'"]` and **no**
  `unsafe-inline`, which is the directive that actually stops an injected script.
  Notification email escapes every database value before interpolation.
- **CSRF.** `sameSite: 'lax'`, no token, and the reasoning in `config.js` holds
  for the shipped topology (one Express process serves SPA and API; dev proxies
  `/api` through Vite, so one origin in both). `Lax` blocks cross-site POST/PATCH/
  DELETE, which is the whole surface here. The comment names the two changes that
  would invalidate it — a sibling subdomain, or a split origin — which is the
  right way to record a conditional decision.
- **Payload limits.** 100 kB global, 8 kB on `/api/errors/report`, the one
  unauthenticated write. The tighter cap is mounted *before* the global parser,
  which is load-bearing and commented: a route-level limit would silently never
  engage. `413` is mapped out of the 500 path and reports the limit that actually
  applied.
- **Authorization.** No role-string comparison in any route. Capability gates via
  `requireCap`/`requireCapAny`/`can()`, with six build-failing static guards in
  `authz.completeness.test.js`. Privilege cascades in the new appeals code are
  ordered most-privileged-first and end in an explicit deny — correct, because
  `super_admin` holds `'*'` and a bare `else` would invert the intent.
- **Step-up auth.** Gate-and-spend pairing is enforced structurally (guard 5), so
  a `requireAAL2` without a matching `spendChallenge` fails the build rather than
  leaving a replayable grant. `account.delete` spends inside the deletion
  transaction, first statement — atomic in both directions. No inline
  `bcrypt.compare` outside sign-in.
- **File uploads.** None. There is no upload endpoint; avatars are string
  references. This removes the entire class.
- **Rate limiting.** Nine distinct limiters with per-endpoint keying decisions
  (address-keyed mail limits with a per-IP ceiling underneath, account-keyed
  login lockout, split read/write limits on the unauthenticated appeal route).
  The campus-NAT reasoning is applied consistently.
- **Realtime.** Socket handshake verifies the cookie JWT, re-reads the user from
  the DB, checks `token_version`, `account_status` and session revocation, and
  re-checks every 5 minutes. Origin policy mirrors the HTTP one and its
  development widening is gated on `!IS_PRODUCTION`.

### S-1 — The most dangerous boot guard had no test *(closed)*

`OAUTH_ALLOW_MOCK=true` in a production process makes
`POST /api/oauth/google/callback` an unauthenticated sign-in as any account,
including `super_admin`, because the mock transport takes the identity from the
request body. `config.js` refuses to boot on it. **Nothing asserted that.**

Every other production boot guard is pinned. This one was pinned by its own
comment — and the `OAUTH_REDIRECT_URI` block's header cites it as precedent
("a placeholder JWT_SECRET and OAUTH_ALLOW_MOCK in production both refuse to
boot") while asserting nothing about it.

Six regression tests added. The guard was already correct: **no behaviour
changed.** What changed is that it can no longer be removed silently.

### S-2 — `NODE_ENV` is a single-variable posture downgrade *(residual, not fixed)*

Every fail-closed production control keys off `NODE_ENV === 'production'`. With
it unset or misspelled, all of these silently invert:

| Control | With `NODE_ENV` unset |
|---|---|
| `OAUTH_ALLOW_MOCK` | defaults **on** → forged-identity sign-in as any user |
| Cookie `secure` | off → session cookie over plain HTTP |
| Weak/placeholder `JWT_SECRET` | warns instead of refusing |
| SMTP completeness, `APP_URL` | not required |
| `DEMO_MODE` | permitted |
| Instance lock, legal-doc verification | advisory instead of fatal |

**Mitigation, verified:** `app.js` mounts `express.static(dist)` and the SPA
fallback **only** when `IS_PRODUCTION`. In the shipped topology nginx proxies
`location /` to the Node process, so a deployment missing `NODE_ENV` serves no
frontend at all. The mistake is loud, not silent — an operator cannot miss it.

**Residual exposure:** the API stays live while the site is blank, so the mock
OAuth endpoint is reachable during the window before someone fixes it.

**Not fixed deliberately.** A guard that refuses to boot without
`NODE_ENV=production` would break `npm run dev`, and distinguishing "a real
deployment" from "a developer's machine" needs a second signal — a new
environment variable and a new failure mode. That is an architectural change,
not an audit fix. Recommended for the next release; recorded here so the decision
is explicit rather than an omission.

### S-3 — Dependency advisories: 3 high, both assessed as not exploitable here

```
high  react-router / react-router-dom  GHSA-qwww-vcr4-c8h2
high  brace-expansion                  GHSA-rgw5-rvv9-x895
```

- **react-router — "RSC Mode CSRF Bypass".** Affects React Router's **RSC mode**.
  This application is a plain SPA: `src/main.jsx` mounts `<BrowserRouter>`, and
  there is no RSC, no framework mode, and no `createRequestHandler` anywhere in
  `src/`. Not exploitable. Note there is **no in-range fix**: the advisory covers
  `>=7.12.0 <8.3.0`, current is `7.18.1`, and npm's suggested remediation is a
  downgrade to `7.11.0` (flagged semver-major). Accepted, and worth tracking for
  the 8.x upgrade rather than acting on now.
- **brace-expansion — DoS via unbounded intermediate arrays. FIXED.** Reached
  only through `nodemon` (`nodemon → minimatch → brace-expansion`), a
  `devDependency` absent from a production install (`npm ci --omit=dev`), so it
  was never a production risk. Cleared anyway: 5.0.8 → 5.0.9, which also carried
  `react-router`/`react-router-dom` 7.18.1 → 7.18.2 as an in-range patch bump.
  `npm audit` now reports 2 highs rather than 3, both the react-router entry
  above. Taken as its own commit with its own four gates, because editing
  `package-lock.json` invalidates every gate already run against it.

---

## 3. Performance findings

### Measured

Production build (`npm run build`, 527 ms):

| Chunk | Raw | gzip |
|---|---|---|
| `index` (eager shell) | 371.85 kB | **116.39 kB** |
| `LeafletMap` (lazy) | 154.31 kB | 45.38 kB |
| `EventModal` (lazy) | 68.87 kB | 17.34 kB |
| `Settings` (lazy) | 46.52 kB | 12.62 kB |

Route-level code splitting is real — 23 separate chunks, with the map (the
single heaviest dependency) isolated behind a lazy boundary. Compression is
mounted first with `threshold: 1024`; hashed assets carry
`max-age=31536000, immutable` while `index.html` is `no-cache`. This is correct
and needs no work.

Index coverage is thorough: ~50 indexes including composite queue indexes
(`reports(status, priority, created_at)`, `appeals(status, created_at)`) and
partial indexes on nullable FKs. `attendance(user_id, present)` covers the
derived-hours aggregate, which is the hottest read in the product.

### P-1 — N+1 in the moderation appeals queue

`GET /api/admin/appeals` computes conflicts per row:

```js
const withConflicts = appeals.map(a => {
  const full = db.prepare('SELECT * FROM appeals WHERE id = ?').get(a.id);
  const conflicts = disqualifiers(db, req.user.id, full);   // up to 5 queries
```

Cost is `6N + 2` queries for `N` appeals in the filtered view. `node:sqlite` is
synchronous and in-process and every predicate hits an index, so at pilot scale
(a queue of tens) this is single-digit milliseconds and **not worth changing**.
It becomes worth changing if the default filter is ever widened to include
`resolved` by default, or if a queue routinely exceeds a few hundred rows.
Recorded rather than fixed, because fixing it now would trade clear code for
speed nobody needs.

### P-2 — Leaderboard aggregates before it limits

`GET /api/leaderboard` groups `users LEFT JOIN attendance` across all opted-in
students, sorts, then `LIMIT 25`. There is no index on
`users(role, leaderboard_opt_in)`, so the candidate set is a table scan. Fine at
target scale; the first index to add if the population reaches the thousands.

### What breaks, and when

| Scale | Assessment |
|---|---|
| **100 users** | Comfortable. Nothing here is stressed. |
| **500 users** | Comfortable. Event list is paginated with a hard cap and gzips ~54× (measured: 690 kB → 12.8 kB for 503 events). Leaderboard scan still trivial. |
| **1000 users** | Still expected to serve, but this is where the *architectural* ceiling matters more than any query. |

**The real ceiling is architectural, not algorithmic.** `instanceLock.js`
enforces exactly one process per database, and it must: all rate-limit state is
per-process memory (N instances enforce N× the configured limits) and slot
capacity checks read outside their write transaction. So the platform scales
**vertically only** — no second app server, no horizontal scaling — and a single
Node process plus a single SQLite file is the whole capacity story.

For one school district that is the right architecture and is well defended. It
is not a defect. It *is* a hard limit that should be understood before anyone
promises multi-district operation.

### Is SQLite still appropriate? **Yes. Do not migrate.**

- Writes are low-volume and bursty (applications, attendance confirmation),
  never sustained.
- The single-writer constraint is already enforced and documented, so SQLite's
  main limitation is a property of the deployment rather than a surprise.
- WAL + `busy_timeout=5000` + one synchronous process means there is no
  cross-process interleaving to race. Transaction safety was reviewed:
  `inTransaction` uses deferred `BEGIN`, which is correct here because the
  instance lock removes the second writer that would make it unsafe.
- Backup and restore are solved *because* it is one file — `verify-restore.sh`
  rehearses a full recovery including a `/health` check against the restored
  database. That property is genuinely hard to keep with Postgres.

A Postgres migration would add an operational component, a connection pool, a
new backup story and a new failure mode, in exchange for concurrency this
workload does not need. **No migration plan is produced, because none is
justified.** Revisit if and only if multi-tenant or multi-instance operation
becomes a requirement.

---

## 4. Infrastructure findings

### Verified strong

- **systemd hardening:** `NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=strict`,
  `ProtectHome`, `ReadWritePaths` scoped to the database directory, dedicated
  `wev` user, `Restart=on-failure` with a start limit.
- **Backups:** `bin/backup.sh` uses SQLite's online `.backup` API, not `cp` —
  correct and non-obvious, since in WAL mode recent commits live in the `-wal`
  sidecar (the script documents a 4 kB main file against a 519 kB WAL). Every
  backup is integrity-checked *before* it is kept, and a backup that fails
  verification is deleted and the script exits non-zero. Timer runs daily at
  03:00 with `Persistent=true`, so a missed run catches up.
- **Restore is rehearsed, not assumed.** `bin/verify-restore.sh` decompresses to
  a throwaway copy, runs `integrity_check` and `foreign_key_check`, counts users
  / hours / certificates / ledger rows, runs the hours-parity checker, then
  **boots the application against the restored database and asserts
  `/health` reports `status:ok` and `writable:true`**. This is better than most
  production systems have.
- **Two separate env files** at different paths specifically so one cannot
  overwrite the other, with the failure mode of merging them documented.
- **CI** runs all four gates plus the nested-lockfile guard on every PR to `main`.

### I-1 — A failed backup notifies nobody *(launch blocker)*

`deploy/wevolunteer-backup.service` has **no `OnFailure=`**, and this is
deliberate and honestly documented — a previous revision claimed one existed
when it did not, and the comment now says so. The commented example on line 54
is the operator's job to complete.

The consequence is unchanged by the honesty: `backup.sh` exits non-zero, systemd
records a failed unit, and **a failed unit nobody looks at is the same as no
backup.** On a platform holding minors' service records that is not acceptable
at go-live. This must be configured before launch, not after.

It also cannot be routed through the application's own alerting: a backup that
cannot run is precisely the situation in which the app may also be down.

### I-2 — Error alerting is off unless `ALERT_EMAIL` is set *(launch blocker)*

`ALERT_EMAIL` unset disables alerting entirely. The env template says this
plainly — "It is the only thing that causes anyone to look at the error
dashboard. Without it the application records its own failures perfectly and
tells nobody" — and unset is the *safe* default rather than the recommended one.

With the retention reporting fixed (§6, R-1), the alert channel now carries
retention failures too, which raises the value of setting it.

### I-3 — CI does not check dependency advisories

The four gates do not include `npm audit`. Both current highs were found by
running it manually during this audit. A scheduled `npm audit --omit=dev` job
(or a Dependabot configuration) would surface the next one without an audit.
Low effort; not a code change.

### I-4 — Operator-owned controls that cannot be verified from the repository

TLS/HTTPS termination, certificate renewal, the firewall on `API_PORT`,
`BIND_ADDRESS=127.0.0.1`, `TRUST_PROXY` matching the real proxy count, and
database volume persistence are all correctly *documented* and all outside this
repository. They are on the checklist in §10 and none of them is verified here.

---

## 5. Privacy findings

- **Data minimisation is real.** No uploads, no analytics, no third-party
  scripts (CSP `connectSrc: 'self'` plus tile hosts only). Date of birth exists
  to run the age gate.
- **Minors.** The age gate is what licenses indefinite retention of certificates
  and hours — the amended COPPA Rule forbids retaining a child's data
  indefinitely, so no under-13 account may exist. This dependency is documented
  at the point it is relied on (`retentionWorker.js`, migration 008), which is
  the right place for it.
- **Credited hours are never stored on a user.** Derived on every read as
  `SUM(hours_awarded) WHERE present = 1`, with every change additionally
  appended to `hours_ledger` and a parity checker (`verify:hours`) that exits
  non-zero on mismatch.
- **Deletion is a soft delete, correctly.** Name shortened, email and username
  replaced with `deleted_<id>` forms, avatar/bio/school nulled,
  `token_version` bumped to kill every session, live reset and verification
  tokens destroyed, future commitments withdrawn and the affected organizers
  notified — all in one transaction. Certificates are snapshotted first so a
  verification lookup still works after the account is gone.
- **The three-year purge is bounded by evidence, not only by the clock.** A shell
  is purged only when nothing depends on it, and the organizer clause is the
  subtle one: `events.organizer_id` cascades, so purging an organizer would have
  destroyed every student's attendance hanging off their events. That path is
  excluded explicitly. Purge is also held while the account is party to a live
  report — **in both directions**, which closes the case of a student who
  reported an adult and then deleted their own account having their safety report
  destroyed three years later by their own privacy right.
- **Logs do not over-expose.** Request log strips query strings (they carry
  `verify=` and `reset=` tokens) and logs an opaque user id, never a name.
  Alert emails deliberately carry no error message, stack, route or affected
  user — and `alerting.test.js` fails the build if any of it appears. Audit
  entries for reading an appeal record *that* the statement was read, never its
  text.
- **Retention now actually runs.** See R-1 — this was the largest privacy finding
  of the audit and is fixed.

---

## 6. Bugs fixed

Each entry: what was wrong → how it was reproduced → what changed → the test.

### R-1 — Retention was never enforced on a frequently restarted server

*(`fix: enforce retention on boot, and say so when it fails`)*

**Wrong:** `startRetentionWorker` armed `setInterval(run, 24h)` and never called
`run()`. The first sweep was a full day after boot, so a deployment restarted
more often than daily enforced the published retention periods **never**, while
`/health` reported ok and the Privacy Policy kept promising them.

**Reproduced:** seed an `admin_audit_logs` row 395 days old, call
`startRetentionWorker(db)`, advance no timers — the row is still there.

**Changed:** one `run()` call before the interval is armed, matching
`autoSelectScheduler.js`, which already documents this exact startup-recovery
reasoning. Safe at boot because the sweep is idempotent, deletes only by age, and
asserts the preserved tables before committing.

**Tests:** `retentionWorker.scheduler.test.js` — startup sweep, interval still
armed at 24 h, double-start idempotent.

### R-2 — A failing retention sweep reached no dashboard and no alert

*(same commit)*

**Wrong:** the catch block was a bare `console.error`. Every other background job
reports via `recordError`; retention did not — and retention is the one holding
`assertPreservedTablesUntouched`, the guard on certificates, credited hours and
safety evidence. That assertion firing is the most consequential event this
system can detect and it landed in a journal line nobody reads.

**Reproduced:** a db proxy that throws on the sweep's first read while leaving the
error tables writable → one log line, zero `error_groups` rows.

**Changed:** `reportRetentionError()` mirroring `notificationWorker`'s
`reportWorkerError`, with `context.component = 'retentionWorker'`.

**Tests:** dashboard row created, attributed to this component, and a sweep
failure not escaping into the boot path.

### R-3 — A reinstated appellant was told they were suspended for nothing

*(`fix: show a reinstated appellant what they were suspended for`)*

**Wrong:** `GET /api/appeals/token/:token` falls back from the live `users`
columns to the frozen snapshots on the appeal, but the query feeding `appeal`
never selected `suspension_reason_snapshot` — so the fallback read `undefined`
and collapsed to `null`. `suspendedAt` had no fallback at all. Since
`POST /unsuspend` NULLs the live columns, the moment an appeal **succeeded** the
student opening their link saw no reason and no date. That is the one reader
migration 015 froze those columns for.

**Reproduced:** suspend → file appeal → unsuspend → `GET` the token route:
`suspensionReason: null` against a snapshot column holding the real text.

**Changed:** select both snapshot columns; add the `suspendedAt` fallback.

**Tests:** the reinstated case asserted **through HTTP** (the row was always
right — the defect was entirely in the reading), plus the still-suspended case so
nobody "fixes" it by preferring a stale snapshot over the live reason.

### R-4 — Deleting your account manufactured false alerts

*(`fix: stop mailing deleted accounts and calling it an incident`)*

**Wrong:** deletion does not clear `notification_jobs` (which has no `user_id`
column — the id is inside the JSON payload), so queued mail was posted to
`deleted_<id>@system.local`. `.local` is reserved by RFC 6762 and resolves
nowhere, so in production: five attempts over ~62 minutes, then `failed`, then
`notificationJobExhausted` — a dashboard row **and an alert email** for mail
that was correctly undeliverable, plus a hard bounce per attempt against the
district's sending domain.

The damage is to the alert channel. A channel that cries wolf gets filtered, and
then the next real outage is missed.

**Reproduced:** stub `sendMail`, queue a job for a `deleted` account, run one
tick — `sent === ['deleted_gone-1@system.local']`.

**Changed:** `handleEmailJob` reads `account_status` and drops the job when
`deleted`. Checked at send time rather than purged at deletion time, so it also
covers a job enqueued by a request that lost the race, needs no `json_extract`
scan in the deletion transaction, and needs no schema change.

**Tests:** not posted, dropped without an `error_groups` row, active account
still delivered, **suspended account still delivered** (that is how appeal
notices reach anyone — widening this to "not active" would cut off the only
channel a suspended student has), and a nonexistent row still retrying.

### R-5 — A gate test that failed randomly

*(`test: pin the mock-OAuth refusal, and stop the taxonomy guard flaking`)*

**Wrong:** `offers nothing the server would reject` loops **18** report
categories, building a full conversation fixture per iteration with bcrypt in
the loop, against vitest's 5000 ms default. Measured ~2.0–2.1 s isolated,
**5122 ms** under full-suite parallel load — the failing run was ~2% over the
line. Not TD-11: nothing crashed, the work did not fit.

**Changed:** a measured explicit 20 s budget on the two loop tests in that file
(~10× isolated, ~4× worst-observed). The global default stays 5000 ms so a truly
hung test still fails fast, and the taxonomy the guard covers is not trimmed to
fit a timer.

**Verified:** four consecutive clean full-suite runs.

---

## 7. Tests added

No existing test was removed or weakened.

| File | Tests | Covers |
|---|---|---|
| `server/retentionWorker.scheduler.test.js` *(new)* | 7 | startup sweep, interval armed, double-start idempotent, dashboard reporting, component attribution, no escape into boot |
| `server/notificationWorker.deletedRecipient.test.js` *(new)* | 5 | placeholder never mailed, dropped not failed, active delivered, **suspended delivered**, nonexistent row still retries |
| `server/config.oauthRedirect.test.js` | +6 | mock-OAuth production refusal, message quality, refusal with real credentials, default OFF, providers not force-enabled, dev unaffected |
| `server/appealsRoutes.test.js` | +2 | reinstated appellant sees reason + date via HTTP; live reason preferred while suspended |

**Totals:** 2946 → **2977 tests**, 176 → **178 files**. Baseline (before this
audit) was 175 passed / 1 skipped.

---

## 8. Disaster recovery

Simulated by reading the mechanism and, where possible, exercising it. **What was
not done is stated.**

| Scenario | Detection | Recovery | Remaining weakness |
|---|---|---|---|
| **Database corruption** | `/health` 503 (`database: disconnected`); `integrity_check` in `backup.sh` refuses to keep a bad backup | Restore latest verified archive; `verify-restore.sh` rehearses the whole path incl. a `/health` check | RPO is up to 24 h (nightly timer). Acceptable for this workload, but it is a real 24-hour window and should be a stated expectation, not a discovery |
| **Server crash** | systemd `Restart=on-failure`, `RestartSec=5`; `/health` for the monitor | Automatic. `notificationWorker.reclaimStaleJobs()` and `reclaimStaleExports()` recover jobs orphaned mid-send at boot; `autoSelectScheduler` runs a catch-up sweep; **`retentionWorker` now does too (R-1)** | `StartLimitBurst=5` in 120 s leaves the service **down** until `systemctl reset-failed`. The worker error handling exists specifically so a full disk degrades mail rather than crash-looping — but if it ever does burn the limit, recovery is manual and unalerted |
| **Failed migration** | Each migration runs in its own transaction; checksums re-verified every boot; `foreign_key_check` before commit on the sanctioned rebuild | Boot refuses; `ENGINEERING_GUIDE §8.5` distinguishes the three causes of a checksum failure and their different fixes | Not simulated against a real half-applied migration in this audit. The design is sound and idempotency is asserted per migration, but a live rehearsal was not performed |
| **Email provider outage** | `getMailHealth()`; queue depth via `getQueueHealth()`; exhaustion logs and alerts | Backoff to 5 attempts (~62 min), then `failed` with the reason retained; **application state is never mutated by a send failure** — sends happen outside the state transaction | An outage longer than ~62 minutes permanently abandons queued notifications. Bounded, visible, and a deliberate trade-off — but there is no requeue tool for the abandoned set |
| **Lost session state** | Client sees 401 | Sessions are stateless JWTs in cookies; nothing to restore. `token_version` and `revoked_sessions` survive in the database. Rate-limit counters are per-process memory and reset on restart | A restart resets every limiter, so login throttling is briefly relaxed after a crash loop. Account-keyed lockout state is in the database, so the security-critical half survives |

**Not verified in this audit:** no database was actually corrupted, no migration
was actually half-applied, and no restore was run against a real production
backup. `verify-restore.sh` exists and reads correctly; it was **not executed**
here because there is no production archive to execute it against. Running it
once against a real backup is on the checklist.

---

## 9. Launch recommendation

## **NOT READY — BLOCKERS REMAIN**

**The code is ready. The operation is not yet proven.**

All four gates pass on the current branch, verified in order:

```
npm ci      PASS
npm test    178 files, 2977 tests passed        (4 consecutive clean runs)
npm run build  built in 527ms
npm run lint   clean
```

No unmitigated security defect was found. The two dependency advisories were each
traced to a code path this application does not use. The four defects found were
fixed with failing-first regression tests. The authorization spine, step-up
re-authentication, evidence preservation and retention machinery are unusually
well defended, and the reasoning behind each control is recorded where the
control lives.

**The blockers are not code. They are operational controls that are shipped as
documentation and cannot be verified from this repository:**

1. **I-1 — a failed backup notifies nobody.** No `OnFailure=` on the backup unit.
   A failed unit nobody looks at is the same as no backup, on a platform holding
   minors' service-hour records. **Must be configured before go-live.**
2. **I-2 — error alerting is off by default.** `ALERT_EMAIL` unset means the
   application records every failure perfectly and tells no one.
3. **I-4 — the deployment does not exist yet.** TLS, `BIND_ADDRESS=127.0.0.1`,
   the firewall on `API_PORT`, `TRUST_PROXY`, volume persistence, and
   `NODE_ENV=production` itself are all unverified. Given S-2, `NODE_ENV` in
   particular is a single variable standing between the shipped posture and a
   forged-identity sign-in endpoint.
4. **No restore has ever been rehearsed against a real archive.** The tooling is
   excellent. An untested backup is a hypothesis.

None of these requires a code change. Every one is a checklist item in §10, and
all of them are closable in a single deployment session.

**Recommendation:** complete §10, capture the evidence, and re-issue this verdict
as READY. The engineering work is done; what remains is proving the machine it
runs on.

---

## 10. Deployment checklist

Sign off each line with evidence, not intent.

### Before first boot

- [ ] `NODE_ENV=production` present in `/etc/wevolunteer/wevolunteer.env` — **verify by reading the file**, not by assuming the template was copied intact. *(S-2: this one variable controls every fail-closed guard.)*
- [ ] `JWT_SECRET` generated with `openssl rand -base64 48`, never from a template
- [ ] `APP_URL` set to the real https origin, no trailing slash
- [ ] `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` all set; `EMAIL_FROM` covered by SPF/DKIM
- [ ] `WEV_DB_PATH` outside `/srv/wevolunteer`, matching `wevolunteer-backup.service`
- [ ] `BIND_ADDRESS=127.0.0.1` **and** a firewall rule on `API_PORT` (belt and braces — the default is `0.0.0.0`)
- [ ] `TRUST_PROXY` equals the actual number of proxies in front of the app
- [ ] `CORS_ORIGINS` set to the public origin
- [ ] **`ALERT_EMAIL` set** *(I-2 — the only reason anyone looks at the dashboard)*
- [ ] `DEMO_MODE` absent entirely
- [ ] If using OAuth: client id + secret + `OAUTH_REDIRECT_URI` naming this deployment, registered byte-for-byte with the provider; `OAUTH_ALLOW_MOCK` **absent**
- [ ] `node --version` is 24.x as the `wev` service user (not via nvm — the unit runs with `nologin`)
- [ ] `bin/install-hooks.sh` run on any machine that will commit

### Boot and verify

- [ ] Service starts clean; journal shows no `FATAL` and no `[Security] Listening on 0.0.0.0`
- [ ] `/health` returns `{"status":"ok","database":"connected","writable":true,"version":"1.2.0"}`
- [ ] **The SPA loads.** A blank page here means `NODE_ENV` is not `production` (S-2) — fix it before going further
- [ ] Migration checksums verified on boot with no warnings
- [ ] Legal documents verified against pinned hashes (fatal in production, so a clean boot proves it)
- [ ] `npm run verify:hours --workspace=server` exits zero
- [ ] Instance lock holds: a second `node server/server.js` refuses to start

### Infrastructure

- [ ] HTTPS with a valid certificate; HTTP→HTTPS redirect confirmed; renewal automated and *tested*
- [ ] nginx passes `Host` through (`proxy_set_header Host $host`) — the CORS same-origin check depends on it
- [ ] WebSocket upgrade proxied (realtime notifications and messaging depend on it)
- [ ] Database directory on persistent, backed-up storage owned by `wev`
- [ ] `WEV_EXPORT_DIR` on durable storage — **not** `/tmp`, which `PrivateTmp=true` destroys on every restart while the database still promises the file for seven days
- [ ] `wevolunteer-backup.timer` enabled; one run completed successfully
- [ ] **`OnFailure=` drop-in added to `wevolunteer-backup.service`** *(I-1 — launch blocker)*
- [ ] **`bin/verify-restore.sh` run against a real archive, and it passed** *(§8 — an untested backup is a hypothesis)*
- [ ] Uptime monitor alerting on two consecutive `/health` failures
- [ ] Log rotation configured for the journal

### First week

- [ ] Confirm the retention sweep logged on the first boot after deploy *(R-1 — it now runs at startup; this is the evidence that it did)*
- [ ] Send one real email end-to-end (verification) and confirm delivery, not just a 200
- [ ] Trigger one deliberate server error and confirm the alert email arrives
- [ ] Review `/errors` for anything the pilot surfaced
- [ ] Confirm `notification_jobs` has no growing `failed` backlog
- [ ] Add `npm audit --omit=dev` to CI or enable Dependabot *(I-3)*
- [ ] Track the react-router 8.x upgrade for GHSA-qwww-vcr4-c8h2 *(S-3 — not exploitable here, but the advisory has no in-range fix)*
