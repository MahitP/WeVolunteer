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
      # Must print nothing. If it prints a route, the destructive demo-reset
      # endpoint is still in the build.
      git show $REF:server/routes/accountRoutes.js | grep "router.post('/api/auth/reset'"

      # Must print 0. Any hit means waitlist promotion is still gated on
      # auto_approve, so promotion silently never fires on organizer-run events.
      git show $REF:server/routes/applicationRoutes.js | grep -c 'auto_approve === 1'

      # Must be non-zero. 0 means APPLICATION_WAITLISTED is unmapped and
      # waitlisted students receive "You have a new notification."
      git show $REF:server/services/notificationContent.js | grep -c APPLICATION_WAITLISTED
      ```
- [ ] `npm test` passes **on a clean checkout of the release ref**, not in your
      working directory.
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
- [ ] **Off-host copy configured.** This is the one gap the project does not close
      for you: `WEV_BACKUP_DIR` defaults to the same disk as the database, so a
      volume failure loses the records and every archive together. Add an rsync,
      an object-store push, or a snapshot schedule — whatever the district already
      has. Do not skip this because everything else in this section passed.
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
- **Off-host backup automation.** Checklist item, not shipped code.
- **Backup failure alerting.** Deliberately not shipped; see §6.
