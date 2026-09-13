# WeVolunteer — Production Readiness Pass

**Date:** 2026-09-13
**Start:** `b87b630` (local `main`; `origin/main` at `6b1c1d6`)
**Production:** live, healthy, reporting `1.2.0`. **Not touched** — no deploy,
restart, database write, DNS, Cloudflare, OCI or firewall change. The live site
was only read: public `GET` requests for headers, `/live` and `/ready`.

The pass audited authentication, authorization, CSRF and cookies, rate limits,
headers, uploads, webhooks, WebSockets, database access, backups, observability,
the origin firewall, deployment tooling, dependencies, privacy, Welly,
accessibility and performance. Every finding below was reproduced before it was
fixed, carries a regression test, and — where the property is security-relevant —
was mutation-checked by reverting the fix and watching the test fail.

---

## 1. Fixed

| # | Area | Defect | Commit |
|---|---|---|---|
| 1 | Authorization / privacy | An event's comment thread (author names of students) was readable and writable by a `partner` and by an organizer who had not accepted the Organizer Agreement — both deliberately kept from `directory.read`. Found by a direct-HTTP sweep: the partner was refused the event and handed its thread. | `4e44c9a` |
| 2 | Privacy | The leaderboard (opted-in students' names and hours) had the same gap. | `be513a0` |
| 3 | Authentication | **The Socket.IO handshake accepted the pre-2FA token.** Holding only a 2FA-enrolled administrator's password was enough to join their live feed of messages and notifications. | `8ec0895` |
| 4 | Reliability | `socket.emit('typing.start')` with no payload rejected a promise inside an unawaited listener; `shutdown.js` treats that as fatal. Any signed-in account could stop the server, repeatably. Client packets are now capped at 8 KB. | `8ec0895` |
| 5 | Privacy / audit | A personal-data export archive was streamed before its audit row was written, and a failed write was swallowed. The row is now written in the step-up spend transaction; no row, no bytes. | `13c176a` |
| 6 | Correctness / privacy | **Every event map in production read "API KEY REQUIRED"** — CARTO now requires a key — and tiles were fetched by students' browsers directly (compliance register R-18). Tiles are now proxied at `/tiles`; the key, when there is one, stays server-side; the CSP no longer permits any tile host. | `c266c28` |
| 7 | Headers | **The application page had no Content-Security-Policy and no HSTS in production** — nginx serves it, and helmet ran only on JSON. Headers are rendered for nginx from the same source Express uses, with a drift test. `X-Frame-Options` is `DENY`. | `3793496` |
| 8 | Backups / monitoring | Backup freshness recognised only SQLite archive names, so on PostgreSQL good nightly backups read as "none", and the alert would have mailed "Backups are not running" every twelve hours. | `e009fa4` |
| 9 | Monitoring | Nothing alerted a person when a scheduled job failed or stopped. Backups, the Cloudflare refresh and a new 15-minute host check (disk, memory, restart loops, `/ready`, nginx, origin certificate, backup age) now report to Better Stack heartbeats. | `18f3254` |
| 10 | Reliability | `StartLimitIntervalSec` sat in `[Service]`, where systemd does not read it, so a crash loop restarted forever. The unit's sandbox now also drops capabilities and confines devices, kernel interfaces, namespaces and socket families. | `915a682` |
| 11 | Origin security | Provisioning recognised an existing open-443 rule in one exact spelling. A conntrack or multiport rule stayed **above** the Cloudflare jump — the origin open to the internet — and a `dpt:4430` rule was matched by prefix and deleted. | `9548f51` |
| 12 | CSRF-equivalent | **A same-site page (the marketing apex) could open a socket with the visitor's cookie** and read their messages. The handshake now checks Origin before the cookie, by the rule the HTTP CORS layer uses. | `de9d7ea` |
| 13 | Authorization | A revoked or expired administrator invitation could still promote its holder: the guarded claim's row count was never read, and on PostgreSQL the check and the promotion are separate awaits. | `48cbd90` |

`security-review` was run over commits 1–13: **no findings at the reporting
threshold.**

The first full-suite run afterwards failed four cases in three repository guards
— the CSP source moving files, an unawaited call without `.catch()`, and a new
PostgreSQL skip. Each guard was right; `acfc766` satisfies them, and the export
audit test now runs on both engines.

The skipped tests are environment-gated, not ignored: PostgreSQL-only cases in the
SQLite run and SQLite-only cases in the PostgreSQL run, live-service checks that
need real vendor credentials, the Supavisor pooler case, and the legal-hash
enforcement mode.

---

## 2. Verified already correct

Checked by reading the code and, where marked, by exercising it.

- **Horizontal authorization** — a second organizer, a second student and a
  partner against the seeded host's event, applications, check-in, close-out,
  roster, auto-select, broadcast, comments, conversations, certificates, badges,
  exports: every write refused; reads either refused or privacy-filtered.
  *(exercised)*
- **Vertical authorization** — `authz.matrix.test.js` and the completeness guard
  cover every route; the guard caught the new tile routes until they were gated.
- **Arrival instructions** are withheld server-side from non-attendees in the
  browse list, not only hidden by the client.
- **Session lifecycle** — token version bumps on reset and "sign out others";
  per-session `jti` revocation on logout; deleted accounts refused; forged tokens
  refused; pre-2FA token refused by HTTP middleware.
- **Password reset** — digest stored, one hour, single use, revokes every
  session, never disables 2FA. Recovery codes and emailed 2FA codes are claimed
  with checked, guarded writes; TOTP has replay protection.
- **OAuth** — state is a signed token bound to a browser cookie nonce, a
  single-use server row, PKCE and the OIDC nonce. Full-page redirects, so COOP
  does not interfere.
- **CSRF** — `csrfGuard` for sibling subdomains on HTTP; cookie `HttpOnly`,
  `Lax`, `Secure` in production (tested).
- **Uploads** — format decided from decoded content against four raster formats
  (no SVG), pixel limit on decode, re-encoded to WebP, server-generated names,
  path-contained deletion, served with `nosniff` and an octet-stream default.
- **Resend webhook** — HMAC over the raw body, length-checked timing-safe
  comparison, five-minute window, idempotent claim, reason logged not returned,
  no payload in logs.
- **SQL** — every dynamic column name comes from a code-defined map; values bound.
- **Other guarded transitions** — check-in tokens, organization invitations,
  appeal tokens and decisions all read their row counts.
- **Timers** — every `setInterval`/`setTimeout` body catches, so none can raise
  the fatal `unhandledRejection`.
- **Analytics** — opt-in, off by default, loaded only after consent, never
  identifies the user; replay masks marked subtrees.
- **Welly** — on-device; no server route; reads only what the user's own API
  calls return.
- **Supply chain** — `npm audit --omit=dev` 0; the only install scripts are
  optional dev-only `fsevents`. The `uuid` advisory was re-evaluated: `hyperid`
  calls `crypto.randomUUID`, present on every Node the engines field admits.
- **Accessibility** — the Playwright sweep: 63 passed, 0 failed.
- **CSP compatibility** — the built client was run under the exact policy in a
  real browser (landing, dashboard, events, event modal, map, messages, settings,
  calendar, profile; realtime WebSocket): no violations, with a deliberately
  injected inline script refused on the same page as the positive control.

---

## 3. Deliberately not changed

| Item | Why |
|---|---|
| Login distinguishes "no such account" from "wrong password" | A recorded product decision with a named switch (`GENERIC_LOGIN_ERRORS` in `authRoutes.js`). Signup's availability checks disclose the same fact and are rate-limited. |
| helmet's `Referrer-Policy: no-referrer` on the page | Under the Fetch standard a page with `no-referrer` sends `Origin: null` on same-origin POSTs, which CORS refuses. The page keeps `strict-origin-when-cross-origin`. |
| `Permissions-Policy` | Camera (QR check-in) and geolocation are in use; a policy needs a feature inventory, not a guess. |
| Deep-link `index.html` from Express sends `public, max-age=0` | nginx serves the page in production; the Express path is not the front door. |
| Minor dependency drift | No security content. `@wllama/wllama` has a documented defect that makes an unreviewed bump risky. |
| The Cloudflare refresh script | Synchronised byte-for-byte with the host; only its unit changed. |
| IPv6 in `cmd_host` | The Cloudflare step restricts IPv6 443 (`CF-HTTPS6`); OCI's Security List filters in front. Recorded in `branch-reconciliation.md`. |
| Unbounded comment, favourite and conversation lists | Each is naturally bounded — one event, one user — and posting is rate-limited. |

---

## 4. Owner actions

Nothing below can be done from the repository. Each is written as the exact step.

### 4.1 Deploy this release — **the map and header fixes do nothing until it ships**
Production still serves defaced maps, a page without CSP, and a socket server
with findings 3, 4 and 12 open. From a clean tree:
`deploy/make-release.sh`, then `provision.sh app` on the host (it installs the new
nginx snippet before `nginx -t`, the heartbeat and host-check units, and creates
`/etc/wevolunteer/heartbeats.env`). Before restarting the application, run
`sudo systemd-analyze verify /etc/systemd/system/wevolunteer.service` and watch
the restart: the sandbox is new.
**Before `provision.sh` replaces `/etc/nginx/sites-available/wevolunteers.conf`,
diff the host copy against the repository's** — the live page sends
`X-Frame-Options: SAMEORIGIN`, which the repository's file never has, so the host
copy has diverged.

### 4.2 Better Stack heartbeats
Create three heartbeats — `BACKUP` (1 day, grace 2 h), `CF_REFRESH` (7 days, grace
1 day), `HOST` (15 min, grace 15 min) — and paste their URLs into
`/etc/wevolunteer/heartbeats.env`. Then `sudo systemctl start
wevolunteer-host-check.service` (the heartbeat should turn green) and `sudo
systemctl start wevolunteer-heartbeat-fail@wevolunteer-backup.service` once (an
alert should reach a person).

### 4.3 CARTO basemap key (optional)
Without it maps draw from OpenStreetMap. To restore the designed styles: create
the free non-commercial key at https://carto.com/basemaps/apikey, restrict it to
the origin server, set `MAP_TILES_CARTO_KEY` in `/etc/wevolunteer/wevolunteer.env`.

### 4.4 Privacy Policy and Cookie Notice
Both say the browser loads map images directly from CARTO. After 4.1 no map
provider sees the student at all. Through the Legal editor, publish a MINOR
version of each replacing that passage with: *"Map images are drawn from
OpenStreetMap data (or CARTO's maps of it) and are loaded through WeVolunteer's
own server, so the map provider does not receive your IP address or anything
about you."* Legal text is the owner's decision; this is the accurate fact to
decide on.

### 4.5 The backup private key on the host
If `/root/backup-keys/backup-key.pem` exists, the host can decrypt every archive,
which defeats encrypting them. Do not delete it first. **(1)** Confirm a copy is in
the password manager; **(2)** on a machine that is not the host, run
`bin/verify-restore-postgres.sh` against a recent `.dump.enc` using that copy and
see "OK — this archive is proven restorable"; **(3)** remove `WEV_BACKUP_TESTKEY`
from the host's environment file if present; **(4)** only then `shred -u` the file.

### 4.6 R2 retention
The upload credentials should stay write-only, so the script cannot prune remote
copies. In the R2 dashboard, add a lifecycle rule deleting objects under the
backup prefix after 30 days.

### 4.7 Confirm the live environment file
Carried from the branch pass: in `/etc/wevolunteer/wevolunteer.env`, confirm
`APP_URL`, `CORS_ORIGINS` and `OAUTH_REDIRECT_URI` name `app.wevolunteers.org`,
`PINECONE_NAMESPACE` is unset or `production`, and any Resend webhook points at
`https://app.wevolunteers.org/api/webhooks/resend`. `CORS_ORIGINS` now also gates
browser socket connections from other origins; the application's own origin is
accepted either way.

---

## 5. Verification on the final tree

| Check | Result |
|---|---|
| `npm test` (SQLite) | 625 files passed, 10 skipped; **10,491 passed, 0 failed**, 176 skipped |
| `npm run test:postgres` | 404 files passed, 2 skipped; **6,986 passed, 0 failed**, 41 skipped |
| Accessibility sweep | 63 passed, 0 failed |
| `npm run lint` | clean |
| `npm run build` | clean |
| `npm run scan:bundle` | 172 files, CLEAN |
| `node bin/nginx-security-headers.mjs --check` | snippet matches source |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `bash -n` on every tracked shell script | 11 scripts, 0 failures |

**Not verifiable from here, and why:** `nginx -t` and systemd behaviour (no nginx
or systemd on the build machine — both run on the host before reload); the real
Better Stack heartbeat endpoint and a real CARTO key (owner accounts); Firefox and
Safari under the page's Referrer-Policy (only Chrome was available).
