# WeVolunteer — Remaining Implementation Roadmap

**Date:** 2026-08-07 · Derived from `implementation-progress-audit.md`.
Priority is by consequence, not by effort. Original-plan references point at
`docs/spec/`.

---

## UX and product pass — 2026-08-07, commits `a6b8d9b`…`31bbc23`

A separate pass after the milestone work above, on quality rather than capability. Six areas,
all verified in a browser at phone, tablet, laptop and desktop widths rather than only in tests.

| Area | Outcome |
|---|---|
| **Error screens** | The 403 rendered in the top-left of an empty viewport above ~55% dead space — `App.jsx` had promoted it to a takeover without `WEIGHTS` agreeing. Every kind is now one weight; the dead `medium` CSS is deleted rather than left to rot. A second defect found while checking: the stacked layout keyed on width alone, so a phone held sideways put the only way out 396px below the fold, on all eight kinds |
| **Suspension** | A suspended person can now sign in, read the decision with its reason and dates, appeal it, and sign out — reaching four routes and nothing else. Closed an enumeration oracle in the process |
| **Audit Explorer** | Rebuilt around how the record is read: sentences instead of SCREAMING_SNAKE, a time as well as a date, the `details` sentence on the row, and a genuine card layout on mobile instead of a 680px-min-width table scrolling sideways. The action filter offered actions nobody writes; it derives from the trail now |
| **Messaging** | The "New message" dialog told three of its four audiences the wrong thing. Copy is derived from capabilities, most-privileged-first, ending in an explicit fallback |
| **Consistency** | The Admin Roster was built on five class names no stylesheet defines. The dangling-class guard could not see them — it matched only generated `s-xxxxxx` names — so 24 dead classes had accumulated. The check now covers every static class name and is closed against new ones |
| **Responsive** | Eleven routes swept at 375px. One overflowed: the calendar, by 85px, from the flexbox `min-width: auto` trap |

**3,340 tests** (209 files), lint exit 0, build exit 0.

**Not done:** the moderation-workflow product review (item 6 of the request). The mechanics are
sound — every action writes an audit row inside the same transaction as the act, and the
Explorer now makes those rows readable — but the end-to-end question of whether an
administrator can reconstruct *why* a decision was made, from the queue rather than from the
audit log, has not been walked through.

---

## Status — updated 2026-08-07, commit `c57acd1`

**All of P0 is done, and P1-2 and P1-3 with it. M1c is complete; M2's roster works.**
The suite is green at **3,283 tests** (204 files), lint exit 0, build exit 0, working tree
clean. Boundaries were additionally verified over HTTP against the running server, not only
in tests.

| Item | Status |
|---|---|
| P0-1 `audit.read` → SUPER_ONLY, system status re-gated | ✅ Done, mutation-tested |
| P0-2 `ROLE`/`ROLES` import — roster 500 | ✅ Done |
| P0-3 role-string comparisons in `AdminRoster.jsx` | ✅ Done |
| P0-4 migration 020/021 idempotency | ✅ Done, with tests |
| ~~P1-1 Guard 1 evasion~~ | ⊘ Withdrawn — was not a real finding |
| P1-2 stray files, corrupted JSDoc | ✅ Done |
| P1-3 commit outstanding work | ✅ Done — `f8cc345`, `9da6026` |
| **P1-4 pending administrator invitations** | **← next** |
| P1-5 run the ownership bootstrap | Waits on owner identities (Q2) |

### Defects found beyond the audit's original list

All seven were found by running or testing the thing, not by reading it.

| # | Defect | How it surfaced |
|---|---|---|
| 1 | **Promotion and revocation could never succeed.** The roster opened its step-up challenge with `{ id }`; the registry binds `targetUserId`. A missing key hashes as absent, so the grant could never be spent — the owner re-enters their password, then the action fails | Writing the first client test for the screen |
| 2 | **Revocation left per-user capability grants intact**, so a demoted administrator kept anything granted — including `report.evidence.read`, the ability to read students' private messages | A test asserted it; the handler did not do it |
| 3 | `routes.adminPromotion.test.js` imported `db.js` statically, binding the suite to the **real database**. The file had been failing at collection, so its five assertions had never run | `testServer.js`'s path assertion refused to start |
| 4 | **The dev server would not boot** — editing migrations 020/021 invalidated their checksums | Running the app |
| 5 | The Audit Explorer issued **one request per keystroke**, each a `LIKE '%…%'` on an unindexed column | Client test |
| 6 | Every Explorer failure rendered as **"Access Denied"** — on a screen only the owner can reach | Client test |
| 7 | `ACCOUNT_SUSPENDED` had been silently recategorised from `ACCOUNT` to `SYSTEM`, filing a lockout notice away from the filter a locked-out student would use | Reading the diff |

Items 1, 2 and 3 compounded: the test agreed with the bug in 1, and could not have caught
2, because it was never running at all.

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
- **Plan reference.** `docs/ENGINEERING_GUIDE.md` authorization spine; Volume II §2.2.
- **Dependencies.** None.
- **Complexity.** Low.
- **Files.** `src/views/AdminRoster.jsx`.
- **Testing.** `authz.completeness.test.js` Guard 3 must return to green.

### P0-4 · Add idempotency guards and tests to migrations 020 and 021

- **Description.** Both use bare `ALTER TABLE ADD COLUMN` with no guard; 021 issues two
  statements in one `db.exec()`. `docs/ENGINEERING_GUIDE.md` requires every migration to assert
  idempotency.
- **Plan reference.** `docs/ENGINEERING_GUIDE.md` Migrations; ENGINEERING_GUIDE §8.
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
