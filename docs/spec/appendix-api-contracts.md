# Appendix B — API Contracts

**Status:** Normative registry
**Binds:** Volume I §1.7.2, Volume II §2.4, Appendix A
**Currency obligation:** Updated in the same commit as any endpoint change (Volume I
§1.9.2 R-8). The authoritative inventory is produced by the Route Debugger (Volume IV
§4.5.5.3) from the route registry; this appendix specifies the **contract rules** and the
notable contracts, not a transcription of all 125 routes.

---

## B.1 Universal contract rules

Every endpoint obeys these. They are stated once here rather than repeated per route.

### B.1.1 Request

| # | Rule |
|---|---|
| RQ-1 | State-changing operations use non-idempotent verbs and require a structured content type. A simple form post MUST NOT be able to construct one (Volume II §2.8.3 layer 3). |
| RQ-2 | Shape is validated before values are read; values before they are written. |
| RQ-3 | Every enumerated parameter is validated against a **closed set** and refused with the legal values. An unrecognised value MUST NOT be silently ignored or silently treated as absent. |
| RQ-4 | Type is checked before measurement. A length rule applied to a non-string is not a rule. |
| RQ-5 | Personal data MUST NOT appear in a path, query string or fragment. |
| RQ-6 | A body limit applies. Where a path-scoped limit is needed, it MUST be mounted **before** the global parser. |
| RQ-7 | An unknown field MUST be ignored, not refused. Refusing unknown fields makes every client addition a breaking change. |

### B.1.2 Response

| # | Rule |
|---|---|
| RS-1 | Every refusal carries a stable machine-readable `code` alongside a human `error`. Clients branch on the code; the message is free to change. |
| RS-2 | A refusal MUST NOT contain a stack trace, a query fragment, an internal identifier the caller cannot use, or the existence of a record the caller may not see. |
| RS-3 | A refusal that names a closed set MUST return that set, so a client can correct without documentation. |
| RS-4 | A list response MUST be bounded. An unbounded response MUST NOT be constructible. |
| RS-5 | Derived fields MUST be computed per request, never read from a stored total. |
| RS-6 | A response MUST NOT include a field the caller's capability does not entitle them to. Filtering client-side is not filtering. |

### B.1.3 Status codes

| Situation | Status | Code class |
|---|---|---|
| Malformed request | 400 | `invalid_*` |
| Unauthenticated | 401 | `unauthenticated`, `session_*` |
| Step-up required | 401 | `reauth_required`, with challenge metadata |
| Capability absent | 403 | `forbidden` |
| Capability present, subject rule refuses | 403 | Specific, e.g. `conflict_of_interest` |
| Suspended | 403 | `suspended` |
| Unverified where required | 403 | `email_unverified` |
| Absent, or present but invisible | 404 | `not_found` |
| State conflict | 409 | Specific, e.g. `already_closed`, `invalid_transition` |
| Rate limited | 429 | `rate_limited` |
| Provider unconfigured | 503 | `provider_not_configured` |
| System fault | 500 | Generic; no detail |

**Requirement.** Absent and invisible MUST be indistinguishable where existence is itself
protected. A conversation the caller is not a participant in answers 404, identically to one
that does not exist.

**Requirement.** Reaching a constraint violation, a parameter-binding failure or a
referential error **because input was not validated** is a 500 that should have been a 400.
Every such case is a defect, not an error-handling choice.

### B.1.4 Idempotency

| # | Rule |
|---|---|
| ID-1 | A resolve-or-create operation MUST be idempotent and MUST be enforced by a **constraint**, not only by a lookup. |
| ID-2 | A state transition MUST refuse a transition that is already applied where re-applying would overwrite a record — specifically, re-closing a closed report. |
| ID-3 | A single-use artefact (step-up grant, appeal token, invitation token) MUST be consumed atomically with the work it authorises. |

### B.1.5 Rate limiting

Distinct limiters for sign-in, registration, password reset, step-up, report filing,
message sending, diagnostic intake, and geocoding. A limited response MUST NOT disclose
remaining attempts or reset time (Volume II §2.8.4).

---

## B.2 Authentication

### B.2.1 Sign-in

`POST /api/auth/login`

Refusal order is normative (Volume II §2.2.3). Each position is a distinct code.

| Order | Condition | Status | Code | Counted as a failed attempt |
|---|---|---|---|---|
| 1 | No such account, or deleted | 401 | `no_such_account` | Yes |
| 2 | Suspended, by the **effective** computation | 403 | `suspended` | No |
| 3 | Provider-only account | 409 | `oauth_only` | **No** |
| 4 | Password mismatch | 401 | `wrong_password` | Yes |

**Requirement.** The `suspended` response MUST NOT contain the end date, the reason, the
imposing actor, or any other enforcement detail. It runs before the password check, so
anyone who can guess an address reaches it (Volume II §2.2.3).

**Requirement.** Position 3 MUST NOT count as an attempt: it is not a password guess, and
counting it would let anyone lock out a provider-only account through a route it cannot use.

**Requirement.** No refusal branch may set a session cookie. Asserted **per branch**.

### B.2.2 Session

| Rule |
|---|
| Claims: subject, token version, session identifier, issue, expiry. **No role. No capabilities.** |
| Every session carries a unique identifier; all minting through one function. |
| Cookie: `HttpOnly`, `SameSite=Lax`, `Secure` in production, narrowest workable path, bounded lifetime. |

---

## B.3 OAuth

### B.3.1 Provider advertisement

`GET /api/oauth/providers`

Returns per provider: identifier, label, whether implemented, and a **state**.

| State | Meaning |
|---|---|
| `available` | Credentials present; sign-in works |
| `misconfigured` | Implemented, credentials absent |
| `coming_soon` | Not implemented |

**Requirement.** The state MUST be computed from **credentials alone**, never from a flag a
development default can set.
**FAILURE MODE:** an expression including a mock-mode flag advertises every provider in every
development environment, which is how a credential-less provider reached production-looking
screens unnoticed.

**Requirement.** The three states MUST be distinguishable. An operator otherwise sees the
same screen as everyone else and cannot tell a missing credential from an unbuilt feature.

### B.3.2 Authorization URL

`POST /api/oauth/:provider/url`

| Condition | Status | Code |
|---|---|---|
| Credentials absent (either half) | **503** | `provider_not_configured` |
| Not implemented | 501 | `provider_not_implemented` |
| Success | 200 | URL, with a nonce cookie |

**Requirement.** The refusal occurs at **URL construction**, not at the button. The endpoint
is reachable directly, and the step-up flow calls the same construction path.

**Requirement.** The secret is checked alongside the identifier even though only the
identifier appears in the URL. A deployment with an identifier and no secret produces a URL
that works — the user signs in at the provider, returns with a real code, and the failure
surfaces at the token exchange, after the round trip, with a message about the exchange
rather than the configuration.

**Requirement.** The mock transport MUST NOT exempt this. It is a callback-side transport
with nothing to offer the redirect, which always goes to the real provider.

### B.3.3 Callback

`POST /api/oauth/:provider/callback`

| Case | Response |
|---|---|
| State never issued, replayed, or cross-provider | 400 |
| Linked identity, account deleted | 401, **and the stale link is cleared** |
| Linked identity, suspended by the **effective** computation | 403 |
| Linked identity, otherwise | 200, session |
| Address match, suspended or deleted | 403 / 401 |
| Address match, otherwise | Requires authenticated session as that account **plus step-up** |
| No match | 200, `signup_required` with a continuation token; **no account created** |

**Requirement.** Both sign-in branches MUST use the effective suspension computation. A
stored-status comparison refuses an account whose timed suspension has expired — and a
provider-only account has no other door, making it a permanent lockout from an account whose
sanction has ended, with nothing on screen to explain it.

**Requirement.** Linking creates a **new credential**, so a live session alone is
insufficient: the link logs in anyone presenting that identity from then on, long after the
session ends.

---

## B.4 Step-up re-authentication

### B.4.1 Registry

Seven actions: `account.delete`, `password.change`, `email.change`, `oauth.link`,
`oauth.unlink`, `data.export`, `data.download`.

**Unbuilt, specified:** administrator promotion, administrator revocation, invitation
creation, audit export (Volume VI P-01, P-03, P-05).

### B.4.2 Contract rules

| # | Rule |
|---|---|
| SU-1 | The gate is an **early refusal, not the check**. The handler MUST additionally spend the grant, inside its own transaction, as the first statement. |
| SU-2 | Bound arguments MUST be **exactly** the registry's keys: no more (extras are ignored, so binding them is a false sense of protection) and no fewer (a missing key hashes as absent and will not match). |
| SU-3 | The bound value MUST be what the handler is about to **write**, never what the client claimed. |
| SU-4 | Every refusal MUST be answered **before** the grant is spent. |
| SU-5 | The gate goes on the operation that produces the effect, not the one that requests it. |

**RATIONALE for SU-4.** A request that delivers nothing MUST NOT cost a verification the
person then has to repeat — least of all a provider-only account, which completes a full
re-consent round trip through an external provider to obtain one.

**RATIONALE for SU-5, from the audit that found both instances.** The export *request* was
gated while the *download* — the actual disclosure — was not; and *adding* a credential was
gated while *removing* one was not. Ask of every gate: where does the effect land, and does a
second endpoint reach it?

---

## B.5 Reporting

`POST /api/reports`

| Field | Rule |
|---|---|
| Target type | Closed set of seven |
| Target identifier | Required |
| Category | Closed set of eighteen. **Any valid category is accepted for any target.** |
| Description | Optional; generous maximum; stored as submitted |
| Priority | **Never accepted.** Derived server-side. |

**Requirement.** The per-target category filter is **presentation only**. Refusing a
distressed student over a category/target combination is worse in every way than filing a
slightly mis-categorised report.

**Requirement.** Filing against a conversation or a message captures evidence in the same
transaction.

**Requirement.** Self-reporting is refused explanatorily; the attempt is usually a
misunderstanding of what the control does.

---

## B.6 Moderation

### B.6.1 Queue

`GET /api/admin/reports` — gate `report.resolve`

| Filter | Validation |
|---|---|
| Status | Closed set, or `all` |
| Priority | Closed set |
| Category | Closed set |
| Target type | Closed set; an alias the client may still speak is normalised |
| Assignee | An identifier, `me`, or `unassigned` |

**Requirement.** Every filter is refused with its legal values. A mistyped filter that
silently returns everything, or nothing, shows a moderator a queue that is not the one they
asked for — and on that surface, "I saw no open reports" is the wrong thing to be wrong
about.

**Requirement.** Ordering: live before closed, then urgent before normal, then **oldest
first**. Newest-first starves the oldest unanswered report, which is by construction the one
most likely to be a real harm nobody answered.

**Requirement.** Counts are computed over the **whole table**, not the filtered page,
because their purpose is to tell a moderator what a filter is hiding from them.

### B.6.2 Detail

`GET /api/admin/reports/:id` — gate `report.resolve`

Returns the report with the same enrichment as the queue, the resolved **subject**, and the
append-only history oldest-first.

**Requirement.** Evidence bodies MUST NOT be in this response. Folding them in would collapse
the capability split silently: a triage-only helper would receive them on every open, while
the separate capability continued to look like it was doing something.

**Requirement.** This read MUST NOT be logged as a disclosure. The queue already returns
these fields to the same capability; logging one and not the other produces a trail that
reads as complete and is not.

**Requirement.** Route ordering: literal paths MUST be declared **before** parameterised
ones.
**FAILURE MODE, realised:** `/reports/:id` declared before `/reports/export` captured the
literal path with the identifier `export`, and the export answered 404 "report not found"
instead of a file — with both routes looking perfectly correct in isolation.

### B.6.3 Evidence

`GET /api/admin/reports/:id/evidence` — gate `report.evidence.read`

**Requirement.** The disclosure is recorded to **both** trails, in one transaction, **before**
the bodies leave the process.

**Requirement.** Each message carries both `created_at` (sent) and `captured_at` (frozen).
They are two facts; the gap is what makes "preserved copy" mean something rather than a label
the interface asserts.

**Requirement.** The client MUST NOT prefetch this. Prefetching manufactures records of
disclosures nobody performed.

### B.6.4 Update

`PATCH /api/admin/reports/:id` — gate `report.resolve`

| Refusal | Status | Code |
|---|---|---|
| Unknown status, priority, resolution, assignee shape | 400 | `invalid_*` |
| Closing with no resolution | 400 | `resolution_required` |
| Closing with a note too short or non-string | 400 | `resolution_note_required` |
| Actor is a party and lacks the escalation capability | 403 | `conflict_of_interest` |
| Already closed | 409 | `already_closed` |
| Illegal transition | 409 | `invalid_transition`, with the legal set |
| Assignee cannot moderate | 400 | `assignee_cannot_moderate` |

**Requirement.** The note's **type** is checked before its length.
**FAILURE MODE, realised:** a check reading `!note || note.length < N` passes for a number,
because a number has no length property. A numeric value closed a report with a note of "1.0"
— on the one field an appeal is reviewed against.

**Requirement.** Assignee validation asks whether the candidate **holds the capability**,
never their role. The capability is grantable precisely so a triage-only helper can exist,
and a role check would refuse to assign work to exactly that person.

**Requirement.** One history entry **per field changed**, in one transaction with the row
update and the audit record.

---

## B.7 Enforcement

### B.7.1 Suspend

`POST /api/admin/users/:id/suspend` — gate `user.suspend`

| Field | Rule |
|---|---|
| Reason | Required, minimum length |
| Until | Optional ISO instant. **Absent means indefinite.** |

| Refusal | Status | Code |
|---|---|---|
| Reason absent or short | 400 | `reason_required` |
| Deadline non-string | 400 | `invalid_until` |
| Deadline unparseable | 400 | `invalid_until` |
| Deadline in the past | 400 | `until_in_past` |
| Self | 400 | — |
| Owner target | 403 | — |
| Administrator target, actor not owner | 403 | — |
| Already suspended | 409 | `already_suspended` |

**Requirement.** A past deadline is refused, not accepted. It would end at the next request,
which reads to everybody as the suspension having silently failed.

**Requirement.** An unparseable deadline is refused at the write path, because the effective
computation **fails closed** on unreadable dates — so an unvalidated write would silently
produce the permanent suspension the moderator was trying to avoid.

**Requirement.** Status change, token version increment, appeal token, audit record and
mandatory notice are **one transaction**. The notice throws if it cannot be enqueued.

**Requirement.** A calendar date supplied by an interface MUST be sent as the **end** of that
day. A date parsed as midnight ends the suspension at the start of the chosen day, cutting it
a day short in most of the world.

**Requirement.** Active events hosted by a suspended organizer are **reported, not
cancelled**. Cancelling would strand students with no notice as a side effect of a moderation
action, and un-cancelling is not something this platform can do.

### B.7.2 Reinstate

`POST /api/admin/users/:id/unsuspend` — gate `user.suspend`

**Requirement.** Clears the deadline.
**FAILURE MODE:** a **future** deadline left behind is not inert. The account works again,
until somebody suspends it a second time without naming a deadline — and it silently inherits
the old one, ending on a date nobody chose.

**Requirement.** Spends outstanding appeal tokens.

**Requirement.** A reason is **optional**. Imposing a sanction has to be justified; removing
one does not, and requiring a paragraph before somebody can undo their own mistake is
friction pointed the wrong way.

### B.7.3 Warn

`POST /api/admin/users/:id/warn` — gate `user.warn`

**Requirement.** Changes **nothing** about the account: no status, no capability, no forced
sign-out. The notice promises that nothing has been removed, and that promise must be true.

**Requirement.** A **second** warning is accepted. The repeat is the escalation; refusing it
makes a second incident unrecordable.

**Requirement.** No appeal token is minted. Appeal routes require a suspended subject, so a
token minted here would be refused by them — a control that reliably fails.

**Requirement.** The notice is mandatory and the dispatch is inside the transaction, throwing
on failure. A warning recorded but undelivered is the exact defect this endpoint exists to
fix.

---

## B.8 Messaging

### B.8.1 Resolve an event-scoped conversation

`POST /api/messages/conversations/resolve`

Derives the participant triple from the event and the actor's relationship to it.

### B.8.2 Resolve an administrator conversation

`POST /api/messages/admin/conversations/resolve` — gate **`report.resolve`**

**Requirement.** Gated on the moderation capability, **not** the messaging capability.
Participating in a conversation is one thing; selecting an arbitrary person by identifier to
start one with is a moderation power, and an organizer holds `message.send`.

**Requirement.** Idempotent, enforced by a partial unique index (Appendix C §C.4 entry 1),
not only by the lookup.

**Requirement.** The counterparty's category is derived from **capabilities**,
most-privileged-first, with an explicit final deny. Testing the narrower capability first
classifies the platform owner as a student.

**Requirement.** Opening the channel is audited, and the detail reads as prose. This record is
read by a person asking why an administrator contacted a student.

### B.8.3 Send

`POST /api/messages/conversations/:id/messages`

Authorised by **participant membership**, not by capability.

| Refusal | Status | Code |
|---|---|---|
| Not a participant | 404 | `not_found` |
| Rate limited | 429 | `rate_limited` |
| Blocked | 409 | `conversation_read_only` — **the generic refusal** |
| Read-only by lifecycle | 409 | `conversation_read_only` |
| Empty or over-length | 400 | — |

**Requirement.** The block check precedes the lifecycle check, and uses the **generic**
refusal so the block is not announced to the blocked party.

**Requirement.** The notification's context line MUST be category-aware. An administrator
thread has no event by design, so an event-shaped fallback labels every message from an
administrator as being about a volunteer opportunity — which is exactly what it is not, in the
one case where the recipient most needs to know who is contacting them and why.

---

## B.9 Appeals

| Endpoint | Auth | Notes |
|---|---|---|
| `GET /api/appeals/token/:token` | **None** | The subject cannot sign in. Discloses only that an action exists, its reason, and the form. |
| `POST /api/appeals/token/:token` | None | Single-use. |
| `POST /api/appeals` | Session | For a subject who can still sign in. |
| `GET /api/appeals/mine` | Session | **Remains accessible after the enforcement ends.** |
| `GET /api/admin/appeals` | `appeal.review` | Queue |
| `PATCH /api/admin/appeals/:id` | `appeal.review` | Decision; reasoning required |

**Requirement.** A filed appeal remains accessible after the enforcement ends.
**FAILURE MODE:** a check requiring current suspension makes an appeal unreadable the moment
the suspension is lifted — including when it is lifted *because* the appeal succeeded.

**Requirement.** A reversal MUST NOT reinstate. Reinstatement is a separate act behind a
different capability, which the deciding reviewer may not hold — and the two MUST be linked
in both directions **by lookup**, so the link is recorded however the reinstatement was
reached.

---

## B.10 Diagnostics intake

`POST /api/errors` — **unauthenticated**, by requirement.

Four independent bounds, none subsuming another (Volume II §2.8.5):

1. Per-source rate limit.
2. Path-scoped body cap mounted **before** the global parser.
3. Ceiling on distinct client-created groups; overflow counted in a single record.
4. Server-side normalisation of every field that could become a high-cardinality key.

**Requirement.** Every response is **identical** whichever bound applied. A distinct response
for "ceiling reached" is a progress meter for an attack, and a failure status invites the
retry that amplifies the flood.

---

## B.11 Health

`GET /health` — unauthenticated

Reports: overall state, database connectivity, **database writability**, version,
maintenance state distinctly from unhealthy.

**Requirement.** Writability, not only connectivity. A read-only database answers
connectivity checks successfully while every write fails.

**Requirement.** Discloses no configuration value, path, user count or dependency version.

**Requirement.** Reports the workspace manifest's version. A test MUST assert both manifests
agree, because a root-only bump makes the running system misreport what it is.

**Requirement.** Responses below the compression threshold are returned uncompressed. This is
expected behaviour, not a defect.

---

## B.12 Verification obligations

| # | Obligation | Enforced by |
|---|---|---|
| VB-1 | Every endpoint refuses every role that must not reach it | Test per endpoint per role |
| VB-2 | Every filter is validated and refused with legal values | Test per filter |
| VB-3 | Every refusal carries a stable code | Test |
| VB-4 | No refusal leaks a trace, query fragment or unusable identifier | Test |
| VB-5 | Absent and invisible are indistinguishable where existence is protected | Test |
| VB-6 | Every gate is paired with a spend for the same action | Static guard |
| VB-7 | Every refusal precedes expenditure | Test per refusal branch |
| VB-8 | Every client `api.X()` call exists on the client's API surface | Static guard |
| VB-9 | Every literal path is declared before any parameterised path that would capture it | Test per literal path |
| VB-10 | No response includes a field the caller's capability does not entitle them to | Test |
| VB-11 | Every endpoint in code appears in the Route Debugger inventory | Derived from the registry |

**Requirement on VB-8.** A call to a method that was never written throws on first use and is
indistinguishable from an unimplemented method until the code runs.
**FAILURE MODE, realised:** four views called generic HTTP verbs the client surface has never
had, taking down the appeals queue — the screen where a suspended student's appeal is read.

**Requirement on VB-9.** Both orderings read identically in source. Only a test distinguishes
them.
