# Appendix A — Capability Registry and Matrix

**Status:** Normative registry
**Binds:** Volume II §2.3, Volume IV §4.1
**Currency obligation:** This appendix MUST be updated in the same commit as any change to
the capability registry (Volume I §1.9.2 R-8). An appendix that lags the registry is a
defect.

---

## A.1 How to read this appendix

The registry in `server/authz.js` is the **implementation** of this appendix. Where the two
disagree, Volume 0 §0.8 precedence applies: this appendix is presumed correct and the code
presumed defective, unless the code carries a header recording an incident that postdates
this document.

**The matrix in §A.4 MUST be derived from the registry by test, not transcribed.** The
tabular form here is for human reading. A test that reads this appendix and compares it to
the registry is acceptable; a test that hardcodes this table is not (P-3).

---

## A.2 Naming rules

| Rule | Detail |
|---|---|
| Form | `domain.action`, lower case, dot-separated. |
| Scope suffix | Where an action is scoped, the scope is a further segment: `event.edit.own`, `service.verify.own_event`. |
| Verb position | The action is last. `report.resolve`, not `resolve.report`. |
| No role names | A capability MUST NOT contain a role identifier. `admin.create` is the sole exception and names the *object* created, not the actor. |
| No negation | There is no `event.no_delete`. Absence is the negative. |
| Stability | A capability identifier is permanent. Renaming one invalidates every grant, every route gate and every historical audit reference. To change a name: add the new identifier, migrate gates, retire the old one from role lists, and retain it in §A.7. |

---

## A.3 The registry

36 capabilities. Columns:

- **Grantable** — may be attached to one account by a grant (Volume II §2.3.7).
- **Withholdable** — may be removed from an account whose role grants it.
- **Class** — the consequence class, used by review rules.

| # | Capability | Meaning | Grantable | Withholdable | Class |
|---|---|---|---|---|---|
| 1 | `admin.create` | Promote or revoke administrator standing; manage invitations | **No** | No | Ownership |
| 2 | `analytics.own_events` | Read statistics for events the principal runs | Yes | Yes | Read |
| 3 | `analytics.impact` | Read the community impact figures (`/impact`, `GET /api/impact`) | Yes | Yes | Read, privileged |
| 4 | `analytics.platform` | Read platform-wide analytics | **No** | No | Read, privileged |
| 5 | `analytics.public` | Read aggregate public analytics | Yes | Yes | Read |
| 6 | `analytics.school` | Read institution-wide analytics | Yes | Yes | Read, privileged |
| 7 | `announcement.post` | Post an announcement to an event's participants | Yes | Yes | Write |
| 8 | `appeal.review` | Read and decide appeals | Yes | Yes | Enforcement |
| 9 | `applicant.review` | Accept, reject or waitlist applications | Yes | Yes | Write |
| 10 | `application.withdraw` | Withdraw one's own application | Yes | Yes | Self |
| 11 | `attendance.mark` | Record attendance and confirm hours | Yes | Yes | Write, hours |
| 11 | `attendance.scan` | Use the check-in scanner | Yes | Yes | Write |
| 12 | `attendance.view` | Read attendance records | Yes | Yes | Read |
| 13 | `audit.read` | Read the operational audit trail | Yes | Yes | Read, privileged |
| 14 | `capability.grant` | Grant and revoke capabilities on other accounts | Yes | Yes | Authorization |
| 15 | `error.read` | Read diagnostic events | **No** | No | Read, privileged |
| 16 | `error.write` | Change diagnostic triage state | **No** | No | Write, privileged |
| 17 | `event.apply` | Apply to a shift | Yes | Yes | Write |
| 18 | `event.create` | Create an event | Yes | Yes | Write |
| 19 | `event.edit.own` | Edit an event the principal owns | Yes | Yes | Write |
| 20 | `event.moderate` | Moderate any event, including removal | Yes | Yes | Moderation |
| 21 | `event.view` | Read events | Yes | Yes | Read |
| 22 | `geocode.use` | Use the geocoding service | Yes | Yes | Read |
| 23 | `impersonation.start` | Begin a read-only impersonation session | **No** | No | Ownership |
| 24 | `message.send` | Participate in a conversation | Yes | Yes | Write |
| 25 | `organizer.approve` | Approve or deny a pending organizer | Yes | Yes | Moderation |
| 25a | `owner.console` | Read the Owner Center (`/owner`): service health, uptime monitors, incidents, usage and infrastructure status | **No** | No | Read, privileged |
| 26 | `portfolio.write` | Maintain one's own portfolio | Yes | Yes | Self |
| 27 | `qr.present` | Present a check-in code | Yes | Yes | Self |
| 28 | `report.evidence.read` | **Read preserved private message bodies** | Yes | Yes | Disclosure, highest |
| 29 | `report.resolve` | Work and decide reports | Yes | Yes | Moderation |
| 30 | `self.read` | Read one's own account | Yes | Yes | Self |
| 31 | `self.write` | Modify one's own account | Yes | Yes | Self |
| 32 | `service.verify.external` | Verify service performed outside the platform | Yes | Yes | Write, hours |
| 33 | `service.verify.own_event` | Verify service at an event the principal runs | Yes | Yes | Write, hours |
| 34 | `stats.self` | Read one's own statistics | Yes | Yes | Self |
| 35 | `user.suspend` | Suspend and reinstate accounts | Yes | Yes | Enforcement |
| 36 | `user.warn` | Issue a formal warning | Yes | Yes | Enforcement |

> **This table has drifted from the code, and the code is the registry.**
> `server/authz.js` is the single source of truth; `ALL_CAPABILITIES` there
> currently holds 53 names, and this table lists 37. The absent ones arrived with
> the v1.3 directory and organizations work and were never added here. That is a
> documentation debt, recorded rather than hidden: nothing enforces this table,
> and a capability missing from it is still enforced everywhere it matters.
> Read `server/authz.js` when the answer has to be right.

### A.3.1 Super-only capabilities

Nine. These MUST be declared explicitly even though the wildcard would satisfy them.

`admin.create`, `analytics.platform`, `audit.read`, `error.read`, `error.write`,
`impersonation.start`, `legal.edit`, `owner.console`, `persona.preview`

**RATIONALE for explicit declaration.** The kernel refuses any capability not named in the
registry. Without an explicit super-only list, a typo would resolve **true** for the
wildcard holder and false for everyone else — and the person testing the feature is the
owner. It works for them and nobody else, and no test fails (Volume II §2.3.3).

**Requirement.** A super-only capability MUST NOT be grantable. The kernel MUST refuse it
*before* consulting grants.

### A.3.2 The `report.evidence.read` split — why it exists

`report.evidence.read` is separate from `report.resolve`, and is **not** super-only. Both
properties are load-bearing.

| Property | Reason |
|---|---|
| Separate from `report.resolve` | Enables a triage-only helper: a person who sorts the queue and never reads a student's private messages — the most invasive power on this platform. |
| Not super-only | Grantability is the entire reason it exists as a separate name. A super-only capability is unreachable by grant, so the helper could not exist. |

**Requirement.** Any change merging these two capabilities destroys this role without
appearing to remove anything, and MUST be treated as a removal of a protection under
Volume 0 §0.8.

---

## A.4 Role × capability matrix

`●` held by role. `—` not held. `*` wildcard: every registered capability.

> **Corrected 2026-08-08.** `analytics.impact` was missing from both tables
> entirely — it postdates this appendix. It is held by `admin` and `super_admin`
> only: it was briefly held by every signed-in role, which made the community
> impact figures readable by students, and narrowing the holder set was the fix.
> `partner` is deliberately excluded; `analytics.public` is where a figure chosen
> *for* an outside reader would go. Rows below `analytics.impact` in the
> definition table are renumbered accordingly.

| Capability | student | organizer | admin | super_admin | partner |
|---|:---:|:---:|:---:|:---:|:---:|
| `admin.create` | — | — | — | * | — |
| `analytics.own_events` | — | ● | ● | * | — |
| `analytics.impact` | — | — | ● | * | — |
| `analytics.platform` | — | — | — | * | — |
| `analytics.public` | — | — | — | * | ● |
| `analytics.school` | — | — | ● | * | — |
| `announcement.post` | — | ● | — | * | — |
| `appeal.review` | — | — | ● | * | — |
| `applicant.review` | — | ● | — | * | — |
| `application.withdraw` | ● | — | — | * | — |
| `attendance.mark` | — | ● | ● | * | — |
| `attendance.scan` | — | ● | — | * | — |
| `attendance.view` | — | ● | ● | * | — |
| `audit.read` | — | — | ● | * | — |
| `capability.grant` | — | — | ● | * | — |
| `error.read` | — | — | — | * | — |
| `error.write` | — | — | — | * | — |
| `event.apply` | ● | — | — | * | — |
| `event.create` | — | ● | — | * | — |
| `event.edit.own` | — | ● | — | * | — |
| `event.moderate` | — | — | ● | * | — |
| `event.view` | ● | ● | ● | * | ● |
| `geocode.use` | — | ● | ● | * | ● |
| `impersonation.start` | — | — | — | * | — |
| `message.send` | ● | ● | ● | * | — |
| `organizer.approve` | — | — | ● | * | — |
| `portfolio.write` | ● | — | — | * | — |
| `qr.present` | ● | — | — | * | — |
| `report.evidence.read` | — | — | ● | * | — |
| `report.resolve` | — | — | ● | * | — |
| `self.read` | ● | ● | ● | * | — |
| `self.write` | ● | ● | ● | * | — |
| `service.verify.external` | — | — | ● | * | — |
| `service.verify.own_event` | — | ● | — | * | — |
| `stats.self` | ● | — | — | * | — |
| `user.suspend` | — | — | ● | * | — |
| `user.warn` | — | — | ● | * | — |

**Counts:** student 9, organizer 14, admin 19, super_admin all 36 by wildcard, partner 3.

### A.4.1 Deliberate widenings, recorded

| Capability | Widened to | Reason |
|---|---|---|
| `analytics.own_events` | admin | An administrator could see every application and every event but not one organizer's own statistics page. An inconsistency with the rest of administrative oversight. |
| `attendance.mark`, `attendance.view` | admin | Oversight of hours requires reading and correcting them. |
| `event.view`, `geocode.use` | partner | Neither route these gate had ever carried a partner-specific restriction; the prior role comparisons named only student, organizer or admin, so partner already passed both. Granting the capabilities preserves that behaviour now the routes ask the kernel. |
| `message.send` | admin | Granted **only after** migration 018 gave the conversation model a shape that can hold an administrator. Previously reverted, because it replaced a permission error with an empty inbox — a worse outcome, not a better one. |

### A.4.2 Deliberate narrowings, recorded

| Capability | Not held by | Reason |
|---|---|---|
| `stats.self` | organizer, admin | The endpoint it gates is scoped to a student's own volunteer statistics. Widening it would require the endpoint to answer a different question. |
| `announcement.post` | admin | Not needed: every announcement route accepts `event.moderate` **or** `announcement.post`, so administrators already reach them. Adding it would grant a capability that changes nothing, which makes the matrix less informative. |
| `event.create` | admin | An administrator creating events would be an organizer. The roles are separable and keeping them separate keeps `event.edit.own` meaningful. |

---

## A.5 Route → capability index

125 routes across 18 modules. Grouped by module. `—` means no capability gate; every such
route MUST carry a recorded justification (Volume II §2.3.5).

### A.5.1 Justified ungated authenticated routes

| Route class | Justification |
|---|---|
| Self-scoped reads and writes | Scoped entirely to the caller's own record; the scope *is* the authorization. |
| Notification list and read-state | Self-scoped. |
| Organizer agreement acceptance | **MUST NOT** be gated on any capability that accepting it grants. Gating it produces a lockout from the one page that undoes the lockout. |
| Conversation participation | Authorised by participant membership, which is a stronger check than a capability: it is per-conversation rather than per-role. |
| Appeal filing and reading by token | The subject has no session and no capability; the token is the authorization. |
| Legal document reads | Public by requirement. A person cannot be asked to rely on a policy they cannot read. |

### A.5.2 Gate index by module

| Module | Routes | Gates used |
|---|---|---|
| `authRoutes` | 6 | — (authentication itself) |
| `oauthRoutes` | 6 | — (authentication); `oauth.link` / `oauth.unlink` via AAL2 |
| `accountRoutes` | 14 | Self-scoped; AAL2 on `account.delete`, `password.change`, `email.change` |
| `userRoutes` | 5 | `self.read`, `self.write`, `event.view` |
| `eventRoutes` | 14 | `event.view`, `event.create`, `event.edit.own`, `event.moderate`, `geocode.use` |
| `applicationRoutes` | 4 | `event.apply`, `application.withdraw`, `applicant.review` |
| `attendanceRoutes` | 6 | `attendance.mark`, `attendance.view`, `attendance.scan`, `qr.present` |
| `contentRoutes` | 16 | `event.view`, `announcement.post`, `event.moderate`, `portfolio.write`, `stats.self`, `analytics.own_events`, `analytics.school` |
| `messageRoutes` | 14 | Participant membership; `event.apply` (blocking); `report.resolve` (admin conversation resolve) |
| `reportRoutes` | 1 | — (any authenticated user may file) |
| `adminRoutes` | 14 | `organizer.approve`, `analytics.school`, `report.resolve`, `report.evidence.read`, `audit.read`, `user.suspend`, `user.warn` |
| `appealsRoutes` | 9 | `appeal.review`; token-authorised for the subject |
| `privacyRoutes` | 3 | Self-scoped; AAL2 on `data.export`, `data.download` |
| `reauthRoutes` | 4 | — (the step-up mechanism itself) |
| `errorRoutes` | 5 | `error.read`, `error.write`; intake unauthenticated by requirement |
| `legalRoutes` | 2 | — (public) |
| `geocodeRoutes` | 1 | `geocode.use` |
| `weatherRoutes` | 1 | `event.view` |

**Requirement.** The authoritative index is produced by the Route Debugger (Volume IV
§4.5.5.3) from the route registry. This table is a summary and MUST NOT be relied upon for
verification.

### A.5.3 Notable gate decisions

| Route | Gate | Why not the obvious one |
|---|---|---|
| Admin conversation resolve | `report.resolve` | **Not** `message.send`. Participating in a conversation is one thing; selecting an arbitrary person by identifier to start one with is a moderation power. An organizer holds `message.send` and MUST NOT reach a stranger through it. |
| Evidence read | `report.evidence.read` | **Not** `report.resolve`. §A.3.2. |
| Report detail | `report.resolve` | Deliberately excludes evidence bodies from its response, so the split in §A.3.2 is not collapsed silently. |
| Blocking | `event.apply` | The capability that identifies a student, who is the party blocking is designed for. |
| Announcement routes | `event.moderate` **or** `announcement.post` | An alternative set, so administrators reach them without holding a capability that would otherwise change nothing (§A.4.2). |
| Warning | `user.warn` | **Not** `user.suspend`, which would make that name lie about what it permits; and **not** `report.resolve`, because sorting a queue must not carry the power to place a disciplinary notice on a student's record. |

---

## A.6 Grants and withholdings

### A.6.1 Grant rules

| # | Rule |
|---|---|
| GR-1 | A grant attaches one capability to one account. |
| GR-2 | A grant MUST NOT confer a super-only capability; the kernel refuses before consulting grants. |
| GR-3 | Granting requires `capability.grant`. |
| GR-4 | A principal MUST NOT grant a capability it does not itself hold. |
| GR-5 | A grant MUST record granter, subject, capability, reason and time. |
| GR-6 | A grant MAY expire. An expired grant MUST be inert without requiring a sweep. |
| GR-7 | Revoking administrator standing MUST revoke every grant on that account in the same transaction (Volume IV §4.2.7 RV-6). |
| GR-8 | Grants MUST be visible on the administrator roster (Volume IV §4.2.5). |

**RATIONALE for GR-4.** Without it, `capability.grant` is a wildcard: the holder grants
themselves anything, then uses it.

**RATIONALE for GR-7.** Without it, revoking the role leaves granted capabilities in place
— the account retains, for example, evidence-reading by grant after losing it by role. The
precise inverse of the intent, and invisible unless grants are displayed.

### A.6.2 Withholding rules

| # | Rule |
|---|---|
| WH-1 | A withholding removes one capability the role would grant. |
| WH-2 | Withholdings are computed per request, from stored state. |
| WH-3 | A withholding MUST be disclosed to the subject with its reason and its remedy. |
| WH-4 | The remedy surface MUST remain reachable while the withholding applies. |
| WH-5 | Withholdings MUST be threaded into the client's principal, so the interface does not offer controls the API will refuse. |
| WH-6 | Withholdings MUST be **ignored** for a wildcard principal (Volume IV §4.1.5 E-13). |
| WH-7 | Persona selection MUST ignore withholdings (Volume II §2.4.6). |

**RATIONALE for WH-7.** An organizer who has not accepted the agreement holds none of the
capabilities that reach a student — including the one that identifies them as an organizer.
Consulting withholdings during persona selection gives them *no* persona, so they fall
through to a terminal "no dashboard for this account": the one state where an explanation
matters most produces a dead end naming no reason, offering no next step, and hiding the
acceptance banner that exists precisely to be seen there. They are still an organizer.
They are an organizer who has not signed yet.

### A.6.3 The organizer agreement withholding

The only withholding presently in effect.

| Property | Value |
|---|---|
| Subject | Organizers who have not accepted the current agreement |
| Withheld | Every capability that reaches a student |
| Remedy | Accept the agreement |
| Remedy surface | The acceptance screen, which MUST be ungated (§A.5.1) |
| Binds administrators | **No.** Administrators are covered by the administrative responsibilities policy instead. |

**Requirement.** This is the case that justifies the role-comparison exemption in Volume II
§2.3.4: the agreement binds organizers and deliberately does not bind administrators, which
cannot be expressed as a capability because administrators hold the capabilities the
agreement gates.

---

## A.7 Retired capabilities

None. This section exists so that the first retirement is recorded rather than deleted.

**Requirement.** A retired capability MUST remain listed here with the release that retired
it and the identifier that replaced it, because historical audit records and expired grants
reference it (§A.2, stability rule).

---

## A.8 Capabilities specified but not yet built

| Capability | Status | Specified in |
|---|---|---|
| `admin.create` | Registered, super-only. Promotion, revocation and invitation mechanisms unbuilt. | Volume IV §4.2, §4.3; Volume VI P-03, P-05 |
| `impersonation.start` | Registered, super-only. Mechanism unbuilt. | Volume IV §4.6; Volume VI P-15 |
| `analytics.platform` | Registered, super-only. No surface reads it. | Volume IV §4.9; Volume VI P-13 |
| `audit.read` | Registered and held. Gates one unrelated status endpoint; the trail is unreadable. | Volume IV §4.4; Volume VI P-01 |

**Requirement.** A capability that remains registered with no mechanism for more than one
release MUST either be built or removed. A registered capability with no mechanism is
indistinguishable from an unfinished feature and will eventually be implemented by somebody
who has not read its specification (Volume IV §4.6.1).

---

## A.9 Verification obligations

| # | Obligation | Enforced by |
|---|---|---|
| VA-1 | Every role's capability set matches §A.4 | Test deriving the matrix from the registry |
| VA-2 | Every super-only capability is in the super-only list | Test |
| VA-3 | An unknown capability denies for a wildcard holder | Test |
| VA-4 | A super-only capability cannot be granted | Test |
| VA-5 | No role comparison exists outside the exemption list | Static guard, server and client |
| VA-6 | Every authenticated route is gated or justified | Static guard |
| VA-7 | Every client capability name exists in the registry | Static guard |
| VA-8 | Every gated route's capability has a plain-language name | Static guard (Volume II §2.4.7) |
| VA-9 | Every cascade is ordered most-privileged-first with an explicit deny | Test asserting wildcard **content**, not only status |
| VA-10 | The owner role appears in no writable enumeration | Static guard (Volume IV §4.1.3) |

**Requirement.** VA-9 MUST assert content. A cascade mis-ordered so the wildcard lands in a
narrow branch still returns 200 with a plausible body; a status assertion cannot detect it.
