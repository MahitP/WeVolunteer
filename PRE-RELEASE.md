# Before WeVolunteer goes live

The single source of truth for launch. Everything here is either an action only
you can take, or a switch that must be flipped in production.

Each item says what happens if it is skipped, because that is what decides the
order.

Last reviewed: 2026-08-14, against the live Resend account.

---

## 1. Security

### Rotate the Resend API key — do this first

The key currently in `.env` was pasted into a chat conversation. Treat it as
disclosed. There is exactly one key on the account today, named `WeVolunteer`.

- [ ] Create a new key (Resend dashboard, or `create-api-key` over the MCP) with
      **send permission only**. The token is shown once.
- [ ] Put it in the production environment file as `RESEND_API_KEY`, mode 0600
- [ ] Restart the service — the key is read per call, so no code change
- [ ] Send one real message and confirm it arrives
- [ ] **Then** delete the old key. Not before: anything still holding it stops
      working the moment it is removed
- [ ] Confirm `.env` is still `chmod 600` and untracked (`git check-ignore .env`)

**If skipped:** anybody who has seen that chat log can send mail as your domain
— password-reset lookalikes to your own students, from an address that passes
your SPF and DKIM.

### Rotate the other secrets if the old commit is reachable

`.gitignore:98` records that `.env` was committed once (audit finding C-3). If
that commit is still in history, `JWT_SECRET`, `TFA_ENCRYPTION_KEY`, the SMTP
app password and the Google OAuth client secret should all be rotated too.

- [x] **Checked 2026-08-15: the commit is NOT reachable.**
      `git log --all -- .env` returns nothing, so no reachable ref carries the
      file. Rotation is not required *on these grounds* — but read the next item
      before concluding those four secrets were never exposed.

### The pre-remediation backup still holds the live secrets, world-readable

`.env.backup-20260809-preremediation` sits beside `.env` in the repository root.
It is gitignored, so it is not in history and not the finding above. The problem
is on disk:

- ~~It is mode **644**~~ — **done 2026-08-19**, now `600`. That was the one step
  here safe to take without deciding anything, so it was taken.
- Its values are not stale. Re-verified 2026-08-19 by comparing hashes rather
  than reading the values: `JWT_SECRET`, `GOOGLE_CLIENT_SECRET` and `SMTP_PASS`
  are still **byte-identical to the current `.env`**. `TFA_ENCRYPTION_KEY` now
  **differs** — it has been rotated since the copy was taken, so the original
  "all four" is no longer accurate and three is the live count. "Pre
  remediation" describes when the copy was taken, not what it contains.

So the care taken over `.env`'s permissions is undone by a world-readable copy of
the same four secrets one directory listing away. Any other account or process on
that machine can read the token-signing key and the key that decrypts stored 2FA
secrets.

- [x] Tighten it now, before deciding anything else — **done 2026-08-19**:
      ```bash
      chmod 600 .env.backup-20260809-preremediation
      ```
- [ ] Then delete it, or move it to the password manager. Left in place
      deliberately: deleting a file holding three live secrets is the owner's
      decision, and the permissions fix already removes the exposure that made
      it urgent. A backup of secrets
      that is not encrypted and not needed is only a second place to lose them
      from. Use `trash`, not `rm`.
- [ ] If that machine is shared, or has been, treat all four as disclosed and
      rotate them along with the Resend key above.

---

## 2. Resend

The domain work is **already done** — see "Already completed" at the bottom
before working through this.

- [ ] Create the delivery webhook, once the production site is serving:
      - endpoint `https://wevolunteers.org/api/webhooks/resend`
      - events: `email.sent`, `email.delivered`, `email.delivery_delayed`,
        `email.bounced`, `email.complained`, `email.failed`
      - **not** `email.opened` or `email.clicked`
- [ ] Put the signing secret it returns into `RESEND_WEBHOOK_SECRET`. It is
      shown once
- [ ] Confirm `/api/admin/system/status` reports `delivery.configured: true`
- [ ] Send a real authentication email and confirm `From` is
      `WeVolunteer <noreply@wevolunteers.org>`
- [ ] Confirm password reset works end to end
- [ ] Confirm email verification works end to end
- [ ] Confirm email 2FA works end to end
- [ ] Confirm Gmail/SMTP is still configured as the fallback
- [ ] Test a controlled fallback: set an invalid `RESEND_API_KEY` on a staging
      instance and confirm mail still goes via SMTP
- [ ] Confirm queued mail drains — stop both providers, send, restore, watch the
      outbox empty
- [ ] Confirm no provider secret appears in the journal

**If the webhook is skipped:** everything still sends. What you lose is knowing
what became of it — a message accepted by Resend and then hard-bounced looks
identical to a delivered one, and `delivery_state` stays NULL forever.

---

## 3. Domain and DNS

**Already verified.** `wevolunteers.org` exists in Resend, status `verified`,
sending enabled, with DKIM (TXT), SPF (MX) and SPF (TXT) all reporting
`verified`. Open and click tracking are both off, which is the intended setting.

- [ ] Publish a DMARC record if you have not — start at `p=none` and read the
      reports before tightening
- [ ] Create the mailboxes or forwards that actually receive mail:
      `admin@` `security@` `legal@` `privacy@` `platform@` `contact@` `support@`
      `mahit@`
- [ ] Confirm `noreply@` is deliverable but discards replies
- [ ] Open one message per category in Gmail, Outlook and Apple Mail

**If the mailboxes are skipped:** the published legal policies now name real
departmental addresses. A missing mailbox means a policy tells a student to
write somewhere that bounces.

---

## 4. OAuth

External consoles — these cannot be changed from the repository.

- [ ] Google Cloud Console → Credentials → OAuth client → Authorised redirect
      URIs: add `https://wevolunteers.org/oauth/callback`, byte for byte
- [ ] Microsoft Entra → App registrations → Redirect URI, platform **Web**, same
      value
- [ ] **Keep** `http://localhost:5173/oauth/callback` on the *development*
      client — it is how anybody works on this
- [ ] **Remove** any localhost redirect from the *production* client
- [ ] OAuth consent screen → user type Internal, if this is a Workspace district
- [ ] Record the client-secret expiry dates somewhere with a reminder
- [ ] Set `OAUTH_REDIRECT_URI` and `CORS_ORIGINS` in the production environment
- [ ] Sign in with Google in production and confirm the redirect lands on
      `wevolunteers.org`, not an old deployment URL
- [ ] Sign in with Microsoft and confirm the same

**If the production localhost redirect is skipped:** a forgotten environment
variable turns into a leaked authorization code. The runbook calls this out at
`docs/operations/pilot-deployment-runbook.md:875`.

---

## 5. Production environment

- [ ] `APP_URL=https://wevolunteers.org` — boot refuses without it, and refuses
      plain http
- [ ] `MAIL_DOMAIN=wevolunteers.org`
- [ ] `TRUST_PROXY=1` behind nginx — boot refuses without it in production
- [ ] `JWT_SECRET` and `TFA_ENCRYPTION_KEY` are real generated values, not the
      published development ones
- [ ] `WEV_DB_PATH` points outside the deploy directory
- [ ] `BIND_ADDRESS=127.0.0.1`, port firewalled
- [ ] `ALERT_EMAIL` set, or operator alerting is silently off
- [ ] `RESEND_API_KEY` set; SMTP set as fallback, or accept the "no fallback"
      warning at boot as a decision
- [ ] `WEV_BACKUP_PUBKEY` points at the backup certificate — see §9

### Bootstrap an owner — the platform has none until you do

A fresh production database has **zero** super-admins. The boot log says so:

```
[ownership] WARNING: Platform has ZERO owners. Super admin access is completely lost.
```

Nothing inside the application can grant the first one, so this cannot be
recovered from the UI.

- [ ] `node bin/grant-ownership.mjs` against the production database, once, after
      the first deploy and after your own account exists
- [ ] Sign in and confirm you can reach `/admin`
- [ ] Set `PLATFORM_OWNER_USERNAME` so the public About page names the right
      account

**If skipped:** the deployment comes up with no administrator, no way to appoint
one, and no way to action a safety report.

---

## 6. Legal

**Enforcement is now ON.** `LEGAL_HASHES_ENFORCED = true`, all 12 documents match
their pinned hashes, and a production server refuses to boot if one drifts.

Editing a published policy is therefore no longer an edit: change the file, run
`node bin/legal-hashes.mjs`, paste the printed constant into `LEGAL_DOCUMENTS`,
and decide whether the change is MAJOR (re-acceptance) or MINOR (notice only).

- [x] Run `node bin/legal-hashes.mjs` — all 12 documents report matching
- [x] Set `LEGAL_HASHES_ENFORCED = true` in `server/legalDocuments.js`
- [ ] Boot once and confirm
      `[legal] 12 published documents verified against their pinned hashes` — this
      line now prints in production too; it previously did not
- [ ] Open each policy in the Legal Center and confirm it still renders
- [ ] Re-run the suite: `server/consent.test.js` has a case that is skipped
      while the flag is false and starts running when it is true

**If skipped:** the consent records claim students agreed to a version of a
document nobody can reproduce — the one thing the consent system exists to be
able to prove.

**After this point** editing a published policy is a version bump, not an edit.
The in-place v1.0 reset has already been used once and is not available again.

### Decide the youth-safety reporting channel

`docs/legal/policies/08-youth-safety-guidelines.md` routes child-safety reports
to `security@wevolunteers.org`, the closest fit among the nine addresses.

- [ ] Decide whether that stays, or whether a dedicated `safety@` is created
- [ ] If it changes: edit, re-run `bin/legal-hashes.mjs`, re-pin, and bump the
      version if enforcement is already on

---

## 7. Analytics (Amplitude)

**The two decisions are made.** Analytics is opt-in per account, and Session
Replay stays at `sampleRate: 1` but records almost nothing until somebody opts
in. Both are implemented; what remains below are tasks, not questions.

### What ships

- **Off for everyone.** `users.analytics_consent` (migration 052) is `NULL` for
  every account — "never asked", which is not consent. Verified against a copy of
  `pilot.db`: 18 users, 18 NULL, 0 granted.
- **Nothing runs for a signed-out visitor**, because nobody who has not signed in
  has been asked. Confirmed in a browser: Amplitude's `engagement-wrapper` node,
  previously always in the DOM, is absent.
- **The switch is in Settings → Privacy**, beside the other privacy controls.
  There is deliberately **no prompt, banner or nudge** — a consent control that
  chases people collects consent from people who wanted the dialog to go away.
- **Turning it off stops recording in the current tab**, via `setOptOut`, not at
  the next reload.
- **Masking is `conservative`**: all inputs *and* all page text. Amplitude's
  default is `medium`, which its own source documents as "text is NOT masked" —
  wrong here, because everything sensitive on this platform is rendered rather
  than typed.
- **The 2FA screen is blocked outright**, not masked. The enrolment QR is an
  `<img>` whose data URL encodes the `otpauth://` secret, and no mask level
  touches an image attribute.
- **Reset and verification links are rewritten** before the recorder stores them,
  using Amplitude's own UGC filter rules.

### Tasks

- [ ] **Use a separate Amplitude project per environment.** Still outstanding and
      now more pressing, because analytics genuinely works: one key across dev and
      production puts developer clicks in the same dataset as student activity.
      The `environment` event property is a marker, not isolation.
- [ ] **Treat the Amplitude account as privileged.** Its remote configuration can
      switch on console capture and network request/response body capture — from
      the dashboard, with no code change and no deploy. Put 2FA on it and record
      who holds it.
- [ ] **Do not set `VITE_AMPLITUDE_API_KEY` in production until the above is
      done.** With it unset the SDK is inert and the published Cookie Notice is
      true either way; with it set, only people who opt in are measured.
- [ ] Remove `prompt_version: 'BA400.4'` from `src/hooks/useAnalyticsConsent.js`
      once the first event has been seen in Amplitude's live feed.
      **Note:** that event only fires for a *consenting, signed-in* person landing
      on `/`. It can no longer fire for an anonymous visitor on the landing page,
      so opt in on a test account to see it.

**If skipped:** setting the key without the separate project is survivable. Not
securing the Amplitude account is not — dashboard access is equivalent to the
ability to start capturing API response bodies from every consenting student's
browser.

### Corrected from the audit

The "Invalid hook call — more than one copy of React" warning recorded here
previously **did not reproduce** across three clean page loads during the
release-candidate audit, despite the engagement bundle being mounted. Treat it as
observed once, not as current behaviour.

---

## 8. Email testing

- [ ] Sign up as a real student on the real domain; confirm the verification
      email arrives **in the inbox, not spam**
- [ ] Password reset end to end
- [ ] Email 2FA end to end
- [ ] An enforcement notice — confirm it comes from `admin@`, not `noreply@`
- [ ] ~~A legal-update notice — confirm it comes from `legal@`~~ **Not testable;
      nothing sends one.** `LEGAL_DOCUMENT_UPDATED` has notification copy, a
      mandatory-notice exemption and a `legal@` identity mapping, and no code
      path anywhere dispatches it. The promise the Terms make — "we will tell you
      in the app" — is kept by `LegalUpdateModal`, which pulls
      `pendingNoticesFor()` on load; the push half was built and never wired.
      Deliberately left unwired rather than switched on during a launch pass:
      turning it on emails every account on the platform the next time a policy
      is published, and that is a decision about volume and tone, not a defect
      to quietly repair. See the Final Launch Readiness Report, P1.
- [ ] Confirm no email carries a `Reply-To` on an authentication message
- [ ] Confirm the same message looks identical whether Resend or SMTP sent it

---

## 9. Database and migrations

> **These steps were written for SQLite and do not apply to the Supabase
> deployment.** Corrected 2026-08-19. `PRAGMA integrity_check` and
> `PRAGMA foreign_key_check` do not exist on PostgreSQL, and the 55 migrations
> never run there — `server/db/postgresSchema.js` is generated by replaying them
> and applied in one step, so "migrations reach head 55" is not a thing to
> confirm. Following the old list would have produced either errors or false
> confidence.

- [ ] Back up the production database before the first deploy —
      `pg_dump --format=custom "$DATABASE_URL" > pre-deploy.dump`
- [ ] Confirm the schema is present and complete:
      65 tables, 87 foreign keys, 171 indexes
      (`docs/operations/postgres-cutover-and-rollback.md` has the queries)
- [ ] Confirm the reserved actor exists and is tombstoned:
      `system-cli`, `account_status = 'deleted'`
- [ ] Restart once and confirm the boot is idempotent — `applyPostgresSchema()`
      is `CREATE TABLE IF NOT EXISTS` throughout and must report
      `[db] postgres: schema applied` without changing anything
- [ ] `/health` returns `writable: true` — that is a real write reaching the
      database, not just a socket that opened
- [ ] Rehearse a restore with `pg_restore`, **not** `bin/verify-restore.sh`
      (that script is `sqlite3` only). The round trip is already rehearsed and
      recorded in the cutover document.

### The nightly backup unit does not cover Supabase

`deploy/wevolunteer-backup.service` runs `bin/backup.sh` with
`WEV_DB_PATH=/var/lib/wevolunteer/wevolunteer.db`, and that script is a
`sqlite3 .backup`. Against a PostgreSQL deployment there is no such file and
nothing to copy, so **the scheduled backup does not protect the production
database**. Verified by reading both, 2026-08-19.

The app now says so rather than staying quiet: `backupStatus()` reports
`unconfigured` when the backup directory does not exist, and as of 2026-08-19
that state alerts **in production** (it stays silent in development, where it
only means a laptop). Before this, a Supabase host with no backups at all was
the one state that produced no alert.

- [ ] Decide the production backup model and write it down. Two viable answers:
      - **Supabase managed backups.** Confirm in the dashboard what the plan
        actually retains — daily snapshots and whether point-in-time recovery is
        included differs by plan, and this must be checked rather than assumed.
        Record the retention window and the recovery point.
      - **A `pg_dump` schedule** you control, written to storage the database
        host cannot read back, encrypted with the same public-key approach
        below.
- [ ] Whichever you choose, rehearse one restore end to end before the first
      real student signs up.
- [ ] If you keep the SQLite backup timer running for the legacy pilot file,
      keep it pointed at that file and do not treat its success as covering
      production.

### Encrypt the backups — do this before the first real student signs up

> The public-key approach below is sound and applies to a `pg_dump` archive just
> as it does to a SQLite one; only the command that produces the archive
> changes. The `sqlite3`-specific verification at the end of this section
> applies to the legacy pilot file only.

A backup holds every student's name, address, school, year group, service
record, messages and safety reports. Unencrypted, one copy of it is a complete
copy of the platform's personal data with none of the access control.

`bin/backup.sh` encrypts to a **public key**, so the host can write backups and
cannot read them. The private key never touches the server.

```bash
openssl req -x509 -newkey rsa:4096 -keyout wev-backup-key.pem \
  -out wev-backup-cert.pem -days 3650 -nodes -subj "/CN=wevolunteer-backup"
```

- [ ] Generate the pair **off the server**
- [ ] Copy only `wev-backup-cert.pem` to the host; set `WEV_BACKUP_PUBKEY` to it
- [ ] Store `wev-backup-key.pem` somewhere you will still have it in three years
      and an attacker on the server will not — a password manager, not the host
- [ ] Run `bin/backup.sh` once and confirm the output is `.db.gz.enc`
- [ ] Rehearse the restore, end to end:
      ```bash
      openssl cms -decrypt -binary -inform DER -in <archive>.db.gz.enc \
        -inkey wev-backup-key.pem | gunzip > restored.db
      sqlite3 restored.db 'PRAGMA integrity_check;'
      ```

**If the key is lost, every backup is lost.** That is the trade for the host not
being able to read them, and it is the right trade — but only if the key is
genuinely kept.

**If skipped:** backups still run and still say so on every line of the log
(`WARNING: this backup is NOT encrypted`). The failure is silent to everyone who
does not read that log.

### Confirm someone hears about a failed backup

The app now emails `ALERT_EMAIL` when the newest archive goes stale, on the
existing sweep — separately from error alerts, because a system whose backups
fail is usually otherwise healthy and generates no errors at all.

- [ ] `ALERT_EMAIL` is set, or backup alerting is silently off
- [ ] Confirm `/api/admin/system/status` reports `backup.status: "ok"` and
      `backup.encrypted: true` after the first nightly run

---

## 10. Browser QA

- [ ] Sign-up, login, verification, reset, 2FA on the production domain
- [ ] Public profile, event, certificate and organization links all resolve to
      `wevolunteers.org`
- [ ] Legal Center loads every document
- [ ] Support and contact links open the right mailbox
- [ ] 320 / 375 / 390 / 768 / 1280 — no console errors, no failed requests, no
      horizontal overflow

---

## 11. Final launch verification

- [ ] `npm test`, `npm run lint`, `npm run build`, `npm audit --omit=dev`
- [ ] `/api/admin/system/status` shows both providers configured, an empty
      outbox, and `delivery.configured: true`
- [ ] Send one message of each identity category and open them
- [ ] Confirm a backup ran after go-live

---

## Already completed — do not redo

Live concerns that are now closed. Listed so nobody reopens them.

- **`wevolunteers.org` is verified in Resend.** Sending enabled; DKIM, SPF MX
  and SPF TXT all `verified`. Open and click tracking off.
- **Two-factor sign-in works on the pilot database again** (migration 055).
  Every second-factor submission there answered `HTTP 500` — correct code and
  wrong one alike, email and recovery both — because `tfa_login_attempts` had
  been created outside the migration system with `preauth_jti` as its key where
  the sign-in path writes `token_hash`. Migration 025 uses
  `CREATE TABLE IF NOT EXISTS`, which does not compare shapes, so it saw the name
  and recorded itself as applied. Every test builds the table from scratch and
  passed; the only database anyone signs in to could not complete a sign-in.
  Verified closed against `pilot.db`: head is 55 and the column is `token_hash`.
- **Auth tokens are hashed at rest** (migration 048). They were stored plaintext,
  which made any readable copy of the database a set of keys to every account
  with an outstanding reset.
- **Transactional mail has a durable outbox** (migration 047). It previously had
  three in-process retries and no record, so a four-second outage silently lost
  verification emails.
- **Delivery outcomes are recorded** (migration 050) once the webhook exists.
- **Every authentication message sends from `noreply@wevolunteers.org`**,
  enforced in `server/emailIdentity.js` rather than by convention.
- **The retired domains** (`wevolunteer.org` singular, `wevolunteer.app`) and the
  personal Gmail address are gone from shipped code and all twelve policies.
- **Appeals are rate limited** to 5 per person per subject per rolling 30 days.
- **Service history and certificates are privacy-gated** (migration 049),
  defaulting to public and enforced server-side.
- **The Resend MCP is documented** at `docs/operations/resend-mcp.md`. It is an
  operator tool; the application does not depend on it at runtime.
