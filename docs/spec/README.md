# WeVolunteer Master Engineering Specification

**Document class:** Normative specification
**Status:** Active
**Version:** 2.0.0-spec.1
**Applies to:** WeVolunteer platform, all releases from v1.3 onward
**Supersedes:** Nothing. Complements `docs/ENGINEERING_GUIDE.md`, which remains the
authority on process rules already in force.

---

## 0.1 What this document is

This is the master engineering specification for WeVolunteer. It is the single
source of truth for the platform's architecture, its invariants, its contracts, and
the order in which unbuilt work is to be built.

It is written to be *implementable*. A competent engineer — or a competent coding
agent — given only this specification and an empty repository should be able to
produce a system that satisfies it. Where the existing repository already satisfies a
requirement, the requirement is still stated in full, and the "Current State"
subsection records the fact that it is met. A specification that omits what is
already true cannot be used to verify that it stays true.

## 0.2 What this document is not

This specification does not contain implementation code. It contains schemas,
contracts, state machines, invariants, acceptance criteria and verification
procedures. Where a fragment resembling code appears — a table definition, a JSON
response shape, a capability identifier — it is a *contract*, normative in its
content and non-normative in its formatting.

This specification does not contain open questions, deferred decisions or
placeholders. Every decision within its scope is made. Where a decision depends on
information the platform owner alone holds, the decision is stated as a *constrained
choice*: the options are enumerated, the constraint that selects between them is
named, and the default that applies absent a contrary instruction is specified.

## 0.3 Normative language

This document uses RFC 2119 keywords with their RFC 2119 meanings.

| Keyword | Meaning |
|---|---|
| **MUST**, **MUST NOT** | Absolute requirement. A violation is a defect regardless of test results. |
| **SHALL**, **SHALL NOT** | Synonym for MUST. Used where the subject is a system rather than an implementer. |
| **SHOULD**, **SHOULD NOT** | Strong recommendation. Deviation requires a recorded justification in the implementing commit message. |
| **MAY** | Genuinely optional. |
| **REQUIRED** | Applied to artefacts (a test, a document, a migration guard) that must exist. |

Additionally:

- **INVARIANT** introduces a property that must hold at every observable moment, not
  merely at the end of an operation. Invariants are the strongest class of statement
  in this document. Each is assigned a stable identifier (`INV-###`) and each MUST be
  enforced by a build-failing test.
- **RATIONALE** introduces the reason a requirement exists. Rationale is
  non-normative, but it is not decoration: a future engineer who cannot find the
  rationale for a constraint will eventually remove the constraint. Every non-obvious
  requirement in this document carries one.
- **FAILURE MODE** introduces the specific bad outcome a requirement prevents,
  stated concretely enough to be reproduced.

## 0.4 Document tree

| File | Volume | Scope |
|---|---|---|
| [`README.md`](README.md) | — | This file. Table of contents, conventions, glossary, change control. |
| [`01-engineering-foundation.md`](01-engineering-foundation.md) | I | Engineering philosophy, repository rules, system architecture, testing doctrine, documentation duties, migration rules, coding standards, branch strategy, release process, Definition of Done. |
| [`02-auth-security.md`](02-auth-security.md) | II | Authentication, the capability kernel, authorization, OAuth, sessions, JWT, cookies, CSRF, CSP, step-up re-authentication, audit logging, threat models, break-glass recovery, Super Admin security. |
| [`03-moderation-messaging.md`](03-moderation-messaging.md) | III | Conversation architecture, messaging, safety reporting, moderation, the evidence system, appeals, notifications, organizer and student lifecycles, suspensions, warnings, the audit timeline. |
| [`04-super-admin-impact.md`](04-super-admin-impact.md) | IV | The immutable ownership system, admin management and invitations, the Admin Audit Explorer, Developer Mode, the Community Impact Dashboard, analytics, organization management, multi-tenancy, feature flags, maintenance mode, emergency controls. |
| [`05-deployment-launch.md`](05-deployment-launch.md) | V | Deployment topology, production configuration, monitoring, alerting, logging, backups, restore drills, scaling, database evolution, the PostgreSQL migration, operational security, incident response, launch readiness. |
| [`06-implementation-phases.md`](06-implementation-phases.md) | VI | The ordered implementation programme. Every phase with objective, prerequisites, changes, tests, rollout, rollback, risk and threat analysis, acceptance checklist, verification gates, and the specialist agent assignments for each. |
| [`appendix-capability-matrix.md`](appendix-capability-matrix.md) | A | The complete capability table, the role×capability matrix, grantability rules, and the route→capability index. |
| [`appendix-api-contracts.md`](appendix-api-contracts.md) | B | Endpoint contracts: method, path, gate, request shape, response shape, error codes, idempotency, rate limits. |
| [`appendix-database-schema.md`](appendix-database-schema.md) | C | Table-by-table schema, constraints, indexes, triggers, retention class, and PostgreSQL portability notes. |
| [`appendix-audit-events.md`](appendix-audit-events.md) | D | Every audit action identifier, its trigger, its actor, its subject, its payload, its trail, and its retention. |
| [`appendix-testing-strategy.md`](appendix-testing-strategy.md) | E | Test taxonomy, the static guard inventory, coverage obligations by change class, flakiness policy, and fixture rules. |

## 0.5 Reading order

Three reading orders are supported and each is complete for its purpose.

**Implementing a phase.** Read §0.3 (this file), then Volume VI for the phase, then
follow the phase's cross-references into Volumes I–V and the appendices. Do not read
the volumes front to back; the phase text names precisely which sections bind it.

**Reviewing a change.** Read Volume I §1.9 (Definition of Done) and §1.10 (review
duties), then the appendix relevant to the change class: capability changes against
Appendix A, endpoint changes against Appendix B, schema changes against Appendix C,
anything that writes a trail against Appendix D.

**Understanding a subsystem.** Read the subsystem's volume in full. Each volume is
self-contained on its subject and cross-references rather than restates.

## 0.6 Glossary

Terms in this glossary have exactly the meaning given, everywhere in this document
and in the codebase. Where a term has a colloquial meaning that differs, the
definition here governs.

| Term | Definition |
|---|---|
| **Actor** | The authenticated principal performing a request. Never inferred from a token payload; always re-derived from persistent storage per request. |
| **Appeal** | A contest of an enforcement decision, filed by its subject, decided by a reviewer, and recorded immutably. |
| **Break-glass** | A recovery procedure that operates outside the normal authorization path, requires physical or host-level access, and is unconditionally audited. |
| **Capability** | A named, atomic permission (`report.resolve`). The only unit of authorization. Roles are bundles of capabilities and are never tested directly. |
| **Capability kernel** | The pure module that answers `can(principal, capability)`. Imports nothing. Shared verbatim between server and client. |
| **Counterparty** | In a conversation, the participant who is not the viewer. |
| **Credited hours** | Service hours attributable to a volunteer. Derived on read, never stored on a user row. |
| **Derived field** | A value computed from other stored values at read time. Never written. |
| **Enforcement action** | A moderation act against a person: a warning, a suspension, a capability withholding, a demotion, a deactivation. |
| **Evidence** | An immutable snapshot of content captured at the moment a report is filed. |
| **Grant** | A capability attached to one account, in addition to its role's capabilities. |
| **Immutable role** | A role that no request path may assign, remove or alter. Presently `super_admin` only. |
| **Owner** | The platform owner. Holds `super_admin`. Exactly two Owner accounts exist; see Volume IV §4.1. |
| **Principal** | The authorization subject: an identity plus its effective role, grants and withholdings. |
| **Report** | A safety or conduct complaint about content, a person, or a conversation. |
| **Sensitive action** | An operation requiring step-up re-authentication (AAL2) in addition to a session. |
| **Step-up / AAL2** | Proof of identity obtained within the current session, bound to one action with one set of arguments, single-use, time-limited. |
| **Takeover** | An error presentation that replaces the entire application shell rather than rendering inside it. |
| **Tenant** | An isolated organizational scope. Presently exactly one, implicit. See Volume IV §4.12. |
| **Trail** | An append-only record. Two exist: `admin_audit_logs` (operational, swept) and subject-scoped histories (`moderation_actions`, `appeal_events`; permanent). |
| **Withholding** | A capability removed from an account that its role would otherwise grant. |

## 0.7 Invariant register

The following invariants are defined across this document. This register is the
authoritative index; the defining section is normative for each.

| ID | Invariant | Defined in |
|---|---|---|
| INV-001 | Credited hours are never stored on a user row. | 01 §1.4.3 |
| INV-002 | A route file never compares a role identifier. | 02 §2.3.4 |
| INV-003 | The capability kernel imports nothing. | 02 §2.3.2 |
| INV-004 | Identity is re-derived from storage on every authenticated request. | 02 §2.2.6 |
| INV-005 | Every authenticated route is behind a capability gate or a recorded exemption. | 02 §2.3.5 |
| INV-006 | Every AAL2 gate is paired with a grant expenditure inside the handler's transaction. | 02 §2.7.5 |
| INV-007 | An authorization cascade is ordered most-privileged-first and terminates in an explicit deny. | 02 §2.3.6 |
| INV-008 | `super_admin` cannot be created, removed, altered or self-assigned by any request path. | 04 §4.1.3 |
| INV-009 | Exactly two accounts hold `super_admin`. | 04 §4.1.2 |
| INV-010 | Evidence rows are immutable at the storage layer, not by convention. | 03 §3.4.4 |
| INV-011 | An enforcement action against a person is never recorded without an actor identity. | 03 §3.9.2 |
| INV-012 | Suspension state is derived from stored data, never from a scheduled job. | 03 §3.8.3 |
| INV-013 | There is exactly one definition of "suspended right now". | 03 §3.8.4 |
| INV-014 | A moderation disclosure is recorded before the disclosed data leaves the process. | 03 §3.4.6 |
| INV-015 | A published legal document's hash never changes. | 01 §1.6.7 |
| INV-016 | An error presentation for an authorization refusal is a takeover. | 01 §1.4.6 |
| INV-017 | Exactly one process serves one database. | 05 §5.2.4 |
| INV-018 | A migration is never destructive without all six §8.3 guards. | 01 §1.6.4 |
| INV-019 | Every declared navigation entry declares a capability condition. | 01 §1.4.7 |
| INV-020 | Production boot fails closed on absent or weak security configuration. | 05 §5.3.2 |
| INV-021 | A capability identifier that does not exist resolves to deny, including for wildcard holders. | 02 §2.3.3 |
| INV-022 | Developer Mode is reachable by exactly one account and is not merely hidden. | 04 §4.5.3 |
| INV-023 | An audit record is written in the same transaction as the act it records. | 02 §2.9.5 |
| INV-024 | A tenant-scoped query is never issued without a tenant predicate. | 04 §4.12.6 |
| INV-025 | Impact metrics are derived from source records and are never accumulated in counters. | 04 §4.9.4 |

## 0.8 Change control

This specification is versioned with the platform and lives in the platform
repository. It is not a wiki and is not edited casually.

**Amendment procedure.**

1. An amendment is proposed as a change to this tree on a `docs/*` branch.
2. The amendment MUST state, in the commit message, which requirement changed, what
   it changed from, and the observation that justified the change.
3. An amendment that relaxes a **MUST** or removes an **INVARIANT** requires a
   recorded security review (Volume I §1.10.4) regardless of size, and MUST cite the
   incident, measurement or design change that makes the removed constraint
   unnecessary. "It seemed excessive" is not a justification.
4. An amendment that adds a capability, an endpoint, a table or an audit action MUST
   update the corresponding appendix in the same commit. An appendix that lags its
   volume is a defect.
5. The version in the header increments: patch for clarification, minor for new
   requirements, major for a removed or reversed requirement.

**Precedence.** Where this specification and the code disagree, the specification is
presumed correct and the code is presumed defective, *except* where the code carries a
header comment recording an incident that postdates this document's version. In that
case the code is correct, this document is stale, and correcting it is the first task
of whoever noticed.

**Precedence against `ENGINEERING_GUIDE.md`.** The guide governs process already in
force and its rules are annotated with the incidents that produced them. Where the
guide and this specification address the same subject, the guide governs *present*
practice and this specification governs *target* practice. Neither may be changed to
contradict the other without the amendment procedure above.

## 0.9 Baseline measurement

Every figure below was measured against the repository at the version this document
was written for. They are recorded so that a future reader can tell whether the
"Current State" subsections in the volumes have gone stale.

| Measurement | Value |
|---|---|
| Roles | 5 (`student`, `organizer`, `admin`, `super_admin`, `partner`) |
| Capabilities | 36 |
| Super-only capabilities | 5 |
| API routes | 125 across 18 route modules |
| Database tables | 45 |
| Immutability triggers | 16 |
| Versioned migrations | 18 |
| Sensitive actions (AAL2) | 7 |
| Published legal documents | 10, all at v1.0 |
| Test files | 194 |
| Tests | 3,163 |
| Client bundle (main chunk) | 373 kB raw / 117 kB gzip |
| Background workers | 3 (`notification`, `export`, `retention`) |
| In-process schedulers | 1 (`autoSelect`) |
| Process model | Exactly one process per database, enforced by `instanceLock` |

## 0.10 Scope boundaries

The following are explicitly **out of scope** for this specification and MUST NOT be
implemented on the strength of it. Each is named because its absence is otherwise
indistinguishable from an omission.

| Out of scope | Reason |
|---|---|
| Payments, donations, fundraising | No regulatory analysis has been performed. Handling money changes the platform's legal class. |
| Direct student-to-student messaging | The safety model depends on every conversation having an adult or a staff party. See Volume III §3.1.5. |
| Public user profiles indexed by search engines | The population is majority minors. See Volume III §3.11.3. |
| Third-party analytics SDKs | See Volume I §1.2.6. |
| Uploaded media (images, documents, video) | Requires content scanning, storage lifecycle and a CSAM-reporting obligation analysis that has not been done. |
| Mobile applications | The responsive web application is the delivery vehicle. Native shells are not precluded but are not specified. |
| Automated moderation by classifier | Specified as explicitly rejected in Volume III §3.5.9, with reasoning. |
