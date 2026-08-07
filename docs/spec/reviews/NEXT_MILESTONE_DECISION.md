# First Implementation Milestone — Decision

**Date:** 2026-08-06
**Decides:** which milestone is built first after the validation pass
**Inputs:** `SPEC_VALIDATION_2026-08-06.md`, `IMPLEMENTATION_GRAPH.md`, Volume VI
**Status:** Recommendation. Not approved. Not started.

---

## 1. Decision

**Milestone 1 is the Audit Log Explorer, preceded by four remediation items.**

> **M1 = R-01 + R-02 + R-03 + R-04 → F-01 (Audit Log Explorer) → F-02 (Administrator roster)**

The remediation items are not a separate milestone. They are the first four commits of
this one, because three of them fix defects in the machinery M1 itself depends on, and
one is a live regression.

**Explicitly not chosen first:** the Ownership system, the Super Admin foundation, the
Impact Dashboard, and the User Management system. §5 states why each loses.

---

## 2. The criteria, applied

The brief specifies five. They are applied in order of weight, and the weighting is
stated rather than assumed.

| # | Criterion | Weight | Why this weight |
|---|---:|---|---|
| 1 | Security impact | Highest | The platform holds minors' private messages and disciplinary records. Nothing outranks this |
| 2 | Ability to verify independently | High | A one-person team plus agents cannot rely on "it looked right". A milestone whose correctness is self-evident is worth more than one that is merely valuable |
| 3 | Dependency unlocking | High | Eight-deep critical path. Unlocking the head of it compounds |
| 4 | Migration risk | Medium | Inverted: **low** migration risk scores well. Two rebuilds have already shipped and no restore drill has been performed |
| 5 | User value | Medium | Real, but the platform is pre-launch. Nobody is currently blocked by a missing feature; the institution is blocked by unverifiable accountability claims |

**On the weighting of user value.** It is deliberately fourth. Before launch, "user
value" means value to the *institution deciding whether to adopt*, and that decision
turns on whether the platform's safety and accountability claims can be demonstrated —
not on feature count.

---

## 3. Why the Audit Log Explorer wins

### 3.1 Security impact — the strongest case

`admin_audit_logs` is written on **every** administrative action and is readable by
nothing. The capability that would gate reading it, `audit.read`, exists, is held by
administrators, and gates exactly one unrelated status endpoint.

This is not a missing feature. It is a **published claim the platform cannot currently
support**. The administrative responsibilities policy commits to accountability that
rests entirely on a record no administrator can read. Today, if a parent or a district
asked "who read my child's private messages, and when", the answer would require
somebody to open the database by hand.

That question is not hypothetical for this platform. It is the question the whole
evidence system, the dual-trail design, and the log-before-disclose rule exist to be
able to answer.

**Second-order security value.** The Explorer is what makes every *later* administrative
feature auditable in practice rather than in principle. Promotion, revocation,
invitations, emergency controls and Developer Mode all write records. Building any of
them before the reading surface means shipping authority whose exercise nobody can
review.

### 3.2 Independent verifiability — the decisive practical case

The Explorer is verifiable **without trusting the implementation**:

- Take an action that writes a known audit record.
- Open the Explorer.
- The record is there, or it is not.

There is no state machine to reason about, no timing, no interaction between features.
Correctness is observable in one step by one person. Among every candidate, this is the
only one with that property.

Contrast the Ownership system, whose central claims are *negative* — "no path can create
a third owner" — and are verified by exhaustively failing to do something across fifteen
edge cases with a wildcard-holding actor. That is verifiable, but only by careful
adversarial testing, not by looking.

### 3.3 Dependency unlocking

F-01 sits at the head of the administrative chain. It unlocks F-02, which unlocks B-01,
which unlocks B-02, which unlocks four separate branches.

**The ordering is not arbitrary.** Volume VI records the reason and it survives
scrutiny: promotion and revocation write audit records whose *only purpose* is being
read. Shipping them first produces a period in which administrator authority can be
granted and withdrawn with no reviewable record — which is precisely the accountability
gap the Explorer closes.

### 3.4 Migration risk — the lowest of any candidate

| Candidate | Migration |
|---|---|
| **Audit Explorer** | **Indexes only. Additive. Revert leaves them harmlessly** |
| Administrator management | Nullable columns, no backfill |
| Ownership system | None, but changes refusal behaviour platform-wide |
| Impact Dashboard | Materialisation tables, plus organization records first |
| User management | Requires a list endpoint that does not exist |

Index-only is the lowest-risk schema change available. Given that two destructive
rebuilds have shipped and **no restore drill has been performed**, a first milestone that
does not touch data is the responsible choice.

### 3.5 User value

Moderate and real. The immediate beneficiaries are the platform owner and the
institution. It is not a student-facing feature, and that is stated plainly rather than
inflated.

---

## 4. What M1 contains

| # | Item | Why in M1 |
|---|---|---|
| R-01 | Restore `ACCOUNT_SUSPENDED` coverage; derive the notification guard | Live regression, introduced by this author. Fix before adding anything |
| R-02 | Narrow the dedupe catch; evaluate mandatory status first | Live defect weakening the suspension rollback guarantee |
| R-03 | Non-empty assertions on 13 derived guards | M1 adds routes and capabilities that these guards protect. A guard passing over zero files protects nothing |
| R-04 | Staleness assertions on 5 exemption lists | Same reasoning, lower severity |
| F-01 | Audit Log Explorer | The milestone |
| F-02 | Administrator roster | Natural pair; the roster's value depends on the Explorer existing |

**R-06 (documentation corrections) runs alongside** and gates nothing.

### 4.1 Deliberately excluded from M1

| Excluded | Why |
|---|---|
| R-05 retention reconciliation | Launch blocker, but its *remedy* is Architectural (A-02) and needs an owner decision. Start the analysis in parallel; do not couple M1 to a decision |
| F-03 suspension sweep | Independent and small, but unrelated. Bundling would blur what M1 verified |
| Anything in §4 of the graph | All blocked on M1 or on each other |

---

## 5. Why each alternative loses

### 5.1 Super Admin foundation / Ownership system — loses on **prerequisite order**

The strongest rival. Its security impact is arguably higher: INV-008 and INV-009 are
foundational, and until they are enforced, ownership is protected by the absence of a
feature rather than by a rule.

**It loses on three grounds.**

1. **It is blocked, correctly.** Volume VI places ownership enforcement *after*
   administrator management, and the reason holds: the paths most likely to be able to
   reach the owner role are promotion and revocation, and the prohibition should be
   verified against the mechanisms that exist rather than against a hypothetical.
2. **Its verification is adversarial, not observational.** Fifteen edge cases, each
   requiring an owner-principal actor, each proving a negative. That is exactly the work
   to do — but it is a poor *first* milestone for establishing a verification rhythm.
3. **The risk it mitigates is not currently live.** No route accepts the owner role as a
   parameter today. The exposure is a *future* feature introducing one — which is
   precisely what B-01 would be. Sequencing ownership immediately after administrator
   management closes the gap at the moment it opens.

**Counter-argument, recorded honestly:** if administrator management were to be built by
an agent without the ownership prohibitions in place, the window between B-01 and B-02
is real. **Mitigation:** B-01's acceptance checklist already requires that promotion
refuse an owner target, and B-02 follows immediately. If that sequencing ever slips,
ownership enforcement moves ahead of B-01.

### 5.2 Impact Dashboard foundation — loses on **audience and dependency**

Genuinely valuable, and the item most likely to matter for college applications and
district demonstrations.

**It loses because:**

- It depends on organization records (A-07), which need a **reconciliation decision**
  and manual data work before any organization-scoped figure is meaningful.
- Its correctness is the hardest to verify of any candidate: every figure needs checking
  against source records, and a wrong figure is *plausible* rather than obviously broken.
- It is entirely on the non-blocking side of launch readiness.
- Building it before the analytics foundation (B-08) would produce figures nobody has
  verified — which the specification prohibits, and which is worse than no dashboard,
  because a wrong figure presented to a district is worse than an absent one.

**It should be second or third**, not first.

### 5.3 User management system — loses on **not existing**

There is no endpoint that lists users. The milestone would be "build a list endpoint,
then build a screen over it" — and the screen's value is mostly the ability to reach
suspend, warn and unsuspend, which are already reachable from a report.

The genuine gap it closes is acting on somebody nobody has reported. That is real but
narrow, and it is a **subset of F-02** (the roster) for the administrative population,
which M1 delivers anyway.

### 5.4 Admin management system — loses on **being B-01**

This is the same thing as B-01, and it is blocked on F-01 and F-02 for the reason in
§3.3. It is the milestone immediately after M1.

---

## 6. Risks of this choice

Stated so the choice is auditable rather than merely argued.

| # | Risk | Mitigation |
|---|---|---|
| K-1 | The Explorer is owner-and-admin-facing; a reviewer may judge M1 as "no user-visible progress" | Accepted and stated. Pre-launch, the constraint is institutional confidence, not feature count |
| K-2 | Adding an export creates a new bulk-disclosure path | Export is registered as a sensitive action with step-up; display constraints apply to export; privacy review is mandatory on the phase |
| K-3 | An unindexed filter causes a full scan and a lock on a single-process system | Every offered filter must be index-supported, asserted by query-plan test. A filter without an index is not offered |
| K-4 | Free-text search over structural detail exposes more than intended | Search is restricted to structural detail; the trail contains no bodies, notes or credentials by construction |
| K-5 | The Explorer makes administrator activity visible and may read as surveillance | The roster's evidence-read count must be labelled as a signal with its window, not as an accusation. UX review is mandatory |
| K-6 | Four remediation commits before the feature may look like scope creep | They are stated as part of the milestone, with reasons. Three fix machinery M1 depends on; one is a live regression |

---

## 7. Definition of done for M1

M1 is complete when **all** of the following hold, each with evidence.

**Remediation**

- [ ] `ACCOUNT_SUSPENDED` is visible to the notification coverage guard, and the guard
      derives its subject set from the registry rather than from a source scan.
- [ ] A non-dedupe error whose message contains the constraint substring rolls back a
      suspension, asserted by induced failure.
- [ ] All 13 identified guards assert a non-empty subject set; the step-up guard asserts
      a non-empty **call-site** count.
- [ ] All 5 identified exemption lists fail when stale.

**Feature**

- [ ] The Explorer refuses student, organizer, partner and unauthenticated; permits
      administrator and owner.
- [ ] Every filter is validated against a closed set and refused with its legal values.
- [ ] Every offered filter is index-supported, proven by query plan.
- [ ] A departed actor's entries survive and render from a fallback.
- [ ] Counts are whole-filtered-set, not page.
- [ ] The retention horizon is displayed.
- [ ] Export requires step-up, the grant is spent in the handler's transaction, and
      replay is refused.
- [ ] Export contains no message body, case note or credential.
- [ ] Viewing writes no audit record.
- [ ] The roster shows grants, withholdings and evidence-read counts, and matches the
      kernel exhaustively.
- [ ] Owners appear on the roster with controls **absent**, not disabled.

**Verification**

- [ ] Four gates pass in order, output observed.
- [ ] Every new guard observed failing against an introduced violation.
- [ ] Exercised in a running instance; observation recorded.
- [ ] Appendices A, B, D and E updated in the same commits.

**Sign-off**

- [ ] Security review (L2) — the new gate, the step-up pairing, the disclosure surface.
- [ ] Database review (L3) — index selection against the filter set.
- [ ] Privacy review — searchable columns and export contents.
- [ ] Accessibility review — the data-dense table and its empty states.
- [ ] Code review (L1) — Definition of Done in full.

---

## 8. What happens after M1

Not a commitment. Recorded so the milestone is not chosen in isolation.

| Next | Item | Trigger |
|---|---|---|
| M2 | B-01 → B-02 (administrator management, then ownership enforcement) | M1 complete. **Must be treated as one unit**; the gap between them is the only window in which promotion exists without the ownership prohibitions |
| M3 | R-05 → A-02 (retention reconciliation) | Owner decision on Q-05. **Blocks launch** |
| Parallel | A-07 → B-08 (organizations, analytics foundation) | Independent of the administrative stream; can start any time |

---

## 9. Recommendation

**Approve M1 as scoped in §4.** It has the highest security impact of any unblocked
item, the lowest migration risk of any candidate, the clearest independent verification,
and it sits at the head of the longest dependency chain.

Its weakest dimension is user-visible value, and that is the right dimension to be
weakest on for a pre-launch platform whose blocking problem is that its accountability
claims cannot currently be demonstrated.

**One condition on approval.** M2 (administrator management → ownership enforcement)
should be treated as a single unit when it is scheduled. Shipping promotion without the
ownership prohibitions immediately behind it opens a window this decision is explicitly
relying on being short.
