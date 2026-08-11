# Volume IV — Ownership, Developer Mode, Impact and Platform Evolution

**Status:** Normative
**Scope:** The immutable ownership system, admin management and invitations, the Admin
Audit Explorer, Developer Mode, the Community Impact Dashboard, analytics, organization
management, multi-tenancy, public impact pages, feature flags, maintenance mode,
emergency controls.

**Binds:** Volume II (authorization, audit, owner security), Volume III (moderation
trails), Appendix A, Appendix D.

---

## 4.1 The immutable ownership system

### 4.1.1 Purpose

Establish platform ownership as a property that the application cannot alter, so that
neither a compromise, nor a mis-click, nor a future feature can transfer, create or
destroy it.

### 4.1.2 INV-009 — Exactly two owner accounts

**INVARIANT.** Exactly two accounts hold the owner role.

| # | Account | Purpose |
|---|---|---|
| 1 | The named principal owner | Routine platform administration and development. |
| 2 | The platform master account | Continuity and recovery. Not used for routine work. |

**Requirements.**

- The count MUST be verified at boot. A count other than two MUST produce a loud,
  non-fatal warning naming the discrepancy.
- The count MUST NOT be fatal at boot.
  **RATIONALE.** A fatal check converts an ownership discrepancy into total unavailability
  — including unavailability of the audit surface needed to diagnose it and the
  administrative surface needed to correct it. The failure mode of the check would be
  worse than the failure it detects.
- The count MUST be surfaced in Developer Mode and in the quarterly review (Volume II
  §2.10.6).
- No request path may change the count in either direction.

**RATIONALE for two rather than one.** One owner is a single point of failure: credential
loss, incapacity or account compromise ends platform administration, and the only
remedy is host access. Two accounts with independent recovery channels (Volume II
§2.10.6 O-3) make continuity a normal operation rather than an incident.

**RATIONALE for two rather than more.** Every additional wildcard holder is an additional
account whose compromise is unbounded and whose actions cannot be constrained by any
permission check. Two is the smallest number that provides continuity, and the model
therefore fixes it at two.

### 4.1.3 INV-008 — The owner role is immutable

**INVARIANT.** No request path may create, remove, alter or assign the owner role.

**Requirements — enforced by absence of mechanism, not by permission check.**

| # | Prohibited operation | Enforcement |
|---|---|---|
| IM-1 | Assigning the owner role | The role identifier MUST NOT appear in any writable role enumeration. No endpoint accepts it as a parameter value. |
| IM-2 | Removing the owner role | No demotion path accepts an owner target. |
| IM-3 | Editing an owner's role | Role is not a writable field on any account-administration endpoint. |
| IM-4 | Deleting an owner account | The deletion path refuses an immutable role. |
| IM-5 | Suspending an owner account | The suspension target rule refuses (Volume II §2.10.4). |
| IM-6 | Warning an owner account | Same target rule. |
| IM-7 | Withholding a capability from an owner | The withholding path refuses an immutable role. |
| IM-8 | Self-promotion to owner | Follows from IM-1: there is no mechanism to accept. |
| IM-9 | Promotion by another owner | Follows from IM-1. Wildcard reach does not create a mechanism. |

**Requirement.** Enforcement MUST be structural wherever possible. A permission check
against a wildcard holder passes; only the absence of a mechanism constrains an owner.

**Requirement.** A static guard MUST assert that the owner role identifier appears in no
writable enumeration, and that no endpoint contract declares role as a mutable field.

**Requirement.** The refusal message for IM-4 through IM-7 MUST state that the account is
an owner account and that ownership is not administrable through the application. It MUST
NOT imply that a more privileged principal could do it, because none can.

### 4.1.4 What owners may do

Owners hold the wildcard and therefore hold every capability. The following are
enumerated because they are the operations the ownership model exists to reserve, and
because each has requirements of its own.

| # | Operation | Requirements |
|---|---|---|
| OP-1 | Promote an account to administrator | §4.2. Recorded. Never immediate without acceptance where the account does not yet exist. |
| OP-2 | Revoke administrator standing | §4.2.7. Recorded. Retains all records. |
| OP-3 | Approve an organizer | Volume III §3.10.1. Also available to administrators. |
| OP-4 | Revoke organizer standing | Volume III §3.10.1. Owner-only. |
| OP-5 | Suspend a user | Volume III §3.8, subject to target rules. |
| OP-6 | Reinstate a user | Volume III §3.8.6. |
| OP-7 | View every audit record | §4.4. |
| OP-8 | Manage administrator invitations | §4.3. |
| OP-9 | Manage pending promotions | §4.3. |
| OP-10 | Access Developer Mode | §4.5. Restricted further than owner-only; see INV-022. |
| OP-11 | Access the Platform Dashboard | §4.9. |
| OP-12 | Grant and revoke capabilities | Volume II §2.3.7. Super-only remain ungrantable. |
| OP-13 | Enter maintenance mode | §4.14. |
| OP-14 | Set feature flags | §4.13. |
| OP-15 | Trigger emergency controls | §4.15. |

**Requirement.** Every operation above MUST write an operational audit record. An owner
action is not exempt from recording; it is the action most in need of it.

### 4.1.5 Edge cases

Each is specified because each is otherwise resolved by accident.

| # | Case | Specified behaviour |
|---|---|---|
| E-1 | An owner attempts to delete their own account | Refused. IM-4 applies to self. |
| E-2 | An owner attempts to suspend the other owner | Refused. IM-5 admits no exception for an owner actor. |
| E-3 | An owner attempts to demote themselves | Refused. IM-2. |
| E-4 | A report names an owner | Decidable by an owner, recorded as a self-review (Volume II §2.4.4). |
| E-5 | A report names **both** owners | Decidable by either, recorded as a self-review. The alternative is an undischargeable hold. |
| E-6 | An owner is the subject of an appeal decision | The appeal is decidable by an owner, recorded as a self-review. |
| E-7 | An owner's provider identity is unlinked, leaving no credential | Refused: the unlink path MUST refuse to remove the last credential on any account, and MUST state why. |
| E-8 | An owner account's address is changed to one already held | Refused by uniqueness, as for any account. |
| E-9 | Both owners lose credentials | Break-glass, Volume II §2.11.4. |
| E-10 | An owner account is compromised | Break-glass, Volume II §2.11.5. |
| E-11 | A migration or script sets a third owner | The boot check warns; the quarterly review catches it; Developer Mode surfaces it. Not preventable at the storage layer without a constraint the platform does not otherwise need — see §4.1.6. |
| E-12 | An owner account is purged by the retention sweep | Impossible: the sweep operates on deleted accounts, and an owner cannot be deleted (IM-4). |
| E-13 | An owner holds a withheld capability from a prior role | The withholding path refuses owners (IM-7); any pre-existing withholding MUST be ignored for a wildcard principal. |
| E-14 | The owner count is one at boot | Warning; the platform operates. A single owner is a continuity risk, not an availability failure. |
| E-15 | The owner count is zero at boot | Warning at the highest severity, and Developer Mode MUST render an unmissable banner. The platform operates, because refusing to boot removes the only surface from which it can be corrected. |

### 4.1.6 Alternatives considered

| Alternative | Rejected because |
|---|---|
| A storage-layer constraint limiting the owner count | A partial unique index cannot express "at most two". A check constraint over a count requires a trigger on every account write, which is a cost paid on every registration to prevent an operation no code path performs. The boot warning plus the review is proportionate. |
| A configuration-declared owner list, ignoring stored roles | Makes ownership unauditable from the database and creates a second source of truth for identity. Also moves ownership into a file that a deployment mistake can rewrite. |
| A single owner with a documented recovery procedure | Rejected: E-9 becomes an incident rather than an operation, and the procedure would be the only continuity mechanism. |
| Owner role as an attribute rather than a role | Would require every capability decision to consult a second field, which is exactly the drift the kernel exists to prevent. |
| Time-limited elevation to owner | Adds a mechanism for becoming an owner, which is the mechanism INV-008 exists to deny. |

### 4.1.7 Acceptance criteria for §4.1

| # | Criterion |
|---|---|
| AC-4.1.1 | Boot verifies the owner count and warns, non-fatally, on any value other than two. |
| AC-4.1.2 | The owner role appears in no writable enumeration; asserted by static guard. |
| AC-4.1.3 | No endpoint contract declares role as mutable; asserted by static guard. |
| AC-4.1.4 | Each of IM-1 to IM-9 is refused, asserted individually, including with an owner as the actor. |
| AC-4.1.5 | Every refusal states that ownership is not administrable and implies no escalation path. |
| AC-4.1.6 | Every owner operation in §4.1.4 writes an audit record. |
| AC-4.1.7 | Each edge case E-1 to E-15 has a test asserting the specified behaviour. |
| AC-4.1.8 | The unlink path refuses to remove the last credential on any account. |
| AC-4.1.9 | A withholding is ignored for a wildcard principal. |

---

## 4.2 Administrator management

### 4.2.1 Purpose

Allow ownership to delegate moderation authority, revocably, with a record.

### 4.2.2 Current state

Administrator promotion has no interface. The capability that would gate it exists and
is owner-only. Promotion is presently possible only by direct database modification,
which produces no record.

### 4.2.3 Problems with the current state

| # | Problem | Consequence |
|---|---|---|
| PB-1 | No promotion interface | Delegation requires host access, so it does not happen; moderation load stays with one person. |
| PB-2 | No record of promotion | "Who made this person an administrator, and when" has no answer. |
| PB-3 | No revocation interface | Removing authority also requires host access, so it is slower than the situation that motivates it. |
| PB-4 | No visibility of the administrator set | Nobody can answer "who currently holds moderation authority over students' private messages". |

### 4.2.4 Design decisions

**D-4.2.1 — Promotion is owner-only, and is a distinct capability.**

The capability gating promotion MUST be super-only, therefore ungrantable. An
administrator MUST NOT be able to create another administrator.

**RATIONALE.** Administrator authority includes reading students' private messages under
a grantable capability. If administrators could promote, the set of people with that
reach would grow without ownership's involvement, and the audit answer to "who authorised
this" would be another administrator, recursively.

**D-4.2.2 — Promotion of an existing account is immediate; promotion of a non-account is
an invitation.**

Two paths, because the failure modes differ. Specified in §4.3.

**D-4.2.3 — Revocation retains everything.**

Revoking administrator standing MUST NOT delete the account, its decisions, its audit
entries, or its subject-scoped history entries.

**RATIONALE.** A former administrator's decisions remain the decisions that were made.
Removing them would rewrite the moderation record, which is the one record that must be
stable.

### 4.2.5 The administrator roster

**Requirements.**

- A roster surface MUST exist, reachable by owners.
- It MUST show, per administrator: identity, when promoted, by whom, last sign-in, the
  capabilities held **including grants and withholdings**, and counts of moderation
  decisions and evidence reads within a stated window.
- Evidence-read counts MUST be shown.
  **RATIONALE.** This is the most invasive power on the platform. An administrator with
  an unusual evidence-read count relative to their decision count is the single most
  useful signal available for detecting misuse, and it is not detectable from any other
  surface.
- The roster MUST show owners, marked as owners, with their controls absent rather than
  disabled.
  **RATIONALE.** A disabled control invites the question of what would enable it. An
  absent control states that no such operation exists.

### 4.2.6 Promotion of an existing account

**Requirements.**

| # | Requirement |
|---|---|
| PR-1 | Gated on the owner-only administration capability. |
| PR-2 | Target MUST be an existing, active, verified account. |
| PR-3 | Target MUST NOT already hold the role, and MUST NOT be an owner. |
| PR-4 | A reason MUST be recorded. |
| PR-5 | Step-up re-authentication MUST be required. |
| PR-6 | The promotion, its actor, its reason and its time MUST be one transaction with an audit record. |
| PR-7 | The subject MUST be notified, and the notice MUST state what the role permits, including that it permits reading reported private messages, and what is expected. |
| PR-8 | The subject's token version MUST be incremented. |

**RATIONALE for PR-5.** Promotion creates a principal with reach over every student's
private messages. It belongs in the same class as the seven existing sensitive actions
and MUST be added to that registry (Volume II §2.7.4).

**RATIONALE for PR-7.** An administrator who does not know their role includes reading
private messages will read them casually. The notice is the first and best moment to
establish that it is a logged, exceptional act.

**RATIONALE for PR-8.** Capabilities are re-derived per request (INV-004), so the
increment is not required for correctness. It is required so the new administrator
signs in again and encounters the notice and the changed interface deliberately, rather
than discovering new controls mid-session.

### 4.2.7 Revocation

**Requirements.**

| # | Requirement |
|---|---|
| RV-1 | Gated on the owner-only administration capability. |
| RV-2 | An owner target MUST be refused (IM-2). |
| RV-3 | A reason MUST be recorded. |
| RV-4 | Step-up MUST be required. |
| RV-5 | Every session MUST end: the token version MUST be incremented. |
| RV-6 | Every capability grant held by the account MUST be revoked in the same transaction. |
| RV-7 | Reports assigned to the account MUST be **unassigned**, and the unassignment recorded. |
| RV-8 | Appeals claimed by the account MUST be **released**, and the release recorded. |
| RV-9 | All decisions, audit entries and history entries MUST be retained. |
| RV-10 | The subject MUST be notified. |

**RATIONALE for RV-6.** Without it, revoking the role leaves granted capabilities in
place. The account would retain, for example, the evidence-reading capability by grant
after losing it by role — the precise inverse of the intent, and invisible on the roster
unless grants are displayed (§4.2.5).

**RATIONALE for RV-7 and RV-8.** An assignment to a revoked account is work that will
never be done, sitting in a queue that reports it as assigned. The oldest-first ordering
(Volume III §3.3.8) then hides it behind the assignment rather than surfacing it as
unworked.

### 4.2.8 Failure modes

| # | Failure mode | Consequence | Control |
|---|---|---|---|
| F-4.1 | Promotion by an administrator | Uncontrolled growth of the set with reach over private messages | Super-only capability |
| F-4.2 | Promotion without a record | Unanswerable accountability question | Transactional audit |
| F-4.3 | Revocation leaves grants | Retained reach after removal | RV-6 |
| F-4.4 | Revocation leaves assignments | Work permanently unworked and reported as assigned | RV-7, RV-8 |
| F-4.5 | Revocation deletes decisions | The moderation record is rewritten | RV-9 |
| F-4.6 | Roster hides grants | Effective authority not visible | §4.2.5 |
| F-4.7 | Owner shown with disabled controls | Suggests an enabling path exists | §4.2.5 absent-not-disabled |

### 4.2.9 Acceptance criteria for §4.2

| # | Criterion |
|---|---|
| AC-4.2.1 | The promotion capability is super-only and ungrantable. |
| AC-4.2.2 | An administrator cannot promote; asserted by test. |
| AC-4.2.3 | Promotion requires step-up and is in the sensitive-action registry. |
| AC-4.2.4 | Promotion is refused for an owner, a non-existent, an unverified, an inactive, and an already-administrator target. |
| AC-4.2.5 | The promotion notice states the private-message reach. |
| AC-4.2.6 | Revocation revokes every grant in the same transaction; asserted with a granted capability present. |
| AC-4.2.7 | Revocation unassigns reports and releases appeals, recorded. |
| AC-4.2.8 | Revocation retains every decision and history entry. |
| AC-4.2.9 | The roster shows grants, withholdings and evidence-read counts. |
| AC-4.2.10 | Owners appear on the roster with controls absent, not disabled. |

---

## 4.3 Pending administrator invitations

### 4.3.1 Purpose

Permit ownership to delegate authority to a person who does not yet have an account,
without creating an account on their behalf or accepting consent for them.

### 4.3.2 The problem this solves

Promotion requires an existing, verified account. Ownership frequently needs to delegate
to a person who has not registered. The available shortcuts are all defective:

| Shortcut | Defect |
|---|---|
| Create the account on their behalf | Accepts the legal agreements on behalf of a person who has not read them. Volume I §1.6.7 makes an acceptance record evidentiary; a forged one is worse than none. |
| Promote on first registration by address match | An address is not identity. Whoever registers with that address becomes an administrator. |
| Share a credential | Destroys attribution for every act taken. |

### 4.3.3 Design

An invitation is a **record of intent**, not a grant. It confers nothing until the
invited person registers, verifies, and accepts.

**Lifecycle:** `pending` → (`accepted` | `revoked` | `expired`).

### 4.3.4 Requirements

| # | Requirement |
|---|---|
| IV-1 | Creating an invitation is gated on the owner-only administration capability and requires step-up. |
| IV-2 | An invitation records: the address, the intended role, the inviting owner, a reason, the creation time, and the expiry. |
| IV-3 | The token MUST be random, single-use, and expiring. |
| IV-4 | The token MUST be delivered to the invited address and MUST NOT be displayed to the inviter after creation. |
| IV-5 | An invitation MUST NOT create an account, a session, or a capability. |
| IV-6 | Acceptance MUST require: registering or signing in as that address, verifying the address, and accepting the legal agreements applicable to the role. |
| IV-7 | Acceptance MUST bind to the **verified address**, not to whoever holds the token. |
| IV-8 | Acceptance MUST be one transaction: consume the token, assign the role, record the audit entry, increment the token version, notify. |
| IV-9 | An invitation MUST be revocable while pending, recorded. |
| IV-10 | An expired invitation MUST be refused with a distinct code and MUST NOT be silently renewable. |
| IV-11 | An invitation for an address that already holds the role MUST be refused. |
| IV-12 | An invitation for an owner's address MUST be refused. |
| IV-13 | At most one pending invitation per address MUST exist; a second MUST replace the first and record the replacement. |
| IV-14 | The pending list MUST be visible to owners with: address, role, inviter, age, expiry. |
| IV-15 | Acceptance MUST be refused if the inviting owner's authority has since been removed — which cannot presently occur (IM-2), but MUST be checked so the property survives any future change. |

**RATIONALE for IV-4.** An inviter who retains the token can accept the invitation
themselves from an address they control, defeating IV-7. Delivery-only is what makes the
address binding meaningful.

**RATIONALE for IV-7.** Binding to the token alone means a forwarded or intercepted mail
confers administrator authority. Binding to the verified address means the invitation is
only usable by somebody who controls that mailbox and has proved it.

**RATIONALE for IV-13.** Multiple pending invitations for one address make revocation
ambiguous: revoking one leaves the others live, and the interface cannot show which is
authoritative.

### 4.3.5 Enumeration

**Requirement.** The invitation acceptance endpoint MUST respond identically for a
token that never existed, a token that expired, a token already used, and a token
belonging to a different address (Volume II §2.2.4).

**RATIONALE.** Distinguishing them lets an attacker probe for live invitations, which are
the highest-value target on the platform: a live invitation is administrator authority
awaiting collection.

### 4.3.6 Acceptance criteria for §4.3

| # | Criterion |
|---|---|
| AC-4.3.1 | Creation is owner-only and step-up gated. |
| AC-4.3.2 | An invitation confers nothing before acceptance; asserted by attempting privileged operations. |
| AC-4.3.3 | The token is never returned to the inviter. |
| AC-4.3.4 | Acceptance requires a verified address matching the invitation. |
| AC-4.3.5 | Acceptance requires the applicable legal acceptances. |
| AC-4.3.6 | Acceptance is one transaction including audit, version increment and notice. |
| AC-4.3.7 | Revocation, expiry, replacement and duplicate refusal each behave as specified. |
| AC-4.3.8 | An owner's address cannot be invited. |
| AC-4.3.9 | Every failure response is identical. |
| AC-4.3.10 | The pending list is visible to owners with the five specified fields. |

---

## 4.4 The Admin Audit Explorer

### 4.4.1 Purpose

Make the audit trails readable, so that the accountability the platform's policies
promise is actually available.

### 4.4.2 The problem

The operational trail is written on every administrative action and is readable by
nothing. The capability that would gate reading it exists and gates a single unrelated
status endpoint. This is the same defect the subject-scoped moderation history had before
it was exposed, and it is the more consequential of the two: the published administrative
responsibilities policy's accountability claims rest on a record no administrator can
read.

### 4.4.3 Requirements

| # | Requirement |
|---|---|
| AE-1 | Gated on the audit-reading capability. |
| AE-2 | Paginated. An unbounded response MUST NOT be possible. |
| AE-3 | Filterable by: actor, subject, action, action class, date range, and free text over the structural detail. |
| AE-4 | Every filter validated against a closed set where one exists, refused with legal values (Volume I §1.7.3). |
| AE-5 | Default ordering newest-first. |
| AE-6 | Each entry shows: time with time-of-day and zone, actor, action in reader's terms, subject, and structural detail. |
| AE-7 | Actor and subject joins MUST be outer, with fallback naming for departed accounts. |
| AE-8 | Action identifiers MUST be translated to labels from a registry; an unrecognised identifier MUST render legibly. |
| AE-9 | An entry MUST link to the subject-scoped history where one exists. |
| AE-10 | Export MUST be available, and MUST be a sensitive action requiring step-up. |
| AE-11 | Reading the explorer MUST NOT itself be audited. |
| AE-12 | The explorer MUST show the **retention horizon** and state that entries older than it have been swept. |
| AE-13 | Counts MUST be computed over the whole filtered set, not the page. |

**RATIONALE for AE-10.** An export is a bulk disclosure of who did what to whom across
the platform. It is a larger disclosure than any single evidence read.

**RATIONALE for AE-11.** Volume II §2.9.6 permits read logging only where a read
discloses content the reader would not otherwise see. An audit-capability holder may
already read every entry; logging each view would flood the trail and destroy its
usability, which is a way of destroying the trail while appearing to strengthen it.

**RATIONALE for AE-12.** Without it, an absence of old entries is indistinguishable from
an absence of old activity. A reader investigating a two-year-old question would conclude
nothing happened.

### 4.4.4 Privacy constraints

| # | Requirement |
|---|---|
| AEP-1 | The explorer MUST NOT display message bodies, case notes, or credentials, because the trail does not contain them (Volume II §2.9.4). |
| AEP-2 | Free-text search MUST operate over structural detail only. |
| AEP-3 | Export MUST carry the same constraints as display. An export path that includes more than the display is a bypass. |
| AEP-4 | The explorer MUST NOT be reachable by an organizer or a student under any grant, because the audit capability MUST NOT be granted to a principal without moderation authority. |

### 4.4.5 Performance

| Operation | Budget |
|---|---|
| Filtered page, 50 entries | ≤ 200 ms |
| Whole-set count for a filter | ≤ 300 ms |
| Export of 10,000 entries | ≤ 5 s, streamed |

**Requirement.** Every filter combination MUST be supported by an index. A filter
requiring a full scan MUST NOT be offered.

### 4.4.6 Acceptance criteria for §4.4

| # | Criterion |
|---|---|
| AC-4.4.1 | Gated on the audit capability; refused for every other principal. |
| AC-4.4.2 | Unbounded responses are impossible. |
| AC-4.4.3 | Every filter is validated and refused with legal values. |
| AC-4.4.4 | Departed actors and subjects render from fallbacks; joins are outer. |
| AC-4.4.5 | Unrecognised action identifiers render legibly. |
| AC-4.4.6 | Export requires step-up and carries display constraints. |
| AC-4.4.7 | Viewing is not audited. |
| AC-4.4.8 | The retention horizon is displayed. |
| AC-4.4.9 | Every offered filter is index-supported. |

---

## 4.5 Developer Mode

### 4.5.1 Purpose

Give the platform's developer the operational visibility that a single-operator system
requires, without creating a surface that widens anybody else's authority.

### 4.5.2 Goals

| ID | Goal |
|---|---|
| G-4.1 | Diagnose a production problem without host access. |
| G-4.2 | Observe the subsystems that have no other visibility: schedulers, queues, sockets, caches. |
| G-4.3 | Verify a capability decision, a route gate or a session state directly, rather than by inference. |
| G-4.4 | Operate emergency controls from a surface that records their use. |
| G-4.5 | Add no capability to any other principal. |

### 4.5.3 INV-022 — Restricted to one account, and not merely hidden

**INVARIANT.** Developer Mode MUST be reachable by exactly one account: the named
principal owner. Restriction MUST be enforced server-side on every endpoint, not by
hiding the navigation entry.

**Requirements.**

- The restriction MUST be implemented as an **explicit identity check** against a
  configured account identifier, in addition to the owner capability requirement.
- The identifier MUST come from configuration, not from a source-code literal, so that
  it can be changed without a release, and MUST be absent-safe: absent configuration
  MUST disable Developer Mode entirely rather than opening it.
- Every Developer Mode endpoint MUST apply the check independently. A shared prefix
  guard is insufficient, because a route registered outside the prefix by mistake would
  be unguarded.
- The navigation entry MUST be absent for every other principal, and its absence MUST
  NOT be the only control.
- A static guard MUST assert that every route under the Developer Mode surface applies
  the identity check.

**RATIONALE for a second check beyond the capability.** The second owner account holds
the wildcard and therefore satisfies any capability requirement. Developer Mode includes
tools that mutate runtime state; restricting it to one account means the continuity
account cannot alter runtime behaviour, which keeps it useful as a clean recovery path.

**RATIONALE for configuration rather than a literal.** An identifier in source is
disclosed to anybody who reads the repository and cannot be rotated without a deployment.

**RATIONALE for absent-safe defaults.** A misconfiguration that opens a debugging surface
is worse than one that closes it.

### 4.5.4 Universal constraints on every tool

| # | Constraint |
|---|---|
| DM-1 | A read-only tool MUST NOT mutate state. |
| DM-2 | Every mutating tool MUST write an audit record, and the record MUST NOT be suppressible from within the tool. |
| DM-3 | No tool may display a credential, a session token, a signing secret, or a step-up grant value. |
| DM-4 | No tool may display message bodies or evidence content. Developer Mode is not a bypass of the evidence capability. |
| DM-5 | No tool may display personal data beyond what an administrator can already see, except where explicitly specified and justified per tool. |
| DM-6 | Every tool MUST degrade to an explanatory empty state rather than an error when its subsystem is unavailable. |
| DM-7 | No tool may be reachable in a non-production environment by a different rule. Environment-dependent authorization is a second code path that is not exercised where it matters. |
| DM-8 | Every mutating tool MUST require confirmation naming the specific effect. |
| DM-9 | No tool may execute arbitrary code, arbitrary queries, or arbitrary shell commands. |

**RATIONALE for DM-9.** An arbitrary-execution tool makes every other control in this
specification advisory. It is the single most valuable target on the platform and its
absence is a security property.

**RATIONALE for DM-7.** A tool that is open in development and closed in production is
tested in the configuration where it is open, so the closed path is the untested one.

### 4.5.5 Tool inventory

Sixteen tools. Each specification states purpose, data, mutations, constraints and
acceptance.

---

#### 4.5.5.1 Scheduler Inspector

**Purpose.** Answer whether scheduled work is running, when it last ran, and what it did.

**Data.** Per scheduler: identifier, running state, interval, last run start and end,
duration, outcome, item count, next scheduled run, consecutive failure count.

**Mutations.** Trigger a run immediately. Pause. Resume.

**Constraints.** A triggered run MUST use the same code path as a scheduled one. A pause
MUST expire automatically after a bounded period and MUST surface a warning while
active.
**RATIONALE for expiry:** an indefinite pause is indistinguishable from a broken
scheduler, and the person who paused it will not be the one who notices.

**Acceptance.** Every scheduler appears; the set is derived from the registry, not
listed. A triggered run produces an audit record. A pause expires.

---

#### 4.5.5.2 Capability Inspector

**Purpose.** Answer authoritatively what a given account may do, and why.

**Data.** For a selected account: role, effective capabilities, which come from the role,
which from grants, which are withheld and by what rule, and the resulting decision for
any capability queried.

**Mutations.** None.

**Constraints.** MUST call the kernel, never reimplement the decision. A second
implementation here would be the drift the kernel exists to prevent, in the one tool
consulted to settle disputes.

**Acceptance.** For every role, the displayed set matches the kernel's answers
exhaustively. Grants and withholdings are attributed to their source. Querying an unknown
capability shows a denial and states that the identifier is unregistered.

---

#### 4.5.5.3 Route Debugger

**Purpose.** Answer which gate protects a route, and what a given principal would receive.

**Data.** Per route: method, path, gate, whether it requires verification, whether it
requires step-up and for which action, its rate limiter, and its declared exemption where
it has one.

**Mutations.** None.

**Constraints.** The inventory MUST be derived from the route registry (P-3). A manually
maintained list would diverge silently and this is the tool consulted when a gate is in
doubt.

**Acceptance.** The route count matches the registry. A route added without a gate is
visibly flagged. Simulated evaluation for each role matches the live behaviour asserted
elsewhere.

---

#### 4.5.5.4 Live Jobs

**Purpose.** Show in-flight and recently completed background work.

**Data.** Per job: identifier, type, state, enqueued time, started time, attempt count,
last error class, and subject reference where one exists.

**Mutations.** Retry. Cancel.

**Constraints.** MUST NOT display job payloads containing personal data; a subject
reference is permitted, its contents are not. A cancel MUST be recorded and MUST NOT
leave a partially applied effect: a job MUST be cancellable only in a state from which
cancellation is complete.

**Acceptance.** A retried job runs through the normal path. A cancel is refused for a job
in a non-cancellable state. No payload content is rendered.

---

#### 4.5.5.5 Notification Tester

**Purpose.** Verify that a notice renders and delivers correctly before it is needed in
an incident.

**Data.** The registry of event types, and a rendered preview of the selected type with
substituted sample values.

**Mutations.** Send a test notice **to the developer's own account only**.

**Constraints.** MUST NOT be able to target another account, at all.
**RATIONALE:** a tool that can send an arbitrary notice to an arbitrary account can send
a student a fabricated suspension notice. Self-only removes the capability rather than
restricting it.
Test notices MUST be marked as tests in their content and in their stored record.
Mandatory-notice overrides MUST NOT apply to test notices.

**Acceptance.** Every registered event type previews. Targeting another account is
impossible, asserted by attempting it. A test notice is marked in content and record.

---

#### 4.5.5.6 WebSocket Monitor

**Purpose.** Answer whether realtime delivery is working and to whom.

**Data.** Connection count, connections per account, per-connection age, subscribed
channels, recent emission counts by event type, and recent delivery failures.

**Mutations.** Disconnect a connection.

**Constraints.** MUST NOT display message content. A disconnect MUST be recorded, and the
client MUST reconnect normally rather than being left in a broken state.

**Acceptance.** Counts agree with the transport's own state. No content appears. A
disconnect is recorded and the client recovers.

---

#### 4.5.5.7 Feature Flags

**Purpose.** Change behaviour without a release. Specified fully in §4.13.

**Data.** Per flag: key, current value, default, description, last change with actor and
time, and the code paths that read it.

**Mutations.** Set. Reset to default.

**Constraints.** Per §4.13.

---

#### 4.5.5.8 Database Statistics

**Purpose.** Understand size, growth and the shape of what is stored.

**Data.** Per table: row count, approximate size, growth over the retained window, index
list with usage where available. Database file size, free pages, journal mode, page size.
Migration state: applied versions with checksum verification status.

**Mutations.** None. Specifically: no vacuum, no analyse, no integrity check from this
surface.
**RATIONALE:** each takes a lock of unbounded duration on a single-process system, which
is an availability incident triggered from a diagnostic screen.

**Acceptance.** Counts match direct queries. Migration state shows every applied version
and its verification result. No mutating operation is offered.

---

#### 4.5.5.9 Maintenance Mode

**Purpose.** Take the platform out of service deliberately and honestly. Specified fully
in §4.14.

---

#### 4.5.5.10 Cache Viewer

**Purpose.** Answer whether a cache is serving stale data.

**Data.** Per cache: identifier, entry count, hit and miss counts, eviction count,
configured bound, and oldest entry age.

**Mutations.** Clear one cache. Clear all.

**Constraints.** MUST NOT display cached values, only keys and metadata, because a cached
value may contain personal data. A clear MUST be recorded, and the effect on load MUST
be stated in the confirmation.

**Acceptance.** Every cache is enumerated from a registry. No values render. A clear is
recorded.

---

#### 4.5.5.11 Environment Health

**Purpose.** One screen answering whether the deployment is correctly configured.

**Data.** Per check: name, status, and the remedy where failing. Checks MUST include:
runtime version within the pinned range; signing-secret strength; mail configuration
completeness and last successful send; application URL set and consistent with the
serving origin; provider credential presence per provider; database writability; disk
headroom; backup age and last verified restore; certificate expiry; scheduler liveness;
owner count; migration checksum status; legal hash verification status.

**Mutations.** None.

**Constraints.** MUST NOT display secret values, only presence and strength verdicts. A
failing check MUST state the remedy, not only the failure.

**Acceptance.** Every boot guard from Volume V §5.3 appears as a check. No secret value
renders. Every failing check has a remedy string.

---

#### 4.5.5.12 API Explorer

**Purpose.** Exercise an endpoint as a specified principal, to settle behaviour questions.

**Data.** The endpoint inventory from the route registry, with contracts.

**Mutations.** Issues real requests.

**Constraints.**

- MUST issue requests **as the developer's own principal**. It MUST NOT be able to
  impersonate another account.
  **RATIONALE:** an explorer that can act as any account is an impersonation tool without
  impersonation's recording obligations (§4.6).
- MUST NOT offer a request that the developer's principal could not otherwise make.
- Every request MUST be recorded, with a marker identifying it as originating from the
  explorer.
- MUST refuse to invoke a step-up-gated endpoint without a genuine grant.

**Acceptance.** Requests are issued as the developer's principal only. Explorer-originated
requests are marked in the record. Step-up-gated endpoints require a real grant.

---

#### 4.5.5.13 Audit Explorer

**Purpose.** The surface specified in §4.4, reachable from Developer Mode.

**Constraints.** Identical to §4.4. Developer Mode MUST NOT relax any constraint there.

---

#### 4.5.5.14 Queue Inspector

**Purpose.** Answer whether the notification and export outboxes are draining.

**Data.** Per queue: depth, oldest item age, throughput over recent windows, failure
count by error class, and dead-letter contents by reference.

**Mutations.** Retry one item. Retry all failed. Discard one item.

**Constraints.** A discard MUST require confirmation naming what will not be delivered,
and MUST be recorded. Discarding a **mandatory** notice MUST be refused.
**RATIONALE:** a mandatory notice exists because the recipient must receive it; a
diagnostic screen must not be able to decide otherwise.

**Acceptance.** Depth matches direct queries. A mandatory notice cannot be discarded. A
discard is recorded with what was dropped.

---

#### 4.5.5.15 OAuth Debugger

**Purpose.** Diagnose provider configuration and callback failures.

**Data.** Per provider: implementation status, credential presence, advertised state,
computed redirect target, recent callback outcomes by failure class, and recent state
issuance and consumption counts.

**Mutations.** Issue a test authorization URL for the developer's own flow.

**Constraints.** MUST NOT display client secrets, authorization codes, or state values.
Failure classes MUST be shown without the underlying token material. MUST NOT be able to
complete a flow as another account.

**Acceptance.** No secret, code or state value renders. A misconfigured provider is shown
as misconfigured with the missing variable named. Test URL issuance uses the real
construction path, including its credential guard.

---

#### 4.5.5.16 Session Viewer

**Purpose.** Answer which sessions exist for an account and end one.

**Data.** Per account, per session: session identifier prefix only, issue time, expiry,
last-seen time, and revocation state. Token version. Suspension state including any
deadline.

**Mutations.** Revoke one session. Revoke all sessions for an account.

**Constraints.**

- MUST NOT display a token, a full session identifier, or anything from which a token
  could be reconstructed.
- A revocation MUST be recorded with actor and target.
- Revoking all sessions for an account MUST be distinguished in the record from revoking
  one, because the former is a forced global sign-out with a support consequence.
- MUST NOT display the account's address or name beyond what the roster already shows.

**Acceptance.** No token material renders. Revocation is recorded, and the two forms are
distinguished. A revoked session is refused on its next request.

---

### 4.5.6 Developer Mode screen design

**Requirements.**

| # | Requirement |
|---|---|
| DS-1 | A single index listing all sixteen tools with a one-line purpose each and a status indicator where the tool has a health dimension. |
| DS-2 | Mutating tools MUST be visually distinguished from read-only tools at the index, not only inside. |
| DS-3 | A persistent banner MUST state that actions in this surface are recorded. |
| DS-4 | Where the owner count is not two, an unmissable banner MUST state the count (E-15). |
| DS-5 | Where maintenance mode is active, a persistent banner MUST state it and offer the exit. |
| DS-6 | Every tool MUST be reachable by keyboard and MUST have a heading structure that permits skipping between tools. |
| DS-7 | Every tool MUST render an explanatory empty state when its subsystem is absent (DM-6). |
| DS-8 | Numeric and tabular data MUST use tabular figures and MUST be sortable where the table exceeds a threshold. |
| DS-9 | No tool may be the only way to perform an operation that a non-developer administrator legitimately needs. |

**RATIONALE for DS-9.** Developer Mode is restricted to one account. An operation
reachable only from it is an operation that stops when that person is unavailable.

### 4.5.7 Alternatives considered

| Alternative | Rejected because |
|---|---|
| Host shell access only | Requires the operator to be at a machine with credentials, which is the situation an incident makes least likely. Also produces no record. |
| A third-party observability platform | Sends personal data to a third party (P-6), and its access model cannot be constrained by this specification. |
| Reachable by any owner | The continuity account must remain a clean recovery path; a mutating surface on it undermines that. |
| Hidden by obscurity, gated only client-side | Not a control. Every endpoint must enforce independently. |
| Arbitrary query or shell tool | DM-9. Makes every other control advisory. |

### 4.5.8 Acceptance criteria for §4.5

| # | Criterion |
|---|---|
| AC-4.5.1 | Every Developer Mode endpoint applies the identity check independently; asserted by static guard and by test with the second owner account. |
| AC-4.5.2 | Absent configuration disables Developer Mode entirely. |
| AC-4.5.3 | No tool renders a credential, token, secret, grant value, message body or evidence content; asserted per tool. |
| AC-4.5.4 | Every mutating tool writes an unsuppressible record. |
| AC-4.5.5 | No arbitrary execution surface exists. |
| AC-4.5.6 | Authorization does not vary by environment. |
| AC-4.5.7 | The Notification Tester cannot target another account. |
| AC-4.5.8 | The API Explorer cannot act as another account, and marks its requests. |
| AC-4.5.9 | The Queue Inspector cannot discard a mandatory notice. |
| AC-4.5.10 | Database Statistics offers no locking operation. |
| AC-4.5.11 | Scheduler pauses expire. |
| AC-4.5.12 | The Capability Inspector calls the kernel and matches it exhaustively. |
| AC-4.5.13 | Every tool degrades to an explanatory empty state. |
| AC-4.5.14 | No operation is reachable only from Developer Mode. |

---

## 4.6 Impersonation

### 4.6.1 Purpose

Permit an owner to see the platform as a specific user sees it, for support, without
creating an untraceable authority.

**Status.** The capability is registered and super-only. The mechanism is not built.
This section specifies it so that it is built correctly or not at all.

### 4.6.2 Requirements

| # | Requirement |
|---|---|
| IP-1 | Gated on the super-only impersonation capability, and additionally restricted to the Developer Mode account (§4.5.3). |
| IP-2 | Step-up MUST be required to begin. |
| IP-3 | Impersonation MUST be **read-only**. No state-changing request may be issued while impersonating. |
| IP-4 | The principal MUST carry both the acting identity and the impersonated identity. Every audit record written during the session MUST name **both**. |
| IP-5 | An unmissable, persistent banner MUST state who is being impersonated and offer exit. |
| IP-6 | A bounded duration MUST apply, after which it ends automatically. |
| IP-7 | Beginning and ending MUST each be recorded. |
| IP-8 | An owner MUST NOT be impersonatable. |
| IP-9 | Message bodies and evidence MUST NOT be readable while impersonating, even where the impersonated account could read them. |
| IP-10 | The impersonated account MUST be notified that it occurred, with the time and the actor. |

**RATIONALE for IP-3.** A writable impersonation produces acts attributable to a person
who did not perform them. That is worse than no support tool: it corrupts the
attribution the entire moderation record depends on.

**RATIONALE for IP-9.** Support questions do not require reading a student's private
messages, and the evidence capability exists precisely to make that read a distinct,
logged act. Impersonation must not become a second path to it.

**RATIONALE for IP-10.** Being viewed as oneself, by staff, without knowing, is a
privacy harm the platform should not inflict silently on a minor.

### 4.6.3 Acceptance criteria for §4.6

| # | Criterion |
|---|---|
| AC-4.6.1 | Impersonation is refused for every principal except the Developer Mode account. |
| AC-4.6.2 | Every state-changing request is refused while impersonating. |
| AC-4.6.3 | Every audit record names both identities. |
| AC-4.6.4 | The banner is present on every screen and offers exit. |
| AC-4.6.5 | The session ends automatically at its bound. |
| AC-4.6.6 | An owner cannot be impersonated. |
| AC-4.6.7 | Messages and evidence are unreadable while impersonating. |
| AC-4.6.8 | The impersonated account is notified. |

---

## 4.7 Organization management

### 4.7.1 Purpose

Represent the organizations that host volunteer work as first-class records, so that
impact can be attributed and partners can be onboarded.

### 4.7.2 Current state

An organization is a free-text affiliation string on an organizer's account. It is not a
record. It cannot be attributed to, corrected centrally, or reported on.

### 4.7.3 Problems

| # | Problem | Consequence |
|---|---|---|
| PO-1 | Free text | "SB Food Pantry", "SB food pantry" and "Example Valley Food Pantry" are three organizations in every report. |
| PO-2 | No record | Impact cannot be attributed to an organization, which is the attribution a partner cares about most. |
| PO-3 | No correction path | A typo is permanent and propagates into every derived figure. |
| PO-4 | No relationship | An organization cannot have several organizers, which is how real organizations work. |

### 4.7.4 Design

**Requirements.**

| # | Requirement |
|---|---|
| OR-1 | An organization is a record with a stable identifier, a canonical name, a type, a locality, an optional public description, and a verification state. |
| OR-2 | An organizer is associated with zero or more organizations. An event is attributed to at most one. |
| OR-3 | The free-text field MUST be retained during migration and MUST be reconciled deliberately, not by automated matching. |
| OR-4 | Creation and verification MUST be gated on moderation authority. An organizer MUST NOT create a verified organization. |
| OR-5 | An organizer MAY propose an organization; the proposal MUST be a pending record conferring nothing until verified. |
| OR-6 | Renaming MUST be recorded and MUST NOT alter historical attribution. |
| OR-7 | Merging MUST be supported, MUST be recorded, and MUST preserve every attributed record. |
| OR-8 | Deleting MUST NOT be supported where any event is attributed. Deactivation MUST be offered instead. |

**RATIONALE for OR-3.** Automated matching on a free-text field silently merges distinct
organizations with similar names and splits identical ones spelled differently. Both
errors then propagate into the impact figures, which are the figures presented to
districts and partners. Reconciliation MUST be a reviewed, recorded act.

**RATIONALE for OR-4.** A verified organization is an assertion the platform makes to
third parties. An organizer asserting it about their own organization is a
self-certification.

### 4.7.5 Acceptance criteria for §4.7

| # | Criterion |
|---|---|
| AC-4.7.1 | An organization is a record with the specified fields. |
| AC-4.7.2 | Verification requires moderation authority. |
| AC-4.7.3 | A proposal confers nothing until verified. |
| AC-4.7.4 | Renaming preserves historical attribution. |
| AC-4.7.5 | Merging preserves every attributed record and is recorded. |
| AC-4.7.6 | Deletion is refused where events are attributed. |
| AC-4.7.7 | Migration retains the original free text for reconciliation. |

---

## 4.8 Analytics architecture

### 4.8.1 Purpose

Produce the figures the Impact Dashboard presents, correctly, from the records that
justify them.

### 4.8.2 INV-025 — Metrics are derived

**INVARIANT.** Every impact metric MUST be derived from source records at query time or
from a **rebuildable** materialisation. A counter incremented on write MUST NOT be the
source of a reported figure.

**RATIONALE.** This is INV-001 generalised. A counter drifts from the events that
produced it after any partial failure, and the drift is undetectable without recomputing
from the events — at which point the counter served no purpose. These figures are
presented to districts, partners and admissions committees; a figure the platform cannot
justify from its own records is worse than no figure.

**Requirements.**

- Where derivation is too slow for interactive use, a materialisation MAY exist. It MUST
  be fully rebuildable from source, MUST record when it was built, and MUST be rebuilt on
  a schedule.
- Any surface displaying a materialised figure MUST display its build time.
- A parity check comparing materialisation to derivation MUST exist and MUST be
  executable on demand.

### 4.8.3 Metric definitions must be single and published

**Requirement.** Every metric MUST have exactly one definition, expressed once, and the
definition MUST be visible to the reader of the figure.

**RATIONALE.** "Volunteer hours" has at least four plausible definitions: hours signed up
for, hours attended, hours confirmed, hours credited. A dashboard reporting one and a
certificate reporting another produces a contradiction that destroys confidence in both.
Publishing the definition beside the figure is what makes the number defensible when
questioned.

**Requirement.** Where a figure excludes something, the exclusion MUST be stated. A
participation rate that silently excludes graduated students is a different figure from
the one its label claims.

### 4.8.4 Time handling

| # | Requirement |
|---|---|
| TM-1 | Every stored timestamp MUST be zone-marked. |
| TM-2 | Aggregation by period MUST use a single declared timezone, stated on the surface. |
| TM-3 | A partial current period MUST be labelled partial, and MUST NOT be compared to complete periods without that label. |
| TM-4 | A period with no data MUST render as zero, not as absent. A gap in a series reads as missing data rather than as no activity. |
| TM-5 | Year-over-year comparison MUST compare equivalent partial periods, not a partial year against complete years. |

**RATIONALE for TM-3 and TM-5.** A dashboard showing this month's partial total beside
last month's complete total appears to show a collapse. Presented to a district, that is
worse than showing nothing.

### 4.8.5 Privacy constraints

| # | Requirement |
|---|---|
| AN-1 | An aggregate MUST NOT be reported where the population is small enough to identify an individual. A minimum cohort size MUST be enforced, and suppressed cells MUST be labelled suppressed rather than shown as zero. |
| AN-2 | A leaderboard or ranking MUST be opt-in, and the opt-in MUST be revocable with immediate effect. |
| AN-3 | A public surface MUST NOT expose an individual's figures without opt-in (§4.11). |
| AN-4 | An organizer's own analytics MUST be scoped to their events. |
| AN-5 | A partner's analytics MUST be scoped to their organization. |
| AN-6 | No analytics surface may disclose a report, an enforcement action, or a message. |

**RATIONALE for AN-1.** "Students volunteering in category X: 1" identifies that student
to anybody who knows the cohort. Suppression must be visible, because a suppressed cell
shown as zero is a false statement.

### 4.8.6 Acceptance criteria for §4.8

| # | Criterion |
|---|---|
| AC-4.8.1 | No reported figure derives from an incremented counter. |
| AC-4.8.2 | Every materialisation is rebuildable and displays its build time. |
| AC-4.8.3 | A parity check exists and is executable. |
| AC-4.8.4 | Every metric has one definition, visible beside the figure. |
| AC-4.8.5 | Every exclusion is stated. |
| AC-4.8.6 | Partial periods are labelled and excluded from complete-period comparison. |
| AC-4.8.7 | Empty periods render as zero. |
| AC-4.8.8 | Cohorts below the minimum are suppressed and labelled. |
| AC-4.8.9 | Ranking is opt-in and revocable immediately. |
| AC-4.8.10 | Organizer and partner analytics are scoped, asserted by test. |

---

## 4.9 The Community Impact Dashboard

### 4.9.1 Purpose

Present the platform's measurable effect on its community, at a standard of rigour that
withstands examination by a school district, a nonprofit partner, or an admissions
committee.

### 4.9.2 Audiences and what each needs

| Audience | Needs | Consequence for design |
|---|---|---|
| Admissions committee | A defensible claim of scope and sustained involvement. | Every figure must be attributable to records; every definition visible. |
| School presentation | Legible in seconds from across a room. | Headline figures large; supporting detail progressive. |
| District demonstration | Evidence of safety and governance, not only volume. | Safety and stewardship metrics are first-class, not hidden. |
| Nonprofit partner | Their own attributed impact. | Organization-scoped views. |
| Investor or funder | Growth, retention and unit economics of engagement. | Trend and cohort views, honestly labelled. |

### 4.9.3 Design principles for this surface

| # | Principle |
|---|---|
| ID-1 | **No vanity metrics.** Every figure must answer a question somebody actually asked. Registered-account counts without activity are excluded. |
| ID-2 | **Definitions visible.** Every figure carries its definition on demand, in the same view. |
| ID-3 | **Honest zero.** An empty platform shows zeros with an explanation, never a placeholder or a sample. |
| ID-4 | **No fabricated data, ever.** Not in a demonstration mode, not as a placeholder, not as a design aid. A screenshot with invented numbers becomes a claim the moment it leaves the room. |
| ID-5 | **Rates beside counts.** A count says something happened; a rate says whether it is working. |
| ID-6 | **Safety is impact.** A platform for minors that reports only volume is reporting the least important half. |
| ID-7 | **Partial periods labelled.** §4.8.4. |
| ID-8 | **Suppression visible.** §4.8.5. |

**RATIONALE for ID-4.** A demonstration mode with realistic invented figures produces a
screenshot indistinguishable from a real one. That screenshot will be shown to a district.
The platform must not manufacture the evidence for a claim about itself.

### 4.9.4 Widget specifications

Each widget states its question, definition, computation, presentation, empty state,
and failure mode.

---

#### W-01 Lifetime volunteer hours

- **Question.** How much service has this platform produced, in total, ever?
- **Definition.** Sum of credited hours across every attendance record marked present.
- **Computation.** Derived (INV-025). Ledger parity verified.
- **Presentation.** Single large figure with unit. Definition on demand.
- **Empty state.** "0 hours credited so far."
- **Failure mode.** Reporting signed-up rather than credited hours inflates the headline
  figure and contradicts every certificate. The definition must be visible for this
  reason.

#### W-02 Students served

- **Question.** How many distinct young people have actually volunteered?
- **Definition.** Distinct accounts with at least one credited attendance record.
- **Computation.** Derived. **Excludes** registered accounts with no credited service,
  and the exclusion is stated.
- **Presentation.** Count, with registered total available as secondary context and
  clearly labelled as a different figure.
- **Empty state.** Zero with explanation.
- **Failure mode.** Reporting registrations as "students served" is the canonical vanity
  metric and is the figure a district is most likely to test.

#### W-03 Events completed

- **Question.** How much volunteer work actually happened?
- **Definition.** Events reaching completed state, distinguished from cancelled and from
  scheduled-but-future.
- **Presentation.** Count with the three states broken out.
- **Failure mode.** Counting scheduled events as delivered.

#### W-04 Organizations served

- **Question.** How many organizations has this platform helped?
- **Definition.** Distinct verified organizations with at least one completed event.
- **Dependency.** §4.7. Until organizations are records, this widget MUST NOT be shown,
  because a free-text count is wrong in both directions.
- **Failure mode.** Counting spelling variants as distinct organizations.

#### W-05 Communities reached

- **Question.** How wide is the geographic footprint?
- **Definition.** Distinct localities with at least one completed event.
- **Privacy.** Locality granularity only. No address, no coordinate, no mapping to an
  individual.
- **Failure mode.** Granularity fine enough to identify a household.

#### W-06 Recurring volunteers

- **Question.** How many students came back?
- **Definition.** Accounts with credited service on two or more distinct events.
- **Presentation.** Count and share of served students.
- **Failure mode.** Counting two shifts at one event as recurrence. The definition is
  distinct events.

#### W-07 Average hours per volunteer

- **Question.** How deep is the typical involvement?
- **Definition.** Credited hours divided by served students. **Median MUST also be
  shown.**
- **RATIONALE.** One student with two hundred hours moves the mean and tells the reader
  nothing about the typical experience. Presenting only the mean is the most common way
  this figure misleads.
- **Failure mode.** Mean alone.

#### W-08 Hours by category

- **Question.** What kind of work is being done?
- **Definition.** Credited hours grouped by event category.
- **Presentation.** Horizontal bars, descending, with a long tail collapsed and
  expandable.
- **Suppression.** Categories below the minimum cohort are aggregated into an explicit
  "other" bucket, labelled.

#### W-09 Hours by organization

- **Question.** Who is this work for?
- **Definition.** Credited hours grouped by attributed organization.
- **Dependency.** §4.7.
- **Scoping.** A partner view shows only their own, with platform total as context.

#### W-10 Hours by month

- **Question.** Is activity growing?
- **Definition.** Credited hours grouped by the month the service occurred, not the month
  it was confirmed.
- **RATIONALE.** Grouping by confirmation date attributes a shift to whenever an organizer
  got round to confirming it, which produces spikes that reflect administrative behaviour
  rather than volunteering.
- **Presentation.** Column series with the current partial month labelled.
- **Empty periods.** Zero, not absent (TM-4).

#### W-11 Year-over-year growth

- **Question.** How does this year compare?
- **Definition.** Credited hours for equivalent periods across years.
- **Requirement.** MUST compare equivalent partials (TM-5). MUST NOT be shown until at
  least two comparable periods exist; before that, it MUST state that the comparison is
  not yet possible rather than showing a misleading figure.

#### W-12 Tag analytics

- **Question.** What skills and interests are being exercised?
- **Definition.** Credited hours and event counts grouped by event tag.
- **Suppression.** Minimum cohort applies.
- **Failure mode.** Tags are organizer-authored free text; near-duplicates must be
  presented as such rather than as distinct, and the widget MUST state that tags are
  uncontrolled.

#### W-13 Participation heatmap

- **Question.** When does volunteering happen?
- **Definition.** Credited hours by day of week and hour of day.
- **Privacy.** Aggregate only. A cell below the minimum cohort MUST be suppressed, because
  a single-occupant cell in a weekly grid identifies an individual's schedule.
- **Accessibility.** MUST have a tabular equivalent; a colour-encoded grid is not
  accessible alone.

#### W-14 Event completion rate

- **Question.** Do events that are posted actually happen?
- **Definition.** Completed events divided by completed plus cancelled. Future events
  excluded, and the exclusion stated.
- **Presentation.** Rate with a plain-language health verdict.
- **RATIONALE for the verdict.** A bare percentage makes staff guess what it means. The
  verdict states whether it warrants attention.

#### W-15 Volunteer retention

- **Question.** Do students stay?
- **Definition.** Of students first serving in a period, the share serving again within a
  defined subsequent window. Cohort-based.
- **Requirement.** The cohort and the window MUST be stated. MUST NOT be shown until a
  full window has elapsed for at least one cohort.
- **Failure mode.** A retention figure computed over an incomplete window understates
  retention and will be quoted.

#### W-16 Acceptance rate

- **Question.** Do students who apply get placed?
- **Definition.** Applications accepted divided by applications resolved. Pending
  excluded, and the exclusion stated.
- **RATIONALE.** This is the platform's fairness metric. A low rate with high signup
  volume means students are being disappointed at scale, which is invisible in every
  volume metric.

#### W-17 Organizer statistics

- **Question.** Who is carrying the programme?
- **Definition.** Per organizer: events hosted, hours enabled, show-up rate.
- **Privacy.** Visible to moderation authority. A public form MUST be opt-in.
- **Presentation.** Ranked, with verification status shown.

#### W-18 Impact cards

- **Question.** What is worth saying about this platform in one sentence?
- **Definition.** A small set of composed statements, each generated from figures above,
  each with its source figures reachable.
- **Requirement.** A card MUST NOT state a claim its source figures do not support, and
  MUST NOT be shown where its sources are suppressed or partial.
- **Requirement.** A card MUST be copyable as text **with** its definitions, so a figure
  quoted elsewhere carries its meaning.

#### W-19 Milestones

- **Question.** What has this platform passed?
- **Definition.** Threshold crossings on the headline figures, with the date each was
  crossed.
- **Requirement.** A milestone MUST be recorded when crossed and MUST NOT be recomputed
  retroactively in a way that changes its date.
- **RATIONALE.** A milestone date that moves when a figure is corrected is not a
  milestone. The crossing is an event.

#### W-20 Trend graphs

- **Question.** Which direction is each headline figure moving?
- **Definition.** Sparkline per headline figure over the retained window.
- **Requirement.** MUST share the axis convention with W-10 so two views of the same data
  cannot appear to disagree.
- **Requirement.** MUST NOT render a trend from fewer than three points.

#### W-21 Safety and stewardship

- **Question.** Is the platform being run responsibly?
- **Definition.** Reports received, share resolved, median time to first moderator
  action, appeals received, share upheld, evidence reads.
- **RATIONALE (ID-6).** This is the widget a district cares about most and the one a
  volume-focused dashboard omits. A platform for minors that cannot report its own
  moderation responsiveness is asking to be taken on trust.
- **Privacy.** Aggregate only. No report, subject, or outcome detail. Suppression applies.
- **Requirement.** MUST be shown even when the figures are unflattering. A metric shown
  only when good is not a metric.

---

### 4.9.5 Layout and progressive disclosure

**Requirements.**

| # | Requirement |
|---|---|
| L-1 | Headline figures (W-01, W-02, W-03, W-05) at the top, legible from a distance. |
| L-2 | Rates (W-14, W-15, W-16) immediately beneath, because they qualify the headlines. |
| L-3 | Safety (W-21) above the fold, not in a lower section. |
| L-4 | Distribution and trend widgets below. |
| L-5 | Every figure's definition reachable without leaving the view. |
| L-6 | A stated "as of" time for the whole surface, and per-widget where a materialisation differs. |
| L-7 | A widget with insufficient data MUST state what it needs, not render empty. |

### 4.9.6 Accessibility

| # | Requirement |
|---|---|
| A-4.1 | Every chart has a tabular equivalent in the accessible tree; the visual is hidden from assistive technology. |
| A-4.2 | Every chart's accessible caption states what is measured, the unit and the period. A caption reused across charts of different units is prohibited. |
| A-4.3 | No figure is conveyed by colour alone; series are distinguishable without colour. |
| A-4.4 | The heatmap has a tabular equivalent (W-13). |
| A-4.5 | Headline figures use semantic headings so the surface is navigable by structure. |
| A-4.6 | Contrast meets the application threshold in both themes, including chart series. |
| A-4.7 | Sparklines are decorative and hidden from assistive technology; their underlying figures are present as text. |
| A-4.8 | Tabular figures use tabular numerals so columns align. |

**FAILURE MODE for A-4.2, realised.** A chart caption hardcoded to describe hours was
reused for a chart counting people, so a screen-reader user was told a count of people
was a quantity of hours. The caption is not decoration: where the visual is hidden, it is
the only description delivered.

### 4.9.7 Performance

| Operation | Budget |
|---|---|
| Whole dashboard, first render | ≤ 1.5 s at the 95th percentile |
| Any single widget query | ≤ 200 ms |
| Materialisation rebuild | ≤ 30 s, off the request path |

**Requirements.**

- The dashboard MUST NOT issue a query per widget where widgets share source data.
- A widget exceeding its budget MUST be materialised rather than tolerated.
- The surface MUST render progressively: headline figures MUST NOT wait on distribution
  widgets.

### 4.9.8 Acceptance criteria for §4.9

| # | Criterion |
|---|---|
| AC-4.9.1 | Every figure derives from records; none from a counter. |
| AC-4.9.2 | Every figure's definition is reachable in-view. |
| AC-4.9.3 | Every exclusion is stated. |
| AC-4.9.4 | No fabricated or sample data exists in any mode. |
| AC-4.9.5 | An empty platform renders zeros with explanations. |
| AC-4.9.6 | W-04 and W-09 are absent until organizations are records. |
| AC-4.9.7 | W-11 and W-15 are absent until their periods permit them, with an explanation. |
| AC-4.9.8 | W-07 shows median as well as mean. |
| AC-4.9.9 | W-10 groups by service date, not confirmation date. |
| AC-4.9.10 | Suppression is applied and labelled in W-08, W-12, W-13, W-21. |
| AC-4.9.11 | W-21 renders unflattering figures. |
| AC-4.9.12 | Every chart has a tabular equivalent and a unit-correct caption. |
| AC-4.9.13 | Partial periods are labelled everywhere they appear. |
| AC-4.9.14 | Impact cards carry definitions when copied. |
| AC-4.9.15 | Milestone dates do not move when figures are corrected. |
| AC-4.9.16 | Budgets in §4.9.7 are measured and recorded. |

---

## 4.10 Growth metrics

### 4.10.1 Purpose

Answer whether the platform is being adopted, separately from whether it is producing
service.

### 4.10.2 Metrics

| Metric | Definition | Failure mode if defined loosely |
|---|---|---|
| Activation rate | Registered accounts reaching first credited service within a window. | Counting registration as activation. |
| Time to first service | Median days from registration to first credited service. | Mean, distorted by outliers. |
| Organizer activation | Approved organizers posting a first event within a window. | Counting approval as activation. |
| Repeat organizer rate | Organizers posting a second event. | |
| Event fill rate | Slots filled divided by slots offered, for completed events. | Including cancelled events, which inflates the rate. |
| Slot utilisation | Credited attendance divided by accepted applications. | Conflating acceptance with attendance. |
| Cohort retention curves | Share of each registration cohort still serving in later periods. | Aggregating cohorts, which hides a declining trend. |

**Requirement.** Every growth metric MUST state its window and its cohort. A growth
figure without them is uninterpretable and will be quoted anyway.

### 4.10.3 Acceptance criteria for §4.10

| # | Criterion |
|---|---|
| AC-4.10.1 | Every metric states window and cohort. |
| AC-4.10.2 | Activation is defined by service, not registration. |
| AC-4.10.3 | Fill rate excludes cancelled events. |
| AC-4.10.4 | Retention is presented by cohort, not aggregated. |

---

## 4.11 Public impact pages

### 4.11.1 Purpose

Permit a shareable, unauthenticated presentation of platform impact, without exposing
individuals.

### 4.11.2 Requirements

| # | Requirement |
|---|---|
| PU-1 | A public page MUST contain **aggregates only**. |
| PU-2 | No individual MUST be identifiable, directly or by cohort size. Suppression applies with a **higher** minimum than internal surfaces. |
| PU-3 | An individual's figures MUST appear only with explicit, revocable opt-in, and revocation MUST take effect immediately including in any cache. |
| PU-4 | An organization's figures MUST appear only with the organization's agreement, recorded. |
| PU-5 | Every figure MUST carry its definition and its "as of" time. |
| PU-6 | The page MUST NOT be indexable where it names any individual, and MUST NOT name any individual under eighteen at all. |
| PU-7 | The page MUST NOT disclose report counts at a granularity that identifies a case. |
| PU-8 | The page MUST be servable under maintenance mode, because it is the surface most likely to be shared while the platform is down. |

**RATIONALE for PU-6.** Volume 0 §0.10 excludes indexable individual profiles. A public
impact page naming a student is that, arrived at from a different direction.

**RATIONALE for PU-3's cache requirement.** An opt-out that persists in a cache is not an
opt-out. The revocation path MUST invalidate any materialisation containing the
individual.

### 4.11.3 Acceptance criteria for §4.11

| # | Criterion |
|---|---|
| AC-4.11.1 | The page contains no individual without opt-in. |
| AC-4.11.2 | No individual under eighteen is named under any circumstance. |
| AC-4.11.3 | Suppression uses the higher public minimum. |
| AC-4.11.4 | Revocation takes effect immediately, including in materialisations. |
| AC-4.11.5 | Every figure carries definition and freshness. |
| AC-4.11.6 | The page is servable under maintenance mode. |

---

## 4.12 Multi-tenancy

### 4.12.1 Purpose

Specify how the platform becomes usable by more than one school or district, so that the
capability is reachable without a rewrite and is not accidentally half-built.

**Status.** Not built. Exactly one implicit tenant exists.

### 4.12.2 Design decision: tenant as a first-class column, introduced before it is needed

**Requirement.** Every table holding tenant-scoped data MUST acquire a tenant reference
**before** a second tenant exists, populated with the single existing tenant.

**RATIONALE.** Adding tenancy to a populated multi-tenant system is a data-classification
exercise with no correct answer for ambiguous rows. Adding it while exactly one tenant
exists is mechanical: every row belongs to that tenant. The window in which this is cheap
closes permanently the moment a second tenant is admitted.

### 4.12.3 INV-024 — No unscoped query

**INVARIANT.** Once tenancy exists, a query against a tenant-scoped table MUST carry a
tenant predicate.

**Requirements.**

- The predicate MUST be applied by a shared mechanism, not by each call site.
- A static guard MUST fail the build on a direct query against a tenant-scoped table
  outside that mechanism.
- The tenant MUST be derived from the authenticated principal, never from a request
  parameter.
  **FAILURE MODE:** a tenant identifier accepted from the client is a cross-tenant read
  waiting to be discovered.
- A cross-tenant read MUST be possible only for an owner, MUST be explicit, and MUST be
  recorded.

### 4.12.4 Scoping rules

| Data class | Scope |
|---|---|
| Users, events, applications, attendance, hours, certificates | Tenant |
| Conversations, messages, reports, evidence, appeals, moderation history | Tenant |
| Organizations | Shared, with per-tenant relationships |
| Legal documents and their versions | Shared |
| Legal acceptances | Tenant, because the acceptor is tenant-scoped |
| Audit records | Tenant, with owner-only cross-tenant read |
| Feature flags | Shared, with per-tenant override |
| Diagnostic events | Shared, with tenant attribution where known |

**Requirement.** A user MUST belong to exactly one tenant. Cross-tenant membership is out
of scope, because it multiplies every authorization decision by a scope question and no
current need requires it.

### 4.12.5 Tenant lifecycle

| # | Requirement |
|---|---|
TN-1 | Creation is owner-only and recorded. |
| TN-2 | A tenant has a canonical name, a locality, an administrative contact, and a state. |
| TN-3 | Suspending a tenant MUST refuse every request from its users with an explanatory refusal, and MUST NOT delete data. |
| TN-4 | Deleting a tenant MUST be a multi-step, recorded operation with an enforced delay and an explicit enumeration of what will be destroyed. |
| TN-5 | Per-tenant configuration MUST be limited to presentation and policy thresholds. It MUST NOT extend to security parameters. |

**RATIONALE for TN-5.** Per-tenant security configuration means the platform's security
posture is whatever the least careful tenant chose, and it multiplies the configurations
that must be tested.

### 4.12.6 Acceptance criteria for §4.12

| # | Criterion |
|---|---|
| AC-4.12.1 | Every tenant-scoped table has a tenant reference, populated, before a second tenant exists. |
| AC-4.12.2 | A direct unscoped query fails the build. |
| AC-4.12.3 | The tenant derives from the principal, never from a parameter. |
| AC-4.12.4 | A cross-tenant read is owner-only, explicit and recorded. |
| AC-4.12.5 | Tenant suspension refuses explanatorily and destroys nothing. |
| AC-4.12.6 | Tenant deletion is delayed, enumerated and recorded. |
| AC-4.12.7 | No security parameter is per-tenant. |

---

## 4.13 Feature flags

### 4.13.1 Purpose

Change behaviour without a release, for staged rollout and for emergency disablement.

### 4.13.2 Requirements

| # | Requirement |
|---|---|
| FF-1 | A flag MUST be declared in a registry with a key, a default, a description, and an owner. |
| FF-2 | A flag read MUST resolve to its default when unset. An unset flag MUST NOT throw or block. |
| FF-3 | Setting a flag MUST be owner-only and recorded with actor, old value, new value and reason. |
| FF-4 | Flags MUST NOT gate a security control. A control that can be flagged off is not a control. |
| FF-5 | Flags MUST NOT gate a legal obligation: consent capture, mandatory notices, retention, audit writing. |
| FF-6 | A flag MUST have a declared removal condition, and a flag past its condition MUST be reported as stale. |
| FF-7 | Flag state MUST be visible in Developer Mode with the code paths that read it. |
| FF-8 | A flag MUST NOT be read on a hot path without caching, and the cache MUST invalidate on set. |
| FF-9 | Every flag's effect MUST be tested in **both** states. |

**RATIONALE for FF-4 and FF-5.** A flag is an unaudited configuration change with
immediate effect. Placing a security control or a legal obligation behind one means the
platform's compliance posture is a runtime variable that one mis-click alters.

**RATIONALE for FF-6.** Flags accumulate. A codebase with forty flags has 2⁴⁰ nominal
configurations and no test coverage of almost all of them. The removal condition makes a
flag a temporary structure by construction.

**RATIONALE for FF-9.** An untested flag state is dead code that will be enabled during
an incident, which is the worst moment to discover it does not work.

### 4.13.3 Acceptance criteria for §4.13

| # | Criterion |
|---|---|
| AC-4.13.1 | Every flag is registered with default, description and owner. |
| AC-4.13.2 | An unset flag resolves to its default without error. |
| AC-4.13.3 | Setting is owner-only and recorded with both values. |
| AC-4.13.4 | No flag gates a security control or legal obligation; asserted by review of the registry. |
| AC-4.13.5 | Every flag has a removal condition; stale flags are reported. |
| AC-4.13.6 | Both states of every flag are tested. |

---

## 4.14 Maintenance mode

### 4.14.1 Purpose

Take the platform out of service deliberately, telling users the truth.

### 4.14.2 Requirements

| # | Requirement |
|---|---|
| MM-1 | Enabling is owner-only, recorded, and requires a stated reason and expected duration. |
| MM-2 | The maintenance presentation MUST be a takeover (INV-016) and MUST state the reason, the expected return, and that no data has been lost. |
| MM-3 | The health endpoint MUST remain available and MUST report maintenance state distinctly from unhealthy. |
| MM-4 | Public impact pages MUST remain servable (PU-8). |
| MM-5 | Legal documents MUST remain servable. A person cannot be asked to rely on a policy they cannot read. |
| MM-6 | Developer Mode MUST remain reachable for the developer account. |
| MM-7 | Background workers MUST continue unless explicitly paused, because draining a queue during maintenance is frequently the purpose. |
| MM-8 | An expected duration MUST be enforced as a warning: past it, Developer Mode MUST report that maintenance has overrun. |
| MM-9 | Enabling MUST NOT terminate sessions. Users MUST return to their prior state. |
| MM-10 | A scheduled maintenance window SHOULD be announced in advance through the notification channel. |

**RATIONALE for MM-3.** A monitoring system that cannot distinguish maintenance from an
outage will page during planned work, which trains the operator to ignore pages.

**RATIONALE for MM-9.** Terminating sessions converts a ten-minute maintenance window
into a platform-wide forced sign-out, with a support cost far exceeding the maintenance.

### 4.14.3 Acceptance criteria for §4.14

| # | Criterion |
|---|---|
| AC-4.14.1 | Enabling is owner-only, recorded, and requires reason and duration. |
| AC-4.14.2 | The presentation is a takeover stating reason, return and data safety. |
| AC-4.14.3 | Health reports maintenance distinctly from unhealthy. |
| AC-4.14.4 | Public pages, legal documents and Developer Mode remain available. |
| AC-4.14.5 | Sessions survive. |
| AC-4.14.6 | Overrun is reported. |

---

## 4.15 Emergency controls

### 4.15.1 Purpose

Provide the smallest set of immediate actions that contain an active incident, each
recorded, each reversible where reversal is meaningful.

### 4.15.2 The controls

| # | Control | Effect | Reversible |
|---|---|---|---|
| EC-1 | Maintenance mode | §4.14 | Yes |
| EC-2 | Disable a provider | That provider stops being advertised and refuses URL construction | Yes |
| EC-3 | Disable registration | New accounts cannot be created; existing users unaffected | Yes |
| EC-4 | Disable messaging | No new messages platform-wide; history readable | Yes |
| EC-5 | Global session revocation | Every session ends | No — sessions are gone |
| EC-6 | Pause a worker or scheduler | Bounded, auto-expiring (§4.5.5.1) | Yes |
| EC-7 | Freeze an account | Sessions ended and refused, without the suspension record | Yes |

**Requirements.**

- Every control MUST be owner-only, MUST require a stated reason, and MUST be recorded
  before it takes effect.
- Every control MUST state, in its confirmation, exactly who is affected and what they
  will see.
- Every reversible control MUST be reversible from the same surface.
- Every control MUST have a corresponding host-level procedure, in case the surface is
  the thing that is broken.

**RATIONALE for EC-7 existing separately from suspension.** A suspension is a moderation
decision with a reason shown to the subject, an appeal token, and a permanent record. An
incident sometimes requires stopping an account **immediately** without asserting a
moderation finding — a suspected compromise, for instance, where the account holder has
done nothing wrong. Using suspension for that places a disciplinary record on an innocent
person and sends them a notice accusing them. A freeze is the honest instrument, and its
notice MUST say that access has been paused pending investigation and that no finding has
been made.

**Requirement.** A freeze MUST have a bounded duration after which it must be renewed or
released, and Developer Mode MUST report frozen accounts and their ages.
**RATIONALE:** an unbounded freeze is a suspension without a record, which is the thing
the freeze exists to avoid becoming.

### 4.15.3 Acceptance criteria for §4.15

| # | Criterion |
|---|---|
| AC-4.15.1 | Every control is owner-only, requires a reason, and is recorded before effect. |
| AC-4.15.2 | Every confirmation names who is affected and what they will see. |
| AC-4.15.3 | Every reversible control is reversible from the same surface. |
| AC-4.15.4 | Every control has a documented host-level equivalent. |
| AC-4.15.5 | A freeze creates no moderation record and its notice asserts no finding. |
| AC-4.15.6 | A freeze is bounded and reported with its age. |

---

## 4.16 Volume IV acceptance summary

Volume IV is satisfied when:

- Every acceptance criterion in §§4.1.7, 4.2.9, 4.3.6, 4.4.6, 4.5.8, 4.6.3, 4.7.5,
  4.8.6, 4.9.8, 4.10.3, 4.11.3, 4.12.6, 4.13.3, 4.14.3 and 4.15.3 holds.
- INV-008, INV-009, INV-022, INV-024 and INV-025 are each enforced by a build-failing
  test observed to fail against an introduced violation.
- Every edge case E-1 to E-15 has a test.
- Every Developer Mode tool satisfies DM-1 to DM-9, asserted per tool.
- No widget presents a figure the platform cannot justify from its records.

**Cross-references.** Volume II §2.10 specifies the security properties of the ownership
model defined here. Volume III §3.9 specifies the trails the Audit Explorer reads.
Volume V §5.6 specifies the workers the Scheduler and Queue inspectors observe. Volume VI
sequences the phases that build each unbuilt subsystem here.
