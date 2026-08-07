# Execution Prompt — Reconciliation Against Approved Plans and Repository

**Date:** 2026-08-06
**Produced under:** Operating Rule 1 — Verification Before Modification
**Status:** **Blocking.** Eleven discrepancies found. Four are blocking; seven are
correctable in place.

---

## Why this document exists

Rule 1 states: *"If the plan is outdated: stop, document the discrepancy, update the plan.
Do not silently diverge."*

That rule was applied in both directions. The execution prompt was checked against the
approved plans **and** against the repository. Where the prompt and the repository
disagree, the repository wins on fact. Where the prompt and the approved plans disagree on
**scope**, that is a decision only the owner can make, and it is escalated rather than
resolved.

**No source file has been modified.**

---

## Summary

| # | Discrepancy | Class | Severity |
|---|---|---|---|
| D-01 | Plan document paths do not exist as given | Correctable | Trivial |
| D-02 | Table named `audit_logs`; the table is `admin_audit_logs` | Correctable | Low |
| D-03 | Columns named `actor_id` / `target_id`; they are `admin_id` / `target_user_id` | Correctable | Low |
| D-04 | **A `severity` filter is required; no severity column exists** | **Blocking** | **High** |
| D-05 | A `category` filter is required; no category column exists | Correctable | Low |
| D-06 | **Phase 2 pulls admin management from M2 into M1** | **Blocking** | **High** |
| D-07 | **Phase 3 Impact Dashboard has no data source for two of its metrics** | **Blocking** | **High** |
| D-08 | Phase 4 Developer Mode was recommended for deferral | Escalate | Medium |
| D-09 | Task 1 — the live regression — is absent from the phase structure | Correctable | Medium |
| D-10 | **Owner identities still not supplied; bootstrap cannot run** | **Blocking** | **High** |
| D-11 | Phase 2 contradicts itself on superadmin creation | Correctable | Low |

---

## Correctable discrepancies

These I can resolve without a decision, and will, unless told otherwise.

### D-01 · Plan paths

**Prompt says:** `docs/spec/M1_EXECUTION_PLAN.md` and three siblings.
**Reality:** all four are at `docs/spec/reviews/`.

**Resolution:** use the real paths. No content difference.

### D-02 · Table name

**Prompt says:** `audit_logs(actor_id)`, `audit_logs(target_id)`, etc.
**Reality:** the table is `admin_audit_logs`. No table named `audit_logs` exists.

**Resolution:** index `admin_audit_logs`. Creating indexes as literally specified would
fail at migration time — which is the safe failure, but it would fail.

### D-03 · Column names

**Prompt says:** `actor_id`, `target_id`.
**Reality:** `id, admin_id, action, target_user_id, details, created_at`.

**Resolution:** use the real column names. The *intent* — index the actor, the target, the
time and the action — is exactly right and is what the approved plan already specifies.

### D-05 · Category filter

**Prompt requires:** filtering by category.
**Reality:** no category column.

**Resolution: already solved in the approved plan.** Category is **derived at read time**
from the action identifier, via a mapping shared with Appendix D. No schema change. The
seven categories are Enforcement, Moderation, Disclosure, Authorization, Account, Access,
System.

This is strictly better than a stored column: a stored category can drift from the action
it describes, and a derived one cannot.

### D-09 · The live regression is missing from the phase structure

**Prompt's phases:** 0 baseline → 1 audit explorer → 2 ownership → …
**Approved M1 plan:** Task 1 is the `ACCOUNT_SUSPENDED` notification coverage regression,
and it is first.

**Re-verified at Phase 0, not assumed:**

```
scanner sees: ORGANIZER_APPROVED, ACCOUNT_REINSTATED, ACCOUNT_WARNED
ACCOUNT_SUSPENDED visible? false
```

**Resolution:** do it first, as Phase 1a. It is a live defect on the notice a suspended
minor receives; building new features on top of a known regression is the wrong order. It
is also small — one comment moved, one scanner hardened, one derived guard added.

### D-11 · Phase 2 contradicts itself

**Prompt says**, three lines apart:

> "Only existing superadmins can create another superadmin."
>
> "Actually: No UI/API should allow creating superadmins. Superadmins are bootstrap-only."

**Resolution:** follow the second. It matches INV-008, the approved plan, and the
prompt's own Final Rules ("never allow superadmin creation through normal UI"). The first
statement is read as superseded by the "Actually".

---

## Blocking discrepancies

These change what gets built. I will not proceed on them without a decision.

---

### D-04 · The severity filter has no column, and adding one is a schema change the approved plan excluded

**Prompt requires (Phase 1):** filters for actor, action, target user, date range,
**severity**, category.

**Reality:** `admin_audit_logs` has six columns and none is severity. There is no severity
concept anywhere in the audit subsystem.

**Why this is blocking rather than correctable.** The approved plan states explicitly:
*"no schema change to `admin_audit_logs` itself"*. Adding a severity column means:

- a migration altering the platform's accountability table;
- a backfill decision for every existing row — what severity is a past `MODERATE_REPORT`?;
- a severity assignment for all ~25 audit actions, which is a judgement call per action;
- and a new field that must be kept correct on every future action.

**Three options:**

| # | Option | Cost | Assessment |
|---|---|---|---|
| **A** | **Drop the severity filter.** Ship the five that map to real columns | None | **Recommended.** Category already groups by consequence — `Disclosure` *is* the high-severity view, and it is derived rather than asserted |
| B | Derive severity from action, as category is derived | Small | Workable, but severity is a second opinion about the same fact category already expresses. Two derived groupings over one column invites them to disagree |
| C | Add a severity column with a migration and backfill | Medium, plus a permanent maintenance obligation | Only justified if severity must be set independently of action — which nothing currently requires |

**Recommendation: A.** If a high-consequence view is wanted, `category = Disclosure`
delivers it — every time private information left the platform, in one filter.

---

### D-06 · Phase 2 moves admin management from M2 into M1

**Prompt (Phase 2) requires:** admin creation by email with promote-or-invite behaviour,
pending invitations with automatic role application on signup, and an admin management
dashboard with grant/remove/revoke-organizer/suspend actions.

**Approved position** — from the milestone decision and the dependency graph, both
approved:

- Administrator promotion and revocation is **B-01**, blocked on the audit explorer (F-01)
  and the roster (F-02).
- Ownership immutability enforcement is **B-02**, blocked on B-01.
- Pending invitations is **B-03**, blocked on B-02 — *"invitations must not be able to
  confer the owner role"*, which requires the prohibition to exist first.

**The ordering argument, restated because it is the whole point.** Ownership enforcement
(INV-008's refusal paths) does not exist yet. Today no route accepts a role as a writable
value, so ownership is protected **by the absence of a feature**. Phase 2 builds exactly
the feature whose absence is currently the protection.

Building invitations before the prohibitions means a window in which a mechanism exists
that assigns roles, with no build-failing guard asserting it cannot assign the owner role.

**Two options:**

| # | Option | Assessment |
|---|---|---|
| **A** | **Split.** M1 = regression fix + audit explorer + bootstrap. M2 = ownership enforcement, then admin management, then invitations | **Recommended.** Preserves the ordering that every approved document relies on |
| B | Build it all in M1, in strict internal order: enforcement → promotion → revocation → invitations | Possible, but it is three milestones of work reported as one, and the security review for each would land at the end rather than at each gate |

**Recommendation: A**, and note that this is not a refusal — it is a request to keep the
gate between the two, so the security review of ownership enforcement happens before
anything can exercise it.

---

### D-07 · The Impact Dashboard has no data source for two required metrics

**Prompt (Phase 3) requires:** communities served; categories using **tags** with examples
Education / Environment / Food / Community / Technology; charts of trends and category
breakdown.

**Measured reality:**

| Required | Available | Verdict |
|---|---|---|
| Tags | **No `tags` column on `events`.** Columns are id, title, description, category, location, application_deadline, organizer_id, status, auto_approve, selection_summary, created_at, instructions, attendee_visibility, address, latitude, longitude | **Absent** |
| Event categories | A `category` column exists, with two distinct values in the development database: `Other`, `Food Pantry` | Present, but not the taxonomy the prompt names |
| Communities served | **No organization or community entity.** The closest is `users.school`, free text | **Absent** |

**The `users.school` problem, measured.** Six distinct values exist for what is plainly
three or four real organizations:

```
South Brunswick | Vikings Softball | SBPL |
SB Softball Booster | South Brunswick HS | South Brunswick High School
```

"South Brunswick", "South Brunswick HS" and "South Brunswick High School" are one school
written three ways. "Vikings Softball" and "SB Softball Booster" are plausibly one
organization.

**A "communities served" figure computed from this field would report 6 for a reality of
3–4.** That figure is the one shown to a district.

**This is precisely what A-07 (organization records) exists for**, and its blocking element
is not schema — it is the **reconciliation decision**: automated matching silently merges
distinct organizations with similar names and splits identical ones spelled differently,
and both errors propagate into the figures.

**Also relevant:** the analytics foundation (B-08) is unbuilt. The approved plan is explicit
that it ships **no dashboard**, because *"a dashboard built on unverified derivations
presents figures nobody has checked"*.

**Three options:**

| # | Option | Assessment |
|---|---|---|
| **A** | **Defer Phase 3.** Build organizations (A-07) with a reconciliation pass, then the analytics foundation (B-08), then the dashboard | **Recommended.** It is also the only order that produces figures defensible to a district |
| B | Build a **reduced** dashboard now: only metrics with a real source — total users, active users, volunteers with credited service, total hours, hours this month, average and **median** hours, events by status. Omit communities and tags, and say why on the surface | Viable. Honest. Delivers most of the value |
| C | Build it as specified, deriving communities from `users.school` and categories from `category` | **Not recommended.** Produces a wrong community count and a category breakdown of two values |

**Recommendation: B if a dashboard is wanted in this milestone, A otherwise.** Not C.

---

### D-10 · The bootstrap cannot run — owner identities were never supplied

The Super Admin plan recorded exactly one blocking input:

> **Q-1 — the two owner identities**, specifically the address for the second account,
> whose recovery channel must be independent of the first.

That has not been provided. **Measured state: zero accounts hold `super_admin`.**

The commands can be *written* without it. They cannot be *run*, so Phase 2's "initial
owners: WeVolunteer account, Mahit owner account" cannot be completed, and the boot-count
check cannot be shipped without producing a warning that fires on every boot.

**Required before Phase 2 completes:**

1. The address for the Mahit owner account (an existing verified account, or one to be
   registered normally first).
2. The address for the WeVolunteer master account.
3. Confirmation their recovery channels are independent — a single compromised mailbox must
   not reach both.

---

## Escalated, not blocking

### D-08 · Developer Mode

The approved security review recommended **deferring** Developer Mode's mutating half
entirely, and stated that the surface must not ship before the audit trail is readable —
because its misuse is detectable only through a record nobody can currently read.

**The prompt's Phase 4 is read-only-first**, which matches the recommendation's first
stage. The three blocking findings from that review stand and must be resolved in the
design before implementation:

| # | Finding |
|---|---|
| DF-1 | Identification must key on **account id**, not email. Keying on email means an address change silently disables or silently transfers the surface |
| DF-2 | Destructive operations need **step-up**, not merely confirmation. Confirmation defends against a mis-click, not a stolen session |
| DF-3 | Must not ship before the audit explorer |

Phase 4 as scoped (read-only, no arbitrary DB editing, no user deletion, no permission
bypass) is compatible with all three, provided DF-1 is settled before the access control
is written.

---

## What I propose to do

Absent a contrary instruction, this is the sequence I would follow. Every step preserves
the ordering the approved documents rely on.

| # | Step | Status |
|---|---|---|
| 1 | Phase 0 baseline | **Done.** 194 files, 3,163 tests, lint and build clean |
| 2 | Agent 1 / Agent 2 current-state and security reports | In progress |
| 3 | **Phase 1a — fix the `ACCOUNT_SUSPENDED` regression** (D-09) | Awaiting go-ahead |
| 4 | **Phase 1b — Audit Explorer**, five filters not six (D-04 option A), real table and column names (D-02, D-03), category derived (D-05) | Awaiting decision on D-04 |
| 5 | Phase 2a — bootstrap **commands** written and tested | Can proceed |
| 6 | Phase 2b — bootstrap **run** | **Blocked on D-10** |
| 7 | Phase 2c — ownership enforcement (INV-008 refusals) | After 6 |
| 8 | Admin management, then invitations | **M2** under D-06 option A |
| 9 | Impact Dashboard | **Deferred or reduced** under D-07 |
| 10 | Developer Mode read-only | After 4, with DF-1 settled |

---

## Decisions required

| # | Decision | Recommendation |
|---|---|---|
| **1** | **D-04** — severity filter: drop, derive, or add a column? | **Drop.** `category = Disclosure` already gives the high-consequence view |
| **2** | **D-06** — admin management in M1, or M2 after ownership enforcement? | **M2.** Keep the gate so ownership enforcement is reviewed before anything exercises it |
| **3** | **D-07** — Impact Dashboard: defer, reduce, or build as specified? | **Reduce or defer.** Not as specified — the community count would be wrong |
| **4** | **D-10** — the two owner identities | Required before the bootstrap can run |

**I will proceed with steps 3 and 5 on the existing approvals if you would rather not
re-litigate scope** — the regression fix and the bootstrap commands are both unambiguous,
both already approved, and neither depends on any of the four decisions above.

---

## Addendum (2026-08-06) — three discrepancies found by verification, after the table above

Agents 1 and 2 completed after this document was first written. Three findings change the
plan; all three were re-verified by direct read before being recorded.

### D-12 — the approved audit-explorer plan is wrong about `audit.read`. **Blocking for step 4.**

`AUDIT_EXPLORER_IMPLEMENTATION_PLAN.md` §1.1 asserted administrators "cannot use
[`audit.read`] for anything". There are **three** production uses. Moving the capability as
approved would silently empty every administrator's application list — a 200 with an empty
array that the status-only authorization matrix cannot detect — and strip contact PII from
student profiles.

**Handled as the prompt requires: the plan was corrected in place, not silently diverged
from.** See that document's new §1.1a, and `CURRENT_STATE_REPORT.md` §2. Step 4 grows from
two changes to four, plus three mandatory content-level tests.

### D-13 — `bin/make-admin.mjs` silently demotes a `super_admin`. **Blocking for step 6; reorders the plan.**

The script guards only `role === 'admin'`; against any other role it overwrites
unconditionally, with no audit row and a "Successfully promoted" message. Harmless today
because no owner exists — **and step 6 is precisely what arms it.**

**This inserts a new step 5a: fix the script before the bootstrap runs.** It is a
precondition of ownership, not a follow-up to it. See `SECURITY_REVIEW_M1.md` §S-1.

### D-14 — the audit trail is mutable and cascades. **Not blocking; folds into step 4.**

`admin_audit_logs.admin_id` carries `ON DELETE CASCADE`, contradicting Volume I §1.7.5, and
the table is absent from both the retention purge's exemption checks and
`PRESERVED_TABLES`. It also has **none** of the 16 immutability triggers that protect the
moderation tables. Publishing a read surface over it — which is what step 4 does — asserts
a durability the storage layer does not provide.

**Folds into step 4's migration:** sever the cascade, snapshot the actor identity, add the
triggers, add the table to `PRESERVED_TABLES`, alongside the indexes the plan already
specifies. See `SECURITY_REVIEW_M1.md` §S-2 and §S-3.

### Revised sequence

| # | Step | Change |
|---|---|---|
| 3 | Phase 1a — `ACCOUNT_SUSPENDED` regression fix | Unchanged |
| 4 | Phase 1b — Audit Explorer | **Grows:** four re-gates + three content tests (D-12), audit-durability migration (D-14) |
| **5a** | **Fix `bin/make-admin.mjs`** | **New, and it precedes the bootstrap** |
| 5 | Bootstrap commands written and tested | Now after 5a |
| 6 | Bootstrap run | Still blocked on D-10 |

**None of this changes M1's shape.** It changes what "done" means for step 4, and it changes
the order around step 5.
