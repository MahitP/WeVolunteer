# Volume III — Messaging, Moderation, Evidence and Lifecycles

**Status:** Normative
**Scope:** Conversation architecture, messaging, safety reporting, moderation, the
evidence system, appeals, notifications, organizer and student lifecycles, suspensions,
warnings, the audit timeline.

**Binds:** Volume II (authorization, audit), Appendix B (contracts), Appendix C
(schema), Appendix D (audit events).

---

## 3.1 Conversation architecture

### 3.1.1 Purpose

Permit the communication the platform exists to enable — an organizer coordinating with
a volunteer, an administrator contacting a person about a report — while making private
contact between an adult and a minor observable, reportable and evidenced.

### 3.1.2 Goals

| ID | Goal | Measured by |
|---|---|---|
| G-3.1 | No conversation exists that a safety process cannot reach. | Every conversation has a reportable surface and an evidence path. |
| G-3.3 | A student can always reach staff. | An administrator channel exists and cannot be closed by an event lifecycle rule. |
| G-3.4 | Membership is one fact, in one place. | Authorization reads the participant table, never the role columns. |
| G-3.5 | A thread's category is stored, never inferred. | INV-3.1 below. |

### 3.1.3 Current state

Conversations carry a `kind` discriminator with three values: an event-scoped
student↔organizer thread, an administrator↔student thread, and an
administrator↔organizer thread. Membership is held in a participant table which the
authorization check reads. Event-scoped threads require an event, a student and an
organizer; administrator threads require exactly one counterparty and no event. A
partial unique index over an expression prevents duplicate administrator threads.

### 3.1.4 Design decisions

**D-3.1.1 — A discriminator column, not inference.**

**INVARIANT (INV-3.1).** A conversation's category MUST be stored. It MUST NOT be
inferred from the presence or absence of a joined record.

**RATIONALE.** Inferring "administrator thread" from a null event is the trap: an
event-scoped thread whose event has been deleted also has a null event, and it MUST NOT
be treated as an administrator thread. Its lifecycle rules still apply and its
participants are still a student and an organizer. The stored category is the fact; the
shape of the joined data is a consequence.

**D-3.1.2 — Membership in the participant table.**

**Requirement.** Authorization MUST read the participant table. The role columns on the
conversation record are descriptive, not authoritative.

**RATIONALE.** The role columns were never what authorised a read. Making the participant
table authoritative is what allows a new conversation category to be added without
touching the authorization path — and it is what allows an administrator to be a
participant without occupying a role column that would misdescribe them.

**D-3.1.3 — An administrator is never placed in the organizer column.**

**Requirement.** An administrator thread MUST leave both the event and the
non-counterparty role column empty.

**RATIONALE.** Placing an administrator in the organizer column would work mechanically
and would state, in the data, that an administrator is the event's organizer. It would
also inherit the event-driven read-only rules, which is the more serious consequence
(§3.1.7).

**D-3.1.4 — Conditional constraints, not relaxed constraints.**

**Requirement.** Relaxing the requirement for an event, a student and an organizer — so
that an administrator thread can exist — MUST be accompanied by conditional constraints
that continue to require all three for an event-scoped thread.

**FAILURE MODE.** Without them, an event-scoped thread with no event becomes
representable. Every event query and every lifecycle rule would read it as a thread
about nothing.

**D-3.1.5 — Uniqueness must be enforceable despite nulls.**

**Requirement.** Duplicate administrator threads MUST be prevented by a constraint, not
only by a lookup.

**RATIONALE.** A composite unique constraint over the three role columns cannot do this
job: null values are distinct under that constraint, so every administrator thread is
unique to it however many times it is created. The constraint MUST therefore be a
partial unique index over an expression that collapses the counterparty columns into
one non-null value, restricted to administrator categories.

**Requirement.** The index MUST be keyed on the **creating administrator** as well as
the counterparty, so two administrators may each hold their own thread with the same
person. A moderation contact belongs to the person who opened it; it is not a shared
mailbox.

**FAILURE MODE without the index.** Pressing a "message" control twice silently produces
a second thread and splits the conversation in half. Neither half contains the whole
exchange, and a moderator reading one concludes the other does not exist.

### 3.1.5 INV-3.2 — Every conversation has an adult or staff party

**INVARIANT.** No conversation category may exist whose participants are two students.

**Requirements.**

- Direct student-to-student messaging MUST NOT be implemented (Volume 0 §0.10).
- A category proposal whose participants are both students MUST be refused at design
  time, not mitigated at implementation time.

**RATIONALE.** The safety model rests on every private exchange having a party who is
accountable to the platform and reachable by it. Peer-to-peer messaging between minors
removes that party and converts the platform into an unmonitored messaging service for
children, with a reporting mechanism as its only control. That is a different product
with a different regulatory posture, and it is not this one.

### 3.1.6 Eligibility to open a thread

| Category | Who may open | Precondition |
|---|---|---|
| Event-scoped | The student or the organizer | A relationship derived from the student's application to that event. |
| Administrator↔student | A principal holding the moderation capability | None beyond the counterparty existing and not being deleted. |
| Administrator↔organizer | Same | Same. |

**Requirement.** Opening an administrator thread is gated on the **moderation**
capability, not the messaging capability (Volume II §2.4.1). Participating in a
conversation is one thing; selecting an arbitrary person by identifier to start one with
is a moderation power, and an organizer holds the messaging capability.

**Requirement.** The counterparty's category MUST be derived from **capabilities**, not
from a role identifier, and the derivation MUST be ordered most-privileged-first
(INV-007). Testing the narrower capability first classifies the platform owner as a
student.

**Requirement.** A counterparty for whom no category applies MUST be refused explicitly.
A capability-poor role MUST NOT fall into whichever category is last.

### 3.1.7 Lifecycle rules

Event-scoped threads become read-only under conditions derived from the event and from
the student's application.

| Condition | Effect |
|---|---|
| Event completed, or its last slot ended | Read-only after a defined window. |
| Application withdrawn or rejected | Read-only after a shorter window. |
| Whichever occurs first | Governs. |

**Requirement.** History MUST remain readable when a thread is read-only. Read-only means
no new messages, not no access.

**Requirement.** The banner MUST state which rule applied.

**INVARIANT (INV-3.3).** An administrator thread MUST NOT become read-only. The
lifecycle computation MUST return early for administrator categories.

**RATIONALE, and why "it happens to work" is insufficient.** With no event, the
event-shaped queries find nothing and the computation falls through to writable. That is
an accident of how absence flows through event-shaped queries, not a decision, and it
stops being true the moment a rule is keyed on the *absence of applications* — an
administrator thread has none, which reads exactly like a student who withdrew, and the
withdrawal branch turns a thread read-only after a short window.

**The rule's purpose.** Event-driven read-only exists so a thread about a finished shift
stops accepting messages. A student's channel to an administrator is not about a shift.
Closing it because an unrelated event ended shuts the one route a person has for raising
something — including an appeal.

### 3.1.8 Message requirements

| # | Requirement |
|---|---|
| M-1 | A maximum length MUST be enforced server-side and communicated client-side before submission. |
| M-2 | An empty or whitespace-only message MUST be refused. |
| M-3 | Sending MUST be rate-limited per sender. |
| M-4 | Content MUST be stored as submitted. No transformation, no truncation. |
| M-5 | Content MUST be rendered as text. No markup interpretation. |
| M-6 | Editing MUST NOT be implemented for event-scoped or administrator threads. |
| M-7 | Deleting a message MUST NOT be implemented. |
| M-8 | Pagination MUST be cursor-based over a stable ordering. |
| M-9 | An invalid cursor MUST be refused, not silently reset to the first page. |

**RATIONALE for M-6 and M-7.** Editing and deletion are the two mechanisms by which an
adult removes the record of what they said to a minor. Their absence is a safety
property, not an unbuilt feature. Where a person needs content removed, the path is a
report, and removal is a moderation decision that leaves a record.

**RATIONALE for M-4 and M-5.** Storing as submitted means the evidence snapshot is the
words that were sent. Rendering as text means a message cannot execute or restructure
the page it appears in.

### 3.1.9 Blocking

**Requirements.**

- A block MUST close an **existing** conversation, not only prevent a new one.
  **FAILURE MODE:** eligibility is evaluated when a thread is opened; an already-open
  thread never passes through it again. Without a check on the send path, blocking
  silently does nothing for the only case that matters — the conversation the student is
  currently in, with the person they want to stop hearing from.
- The block check MUST precede the lifecycle check, so a blocked sender is refused
  whether or not the thread is writable.
- The refusal MUST be the **generic** read-only refusal. The block MUST NOT be announced
  to the blocked party.
- A principal holding the moderation capability MUST NOT be blockable in a moderation
  thread.
  **RATIONALE:** a student must not be able to close the channel through which the
  platform contacts them about a safety matter. This is a deliberate asymmetry and MUST
  be documented in the community guidelines.

### 3.1.10 Notification context

**Requirement.** A message notification MUST name what the thread is about, and the
description MUST be correct for the category.

**FAILURE MODE.** A fallback description written for an event-scoped thread whose event
was deleted reads as "volunteer conversation". An administrator thread has no event by
design, so without a category-aware description every message from an administrator
arrives labelled as being about a volunteer opportunity — which is exactly what it is
not, in the one case where the recipient most needs to know who is contacting them and
why.

### 3.1.11 Accessibility

| # | Requirement |
|---|---|
| A-3.1 | The message list is a labelled region; new messages are announced politely, not assertively. |
| A-3.2 | Each message's author and time are programmatically associated with its content. |
| A-3.3 | Read-only state is conveyed in text and by the composer's disabled state with an accessible explanation. |
| A-3.4 | Pagination is operable by keyboard and announces that older messages loaded. |
| A-3.5 | The unread indicator has a text equivalent. |

### 3.1.12 Performance

| Operation | Budget |
|---|---|
| Conversation list | ≤ 150 ms for 50 threads |
| Message page | ≤ 100 ms for 50 messages |
| Send | ≤ 200 ms including notification enqueue |
| Unread count | ≤ 20 ms per thread |

**Requirement.** The conversation list MUST NOT issue a query per thread for its derived
fields. Unread counts and last messages MUST be resolved in a bounded number of queries
regardless of thread count.

### 3.1.13 Acceptance criteria for §3.1

| # | Criterion |
|---|---|
| AC-3.1.1 | Category is stored; no code infers it from a null event. |
| AC-3.1.2 | Authorization reads the participant table only. |
| AC-3.1.3 | An event-scoped thread with no event is rejected by constraint, asserted at the storage layer. |
| AC-3.1.4 | An administrator thread naming both role columns is rejected by constraint. |
| AC-3.1.5 | A duplicate administrator thread is rejected by constraint, not only by lookup. |
| AC-3.1.6 | Two administrators may each hold a thread with the same person. |
| AC-3.1.7 | Opening an administrator thread requires the moderation capability; the messaging capability is insufficient. |
| AC-3.1.8 | Category derivation is capability-based, ordered most-privileged-first, with an explicit final deny. |
| AC-3.1.9 | An administrator thread is writable at an arbitrarily distant future time. |
| AC-3.1.10 | Blocking closes an existing thread; the refusal is generic. |
| AC-3.1.11 | A moderation thread cannot be blocked by its counterparty. |
| AC-3.1.12 | Notification context is category-aware. |
| AC-3.1.13 | No edit or delete path exists for a message. |

---

## 3.2 Safety reporting

### 3.2.1 Purpose

Give any user a low-friction path to raise a concern about content, a person, or a
conversation, and ensure what they raise reaches a human with the evidence attached.

### 3.2.2 Current state

A unified report model covers seven target types. A category taxonomy of eighteen
categories, grouped for presentation. Priority is derived server-side and never accepted
from the client. Filing from a conversation captures evidence. Duplicate reports are
folded.

### 3.2.3 Target types and the reporting surfaces

| Target | Surface | Evidence captured |
|---|---|---|
| Event | Event view | Title and organizer snapshot |
| Comment | Comment | Body, author, author name snapshot |
| Announcement | Announcement | Body snapshot |
| Conversation | Conversation | **Message bodies** |
| Message | Message | **Message bodies** |
| User | Profile, conversation, roster | Identity snapshot |
| Certificate | Verification page | Code and issuance snapshot |

**Requirement.** Every surface on which content appears MUST carry a report affordance
for that content.
**RATIONALE:** a reporting mechanism reachable only from one screen is a mechanism most
users will not find at the moment they need it.

### 3.2.4 Category taxonomy

**Requirements.**

- Categories MUST be defined once, on the server, and re-exported to the client (P-8).
- Stored values MUST be stable machine identifiers. They MUST NOT be displayed.
- Labels MUST be written in the **first person**, from the reporter's perspective, and
  the moderation surface MUST show the **same words**, so both sides of a report are
  discussing the same thing.
- Categories MUST be grouped for presentation. A flat list of eighteen is not read by
  anyone, least of all somebody distressed enough to be filing.
- A per-target filter MAY narrow the offered set for scannability.

**Requirement.** The per-target filter is **presentation only**. The server MUST accept
a category the client would not have offered for that target.
**RATIONALE:** a mismatched category is a mis-tap. Refusing a distressed student over a
category/target combination is worse in every way than filing a slightly
mis-categorised report.

**Requirement.** A retired category MUST still render. An old report keeps whatever it
was filed as, and a blank cell on a moderation surface reads as "nothing wrong here".

**FAILURE MODE, realised twice.** Two client surfaces offered category sets that did not
match the server's. In one, the single option a student is most likely to reach for was
refused with a validation error on every attempt, and the only error handling was a
console line. In the other, free prose was sent where a category was expected, so every
report of an event or a comment landed in the catch-all and the eighteen-category
taxonomy was unreachable from the product entirely. Both are why the taxonomy is
re-exported rather than restated.

### 3.2.5 Derived priority

**Requirement.** Priority MUST be derived server-side from two inputs, and MUST NOT be
accepted from the client.

| Input | Effect |
|---|---|
| Category | Some categories floor at urgent. |
| Actor asymmetry | A student reporting an adult floors at urgent, whatever the category. |

**RATIONALE for the asymmetry floor.** It costs one lookup and it is the difference
between a student who reported an adult being seen today and being seen whenever the
queue is next worked.

**Requirement.** Derived priority MUST be **displayed**. It was computed on every report
and shown on none, which made the whole derivation invisible to the person it exists to
help.

### 3.2.6 Description field

| # | Requirement |
|---|---|
| R-1 | Optional. A category alone MUST be a complete report. |
| R-2 | Maximum length MUST be generous. A student describing a grooming conversation needs room, and running out of characters mid-sentence is a bad thing to happen to somebody who has worked up to typing it. |
| R-3 | Stored as submitted. |
| R-4 | Immutable once filed (§3.3.7). |
| R-5 | Where absent, the moderation surface MUST say the reporter chose a category and added nothing, rather than rendering an empty region. |

### 3.2.7 Duplicate folding

**Requirements.**

- A repeat report of the same target by the same reporter within a window MUST be folded
  rather than creating a second record.
- Folding MUST be recorded so the fold is visible.
- The resolution taxonomy MUST include a value expressing the fold, because the system
  itself produces that outcome and the moderation surface must be able to express what
  the system did.
- Folding MUST NOT lose a **new description**. Where a repeat carries additional
  information, the information MUST be retained.
- Reports from **different** reporters MUST NOT be folded. Two people reporting the same
  thing is corroboration, and collapsing it destroys the signal.

### 3.2.8 Rate limiting

**Requirements.**

- Filing MUST be rate-limited per reporter.
- The limit MUST be generous enough that a person reporting several messages in one
  distressing exchange is not refused.
- A limited response MUST NOT suggest the report was filed.

### 3.2.9 Self-reporting

**Requirement.** A user MUST NOT report their own content. The refusal MUST be
explanatory, because the attempt is usually a misunderstanding of what the control does.

### 3.2.10 Accessibility

| # | Requirement |
|---|---|
| A-3.6 | The report control has an accessible name naming the target. |
| A-3.7 | The dialog traps focus, is dismissible by keyboard, and restores focus. |
| A-3.8 | Grouped categories use real grouping semantics. |
| A-3.9 | The character counter is announced at thresholds, not on every keystroke. |
| A-3.10 | Submission confirmation is announced and states what happens next and when. |

### 3.2.11 Acceptance criteria for §3.2

| # | Criterion |
|---|---|
| AC-3.2.1 | Every content surface carries a report affordance. |
| AC-3.2.2 | The taxonomy is re-exported from the server; a client copy fails the build. |
| AC-3.2.3 | The server accepts any valid category for any target. |
| AC-3.2.4 | A retired category renders legibly. |
| AC-3.2.5 | Priority is derived, is not accepted from the client, and is displayed. |
| AC-3.2.6 | A student reporting an adult produces urgent priority regardless of category. |
| AC-3.2.7 | A category-only report is accepted and renders explanatorily. |
| AC-3.2.8 | Folding is recorded, retains new information, and never folds across reporters. |
| AC-3.2.9 | Self-reporting is refused explanatorily. |
| AC-3.2.10 | All seven target types are filed end to end by test. |

---

## 3.3 Moderation

### 3.3.1 Purpose

Give a moderator what they need to decide a report, the actions to act on it, and a
record that survives them.

### 3.3.2 Goals

| ID | Goal |
|---|---|
| G-3.6 | Nothing is decidable without the evidence being reachable. |
| G-3.7 | No decision is unattributable. |
| G-3.8 | No report can become permanently undecidable. |
| G-3.9 | A moderator can act on the person, not only on the record. |
| G-3.10 | Every outcome the taxonomy can express corresponds to something the platform can do. |

### 3.3.3 Report state machine

States: `open`, `reviewing`, `escalated`, `resolved`, `dismissed`.

| From | To |
|---|---|
| `open` | `reviewing`, `escalated`, `resolved`, `dismissed` |
| `reviewing` | `open`, `escalated`, `resolved`, `dismissed` |
| `escalated` | `open`, `reviewing`, `resolved`, `dismissed` |
| `resolved` | `open`, `reviewing` |
| `dismissed` | `open`, `reviewing` |

**Requirements.**

- Transitions MUST be enumerated. An arbitrary value from the enumeration MUST NOT be
  accepted.
- Two transitions a permissive route would allow MUST be refused:
  - **Re-closing an already-closed report.** It would overwrite the first decision's
    outcome, note, actor and timestamp with a second, leaving no sign the first existed.
    The subject-scoped history makes it recoverable, but a decision that quietly replaces
    another is not something the route should permit.
  - **`resolved` → `dismissed` directly.** It changes outcome without the report having
    been open for reconsideration.
- **Reopening MUST be permitted** from either terminal state. A moderator who learns
  something new must be able to act on it.
- Reopening MUST clear the decision it reverses.
  **RATIONALE:** left in place, a reopened report reads as open *and* decided by a named
  person at a named time, and the next moderator sees a decision that has been
  withdrawn. The withdrawn decision is not lost — it is in the subject-scoped history,
  which is where a superseded decision belongs.
- `escalated` MUST count as **live** for every purpose: queue ordering, evidence holds,
  retention holds. A report that has left the queue for a phone call is the last one
  whose evidence should look finished.

### 3.3.4 Closing requirements

| # | Requirement |
|---|---|
| C-1 | An outcome MUST be chosen from the enumeration. |
| C-2 | A note MUST be provided, meeting a minimum length. |
| C-3 | The note's type MUST be checked before its length. |
| C-4 | The note MUST be retained permanently. |
| C-5 | The interface MUST state that the note is what an appeal is reviewed against. |

**RATIONALE for C-2 and C-5.** The note is the only artefact an appeal is reviewed
against. The community guidelines promise an appellant the outcome and the reason, and a
suspension is contestable years later, at which point a one-word note is not something
anybody can review a decision against.

**FAILURE MODE for C-3, realised.** A check reading `!note || note.length < N` passes for
a number, because a number has no length property and the comparison against undefined is
false. A numeric value closed a report with a note of "1.0" — on the one field an appeal
is reviewed against, reachable by any client sending structured data rather than a form.

### 3.3.5 The outcome taxonomy

**Requirement.** Every outcome the taxonomy can express MUST correspond to an action the
platform can perform, or MUST be explicitly labelled as an off-platform escalation.

**FAILURE MODE, realised.** An outcome expressing that a warning was issued existed in
the taxonomy and in the interface for two releases. Choosing it wrote a word on a closed
report and told nobody. The platform's own record said a warning had been issued while
the only party it concerned had no idea — which is worse than having no warning, because
the label is what justifies the next escalation.

**Requirement.** Recording an outcome and performing the corresponding act are
**separate operations**, deliberately.

**RATIONALE.** A report may be dismissed with no action; and a person may be warned about
something that came to light without a report. Coupling them would make each impossible
without the other. The requirement is not that they be coupled — it is that every
outcome the taxonomy offers has an act that performs it.

### 3.3.6 Assignment and priority

**Requirements.**

- A report MAY be assigned. Assignment MUST be recorded.
- An assignee MUST be validated to exist, be active, and **hold the resolution
  capability** — asked as a capability, never as a role comparison, because the
  capability is grantable precisely so a triage-only helper can exist and a role check
  would refuse to assign work to exactly that person.
- Priority MAY be adjusted, and the adjustment MUST be recorded with both values.
- Self-assignment by a party to the report is the quiet form of deciding it and MUST be
  refused by the conflict rule (Volume II §2.4.4).

### 3.3.7 Immutability

**INVARIANT.** What a report *says* MUST be immutable. What a report is *for* — its
workflow — MUST be mutable.

**Requirements.**

- The category, the description, the target and the reporter identity snapshot MUST be
  immutable at the storage layer.
- Status, priority, assignment, outcome and note MUST be mutable, because a report that
  cannot be closed is a permanent hold on everything keyed to it.
- Deletion MUST be refused at the storage layer, for any path.
- A column subject to referential nullification MUST be excluded from the immutable
  enumeration.
  **RATIONALE:** a nullification performs a real update and does fire update
  constraints. Naming that column would abort the retention sweep instead of the
  tampering.

### 3.3.8 The queue

**Requirements.**

- Every filter MUST be validated against a closed set and refused with the legal values.
  A mistyped filter that silently returns everything, or nothing, shows a moderator a
  queue that is not the one they asked for.
- Default scope MUST be live work.
- Ordering MUST be: live before closed, then urgent before normal, then **oldest
  first**.
  **RATIONALE for oldest-first.** Newest-first starves the oldest unanswered report,
  which is by construction the one most likely to be a real harm nobody answered — and
  the response-time promise is about the oldest item, not the newest.
- Live statuses MUST sort above closed, so working the queue never means scrolling past
  finished work.
- Counts MUST be computed over the **whole** table, not the filtered page, because their
  purpose is to tell a moderator what a filter is hiding from them.
- Actions MUST be available on every live status, not only the initial one.
  **FAILURE MODE:** gated on the initial status alone, a report loses its controls the
  moment a moderator picks it up — so reports in progress could be created and then never
  closed from the product at all, and an escalated report is by definition the one
  somebody is actively dealing with.

### 3.3.9 Target presentation — three honestly distinguished states

| State | Meaning | Presentation |
|---|---|---|
| Live | Content still exists; this is it | The content |
| Snapshot | Original gone; this is the copy taken at filing | The copy, labelled as preserved |
| Missing | Genuinely nothing preserved | An explicit statement |

**Requirements.**

- These MUST be distinguished. A decision can turn on which one a moderator is reading.
- The derivation MUST exist in **one place**, serving every surface.
- The missing state MUST be true only when there is genuinely nothing.
  **FAILURE MODE, realised:** the missing state was true for every conversation report,
  so the queue told moderators no copy was kept about reports holding hundreds of
  preserved messages. A report with preserved evidence is never missing — the evidence
  *is* the record, and saying otherwise talks a moderator out of opening it.
- A target with no body of its own — a conversation, a person, a certificate — MUST be
  identified by a name snapshot. Without it those reports render as an unlabelled row,
  which is the same blank cell a moderator reads as "nothing wrong here".

### 3.3.10 The report detail surface

**Requirements.**

- MUST show: category by its reporter-facing label, reporter, subject, filing time,
  target presentation, description, current status and priority, assignment, outcome and
  note when closed, evidence availability, and the action history.
- MUST be reachable for **closed** reports, not only live ones.
  **RATIONALE:** a resolved report is exactly the one somebody needs to read in full,
  because an appeal is reviewed against the decision recorded on it. Gating the record
  behind "still actionable" hides the evidence for every case an appeal can be about.
- MUST NOT include evidence bodies in the same response as the record (§3.4.5).
- MUST resolve and name the **person the report is about**, derived server-side.

**Requirement on subject derivation.** The rule is easy to get wrong and MUST be
implemented once: a report about a person names them in the target identifier; every
other report names the author of the reported content. A check reading only the
authorship column misses every report filed directly against a person, which is the
shape a report about an adult almost always takes.

**Requirement.** Subject derivation MUST NOT fall back to the reporter.
**RATIONALE:** the audit trail's subject derivation does fall back, so that a record
always has a subject. Reusing that fallback here would offer a moderator a control
pointed at the child who filed the report.

### 3.3.11 Acceptance criteria for §3.3

| # | Criterion |
|---|---|
| AC-3.3.1 | Every illegal transition is refused with its legal set. |
| AC-3.3.2 | Re-closing a closed report is refused. |
| AC-3.3.3 | Reopening clears the prior decision and records the reversal. |
| AC-3.3.4 | Escalated counts as live for queue, evidence hold and retention hold. |
| AC-3.3.5 | Closing requires an outcome and a type-checked note. |
| AC-3.3.6 | Every outcome corresponds to a performable act or is labelled off-platform. |
| AC-3.3.7 | Assignee validation is capability-based. |
| AC-3.3.8 | Report content is immutable at the storage layer; workflow is not. |
| AC-3.3.9 | Deletion is refused at the storage layer. |
| AC-3.3.10 | Every filter is validated and refused with legal values. |
| AC-3.3.11 | Ordering is live-first, urgent-first, oldest-first. |
| AC-3.3.12 | Counts are whole-table. |
| AC-3.3.13 | Actions are available on every live status. |
| AC-3.3.14 | All three target states render distinctly; missing is true only when nothing is preserved. |
| AC-3.3.15 | Detail is reachable for closed reports. |
| AC-3.3.16 | Subject derivation covers direct-subject reports and never falls back to the reporter. |

---

## 3.4 The evidence system

### 3.4.1 Purpose

Ensure that what a report is about survives the report, including against deliberate
destruction by its subject.

### 3.4.2 The problem, stated concretely

The adversary is A-2: an adult with legitimate platform access who has said something to
a minor and wants the record gone. Before the evidence system, three chained cascading
foreign keys meant that deleting an event removed every conversation held under it,
every safety report about those conversations, and the message snapshots written
specifically to survive message deletion.

The organizer needed no privilege beyond owning their own event. The two guards on event
deletion refused only an event with attendance recorded or one already completed — and
**the harm occurs before the event runs, when attendance is zero by definition**. The
window in which the evidence was destructible was exactly the window in which the harm
occurs.

### 3.4.3 Design decisions

**D-3.4.1 — Capture at filing, not on demand.**

**Requirement.** Filing a report against a conversation or a message MUST capture the
message bodies at that moment.

**RATIONALE.** A reference to live content is worth nothing once the content is gone,
and the subject controls the content.

**D-3.4.2 — Sever the cascades, snapshot the identity.**

**Requirement.** A foreign key from a record of an event to the subject of that event
MUST NOT cascade on delete, and the identifying attributes MUST be snapshotted at record
time.

**FAILURE MODE this closes.** A student who reported an adult destroyed their own report
by exercising their deletion right, because the reporter reference cascaded and the
retention sweep hard-deletes anonymised shells. The victim's own privacy right silently
erased the record of what had been done to them. Holding the shell instead would have
been the easier patch and would have made a **published** retention period false with no
stated end.

**D-3.4.3 — Hold deletion while a report is live.**

**Requirement.** Deleting an event, a comment or an announcement MUST be refused while
any report naming it, or its children, is live.

**Requirements.**

- The refusal MUST carry a distinct code and a persistent explanation, not only a
  transient message.
- The hold MUST apply to **administrators**. It is about the evidence, not about who is
  asking.
- The predicate MUST have exactly one definition. A second copy is a second way to lose
  evidence.
- The hold MUST be dischargeable: the moderation surface MUST be able to close the
  report that holds it. A hold that cannot be discharged is a permanent lock.

### 3.4.4 INV-010 — Immutability at the storage layer

**INVARIANT.** Evidence rows MUST reject update and delete at the storage layer, for
every path.

**RATIONALE.** A test asserts that the code path somebody wrote behaves. A storage
constraint asserts it for every path anybody ever writes, including an operational
script and a database console.

**Requirement.** A table rebuild MUST restore these constraints. A rebuild that drops
them silently removes the invariant while every test still passes.

### 3.4.5 The capability split

**Requirement.** Reading evidence MUST be gated on a capability **distinct** from the
capability that permits deciding the report.

**RATIONALE.** The split is what makes the triage-only helper possible: a person who
sorts the queue and never reads a student's private messages — the most invasive power
on this platform.

**Requirement.** The evidence capability MUST NOT be super-only. Grantability is the
entire reason it exists as a separate name.

**Requirement.** Evidence bodies MUST NOT be included in the report detail response.

**RATIONALE.** Folding them in would collapse the split silently: the helper would
receive them on every open, while the separate capability continued to look like it was
doing something. The cost is one extra round trip when a moderator chooses to open the
evidence; the benefit is that choosing to is a distinct, logged act rather than a side
effect of viewing a report.

### 3.4.6 INV-014 — Disclosure is recorded before it occurs

**INVARIANT.** A read of preserved evidence MUST be recorded, to **both** trails, before
the bodies leave the process.

**Requirements.**

- The operational trail's subject MUST be the **reported party**, because the question
  the record answers later is whose private messages were read.
- The subject-scoped history MUST also carry it, because the operational trail is swept
  and a suspension is appealable years later. "Who read this student's private messages"
  is exactly the question a parent or a district asks long after the sweep window.
- Both writes MUST be in one transaction. A read recorded in one place and not the other
  is a record that disagrees with itself.
- The interface MUST warn, **before** the control is pressed, that the read is recorded
  permanently with the reader's name and the time.
- Evidence MUST NOT be fetched on opening a report. Prefetching manufactures records of
  disclosures nobody performed, which makes the trail unusable in the direction it
  exists to serve — worse than having no trail.

**RATIONALE for the whole subsection.** The youth-safety guidelines state in print: this
is the one situation in which an administrator reads private messages, and it is logged.
Until the disclosure was both possible and logged, that sentence described something
that could not happen — and so was not logged either.

### 3.4.7 Presentation

**Requirements.**

- Evidence MUST be presented read-only, and the interface MUST **say** it cannot be
  edited or deleted by anyone, including an administrator.
  **RATIONALE:** "can I be accused of altering this" is a fair question to have answered
  on the screen rather than in a schema file.
- No affordance that could mutate evidence may exist, and no endpoint may exist behind
  one.
- Each preserved message MUST show its author, its **sent** time and its **captured**
  time.
  **RATIONALE:** these are two different facts, and the difference is the one a moderator
  needs. It is what distinguishes a preserved copy from a live read, and it is the answer
  to "could this have been edited between being sent and being reported".
- An author whose account is gone MUST be named from the snapshot.
- The count MUST agree with the number of rows presented, and the count's copy MUST agree
  grammatically with its number.

### 3.4.8 Retention

**Requirements.**

- Evidence MUST be exempt from the message retention sweep while its report is live, and
  MUST remain exempt after closure for the appeal window plus the appeal retention
  period.
- The exemption predicate MUST cover the **whole live thread**, not only the captured
  identifiers.
  **FAILURE MODE, realised:** the exemption named only snapshotted identifiers, and the
  snapshot is capped, so a message beyond the cap in a reported conversation was deleted
  while the report was still open.
- The exemption MUST have one definition.
- The sweep's safety assertions MUST run **inside** its transaction (Volume I §1.4.8).

### 3.4.9 Threat model for §3.4

| # | Threat | Control | Residual |
|---|---|---|---|
| T-3.1 | Subject deletes the content | Capture at filing | None material. |
| T-3.2 | Subject deletes the container | Severed cascades plus deletion holds | None material. |
| T-3.3 | Reporter's deletion right erases their own report | Nullification plus identity snapshot | None material. |
| T-3.4 | Retention sweep removes evidence | Whole-thread exemption; in-transaction assertions | A sweep bug outside the exemption; mitigated by the assertions. |
| T-3.5 | Evidence edited to fabricate | Storage-layer immutability | Host-level access. |
| T-3.6 | Evidence read without record | Log-before-disclose; no prefetch | An administrator reads legitimately and lies about why. Evidential, not preventive. |
| T-3.7 | Triage helper widened to read messages | Distinct capabilities; bodies absent from the detail response | A grant of the evidence capability, which is recorded and reviewable. |

### 3.4.10 Acceptance criteria for §3.4

| # | Criterion |
|---|---|
| AC-3.4.1 | Filing against a conversation or message captures bodies. |
| AC-3.4.2 | No record-of-event key cascades to its subject; a snapshot exists. |
| AC-3.4.3 | Deleting a held container is refused with a distinct code, for administrators too. |
| AC-3.4.4 | The hold predicate has one definition. |
| AC-3.4.5 | Evidence rejects update and delete at the storage layer, asserted directly. |
| AC-3.4.6 | Evidence reading is a distinct, grantable, non-super-only capability. |
| AC-3.4.7 | The report detail response contains no bodies. |
| AC-3.4.8 | A read writes to both trails, in one transaction, before disclosure. |
| AC-3.4.9 | The interface warns before the read and states immutability after it. |
| AC-3.4.10 | No mutation affordance or endpoint exists for evidence. |
| AC-3.4.11 | Both timestamps are shown per message. |
| AC-3.4.12 | Evidence is not fetched on report open, asserted by test. |
| AC-3.4.13 | The retention exemption covers the whole live thread. |

---

## 3.5 Moderation actions

### 3.5.1 Purpose

Give a moderator acts that change something, so the queue is not a filing system with an
outcome dropdown attached.

### 3.5.2 The action set

| Act | Effect | Capability | Reversible |
|---|---|---|---|
| Dismiss | Closes with no action | Resolution | By reopening |
| Warn | Formal notice; no access change | Warning | Not undone; superseded |
| Suspend | Ends access; ends every session | Suspension | Reinstatement |
| Reinstate | Restores access | Suspension | Re-suspension |
| Remove content | Content unavailable; evidence retained | Moderation | Not undone |
| Withhold capability | Removes one capability | Grant administration | Restoration |
| Remove organizer standing | Demotion, records retained | Owner administration | Re-approval |
| Deactivate | Terminal | Owner administration | Not undone |

**Requirement.** Every act MUST record: actor, subject, reason, timestamp, and an entry
in both trails.

**Requirement.** An act MUST NOT be offered in the interface unless the endpoint exists
(Volume I §1.9.3 D-19). A control over an absent endpoint is worse than its absence,
because the absence is visible and the broken control is not.

### 3.5.3 Warnings

**Requirements.**

- A warning MUST deliver a notice the subject receives, whatever their notification
  preferences say.
- The moderator's words MUST be shown to the subject **verbatim**, and the composer MUST
  say so.
- A reason MUST meet a minimum length, because these words are shown to the person and
  are what a later escalation is justified against.
- A warning MUST change **nothing** about the account: no status, no capability, no
  forced sign-out. The notice states that nothing has been removed, and that MUST be
  true.
- A warning MUST NOT carry an appeal token.
  **RATIONALE:** appeal tokens are minted for suspensions and the appeal routes require a
  suspended subject. A token minted here would be refused by them — a control that
  reliably fails. The support channel is offered instead, which a human answers.
- A **second** warning MUST be permitted. The repeat is the escalation; refusing it makes
  a second incident unrecordable.
- The notice MUST state three things and no more: what was decided, that nothing has been
  taken away, and what happens next.
  **RATIONALE:** the recipient is frequently a teenager about to feel accused. The two
  failure modes are opposite — wording so soft they do not realise anything was recorded,
  or so severe they believe they have been removed from the platform.

### 3.5.4 The warning capability

**Requirement.** Warning MUST be a capability distinct from suspension.

**RATIONALE.** Folding it into suspension would make that name lie about what it
permits, and the split enables the useful grant: a helper who can tell somebody to stop
and cannot lock them out.

**Requirement.** It MUST NOT be the resolution capability either. Sorting a queue must
not carry the power to place a disciplinary notice on a student's record.

### 3.5.5 Content removal

**Requirements.**

- Removal MUST make content unavailable to users while retaining it as evidence.
- Removal MUST be recorded with the deciding report where one exists.
- Removal MUST NOT delete the evidence snapshot.
- The author MUST be notified, with the reason.

### 3.5.6 Acting on the person, from the report

**Requirements.**

- The report detail surface MUST offer acts against the resolved subject, each gated on
  its own capability.
- Ordering MUST place **contact before enforcement**.
  **RATIONALE:** most reports are resolved by asking somebody what happened, and a
  moderator offered only enforcement will use enforcement.
- Where there is no person to act on, nothing MUST be offered, and the reporter MUST NOT
  be substituted (§3.3.10).
- An act already in force MUST NOT be offered again; its state MUST be shown instead,
  with the reversal.

### 3.5.7 Failure modes

| # | Failure mode | Control |
|---|---|---|
| F-3.1 | Outcome recorded, act never performed | §3.3.5 correspondence requirement |
| F-3.2 | Warning recorded, notice undelivered | Notice enqueued in the transaction; throws |
| F-3.3 | Act offered where the person is absent | Subject resolution; no reporter fallback |
| F-3.4 | Suspension imposable, not reversible | §3.5.2 reversibility column; reinstatement offered where suspension is |
| F-3.5 | Warning silently restricts something | Test asserting status, token version, role and suspension fields unchanged |

### 3.5.8 Acceptance criteria for §3.5

| # | Criterion |
|---|---|
| AC-3.5.1 | Every act records actor, subject, reason, time, and both trails. |
| AC-3.5.2 | No act is offered without an endpoint. |
| AC-3.5.3 | A warning delivers a notice preferences cannot suppress. |
| AC-3.5.4 | A warning changes no account field, asserted field by field. |
| AC-3.5.5 | A warning carries no appeal token. |
| AC-3.5.6 | A second warning is accepted. |
| AC-3.5.7 | Warning is a distinct capability from suspension and from resolution. |
| AC-3.5.8 | Removal retains evidence and notifies the author. |
| AC-3.5.9 | Contact precedes enforcement in the offered order. |
| AC-3.5.10 | Reinstatement is offered wherever suspension is. |

### 3.5.9 Automated moderation is out of scope, and why

**Requirement.** Automated classification of message content MUST NOT be implemented.

**RATIONALE.** A classifier on this surface produces two failures, and the platform can
absorb neither. A false positive removes or flags a student's message to an organizer
about a shift, teaching the population that the platform reads their messages and
misjudges them. A false negative is worse: it creates a *record* that the content was
reviewed and cleared, which is then relied upon. On a platform whose entire moderation
population is one to two people, an automated pass that is trusted is more dangerous
than no pass at all. Reporting is the mechanism, and it is reachable from every surface.

---

## 3.6 Notifications

### 3.6.1 Purpose

Tell people things they need to know, through channels they control, except where
control would mean not telling them something they must be told.

### 3.6.2 Architecture

Two channels: an in-application record, and mail dispatched by an outbox worker.

**Requirements.**

- Dispatch MUST write the in-application record and enqueue mail in one transaction with
  the act that triggered it, where the notice is mandatory.
- The outbox MUST be durable and retried. A transient mail failure MUST NOT lose the
  notice.
- Content MUST be generated from a registry keyed by event type. A caller MUST NOT pass
  arbitrary content.
- Every event type MUST have content. A missing case MUST fail the build.

### 3.6.3 Preferences

**Requirements.**

- Preferences are per category and per channel, and default to enabled.
- A global mail opt-out MUST be honoured for every non-mandatory notice.

### 3.6.4 Mandatory notices

**Requirement.** A closed set of event types MUST be delivered whatever the preferences
say. The set MUST be a literal enumeration, not a flag a caller may pass.

**RATIONALE for a set rather than a flag.** A flag becomes an override for anything
within two releases.

**The set, with the reason each member is in it:**

| Event | Reason |
|---|---|
| Suspension | The subject cannot read an in-application notice — they are refused before a principal exists — so mail is the only channel that reaches them. Honouring a preference to the point of denying a minor any knowledge of a sanction against them, or of their right to appeal it, is not privacy-protective; it is a failure to serve notice. |
| Warning | The step that precedes suspension, and worthless if unread. A warning nobody read still counts against them next time. |
| Reinstatement | The reciprocal duty. The override is only defensible because the notice is necessary, which obliges the same treatment for the good news. Nothing told a reinstated student anything, and they cannot discover it by signing in because they have no reason to try. |
| Appeal outcome, each form | Same reciprocity; also a published promise. |
| Urgent safety alert to moderators | On a platform whose moderator population is one person, a preference toggle became the only thing between a child-safety report and an unread queue. |

**Requirement.** The in-application record MUST still be written for these. It is
unreadable while a suspension is live, and it is exactly what the person finds waiting
the moment they are reinstated.

### 3.6.5 Failure handling

**Requirement.** A mandatory notice that cannot be enqueued MUST **throw**, rolling back
the act.

**RATIONALE.** A suspension whose notice could not be created is a person locked out with
no reason given and no appeal path in existence. The failure used to be swallowed and the
suspension committed anyway. Rolling back makes it a clean, retryable failure instead of
a silent one.

**Requirement.** A non-mandatory notice MUST NOT fail its triggering operation.

### 3.6.6 Deduplication

**Requirements.**

- A deduplication key MAY be supplied; where present, a repeat within a window MUST NOT
  produce a second notice.
- Deduplication MUST NOT apply to mandatory notices. Two suspensions are two facts.

### 3.6.7 Content requirements

| # | Requirement |
|---|---|
| N-1 | A notice states what happened, what it means for the reader, and what to do. |
| N-2 | A notice MUST NOT contain a status code or an internal identifier. |
| N-3 | An enforcement notice MUST state what has **not** been taken away. |
| N-4 | An action link MUST be a single canonical form agreed by the mail body, the in-application record, and the client's route allowlist. |
| N-5 | Mail MUST escape interpolated values. |
| N-6 | A deadline MUST be rendered as a date a person can act on, not as a duration. |

**FAILURE MODE for N-4, realised.** A link form that the client route table did not
match produced a dead link in the one message a suspended user is guaranteed to read.

### 3.6.8 Acceptance criteria for §3.6

| # | Criterion |
|---|---|
| AC-3.6.1 | Every event type has content; a missing case fails the build. |
| AC-3.6.2 | The mandatory set is a literal enumeration; no caller flag exists. |
| AC-3.6.3 | Each mandatory member is delivered with preferences disabled and with a global opt-out. |
| AC-3.6.4 | A mandatory notice that cannot be enqueued rolls back its act. |
| AC-3.6.5 | A non-mandatory failure does not fail its operation. |
| AC-3.6.6 | Deduplication does not apply to mandatory notices. |
| AC-3.6.7 | Every action link resolves in the client route allowlist. |
| AC-3.6.8 | Mail escapes interpolated values, asserted with hostile input. |

---

## 3.7 Appeals

### 3.7.1 Purpose

Give a person subject to enforcement a path to contest it, and make the contest and its
decision permanent.

### 3.7.2 Access

**Requirements.**

- A suspension MUST mint a single-use, expiring token, delivered in the mandatory notice.
- The token MUST be usable **without a session**, because the subject cannot sign in.
- The token path MUST NOT disclose more than: that an enforcement action exists, its
  reason, and the form.
- An authenticated path MUST also exist for a subject who can still sign in.
- A subject who has **already filed** MUST retain access to their appeal even after the
  enforcement ends.
  **FAILURE MODE:** a check requiring current suspension makes an appeal unreadable the
  moment the suspension is lifted — including when it is lifted *because* the appeal
  succeeded.

### 3.7.3 Token lifecycle

| # | Requirement |
|---|---|
| AT-1 | Single-use. |
| AT-2 | Expiring, with the expiry stated in zone-marked form. |
| AT-3 | **Spent at reinstatement.** |
| AT-4 | A new enforcement action mints a new token. |

**FAILURE MODE for AT-3, realised.** A token stayed live through a reinstatement. It
answered as absent only because the route checked account status, so it lay dormant and
became usable again the moment the person was suspended a **second** time — carrying an
appeal window that opened before the thing being appealed, and letting an old link
disclose a new suspension's reason.

**Requirement on date formats.** Expiry MUST be stored zone-marked.
**FAILURE MODE:** a zone-less timestamp is parsed as local time, so the real expiry
drifts by the host's offset and two issuance paths in the same file disagree about when
the same period ends.

### 3.7.4 Content and immutability

**Requirements.**

- The appellant's statement MUST be captured separately from the reviewer's reasoning,
  and MUST be **write-once**.
  **RATIONALE:** a shared field lets a reviewer overwrite what the appellant said. The
  appellant's words are the thing being reviewed.
- The reviewer's identity MUST be write-once.
- The decision MUST be recorded with outcome, reasoning, reviewer and time.
- The appeal record and its history MUST reject update and delete at the storage layer.
- Reopening MUST be a new entry, never an edit.

### 3.7.5 Lifecycle

States: `open`, `under_review`, `decided`, `reopened`.

**Requirements.**

- Claiming MUST record the claimer.
- A decision MUST record reasoning meeting a minimum length.
- Two outcomes exist: the decision stands, or it is reversed.
- A reversal MUST NOT itself reinstate. Reinstatement is a **separate** act behind the
  suspension capability, which the deciding reviewer may not hold.
- The two MUST nonetheless be **linked**: the reinstatement MUST record which appeal
  required it, and the appeal's history MUST record that reinstatement occurred.
  **FAILURE MODE:** without the link, the audit log records a reinstatement with no
  traceable reason, and the appeal's history stops at the decision — so "was this person
  actually let back in" has no answer on the record.
- The link MUST be looked up rather than passed in, so it is recorded however the
  reinstatement was reached, including by an administrator who never opened the appeal.

### 3.7.6 Independence disclosure

**Requirement.** The platform MUST NOT claim independent review it cannot provide.

**Requirement.** Where the reviewer may be the same person who imposed the enforcement,
the published guidelines MUST say so plainly, and a self-review MUST be recorded as such
(Volume II §2.4.4).

**RATIONALE.** A promise of independent review on a one-to-two-person team is false, and
a false procedural promise is worse than an honest limitation: it invites reliance that
cannot be met, and it is the kind of statement a district will test.

### 3.7.7 Acceptance criteria for §3.7

| # | Criterion |
|---|---|
| AC-3.7.1 | A suspension mints a token delivered in the mandatory notice. |
| AC-3.7.2 | The token works with no session and discloses nothing beyond the permitted set. |
| AC-3.7.3 | A filed appeal remains accessible after the enforcement ends. |
| AC-3.7.4 | Tokens are single-use, expiring, zone-marked, and spent at reinstatement. |
| AC-3.7.5 | A dormant token cannot be revived by a second enforcement. |
| AC-3.7.6 | The statement and the reviewer identity are write-once, asserted at the storage layer. |
| AC-3.7.7 | Appeal records and histories reject update and delete. |
| AC-3.7.8 | A reversal does not reinstate; reinstatement is separately gated. |
| AC-3.7.9 | Reinstatement and appeal are linked in both directions, by lookup. |
| AC-3.7.10 | The guidelines disclose the review limitation. |

---

## 3.8 Suspensions

### 3.8.1 Purpose

Remove access from an account, for a stated reason, for a stated period or indefinitely,
reversibly and appealably.

### 3.8.2 Requirements

| # | Requirement |
|---|---|
| S-1 | A reason MUST be provided, meeting a minimum length, because the subject is told it and an appeal is reviewed against it. |
| S-2 | Every session MUST end. The token version MUST be incremented. |
| S-3 | The status change, the token version, the appeal token, the audit record and the notice MUST be one transaction. |
| S-4 | An already-suspended account MUST be refused, and the original reason MUST survive. |
| S-5 | Self-suspension MUST be refused. |
| S-6 | Target rules per Volume II §2.4.4 and §2.10.4. |
| S-7 | Active events hosted by a suspended organizer MUST be **reported, not cancelled**. |
| S-8 | Credited hours, attendance and certificates MUST be untouched, and the notice MUST say so. |

**RATIONALE for S-2.** Status alone stops the next sign-in and leaves every issued cookie
working for up to a week — so the person suspended for messaging a student could continue
messaging that student for that week, which is the entire window the suspension exists to
close.

**RATIONALE for S-7.** A suspended organizer may host events with volunteers already
accepted onto shifts. Cancelling automatically would strand students with no notice as a
side effect of a moderation action, and un-cancelling is not something this platform can
do. The count is returned for an administrator to act on deliberately.

### 3.8.3 INV-012 — Timed suspensions expire from data

**INVARIANT.** A suspension deadline MUST be authoritative in the stored record. Access
MUST return the instant the deadline passes, whether or not any background work ran.

**Requirements.**

- The deadline is nullable; null means indefinite, and null MUST remain what every
  pre-existing record has always meant. No default, no backfill.
  **RATIONALE:** inventing an expiry converts safety suspensions imposed before the
  column existed into ones that lapse.
- An **unreadable** deadline MUST fail **closed** — treated as indefinite.
  **RATIONALE:** between "locked out until a human looks" and "quietly released by a
  typo", only the first is recoverable.
- A deadline already in the past MUST be refused at the write path. It would end at the
  next request, which reads to everybody as the suspension having silently failed.
- A non-string deadline MUST be refused, not coerced.
- The boundary MUST be **exclusive**: at the deadline instant, the suspension is over.
- A deadline supplied as a calendar date MUST be interpreted as the **end** of that day.
  **FAILURE MODE:** a date parsed as midnight ends the suspension at the start of the
  chosen day, cutting it a day short in most of the world.

**RATIONALE against a job-based expiry.** A scheduled job is a promise the process must
keep running to honour. Down for a day, a student who should be back is still locked out,
and nothing about the record says the deadline passed — which is exactly the fake
expiration this requirement forbids.

### 3.8.4 INV-013 — One definition of "suspended right now"

**INVARIANT.** There MUST be exactly one predicate answering whether an account is
suspended at this moment. Every enforcement point MUST call it.

**Requirements.**

- A static guard MUST scan **every** server module and fail on a status-string
  comparison, with exemptions carrying reasons and failing when stale.
- The guard MUST **derive** its subject set from the filesystem (P-3).
- Enforcement points MUST additionally be asserted **positively** to use the predicate,
  because the negative check also passes for a module that stopped enforcing suspension
  altogether.

**The three doors, and how each fails differently:**

| Door | Failure if the predicate is not used |
|---|---|
| Per-request authentication | A suspended person keeps a working session. Silent, and the exact thing suspension exists to prevent. |
| Password sign-in | Somebody whose period is up cannot get back in. Visible; reported within a day. |
| Provider sign-in | The same lockout — except a provider-only account has **no other door**, so it is permanent rather than annoying, from an account whose sanction has already expired, with nothing on screen to explain it. |

**FAILURE MODE, realised.** A guard listing the two enforcement points its author knew
about missed the third. The provider path compared the stored status, and a
provider-only account whose timed suspension had expired was permanently locked out.
This is the specific incident that makes derivation (P-3) a principle rather than a
preference.

### 3.8.5 Normalisation

**Requirements.**

- Each enforcement point MUST normalise a record whose deadline has passed, so
  administrative views stop describing the person as suspended.
- Normalisation MUST retain the reason, the imposition time and the imposing actor.
  **RATIONALE:** "this account was suspended in March, for this reason, by this
  administrator" stays true after the suspension ends. An appeal is reviewable years
  later, and a moderator handling a repeat incident needs to know there was a first one.
  The operational audit row that would otherwise carry it is swept.
- Normalisation MUST NOT increment the token version. It was incremented at imposition,
  which ended every session; incrementing again is one more forced sign-out for somebody
  just let back in.
- A sweep MAY normalise records for accounts that never return. Access correctness MUST
  NOT depend on it; only labelling does.
- Where a sweep is absent, that MUST be stated rather than implied (Volume V §5.6.6).

### 3.8.6 Reinstatement

**Requirements.**

- Reinstatement MUST clear the deadline.
  **FAILURE MODE:** a **future** deadline left behind is not inert. The account works
  again, until somebody suspends it a second time without naming a deadline — and it
  silently inherits the old one, ending on a date nobody chose. The same dormant-value
  class as the appeal token in §3.7.3.
- Reinstatement MUST spend outstanding appeal tokens.
- Reinstatement MUST NOT be reachable only through the appeals surface.
  **FAILURE MODE, realised:** the only route to reversing a suspension ran through the
  suspended person appealing it, so an administrator who suspended the wrong account had
  to wait for a student to formally contest something the administrator already knew was
  wrong.
- A reason MUST be optional.
  **RATIONALE:** imposing a sanction has to be justified; removing one does not.
  Requiring a paragraph before somebody can undo their own mistake is friction pointed
  the wrong way.
- The subject MUST be notified.

### 3.8.7 Disclosure

**Requirement.** The end date MUST NOT appear in the pre-authentication sign-in refusal
(Volume II §2.2.3). It MUST appear in the mandatory notice.

**Requirement.** The notice MUST state whether the suspension has an end date, and MUST
say plainly when it does not. A person told only that they are suspended cannot tell a
week from for ever, and will either wait indefinitely for something that lapsed or spend
their one appeal on a suspension that was going to end anyway.

### 3.8.8 Acceptance criteria for §3.8

| # | Criterion |
|---|---|
| AC-3.8.1 | A suspension requires a reason and ends every session, asserted with a pre-existing session. |
| AC-3.8.2 | Status, version, token, audit and notice are one transaction. |
| AC-3.8.3 | A second suspension is refused and the original reason survives. |
| AC-3.8.4 | Active events are reported, not cancelled. |
| AC-3.8.5 | Hours, attendance and certificates are untouched. |
| AC-3.8.6 | Null deadline means indefinite; no record was backfilled. |
| AC-3.8.7 | An unreadable deadline keeps the account suspended. |
| AC-3.8.8 | A past or non-string deadline is refused. |
| AC-3.8.9 | The boundary is exclusive; a date-only value ends at the day's end. |
| AC-3.8.10 | One predicate exists; a derived guard covers every module; exemptions fail when stale. |
| AC-3.8.11 | All three doors are positively asserted to use it. |
| AC-3.8.12 | Expiry restores access with no job running, at every door including provider sign-in. |
| AC-3.8.13 | Normalisation retains the reason and does not bump the token version. |
| AC-3.8.14 | Reinstatement clears the deadline, spends tokens, and is reachable outside appeals. |
| AC-3.8.15 | The end date is absent pre-authentication and present in the notice. |

---

## 3.9 The audit timeline

### 3.9.1 Purpose

Make what has been done to a subject readable by the people who need it.

### 3.9.2 INV-011 — No unattributed act

**INVARIANT.** Every entry recording an act against a person MUST name the actor.

**RATIONALE.** An anonymous entry says somebody changed this without saying who, which is
the single question the record exists to answer.

### 3.9.3 Granularity

**Requirement.** One entry per field changed, not one per request.

**RATIONALE.** Assigning, reprioritising and closing are three decisions and read as
three lines a year later.

**Requirement.** Where one request writes several entries sharing a timestamp, ordering
MUST be stabilised by a secondary key. Without it, a history's order is whatever the
query planner chose — which for a history is not a detail.

### 3.9.4 Presentation

| # | Requirement |
|---|---|
| TL-1 | Oldest first, so the timeline reads in the order things happened. |
| TL-2 | Each entry shows time with time-of-day, the actor's name, the act in the reader's terms, and what changed. |
| TL-3 | An actor whose account is gone MUST be named from a fallback, and the join MUST be outer. An inner join deletes a departed moderator's decisions from the record. |
| TL-4 | Stored identifiers MUST be translated to labels. |
| TL-5 | An unrecognised act MUST render legibly rather than vanishing. |
| TL-6 | An evidence read MUST appear. It is how a moderator learns somebody already read them. |
| TL-7 | A self-review MUST be visibly marked. |

### 3.9.5 What the timeline is not

**Requirement.** The timeline MUST NOT include page views, metadata reads, or automated
sweeps that changed nothing. It records **decisions and disclosures**.

**RATIONALE.** A timeline recording everything is a timeline nobody reads, which is a way
of destroying it while appearing to strengthen it.

### 3.9.6 Acceptance criteria for §3.9

| # | Criterion |
|---|---|
| AC-3.9.1 | Every entry names an actor. |
| AC-3.9.2 | One entry per field changed. |
| AC-3.9.3 | Same-timestamp entries have stable ordering. |
| AC-3.9.4 | Oldest first, with time-of-day. |
| AC-3.9.5 | A departed actor's entries survive and are named from a fallback. |
| AC-3.9.6 | Evidence reads and self-reviews appear and are marked. |
| AC-3.9.7 | No page views or metadata reads appear. |

---

## 3.10 Lifecycles

### 3.10.1 Organizer lifecycle

| State | Reached by | Capabilities |
|---|---|---|
| Requested | Registration as an organizer | None reaching a student |
| Approved, unsigned | Staff approval | Still none reaching a student; agreement withheld |
| Active | Agreement accepted | Full organizer set |
| Suspended | Enforcement | None |
| Standing removed | Demotion | Reduced to a base account; records retained |

**Requirements.**

- Approval MUST be an explicit staff act, recorded.
- Denial pre-approval MUST be distinguished from demotion post-approval. Denial MAY
  remove the account, because it has produced nothing; demotion MUST NOT, because it
  has.
- The agreement MUST be a withholding, not a status flag, so the same mechanism that
  computes capabilities computes the restriction.
- The acceptance screen MUST be reachable while the withholding applies (Volume II
  §2.3.5).
- Demotion MUST retain every event, attendance record, credited hour and certificate the
  organizer produced.
  **RATIONALE:** an event that produced service hours is part of a student's record
  regardless of what became of the organizer.

### 3.10.2 Student lifecycle

| State | Reached by | Notes |
|---|---|---|
| Registered, unverified | Registration | Confined by the verification gate |
| Active | Verification | Full student set |
| Suspended | Enforcement | Records retained |
| Warned | Enforcement | No capability change |
| Deletion requested | Self-service, step-up gated | Anonymised shell; records retained per policy |
| Purged | Retention expiry | Shell removed |

**Requirements.**

- Deletion MUST be self-service and step-up gated.
- Deletion MUST anonymise rather than remove, for the published retention period, so
  service records and safety records survive.
- The published period MUST be honoured exactly. Extending it silently to preserve
  something makes a published statement false with no stated end.
- Purge MUST NOT cascade into another person's records. Exemptions MUST be computed from
  the schema, not enumerated.
  **FAILURE MODE, realised:** an organizer's shell was never exempt however many
  students' service records hung off their events, because the exemption checked only the
  purged account's own attendance rows and the attendance subject is always the
  volunteer. Time-armed rather than live, which is why it had to be found by reading the
  schema rather than by waiting for it.
- Graduation MUST NOT be a lifecycle state. A graduated student is an active account
  whose record is complete.

### 3.10.3 Acceptance criteria for §3.10

| # | Criterion |
|---|---|
| AC-3.10.1 | Approval is explicit and recorded. |
| AC-3.10.2 | Denial and demotion are distinct; demotion retains all records. |
| AC-3.10.3 | The agreement is a withholding and its acceptance screen is reachable. |
| AC-3.10.4 | Deletion is step-up gated and anonymises. |
| AC-3.10.5 | The published retention period is honoured exactly. |
| AC-3.10.6 | Purge exemptions are schema-derived and cover others' records. |

---

## 3.11 Privacy considerations for this volume

| # | Requirement |
|---|---|
| P-3.1 | Message content is disclosed only through the evidence path, under its own capability, recorded. |
| P-3.2 | A report's reporter is disclosed to moderators and never to the reported party. |
| P-3.3 | A moderator's case note is never placed in the operational trail. |
| P-3.4 | An enforcement notice discloses only what concerns its recipient. |
| P-3.5 | Public profiles indexed by search engines MUST NOT exist. The population is majority minors, and discoverability is a safety property, not a growth feature. |
| P-3.6 | A data export includes the requester's own reports, enforcement actions and appeals, and MUST NOT disclose another person's identity where it is not already known to them. |
| P-3.7 | A certificate verification page discloses the minimum that makes verification meaningful, and its code is random rather than derived from an identifier. |

---

## 3.12 Volume III acceptance summary

Volume III is satisfied when:

- Every acceptance criterion in §§3.1.13, 3.2.11, 3.3.11, 3.4.10, 3.5.8, 3.6.8, 3.7.7,
  3.8.8, 3.9.6 and 3.10.3 holds.
- Every invariant attributed to Volume III — INV-010, INV-011, INV-012, INV-013,
  INV-014, and the volume-local INV-3.1 to INV-3.3 — is enforced by a build-failing test
  observed to fail against an introduced violation.
- Every threat in §3.4.9 has its control implemented and its residual risk carried into
  Volume V §5.13.
- Every performance budget in §3.1.12 has been measured, with the measurement recorded.

**Cross-references.** Volume II supplies the authorization and audit machinery this
volume applies. Volume IV §4.4 specifies the Audit Explorer that reads the trails
described in §3.9. Volume V §5.6 specifies the sweep behaviour §3.4.8 and §3.8.5 depend
on. Appendix D is the normative registry of every action named here.
