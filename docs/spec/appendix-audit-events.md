# Appendix D — Audit Event Registry

**Status:** Normative registry
**Binds:** Volume II §2.9, Volume III §3.9, Volume IV §4.4
**Currency obligation:** This appendix MUST be updated in the same commit as any change to
the set of recorded actions (Volume I §1.9.2 R-9).

---

## D.1 How to read this appendix

Two trails exist and they are not interchangeable.

| Trail | Scope | Retention | Answers |
|---|---|---|---|
| **Operational** (`admin_audit_logs`) | Every administrative action, platform-wide | **365 days**, swept | "What has been happening on this platform?" |
| **Subject-scoped** (`moderation_actions`, `appeal_events`) | One report, one appeal | **Permanent** — exempt from every sweep | "What happened in this case?" |

**Requirement.** An act that is both administratively notable and case-relevant MUST be
written to **both** (Volume II §2.9.2).

**RATIONALE.** The operational trail is swept at one year. A suspension is permanent and
appealable years later, and "who read this student's private messages" is exactly the
question a parent or a district asks long after the sweep window — at which point the
operational row is gone. Writing to one and not the other produces a record that disagrees
with itself.

---

## D.2 Naming rules

| Rule | Detail |
|---|---|
| Operational form | `SCREAMING_SNAKE_CASE`, verb-final: `ACCOUNT_SUSPENDED`, not `SUSPEND_ACCOUNT`. |
| Subject-scoped form | `lower_snake_case`, past tense: `status_changed`, `evidence_viewed`. |
| Names the act | Not the endpoint. `REPORT_EVIDENCE_VIEWED`, not `GET_EVIDENCE`. |
| Stability | **An identifier is permanent.** Renaming makes every past record unqueryable. To change: add the new identifier, retain the old in §D.8, and query both. |
| No parameterisation | An identifier MUST be a literal, never assembled from a variable. An assembled identifier cannot be enumerated, indexed, or filtered against a closed set. |

**Requirement.** The two forms differ deliberately, so that a reader of either trail knows
which one they are looking at without checking the table name.

---

## D.3 Required fields

| Field | Requirement |
|---|---|
| Actor | **Always present** for an administrative act (INV-011). An anonymous entry says somebody changed this without saying who, which is the single question the trail exists to answer. |
| Action | From this registry. |
| Subject | The person the act concerns. For a case, the **reported party** rather than the reporter, because "whose case was this" is the question answered later. |
| Timestamp | Zone-marked. |
| Structural detail | What changed, readable without the application. |

### D.3.1 Subject derivation for report-related actions

**Requirement.** A report about a **person** names them in the target identifier; every other
report names the author of the reported content. A check reading only the authorship column
misses every report filed directly against a person — the shape a report about an adult
almost always takes.

**Requirement.** The audit subject derivation MAY fall back to the reporter so that a record
always has a subject reference. The **user-interface** subject derivation MUST NOT (Volume
III §3.3.10): reusing the fallback there would offer a moderator a control pointed at the
child who filed the report.

---

## D.4 What MUST NOT be recorded

| Excluded | Reason |
|---|---|
| Message bodies | The operational trail has a broader audience than the conversation. Where a content record is needed, the evidence system holds it under its own capability. |
| Moderator case notes | Frequently quote a student's report. They already live in two places retained longer than this trail. |
| Appellant statements | Same. They are held write-once on the appeal record. |
| Passwords, tokens, grant values, secrets | Never, in any form. |
| Unredacted free text | Subject to Volume II §2.9.7. |

**Requirement.** Where a record of content is needed for integrity rather than reading, a
**hash** MUST be stored rather than the content.

---

## D.5 Operational trail registry

`ACTOR` column: who performs it. `SUBJECT`: whose record it concerns. `DUAL`: also written
to a subject-scoped trail.

### D.5.1 Account lifecycle

| Action | Trigger | Actor | Subject | Detail | Dual |
|---|---|---|---|---|---|
| `ACCOUNT_DELETED` | Self-service deletion completes | The account holder | Self | Anonymisation performed; retention class | No |
| `USERNAME_DEDUPED` | A username collision is resolved during migration or signup | System or actor | The account | Prior and new value | No |
| `ACCEPT_ORGANIZER_AGREEMENT` | An organizer accepts the agreement | The organizer | Self | Document version and hash | No |

### D.5.2 Organizer lifecycle

| Action | Trigger | Actor | Subject | Detail | Dual |
|---|---|---|---|---|---|
| `APPROVE_ORGANIZER` | A pending organizer is approved | Moderation authority | The organizer | — | No |
| `DENY_ORGANIZER` | A pending organizer is denied pre-approval | Moderation authority | The organizer | That the account was removed | No |

**Requirement.** Denial pre-approval and demotion post-approval MUST have **distinct**
identifiers. Denial may remove an account that has produced nothing; demotion MUST NOT
(Volume III §3.10.1). Sharing an identifier makes the two indistinguishable in the record.

**Unbuilt, specified:** `REVOKE_ORGANIZER` for demotion (Volume VI P-07).

### D.5.3 Enforcement

| Action | Trigger | Actor | Subject | Detail | Dual |
|---|---|---|---|---|---|
| `ACCOUNT_SUSPENDED` | A suspension is imposed | Enforcement authority | The suspended account | **Duration** — until a date, or indefinitely — and the reason | No |
| `ACCOUNT_UNSUSPENDED` | A suspension is lifted by hand | Enforcement authority | The account | Optional note; the appeal that required it where one did | No |
| `ACCOUNT_WARNED` | A formal warning is issued | Warning authority | The warned account | The reason | No |

**Requirement on `ACCOUNT_SUSPENDED`.** The duration MUST be in the detail. "Suspended for
this reason" and the same words for one week are different administrative acts, and the trail
must distinguish them years later.

**Unbuilt, specified:** an identifier for automatic expiry, distinct from
`ACCOUNT_UNSUSPENDED`, so a suspension that ran its course is distinguishable from one a
person lifted (Volume VI P-06).

### D.5.4 Moderation

| Action | Trigger | Actor | Subject | Detail | Dual |
|---|---|---|---|---|---|
| `MODERATE_REPORT` | A report's status, priority, assignment or outcome changes | Moderation authority | Reported party (D.3.1) | Which fields changed; the transition; the outcome where closing | **Yes** |
| `MODERATE_REPORT_SELF_REVIEW` | The same, where the actor is a party to the report | Moderation authority | Reported party | As above, plus that the actor is named in the report | **Yes** |
| `REPORT_EVIDENCE_VIEWED` | Preserved message bodies are disclosed | Evidence authority | **Reported party**, not the reporter | Count of messages disclosed; the report | **Yes** |

**Requirement on the self-review identifier.** It MUST be **distinct**, not a flag on the
ordinary identifier, so self-reviews are queryable as a class rather than discoverable by
inspection (Volume II §2.10.5).

**Requirement on `REPORT_EVIDENCE_VIEWED`.** Written **before** the bodies leave the process
(INV-014), to both trails, in one transaction. The subject is the reported party because the
question this record answers later is whose private messages were read.

**Requirement.** The resolution note MUST NOT appear in the operational detail (§D.4).

### D.5.5 Appeals

| Action | Trigger | Actor | Subject | Detail | Dual |
|---|---|---|---|---|---|
| `APPEAL_TOKEN_ISSUED` | An appeal token is minted or re-issued | Enforcement authority or system | The appellant | Expiry | **Yes** |
| `APPEAL_VIEWED` | An appeal is opened by a reviewer | Appeal authority | The appellant | — | **Yes** |
| `APPEAL_REVIEWED` | An appeal is claimed | Appeal authority | The appellant | — | **Yes** |
| `APPEAL_DECISION_STANDS` | The original decision is upheld | Appeal authority | The appellant | Reviewer; reasoning present | **Yes** |
| `APPEAL_DECISION_REVERSED` | The original decision is reversed | Appeal authority | The appellant | Reviewer; reasoning present; that reinstatement is a separate act | **Yes** |
| `APPEAL_REOPENED` | A decided appeal is reopened | Appeal authority | The appellant | Reason | **Yes** |

**Requirement.** `APPEAL_DECISION_REVERSED` MUST NOT imply reinstatement. Reinstatement is a
separate act behind a different capability, which the deciding reviewer may not hold, and the
two MUST be linked in both directions by lookup (Volume III §3.7.5).

**Requirement.** The appellant's statement and the reviewer's reasoning MUST NOT be copied
into the operational detail. The detail records that reasoning **exists**, not what it says.

### D.5.6 Authorization

| Action | Trigger | Actor | Subject | Detail | Dual |
|---|---|---|---|---|---|
| `USER_BLOCKED` | One user blocks another | The blocker | The blocked party | — | No |
| `USER_UNBLOCKED` | A block is removed | The blocker | The unblocked party | — | No |

**Requirement.** A block MUST NOT be disclosed to the blocked party (Volume III §3.1.9). This
record is for moderation review, not for the subject.

**Unbuilt, specified:** `CAPABILITY_GRANTED`, `CAPABILITY_REVOKED`, `CAPABILITY_WITHHELD`,
`CAPABILITY_RESTORED`, `ADMIN_PROMOTED`, `ADMIN_REVOKED`, `ADMIN_INVITED`,
`ADMIN_INVITATION_ACCEPTED`, `ADMIN_INVITATION_REVOKED` (Volume VI P-03, P-05, P-07).

### D.5.7 Messaging

| Action | Trigger | Actor | Subject | Detail | Dual |
|---|---|---|---|---|---|
| `ADMIN_CONVERSATION_OPENED` | An administrator opens a moderation conversation | Moderation authority | The counterparty | Whether the counterparty is a student or an organizer; the conversation reference | No |

**Requirement.** Recorded when the **channel is opened**, not only when a message is sent.
"An administrator opened a line to this student" is the fact worth having on the record — it
is the act a person who has done nothing wrong might reasonably ask about later.

**Requirement.** Message bodies MUST NOT be copied here (§D.4).

**Requirement.** The detail MUST read as prose, not as an enumeration value. This record is
read by a person asking why an administrator contacted a student.

### D.5.8 Privacy and data rights

| Action | Trigger | Actor | Subject | Detail | Dual |
|---|---|---|---|---|---|
| `DATA_EXPORT_REQUESTED` | An export is requested | The account holder | Self | — | No |
| `DATA_EXPORT_DOWNLOADED` | An export archive is downloaded | The account holder | Self | Job reference | No |

**Requirement.** Both are recorded. The **download** is the disclosure; the request is only
its announcement. Gating or recording the request alone leaves the disclosure unrecorded
(Volume II §2.7.7).

### D.5.9 Diagnostics

| Action | Trigger | Actor | Subject | Detail | Dual |
|---|---|---|---|---|---|
| `ERROR_GROUP_STATUS_CHANGED` | A diagnostic group is resolved, ignored or reopened | Diagnostic authority | — (no person) | Group fingerprint; prior and new state | No |

**Requirement.** This action has **no human subject**. The subject field MUST be null rather
than defaulted to the actor, so a query for "actions concerning this person" does not return
diagnostic triage.

### D.5.10 Test-only identifiers

The following appear in the codebase and are **fixtures**. They MUST NOT be written by
production paths, and a static guard SHOULD assert they appear only in test files.

`BULK`, `RETENTION_FIXTURE`, `RETENTION_SCHEDULER_FIXTURE`, `SOMETHING_HAPPENED`, `X`

**RATIONALE for listing them.** An unrecognised identifier in a production trail is
indistinguishable from a fixture leak. Listing the fixtures makes the distinction checkable.

---

## D.6 Subject-scoped trail registry

### D.6.1 `moderation_actions` — report history

Permanent. Append-only at the storage layer.

| Action | Trigger | Fields populated |
|---|---|---|
| `filed` | A report is created | Actor is the reporter |
| `status_changed` | Status transitions | Prior and new status |
| `prioritised` | Priority changes | Prior and new priority |
| `assigned` | A report is assigned | Assignee |
| `unassigned` | Assignment is cleared | — |
| `resolved` | A report is closed | New outcome |
| `reopened` | A closed report is reopened | — |
| `evidence_viewed` | Preserved bodies are disclosed | Actor |
| `self_review` | The deciding actor is a party | Actor |

**Requirement.** **One entry per field changed**, not one per request (Volume III §3.9.3).
Assigning, reprioritising and closing are three decisions and read as three lines a year
later.

**Requirement.** Where one request writes several entries sharing a timestamp, ordering MUST
be stabilised by a secondary key. Without it, a history's order is whatever the query planner
chose — which for a history is not a detail.

**Requirement.** `reopened` MUST clear the decision it reverses on the report row, while the
superseded decision remains here. A reopened report that reads as open *and* decided by a
named person at a named time shows the next moderator a decision that has been withdrawn.

### D.6.2 `appeal_events` — appeal history

Permanent. Append-only at the storage layer.

| Event class | Trigger |
|---|---|
| Filed | The appellant submits |
| Viewed | A reviewer opens |
| Claimed | A reviewer takes it |
| Decided | Outcome recorded with reasoning |
| Reopened | A decided appeal is reopened |
| Reinstatement linked | A reinstatement performed for this appeal |

**Requirement.** The reinstatement link MUST be recorded here **by lookup**, not by
parameter, so it is recorded however the reinstatement was reached — including by an
administrator who never opened the appeal (Volume III §3.7.5).

**FAILURE MODE without it.** The audit log records a reinstatement with no reason anybody can
trace back to the appeal that required it, and the appeal's history stops at the decision —
so "was this person actually let back in" has no answer on the record.

---

## D.7 Storage-layer integrity

| # | Requirement |
|---|---|
| SI-1 | Both subject-scoped tables MUST reject `UPDATE` and `DELETE` by any path. |
| SI-2 | The appellant's statement and the reviewer's identity MUST be **write-once**, enforced at the storage layer. |
| SI-3 | A reversal MUST be a new entry, never an edit. |
| SI-4 | A column subject to referential nullification MUST be **excluded** from an immutability enumeration. |

**RATIONALE for SI-1.** A test asserts that the code path somebody wrote behaves; a storage
constraint asserts it for every path anybody ever writes, including an operational script and
a database console.

**RATIONALE for SI-4.** A referential nullification performs a real update and does fire
update constraints. Naming that column would abort the retention sweep instead of the
tampering.

**Requirement.** A table rebuild MUST restore these constraints. A rebuild that drops them
silently removes the invariant while every test still passes.

---

## D.8 Retired identifiers

None. This section exists so the first retirement is recorded rather than deleted.

**Requirement.** A retired identifier MUST remain listed with the release that retired it and
its replacement, because historical records reference it. Renaming rather than retiring makes
past records unqueryable (§D.2).

---

## D.9 Read logging policy

**Requirement.** A read is logged where, and **only** where, it discloses content the reader
would not otherwise see.

| Read | Logged | Reason |
|---|---|---|
| Preserved evidence | **Yes**, both trails, before disclosure | The one situation in which an administrator reads private messages. |
| Data export download | **Yes** | Bulk disclosure of one person's record. |
| Report metadata | **No** | The queue listing already returns those fields to the same capability. Logging one and not the other produces a trail that reads as complete and is not. |
| Audit explorer | **No** | The capability holder may already read every entry; logging each view would flood the trail and destroy its usability. |
| Ordinary page views | **No** | Volume by itself destroys a trail. |

**Requirement.** A read MUST NOT be logged unless it happened. **Prefetching audited data is
prohibited**: it manufactures records of disclosures nobody performed, which makes the trail
unusable in the direction it exists to serve — worse than having no trail (Volume III
§3.4.6).

---

## D.10 Retention

| Trail | Period | Basis |
|---|---|---|
| Operational | **365 days** | The published band is 90 days to one year. 90 days is shorter than the time it typically takes to discover administrative misuse, so the longer end is taken. |
| Subject-scoped | **Permanent** | Exempt from every sweep. A suspension is appealable years later. |

**Requirement.** The operational period MUST match the published privacy policy exactly. It
MUST NOT be silently extended to preserve something, because that makes a published statement
false with no stated end.

**Requirement.** The Audit Explorer MUST display the retention horizon and state that
entries older than it have been swept (Volume IV §4.4.3 AE-12). Without it, an absence of old
entries is indistinguishable from an absence of old activity, and a reader investigating a
two-year-old question would conclude nothing happened.

---

## D.11 Verification obligations

| # | Obligation | Enforced by |
|---|---|---|
| VD-1 | Every administrative action writes an operational record with an actor | Test per action |
| VD-2 | Every dual-trail action writes both, in one transaction | Test per action |
| VD-3 | No trail contains bodies, notes, statements or credentials | Test scanning written records under exercise |
| VD-4 | Audit records are written in the same transaction as their act | Test by induced failure |
| VD-5 | Evidence reads are logged before disclosure | Test |
| VD-6 | Metadata reads are not logged as disclosures | Test |
| VD-7 | Subject-scoped tables reject update and delete | Test at the storage layer |
| VD-8 | Write-once columns reject a second write | Test at the storage layer |
| VD-9 | The retention sweep runs without tripping an immutability constraint | Test |
| VD-10 | Same-timestamp entries have stable ordering | Test |
| VD-11 | Every identifier in this registry is a literal | Static guard |
| VD-12 | Fixture identifiers appear only in test files | Static guard |
| VD-13 | Every action in code appears in this appendix | Static guard comparing code to this file |

**Requirement on VD-4.** Transactionality MUST be verified by **inducing a failure**, not by
reading the code. A record written outside its transaction is invisible in review and
produces, on failure, either an act with no record or a record of an act that never happened
— the second being worse, because it is evidence of a thing that did not occur.

**Requirement on VD-13.** The guard MUST derive the set of identifiers from source (P-3) and
MUST fail when an identifier exists in code and not here, and when one exists here and not in
code. Both directions matter: the first is an unregistered action, the second a stale
appendix.
