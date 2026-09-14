# WeVolunteer — Release Checklist

**Created:** 2026-07-31 (release-preparation pass)
**Audience:** whoever is putting a WeVolunteer build onto a real host.
**Companion document:** [`pilot-deployment-runbook.md`](pilot-deployment-runbook.md) —
that one tells you *how* to deploy; this one is the gate you pass before you do.

---

## Why this document exists

A forensic audit on 2026-07-30 found seven ship-blocking defects. All seven were
fixed. But the fixes lived **only in the working tree** — nothing was committed, so
the runbook's own deploy procedure (`git clone`, `git checkout`) would have shipped
the version that still had them, including a `POST /api/auth/reset` endpoint that
destroyed the database instead of resetting it.

That is the failure mode this checklist exists to prevent: **green tests on a
machine are not a release.** Every box below is something that was, at some point in
this project's short history, believed to be true and was not.

---

## 0 — Before you start

- [ ] You know which git ref you are deploying, and it is a **tag or a commit hash**,
      not "the working tree" or "main, probably".
- [ ] `git status --porcelain` on the release ref is **empty**. If it is not, you are
      not deploying what you tested.

---

## 1 — Release integrity (the audit's actual failure)

- [ ] All intended fixes are **committed**. Verify against the deployed ref, not
      your editor:
      ```bash
      REF=<tag-or-sha>
      # Braces around REF are required, not style: in zsh — the default shell on
      # macOS — `$REF:server/...` is parsed as a history modifier and git is
      # handed a mangled path.

      # Must print nothing. If it prints a route, the destructive demo-reset
      # endpoint is still in the build.
      git show ${REF}:server/routes/accountRoutes.js | grep "router.post('/api/auth/reset'"

      # Must print 0. Any hit means waitlist promotion is still gated on
      # auto_approve, so promotion silently never fires on organizer-run events.
      #
      # Comment lines are stripped first, and that is not cosmetic: the fix left
      # behind a comment saying "the `auto_approve === 1` condition that used to
      # be here is gone", so the naive grep now reports 1 and halts a release
      # over the paragraph explaining why there is nothing to halt over. The
      # same false positive already cost this repository a debugging session in
      # a limiter guard.
      git show ${REF}:server/routes/applicationRoutes.js \
        | grep -vE '^\s*(//|\*|/\*)' | grep -c 'auto_approve === 1'

      # Must be non-zero. 0 means APPLICATION_WAITLISTED is unmapped and
      # waitlisted students receive "You have a new notification."
      git show ${REF}:server/services/notificationContent.js | grep -c APPLICATION_WAITLISTED
      ```
- [ ] `npm test` passes **on a clean checkout of the release ref**, not in your
      working directory.
- [ ] **`npm test` again, against PostgreSQL.** This is a separate item because
      the default run is not the production engine and silently proves less than
      it appears to:
      ```bash
      createdb wev_release_check
      TEST_POSTGRES_URL="postgres://$(whoami)@localhost:5432/wev_release_check" npm test
      dropdb wev_release_check
      ```
      The bare `npm test` runs on SQLite and reports **176 skipped**. Those skips
      are `describe.skipIf(!RUNNING_ON_POSTGRES)` — 143 of them are the
      PostgreSQL dialect, transaction, pooler and concurrency tests, i.e. exactly
      the engine production runs on. With `TEST_POSTGRES_URL` set the run is
      **10,436 passed / 33 skipped**, and a green SQLite run is not evidence
      about PostgreSQL.

      Measured on 2026-09-06: both pass. The point of the item is that a release
      signed off on the SQLite run alone has not tested the production engine.
- [ ] `npm run test:postgres` passes with `TEST_POSTGRES_URL` set — the
      application-level PostgreSQL suite (6,789 tests). Note that this script
      needs `TEST_POSTGRES_URL`; running it bare tests nothing new. Do **not**
      additionally force `DATABASE_ENGINE=postgres` across both vitest projects —
      the parallel test files then share one database and collide, which looks
      like ~190 product failures and is not one.
- [ ] `npm run a11y` passes, with `WEV_DB_PATH` pointed at a scratch database
      (the harness refuses to run without it, on purpose).
- [ ] `npm run build` exits 0.
- [ ] `npm run lint` exits 0. (It exited 1 for a while on two
      `react-hooks(rules-of-hooks)` errors — one of which was a genuine crash when an
      admin approved an organizer who had the dashboard open.)
- [ ] No debug or generated files in the ref:
      ```bash
      git ls-files | grep -E '\.log$|test_output|update_css|\.DS_Store|\.db$|\.zip$'
      # Must print nothing.
      ```
- [ ] No secret material in the ref. The repository ships its own scanner:
      ```bash
      bash bin/pre-commit-secret-scan.sh   # must exit 0
      git ls-files | grep -E '^\.env$'     # must print nothing
      ```
- [ ] `bin/install-hooks.sh` has been run by everyone who commits, so the scanner
      runs pre-commit rather than only here.

---

## 2 — Configuration

Work through §4 and §4a of the runbook. The items below are the ones that bite.

- [ ] `JWT_SECRET` generated with `openssl rand -base64 48`. Not a passphrase — the
      boot guard rejects fewer than 8 distinct characters, and it is right to.
- [ ] `NODE_ENV=production`. **Nothing checks this**, and without it you get none of
      the production guards.
- [ ] `APP_URL` set to the real https origin, no trailing slash.
- [ ] `WEV_DB_PATH` set **outside** `/srv/wevolunteer`, so a redeploy or
      `git clean -xdf` cannot delete the data.
- [ ] `BIND_ADDRESS=127.0.0.1`. The default is `0.0.0.0` — the runbook claimed
      loopback for months and was wrong.
- [ ] `TRUST_PROXY` set to the exact number of proxy hops. Unset behind a proxy
      collapses every user into one rate-limit bucket; set without a proxy lets
      clients forge `X-Forwarded-For`.
- [ ] `CORS_ORIGINS` set to the deployment origin.
- [ ] `DEMO_MODE` **absent**. Combined with production it is fatal, but do not add it.
- [ ] `OAUTH_ALLOW_MOCK` **absent**. Fatal in production, and for good reason.
- [ ] If any OAuth provider is configured, `OAUTH_REDIRECT_URI` names *this*
      deployment. The server refuses to boot otherwise — see §4a.
- [ ] `/etc/wevolunteer/wevolunteer.env` is `chmod 640`, owned `root:wev`.

---

## 3 — Firewall (verify from another machine)

- [ ] `curl -m 5 http://<public-ip>:5050/health` from a **different host** fails.
      If it returns JSON, the Node process is exposed and TLS is being bypassed.
- [ ] `sudo ufw status verbose` does not list the API port.
- [ ] `curl -sS https://<domain>/health` succeeds and returns
      `{"status":"ok","database":"connected","writable":true,...}`.
      The `writable` field is the one that matters: a read-only or full disk used to
      report `ok`.

---

## 4 — SMTP, proven end to end

`REQUIRE_EMAIL_VERIFICATION` **defaults to ON**, so unproven mail means no new
account can be used. This is not a step to defer.

- [ ] A real verification email arrives at a real mailbox, and the link works.
- [ ] A real password-reset email arrives, and the link works.
- [ ] Both links point at your domain — read the URL, do not assume.
- [ ] `EMAIL_FROM` is an address the relay may send as, covered by SPF/DKIM.
- [ ] Check the mail is not landing in spam. Send to a Gmail and an Outlook address.
- [ ] Consider `MAIL_RATE_LIMIT` for signup week. The limiter is now keyed per
      **address** (and per session for `resend-verification`) rather than per IP —
      it used to be 5 per 15 minutes for an entire campus behind one NAT — but a
      large cohort on day one is still worth sizing for.

---

## 5 — OAuth (skip entirely if running email-only)

- [ ] Every step of the runbook §4a smoke test passes, especially step 3: the
      authorize URL must carry your `redirect_uri`, not `localhost`.
- [ ] Step 4 returns 400. Anything that mints a session means the mock transport is
      live — stop the service.
- [ ] A real browser sign-in with a district account completes.

---

## 6 — Backups and restore

- [ ] `sudo systemctl enable --now wevolunteer-backup.timer`.
- [ ] `systemctl list-timers wevolunteer-backup.timer` shows a next run.
- [ ] One run by hand succeeds: `sudo systemctl start wevolunteer-backup.service`,
      and the journal shows a `verified: users=… credited_hours=…` line.
- [ ] **Off-host copy configured.** `WEV_BACKUP_DIR` defaults to the same disk as
      the database, so a volume failure loses the records and every archive
      together. This is no longer a "bring your own" item: set the four `B2_*`
      variables and the nightly run uploads to Backblaze B2, checks B2's own
      record of the object, **downloads it back and compares hashes**, and audits
      what the bucket actually retains. All four or none — a half-configured
      destination is refused rather than silently skipped.
      Full procedure, including the bucket's lifecycle rule and Object Lock
      settings, the three scoped keys, and why no key may have `deleteFiles`:
      [`offsite-backups.md`](offsite-backups.md) §11.
      Do not skip this because everything else in this section passed.
- [ ] **Spending caps set on the B2 account, before the first upload.** A new
      account has none, and without them "$0" is a forecast rather than a
      guarantee. B2 refuses a breached cap instead of billing it — that is the
      reason it was chosen over R2, and it only holds if the caps exist.
      See [`offsite-backups.md`](offsite-backups.md) §10.
- [ ] **The backup private key is NOT on this host.** If
      `/root/backup-keys/backup-key.pem` (or any `WEV_BACKUP_TESTKEY` in the
      environment file) exists, the host can decrypt every archive and the
      encryption is decorative. Confirm the password manager holds a copy, prove
      that copy restores on a machine that is not this one, then `shred -u` the
      one here. **Prove the copy you are keeping works before destroying the one
      you have.**
- [ ] **Weekly restore drill scheduled on a machine that is not this host.**
      `bin/restore-drill-postgres.sh` fetches from B2, decrypts, restores into a
      throwaway cluster and compares against the manifest. It runs where the
      private key already is — deliberately not here, and deliberately with no
      systemd unit, since installing one would put the key back on this host.
      Its verdict travels to the Owner Center through the bucket.
- [ ] **Restore rehearsed**, with the shipped script:
      ```bash
      sudo -u wev WEV_BACKUP_DIR=/var/backups/wevolunteer bin/verify-restore.sh
      ```
      It decompresses the newest archive into a throwaway copy, runs
      `integrity_check` and `foreign_key_check`, asserts the archive actually
      contains accounts, verifies hours-ledger parity, boots the real application
      against it, and confirms `/health` reports writable. It never touches the live
      database. **A backup nobody has restored is a hypothesis.**
- [ ] You have decided what alerts on backup failure. **The unit has no `OnFailure=`
      and the project does not add one** — an alert target is environment-specific.
      Either add a drop-in (`systemctl edit wevolunteer-backup.service`) or accept
      that your only signal is the freshness field on the admin status panel, and
      write down who checks it.

### 6a — Does this release contain a table rebuild?

ENGINEERING_GUIDE §8.3 makes "take a backup first" the first of the six guards a
destructive rebuild must carry. It is also the **only one of the six that no code
enforces**: the other five are assertions inside the migration, and this one is a
person remembering. Migrations run automatically and unattended at boot
(`db.js` → `runMigrations`), so by the time anybody looks, the rebuild has run.

- [ ] Check whether the release adds a migration that rebuilds a table:
      ```bash
      git diff --name-only <last-release-tag>..HEAD -- server/migrations/ | xargs grep -l "ownTransaction" 2>/dev/null
      ```
      A rebuild is recognisable by `ownTransaction: true` plus a `DROP TABLE` —
      `PRAGMA foreign_keys` is a silent no-op inside an open transaction, which
      is the whole reason a rebuild has to manage its own.
- [ ] **If it does:** run `bin/verify-restore.sh` (above) *for this release*, not
      just once at first deployment. §6 is written as a first-deploy section, and
      a rebuild is the one change where a stale rehearsal is not good enough.
      **v1.3 contains one: migration 032 rebuilds `external_hours`.**

---

## 7 — Operational visibility

- [ ] `/api/admin/system/status` returns, as an admin, all of:
      `mail`, `notificationQueue`, `backup`, `hoursLedger`. If you see only
      `smtpConfigured`, you are running an older build — that single field reported
      that three env vars were set, not that mail worked.
- [ ] Someone is named as the person who looks at that panel daily during week one,
      specifically at `backup.status`, `notificationQueue.failed`, and
      `hoursLedger.inParity`.
- [ ] `journalctl -u wevolunteer -f` shows `[req]` lines. Request logging is on by
      default in production; query strings are stripped deliberately, because
      `/?reset=<token>` carries a live credential.
- [ ] Alerts wired for at least: service down, `/health` non-200, disk >85%,
      TLS expiry <14 days, backup stale >26h. See the runbook's monitoring section.

---

## 8 — Restart behaviour

- [ ] `sudo systemctl restart wevolunteer` and confirm in the journal:
      `[Shutdown] SIGTERM received — draining`, then
      `Notification outbox processor stopped`, then `Database closed`, then
      `[Shutdown] Complete (exit 0)`.
      If the service instead takes ~90s and systemd reports a SIGKILL, something is
      holding the event loop open and queued work is being lost on every deploy.
- [ ] After the restart, `/api/admin/system/status` shows
      `notificationQueue.processing` at or near 0 — orphaned jobs are reclaimed on
      startup, so a job stuck in `processing` after a restart means the reclaim did
      not run.

---

## 9 — Data protection

- [ ] `VITE_PRIVACY_URL` set, pointing at a **real** published privacy notice, and
      the signup consent checkbox appears. Left unset the gate is deliberately
      inert — a checkbox pointing at nothing manufactures the appearance of a
      reviewed policy.
- [ ] A data export completes and downloads. Exports are written beside the database
      now, not to `os.tmpdir()` — under systemd's `PrivateTmp=true` the old location
      was destroyed on every restart while the record still promised the file for
      seven days.
- [ ] The export directory is `0700` and on the same backed-up volume as the database.
- [ ] The district has been told, in writing, what is stored and who can see it.

### Making the repository public — a gate, not a step

The working tree is clean: the demo seed and every test fixture use synthetic
identities on reserved `example.*` domains, and a scan of the current tree finds
zero personal addresses. **Git history is a different question, and it is not
resolved by that.**

Until 2026-08-11 the `DEMO_MODE` seed carried real volunteers of a real school —
including students in grades 10 and 11 with full names, working addresses at
consumer domains, a school and a year group — and because those addresses were
the suite's login fixtures they had spread to over a hundred files. Commit
`ae4c5d7` replaced them. Every commit BEFORE it still contains them.

That data is pinned by **nine refs that are published to `origin`**, not one:

- `refs/heads/main` and `refs/heads/claude/fix-ci-db-tooling-qd1gbz`
- `refs/tags/v1.0.0`, `v1.0.0-pilot`, `v1.1.0`
- `refs/tags/backup/pre-scrub-2026-07-31`,
  `backup/main-pre-consolidation-2026-07-31`,
  `backup/v1.1-pre-consolidation-2026-07-31`,
  `archive/stabilization-backup-pre-purge-2026-07-31`

All 408 commits reachable from `origin/main` carry them (earliest `ed2dea1`,
2026-07-20). Rewriting `main` alone would remove nothing, because the four
backup/archive tags exist precisely to pin the pre-rewrite commits — that is what
they are for.

**This does not block the launch.** The repository is private and deliberately so
(see the Licence section of README.md: all rights reserved, no licence granted),
and nothing in the deployment requires publishing it. Launching does not publish
anything.

- [ ] **If the repository is ever made public, this must be resolved first.** The
      options are: rewrite history across all nine refs and force-update them
      (destroys the shared history and every published tag, and any existing
      clone or fork still has the data); publish a fresh repository whose first
      commit is the current clean tree (keeps the data private, loses the public
      development record); or keep it private. Given the subjects include minors,
      the middle option is the one to prefer.
- [ ] Anyone granted collaborator access to the private repository can read the
      historical data. Grant access on that understanding, or resolve the history
      first.

---

## 10 — Credential rotation

- [ ] Google OAuth client secret rotated if it has ever been in a working-tree
      `.env` on a shared or AI-assisted development machine. The audit confirmed the
      secrets are in **no** git object — including unreachable ones — but a
      credential that has sat in a dev checkout should not become the production one.
- [ ] SMTP credential rotated on the same reasoning, and scoped to send-only.
- [ ] `JWT_SECRET` is **newly generated for production** and has never existed in a
      development environment. Rotating it later invalidates every session, which is
      also how you respond to a suspected leak.
- [ ] Microsoft client secret expiry noted in a calendar. Entra secrets expire and
      will outlive the pilot.

---

## 11 — Final gate

- [ ] Run the runbook's §10 production smoke test end to end.
- [ ] Walk one complete student journey on the real deployment: sign up → verify →
      apply → get accepted → attend → hours credited → certificate verifies at its
      public URL.
- [ ] Confirm `POST /api/auth/reset` returns **404** on the live host.
- [ ] Confirm no demo account can log in (`admin@example.gov`, `password123`).
      Expect `no_such_account`. On a database seeded in `DEMO_MODE` that account
      is an administrator behind a published password; it was removed from
      `pilot.db` on 2026-08-08 — see the note at step 6 of the deployment
      runbook for how, and why not with `DELETE`.
- [ ] Confirm the server did not print the `DEMO_MODE is ON over a database that
      already has accounts` banner at boot. It fires whenever demo mode is set
      over a populated database, which the seeding banner never covered.
- [ ] `bin/seed-pilot.js` and `bin/simulate-pilot.js` refuse to run:
      ```bash
      # All three must refuse. These scripts ship to /srv/wevolunteer/bin.
      NODE_ENV=production node bin/seed-pilot.js --yes
      WEV_DB_PATH=/var/lib/wevolunteer/wevolunteer.db node bin/seed-pilot.js --yes
      NODE_ENV=production node bin/simulate-pilot.js --yes
      ```
      Before this pass, the second command **deleted the production database** and
      replaced it with 26 accounts sharing a published password, one of them an
      administrator.

---

## What this checklist does not cover

Stated plainly, because a checklist that implies completeness is worse than one that
admits its edges:

- **Load.** Nothing here has been under a real cohort. The architecture is sized for
  a single district (see the runbook's scaling table), and rate limiting is an
  in-process map — **run exactly one instance.**
- **Auto Select scheduling.** There is still no scheduler; if an organizer forgets to
  run a draw, applicants stay pending and are never told. Run the runbook's
  "pending past deadline" query daily.
- **Off-host backup automation.** Shipped as of 2026-09-13: `bin/backup-offsite.mjs`
  uploads to Backblaze B2 and proves the copy by downloading it back. What is NOT
  shipped is the account — the bucket, its lifecycle rule, its caps and its three
  keys are still a human step (§6, and `offsite-backups.md` §11), and no request
  from this project has ever reached backblazeb2.com.
- **Backup failure alerting.** Now shipped for the cases the application can see:
  a stale or missing local archive, a failed or stale off-site copy, and a failed
  or stale restore drill all email `ALERT_EMAIL` at most twice a day, with a
  subject that distinguishes "backups are not running" from "backups are running
  but the off-site copy is not". What is still NOT shipped is `OnFailure=` on the
  systemd unit: a unit that fails before the application ever sees it — the timer
  disabled, the host down — is invisible to an alerter running inside that host.
  See §6.
