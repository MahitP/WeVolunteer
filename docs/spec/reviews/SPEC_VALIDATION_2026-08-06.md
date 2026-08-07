# Specification-to-Code Validation

**Date:** 2026-08-06
**Validates:** `docs/spec/` v2.0.0-spec.1 against the repository at commit `ec2945b`
**Method:** Direct measurement. Every claim below was produced by executing a query,
reading the cited source, or running the code. No finding is inferred from the
specification's own text.

---

## 1. Scope and method

### 1.1 What was checked

| Area | Method |
|---|---|
| Database schema | Live queries against `pilot.db` — table list, column lists, trigger list, index list |
| Migrations | Registry enumeration; ordering-dependency reading |
| Capabilities and roles | Imported the kernel and enumerated it |
| Routes | Router-stack counts per module; gate classification |
| Frontend navigation | Read `NAV` and `APP_ROUTES` directly |
| API contracts | Spot-checked against handler source for the contracts the spec makes claims about |
| Audit events | Grepped every `recordAudit` call site and every action literal |
| Notification types | Full registry enumeration and dispatch-site census |
| Moderation lifecycle | Read the transition table and the closing rules |
| Authentication lifecycle | Read the refusal ordering and the verification allowlist |
| Deployment assumptions | Read every file in `deploy/` |

### 1.2 What was **not** checked

Stated so the gap is visible rather than implied.

- **Client component behaviour** beyond navigation and route tables.
- **The end-to-end browser spec**, which is not part of the standard loop.
- **Runtime performance against the budgets** in the volumes. No budget in the
  specification has been measured; §6.4 records this.

### 1.3 Posture

The specification was written three commits ago by the same author now validating it.
That is a conflict of interest, and this document is written against it: the default
assumption below is that **the specification is wrong and the repository is right**,
and each finding states which source of truth wins with a reason rather than a
preference.

---

## 2. Summary

| Class | Count |
|---|---:|
| Sections validated as accurate | 11 areas |
| **Conflicts requiring amendment** | **12** |
| Stale assumptions | 4 |
| Missing architecture details | 5 |
| Contradictions **within the repository** (not spec-vs-code) | 4 |
| **Regressions found in the code** | **2** |

**The most serious finding is not a specification error.** It is a live regression in
the code, introduced by this author in commit `b8434fd` two sessions ago: the
`ACCOUNT_SUSPENDED` notification — the most consequential mandatory notice on the
platform — is no longer visible to the test that verifies notification content exists.
See §5.1.

---

## 3. Validated as accurate

The following specification claims were measured and hold.

| # | Claim | Location | Measured |
|---|---|---|---|
| V-01 | 36 capabilities; 5 super-only | README §0.9, Appendix A | Exact match, name for name |
| V-02 | 5 roles; counts 9 / 14 / 19 / wildcard / 3 | Appendix A §A.4 | Exact match |
| V-03 | 125 routes across 18 modules | README §0.9 | Exact match, per module |
| V-04 | 45 tables | README §0.9, Appendix C | Exact match |
| V-05 | 16 immutability triggers, named | Appendix C §C.3 | Exact match, name for name |
| V-06 | 58 explicit indexes | Appendix C §C.6 | Exact match |
| V-07 | 18 versioned migrations; two sanctioned rebuilds (001, 018) | Appendix C §C.5 | Exact match |
| V-08 | 7 sensitive actions | README §0.9, Volume II §2.7.2 | Exact match |
| V-09 | 10 legal documents, all v1.0, hashes verify | Volume V LR-22 | All 10 verify; zero drift |
| V-10 | Report lifecycle: 5 states, transition table as specified | Volume III §3.3.3 | Exact match including the two refused transitions |
| V-11 | Sign-in refusal ordering: absent → suspended → provider-only → password | Volume II §2.2.3 | Exact match, including that provider-only is not counted as a failed attempt |
| V-12 | Admin navigation: Moderation Center, Opportunities, Messages, Notifications, Appeals | Volume IV | Exact match |
| V-13 | `audit.read` gates exactly one endpoint, and it is unrelated to the trail | Volume IV §4.4.2 | Confirmed: `/api/admin/system/status` only |
| V-14 | `error_events` has **no request-body column** | Appendix C §C.2.9 | Confirmed. Columns are id, fingerprint, occurred_at, stack, route, method, status_code, user_hash, role, user_agent, context |
| V-15 | Deployment is systemd units for a Linux host; a backup timer exists | Volume V §5.2.1 | Confirmed: service, backup service, backup timer, env example, README |
| V-16 | The suspension predicate has one definition and three enforcement doors | Volume III §3.8.4 | Confirmed, including the derived guard |
| V-17 | 10 tables are asserted preserved by the retention sweep | Appendix C | Confirmed: certificates, attendance, hours_ledger, reports, conversation_reports, conversation_report_messages, appeals, appeal_events, moderation_actions, report_evidence |

---

## 4. Conflicts

Each conflict states what the specification claims, what the repository does, **which
source of truth wins and why**, and the proposed correction. Nothing has been changed.

---

### C-01 — Retention classes are specified for 45 tables; only 4 periods are enforced

**Specification claims.** Appendix C assigns a retention class to every one of the 45
tables, including `AGED-1095d` for `event_comments`, `event_announcements`,
`application_conflicts` and `auto_select_runs`, and `EPHEMERAL` for
`data_export_jobs`.

**Repository does.** `RETENTION` in the retention worker has exactly **four** keys:
`messageDays`, `auditDays`, `deletedAccountDays`, `applicationDays`. The sweep issues
`DELETE` against exactly five targets: `messages`, `admin_audit_logs`, `applications`,
and — for purged accounts — `legal_acceptances` and `users`.

Separate sweeps exist elsewhere for diagnostics, step-up challenges, verification
tokens, revoked sessions and notifications. **Nothing sweeps** `event_comments`,
`event_announcements`, `application_conflicts`, `auto_select_runs` or
`data_export_jobs`.

**Which wins: the repository, on fact; the specification, on intent.** The
specification is describing a target state as though it were current, which is exactly
the failure mode Volume 0 §0.2 prohibits ("this specification does not contain
placeholders") and Volume I P-5 prohibits ("a prediction presented as a result").

**Proposed correction.** Appendix C gains a column distinguishing **enforced** from
**declared** retention, with the enforcing mechanism named per table. Tables with no
enforcing mechanism are marked `UNENFORCED` and carried into the launch readiness
assessment, because a published retention period the platform does not honour is a
false statement in the privacy policy (Volume V LR-20 already requires this and would
currently fail).

**Severity: high.** LR-20 is a blocking launch criterion. It cannot currently pass.

---

### C-02 — Two appeal identifiers are documented as audit actions; they are notification kinds

**Specification claims.** Appendix D §D.5.5 lists `APPEAL_DECISION_STANDS` and
`APPEAL_DECISION_REVERSED` in the **operational audit trail registry**, with actor,
subject, detail and a dual-trail marking.

**Repository does.** Neither is ever passed to `recordAudit`. Both are **notification
event types**: declared in `MANDATORY_NOTICE_EVENTS`, mapped in `EVENT_CATEGORIES` to
`ACCOUNT`, given content in the notification switch, and dispatched from a ternary in
the appeals route. The appeals path writes exactly three audit actions:
`APPEAL_VIEWED`, `APPEAL_REVIEWED`, `APPEAL_REOPENED`.

**Which wins: the repository.** The specification catalogued identifiers by grepping
for string literals without distinguishing the two registries they belong to. That is a
method error in the specification, not a defect in the code.

**Proposed correction.** Remove both from Appendix D §D.5.5. Add a note recording that
an appeal **decision** produces a notification but no distinct audit action, and raise
the question in §8 of whether it should — an appeal decision is an administrative act
against a person and the argument for recording it is strong.

**Severity: medium.** The appendix is wrong, and it is wrong in the direction of
overstating coverage.

---

### C-03 — The specification claims a content-coverage guard that does not exist

**Specification claims.** Volume III §3.6.2: "Every event type MUST have content. A
missing case MUST fail the build." Appendix E lists it as an obligation.

**Repository does.** The coverage test does **not** iterate the event registry. It
regex-scans `server/` for `dispatch('EVENT_NAME'` call sites and asserts only on what
that scan happens to find. Consequently:

- **10 of 40** registered event types have no content case and fall through to a generic
  placeholder — `APPLICATION_SUBMITTED`, `EVENT_LOCATION_CHANGED`, `EVENT_TIME_CHANGED`,
  `EVENT_FULL`, `SPOT_AVAILABLE`, `CERTIFICATE_REVOKED`, `PASSWORD_CHANGED`,
  `PASSWORD_RESET`, `EMAIL_VERIFIED`, `MAINTENANCE_NOTICE`. None is dispatched today, so
  the defect is latent rather than live.
- **There is no assertion** that every `MANDATORY_NOTICE_EVENTS` member has content,
  despite a comment in the content module asserting that the coverage test does exactly
  that.

**Which wins: the specification.** The requirement is correct and the code does not meet
it. A scanner keyed on call-site formatting is not a coverage guard; it is a guard over
the subset of call sites written in one style — precisely the enumeration failure
principle P-3 exists to prevent.

**Proposed correction.** Rewrite the coverage test to **derive** its subject set from
`EVENT_CATEGORIES` and `MANDATORY_NOTICE_EVENTS` rather than from a source scan, and
assert content for every member of both. Keep the dispatch-site scan as an additional
check for events dispatched but unregistered. Record the 10 contentless events as a
finding to resolve — each is either given content or removed from the registry.

**Severity: high.** This is a guard the specification relies on and that does not
function.

---

### C-04 — Mandatory-notice failure is swallowed when the error message contains "UNIQUE"

**Specification claims.** Volume III §3.6.5: "A mandatory notice that cannot be enqueued
MUST **throw**, rolling back the act."

**Repository does.** The dispatch catch block tests
`String(e.message).includes('UNIQUE')` and returns `null` **before** reaching the
mandatory-notice rethrow. The match is an unanchored substring test, not a check against
a specific constraint error code.

**Which wins: the specification, with a caveat.** The dedupe catch is legitimate — a
duplicate suppressed by the unique index is not a failure. But it currently swallows
**any** error whose message happens to contain that substring, for a mandatory notice,
which defeats the rollback guarantee that Volume III §3.6.5 and the suspension
transaction both depend on.

**Proposed correction.** Narrow the dedupe catch to the specific constraint condition,
and evaluate `isMandatoryNotice` **first** so that a mandatory notice can never be
swallowed by a message-text heuristic. Add a test that induces a non-dedupe error
containing the substring and asserts the suspension rolls back.

**Severity: high.** It weakens the guarantee behind the platform's most consequential
transaction.

---

### C-05 — A missing recipient silently voids a mandatory notice

**Specification claims.** Volume III §3.6.5, as above.

**Repository does.** `dispatch` returns `null` when the user row is absent, **before**
any mandatory handling. A mandatory notice addressed to a deleted or missing account
produces nothing and throws nothing.

**Which wins: undecided; this is a genuine design question, escalated in §8.** Throwing
would roll back a suspension because the target account vanished mid-transaction, which
is arguably correct and arguably a denial-of-service on the moderation path. The
specification does not currently address it at all, which is the actual defect.

**Proposed correction.** Volume III §3.6.5 gains an explicit clause for an absent
recipient, with a decision. The recommendation is to **throw for mandatory notices**,
because the enforcement transaction should not commit against a subject the platform
cannot identify — but this is the owner's call.

**Severity: medium.** A silent no-op on an enforcement notice.

---

### C-06 — The route→capability index implies route-level gates that do not exist

**Specification claims.** Appendix A §A.5.2 presents a "gate index by module" listing
capabilities per route module, which reads as declarative route-level gating.

**Repository does.** **60 of 125 routes** carry `authenticateToken` with no capability
middleware. They are declared in the completeness guard's route registry under three
categories: **32 `SELF_ONLY`**, **19 `INLINE_GATED`**, **9 `OPEN_TO_AUTHENTICATED`**.

The announcement routes are a worked example: Appendix A §A.4.2 claims they "accept
`event.moderate` **or** `announcement.post`". The behaviour claim is **correct** — the
handler tests both capabilities inline — but the routes carry no `requireCapAny` gate,
so the appendix describes effective authorization as though it were declared
authorization.

**Which wins: the repository, and it is more rigorous than the specification described.**
Guard 2 walks the **live router stack** rather than source text, and requires every
ungated authenticated route to be declared with a category and a one-line reason. The
specification's INV-005 ("a capability gate, or a reviewed one-line justification")
understates a three-category registry of 60 entries.

**Proposed correction.** Appendix A §A.5.2 is replaced with (a) the three-category
breakdown with counts, (b) a statement that the authoritative inventory is derived from
the live router stack, and (c) an explicit note that a capability listed against a
module may be enforced inline rather than at the route. Volume II §2.3.5 is amended to
describe the three categories by name.

**Severity: medium.** The specification is less accurate than the code, in a way that
would mislead an implementer into thinking gating is more declarative than it is.

---

### C-07 — An unverified account cannot correct a mistyped address

**Specification claims.** Volume II §2.2.5: an unverified account "MUST be able to
reach: the verification wall, the resend action, sign-out, **settings sufficient to
correct the address**, and every legal document."

**Repository does.** The email-gate allowlist is exactly: `/api/auth/me`,
`/api/auth/verify-email`, `/api/auth/resend-verification`, `/api/auth/logout`,
`/api/auth/account`, `/api/notifications`, plus the prefix `/api/auth/reauth/`.
`/api/auth/change-email` is **not** allowlisted. An unverified account that registered
with a mistyped address can resend verification to the wrong address, or delete the
account. It cannot correct the address.

**Which wins: the repository, on security; the specification, on product.** Permitting
an unverified account to change its address turns registration into an open relay for
verification mail to arbitrary addresses. That is a real abuse vector and the current
behaviour is defensible.

But the resulting product state is that a typo requires deleting the account and
starting again, and nothing in the interface says so.

**Proposed correction.** Amend Volume II §2.2.5 to state the actual rule: an unverified
account may resend or **delete**, and address correction is deliberately unavailable
because it would make registration a mail relay. Add a requirement that the verification
wall **says this**, and offers deletion as the explicit remedy. Record the abuse
reasoning inline in the allowlist.

**Severity: medium.** The specification asserts a capability that does not exist; the
product has an unsignposted dead end.

---

### C-08 — Systemd restart limits exist; the specification implies they may not

**Specification claims.** Volume V §5.10 IN-5 and IN-6 require a restart backoff and
that automatic restart "MUST NOT mask a boot guard failure".

**Repository does.** The service unit sets `Restart=on-failure`, `RestartSec=5`,
`StartLimitBurst=5`, `StartLimitIntervalSec=120`. A boot-guard failure therefore
produces five restarts in two minutes and then a hard stop.

**Which wins: the repository. The requirement is already met.** This is recorded as a
conflict only because Volume V §5.13 lists infrastructure items as unverified, and this
one is verified.

**Proposed correction.** Volume V §5.10.2 AC-5.10.5 is marked satisfied, citing the
unit file. No code change.

**Severity: none.** Corrects an understatement.

---

### C-09 — Tenant scoping is presented as a table property; no tenant column exists

**Specification claims.** Appendix C gives every table a "tenant scope" property, and
Volume IV §4.12 specifies multi-tenancy.

**Repository does.** No table has a tenant column. Multi-tenancy is entirely unbuilt.

**Which wins: neither — the specification is correctly forward-looking but insufficiently
labelled.** Volume IV §4.12.1 does state "Not built. Exactly one implicit tenant
exists." Appendix C does not repeat that qualification, so read alone it describes a
schema that does not exist.

**Proposed correction.** Appendix C's tenant column is relabelled "tenant scope **when
introduced**" with a header note pointing at Volume IV §4.12.1.

**Severity: low.** A labelling defect, not a factual one.

---

### C-10 — Roughly 13 derived guards can pass over zero files

**Specification claims.** Appendix E §E.4.1 GD-2: every guard "MUST assert the subject
set is **non-empty**, or document why emptiness is tolerated". Volume I §1.5.4 states
the same. The rationale given is that "a guard whose derivation returns nothing passes
vacuously and looks green forever".

**Repository does.** At least **13 derived guards have no non-empty assertion**:

- The role-comparison guard over `server/` — **Guard 1 of the six**
- The suspension single-definition guard
- The `datetime('now')` comparison guard
- The orphaned-cleanup-function guard
- The raw-audit-insert guard
- Three guards in the synchronous-hashing/transaction/await family
- The hardcoded-colour guard
- The dangling-class prefix guard
- Two dialog-semantics guards
- Two tooling guards over `bin/`

Guard 1's absence is conspicuous: Guards 3, 4, 5 and 6 in the **same file** all carry
one. A refactor that renames `server/` or changes the walk's filter would leave the
platform's primary role-comparison guard reporting success over an empty set.

A subtler instance: the step-up header guard asserts the **file** walk is non-empty but
never that any gated call site was found. Renaming all five gated API methods would
leave it green over zero call sites.

**Which wins: the specification.** GD-2 is correct and is not met.

**Proposed correction.** Add non-empty assertions to all 13, and to the step-up guard add
a call-site-count assertion rather than a file-count assertion. This is mechanical, has
no behavioural risk, and is the single cheapest integrity improvement available.

**Severity: high.** These are the guards enforcing the platform's authorization and
suspension invariants.

---

### C-11 — Five exemption lists have no staleness assertion

**Specification claims.** Appendix E GD-4 and Volume I §1.2.3: "An exemption list MUST be
paired with a staleness assertion that fails when an exemption no longer matches
anything."

**Repository does.** Four of the six authorization guards do this correctly, as do the
suspension guard and the provider fixtures. But **five exemption lists do not**:

| Exemption | Guard |
|---|---|
| A blanket directory skip for an auth component folder | Hardcoded-colour guard |
| Three intentional marker classes | Dangling-class guard |
| A dynamic class stem | Error-style guard |
| Excluded client routes | Client-route allowlist guard — validates that reasons are non-empty and that entries do not overlap, but **not that the route still exists** |
| Shell paths | Internal-link guard — **partial**: fails only if a shell path became a real route, not if it became dead |

**Which wins: the specification.** GD-4 is correct and is not met in five places.

**Proposed correction.** Add staleness assertions. The client-route exclusion is the most
important: an exclusion for a deleted route survives forever and would silently cover a
future route that reused the path.

**Severity: medium.**

---

### C-12 — Several guards enumerate where the repository's own doctrine says derive

**Specification claims.** P-3, stated three times in the repository's own guard
docstrings ("derive the subject, do not enumerate it").

**Repository does.** Enumerated subject sets remain in: the CLI tool list, the
destructive tool list, the gated API method list, a 20-entry required-class list, an
error-capture file × component × boundary table with a magic call-site count, two
integration guards with fixed file lists and a `setInterval` count, and capability-count
assertions in the diagnostics route guard.

**Which wins: the specification, but the priority is low.** Each of these is a small,
slow-moving subject set, and several are anchored by exact-equality assertions that fail
loudly when the subject changes. This is technical debt, not a live hazard.

**Proposed correction.** Record in the debt register. Convert opportunistically when
touching each area. Do **not** convert as a batch — the churn would obscure the two
high-severity guard findings above.

**Severity: low.**

---

## 5. Regressions found in the code

These are defects in the repository, not in the specification.

### 5.1 `ACCOUNT_SUSPENDED` is invisible to the notification coverage test — introduced by this author

**What.** The coverage test discovers events by matching `dispatch(` immediately
followed by a quoted literal. In `adminRoutes.js`, a JSDoc block now sits between the
call and its first argument, so the pattern does not match. `ACCOUNT_SUSPENDED` is
therefore **not covered** by the test that verifies notification content exists, renders,
and contains no placeholder text.

**Verified directly.** Running the test's own regex against the file returns
`ORGANIZER_APPROVED, ACCOUNT_REINSTATED, ACCOUNT_WARNED` — and not `ACCOUNT_SUSPENDED`.

**Origin.** Commit `b8434fd`, "feat: suspensions that actually end on their own",
authored in this project two sessions ago. The comment explains why `suspendedUntil`
is passed. The explanation is correct and worth keeping; its **position** broke the
scanner.

**Why it matters.** This is the notice a suspended minor receives, containing the reason
and the appeal link. It is the notice with the strongest correctness requirement on the
platform, and it is now the one with the weakest test coverage.

**Recommended fix.** Two changes, and the second matters more:

1. Move the comment above the `dispatch(` call so the scanner sees the literal again.
2. **Fix the guard, not just the instance** — C-03. A guard that a comment can blind is
   a guard that will be blinded again. Deriving the subject set from the registry removes
   the failure mode permanently.

`APPEAL_DECISION_STANDS` and `APPEAL_DECISION_REVERSED` are invisible to the same
scanner for a different reason — they are dispatched from a ternary — and that one is
pre-existing.

### 5.2 A stale comment asserts a guarantee that does not exist

`server/services/notificationContent.js` states that the coverage test "asserts every
member has content". It does not; it never imports `MANDATORY_NOTICE_EVENTS`. Under
Volume I §1.2.9 a comment asserting a protection that does not exist is worse than no
comment: it causes a reader to believe a check is in place.

**Recommended fix.** Correct the comment in the same change as C-03, so the comment
becomes true rather than merely removed.

---

## 6. Stale assumptions in the specification

| # | Assumption | Reality | Action |
|---|---|---|---|
| S-01 | Every notification event type is reachable | **11 of 40** registered events are never dispatched: the 10 contentless ones plus `REMOVED_FROM_EVENT`, which has content and a category but no dispatch site | Decide per event: build, or remove from the registry. A registry of unreachable events is the same defect as a registered capability with no mechanism (Appendix A §A.8) |
| S-02 | `notifications.kind` has one vocabulary | **Two.** Production writes the six-value category vocabulary. A second, lowercase 14-value vocabulary exists in `utils.js` with a `createNotification` function that has **zero production call sites** | Remove the dead vocabulary and its function, or document why both exist. Two vocabularies in one column is P-8 violated |
| S-03 | Performance budgets are measurable targets | **No budget in the specification has ever been measured.** Volumes II, III and IV state budgets as though they were observed | Mark every budget "target, unmeasured" until a measurement exists |
| S-04 | The appendices are complete registries | Appendix D omitted the notification registry entirely, which is why C-02 occurred | Appendix D gains an explicit statement that it covers audit actions only, and cross-references the notification registry |

---

## 7. Missing architecture details

Things the repository does that the specification does not describe.

| # | Missing | Where it should go |
|---|---|---|
| M-01 | **Guard 2's three-category route registry**, with 60 declared entries and the live-router-stack walk | Volume II §2.3.5; Appendix A §A.5 |
| M-02 | **The notification registry itself** — 40 event types, 6 categories, 7 mandatory members — appears nowhere in the specification as a registry | New appendix, or an Appendix D section |
| M-03 | **`notification_jobs` has no dedupe**, unlike `notifications`. The email path can duplicate where the in-app path cannot | Volume III §3.6.6 |
| M-04 | **The dedupe pre-check is a 7-day window**, and there is a second dedupe layer at the unique index | Volume III §3.6.6 |
| M-05 | **`SYSTEM_ALERT` is categorised `ACCOUNT`**, not `SYSTEM`, deliberately — so the moderator alert is not suppressible by a system-category preference | Volume III §3.6.4, as a worked example of the mandatory-notice reasoning |

### 7.1 Static guard inventory — completed, and it is the largest finding

The inventory completed after §2 was drafted. It changes the picture substantially and
produces conflicts C-10 through C-12 below.

**Appendix E §E.4.2–E.4.3 claims 15 server and 8 client guards. The actual count is
72.** The specification undercounts the guard estate by a factor of three.

The estate is far richer than the specification describes. Guards exist that the
specification never mentions, including: no raw insert into the audit trail outside its
module; no synchronous password hashing in a route; **no `await` between a transaction's
opening and closing brace**; no comparison against a database-side `datetime('now')`;
every exported cleanup function has a caller outside its own module; the diagnostics
route mounts no authentication middleware and is *absent* from the authorization
registry; version fields agree across three manifests and the changelog; the runtime
version is pinned in five places including the service unit.

The `await`-inside-transaction guard is particularly notable: Volume I §1.7.4 states the
rule as a coding standard, and Volume V §5.9.6 CP-8 states it as a constraint on
pre-migration work. **Neither says it is already enforced by a build-failing guard.**
It is.

---

## 8. Questions requiring an owner decision

These cannot be resolved by reading code.

| # | Question | Why it needs you |
|---|---|---|
| Q-01 | Should an **appeal decision** write an audit action, not only a notification? | It is an administrative act against a person. C-02 revealed the absence; the specification's own INV-011 argues it should be recorded |
| Q-02 | Should a **mandatory notice to a missing recipient** throw? | C-05. Throwing rolls back enforcement when the subject vanishes; not throwing means an enforcement action commits with no notice |
| Q-03 | What happens to the **10 contentless** and **1 orphaned** notification events? | Build or delete. Either is fine; leaving them is not |
| Q-04 | Is the **unverified address-correction dead end** acceptable? | C-07. The security reasoning is sound; the product consequence is a mistyped address requiring account deletion |
| Q-05 | Which **unenforced retention periods** are published? | C-01. Any published period with no enforcing mechanism is a false statement in the privacy policy and blocks LR-20 |

---

## 9. Recommended amendments

In priority order. None has been applied.

| # | Amendment | Target | Blocks |
|---|---|---|---|
| A-01 | Restore `ACCOUNT_SUSPENDED` coverage and **rewrite the coverage guard to derive from the registry** | Code + Appendix E | Nothing — do first, it is small and it is a live regression |
| A-02 | Narrow the dedupe catch and evaluate mandatory status first | Code + Volume III §3.6.5 | Nothing |
| A-03 | Split Appendix C retention into **enforced** and **declared**, and reconcile against the published policy | Appendix C + Volume V LR-20 | Launch (LR-20 currently fails) |
| A-04 | Remove the two notification kinds from Appendix D; add the notification registry as its own section | Appendix D | Nothing |
| A-05 | Replace Appendix A §A.5.2 with the three-category breakdown; amend INV-005's description | Appendix A + Volume II §2.3.5 | Phase 1 graph accuracy |
| A-06 | Correct Volume II §2.2.5 to the actual allowlist, with the abuse reasoning, and require the wall to signpost deletion | Volume II + code (copy) | Nothing |
| A-07 | Mark every performance budget "target, unmeasured" | Volumes II–IV | Nothing |
| A-08 | Relabel Appendix C's tenant column as forward-looking | Appendix C | Nothing |
| A-09 | Mark Volume V AC-5.10.5 satisfied, citing the unit file | Volume V | Nothing |
| A-10 | **Add non-empty assertions to the 13 vacuum-prone guards** (C-10) | Code | Nothing — mechanical, zero behavioural risk |
| A-11 | Add staleness assertions to the 5 exemption lists (C-11) | Code | Nothing |
| A-12 | Rewrite Appendix E §E.4 with the real inventory: **72 guards, not 23** | Appendix E | Phase 1 graph accuracy |
| A-13 | Record the enumerated-subject-set guards in the debt register (C-12) | Debt register | Nothing |

---

## 10. Verdict

The specification is **substantially accurate on structure** — every count, every
capability name, every trigger, every migration, the whole moderation lifecycle and the
whole authentication refusal ordering were verified exactly.

It is **inaccurate in three specific directions**, and the pattern is consistent: it
overstates enforcement.

1. It describes **target retention** as though it were enforced (C-01).
2. It claims a **coverage guard** that does not function (C-03).
3. It presents **inline authorization as declarative** (C-06).

It is also inaccurate in one direction that flatters the code less than it deserves: it
**undercounts the static guard estate by a factor of three** (§7.1), and omits several
guards — the no-`await`-in-transaction guard among them — that enforce rules the
specification states only as coding standards.

Two of those three are the specification claiming a protection the code does not
provide, which is the most dangerous class of specification error — it is exactly the
thing a reader relies on and does not re-check.

**The code, meanwhile, contains two live defects** (§5), one of which this author
introduced while shipping a feature the same specification describes as complete.

**The guard estate is strong but has a systemic weakness.** Thirteen derived guards —
including the platform's primary role-comparison guard — can pass over zero files
(C-10). The estate's own doctrine names this failure mode; the estate does not fully
apply it to itself.

**Recommendation, in order.**

1. **A-01 and A-02** — code fixes, both safety-adjacent, both small. Do first.
2. **A-10** — thirteen mechanical assertions with no behavioural risk. Cheapest
   integrity gain available.
3. **A-12** — required before the Phase 1 dependency graph can be relied upon, because
   the graph's "tests required" column assumes the guard inventory is known.
4. **A-03** — required before launch. It is a published-policy conflict, not a
   documentation defect: LR-20 cannot currently pass.

Everything else is documentation correction and can proceed in parallel.
