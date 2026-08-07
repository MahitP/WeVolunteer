# Audit Log Viewer — Design Review

**Date:** 2026-08-06
**Designs:** `/admin/audit` and its supporting endpoints
**Implements:** Volume IV §4.4, Volume VI P-01
**Status:** Design. Nothing implemented.

---

## 1. The gap

`admin_audit_logs` is written on every administrative action and is **readable by
nothing**. `audit.read` exists, is held by administrators and owners, and gates exactly
one endpoint — a system status route unrelated to the trail.

The consequence is not a missing feature. The published administrative responsibilities
policy commits to accountability that rests entirely on this record. Today, "who read my
child's private messages, and when" requires opening the database by hand.

This is the same defect the report history had before it was exposed, and it is the more
consequential of the two: the report history covers one case, this covers the platform.

---

## 2. Measured starting state

| # | Fact | Design consequence |
|---|---|---|
| AU-1 | Columns are `id, admin_id, action, target_user_id, details, created_at` | Every filter must map to one of six columns. There is no category column, no severity, no IP, no session reference |
| AU-2 | **Zero explicit indexes.** Only the primary-key autoindex | **Every filter proposed below is currently a full table scan.** Indexes are not an optimisation here; they are a precondition |
| AU-3 | Retention is **365 days**, enforced | The viewer must state the horizon, or absence of old entries reads as absence of old activity |
| AU-4 | `target_user_id` is a foreign key to accounts | Invitation events have no valid subject (see Super Admin review §4.6). The viewer must render a null subject legibly |
| AU-5 | `details` is free text | Filtering on it can only be a substring match, and it is the only place structured facts currently live |
| AU-6 | Two rows exist in development | No performance signal from real data. Budgets must be derived from projected volume, not measured |

**AU-2 is the single most important constraint.** On a single-process embedded database,
a full scan under a lock is an availability incident, not a slow page.

---

## 3. Access control

### 3.1 Who can view

| Principal | Access | Reason |
|---|---|---|
| **Owner** | Everything | Wildcard; also the party accountable for the platform |
| **Administrator** | Everything, subject to §3.3 | Holds `audit.read` by role |
| **Grant holder** | Everything | `audit.read` is grantable — see §3.2 |
| Organizer, student, partner | **None** | Do not hold the capability |
| Unauthenticated | **None** | |

### 3.2 Should `audit.read` remain grantable?

**Decision: yes, but with a stated constraint.**

The capability is currently grantable. The triage-only-helper pattern that justifies
grantability for `report.resolve` does **not** obviously apply here: a helper who sorts
the queue has no evident need to read platform-wide administrative history.

**Constraint added:** `audit.read` MUST NOT be granted to a principal that does not also
hold `report.resolve` or `event.moderate`. A principal with audit access and no moderation
authority can observe every administrative action without being accountable for any.

**Enforcement:** the grant path refuses the combination, and the administrator roster
displays it if it somehow exists.

### 3.3 Can administrators view other administrators' actions?

**Decision: yes. No self-filtering, no peer-blindness.**

This is the load-bearing access decision and the alternatives were considered seriously.

| Option | Rejected because |
|---|---|
| An administrator sees only their own actions | Destroys the trail's purpose. Administrator misuse is detected by *peers* noticing, and a self-only view means only the owner can ever detect anything — on a platform whose owner is one person |
| An administrator sees peers' actions but not the owner's | Creates a class of unobservable action, which is precisely what the wildcard already makes dangerous. The owner's actions are the ones most in need of visibility |
| An administrator sees everything | **Chosen** |

**RATIONALE.** The trail's function is mutual accountability. A trail visible only to the
person most likely to be the subject of concern is not an accountability mechanism.

**Accepted cost.** An administrator can observe a colleague's activity, which could be
used for social engineering or to identify a target. That risk is real and is smaller
than the risk of unobservable administrative action. Recorded as residual.

**Consequence for the roster.** The evidence-read count on the administrator roster
(Volume IV §4.2.5) is the countervailing control: it makes *unusual* reading visible
without requiring anyone to trawl the trail.

### 3.4 Can owners see everything?

Yes, by wildcard. No additional mechanism.

### 3.5 What the viewer must not become

| # | Prohibition | Reason |
|---|---|---|
| N-1 | It MUST NOT display message bodies, case notes, appellant statements or credentials | The trail does not contain them by construction. If the viewer ever shows one, the trail has been contaminated |
| N-2 | It MUST NOT be reachable by a principal without moderation authority | §3.2 |
| N-3 | It MUST NOT log its own reads | §5.4 |
| N-4 | Its export MUST NOT return more than its display | An export path with wider content is a bypass of every display constraint |

---

## 4. Endpoints

### 4.1 `GET /api/admin/audit`

**Gate:** `audit.read`

| Parameter | Type | Validation |
|---|---|---|
| `actor` | account id | Must exist, or `me` |
| `subject` | account id | Must exist |
| `action` | enum | Closed set from the registry; refused with legal values |
| `category` | enum | Closed set; see §4.4 |
| `from`, `to` | ISO date | Parsed; `from ≤ to`; range bounded to the retention horizon |
| `q` | string | Substring over `details` only; length-bounded |
| `limit`, `cursor` | pagination | Bounded; see §4.3 |

**Response:** entries, a whole-filtered-set count, the retention horizon, and the applied
filter echoed back.

**Requirements**

| # | Requirement |
|---|---|
| E-1 | Unbounded responses MUST NOT be constructible |
| E-2 | Every enumerated filter validated against a closed set, refused with the legal values |
| E-3 | Actor and subject joins MUST be **outer**, with fallback naming for departed accounts |
| E-4 | Action identifiers translated to labels; an unrecognised identifier renders legibly rather than vanishing |
| E-5 | A null subject renders as "no subject" with an explanation, not as blank (AU-4) |
| E-6 | Counts computed over the whole filtered set, not the page |
| E-7 | The retention horizon returned on every response |

### 4.2 `GET /api/admin/audit/export`

**Gate:** `audit.read` **plus step-up re-authentication**

| # | Requirement |
|---|---|
| X-1 | Registered as a sensitive action; gated **and** spent inside the handler's transaction |
| X-2 | Carries the same content constraints as display (N-4) |
| X-3 | Bounded: an export of the full retention window must be streamable, not materialised |
| X-4 | The export **is** audited — unlike viewing (§5.4) — because it is a bulk disclosure |
| X-5 | The filename and content state the filter applied and the generation time |

**RATIONALE for X-1.** An export is a bulk disclosure of who did what to whom across the
platform. It is a larger disclosure than any single evidence read, and evidence reads are
gated and logged.

### 4.3 Pagination

**Decision: cursor-based over `(created_at, id)`, not offset.**

| Option | Rejected because |
|---|---|
| Offset | Degrades linearly and produces duplicates or gaps when rows are inserted during paging — and this table is written continuously |
| Cursor over `created_at` alone | Not unique. Two records written in the same transaction share a timestamp |
| **Cursor over `(created_at, id)`** | **Chosen.** Stable, unique, and index-supportable |

**Requirement.** An invalid cursor MUST be refused, not silently reset to the first page.

---

## 5. Filtering

### 5.1 The filter set and its indexes

**Every filter listed here requires an index that does not currently exist (AU-2).**

| Filter | Index required | Note |
|---|---|---|
| Date range (default view) | `(created_at DESC, id)` | Also serves default ordering and the cursor |
| Actor | `(admin_id, created_at DESC, id)` | The most common investigative query: "what has this person done" |
| Subject | `(target_user_id, created_at DESC, id)` | "What has been done to this person" |
| Action | `(action, created_at DESC, id)` | "Every evidence read" |
| Category | Served by the action index | §4.4 |
| Free text over `details` | **None** | §5.3 |

**Requirement.** A filter without an index MUST NOT be offered. This is not a performance
preference: a full scan under a write lock on a single-process embedded database is an
availability incident.

### 5.2 Combined filters

The four indexed filters compose. The query planner will select one index and filter the
remainder in memory, which is acceptable **provided** the leading filter is selective.

**Requirement.** Where a request combines filters, the handler MUST order the predicate so
the most selective indexed column leads. Actor and subject are more selective than action;
action is more selective than a date range.

### 5.3 Free-text search — constrained

**Decision: offered, but only as a substring over `details`, and only in combination with
at least one indexed filter.**

**RATIONALE.** An unanchored substring search over an unindexed text column across a
year's records is the worst query the viewer could issue. Requiring an indexed filter
alongside bounds the scan to that filter's result set.

**Requirement.** A free-text query with no other filter MUST be refused with an
explanation naming what to add — not silently expanded to the full range.

### 5.4 Is viewing itself audited?

**Decision: no.**

| Consideration | Resolution |
|---|---|
| Volume II §2.9.6 permits read logging only where a read discloses content the reader would not otherwise see | An `audit.read` holder may already read every entry. Viewing discloses nothing new |
| Logging every view would flood the trail | And flooding a trail destroys it while appearing to strengthen it |
| But then administrators can browse unobserved | **Accepted.** The countervailing control is that the trail contains no content — no bodies, no notes, no credentials. Browsing it reveals *who did what*, which every administrator is entitled to know (§3.3) |
| The export **is** audited | Because it removes data from the platform, which is a different act |

---

## 6. Action categories

The trail has no category column (AU-1). Categories are **derived** from the action
identifier at read time, from a mapping held with the action registry.

| Category | Actions | Why grouped |
|---|---|---|
| **Enforcement** | Suspend, unsuspend, warn, appeal token issued | Acts against a person's access |
| **Moderation** | Report decisions, self-reviews | Case work |
| **Disclosure** | Evidence viewed, data export requested/downloaded, audit export | **Reads that removed or revealed private content.** The category a parent asks about |
| **Authorization** | Promote, revoke, grant, withhold, invite, accept, bootstrap, retire | Changes to who can do what |
| **Account** | Deletion, username dedupe, agreement acceptance | Lifecycle |
| **Access** | Blocks, unblocks | Peer-level |
| **System** | Diagnostic triage | No human subject |

**Requirement.** The mapping MUST be derived from a single registry shared with Appendix
D, so a new action cannot be added without a category. An uncategorised action MUST render
under an explicit "uncategorised" heading rather than being hidden by a category filter.

**RATIONALE for the Disclosure category existing at all.** It is the answer to the
question the trail exists for. Grouping evidence reads with data exports and audit exports
makes "every time private information left the platform" one filter rather than three.

---

## 7. Screen design

### 7.1 Layout

| Region | Contents |
|---|---|
| Header | Title; the retention horizon stated as a sentence, not a footnote |
| Filter bar | Actor, subject, action, category, date range, text. Applied filters shown as removable chips |
| Summary | Whole-filtered-set count; the range actually covered |
| Table | Time, actor, action, subject, detail |
| Footer | Cursor pagination; export control |

### 7.2 Row rendering

| Column | Requirement |
|---|---|
| Time | Absolute, with time of day and zone. **Not relative-only** — "3 months ago" is unusable for correlating with an external record |
| Actor | Name, linked to the roster. Departed accounts render from a fallback |
| Action | Human label from the registry, with the category as a secondary marker |
| Subject | Name, linked. **Null renders as an explicit statement**, never blank |
| Detail | Structural text as stored, wrapped, not truncated to invisibility |

### 7.3 Empty states

| State | Copy requirement |
|---|---|
| No entries at all | State that the trail is empty and that it is written on administrative actions — so an empty trail on a new platform is not read as a defect |
| No entries for this filter | **Name the filter that produced it**, so the reader is not stranded |
| Entries exist but are older than the horizon | State the horizon explicitly. This is AU-3 and is the case most likely to mislead |

### 7.4 What the screen must not imply

| # | Requirement |
|---|---|
| S-1 | The evidence-read count on the roster is a **signal**, not an accusation. The audit view MUST use the same neutral framing: reading evidence is a legitimate, logged act |
| S-2 | The screen MUST NOT present a "suspicious activity" heuristic. A false positive here accuses a colleague |
| S-3 | The screen MUST NOT offer deletion, editing or annotation of entries |

---

## 8. Performance

Budgets are **targets, not measurements** — there is no production volume to measure
against (AU-6).

| Operation | Target | Depends on |
|---|---|---|
| Filtered page, 50 entries | ≤ 200 ms | §5.1 indexes existing |
| Whole-filtered-set count | ≤ 300 ms | Same |
| Export, 10,000 entries | ≤ 5 s, streamed | Not materialised |

**Projected volume.** At an estimated few hundred administrative actions per month, the
365-day table holds low thousands of rows. Every index in §5.1 is small. The risk is not
volume; it is a full scan taken under a write lock, which AU-2 currently guarantees for
every query.

**Requirement.** Each index MUST be verified by query plan, per filter, as an acceptance
criterion — not assumed from the index's existence.

---

## 9. Privacy review

| # | Requirement | Basis |
|---|---|---|
| P-1 | Displays no message body, case note, appellant statement or credential | The trail does not contain them; N-1 makes it a viewer constraint too |
| P-2 | Free-text search operates over `details` only, never over joined account fields | Prevents the viewer becoming a user-search surface |
| P-3 | Export carries display constraints exactly | N-4 |
| P-4 | Not reachable without moderation authority | §3.2 |
| P-5 | Subject names are shown to a principal who can already see them elsewhere | No new disclosure |
| P-6 | The trail is swept at 365 days and the viewer says so | Prevents a false impression of completeness |

**One open privacy question.** The trail records `admin_id` and `target_user_id` but no
IP address or session reference. Adding either would improve investigation and would be a
new personal-data field with its own retention obligation. **Recommendation: do not add
them.** The investigative benefit is speculative; the obligation is certain.

---

## 10. Accessibility

| # | Requirement |
|---|---|
| A-1 | Table uses proper header semantics with a caption stating what is listed and the active filter |
| A-2 | Filter controls individually labelled; the applied-filter state announced on change |
| A-3 | Pagination announces position and whether more remain |
| A-4 | Timestamps are readable text |
| A-5 | Numeric and time columns use tabular figures so columns align |
| A-6 | The category marker is text, not colour alone |
| A-7 | Empty states are announced, not merely rendered |
| A-8 | The export control states that it requires re-verification **before** it is pressed |

---

## 11. Testing

| # | Test |
|---|---|
| T-01 | Refused for student, organizer, partner, unauthenticated |
| T-02 | Permitted for administrator, owner, and an `audit.read` grant holder |
| T-03 | Refused for a grant holder lacking moderation authority (§3.2) |
| T-04 | Every filter validated; each invalid value refused with its legal set |
| T-05 | Free text with no other filter refused with an explanation |
| T-06 | Unbounded response not constructible |
| T-07 | Invalid cursor refused, not silently reset |
| T-08 | Departed actor and subject render from fallbacks; entries not lost |
| T-09 | Null subject renders explicitly |
| T-10 | Unrecognised action identifier renders legibly |
| T-11 | Counts are whole-filtered-set |
| T-12 | Retention horizon present on every response |
| T-13 | Every offered filter uses its index — **asserted by query plan**, per filter |
| T-14 | Export requires step-up; grant spent; replay refused |
| T-15 | Export content matches display content exactly |
| T-16 | Viewing writes no audit record |
| T-17 | Export writes an audit record |
| T-18 | No response contains a message body, case note or credential |

---

## 12. Rollout and rollback

**Rollout:** single merge. Indexes apply at boot.

**Rollback:** revert. The indexes remain and are harmless — the revert note MUST say so,
because an operator seeing indexes for a removed feature will otherwise wonder whether the
revert was complete.

**No data is written by this feature except audit records for exports.** That is the
property that makes it the safest available first milestone.

---

## 13. Open questions

| # | Question | Recommendation |
|---|---|---|
| Q-1 | Should `audit.read` be restricted to owners rather than administrators? | **No.** §3.3: a trail visible only to the person most likely to be its subject is not an accountability mechanism |
| Q-2 | Should the viewer surface subject-scoped histories (report and appeal trails) in the same screen? | **Not initially.** They have different retention, different immutability and different audiences. Link to them from an entry instead |
| Q-3 | Should the export be restricted to owners? | **No**, but it must be step-up gated and audited. Restricting it would make an administrator unable to produce the record of their own actions when asked to |
| Q-4 | Should there be a saved-filter or alerting feature? | **Deferred.** An alert on an audit pattern is a heuristic, and S-2 rejects heuristics that read as accusations |
| Q-5 | Should the trail gain an IP or session column? | **No.** §9 |

---

## 14. Recommendation

**Approve as designed.** The viewer is the highest-value unblocked item, it writes almost
nothing, and its correctness is observable in one step.

**Two conditions.**

1. **Indexes are a precondition, not an optimisation.** AU-2 means every filter is
   currently a full scan, and T-13 must assert the plan per filter rather than trusting
   the index's existence.
2. **The §3.2 constraint on granting `audit.read`** must ship with the viewer, not after.
   Otherwise the first grant of the capability creates a principal who can observe every
   administrative action without being accountable for any.
