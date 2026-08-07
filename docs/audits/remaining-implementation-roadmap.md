# WeVolunteer — Remaining Implementation Roadmap

**Date:** 2026-08-07 · Derived from `implementation-progress-audit.md`.
Priority is by consequence, not by effort. Original-plan references point at
`docs/spec/`.

---

## P0 — Critical: security, data integrity, broken builds

### P0-1 · Move `audit.read` to `SUPER_ONLY` and re-gate system status

- **Description.** The Audit Explorer is live and gated on `audit.read`, which
  administrators hold. Ordinary administrators can read the administrative audit trail,
  including records of actions taken against them. Moving the capability also strips
  `GET /api/admin/system/status`, which must move to `analytics.school` in the **same
  commit** — splitting them leaves a window with no system status for administrators.
- **Plan reference.** `AUDIT_EXPLORER_IMPLEMENTATION_PLAN.md` §1.1a, changes 1 and 2.
- **Dependencies.** None. Changes 3 and 4 (the decoupling) are already done.
- **Complexity.** Low to write, high to verify.
- **Files.** `server/authz.js`, `server/routes/adminRoutes.js`, `server/authz.matrix.test.js`.
- **Testing.** Three **content-level** assertions, not status assertions: an administrator
  receives a *non-empty* application list; an administrator sees contact fields on a
  student profile; an administrator still reaches system status. Plus: an administrator
  is refused `GET /api/admin/audit-logs`, an owner is allowed.

### P0-2 · Fix `ROLE` / `ROLES` import — roster endpoint 500s

- **Description.** `adminRoutes.js` imports `ROLES` but uses `ROLE`. Every
  `GET /api/admin/roster` request throws `ReferenceError` at `:1917`.
- **Plan reference.** M2 · Admin roster.
- **Dependencies.** None.
- **Complexity.** Trivial (one word).
- **Files.** `server/routes/adminRoutes.js`.
- **Testing.** `routes.adminRoster.test.js` already covers it and currently fails.

### P0-3 · Remove role-string comparisons from `AdminRoster.jsx`

- **Description.** Lines 30 and 33 compare `u.role` against literals, failing Guard 3.
  Beyond the build failure: `super_admin` holds `'*'`, so role cascades are not mutually
  exclusive and mis-order by construction.
- **Plan reference.** `CLAUDE.md` authorization spine; Volume II §2.2.
- **Dependencies.** None.
- **Complexity.** Low.
- **Files.** `src/views/AdminRoster.jsx`.
- **Testing.** `authz.completeness.test.js` Guard 3 must return to green.

### P0-4 · Add idempotency guards and tests to migrations 020 and 021

- **Description.** Both use bare `ALTER TABLE ADD COLUMN` with no guard; 021 issues two
  statements in one `db.exec()`. `CLAUDE.md` requires every migration to assert
  idempotency.
- **Plan reference.** `CLAUDE.md` Migrations; ENGINEERING_GUIDE §8.
- **Dependencies.** None.
- **Complexity.** Low.
- **Files.** `server/migrations/020_administrator_roster.js`,
  `021_administrator_promotion_metadata.js`, new
  `server/migrations.administratorRoster.test.js`.
- **Testing.** Apply twice against a throwaway database; assert no throw and no duplicate
  column.

---

## P1 — Important missing functionality

### ~~P1-1 · Close the Guard 1 evasion via `ROLE.X`~~ — **WITHDRAWN, no work required**

Recorded in error and withdrawn the same day. `ROLE.X` is the **sanctioned** spelling, not
an evasion: `server/authz.js:44-66` exists precisely so that the handful of decisions which
genuinely are about a role can name one without a literal, and Guard 1's own failure
message points at it as the remedy. The `authRoutes.js:263` change was correct and the
stale exemption was rightly removed. See the withdrawal note in
`implementation-progress-audit.md` §6.1.

### P1-2 · Repository hygiene — remove stray files, repair corrupted JSDoc

- **Description.** `patch_roster.py` (316 lines), `update_roster.py`, `test-check.js` sit
  untracked at the repository root. `authRoutes.js:122` contains `` \`tokenVersion\` ``,
  escaped backticks left by a textual patch script.
- **Dependencies.** None.
- **Complexity.** Trivial.
- **Files.** the three root files; `server/routes/authRoutes.js`.
- **Testing.** Lint and build stay green.

### P1-3 · Commit the outstanding work in milestone-shaped commits

- **Description.** 19 modified and 10 untracked files spanning M1c and M2 sit uncommitted
  with no boundary. Split at least into: M1c Audit Explorer + capability move; M2
  Administrator Roster.
- **Dependencies.** P0-1 … P0-4.
- **Complexity.** Low.
- **Testing.** Full suite green before each commit.

### P1-4 · Pending administrator invitations

- **Description.** Specified but entirely unbuilt — no table, no route, no client. This is
  the remaining M2 feature.
- **Plan reference.** `docs/spec/04-super-admin-impact.md` §4.3, requirements IV-1…IV-13.
- **Dependencies.** P0-1 (ownership capability surface must be settled first).
- **Complexity.** **High** — this introduces the first `UPDATE users SET role` in
  `server/`, dissolving the "no mechanism exists" property that the privilege-escalation
  surface currently rests on.
- **Files.** new migration, `server/routes/adminRoutes.js`, new client view,
  `server/authz.js`.
- **Testing.** Acceptance must bind to a **verified** address; the acceptance endpoint must
  answer identically for expired / revoked / nonexistent (a live admin invitation is the
  highest-value probe target on the platform); an invitation row must never be readable as
  a capability.

### P1-5 · Run the ownership bootstrap

- **Description.** `bin/grant-ownership.mjs` exists and is tested but has never been run.
  No `super_admin` exists in any real database.
- **Dependencies.** P0-1 … P0-4, and **owner identities from the owner** (see
  `questions-for-owner.md` Q2).
- **Complexity.** Low to execute, irreversible in effect.
- **Testing.** Already covered by `ownershipBootstrap.test.js`.

---

## P2 — UX and product

### P2-1 · Impact Dashboard and public metrics (M3)

- **Description.** Community impact metrics, derived not stored (INV-025).
- **Plan reference.** `docs/spec/04-super-admin-impact.md`.
- **Dependencies.** M2 complete.
- **Complexity.** Medium.
- **Open question.** The approved reconciliation flagged D-07: the community count as
  specified would be wrong. Reduce or defer — see `questions-for-owner.md` Q4.

### P2-2 · Administrator Roster polish

- **Description.** Once P0-2 and P0-3 land, the roster still needs empty/loading/error
  states and a confirmation flow for revoke.
- **Dependencies.** P0-2, P0-3.
- **Complexity.** Low.

---

## P3 — Nice to have

### P3-1 · Developer Mode, read-only (M4)

- **Description.** 16 named tools, restricted to the owner account.
- **Plan reference.** `docs/spec/04-super-admin-impact.md`;
  `reviews/DEVELOPER_MODE_SECURITY_REVIEW.md`.
- **Dependencies.** M1c, M2, M3.
- **Complexity.** High.
- **Note.** The security review flagged DF-1 as unsettled. Read-only scope only.

### P3-2 · Audit `make-admin.mjs` promotions

- **Description.** The CLI writes no audit record when it promotes. Blocked on deciding
  what actor identity a CLI action carries — see `questions-for-owner.md` Q3.

### P3-3 · Reconcile the two invalid-filter conventions

- **Description.** `errorRoutes.js` clamps silently; `adminRoutes.js` refuses with 400 and
  an `allowed` array. Unreconciled. The Audit Explorer uses the strict convention, which is
  correct for an accountability surface.
