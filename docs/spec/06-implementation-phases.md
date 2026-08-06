# Volume VI — The Implementation Programme

**Status:** Normative
**Scope:** The ordered programme that closes the gap between the current system and this
specification. Specialist agent assignments, per-phase requirements, verification gates.

**Binds:** Volumes I–V, all appendices.

---

## 6.1 How this volume is used

### 6.1.1 Purpose

Volumes I–V specify the target. This volume specifies the order, the division of labour,
and the gates. It is the entry point for any session that is about to change code.

### 6.1.2 Procedure for executing a phase

1. Read the phase in full.
2. Read every section it cites. The citations are exhaustive: a phase does not depend on a
   requirement it does not cite.
3. Confirm the prerequisites. A phase whose prerequisites are unmet MUST NOT begin; the
   correct action is to close the prerequisite.
4. Execute the specialist assignments in the stated order. Where an order is stated it is
   load-bearing.
5. Satisfy the acceptance checklist item by item, with evidence.
6. Pass the verification gates in order.
7. Obtain the sign-offs.

**Requirement.** A phase MUST NOT be partially merged unless it declares stages. Where it
declares stages, each stage MUST be independently shippable and independently revertible.

### 6.1.3 Phase depth

Phases vary in specified depth in proportion to their risk, not their size. A phase
touching authorization, evidence or ownership carries more specification than a phase
adding a read-only surface, because the cost of getting it wrong differs by orders of
magnitude. Where a phase's specification is short, the brevity is a statement that the
phase is well-constrained by the volumes it cites.

---

## 6.2 The specialist agent model

### 6.2.1 Purpose

Work on this platform is performed by a single human owner and a set of coding agents.
This section specifies the specialist roles, so that a phase's review is a set of distinct
perspectives rather than one pass repeated.

### 6.2.2 Why specialisation rather than one general pass

A single reviewing pass, however careful, has one failure mode: it evaluates the change
against the concerns the reviewer happens to be holding. The defects this repository has
actually shipped were each invisible from the perspective that produced them and obvious
from another:

| Realised defect | Invisible to | Obvious to |
|---|---|---|
| An interface calling API methods that were never written | The frontend author, who was reading the view | A contract reviewer comparing calls to definitions |
| A guard listing two of three enforcement points | The security author, who enumerated what they knew | A reviewer applying P-3 |
| A route parameter shadowing a literal path | The backend author, who tested the new route | A reviewer reading the whole route table |
| A chart caption describing hours over a count of people | The data author | An accessibility reviewer, for whom the caption is the only content |
| An outcome in a taxonomy that performed nothing | Everyone reading the moderation code | A reviewer tracing each outcome to an act |

**Requirement.** A phase MUST be reviewed by every specialist it assigns, and each
specialist MUST review against **its own** concern list rather than re-reviewing the whole
change generally.

### 6.2.3 The specialist roster

| # | Specialist | Owns | Never owns |
|---|---|---|---|
| SP-01 | **Planning** | Decomposition, sequencing, prerequisite verification, scope discipline | Technical design |
| SP-02 | **Architecture** | Whether the change fits the model; whether it introduces a parallel system | Implementation detail |
| SP-03 | **Database** | Schema shape, constraints, indexes, query cost, portability | Migration execution safety |
| SP-04 | **Migrations** | Idempotency, guards, rollback, ordering, checksum integrity | Schema design |
| SP-05 | **Backend** | Handlers, services, transactions, validation, error classes | Authorization correctness |
| SP-06 | **API design** | Contracts, status codes, error codes, idempotency, versioning | Handler internals |
| SP-07 | **Frontend** | Components, state, data flow, code splitting | Visual design |
| SP-08 | **UI** | Layout, hierarchy, typography, density, token discipline | Interaction semantics |
| SP-09 | **UX** | Flows, copy, failure states, disclosure, comprehension | Aesthetics |
| SP-10 | **Accessibility** | Semantics, keyboard, focus, announcements, contrast, non-visual equivalents | General correctness |
| SP-11 | **Security review** | Authorization, authentication, secrets, injection, disclosure | Threat enumeration |
| SP-12 | **Threat model** | New adversary paths, control adequacy, residual risk | Implementation |
| SP-13 | **Privacy review** | What is collected, stored, disclosed, retained, exported | Security controls |
| SP-14 | **Legal review** | Consistency with published documents; new obligations | Privacy mechanics |
| SP-15 | **Testing** | Coverage against consequence, guard derivation, fixture hygiene, failing-first discipline | Feature correctness |
| SP-16 | **Performance** | Budgets, query counts, payload sizes, render cost | Correctness |
| SP-17 | **Observability** | Signals, alerts, diagnostic coverage, log hygiene | Infrastructure |
| SP-18 | **Documentation** | Headers, appendices, changelog, runbooks | Code |
| SP-19 | **Code review** | The Definition of Done, in full, as the final gate | Anything a specialist above owns |
| SP-20 | **Release engineering** | Gates, versioning, deployment, rollback rehearsal | Feature work |

### 6.2.4 Universal specialist obligations

**Requirement.** Every specialist MUST, in its report:

1. State what it examined, specifically.
2. State what it found, or that it found nothing.
3. State what it did **not** examine, so a gap is visible.
4. Name any assumption it relied on.
5. Give a verdict: pass, pass-with-findings, or fail.

**Requirement.** A specialist MUST NOT pass a change it did not examine. Absence of a
finding is only meaningful if the examination happened.

**Requirement.** A finding MUST include a reproduction or a citation. A finding stated as
an opinion cannot be verified or dismissed.

### 6.2.5 Mandatory assignments by change class

Independent of phase, the following are mandatory.

| Change touches | Mandatory specialists |
|---|---|
| Authentication, authorization, secrets | SP-11, SP-12, SP-19 |
| Schema | SP-03, SP-04, SP-19 |
| Any trail | SP-11, SP-13, SP-18 |
| Personal data flow | SP-13, SP-14 |
| A new endpoint | SP-06, SP-11, SP-15 |
| A new screen | SP-09, SP-10, SP-08 |
| A failure state | SP-09, SP-10 |
| A migration | SP-04, SP-03, SP-20 |
| A published claim | SP-14 |
| A derived figure | SP-03, SP-13, SP-16 |
| Anything | SP-15, SP-19 |

**Requirement.** SP-15 and SP-19 are mandatory on every change without exception.

### 6.2.6 Sign-off

| Level | Required for | Signer |
|---|---|---|
| L1 | Any merge | SP-19 |
| L2 | Authorization, authentication, secrets, trails | SP-11 plus SP-19 |
| L3 | Schema change | SP-04 plus SP-19 |
| L4 | Destructive migration; any change to the ownership model; any relaxation of an invariant | Platform owner, in writing |
| L5 | Launch, or launch to a new institution | Platform owner, per Volume V §5.13.4 |

---

## 6.3 Phase index

| # | Phase | Closes | Risk | Prerequisites |
|---|---|---|---|---|
| P-00 | Guard and derivation hardening | Latent guard gaps | Low | None |
| P-01 | Audit Log Explorer | NB-1 | Medium | P-00 |
| P-02 | Administrator roster | NB-2 (part) | Medium | P-01 |
| P-03 | Administrator promotion and revocation | PB-1 to PB-3 | **High** | P-02 |
| P-04 | Ownership immutability enforcement | INV-008, INV-009 | **High** | P-03 |
| P-05 | Pending administrator invitations | §4.3 | **High** | P-04 |
| P-06 | Suspension normalisation sweep | NB-4 | Low | P-00 |
| P-07 | Remaining moderation actions | NB-3 | Medium | P-04 |
| P-08 | Developer Mode shell and read-only tools | §4.5 (part) | Medium | P-04 |
| P-09 | Feature flags and maintenance mode | §4.13, §4.14 | Medium | P-08 |
| P-10 | Developer Mode mutating tools and emergency controls | §4.5 (rest), §4.15 | **High** | P-09 |
| P-11 | Organization records | NB-6 | Medium | None |
| P-12 | Analytics foundation | §4.8 | Medium | P-11 |
| P-13 | Community Impact Dashboard | NB-7 | Medium | P-12 |
| P-14 | Public impact pages | §4.11 | Medium | P-13 |
| P-15 | Impersonation | NB-5 | **High** | P-10 |
| P-16 | Multi-tenancy preparation | §4.12 (schema only) | **High** | P-11 |
| P-17 | Database engine migration | §5.9 | **Highest** | Measured trigger |

**Requirement.** P-01 precedes P-02 and P-03. Administrator management MUST NOT ship before
the surface that makes its records readable, because promotion and revocation write audit
entries whose only purpose is being read.

**Requirement.** P-04 precedes P-05, P-07, P-08. Ownership immutability MUST be enforced
before any surface is built that could otherwise be used to alter it.

---

## 6.4 Phase P-00 — Guard and derivation hardening

### 6.4.1 Objective

Close every latent gap in the existing static guards by applying P-3 to each, so that
subsequent phases cannot introduce a violation that an enumerated guard would miss.

**RATIONALE for placing this first.** Three realised defects on this platform were guards
that covered what their author remembered. Every subsequent phase adds subjects to those
guards. Hardening them first means later phases are protected by construction rather than
by the author of each remembering.

### 6.4.2 Prerequisites

None. This phase changes no production behaviour.

### 6.4.3 Scope

| # | Item | Requirement |
|---|---|---|
| 00-1 | Audit every static guard for enumerated subject sets | Volume I §1.5.4 |
| 00-2 | Convert each to derivation, or add a completeness assertion | P-3 |
| 00-3 | Add a staleness assertion to every exemption list | P-3 |
| 00-4 | Verify each guard fails against an introduced violation, and record the verification | Volume I §1.5.4 |
| 00-5 | Add the guard required by §4.1.3: the owner role appears in no writable enumeration | Advance work for P-04 |
| 00-6 | Add the guard required by §4.5.3: every Developer Mode route applies the identity check | Advance work for P-08 |
| 00-7 | Add the guard required by §2.4.7: every gated route's capability has a plain-language name | Closes a live gap |
| 00-8 | Add the configuration inventory test required by §5.3.5 | Closes a live gap |

**Requirement.** 00-5 and 00-6 MUST be written now, against subjects that do not yet
exist, and MUST assert their subject set is non-empty **or** explicitly tolerate emptiness
with a comment stating when it will become non-empty.

**RATIONALE.** A guard written with the feature is a guard written by the person motivated
to ship the feature. A guard written first constrains that person.

### 6.4.4 Architecture, migrations, backend, frontend, API

None. Test-only.

### 6.4.5 Tests

The phase is tests. Verification is that each new or converted guard has been observed
failing.

### 6.4.6 Documentation

- Each guard's header states what it prevents and the failure mode.
- Volume I §1.5.4's verification record is added per guard.

### 6.4.7 Rollout and rollback

Rollout: merge. Rollback: revert. No data, no behaviour, no user impact.

### 6.4.8 Risk analysis

| # | Risk | Mitigation |
|---|---|---|
| R-00.1 | A converted guard is weaker than the enumerated one it replaced | Each conversion MUST be verified to still fail on the violations the original caught, before merging |
| R-00.2 | A derived guard's subject set is empty, passing vacuously | Non-emptiness assertion required |
| R-00.3 | Guard churn produces line-pin updates without re-reading | Volume I §1.11; each pin update records the re-read's conclusion |

### 6.4.9 Threat analysis

No new adversary path. The phase reduces T-23 (silent authorization regression).

### 6.4.10 Accessibility review

Not applicable. No user-facing surface.

### 6.4.11 Specialist assignments

| Specialist | Why | Reviews | Deliverable | Verification |
|---|---|---|---|---|
| SP-15 Testing | Owns the guard estate | Every guard's subject derivation, non-emptiness, exemption staleness, and observed failure | Guard inventory with per-guard verification record | Every guard observed failing |
| SP-11 Security | Guards enforce authorization invariants | That no conversion weakened coverage | Confirmation per converted guard | Original violations still caught |
| SP-19 Code review | Definition of Done | The whole change | Verdict | D-1 to D-20 |

### 6.4.12 Acceptance checklist

- [ ] Every static guard derives its subject set or carries a completeness assertion.
- [ ] Every guard asserts its subject set is non-empty, or documents tolerated emptiness.
- [ ] Every exemption list fails when stale.
- [ ] Every guard has a recorded observation of failing against a violation.
- [ ] Guards 00-5, 00-6, 00-7, 00-8 exist.
- [ ] Four gates pass in order.

### 6.4.13 Verification gates

| Gate | Criterion |
|---|---|
| G1 | Four gates pass. |
| G2 | Guard count increased; no guard's coverage decreased. |
| G3 | Every verification record present. |
| G4 | SP-19 sign-off (L1). |

---

## 6.5 Phase P-01 — Audit Log Explorer

### 6.5.1 Objective

Make the operational audit trail readable, closing NB-1.

**RATIONALE.** The trail is written on every administrative action and readable by nothing.
The published administrative responsibilities policy's accountability claims rest on a
record no administrator can read, which makes those claims presently unverifiable — by an
administrator, by the institution, or by a parent.

### 6.5.2 Prerequisites

P-00 complete.

### 6.5.3 Architecture changes

None structural. One read surface over an existing table, plus indexes.

### 6.5.4 Migrations

| # | Change | Path | Guards |
|---|---|---|---|
| 01-M1 | Indexes supporting every offered filter | Additive | Idempotent; no data change |

**Requirement.** Index selection MUST be driven by the filter set in §4.4.3 AE-3. A filter
without an index MUST NOT be offered (§4.4.5).

### 6.5.5 Backend

| # | Requirement | Cites |
|---|---|---|
| 01-B1 | A paginated, filtered read endpoint gated on the audit capability | §4.4.3 AE-1, AE-2 |
| 01-B2 | Every filter validated against a closed set, refused with legal values | Volume I §1.7.3 |
| 01-B3 | Outer joins for actor and subject with fallback naming | §4.4.3 AE-7 |
| 01-B4 | Whole-filtered-set counts | AE-13 |
| 01-B5 | Retention horizon reported | AE-12 |
| 01-B6 | An export endpoint, registered as a sensitive action | AE-10, Volume II §2.7 |
| 01-B7 | No read logging for this surface | AE-11, Volume II §2.9.6 |

**Requirement on 01-B6.** Export MUST be added to the sensitive-action registry, MUST have
a gate, and MUST have a spend inside its handler's transaction (INV-006). The pairing guard
will fail otherwise, which is the intended behaviour.

### 6.5.6 Frontend

| # | Requirement |
|---|---|
| 01-F1 | A filterable, paginated table reachable from the administrative surface |
| 01-F2 | Action identifiers rendered as labels; unrecognised identifiers render legibly |
| 01-F3 | Links to subject-scoped histories where present |
| 01-F4 | The retention horizon displayed as a statement, not a footnote |
| 01-F5 | Export behind a step-up flow with the disclosure that it is a bulk export |

### 6.5.7 API

Contracts per Appendix B. Codes: `invalid_filter`, `reauth_required`, `forbidden`.

### 6.5.8 Tests

| # | Test |
|---|---|
| 01-T1 | Refused for student, organizer, partner, and unauthenticated |
| 01-T2 | Permitted for administrator and owner |
| 01-T3 | Every filter validated; each invalid value refused with its legal set |
| 01-T4 | Unbounded response impossible |
| 01-T5 | A departed actor renders from fallback; the entry is not lost |
| 01-T6 | An unrecognised action identifier renders |
| 01-T7 | Counts are whole-set, not page |
| 01-T8 | Export requires step-up; the grant is spent; a replay is refused |
| 01-T9 | Viewing writes no audit entry |
| 01-T10 | Export contains no message body, case note or credential |
| 01-T11 | Every offered filter uses an index (query plan assertion) |

### 6.5.9 Documentation

Appendix B gains the endpoints. Appendix D gains the export action. A runbook section
describes using the explorer during an incident.

### 6.5.10 Rollout and rollback

Rollout: single merge; indexes apply at boot. Rollback: revert; indexes may remain
harmlessly, and the revert MUST state that.

### 6.5.11 Risk analysis

| # | Risk | Mitigation |
|---|---|---|
| R-01.1 | An unindexed filter causes a full scan and a lock on a single-process system | AE-5 index requirement; query-plan test |
| R-01.2 | Export becomes a bulk disclosure path | Step-up; display constraints apply to export; SP-13 review |
| R-01.3 | Free-text search over structural detail exposes more than intended | AEP-2; SP-13 verifies the searchable column set |
| R-01.4 | Retention horizon absent, so missing history reads as no activity | AE-12; test |

### 6.5.12 Threat analysis

| # | Threat | Control | Residual |
|---|---|---|---|
| T-01.1 | An administrator enumerates colleagues' activity for retaliation | The trail contains no content; the roster shows evidence-read counts (P-02) which is the countervailing control | Present; evidential |
| T-01.2 | Export exfiltrates the trail | Step-up; export is itself audited | An administrator with a valid grant; recorded |
| T-01.3 | Filter injection | Closed-set validation | None material |

### 6.5.13 Accessibility review

| # | Requirement |
|---|---|
| 01-A1 | The table has proper header semantics and a caption stating what is listed and the active filter |
| 01-A2 | Filter controls are labelled; the applied-filter state is announced on change |
| 01-A3 | Pagination announces position and total |
| 01-A4 | Timestamps are readable text, not relative-only |
| 01-A5 | Numeric columns use tabular figures |
| 01-A6 | An empty result states which filter produced it, so the reader is not stranded |

### 6.5.14 Specialist assignments

| Specialist | Why | Reviews | Deliverable | Verification | Sign-off |
|---|---|---|---|---|---|
| SP-01 Planning | First phase with user-facing scope | Prerequisite completion; scope boundary against P-02 | Confirmed scope | P-00 closed | — |
| SP-03 Database | Filter performance on a growing table | Index selection against the filter set; query plans | Index rationale per filter | Every filter indexed | L3 |
| SP-06 API design | New contracts | Pagination shape, error codes, export semantics | Appendix B entries | Contracts match implementation | — |
| SP-05 Backend | Handlers | Validation, joins, counts | — | 01-T3 to 01-T7 | — |
| SP-11 Security | Reads a trail; adds an export | Gate, step-up pairing, disclosure surface | Security note | 01-T1, 01-T2, 01-T8 | L2 |
| SP-13 Privacy | Bulk personal-data surface | Searchable columns, export contents, absence of content fields | Privacy note | 01-T10 | — |
| SP-10 Accessibility | New data-dense screen | §6.5.13 items | Accessibility report | 01-A1 to 01-A6 | — |
| SP-09 UX | The reader is under pressure during an incident | Empty states, filter comprehension, horizon statement | Copy review | 01-A6 | — |
| SP-16 Performance | Budgets | §4.4.5 budgets | Measurements | Budgets met | — |
| SP-15 Testing | Mandatory | Coverage against §6.5.8 | Test report | All present | — |
| SP-18 Documentation | Appendices | B, D, runbook | Diffs | Present in same commit | — |
| SP-19 Code review | Mandatory | Definition of Done | Verdict | D-1 to D-20 | L1 |

### 6.5.15 Acceptance checklist

- [ ] Every §6.5.5 and §6.5.6 requirement satisfied.
- [ ] Every §6.5.8 test present and passing.
- [ ] Every §6.5.13 accessibility item satisfied.
- [ ] Appendices B and D updated in the same commit.
- [ ] Every filter index-supported, verified by query plan.
- [ ] Budgets measured and recorded.
- [ ] Four gates pass in order.
- [ ] L1, L2, L3 sign-offs obtained.

### 6.5.16 Verification gates

| Gate | Criterion |
|---|---|
| G1 | Four gates pass. |
| G2 | Authorization tests pass for all five roles. |
| G3 | Step-up pairing guard passes for the export action. |
| G4 | Query plans show index use for every filter. |
| G5 | SP-13 confirms no content field is reachable. |
| G6 | Exercised in a running instance; observation recorded. |

---

## 6.6 Phase P-02 — Administrator roster

### 6.6.1 Objective

Make the set of principals holding moderation authority visible, with their effective
capabilities and their evidence-read activity.

**RATIONALE.** Nobody can presently answer "who holds authority to read students' private
messages". That is the question the roster exists to answer, and the evidence-read count is
the single most useful misuse signal available.

### 6.6.2 Prerequisites

P-01 complete. The roster links to the explorer.

### 6.6.3 Architecture changes

None. A derived read surface.

### 6.6.4 Migrations

| # | Change | Path |
|---|---|---|
| 02-M1 | Index supporting per-actor audit aggregation | Additive |

### 6.6.5 Backend

| # | Requirement | Cites |
|---|---|---|
| 02-B1 | A roster endpoint gated on the owner-only administration capability | §4.2.5 |
| 02-B2 | Per administrator: identity, promotion metadata where recorded, last sign-in, effective capabilities with source attribution, grants, withholdings | §4.2.5 |
| 02-B3 | Decision and evidence-read counts within a stated window | §4.2.5 |
| 02-B4 | Owners included, marked, with no mutation affordance | §4.2.5 |
| 02-B5 | Capabilities computed by the kernel, never reimplemented | §4.5.5.2 rationale |

**Requirement on 02-B2.** Promotion metadata does not exist for administrators promoted
before P-03. The roster MUST render its absence explicitly — "promoted before this was
recorded" — rather than showing a blank, which reads as an error.

### 6.6.6 Frontend

| # | Requirement |
|---|---|
| 02-F1 | A roster table with capability detail expandable per administrator |
| 02-F2 | Owners marked, controls **absent** not disabled |
| 02-F3 | Evidence-read counts presented beside decision counts, so the ratio is legible |
| 02-F4 | Links to the explorer filtered to that actor |

**Requirement on 02-F3.** The count MUST NOT be presented as an accusation. It is a
signal, and its label MUST state the window and that reading evidence is a legitimate,
logged act.

### 6.6.7 Tests

| # | Test |
|---|---|
| 02-T1 | Refused for administrator, organizer, student, unauthenticated |
| 02-T2 | Permitted for owner |
| 02-T3 | Effective capabilities match the kernel exhaustively, for a granted and a withheld case |
| 02-T4 | Owners appear marked with no mutation affordance in the response |
| 02-T5 | Absent promotion metadata renders explanatorily |
| 02-T6 | Counts are window-scoped and the window is reported |

### 6.6.8 Rollout, rollback, risk

Rollout: merge. Rollback: revert; index harmless.

| # | Risk | Mitigation |
|---|---|---|
| R-02.1 | Evidence-read counts read as accusation, discouraging legitimate reads | 02-F3 labelling; SP-09 review |
| R-02.2 | Capability display diverges from the kernel | 02-B5; 02-T3 exhaustive |
| R-02.3 | Aggregation is expensive as the trail grows | 02-M1; SP-16 measurement |

### 6.6.9 Threat analysis

| # | Threat | Control | Residual |
|---|---|---|---|
| T-02.1 | Roster used to identify a target for social engineering | Owner-only | Present; the roster is the smaller risk than the absence of oversight |
| T-02.2 | Displayed capabilities understate reach, giving false assurance | Grants and withholdings shown; kernel-computed | None material |

### 6.6.10 Accessibility

| # | Requirement |
|---|---|
| 02-A1 | Expandable capability detail is a disclosure with correct state semantics |
| 02-A2 | The owner marking is text, not an icon alone |
| 02-A3 | Count columns use tabular figures with unit-bearing headers |
| 02-A4 | Absent controls do not leave an empty focusable cell |

### 6.6.11 Specialist assignments

| Specialist | Why | Reviews | Verification | Sign-off |
|---|---|---|---|---|
| SP-11 Security | Enumerates privileged principals | Gate; that the surface adds no mutation | 02-T1, 02-T2, 02-T4 | L2 |
| SP-13 Privacy | Displays administrator activity | Window scoping; that no case detail appears | 02-T6 | — |
| SP-03 Database | Aggregation cost | Index; plan | Budget met | L3 |
| SP-09 UX | The count is easily misread | Labelling of evidence counts; absent-metadata copy | 02-T5 | — |
| SP-10 Accessibility | New table with disclosure | §6.6.10 | 02-A1 to 02-A4 | — |
| SP-15, SP-18, SP-19 | Mandatory | — | — | L1 |

### 6.6.12 Acceptance checklist and gates

- [ ] Every §6.6.5 and §6.6.6 requirement satisfied.
- [ ] Every §6.6.7 test present.
- [ ] Capability display verified against the kernel exhaustively.
- [ ] Owners marked with controls absent.
- [ ] Four gates pass; L1 and L2 obtained.

---

## 6.7 Phase P-03 — Administrator promotion and revocation

### 6.7.1 Objective

Allow ownership to delegate and withdraw moderation authority through the application,
recorded.

**Risk: HIGH.** This phase creates the mechanism by which a principal gains authority over
every student's private messages.

### 6.7.2 Prerequisites

P-01 and P-02 complete. Promotion writes records that must be readable, and revocation
must be verifiable against the roster.

### 6.7.3 Architecture changes

Two new sensitive actions. The registry and its guards (INV-006) apply.

### 6.7.4 Migrations

| # | Change | Path | Notes |
|---|---|---|---|
| 03-M1 | Promotion metadata columns: promoted at, promoted by, reason | Additive, nullable | No backfill. Existing administrators have none, and inventing it would be a fabricated record. |

**Requirement.** No backfill. §4.2.5 requires the absence to render explanatorily.

### 6.7.5 Backend

| # | Requirement | Cites |
|---|---|---|
| 03-B1 | Promotion gated on the owner-only administration capability | §4.2.6 PR-1 |
| 03-B2 | Target validation: existing, active, verified, not already administrator, not owner | PR-2, PR-3 |
| 03-B3 | Reason required, minimum length | PR-4 |
| 03-B4 | Step-up required; registered as a sensitive action; spend inside the transaction | PR-5, INV-006 |
| 03-B5 | Role change, metadata, audit, token version increment, notice: one transaction | PR-6, PR-8 |
| 03-B6 | Notice states the reach including reported private messages | PR-7 |
| 03-B7 | Revocation gated identically; refuses owner targets | RV-1, RV-2 |
| 03-B8 | Revocation revokes every grant in the same transaction | RV-6 |
| 03-B9 | Revocation unassigns reports and releases appeals, recorded | RV-7, RV-8 |
| 03-B10 | Revocation retains every decision and history entry | RV-9 |
| 03-B11 | Revocation increments token version and notifies | RV-5, RV-10 |

**Requirement.** Every refusal MUST be answered before the step-up grant is spent (Volume
II §2.7.6). A promotion refused for an invalid target MUST NOT cost the owner a
verification.

### 6.7.6 Frontend

| # | Requirement |
|---|---|
| 03-F1 | Promotion initiated from the roster, with a target search that discloses nothing about non-matching accounts |
| 03-F2 | A confirmation stating exactly what the target will gain, naming private-message reach |
| 03-F3 | Reason composer stating that the reason is recorded permanently |
| 03-F4 | Revocation confirmation enumerating what will happen: sessions ended, grants revoked, assignments released, records retained |
| 03-F5 | Step-up flow inline, preserving the composed reason on refusal |

**Requirement on 03-F4.** The enumeration is not decoration. An owner revoking authority
under pressure needs to know that assignments will be released, because the released work
is then unworked and needs reassignment.

### 6.7.7 Tests

| # | Test |
|---|---|
| 03-T1 | An administrator cannot promote — asserted for a role-holder and a grant-holder |
| 03-T2 | Promotion refused for owner, non-existent, unverified, inactive, already-administrator |
| 03-T3 | Promotion requires step-up; grant single-use; replay refused |
| 03-T4 | Every refusal precedes expenditure, asserted per refusal branch |
| 03-T5 | Promotion is atomic: an induced notice failure rolls back the role change |
| 03-T6 | Notice content names private-message reach |
| 03-T7 | Revocation revokes grants, asserted with a granted capability present |
| 03-T8 | Revocation unassigns reports and releases appeals, both recorded |
| 03-T9 | Revocation retains decisions and history entries |
| 03-T10 | Revocation ends sessions, asserted with a live session |
| 03-T11 | Revocation refused for an owner target |
| 03-T12 | Both actions appear in the explorer with actor, subject and reason |

**Requirement on 03-T5.** Atomicity MUST be asserted by inducing a failure, not by reading
the code. This is the test class Volume I §1.2.5 exists for.

### 6.7.8 Rollout

Two stages, independently shippable:

| Stage | Content | Why staged |
|---|---|---|
| 03-S1 | Revocation | Ships first. Revocation reduces authority; promotion increases it. If the phase must stop midway, the safe half is the one that shipped. |
| 03-S2 | Promotion | Ships second, after 03-S1 has been exercised. |

**RATIONALE.** Ordering the risk-reducing half first means a partial phase leaves the
platform safer, not less safe.

### 6.7.9 Rollback

| Stage | Rollback |
|---|---|
| 03-S1 | Revert. Already-revoked administrators stay revoked; that is correct and MUST be stated. |
| 03-S2 | Revert. Already-promoted administrators stay promoted. Metadata columns remain, harmlessly. |

**Requirement.** Neither rollback may attempt to reverse role changes already made. A
rollback that demotes administrators promoted through the feature would remove authority
somebody is relying on, without a decision.

### 6.7.10 Risk analysis

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R-03.1 | Promotion reachable by an administrator | Critical | Super-only capability; 03-T1 asserts for both role and grant |
| R-03.2 | Revocation leaves grants, retaining reach | High | RV-6; 03-T7 |
| R-03.3 | Revocation leaves assignments, silently unworked | Medium | RV-7, RV-8; 03-T8 |
| R-03.4 | Revocation deletes decisions, rewriting the moderation record | Critical | RV-9; 03-T9 |
| R-03.5 | Promotion partially applied | High | Single transaction; 03-T5 by induced failure |
| R-03.6 | A promoted administrator is unaware of the reach | Medium | PR-7; 03-T6 |
| R-03.7 | Target search enumerates accounts | Medium | 03-F1; uniform responses per Volume II §2.2.4 |

### 6.7.11 Threat analysis

| # | Threat | Control | Residual |
|---|---|---|---|
| T-03.1 | Privilege escalation to administrator | Super-only; step-up; audited | An owner compromise, which is unbounded regardless and covered by Volume II §2.11.5 |
| T-03.2 | An owner promotes under coercion | Step-up does not defend against a present coercer | Recorded; the roster and explorer make it visible |
| T-03.3 | Revocation used to remove an administrator who is investigating the revoker | RV-9 retains their decisions; the explorer records the revocation | Present; evidential. Documented as a known limitation of a two-owner model |

**Requirement.** T-03.3 MUST be recorded in the launch readiness residual risks. It is not
mitigable within this ownership model and pretending otherwise would be dishonest.

### 6.7.12 Accessibility

| # | Requirement |
|---|---|
| 03-A1 | Confirmation dialogs trap focus, are keyboard-dismissible, restore focus |
| 03-A2 | The consequence enumeration is a list, semantically |
| 03-A3 | The step-up flow announces its purpose and preserves the reason on refusal |
| 03-A4 | Destructive confirmation is not conveyed by colour alone |
| 03-A5 | Target search results are announced as a count on change |

### 6.7.13 Specialist assignments

| Specialist | Why | Reviews | Deliverable | Verification | Sign-off |
|---|---|---|---|---|---|
| SP-01 Planning | Staging decision | That 03-S1 precedes 03-S2 and each is shippable | Stage plan | Stages independently revertible | — |
| SP-11 Security | Creates the highest-privilege path short of ownership | Capability class; step-up pairing; refusal ordering; transaction boundaries | Security assessment | 03-T1 to 03-T4, 03-T10, 03-T11 | **L2** |
| SP-12 Threat model | New escalation path | Adversary paths to administrator; coercion; retaliatory revocation | Threat delta with residuals | T-03.1 to T-03.3 recorded | — |
| SP-05 Backend | Transactional integrity | Atomicity; grant revocation; assignment release | — | 03-T5, 03-T7, 03-T8 | — |
| SP-04 Migrations | Additive columns, no backfill | Idempotency; that no backfill occurs | Migration review | Absence renders explanatorily | **L3** |
| SP-06 API design | Two new endpoints | Contracts; error codes; idempotency | Appendix B | Contracts match | — |
| SP-13 Privacy | Notice content; target search | Notice discloses appropriately; search does not enumerate | Privacy note | 03-F1, 03-T6 | — |
| SP-14 Legal | The notice creates an expectation | Consistency with the administrative responsibilities policy | Legal note | Policy and notice agree | — |
| SP-09 UX | The confirmation must be understood under pressure | Consequence enumeration; reason preservation | Copy review | 03-F4, 03-F5 | — |
| SP-10 Accessibility | Dialogs and step-up | §6.7.12 | Report | 03-A1 to 03-A5 | — |
| SP-17 Observability | Both acts must be visible | That both appear in the explorer with full attribution | — | 03-T12 | — |
| SP-15, SP-18, SP-19 | Mandatory | — | — | — | L1 |
| Platform owner | Ownership model adjacent | The whole phase | Written approval | — | **L4** |

### 6.7.14 Acceptance checklist

- [ ] Every §6.7.5 and §6.7.6 requirement satisfied.
- [ ] Every §6.7.7 test present; 03-T5 by induced failure.
- [ ] Both actions in the sensitive-action registry, gated and spent.
- [ ] Pairing guard passes.
- [ ] Every refusal precedes expenditure.
- [ ] No backfill performed.
- [ ] Appendices A, B, D updated.
- [ ] T-03.3 recorded as a residual risk.
- [ ] Stages shipped in order, each exercised.
- [ ] L1, L2, L3, L4 obtained.

### 6.7.15 Verification gates

| Gate | Criterion |
|---|---|
| G1 | Four gates pass at each stage. |
| G2 | Six authorization guards pass. |
| G3 | Step-up pairing guard passes for both actions. |
| G4 | Atomicity verified by induced failure. |
| G5 | Revocation verified against a granted capability and a live session. |
| G6 | Both acts visible in the explorer. |
| G7 | Owner written approval recorded. |

---

## 6.8 Phase P-04 — Ownership immutability enforcement

### 6.8.1 Objective

Make INV-008 and INV-009 structurally true and build-enforced.

**Risk: HIGH.** The phase's failure mode is believing ownership is protected when it is
not.

### 6.8.2 Prerequisites

P-03 complete. Promotion and revocation are the paths most likely to be able to reach the
owner role, so they must exist before the prohibition is verified against them.

### 6.8.3 Scope

| # | Item | Cites |
|---|---|---|
| 04-1 | Boot-time owner count check, warning and non-fatal | §4.1.2 |
| 04-2 | Every prohibition IM-1 to IM-9 enforced by absence of mechanism | §4.1.3 |
| 04-3 | Static guard: owner role in no writable enumeration | §4.1.3 |
| 04-4 | Static guard: no endpoint declares role mutable | §4.1.3 |
| 04-5 | Refusal copy asserting no escalation path | §4.1.3 |
| 04-6 | Every edge case E-1 to E-15 tested | §4.1.5 |
| 04-7 | Unlink refuses removal of the last credential | E-7 |
| 04-8 | Withholding ignored for a wildcard principal | E-13 |
| 04-9 | Suspension target rules capability-based | Volume II §2.10.4 |

### 6.8.4 Migrations

None.

**Requirement.** No storage constraint on the owner count. §4.1.6 records why: a check
constraint requires a trigger on every account write, paid on every registration to
prevent an operation no code path performs.

### 6.8.5 Tests

Every edge case E-1 to E-15, individually, **with an owner as the actor** where applicable.

**Requirement.** E-2 (an owner suspending the other owner) and E-3 (an owner demoting
themselves) MUST be asserted with an owner principal. A test using an administrator
principal proves nothing: the administrator is refused by an ordinary rule, and the
wildcard case is the one that matters.

### 6.8.6 Rollout, rollback

Rollout: merge. Rollback: revert — but the revert removes protections, so it MUST be
treated as a change requiring L4.

### 6.8.7 Risk and threat analysis

| # | Risk | Mitigation |
|---|---|---|
| R-04.1 | A prohibition enforced by permission check rather than absence | SP-11 reviews each individually; a permission check passes for a wildcard holder |
| R-04.2 | Boot check made fatal | §4.1.2; test asserts the platform boots with a wrong count |
| R-04.3 | A refusal implies an escalation path | 04-5; SP-09 reviews every message |
| R-04.4 | Guard subject set empty, passing vacuously | P-00 non-emptiness requirement |

| # | Threat | Control | Residual |
|---|---|---|---|
| T-04.1 | Ownership seizure through the application | Absence of mechanism | Host access; break-glass, recorded |
| T-04.2 | Ownership destruction by an owner's error | IM-2, IM-4, IM-5 | An owner with host access |

### 6.8.8 Specialist assignments

| Specialist | Why | Reviews | Verification | Sign-off |
|---|---|---|---|---|
| SP-11 Security | The invariant is the platform's foundation | Each prohibition individually; whether enforcement is structural or a check | E-1 to E-15 with owner actors | **L2** |
| SP-12 Threat model | Seizure and destruction paths | Every path to the role, including migrations and scripts | T-04.1, T-04.2 recorded | — |
| SP-02 Architecture | Absence of mechanism is an architectural property | That no enumeration, contract or parameter admits the role | 04-3, 04-4 | — |
| SP-15 Testing | Edge cases | That every case is tested with the correct actor | All fifteen | — |
| SP-09 UX | Refusal copy | That no message implies escalation | 04-5 | — |
| SP-18, SP-19 | Mandatory | — | — | L1 |
| Platform owner | Ownership model | The whole phase | — | **L4** |

### 6.8.9 Acceptance checklist and gates

- [ ] Boot warns non-fatally on a count other than two; the platform boots.
- [ ] Every IM-1 to IM-9 enforced by absence, verified individually.
- [ ] Both guards present with non-empty subject sets.
- [ ] Every E-1 to E-15 tested, with owner actors where applicable.
- [ ] No refusal implies an escalation path.
- [ ] Four gates pass; L1, L2, L4 obtained.

---

## 6.9 Phase P-05 — Pending administrator invitations

### 6.9.1 Objective

Permit delegation to a person without an account, without creating one or accepting
consent for them.

**Risk: HIGH.** A live invitation is administrator authority awaiting collection.

### 6.9.2 Prerequisites

P-04 complete. Invitations must not be able to confer the owner role, which requires the
prohibition to be enforced first.

### 6.9.3 Migrations

| # | Change | Path |
|---|---|---|
| 05-M1 | Invitation table: address, role, inviter, reason, token hash, created, expires, state, accepted-by | Registry, additive |

**Requirement.** The token MUST be stored as a hash, never in plaintext. A table of live
invitation tokens is a table of administrator credentials.

**Requirement.** The address MUST be stored case-insensitively comparable, matching the
account uniqueness rule, so an invitation cannot be accepted by a case variant.

### 6.9.4 Backend

Per §4.3.4 IV-1 to IV-15. Every requirement is normative and each MUST have a test.

**Requirement.** IV-15 MUST be implemented even though it cannot currently trigger. The
check costs nothing and makes the property survive a future change to the ownership model.

### 6.9.5 Frontend

| # | Requirement |
|---|---|
| 05-F1 | Pending list per §4.3.4 IV-14 |
| 05-F2 | Creation form with reason, stating that the token is delivered and not shown |
| 05-F3 | Revocation with confirmation |
| 05-F4 | An acceptance surface reachable unauthenticated, leading through registration or sign-in, verification, and consent |
| 05-F5 | An expired or invalid token renders the uniform refusal, indistinguishable across causes |

### 6.9.6 Tests

Per §4.3.6, plus:

| # | Test |
|---|---|
| 05-T1 | An invitation confers nothing before acceptance, asserted by attempting privileged operations as the invited account |
| 05-T2 | The token is absent from every response, asserted by scanning the creation response |
| 05-T3 | Acceptance by a different verified address is refused |
| 05-T4 | Acceptance without consent is refused |
| 05-T5 | Acceptance is atomic; an induced notice failure rolls back the role assignment |
| 05-T6 | Every failure cause returns an identical response, asserted across four causes |
| 05-T7 | An owner's address cannot be invited |
| 05-T8 | A case-variant address cannot accept |
| 05-T9 | A second invitation replaces the first and records the replacement |

### 6.9.7 Rollout, rollback

Rollout: merge. Rollback: revert; pending invitations become unacceptable, which is safe.
The revert MUST state that pending invitations are voided and that invited parties should
be told.

### 6.9.8 Risk and threat analysis

| # | Risk | Mitigation |
|---|---|---|
| R-05.1 | Token retained by inviter, defeating address binding | IV-4; 05-T2 |
| R-05.2 | Token stored in plaintext | 05-M1 hashing |
| R-05.3 | Acceptance without consent, producing a forged acceptance record | IV-6; 05-T4 |
| R-05.4 | Case-variant acceptance | 05-M1 comparability; 05-T8 |
| R-05.5 | Enumeration of live invitations | IV per §4.3.5; 05-T6 |

| # | Threat | Control | Residual |
|---|---|---|---|
| T-05.1 | Intercepted mail confers authority | Address binding plus verification requirement | Mailbox compromise; the same exposure as password reset |
| T-05.2 | An owner invites themselves at a second address | Prevented by IV-12 only for known owner addresses; otherwise the owner already holds the wildcard so the invitation grants nothing new | None material |
| T-05.3 | Probing for live invitations | Uniform responses | Timing; out of scope for this threat class |

### 6.9.9 Accessibility

| # | Requirement |
|---|---|
| 05-A1 | The acceptance flow is completable by keyboard throughout, across three steps |
| 05-A2 | Each step announces progress and what remains |
| 05-A3 | The uniform refusal is announced and offers a next action |
| 05-A4 | Consent controls are individually labelled and not pre-checked |

**Requirement on 05-A4.** A pre-checked consent control is not consent, and its acceptance
record would be evidence of nothing.

### 6.9.10 Specialist assignments

| Specialist | Why | Reviews | Verification | Sign-off |
|---|---|---|---|---|
| SP-11 Security | Creates a credential-like artefact | Token generation, storage, delivery, single-use, binding | 05-T1 to 05-T3, 05-T6 | **L2** |
| SP-12 Threat model | New unauthenticated surface conferring authority | Interception, enumeration, replay, self-invitation | T-05.1 to T-05.3 | — |
| SP-14 Legal | Consent capture on acceptance | That acceptance records version and hash; that nothing is pre-accepted | 05-T4, 05-A4 | — |
| SP-13 Privacy | Address handling | That an invited address is not disclosed to non-owners | — | — |
| SP-03 Database | New table | Uniqueness, comparability, index | 05-T8 | L3 |
| SP-04 Migrations | Registry migration | Idempotency, rollback | — | L3 |
| SP-09 UX | Multi-step unauthenticated flow | Comprehension; that the uniform refusal is not a dead end | 05-A3 | — |
| SP-10 Accessibility | Three-step flow | §6.9.9 | 05-A1 to 05-A4 | — |
| SP-15, SP-18, SP-19 | Mandatory | — | — | L1 |
| Platform owner | Confers administrator authority | The phase | — | **L4** |

### 6.9.11 Acceptance checklist and gates

- [ ] Every IV-1 to IV-15 satisfied and tested.
- [ ] Token hashed; absent from every response.
- [ ] Acceptance atomic, verified by induced failure.
- [ ] Four failure causes indistinguishable.
- [ ] Consent captured with version and hash; nothing pre-checked.
- [ ] Four gates pass; L1, L2, L3, L4 obtained.

---

## 6.10 Phase P-06 — Suspension normalisation sweep

### 6.10.1 Objective

Close NB-4: normalise records whose suspension deadline has passed for accounts that never
return.

**RATIONALE.** Access correctness does not depend on this (INV-012). What lags is
labelling: an expired suspension on an account that never signs in again reads as active
suspension in every administrative view.

### 6.10.2 Prerequisites

P-00 complete.

### 6.10.3 Scope

Per §5.6.3 SN-1 to SN-5.

### 6.10.4 Tests

| # | Test |
|---|---|
| 06-T1 | The sweep uses the shared predicate; asserted by the derived guard |
| 06-T2 | An expired suspension is normalised; the reason is retained |
| 06-T3 | Token versions are not incremented |
| 06-T4 | An unreadable deadline is left alone |
| 06-T5 | An indefinite suspension is untouched |
| 06-T6 | A future deadline is untouched |
| 06-T7 | The sweep records what it lifted |
| 06-T8 | Idempotent: a second pass changes nothing |

### 6.10.5 Rollout, rollback, risk

Rollout: merge; the schedule begins at boot. Rollback: revert; access remains correct.

| # | Risk | Mitigation |
|---|---|---|
| R-06.1 | The sweep releases an account it should not | Shared predicate; 06-T4, 06-T5, 06-T6 |
| R-06.2 | The sweep clears the reason, destroying the record | 06-T2 |
| R-06.3 | The sweep bumps token versions, signing out reinstated users | 06-T3 |

### 6.10.6 Specialist assignments

| Specialist | Why | Reviews | Verification | Sign-off |
|---|---|---|---|---|
| SP-11 Security | Modifies enforcement state | That the predicate is shared, not reimplemented | 06-T1 | L2 |
| SP-05 Backend | Sweep logic | Idempotency; failure isolation | 06-T8 | — |
| SP-17 Observability | New scheduled work | That it is observable and alerts on consecutive failure | Volume V BW-1, BW-3 | — |
| SP-15, SP-18, SP-19 | Mandatory | — | — | L1 |

### 6.10.7 Acceptance checklist

- [ ] SN-1 to SN-4 satisfied; SN-5 removed from the readiness assessment.
- [ ] Every §6.10.4 test present.
- [ ] Observable and alerting.
- [ ] Four gates pass; L1, L2 obtained.

---

## 6.11 Phase P-07 — Remaining moderation actions

### 6.11.1 Objective

Close NB-3: organizer standing removal and per-account feature restriction.

### 6.11.2 Prerequisites

P-04 complete. Both act on roles and capabilities, so the immutability enforcement must
exist first.

### 6.11.3 Scope

| # | Item | Cites |
|---|---|---|
| 07-1 | Organizer standing removal, retaining every record | Volume III §3.10.1 |
| 07-2 | Per-account capability withholding as a moderation act | Volume II §2.3.7 |
| 07-3 | Both offered from the report detail surface, capability-gated | Volume III §3.5.6 |
| 07-4 | Both reversible from the same surface | Volume III §3.5.2 |

**Requirement on 07-2.** Withholding MUST use the existing per-account capability
machinery. A parallel restriction system MUST NOT be introduced (SP-02 reviews this
specifically).

### 6.11.4 Tests

| # | Test |
|---|---|
| 07-T1 | Demotion retains every event, attendance record, credited hour and certificate |
| 07-T2 | Demotion is distinguished from pre-approval denial |
| 07-T3 | Demotion ends sessions and notifies |
| 07-T4 | Demotion refused for an owner |
| 07-T5 | Withholding takes effect on the next request without re-signing-in |
| 07-T6 | Withholding is disclosed to the subject with reason and remedy |
| 07-T7 | Withholding refused for an owner |
| 07-T8 | Both reversible; reversal recorded |
| 07-T9 | Both write to both trails |

### 6.11.5 Risk and threat analysis

| # | Risk | Mitigation |
|---|---|---|
| R-07.1 | Demotion deletes records | 07-T1 |
| R-07.2 | A parallel restriction system is introduced | SP-02 review; 07-2 |
| R-07.3 | Withholding leaves the subject with no explanation | 07-T6; Volume II §2.4.6 |
| R-07.4 | Withholding removes the capability needed to discharge it | Volume II §2.3.5; SP-11 verifies the remedy surface stays reachable |

### 6.11.6 Specialist assignments

| Specialist | Why | Reviews | Verification | Sign-off |
|---|---|---|---|---|
| SP-02 Architecture | Risk of a parallel system | That withholding reuses existing machinery | R-07.2 | — |
| SP-11 Security | Alters capabilities | Target rules; remedy reachability | 07-T4, 07-T7, R-07.4 | L2 |
| SP-09 UX | Withholding must be explicable | Disclosure copy and remedy | 07-T6 | — |
| SP-10 Accessibility | New confirmations | Dialog semantics | — | — |
| SP-15, SP-18, SP-19 | Mandatory | — | — | L1 |

### 6.11.7 Acceptance checklist

- [ ] 07-1 to 07-4 satisfied.
- [ ] Every §6.11.4 test present.
- [ ] No parallel restriction system introduced.
- [ ] Four gates pass; L1, L2 obtained.

---

## 6.12 Phase P-08 — Developer Mode shell and read-only tools

### 6.12.1 Objective

Establish the Developer Mode surface with its access control, and the nine read-only tools.

**Requirement.** Access control ships **before** any tool. A surface whose restriction is
added later is a surface that was briefly open.

### 6.12.2 Prerequisites

P-04 complete. The identity check depends on ownership being settled.

### 6.12.3 Stages

| Stage | Content |
|---|---|
| 08-S1 | Shell, access control, index, and the guard requiring every route to apply the check |
| 08-S2 | Environment Health, Capability Inspector, Route Debugger |
| 08-S3 | Scheduler Inspector (read-only view), Queue Inspector (read-only), Live Jobs (read-only), Database Statistics, Cache Viewer (read-only), Session Viewer (read-only) |
| 08-S4 | Audit Explorer link, OAuth Debugger (read-only) |

**Requirement.** 08-S1 MUST include the guard, and the guard MUST be verified failing
against a route that omits the check.

### 6.12.4 Scope requirements

Per §4.5.3, §4.5.4 DM-1 to DM-9, and the per-tool specifications in §4.5.5. Every tool in
this phase is read-only: DM-2 does not apply, and each tool MUST be verified to perform no
write.

### 6.12.5 Tests

| # | Test |
|---|---|
| 08-T1 | Every Developer Mode route refused for the second owner account |
| 08-T2 | Every route refused for administrator, organizer, student, unauthenticated |
| 08-T3 | Absent configuration disables the surface entirely |
| 08-T4 | The guard fails against a route omitting the check |
| 08-T5 | No tool renders a credential, token, secret, grant, message body or evidence content — asserted per tool |
| 08-T6 | No tool in this phase performs a write, asserted by comparing state before and after |
| 08-T7 | Authorization does not vary by environment |
| 08-T8 | The Capability Inspector matches the kernel exhaustively |
| 08-T9 | The Route Debugger's inventory count matches the registry |
| 08-T10 | Every tool renders an explanatory empty state with its subsystem absent |

### 6.12.6 Risk and threat analysis

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R-08.1 | A route registered outside the prefix is unguarded | Critical | Per-route check; 08-T4 |
| R-08.2 | Configuration absent, opening rather than closing | Critical | 08-T3 |
| R-08.3 | A tool discloses a secret | High | 08-T5 per tool |
| R-08.4 | A locking operation offered from Database Statistics | High | §4.5.5.8; SP-03 review |
| R-08.5 | The Capability Inspector reimplements the decision | Medium | 08-T8 |
| R-08.6 | An operation becomes reachable only here | Medium | DS-9; SP-01 review |

| # | Threat | Control | Residual |
|---|---|---|---|
| T-08.1 | A compromised administrator reaches diagnostic internals | Identity check independent of capability | None material |
| T-08.2 | The developer account is compromised, exposing every subsystem | Read-only in this phase; mutations deferred to P-10 | Present; bounded by phase ordering |
| T-08.3 | A tool becomes an unaudited read path to personal data | DM-4, DM-5; SP-13 per tool | None material |

### 6.12.7 Accessibility

| # | Requirement |
|---|---|
| 08-A1 | The index is navigable by heading structure |
| 08-A2 | Every table has header semantics and a caption |
| 08-A3 | Status indicators have text equivalents |
| 08-A4 | Sortable tables announce sort state |
| 08-A5 | Empty states are announced, not merely rendered |

### 6.12.8 Specialist assignments

| Specialist | Why | Reviews | Verification | Sign-off |
|---|---|---|---|---|
| SP-11 Security | New privileged surface | Per-route enforcement; absent-safe default; environment invariance | 08-T1 to 08-T4, 08-T7 | **L2** |
| SP-13 Privacy | Tools read internals | Per tool: what personal data is reachable | 08-T5 | — |
| SP-03 Database | Statistics tool | That no locking operation is offered | R-08.4 | — |
| SP-02 Architecture | Sixteen tools risk sprawl | That tools read existing registries rather than duplicating | 08-T8, 08-T9 | — |
| SP-01 Planning | Staging and DS-9 | That no operation becomes exclusive to this surface | R-08.6 | — |
| SP-10 Accessibility | Data-dense surfaces | §6.12.7 | 08-A1 to 08-A5 | — |
| SP-16 Performance | Statistics can be expensive | Query cost per tool | Budgets | — |
| SP-15, SP-18, SP-19 | Mandatory | — | — | L1 |
| Platform owner | New privileged surface | The phase | — | **L4** |

### 6.12.9 Acceptance checklist

- [ ] 08-S1 shipped first, including the guard, verified failing.
- [ ] Every §4.5.5 read-only tool satisfies its specification.
- [ ] Every §6.12.5 test present, per tool where stated.
- [ ] No write performed by any tool in this phase.
- [ ] Four gates pass; L1, L2, L4 obtained.

---

## 6.13 Phase P-09 — Feature flags and maintenance mode

### 6.13.1 Objective

Provide runtime behaviour control and honest planned downtime.

### 6.13.2 Prerequisites

P-08 complete. Both are Developer Mode tools.

### 6.13.3 Scope

Per §4.13 FF-1 to FF-9 and §4.14 MM-1 to MM-10.

**Requirement.** FF-4 and FF-5 MUST be verified by SP-11 reviewing the initial flag
registry: no flag may gate a security control or a legal obligation.

### 6.13.4 Tests

| # | Test |
|---|---|
| 09-T1 | An unset flag resolves to its default without error |
| 09-T2 | Setting is owner-only and records both values |
| 09-T3 | Both states of every registered flag are tested |
| 09-T4 | A stale flag past its removal condition is reported |
| 09-T5 | Maintenance mode presents as a takeover with reason, return and data safety |
| 09-T6 | Health reports maintenance distinctly from unhealthy |
| 09-T7 | Legal documents, public pages and Developer Mode remain available under maintenance |
| 09-T8 | Sessions survive maintenance |
| 09-T9 | Maintenance overrun is reported |

### 6.13.5 Risk and threat analysis

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R-09.1 | A flag gates a security control | Critical | FF-4; SP-11 registry review |
| R-09.2 | A flag gates a legal obligation | Critical | FF-5; SP-14 registry review |
| R-09.3 | Flags accumulate untested | High | FF-6, FF-9; 09-T3, 09-T4 |
| R-09.4 | Maintenance terminates sessions | Medium | MM-9; 09-T8 |
| R-09.5 | Monitoring pages during planned maintenance | Medium | MM-3; 09-T6 |

| # | Threat | Control | Residual |
|---|---|---|---|
| T-09.1 | A flag change disables a protection | FF-4; recorded and owner-only | An owner error; recorded |
| T-09.2 | Maintenance used to hide an incident | Recorded with reason; overrun reported | Evidential |

### 6.13.6 Specialist assignments

| Specialist | Why | Reviews | Verification | Sign-off |
|---|---|---|---|---|
| SP-11 Security | Flags can disable controls | The registry, flag by flag | R-09.1 | **L2** |
| SP-14 Legal | Flags can disable obligations | The registry against published commitments | R-09.2 | — |
| SP-17 Observability | Maintenance affects alerting | That health distinguishes maintenance | 09-T6 | — |
| SP-09 UX | The maintenance page is read by users | Reason, return, data-safety copy | 09-T5 | — |
| SP-10 Accessibility | A takeover | Announcement, focus, contrast | — | — |
| SP-15, SP-18, SP-19 | Mandatory | — | — | L1 |

### 6.13.7 Acceptance checklist

- [ ] Every FF and MM requirement satisfied.
- [ ] No flag gates a security control or legal obligation, reviewed flag by flag.
- [ ] Both states of every flag tested.
- [ ] Four gates pass; L1, L2 obtained.

---

## 6.14 Phase P-10 — Developer Mode mutating tools and emergency controls

### 6.14.1 Objective

Add the mutating tools and the seven emergency controls.

**Risk: HIGH.** This phase makes a single account able to alter runtime state platform-wide.

### 6.14.2 Prerequisites

P-08 and P-09 complete. Mutating tools require the shell, the access control, and the
recording surface that makes their use visible.

### 6.14.3 Scope

| # | Item |
|---|---|
| 10-1 | Mutations for Scheduler Inspector, Live Jobs, Cache Viewer, Queue Inspector, Session Viewer |
| 10-2 | Notification Tester, self-target only |
| 10-3 | API Explorer, own-principal only |
| 10-4 | Emergency controls EC-1 to EC-7 |

### 6.14.4 Tests

| # | Test |
|---|---|
| 10-T1 | Every mutation writes an unsuppressible record |
| 10-T2 | Every mutation requires confirmation naming its specific effect |
| 10-T3 | The Notification Tester cannot target another account, asserted by attempting it |
| 10-T4 | The API Explorer cannot act as another account; its requests are marked |
| 10-T5 | The Queue Inspector cannot discard a mandatory notice |
| 10-T6 | Scheduler pauses expire automatically |
| 10-T7 | A freeze creates no moderation record and its notice asserts no finding |
| 10-T8 | A freeze is bounded and reported with its age |
| 10-T9 | Every emergency control records before taking effect |
| 10-T10 | Every reversible control is reversible from the same surface |
| 10-T11 | Global session revocation ends every session |
| 10-T12 | No arbitrary execution surface exists |

### 6.14.5 Risk and threat analysis

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R-10.1 | The Notification Tester sends a fabricated suspension notice to a student | Critical | Self-only; 10-T3 |
| R-10.2 | The API Explorer becomes unaudited impersonation | Critical | Own-principal only; marked requests; 10-T4 |
| R-10.3 | A mandatory notice is discarded | Critical | 10-T5 |
| R-10.4 | A freeze becomes an unrecorded suspension | High | Bounded, reported, notice asserts no finding; 10-T7, 10-T8 |
| R-10.5 | An indefinite pause presents as a broken scheduler | Medium | Expiry; 10-T6 |
| R-10.6 | A control takes effect before it is recorded | High | 10-T9 |
| R-10.7 | The surface is unavailable when it is needed | Medium | Every control has a host-level equivalent (§4.15.2) |

| # | Threat | Control | Residual |
|---|---|---|---|
| T-10.1 | The developer account is compromised, permitting platform-wide disruption | Recorded; bounded; host-level reversal available | **Present and material.** Recorded in the readiness assessment. Mitigated by Volume II §2.10.6 O-1 to O-6 |
| T-10.2 | Emergency controls used to suppress evidence of misconduct | Every use recorded before effect; freeze cannot destroy data | Evidential |

**Requirement.** T-10.1 MUST be recorded as a residual risk. A single account able to alter
runtime state platform-wide is a concentration of risk that this phase creates knowingly,
in exchange for a one-operator platform's ability to respond to an incident.

### 6.14.6 Specialist assignments

| Specialist | Why | Reviews | Verification | Sign-off |
|---|---|---|---|---|
| SP-11 Security | Creates platform-wide mutation authority | Every mutation's recording; self-only and own-principal constraints; absence of arbitrary execution | 10-T1 to 10-T5, 10-T12 | **L2** |
| SP-12 Threat model | Concentration of authority | Compromise consequences; suppression paths | T-10.1, T-10.2 recorded | — |
| SP-13 Privacy | Tests send notices; explorer issues requests | That no notice reaches another account; that no request reads another's data | 10-T3, 10-T4 | — |
| SP-17 Observability | Controls affect monitoring | That each control's effect is visible in signals | — | — |
| SP-09 UX | Confirmations must state effects precisely | Every confirmation string | 10-T2 | — |
| SP-20 Release | Host-level equivalents | That each control has a documented host procedure | R-10.7 | — |
| SP-15, SP-18, SP-19 | Mandatory | — | — | L1 |
| Platform owner | Concentration of authority | The phase | — | **L4** |

### 6.14.7 Acceptance checklist

- [ ] Every mutation records unsuppressibly, before effect.
- [ ] Self-only and own-principal constraints verified by attempting violation.
- [ ] Mandatory notices undiscardable.
- [ ] Freeze bounded, reported, and asserts no finding.
- [ ] Every control has a host-level equivalent.
- [ ] T-10.1 recorded as residual.
- [ ] Four gates pass; L1, L2, L4 obtained.

---

## 6.15 Phase P-11 — Organization records

### 6.15.1 Objective

Convert organizational affiliation from free text to records, per §4.7.

### 6.15.2 Prerequisites

None. Independent of the administrative phases.

### 6.15.3 Migrations

| # | Change | Path | Notes |
|---|---|---|---|
| 11-M1 | Organization table | Registry, additive | |
| 11-M2 | Organizer↔organization association table | Registry, additive | |
| 11-M3 | Event organization reference, nullable | Registry, additive | |

**Requirement.** The existing free-text field MUST be retained. Reconciliation is a
subsequent, human, recorded activity — not part of the migration (§4.7.4 OR-3).

**RATIONALE.** Automated matching silently merges distinct organizations with similar names
and splits identical ones spelled differently. Both errors propagate into the figures
presented to districts.

### 6.15.4 Tests

Per §4.7.5, plus:

| # | Test |
|---|---|
| 11-T1 | The migration retains every free-text value |
| 11-T2 | An organizer cannot create a verified organization |
| 11-T3 | A proposal confers nothing |
| 11-T4 | Renaming preserves historical attribution |
| 11-T5 | Merging preserves every attributed record and is recorded |
| 11-T6 | Deletion refused where events are attributed; deactivation offered |

### 6.15.5 Risk and threat analysis

| # | Risk | Mitigation |
|---|---|---|
| R-11.1 | Automated reconciliation corrupts attribution | OR-3; 11-T1 |
| R-11.2 | Self-certified verification | OR-4; 11-T2 |
| R-11.3 | Merge loses records | OR-7; 11-T5 |
| R-11.4 | Renaming rewrites history | OR-6; 11-T4 |

| # | Threat | Control | Residual |
|---|---|---|---|
| T-11.1 | An organizer asserts a verified affiliation to gain trust | Verification requires moderation authority | None material |

### 6.15.6 Specialist assignments

| Specialist | Why | Reviews | Verification | Sign-off |
|---|---|---|---|---|
| SP-03 Database | New entity and relationships | Cardinality, uniqueness, indexes, portability | — | **L3** |
| SP-04 Migrations | Three additive migrations | Idempotency, ordering, rollback, retention of free text | 11-T1 | **L3** |
| SP-02 Architecture | New first-class entity | That it does not duplicate existing concepts | — | — |
| SP-11 Security | Verification is an assertion to third parties | Gate on verification | 11-T2 | L2 |
| SP-09 UX | Proposal flow | That a proposal is clearly pending | 11-T3 | — |
| SP-15, SP-18, SP-19 | Mandatory | — | — | L1 |

### 6.15.7 Acceptance checklist

- [ ] Three migrations applied, idempotent, free text retained.
- [ ] Every §6.15.4 test present.
- [ ] Reconciliation is documented as a separate human activity.
- [ ] Four gates pass; L1, L2, L3 obtained.

---

## 6.16 Phase P-12 — Analytics foundation

### 6.16.1 Objective

Establish the derivation layer, metric definitions and suppression rules that the
dashboard depends on, per §4.8.

**Requirement.** This phase ships **no dashboard**. It ships definitions, derivations,
parity checks and suppression, verified independently. A dashboard built on unverified
derivations presents figures nobody has checked.

### 6.16.2 Prerequisites

P-11 complete for organization-scoped metrics.

### 6.16.3 Scope

| # | Item | Cites |
|---|---|---|
| 12-1 | One definition per metric, expressed once, exposed with the figure | §4.8.3 |
| 12-2 | Derivation for every metric; no counters | INV-025 |
| 12-3 | Materialisation where a budget requires it, rebuildable, with build time | §4.8.2 |
| 12-4 | Parity check between materialisation and derivation | §4.8.2 |
| 12-5 | Timezone handling; partial-period labelling | §4.8.4 |
| 12-6 | Minimum cohort suppression, labelled | §4.8.5 AN-1 |
| 12-7 | Scoping for organizer and partner views | AN-4, AN-5 |

### 6.16.4 Tests

| # | Test |
|---|---|
| 12-T1 | Every metric derives from records; no counter is a source |
| 12-T2 | Every materialisation rebuilds to the same values as its derivation |
| 12-T3 | The parity check exits non-zero on an induced divergence |
| 12-T4 | A partial period is labelled and excluded from complete-period comparison |
| 12-T5 | An empty period yields zero, not absence |
| 12-T6 | A cohort below the minimum is suppressed and labelled, not zeroed |
| 12-T7 | Organizer scoping excludes other organizers' events |
| 12-T8 | Partner scoping excludes other organizations |
| 12-T9 | Hours group by service date, not confirmation date |
| 12-T10 | Median and mean are both computed where §4.9.4 W-07 requires |

### 6.16.5 Risk and threat analysis

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R-12.1 | A counter becomes a source | High | INV-025; 12-T1 |
| R-12.2 | A materialisation drifts | High | 12-T2, 12-T3; scheduled rebuild |
| R-12.3 | Suppression shown as zero, a false statement | High | 12-T6 |
| R-12.4 | Confirmation-date grouping produces administrative artefacts | Medium | 12-T9 |
| R-12.5 | A figure has two definitions across surfaces | High | 12-1; SP-03 verifies single expression |

| # | Threat | Control | Residual |
|---|---|---|---|
| T-12.1 | Aggregate re-identification | Minimum cohort suppression | Present at small population; the minimum MUST be set with the actual population in mind |
| T-12.2 | An organizer infers another's performance | Scoping | None material |

### 6.16.6 Specialist assignments

| Specialist | Why | Reviews | Verification | Sign-off |
|---|---|---|---|---|
| SP-03 Database | Derivations and their cost | Query correctness; index support; single expression per metric | 12-T1, 12-T9, R-12.5 | **L3** |
| SP-13 Privacy | Aggregates over minors | Suppression threshold against actual population; scoping | 12-T6 to 12-T8, T-12.1 | — |
| SP-16 Performance | Budgets drive materialisation | Which metrics require materialisation | Budgets | — |
| SP-02 Architecture | Risk of a parallel data layer | That derivations read source tables, not a new store | — | — |
| SP-15 Testing | Parity is the safety property | That the parity check fails on divergence | 12-T3 | — |
| SP-18, SP-19 | Mandatory | — | — | L1 |

### 6.16.7 Acceptance checklist

- [ ] Every metric has one definition, exposed with the figure.
- [ ] No counter is a source.
- [ ] Parity check exists and fails on divergence.
- [ ] Suppression labelled, never zeroed.
- [ ] No dashboard shipped in this phase.
- [ ] Four gates pass; L1, L3 obtained.

---

## 6.17 Phase P-13 — Community Impact Dashboard

### 6.17.1 Objective

Build the twenty-one widgets in §4.9.4 on the verified foundation from P-12.

### 6.17.2 Prerequisites

P-12 complete. W-04 and W-09 additionally require P-11.

### 6.17.3 Stages

| Stage | Widgets | Why |
|---|---|---|
| 13-S1 | W-01, W-02, W-03, W-05, W-21 | Headlines plus safety. Safety ships with the headlines, not after, per ID-6. |
| 13-S2 | W-14, W-15, W-16, W-06, W-07 | Rates and depth. |
| 13-S3 | W-08, W-09, W-10, W-12, W-13 | Distributions. |
| 13-S4 | W-11, W-17, W-18, W-19, W-20, W-04 | Comparison, composition, milestones. |

**Requirement.** 13-S1 MUST include W-21. A dashboard whose safety widget arrives in a
later stage is a dashboard that was presented without it.

### 6.17.4 Requirements

Every widget per its §4.9.4 specification, plus §4.9.5 layout and §4.9.6 accessibility.

**Requirement.** A widget whose data preconditions are unmet MUST state what it needs
(§4.9.5 L-7). It MUST NOT render empty and MUST NOT be silently omitted.

### 6.17.5 Tests

| # | Test |
|---|---|
| 13-T1 | Every widget renders correct values against a known fixture |
| 13-T2 | Every widget renders its zero state with an explanation |
| 13-T3 | No fabricated or sample data exists in any mode |
| 13-T4 | Every chart has a tabular equivalent in the accessible tree |
| 13-T5 | Every chart caption states the correct unit for that chart |
| 13-T6 | Partial periods labelled wherever they appear |
| 13-T7 | Suppressed cells labelled |
| 13-T8 | W-04, W-09 absent until organizations are records |
| 13-T9 | W-11, W-15 absent until their periods permit, with explanation |
| 13-T10 | Impact cards carry definitions when copied |
| 13-T11 | Milestone dates do not move when a figure is corrected |
| 13-T12 | The dashboard issues a bounded query count regardless of widget count |

**Requirement on 13-T5.** The caption is the only content delivered where the visual is
hidden. A caption reused across charts of differing units MUST fail this test. This has
occurred: a caption describing hours was reused for a chart counting people.

### 6.17.6 Risk and threat analysis

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R-13.1 | A figure is presented that the platform cannot justify | Critical | P-12 foundation; 13-T1 |
| R-13.2 | Sample data becomes a claim via a screenshot | Critical | ID-4; 13-T3 |
| R-13.3 | A partial period reads as a collapse | High | TM-3; 13-T6 |
| R-13.4 | A suppressed cell reads as zero | High | AN-1; 13-T7 |
| R-13.5 | A chart is inaccessible | High | A-4.1; 13-T4, 13-T5 |
| R-13.6 | Query count scales with widgets | Medium | §4.9.7; 13-T12 |
| R-13.7 | Safety widget deferred | High | 13-S1 staging |

| # | Threat | Control | Residual |
|---|---|---|---|
| T-13.1 | Re-identification from a heatmap cell | Cell-level suppression | None material with the threshold enforced |
| T-13.2 | A figure quoted without its definition | Cards carry definitions when copied | Present; a reader may still quote a bare number |

### 6.17.7 Specialist assignments

| Specialist | Why | Reviews | Verification | Sign-off |
|---|---|---|---|---|
| SP-10 Accessibility | Charts are the least accessible content class | Tabular equivalents; per-chart captions; colour independence | 13-T4, 13-T5 | — |
| SP-13 Privacy | Aggregates over minors, some public-adjacent | Suppression at cell level; heatmap granularity | 13-T7, T-13.1 | — |
| SP-08 UI | Legibility from a distance; density | Hierarchy; token discipline; tabular figures | §4.9.5 | — |
| SP-09 UX | Figures will be quoted | Definitions in-view; partial labelling; zero states | 13-T2, 13-T6, 13-T10 | — |
| SP-16 Performance | Twenty-one widgets | Query count; progressive render | 13-T12; budgets | — |
| SP-03 Database | Widget queries | That each uses P-12 derivations, not new ones | R-13.1 | — |
| SP-14 Legal | Figures become public claims | That no widget overstates | R-13.2 | — |
| SP-15, SP-18, SP-19 | Mandatory | — | — | L1 |

### 6.17.8 Acceptance checklist

- [ ] Every widget per §4.9.4, staged per §6.17.3 with W-21 in the first stage.
- [ ] Every §6.17.5 test present.
- [ ] No fabricated data in any mode.
- [ ] Every chart has a tabular equivalent and a unit-correct caption.
- [ ] Budgets measured.
- [ ] Four gates pass; L1 obtained.

---

## 6.18 Phase P-14 — Public impact pages

### 6.18.1 Objective

Publish an unauthenticated aggregate view, per §4.11.

### 6.18.2 Prerequisites

P-13 complete.

### 6.18.3 Requirements

Per §4.11.2 PU-1 to PU-8.

**Requirement.** The public suppression minimum MUST be strictly higher than the internal
one, and the value MUST be set with the actual population size in mind.

### 6.18.4 Tests

| # | Test |
|---|---|
| 14-T1 | No individual appears without opt-in |
| 14-T2 | No individual under eighteen appears under any circumstance |
| 14-T3 | The public suppression minimum is applied and exceeds the internal one |
| 14-T4 | Revocation of opt-in takes effect immediately, including in materialisations |
| 14-T5 | Every figure carries definition and freshness |
| 14-T6 | The page is servable under maintenance mode |
| 14-T7 | No report, enforcement or message detail appears |
| 14-T8 | The page is not indexable where any individual is named |

### 6.18.5 Risk and threat analysis

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R-14.1 | A minor is named publicly | Critical | PU-6; 14-T2 |
| R-14.2 | Opt-out persists in a cache | Critical | PU-3; 14-T4 |
| R-14.3 | Re-identification from a small public aggregate | High | Higher minimum; 14-T3 |
| R-14.4 | A stale figure is quoted as current | Medium | PU-5; 14-T5 |

| # | Threat | Control | Residual |
|---|---|---|---|
| T-14.1 | Scraping to build a profile of a school's students | Aggregates only; no individual without opt-in; no minor ever | None material |
| T-14.2 | Cross-referencing aggregates across time to identify an individual | Higher minimum; SP-13 reviews the differencing risk across published snapshots | **Present.** MUST be recorded: repeated publication of small aggregates permits differencing |

**Requirement.** T-14.2 MUST be recorded as a residual risk, and SP-13 MUST assess whether
the publication cadence and the minimum together make differencing impractical for the
actual population.

### 6.18.6 Specialist assignments

| Specialist | Why | Reviews | Verification | Sign-off |
|---|---|---|---|---|
| SP-13 Privacy | Public data about minors | Every figure; the minimum; differencing across snapshots | 14-T1 to 14-T4, T-14.2 | — |
| SP-14 Legal | Public claims and consent | Opt-in mechanics; consent record for organizations | 14-T1 | — |
| SP-11 Security | Unauthenticated surface | That no authenticated data leaks; caching behaviour | 14-T7 | L2 |
| SP-16 Performance | Public and cacheable | Cache strategy consistent with PU-3 | 14-T4 | — |
| SP-10 Accessibility | Public surface | Full accessibility, no exceptions | — | — |
| SP-15, SP-18, SP-19 | Mandatory | — | — | L1 |
| Platform owner | Public claims about the platform | The page as published | — | **L4** |

### 6.18.7 Acceptance checklist

- [ ] PU-1 to PU-8 satisfied.
- [ ] Every §6.18.4 test present.
- [ ] Differencing risk assessed and recorded.
- [ ] Four gates pass; L1, L2, L4 obtained.

---

## 6.19 Phase P-15 — Impersonation

### 6.19.1 Objective

Build read-only impersonation per §4.6, or decide not to.

**Requirement.** This phase MAY be declined. If declined, the capability MUST be removed
from the registry rather than left registered and unimplemented.

**RATIONALE.** A registered capability with no mechanism is indistinguishable from an
unfinished feature and will eventually be implemented by somebody who has not read §4.6.

### 6.19.2 Prerequisites

P-10 complete.

### 6.19.3 Requirements

Per §4.6.2 IP-1 to IP-10, without exception.

### 6.19.4 Tests

Per §4.6.3, plus:

| # | Test |
|---|---|
| 15-T1 | Every state-changing request is refused while impersonating, asserted across verbs and endpoints |
| 15-T2 | Every audit record written during impersonation names both identities |
| 15-T3 | Messages and evidence are unreadable while impersonating, even where the subject could read them |
| 15-T4 | The session ends automatically at its bound |
| 15-T5 | The subject is notified with time and actor |
| 15-T6 | An owner cannot be impersonated |

### 6.19.5 Risk and threat analysis

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R-15.1 | A write occurs while impersonating, misattributing an act | Critical | IP-3; 15-T1 across every verb |
| R-15.2 | Impersonation becomes a second path to evidence | Critical | IP-9; 15-T3 |
| R-15.3 | A session persists unnoticed | High | IP-5 banner, IP-6 bound; 15-T4 |
| R-15.4 | The subject is unaware | High | IP-10; 15-T5 |

| # | Threat | Control | Residual |
|---|---|---|---|
| T-15.1 | Impersonation used to read a student's private content | IP-9 | None material |
| T-15.2 | Impersonation used to act as a student | IP-3, IP-4 | None material with 15-T1 exhaustive |

### 6.19.6 Specialist assignments

| Specialist | Why | Reviews | Verification | Sign-off |
|---|---|---|---|---|
| SP-11 Security | Creates a dual-identity principal | Read-only enforcement across every write path; dual attribution | 15-T1, 15-T2 | **L2** |
| SP-12 Threat model | Attribution corruption | Every path to a write; every path to content | T-15.1, T-15.2 | — |
| SP-13 Privacy | Viewing a minor's account | Notification obligation; content exclusion | 15-T3, 15-T5 | — |
| SP-09 UX | The banner must be unmissable | Banner persistence and exit | IP-5 | — |
| SP-10 Accessibility | A persistent banner | That it is announced and does not obstruct | — | — |
| SP-15, SP-18, SP-19 | Mandatory | — | — | L1 |
| Platform owner | Dual-identity authority | The phase, or the decision to decline | — | **L4** |

### 6.19.7 Acceptance checklist

- [ ] Either IP-1 to IP-10 satisfied with every test, or the capability removed from the
      registry with the decision recorded.
- [ ] Four gates pass; L1, L2, L4 obtained if built.

---

## 6.20 Phase P-16 — Multi-tenancy preparation

### 6.20.1 Objective

Add the tenant dimension while exactly one tenant exists, per §4.12.2.

**Requirement.** This phase adds the **column and the enforcement mechanism**. It does not
admit a second tenant.

**RATIONALE.** The window in which this is mechanical closes permanently the moment a
second tenant exists. Every row currently belongs to one tenant; afterwards, ambiguous rows
have no correct answer.

### 6.20.2 Prerequisites

P-11 complete. Organizations are shared across tenants, so their model must be settled.

### 6.20.3 Migrations

| # | Change | Path | Notes |
|---|---|---|---|
| 16-M1 | Tenant table with the single existing tenant | Registry, additive | |
| 16-M2 | Tenant reference on every tenant-scoped table, populated | Registry, additive per table | Non-null after population |
| 16-M3 | Indexes leading with the tenant reference | Additive | |

**Requirement.** 16-M2 MUST be additive per table, not a rebuild. Adding a column and
populating it does not require the six guards; a rebuild would.

**Requirement.** Scoping MUST follow §4.12.4 exactly. A table scoped incorrectly is a
cross-tenant leak the moment a second tenant exists.

### 6.20.4 Backend

| # | Requirement |
|---|---|
| 16-B1 | A shared mechanism applying the tenant predicate |
| 16-B2 | The tenant derived from the principal, never from a parameter |
| 16-B3 | A static guard failing on direct queries against tenant-scoped tables outside the mechanism |
| 16-B4 | Owner-only, explicit, recorded cross-tenant read |

### 6.20.5 Tests

| # | Test |
|---|---|
| 16-T1 | Every tenant-scoped table has a populated reference |
| 16-T2 | A direct unscoped query fails the build |
| 16-T3 | The tenant derives from the principal; a parameter is ignored |
| 16-T4 | A second tenant's data is invisible, asserted with a fixture second tenant that is not admitted to production |
| 16-T5 | Cross-tenant read is owner-only and recorded |
| 16-T6 | Every index leads with the tenant reference where the query does |

**Requirement on 16-T4.** A fixture second tenant MUST exist in tests. Isolation cannot be
verified with one tenant, and the phase's entire purpose is isolation.

### 6.20.6 Risk and threat analysis

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R-16.1 | A table scoped incorrectly | Critical | §4.12.4; SP-03 reviews table by table |
| R-16.2 | A query bypasses the mechanism | Critical | 16-B3; 16-T2 |
| R-16.3 | Tenant accepted from a parameter | Critical | 16-B2; 16-T3 |
| R-16.4 | Index changes degrade existing queries | Medium | SP-16 measures before and after |
| R-16.5 | The phase is deferred until a second tenant exists | High | Recorded as the reason for the phase's placement |

| # | Threat | Control | Residual |
|---|---|---|---|
| T-16.1 | Cross-tenant read | Shared mechanism; build guard; principal-derived tenant | None material with 16-T2 and 16-T4 |
| T-16.2 | Tenant enumeration by parameter probing | Parameter ignored | None material |

### 6.20.7 Specialist assignments

| Specialist | Why | Reviews | Verification | Sign-off |
|---|---|---|---|---|
| SP-03 Database | Scoping decision per table | Every table against §4.12.4; index leading columns | 16-T1, 16-T6, R-16.1 | **L3** |
| SP-04 Migrations | Population across many tables | Idempotency; additive rather than rebuild; ordering | 16-T1 | **L3** |
| SP-11 Security | Isolation is the security property | The mechanism; the guard; principal derivation | 16-T2 to 16-T5 | **L2** |
| SP-02 Architecture | Cross-cutting change | That scoping is one mechanism, not per-call-site | 16-B1 | — |
| SP-16 Performance | Index changes | Query plans before and after | R-16.4 | — |
| SP-15, SP-18, SP-19 | Mandatory | — | — | L1 |
| Platform owner | Structural change across the schema | The phase | — | **L4** |

### 6.20.8 Acceptance checklist

- [ ] Every tenant-scoped table has a populated reference; scoping matches §4.12.4.
- [ ] The shared mechanism exists; the guard fails on bypass.
- [ ] A fixture second tenant verifies isolation.
- [ ] No second tenant admitted to production.
- [ ] Four gates pass; L1, L2, L3, L4 obtained.

---

## 6.21 Phase P-17 — Database engine migration

### 6.21.1 Objective

Execute the engine change per §5.9.7.

**Requirement.** This phase MUST NOT begin until a §5.7.3 trigger is **measured**. An
anticipated trigger is not a trigger.

### 6.21.2 Prerequisites

A measured trigger. P-16 complete, because retrofitting tenancy during an engine change
compounds two high-risk projects.

### 6.21.3 Requirements

Per §5.9.7 MP-1 to MP-11, without reordering.

**Requirement.** MP-5 — the conversion of all SQL-bearing files — MUST be one change.
§5.9.3 records why: a partially converted system has two transaction models and the
boundary between them is where correctness is lost.

### 6.21.4 Tests

Every invariant in §0.7 MUST be re-verified against the new engine, individually. Every
existing test MUST pass. Additionally:

| # | Test |
|---|---|
| 17-T1 | Every immutability trigger re-expressed and individually verified against its invariant |
| 17-T2 | The partial expression index re-expressed; duplicate prevention verified behaviourally |
| 17-T3 | Row-count parity per table and child-count parity per relationship |
| 17-T4 | Ledger/derivation parity passes |
| 17-T5 | Materialisation parity passes |
| 17-T6 | No transaction spans an await, asserted by the transaction helper |
| 17-T7 | Every boot guard re-derived and failing closed |
| 17-T8 | A restore drill on the new engine before real users |

### 6.21.5 Risk and threat analysis

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R-17.1 | An immutability trigger is lost in translation | Critical | 17-T1 individually |
| R-17.2 | The partial index is dropped, permitting duplicate administrator conversations | High | 17-T2 behaviourally |
| R-17.3 | Data lost or misaligned in migration | Critical | 17-T3 per table and relationship |
| R-17.4 | A transaction spans an await, producing a partial write | Critical | 17-T6; helper enforcement |
| R-17.5 | Boot guards lost | High | 17-T7 |
| R-17.6 | Rollback impossible after cutover | Critical | Old system restorable throughout; rehearsed rollback |

| # | Threat | Control | Residual |
|---|---|---|---|
| T-17.1 | An invariant silently unenforced on the new engine | Individual re-verification of all twenty-five | Present until 17-T1 to 17-T7 complete |
| T-17.2 | Network exposure of the database | Engine-level access control; enumerated in §5.11.1 | New; MUST be added to the access enumeration |

### 6.21.6 Specialist assignments

Every specialist in the roster is assigned. This is the only phase for which that is true.

| Specialist | Focus | Sign-off |
|---|---|---|
| SP-01 Planning | That MP-1 to MP-11 are not reordered and MP-5 is one change | — |
| SP-03 Database | Baseline schema review table by table against Appendix C | **L3** |
| SP-04 Migrations | Baseline generation; record restart; checksum rebuild | **L3** |
| SP-05 Backend | The synchrony conversion; transaction helper | — |
| SP-11 Security | Every invariant re-verified; new network exposure | **L2** |
| SP-12 Threat model | T-17.2 and the new access surface | — |
| SP-13 Privacy | That the new engine's access is enumerated as database-equivalent | — |
| SP-15 Testing | That every invariant has an individually observed re-verification | — |
| SP-16 Performance | Before and after under equivalent load | — |
| SP-17 Observability | Signals re-derived for the new engine | — |
| SP-20 Release | Cutover, rehearsed rollback, restore drill | — |
| SP-18, SP-19 | Mandatory | L1 |
| Platform owner | The whole migration | **L4** |

### 6.21.7 Acceptance checklist

- [ ] A trigger was measured and recorded before beginning.
- [ ] MP-1 to MP-11 executed in order; MP-5 as one change.
- [ ] All twenty-five invariants individually re-verified.
- [ ] All sixteen triggers individually re-verified.
- [ ] Parity verified per table and relationship.
- [ ] Restore drill performed on the new engine.
- [ ] Rollback rehearsed and available throughout.
- [ ] Four gates pass; L1, L2, L3, L4 obtained.

---

## 6.22 Programme-level requirements

### 6.22.1 Ordering constraints, restated

| Constraint | Reason |
|---|---|
| P-00 first | Later phases add subjects to guards that must derive them. |
| P-01 before P-02, P-03 | Administrative records must be readable before they are written. |
| P-04 before P-05, P-07, P-08, P-10 | Ownership immutability before any surface that could alter it. |
| P-11 before P-12, P-16 | Organizations before organization-scoped metrics and before shared-entity tenancy decisions. |
| P-12 before P-13 | Verified derivations before any surface presenting them. |
| P-13 before P-14 | Internal before public. |
| P-16 before P-17 | Do not compound two high-risk structural projects. |
| P-17 only on a measured trigger | §5.7.2. |

### 6.22.2 Cross-phase obligations

| # | Obligation |
|---|---|
| CX-1 | Every phase updates every appendix it affects, in the same commit. |
| CX-2 | Every phase adds any new invariant to §0.7 with a build-failing test. |
| CX-3 | Every phase carries its residual risks into the launch readiness assessment. |
| CX-4 | Every phase's user-visible change is exercised in a running instance, with the observation recorded. |
| CX-5 | Every phase's new endpoints appear in Appendix B before the phase closes. |
| CX-6 | Every phase's new capabilities appear in Appendix A before the phase closes. |
| CX-7 | Every phase's new audit actions appear in Appendix D before the phase closes. |
| CX-8 | No phase closes with a control rendered for an endpoint that does not exist. |

### 6.22.3 What terminates a phase early

A phase MUST be stopped, not worked around, when any of the following occurs.

| # | Condition | Action |
|---|---|---|
| ST-1 | A prerequisite is discovered unmet | Close the prerequisite as its own change. |
| ST-2 | An invariant would have to be weakened | Stop; the amendment procedure in §0.8 applies, with L4. |
| ST-3 | A specialist returns a fail verdict | Address the finding; do not proceed on the strength of other passes. |
| ST-4 | A test cannot be written for a required behaviour | The behaviour is not specified well enough to build. Return to the specification. |
| ST-5 | A guard must be relaxed to make the change pass | The change is wrong, or the guard is. Establish which before proceeding. |
| ST-6 | The change requires fabricating data to demonstrate | Stop. ID-4. |

**RATIONALE for ST-5.** A guard relaxed to admit a change has been converted from a
protection into a formality, and the relaxation will not be revisited. Establishing which
of the two is wrong is a smaller task than recovering from having guessed.

---

## 6.23 Volume VI acceptance summary

Volume VI is satisfied when:

- Every phase attempted has satisfied its acceptance checklist and passed its gates.
- Every specialist assignment for every attempted phase has produced a report meeting
  §6.2.4.
- Every sign-off at the required level has been obtained and recorded.
- Every cross-phase obligation CX-1 to CX-8 holds for every closed phase.
- The launch readiness assessment (Volume V §5.13) reflects the phases closed and the
  residual risks each contributed.

**Cross-references.** Volumes I–V are the requirements each phase implements. The
appendices are the registries each phase updates. Volume V §5.13.3 lists the items these
phases close.
