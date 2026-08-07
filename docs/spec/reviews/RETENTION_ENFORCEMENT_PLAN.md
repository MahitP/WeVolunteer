# Retention Enforcement — Complete Audit

**Date:** 2026-08-06
**Task:** M1 Task 2
**Method:** Every published promise read verbatim from the policy source; every
enforcement mechanism read from the code that implements it.
**Policy changes made:** **None.** No published wording was edited.

---

## 0. Correction to a previous finding

**`SPEC_VALIDATION_2026-08-06.md` C-01 is wrong, and this document corrects it.**

C-01 asserted that the specification "describes target retention as though enforced",
that "nothing sweeps" five named tables, and that **launch criterion LR-20 "cannot
currently pass"**.

That conclusion does not survive checking the published promises. The error was
methodological: C-01 compared Appendix C's *table-level retention classes* against the
retention worker, and concluded that a table with no sweep was a promise unmet. It never
read the published policy to establish **which promises exist**.

Having now read them:

- **Every published retention promise is enforced.** All ten, verified against the code
  that implements each.
- Three of the five tables C-01 named carry **no published promise at all**.
- One (`event_comments`) is promised on an **event-lifetime basis**, not an age basis, so
  a sweep would be wrong.
- One (`data_export_jobs`) **is** swept, by a different worker C-01 did not check.

**LR-20 passes.** The blocking-launch claim is withdrawn.

**What remains true from C-01** is much narrower: Appendix C assigns retention *classes*
to internal tables that have no published promise and no sweep, which is a documentation
imprecision. §6 records it.

The severity of C-01 moves from **high, blocks launch** to **low, documentation only**.

---

## 1. Sources

| Source | Role |
|---|---|
| `docs/legal/policies/01-privacy-policy.md` §"How long we keep things" | The published table. Primary |
| `docs/legal/policies/04-data-deletion-policy.md` | Restates the same periods for the deletion flow. Must agree with the primary |
| `server/workers/retentionWorker.js` | The daily sweep |
| `server/errorReporter.js` | Diagnostic retention |
| `server/workers/exportWorker.js` | Export archive expiry |
| `server/utils.js`, `server/reauth.js`, `server/services/verification.js` | Token and notification sweeps |

**Rule applied throughout.** A promise is *enforced* only if a mechanism deletes or
preserves on the promised schedule. A promise that happens to hold because nothing has
aged out yet is **not** enforced.

---

## 2. The ten published promises

Each row: the policy statement verbatim, the tables it governs, the enforcing mechanism,
and the verdict.

---

### P-01 · Volunteer hours and attendance

> **"Kept indefinitely."** *This is your service record. People come back for it years
> later — for a college application, a scholarship, a job.*

| | |
|---|---|
| **Tables** | `attendance`, `hours_ledger`, `attendance_checkin` |
| **Enforcement** | `PRESERVED_TABLES` in the retention worker includes `attendance` and `hours_ledger`. The sweep asserts their counts are unchanged **inside its own transaction**, so a sweep that destroyed them throws and rolls back |
| **Missing** | `attendance_checkin` is not in `PRESERVED_TABLES`. It is also not swept by anything, so the promise holds — but it is protected by absence of a deleter rather than by an assertion |
| **Verdict** | **ENFORCED**, with one strengthening opportunity (§5, I-01) |

---

### P-02 · Certificates

> **"Kept indefinitely."** *So a college or employer can still verify one years after you
> earned it.*

| | |
|---|---|
| **Tables** | `certificates` |
| **Enforcement** | In `PRESERVED_TABLES`; count asserted in-transaction. Additionally, the account purge refuses to remove a shell that holds a certificate |
| **Missing** | Nothing |
| **Verdict** | **ENFORCED** |

---

### P-03 · Account and profile

> *"While your account is open. After deletion, your details are replaced with a shortened
> name, and the remaining shell is deleted after **3 years** — unless you have volunteer
> hours or a certificate, which the shell has to outlive, or you are named in an open
> safety report, in which case it waits until that report is closed."*

This is the most conditional promise published, with **three** exceptions.

| | |
|---|---|
| **Tables** | `users`, and `legal_acceptances` deleted alongside |
| **Enforcement** | `deletedAccountDays = 3 × 365`. Purge excludes shells that: appear in `attendance`; appear in `certificates`; organize an event that has attendance or certificates; **or are party to a live report in either direction** |
| **Exception 1 — hours** | Enforced |
| **Exception 2 — certificates** | Enforced |
| **Exception 3 — open report** | Enforced, **in both directions**. The reporter side is the one that matters: it is the path by which a student who reported an adult and then deleted their own account had their report destroyed three years later |
| **Missing** | Nothing |
| **Verdict** | **ENFORCED**, including all three exceptions |

**Note.** The organizer-side exemption is derived from the schema relationship (events →
attendance/certificates) rather than from the purged account's own rows. That is the
correct construction: the attendance subject is always the volunteer, never the organizer,
so an exemption checking only the purged account's own attendance would never protect an
organizer whose events produced other students' records.

---

### P-04 · Applications

> *"3 years after the event."* *Long enough to resolve a dispute about a placement.*

| | |
|---|---|
| **Tables** | `applications` |
| **Enforcement** | `applicationDays = 3 × 365`, measured from `MAX(slots.end_datetime)` with `applied_at` as fallback |
| **Missing** | Nothing |
| **Verdict** | **ENFORCED** |

**Note on the timestamp choice**, because it is load-bearing and easy to get wrong on a
future edit: the cutoff must be the **event's end**, not the application's creation. A
student applying to an event two years out would otherwise have their application deleted
before the event happened, taking the organizer's roster with it. Event *status* was
rejected as the anchor because an abandoned event never completes, which would retain its
applications for ever — the least privacy-preserving option available.

---

### P-05 · Messages

> **"3 years — longer if the conversation has been reported."** *A reported conversation is
> never deleted on schedule, because that would destroy the evidence an investigation
> needs.*

| | |
|---|---|
| **Tables** | `messages` |
| **Enforcement** | `messageDays = 3 × 365`, with an exemption for messages in a live reported thread |
| **Exemption scope** | The **whole live thread**, not only the captured identifiers. The capture is bounded, so an exemption naming only snapshotted identifiers would sweep message eleven of a reported conversation while the report was open |
| **Missing** | Nothing |
| **Verdict** | **ENFORCED** |

---

### P-06 · Safety reports and the messages saved with them

> **"Kept indefinitely."** *It is kept even if you delete your account, and it cannot be
> edited or deleted by anyone — including us.*

| | |
|---|---|
| **Tables** | `reports`, `report_evidence`, `moderation_actions`, `conversation_reports`, `conversation_report_messages` |
| **Enforcement** | All five in `PRESERVED_TABLES` with in-transaction count assertions. **Additionally enforced at the storage layer**: eight triggers refuse `UPDATE` and `DELETE` on these tables by any path, including an operational script or a database console |
| **Missing** | Nothing |
| **Verdict** | **ENFORCED — and this is the strongest enforcement on the platform.** The published claim "it cannot be edited or deleted by anyone — including us" is one of very few product claims backed by a database constraint rather than by code discipline |

---

### P-07 · Comments

> *"Until the event is deleted — and an event named in an open safety report cannot be
> deleted until that report is closed."*

| | |
|---|---|
| **Tables** | `event_comments` |
| **Enforcement** | **Not age-based, deliberately.** Comments are removed by cascade when their event is deleted. Event deletion is refused while a report names the event, its comments or its conversations |
| **Missing** | Nothing |
| **Verdict** | **ENFORCED — and a sweep would be a policy violation, not an improvement** |

**This row is the specific correction to C-01.** C-01 flagged `event_comments` as having
no sweep and treated that as an unmet promise. The published promise is
event-lifetime-scoped. Adding an age-based sweep would delete comments the policy says are
kept until the event is deleted.

---

### P-08 · Error diagnostics

> *"The detailed record of one error: **30 days**. The summary of a problem we have already
> dealt with: **30 days**. The summary of a problem nobody has dealt with yet: **180
> days**."*

| | |
|---|---|
| **Tables** | `error_events`, `error_groups` |
| **Enforcement** | `EVENT_RETENTION_DAYS = 30`, `CLOSED_GROUP_RETENTION_DAYS = 30`, `OPEN_GROUP_RETENTION_DAYS = 180` — a three-tier sweep matching the three published tiers exactly |
| **Additional, unpublished tier** | `SINGLE_CLIENT_GROUP_RETENTION_DAYS = 7` removes single-occurrence client-created groups sooner |
| **Missing** | Nothing |
| **Verdict** | **ENFORCED**, and the extra tier is **stricter than promised**, which is not a violation |

**Note.** Keeping data *less* time than published is compatible with the promise, which is
a ceiling rather than a guarantee of availability. It should nonetheless be documented so a
future reader does not treat the 7-day tier as a bug (§5, I-03).

---

### P-09 · Administrator audit logs

> **"1 year."** *So misuse of an administrator account can be traced later.*

| | |
|---|---|
| **Tables** | `admin_audit_logs` |
| **Enforcement** | `auditDays = 365` |
| **Missing** | Nothing |
| **Verdict** | **ENFORCED** |

**Interaction with the Audit Log Explorer.** The Explorer must display this horizon. An
absence of old entries is otherwise indistinguishable from an absence of old activity, and
a reader investigating a two-year-old question would conclude nothing happened.

**Interaction with subject-scoped trails.** `moderation_actions` and `appeal_events` are
**exempt** from this sweep and are retained permanently under P-06. That asymmetry is
deliberate — a suspension is appealable years after the operational row is gone — and it is
the reason case-relevant acts are written to both trails.

---

### P-10 · Data export archives

> **"7 days, then deleted automatically."** *Already enforced in code.*

| | |
|---|---|
| **Tables** | `data_export_jobs`, plus files on disk |
| **Enforcement** | `cleanupExpiredExports` selects completed jobs past `expires_at`, unlinks the file, marks the job `expired` and **clears the recorded path**. Expiry is set to 7 days at creation |
| **Missing** | The **job row** is retained after expiry, holding no archive but recording that an export occurred |
| **Verdict** | **ENFORCED.** The promise concerns *archives* — the files — and those are deleted |

**Second correction to C-01**, which listed `data_export_jobs` as unswept. It is swept, by
the export worker rather than the retention worker.

**One judgement recorded:** retaining the job row after the archive is deleted is
defensible and arguably desirable — it is the record that an export was taken, which
pairs with the audit entry. It is **not** covered by the published promise either way. §5
I-04 proposes stating it.

---

## 3. Verdict table

| # | Promise | Enforced | Mechanism |
|---|---|:---:|---|
| P-01 | Hours and attendance — indefinite | ✅ | Preserved-table assertion, in-transaction |
| P-02 | Certificates — indefinite | ✅ | Preserved-table assertion + purge exemption |
| P-03 | Account shell — 3 years, 3 exceptions | ✅ | `deletedAccountDays` + all three exemptions |
| P-04 | Applications — 3 years after the event | ✅ | `applicationDays`, anchored to event end |
| P-05 | Messages — 3 years, longer if reported | ✅ | `messageDays` + whole-thread exemption |
| P-06 | Reports and saved messages — indefinite | ✅ | Preserved tables **+ 8 storage triggers** |
| P-07 | Comments — until the event is deleted | ✅ | Cascade + deletion hold. No sweep, correctly |
| P-08 | Diagnostics — 30 / 30 / 180 days | ✅ | Three-tier sweep, plus a stricter fourth tier |
| P-09 | Audit logs — 1 year | ✅ | `auditDays` |
| P-10 | Export archives — 7 days | ✅ | Export worker expiry + unlink |

**10 of 10 enforced. No published promise is unmet. LR-20 passes.**

---

## 4. Tables with no published promise

These have no promise, therefore no obligation. Listed so their absence from §2 is visible
as a finding rather than an oversight.

| Table | Swept? | Assessment |
|---|---|---|
| `event_announcements` | No | No promise. Bounded by event lifetime via cascade, like comments |
| `application_conflicts` | No | No promise. Child of `applications`; should follow it |
| `auto_select_runs` | No | No promise. Operational record of a selection run |
| `user_favorites` | No | No promise. Account-lifetime |
| `notification_preferences` | No | No promise. Account-lifetime |
| `notifications` | Partially | A sweep exists in `utils.js`. No published period |
| `oauth_states`, `oauth_signup_sessions` | Yes | Short-lived by construction |
| `password_reset_tokens`, `email_verification_tokens`, `email_change_tokens` | Yes | Token sweeps |
| `revoked_sessions` | Yes | Purged once the token could no longer be valid |
| `reauth_challenges` | Yes | Step-up challenge sweep |
| `instance_lock` | N/A | Single row, operational |
| `schema_migrations` | No | Permanent by design |

**No action required for any of these.** Two are worth a decision (§5, I-02).

---

## 5. Improvements — none required, all optional

No improvement below closes a policy gap, because there is no policy gap. Each strengthens
enforcement or removes an ambiguity.

| # | Improvement | Rationale | Priority |
|---|---|---|---|
| **I-01** | Add `attendance_checkin` to `PRESERVED_TABLES` | P-01 covers attendance records. `attendance_checkin` is currently protected only by nothing deleting it. Adding it converts an absence into an assertion, and costs one array entry | **Medium** |
| **I-02** | Decide `application_conflicts` and `auto_select_runs` | Both are children of data swept at 3 years, and neither is swept. Not a promise gap, but an accumulation. Recommend: sweep `application_conflicts` with its parent; retain `auto_select_runs` as an operational record | Low |
| **I-03** | Document the 7-day single-client diagnostic tier | Stricter than published, which is fine, but undocumented stricter behaviour reads as a bug to the next reader | Low |
| **I-04** | State in the deletion policy that the export *job record* outlives its archive | The promise covers archives. The record is a separate fact and stating it is more honest than leaving it inferable | Low |
| **I-05** | Add a test per promise, asserting the enforced period equals the published one | The strongest available improvement. Today the agreement between policy and code is verified by this document, once. A test verifies it every run | **High** |

### I-05 in detail — the one worth doing

**What.** For each of P-01 to P-10, a test asserting that the constant the code uses equals
the period the policy publishes.

**Why it is the highest-value item here.** Every finding in this document is a
point-in-time observation. Nothing prevents a future change from altering `messageDays` to
`2 × 365` without touching the policy, and nothing would fail. The policy text and the
constants are two copies of one rule (P-8), and they are currently tied together by
nothing.

**How, without brittleness.** Do not parse prose. Publish the periods as a structured
constant that the policy document is generated from or checked against, and assert the
retention constants match it. Where parsing the published table is unavoidable, anchor on
the table rows rather than free text, and assert the parse found ten rows so a parser that
silently matches nothing fails.

**Scope note.** This is a genuine piece of work, not a one-line assertion, and it is **not**
part of M1. Recommend it as its own small task after M1.

---

## 6. Documentation corrections required

| # | Correction | Target |
|---|---|---|
| **D-01** | **Withdraw C-01's claim that LR-20 cannot pass.** Restate it as a documentation imprecision, severity low | `SPEC_VALIDATION_2026-08-06.md` |
| D-02 | Amend the graph: R-05 is no longer a launch blocker, and A-02 (retention remedy) is no longer an architectural decision — there is nothing to decide | `IMPLEMENTATION_GRAPH.md` |
| D-03 | Split Appendix C's retention column into **published promise** and **enforcement mechanism**, and mark tables with neither as "no promise" rather than assigning them an invented class | `appendix-database-schema.md` |
| D-04 | Record in Volume V that LR-20 is satisfied, citing this document | `05-deployment-launch.md` |

**D-01 and D-02 must be applied before the implementation graph is used for sequencing**,
because both currently mark work as launch-blocking that is not.

---

## 7. What was not changed

Stated explicitly, per the instruction.

- **No policy wording was edited.** Not one word of any published document.
- **No retention constant was changed.**
- **No sweep was added, removed or rescheduled.**
- **No table's enforcement was altered.**

The only changes this document proposes are to *specification and review documents*, and
they are corrections of my own earlier errors.

---

## 8. Recommendation

**No retention work is required for launch.** All ten published promises are enforced, and
one of them — the safety-report promise — is enforced more strongly than the policy claims,
at the storage layer rather than in code.

**Three actions follow from this audit:**

1. **Apply D-01 and D-02 immediately.** Two planning documents currently claim a launch
   blocker that does not exist, and sequencing decisions are being made from them.
2. **Do I-01** — one array entry, converts an unasserted protection into an asserted one.
3. **Schedule I-05 after M1.** It is the only item that prevents this audit from becoming
   stale the moment somebody edits a constant.

**A note on how the original error happened**, because it is the more useful finding. C-01
compared an appendix to a worker and never read the policy. The appendix was the wrong
reference: it is a description of the schema, not a statement of obligations. The
obligations live in the published documents, and any future retention audit must start
there.
