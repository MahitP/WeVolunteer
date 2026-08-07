# Audit Log Explorer — Implementation Plan

**Date:** 2026-08-06
**Task:** M1 Task 3
**Status:** Plan. **No code written.** Requires approval before implementation.
**Supersedes on one point:** `AUDIT_VIEWER_DESIGN.md` §3.3 — see §1.

---

## 1. A decision reversal, recorded

The instruction specifies the frontend is **Super Admin only**.

`AUDIT_VIEWER_DESIGN.md` §3.3 recommended **administrator and owner** access, reasoning
that a trail visible only to the person most likely to be its subject is not an
accountability mechanism, and that peer visibility is how administrator misuse gets
noticed.

**The instruction wins. It is the owner's call and it is defensible**: with one
administrator on the platform today, "peer visibility" is currently hypothetical, while
concentrating the trail reduces the number of principals who can enumerate colleagues'
activity. Restricting now and widening later is reversible; the reverse is not.

**Two consequences must be handled rather than absorbed silently.**

### 1.1 This is a capability change, not a screen change

`audit.read` is currently held by **`admin`**. Hiding the screen while administrators
retain the capability would leave the API reachable — a client-side restriction is not a
boundary.

**Required: move `audit.read` into the super-only set.**

| Effect | Consequence |
|---|---|
| Administrators lose `audit.read` | They currently cannot use it for anything — it gates one unrelated status endpoint — so nothing they do today breaks |
| The capability becomes **ungrantable** | Super-only capabilities are refused before grants are consulted. The triage-helper concern in the design's §3.2 disappears entirely |
| `/api/admin/system/status` loses its administrator access | **This is a real regression** and must be handled — see §1.2 |

### 1.2 The status endpoint must be re-gated

`/api/admin/system/status` is currently gated on `audit.read`. If that capability becomes
super-only, administrators lose the system-status screen, which has nothing to do with the
audit trail.

**Required: re-gate it on `analytics.school`**, which administrators hold and which
matches what the endpoint actually returns — platform health counters, mail status, queue
health.

**This must ship in the same change as the capability move.** Splitting them leaves a
window in which administrators cannot see system status.

### 1.3 Recorded for a future revisit

If a second administrator is ever added, §3.3 of the design document should be re-read.
The argument for peer visibility strengthens with every administrator, and the decision
made here is the right one for a population of one.

---

## 2. Scope

| In | Out |
|---|---|
| Query API with filtering and pagination | Saved filters, alerting, heuristics |
| Indexes and their migration | Any schema change to `admin_audit_logs` itself |
| Super Admin-only timeline UI | Administrator access (§1) |
| Export with step-up | Scheduled or automated export |
| Authorization, pagination, filtering and performance tests | Subject-scoped trail integration (§9, deferred) |

---

## 3. Database

### 3.1 Measured starting state

| Fact | Consequence |
|---|---|
| Columns: `id, admin_id, action, target_user_id, details, created_at` | Every filter maps to one of six columns |
| **Zero explicit indexes** — only the primary-key autoindex | **Every filter is currently a full table scan** |
| 365-day retention | Table stays small; the risk is the scan, not the volume |

**On a single-process embedded database, a full scan taken under a write lock is an
availability incident, not a slow page.** Indexes are a precondition here, not an
optimisation.

### 3.2 Indexes — required only

Four. Each maps to exactly one offered filter. No speculative indexes.

| # | Index | Serves |
|---|---|---|
| IX-1 | `(created_at DESC, id)` | Default ordering **and** the pagination cursor |
| IX-2 | `(admin_id, created_at DESC, id)` | Actor filter — "what has this person done" |
| IX-3 | `(target_user_id, created_at DESC, id)` | Subject filter — "what has been done to this person" |
| IX-4 | `(action, created_at DESC, id)` | Action filter, and category filter via action mapping |

**Every index trails `(created_at DESC, id)`** so the cursor remains usable inside a
filtered query. Without it, filtering by actor would fall back to a sort.

**No index for free-text search.** §5.3 constrains that filter instead.

### 3.3 Migration plan

**One migration, additive, no table rebuild.**

| Property | Value |
|---|---|
| Class | Additive — `CREATE INDEX IF NOT EXISTS` × 4 |
| Rebuild guards required | **None.** Nothing is dropped |
| Idempotent | Yes, by `IF NOT EXISTS` |
| Rollback | Drop the four indexes. Data untouched |
| Ordering dependency | None |
| Checksum | Standard registry checksum over the whole file |

**Why the registry rather than the additive bootstrap path:** Volume I §1.6.2 reserves the
bootstrap path for "add a nullable column or an index" — which this is. Either path is
defensible. **Recommendation: the registry**, because it gives the change a version, a
recorded application and a rollback note, and four indexes on the platform's accountability
table is worth that record.

### 3.4 Query performance validation

**Requirement: every offered filter is verified by query plan, per filter, as an
acceptance criterion.** The index existing is not evidence that the query uses it.

| # | Validation |
|---|---|
| QP-1 | For each of the four filters, assert the plan uses the intended index and performs no full scan |
| QP-2 | For the default unfiltered view, assert IX-1 is used |
| QP-3 | For a combined filter, assert the plan uses the most selective available index |
| QP-4 | Seed a fixture with enough rows that a scan would be distinguishable from an index lookup, and assert the plan rather than the timing — **timing is a flaky assertion; the plan is not** |

**Why plan assertions rather than timing budgets:** timing on a test machine under
parallel load is noise. The plan is deterministic.

---

## 4. Backend

### 4.1 `GET /api/admin/audit`

**Gate:** `audit.read` — super-only after §1.1

| Parameter | Validation | Refusal |
|---|---|---|
| `actor` | Existing account id, or `me` | 400 `invalid_actor` |
| `subject` | Existing account id | 400 `invalid_subject` |
| `action` | Closed set from the registry | 400 `invalid_action`, with legal values |
| `category` | Closed set (§6) | 400 `invalid_category`, with legal values |
| `from`, `to` | ISO date; `from ≤ to`; bounded to the retention horizon | 400 `invalid_range` |
| `q` | Substring over `details`; length-bounded; **requires another filter** (§5.3) | 400 `text_search_needs_filter` |
| `limit` | Bounded, default 50, maximum 200 | 400 `invalid_limit` |
| `cursor` | Opaque, validated | 400 `invalid_cursor` |

**Response:** entries, whole-filtered-set count, retention horizon, echoed filter, next
cursor.

| # | Requirement |
|---|---|
| B-1 | Unbounded responses not constructible |
| B-2 | Every enumerated filter validated against a closed set, refused with legal values |
| B-3 | Actor and subject joins **outer**, with fallback naming for departed accounts |
| B-4 | A **null subject renders explicitly** — invitation events will have none (§7) |
| B-5 | Counts over the whole filtered set, not the page |
| B-6 | Retention horizon on every response |
| B-7 | Unrecognised action identifiers returned as-is with a flag, never dropped |

### 4.2 `GET /api/admin/audit/export`

**Gate:** `audit.read` **plus step-up re-authentication**

| # | Requirement |
|---|---|
| X-1 | Registered as a sensitive action; gated **and spent** inside the handler's transaction |
| X-2 | Identical content constraints to display — an export path returning more is a bypass |
| X-3 | Streamed, not materialised |
| X-4 | **Audited** — unlike viewing (§4.3) — because it removes data from the platform |
| X-5 | Filename and content state the filter applied and the generation time |

**New sensitive action:** `audit.export`. Binds no parameters — the filter is not
security-relevant, and binding it would mean a grant obtained for one filter could not be
spent on another, which is friction with no benefit.

### 4.3 Read logging

**Viewing is not audited. Export is.**

| Read | Audited | Reason |
|---|---|---|
| Any filtered page | **No** | The capability holder may already read every entry; viewing discloses nothing new. Logging every view would flood the trail, and flooding a trail destroys it while appearing to strengthen it |
| Export | **Yes** | Removes data from the platform |

### 4.4 Pagination

**Cursor over `(created_at, id)`.**

| Option | Verdict |
|---|---|
| Offset | **Rejected.** Degrades linearly and produces duplicates or gaps when rows are inserted during paging — and this table is written continuously |
| Cursor on `created_at` alone | **Rejected.** Not unique; a single transaction writes several rows sharing a timestamp |
| **Cursor on `(created_at, id)`** | **Chosen.** Stable, unique, index-supported by IX-1 |

**An invalid cursor is refused, never silently reset to the first page.**

---

## 5. Filtering

### 5.1 The offered set

Exactly five: actor, subject, action, category, date range — plus constrained free text.
**Nothing else is offered**, because nothing else is indexed.

### 5.2 Combination

The four indexed filters compose. The handler orders predicates so the most selective
indexed column leads: actor and subject are more selective than action; action is more
selective than a date range.

### 5.3 Free text — deliberately constrained

**Offered only in combination with at least one indexed filter.**

An unanchored substring search over an unindexed text column across a year of records is
the worst query this surface could issue. Requiring an indexed filter bounds the scan to
that filter's result set.

**A free-text query with no other filter is refused with an explanation naming what to
add** — not silently expanded to the full range.

---

## 6. Action categories

The table has no category column. Categories are **derived at read time** from a mapping
held with the action registry.

| Category | Contains |
|---|---|
| **Enforcement** | Suspend, unsuspend, warn, appeal token issued |
| **Moderation** | Report decisions, self-reviews |
| **Disclosure** | Evidence viewed, data export requested/downloaded, audit export |
| **Authorization** | Promote, revoke, grant, withhold, invite, accept, bootstrap, retire |
| **Account** | Deletion, username dedupe, agreement acceptance |
| **Access** | Blocks, unblocks |
| **System** | Diagnostic triage |

| # | Requirement |
|---|---|
| C-1 | The mapping is **derived from one registry shared with Appendix D**, so a new action cannot exist without a category |
| C-2 | An uncategorised action renders under an explicit "uncategorised" heading, never hidden by a category filter |

**Why Disclosure exists as a category.** It is the answer to the question the trail exists
for. Grouping evidence reads with data exports and audit exports makes "every time private
information left the platform" one filter rather than three.

---

## 7. Frontend

### 7.1 Access

**Super Admin only**, enforced server-side by the super-only capability (§1.1). The
navigation entry is hidden for every other principal, and **that hiding is not the
control**.

### 7.2 Timeline presentation

The instruction specifies timeline style. Applied as follows.

| Element | Requirement |
|---|---|
| Ordering | Newest first by default. **The opposite of the report history**, which is oldest-first — a case is read as a narrative, a platform trail is read as a feed |
| Grouping | By day, with a sticky date heading |
| Entry | Time of day · actor · action label · subject · structural detail |
| Density | One entry per row; detail wraps rather than truncating to invisibility |
| Category | A text marker per entry, never colour alone |

**Reuse.** The existing timeline component family used by the report history should be
reused where it fits, and **not** forced where it does not: the report timeline is a short
narrative with a vertical rule; this is a long paginated feed. Reuse the entry rendering;
do not reuse the rail.

### 7.3 Immutability in the interface

| # | Requirement |
|---|---|
| IM-1 | **No edit affordance. No delete affordance. No annotation.** None exists, and no endpoint exists behind one |
| IM-2 | The screen **states** that records cannot be edited or deleted by anyone, including the platform owner |
| IM-3 | No bulk-selection control, because there is no bulk operation |

**IM-2 matters for the same reason the evidence viewer states it:** "can I be accused of
altering this" is a fair question to have answered on the screen rather than in a schema
file.

### 7.4 Required states

| State | Copy requirement |
|---|---|
| Empty trail | State that the trail is written on administrative actions, so an empty trail on a new platform is not read as a defect |
| Empty for this filter | **Name the filter that produced it**, so the reader is not stranded |
| Older than the horizon | State the horizon explicitly. This is the case most likely to mislead |
| Departed actor | Render from the fallback with a marker; never blank |
| Null subject | Explicit "no subject", never blank |

### 7.5 What the screen must not become

| # | Prohibition | Reason |
|---|---|---|
| N-1 | No "suspicious activity" heuristic | A false positive accuses a colleague |
| N-2 | No inline user management | The trail is a record, not a control surface |
| N-3 | No message body, case note, appellant statement or credential | The trail contains none by construction; if one ever renders, the trail has been contaminated |

---

## 8. Tests

### 8.1 Authorization

| # | Test |
|---|---|
| T-01 | Refused for student, organizer, partner, unauthenticated |
| T-02 | **Refused for administrator** — the §1.1 change, asserted directly |
| T-03 | Permitted for owner |
| T-04 | `audit.read` **cannot be granted**, asserted by attempting a grant |
| T-05 | `/api/admin/system/status` still permitted for administrator after re-gating (§1.2) |

**T-02 and T-05 are the pair that proves §1 was done completely.** T-02 alone would pass
for an implementation that broke system status.

### 8.2 Filtering

| # | Test |
|---|---|
| T-06 | Each filter validated; each invalid value refused **with its legal set** |
| T-07 | Free text with no other filter refused with an explanation |
| T-08 | `from > to` refused |
| T-09 | A range beyond the retention horizon is clamped or refused, and says which |
| T-10 | Category filter returns exactly the actions mapped to it |
| T-11 | An unrecognised action identifier is returned, not dropped |

### 8.3 Pagination

| # | Test |
|---|---|
| T-12 | Unbounded response not constructible; `limit` above maximum refused |
| T-13 | Cursor paging returns every entry exactly once across pages |
| T-14 | **Entries inserted during paging do not cause duplicates or gaps** — the offset failure this design avoids |
| T-15 | Invalid cursor refused, not silently reset |
| T-16 | Same-timestamp entries are ordered stably by id across a page boundary |

**T-16 is the one a naive implementation fails.** One transaction writes several rows
sharing a timestamp, and a page boundary falling inside that group is where a
timestamp-only cursor loses or repeats rows.

### 8.4 Performance regression

| # | Test |
|---|---|
| T-17 | **Query plan per filter** asserts the intended index and no full scan |
| T-18 | Default view uses IX-1 |
| T-19 | Combined filter uses the most selective index |
| T-20 | Whole-set count does not scan |
| T-21 | A fixture large enough to distinguish scan from lookup; **plan asserted, not timing** |

### 8.5 Content and integrity

| # | Test |
|---|---|
| T-22 | No response contains a message body, case note, statement or credential |
| T-23 | Export content matches display content exactly |
| T-24 | Export requires step-up; grant single-use; replay refused |
| T-25 | Viewing writes no audit record |
| T-26 | Export writes an audit record |
| T-27 | Departed actor and subject render from fallbacks; entries not lost |

---

## 9. Deliberately deferred

| # | Item | Why |
|---|---|---|
| DF-1 | Surfacing subject-scoped trails in the same screen | Different retention, different immutability, different audience. Link from an entry instead |
| DF-2 | Saved filters | Not needed at this volume |
| DF-3 | Alerting on audit patterns | An alert on a pattern is a heuristic; N-1 rejects heuristics that read as accusations |
| DF-4 | IP or session columns | New personal-data fields with their own retention obligation, for speculative investigative benefit. **Recommend never** |
| DF-5 | Administrator access | §1. Revisit if a second administrator is added |

---

## 10. Rollout and rollback

**Rollout:** one merge. Indexes apply at boot.

**Sequencing within the change:** the capability move (§1.1) and the status re-gate (§1.2)
**must be in the same commit**. Splitting them leaves administrators without system status.

**Rollback:** revert. The four indexes remain and are harmless — **the revert note must say
so**, because an operator seeing indexes for a removed feature will otherwise wonder
whether the revert completed.

**No data is written by this feature except audit records for exports.** That is the
property making it the safest available first feature.

---

## 11. Risks

| # | Risk | Mitigation |
|---|---|---|
| R-1 | Administrators silently lose system status | §1.2; T-05 |
| R-2 | An unindexed filter reaches production | T-17 asserts the plan per filter; a filter without an index is not offered |
| R-3 | Free-text search becomes a full-table scan | §5.3 requires an indexed companion filter; T-07 |
| R-4 | Export returns more than display | X-2; T-23 |
| R-5 | Cursor loses entries at a same-timestamp boundary | `(created_at, id)`; T-16 |
| R-6 | The trail is contaminated by a future writer putting content in `details` | T-22 is a standing assertion, not a one-off check |

---

## 12. Open questions

| # | Question | Recommendation |
|---|---|---|
| Q-1 | Should `audit.read` become super-only, or should the route gate on `admin.create` while the capability stays with admin? | **Super-only.** A capability held but unusable is confusing, and super-only additionally makes it ungrantable |
| Q-2 | Is `analytics.school` the right new gate for system status? | Yes — administrators hold it and it matches what the endpoint returns. Alternative is a new `system.read` capability, which is cleaner but adds a capability for one route |
| Q-3 | Should export be owner-only given the surface already is? | Moot after §1 — the whole surface is owner-only. Keep step-up regardless: it defends against a stolen session, which the capability cannot |
| Q-4 | Day-grouped timeline, or flat table? | Day-grouped, per the instruction. Flat is easier to scan for a specific entry; grouping is better for reading a period. Grouping wins because the primary use is "what happened around this time" |

---

## 13. Recommendation

**Approve, with the §1 consequences handled as one change.**

The plan is deliberately narrow: four indexes, two endpoints, one screen, no schema change
to the table itself, and no data written except an audit record on export.

**The one thing that must not be split** is the capability move and the status re-gate.
Everything else in this plan can be staged; those two cannot, because between them lies a
window where administrators lose a screen that has nothing to do with the audit trail.
