# Current State Report — Agent 1, Repository Analyst

**Date:** 2026-08-06
**Commit:** `4f8b6d6`
**Remit:** Current-state verification for the audit explorer and ownership work.
**Code changes made: none.**

---

## 0. Headline

**The approved `AUDIT_EXPLORER_IMPLEMENTATION_PLAN.md` contains a material error, found by
this verification pass.**

That plan states, in §1.1:

> "Administrators lose `audit.read` — they currently cannot use it for anything — it gates
> one unrelated status endpoint — so nothing they do today breaks."

**That is wrong.** `audit.read` has **three** production uses, not one. Moving it to
`SUPER_ONLY` as planned would, in addition to the anticipated status-endpoint change:

1. **Silently empty every administrator's application list** — a 200 response with zero
   rows, which no existing test would catch.
2. **Remove contact PII from student profiles** for administrators.

This is exactly what Operating Rule 1 exists to catch. Details in §2.

---

## 1. Audit surface — greenfield

### 1.1 No read path exists

**Definitively: no HTTP route reads `admin_audit_logs`.** Every other reference in
`server/routes/` is a comment.

The single production read anywhere is an existence probe in `server/appeals.js:134-139`,
used to disqualify an appeal reviewer who was the suspending administrator. It returns no
rows to any client.

Building the explorer is greenfield. There is nothing to refactor and nothing to break.

### 1.2 `recordAudit` — the only writer

`server/auditLog.js:107` · `recordAudit(db, entry)` where entry is
`{ adminId, action, targetUserId?, details? }`.

| Property | Detail |
|---|---|
| Allowed fields | Frozen list of exactly four. **Unknown keys throw** |
| Required | `adminId`, `action` — non-empty strings |
| `id` and `created_at` | Generated internally, **not parameters**. Deliberate: prevents backdating, and follows a prior production id-collision incident |
| Read function | **None.** The module exports one symbol |
| Imports | `node:crypto` only |

**A build-failing guard** (`server/auditLog.test.js:179`) fails on any raw
`INSERT INTO admin_audit_logs` outside this helper.

**Directly relevant to the severity discrepancy (D-04):** `recordAudit`'s error message for
an unknown key *already names* that there is no `severity` column. The absence is
deliberate and documented, not an oversight.

### 1.3 Schema and its two problems

```sql
CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_user_id TEXT,
  details TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(admin_id) REFERENCES users(id) ON DELETE CASCADE
)
```

**Problem 1 — no indexes.** None in `db.js`, none in any migration. Every filter and the
default ordering are full scans today. Confirms the approved plan's premise.

**Problem 2 — a cascade that contradicts the table's purpose. NEW FINDING.**

`admin_id REFERENCES users(id) ON DELETE CASCADE` means **deleting an administrator's row
deletes every audit record they created.**

Volume I §1.7.5 states the rule this violates:

> A foreign key from a **record of an event** to the **subject of that event** MUST NOT
> cascade on delete.

An audit record is the record of what an administrator did. It should outlive the
administrator, exactly as a safety report outlives its reporter — which is why
`reports.reporter_id` was severed for precisely this reason.

**Currently exploitable? No.** Account deletion is soft (anonymise), hard deletion happens
at the 3-year retention purge, and audit rows are swept at 365 days — so the rows are
already gone before the purge reaches the shell.

**Latent risk: yes, and it is the kind that activates quietly.** If the audit retention
period were ever lengthened past the account-shell period, or if any other path deleted a
user row, an administrator's trail would vanish with them. Recorded as finding **F-02**.

### 1.4 Retention

`auditDays: 365`, swept by `DELETE FROM admin_audit_logs WHERE created_at < ?`. Confirms
the retention audit.

---

## 2. `audit.read` — the plan's error, in detail

### 2.1 Three production uses

| # | Location | What it gates |
|---|---|---|
| 1 | `server/routes/adminRoutes.js:1207` | `GET /api/admin/system/status` — the only `requireCap` gate. **Known and planned for** |
| 2 | `server/routes/userRoutes.js:39` | `canSeeContact = isSelf \|\| can(req.principal, 'audit.read') \|\| hostsApplicant` — **contact PII on `GET /api/users/:id/profile`. NOT in the plan** |
| 3 | `server/routes/applicationRoutes.js:45` | `if (can(req.principal, 'audit.read'))` — the **unscoped branch** of `GET /api/applications`. **NOT in the plan** |

### 2.2 Why use 3 is the dangerous one

The applications handler is a capability cascade. An administrator matches the
`audit.read` branch to receive **all** applications. Remove the capability and the
administrator falls through — they do not hold `applicant.review` and do not hold
`application.withdraw` — to the terminal explicit-deny branch, which sets `rows = []`.

**The result is HTTP 200 with an empty array.**

The authorization matrix asserts `admin: 'allow'` for this route. **`allow` is a status
assertion.** A 200 with zero rows passes it. The regression would be invisible to the
matrix, invisible to lint, invisible to the build — and visible only to an administrator
wondering where every application went.

This is precisely the failure class Volume II §2.4.5 warns about: *"a content defect no
status-code assertion can detect, because the response is still a 200 with a plausible
body."* The specification names the hazard; the plan then walked into it.

### 2.3 `SUPER_ONLY` semantics

```js
export const SUPER_ONLY = [
  'error.read', 'error.write',
  'analytics.platform',
  'impersonation.start',
  'admin.create',
];
```

The check sits **before** the per-user grants lookup, so a `SUPER_ONLY` capability is
unreachable by grant, and `userCapabilities.js` throws when a grant names one.

**Important mechanical detail:** the role array is consulted *before* the `SUPER_ONLY`
test. Adding `audit.read` to `SUPER_ONLY` while leaving it in the `admin` array is a
**no-op** except for grantability. The move requires removing it from `admin` — which is
what triggers uses 2 and 3.

### 2.4 Corrected plan for the capability move

The move now requires **four** coordinated changes in one commit, not two:

| # | Change | Replacement gate |
|---|---|---|
| 1 | `audit.read` → `SUPER_ONLY`, removed from `admin` | — |
| 2 | `GET /api/admin/system/status` | `analytics.school` — admins hold it, and it matches what the endpoint returns |
| 3 | `GET /api/applications` unscoped branch | `event.moderate` — the platform-wide moderation capability admins hold |
| 4 | `canSeeContact` on `GET /api/users/:id/profile` | `event.moderate` — same reasoning |

**And three tests must be added**, because the existing matrix cannot see two of these:

- An administrator receives a **non-empty** application list — a **content** assertion, not
  a status assertion.
- An administrator sees contact fields on a student profile.
- An administrator still reaches system status.

**Without those three content-level tests, this change is not safe to make.**

### 2.5 Client side

**`src/` contains zero references to `audit.read`.** No nav entry, no route, no component.
The client re-exports the server tables wholesale, so a `SUPER_ONLY` change propagates
automatically. An explorer nav entry would be the first client reference.

---

## 3. Ownership — confirmed unreachable

| Fact | Evidence |
|---|---|
| **No code path writes `role = 'super_admin'`** | The only `UPDATE … SET role` in non-test code is `bin/make-admin.mjs:32`, hardcoded to `'admin'`. No `INSERT INTO users` writes it |
| `ROLE.SUPER_ADMIN` is **never referenced** outside its own declaration | — |
| `admin.create` is `SUPER_ONLY` but **no route mounts `requireCap('admin.create')`** | Its only uses are read-side predicates in appeals and suspension-target checks |

**Confirms: a `super_admin` can only exist by direct SQL. There is no promotion path.**

### 3.1 NEW FINDING — the promotion script would silently demote an owner

`bin/make-admin.mjs` guards only `if (user.role === 'admin')`. Run against **any** other
role it overwrites unconditionally.

**Run against a `super_admin`, it silently demotes them to `admin`** — with no warning, no
confirmation, no audit row.

Once ownership is bootstrapped, this script becomes a one-command ownership-destruction
tool. It also writes no audit record and uses no database-safety wrapper.

Recorded as finding **F-01**. It must be fixed **before** the bootstrap runs, not after.

---

## 4. Frontend integration surface

A new admin screen must touch **four coupled places**, and one of them throws at render if
missed:

| # | Place | Failure if missed |
|---|---|---|
| 1 | `APP_ROUTES` in `src/routes/index.jsx` | Route unreachable |
| 2 | `NAV` in `src/App.jsx` | No navigation entry; **module-load throw** if the entry declares no capability |
| 3 | `tabForPath()` in `src/App.jsx` | Silently falls back to `'dashboard'` — wrong page title, wrong rail item highlighted. The file's own comment records `/errors` as the historical instance |
| 4 | `ROUTE_PROPS` map + `withProps()` | **Throws at render** if the path has no entry. Use `{}` for none |

### 4.1 Existing admin surfaces

Only three: `AdminDashboard`, `AdminAppeals`, and `ErrorDashboard` — the last already
`SUPER_ONLY` via `error.read`, making it the **existing precedent** for an owner-only
screen.

### 4.2 Table primitives available

`.tablewrap` · `.tablescroll` · `.table` · `.table thead th` · `.table tbody td` ·
`.cell-title` · `.cell-actions`, with `min-width: 680px` on `.table` so the wrapper scrolls
rather than the page. Two build-failing style guards apply: no dangling classes, no
hardcoded colours.

---

## 5. Precedents to follow

### 5.1 `ErrorDashboard` is the closest analogue

Same shape as the explorer: owner-only, paginated, filtered, master/detail.

| Pattern | Detail |
|---|---|
| Page size | `PAGE_SIZE = 50`, matching the server, so "Next" means what the server means |
| Filter change | **Resets offset** — "page 3 of open is not page 3 of all" |
| Paging bounds | `canPrev` / `canNext` named once, used for both `disabled` and logic |
| Presentation | Renders **cards, not a `<table>`** — relevant to the timeline requirement |

### 5.2 Two incompatible in-repo conventions for invalid filters

| Convention | Where | Rationale given |
|---|---|---|
| **Clamp / silently ignore** | `errorRoutes.js` | "a filter is a view, and answering 400 for one would make the dashboard brittle for no gain" |
| **400 with a `code` and an `allowed` array** | `adminRoutes.js` reports queue | "refused with a 400 naming the legal values, rather than silently dropped" |

**These are not reconciled in the repository.** The approved explorer plan specifies the
strict convention. That is the right choice for an accountability surface — a filter
silently ignored on an audit trail means a reader believes they searched something they
did not — but the divergence should be a conscious decision, and it is now recorded.

### 5.3 Adding a sensitive action costs six things

Required for the planned `audit.export`:

1. The registry entry.
2. **A hand-written sorted-list assertion** in `sensitiveActions.test.js` — deliberately not
   derived, "so adding an action is a deliberate act a reviewer sees".
3. Guard 5: the action must be gated by `requireAAL2` somewhere.
4. Guard 5: the gate must be paired with a `spendChallenge` in the same file.
5. Guard 4: the argument must be a string literal and a registry member.
6. Guard 6: no undeclared direct `consumeChallenge`.

---

## 6. Findings register

| # | Finding | Severity | Action |
|---|---|---|---|
| **F-01** | `bin/make-admin.mjs` **silently demotes a `super_admin`**, with no audit record and no safety wrapper | **High** | Fix **before** bootstrap runs |
| **F-02** | `admin_audit_logs.admin_id` cascades on user delete — an administrator's trail dies with their row. Violates Volume I §1.7.5 | Medium (latent) | Sever the cascade; snapshot the actor identity |
| **F-03** | The approved explorer plan's §1.1 is **wrong**: `audit.read` has three uses, not one | **High** | Plan corrected in §2.4; three content-level tests required |
| F-04 | Moving `audit.read` would produce a **silent 200-with-empty-list** for admins that the matrix cannot detect | **High** | Content assertions, not status assertions |
| F-05 | `recordAudit` already documents that no `severity` column exists | Informational | Supports dropping the severity filter (D-04) |
| F-06 | Two unreconciled conventions for invalid filter values | Low | Explorer uses the strict one; recorded |

---

## 7. Verdict

**The audit explorer is buildable and is genuinely greenfield** — no read path exists, the
schema is stable, and there is a close precedent to follow in `ErrorDashboard`.

**Two things must happen before any code is written:**

1. **F-03's correction must be accepted.** The capability move is four changes, not two, and
   two of them are invisible to the existing test suite. Proceeding on the plan as approved
   would ship a silent regression.
2. **F-01 must be fixed before the bootstrap runs**, or the first ownership accounts will
   exist alongside a script that removes them without a trace.

Neither changes the milestone's shape. Both change what "done" means for it.
