# Super Admin & Ownership — Security Design Review

**Date:** 2026-08-06
**Reviews:** Volume IV §4.1–§4.3 (ownership, administrator management, invitations)
**Status:** Design review. Nothing implemented. Blocking questions in §9.

---

## 1. Measured starting state

Every fact below was measured, not assumed. Two of them change the design materially.

| # | Fact | Consequence |
|---|---|---|
| SA-1 | **Zero accounts hold `super_admin`.** Role distribution is 1 admin, 2 organizers, 12 students | INV-009 ("exactly two owner accounts") is **currently violated with a count of zero**. Ownership does not exist yet |
| SA-2 | **No mechanism creates a `super_admin`.** The only promotion script is hardcoded to `admin` | Consistent with INV-008 — but it means the two owner accounts cannot be created by any supported path |
| SA-3 | The promotion script writes **no audit record** and uses **no database-safety wrapper** | Every role change made today is unattributable |
| SA-4 | No route accepts a role as a writable parameter | INV-008 is currently true **by absence of feature**, not by rule |
| SA-5 | The wildcard resolves every capability; five capabilities are declared super-only | Any capability gate placed on an owner passes. Constraint must be structural |
| SA-6 | Suspension target rules already refuse self-suspension and require owner-only administration capability to suspend a capability-holder | Partial ownership protection already exists, expressed as capabilities rather than roles — correctly |

**The central finding: ownership has a bootstrap problem the specification does not
address.** INV-009 requires exactly two owner accounts. INV-008 forbids any request path
from creating one. No path exists. Therefore the two accounts can only come into
existence through direct database modification — which produces no record, uses no
safety wrapper, and is exactly the class of action the audit trail exists to capture.

Volume IV §4.1 specifies what owners may do and what may not be done to them. **It never
specifies how they come to exist.** That is the gap this review closes.

---

## 2. Ownership

### 2.1 Who are the immutable Super Admins

Two accounts, fixed at two.

| # | Account | Purpose | Routine use |
|---|---|---|---|
| **O-1** | The named principal owner (Mahit) | Platform administration, development, Developer Mode | Yes |
| **O-2** | The WeVolunteer master account | Continuity and recovery | **No** |

**Why exactly two.** One is a single point of failure: credential loss, incapacity or
compromise ends platform administration with no remedy short of host access. Each
additional wildcard holder is an additional account whose compromise is unbounded and
whose actions no permission check can constrain. Two is the smallest number providing
continuity.

**O-2 is not a shared account.** It is a distinct identity with its own credential, held
by the same person, used only when O-1 is unavailable. This distinction matters for
attribution: an action by O-2 must be distinguishable from an action by O-1 in the audit
trail, which is impossible if they share a credential.

### 2.2 How they are created

**This is the design decision the specification is missing.** Three options were
considered.

| Option | Mechanism | Verdict |
|---|---|---|
| **A** | An application route, owner-gated | **Rejected.** Violates INV-008 directly. Creates the mechanism the invariant exists to deny, and a mechanism that exists will eventually be reachable |
| **B** | A migration that inserts the two accounts | **Rejected.** Bakes credentials or account identifiers into version-controlled source, and re-runs against every environment including development |
| **C** | **A host-level bootstrap command, single-use, unconditionally audited** | **Chosen** |

**Chosen design — the bootstrap command.**

| # | Requirement |
|---|---|
| BS-1 | Executable **only from a host shell**. Not reachable over the network by any credential |
| BS-2 | Refuses to run if the owner count is already **2** |
| BS-3 | Promotes an **existing, verified, active** account. It MUST NOT create an account, because account creation carries consent capture that cannot be performed on somebody's behalf |
| BS-4 | Requires an explicit confirmation naming the target address and stating that the change is irreversible through the application |
| BS-5 | Writes an audit record **unconditionally**, naming the operator as recorded at invocation, the target, and the reason. The write is not suppressible by any flag |
| BS-6 | Uses the database-safety wrapper that other destructive tools use |
| BS-7 | Refuses if the target already holds the role |
| BS-8 | Increments the target's token version, so the change takes effect on the next request and the holder signs in deliberately |
| BS-9 | Prints the resulting owner count and refuses to exit successfully if it is not the expected value |

**RATIONALE for BS-3.** Creating an account on somebody's behalf accepts the legal
agreements for them. The specification treats an acceptance record as evidentiary; a
forged one is worse than none.

**RATIONALE for BS-2.** Without it, the command *is* the mechanism INV-008 forbids —
merely one requiring host access. Bounding it at two makes it a bootstrap rather than an
escape hatch.

### 2.3 How they are stored

**Decision: as a role value on the account row, exactly as every other role.**

Alternatives considered and rejected:

| Alternative | Rejected because |
|---|---|
| A configuration-declared owner list | Makes ownership unauditable from the database, creates a second source of truth for identity, and moves ownership into a file a deployment mistake can rewrite |
| A separate `owners` table | The capability kernel resolves from role. A second source would require every decision to consult two places — the drift the kernel exists to prevent |
| An attribute alongside the role | Same objection |

**Consequence accepted.** Because ownership is a role value, anybody with database access
can set it. That is true of every security property in an embedded-database system and is
addressed operationally (§8), not structurally.

### 2.4 Can they be deleted

**No.** Enforced by absence of mechanism at four points:

| # | Path | Enforcement |
|---|---|---|
| D-1 | Self-service account deletion | Deletion path refuses an immutable role |
| D-2 | Administrative deletion | No such route exists, and none may be added |
| D-3 | Retention purge | Operates only on accounts in the deleted state, which D-1 and D-2 prevent |
| D-4 | Referential cascade | No foreign key cascade reaches an account row |

**Requirement.** The refusal message MUST state that the account is an owner account and
that ownership is not administrable through the application. It MUST NOT imply that a
more privileged principal could do it, because none can.

### 2.5 Can they be transferred

**No — and this is a deliberate narrowing of what "transfer" usually means.**

There is no operation that moves ownership from one account to another. What exists is:

| Need | Mechanism |
|---|---|
| The owner's address changes | Change the address on the **existing** account. Ownership is a property of the account, not the address |
| The owner's credential is lost | Break-glass credential reset (§7). The account is unchanged |
| The person changes | **Bootstrap a new owner account, then retire the old one via the same host-level command.** Two operations, both host-level, both audited, and never leaving the count outside {1, 2, 3} momentarily |

**Requirement.** The retirement half of BS must exist for the "person changes" case, and
MUST refuse to reduce the count below **1**.

**RATIONALE for allowing 1 momentarily but not 0.** A transfer sequence that must pass
through zero owners has a window in which the platform has no owner. Requiring the new
owner to be added *before* the old is removed makes the sequence 2 → 3 → 2 rather than
2 → 1 → 2, and the transient 3 is safer than a transient 0. The boot check warns at 3;
that warning is correct and expected during a transfer.

### 2.6 What happens if both accounts are lost

Three distinct scenarios with different remedies. The specification currently treats them
as one.

| # | Scenario | Remedy |
|---|---|---|
| L-1 | **Credentials lost, accounts intact** | Break-glass credential reset (§7). Restores access without altering the role |
| L-2 | **One account compromised** | Rotate the signing secret (ends every session platform-wide), reset that owner's credential, enumerate every action by that account across the suspected window, reverse what is reversible, record what is not |
| L-3 | **Both accounts destroyed at the database level** | Restore from backup, then bootstrap. **This is the scenario that makes the restore drill a launch blocker** |

**Requirement.** All three procedures must be runbooks with dated drill records. None
currently has one.

---

## 3. Admin management

### 3.1 Create admin

**Not an operation.** There is no "create admin" that produces an account. There are two
paths that produce an administrator:

- **Promote an existing account** (§3.3)
- **Invite an address that has no account** (§4)

**RATIONALE.** Creating an account on somebody's behalf forges a consent record (§2.2
BS-3). The same objection applies here and is the reason the operation does not exist.

### 3.2 Invite admin

§4.

### 3.3 Promote existing account

| # | Requirement |
|---|---|
| P-1 | Gated on the super-only administration capability. **Ungrantable**, so an administrator can never promote another |
| P-2 | Target must be existing, active, **verified**, not already an administrator, not an owner |
| P-3 | A reason is required, meeting a minimum length, and is recorded permanently |
| P-4 | **Step-up re-authentication required.** Registered as a sensitive action, gated and spent inside the handler's transaction |
| P-5 | Role change, metadata, audit record, token-version increment and notice are **one transaction** |
| P-6 | The notice states what the role permits, **explicitly including that it permits reading reported private messages**, and what is expected |
| P-7 | Every refusal is answered **before** the step-up grant is spent |

**RATIONALE for P-1's ungrantability.** Administrator authority includes reading
students' private messages under a grantable capability. If administrators could promote,
the set of people with that reach would grow without ownership's involvement, and the
audit answer to "who authorised this" would be another administrator, recursively.

**RATIONALE for P-6.** An administrator who does not know their role includes reading
private messages will read them casually. The notice is the first and best moment to
establish that it is a logged, exceptional act.

### 3.4 Revoke admin

| # | Requirement |
|---|---|
| RV-1 | Same capability, same step-up |
| RV-2 | An owner target is refused |
| RV-3 | A reason is recorded |
| RV-4 | **Every capability grant on that account is revoked in the same transaction** |
| RV-5 | Reports assigned to the account are **unassigned**, recorded |
| RV-6 | Appeals claimed by the account are **released**, recorded |
| RV-7 | Every decision, audit entry and history entry is **retained** |
| RV-8 | Token version incremented; subject notified |

**RATIONALE for RV-4.** Without it, revoking the role leaves granted capabilities in
place. The account would retain evidence-reading by grant after losing it by role — the
precise inverse of the intent, and invisible on any surface that does not display grants.

**RATIONALE for RV-5 and RV-6.** An assignment to a revoked account is work that will
never be done, sitting in a queue reporting it as assigned. The oldest-first ordering then
hides it behind the assignment rather than surfacing it as unworked.

**RATIONALE for RV-7.** A former administrator's decisions remain the decisions that were
made. Removing them rewrites the moderation record, which is the one record that must be
stable.

### 3.5 Restore admin

**Decision: there is no distinct "restore" operation. Restoration is promotion.**

| Consideration | Resolution |
|---|---|
| Should a revoked administrator be re-promotable? | **Yes**, through the ordinary promotion path |
| Should prior grants be restored? | **No.** They were revoked deliberately (RV-4). Re-granting is a separate decision requiring its own record |
| Should prior assignments be restored? | **No.** They were released and may have been reassigned |
| Should the history show a re-promotion distinctly? | **Yes** — the audit trail shows promote → revoke → promote, which is the honest record |

**RATIONALE.** A "restore" that reinstates prior grants and assignments would re-establish
authority that was deliberately removed, on the strength of a single action whose record
reads as a lesser act than the original promotion.

### 3.6 The constraints, restated as tests

| # | Constraint | Verified by |
|---|---|---|
| C-1 | Cannot create super admins | No route accepts the role; static guard asserts it appears in no writable enumeration |
| C-2 | Cannot modify super admins | Promotion, revocation, suspension, warning, withholding and deletion each refuse an owner target — **asserted with an owner as the actor**, because an administrator actor is refused by an ordinary rule and proves nothing |
| C-3 | Every action audited | Transactional audit on promote, revoke, invite, accept, revoke-invitation |
| C-4 | Reversible where appropriate | Promotion ↔ revocation. Bootstrap is **not** reversible through the application, by design |

---

## 4. Pending admin invitations

### 4.1 The two cases

**Case A — the address already has an account.**

→ **Promote immediately** via §3.3. No invitation is created.

**Requirement.** The invitation surface MUST detect this and route to promotion rather
than creating a pending record. Two mechanisms for the same outcome would produce
ambiguity about which is authoritative.

**Requirement.** The target must still be **verified**. An unverified account with a
matching address has not proved control of it.

**Case B — the address has no account.**

→ **Create a pending invitation.** On signup with that address, apply the role.

### 4.2 Why an invitation is a record of intent, not a grant

An invitation confers **nothing** until accepted. It is not a credential, not a session,
not a capability. The alternatives are all defective:

| Shortcut | Defect |
|---|---|
| Create the account on their behalf | Forges a consent record |
| Promote on first registration by address match, with no invitation record | An address is not identity. Whoever registers with it becomes an administrator, and nothing records that this was intended |
| Share a credential | Destroys attribution for every act taken |

### 4.3 Requirements

| # | Requirement |
|---|---|
| I-1 | Creation is owner-only and step-up gated |
| I-2 | Records address, intended role, inviting owner, reason, creation time, expiry |
| I-3 | Token is random, **stored as a hash**, single-use, expiring |
| I-4 | Token is **delivered to the invited address and never shown to the inviter** |
| I-5 | Confers no account, session or capability before acceptance |
| I-6 | Acceptance requires registering or signing in as that address, **verifying it**, and accepting the applicable legal agreements |
| I-7 | Acceptance binds to the **verified address**, not to whoever holds the token |
| I-8 | Acceptance is one transaction: consume token, assign role, audit, increment token version, notify |
| I-9 | Revocable while pending, recorded |
| I-10 | An expired invitation is refused with a distinct internal code and is **not silently renewable** |
| I-11 | An address already holding the role is refused |
| I-12 | An owner's address is refused |
| I-13 | **At most one pending invitation per address.** A second replaces the first and records the replacement |
| I-14 | Pending list visible to owners: address, role, inviter, age, expiry |
| I-15 | Acceptance is refused if the inviting owner's authority has since been removed — currently impossible, but checked so the property survives a future change |

**RATIONALE for I-4.** An inviter who retains the token can accept the invitation
themselves from an address they control, defeating I-7. Delivery-only is what makes the
address binding meaningful.

**RATIONALE for I-13.** Multiple pending invitations for one address make revocation
ambiguous: revoking one leaves the others live, and no interface can show which is
authoritative.

### 4.4 Expiration

**Chosen: 7 days, non-renewable.**

| Consideration | Resolution |
|---|---|
| Why bounded at all? | A live invitation is administrator authority awaiting collection. An indefinite one is a permanent liability in a mailbox |
| Why 7 days? | Long enough for somebody to act in an ordinary week; short enough that a forgotten invitation lapses before it is forgotten about |
| Renewable? | **No.** Issue a new one, which produces a new record and a new decision. Renewal makes the original creation decision indefinitely extensible |
| What happens at expiry? | The record moves to `expired` and remains visible in the pending list for a period, so an owner can see that an invitation lapsed rather than finding it absent |

### 4.5 Cancellation

| # | Requirement |
|---|---|
| CX-1 | An owner may revoke any pending invitation |
| CX-2 | Revocation is recorded with actor and reason |
| CX-3 | Revocation is **immediate**: a token presented afterwards is refused identically to one that never existed |
| CX-4 | The invited party is **not** notified of revocation |

**RATIONALE for CX-4.** Notifying somebody that authority they never accepted has been
withdrawn discloses that it was contemplated. Where an owner wants to communicate, they
can; the platform should not do it automatically.

### 4.6 Audit events

| Event | When | Actor | Subject | Detail |
|---|---|---|---|---|
| `ADMIN_INVITED` | Invitation created | Inviting owner | Invited address | Role, reason, expiry |
| `ADMIN_INVITATION_REVOKED` | Revoked while pending | Owner | Invited address | Reason |
| `ADMIN_INVITATION_EXPIRED` | Lapsed | System | Invited address | — |
| `ADMIN_INVITATION_ACCEPTED` | Accepted | The accepting account | The accepting account | Which invitation; the inviting owner |
| `ADMIN_PROMOTED` | Promotion (either path) | Owner, or system on acceptance | Promoted account | Reason; whether by invitation or direct |
| `ADMIN_REVOKED` | Revocation | Owner | Revoked account | Reason; grants revoked; assignments released |
| `OWNER_BOOTSTRAPPED` | Bootstrap command | Operator as recorded | The new owner | Reason; resulting count |
| `OWNER_RETIRED` | Retirement command | Operator as recorded | The retired owner | Reason; resulting count |

**Requirement.** The subject of an invitation event is an **address**, not an account
identifier, because no account may exist. The audit trail's subject column is a foreign
key to accounts, so invitation events MUST record the address in the detail and leave the
subject null — and Appendix D must state this, because a null subject otherwise reads as
a defect.

### 4.7 Abuse prevention

| # | Vector | Control |
|---|---|---|
| AB-1 | Inviter retains the token and self-accepts | I-4 delivery-only; I-7 verified-address binding |
| AB-2 | Intercepted mail confers authority | I-6 requires verification of the address — the interceptor must control the mailbox, the same exposure as password reset |
| AB-3 | Probing for live invitations | **Every failure cause returns an identical response**: never existed, expired, already used, wrong address |
| AB-4 | Invitation spam to arbitrary addresses | Rate-limit creation per owner; the pending list makes volume visible; only two accounts can create them |
| AB-5 | Invitation to an address the inviter controls, to create a second identity | Not preventable, and not a meaningful escalation: an owner already holds the wildcard. Recorded as accepted residual risk |
| AB-6 | Race between two invitations for one address | I-13 one-pending-per-address, enforced by a **unique constraint**, not only by lookup |
| AB-7 | Acceptance after the inviter's authority is removed | I-15 |
| AB-8 | Token brute force | Random token of sufficient length, stored hashed, rate-limited acceptance, uniform failure response |

---

## 5. Findings against Volume IV

| # | Finding | Severity | Action |
|---|---|---|---|
| F-1 | **Volume IV never specifies how owner accounts are created.** With zero owners today and no mechanism, ownership cannot be established | **High** | Add §2.2 bootstrap to Volume IV §4.1 |
| F-2 | **Volume IV has no owner retirement operation**, so the "person changes" case has no path | **High** | Add §2.5 retirement |
| F-3 | The promotion script writes no audit record and uses no safety wrapper | **Medium** | Either bring it under the safety wrapper with auditing, or delete it in favour of the promotion route once that exists |
| F-4 | Volume IV's edge case E-14/E-15 treat counts of 1 and 0 as warnings. **Zero is the current state**, so the warning fires on every boot from day one | **Medium** | Correct: a warning that fires always is ignored always. The bootstrap must run before the check is meaningful |
| F-5 | Invitation audit events have no valid subject account | **Medium** | Specify null subject with address in detail (§4.6) |
| F-6 | The specification does not state that O-2 must not share a credential or a recovery channel with O-1 in the *design* section — only in the operational one | **Low** | Restate in §4.1 |

---

## 6. Threat model

| # | Threat | Control | Residual |
|---|---|---|---|
| T-1 | Ownership seizure through the application | No mechanism accepts the role; static guard | Host access. Bounded by audit and by §8 |
| T-2 | Ownership seizure through the bootstrap command | Host access required; refuses above 2; unconditionally audited | An operator with host access is unbounded. This is true of any embedded-database system |
| T-3 | Administrator promotes another administrator | Super-only, ungrantable capability | An owner compromise, which is unbounded regardless |
| T-4 | Revoked administrator retains reach via grants | RV-4 revokes in the same transaction | None material |
| T-5 | Invitation intercepted | Verified-address binding | Mailbox compromise |
| T-6 | Live invitations enumerated | Uniform failure responses | Timing; out of scope for this class |
| T-7 | Owner acts under coercion | Step-up does not defend against a present coercer | Recorded; roster and explorer make it visible |
| T-8 | **Retaliatory revocation** — an owner revokes an administrator who is investigating them | RV-7 retains their decisions; the revocation is recorded | **Present and unmitigable within a two-owner model.** Must be recorded in launch readiness |
| T-9 | Owner account compromised | §2.6 L-2 | Bounded by detection speed, which depends on the audit explorer existing |

**T-8 and T-9 both argue for the Audit Log Explorer preceding administrator management** —
which is the sequencing `NEXT_MILESTONE_DECISION.md` independently recommends.

---

## 7. Break-glass interaction

The bootstrap command and break-glass credential reset are **different operations** and
must not be merged.

| | Bootstrap | Credential reset |
|---|---|---|
| Changes the role | **Yes** | **No** |
| Refuses if target is not already an owner | No — that is its purpose | **Yes** |
| Bounded by owner count | Yes, at 2 | No |
| Audited | Unconditionally | Unconditionally |

**Requirement.** The credential reset MUST refuse to run against an account that does not
already hold the owner role. It restores access to an existing owner; it does not create
one. Merging the two would give the recovery procedure the power to mint ownership.

---

## 8. Operational requirements

| # | Requirement |
|---|---|
| OP-1 | Each owner account has a unique credential shared with nobody |
| OP-2 | Multi-factor authentication at the identity provider where one is used |
| OP-3 | **The two accounts do not share a recovery channel.** A single compromised mailbox must not reach both |
| OP-4 | O-2 is not used for routine work |
| OP-5 | Owner credentials appear in no repository, no host environment beyond what the process needs, and no documentation |
| OP-6 | A quarterly review confirms the count is exactly two and both are intended, recorded |
| OP-7 | The bootstrap and retirement commands are documented as runbooks with dated drill records |

---

## 9. Blocking questions

Cannot be resolved by design. Each needs an owner decision before implementation.

| # | Question | Why it blocks |
|---|---|---|
| Q-1 | **What are the two owner identities?** Specifically the address for O-2 | Bootstrap cannot run without them, and OP-3 requires the recovery channels to be independent |
| Q-2 | **Should the bootstrap command be built now, or should ownership be established by direct database modification once and documented?** | The command is a permanent, audited mechanism; a one-off is faster and unrecorded. Recommendation: **build the command**, because F-2 means retirement will be needed eventually and the one-off leaves no record of the platform's most consequential change |
| Q-3 | **Invitation expiry: is 7 days right for this institution?** | A school's response cadence may differ |
| Q-4 | **Should `ADMIN_INVITATION_EXPIRED` be written by a sweep, or computed on read?** | A sweep is another scheduled job; computing on read means no event exists to audit. Recommendation: **compute on read, audit nothing** — expiry is the absence of action, not an action |
| Q-5 | **Does T-8 (retaliatory revocation) need a structural control?** | It is unmitigable in a two-owner model. Options: accept and record, or require a second owner's concurrence for revocation — which is unavailable when one person holds both accounts |

---

## 10. Recommendation

**The ownership design in Volume IV is sound but incomplete.** Its prohibitions are
correct and correctly reasoned. Its omission is that it specifies a system with exactly
two owner accounts without specifying how those accounts come to exist — and the measured
state is zero.

**Approve §2.2 (bootstrap) and §2.5 (retirement) as amendments to Volume IV §4.1** before
any ownership work begins. Without them, the first implementation attempt will either
invent a mechanism that violates INV-008, or establish ownership by unrecorded database
modification.

**Do not build administrator management before the Audit Log Explorer.** T-8 and T-9 both
depend on the trail being readable for detection, and both concern the exact authority
administrator management creates.
