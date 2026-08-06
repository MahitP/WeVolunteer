# Appendix C — Database Schema

**Status:** Normative registry
**Binds:** Volume I §1.6, Volume III, Volume V §5.6, §5.9
**Currency obligation:** Updated in the same commit as any schema change, including a
retention class for every new table (Volume I §1.9.2 R-10).

---

## C.1 How to read this appendix

45 tables, 16 immutability triggers, 58 explicit indexes, 18 versioned migrations.

Each table carries five properties. They are not optional metadata; each drives a rule
elsewhere.

| Property | Drives |
|---|---|
| **Retention class** | The sweep's behaviour (Volume V §5.6.2) |
| **Immutability** | Whether storage-layer constraints apply (Volume II §2.9.8) |
| **Tenant scope** | Multi-tenancy preparation (Volume IV §4.12.4) |
| **Cascade policy** | Whether deleting a parent may remove a record of an event (Volume I §1.7.5) |
| **Portability note** | What the engine migration must reproduce (Volume V §5.9.6) |

### C.1.1 Retention classes

| Class | Meaning |
|---|---|
| `PERMANENT` | Never swept. Survives account deletion. |
| `LIFETIME` | Retained while the account exists; anonymised on deletion. |
| `AGED-{n}d` | Swept at *n* days. |
| `EPHEMERAL` | Short-lived; swept aggressively. |
| `DERIVED` | Rebuildable; may be discarded. |

### C.1.2 Cascade classes

| Class | Meaning |
|---|---|
| `CASCADE` | Deleting the parent removes the row. Permitted only where the row has no independent evidentiary value. |
| `SEVERED` | The reference nullifies; an identity snapshot preserves legibility. **Required** wherever the row is a record of an event and the parent is its subject. |
| `RESTRICT` | Deleting the parent is refused. |

---

## C.2 Table registry

### C.2.1 Identity and accounts

| Table | Purpose | Retention | Immutable | Tenant |
|---|---|---|---|---|
| `users` | Accounts | `LIFETIME`, then `AGED-1095d` as an anonymised shell | No | Yes |
| `oauth_accounts` | Provider identity links | `LIFETIME` | No | Yes |
| `oauth_states` | In-flight authorization state | `EPHEMERAL` | No | No |
| `oauth_signup_sessions` | Signup continuation | `EPHEMERAL` | No | No |
| `password_reset_tokens` | Reset tokens | `EPHEMERAL` | No | Yes |
| `email_verification_tokens` | Verification tokens | `EPHEMERAL` | No | Yes |
| `email_change_tokens` | Address-change tokens | `EPHEMERAL` | No | Yes |
| `revoked_sessions` | Per-session revocation | `EPHEMERAL`, swept once the token could no longer be valid | No | Yes |
| `reauth_challenges` | Step-up grants | `EPHEMERAL` | No | Yes |
| `user_capabilities` | Per-account grants | `LIFETIME` | No | Yes |
| `instance_lock` | Single-process enforcement | `DERIVED` | No | No |

**Requirement on `users`.** No column may store a service-hour total (INV-001). Suspension
state comprises `account_status`, `suspended_at`, `suspended_until`, `suspension_reason`,
`suspended_by`, `suspension_lifted_at`; `suspended_until` is nullable and null means
indefinite, permanently (Volume III §3.8.3).

**Requirement on `revoked_sessions`.** Entries MUST NOT be swept before the corresponding
token could no longer be valid. Sweeping earlier resurrects a revoked session.

**Requirement on `oauth_accounts`.** Keyed on the provider's stable subject identifier, never
on the address. Addresses are reassigned, particularly in school domains after a student
leaves; a link keyed on address hands the departed student's account to the next holder
(Volume II §2.6.7).

### C.2.2 Events and service

| Table | Purpose | Retention | Immutable | Tenant |
|---|---|---|---|---|
| `events` | Volunteer opportunities | `PERMANENT` while hours derive from them | No | Yes |
| `slots` | Shifts within an event | `PERMANENT` | No | Yes |
| `applications` | Sign-ups | `AGED-1095d` **from the event**, not the application | No | Yes |
| `application_conflicts` | Overlapping-application records | `AGED-1095d` | No | Yes |
| `attendance` | Presence and awarded hours | `PERMANENT` | No | Yes |
| `attendance_checkin` | Check-in events | `PERMANENT` | No | Yes |
| `hours_ledger` | Append-only hours record | `PERMANENT` | Append-only by convention | Yes |
| `certificates` | Issued certificates | `PERMANENT` | No | Yes |
| `auto_select_runs` | Automatic selection records | `AGED-1095d` | No | Yes |
| `user_favorites` | Saved events | `LIFETIME` | No | Yes |

**Requirement on `applications`.** Ageing is computed from the **event's last slot end**,
falling back to the application's own timestamp where no slot exists. The predicate MUST be
written once and shared by the count and the delete, so a dry run can never report a
different set from the one the sweep removes.

**Requirement on `attendance` and `hours_ledger`.** Credited hours derive from attendance
marked present; the ledger is the independent record from which the derivation is verified. A
credit retains its original value permanently — editing the slot later MUST NOT re-price it
(INV-001).

**Requirement on `certificates`.** Verification codes MUST be random, stored, and never
derived from a user or event identifier. A derived code is guessable and turns verification
into enumeration.

### C.2.3 Messaging

| Table | Purpose | Retention | Immutable | Tenant |
|---|---|---|---|---|
| `conversations` | Threads | `PERMANENT` | No | Yes |
| `conversation_participants` | Membership — **the authorization source** | `PERMANENT` | No | Yes |
| `messages` | Message bodies | `AGED-1095d`, **exempt while under report** | No | Yes |
| `user_blocks` | Blocks | `LIFETIME` | No | Yes |

**Requirement on `conversations`.** `kind` is stored and MUST NOT be inferred (INV-3.1).
Conditional constraints require an event, a student and an organizer for an event-scoped
thread, and exactly one counterparty with no event for an administrator thread (Volume III
§3.1.4).

**Requirement on `messages`.** The retention exemption MUST cover the **whole live thread**,
not only captured identifiers. The capture is bounded, so a message beyond the bound in a
reported conversation would otherwise be swept while the report is open. The exemption
predicate MUST have exactly one definition — a second copy is a second way to lose evidence.

**Requirement on `conversation_participants`.** Authorization reads this table. The role
columns on `conversations` are descriptive and MUST NOT be consulted for access decisions
(Volume III §3.1.4 D-3.1.2).

### C.2.4 Reporting, evidence and moderation

| Table | Purpose | Retention | Immutable | Tenant |
|---|---|---|---|---|
| `reports` | Unified reports | `PERMANENT` | **Content immutable; workflow mutable** | Yes |
| `report_evidence` | Frozen message bodies | `PERMANENT` | **Fully immutable** | Yes |
| `moderation_actions` | Report history | `PERMANENT`, sweep-exempt | **Append-only** | Yes |
| `conversation_reports` | Legacy conversation reports | `PERMANENT` | **Immutable** | Yes |
| `conversation_report_messages` | Legacy evidence | `PERMANENT` | **Immutable** | Yes |

**Requirement on `reports`.** Category, description, target and reporter snapshot MUST be
immutable at the storage layer. Status, priority, assignment, outcome and note MUST be
mutable, because a report that cannot be closed is a permanent hold on everything keyed to
it. `reporter_id` MUST be **excluded** from the immutable column enumeration: a referential
nullification performs a real update and fires update constraints, so naming it would abort
the retention sweep instead of the tampering.

**Requirement on `report_evidence`.** Both `created_at` (when sent) and `captured_at` (when
frozen) MUST be present and MUST both be exposed. They are two facts, and the difference is
what distinguishes a preserved copy from a live read.

**Requirement.** `reports.reporter_id` is `SEVERED`, with a name snapshot.
**FAILURE MODE closed:** a student who reported an adult destroyed their own report by
exercising their deletion right, because the reference cascaded and the sweep hard-deletes
anonymised shells. The victim's own privacy right silently erased the record of what had been
done to them.

### C.2.5 Appeals

| Table | Purpose | Retention | Immutable | Tenant |
|---|---|---|---|---|
| `appeals` | Appeals | `PERMANENT` | **Immutable; statement and reviewer write-once** | Yes |
| `appeal_events` | Appeal history | `PERMANENT`, sweep-exempt | **Append-only** | Yes |
| `appeal_tokens` | Unauthenticated access tokens | `EPHEMERAL`, spent at reinstatement | No | Yes |

**Requirement on `appeals`.** The appellant's statement MUST be a separate column from the
reviewer's reasoning, and MUST be write-once. A shared field lets a reviewer overwrite what
the appellant said, and the appellant's words are the thing being reviewed.

**Requirement on `appeal_tokens`.** Expiry MUST be stored zone-marked.
**FAILURE MODE:** a zone-less timestamp is parsed as local time, so the real expiry drifts by
the host's offset and two issuance paths disagree about when the same period ends.

**Requirement.** Outstanding tokens MUST be spent at reinstatement.
**FAILURE MODE closed:** a token stayed live through a reinstatement, answering as absent only
because the route checked account status — so it lay dormant and became usable again on the
next suspension, carrying an appeal window that opened before the thing being appealed.

### C.2.6 Notifications

| Table | Purpose | Retention | Immutable | Tenant |
|---|---|---|---|---|
| `notifications` | In-application records | `AGED`, per class | No | Yes |
| `notification_jobs` | Mail outbox | `EPHEMERAL` after delivery | No | Yes |
| `notification_preferences` | Per-category, per-channel settings | `LIFETIME` | No | Yes |

**Requirement.** `notifications.kind` stores the **category**, not the event type. A query
filtering by event name silently matches nothing.
**FAILURE MODE:** a test filtering on the event name passed while asserting the absence of
rows it never looked for.

### C.2.7 Legal

| Table | Purpose | Retention | Immutable | Tenant |
|---|---|---|---|---|
| `legal_documents` | Published documents with pinned hashes | `PERMANENT` | **Published versions immutable** | No — shared |
| `legal_acceptances` | Acceptance records | `PERMANENT` | Immutable | Yes |

**Requirement.** A published version's hash MUST NOT change; editing one MUST throw
(INV-015). An acceptance references a version and a hash, so what a person agreed to is
recoverable exactly. A correction is a **new version**; there is no in-place edit.

**Requirement.** The hash covers the **published body** only, so editorial matter outside it
may be corrected without moving the hash.

### C.2.8 Content

| Table | Purpose | Retention | Immutable | Tenant |
|---|---|---|---|---|
| `event_comments` | Comments | `AGED-1095d`, exempt under report | No | Yes |
| `event_announcements` | Announcements | `AGED-1095d`, exempt under report | No | Yes |

### C.2.9 Diagnostics and administration

| Table | Purpose | Retention | Immutable | Tenant |
|---|---|---|---|---|
| `error_groups` | Fingerprinted failure classes | `AGED-30d` | No | Shared |
| `error_events` | Individual occurrences | `AGED-30d` | No | Shared |
| `admin_audit_logs` | Operational trail | `AGED-365d` | No | Yes |
| `data_export_jobs` | Export jobs | `EPHEMERAL` | No | Yes |
| `schema_migrations` | Applied migrations with checksums | `PERMANENT` | No | No |

**Requirement on `error_events`.** There MUST be **no column for a request body**. Not
unpopulated — absent, so a later change that seems harmless cannot begin filling it.
Structured context MUST be an allowlist, never a denylist: a denylist fails on the first
field nobody anticipated. The subject MUST be a one-way hash, never an identifier. The route
MUST be stored as a **pattern**, never with parameters interpolated, with query and fragment
removed before matching.

---

## C.3 Immutability triggers

16 triggers. Each MUST be restored by any rebuild of its table.

| # | Trigger | Table | Prevents |
|---|---|---|---|
| 1 | `reports_immutable` | `reports` | Editing what a report says |
| 2 | `reports_no_delete` | `reports` | Deleting a report |
| 3 | `report_evidence_no_update` | `report_evidence` | Editing frozen evidence |
| 4 | `report_evidence_no_delete` | `report_evidence` | Deleting frozen evidence |
| 5 | `moderation_actions_no_update` | `moderation_actions` | Editing history |
| 6 | `moderation_actions_no_delete` | `moderation_actions` | Deleting history |
| 7 | `appeals_immutable` | `appeals` | Editing an appeal record |
| 8 | `appeals_no_delete` | `appeals` | Deleting an appeal |
| 9 | `appeals_statement_write_once` | `appeals` | Overwriting the appellant's statement |
| 10 | `appeals_reviewer_name_write_once` | `appeals` | Overwriting the reviewer identity |
| 11 | `appeal_events_no_update` | `appeal_events` | Editing appeal history |
| 12 | `appeal_events_no_delete` | `appeal_events` | Deleting appeal history |
| 13 | `conversation_reports_immutable` | `conversation_reports` | Editing a legacy report |
| 14 | `conversation_reports_no_delete` | `conversation_reports` | Deleting a legacy report |
| 15 | `conversation_report_messages_no_update` | `conversation_report_messages` | Editing legacy evidence |
| 16 | `conversation_report_messages_no_delete` | `conversation_report_messages` | Deleting legacy evidence |

**Requirement.** A rebuild that drops a trigger silently removes an invariant while every
test passes. Trigger restoration MUST be asserted per rebuild (Volume I §1.6.4).

**Portability.** All 16 MUST be re-expressed and **individually** re-verified against the
invariant each enforces during an engine migration (Volume V §5.9.7 MP-2).

---

## C.4 Constraints a naïve translation would drop

**Requirement.** Every entry here MUST be verified **behaviourally** after any engine change,
not by inspecting the generated schema.

| # | Constraint | Table | Consequence if dropped |
|---|---|---|---|
| 1 | Partial unique index over `(kind, created_by, COALESCE(student_id, organizer_id))` where kind is an administrator category | `conversations` | Duplicate administrator conversations. Pressing a control twice silently splits the conversation in half; neither half contains the whole exchange, and a moderator reading one concludes the other does not exist. |
| 2 | Conditional CHECK requiring event, student and organizer for an event-scoped thread | `conversations` | An event-scoped thread about no event becomes representable. Every event query and every lifecycle rule reads it as a thread about nothing. |
| 3 | Conditional CHECK requiring exactly one counterparty for an administrator thread | `conversations` | A thread naming both a student and an organizer as counterparties, with no defined semantics. |
| 4 | Write-once enforcement on the appellant statement and reviewer identity | `appeals` | A reviewer overwrites what the appellant said. |
| 5 | Column-scoped immutability on `reports`, excluding the nullifiable reference | `reports` | Either the workflow freezes, or the retention sweep aborts. |
| 6 | Case-insensitive uniqueness on address and username | `users` | A case variant creates a second account for the same person, or accepts an invitation intended for another. |

**RATIONALE for entry 1's presence here.** A composite unique constraint over the three role
columns cannot enforce it: null values are distinct under such a constraint, so every
administrator thread is unique to it however many times it is created. The expression index
is the only mechanism, and a naïve table translation drops it while producing a schema that
looks complete.

---

## C.5 Migration registry

18 versioned migrations. Each MUST be idempotent, checksum-verified over its whole file, and
carry a rollback in its header (Volume I §1.6.3).

| # | Name | Class | Notes |
|---|---|---|---|
| 001 | `authz_roles` | **Rebuild** | Widens the role constraint. Sanctioned; carries all six guards. |
| 002 | `user_capabilities` | Additive | Per-account grants. The mechanism the triage-only helper depends on. |
| 003 | `reauth_challenges` | Additive | Step-up grants. |
| 004 | `error_events` | Additive | Diagnostics. |
| 005 | `error_alerts` | Additive | Alerting state. |
| 006 | `account_suspension` | Additive | Suspension columns. No backfill: every existing row was active or deleted. |
| 007 | `legal_consent` | Additive | Documents and acceptances. |
| 008 | `date_of_birth` | Additive | Age gate. |
| 009 | `user_blocks` | Additive | Blocking. |
| 010 | `graduation_year` | Additive | |
| 011 | `evidence_preservation` | Additive + cascade severance | Severs the cascades that let a reported party destroy evidence. |
| 012 | `unified_reports` | **Rebuild** | Rebuilds `reports`. **MUST run while the table is childless.** |
| 013 | `report_evidence_and_fold` | Additive | Creates `report_evidence` — the child 012 must not have had. |
| 014 | `appeals` | Additive | |
| 015 | `appeals_integrity` | Additive + backfill | Splits the appellant statement from reviewer reasoning and freezes it. **MUST follow 014.** Its backfill recovers statements only from undecided appeals, so deferral loses them permanently. |
| 016 | `legal_v1_republish` | Data | **MUST precede catalogue synchronisation**, which it does: migrations run before the sync. Reversing restores the boot failure it repairs. |
| 017 | `timed_suspension` | Additive | Adds the deadline and lifted-at columns. **No default, no backfill** — inventing an expiry would convert safety suspensions imposed before the column existed into ones that lapse. |
| 018 | `admin_conversations` | **Rebuild** | Rebuilds `conversations` to admit administrator threads. Sanctioned; all six guards; `ownTransaction`. |

### C.5.1 Ordering dependencies

| Dependency | Consequence of reversal |
|---|---|
| 012 before 013 | 012 rebuilds `reports` and must run while childless. 013 gives it a child. Reordering makes the rebuild **destructive** rather than merely wrong. |
| 015 after 014 | 015 alters a table 014 creates, and its backfill only recovers statements from appeals not yet decided. |
| 016 before catalogue sync | Reversing restores the boot failure 016 repairs. |

### C.5.2 The two sanctioned rebuilds

Both carry all six guards from Volume I §1.6.4. A third requires the amendment procedure in
Volume 0 §0.8.

| Rebuild | Why unavoidable | Children at risk |
|---|---|---|
| 001 `users` | The engine cannot alter a CHECK constraint in place. | Every table referencing accounts. |
| 018 `conversations` | The engine cannot drop `NOT NULL` in place. | `messages`, `conversation_participants`, `conversation_reports` — one of which leads to the frozen evidence behind safety reports. |

**Requirement.** Both declare `ownTransaction`, because the foreign-key enforcement pragma is
a **silent no-op inside an open transaction**. A rebuild depending on it while wrapped in a
transaction executes with foreign keys enforced, cascade-deletes its children, and reports
success — and nothing else catches it: the parent's rows are copied and survive; a foreign-key
check finds nothing because a cascade *deletes* children rather than orphaning them; and no
exception is thrown, so no rollback fires.

**Portability.** In a network engine, 001 becomes constraint drop and add, and 018 becomes
three `ALTER COLUMN … DROP NOT NULL` statements. Both rebuilds and all six guards **disappear**
(Volume V §5.9.4 BL-1).

---

## C.6 Index inventory

58 explicit indexes. Requirements rather than an exhaustive listing; the authoritative
inventory is produced by Developer Mode (Volume IV §4.5.5.8).

| # | Requirement |
|---|---|
| IX-1 | Every offered filter MUST be index-supported. A filter requiring a full scan MUST NOT be offered (Volume IV §4.4.5). |
| IX-2 | A rebuild MUST restore every index the drop removed. A dropped index is a silent performance regression. |
| IX-3 | Where tenancy is added, indexes on tenant-scoped tables MUST lead with the tenant reference (Volume IV §4.12). |
| IX-4 | A partial index MUST state its predicate's purpose in the migration that creates it. |
| IX-5 | An index whose purpose is a retention sweep's exemption probe MUST say so, so it is not removed as unused by query analysis. |

**Requirement on IX-5.** An index probed only by a nightly sweep appears unused to
query-frequency analysis. Removing it converts a bounded sweep into a full scan on a
single-process system, which is an availability incident.

---

## C.7 Cascade audit

The following references are `SEVERED` rather than `CASCADE`, each closing a realised or
analysed failure.

| Reference | Was | Failure closed |
|---|---|---|
| `reports.reporter_id` → accounts | `CASCADE` | A student who reported an adult destroyed their own report by exercising their deletion right, because the sweep hard-deletes anonymised shells. |
| `conversation_reports.reporter_id` → accounts | `CASCADE` | Same. |
| Report chain under events | `CASCADE` chain | Deleting an event removed every conversation held under it, every safety report about those conversations, and the message snapshots written specifically to survive message deletion. The organizer needed no privilege beyond owning their own event, and **the harm occurs before the event runs, when attendance is zero by definition** — so the window in which evidence was destructible was exactly the window in which the harm occurs. |

**Requirement.** Every severance MUST be accompanied by an identity snapshot, and every read
of a severed reference MUST be an **outer** join.
**FAILURE MODE:** an inner join makes affected records *vanish* from a moderation queue — the
quietest possible failure, and one a moderator cannot notice, because nothing renders to say
anything is missing.

**Requirement.** Purge exemptions MUST be **derived from the schema**, never enumerated.
**FAILURE MODE, realised:** an organizer's anonymised shell was never exempt however many
students' service records hung off their events, because the exemption checked only the
purged account's own attendance rows — and the attendance subject is always the volunteer,
never the organizer. Time-armed rather than live, so it had to be found by reading the schema
rather than by waiting for it.

---

## C.8 Portability summary

| Construct | Count | Portability |
|---|---|---|
| Tables | 45 | Portable |
| Immutability triggers | 16 | **Require re-expression and individual re-verification** |
| Explicit indexes | 58 | Portable |
| Partial expression indexes | 1 | Portable, but dropped by a naïve translation (§C.4 entry 1) |
| Conditional CHECK constraints | 3 | Portable; verify behaviourally |
| Pragma statements | 109 | **No equivalents.** The pragma-took-effect guard becomes meaningless. |
| Destructive rebuilds | 2 | **Disappear** — the engine can alter constraints in place |
| Migrations replayable | 0 | A generated baseline is required, with the record restarted and the checksum system rebuilt |

**Requirement.** The engine migration MUST re-verify every invariant in Volume 0 §0.7
individually against the new engine (Volume V §5.9.7 MP-10).

---

## C.9 Verification obligations

| # | Obligation | Enforced by |
|---|---|---|
| VC-1 | No user column stores a service-hour total | Test |
| VC-2 | Ledger and derivation agree | Standalone parity command, non-zero on mismatch |
| VC-3 | Every immutability trigger rejects update and delete | Test at the storage layer, per trigger |
| VC-4 | Every rebuild restores its triggers and indexes | Test per rebuild |
| VC-5 | Every migration is idempotent | Test executing `up` twice |
| VC-6 | Checksums cover whole files and verify at boot | Test |
| VC-7 | Every constraint in §C.4 is verified behaviourally | Test per constraint |
| VC-8 | Every severed reference has a snapshot and outer joins | Test per reference |
| VC-9 | Purge exemptions are schema-derived; a new child table is covered without a code change | Test adding a fixture child |
| VC-10 | Every retention period matches the published policy | Test per class |
| VC-11 | The sweep's assertions run inside its transaction | Test by induced failure |
| VC-12 | Every table in this appendix exists, and every existing table appears here | Static guard comparing schema to this file |

**Requirement on VC-12.** The guard MUST fail in **both** directions: a table in the schema
and not here is an undocumented table; a table here and not in the schema is a stale
appendix.
