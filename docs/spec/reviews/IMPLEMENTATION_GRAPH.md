# Implementation Dependency Graph

**Date:** 2026-08-06
**Derived from:** `06-implementation-phases.md`, `appendix-capability-matrix.md`,
`appendix-database-schema.md`, `appendix-api-contracts.md`, and the findings in
`SPEC_VALIDATION_2026-08-06.md`
**Status:** Planning artefact. Nothing here has been built.

---

## 1. How this differs from Volume VI

Volume VI orders phases by dependency and specifies each in full. This document
classifies every planned item by **whether it can start now**, and records the cost
dimensions that decide sequencing. Where the two disagree, this document is the later
analysis and incorporates the validation findings; Volume VI's per-phase requirements
remain normative.

**One material change from Volume VI.** Validation produced four remediation items
(§3.1) that did not exist when Volume VI was written. Three of them are prerequisites
for work Volume VI treats as unblocked. The graph reflects that.

---

## 2. Classification rules

| Class | Means |
|---|---|
| **Ready** | Every prerequisite is met. Work can begin without a further decision. |
| **Blocked** | Requires another item first. The blocker is named. |
| **Architectural** | Requires a decision that cannot be derived from the specification. The decision is stated. |
| **Deferred** | Not needed for launch. Deferral is a decision, not an omission. |

**Rollback difficulty** is scored on what a revert costs:

| Score | Means |
|---|---|
| **Trivial** | Revert the commit. No data, no user-visible state. |
| **Low** | Revert; additive schema remains harmlessly. |
| **Medium** | Revert leaves data written by the feature. Safe, but the data outlives the code. |
| **High** | Revert cannot undo effects already applied to accounts or records. |
| **Irreversible** | Cannot be reverted meaningfully once exercised. |

---

## 3. Ready

### 3.1 Remediation items — from validation, all Ready

These did not exist in Volume VI. Three of them gate later work.

---

#### R-01 · Restore `ACCOUNT_SUSPENDED` coverage and derive the notification guard

**Closes:** SPEC_VALIDATION §5.1 (live regression), C-03

| Dimension | Detail |
|---|---|
| Dependencies | None |
| Migrations | None |
| Backend | Move one comment out of a call's argument list |
| Frontend | None |
| Tests | Rewrite the coverage guard to derive its subject set from `EVENT_CATEGORIES` and `MANDATORY_NOTICE_EVENTS`; assert content for every member of both; keep the dispatch scan as a supplementary check for unregistered dispatches |
| Security impact | **Restores** coverage on the notice a suspended minor receives, containing the reason and the appeal link |
| Rollback | **Trivial** |

**Why it is first.** It is a live regression, it is small, and the corrected guard is
what prevents the same class recurring. Fixing only the comment position would leave a
guard that any future comment can blind again.

**Discovered side effect:** the same rewrite will surface the 10 contentless registered
events. Those are a **decision**, not part of this item — see A-04.

---

#### R-02 · Narrow the dedupe catch; evaluate mandatory status first

**Closes:** C-04

| Dimension | Detail |
|---|---|
| Dependencies | None |
| Migrations | None |
| Backend | Reorder the dispatch catch; replace a substring match on the error message with a check against the specific constraint condition |
| Frontend | None |
| Tests | Induce a non-dedupe error whose message contains the substring; assert the suspension transaction rolls back. Assert a genuine duplicate is still suppressed |
| Security impact | Restores the rollback guarantee behind the platform's most consequential transaction |
| Rollback | **Trivial** |

---

#### R-03 · Add non-empty assertions to 13 derived guards

**Closes:** C-10

| Dimension | Detail |
|---|---|
| Dependencies | None |
| Migrations | None |
| Backend | None |
| Frontend | None |
| Tests | 13 assertions; plus convert the step-up guard from a file-count to a call-site-count assertion |
| Security impact | The affected guards include the platform's **primary role-comparison guard** and the suspension single-definition guard. Both can currently pass over zero files |
| Rollback | **Trivial** |

**Why it gates other work.** Every subsequent phase adds subjects to these guards. A
guard that can pass vacuously provides no protection to the work that relies on it.

---

#### R-04 · Add staleness assertions to 5 exemption lists

**Closes:** C-11

| Dimension | Detail |
|---|---|
| Dependencies | None |
| Migrations | None |
| Tests | 5 assertions. The client-route exclusion is the important one: an exclusion for a deleted route currently survives forever and would silently cover a future route reusing the path |
| Security impact | Low directly; prevents silent coverage loss |
| Rollback | **Trivial** |

---

#### R-05 · Reconcile retention: enforced versus declared

**Closes:** C-01. **Blocks launch** (LR-20)

| Dimension | Detail |
|---|---|
| Dependencies | None to *analyse*. Enforcement work depends on the outcome |
| Migrations | None to analyse |
| Backend | Depends: any published period with no enforcing mechanism needs either a sweep or a policy amendment |
| Frontend | None |
| Tests | One per retention class, asserting the enforced period matches the published one |
| Security impact | Privacy-policy truthfulness. A published period the platform does not honour is a false statement about a minor's data |
| Rollback | **Trivial** for the analysis; **Medium** for any new sweep, because a sweep that has run has deleted things |

**Architectural component.** Whether to build the missing sweeps or amend the published
periods is an owner decision (Q-05). The analysis is Ready; the remedy is Architectural.

---

#### R-06 · Documentation corrections

**Closes:** C-02, C-06, C-07, C-08, C-09, C-12, S-01 to S-04, M-01 to M-05, and the
Appendix E rewrite (A-12)

| Dimension | Detail |
|---|---|
| Dependencies | None |
| Everything else | Documentation only |
| Security impact | None directly. Appendix E's rewrite (72 guards, not 23) is a prerequisite for trusting any later "tests required" estimate |
| Rollback | **Trivial** |

---

### 3.2 Feature items — Ready

---

#### F-01 · Audit Log Explorer (Volume VI P-01)

| Dimension | Detail |
|---|---|
| Dependencies | R-03 recommended first (the guard estate should be sound before adding gated routes) |
| Migrations | Indexes supporting every offered filter. Additive |
| Backend | One paginated filtered read endpoint; one export endpoint registered as a sensitive action |
| Frontend | One filterable table screen; step-up flow for export |
| Tests | Authorization for all five roles; filter validation per filter; departed-actor fallback; whole-set counts; step-up pairing; export content constraints; query-plan assertions per filter |
| Security impact | **Positive and significant.** The trail is currently written and readable by nobody. Adds one bulk-disclosure path, mitigated by step-up |
| Rollback | **Low.** Revert; indexes remain harmlessly |

**Unblocks:** F-02, F-03. Administrator management writes records whose only purpose is
being read.

---

#### F-02 · Administrator roster (Volume VI P-02)

| Dimension | Detail |
|---|---|
| Dependencies | **F-01** — the roster links into the explorer |
| Migrations | One index for per-actor audit aggregation. Additive |
| Backend | One read endpoint, owner-gated |
| Frontend | One table with expandable capability detail |
| Tests | Authorization; capability display matches the kernel exhaustively for granted and withheld cases; owners marked with no mutation affordance; absent promotion metadata renders explanatorily |
| Security impact | **Positive.** Nobody can currently answer "who holds authority to read students' private messages". Adds the evidence-read count, which is the only misuse signal available |
| Rollback | **Low** |

Listed under Ready because F-01 is Ready and the pair is naturally one work stream.
Strictly it is Blocked on F-01.

---

#### F-03 · Suspension normalisation sweep (Volume VI P-06)

| Dimension | Detail |
|---|---|
| Dependencies | R-03 (the suspension guard is one of the 13) |
| Migrations | None |
| Backend | Wire the existing `sweepExpiredSuspensions` to a schedule |
| Frontend | None |
| Tests | Uses the shared predicate; retains the reason; does not bump token versions; leaves unreadable deadlines alone; idempotent; records what it lifted |
| Security impact | **None to access correctness** — the predicate is already authoritative. Corrects labelling only |
| Rollback | **Low.** Revert; already-normalised rows stay normalised, which is correct |

**Note.** The function exists and is tested. This item is scheduling plus observability,
not new logic.

---

## 4. Blocked

---

#### B-01 · Administrator promotion and revocation (Volume VI P-03)

**Blocked by:** F-01, F-02

| Dimension | Detail |
|---|---|
| Migrations | Promotion metadata columns, nullable, **no backfill** |
| Backend | Two endpoints; two new sensitive actions; grant revocation, report unassignment and appeal release inside the revocation transaction |
| Frontend | Promotion and revocation flows from the roster; consequence enumeration; step-up |
| Tests | ~12 cases including: an administrator cannot promote (asserted for both role-holder and grant-holder); atomicity **by induced failure**; revocation revokes grants; revocation retains decisions |
| Security impact | **Highest of any Ready or Blocked item.** Creates the mechanism by which a principal gains authority over every student's private messages |
| Rollback | **High.** Already-promoted administrators stay promoted; a rollback must not demote them, because that removes authority somebody is relying on without a decision |

**Staging is load-bearing.** Revocation ships before promotion, so a phase stopped
midway leaves the platform *safer*, not less safe.

---

#### B-02 · Ownership immutability enforcement (Volume VI P-04)

**Blocked by:** B-01 — the paths most likely to be able to reach the owner role must
exist before the prohibition is verified against them

| Dimension | Detail |
|---|---|
| Migrations | **None.** No storage constraint on the owner count — see §6, D-03 |
| Backend | Boot-time count check, warning and non-fatal; refusals by absence of mechanism |
| Frontend | Refusal copy asserting no escalation path |
| Tests | All 15 edge cases, **with an owner as the actor** where applicable. A test using an administrator principal proves nothing: the administrator is refused by an ordinary rule and the wildcard case is the one that matters |
| Security impact | **Foundational.** INV-008 and INV-009 |
| Rollback | **Trivial** to revert, but the revert *removes protections* and therefore needs owner sign-off |

---

#### B-03 · Pending administrator invitations (Volume VI P-05)

**Blocked by:** B-02 — invitations must not be able to confer the owner role

| Dimension | Detail |
|---|---|
| Migrations | One table. Token stored as a **hash**; address stored case-insensitively comparable |
| Backend | Create, revoke, accept. Acceptance requires verified address matching the invitation, plus consent capture |
| Frontend | Pending list; creation; unauthenticated three-step acceptance |
| Tests | ~12 including: confers nothing before acceptance; token absent from every response; four failure causes indistinguishable; acceptance atomic by induced failure; case-variant refused |
| Security impact | **Very high.** A live invitation is administrator authority awaiting collection |
| Rollback | **Medium.** Pending invitations become unacceptable, which is safe, but invited parties must be told |

---

#### B-04 · Remaining moderation actions (Volume VI P-07)

**Blocked by:** B-02 — both act on roles and capabilities

| Dimension | Detail |
|---|---|
| Migrations | None. Withholding reuses the existing per-account capability machinery |
| Backend | Organizer demotion; capability withholding as a moderation act |
| Frontend | Both offered from report detail, capability-gated, both reversible from the same surface |
| Tests | Demotion retains every event, attendance record, credited hour and certificate; withholding takes effect next request; withholding disclosed with reason and remedy; remedy surface stays reachable |
| Security impact | Medium. Adds two enforcement instruments |
| Rollback | **High.** A demotion already applied cannot be silently reversed |

**Watch item.** The single largest risk is introducing a *parallel* restriction system
instead of reusing withholding.

---

#### B-05 · Developer Mode shell and read-only tools (Volume VI P-08)

**Blocked by:** B-02

| Dimension | Detail |
|---|---|
| Migrations | None |
| Backend | Access control applied **per route**, not by prefix; nine read-only tools |
| Frontend | Index plus nine tool screens |
| Tests | Refused for the **second owner account**; refused for every other principal; absent configuration disables entirely; the guard fails against a route omitting the check; no tool renders a secret; no tool writes |
| Security impact | High. New privileged surface, mitigated by read-only scope in this item |
| Rollback | **Trivial** |

**Access control ships before any tool.** A surface whose restriction is added later is
a surface that was briefly open.

---

#### B-06 · Feature flags and maintenance mode (Volume VI P-09)

**Blocked by:** B-05

| Dimension | Detail |
|---|---|
| Migrations | Flag storage, or configuration-backed |
| Backend | Flag registry with defaults; maintenance state |
| Frontend | Two Developer Mode tools; a maintenance takeover |
| Tests | Unset flag resolves to default; both states of every flag tested; maintenance is a takeover; health reports maintenance distinctly from unhealthy; sessions survive |
| Security impact | **Requires review of the registry, flag by flag.** No flag may gate a security control or a legal obligation |
| Rollback | **Medium.** A flag set in production must be reset before the code that reads it is removed |

---

#### B-07 · Developer Mode mutating tools and emergency controls (Volume VI P-10)

**Blocked by:** B-05, B-06

| Dimension | Detail |
|---|---|
| Migrations | Freeze state on accounts |
| Backend | Mutations for five tools; notification tester self-target only; API explorer own-principal only; seven emergency controls |
| Frontend | Confirmation flows naming specific effects |
| Tests | Every mutation records unsuppressibly **before** effect; tester cannot target another account; explorer cannot act as another account; mandatory notices undiscardable; pauses expire; freeze creates no moderation record |
| Security impact | **Creates platform-wide mutation authority in one account.** The concentration is deliberate and must be recorded as a residual risk |
| Rollback | **High.** Effects already applied — revoked sessions, discarded jobs, frozen accounts — do not reverse |

---

#### B-08 · Analytics foundation (Volume VI P-12)

**Blocked by:** F-04 (organization records) for organization-scoped metrics only

| Dimension | Detail |
|---|---|
| Migrations | Materialisation tables only where a budget requires one |
| Backend | One definition per metric; derivations; parity check |
| Frontend | **None. This item ships no dashboard** |
| Tests | No counter is a source; materialisation rebuilds to the same values; parity check fails on induced divergence; suppression labelled not zeroed; scoping excludes other organizers and organizations |
| Security impact | Privacy: aggregate suppression threshold must be set against the **actual** population |
| Rollback | **Low** |

**Ships no user-visible surface deliberately.** A dashboard built on unverified
derivations presents figures nobody has checked.

---

#### B-09 · Community Impact Dashboard (Volume VI P-13)

**Blocked by:** B-08. Two widgets additionally blocked by F-04

| Dimension | Detail |
|---|---|
| Migrations | None beyond B-08 |
| Backend | Widget queries over B-08 derivations |
| Frontend | 21 widgets in four stages; safety widget in the **first** stage |
| Tests | Correct values against a known fixture; zero states; **no fabricated data in any mode**; every chart has a tabular equivalent and a unit-correct caption; partial periods labelled; bounded query count |
| Security impact | Low internally. Becomes significant at F-06 (public pages) |
| Rollback | **Trivial** |

---

#### B-10 · Public impact pages (Volume VI P-14)

**Blocked by:** B-09

| Dimension | Detail |
|---|---|
| Migrations | Opt-in state |
| Backend | Unauthenticated aggregate endpoint; higher suppression minimum |
| Frontend | Public page |
| Tests | No individual without opt-in; **no individual under eighteen under any circumstance**; revocation immediate including in materialisations; servable under maintenance |
| Security impact | **Highest privacy exposure of any item.** Public data derived from minors' records |
| Rollback | **Medium.** Published figures may have been screenshotted and shared |

---

## 5. Architectural

Items requiring a decision that cannot be derived from the specification.

---

#### A-01 · Impersonation (Volume VI P-15)

**Decision required:** build it, or **remove the capability from the registry**.

The capability is registered and super-only with no mechanism. Volume IV §4.6.1 states
the rule: a registered capability with no mechanism is indistinguishable from an
unfinished feature and will eventually be implemented by somebody who has not read the
specification.

| If built | Detail |
|---|---|
| Blocked by | B-07 |
| Backend | Dual-identity principal; every write refused; both identities on every audit record |
| Tests | Every state-changing request refused **across every verb**; messages and evidence unreadable; automatic expiry; subject notified |
| Security impact | Read-only makes it tolerable. Writable impersonation would corrupt the attribution the entire moderation record depends on |
| Rollback | **Medium** |

**Recommendation: remove the capability** unless a concrete support need has appeared.
It has not, in the platform's history to date.

---

#### A-02 · Retention enforcement remedy (from R-05)

**Decision required:** for each published period with no enforcing mechanism, build the
sweep or amend the published period.

Building a sweep is **Medium-to-High** rollback: a sweep that has run has deleted
things. Amending the policy is trivial but must be honest about why.

---

#### A-03 · Multi-tenancy preparation (Volume VI P-16)

**Decision required:** whether a second institution is a real prospect within a horizon
that justifies the work now.

| Dimension | Detail |
|---|---|
| Blocked by | F-04 |
| Migrations | A tenant column on every tenant-scoped table, populated. **Additive per table, not a rebuild** |
| Backend | One shared scoping mechanism; a build guard against bypass |
| Tests | A **fixture second tenant** — isolation cannot be verified with one tenant |
| Security impact | Isolation becomes a security property the moment a second tenant exists |
| Rollback | **High.** Columns and indexes across the schema |

**The timing argument is the whole decision.** While exactly one tenant exists, every
row belongs to it and the migration is mechanical. Afterwards, ambiguous rows have no
correct answer. The window closes permanently on admitting a second tenant — but doing
the work for a tenant that never arrives is substantial cost for nothing.

---

#### A-04 · The 11 unreachable notification events

**Decision required:** build or delete, per event.

10 registered events have no content and fall through to a placeholder; 1 has content
and no dispatch site. None is reachable today. Leaving them is the same defect class as
a registered capability with no mechanism.

| Dimension | Detail |
|---|---|
| Dependencies | R-01 surfaces them |
| Rollback | **Trivial** either way |

---

#### A-05 · Audit action for appeal decisions

**Decision required:** should an appeal decision write an audit action?

Currently it produces a notification only. It is an administrative act against a person,
and INV-011 argues it should be recorded. Adding it is trivial; the decision is whether
the subject-scoped appeal history already discharges the obligation.

---

#### A-06 · Mandatory notice to a missing recipient

**Decision required:** throw, or continue silently?

Throwing rolls back enforcement when the subject vanishes mid-transaction. Not throwing
means an enforcement action commits with no notice. The specification does not currently
address it.

---

#### A-07 · Organization records (F-04 in dependency terms)

**Decision required:** the reconciliation policy for existing free-text affiliations.

| Dimension | Detail |
|---|---|
| Dependencies | None |
| Migrations | Three additive: organization table, organizer association, event reference |
| Backend | Create, propose, verify, rename, merge, deactivate |
| Frontend | Management screens |
| Tests | Free text retained; organizer cannot self-verify; renaming preserves historical attribution; merging preserves attributed records |
| Security impact | Low |
| Rollback | **Medium.** Attributions written by the feature outlive a revert |

**The decision is reconciliation, not schema.** Automated matching on free text silently
merges distinct organizations with similar names and splits identical ones spelled
differently — and both errors propagate into figures presented to districts. Manual,
recorded reconciliation is the recommendation, but it is work somebody must do.

**Unblocks:** B-08 (partially), B-09 (two widgets), A-03.

---

## 6. Deferred

| # | Item | Why deferred | Revisit when |
|---|---|---|---|
| D-01 | Database engine migration (P-17) | Requires a **measured** trigger. None has been measured. Anticipation is not a trigger | A §5.7.3 trigger is measured |
| D-02 | Horizontal scaling | Requires D-01 | After D-01 |
| D-03 | Storage-level owner-count constraint | Requires a trigger on every account write, paid on every registration, to prevent an operation no code path performs. The boot warning plus quarterly review is proportionate | If a third owner ever appears in practice |
| D-04 | Uploaded media | Requires content scanning, storage lifecycle, and a reporting-obligation analysis not yet done | Never, absent a concrete need |
| D-05 | Student-to-student messaging | **Permanently excluded.** The safety model depends on every conversation having an adult or staff party | Never |
| D-06 | Public individual profiles | **Permanently excluded.** Population is majority minors | Never |
| D-07 | Third-party analytics | **Permanently excluded.** Data flows cannot be constrained by this specification | Never |
| D-08 | Automated content classification | **Explicitly rejected.** A false negative creates a record that content was reviewed and cleared, which is then relied upon | Never |
| D-09 | Native mobile applications | Responsive web is the delivery vehicle | If the institution requires it |

---

## 7. Critical path

```
R-01 ─┐
R-02 ─┤
R-03 ─┼─→ F-01 ─→ F-02 ─→ B-01 ─→ B-02 ─┬─→ B-03
R-04 ─┘                                  ├─→ B-04
                                         └─→ B-05 ─→ B-06 ─→ B-07 ─→ [A-01]

A-07 ─→ B-08 ─→ B-09 ─→ B-10
   └──────────────────→ [A-03]

R-05 ─→ [A-02]                        F-03 (independent, after R-03)
```

**Two independent streams.** The administrative stream (R → F-01 → … → B-07) and the
impact stream (A-07 → B-08 → B-10) share no dependency. They can run in either order or
in parallel. Nothing in the impact stream is a launch blocker; two items in the
administrative stream are.

**The longest chain is eight items deep** and every link is real: each item writes
records the next one reads, or establishes a protection the next one could otherwise
violate.

---

## 8. Sequencing summary

| Rank | Item | Rationale |
|---|---:|---|
| 1 | R-01, R-02 | Live defects. Both safety-adjacent. Both trivial to revert |
| 2 | R-03, R-04 | Mechanical, zero behavioural risk, and everything downstream relies on these guards |
| 3 | R-06 | Documentation. Required before any later estimate can be trusted |
| 4 | **F-01** | Highest-value unblocked feature. See `NEXT_MILESTONE_DECISION.md` |
| 5 | F-02 | Natural pair with F-01 |
| 6 | R-05 → A-02 | Launch blocker. Start the analysis early; the remedy needs a decision |
| 7 | F-03 | Independent, small, closes a recorded gap |
| 8 | B-01 → B-02 | The high-risk administrative core |
| 9 | A-07 → B-08 | Begins the impact stream |
| 10 | Everything else | Per the critical path |

---

## 9. What this graph does not decide

- **Which item to build first** — that is `NEXT_MILESTONE_DECISION.md`, and it argues
  the case rather than reading it off this table.
- **How to build any item** — Volume VI's per-phase specifications remain normative.
- **Whether the Architectural items are worth doing** — each states its decision; none
  is decided here.

**Requirement.** No item in §4 may begin before its named blocker is closed. No item in
§5 may begin before its decision is recorded in writing.
