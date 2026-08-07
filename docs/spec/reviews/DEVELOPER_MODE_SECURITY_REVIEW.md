# Developer Mode — Security Review

**Date:** 2026-08-06
**Reviews:** Volume IV §4.5 (sixteen tools), §4.15 (emergency controls)
**Status:** Security review. **Nothing implemented. Recommendation is to defer.**

---

## 1. Summary and headline recommendation

Developer Mode concentrates platform-wide observation and mutation authority into a
single account. That concentration is the point — a one-operator platform needs it — and
it is also the largest single risk any proposed feature carries.

**Recommendation: build it in two stages separated by a decision point, and defer the
second stage until the first has been in use.**

| Stage | Contents | Recommendation |
|---|---|---|
| **DM-1** | Shell, access control, nine read-only tools | Build after ownership enforcement (Volume VI P-08) |
| **DM-2** | Seven mutating tools, seven emergency controls | **Defer.** Revisit only after DM-1 has been used in a real incident |

**Reasoning for deferring DM-2.** Every mutating tool in it has a host-level equivalent
that already exists and is already audited by the operating system. The tools buy
convenience during an incident; they cost a permanent, network-reachable mutation surface
on one account. Until DM-1 has been used and the specific convenience gaps are known from
experience, the trade cannot be assessed — and building it speculatively means building
the largest-risk surface on the platform against a guess.

**Three findings below are blocking regardless of staging:** §2.3 (identification),
§3.2 (compromise), §6.1 (the notification tester).

---

## 2. How is the account identified?

### 2.1 The requirement

Volume IV §4.5.3 (INV-022) requires Developer Mode reachable by **exactly one** account —
the named principal owner — enforced server-side per endpoint, by an explicit identity
check **in addition to** the owner capability.

**Why the capability is insufficient.** The second owner account holds the wildcard and
satisfies any capability requirement. Restricting to one account keeps the continuity
account a clean recovery path: an account that cannot alter runtime state is an account
whose compromise has a smaller blast radius.

### 2.2 Identification options

| Option | Assessment |
|---|---|
| **Email address** | **Rejected.** §2.3 |
| **Account identifier** | **Chosen.** Immutable for the account's lifetime, meaningless if leaked, changeable only by the bootstrap path |
| Username | Rejected. Mutable; the platform has a username-change endpoint |
| A dedicated database flag | Rejected. A second source of truth for a property already derivable, and a writable column is a target |
| A configuration secret the operator supplies per session | Rejected. Becomes a second credential to manage, and a shared one if ever written down |

**Decision: a configured account identifier**, supplied by environment configuration, not
a source literal.

| # | Requirement |
|---|---|
| ID-1 | The identifier comes from environment configuration, never from source |
| ID-2 | **Absent configuration disables Developer Mode entirely**, rather than opening it |
| ID-3 | The configured identifier MUST also hold the owner role. Both conditions, checked independently |
| ID-4 | A configured identifier naming a non-existent, deleted or suspended account disables the surface and logs a boot warning |
| ID-5 | Every endpoint applies the check **independently**. A shared prefix guard is insufficient — a route registered outside the prefix by mistake would be unguarded |
| ID-6 | A static guard asserts every Developer Mode route applies the check, deriving the route set from the router stack |

**RATIONALE for ID-2.** A misconfiguration that opens a debugging surface is worse than
one that closes it. The failure mode must be unavailability, not exposure.

**RATIONALE for ID-5.** This is the failure that has already occurred elsewhere in this
repository, in a different form: a route declared outside the pattern its guard assumed.
A per-route check plus a derived guard is the only combination that survives a route being
added carelessly.

### 2.3 What happens if the email changes — **blocking finding**

**If Developer Mode were keyed on email address, an email change would either silently
disable it or silently transfer it.** Both are unacceptable:

- Silent disablement: the operator loses their diagnostic surface during the change,
  discovering it at the next incident.
- Silent transfer: whoever ends up with the old address gains the surface. The platform
  has an email-change endpoint and addresses in school domains are reassigned.

**Resolution.** Keying on the account identifier makes an email change a non-event.
Developer Mode follows the account, which is the correct semantics: the surface belongs to
the person, and the person is the account.

**Requirement.** The specification must state this explicitly, because "identify Mahit's
account" reads naturally as "by email" and that is the wrong answer.

**Corollary requirement.** An email change on the Developer Mode account MUST write an
audit record and SHOULD produce a notice to the account's prior address, for the same
reason any credential-adjacent change does.

### 2.4 What if the account is deleted or suspended?

| Case | Behaviour |
|---|---|
| Deleted | Impossible — an owner account cannot be deleted (Super Admin review §2.4) |
| Suspended | Impossible — an owner account cannot be suspended |
| Role removed | Impossible — INV-008 |
| Identifier reconfigured to another account | Possible, requires host access, and MUST log a boot warning naming the change |

---

## 3. What if the account is compromised?

### 3.1 Blast radius

This is the question that drives the staging recommendation.

| Stage | What a compromised account can do |
|---|---|
| **DM-1 (read-only)** | Observe every subsystem: queue depths, session lists, capability resolutions, route gates, environment health, database statistics. **No state change.** No message bodies, no evidence, no secrets |
| **DM-2 (mutating)** | Everything above, **plus**: revoke every session platform-wide, discard queued notifications, clear caches, pause schedulers, freeze accounts, disable providers, disable registration, disable messaging, enter maintenance mode |

**DM-2's blast radius is a full denial of service on the platform, exercisable from a
browser, by one credential.**

### 3.2 Mitigations — and one that is missing

| # | Mitigation | Present in the design? |
|---|---|---|
| M-1 | Every mutation recorded before it takes effect | Yes |
| M-2 | Records unsuppressible from within the tool | Yes |
| M-3 | No tool renders a secret, token, grant or message body | Yes |
| M-4 | No arbitrary execution surface | Yes |
| M-5 | Every control has a host-level equivalent, so the surface is not the only path | Yes |
| M-6 | Multi-factor authentication on the account | Operational, §8 |
| M-7 | **Step-up re-authentication on destructive operations** | **NO — missing.** §5 |
| M-8 | **A second-party confirmation for platform-wide effects** | **NO — and unavailable.** §3.3 |

**M-7 is a blocking gap.** Volume IV §4.5.4 DM-8 requires "confirmation naming the
specific effect" but does **not** require step-up. A confirmation dialog defends against a
mis-click; it does not defend against a stolen session. The operations in DM-2 are
precisely the ones a stolen session would be used for.

### 3.3 The unavailable mitigation, stated honestly

Two-person control on destructive operations is the standard mitigation for concentrated
authority. **It is unavailable here**, because both owner accounts are held by one person.
Requiring a second owner's concurrence would either be theatre (the same person approves
from the other account) or a lockout (nobody else can approve).

**This is recorded as an accepted, unmitigable residual risk.** It is a consequence of a
one-person platform and cannot be designed away. It is also a reason to keep DM-2 small
and deferred rather than to build it comprehensively.

### 3.4 Detection

**A compromise of this account is detected by the audit trail, and only by it.**

That is the third independent argument for the Audit Log Explorer preceding Developer
Mode — the first two being in the Super Admin review §6. Building a surface whose misuse
is detectable only through a record nobody can read is building it blind.

**Requirement.** Developer Mode MUST NOT ship before the Audit Log Explorer.

---

## 4. Tool classification

### 4.1 Read-only — DM-1

| Tool | Reads | Sensitive content risk |
|---|---|---|
| Environment Health | Configuration presence and verdicts | **Must show presence, never values** |
| Capability Inspector | Kernel resolutions per account | None — capabilities are not secret |
| Route Debugger | Route registry, gates | None |
| Scheduler Inspector | Run times, outcomes, counts | None |
| Queue Inspector (read) | Depths, ages, failure classes, dead-letter **references** | **Must not render job payloads** |
| Live Jobs (read) | Job states, attempts, error classes | **Must not render payloads** |
| Database Statistics | Row counts, sizes, migration state | None. **Must offer no locking operation** |
| Cache Viewer (read) | Keys and metadata | **Must not render cached values** |
| Session Viewer (read) | Session metadata, token version, suspension state | **Must not render tokens or full session identifiers** |
| OAuth Debugger (read) | Provider states, failure classes | **Must not render secrets, codes or state values** |

**Common constraint.** Six of the ten have a "must not render X" clause. The pattern is
consistent: these tools observe subsystems that *handle* sensitive data, and the boundary
is metadata versus content.

**Requirement.** Each such constraint MUST be a per-tool test, not a general principle.
A general principle is not testable; ten specific assertions are.

### 4.2 Destructive — DM-2

Ordered by blast radius, widest first.

| Tool / control | Effect | Reversible |
|---|---|---|
| **Global session revocation** | Every session on the platform ends | **No** |
| **Disable messaging** | No new messages platform-wide | Yes |
| **Disable registration** | No new accounts | Yes |
| **Maintenance mode** | Platform out of service | Yes |
| **Disable a provider** | That sign-in path stops | Yes |
| **Queue discard** | A queued notification is never delivered | **No** |
| **Account freeze** | One account's sessions end and are refused | Yes |
| **Session revoke (one)** | One session ends | **No** |
| Scheduler pause | Scheduled work stops, bounded and auto-expiring | Yes |
| Cache clear | Cache repopulates under load | Yes |
| Job retry / cancel | One job re-runs or stops | Partially |
| Notification test send | One notice to self | N/A |

### 4.3 The three that need more than confirmation

| Tool | Why |
|---|---|
| **Global session revocation** | Signs out every user with no warning. Support cost is platform-wide and the action cannot be undone |
| **Queue discard** | Silently prevents a delivery. If the discarded item were a mandatory notice, it would be an undelivered enforcement notice — which is why discarding a mandatory notice must be **refused entirely**, not merely confirmed |
| **Account freeze** | Removes a person's access with no moderation record. Its whole purpose is to be distinguishable from suspension, which means it must not become an unrecorded suspension |

---

## 5. Confirmation and step-up — the recommendation

Volume IV requires confirmation on mutations. **This review adds step-up.**

| Class | Confirmation | Step-up | Rationale |
|---|---|---|---|
| Read-only tools | No | No | No effect |
| Notification test to self | No | No | Self-only, marked as a test |
| Job retry, cache clear, scheduler pause | **Yes** | No | Bounded, reversible, low blast radius |
| Job cancel, single session revoke | **Yes** | No | Narrow, and irreversible only for one item |
| Provider disable, registration disable, messaging disable, maintenance mode | **Yes** | **Yes** | Platform-wide user-visible effect |
| **Account freeze** | **Yes** | **Yes** | Removes a person's access |
| **Queue discard** | **Yes** | **Yes** | Prevents a delivery, irreversibly |
| **Global session revocation** | **Yes** | **Yes** | Widest blast radius available |

**RATIONALE.** Step-up binds an action to a fresh proof of identity, to one action, with
its arguments, single-use. That is exactly the property needed against a stolen session,
and it is machinery the platform already has and already guards (INV-006). Extending it to
Developer Mode's destructive operations costs one registry entry per action.

**Requirement.** Each such operation MUST be added to the sensitive-action registry, gated
**and** spent inside its handler's transaction. The existing pairing guard will enforce it.

---

## 6. Per-tool findings

### 6.1 Notification Tester — **blocking finding**

**The specification restricts it to self-target. That restriction is correct and must be
structural, not a check.**

A tool that can send an arbitrary notification to an arbitrary account can send a student
a fabricated suspension notice, containing a fabricated reason and a fabricated appeal
link. That is the single most damaging thing any tool in this design could do, and it
would arrive through the platform's own mandatory-notice channel — the one channel a
recipient has been told to trust.

| # | Requirement |
|---|---|
| NT-1 | The recipient MUST be the caller's own account, taken from the principal, **never from a parameter**. There must be no parameter to supply |
| NT-2 | Test notices MUST be marked as tests in their content **and** in their stored record |
| NT-3 | Mandatory-notice overrides MUST NOT apply to test notices |
| NT-4 | A test asserts that attempting to target another account is impossible, not merely refused |

**RATIONALE for NT-1's phrasing.** "Refused when targeting another account" is a check
that can be removed. "No parameter exists" cannot.

### 6.2 API Explorer — **blocking finding**

**Must issue requests as the caller's own principal.** An explorer that can act as another
account is an impersonation tool without impersonation's recording obligations — and
impersonation is separately specified with dual-identity attribution, a banner, an expiry
and a notification to the subject.

| # | Requirement |
|---|---|
| AE-1 | Requests issued as the caller's own principal only |
| AE-2 | MUST NOT offer a request the caller could not otherwise make |
| AE-3 | Every request recorded with a marker identifying it as explorer-originated |
| AE-4 | Step-up-gated endpoints require a genuine grant; the explorer MUST NOT synthesise one |

**AE-4 matters.** An explorer that could bypass step-up would defeat INV-006 for every
sensitive action at once.

### 6.3 Database Statistics

**Offers no locking operation.** No vacuum, no analyse, no integrity check. Each takes a
lock of unbounded duration on a single-process system — an availability incident triggered
from a diagnostic screen.

**Recommendation:** keep these as host-level operations with a documented runbook.

### 6.4 Queue Inspector

**Discarding a mandatory notice MUST be refused**, not confirmed. A mandatory notice
exists because the recipient must receive it; a diagnostic screen must not be able to
decide otherwise.

### 6.5 Session Viewer

Renders no token material and no full session identifier. Distinguishes revoking one
session from revoking all for an account in the audit record, because the latter is a
forced sign-out with a support consequence.

### 6.6 Scheduler Inspector

Pauses **expire automatically**. An indefinite pause is indistinguishable from a broken
scheduler, and the person who paused it will not be the one who notices.

### 6.7 Environment Health

Shows presence and strength verdicts, never values. A failing check states the **remedy**,
not only the failure — an operator reading it is mid-incident.

---

## 7. Findings against Volume IV

| # | Finding | Severity | Action |
|---|---|---|---|
| DF-1 | **Identification method is unspecified.** "Mahit's account" does not say by what. Email is the intuitive and wrong answer | **Blocking** | Adopt §2.2: configured account identifier, absent-safe |
| DF-2 | **No step-up on destructive operations.** Confirmation defends against mis-clicks, not stolen sessions | **Blocking** | Adopt §5 |
| DF-3 | **Detection depends on the audit trail being readable**, which it is not | **Blocking** | Developer Mode must not precede the Audit Log Explorer |
| DF-4 | Two-person control is unavailable and the specification does not say so | Medium | Record as unmitigable residual (§3.3) |
| DF-5 | DM-2's tools duplicate host-level capabilities that already exist and are already audited | Medium | Defer DM-2 (§1) |
| DF-6 | Volume IV §4.5.4 DM-5 permits personal data "where explicitly specified and justified per tool", but no tool specifies any | Low | Tighten to a flat prohibition; no tool currently needs an exception |
| DF-7 | An email change on the Developer Mode account has no specified consequence | Low | §2.3 corollary: audit it, notify the prior address |

---

## 8. Operational requirements

| # | Requirement |
|---|---|
| OP-1 | Multi-factor authentication on the Developer Mode account, at the identity provider |
| OP-2 | The account is not used on shared or institution-managed devices |
| OP-3 | The configured identifier is reviewed quarterly alongside the owner-count review |
| OP-4 | Every host-level equivalent of every DM-2 control is documented **before** DM-2 is built, so the tools are a convenience rather than the only path |
| OP-5 | Enabling Developer Mode in a new deployment is a documented, deliberate step — never a default |

---

## 9. Testing

| # | Test |
|---|---|
| T-01 | Every endpoint refused for the **second owner account** |
| T-02 | Every endpoint refused for administrator, organizer, student, unauthenticated |
| T-03 | Absent configuration disables the surface entirely |
| T-04 | A configured identifier naming a non-owner disables the surface |
| T-05 | The derived guard fails against a route omitting the check |
| T-06 | Per tool: no credential, token, secret, grant, message body or evidence content rendered |
| T-07 | Per read-only tool: state before equals state after |
| T-08 | Authorization does not vary by environment |
| T-09 | The notification tester has **no recipient parameter** |
| T-10 | The API explorer cannot act as another account; requests are marked |
| T-11 | The API explorer cannot invoke a step-up-gated endpoint without a genuine grant |
| T-12 | A mandatory notice cannot be discarded |
| T-13 | Scheduler pauses expire |
| T-14 | Every destructive operation in §5 requires step-up; grants are single-use |
| T-15 | Every mutation records before it takes effect |
| T-16 | Every tool degrades to an explanatory empty state when its subsystem is absent |

---

## 10. Recommendation

**Do not build Developer Mode next.** It is third in priority behind the Audit Log
Explorer and administrator management, and §3.4 makes the ordering a requirement rather
than a preference: its misuse is detectable only through a record nobody can currently
read.

**When it is built:**

1. **DM-1 only.** Shell, access control, nine read-only tools. Ship the access control
   and its derived guard **before any tool** — a surface whose restriction arrives later
   is a surface that was briefly open.
2. **Adopt §2.2 identification** — configured account identifier, absent-safe, checked per
   route, independently of the owner capability.
3. **Then stop.** Use DM-1 through at least one real incident. Record which mutations were
   actually wanted and which host-level equivalents were inadequate.
4. **Revisit DM-2 with that evidence.** Build only the controls experience showed were
   needed, each with step-up per §5.

**The three blocking findings — DF-1, DF-2, DF-3 — must be resolved in the specification
before implementation begins**, not during it. Two of them concern how the surface is
protected, and the third concerns whether its misuse could be seen at all.
