# WeVolunteer v2 — Platform Master Plan

> **Status:** Design document. No code is written from this document directly.
> Each workstream below is converted into its own bite-sized TDD implementation
> plan (`docs/plans/YYYY-MM-DD-<workstream>.md`) at the moment that workstream
> starts — see §14. This document is the *spec* layer; those are the *task*
> layer.

**Author:** Lead architect · **Date:** 2026-07-31 · **Baseline:** v1.1.0, post-stabilization (508 tests, 88 test files)

**Goal:** Take WeVolunteer from a working volunteer coordination app to a
volunteer *management platform* a school district would adopt, procure, and
trust with student records.

**Governing principle:** the stabilization sprint bought us a codebase that is
correct. This phase must not spend that. Every workstream below either lands
behind a capability check with a test matrix, or it does not land.

---

## 0. Read this first: the brief is out of date

The task brief lists problems that the stabilization sprint already solved. I
audited the tree before planning, because planning to build things that exist
is the fastest way to waste a quarter. Here is the truth table.

| Brief claim | Reality in `main` @ f576bfc | Verdict |
|---|---|---|
| "OAuth missing" | `server/oauth/providers/{google,microsoft,apple}.js`, `oauthRoutes.js` (6 endpoints incl. link/disconnect), `oauth_accounts` / `oauth_states` / `oauth_signup_sessions` tables, `GoogleButton`/`MicrosoftButton`/`AppleButton`, `ConnectedAccounts.jsx`, `OAuthCallback.jsx`, `routes.oauth.test.js`, `config.oauthRedirect.test.js` | **False.** Three providers ship, including Apple which the brief doesn't ask for. |
| "No real email system" | `server/email.js` (560 lines): nodemailer SMTP transport, console-mock fallback, 3-attempt retry, `getMailHealth()`, HTML escaping, verification / reset / email-change / notification senders. `notification_jobs` table + `notificationWorker.js` = a real queue. | **False.** Delivery works. What's missing is *tracking* (§4.2). |
| "Account deletion is broken" | `accountRoutes.js:154` soft-deletes (`account_status='deleted'`, `deleted_at`, `token_version+1`), `authenticateToken` rejects deleted accounts at `utils.js:68`, `routes.deletion.test.js` passes | **Unconfirmed.** The happy path is implemented and tested. I need a repro before I plan a fix — see §15 Q1. |
| "Password/identity verification poorly designed" | **No** `reauth`, `step-up`, `verifyIdentity`, or `confirmPassword` anywhere in `server/`. Sensitive actions are gated by session cookie alone. | **True, and it's the real Phase 1.** |
| "Bring back location features" | `src/components/location/` (13 files: `LeafletMap`, `LocationPicker`, `LocationSearch`, `WeatherSummary`, `DirectionsButton`, `MapPreview`…), `geocodeRoutes.js` → Nominatim, `weatherRoutes.js` → Open-Meteo, `events.latitude`/`longitude`/`address` columns, `leaflet` + `react-leaflet` in deps | **False.** Phase 6 is ~85% built. It needs provider-policy compliance, not construction. |
| "Create attendance system" | `attendance_checkin` table, `attendanceRoutes.js`, `CheckInView.jsx`, `hours_ledger` with parity verification | **Partly built.** Check-in exists; QR, arrival/departure timestamps, and offline do not. |
| "Service portfolio" | `VolunteerPortfolio.jsx` exists but renders platform-verified hours only — no external-source model anywhere | **True gap.** |
| PWA | `public/` has `favicon.svg`, `icons.svg`, `theme.js`. No manifest, no service worker, no maskable icons. | **True gap.** |
| Error monitoring | Error handler at `app.js:626` maps and returns, but persists nothing. No `error_*` table. `App.jsx:896` is `<Route path="*" element={<Navigate to="/" replace />} />` — 404s are *swallowed*. | **True gap.** |
| Taxonomy | `events.category TEXT CHECK(category IN ('School','5K','Food Pantry','Fundraiser','Other'))` — a hardcoded 5-value CHECK. No tags. | **True gap, and harder than it looks** (§7.7). |
| Super admin | `users.role TEXT CHECK(role IN ('student','organizer','admin'))`. No super_admin. | **True gap, and it is blocked** (§3). |

**What this changes:** Phase 1 and Phase 2 shrink to focused additions. Phase 6
becomes a compliance-and-polish pass. The saved effort goes into the workstream
the brief never mentions, which is the one thing that must happen first.

---

## 1. Product vision and personas

> "The platform where students discover volunteer opportunities, organizations
> manage volunteers, schools verify service hours, and communities measure
> impact."

Four verbs — *discover, manage, verify, measure*. Each maps to a persona whose
job-to-be-done must be satisfiable in under two minutes, on a phone, on the
first try. That is the "wow factor"; charts are not.

| Persona | Primary job | Success metric | Today's friction |
|---|---|---|---|
| **Student** (grades 9–12) | "Prove I did my hours, find my next one" | Time from landing → applied < 90s; hours transcript exportable | Portfolio can't hold NHS/Key Club hours, so students keep a parallel spreadsheet |
| **Organizer** (nonprofit, PTO, library) | "Fill my shifts and take attendance without a clipboard" | Roster filled ≥ 90%; attendance closed same-day | Attendance is manual tapping through a list |
| **School admin** (activities director, NHS advisor) | "Sign off hours I can defend to a parent" | Verification decisions/min; zero disputed records | No verification workflow; no external-hours sign-off |
| **Super admin** (platform owner) | "Keep it running and show the district it works" | MTTR on errors; a stat page worth putting in a board deck | No error visibility; no aggregate impact view |
| **Community partner** (district, borough council) | "Show measurable community impact" | Public impact page shareable | Doesn't exist |

**The procurement lens.** A district's questions are: Who can see student data?
What happens when a student withdraws consent? Can you show me an audit log? Is
it FERPA-defensible? Does it work on our Chromebook fleet? Every workstream
below has an answer, because a "wow" demo that fails the security review is
worth zero.

---

## 2. Current architecture (verified)

```
React 19.2 + Vite 8 + react-router 7 (SPA, no SSR)
  src/App.jsx (1286 lines) — routing, session bootstrap, role gating via inline ternaries
  src/components/  (~40 components, colocated CSS, design-token discipline
                    enforced by noHardcodedColors.test.js + tokens.test.js)
  src/views/       (19 route-level views, all React.lazy)
  socket.io-client → src/services/socket.js

Node 24 (>=24 <25) + Express + socket.io
  server/app.js (655)      — middleware, rate limits, health, error handler (last)
  server/routes/ (13)      — role checks inline, `req.user.role !== 'admin'`
  server/services/ (5)     — autoSelect, notificationService, verification
  server/workers/ (2)      — notificationWorker, exportWorker (durable, tested)
  server/db.js (1038)      — node:sqlite DatabaseSync, WAL, imperative migrations
  36 tables + hours_ledger / certificates / attendance_checkin / instance_lock

Auth: httpOnly cookie JWT; identity re-derived from DB every request
      (utils.js:52) with token_version + revoked_sessions revocation
Tests: vitest (88 files, 508 tests) + playwright; CI runs npm ci → test → build → lint
```

**Three properties of this codebase the plan must respect:**

1. **No migration framework.** `db.js` runs imperative DDL on every boot:
   `CREATE TABLE IF NOT EXISTS` + `addColumnIfMissing()`. It is idempotent by
   construction, and there is already one table-rebuild precedent
   (`applications_new`). We are about to do ~10 structural migrations. That
   needs a versioned registry (§8.1) *before* it needs anything else.
2. **Timestamps are lexicographically compared.** TD-10 documents a real bug
   caused by mixing ISO `T`-separated strings with SQLite's space-separated
   `datetime('now')`. **Every new table in this plan stores ISO-8601 UTC with
   `T` and `Z`, generated in JS, never by SQLite.** This is non-negotiable and
   goes in the global constraints of every derived plan.
3. **Derived hours stay derived.** `hours_ledger` is the single source of truth
   for platform-credited hours, with parity verification. External hours (W8)
   must **never** be written into it (§7.8).

---

## 3. The blocker nobody listed: authorization is a copy-pasted string compare

This is the most important finding in the audit, and it reorders the entire
roadmap.

Authorization today is **~40 inline string comparisons** scattered across route
handlers:

```js
// server/routes/adminRoutes.js — repeated at :15, :31, :63, :110, :207, :241, :299, :468
if (req.user.role !== 'admin') { return res.status(403).json({ error: 'Access denied' }) }
```

…and **~15 inline ternaries** in the client:

```jsx
// src/App.jsx:785
currentUser.role === 'admin' ? <AdminDashboard /> :
currentUser.role === 'student' ? ( … ) : …
```

**The failure mode:** the moment you add `super_admin` to the role enum, every
one of those ~40 checks evaluates `'super_admin' !== 'admin'` → **true** → the
platform owner is locked out of every admin route in the product. The Phase 10
feature the brief wants most is the feature this pattern most reliably breaks.
And it fails *silently* — no test fails, because no test asserts "super_admin
can reach admin routes" until we write one.

There is also a related latent bug: `attendanceRoutes.js:62` and `:44` gate on
`role !== 'organizer'` and `role === 'student'` respectively, so an `admin`
already gets inconsistent treatment across sibling endpoints in the same file.
Adding a fifth role multiplies that inconsistency by every new call site.

**Therefore: W0 (authorization kernel) is a hard prerequisite for W4's super
admin dashboard, W5's admin dashboards, W8's advisor verification, and all of
W10.** It ships first, it ships with an exhaustive matrix test, and it is the
one workstream with no user-visible output. That is fine. Foundations are
allowed to be invisible; they are not allowed to be skipped.

---

## 4. Cross-cutting foundations

Four things every later workstream consumes. Built once, in v1.2.

### 4.1 Capability-based authorization (`server/authz.js` + `src/authz.js`)

Replace role-string compares with named capabilities. Roles map to capability
sets; code asks for capabilities, never roles.

```js
// server/authz.js
export const ROLES = ['student', 'organizer', 'admin', 'super_admin', 'partner'];

export const CAPABILITIES = {
  student:     ['event.view', 'event.apply', 'application.withdraw', 'self.read',
                'self.write', 'portfolio.write', 'message.send', 'qr.present'],
  organizer:   ['event.view', 'event.create', 'event.edit.own', 'applicant.review',
                'attendance.mark', 'attendance.scan', 'announcement.post',
                'message.send', 'self.read', 'self.write', 'service.verify.own_event'],
  admin:       ['event.view', 'event.moderate', 'organizer.approve', 'user.suspend',
                'report.resolve', 'audit.read', 'analytics.school',
                'service.verify.external', 'capability.grant',
                'self.read', 'self.write'],
  super_admin: ['*'],           // resolved by can(), never expanded literally
  partner:     ['analytics.public'],
};

// Super-admin-only capabilities. Declared explicitly rather than left implicit
// under the '*' wildcard, because the route-completeness test asserts every
// capability referenced by a route exists in this file — a wildcard would let a
// typo ('error.raed') pass silently for super_admin and 403 for everyone else.
export const SUPER_ONLY = [
  'error.read', 'error.write',        // W4 error dashboard
  'analytics.platform',              // W5 super admin dashboard
  'impersonation.start',             // W10
  'admin.create',                    // platform account mints admins
];

// A principal is never just a role. Impersonation (W10) depends on this shape.
// { userId, actualRole, effectiveRole, actorId|null, aal, impersonating }
export function can(principal, capability) { … }
export function requireCap(capability) { return (req, res, next) => { … } }
```

Rules:
- `requireCap()` is the **only** authorization primitive in route files. A PR
  that reintroduces `req.user.role !== …` fails review (added to
  ENGINEERING_GUIDE §6).
- Ownership scoping stays explicit: `event.edit.own` still requires the handler
  to compare `organizer_id`. Capabilities answer *may this kind of actor*, not
  *may this actor, this row*. Conflating the two is how row-level bugs hide.
- The client mirror (`src/authz.js`) shares the capability table but is **UX
  only**. Every capability is re-checked server-side. A `<Can cap="…">`
  component replaces the App.jsx ternaries.
- **Completeness test:** a route registry test enumerates every registered
  Express route and fails if any authenticated route lacks a declared
  capability. This is what stops the next 40 copy-pastes.

### 4.2 Versioned migrations (`server/migrations/`)

```
server/migrations/
  index.js          — ordered registry, runs inside a transaction, records schema_version
  001_authz_roles.js
  002_error_events.js
  …
```

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  applied_at  TEXT NOT NULL,        -- ISO-8601 UTC, JS-generated
  checksum    TEXT NOT NULL         -- guards against edited-after-apply migrations
);
```

`db.js` keeps its existing `CREATE TABLE IF NOT EXISTS` bootstrap for the
current 36 tables (rewriting that is risk with no reward) and delegates all
*new* structural change to the registry. Every migration must be idempotent and
covered by a "run initDatabase twice" test — that test already has a precedent
in `migration.test.js`.

### 4.3 Step-up authentication (AAL) — the real Phase 1

Two assurance levels on the session: `aal1` = has a valid cookie; `aal2` =
proved identity within the last 5 minutes. Sensitive actions require `aal2`.

```sql
CREATE TABLE IF NOT EXISTS reauth_challenges (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  action        TEXT NOT NULL,          -- 'account.delete' | 'email.change' | …
  params_hash   TEXT NOT NULL,          -- binds the grant to *these* arguments
  method        TEXT,                   -- 'password' | 'oauth:google' | 'oauth:microsoft'
  session_id    TEXT NOT NULL,          -- binds to the session that opened it
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,          -- created_at + 5 min
  consumed_at   TEXT,                   -- single-use
  ip_hash       TEXT,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_reauth_user ON reauth_challenges(user_id, expires_at);
```

**Sensitive action registry** (`server/sensitiveActions.js`) — the single list,
so adding an action can't forget to add the gate:

| Action | Why | Extra requirement |
|---|---|---|
| `account.delete` | irreversible | + typed confirmation phrase |
| `email.change` | account takeover vector | + confirm to *both* addresses (exists) |
| `password.change` | takeover | — |
| `oauth.disconnect` | can orphan the only login method | + block if last credential |
| `role.request_organizer` | privilege escalation | — |
| `impersonation.start` | full account access (W10) | + super_admin + allowlist |
| `service.verify.external` | writes to a student record (W8) | — |
| `data.export` | bulk PII egress | — |

**Design decisions:**
- The grant lives **server-side** in the table above, not as a JWT claim. A
  claim can't be revoked mid-window; a row can.
- `params_hash` binds the grant to the exact arguments. Without it, verifying to
  change your email to `a@x.com` also authorizes changing it to `attacker@x.com`
  inside the 5-minute window. This is the subtle bug in most step-up
  implementations.
- **OAuth re-consent** must force a fresh authentication, not silently reuse the
  IdP session: Google `prompt=login` + `max_age=0`, Microsoft `prompt=login`.
  Then verify the returned `sub` matches the linked `oauth_accounts` row — *and*
  for Google, verify `hd` (hosted domain) still matches the district when the
  account was district-provisioned.
- **Never username-only**, per the brief. Also never email-only: both are
  public-ish identifiers, and `routes.enumeration.test.js` shows we already
  treat identifier disclosure as a threat.
- Password-less accounts (OAuth-only signup) must be offered OAuth re-consent,
  never a password prompt they can't satisfy. `ConnectedAccounts.jsx` already
  knows which providers are linked; the challenge endpoint returns the available
  methods so the UI can render only those.

**UX (three screens, one component):**

```
┌─ Verify your identity ─────────────────────┐
│ To delete your account, confirm it's you.  │
│                                             │
│  [ G  Continue with Google ]                │
│  [ ⊞  Continue with Microsoft ]             │
│  ───────────── or ─────────────             │
│  Password  [………………………]                     │
│                          [Cancel] [Verify]  │
│ Expires in 4:52                             │
└─────────────────────────────────────────────┘
```
Rendered as `<VerifyIdentityModal action="account.delete" params={…} onGranted={…}>`.
Rate limited to 5 attempts / 15 min / user (reuse the existing limiter from
`routes.rateLimit.test.js`), with failures written to `admin_audit_logs`.

### 4.4 Observability primitives

Structured error capture (W4) is a foundation, not a feature, because every
later workstream generates errors we'll otherwise never see. Ships in v1.2 as a
write path + retention job; the *dashboard* ships in v1.3 once W0 gives us a
`super_admin` to show it to.

---

## 5. Dependency graph

```
                    ┌──────────────────────────────┐
                    │ W0  Authorization kernel     │  ← blocks the most
                    │     + migrations registry    │
                    └───┬──────────┬───────────┬───┘
                        │          │           │
        ┌───────────────┘          │           └──────────────┐
        ▼                          ▼                          ▼
┌───────────────┐        ┌──────────────────┐       ┌──────────────────┐
│ W1 Step-up    │        │ W4 Errors        │       │ W5 Dashboards    │
│    auth (AAL) │        │  (write path →   │       │  (admin + super  │
└───┬────────┬──┘        │   dashboard)     │       │   admin views)   │
    │        │           └──────────────────┘       └────────▲─────────┘
    │        │                                               │
    │        └──────────────┐                    ┌───────────┘
    ▼                       ▼                    │
┌──────────────┐   ┌─────────────────┐   ┌───────┴────────┐
│ W10 Super    │   │ W8 Service      │   │ W7 Taxonomy    │
│  admin +     │   │  portfolio      │   │  (categories   │
│  impersonate │   │  + verification │   │   + tags)      │
└──────────────┘   └─────────────────┘   └───┬────────┬───┘
                                             │        │
                            ┌────────────────┘        └────────┐
                            ▼                                  ▼
                   ┌──────────────────┐              ┌──────────────────┐
                   │ W6 Maps/weather  │              │ Recommendations  │
                   │  (polish only)   │              │  (enhance exist) │
                   └──────────────────┘              └──────────────────┘

┌──────────────┐        ┌──────────────────┐
│ W2 Email     │───────▶│ W3 PWA           │───────▶┌──────────────────┐
│  tracking    │  push  │  + service worker│ offline│ W9 QR attendance │
└──────────────┘  infra └──────────────────┘  outbox└──────────────────┘
```

**Hard edges (violating these causes rework):**
- W0 → W4/W5/W8/W10 — all need `super_admin` or non-role-string checks.
- W1 → W10 — impersonation without step-up is a backdoor.
- W1 → W8 — external-hours verification writes to a student record.
- W7 → W5 — category analytics built on a CHECK constraint must be rebuilt.
- W3 → W9 — offline attendance needs the service worker's IndexedDB outbox.
- W2 → W3 — push notifications reuse the notification job queue and preferences.

**Soft edges (nice, not required):** W6 distance filtering benefits from W7's
tag filters sharing one query builder in `eventQuery.js`.

---

## 6. Release train

Four releases, each independently shippable and demo-able.

| Release | Theme | Contents | Demo story | Est. |
|---|---|---|---|---|
| **v1.2** | Foundations | W0 authz kernel, migrations registry, W1 step-up auth, W4 error write path + retention | "Watch me try to delete my account — it asks me to prove it's me." | 3–4 wk |
| **v1.3** | Trust & Reach | W2 email tracking + suppression, W3 PWA (install, offline, push), W4 dashboard + custom 404/403/500 | "Install it from Safari. Turn off wifi. It still works." | 4–5 wk |
| **v1.4** | Meaning | W7 taxonomy, W5 dashboards (all four), W6 provider compliance + distance filter, recommendations v2 | "Here's the district's participation trend by category." | 4–5 wk |
| **v2.0** | Platform | W8 service portfolio + verification, W9 QR attendance, W10 super admin + impersonation + public impact page | "Student shows a QR. I scan. Hours are on their transcript, signed by the NHS advisor." | 6–8 wk |

The v2.0 demo is the district-adoption pitch. Everything before it exists to
make that demo survive scrutiny.

---

## 7. Workstream designs

Each workstream: current state → target → schema → API → frontend → security →
UX → tests → risks.

### W0 — Authorization kernel & migration registry (v1.2)

**Current:** §3. **Target:** §4.1 + §4.2.

**Schema.** Add `super_admin` and `partner` to `users.role`. SQLite **cannot**
alter a CHECK constraint — it requires the 12-step table rebuild. `db.js`
already has an `applications_new` precedent to copy.

```js
// server/migrations/001_authz_roles.js
export const version = 1;
export const name = 'authz_roles';
export function up(db) {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  db.exec(`CREATE TABLE users_new (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    grade TEXT CHECK(grade IN ('9','10','11','12','Adult','N/A')) NOT NULL,
    role TEXT CHECK(role IN ('student','organizer','admin','super_admin','partner')) NOT NULL,
    /* … every existing column, in order, including the 11 added by
       addColumnIfMissing: token_version, email_opt_out, account_status,
       deleted_at, email_verified, username, username_changed_at,
       profile_visibility, leaderboard_opt_in … */
    created_at TEXT NOT NULL
  )`);
  db.exec('INSERT INTO users_new SELECT /* explicit column list */ FROM users');
  db.exec('DROP TABLE users');
  db.exec('ALTER TABLE users_new RENAME TO users');
  /* recreate every index, including the case-insensitive email unique index */
  const bad = db.prepare('PRAGMA foreign_key_check').all();
  if (bad.length) throw new Error(`FK violations after users rebuild: ${bad.length}`);
  db.exec('COMMIT');
  db.exec('PRAGMA foreign_keys = ON');
}
```

Plus a capability-grant table, so we can hand an NHS advisor verification
rights (W8) without inventing a role for every job title:

```sql
CREATE TABLE IF NOT EXISTS user_capabilities (
  user_id     TEXT NOT NULL,
  capability  TEXT NOT NULL,
  scope       TEXT,                 -- NULL = global; else school id / event id
  granted_by  TEXT NOT NULL,
  granted_at  TEXT NOT NULL,
  expires_at  TEXT,
  PRIMARY KEY (user_id, capability, scope),
  FOREIGN KEY(user_id)    REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(granted_by) REFERENCES users(id)
);
```

**API.** No new endpoints. ~40 handlers change from `if (role !== …)` to
`requireCap('…')` in the router chain. Behaviour-preserving by design: the
capability table is derived *from* the current checks, so the matrix test's
first run must reproduce today's behaviour exactly — except where it exposes an
existing inconsistency (`attendanceRoutes.js:44` vs `:62`), which gets fixed
deliberately and noted in CHANGELOG.

**Frontend.** `src/authz.js` + `<Can cap>` + `useCan()`. `App.jsx` role
ternaries → a route table with `requiredCap`, which also cuts that 1286-line
file down materially. Split `App.jsx` into `App.jsx` (shell) +
`src/routes/index.jsx` (table) while we're there — it is the highest-churn file
in the repo and every workstream touches it.

**Security.** Deny-by-default: unknown capability → `false`. `super_admin: ['*']`
resolved inside `can()` so a wildcard can never be accidentally serialized to
the client. The client table is advisory; server re-checks always.

**Tests (the crown jewel).** A table-driven matrix: every registered route ×
every role × {owner, non-owner} → expected status. ~40 routes × 5 roles × 2 =
~400 assertions, generated, not hand-written. This single test file is worth
more than the rest of W0's tests combined, and it is what makes W10 safe.
Plus: route-registry completeness test; `can()` unit tests; migration
idempotency + FK-integrity test; a lint rule / grep test banning
`req.user.role` outside `authz.js`.

**Risks.** The `users` table rebuild is the single riskiest operation in this
entire plan — it drops and recreates the table every other table's FKs point
at. Mitigations: `bin/backup.sh` immediately before; `PRAGMA foreign_key_check`
inside the transaction; verify `hours_ledger` parity after (the invariant check
already exists — `verifyLedgerParity`); rehearse on a copy of `pilot.db`; ship
this migration *alone* in v1.2.0, no other schema change in the same release.

---

### W1 — Step-up authentication (v1.2)

**Current:** absent. **Target:** §4.3.

**API.**

| Method | Path | Cap | Notes |
|---|---|---|---|
| POST | `/api/auth/reauth/challenge` | authenticated | Body `{action, params}`. Returns `{challengeId, methods:['password','oauth:google'], expiresAt}`. Returns available methods only. |
| POST | `/api/auth/reauth/password` | authenticated | Body `{challengeId, password}`. bcrypt compare (async — `bcryptAsync.test.js` exists). Rate limited. |
| GET | `/api/auth/reauth/oauth/:provider` | authenticated | Redirect with `prompt=login&max_age=0`, `state` bound to challengeId |
| POST | `/api/auth/reauth/oauth/:provider/callback` | authenticated | Verifies `sub` matches linked account; marks challenge granted |
| — | *consumed by* sensitive routes | — | `requireAAL2('action')` middleware reads+consumes the challenge |

**UX flows.**

```
Delete account:
  Settings → Delete account
    → VerifyIdentityModal(action='account.delete')
    → [Google | Microsoft | Password]
    → typed confirmation: "delete my account"
    → consequences screen (hours retained anonymized? see Q2)
    → DELETE /api/account  (requireAAL2 consumes challenge)
    → signed out everywhere (token_version++), confirmation email

Change email:
  Settings → Email → new address
    → VerifyIdentityModal(action='email.change', params={newEmail})
    → existing double-confirmation flow (email_change_tokens) unchanged
```

**Security.** Covered in §4.3. Additionally: challenges are swept by the
existing `maintenanceSweep` (there's already a retention-sweep pattern and
tests); `ip_hash` not raw IP, per the privacy posture in `privacyRoutes.js`.

**Tests.** Grant is single-use; grant expires at 5:00; grant does not transfer
across actions; grant does not transfer across `params_hash`; grant does not
transfer across sessions; OAuth callback with mismatched `sub` is rejected;
password-less account is not offered `password`; disconnecting the last
credential is blocked; 6th attempt in 15 min is limited.

**Risks.** Adding friction to deletion could look like dark-pattern retention.
Mitigation: deletion remains reachable in ≤ 3 taps and never fails closed — if
the email transport is down, OAuth and password paths still work.

---

### W2 — Email delivery tracking (v1.3)

**Current:** nodemailer + SMTP + retry + health + mock fallback. Real.
**Missing:** per-message tracking, suppression, bounce handling, template
registry, idempotency.

**Provider recommendation.** The constraint is "free, no credit card, high
limits, district-credible."

| Provider | Free tier | CC required | Verdict |
|---|---|---|---|
| **Google Workspace SMTP relay** | ~2,000/day per user | No (district already pays) | **First choice if the district has Workspace** — the user's email is `@sbschools.org`, so it likely does. Best deliverability: mail comes *from* the district domain. |
| **Brevo** | 300/day (9k/mo) | No | **Best independent choice.** No CC, generous, webhooks for bounces. |
| Resend | 3,000/mo, 100/day | No | Great DX, lower daily cap. Good fallback. |
| MailerSend | 3,000/mo | No | Comparable. |
| Amazon SES | 3,000 msg/mo (12mo) | **Yes** | Disqualified by the no-CC constraint; revisit at district scale. |

**Recommendation: Brevo as the default SMTP provider, with Workspace relay as a
documented alternative.** No code change either way — `email.js` already takes
`SMTP_HOST/USER/PASS`, so this is configuration. Volume sanity check: 500
students × ~4 emails/week ≈ 2,000/week ≈ 290/day. Brevo's 300/day is *tight*;
digest batching (below) is what keeps us inside it, and Workspace relay is the
headroom.

**Schema.**

```sql
CREATE TABLE IF NOT EXISTS email_messages (
  id             TEXT PRIMARY KEY,
  user_id        TEXT,                       -- nullable: survives account deletion
  to_hash        TEXT NOT NULL,              -- sha256(lower(email)) — no plaintext address at rest
  template       TEXT NOT NULL,              -- 'welcome' | 'application.accepted' | …
  subject        TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,               -- prevents double-send on retry
  status         TEXT CHECK(status IN ('queued','sent','delivered','bounced','failed','suppressed')) NOT NULL,
  attempts       INTEGER NOT NULL DEFAULT 0,
  provider_id    TEXT,                       -- provider message id, for support tickets
  error          TEXT,
  created_at     TEXT NOT NULL,
  sent_at        TEXT,
  updated_at     TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_email_status  ON email_messages(status, created_at);
CREATE INDEX IF NOT EXISTS idx_email_user    ON email_messages(user_id, created_at);

CREATE TABLE IF NOT EXISTS email_suppressions (
  to_hash    TEXT PRIMARY KEY,
  reason     TEXT CHECK(reason IN ('hard_bounce','complaint','manual','repeated_soft')) NOT NULL,
  created_at TEXT NOT NULL,
  notes      TEXT
);
```

**Architecture.** Reuse `notification_jobs` + `notificationWorker.js` rather
than building a second queue — it is already durable and tested
(`notificationWorker.reliability.test.js`, `exportWorker.durability.test.js`).
Add an `email` job type. Send path becomes:

```
sendTemplate(template, userId, vars, {idempotencyKey})
  → suppression check (hash lookup)     → status='suppressed', stop
  → user.email_opt_out check            → transactional? send : stop
  → INSERT email_messages status='queued'
  → enqueue notification_jobs
  → worker: render template → transporter.sendMail → status='sent' + provider_id
  → on failure: attempts++, exponential backoff (1m, 5m, 30m), then 'failed'
  → 3 consecutive hard bounces or 1 complaint → email_suppressions
```

**Transactional vs. marketing split matters legally and operationally:**
verification, password reset, and email-change messages ignore `email_opt_out`
and ignore soft suppression (you must be able to recover your account).
Everything else respects both.

**Template registry** (`server/emailTemplates/`), one module per template
exporting `{subject(vars), text(vars), html(vars)}`, so the 15 templates the
brief lists are data, not 15 copies of a layout. `email.escaping.test.js`
already guards HTML injection — extend it to iterate the whole registry
automatically so a new template can't skip escaping.

**Templates to build:** account — welcome, verify, reset, email-changed,
password-changed, account-deleted; volunteer — application submitted, accepted,
rejected, waitlisted, promoted-from-waitlist, event reminder (T-24h), schedule
changed, event cancelled, hours credited, verification decision; organizer —
new applicant, roster below threshold, attendance pending (T+24h), event
approved/rejected; admin — security alert (failed step-up burst, impersonation
started), system error digest, weekly summary.

**Digest batching** is required, not optional: an organizer with a popular event
must not get 40 "new applicant" emails. Per-user, per-template windows (5 min
for applicant notices, daily for digests), collapsing into one message. This is
also the mechanism that keeps us under Brevo's 300/day.

**Frontend.** `NotificationPreferences.jsx` gains real per-template toggles
grouped by category. Super admin gets an email-log view (W4 dashboard shell):
status counts, recent failures, suppression list with manual removal.

**Security/privacy.** No plaintext addresses in `email_messages` (hash only) —
so the table isn't a harvestable directory, and `ON DELETE SET NULL` keeps
delivery history for ops without keeping the person. Unsubscribe links are
signed, single-purpose tokens, never bare user ids. Bounce webhook endpoint
verifies the provider's signature and is rate limited.

**Tests.** Idempotency key prevents duplicate send; suppressed address is not
sent to; transactional bypasses opt-out; marketing does not; backoff schedule;
3 hard bounces → suppression; digest collapses N events into 1 message; every
template in the registry escapes HTML; bounce webhook rejects bad signature.

---

### W3 — Mobile experience + PWA (v1.3)

**Current:** mobile CSS is genuinely considered — `viewport-fit=cover` with a
documented rationale in `index.html`, `env(safe-area-inset-*)` used in 12
places, `.mobilenav` exists, design tokens enforced by test. **Missing:** the
entire PWA layer.

**Mobile UX audit — findings to fix.** (To be confirmed against the running app
with the browser tools during W3; these are the code-level smells I can see
now.)

| Area | Finding | Fix |
|---|---|---|
| Navigation | `.mobilenav` exists but the role-conditional route tree means tab sets differ per role in ad-hoc ways | Derive tabs from the W0 capability table; max 5 tabs; active state; badge counts from socket |
| Touch targets | Icon-only buttons at `lucide-react` default `size={15}` (seen in `ProfileMenu.jsx`) — visual 15px | Enforce 44×44 CSS min hit area via a `.tap-target` utility; audit all icon buttons |
| Forms | `CreateEvent.jsx` is a long single-column form; slot creation is nested | Multi-step wizard with progress; `inputmode`/`autocomplete`/`enterkeyhint` on every field; sticky primary action above the keyboard |
| Modals | 11 modal components; `useModal.js` + `dialogSemantics.test.jsx` show focus discipline exists | On mobile, convert to full-screen sheets with drag-to-dismiss; `dvh` not `vh` (iOS toolbar); scroll-lock the body |
| Dashboards | Charts via `BarChart.jsx` (custom SVG) | Horizontal scroll containers, never squeeze; stat tiles 2-up on mobile |
| Event browsing | Progressive fetch already exists (`fetchEventsProgressive.test.js`), windowing exists (`useWindowedRows`) | Add skeletons; make filter a bottom sheet; keep list position on back |
| Attendance | `CheckInView.jsx` — tapping a long roster | W9 replaces with scanning; keep search + big rows as fallback |

**PWA architecture.**

```
vite-plugin-pwa (Workbox under the hood) — injectManifest strategy, not generateSW,
because our caching rules are security-sensitive and must be readable.

public/manifest.webmanifest
  name / short_name "WeVolunteer"
  display: standalone, orientation: portrait-primary
  theme_color + background_color from design tokens (not hardcoded — tokens.test.js)
  icons: 192, 512, plus 512 maskable (safe zone respected)
  shortcuts: "Browse events", "My hours", "Scan attendance" (capability-filtered at runtime)

src/sw.js
  precache: app shell (index.html, hashed JS/CSS, icons, fonts)
  runtime:
    /api/events, /api/events/:id      → NetworkFirst,  3s timeout, 5 min maxAge
    /api/geocode, tile requests       → StaleWhileRevalidate, 30 day, capped 200 entries
    /api/weather                      → StaleWhileRevalidate, 1 hour
    /api/auth/*, /api/oauth/*         → NetworkOnly, never cached
    all POST/PATCH/DELETE             → NetworkOnly + BackgroundSync outbox (W9)
    navigation fallback               → /offline.html
```

**The security issue that matters more than any feature here.** School
Chromebooks are shared. A service worker cache is **origin-scoped, not
user-scoped**. If we cache `/api/applications` and student A signs out and
student B signs in on the same device, B can be served A's cached roster —
including names and contact info. This is a FERPA incident, delivered by a
performance optimization.

Mitigations, all required:
1. Cache names are namespaced with a per-session salt: `wev-${userScopeId}-api`.
2. On logout, `caches.keys()` → delete every `wev-*-api` cache, and clear
   IndexedDB. Fire this from the logout handler *and* from a `SIGNED_OUT`
   `postMessage` so it runs even if the tab closes mid-flight.
3. **Never cache any response containing another person's PII.** Practically:
   cache the *event catalog* (public-ish) aggressively; cache the user's own
   data in IndexedDB keyed by user id; never runtime-cache
   `/api/applications`, `/api/messages`, `/api/users/:id`, or admin routes.
4. `Cache-Control: no-store` on those endpoints server-side as belt-and-braces,
   so a future SW change can't silently start caching them.
5. A test asserting the SW route list contains no PII endpoint — an allowlist,
   so the default for a new endpoint is "not cached."

**Push notifications.** VAPID + `web-push` on the server; reuse
`notification_preferences` and the existing job queue so a notification can
fan out to in-app + email + push from one place.

```sql
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  endpoint    TEXT NOT NULL UNIQUE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  user_agent  TEXT,
  created_at  TEXT NOT NULL,
  last_used_at TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

Platform reality to design around: **iOS only delivers web push to PWAs the
user has added to the Home Screen** (16.4+), and permission must follow a user
gesture. So: never auto-prompt. Show an "Enable reminders" card after the first
successful application, and on iOS show install instructions first, gated on
`navigator.standalone`. A `410 Gone` from the push service prunes the
subscription.

**Splash screens.** Android derives them from the manifest. iOS needs explicit
`apple-touch-startup-image` links per device size — generate them in the build
rather than hand-maintaining ~10 `<link>` tags.

**Tests.** Manifest validity + required icon sizes; SW precache manifest is
non-empty after build; runtime-caching allowlist contains no PII route; logout
clears all `wev-*` caches and IndexedDB; offline navigation serves
`/offline.html`; push subscribe/unsubscribe round trip; `410` prunes.
Playwright with `context.setOffline(true)` for the offline path;
`resize_window` + real device-width runs for the mobile audit.

**Risks.** A bad service worker is the classic way to brick a web app for
returning users. Mitigations: `skipWaiting` only on explicit user action ("A new
version is available — Reload"); a versioned kill-switch (`/sw-kill.js` that
unregisters) documented in the runbook; SW registered only in production builds
so dev iteration is unaffected.

---

### W4 — Error monitoring (write path v1.2, dashboard v1.3)

**Current:** `app.js:626` handler maps known errors (there's a documented
`entity.too.large` mapping bug fix in the comments) and returns 500. Nothing
persists. `ErrorBoundary.jsx` exists client-side. 404s are swallowed by
`App.jsx:896`'s redirect-to-home.

**Schema.** Two tables: raw events (retention-limited) + fingerprint
aggregates (kept long).

```sql
CREATE TABLE IF NOT EXISTS error_fingerprints (
  id             TEXT PRIMARY KEY,          -- sha256(type + normalized top frames + route template)
  error_type     TEXT NOT NULL,             -- 'TypeError' | 'HttpError' | 'UnhandledRejection'
  message_sample TEXT NOT NULL,             -- redacted exemplar
  route_template TEXT,                      -- '/api/events/:id' — never a raw URL
  severity       TEXT CHECK(severity IN ('info','warning','error','critical')) NOT NULL,
  source         TEXT CHECK(source IN ('server','client','worker')) NOT NULL,
  first_seen_at  TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL,
  total_count    INTEGER NOT NULL DEFAULT 0,
  affected_users INTEGER NOT NULL DEFAULT 0,
  status         TEXT CHECK(status IN ('open','acknowledged','resolved','muted')) NOT NULL DEFAULT 'open',
  resolved_at    TEXT,
  resolved_by    TEXT,
  notes          TEXT
);

CREATE TABLE IF NOT EXISTS error_events (
  id             TEXT PRIMARY KEY,
  fingerprint_id TEXT NOT NULL,
  occurred_at    TEXT NOT NULL,
  user_id        TEXT,                      -- SET NULL on delete
  user_role      TEXT,                      -- role at time of error (users.role may change)
  route_template TEXT,
  http_method    TEXT,
  status_code    INTEGER,
  stack          TEXT,                      -- redacted, truncated to 8 KB
  browser        TEXT,                      -- parsed family+major only, not full UA
  os             TEXT,
  device_type    TEXT CHECK(device_type IN ('mobile','tablet','desktop','unknown')),
  request_id     TEXT,                      -- correlates client report ↔ server log
  release        TEXT,                      -- package.json version + git sha
  FOREIGN KEY(fingerprint_id) REFERENCES error_fingerprints(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_err_events_time ON error_events(occurred_at);
CREATE INDEX IF NOT EXISTS idx_err_events_fp   ON error_events(fingerprint_id, occurred_at);

CREATE TABLE IF NOT EXISTS error_daily_rollup (
  day TEXT NOT NULL, fingerprint_id TEXT NOT NULL, severity TEXT NOT NULL,
  count INTEGER NOT NULL, affected_users INTEGER NOT NULL,
  PRIMARY KEY (day, fingerprint_id)
);
```

**Fingerprinting** is what turns 10,000 rows into 12 actionable problems:
normalize the stack (strip absolute paths, hashes, line numbers beyond the top
3 frames), drop numeric/UUID path segments to get a route *template*, then hash
`type + frames + template`. Without this the dashboard is a firehose.

**Privacy — this table is the highest-risk one in the plan.** A stack trace is
famous for containing whatever was in scope.
- **Never store:** request bodies, query strings, cookies, headers, tokens, raw
  URLs, full user-agent strings, IP addresses, email addresses.
- **Redact on write** (not on read): a scrubber replaces anything matching
  email / JWT / bearer / long-hex / `password|token|secret|key` patterns before
  the row is inserted. Tested against a corpus of nasty inputs.
- **Retention:** raw `error_events` 90 days; `error_daily_rollup` 13 months;
  `error_fingerprints` indefinite. Swept by the existing `maintenanceSweep`
  (`notificationRetention.test.js` is the pattern to copy).
- **Access:** `audit.read`-style capability — `error.read`, super admin only.
  Every dashboard view is itself written to `admin_audit_logs`.

**Sampling / abuse control.** The client report endpoint is unauthenticated-ish
by necessity (errors happen when logged out) and is therefore a spam vector:
rate limit 10/min/IP, 5 KB payload cap, drop events whose fingerprint already
exceeded 1,000 occurrences in the last hour (count them in the rollup instead —
`total_count` keeps incrementing, `error_events` stops growing). This is the
mechanism that stops one looping client from filling the disk.

**API.**

| Method | Path | Cap | Notes |
|---|---|---|---|
| POST | `/api/errors/client` | none (rate limited) | Client + `ErrorBoundary` reports |
| GET | `/api/admin/errors/summary?window=today\|7d\|30d\|1y` | `error.read` | Counts, top fingerprints, trend series |
| GET | `/api/admin/errors/fingerprints` | `error.read` | Paginated, filter by severity/status/source |
| GET | `/api/admin/errors/fingerprints/:id` | `error.read` | Detail + last 50 events |
| PATCH | `/api/admin/errors/fingerprints/:id` | `error.write` | ack / resolve / mute / notes |

**Custom pages.** `App.jsx:896`'s `<Navigate to="/" replace />` must become a
real `<NotFound />` — silently redirecting is worse than a 404 because the user
can't tell whether the link was wrong or the app broke.

- **404:** full-screen, illustrated, "That page doesn't exist." + search + 3
  contextual links by role (`Browse events` / `My dashboard`).
- **403:** explains *why* — "This page is for organizers. You're signed in as a
  student." + the actual next action (request organizer access). Generic "Access
  denied" generates support tickets.
- **500:** friendly, non-technical, with a **reference id** (the `request_id`)
  the user can quote, a Retry that actually retries, and a "Report what
  happened" box. The reference id is the difference between "it broke" and a
  diagnosable ticket.
- **Toasts:** the existing `addToast` becomes taxonomy-driven — every error code
  maps to `{message, severity, recoveryAction}`. No raw server strings shown to
  users, ever.
- **Offline banner:** distinct from an error. `navigator.onLine` + failed-fetch
  detection.

**Dashboard UX** (super admin): a header row of four stat tiles (errors today /
vs yesterday % / affected users / unresolved criticals), a trend chart with a
window selector, then a triage table sorted by `affected_users` — because
"broke for 40 people once" outranks "broke for one person 40 times." Row →
detail: sparkline, first/last seen, release introduced, device/browser
breakdown, last 50 redacted stacks, and ack/resolve/mute.

**Tests.** Redaction scrubs each PII class (table-driven); identical errors from
different line numbers share a fingerprint; different errors don't collide;
route template drops ids; rollup math matches raw counts; retention sweep
deletes >90d and keeps rollups; rate limiter caps client reports; oversized
payload rejected; non-super-admin gets 403 on every dashboard endpoint (comes
free from W0's matrix); 404/403/500 pages render for the right conditions.

---

### W5 — Dashboard redesign (v1.4)

**Principle from the brief, taken literally: no meaningless graphs.** Every
chart must answer a question its viewer actually asks, and the question is
written above the chart as its title. If we can't name the question, the chart
is cut.

**Performance approach.** Do not aggregate at request time. Nightly rollups via
the existing maintenance job, read directly by the dashboard endpoints:

```sql
CREATE TABLE IF NOT EXISTS metrics_daily (
  day             TEXT NOT NULL,
  scope           TEXT NOT NULL,     -- 'platform' | 'school:<id>' | 'user:<id>' | 'org:<id>'
  metric          TEXT NOT NULL,     -- 'hours_credited' | 'events_published' | 'active_users' | …
  dimension       TEXT,              -- e.g. category slug, NULL for totals
  value           REAL NOT NULL,
  computed_at     TEXT NOT NULL,
  PRIMARY KEY (day, scope, metric, dimension)
);
CREATE INDEX IF NOT EXISTS idx_metrics_scope ON metrics_daily(scope, metric, day);
```

One table, one shape, all four dashboards. Backfilled from `hours_ledger` +
`attendance` + `events` on first run. Recomputable from scratch — never the
source of truth, always a cache, so a rollup bug is never a data-loss bug.

**Student dashboard — "Am I on track, and what's next?"**
- Hero: hours total, with progress ring toward a goal (goal is user-set or
  school-set; needs `service_goals` — see W8).
- Next commitment card: nearest accepted slot, with weather (W6) and directions.
- **Streak:** must be defined precisely or it's a lie. Definition: *consecutive
  calendar months containing ≥1 credited attendance.* Monthly, not weekly —
  weekly streaks punish students for exam weeks and school holidays, which makes
  the metric hostile. Broken streaks show "best streak" so history isn't erased.
- Charts: cumulative hours over time (question: *will I hit my goal?* — with a
  goal line and a projection); category mix donut (*am I well-rounded?* — NHS
  applications ask this); monthly activity bars (*when do I actually volunteer?*).
- Impact summary in human units, generated from category + hours ("You've helped
  serve ~1,200 meals"), with the conversion factors stored and documented per
  category so the number is defensible, not invented.
- Badges: see W8's `awards`. Earned-only display with progress on the next one;
  no locked-badge wall (demotivating and clutters mobile).

**Organizer dashboard — "Will my shifts fill, and who's coming?"**
- Action queue first: pending applications, unmarked attendance, expiring
  deadlines. This is the dashboard's real job.
- Fill rate per upcoming event (accepted / capacity) with a risk flag when a
  shift is <50% filled within 72h of start.
- Attendance rate and no-show rate over their last 10 events (question: *how
  much should I over-book?*).
- Volunteer retention: first-time vs returning split (*am I building a base?*).
- Demographics: **grade-band distribution only**, and **suppressed below n=5**
  (§11) — an organizer must not be able to identify individuals by cross-filtering.

**Admin dashboard — "Is the school meeting its service commitment?"**
- School-wide credited hours this year vs last, participation rate
  (distinct students with ≥1 credited hour / enrolled), median hours per
  participating student (median, not mean — a few 200-hour students distort a
  mean badly).
- Participation trend by month; category distribution; top organizations by
  hours hosted.
- Verification queue depth + median time-to-decision (W8) — this is the metric
  an activities director is actually judged on.
- Equity view: participation by grade band, flagging bands that lag — the
  question a district cares about, and a genuine differentiator.

**Super admin dashboard + public impact page — "Is the platform working, and is
it worth it?"**
- The big numbers the brief wants: total hours, volunteers, events, organizations.
- Growth: MoM new users, WAU/MAU, retention cohort curve.
- Most popular categories, most active organizations, geographic distribution
  (a Leaflet heat layer over event lat/lng — W6 already provides coordinates).
- Ops row: error rate (W4), email delivery rate (W2), queue depth, DB size.
- **Public page** (`/impact`, unauthenticated): the same headline stats,
  aggregate-only, with the k-anonymity floor applied, cached for 1 hour, and
  **explicitly no per-user or per-school breakdown**. This is the shareable
  artifact — big type, animated count-up, one map, a category bar. It should
  look like something a superintendent screenshots for a board meeting.

**API.** `GET /api/dashboard/student|organizer|admin|super` (each behind its
capability, each returning a single composed payload — one request per
dashboard, not eight), plus `GET /api/impact/public` (no auth, cached).

**Frontend.** `BarChart.jsx` exists; add `Sparkline.jsx`, `ProgressRing.jsx`,
`StatTile.jsx`, `TrendChart.jsx` as SVG primitives using design tokens (no
chart library — `noHardcodedColors.test.js` and the tokens discipline are worth
more than a dependency, and our chart needs are simple). All charts get
`role="img"` + a text `aria-label` carrying the actual numbers, and a "view as
table" toggle — accessibility here is also the mobile fallback.

**Tests.** Rollup correctness vs. direct aggregation on a seeded fixture;
streak definition edge cases (month boundaries, gaps, timezone); median vs mean;
k-anonymity suppression at n=4 vs n=5; public endpoint leaks no user-level data
(assert on shape, not just values); each dashboard endpoint 403s for wrong
capability; empty-state rendering for a brand-new user (the most common first
experience, and the easiest to get wrong).

---

### W6 — Maps, location, weather (v1.4, polish)

**Current: mostly done.** 13 location components, Leaflet + react-leaflet,
Nominatim geocoding (rate limited, auth required), Open-Meteo weather,
`events.latitude/longitude/address`, `useGeolocation`, `LocationContext`,
`DirectionsButton`, `docs/features/location-system.md`.

**What's actually left:**

1. **Provider policy compliance — the real risk.** These are free services with
   usage policies, and violating them gets us blocked mid-demo.
   - **Nominatim:** max 1 req/s, a valid identifying `User-Agent`/`Referer`
     required, and **results must be cached** rather than re-requested. Verify
     `geocodeRoutes.js` sets a real UA and add a persistent `geocode_cache`
     table (address hash → lat/lng, 30-day TTL). Bulk geocoding is prohibited.
   - **OSM tile servers:** the tile usage policy forbids heavy/commercial use.
     A district rollout is exactly the traffic that gets an app blocked.
     **Recommendation:** switch the tile layer to a free-tier tile host with an
     explicit allowance — Carto Positron or MapTiler (100k tiles/mo free, no CC)
     — and keep OSM tiles for dev only. Attribution stays in both cases.
   - **Open-Meteo:** free for non-commercial use, ~10k calls/day. Cache by
     `(round(lat,2), round(lng,2), date)` — a school district's events cluster
     in a few square miles, so cache hit rate will be very high.
2. **Distance filtering, server-side.** Bounding-box prefilter then Haversine
   ordering, inside the existing `eventQuery.js` so it composes with the
   server-side filters and pagination the sprint just built:
   ```sql
   WHERE latitude BETWEEN :minLat AND :maxLat
     AND longitude BETWEEN :minLng AND :maxLng
   ORDER BY ( (latitude-:lat)*(latitude-:lat)
            + (longitude-:lng)*(longitude-:lng)*:cosFactor ) ASC
   ```
   Squared-euclidean with a `cos(lat)` correction is sufficient for ordering at
   county scale and avoids trig in SQLite; exact Haversine is computed in JS for
   the displayed "2.3 mi away".
3. **Weather that changes behaviour, not decoration.** `events.is_outdoor`
   (new boolean). For outdoor events within 7 days, show the forecast; when
   precipitation probability >60% or temperature is outside 40–95°F, surface a
   warning **to the organizer** with a one-tap "Notify attendees" that composes
   a schedule-change message (W2). That is the difference between a gimmick and
   a feature: it triggers an action.
4. **Privacy.** `useGeolocation` must be opt-in per session, never persisted
   server-side, and "near me" must degrade to a manual location entry. Student
   coordinates are never sent to the server — distance filtering sends a
   coarsened center (2 decimal places ≈ 1 km) instead of an exact position.

**Tests.** Geocode cache hit avoids the outbound call; Nominatim limiter holds
1 req/s; bounding-box math at negative longitudes; distance ordering matches a
JS Haversine reference within tolerance; weather cache key rounding; warning
thresholds; geolocation denial path renders manual entry.

---

### W7 — Event taxonomy (v1.4)

**Current:** `events.category TEXT CHECK(category IN ('School','5K','Food
Pantry','Fundraiser','Other'))`. These aren't categories — `5K` is an event
format, `School` is a venue, and `Other` absorbs everything real. No tags.

**Target schema.**

```sql
CREATE TABLE IF NOT EXISTS event_categories (
  id          TEXT PRIMARY KEY,
  slug        TEXT UNIQUE NOT NULL,       -- 'food-security'
  label       TEXT NOT NULL,              -- 'Food Security'
  description TEXT,
  icon        TEXT,                       -- lucide icon name
  color_token TEXT NOT NULL,              -- design-token name, never a hex (tokens.test.js)
  sort_order  INTEGER NOT NULL,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS event_tags (
  id           TEXT PRIMARY KEY,
  slug         TEXT UNIQUE NOT NULL,      -- 'nhs'
  label        TEXT NOT NULL,             -- 'NHS'
  category_id  TEXT,                      -- optional affinity, for suggestions
  status       TEXT CHECK(status IN ('curated','suggested','rejected','merged')) NOT NULL DEFAULT 'suggested',
  merged_into  TEXT,                      -- set when status='merged'
  usage_count  INTEGER NOT NULL DEFAULT 0,
  created_by   TEXT,
  created_at   TEXT NOT NULL,
  FOREIGN KEY(category_id) REFERENCES event_categories(id) ON DELETE SET NULL,
  FOREIGN KEY(merged_into) REFERENCES event_tags(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS event_tag_map (
  event_id TEXT NOT NULL, tag_id TEXT NOT NULL, added_at TEXT NOT NULL,
  PRIMARY KEY (event_id, tag_id),
  FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY(tag_id)   REFERENCES event_tags(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tagmap_tag ON event_tag_map(tag_id);

CREATE TABLE IF NOT EXISTS user_tag_interests (
  user_id TEXT NOT NULL, tag_id TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,       -- decays; built from applications + favorites
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, tag_id)
);
```

**Seed categories** (from the brief, plus the two a school actually needs):
Education, Environment, Food Security, Animal Welfare, Community Service,
Healthcare, Arts & Culture, Government & Civics, Sports & Recreation, Faith &
Service.

**Migration — expand/contract, because this one can't be a big-bang.** The
category CHECK constraint means another table rebuild, and there are existing
rows plus `eventQuery.js` filters, `EventCard` badges, and seed data depending
on the old values.

| Step | Release | Action |
|---|---|---|
| 1 | v1.4.0 | Create the three new tables; seed categories + curated tags |
| 2 | v1.4.0 | Rebuild `events` **without** the category CHECK; add `category_id TEXT REFERENCES event_categories(id)`; keep the old `category` column |
| 3 | v1.4.0 | Backfill `category_id` via an explicit, reviewed mapping and auto-tag |
| 4 | v1.4.0 | Dual-write: writes set both columns; reads prefer `category_id` |
| 5 | v1.4.1 | Verify zero NULL `category_id`; switch reads to `category_id` only |
| 6 | v1.5.0 | Drop `events.category` |

Legacy mapping (explicit — an auto-guess here silently mislabels history):

| Old | → Category | → Auto-tags |
|---|---|---|
| `School` | Education | `#school` |
| `5K` | Sports & Recreation | `#outdoor`, `#fundraiser`, `#5k` |
| `Food Pantry` | Food Security | `#food` |
| `Fundraiser` | Community Service | `#fundraiser` |
| `Other` | Community Service | `#uncategorized` ← flagged for organizer re-triage |

`Other` → Community Service is a **lossy** mapping. Rather than guess, rows
mapped from `Other` are tagged `#uncategorized` and surfaced to their organizer
in a "confirm your event's category" prompt. Honest degradation beats invented
precision, and it turns a data problem into a one-tap task.

**Tag governance.** Curated tags are admin-managed; organizers may suggest, and
a suggestion is usable immediately but marked `suggested` and invisible in
filter facets until curated. Admin tools: approve, rename, merge (with
`merged_into` so old links keep resolving), reject. Without merge, we get
`#Pets`, `#pets`, `#PetCare`, `#animals` within a month and the analytics are
worthless. Slugs are normalized (lowercase, hyphenated, deduped on write).

**Recommendations v2.** `routes.recommendations.test.js` already exists, so this
enhances rather than creates. Score = weighted sum of tag-interest overlap
(`user_tag_interests` ⋂ event tags), category affinity, distance (W6), schedule
compatibility with the student's past accepted slots, and a small boost for
under-filled shifts (which serves organizers too). Interest weights are built
from applications and favorites with time decay. Explicitly **explainable**:
each recommendation ships the reason ("Because you volunteered at 3 Food
Security events"). An unexplainable recommendation in a school product is a
trust problem, not just a UX one.

**Tests.** Slug normalization/dedupe; merge preserves event associations;
suggested tags excluded from facets; the full legacy mapping table (row per
mapping); `usage_count` maintenance; backfill leaves zero NULLs; dual-write
consistency; recommendation determinism on a fixture; recommendation always
carries a reason.

---

### W8 — Service portfolio & external hours (v2.0)

The single biggest product differentiator here. Students currently keep hours in
WeVolunteer **and** a spreadsheet for NHS. Owning the whole record is what makes
the platform indispensable.

**The invariant that governs the whole design:** platform hours are *derived*
from `attendance` via `hours_ledger`, with parity verification
(`verifyLedgerParity`). External hours are *asserted* by a student and
*attested* by a verifier. **These must never share a table.** Writing
self-reported hours into `hours_ledger` would destroy the property that makes
platform hours trustworthy, and it would break parity verification.

**Schema.**

```sql
CREATE TABLE IF NOT EXISTS service_entries (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  source           TEXT CHECK(source IN ('platform','external')) NOT NULL,
  -- platform rows: derived, read-only, hours mirrored from hours_ledger
  event_id         TEXT,
  slot_id          TEXT,
  -- external rows: student-asserted
  title            TEXT,
  organization     TEXT,
  organization_contact TEXT,               -- for verifier follow-up; PII, access-controlled
  category_id      TEXT,
  served_on        TEXT,                   -- ISO date
  hours            REAL,
  description      TEXT,
  verification_status TEXT CHECK(verification_status IN
    ('unverified','pending','verified','rejected','expired')) NOT NULL DEFAULT 'unverified',
  verified_by      TEXT,
  verified_at      TEXT,
  rejection_reason TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  FOREIGN KEY(user_id)     REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(event_id)    REFERENCES events(id) ON DELETE SET NULL,
  FOREIGN KEY(category_id) REFERENCES event_categories(id) ON DELETE SET NULL,
  FOREIGN KEY(verified_by) REFERENCES users(id) ON DELETE SET NULL,
  CHECK (source = 'platform' OR (title IS NOT NULL AND hours IS NOT NULL AND served_on IS NOT NULL)),
  CHECK (hours IS NULL OR (hours > 0 AND hours <= 24))
);
CREATE INDEX IF NOT EXISTS idx_service_user   ON service_entries(user_id, served_on);
CREATE INDEX IF NOT EXISTS idx_service_status ON service_entries(verification_status, created_at);
-- Duplicate-submission guard (same student, org, date, hours):
CREATE UNIQUE INDEX IF NOT EXISTS idx_service_dedupe
  ON service_entries(user_id, organization, served_on, hours) WHERE source = 'external';

CREATE TABLE IF NOT EXISTS service_evidence (
  id           TEXT PRIMARY KEY,
  entry_id     TEXT NOT NULL,
  kind         TEXT CHECK(kind IN ('file','link','contact_attestation')) NOT NULL,
  storage_key  TEXT,                       -- opaque; never a user-controlled path
  original_name TEXT,
  mime_type    TEXT,
  byte_size    INTEGER,
  sha256       TEXT,
  url          TEXT,
  uploaded_at  TEXT NOT NULL,
  FOREIGN KEY(entry_id) REFERENCES service_entries(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS verification_requests (
  id           TEXT PRIMARY KEY,
  entry_id     TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  assignee_id  TEXT,                        -- specific verifier, or NULL for the pool
  verifier_kind TEXT CHECK(verifier_kind IN ('nhs_advisor','teacher','organizer','admin')) NOT NULL,
  status       TEXT CHECK(status IN ('open','approved','rejected','withdrawn','expired')) NOT NULL DEFAULT 'open',
  decided_by   TEXT, decided_at TEXT, decision_note TEXT,
  created_at   TEXT NOT NULL, expires_at TEXT NOT NULL,   -- 30 days
  FOREIGN KEY(entry_id) REFERENCES service_entries(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS service_goals (
  id TEXT PRIMARY KEY, user_id TEXT, school TEXT,
  label TEXT NOT NULL,                      -- 'NHS 2026–27', 'Graduation requirement'
  target_hours REAL NOT NULL,
  category_id TEXT,                         -- optional: category-specific requirement
  period_start TEXT NOT NULL, period_end TEXT NOT NULL,
  counts_external INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS awards (
  id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, label TEXT NOT NULL,
  description TEXT NOT NULL, icon TEXT, criteria_json TEXT NOT NULL, sort_order INTEGER
);
CREATE TABLE IF NOT EXISTS user_awards (
  user_id TEXT NOT NULL, award_id TEXT NOT NULL, earned_at TEXT NOT NULL,
  PRIMARY KEY (user_id, award_id)
);
```

**Platform rows are projections.** `service_entries` rows with
`source='platform'` are maintained by a trigger-equivalent in application code
whenever `hours_ledger` changes — never edited directly, always
`verification_status='verified'`, and fully rebuildable from `hours_ledger`.
This gives one unified timeline to render without compromising the ledger.

**Verifier model.** Do **not** add `nhs_advisor` to `users.role` — that is role
explosion, and an NHS advisor is usually also a teacher and sometimes an
organizer. Use W0's `user_capabilities`: grant `service.verify.external` scoped
to a school. Admins grant it; grants are audit-logged and expirable.

**Verification workflow.**

```
Student adds external entry
  → status 'unverified'  (visible to student, excluded from official totals)
  → student requests verification, choosing a verifier kind
     • nhs_advisor / teacher → routed to holders of service.verify.external at their school
     • organizer            → routed to that event's organizer (must be a platform-known org)
  → verifier queue: entry + evidence + a "this student claims X hours on DATE" summary
  → decision requires step-up auth (W1) — it writes to a student record
  → approve → 'verified', verified_by/at recorded, immutable from then on
     reject  → 'rejected' + reason, student may edit and resubmit (creates a NEW request;
               the old one is retained for audit)
  → 30 days with no decision → 'expired', student notified, may re-request
  → every transition → admin_audit_logs + email (W2)
```

**Abuse prevention** — a self-reported-hours feature is an integrity target, and
a district *will* ask about this:
- Verifier must be a different user than the student; a self-verification
  attempt is a `critical` audit event.
- Hard caps: ≤24h per entry (schema CHECK), ≤16h per student per calendar day
  summed across entries, ≤40h per submission batch.
- The unique dedupe index blocks the copy-paste duplicate.
- Evidence required above a configurable threshold (default: >8h in one entry).
- Verified entries are immutable; a correction is a new entry plus a void of the
  old, never an in-place edit.
- Rate limit: 20 new entries per student per day.
- Anomaly flag surfaced to admins: any student whose external hours exceed 3×
  their platform hours, or who submits >50h in a week.
- Evidence files: extension **and** magic-byte validation, 10 MB cap,
  images+PDF only, stored under a generated key (never the user's filename),
  served through an authorizing endpoint (never a static path),
  `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`. Files
  are never publicly addressable.

**Portfolio UX — "My Service Journey."** A single vertical timeline merging both
sources, each row badged:
- `✓ Verified by WeVolunteer` (platform)
- `✓ Verified by Ms. Patel, NHS Advisor` (external, verified)
- `⏳ Pending verification` (external, requested)
- `○ Outside Source — unverified` (external, self-reported) ← the brief's
  "Outside Source" requirement, stated plainly so nobody mistakes it for
  attested hours

Header: total verified hours, split platform vs external, progress toward each
active goal. Export: printable transcript PDF + `.ics`-style attestation
document showing only verified hours, with a verification URL — extend
`certificates.js` and the existing `/verify/:code` route, which already
implements exactly this pattern for event certificates. **Unverified hours never
appear on an exported transcript**, or the export is worthless to a college.

**API.** `GET/POST/PATCH/DELETE /api/service-entries[/:id]`,
`POST /api/service-entries/:id/evidence`, `GET /api/service-entries/:id/evidence/:eid`,
`POST /api/service-entries/:id/request-verification`,
`GET /api/verifications/queue` (`service.verify.external`),
`POST /api/verifications/:id/decide` (+ AAL2),
`GET/POST /api/service-goals`, `GET /api/portfolio/export`,
`GET /api/awards` + `/api/users/me/awards`.

**Tests.** Platform entries are read-only via the API; ledger change updates the
projection; projection rebuild is idempotent; dedupe index blocks duplicates;
24h and 16h/day caps; self-verification rejected + audited; verified entries
immutable; rejection→resubmit creates a new request and retains the old;
expiry at 30 days; unverified hours excluded from goals, totals, and exports;
evidence magic-byte rejection of a renamed `.exe`; evidence not readable by a
different student (IDOR — `privacyExportIdor.test.js` is the precedent);
transcript contains only verified rows; award criteria evaluation.

---

### W9 — QR attendance (v2.0)

**Current:** `attendance_checkin(event_id, slot_id, user_id, present,
marked_by, marked_at)` — a present/absent flag, no arrival/departure, no QR. No
QR library in `package.json`.

**Threat model first**, since the brief asks for it and it drives every design
choice.

| Threat | Naive design fails how | Our mitigation |
|---|---|---|
| **Screenshot sharing** | Static QR = student ID → screenshot lets an absent friend be checked in | Rotating HMAC token, 30 s validity, live countdown; a screenshot is stale before it can be forwarded |
| **Replay** | Same token scanned twice, or captured and reused | Server-side single-use nonce table + monotonic timestamp per user; second use rejected |
| **Duplicate scan** | Organizer double-taps; hours credited twice | Idempotent on `(slot_id, user_id, scan_kind)`; second scan within 60 s returns the same result, not an error |
| **Forged QR** | Client-side-only validation | HMAC-SHA256 with a server secret; the client can render but never mint |
| **Buddy punching (physical)** | Student presents a friend's phone | Organizer sees the student's **photo + name** on scan and confirms; the scan is a lookup, not an authorization |
| **Wrong event / wrong day** | Token valid anywhere | Token is scoped to `user_id` only; the *server* binds it to event+slot from the organizer's authenticated context and rejects if the student isn't accepted for that slot or the slot's window isn't open |
| **Offline gym / no signal** | Attendance lost | Signed offline roster + local validation + IndexedDB outbox, server re-validates on sync |
| **Clock skew** | Legit students rejected | ±60 s tolerance; server time is authoritative; client shows server-synced countdown |
| **Camera-less device** | Flow blocked | 6-character rotating numeric fallback code, and manual roster marking always remains |

**Token design.**

```
Student-presented payload (base64url, ~120 bytes, well within QR v4 at ECC-M):
  v   : 1
  uid : user id
  ts  : issued-at (server epoch seconds)
  n   : 8-byte random nonce
  sig : HMAC-SHA256(secret_current, `${v}|${uid}|${ts}|${n}`) truncated to 16 bytes

Secret: WEV_QR_SECRET, 32 bytes, rotated with an overlap window
        (accept current + previous for 24 h so rotation never breaks a live event).
Validity: 30 s, ±60 s skew tolerance.
Rendering: token minted server-side (GET /api/attendance/qr/token),
           refreshed via the existing socket.io channel; falls back to polling.
```

Why not client-side derivation (real TOTP)? It would require shipping a
per-user secret to the browser, where it is extractable and therefore
shareable — reintroducing the screenshot problem in a worse form. Server-minted
tokens keep the secret server-side.

**Two scan directions, both needed:**
- **Organizer scans student** (brief's flow): best for small shifts, gives the
  organizer the photo-confirmation step.
- **Student scans event QR** (organizer displays it on a laptop/printout): far
  better for a 200-person 5K, since throughput isn't bottlenecked on one device.
  Event QR carries `event_id + slot_id + rotating sig`; the student's
  authenticated session supplies identity. Same table, `scan_kind` records which
  direction was used.

**Schema — move from a flag to an append-only scan log.** Deriving state from
events (rather than mutating a flag) is what makes offline sync, arrival vs
departure, and dispute resolution tractable.

```sql
CREATE TABLE IF NOT EXISTS attendance_scans (
  id            TEXT PRIMARY KEY,
  event_id      TEXT NOT NULL,
  slot_id       TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  kind          TEXT CHECK(kind IN ('arrival','departure')) NOT NULL,
  method        TEXT CHECK(method IN ('qr_scan_student','qr_scan_event','manual','fallback_code')) NOT NULL,
  scanned_at    TEXT NOT NULL,              -- server-authoritative
  client_time   TEXT,                       -- for skew diagnostics
  recorded_by   TEXT,                       -- organizer, NULL when student-initiated
  device_label  TEXT,
  offline_queued INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT UNIQUE NOT NULL,     -- client-generated; makes retry safe
  token_nonce   TEXT,
  created_at    TEXT NOT NULL,
  FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY(slot_id)  REFERENCES slots(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id)  REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_scans_slot ON attendance_scans(slot_id, user_id, kind);

CREATE TABLE IF NOT EXISTS qr_nonces (
  nonce TEXT PRIMARY KEY, user_id TEXT NOT NULL, used_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_qr_nonce_exp ON qr_nonces(expires_at);
```

`attendance_checkin` stays as the derived present/absent state so existing
routes, `hours_ledger`, and 500 passing tests keep working — the scan log feeds
it. Hours become `min(departure - arrival, slot_duration)` when both scans
exist, falling back to `slotDuration(slot)` (the existing behaviour in
`attendance.js:56`) when only arrival exists. Organizers can always override,
and an override is audit-logged with the original value retained — this is a
student's transcript, so the audit trail is the product.

**Offline design (depends on W3).** On opening the scanner, the organizer's
device downloads a signed roster (accepted students for the slot: id, name,
photo hash) valid 12 h. Offline scans are validated locally against the HMAC
(the device holds a per-event scoped verification key, not the master secret),
queued in IndexedDB with an idempotency key, and shown as "pending sync." On
reconnect, Background Sync flushes them; the **server re-validates everything**
and may reject (e.g. student withdrew). Conflicts surface to the organizer for
resolution rather than being silently dropped.

**Libraries.** `qrcode` (render, server or client), `jsqr` or `html5-qrcode`
(scan). Camera access requires HTTPS and a user gesture — both already
constraints from W3.

**UX.** Student: hours card → "Show my check-in code" → large QR, countdown
ring, brightness boost, name underneath, 6-char fallback code. Organizer:
scanner full-screen with a live roster strip, big success/failure feedback
(haptic + sound — the organizer is looking at a crowd, not a screen), running
"12 of 30 arrived" count, a mode switch for arrival/departure, and search-based
manual marking always one tap away.

**Tests.** Valid token accepted; expired (31 s) rejected; future-dated beyond
skew rejected; tampered signature rejected; previous-secret accepted within the
rotation window, rejected after; nonce reuse rejected; duplicate idempotency key
returns the original scan (not an error, not a duplicate row); scan for a
non-accepted student rejected; scan outside the slot window rejected; organizer
without `attendance.scan` rejected (from W0's matrix); departure before arrival
rejected; hours derivation with both/one/neither scan; offline queue flush is
idempotent across a double flush; server rejection of a synced scan surfaces to
the organizer.

---

### W10 — Super admin, platform ownership, and impersonation (v2.0)

**Depends on W0 (roles/capabilities) and W1 (step-up).**

**Accounts.**
- **Platform account** (`wevolunteer.platform@gmail.com`): `role='super_admin'`,
  the public identity and the only account that can mint other admins. Created
  by a one-time bootstrap script (extend `bin/make-admin.mjs`), never through
  signup. Must have OAuth linked and, ideally, 2FA at the Google level — this
  account is the platform's root of trust.
- **Developer account** (Mahit): a normal `student` account by default, so it
  looks and behaves like a student's — which is the point, since it's how you
  see what students see. Elevation is *temporary* and *granted*, never a
  standing role.

**"Switch Access" is impersonation, and impersonation must never be
multi-role.** The brief is right to flag the danger. A single account holding
four roles is a permanent privilege-escalation surface and makes every audit log
ambiguous. Instead:

```
Principal shape (from W0):
  { userId: <target>, actualRole, effectiveRole, actorId: <developer>|null, aal, impersonating }

Impersonation token: short-lived JWT, separate cookie, carrying an actor claim
  { sub: targetUserId, act: { sub: developerUserId }, sid, exp: now + 30 min }
(RFC 8693-style delegation: the token says *who is acting as whom*, so every
 downstream log and check can see both.)
```

**Gate — all five conditions required to start impersonation:**
1. Caller's `actualRole === 'super_admin'`, **or** caller's id is in the
   `WEV_IMPERSONATION_ALLOWLIST` env var. Not a database flag — an env var, so
   granting it requires deploy access, not just a DB write.
2. Step-up AAL2 within the last 5 minutes (W1), action
   `impersonation.start`, `params_hash` binding the specific target.
3. Target is not another `super_admin` (no lateral root access).
4. An `impersonation_sessions` row is created *before* the token is issued.
5. A `critical`-severity audit event is written and a security email is sent to
   the platform account (W2) — so an unexpected impersonation is noticed.

```sql
CREATE TABLE IF NOT EXISTS impersonation_sessions (
  id            TEXT PRIMARY KEY,
  actor_id      TEXT NOT NULL,
  target_id     TEXT NOT NULL,
  mode          TEXT CHECK(mode IN ('read_only','read_write')) NOT NULL DEFAULT 'read_only',
  reason        TEXT NOT NULL,               -- required free text; audits need intent
  started_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,               -- started_at + 30 min, hard cap
  ended_at      TEXT,
  ended_reason  TEXT CHECK(ended_reason IN ('user_exit','expired','revoked','logout')),
  request_count INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(actor_id)  REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(target_id) REFERENCES users(id) ON DELETE CASCADE
);
```

**Constraints while impersonating:**
- **`read_only` is the default mode**, and it denies every mutating verb except
  an explicit allowlist needed to exercise a flow. `read_write` requires a
  second step-up and is capped at 15 minutes.
- **Always denied, in either mode:** `account.delete`, `password.change`,
  `email.change`, `oauth.disconnect`, `data.export`, `impersonation.start`
  (no chaining), and any capability the *target* doesn't have (impersonation
  can never grant more than the target has — it's a view, not an escalation).
- **Every request** during the session increments `request_count` and, for
  mutations, writes `admin_audit_logs` with **both** `actor_id` and
  `target_id`. An audit line that says only "the student changed X" during an
  impersonation session is a compliance failure.
- A persistent, unmissable banner: `⚠ Viewing as Leo Chen (read-only) · 24:31
  left · [Exit]`. Non-dismissible, offset so it never covers a primary action,
  and rendered in a distinct color token.
- Exit restores the original session (the developer's own cookie is preserved
  and re-activated, never re-issued from the impersonation token).
- Socket.IO connections must carry and enforce the same principal — a
  long-lived socket is the easy place to leak authority past token expiry.
  `socket.envelope.test.js` gives us the pattern to extend.

**This replaces `DemoBar.jsx`.** That component swaps whole accounts by id from
a hardcoded list and is `DEMO_MODE`-gated scaffolding. Impersonation is its
supportable successor; `DemoBar` should be deleted in the same release so two
account-switching mechanisms never coexist.

**Profile menu UX.** `ProfileMenu.jsx` already imports `ChevronsUpDown`, so the
affordance is anticipated. The item is rendered only when
`can(principal,'impersonation.start')` — and because the client capability table
is advisory, the endpoint enforces it independently. It is not "hidden" by
obscurity; it is absent because the capability is absent.

```
Profile menu (developer account only)
  Edit Profile / Notifications / Settings / Sign Out
  ──────────────────────────────
  ⇅ Switch Access
      → Verify your identity (W1)
      → Pick mode: [Read-only ▾]  Reason: [………]
      → Search a user, or pick a role archetype (a seeded demo user per role)
      → Confirm → banner appears, session starts
```

**Tests.** Non-super-admin cannot start impersonation (matrix); missing AAL2
rejected; impersonating a super_admin rejected; chaining rejected; read-only
blocks mutations; denied-action list enforced in read_write too; capability
intersection (impersonating a student cannot reach admin routes); 30-minute
hard expiry; exit restores the original session; audit rows contain both ids;
socket connections respect expiry; `request_count` increments.

---

## 8. Consolidated database migration plan

Ordered, one release per group, each behind the §4.2 registry with an
idempotency test.

| # | Migration | Release | Type | Risk | Notes |
|---|---|---|---|---|---|
| 001 | `schema_migrations` + registry | v1.2.0 | additive | low | Must land alone, first |
| 002 | `users` rebuild: add `super_admin`,`partner` to role CHECK | v1.2.0 | **rebuild** | **high** | Ships alone; backup + `foreign_key_check` + ledger parity after |
| 003 | `user_capabilities` | v1.2.0 | additive | low | |
| 004 | `reauth_challenges` | v1.2.1 | additive | low | |
| 005 | `error_fingerprints`, `error_events`, `error_daily_rollup` | v1.2.1 | additive | low | |
| 006 | `email_messages`, `email_suppressions` | v1.3.0 | additive | low | |
| 007 | `push_subscriptions` | v1.3.0 | additive | low | |
| 008 | `event_categories`, `event_tags`, `event_tag_map`, `user_tag_interests` | v1.4.0 | additive | low | Seeded |
| 009 | `events` rebuild: drop category CHECK, add `category_id`, `is_outdoor` | v1.4.0 | **rebuild** | **high** | Ships alone; slots/applications FK into events |
| 010 | Backfill `category_id` + auto-tags per the §7.7 mapping | v1.4.0 | data | medium | Reversible; `Other` rows flagged |
| 011 | `metrics_daily` + backfill from `hours_ledger` | v1.4.0 | additive | low | Rebuildable cache |
| 012 | `geocode_cache` | v1.4.1 | additive | low | |
| 013 | `service_entries`, `service_evidence`, `verification_requests`, `service_goals`, `awards`, `user_awards` | v2.0.0 | additive | medium | Largest additive set; platform-row projection backfill |
| 014 | `attendance_scans`, `qr_nonces` | v2.0.0 | additive | medium | `attendance_checkin` retained as derived state |
| 015 | `impersonation_sessions` | v2.0.0 | additive | low | |
| 016 | Drop `events.category` | v1.5.0 / post-v2 | **rebuild** | medium | Only after 010 verifies zero NULLs |

**Rules for every migration:**
1. `bin/backup.sh` runs before any migration in the `rebuild` class, and the
   runbook already documents copying `-wal`/`-shm` alongside the `.db`.
2. Rebuilds follow the full SQLite 12-step procedure with `PRAGMA foreign_keys
   = OFF` outside a transaction, DDL inside it, `PRAGMA foreign_key_check`
   before `COMMIT`.
3. Every migration has a "runs twice cleanly" test and, for rebuilds, a
   row-count + checksum equality assertion against a fixture DB.
4. Only one `rebuild`-class migration per release. Ever.
5. `verifyLedgerParity()` runs after any migration touching `users`, `events`,
   `slots`, `applications`, or `attendance`.
6. Down-migrations are **not** provided; recovery is restore-from-backup. Down
   migrations for destructive DDL are a comforting fiction, and a tested restore
   (`bin/verify-restore.sh` exists) is the real control.

---

## 9. API surface changes

**New route groups:** `/api/auth/reauth/*` (4), `/api/errors/client` (1),
`/api/admin/errors/*` (4), `/api/dashboard/*` (4), `/api/impact/public` (1),
`/api/categories` + `/api/tags` + `/api/admin/tags/*` (6),
`/api/service-entries/*` (7), `/api/verifications/*` (2),
`/api/service-goals` (2), `/api/awards` (2), `/api/attendance/qr/*` (3),
`/api/attendance/scan` (1), `/api/attendance/roster/offline` (1),
`/api/push/subscribe|unsubscribe` (2), `/api/impersonation/start|end` (2),
`/api/webhooks/email/bounce` (1). ≈ 43 new endpoints.

**Modified:** all ~40 existing handlers swap inline role checks for
`requireCap()` (W0, behaviour-preserving). `/api/events` gains `category`,
`tags[]`, `distance`, `lat`, `lng`, `is_outdoor` filters inside the existing
server-side filter + pagination machinery. Sensitive endpoints gain
`requireAAL2`. `Cache-Control: no-store` added to PII endpoints (W3).

**Conventions to hold** (all already established in this codebase): cookie
auth, `{ error: string }` failure envelope, 401 vs 403 distinction, rate
limiters per route group, ISO-8601 UTC strings, cursor/offset pagination as
already implemented. **No API versioning prefix** — this is a single-client
platform, and `/v2` would be ceremony. Breaking changes are coordinated with
the SPA deploy, which is atomic.

---

## 10. Frontend architecture changes

1. **Decompose `App.jsx` (1286 lines).** → `App.jsx` (shell + providers) +
   `src/routes/index.jsx` (route table with `requiredCap`) +
   `src/session/SessionProvider.jsx` (bootstrap, currently tangled into App and
   the cause of the TD-9 flake). This is the single highest-leverage refactor in
   the plan: it is the file every workstream must touch.
2. **`src/authz.js` + `<Can>` + `useCan()`** replace ~15 role ternaries.
3. **New providers:** `SessionProvider`, `ImpersonationProvider` (banner +
   effective principal), `OfflineProvider` (online state + outbox depth),
   `ToastProvider` (formalizing the existing `addToast`).
4. **`src/charts/`** primitives: `StatTile`, `Sparkline`, `TrendChart`,
   `ProgressRing`, `DonutChart` — SVG, token-driven, accessible, no dependency.
5. **`src/errors/`**: `NotFound`, `Forbidden`, `ServerError`, `OfflineNotice`,
   plus an error-code → user-message map. Extend `ErrorBoundary.jsx` to report.
6. **`src/pwa/`**: `sw.js`, registration with update prompt, `outbox.js`
   (IndexedDB), `push.js`.
7. **`src/qr/`**: `QrDisplay`, `QrScanner`, `FallbackCode`.
8. **Mobile primitives:** `Sheet` (full-screen modal on mobile),
   `TapTarget`, `SkeletonList`, `MobileNav` driven by capabilities.
9. **Keep:** colocated CSS, design tokens (`noHardcodedColors.test.js`,
   `tokens.test.js`, `noDanglingClasses.test.js`), `React.lazy` per route,
   `useModal` focus discipline (`dialogSemantics.test.jsx`). These guardrails
   are why this codebase is in good shape; every new component must satisfy them.

---

## 11. Consolidated security & privacy concerns

Ranked by likely harm.

1. **Service-worker cache leaking PII across users on shared devices** (W3).
   Highest-severity *new* risk this plan introduces. Controls in §W3; a
   PII-endpoint allowlist test is mandatory before the SW ships.
2. **Adding a role locks out authorization checks** (W0/§3). Controls: capability
   kernel + generated matrix test.
3. **Impersonation as a backdoor** (W10). Controls: env-var allowlist, step-up,
   read-only default, capability intersection, 30-min cap, dual-id audit, no
   chaining, banner.
4. **Stack traces leaking PII** (W4). Controls: redact-on-write, no bodies/URLs/
   headers, 90-day retention, super-admin-only access, access itself audited.
5. **Self-reported hours fraud** (W8). Controls: distinct-verifier rule, caps,
   dedupe index, evidence thresholds, immutability, anomaly flags.
6. **QR replay / screenshot sharing** (W9). Controls: 30 s HMAC tokens, nonce
   table, photo confirmation, server-side slot binding.
7. **Step-up grant confusion** (W1). Controls: `params_hash` binding,
   single-use, session-bound, 5-min TTL, server-side rows.
8. **Student PII in analytics** (W5). Controls: k-anonymity floor n=5 with cell
   suppression, aggregate-only public endpoint, grade bands not birthdates, no
   per-student data in organizer views beyond their own applicants.
9. **File upload as an attack vector** (W8). Controls: magic bytes, size cap,
   allowlisted types, generated storage keys, authorizing download endpoint,
   `nosniff` + attachment disposition.
10. **Email as an enumeration/spam vector** (W2). Controls: hashed recipients at
    rest, signed unsubscribe tokens, suppression list, signature-verified
    webhook, existing rate limiters.
11. **Third-party provider dependency** (W6). Controls: caching, identifying
    User-Agent, tile host with an explicit free allowance, graceful degradation
    to a static map + address text.
12. **FERPA posture overall.** Service hours tied to a named student are an
    education record. Required: data-retention policy per table, documented
    subprocessor list (SMTP provider, tile host, weather API — note that
    Nominatim/Open-Meteo receive *coordinates*, never student identity), the
    existing export/deletion flows extended to cover every new table, and a
    written answer to "what happens to a student's record when they graduate."
    **Add `docs/operations/data-inventory.md`** — a table-by-table map of what
    personal data exists, its lawful basis, retention, and deletion behaviour.
    This document is what makes a district's security review survivable, and it
    should be written during v1.2, not the week before the review.

---

## 12. Testing strategy

Current: 508 tests / 88 files, vitest + Playwright, CI = `npm ci` → test →
build → lint. That baseline is an asset; the strategy is to extend its habits,
not to add a new framework.

**Layers.**
- **Unit** — pure logic: `can()`, fingerprinting, redaction, QR sign/verify,
  hours derivation, streak calculation, distance math, slug normalization,
  category mapping, award criteria.
- **Route/integration** (the existing dominant style, and where bugs actually
  are) — every new endpoint: happy path, each auth failure, each validation
  failure, idempotency, rate limit.
- **Generated matrices** — the strategic addition:
  1. **authz matrix**: routes × roles × ownership → expected status (~400 cases).
  2. **capability completeness**: every registered route declares a capability.
  3. **template registry**: every email template escapes HTML and renders with
     empty/hostile vars.
  4. **SW cache allowlist**: no PII endpoint is runtime-cached.
  5. **migration idempotency**: every registry entry runs twice cleanly.
  These convert "did we remember?" into "the suite remembers for us," which is
  what keeps a 43-endpoint expansion from eroding the security posture.
- **Migration tests** — fixture DB at the prior schema, migrate, assert row
  counts, checksums, FK integrity, ledger parity.
- **E2E (Playwright)** — the five flows that constitute the demo: signup→verify→
  apply→accepted→hours; step-up→delete account; install PWA→offline browse→
  reconnect; QR arrival→departure→hours credited; external entry→request→
  advisor verifies→transcript export.
- **Offline/PWA** — `context.setOffline(true)`, outbox flush, double-flush
  idempotency, logout cache purge.
- **Accessibility** — extend `dialogSemantics.test.jsx` habits: keyboard
  traversal on new modals/sheets, chart `aria-label`s carrying real numbers,
  44px hit areas, focus restoration.
- **Load sanity** — not a load-testing program, just three guards: 500-event
  browse pagination, 200-student roster scan throughput, dashboard endpoint
  latency against a seeded year of `metrics_daily`. `bin/simulate-pilot.js`
  already exists to generate the data.

**Non-negotiables.** TDD per the engineering guide: failing test first, minimal
implementation, frequent commits. Zero lint warnings (the `.oxlintrc.json`
baseline). No `.only`. Every new table gets a retention/deletion test. Every
security control in §11 has a test that *fails when the control is removed* —
a control without such a test is a comment.

**Projected suite growth:** ~508 → ~1,150 tests. Runtime must stay under ~90 s
or people stop running it locally; if it grows past that, shard in CI rather
than deleting tests.

---

## 13. Deployment requirements

**New environment variables** (all documented in `.env.example`, all validated
at boot by `preflight.js`, which already exists and should **fail startup** on a
missing production secret — the `JWT_SECRET` fix established this pattern):

```
SMTP_HOST / SMTP_USER / SMTP_PASS / EMAIL_FROM      # W2 (already read by email.js)
EMAIL_BOUNCE_WEBHOOK_SECRET                          # W2
VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT # W3
WEV_QR_SECRET / WEV_QR_SECRET_PREVIOUS               # W9, rotatable with overlap
WEV_IMPERSONATION_ALLOWLIST                          # W10, comma-separated user ids
WEV_PLATFORM_ACCOUNT_EMAIL                           # W10
TILE_URL_TEMPLATE / TILE_API_KEY                     # W6
NOMINATIM_USER_AGENT                                 # W6, policy requirement
EVIDENCE_STORAGE_DIR / EVIDENCE_MAX_BYTES            # W8
ERROR_RETENTION_DAYS (90) / ERROR_SAMPLE_CEILING     # W4
```

**Infrastructure.**
- **HTTPS is now mandatory**, not advisable: camera access (W9), service worker
  and install (W3), and push (W3) all require a secure context. This is a
  release blocker for v1.3, so provision the certificate during v1.2.
- **Persistent disk** for evidence uploads (W8) — sized ~5 GB initially — and
  it must be in the backup set alongside the DB. If a persistent volume isn't
  available on the target host, that changes the W8 storage decision (Q3).
- **Backups** must now cover: `wevolunteer.db` + `-wal` + `-shm`, and the
  evidence directory. `bin/backup.sh` and `bin/verify-restore.sh` exist; extend
  and re-verify both.
- **Secret rotation runbook** for `WEV_QR_SECRET` (dual-secret overlap) and
  VAPID keys (rotation invalidates subscriptions — must trigger re-subscribe).
- **Service worker kill switch** documented and tested before the first SW
  deploy. This is the one deploy that can brick returning users.
- **CI additions:** the five generated matrix tests as required checks; a
  migration-idempotency job; a PWA/Lighthouse budget check (installability,
  performance ≥ 90 on mobile); `npm audit` gate for the ~6 new dependencies.
- **New dependencies** (deliberately few, all mature):
  `vite-plugin-pwa` + `workbox-*` (build-time), `web-push`, `qrcode`,
  `jsqr`/`html5-qrcode`. **Rejected:** any charting library (SVG primitives are
  enough and preserve the token discipline), any error-monitoring SaaS (the
  brief requires an in-product dashboard, and student PII shouldn't leave the
  district's infrastructure), any ORM/migration framework (§4.2 registry is
  ~100 lines and fits `node:sqlite`).
- **Rollback plan per release:** SPA is atomic (previous build re-deployable);
  server is a process restart; DB is restore-from-backup for rebuild
  migrations. Because rebuild migrations ship alone, a bad release is never
  entangled with a schema change we can't undo.
- **TD-2 (branch protection) is still open and blocked on tier.** With ~43 new
  endpoints landing, the discipline-only protection on `main` becomes materially
  riskier. Recommendation: make the repo public (it's a school civic project —
  publishing it is also a credibility asset) or pay for Pro, and enable
  protection before v1.2 merges. This is cheap and removes a real hazard.

---

## 14. Recommended implementation order

Numbered execution sequence. Each item becomes its own bite-sized TDD plan
document when it starts.

**v1.2 — Foundations (3–4 weeks).** *No user-visible feature. Ships the ground
everything else stands on.*
1. Migration registry + `schema_migrations` (§4.2).
2. **`users` table rebuild** for the role enum — alone, backed up, parity-verified.
3. `server/authz.js` capability kernel + `requireCap` + `user_capabilities`.
4. Convert all ~40 route checks; land the generated authz matrix + completeness tests.
5. Client `src/authz.js` + `<Can>`; decompose `App.jsx` into shell + route table + `SessionProvider`.
6. Step-up auth: `reauth_challenges`, 4 endpoints, `requireAAL2`, sensitive-action registry.
7. `VerifyIdentityModal` + wire deletion / email / password / oauth-disconnect.
8. Error capture write path: tables, fingerprinting, redaction, retention sweep, client report endpoint.
9. `docs/operations/data-inventory.md` (§11.12) — write it while the schema is fresh.

**v1.3 — Trust & Reach (4–5 weeks).**
10. Email tracking: `email_messages`, `email_suppressions`, idempotency, backoff, suppression.
11. Template registry + all ~20 templates + digest batching.
12. Notification preferences UI; email log view for super admin.
13. Custom 404 / 403 / 500 pages; remove the `App.jsx` catch-all redirect; error-code → message map; offline banner.
14. Error dashboard (summary, triage table, detail, ack/resolve/mute).
15. Mobile UX audit against the running app; fix tap targets, sheets, forms, skeletons, `MobileNav`.
16. PWA: manifest, icons, splash generation, `vite-plugin-pwa`, `sw.js` with the security-reviewed cache allowlist.
17. Cache partitioning + logout purge + the PII-allowlist test.
18. Push: VAPID, `push_subscriptions`, permission UX, iOS install path, `410` pruning.

**v1.4 — Meaning (4–5 weeks).**
19. Taxonomy tables + seed categories/tags.
20. **`events` rebuild** (drop category CHECK, add `category_id`, `is_outdoor`) — alone.
21. Backfill + auto-tag + `#uncategorized` organizer re-triage prompt.
22. Tag governance admin UI (approve/rename/merge/reject).
23. Category + tag filtering in `eventQuery.js`; facets in browse; EventCard badges.
24. `metrics_daily` + nightly rollup + backfill.
25. Chart primitives (`src/charts/`).
26. Student dashboard, then organizer, then admin, then super admin.
27. Public `/impact` page with k-anonymity suppression + caching.
28. W6 compliance: geocode cache, Nominatim UA/limit audit, tile host swap, weather cache.
29. Distance filtering server-side + coarsened client coordinates.
30. Weather warnings → organizer "Notify attendees" action.
31. Recommendations v2 with `user_tag_interests` and explanations.

**v2.0 — Platform (6–8 weeks).**
32. `service_entries` + platform-row projection from `hours_ledger` + rebuild job.
33. External entry CRUD, caps, dedupe index, rate limits.
34. Evidence upload + validation + authorizing download endpoint.
35. `verification_requests` + verifier queue + AAL2 decisions + expiry.
36. `service_goals` + progress; `awards` + `user_awards` + criteria evaluation.
37. "My Service Journey" portfolio timeline with source badging.
38. Transcript export (extend `certificates.js` + `/verify/:code`), verified-only.
39. Anomaly flags for admins.
40. `attendance_scans` + `qr_nonces`; token mint/verify; secret rotation overlap.
41. `QrDisplay` (student) + `QrScanner` (organizer) + fallback code.
42. Event-QR reverse direction for large events.
43. Arrival/departure hours derivation + organizer override with audit.
44. Offline roster + IndexedDB outbox + background sync + conflict resolution.
45. `impersonation_sessions`; start/end endpoints with the five-condition gate.
46. Actor-claim token, read-only enforcement, denied-action list, capability intersection.
47. Impersonation banner, Switch Access menu, socket enforcement, dual-id audit.
48. Delete `DemoBar.jsx`; bootstrap the platform account script.
49. Full E2E pass over the five demo flows; load sanity; district security-review dry run.

**Sequencing rationale.** Foundations first because they are prerequisites, not
because they're safe. Errors before features so the features' failures are
visible. PWA before QR because offline attendance depends on it. Taxonomy before
dashboards because analytics built on a CHECK constraint gets rebuilt. Portfolio
before QR within v2.0 because QR feeds the portfolio, and the portfolio is the
demo's payoff. Impersonation last because it is the highest-risk feature and
should be built on top of an authorization system that has been exercised in
production for three releases.

---

## 15. Open decisions I need from you

None of these block the start of v1.2 — items 1–9 above proceed regardless — but
each changes work later in the plan.

- **Q1 — "Account deletion is broken": what's the repro?** ✅ **CLOSED — the
  complaint was right, and about a case the passing tests did not cover.**

  The soft-delete path worked for an account with a password. For a
  **provider-only** account it asked for nothing at all: `password_hash` held
  the `'!OAUTH_ONLY!'` sentinel, the password branch was skipped, and a single
  request against a live session irreversibly anonymised the account. Every
  deletion test used a password account, so the suite was green.

  Fixed in two stages. First, before this plan, with a server-checked
  confirmation: the account had to type its own username. That was a stopgap
  and the code said so where it did it — *"Typing the account's own username is
  not a credential."* It is public within the app and appears on every comment
  the person has posted.

  Then in **v1.2b (W1)** the stopgap was removed entirely. Deletion is now
  behind `requireAAL2('account.delete')`, satisfied by the account password
  **or** by re-authenticating at a linked provider — which is the credential a
  provider-only account always had and the code could not previously check. A
  typed confirmation phrase remains in the interface, where a deliberateness
  check belongs, but the server no longer accepts it as proof.

  *The general lesson, recorded because it recurred three more times on this
  branch:* the tests were green because they all exercised the same account
  shape. Coverage of a branch is not coverage of the states that reach it.
- **Q2 — What happens to a graduated or deleted student's hours?** Options:
  (a) hard-delete everything, (b) anonymize attendance so organizers' event
  history and aggregate impact stats survive, (c) retain for N years per district
  records policy. This determines the FK behaviour on ~6 new tables and belongs
  in the data inventory. *Assumption:* (b), anonymize and retain aggregates —
  it's the only option that keeps §5's impact numbers honest over time.
- **Q3 — Evidence file storage (W8).** Is there a persistent disk on the deploy
  target? If not, the options are object storage (needs an account, possibly a
  card) or launching W8 with link-and-attestation evidence only and adding
  uploads later. *Assumption:* local persistent disk with the caps in W8.
- **Q4 — Email provider.** Does South Brunswick have Google Workspace? If yes,
  the SMTP relay is strictly better (district domain, higher limits, no new
  vendor). *Assumption:* Brevo, since it needs no card and no district IT ticket.
- **Q5 — NHS advisor onboarding.** Do advisors already have accounts, and who
  grants `service.verify.external` — the school admin or the platform account?
  *Assumption:* school admin grants it, audit-logged.
- **Q6 — Multi-district tenancy.** ENGINEERING_GUIDE §10.7 names this as the
  likely forcing function for PostgreSQL. If a second district is a real
  near-term prospect, `school` should become a first-class `organizations`
  entity in v1.4 rather than the `TEXT` column it is today — retrofitting
  tenancy after W5's analytics and W8's scoped capabilities ship is
  significantly more expensive. *Assumption:* single district through v2.0,
  with `scope` columns already shaped to accept a tenant id later (which is why
  `user_capabilities.scope` and `metrics_daily.scope` exist).

---

## 16. What I deliberately did not include

Stating these so they're decisions, not oversights.

- **PostgreSQL migration.** No trigger has fired (ENGINEERING_GUIDE §10.1).
  SQLite handles a single district comfortably. Q6 is the thing that would
  change this.
- **Native iOS/Android apps.** The PWA reaches ~95% of the requirement at ~10%
  of the cost, and there is no app-store review in the loop. Revisit only if
  push on iOS proves insufficient in the pilot.
- **A third-party error SaaS (Sentry et al.)** — the brief explicitly wants an
  in-product super admin dashboard, and student PII in stack traces shouldn't
  leave district infrastructure.
- **Real-time chat expansion.** Messaging works. Expanding it competes with the
  four verbs in the vision and adds a moderation burden.
- **Full i18n.** Worth doing when a district asks. Until then it taxes every
  string in every workstream above.
- **ML-based recommendations.** The tag-overlap scorer in W7 is explainable,
  debuggable, and good enough. An unexplainable recommender in a school product
  is a liability.
- **SSO/SAML for district identity.** Google and Microsoft OAuth already cover
  Workspace and M365 tenants, which is what districts actually run. Real SAML
  only if procurement demands it.
- **A locked-badge wall / leaderboard expansion.** `leaderboard_opt_in` exists
  and is off by default, which is the right default for minors. Gamification
  that ranks students publicly is a safeguarding conversation, not a feature
  decision.
