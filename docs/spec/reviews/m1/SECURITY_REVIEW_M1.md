# Security Review — M1 Preconditions

**Date:** 2026-08-06 · **Commit:** `4f8b6d6` · **Code changes made: none.**
**Method:** independent audit (Agent 2), every finding then re-verified by direct read
before being accepted here. One finding was **refuted** on re-verification.

---

## 0. Verdict

**The privilege-escalation surface is closed.** An ordinary administrator cannot become,
remove, demote, or suspend an owner, and an unauthenticated user cannot mint a privileged
account. Four independent mechanisms hold this up, and the strongest of them is that the
mechanism simply does not exist:

- **No `UPDATE users SET role` exists anywhere in `server/`.** The only role-mutating
  statement in the repository is `bin/make-admin.mjs:32`, a CLI script requiring shell and
  database-file access. `super_admin` is not writable by any code in this repo.
- **Role is never trusted from the token.** `server/utils.js:178-183` re-reads it from the
  database on every request; the socket path does the same.
- **Signup role is allowlisted**, not filtered: `SELF_ASSIGNABLE_ROLES = ['student',
  'organizer']`, and the OAuth door re-runs the same validation on the stored blob — the
  historical bypass, documented in `accountValidation.js:1-13`, is closed.
- **`SUPER_ONLY` is checked before grants** (`authz.js:265`), so no per-user grant can reach
  an owner capability, and `userCapabilities.js:29` refuses to even store such a row.

**The weakest link in this codebase is not authorization. It is audit durability.** The
moderation trails are append-only at the storage layer — 16 triggers across reports,
evidence, appeals and moderation actions. The *administrative* trail, which records
administrators acting on students, has **none**, and it carries a foreign key that deletes
it. That asymmetry is the substance of this review.

---

## 1. Findings

| ID | Finding | Severity | Exploitable now |
|---|---|---|---|
| **S-1** | `bin/make-admin.mjs` silently demotes a `super_admin` | **High** | **Yes, once ownership exists** |
| **S-2** | `admin_audit_logs.admin_id` cascades on user delete; table absent from `PRESERVED_TABLES` | Medium | No — blocked by an arithmetic accident |
| **S-3** | `admin_audit_logs` has no immutability triggers, unlike every moderation table | Medium | No — no writer exists |
| S-4 | `GENERIC_LOGIN_ERRORS` does not cover the `suspended` and `oauth_only` branches | Low | Oracle only; accepted product decision |
| S-5 | `capability.grant` is a live admin capability with no route; `grantCapability` has zero call sites | Low (latent) | No |
| S-6 | `adminRoutes.js:524` documents an FK on `target_user_id` that does not exist | Informational | No |
| ~~S-7~~ | ~~`/warn` may not enforce suspension target rules~~ | — | **REFUTED — see §3** |

---

## 2. The three that matter for M1

### S-1 — the promotion script destroys ownership silently. **High.**

```js
// bin/make-admin.mjs:27-33
if (user.role === 'admin') {
  console.log(`User ${email} is already an admin.`);
  process.exit(0);
}
db.prepare("UPDATE users SET role = 'admin' WHERE email = ?").run(email);
```

The guard tests one role. Against **any** other role the `UPDATE` runs unconditionally.
Run against a `super_admin`, it **demotes the platform owner to administrator** — no
warning, no confirmation, no audit row, exit code 0, and a success message.

Today this is harmless: no `super_admin` exists. **The bootstrap milestone is exactly what
arms it.** The moment M1 creates the two owner accounts, the repository contains a
one-command, unlogged ownership-destruction tool whose output says "Successfully promoted".

Compounding: it writes no audit record and uses none of the database-safety wrappers. The
demotion would be invisible in `admin_audit_logs` as well as on the console.

**This must be fixed before the bootstrap runs, not after.** It is a precondition of M1, not
a follow-up to it. The fix is small — refuse any non-`student`/`organizer` role, and record
an audit row — but the ordering is not negotiable.

### S-2 — the audit trail is deleted with its author. **Medium, latent.**

```sql
-- server/db.js:622-632
FOREIGN KEY(admin_id) REFERENCES users(id) ON DELETE CASCADE
```

Volume I §1.7.5 states the rule this breaks: *a foreign key from a record of an event to
the subject of that event MUST NOT cascade on delete.* An audit row is the record of what
an administrator did; it should outlive them, exactly as a safety report outlives its
reporter — which is why `reports.reporter_id` was severed for this same reason.

The path is real end to end. `DELETE /api/auth/account` has **no role restriction** — its
own comment names "a student, admin, super_admin, or partner deleting their own account".
That soft-deletes; `retentionWorker.js:315` hard-deletes the shell at three years; the
cascade then removes every audit row that administrator ever wrote.

Two safety nets that should catch this do not:

- The purge **exemption list** holds back accounts with attendance, certificates, organized
  events, or live reports. **It does not check `admin_audit_logs`.**
- **`PRESERVED_TABLES` does not include `admin_audit_logs`** — verified directly at
  `retentionWorker.js:104-106`. So `assertPreservedTablesUntouched`, the mechanism written
  precisely to turn this intention into an enforced invariant, does not fire.

**Not currently exploitable**, and the reason is worth stating plainly because it is not a
control: audit rows are swept at 365 days and shells are purged at 1095, so the rows are
already gone. **The property is protected by the arithmetic accident `365 < 1095`, which
nobody wrote down.** Lengthen audit retention past three years — a plausible response to a
district asking for longer records — and the invariant silently inverts.

There is a second-order irony here: `PRESERVED_TABLES`' own comment explains that the
appeals tables were added *because* this worker sweeps `admin_audit_logs` at 365 days and a
due-process record cannot depend on it. The reasoning was applied to the appeal record and
not to the audit record itself.

### S-3 — the administrative trail is the least protected trail on the platform. **Medium.**

Complete trigger inventory: **16 triggers**, on `conversation_report_messages`,
`conversation_reports`, `reports`, `moderation_actions`, `report_evidence`, `appeals`, and
`appeal_events`. **`admin_audit_logs` appears nowhere in that list.**

Its integrity rests entirely on the `recordAudit` chokepoint — which is genuinely well
built (frozen four-key allowlist, internally generated `id`, internally stamped
`created_at` so **no caller can backdate a row**, never catches, so a failed audit rolls
back its transaction) and genuinely enforced (`auditLog.test.js:179` fails the build on any
raw `INSERT` elsewhere; there are zero).

But that is a **code** control on a **data** property. Reports get both. The table that
records administrators acting on minors gets only the weaker one.

**Relevant to M1 specifically:** the audit explorer makes this trail a first-class product
surface — a page an owner reads to answer "what did this administrator do". Publishing a
read surface over a mutable table asserts a durability the storage layer does not provide.
Adding the four triggers is small and belongs in the same migration as the indexes.

---

## 3. Refuted on re-verification — S-7

Agent 2 flagged, explicitly as **unverified**, that `POST /api/admin/users/:id/warn` might
not enforce suspension target rules — which would let an ordinary administrator place a
permanent disciplinary warning on the owner's record.

**Direct read refutes it.** `adminRoutes.js:1706` calls
`suspensionTargetError(req.principal, req.user.id, target)` and returns the refusal, and
lines 1696-1705 document the reuse and its reasoning. The audit's grep saw the call at 1706
and attributed it to the appeal-token route that begins at 1742.

All three enforcement routes — suspend (1401), unsuspend (1532), warn (1706) — share one
target-rule definition. **There is no gap.** Recorded because the agent correctly refused to
assert what it had not read, and because the verification is the point.

---

## 4. Confirmed sound — no action

- **Target rules are asked as capability questions, never role comparisons**, and the
  target principal is deliberately built **without grants**, so a revocable per-user grant
  cannot shield its holder from moderation. Correct on both counts.
- **Nobody may suspend a `super_admin`, including another `super_admin`** — because the
  failure mode is a platform with no one able to undo it.
- **Audit writes are inside the same transaction as the act they record.** Suspension
  updates the user, mints the appeal token, writes the audit row, and dispatches the
  mandatory notice in one `inTransaction`. `recordAudit` never catches, so a failed audit
  rolls back the suspension. No suspension without its audit row, and none the other way.
- **Six session-invalidation mechanisms**, including a mid-connection socket re-check.
  `revoked_sessions` is purged only once the token would have expired anyway — no window.
- **Sign-in refusal ordering puts the throttle first**, closing three oracles that were
  previously readable after lockout, and keys on user id so the email/username dual
  identifier does not double the allowance.
- **The suspension end date is withheld pre-authentication** — the defect found and fixed
  during the suspension work.

One accepted risk restated rather than reported as new: an ordinary administrator holds
`report.evidence.read`, the ability to read students' private message bodies. It is
deliberate, double-logged in the same transaction, and the most invasive power on the
platform. It means "administrator" ≈ "owner" for the data that matters most to a minor —
which is context worth holding while deciding how much the owner tier should be able to
see about administrators.

---

## 5. What this changes for M1

| # | Consequence | Blocking? |
|---|---|---|
| 1 | **S-1 must be fixed before the bootstrap runs.** Ownership cannot be created while an unlogged one-command demotion exists | **Yes — precondition** |
| 2 | **S-2 and S-3 fold into the audit-explorer migration.** Sever the cascade, snapshot the actor identity, add the four triggers, add `admin_audit_logs` to `PRESERVED_TABLES`, alongside the indexes | No — same migration |
| 3 | S-4, S-5, S-6 are recorded for the debt register | No |

Items 1 and 2 are additions to M1's scope, not changes to its shape. Both are small. Item 1
changes the **order** of M1: the script fix precedes the bootstrap.
