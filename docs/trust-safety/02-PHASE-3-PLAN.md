# Phase 3 — trust & safety implementation plan

**Date:** 2026-08-05 · **Baseline:** `01-BASELINE-AUDIT.md`, verified against the code ·
**Suite:** 163 files, 2642 tests passing

This plan reconciles four sources, which is why it exists rather than a fifth design:

1. `docs/specs/2026-08-05-trust-and-safety-mvp.md` — a 97 KB buildable specification written
   in a previous session and committed in `8b8dd53`. **It is the primary source.** It is more
   detailed and better reasoned than anything produced this session, and where it disagrees
   with a reviewer below, it usually wins.
2. A trust & safety review (abuse scenarios, taxonomy, severity derivation, escalation).
3. A legal risk review (`/legal-risk-assessment`, `/compliance-check`).
4. A design review (`/design-system`, `/design-critique`, `/ux-copy`,
   `/accessibility-review`).

Everything below that says a claim was *verified* means it was run, not read.

---

## 0. Already shipped this session

These were free or nearly free, and each closed a live exposure. Done, tested, committed.

| Item | Commit | Why it went first |
|---|---|---|
| Removed the false "You can report anonymously" from two published documents | `c84ed9b` | `reporter_id` is `NOT NULL` on both report tables and the admin queue selects the reporter's name *and email*. Pure copy, no code, and the reviewers independently ranked it the highest-value item in the phase |
| Report modal no longer sends a student in danger to "your school" | `c84ed9b` | 911 and 1-877-NJ-ABUSE. WeVolunteer is not a district service; a school cannot see the report and cannot act |
| Suspension notice no longer sends a suspended user to "your school administrator" | `c84ed9b` | Replaced with the appeal address and the five-business-day commitment the Terms already make |
| Moderation queue urgency signal made visible; the guard that missed it widened | `6389a9e` | `tag-error` has no rule — the family is `tag-danger`. Every OPEN badge rendered grey on grey |

---

## 1. The finding that reorders the plan

**A reported organizer can destroy the evidence against themselves, and the delete guard does
not stop them.** This is not in the primary spec. It was found by the trust & safety review
and then confirmed by running it:

```
conversations.event_id          -> events(id)               ON DELETE CASCADE   db.js:508
conversation_reports.conv_id    -> conversations(id)         ON DELETE CASCADE   db.js:570
conversation_report_messages    -> conversation_reports(id)  ON DELETE CASCADE   db.js:582
```

Measured against a real database, `PRAGMA foreign_keys = 1`:

```
attendance rows on event:            0
before  reports/evidence:            1 1
DELETE FROM events WHERE id='ev1'
after   reports/evidence:            0 0
```

`DELETE /api/events/:id` (`eventRoutes.js:778`) refuses only when attendance exists or the
event is `completed`. **Grooming happens before the event runs**, when attendance is zero by
definition — so the window in which the evidence is destructible is exactly the window in
which the harm occurs. The organizer needs no privilege they do not already have: it is their
own event.

The snapshot in `conversation_report_messages` was built specifically to survive message
deletion. It does not survive this.

**Consequence for the plan:** evidence preservation moves ahead of the queue. A queue that
reads reports which the reported party can delete first is not a queue.

---

## 2. Where the reviewers disagreed, and what this plan does

| Question | Primary spec | Reviewer | Decision |
|---|---|---|---|
| Migration numbers | 010 and 011 | — | **011 and 012.** 010 is `graduation_year`, committed in `f6e8a53` after the spec was written |
| Fold `conversation_reports` into `reports`? | Fold the envelope, copy evidence, freeze the legacy tables | Design review preferred a query-layer union, to avoid disturbing the evidence FK | **Fold.** The spec's method never touches the legacy tables — it INSERTs copies and leaves the originals frozen, so the FK it was worried about is not disturbed. A union read-model means two shapes, two filters and two workflows maintained forever for a team of one |
| How many report categories | 18, filtered per target type | T&S review: 9 is the ceiling for a frightened 14-year-old. Design review: 10 in 4 groups | **The spec's list, its grouping, and its per-target filter** — a student reporting a conversation sees a filtered subset, never 18. **Plus the T&S review's actor-asymmetry floor** (next row), which is what makes a longer list safe |
| Severity model | Two levels, `urgent`/`normal`, derived from category | T&S review: four levels with four modifiers | **Two levels** — the spec's argument holds: a five-level scale on a two-person team is a field nobody fills in consistently. **But adopt one modifier**: a student reporting an adult floors at `urgent` regardless of category. It costs one join and it means a student who freezes at the dropdown still gets a same-day response |
| Queue sort | `status, priority, created_at DESC` | Both reviews: oldest-first within band | **Oldest-first within band.** Newest-first buries the oldest unhandled report, which is by construction the one most likely to be a real harm nobody answered. One word, and it prevents the characteristic failure of a once-a-day queue |
| Appeals | In-app, token-based | T&S review: do not build it; email already works and reaches a suspended user | **Build the intake.** The Terms and Community Guidelines both already promise a five-business-day answer, so this is a contractual commitment with no record, no reviewer field and no timer — the gap is the risk. Keep email as the parallel channel, which the shipped copy fix now names |

---

## 3. Build sequence

Ordered by harm prevented per unit of work. Each step leaves `main` shippable.

### PR-1 — Stop the evidence being destroyable ⚠️ not started

The §1 finding. Independent of the schema work and should not wait for it.

- Refuse `DELETE /api/events/:id` when any conversation under it is named by a live report —
  same shape as the existing `attendance_exists` 409 at `eventRoutes.js:794`
- Refuse `DELETE /api/comments/:id` for a reported comment
- Exempt held rows from `retentionWorker.sweep`, and assert it the way
  `assertPreservedTablesUntouched` already asserts the preserved tables
- Add "is party to a live report" to the shell-purge exclusion — a purged shell cascades
  conversations and reports away (`retentionWorker.js:148`)
- **Tests:** the exact scenario in §1, failing first

### PR-2 — Migration 011, the `reports` rebuild ⚠️ not started

Spec §2, renumbered. `ownTransaction: true`, all six ENGINEERING_GUIDE §8.3 guards, modelled
on `001_authz_roles.js`. Widens `target_type` and `status`, adds category, priority,
assignment, resolution, timestamps and the reporter/role snapshots.

Must run while `reports` is childless — PR-3 gives it children.

### PR-3 — Migration 012, history and evidence ⚠️ not started

Spec §3. `moderation_actions` (append-only, enforced by SQLite triggers, not convention),
`report_evidence` (`ON DELETE RESTRICT`, no FK on `message_id`), and the INSERT-only backfill
that folds `conversation_reports` in.

**This is the step that closes G-1** — the write-only table becomes readable.

### PR-4 — `server/moderation.js` and the report routes ⚠️ not started

Categories exported once and imported by the client so they cannot drift. Priority derived
server-side, never accepted from the client, with the actor-asymmetry floor. Submission
gated, rate-limited, deduplicated by the partial unique index.

### PR-5 — The moderation queue ⚠️ not started

Read, assign, note, resolve, dismiss, escalate. Every mutation writes **both**
`moderation_actions` and `admin_audit_logs`. Resolution note mandatory — it is what an appeal
is reviewed against, and the suspension route already sets that precedent.

Design review's constraints: no destructive action in a list row; reporter identity and
disclosure text in the detail view only, never in a scannable list; no bulk resolve; no
full-text search over minors' disclosures.

### PR-6 — Appeals ⚠️ not started

Intake, review, decision, record. The access problem is real and is solved by a token, not a
session: a suspended user cannot sign in (`authRoutes.js:452`) and `authenticateToken` refuses
them (`utils.js:186`).

**`appeals.suspension_id` cannot exist as specified.** Suspension is not a table — migration
006 added three columns to `users`. The appeal snapshots `suspended_at` and
`suspension_reason` instead, which is strictly better: an administrator can lift and re-apply
a suspension with a different reason and the appeal still records what was actually appealed.
A foreign key would have silently re-pointed.

### PR-7 — Client surfaces ⚠️ not started

One report modal, not two. Design review's full spec: category groups as `.check` rows,
safety interstitial with the real crisis numbers, two-tier confidentiality disclosure, a
persistent confirmation state rather than a toast.

### PR-8 — Documents, last ⚠️ not started

Only after the code exists. The legal review produced a per-document delta list marked
**[SAFE NOW]** versus **[WRITE ONLY AFTER CODE]**; the `[SAFE NOW]` copy items shipped in
`c84ed9b`. Everything else waits, because writing a promise ahead of the code is the specific
defect this project has now had three times.

---

## 4. Open items this plan does not resolve

- **Moderation-record retention.** `admin_audit_logs` is swept at 365 days. New Jersey tolls
  limitations for minors, so a 13-year-old's claim can survive to roughly age 20. A safety
  record that expires in twelve months is self-harm — it is as much the operator's defence as
  anyone's case. Needs its own retention class, and the published retention table cannot be
  updated until the migration enforces it.
- **No litigation hold.** The retention worker sweeps unconditionally. There is no way to
  freeze anything after a preservation request.
- **18 U.S.C. §2258A / NCMEC appears nowhere** in `docs/legal/` or `server/` — zero matches.
  A moderator read route is precisely what creates the actual knowledge that triggers the
  duty. Procedure, not code, and cheap to write.
- **An admin can see and dismiss a report naming themselves.** `report.resolve` is held by
  every admin. Reports naming an admin should route to `super_admin` only; reports naming the
  operator have nowhere on the platform to go, by arithmetic, and the honest answer is the
  off-platform hotline.
- **Suspension has no duration**, though the Community Guidelines publish "for a stated
  period".
- **The `USER_BLOCKED` signal is recorded and never read.** Counting distinct students who
  have blocked one adult is the cheapest grooming detector available, and the data already
  exists.
