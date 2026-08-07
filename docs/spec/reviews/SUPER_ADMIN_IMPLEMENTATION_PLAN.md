# Super Admin Bootstrap & Ownership — Implementation Plan

**Date:** 2026-08-06
**Task:** M1 Task 4
**Status:** Plan. **No code written.** Blocked on one owner input (§10).
**Builds on:** `SUPER_ADMIN_DESIGN_REVIEW.md`

---

## 1. The problem this solves

| Measured fact | Consequence |
|---|---|
| **Zero accounts hold `super_admin`** | Ownership does not exist. INV-009 ("exactly two") is violated with a count of zero |
| **No mechanism creates one.** `bin/make-admin.mjs` is hardcoded to `admin` | The two accounts cannot be created by any supported path |
| That script writes **no audit record** and uses **no database-safety wrapper** | Every role change made today is unattributable |
| Volume IV specifies what owners may do and what may not be done to them | It never specifies **how they come to exist** |

**The gap is not enforcement. It is origination.** Enforcement (INV-008's refusal paths) is
M2. This plan covers only how the two accounts come into existence, how they are recovered,
and what records that leaves.

---

## 2. The four rules, and how each is met

| Rule | Mechanism | Enforced by |
|---|---|---|
| **Nobody can create a super admin from the UI** | No route accepts a role as a writable value. The bootstrap is a host-shell command | Absence of mechanism + static guard (§7) |
| **Super admin cannot be removed normally** | Deletion, suspension, demotion and withholding each refuse an immutable-role target. Retirement exists only as a host command bounded by the owner count | Absence of mechanism + refusal tests |
| **An admin cannot become a super admin** | Promotion accepts one target role, `admin`, as a literal. The owner role appears in no writable enumeration | Static guard |
| **Every privilege action audited** | Bootstrap, retirement, promotion, revocation, invitation lifecycle each write an unsuppressible record | Transactional audit + tests |

---

## 3. Bootstrap process

### 3.1 Chosen mechanism

**A host-shell CLI command, single-purpose, bounded by the owner count, unconditionally
audited.**

| Option | Verdict |
|---|---|
| An application route, owner-gated | **Rejected.** Creates the mechanism INV-008 exists to deny. A mechanism that exists will eventually be reachable |
| A migration inserting the accounts | **Rejected.** Bakes identities into version-controlled source and re-runs against every environment including development |
| Direct database modification, documented once | **Rejected.** Leaves no record of the platform's most consequential change, and offers no path for the retirement case (§5) |
| **Host CLI** | **Chosen** |

### 3.2 Command surface

```
bin/grant-ownership.mjs <email> --reason "<why>"
bin/revoke-ownership.mjs <email> --reason "<why>"
```

Two commands, not one with a flag. **Reason:** a single command with `--grant` / `--revoke`
is one typo away from the opposite of the intended act, on the platform's most consequential
operation.

### 3.3 Grant — requirements

| # | Requirement |
|---|---|
| BS-1 | Runs only from a host shell. Not reachable over the network by any credential |
| BS-2 | **Refuses if the owner count is already 2.** This is what makes it a bootstrap rather than an escape hatch |
| BS-3 | **Promotes an existing, verified, active account.** MUST NOT create an account — account creation carries consent capture that cannot be performed on somebody's behalf |
| BS-4 | Refuses if the target already holds the role |
| BS-5 | Refuses a deleted or suspended target |
| BS-6 | Requires an interactive confirmation naming the target address and stating the change is irreversible through the application |
| BS-7 | Requires `--reason`; refuses without one |
| BS-8 | Writes an audit record **unconditionally**, naming the operator as recorded at invocation, the target, and the reason. Not suppressible by any flag |
| BS-9 | Uses the existing database-safety wrapper, as other destructive tools do |
| BS-10 | Increments the target's token version, so the change takes effect next request and the holder signs in deliberately |
| BS-11 | Prints the resulting owner count; **exits non-zero if it is not the expected value** |
| BS-12 | Honours `WEV_DB_PATH`, so it cannot be pointed at the wrong database by accident |

**On BS-8's operator identity.** A host command has no authenticated principal. The record
must name *somebody*. Options: a required `--operator` argument, or the host username.
**Recommendation: the host username, captured automatically, with `--operator` as an
optional override for a shared host.** An argument alone can be falsified as easily as it
is supplied; the username at least reflects who was logged in.

### 3.4 Revoke — requirements

| # | Requirement |
|---|---|
| RV-1 | All of BS-1, BS-6 through BS-12 |
| RV-2 | **Refuses to reduce the owner count below 1** |
| RV-3 | Refuses if the target does not hold the role |
| RV-4 | Demotes to `admin`, not to `student`. A retired owner remains platform staff unless separately demoted |
| RV-5 | Revokes every capability grant on the account in the same transaction |

**RV-2's floor is 1, not 2.** A transfer sequence must be able to run
2 → 3 → 2 (add the new owner, then retire the old). Forcing 2 → 1 → 2 creates a window with
a single owner; forbidding any reduction makes transfer impossible. The transient 3 warns
at boot, which is correct and expected during a transfer.

### 3.5 The two initial owners

| # | Account | Purpose | Routine use |
|---|---|---|---|
| **O-1** | The named principal owner | Platform administration, development, Developer Mode | Yes |
| **O-2** | The WeVolunteer master account | Continuity and recovery | **No** |

**Not a shared credential.** Two distinct identities with separate credentials, so an action
by O-2 is distinguishable from an action by O-1 in the trail. A shared credential destroys
that distinction and is the single most damaging shortcut available here.

**Bootstrap order:** O-1 first, then O-2. If the process is interrupted between them, the
platform has one owner — degraded but operable — rather than zero.

**Both accounts must exist and be verified before either command runs** (BS-3).

---

## 4. Immutable owners

### 4.1 Storage

**As a role value on the account row, exactly like every other role.**

| Alternative | Rejected because |
|---|---|
| Configuration-declared owner list | Makes ownership unauditable from the database, creates a second source of truth for identity, and moves ownership into a file a deployment mistake can rewrite |
| A separate `owners` table | The kernel resolves from role; a second source means every decision consults two places — the drift the kernel exists to prevent |
| An attribute beside the role | Same objection |

**Consequence accepted:** anybody with database access can set the role. True of every
security property in an embedded-database system; addressed operationally, not structurally.

### 4.2 The prohibitions

Enforced by **absence of mechanism**, not by permission check — a permission check against a
wildcard holder passes.

| # | Operation | Enforcement |
|---|---|---|
| IM-1 | Assign the owner role | The identifier appears in no writable enumeration; no endpoint accepts it |
| IM-2 | Remove the owner role | No demotion path accepts an owner target |
| IM-3 | Edit an owner's role | Role is not a writable field on any account endpoint |
| IM-4 | Delete an owner account | Deletion path refuses an immutable role |
| IM-5 | Suspend an owner | Suspension target rule refuses |
| IM-6 | Warn an owner | Same rule |
| IM-7 | Withhold a capability from an owner | Withholding path refuses; any pre-existing withholding is ignored for a wildcard principal |
| IM-8 | Self-promote | Follows from IM-1 |
| IM-9 | Promotion by another owner | Follows from IM-1. Wildcard reach does not create a mechanism |

**Refusal copy requirement.** Each must state that the account is an owner account and that
ownership is not administrable through the application. It MUST NOT imply a more privileged
principal could do it, because none can.

### 4.3 Boot-time count check

| # | Requirement |
|---|---|
| BC-1 | Verify the owner count at boot |
| BC-2 | **Warn, non-fatally**, on any value other than 2 |
| BC-3 | The warning names the actual count and the expected one |
| BC-4 | A count of **0** warns at the highest severity |

**BC-2 is deliberate.** A fatal check converts an ownership discrepancy into unavailability
of the very surfaces needed to diagnose and correct it. The check's failure mode would be
worse than the failure it detects.

**A live consequence:** the count is currently 0, so this warning fires on **every boot**
until the bootstrap runs. A warning that always fires is a warning always ignored — so the
bootstrap must run **before** the check ships, or the check ships with the bootstrap in the
same change.

---

## 5. Recovery strategy

Three scenarios, deliberately separated. The design review found them conflated.

| # | Scenario | Remedy | Changes the role? |
|---|---|---|---|
| **L-1** | Credentials lost, accounts intact | Break-glass credential reset | **No** |
| **L-2** | One account compromised | Rotate the signing secret (ends every session), reset that credential, enumerate every action by that account across the window, reverse what is reversible, record what is not | No |
| **L-3** | Both accounts destroyed at the database level | **Restore from backup**, then re-run the bootstrap if needed | Possibly |

### 5.1 Credential reset is NOT the bootstrap

**These must remain separate commands.**

| | Bootstrap | Credential reset |
|---|---|---|
| Changes the role | **Yes** | **No** |
| Refuses a non-owner target | No — that is its purpose | **Yes** |
| Bounded by owner count | Yes, at 2 | No |
| Audited | Unconditionally | Unconditionally |

**Merging them would give the recovery procedure the power to mint ownership** — the exact
capability INV-008 denies, reachable by whoever can run recovery.

### 5.2 L-3 depends on a drill that has not happened

Restoring from backup is the only remedy for L-3, and **no restore drill has ever been
performed** — while two destructive schema rebuilds have shipped.

**This plan does not close that.** It is recorded as the dependency it is: the ownership
recovery story is only as good as the restore, and the restore is currently a hypothesis.

---

## 6. Migration strategy

**No schema migration is required.**

| Question | Answer |
|---|---|
| New table? | No |
| New column? | No |
| Constraint on the owner count? | **No** — §6.1 |
| Data migration? | No. The bootstrap is an operational act, not a migration |

### 6.1 Why no storage constraint on the count

A check constraint over a count requires a trigger on every account write — paid on every
registration, for ever — to prevent an operation that no code path performs.

**The proportionate controls are:** the bootstrap's own refusal at 2 (BS-2), the boot
warning (BC-1), the quarterly review, and the fact that no route can set the role.

Recorded as a deliberate decision so a future reader does not add the trigger believing it
was overlooked.

### 6.2 What about the existing promotion script?

`bin/make-admin.mjs` promotes to `admin`, writes no audit record, and uses no safety
wrapper.

| Option | Verdict |
|---|---|
| Leave it | **Rejected.** It is an unattributable privilege change |
| Bring it under the safety wrapper and add auditing | **Chosen for now** |
| Delete it once the promotion route exists (M2) | **Chosen for then** |

**Recommendation:** add auditing and the safety wrapper in the same change as the bootstrap
commands, since they share the pattern; delete it when M2 ships the audited route.

---

## 7. CLI requirements

Common to all three ownership commands.

| # | Requirement |
|---|---|
| CLI-1 | Honours `WEV_DB_PATH`. **Enforced by the existing tooling guard** that requires every `bin/` script opening a database to reference it |
| CLI-2 | Imports the database-safety wrapper. **Enforced by the existing guard** over destructive scripts |
| CLI-3 | **Never assigns `NODE_ENV`.** Enforced by the existing guard |
| CLI-4 | Announces what it will do and requires typed confirmation — not a bare y/n — for irreversible acts |
| CLI-5 | Exits non-zero on refusal, with the reason on stderr |
| CLI-6 | Prints the resulting owner count and verifies it before exiting successfully |
| CLI-7 | Is idempotent-safe: re-running after success refuses cleanly rather than duplicating |
| CLI-8 | Documented in a runbook, with a **dated drill record** |

**CLI-1 through CLI-3 are already enforced** by guards in the repository. The new commands
inherit them automatically — provided the guards' subject sets derive from `bin/`, which
they do. **Note:** two of those guards currently lack non-empty assertions, so a change
that emptied the walk would silently stop covering these commands. That is one of the 13
items in the guard remediation work stream.

---

## 8. Audit requirements

### 8.1 New audit actions

| Action | Trigger | Actor | Subject | Detail |
|---|---|---|---|---|
| `OWNER_BOOTSTRAPPED` | Grant command succeeds | Host operator | The new owner | Reason; resulting count |
| `OWNER_RETIRED` | Revoke command succeeds | Host operator | The retired owner | Reason; resulting count; grants revoked |
| `OWNER_CREDENTIAL_RESET` | Break-glass reset | Host operator | The owner | Reason |

Each must be added to Appendix D in the same commit as the command that writes it.

### 8.2 Requirements

| # | Requirement |
|---|---|
| AU-1 | The record is written in the **same transaction** as the role change |
| AU-2 | The record is **unsuppressible** — no flag, no environment variable, no argument disables it |
| AU-3 | If the audit write fails, the role change **rolls back** |
| AU-4 | The actor is the host operator, captured automatically (§3.3) |
| AU-5 | The reason is recorded verbatim |

**AU-3 is the one most likely to be skipped** in a CLI, where the temptation is to write the
role first and log afterwards. Recorded-but-not-performed and performed-but-not-recorded are
both worse than a clean, retryable failure.

### 8.3 Visibility

These records are only useful if they can be read — which is the Audit Log Explorer (M1
Task 3). **The ownership commands should not ship before the Explorer**, for the same reason
administrator management should not: their whole value is a record somebody can review.

---

## 9. Tests

### 9.1 Bootstrap command

| # | Test |
|---|---|
| T-01 | Refuses when the owner count is already 2 |
| T-02 | Refuses a non-existent, unverified, inactive, deleted or suspended target |
| T-03 | Refuses a target that already holds the role |
| T-04 | Refuses without `--reason` |
| T-05 | **Creates no account** — asserted by attempting against an unknown address and checking the account count is unchanged |
| T-06 | Writes an audit record with operator, target, reason |
| T-07 | **An induced audit-write failure rolls back the role change** |
| T-08 | Increments the token version |
| T-09 | Exits non-zero if the resulting count is unexpected |
| T-10 | Re-running after success refuses cleanly |

### 9.2 Revoke command

| # | Test |
|---|---|
| T-11 | Refuses to reduce the count below 1 |
| T-12 | Refuses a target not holding the role |
| T-13 | Demotes to `admin`, not lower |
| T-14 | Revokes every grant in the same transaction |
| T-15 | Writes an audit record |

### 9.3 Immutability

Every prohibition, **asserted with an owner as the actor** where applicable.

| # | Test |
|---|---|
| T-16 | Deleting an owner is refused — including self-deletion |
| T-17 | Suspending an owner is refused — including by the other owner |
| T-18 | Warning an owner is refused |
| T-19 | Withholding from an owner is refused; a pre-existing withholding is ignored |
| T-20 | No endpoint accepts the owner role as a value |
| T-21 | The owner role appears in no writable enumeration — **static guard** |
| T-22 | A refusal message implies no escalation path |

**T-16 through T-19 with an administrator actor prove nothing** — the administrator is
refused by an ordinary rule. The wildcard case is the one that matters.

### 9.4 Boot check

| # | Test |
|---|---|
| T-23 | A count of 0, 1 or 3 warns and the platform **still boots** |
| T-24 | The warning names the actual and expected counts |

---

## 10. Blocking input required

**One item blocks implementation.**

| # | Input | Why it blocks |
|---|---|---|
| **Q-1** | **The two owner identities** — specifically the address for O-2 | The bootstrap cannot run without them. O-2's recovery channel must be **independent** of O-1's: a single compromised mailbox must not reach both |

**Recommendation for O-2:** a dedicated address on a different provider from O-1, with
multi-factor authentication, not used for anything else, and not forwarding to O-1.

### 10.1 Non-blocking decisions, with recommendations

| # | Question | Recommendation |
|---|---|---|
| Q-2 | Build the commands, or bootstrap once by hand and document it? | **Build them.** Retirement will be needed eventually (§5), and a one-off leaves no record of the platform's most consequential change |
| Q-3 | Operator identity: argument or host username? | **Host username**, with an optional override. An argument alone is as falsifiable as it is convenient |
| Q-4 | Fix or delete `bin/make-admin.mjs`? | **Fix now, delete at M2** (§6.2) |
| Q-5 | Ship the boot check before or with the bootstrap? | **With.** Shipping first means a warning that always fires, which trains everyone to ignore it (§4.3) |

---

## 11. Sequencing

| # | Step | Depends on |
|---|---|---|
| 1 | Owner provides Q-1 | — |
| 2 | Audit Log Explorer ships (M1 Task 3) | §8.3 — the records must be readable |
| 3 | Bootstrap and revoke commands, with the boot check, in one change | 1, 2 |
| 4 | Run the bootstrap. O-1, then O-2 | 3 |
| 5 | Verify: count is 2, both records visible in the Explorer, both accounts sign in | 4 |
| 6 | Immutability enforcement (INV-008 refusal paths) — **M2, not M1** | 5 |

**Step 6 is deliberately outside this plan.** Origination and enforcement are separate
concerns, and the enforcement work belongs with administrator management, where the paths
most likely to reach the owner role will exist.

---

## 12. Risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| K-1 | The bootstrap becomes a general escape hatch | **High** | BS-2's refusal at 2 is what makes it a bootstrap. Without it, this plan creates the mechanism INV-008 denies |
| K-2 | An audit write fails and the role change commits anyway | **High** | AU-3; T-07 by induced failure |
| K-3 | A shared credential between O-1 and O-2 | **High** | §3.5. Destroys attribution and is the most tempting shortcut |
| K-4 | Both owners share a recovery channel | **High** | Q-1's requirement; §10 recommendation |
| K-5 | Retirement reduces the count to 0 | Medium | RV-2's floor of 1 |
| K-6 | Boot check ships before the bootstrap, and its warning is normalised | Medium | Q-5: ship together |
| K-7 | A future contributor adds the count constraint believing it was overlooked | Low | §6.1 records the decision |
| K-8 | L-3 recovery depends on an untested restore | **High** | §5.2. Not closed by this plan; recorded as a dependency |

---

## 13. Recommendation

**Approve, subject to Q-1.**

The plan adds no schema, no route and no UI. It adds two host commands, three audit
actions, one boot warning, and the auditing that `bin/make-admin.mjs` should always have
had.

**Two conditions.**

1. **The bootstrap must not ship before the Audit Log Explorer.** Its output is a record,
   and a record nobody can read is not accountability. This is the same ordering argument
   that put the Explorer first in the milestone.
2. **K-8 must be acknowledged rather than absorbed.** The recovery story for total loss is
   "restore from backup", and that path has never been exercised while two destructive
   rebuilds have shipped. The restore drill is not part of this plan, and this plan is
   weaker than it appears until that drill happens.
