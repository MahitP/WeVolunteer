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

- [ ] Check whether the commit is reachable
- [ ] Rotate all five if it is

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

---

## 6. Legal

- [ ] Run `node bin/legal-hashes.mjs` — all 11 documents must report matching
- [ ] Set `LEGAL_HASHES_ENFORCED = true` in `server/legalDocuments.js`
- [ ] Boot once and confirm
      `[legal] 11 published documents verified against their pinned hashes`
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

## 7. Email testing

- [ ] Sign up as a real student on the real domain; confirm the verification
      email arrives **in the inbox, not spam**
- [ ] Password reset end to end
- [ ] Email 2FA end to end
- [ ] An enforcement notice — confirm it comes from `admin@`, not `noreply@`
- [ ] A legal-update notice — confirm it comes from `legal@`
- [ ] Confirm no email carries a `Reply-To` on an authentication message
- [ ] Confirm the same message looks identical whether Resend or SMTP sent it

---

## 8. Database and migrations

- [ ] Back up the production database before the first deploy
- [ ] Deploy and confirm migrations reach head 50
- [ ] `PRAGMA integrity_check` → `ok`
- [ ] `PRAGMA foreign_key_check` → empty
- [ ] Restart once and confirm 0 migrations apply the second time
- [ ] Rehearse a restore (`bin/verify-restore.sh`)

---

## 9. Browser QA

- [ ] Sign-up, login, verification, reset, 2FA on the production domain
- [ ] Public profile, event, certificate and organization links all resolve to
      `wevolunteers.org`
- [ ] Legal Center loads every document
- [ ] Support and contact links open the right mailbox
- [ ] 320 / 375 / 390 / 768 / 1280 — no console errors, no failed requests, no
      horizontal overflow

---

## 10. Final launch verification

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
  personal Gmail address are gone from shipped code and all eleven policies.
- **Appeals are rate limited** to 5 per person per subject per rolling 30 days.
- **Service history and certificates are privacy-gated** (migration 049),
  defaulting to public and enforced server-side.
- **The Resend MCP is documented** at `docs/operations/resend-mcp.md`. It is an
  operator tool; the application does not depend on it at runtime.
