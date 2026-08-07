# WeVolunteer Implementation Progress Audit

**Date:** 2026-08-07 · **Branch:** `main` · **HEAD:** `eece3bf`
**Method:** every claim below re-verified against the repository. Test counts, exit codes
and error messages are copied from actual runs, not from commit messages.

---

## 0. Summary

| | |
|---|---|
| Milestones fully complete | **M1a**, **M1b** |
| Milestone in progress | **M1c** — built but **not secured**; uncommitted |
| Started out of order | **M2** (Admin Roster) — uncommitted, **two live defects** |
| Test status | **2 failing / 3,254 passing / 5 skipped** · 3 files failed |
| Lint | exit 0 |
| Build | exit 0 |
| Working tree | **19 modified + 10 untracked files, all uncommitted** |

**The single most important finding:** the Audit Explorer is built and routable, but
`audit.read` was never moved to `SUPER_ONLY`. **Ordinary administrators can read the
administrative audit log today.** That inverts the entire premise of the approved design.

---

## 1. Original Plan Overview

### Purpose

Take WeVolunteer — a volunteer scheduling and service-hour platform whose users are
majority minors — from "feature-complete" to "safely operable by a named owner", by adding
an ownership tier that is accountable, auditable, and impossible to acquire by accident.

### Source documents

The ~91,000-word specification lives in `docs/spec/`, not in one file:

| Document | Content |
|---|---|
| `docs/spec/README.md` + `01`–`06` | Six volumes: engineering foundation, auth/security, moderation/messaging, ownership + Developer Mode + impact, deployment/launch, implementation phases |
| `docs/spec/appendix-*.md` (5) | Capability matrix, API contracts, database schema, audit events, testing strategy |
| `docs/spec/reviews/` | Validation pass, implementation graph, milestone decision, four design reviews |
| `docs/spec/reviews/M1_EXECUTION_PLAN.md` + 3 siblings | The approved M1 plans |
| `docs/spec/reviews/m1/` | Phase-0 baseline, current-state report, security review, reconciliation |

### Intended order

The owner-approved milestone order, recorded verbatim:

```
M1a  Fix ACCOUNT_SUSPENDED coverage regression
     Fix make-admin ownership demotion bug
     Audit.read dependency mapping
     Audit log integrity review
M1b  Audit log hardening · indexes · immutability · preservation
M1c  Audit Explorer · Super Admin visibility
M2   Ownership bootstrap · Super Admin role · Admin roster · Pending admin invitations
M3   Impact Dashboard · Public metrics
M4   Developer Mode (read-only)
```

The ordering is not cosmetic. Each milestone is a precondition of the next: the audit log
must be durable (M1b) before a screen publishes it (M1c), and ownership must not be
destructible by a stray script (M1a) before ownership exists (M2).

---

## 2. Completed Work

### 2.1 M1a — security prerequisites · commit `d41228c`

| | |
|---|---|
| **Feature** | ACCOUNT_SUSPENDED notification coverage regression + `make-admin` ownership protection |
| **Plan section** | M1a, items 1 and 2 |
| **Files** | `bin/make-admin.mjs`, `server/makeAdmin.test.js` (new, 164 lines), `server/notificationContent.coverage.test.js`, `server/routes/adminRoutes.js` |
| **Tests proving it** | `makeAdmin.test.js` and `notificationContent.coverage.test.js` — **both pass** |
| **Verified** | Yes. The dispatch scanner now strips comments before matching; `ACCOUNT_SUSPENDED` is visible to it again |

**What it fixed.** Commit `b8434fd` had placed a JSDoc block between `dispatch(` and
`'ACCOUNT_SUSPENDED'`. The coverage scanner's pattern tolerates whitespace but not
comments, so the platform's most consequential mandatory notice silently left coverage
while the suite stayed green. Separately, `bin/make-admin.mjs` guarded only
`role === 'admin'` and would have **silently demoted a `super_admin`** with a success
message and exit code 0.

**Limitations.** `make-admin.mjs` still writes **no audit record** when it promotes. The
CLI has no principal to attribute the action to, which is a genuine design question — see
`questions-for-owner.md` Q3.

### 2.2 M1b — audit log hardening · commits `b8c7cad`, `41abcb3`, `eece3bf`

| | |
|---|---|
| **Feature** | Audit log durability, ownership bootstrap tooling, owner deletion protection |
| **Plan section** | M1b (all four items) + M2 tooling pulled forward |
| **Files** | `server/migrations/019_audit_log_hardening.js` (new), `server/auditLog.js`, `server/migrations/index.js`, `bin/grant-ownership.mjs` (new), `bin/revoke-ownership.mjs` (new), `server/routes/accountRoutes.js`, `server/server.js` |
| **Tests** | `migrations.auditLogHardening.test.js` (108 lines), `ownershipBootstrap.test.js` (133 lines), `routes.deletion.test.js` — **all pass** |
| **Verified** | Yes — migration 019 is registered in `index.js` and the suite is green |

This addressed findings S-2 and S-3 from `docs/spec/reviews/m1/SECURITY_REVIEW_M1.md`: the
`ON DELETE CASCADE` that destroyed an administrator's audit trail with their account row,
and the total absence of immutability triggers on `admin_audit_logs` — the one trail that
records administrators acting on minors, and the only one that had neither.

**Limitation.** `bin/grant-ownership.mjs` and `revoke-ownership.mjs` exist and are tested,
but **have not been run**. No `super_admin` exists in any real database.

---

## 3. Partially Completed Work

> Everything in this section is **uncommitted**. It is present in the working tree only.

### 3.1 M1c — Audit Explorer · **BUILT BUT NOT SECURED**

**What exists:**

| Piece | Location |
|---|---|
| API endpoint | `server/routes/adminRoutes.js:1795` — `GET /api/admin/audit-logs` |
| Client view | `src/views/AdminAuditExplorer.jsx` (new) |
| Route entry | `src/routes/index.jsx:132` |
| Nav entry | `src/App.jsx:177` |
| Denial copy | `src/views/ErrorExperience/denialDetail.js:50` |
| Tests | `server/routes.adminAuditExplorer.test.js` (new) — passing |

**What is missing — and it is the point of the milestone:**

`audit.read` is **still in the `admin` role array** (`server/authz.js:110`) and is **not in
`SUPER_ONLY`** (`server/authz.js:169-174`). The screen, the route and the API are all gated
on `audit.read`. Therefore **every ordinary administrator can read the full administrative
audit log right now** — including the record of actions taken against them by other
administrators.

The approved design (`AUDIT_EXPLORER_IMPLEMENTATION_PLAN.md` §1.1a) required **four**
coordinated changes. **Two were done:**

| # | Change | Status |
|---|---|---|
| 1 | `audit.read` → `SUPER_ONLY`, removed from `admin` | ❌ **NOT DONE** |
| 2 | `GET /api/admin/system/status` re-gated off `audit.read` | ❌ **NOT DONE** — still `requireCap('audit.read')` at `adminRoutes.js:1208` |
| 3 | `GET /api/applications` unscoped branch decoupled | ✅ Done — now `application.read_all` |
| 4 | `canSeeContact` decoupled | ✅ Done — now `user.contact.read` |

**Credit where due:** changes 3 and 4 were implemented **better than the approved plan
specified**. The plan proposed overloading `event.moderate`; the implementation introduced
two dedicated capabilities, `application.read_all` and `user.contact.read`, which name what
they actually authorize. That is the correct call and the plan should be updated to match.

**Required next steps:** move `audit.read` into `SUPER_ONLY` and remove it from the `admin`
array; re-gate system status on `analytics.school`; add the three **content-level** tests
the plan mandates (a status assertion cannot catch the regression class here — see §6.1).

### 3.2 M2 — Administrator Roster · **TWO LIVE DEFECTS**

**What exists:** migrations `020_administrator_roster.js` and
`021_administrator_promotion_metadata.js`; `GET /api/admin/roster`,
`GET /api/admin/users/lookup`, `POST /api/admin/users/:id/promote`,
`POST /api/admin/users/:id/revoke` (all `requireCap('admin.create')`);
`src/views/AdminRoster.jsx`; two new sensitive actions `admin.promote` / `admin.revoke`;
tests `routes.adminRoster.test.js`, `routes.adminPromotion.test.js`.

**What is broken:**

**Defect 1 — `GET /api/admin/roster` returns HTTP 500 on every request.**

```
Failed to fetch admin roster: ReferenceError: ROLE is not defined
    at server/routes/adminRoutes.js:1917:33
```

`adminRoutes.js` imports `ROLES` (the plural array) but the handler uses `ROLE` (the
frozen singular object). Both are real exports of `authz.js`, so the import succeeds and
the failure is deferred to request time. **The roster screen cannot load at all.**

**Defect 2 — `src/views/AdminRoster.jsx` violates the authorization guard, failing the
build.**

```
src/views/AdminRoster.jsx:30: "if (u.role === 'admin' || u.role === 'super_admin') {"
src/views/AdminRoster.jsx:33: "if (u.role !== 'student') {"
```

Guard 3 of `authz.completeness.test.js` fails on both. This is the precise rule
`CLAUDE.md` states as non-negotiable: route and view code asks for a **capability**, never
compares a role string. It matters beyond style — `super_admin` holds `'*'`, so a cascade
of role comparisons is not mutually exclusive and will mis-order.

**What is right about it:** the promote/revoke endpoints correctly pair
`requireCap('admin.create')` + `requireAAL2(...)` + `spendChallenge(...)` inside the
transaction, with `bindsParams: ['targetUserId']` matching the spend. That satisfies
Guards 4, 5 and 6 and is the hardest part to get right.

### 3.3 Demo owner account seeded in code

`server/db.js` gained `seedSuperAdmin()`, which inserts `user-super` /
`owner@wevolunteer.local` with the password `password123` and role `super_admin`.

It is gated behind `DEMO_MODE` **and** the presence of the `user-admin` seed, and
production boot fails closed when `DEMO_MODE` is set with `NODE_ENV=production`. So it
should not reach production.

**But it contradicts a stated invariant.** `CLAUDE.md` and the security review both record
that no code path creates a `super_admin` — "enforced by absence of mechanism, which is
stronger than a permission check". A mechanism now exists. See `questions-for-owner.md` Q1.

---

## 4. Not Started

| Item | Milestone |
|---|---|
| Pending administrator invitations | M2 |
| Ownership bootstrap **run** (creating the two real owner accounts) | M2 |
| Impact Dashboard | M3 |
| Public metrics | M3 |
| Developer Mode (read-only, 16 tools) | M4 |

Confirmed absent: there is no `invitations` table in `db.js` or in any of the 21
migrations, and no route or client call references one.

---

## 5. Current Test Status

Measured on the working tree as it stands, not on `HEAD`.

| Metric | Value |
|---|---|
| Test files | **3 failed**, 197 passed (200) |
| Tests | **2 failed**, 3,254 passed, 5 skipped (3,261) |
| Duration | 90.86 s |
| Lint (`npm run lint`) | **exit 0** |
| Build (`npm run build`) | **exit 0** — 374.67 kB / 117.43 kB gzip |

### Failing tests

| # | Test | Cause |
|---|---|---|
| 1 | `authz.completeness.test.js` › no undeclared role-string comparison under `src/` | `AdminRoster.jsx:30` and `:33` (§3.2 Defect 2) |
| 2 | `routes.adminRoster.test.js` › allows owner requests and returns roster data | `ROLE is not defined` (§3.2 Defect 1) |

A third file is counted as failed but emitted no separate `FAIL` line; it resolves to the
same two root causes.

**Note on `HEAD` vs. working tree:** `HEAD` (`eece3bf`) is believed green. Both failures
are introduced by uncommitted work.

---

## 6. Risk Assessment

### 6.1 Security risks

| # | Risk | Severity |
|---|---|---|
| **R-1** | **`audit.read` is still an administrator capability while the Audit Explorer is live.** Any administrator can read the full administrative audit trail, including actions other administrators took against them | **High** |
| **R-2** | `GET /api/admin/system/status` still gated on `audit.read`, so fixing R-1 without re-gating it silently removes system status from administrators | **Medium** |
| **R-3** | `AdminRoster.jsx` role-string cascade — `super_admin` holds `'*'`, so role cascades mis-order by construction | **Medium** |
| **R-4** | `seedSuperAdmin()` creates a `super_admin` with a **known password** in code. Demo-gated, but the invariant "no code path creates an owner" is now false | **Medium** |
| ~~R-5~~ | ~~Guard 1 can be evaded with `ROLE.X`~~ — **WITHDRAWN, see below** | — |

**R-5 withdrawn (same-day correction).** I first recorded the `authRoutes.js:263` change —
`fields.role === 'organizer'` becoming `fields.role === ROLE.ORGANIZER`, with the reviewed
exemption at `:259` deleted — as an evasion of Guard 1. **That was wrong.** `server/authz.js:44-66`
documents `ROLE` as the sanctioned remedy, in terms that answer the objection directly:

> "the rule the guard is really enforcing is 'role names live in one file', not 'roles are
> never named'. This is that one file. A typo here is a build failure … a typo in a
> scattered string literal is a silent deny."

Guard 1's own failure message names importing from `authz.js` as the fix. The change was
correct, and deleting the exemption alongside it was correct — an exemption for a
comparison that no longer needs one is stale. Recorded rather than deleted because the
reasoning that produced the error is worth keeping next to the correction.

**Why R-1's fix needs content-level tests.** The authorization matrix asserts
`admin: 'allow'` for `GET /api/applications`. `allow` is a *status* assertion, and a
capability cascade that falls through to its explicit-deny terminator returns **HTTP 200
with an empty array**. Changes 3 and 4 are already in place, so this specific trap is now
disarmed — but the tests that prove it are still missing, which means the protection is
undocumented and can be removed by anyone who does not know it is load-bearing.

### 6.2 Architectural risks

- **Migrations 020 and 021 use bare `ALTER TABLE ADD COLUMN`** with no
  `addColumnIfMissing` guard and no idempotency test. `CLAUDE.md` requires every migration
  to assert idempotency. Migration 021 issues two `ALTER TABLE` statements in a single
  `db.exec()`.
- **`issueSession` now writes to the database on every sign-in** (`last_sign_in_at`),
  wrapped in try/catch. Sign-in is the hottest write path in the application and this adds
  an unconditional `UPDATE` to it.
- **A large body of work is uncommitted** — 19 modified and 10 untracked files spanning
  two milestones with no commit boundary between them.

### 6.3 Repository hygiene

- **Three stray files at the repository root**, all untracked: `patch_roster.py` (316
  lines), `update_roster.py` (6 lines), `test-check.js` (10 lines — a hand-run probe of
  the roster endpoint that is failing). None belong in the repository.
- **Source corruption from a patch script.** `server/routes/authRoutes.js:122` now reads
  `` \`tokenVersion\` `` — escaped backticks inside a JSDoc block. Harmless to execution,
  but it is direct evidence that `patch_roster.py` rewrote source files textually.

### 6.4 UX issues

- The Audit Explorer nav entry is visible to administrators (consequence of R-1).
- The Administrator Roster screen returns 500 and renders nothing.

---

## 7. What Needs Finishing

In dependency order:

1. **Fix the two live defects** (`ROLE` import; `AdminRoster.jsx` role comparisons).
2. **Complete M1c**: move `audit.read` to `SUPER_ONLY`, re-gate system status, add the
   three content-level tests.
3. **Harden migrations 020/021**, add idempotency tests.
4. **Remove the stray root files** and repair the corrupted JSDoc.
5. **Close the Guard 1 evasion** (R-5).
6. **Commit the work** in logical milestone-shaped commits.
7. Then M2 proper: pending invitations, and the bootstrap run.
