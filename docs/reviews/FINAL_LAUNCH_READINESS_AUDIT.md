# Final launch readiness audit

**Date:** 2026-08-06
**Version:** 1.2.0
**Scope:** stabilisation pass over OAuth, authorization, moderation, the error
experience, the legal baseline and deployment readiness.

This document states what was verified and what was not. Where something is
unfinished it says so, with the reason, rather than describing an intention as a
result.

---

## 1. Verification performed

| Gate | Result |
|---|---|
| `npm ci` | passes; installs from the root lockfile |
| `npm test` | **185 files, 3027 tests, 0 failures, 0 unhandled errors** |
| `npm run lint` | clean (oxlint) |
| `npm run build` | clean, ~371 kB main chunk (116 kB gzip) |
| Server boot | reaches listening against the real pilot database |
| `/health` | `{"status":"ok","database":"connected","writable":true,"version":"1.2.0"}` |
| Legal endpoints | all 10 answer 200, all at v1.0, hashes verified |
| OAuth | Google mints a URL with a real `client_id`; Microsoft (unconfigured) answers 503 rather than a broken URL |

A note on method: a full-suite failure in `shutdown.test.js` during this pass was
traced to a verification server left running on the same port, not to a
regression. It passes in isolation and in a clean run. Do not run a manual server
alongside `npm test`.

---

## 2. Completed in this pass

### 2.1 OAuth — AADSTS900144 (fixed, root cause)

Two independent defects, both now closed:

- **Advertising.** `OAUTH_PROVIDERS_ENABLED` read
  `OAUTH_ALLOW_MOCK || <credentials>`, and `OAUTH_ALLOW_MOCK` defaults to
  `!IS_PRODUCTION` — so every development environment advertised every provider.
  `OAUTH_PROVIDERS_CONFIGURED` now answers from credentials alone and is what
  `/api/oauth/providers` reports.
- **Minting.** `getAuthUrl` had no credential guard in either provider, so
  `POST /api/oauth/microsoft/url` returned 200 with `client_id=`. Hiding the
  button was not enough: the endpoint is reachable directly and `reauthRoutes.js`
  calls `getAuthUrl` down a second path. `oauth/credentials.js` now refuses at
  construction time, and the mock does not exempt it.

Google carried the identical defect, masked only by having real credentials in
`.env`.

`/api/oauth/providers` gained `state` (`available` | `misconfigured` |
`coming_soon`). The auth screens no longer describe a credential-less provider as
"coming soon", which is what let this sit unnoticed — an operator sees the same
screen as everyone else.

### 2.2 Legal baseline — uniformly v1.0

All ten documents publish at v1.0 with verified hashes. Six that had been bumped
to 1.1 (to work around a startup collision with drafting-era publications) were
returned to 1.0, and the development database's stale rows and test acceptances
were cleared so the clean baseline could publish.

**The integrity system is unchanged**: hash pinning, the immutability guard,
fail-closed boot and acceptance tracking are byte-for-byte as they were, and
`legalRepublish.test.js` still pins that editing a published version throws.

### 2.3 The second privacy page — deleted

`PrivacyNotice.jsx` survived the `/privacy` redirect as an unused `React.lazy`
import, so a second, unversioned privacy page was still compiled into the bundle.
Removed with its 14 tests. The two policy files that named it in prose were
edited **above** the `## Draft` marker, so no published hash moved.

### 2.4 "Review queue" → "Moderation Center"

The rail said one thing and the page said another ("Moderation queue"). "Safety
Center" was rejected: the destination also holds organizer requests, which is
moderation but is not safety reporting.

### 2.5 The 403 is now a takeover

Every other error state — 404, 500, the crash boundary, the offline overlay — had
been moved outside the shell. The permission refusal was the last one still
rendering as a card inside `<main>`, with the sidebar and profile menu framing a
message saying the area was not for the reader.

**This reverses a previously tested decision** (that a 403 should keep the shell
"the reader needs to act on the advice"). The argument is answered rather than
discarded: `ErrorExperience` carries its own recovery action.

`deniedRoute()` mirrors the route table's element ternary exactly —
`requiresVerified`, then `requiredCap`, and nothing more. Any extra condition
here would refuse a route the table would have rendered.

### 2.6 API client contract guard

Four views called `api.get/patch/post/fetch`, which have never existed, so the
appeals queue and the suspended-student appeal form threw on first use.
`src/apiContract.test.js` now walks every non-test file under `src/` and fails the
build on any `api.X()` that is not defined.

---

## 3. Not done, and why

### 3.1 Admin messaging — NOT implemented

This was investigated and deliberately **not** shipped.

`messaging.js`'s `eligibleRelationship` has an admin branch, which is what made
this look built. It is not. `resolveConversation` always creates the conversation
between `student_id` and `organizer_id`, so an admin who resolves one **is not a
participant** and receives 404 on both read and send. The admin branch exists to
let an admin *inspect* a student↔organizer thread, not to message a student.

Granting `message.send` to admin — which was tried — replaces the permission
error with an empty inbox. That is a worse outcome, not a better one, so it was
reverted.

Real admin messaging needs a conversation shape that is not
`(event, student, organizer)`. The `conversations` table's columns and its
lookup key all assume that triple. Putting an admin in the `organizer_id` slot
would work mechanically and would misrepresent an administrator as the event's
organizer in the data model, and inherit event-date-driven read-only rules that
make no sense for a moderation contact.

**Required:** a migration for a conversation type or a participant model, a
recipient-picker UI, and the audit trail (sender, timestamp, recipients, content
hash — hashed, not copied, because `admin_audit_logs` has a broader audience than
the message does).

### 3.2 Moderation evidence UI — NOT implemented

`GET /api/admin/reports/:id/evidence` exists and is gated on
`report.evidence.read`, which admin holds. **No client code calls it.**
`AdminDashboard.jsx` renders the evidence *count* ("1 message preserved as
evidence") with no way to open it.

So a moderator cannot read the evidence for a report they are deciding. The
backend, the capability and the immutability guarantees are all in place; the
view is missing. This is the highest-value remaining item and it is
child-safety-relevant.

### 3.3 Moderation actions and UX (severity, timeline, assignment) — NOT done

Report status transitions exist server-side (`PATCH /api/admin/reports/:id`,
suspend/unsuspend, appeals). Severity, assigned reviewer, history timeline and an
action panel do not exist in the UI.

### 3.4 Admin capability audit — partially done

Measured: admin holds 17 capabilities. The only two it lacks that it arguably
needs are `message.send` (§3.1) and `announcement.post` — and **announcements
already work**, because every announcement route accepts `event.moderate` OR
`announcement.post`. Moderation, reports, evidence read, user management, appeals
and audit read are all already held and were verified against the route guards.

No wildcard was granted to admin. No capability was added in this pass.

### 3.5 Permission-denial copy — NOT changed

The request was that every denial name the feature attempted, the reason, and who
can grant access. The current 403 is generic. `deniedRoute()` deliberately
returns the matched **route** rather than a boolean so this can be built without
re-deriving it, but the copy itself is unchanged.

---

## 4. Security

| Item | Status |
|---|---|
| OAuth state replay, cross-provider replay, single-use state, CSRF nonce | covered by existing tests, verified |
| Session cookie: HttpOnly, Lax, path, Secure-in-production, none on failure | covered by existing tests, verified |
| Empty-credential OAuth URLs | now impossible (§2.1), pinned across five environments |
| Evidence immutability | unchanged; not weakened |
| Admin wildcard | not granted |
| `npm audit` | **2 high**, see below |

**The `npm audit` finding is not exploitable in this configuration.**
`react-router` 7.18.2 is flagged by GHSA-qwww-vcr4-c8h2, "RSC Mode CSRF Bypass".
This app is a client-only SPA using `BrowserRouter`; it does not use React Server
Components or any server-side router API. The only offered remedy is a downgrade
to 7.11.0, which is a breaking change. **Recommendation: do not downgrade; watch
for a patched 7.x.** Re-assess if server-side rendering is ever adopted.

---

## 5. Deployment requirements

Unchanged and unmet by the stated plan — see
`docs/plans/supabase-vercel-migration-plan.md` for the full assessment.

- What `deploy/` builds is **systemd units for a Linux host**. There is no
  `vercel.json`, no Supabase configuration and no Postgres driver.
- The frontend can move to Vercel immediately (static bundle; only the API origin
  and CORS allowlist need setting).
- The backend cannot move to Supabase without converting 65 files of synchronous
  `node:sqlite` access to async, which reintroduces a concurrency hazard
  `instanceLock.js` documents. Recommendation is to launch on the VPS.
- **The Privacy Policy must keep saying the hosting provider is not yet chosen
  until a deployment actually exists.** It currently tells the reader that this
  wording means the service holds nobody's information yet. That is true today.

Before launch, still required:
- `ALERT_EMAIL` and the `SMTP_*` set configured and delivery-tested.
- A **verified restore drill** — `wevolunteer-backup.timer` exists; a backup that
  has never been restored is not a backup.
- `OAUTH_REDIRECT_URI` set to the real callback and registered with Google.
  Production refuses to boot on a loopback value when a provider is configured.
- `MICROSOFT_CLIENT_ID`/`SECRET` if Microsoft sign-in is wanted; otherwise the
  button correctly reads "not set up on this site".

---

## 6. Recommended next steps, in priority order

1. **Moderation evidence view** (§3.2). Safety-critical, backend already done,
   smallest gap between "built" and "usable".
2. **Moderation action panel and status/severity** (§3.3).
3. **Admin messaging** (§3.1) — scope the conversation model first; it needs a
   migration.
4. **Denial copy** (§3.5) — cheap now that the route is available at the refusal.
5. **Restore drill and `ALERT_EMAIL`** (§5) — neither is code, both are launch
   blockers.
6. Supabase/Vercel: frontend whenever convenient; backend as its own project.
