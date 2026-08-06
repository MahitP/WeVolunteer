# Volume II — Authentication, Authorization and Security Architecture

**Status:** Normative
**Scope:** Authentication, the capability kernel, authorization, OAuth, sessions, JWT,
cookies, CSRF, CSP, step-up re-authentication, audit logging, threat models, break-glass
recovery, Super Admin security.

**Binds:** Appendix A (capability matrix), Appendix B (endpoint contracts), Appendix D
(audit events).

---

## 2.1 Purpose, goals and threat context

### 2.1.1 Purpose

This volume specifies who the platform believes a request is from, what that principal
may do, how both determinations are made, and what is recorded about them. It is the
most load-bearing volume in this specification: every other volume's guarantees are
conditional on this one holding.

### 2.1.2 Goals

| ID | Goal | Measured by |
|---|---|---|
| G-2.1 | Adding a role never silently grants or denies anything. | INV-002, INV-005; role×capability matrix derived, not written. |
| G-2.2 | A stolen session token is bounded in time and revocable immediately. | INV-004; token-version invalidation; per-session revocation. |
| G-2.3 | The most consequential actions require proof of identity *now*, not proof of a session. | INV-006; seven sensitive actions, single-use grants. |
| G-2.4 | An authorization mistake fails closed. | INV-021; unknown capability denies for every principal including wildcard holders. |
| G-2.5 | Every act against a person is attributable. | INV-011, INV-023. |
| G-2.6 | Platform ownership cannot be seized through the application. | INV-008, INV-009. |
| G-2.7 | Loss of the owner's credentials is recoverable without weakening the model. | §2.11 break-glass. |

### 2.1.3 Threat context

The platform's adversary model is unusual and shapes every decision below. The
realistic adversaries, in descending order of likelihood:

| # | Adversary | Capability | Motivation |
|---|---|---|---|
| A-1 | A student with an account | Authenticated, technically curious, has a browser and a console. | Curiosity; grade or hour inflation; accessing another student's data; reaching a peer they have been blocked from. |
| A-2 | An adult organizer with an account | Authenticated, holds capabilities over students. | Reaching a specific minor privately; obscuring or destroying a report about themselves. |
| A-3 | A student subject to enforcement | Authenticated or suspended. | Evading a suspension; destroying evidence; retaliating against a reporter. |
| A-4 | An opportunistic external attacker | Unauthenticated; scans for common misconfiguration. | Credential stuffing; enumerating accounts; defacement. |
| A-5 | A compromised administrator account | Full moderation capability. | Anything, including reading every student's private messages. |
| A-6 | The platform owner acting in error | Wildcard capability. | None — but the consequences are the largest, so the model must make errors visible and recoverable. |

**A-2 is the design-driving adversary.** An adult with legitimate platform access,
seeking private contact with a specific minor and the ability to remove the record of
it, is both the most consequential and the least addressable by conventional security
controls: the adversary is authenticated, authorised, and doing things the platform
exists to permit. Every moderation and evidence control in Volume III is shaped by
this adversary, and the authorization model here is what makes those controls
enforceable.

**A-6 is why ownership is immutable rather than merely privileged.** A wildcard holder
who mis-clicks cannot be prevented by permission checks, because they hold every
permission. The mitigations are structural (§4.1), procedural (§2.10.6), and
evidentiary (§2.9).

---

## 2.2 Authentication

### 2.2.1 Purpose

Establish, per request, which account the request is from — or that it is from none.

### 2.2.2 Current state

Two credential paths exist: a password path and an OAuth provider path. Both terminate
in the same session-minting function. Sessions are carried in an HTTP-only cookie
containing a signed token. Identity is re-derived from persistent storage on every
authenticated request. Email verification gates a subset of the surface. Five distinct
session-invalidation mechanisms exist and are enumerated in §2.5.

### 2.2.3 Credential paths

**Password path.** A caller supplies an identifier — email address or username — and a
password.

Refusal ordering is normative and each position is justified:

| # | Condition | Response | Why at this position |
|---|---|---|---|
| 1 | No such account, or account deleted | 401, `no_such_account` | Cheapest check; nothing else can proceed. |
| 2 | Account suspended (effective, per §3.8) | 403, `suspended` | **Before** the password check. Telling a suspended person their password is wrong sends them into the reset loop for a problem a reset cannot fix. |
| 3 | Account is provider-only | 409, `oauth_only` | Before the password comparison, which would otherwise return false against a sentinel and report "wrong password" for an account that has never had one. Not counted as a failed attempt: it is not a password guess, and counting it would let anyone lock out a provider-only account through a route it cannot use. |
| 4 | Password mismatch | 401, `wrong_password` | Counted as a failed attempt. |
| 5 | Success | 200 + session | Failure counter cleared. |

**Disclosure requirements at position 2.** The refusal MUST NOT include the suspension
end date, the reason, the imposing administrator, or any other detail of the
enforcement action.

**RATIONALE.** Position 2 precedes the password check, so anyone who can guess an email
address reaches this response. That the account exists and is suspended is already
disclosed there and is an accepted product decision with a documented switch for
reversing it. The *end date* is not covered by that decision: it is a detail of a
moderation action against a named person, usually a minor. The subject receives it in
the mandatory notice sent to the address on the account, which is a channel the
adversary does not control.

**FAILURE MODE.** Without this rule, an adult can determine whether a specific
student's account is under enforcement and when that enforcement lifts, by typing the
student's address into a login form.

**OAuth path.** Specified in §2.6.

### 2.2.4 Account enumeration policy

The platform **discloses account existence** on the sign-in path. This is a deliberate,
recorded product decision, not an oversight.

**Requirements.**

- The decision MUST be expressed as a single named configuration constant, so that
  reversing it is one edit with no other change required.
- Where the constant selects generic messaging, **every** refusal on the sign-in path
  MUST return the identical generic message and status. A generic message on three
  branches out of four discloses by elimination.
- Enumeration MUST NOT be possible through any *other* surface: registration,
  password reset, email-change, username availability and invitation acceptance MUST
  all respond identically for existent and non-existent subjects.

**RATIONALE for the asymmetry.** The sign-in screen is used by a student who has
forgotten which address they registered with; a generic message there produces support
load with no security benefit against A-4, who can enumerate through registration
anyway if that surface is not also hardened. The other surfaces have no such usability
argument and are therefore hardened.

### 2.2.5 Email verification

Verification is a **gate on a subset of the surface**, not a precondition of session
issuance.

**Requirements.**

- An unverified account MAY hold a session and MUST be able to reach: the verification
  wall, the resend action, sign-out, settings sufficient to correct the address, and
  every legal document.
- Every other authenticated surface MUST be refused with a distinct code so the client
  routes to the wall rather than rendering a generic refusal.
- The allowlist MUST be expressed as path prefixes in one place, and MUST include the
  step-up re-authentication paths.
  **RATIONALE:** correcting the address is a sensitive action; if step-up is behind the
  verification gate and verification requires correcting the address, the account is
  locked in a cycle it cannot exit.
- A provider that **attests** the address MUST satisfy verification on signup. A
  provider that does not attest MUST NOT.
- Verification tokens MUST be single-use, expiring, and invalidated when the address
  changes.

### 2.2.6 INV-004 — Identity is re-derived per request

**INVARIANT.** The principal MUST be constructed from persistent storage on every
authenticated request. No authorization decision may rely on a claim carried in the
token beyond the subject identifier and the fields required to detect invalidation.

**Requirements.**

- Role, email, name, verification state, account status and suspension deadline MUST be
  read from storage.
- Per-account grants and withholdings MUST be read from storage.
- The token MAY carry: subject identifier, token version, session identifier, issue and
  expiry times. It MUST NOT carry role or capabilities.

**RATIONALE.** A token is valid for up to its full lifetime. A role encoded in it is a
role that persists after demotion. Re-deriving makes every identity change — demotion,
suspension, capability revocation, deletion — effective on the next request rather than
on the next sign-in.

**FAILURE MODE.** An administrator is demoted after acting improperly. Their existing
token continues to assert `admin` for up to a week, during which they retain every
moderation capability including reading students' private messages.

### 2.2.7 Failed-attempt handling

**Requirements.**

- Failures MUST be counted per **subject identifier and source address in
  combination**, so that one attacker cannot lock out an arbitrary account and one
  account's owner cannot be locked out by another's attacker.
- The response to a rate-limited attempt MUST be indistinguishable from a wrong
  password, except for the status code required by the transport. It MUST NOT report
  the remaining attempts or the lockout duration.
  **RATIONALE:** a countdown is a progress meter for an attack.
- The counter MUST be cleared on success.
- A provider-only refusal and a suspension refusal MUST NOT increment the counter.

### 2.2.8 Failure modes

| # | Failure mode | Consequence | Control |
|---|---|---|---|
| F-2.2.1 | Role read from token | Demotion ineffective for a week | INV-004 |
| F-2.2.2 | Suspension checked after password | Suspended user sent to password reset | §2.2.3 ordering |
| F-2.2.3 | End date in pre-auth refusal | Enforcement detail readable by anyone who guesses an address | §2.2.3 disclosure rule |
| F-2.2.4 | Step-up behind verification gate | Account unable to correct the address that blocks it | §2.2.5 allowlist |
| F-2.2.5 | Lockout counted per account only | One attacker locks out any account at will | §2.2.7 |
| F-2.2.6 | Provider-only refusal counted as failure | Provider-only account lockable through an unusable route | §2.2.3 position 3 |

### 2.2.9 Acceptance criteria for §2.2

| # | Criterion |
|---|---|
| AC-2.2.1 | Sign-in refusals occur in the order in §2.2.3, asserted per position. |
| AC-2.2.2 | No sign-in refusal contains a suspension end date, reason or actor. |
| AC-2.2.3 | The enumeration decision is a single named constant. |
| AC-2.2.4 | Registration, reset, email-change, username check and invitation acceptance respond identically for existent and non-existent subjects. |
| AC-2.2.5 | An unverified account can reach the wall, resend, sign-out, address correction, legal documents and step-up, and nothing else. |
| AC-2.2.6 | The principal contains no value read from the token except the subject, token version and session identifier. |
| AC-2.2.7 | A demoted account loses its capabilities on the next request without re-signing-in. |
| AC-2.2.8 | Failure counting is keyed on identifier and address in combination. |

---

## 2.3 The capability kernel

### 2.3.1 Purpose

Provide the single, total answer to "may this principal do this thing", in a form that
cannot drift between server and client and cannot be bypassed by a route.

### 2.3.2 INV-003 — The kernel imports nothing

**INVARIANT.** The capability kernel MUST have no imports. Not the database, not
configuration, not utilities, not a logger.

**Requirements.**

- It MUST be unit-testable with no fixtures.
- It MUST be safe to include in the client bundle.
- The client MUST **re-export** it rather than reimplement it (P-8).
- A static guard MUST assert the module's import list is empty.

**RATIONALE.** Three properties follow from purity and all three are load-bearing. It
cannot decay into a data-access layer, which is what would happen the first time a
capability check needed "just one query". It is cheap enough to ship to the client, so
the two tables physically cannot diverge. And it is testable without a database, which
means its tests are fast enough to be exhaustive over the whole matrix.

### 2.3.3 INV-021 — Unknown capabilities deny universally

**INVARIANT.** A capability identifier not present in the registry MUST resolve to
deny, for every principal, **including a wildcard holder**. The check against the
registry MUST occur *before* the wildcard is consulted.

**FAILURE MODE this prevents.** A typo — `error.raed` — resolves true for the wildcard
holder and false for everyone else. The person testing the feature is the owner. It
works for them and for nobody else, and no test fails. This is the worst class of
authorization defect because it is invisible to the only person who can reproduce it.

**Corollary requirement.** Because the registry is authoritative, capabilities held
only by the wildcard MUST still be **declared explicitly** in a super-only list. A
capability that exists nowhere but in a wildcard is indistinguishable from a typo.

### 2.3.4 INV-002 — Route files never compare a role

**INVARIANT.** No module that makes an authorization decision may compare a role
identifier to a literal.

**Requirements.**

- Routes MUST request a named capability, or ask the kernel.
- Role identifiers MUST be defined in exactly one place and referenced from there.
- A static guard MUST fail the build on any spelling of a role comparison, and MUST
  scan **both** server and client source.
- Exemptions MUST be enumerated with a reason, MUST be re-read when their position
  moves, and MUST fail when stale.

**RATIONALE.** Before the kernel, authorization was roughly forty copies of a role
comparison. That pattern has one fatal property: **adding a role silently denies it
everywhere**, because a new identifier is not equal to any existing literal. Adding the
owner role to that system would have locked the owner out of every administrative
route, and no test would have failed.

**On the exemption mechanism.** A handful of decisions genuinely concern a role rather
than a capability — the clearest being an agreement that binds organizers and
deliberately does not bind administrators, which cannot be expressed as a capability
because administrators hold the capabilities the agreement gates. Such a decision MUST
reference the single role definition, and MUST be listed as an exemption with its
reason. The guard's real rule is "role identifiers live in one file", not "roles are
never named".

**On pinned exemptions.** Where an exemption is pinned by position, moving it MUST
require re-reading the exempted code and recording what the re-read concluded. A pin
updated without a re-read is a rubber stamp and forfeits the guard's only benefit. See
Volume I §1.11.

### 2.3.5 INV-005 — Every authenticated route is gated

**INVARIANT.** Every route requiring authentication MUST be behind a capability gate,
or MUST carry a reviewed one-line justification for having none.

**Requirements.**

- A static guard MUST enumerate routes from source and fail on an ungated route with no
  justification.
- A justification MUST state why the route is safe without a capability. Acceptable
  justifications are narrow: the route is scoped entirely to the caller's own record;
  or the route is the mechanism by which a locked-out principal recovers capability.
- The guard MUST fail when a justification no longer matches a route.

**The second acceptable justification, stated concretely.** A screen on which an
organizer accepts an agreement MUST NOT be gated on any capability that accepting the
agreement grants. Gating it produces a lockout from the one page that undoes the
lockout.

### 2.3.6 INV-007 — Cascade ordering

**INVARIANT.** Any conditional chain over capability checks MUST be ordered
most-privileged-first and MUST terminate in an explicit deny.

**RATIONALE — why chains are not mutually exclusive.** The wildcard satisfies every
check. A chain of alternatives is therefore **not** a set of exclusive cases: a
wildcard principal matches whichever branch is tested first.

**Two rules follow, and both are load-bearing.**

1. **Most-privileged-first.** Testing a narrow capability first captures the wildcard
   in the narrow branch. The owner then silently receives a *student's scoped view* of
   the data — a content defect no status-code assertion can detect, because the response
   is still a 200 with a plausible body.
2. **Explicit terminal deny.** "No recognised capability" MUST default to seeing and
   doing nothing. A trailing unconditional branch grants unscoped access to every
   future role on the day it is added — which is the same class of defect the kernel
   exists to eliminate, merely inverted.

**Requirement.** Every cascade MUST carry an inline note stating that its order is
load-bearing. A reader who does not know about the wildcard will otherwise reorder it
for readability.

### 2.3.7 Grants and withholdings

Two per-account modifiers exist. Both are specified fully in Appendix A.

| Modifier | Effect | Constraint |
|---|---|---|
| **Grant** | Adds one capability to one account. | MUST NOT grant a super-only capability. MUST be recorded with granter, subject, capability, reason and time. MAY expire. |
| **Withholding** | Removes one capability the role would grant. | Computed per request. MUST be visible to the affected account with its reason and its remedy. |

**Requirements.**

- Grantability MUST be a property of the capability, declared in the registry, not a
  property of the granting call site.
- A super-only capability MUST NOT be grantable, and the kernel MUST refuse it *before*
  consulting grants.
- Granting MUST itself be a capability, and MUST NOT be self-serviceable: a principal
  MUST NOT grant itself a capability it does not hold.
- A withholding MUST be threaded into the client's copy of the principal, so the
  interface does not offer controls the API will refuse.
  **FAILURE MODE:** an organizer who has not accepted the agreement holds none of the
  capabilities that reach a student, but the navigation offers three screens that all
  refuse — with no explanation of why.

**The triage-only helper.** The grant mechanism exists for a specific, named use: a
person who can sort the moderation queue and cannot read students' private messages.
This is why report resolution and evidence reading are separate capabilities and why
neither is super-only. Any change that merges them destroys this role without
appearing to remove anything.

### 2.3.8 Client-side authorization is presentation only

**Requirement.** Every capability MUST be re-checked server-side. A client-side check
is a convenience that prevents offering a control that will be refused; it is never a
boundary.

**Requirement.** The client's capability names MUST be validated against the registry
by a static guard.
**FAILURE MODE:** a mistyped capability in a navigation entry or route condition is not
an error. It is an entry invisible to every user and a route that refuses everyone.
Nothing throws and nothing logs.

### 2.3.9 Alternatives considered

| Alternative | Rejected because |
|---|---|
| Role checks at call sites | The realised defect: adding a role silently denies everywhere. |
| Role hierarchy with inheritance | Makes "what can this role do" answerable only by traversal, and makes an accidental grant through an inherited edge invisible. The flat table is auditable by reading. |
| Policy engine with a rule language | A second language to review, a second thing to get wrong, and no static guard could then verify route coverage. |
| Per-record ACLs | The domain is role-shaped: a student's relationship to an event is derivable from their application. Per-record entries would duplicate derivable state and drift from it. |
| Capabilities in the token | Forfeits INV-004; demotion becomes effective at next sign-in. |
| Server-only kernel, client role checks | Guarantees drift, in the direction of offering controls the API refuses. |

### 2.3.10 Acceptance criteria for §2.3

| # | Criterion |
|---|---|
| AC-2.3.1 | The kernel has an empty import list, asserted by guard. |
| AC-2.3.2 | The client re-exports the kernel and does not reimplement it. |
| AC-2.3.3 | An unknown capability denies for a wildcard holder, asserted by test. |
| AC-2.3.4 | Every super-only capability is declared in the super-only list. |
| AC-2.3.5 | No role comparison exists in server or client outside the exemption list. |
| AC-2.3.6 | Every exemption carries a reason and fails when stale. |
| AC-2.3.7 | Every authenticated route is gated or justified. |
| AC-2.3.8 | Every cascade is ordered most-privileged-first with an explicit terminal deny, asserted for the wildcard principal specifically. |
| AC-2.3.9 | A super-only capability cannot be granted, asserted by test. |
| AC-2.3.10 | Every client capability name exists in the registry. |
| AC-2.3.11 | The role×capability matrix is derived from the registry, not written out. |

---

## 2.4 Authorization surfaces and refusal behaviour

### 2.4.1 Gate placement

| Surface | Gate |
|---|---|
| Route | Declarative capability requirement, applied before the handler. |
| Sub-decision within a handler | Direct kernel query, with cascade rules per §2.3.6. |
| Navigation entry | Capability condition, mandatory (INV-019). |
| Client route | Capability condition in the route table. |
| Rendered control | Capability check mirroring the endpoint's gate. |

**Requirement.** A rendered control MUST be gated on the **same** capability as the
endpoint it calls. Mirroring a *different* capability produces a control that renders
for exactly the role most likely to press it and then refuses.

**Worked example, normative.** Opening a moderation conversation with an arbitrary
person is gated on the moderation capability, **not** on the messaging capability.
Participating in a conversation is one thing; selecting an arbitrary person by
identifier to start one with is a moderation power. An organizer holds the messaging
capability and MUST NOT reach a stranger through it.

### 2.4.2 Refusal status codes

| Situation | Status | Code class |
|---|---|---|
| No session | 401 | `unauthenticated` |
| Session invalid, revoked, or version-stale | 401 | `session_*` |
| Valid session, capability absent | 403 | `forbidden` |
| Valid session, capability present, subject-specific rule refuses | 403 | Specific, e.g. `conflict_of_interest` |
| Step-up required | 401 with challenge metadata | `reauth_required` |
| Suspended | 403 | `suspended` |
| Unverified where verification is required | 403 | `email_unverified` |
| Resource absent, or present but not visible to this principal | 404 | `not_found` |

**Requirement on the last row.** Where disclosing existence would itself be a
disclosure, absence and invisibility MUST be indistinguishable. A conversation the
caller is not a participant in MUST answer 404, identically to a conversation that does
not exist.

### 2.4.3 Refusals must not leak by timing or by shape

**Requirements.**

- A refusal MUST NOT vary in shape according to whether the subject exists, on any
  surface where existence is itself protected.
- A refusal for a blocked sender MUST use the **generic** read-only refusal, so that
  the block is not announced to the blocked party.
- A capability refusal MUST NOT enumerate the capabilities the caller holds.

### 2.4.4 Conflict of interest

**Requirement.** A principal MUST NOT decide a matter to which they are a party.

**Requirements in detail.**

- Party-hood MUST be computed over **every** relationship, not the obvious one. For a
  report, this includes reporter, author of reported content, and — the one most easily
  missed — the **subject named directly** when the report is about a person rather than
  content. A check reading only the authorship column misses every report filed
  directly against a person, which is the shape a report about an adult almost always
  takes.
- **Reading** MUST remain permitted. A person must be able to see what was said about
  them. It is *deciding* that is refused — including the quiet forms: reprioritising,
  assigning to oneself, or closing.
- The refusal MUST name who *can* decide it.

**The deadlock exception, and why it exists.** Where the only principal senior enough to
decide is themselves the subject, the matter MUST remain decidable by the most
privileged principal, and the decision MUST be recorded as a self-review: a distinct
entry in the subject-scoped history and a distinct audit action, both naming the actor.

**RATIONALE.** The alternative — no on-platform path — produces a concrete failure on a
one-to-two-person team: a report naming the only administrator can never leave the open
state, so it holds a deletion hold on that person's events and a retention hold on every
account party to it, permanently, with no remedy short of editing the database by hand.
A safety mechanism that cannot be discharged stops being a safety mechanism and becomes
a lock. The mitigation for a self-review is that everyone can see it was one — the same
trade the community guidelines already publish when they decline to promise an
independent reviewer.

### 2.4.5 Scoping rather than refusing

Where a principal may see *some* of a collection, the handler MUST scope the query
rather than refuse the request, and the scoping cascade MUST obey INV-007.

**FAILURE MODE the ordering prevents.** A cascade testing the narrow capability first
gives the owner a student's scoped view — they see their own records where they should
see everything. The response is a 200 with a plausible body, so no status assertion
catches it.

### 2.4.6 Withholding disclosure

**Requirement.** Where a capability is withheld, the affected account MUST be told: that
it is withheld, why, and what discharges it. The screen that discharges it MUST remain
reachable (§2.3.5).

**Requirement.** Persona selection — which dashboard a principal sees — MUST be
computed against the role's own capabilities with withholdings **ignored**.

**RATIONALE.** An organizer who has not accepted the agreement holds none of the
capabilities that reach a student, including the one that identifies them as an
organizer. Consulting withholdings during persona selection gives them *no* persona,
so they fall through to a terminal "no dashboard for this account" — the one state
where an explanation matters most produces a dead end naming no reason, offering no
next step, and hiding the acceptance banner that exists precisely to be seen there.
They are still an organizer. They are an organizer who has not signed yet. Persona asks
*who*, not *what may they do*.

### 2.4.7 Refusal copy

**Requirement.** A refusal MUST name three things: the feature attempted, the reason
this account is refused, and who can grant access.

**Requirements in detail.**

- The feature MUST be named in plain language. A capability identifier MUST NOT be
  displayed.
- A capability with no plain-language name MUST degrade to a generic area description.
  A guard derived from the route table MUST fail when a gated route's capability has no
  name, so that the vaguer wording cannot quietly become the norm.
- The remedy MUST be **true**. Where a capability is unreachable by grant, the copy
  MUST say it cannot be granted rather than promising an administrator can help.
- Where the refusal is a pending approval rather than a missing capability, the pending
  approval MUST be reported. Reporting the capability tells the reader they lack a
  permission they in fact hold, and sends them to ask for something they already have.
  This ordering MUST mirror the refusal computation's own ordering.
- The remedy MUST NOT direct the reader to a party with no access to the platform.
  **RATIONALE:** this platform is independent of any school district. A school
  administrator cannot see the refusal and cannot act on it. Directing somebody to a
  powerless party is worse than saying nothing, because it consumes their effort and
  ends in silence.
- The explanation MUST NOT be attached to a fault or crash presentation. Those are
  written flat and reassurance-first; a sentence about capabilities beneath one answers
  a question nobody asked at a moment the reader may have just lost work.

### 2.4.8 Acceptance criteria for §2.4

| # | Criterion |
|---|---|
| AC-2.4.1 | Every rendered control is gated on the same capability as its endpoint. |
| AC-2.4.2 | An invisible resource is indistinguishable from an absent one. |
| AC-2.4.3 | A blocked sender receives the generic read-only refusal. |
| AC-2.4.4 | Party-hood covers direct-subject reports, asserted by test. |
| AC-2.4.5 | A party may read but not decide; the refusal names who can. |
| AC-2.4.6 | A self-review is recorded distinctly in both trails. |
| AC-2.4.7 | Every scoping cascade is asserted for the wildcard principal's content, not only its status. |
| AC-2.4.8 | A withheld capability is disclosed with reason and remedy, and its remedy screen is reachable. |
| AC-2.4.9 | Persona selection ignores withholdings. |
| AC-2.4.10 | Every refusal names feature, reason and remedy; a gated route with no feature name fails the build. |
| AC-2.4.11 | No refusal directs the reader to a party without platform access. |

---

## 2.5 Sessions, tokens and cookies

### 2.5.1 Session token

**Requirements.**

- The session is a signed token in a cookie. It MUST NOT be readable by client script.
- Claims are limited to: subject identifier, token version, session identifier, issue
  time, expiry. No role. No capabilities. No email.
- **Every session MUST carry a unique session identifier.** Step-up grant binding
  depends on it, and a grant cannot be bound to a session without one.
- All minting MUST pass through a single function. A second minting path produces
  sessions without identifiers, which then cannot be individually revoked and cannot
  hold a step-up grant.

### 2.5.2 Signing secret

**Requirements.**

- Production boot MUST fail on an absent secret, on a recognised placeholder, and on a
  secret below a minimum length. Failure MUST name the remedy including a generation
  command.
- Development MAY use a fixed secret. It MUST warn on every boot.
- Rotation invalidates every session. The procedure and its announcement obligations
  are in Volume V §5.11.4.

**RATIONALE for failing closed.** Every session cookie is signed with this value. A
guessable secret lets anyone mint a token for any account, including the owner. There is
no partial failure: the system is either sound or fully compromised, so boot is the
correct place to refuse.

### 2.5.3 Cookie attributes

| Attribute | Value | Reason |
|---|---|---|
| `HttpOnly` | Always | Script cannot read the session. |
| `Secure` | Production always; development conditional | A production cookie without it is transmittable in clear text. |
| `SameSite` | `Lax` | Blocks cross-site POST; permits top-level navigation return, which the OAuth redirect requires. `Strict` breaks that return. |
| `Path` | Narrowest that works | Limits exposure to subpaths. |
| `Max-Age`/`Expires` | Bounded, ≤ 7 days | Bounds the window of a stolen token. |
| Name | Application-prefixed | Avoids collision on a shared host. |

**Requirements.**

- A failed authentication MUST NOT set a session cookie, at all, in any branch. This
  MUST be asserted per refusal branch, not once.
- Clearing MUST use attributes matching the set operation. Mismatched attributes leave
  the cookie in place while reporting sign-out.

### 2.5.4 Invalidation mechanisms

Five exist. Each addresses a case the others do not; none is redundant.

| # | Mechanism | Scope | Triggered by |
|---|---|---|---|
| 1 | Expiry | One token | Time. |
| 2 | Token version increment | Every session of one account | Password change, suspension, forced global sign-out, credential compromise. |
| 3 | Session revocation list | One session | Signing out one device. |
| 4 | Account status | Every session | Deletion, suspension. |
| 5 | Absent account | Every session | Hard deletion after retention. |

**Requirements.**

- A suspension MUST increment the token version.
  **FAILURE MODE:** status alone stops the *next sign-in* and leaves every
  already-issued cookie working for up to a week. The person suspended for messaging a
  student could continue messaging that student for that week — which is the entire
  window the suspension exists to close.
- Revocation MUST be checked **after** the version check, so that an account-wide
  invalidation reports itself as such rather than as a single-device sign-out.
- Revocation MUST be checked **before** the principal is populated, so a revoked token
  never reaches a handler.
- Revocation entries MAY be swept once the corresponding token could no longer be
  valid, and MUST NOT be swept earlier.

### 2.5.5 Acceptance criteria for §2.5

| # | Criterion |
|---|---|
| AC-2.5.1 | Session tokens carry no role or capability claim. |
| AC-2.5.2 | Every session carries a unique identifier; all minting is through one function. |
| AC-2.5.3 | Production boot fails on absent, placeholder or weak secret, with a remedy in the message. |
| AC-2.5.4 | Cookie attributes match §2.5.3, asserted by test. |
| AC-2.5.5 | No refusal branch sets a cookie; asserted per branch. |
| AC-2.5.6 | Suspension increments token version; an existing session is refused on its next request. |
| AC-2.5.7 | Revocation is checked after version and before principal population. |

---

## 2.6 OAuth

### 2.6.1 Purpose

Permit sign-in and sign-up through an external identity provider without weakening any
property established above.

### 2.6.2 Current state

Three providers are registered. Two are implemented; one is an explicit unimplemented
placeholder. Provider advertisement is computed from credentials alone. URL construction
refuses when credentials are absent. A mock transport exists for tests and is
opt-in.

### 2.6.3 Provider registry requirements

**Requirements.**

- Each provider declares an identifier, a label, and whether it is implemented.
- An unimplemented provider MUST **throw** when asked for an authorization URL. It MUST
  NOT return a sentinel string.
  **FAILURE MODE:** a returned sentinel is assigned to the browser's location, so the
  button appears to do nothing at all, with no error and no explanation.
- A provider MUST NOT be advertised as available unless its credentials are present.
- Advertisement MUST be computed from **credentials alone**, never from a flag that a
  development-mode default can set.
  **FAILURE MODE:** an advertisement expression including a mock-mode flag advertises
  every provider in every development environment, which is how a credential-less
  provider reached production-looking screens unnoticed.
- The advertised state MUST distinguish *available*, *misconfigured* and *not yet
  implemented*. An operator otherwise sees the same screen as everyone else and cannot
  tell a missing credential from an unbuilt feature.

### 2.6.4 The credential guard

**Requirement.** A provider MUST NOT construct an authorization URL unless both the
client identifier and the client secret are present. The refusal MUST occur at the point
of construction.

**Requirements in detail.**

- The secret MUST be checked alongside the identifier even though only the identifier
  appears in the URL.
  **RATIONALE:** a deployment with an identifier and no secret produces a URL that
  works. The user signs in at the provider, returns with a real authorization code, and
  the failure surfaces at the token exchange — after the round trip, with a message
  about the exchange rather than about the configuration.
- The mock transport MUST NOT exempt the guard. The mock is a **callback-side**
  transport; it has nothing to offer the redirect that begins the flow, which always
  goes to the real provider. Exempting it is precisely what keeps a credential-less URL
  alive in the environment where it would be found.
- Hiding the button is insufficient. The mint endpoint is reachable directly, and the
  step-up flow calls the same construction path.
- A static guard MUST fail the build on an implemented provider whose URL construction
  does not invoke the credential check. The provider set MUST be derived from the
  provider directory (P-3).

**FAILURE MODE, realised.** With a client identifier unset, a provider constructed and
returned a URL with an empty identifier parameter. The endpoint answered 200, the browser
followed it, and the provider terminated the journey with a configuration error. The
user had already left the site by then, which is the worst place to discover a
configuration mistake.

### 2.6.5 State and nonce

**Requirements.**

- State MUST be single-use, bound to the issuing browser by a separate cookie nonce, and
  MUST expire.
- State MUST be bound to the **provider**. A state issued for one provider MUST NOT be
  accepted by another.
- A callback with a state never issued by this system MUST be refused before any
  provider communication.
- Replay of a consumed state MUST be refused.

### 2.6.6 Callback branches

Four cases. Each has distinct requirements.

| Case | Condition | Requirements |
|---|---|---|
| Returning identity | This provider identity is already linked | Refuse if the account is deleted **and clear the stale link**, so a fresh signup with the same provider account is a clean signup rather than a permanent dead end. Refuse if suspended, using the effective computation (§3.8), not the stored status. |
| Address match | No link, but an account holds the address | Refuse if deleted or suspended. Linking creates a **new credential**, so it MUST require an authenticated session as that account plus step-up — a live session alone is insufficient, because the link logs in anyone presenting that identity from then on, long after the session ends. |
| New account | No link, no address match | Return a signup continuation token. MUST NOT create an account implicitly: consent must be collected. |
| Attested address | Provider asserts the address is verified | MAY satisfy email verification. A provider that does not attest MUST NOT. |

**Requirement on suspension checks in this handler.** Both sign-in branches MUST use
the effective suspension computation. A stored-status comparison refuses an account whose
timed suspension has already expired — and a provider-only account has no other door, so
that is a permanent lockout from an account whose sanction has ended, with nothing on
screen to explain it.

### 2.6.7 Provider identity is the key, not the address

**Requirement.** The link MUST be keyed on the provider's stable subject identifier,
never on the address.

**RATIONALE.** Addresses are reassigned, particularly in school domains after a student
leaves. A link keyed on address hands the departed student's account to the next holder
of the address.

### 2.6.8 Acceptance criteria for §2.6

| # | Criterion |
|---|---|
| AC-2.6.1 | An unimplemented provider throws rather than returning a sentinel. |
| AC-2.6.2 | Advertisement derives from credentials alone. |
| AC-2.6.3 | Six provider states are covered per implemented provider: configured, identifier-only, secret-only, neither, mock-with-no-credentials, and never-an-empty-identifier. The provider set is derived. |
| AC-2.6.4 | A provider with no credential-guard invocation fails the build. |
| AC-2.6.5 | State is single-use, nonce-bound, provider-bound and expiring; replay and cross-provider replay refused. |
| AC-2.6.6 | A deleted account's stale link is cleared on refusal. |
| AC-2.6.7 | Linking requires an authenticated session as the account plus step-up. |
| AC-2.6.8 | Both sign-in branches use the effective suspension computation; an expired timed suspension permits sign-in. |
| AC-2.6.9 | Links are keyed on provider subject identifier. |
| AC-2.6.10 | The mock transport is opt-in and cannot be enabled by an unset credential. |

---

## 2.7 Step-up re-authentication

### 2.7.1 Purpose

Require proof of identity **now** for actions whose consequences a stolen or borrowed
session must not be able to cause.

### 2.7.2 Current state

Seven actions are registered as sensitive: account deletion, password change, email
change, provider link, provider unlink, data export request, data archive download. A
grant is bound to one action, with its arguments, from one session, for a limited
period, and is single-use.

### 2.7.3 Grant properties

A grant MUST be:

| Property | Requirement | Failure prevented |
|---|---|---|
| Action-bound | Valid for exactly one registered action. | A grant for a low-consequence action authorising a high-consequence one. |
| Argument-bound | Bound to the specific arguments the registry declares. | A grant to change the address to one value authorising a change to another. |
| Session-bound | Bound to the session identifier that obtained it. | A grant obtained in one session used from another. |
| Time-limited | Short, minutes not hours. | A borrowed unlocked device. |
| Single-use | Consumed on spend. | Replay. |

### 2.7.4 Registry

**Requirements.**

- Each action declares an identifier, a human label, the acceptable proof methods, and
  the exact argument names bound.
- Every gate argument MUST be a **literal** drawn from the registry. A computed or
  variable action identifier MUST fail the build, because it cannot be statically
  verified.
- The registry is the single source for what is sensitive. A route requiring step-up
  that is not in the registry MUST fail the build.

### 2.7.5 INV-006 — Gate and spend are both required

**INVARIANT.** The gate is an **early refusal, not the check**. The handler MUST
additionally spend the grant, inside its own transaction, as the first statement, so
that the work and the expenditure are atomic in both directions.

**Requirements.**

- A gate without a spend MUST fail the build.
  **FAILURE MODE:** a gate with no spend leaves the grant replayable — and every
  functional test still passes, because the action works. The defect is invisible
  behaviourally.
- Every registered action MUST have a gate. Every gate MUST have a spend for the same
  action. Both directions MUST be verified by static guard.
- Any direct expenditure outside this pattern MUST be declared.
- Arguments MUST be **exactly** the keys the registry binds: no more (extras are
  ignored, so binding them is a false sense of protection) and no fewer (a missing key
  hashes as absent and will not match).
- The bound value MUST be the value the handler is about to **write**, never the value
  the client claimed.

### 2.7.6 Refuse before spending

**Requirement.** Every refusal MUST be answered before the grant is spent.

**RATIONALE.** A request that delivers nothing MUST NOT cost a verification the person
then has to repeat — least of all a provider-only account, which completes a full
re-consent round trip through an external provider to obtain one.

### 2.7.7 Gate the operation, not the announcement

**Requirement.** The gate MUST be placed on the operation that produces the effect, not
on the operation that requests it.

**RATIONALE, from the audit that found both instances.** Two endpoints reached a gated
effect by an ungated route: the export *request* was gated while the *download* — the
actual disclosure — was not; and *adding* a credential was gated while *removing* one
was not. The question to ask of every gate is: where does the effect land, and does a
second endpoint reach it?

### 2.7.8 Proof methods

| Method | Requirement |
|---|---|
| Password | Compared only in the sign-in path and the step-up path. No other route may compare a password. |
| Provider re-consent | A full round trip. The returned subject identifier MUST match the linked identifier on the account; a different one is a wrong answer and MUST cost an attempt. |

**Requirement.** A provider-only account MUST be able to satisfy step-up. An action
whose only proof method is a password is unavailable to it.

**Requirement.** Step-up attempts MUST be rate-limited separately from sign-in, because
the caller is already authenticated and the limits serve a different purpose.

### 2.7.9 Acceptance criteria for §2.7

| # | Criterion |
|---|---|
| AC-2.7.1 | Every grant is action-, argument-, session-bound, time-limited and single-use. |
| AC-2.7.2 | A gate with no matching spend fails the build. |
| AC-2.7.3 | A registered action with no gate fails the build. |
| AC-2.7.4 | Every gate argument is a registry literal. |
| AC-2.7.5 | Bound arguments match the registry exactly. |
| AC-2.7.6 | Every refusal precedes expenditure, asserted per refusal. |
| AC-2.7.7 | Export download and provider unlink are gated, not only request and link. |
| AC-2.7.8 | A provider-only account can satisfy every sensitive action. |
| AC-2.7.9 | A grant cannot be replayed, cross-used, or used from another session. |
| AC-2.7.10 | Step-up is rate-limited separately from sign-in. |

---

## 2.8 Transport, headers and browser-side protections

### 2.8.1 Security headers

**Requirements.**

- Security headers MUST be applied before any route, so they cover error responses.
- Content-Type sniffing MUST be disabled.
- Framing MUST be denied.
- Referrer policy MUST NOT leak paths cross-origin.
- Transport security MUST be asserted in production with a meaningful duration.

### 2.8.2 Content Security Policy

**Requirements.**

- A policy MUST be served in production.
- Script sources MUST be restricted to the application's own origin. Inline script MUST
  NOT be permitted.
- Connect sources MUST be restricted to the application origin and the realtime
  transport origin.
- Frame ancestors MUST be denied.
- No third-party script, font, style or image origin may be permitted, because none is
  used (P-6) and permitting an unused origin is a standing invitation.
- Violation reporting MAY be enabled. Where enabled, reports MUST pass through the same
  redaction as diagnostic capture.

### 2.8.3 CSRF

**Chosen defence, in layers:**

| # | Layer | Effect |
|---|---|---|
| 1 | `SameSite=Lax` on the session cookie | Blocks cross-site form posts, which is the overwhelming majority of the attack surface. |
| 2 | CORS scoped to the API prefix with an explicit origin allowlist | A cross-origin request from an unlisted origin cannot read a response. |
| 3 | State-changing operations use non-idempotent verbs and require a JSON content type | A simple form post cannot construct the request. |
| 4 | Step-up on the seven highest-consequence actions | Even a successful CSRF cannot reach them. |

**Requirement.** A synchroniser token MUST NOT be adopted in place of layers 1–3
without an assessment recording why they are insufficient. Adding a token while
believing it replaces those layers is a net loss, because the token becomes the
perceived protection and the layers are then relaxed.

**Requirement.** The realtime transport MUST authenticate on connection with the same
session mechanism, and MUST re-derive the principal (INV-004) rather than trusting the
handshake payload.

### 2.8.4 Rate limiting

**Requirements.**

- Distinct limits for: sign-in, registration, password reset, step-up, report filing,
  message sending, diagnostic intake, and geocoding.
- A limiter MUST be positioned before its handler so a limited request does no work.
- A limited response MUST NOT disclose remaining attempts or reset time.
- Limits protecting a resource from **volume** and limits protecting it from a **single
  source** are different controls and neither subsumes the other. Where both matter,
  both MUST exist. Specifically: a per-source limiter bounds one address and does
  nothing about a thousand; a global ceiling bounds total rows and does nothing about
  request volume.

### 2.8.5 The unauthenticated intake surface

Exactly one write endpoint accepts a request with no session: diagnostic capture. Its
existence is deliberate and its bounds are normative.

**RATIONALE for accepting unauthenticated writes.** The failures most worth hearing
about are those occurring before a session exists: the sign-in screen, a failed session
check, a bundle that will not boot. Requiring authentication hides exactly the class of
defect the subsystem exists to see.

**Requirements — four independent bounds, none of which subsumes another.**

1. A dedicated per-source rate limit.
2. A path-scoped body size cap, mounted **before** the global parser. Mounted after, the
   global parser wins and the cap does nothing. This MUST be verified by test, because
   both orderings read identically.
3. A ceiling on distinct client-created groups, beyond which overflow is counted in a
   single record.
4. Server-side normalisation of every field that could otherwise become a
   high-cardinality key, so no client-supplied string reaches a grouping column.

**Requirement.** Every response MUST be identical whichever bound applied.
**RATIONALE:** a distinct response for "ceiling reached" is a progress meter for an
attack, and a failure status invites the retry that amplifies the flood.

### 2.8.6 Acceptance criteria for §2.8

| # | Criterion |
|---|---|
| AC-2.8.1 | Headers apply to error responses, asserted by requesting a failing route. |
| AC-2.8.2 | The policy permits no third-party origin and no inline script. |
| AC-2.8.3 | Cookie is `SameSite=Lax`, `HttpOnly`, `Secure` in production. |
| AC-2.8.4 | CORS is scoped to the API prefix with an explicit allowlist. |
| AC-2.8.5 | The realtime transport authenticates and re-derives the principal. |
| AC-2.8.6 | Each named surface has a distinct limiter, positioned before its handler. |
| AC-2.8.7 | The intake body cap is proven effective by test. |
| AC-2.8.8 | Intake responses are identical across all four bounds. |

---

## 2.9 Audit logging

### 2.9.1 Purpose

Answer, later, who did what to whom and when — for operational questions and for
questions asked by a parent, a school, or a district.

### 2.9.2 Two trails, deliberately

| Trail | Scope | Retention | Answers |
|---|---|---|---|
| **Operational audit** | Every administrative action, platform-wide | Swept at a bounded age | "What has been happening on this platform?" |
| **Subject-scoped history** | One report, one appeal, one account | **Permanent** — exempt from sweeps | "What happened in this case?" |

**Requirement.** An act that is both administratively notable and case-relevant MUST be
written to **both**.

**RATIONALE.** The operational trail is swept. A suspension is permanent and appealable
years later, and "who read this student's private messages" is exactly the question
asked long after the sweep window — at which point the operational row is gone. Writing
to one and not the other produces a record that disagrees with itself.

### 2.9.3 Required fields

| Field | Requirement |
|---|---|
| Actor | Always present for an administrative act. INV-011. |
| Action | From a closed registry (Appendix D). |
| Subject | The person the act concerns. For a case, the **reported party** rather than the reporter, because "whose case was this" is the question the record answers. |
| Timestamp | Zone-marked. |
| Structural detail | What changed, in a form readable without the application. |

### 2.9.4 What MUST NOT be recorded

| Excluded | Reason |
|---|---|
| Message bodies | The operational trail has a broader audience than the conversation. Where a content record is needed, the evidence system holds it under its own capability. |
| Moderator-authored case notes | Frequently quote a student's report. They already live in two places retained longer than this trail. |
| Passwords, tokens, grant identifiers | Never, in any form. |
| Unredacted free text | Subject to the redaction rules in §2.9.7. |

**Requirement.** Where a record of content is required for integrity rather than
reading, a **hash** MUST be stored rather than the content.

### 2.9.5 INV-023 — Audit is transactional

**INVARIANT.** An audit record MUST be written in the same transaction as the act it
records.

**FAILURE MODE.** The act commits and the record fails: a report whose status changed
with nothing recording who changed it — the one state the trail exists to make
impossible. Or the record commits and the act fails: a trail describing something that
never happened, which is worse, because it is evidence of a thing that did not occur.

### 2.9.6 Read logging

**Requirement.** A read MUST be logged where, and only where, it **discloses content
the reader would not otherwise see**.

**Requirements in detail.**

- Reading preserved evidence MUST be logged, to both trails, before the content leaves
  the process (INV-014).
- Reading a report's own metadata MUST NOT be logged, because the queue listing already
  returns those fields to the same capability. Logging one and not the other produces a
  trail that reads as complete and is not.
- Ordinary page views MUST NOT be logged. Logging every read makes the trail unusable
  by volume, which is a way of destroying it.
- A read MUST NOT be logged unless it happened. **Prefetching audited data is
  prohibited** (Volume I §1.7.7): it manufactures records of disclosures nobody
  performed, which makes the trail unusable in the direction it exists to serve — worse
  than having no trail.

### 2.9.7 Redaction

**Requirement.** Free text captured for diagnostics MUST be redacted **before** it is
stored, not on the way out.

**Requirements in detail.**

- Rules MUST be applied most-specific-first, so a structured token is recognised before
  a generic rule consumes its segments.
- Truncation MUST be applied **last**, so a secret near the end of a long value is
  redacted before the cut rather than preserved by it.
- Identifying a person MUST use a one-way hash, never an identifier.
- A route MUST be stored as a **pattern**, never with its parameters interpolated, with
  query and fragment removed before matching. This is what keeps a reset token or an
  authorization code out of the store entirely.
- There MUST be **no column for a request body**. Not "unpopulated" — absent, so that a
  later change which seems harmless cannot begin filling it.
- Structured context MUST be an allowlist, not a denylist. A denylist fails on the
  first field nobody anticipated.

### 2.9.8 Trail integrity

**Requirements.**

- Subject-scoped histories MUST be append-only at the **storage layer**.
  **RATIONALE:** a test asserts that the code path somebody wrote behaves; a storage
  constraint asserts it for every path anybody ever writes, including an operational
  script and a database console.
- A superseded decision MUST be retained. Where a record is reversed, the reversal is a
  new entry; the original MUST NOT be edited or removed.
- Where a status column must remain mutable for a workflow to progress, the immutability
  constraint MUST enumerate the columns it protects rather than protecting the whole
  row.
  **Requirement:** a column subject to a referential nullification MUST be excluded from
  that enumeration, because such a nullification performs a real update and does fire
  update constraints — naming it would abort the retention sweep instead of the
  tampering.

### 2.9.9 Acceptance criteria for §2.9

| # | Criterion |
|---|---|
| AC-2.9.1 | Every administrative action writes an operational record with an actor. |
| AC-2.9.2 | Every case-relevant action additionally writes a permanent subject-scoped entry. |
| AC-2.9.3 | No trail contains message bodies, case notes, credentials or unredacted text. |
| AC-2.9.4 | Audit records are written in the same transaction as their act. |
| AC-2.9.5 | Evidence reads are logged to both trails before disclosure. |
| AC-2.9.6 | Metadata reads are not logged as disclosures. |
| AC-2.9.7 | No audited data is prefetched. |
| AC-2.9.8 | Redaction is most-specific-first with truncation last, verified per rule. |
| AC-2.9.9 | No request-body column exists on any diagnostic table. |
| AC-2.9.10 | Subject-scoped histories reject update and delete at the storage layer. |
| AC-2.9.11 | The retention sweep runs without tripping an immutability constraint. |

---

## 2.10 Super Admin security

### 2.10.1 Purpose

Constrain the most privileged principal so that its errors are visible and its
compromise is bounded. The ownership *model* is specified in Volume IV §4.1; this
section specifies its **security** properties.

### 2.10.2 The wildcard and its consequences

The owner role holds a wildcard, so the kernel answers true for every capability.
Consequences that MUST be handled everywhere:

| Consequence | Requirement |
|---|---|
| Cascades are not exclusive | INV-007, §2.3.6. |
| Typos resolve true | INV-021, §2.3.3. |
| Capability gates cannot constrain the owner | Constraint MUST be structural (§2.10.3) or evidentiary (§2.10.5). |
| Scoped views silently mis-scope | Cascade content MUST be asserted for the wildcard specifically, not only status. |

### 2.10.3 Structural constraints on the owner

Some operations MUST be refused **to the owner** despite the wildcard. Each is
enumerated with its mechanism.

| Operation | Rule | Mechanism |
|---|---|---|
| Assign, remove or alter the owner role | Prohibited for every principal (INV-008). | No route accepts the role as a parameter; the role is absent from every writable enumeration. |
| Delete an owner account | Prohibited. | Deletion path refuses on immutable role. |
| Suspend an owner account | Prohibited. | Suspension target rule refuses. |
| Reduce the owner count below two | Prohibited. | Guard on the count (INV-009). |
| Self-grant a super-only capability | Meaningless but MUST still be refused. | Grant path refuses super-only. |

**Requirement.** These MUST be enforced by absence of mechanism where possible, not by
a permission check. A permission check against a wildcard holder passes.

### 2.10.4 Suspension target rules

Ordered most-privileged-first, terminating in an explicit deny.

1. Self-suspension MUST be refused.
2. An owner account MUST NOT be suspended by anyone, including another owner.
3. An account holding the suspension capability MUST be suspendable only by a principal
   holding the owner-only administration capability.
4. Anything else: explicit deny.

**Requirement.** Rule 3 MUST be expressed as a **capability** question about the target,
not a role comparison. The suspension capability is grantable, so a role comparison
would refuse to protect a granted holder while protecting a role-based one.

### 2.10.5 Evidentiary constraints

Where the owner cannot be prevented, the act MUST be **visible**.

**Requirements.**

- Every owner action MUST produce an operational audit record like any other.
- A self-review MUST produce a **distinct** action identifier, so it is queryable as a
  class rather than discoverable by inspection.
- Break-glass use MUST produce an unconditional, distinctly identified record (§2.11).
- Impersonation, when built, MUST record both the acting and the impersonated identity
  on every action taken during it, and MUST NOT be silently enterable. See Volume IV
  §4.6.

### 2.10.6 Operational requirements for owner accounts

| # | Requirement |
|---|---|
| O-1 | Each owner account MUST have a unique credential shared with nobody. |
| O-2 | Each MUST have multi-factor authentication at its identity provider where a provider is used. |
| O-3 | The two owner accounts MUST NOT share a recovery channel. A single compromised mailbox MUST NOT reach both. |
| O-4 | The second owner account MUST NOT be used for routine work. Its purpose is recovery and continuity. |
| O-5 | Owner credentials MUST NOT be stored in the repository, in the deployment host's environment beyond what the process needs, or in any documentation. |
| O-6 | A quarterly review MUST confirm the owner count is exactly two and both accounts are intended. The review MUST be recorded. |

### 2.10.7 Acceptance criteria for §2.10

| # | Criterion |
|---|---|
| AC-2.10.1 | No route accepts the owner role as an assignable value. |
| AC-2.10.2 | Deleting or suspending an owner account is refused, asserted by test. |
| AC-2.10.3 | The owner count cannot be reduced below two. |
| AC-2.10.4 | Suspension target rules are capability-based and ordered most-privileged-first. |
| AC-2.10.5 | A self-review writes a distinct action identifier. |
| AC-2.10.6 | Every cascade is asserted for wildcard **content**, not only status. |
| AC-2.10.7 | The owner-count review has a recorded execution. |

---

## 2.11 Break-glass recovery

### 2.11.1 Purpose

Restore platform administration when the normal path is unavailable, without creating a
path an adversary can use.

### 2.11.2 Scenarios in scope

| # | Scenario | Recovery |
|---|---|---|
| B-1 | Both owner accounts locked out (credential loss) | §2.11.4 |
| B-2 | Owner account compromised | §2.11.5 |
| B-3 | Every administrator suspended or demoted in error | §2.11.4 |
| B-4 | A report names the only administrator | Self-review path, §2.4.4 — not break-glass. |
| B-5 | Signing secret compromised | §2.11.6 |
| B-6 | Database corrupted or lost | Restore, Volume V §5.8. |

### 2.11.3 Governing principles

| # | Principle |
|---|---|
| BG-1 | Break-glass requires **host access**. It MUST NOT be reachable over the network by any credential. |
| BG-2 | Break-glass MUST leave an unconditional record. The record MUST NOT be suppressible by the operator using it. |
| BG-3 | Break-glass MUST be the **narrowest** action that restores administration — never a general escape hatch. |
| BG-4 | Break-glass MUST NOT weaken any invariant. It MUST NOT create a third owner, MUST NOT bypass immutability, MUST NOT alter a published legal hash. |
| BG-5 | Every procedure MUST have been **executed** in a drill. An unexercised procedure is a hypothesis (Volume I §1.10.3). |

### 2.11.4 Procedure: lockout

Preconditions: host shell access; a current backup; the process may be running.

1. Take a fresh backup and verify it restores. Do not proceed otherwise.
2. Record the intent: who is performing this, why, and what will change.
3. Execute the credential-reset operation against the target owner account. It MUST
   only: clear the suspension state if present, reset the credential to a
   single-use value, and increment the token version.
4. It MUST NOT: alter the role, create an account, grant a capability, or touch any
   other account.
5. It MUST write an operational audit record naming the operator as recorded at step 2,
   the target, and the reason. The write MUST be unconditional.
6. Sign in, set a new credential through the normal path, and confirm the record from
   step 5 is visible in the audit surface.
7. Record completion in the incident log with the timestamp and what was verified.

**Requirement.** The operation MUST refuse to run against an account that does not
already hold the owner role. It restores access to an existing owner; it does not create
one.

### 2.11.5 Procedure: compromise

1. Rotate the signing secret. This invalidates every session platform-wide, including
   the adversary's. Accept the cost.
2. Reset the compromised owner's credential per §2.11.4.
3. Query the operational trail for every action by that account across the suspected
   window. Enumerate them.
4. Reverse what is reversible, in this order: capability grants, role changes,
   suspensions, then content changes.
5. Anything irreversible MUST be recorded in the incident log as irreversible, with
   what was lost.
6. Notify per Volume V §5.12.
7. Verify the owner count is exactly two and both are intended.

**Requirement.** Step 3 depends on the trail being complete and on read-disclosures
being logged. This is the scenario those requirements exist for.

### 2.11.6 Procedure: secret compromise

1. Generate a new secret meeting the strength requirement.
2. Replace it and restart. Every session ends.
3. Announce the forced sign-out through the notification channel, because otherwise
   every user experiences an unexplained sign-out and a portion will conclude the
   platform is broken.
4. Record the rotation.

### 2.11.7 Acceptance criteria for §2.11

| # | Criterion |
|---|---|
| AC-2.11.1 | No break-glass operation is reachable over the network. |
| AC-2.11.2 | Every break-glass operation writes an unsuppressible record. |
| AC-2.11.3 | The credential reset refuses a non-owner target and cannot create an account. |
| AC-2.11.4 | No break-glass operation can produce a third owner. |
| AC-2.11.5 | Each procedure has a dated drill record. |
| AC-2.11.6 | Secret rotation is documented with its announcement obligation. |

---

## 2.12 Consolidated threat model

Each row states the threat, the adversary, the primary control, the secondary control,
and the residual risk. Residual risk is stated honestly; a threat model claiming no
residual risk is not a threat model.

| # | Threat | Adversary | Primary control | Secondary control | Residual |
|---|---|---|---|---|---|
| T-01 | Session theft via script | A-1, A-4 | `HttpOnly`; CSP with no inline script | Bounded lifetime | A browser extension with host permissions is out of scope. |
| T-02 | Session theft via network | A-4 | `Secure`; transport security | Same-origin delivery | A compromised device is out of scope. |
| T-03 | CSRF | A-4 | `SameSite=Lax` | Scoped CORS; verb and content-type requirements; step-up on the seven | A browser ignoring `SameSite` is out of scope. |
| T-04 | Privilege escalation by role edit | A-1, A-2 | Role not writable by any route; INV-008 | Audit on every role change | An operator with host access is in scope only for break-glass, which is recorded. |
| T-05 | Privilege escalation by capability grant | A-5 | Grant requires a capability; super-only ungrantable | Audit; grants enumerable per account | A compromised administrator can grant within their own reach. Bounded by the grant audit and the quarterly review. |
| T-06 | Demoted actor retains access | A-2, A-5 | INV-004 re-derivation | Token version increment | None material. |
| T-07 | Suspended actor retains access | A-3 | Token version increment on suspension | Per-request status check | None material. |
| T-08 | Suspension evaded via provider sign-in | A-3 | Effective-suspension computation on both provider branches; §2.6.6 | Single-definition guard (INV-013) | None material. |
| T-09 | Evidence destroyed by its subject | A-2, A-3 | Severed cascades; capture at report time | Storage-layer immutability; deletion holds | Host-level database access. Break-glass is recorded but a determined operator with the host is unbounded. |
| T-10 | Report destroyed by reporter's own deletion right | A-3, and the platform's own privacy machinery | Nullifying rather than cascading; identity snapshot | Retention exemption | None material. |
| T-11 | Private messages read without record | A-5 | Distinct capability; disclosure logged to both trails before disclosure | No prefetch rule | An administrator may read legitimately and lie about why. Mitigated evidentially, not preventively. |
| T-12 | Adult reaching a specific minor privately | A-2 | Every conversation has an organizer or staff party; §3.1.5 | Reporting from within the conversation; evidence capture | An adult with a legitimate organizer relationship can message within it. This is the platform's function; the control is that it is recorded and reportable. |
| T-13 | Account enumeration | A-4 | Uniform responses on registration, reset, email-change, username check, invitation | Rate limits | Sign-in discloses existence by recorded decision. Reversible by one constant. |
| T-14 | Credential stuffing | A-4 | Combined-key failure counting; opaque limited response | Provider sign-in reduces password surface | An attacker with a valid credential is indistinguishable from the owner of it. Multi-factor at the provider is the only further control. |
| T-15 | Enforcement detail disclosure pre-auth | A-2, A-4 | No end date, reason or actor in the sign-in refusal | Detail delivered by notice to the account | Existence and suspension state are disclosed by recorded decision. |
| T-16 | Step-up replay | A-1 | Single-use, action-, argument-, session-bound grants | Build-failing gate/spend pairing | None material. |
| T-17 | OAuth state replay or cross-provider replay | A-4 | Single-use, nonce-bound, provider-bound state | Expiry | None material. |
| T-18 | Account takeover by address reassignment | A-1 | Links keyed on provider subject identifier | Linking requires session plus step-up | None material. |
| T-19 | Empty-credential authorization URL | A-4 (opportunistic), operator error | Construction-time credential refusal | Derived static guard over the provider set | None material. |
| T-20 | Diagnostic store used for exfiltration or flooding | A-1, A-4 | Four independent bounds; redaction before storage; no body column | Uniform responses | A determined flooder consumes the group ceiling; overflow is counted, not stored. |
| T-21 | Owner error with wildcard reach | A-6 | Structural refusals (§2.10.3) | Audit; two-owner continuity; recorded reviews | An owner can do anything the structure permits. Bounded evidentially. |
| T-22 | Signing secret weakness | A-4 | Boot-time refusal on absent, placeholder or weak | Rotation procedure | A secret leaked by other means; rotation is the remedy. |
| T-23 | Silent authorization regression | Any | Six build-failing guards | Derived subject sets | A guard nobody wrote. Mitigated by the derivation principle and by requiring every invariant to have one. |
| T-24 | Trail incompleteness at investigation time | A-5 | Transactional audit; dual trails; permanent subject-scoped histories | No-prefetch rule | Operational trail is swept; anything needed beyond that window must be in a subject-scoped history by design. |

---

## 2.13 Privacy considerations for this volume

| # | Requirement |
|---|---|
| P-2.1 | No personal data in any URL path, query string or fragment on any authenticated surface. |
| P-2.2 | Diagnostic capture identifies people by one-way hash only. |
| P-2.3 | The operational trail names subjects by identifier, never by embedded content. |
| P-2.4 | A disclosure of private content is capability-gated and recorded. |
| P-2.5 | An enforcement action's details reach its subject through a channel bound to the account, not through a response to an unproven request. |
| P-2.6 | A data export MUST include the enforcement actions and audit entries concerning the requester, and MUST NOT include another person's identity where that identity is not already known to the requester. |
| P-2.7 | No third-party origin appears in the content policy, because none is used. |

---

## 2.14 Accessibility requirements for this volume

Authentication and refusal surfaces are the screens a person reaches when something has
gone wrong, frequently under time pressure.

| # | Requirement |
|---|---|
| A-2.1 | Every form control has a programmatically associated label. Placeholder text is never the only label. |
| A-2.2 | Every refusal is announced to assistive technology on render, not merely present in the document. |
| A-2.3 | Focus moves to the refusal when it replaces the shell, and the recovery action is reachable by keyboard as the next stop. |
| A-2.4 | Error text is not conveyed by colour alone. |
| A-2.5 | A password field has a reveal control operable by keyboard, labelled by state. |
| A-2.6 | The step-up dialog traps focus, restores focus on close, and is dismissible by keyboard. |
| A-2.7 | Provider buttons state their status in text, not by styling alone. A misconfigured provider reads as unavailable in its accessible name. |
| A-2.8 | Every timing constraint (grant lifetime, lockout) is either announced or generous enough not to require announcement; a silent expiry is prohibited. |
| A-2.9 | Contrast on refusal surfaces meets the same threshold as the application, in both themes. |

---

## 2.15 Performance budgets for this volume

| Operation | Budget | Rationale |
|---|---|---|
| Principal construction | ≤ 3 ms, ≤ 3 queries | Runs on every authenticated request. |
| Capability decision | ≤ 0.05 ms, zero queries | Pure; called many times per request. |
| Password verification | 150–350 ms | Deliberately slow. A cost factor below the range is a defect. |
| Sign-in end to end | ≤ 500 ms at the 95th percentile | Dominated by verification. |
| Step-up grant open | ≤ 100 ms | |
| Grant expenditure | ≤ 5 ms | Inside a transaction. |
| Audit write | ≤ 3 ms | Inside the caller's transaction; MUST NOT dominate it. |
| Capability matrix test suite | ≤ 5 s | Exhaustive over the matrix; must stay cheap enough to keep exhaustive. |

**Requirement.** Password verification MUST NOT be tuned faster to meet the sign-in
budget. If the budget cannot be met, the budget is wrong.

---

## 2.16 Monitoring and failure modes

### 2.16.1 Signals

| Signal | Alert condition |
|---|---|
| Failed sign-in rate per source | Sustained elevation. |
| Failed sign-in rate platform-wide | Step change, suggesting credential stuffing. |
| 403 rate by capability | Step change, suggesting a regression or a probe. |
| Step-up failure rate | Elevation, suggesting a broken flow or an attack. |
| Provider callback failure rate by provider | Any sustained failure. |
| Boot guard failures | Any occurrence. |
| Migration checksum failures | Any occurrence. |
| Audit write failures | **Any occurrence, paged.** An audit write failing means acts are occurring unrecorded. |
| Owner-account sign-in | Every occurrence, recorded and reviewable. |
| Break-glass use | **Any occurrence, paged.** |

### 2.16.2 Failure modes

| # | Failure mode | Detection | Response |
|---|---|---|---|
| F-2.1 | Guard passes because its subject set is empty | Guards assert their subject set is non-empty | Fix the derivation. |
| F-2.2 | Exemption outlives its subject | Staleness assertion | Re-read and remove. |
| F-2.3 | Pin updated without re-reading | Not detectable automatically | Review duty; the update must record the re-read's conclusion. |
| F-2.4 | Capability added to a role without appendix update | Matrix derived from registry; appendix diff required by release checklist | Update in the same commit. |
| F-2.5 | New route ungated | Build-failing coverage guard | Gate or justify. |
| F-2.6 | Cascade reordered for readability | Wildcard content assertions | Restore order; strengthen the inline note. |
| F-2.7 | Gate added without spend | Build-failing pairing guard | Add the spend inside the transaction. |
| F-2.8 | Second minting path introduced | Sessions without identifiers cannot hold grants; step-up fails | Route through the single function. |
| F-2.9 | Effective-state check reverted to a status comparison | Single-definition guard over all server modules | Restore the predicate. |

---

## 2.17 Rollback and migration strategy for this volume

### 2.17.1 Rollback

| Change class | Rollback |
|---|---|
| New capability | Remove from the role list. Grants referencing it become inert; the kernel denies an unknown capability, so no action is required. Remove from the appendix in the same commit. |
| New gate on an existing route | Remove the gate. No data change. |
| New sensitive action | Remove the gate and the spend **together**. Removing the gate alone leaves an unreachable spend; removing the spend alone leaves a replayable grant. |
| Cookie attribute change | Revert. Existing cookies with the prior attributes remain valid until expiry; no forced sign-out. |
| Signing secret rotation | **Not reversible.** Sessions are gone. Plan accordingly. |
| Session identifier introduction | Not reversible without invalidating sessions minted with it. |
| Audit action rename | Prohibited. Add a new identifier; retain the old in the appendix as historical. Renaming makes past records unqueryable. |

### 2.17.2 Migration strategy

- A new capability MUST be added to the registry and the appendix in the same commit as
  the first gate that uses it, and MUST NOT be added speculatively.
- A capability MUST NOT be granted to a role before the data model supports what it
  implies.
  **RATIONALE, realised:** granting the messaging capability to administrators before
  the conversation model could hold an administrator replaced a permission error with
  an empty inbox — a worse outcome, not a better one, because the permission error was
  at least accurate.
- Adding a session claim requires a compatibility window in which the absence of the
  claim is tolerated, or an accepted forced sign-out. The choice MUST be stated.
- Adding an immutability constraint to an existing table MUST first verify no legitimate
  path currently performs the write being prohibited, including retention sweeps and
  referential nullifications.

---

## 2.18 Documentation requirements for this volume

| # | Requirement |
|---|---|
| D-2.1 | The kernel carries a header stating the cascade rule, the wildcard consequence, and the incident that produced the module. |
| D-2.2 | Every guard carries a header stating what it prevents and the failure mode. |
| D-2.3 | Every exemption carries its reason inline and is re-read when it moves. |
| D-2.4 | Appendix A matches the registry exactly. |
| D-2.5 | Appendix D lists every audit action with trigger, actor, subject, payload, trail and retention. |
| D-2.6 | Every break-glass procedure is a runbook with a dated drill record. |
| D-2.7 | The sensitive-action registry documents, per action, what is bound and why those keys. |
| D-2.8 | The enumeration decision is documented with the constant that reverses it. |

---

## 2.19 Volume II acceptance summary

Volume II is satisfied when:

- Every acceptance criterion in §§2.2.9, 2.3.10, 2.4.8, 2.5.5, 2.6.8, 2.7.9, 2.8.6,
  2.9.9, 2.10.7 and 2.11.7 holds.
- Every invariant attributed to Volume II — INV-002, INV-003, INV-004, INV-005,
  INV-006, INV-007, INV-021, INV-023 — is enforced by a build-failing test that has been
  observed to fail against an introduced violation.
- Every threat in §2.12 has its primary and secondary control implemented, and its
  residual risk recorded in the launch readiness assessment (Volume V §5.13).
- Every performance budget in §2.15 has been measured at least once, with the
  measurement recorded.
- Every break-glass procedure in §2.11 has a dated drill record.

**Cross-references.** Volume III applies this volume's authorization model to
moderation. Volume IV §4.1 specifies the ownership model whose security properties are
in §2.10. Volume V §5.3 specifies the boot guards §2.5.2 requires. Appendix A is the
normative capability registry; Appendix D the normative audit registry.
