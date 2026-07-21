# Block 2, Step 2 — Complete Mutation Map

**Date:** 2026-07-21
**Status:** ✅ **Implemented.** All 35 mapped paths carry their behaviour change and a test. 57 tests passing.

**§7 resolved:** multi-day completion was pulled into this step, as recommended.
**§4a resolved:** immutability freezes the event definition and lifecycle; attendance corrections remain possible and now require a reason and an actor.

**Added beyond the original map, from decision 5:** a separate `attendance_checkin` table and `POST/GET /api/events/:id/checkin`. Marking people off during an event had nowhere to live once crediting was restricted to ended shifts. Keeping check-in in its own table is what lets `attendance` retain its exact meaning — which is why none of the 24 existing hours queries changed and no volunteer total moved.
**Method:** Mutation sites enumerated mechanically by grepping every `INSERT`/`UPDATE`/`DELETE` against `applications`, `attendance`, `slots`, and `events`, then cross-checked against the route table. Not from memory.

### Governing constraints

1. Existing hours totals must not change.
2. Previously credited hours must never disappear silently.
3. Attendance represents historical participation, not current application status.
4. Completed events must become immutable.
5. All hour corrections must produce ledger entries.

### The load-bearing principle

**Application status and attendance are decoupled.** After Step 2, *no application-status transition writes to `attendance` or to the ledger.* Selection workflow and historical participation become independent axes. This single change eliminates loss paths L1 and L6 outright, rather than guarding against them.

Consequence worth stating plainly: **the ledger is an hours ledger, not an activity log.** Status changes, slot edits, and event-status changes produce no ledger entries unless they change credited hours. Under the new design, they cannot.

---

## 1. Application status mutations

Eleven paths. **None writes to `attendance` today; none will after Step 2.** They are mapped because today they can *indirectly* destroy hours via the attendance rewrite (A8, A9) or via cascade.

| # | Path | Current behaviour | New behaviour | Ledger entry | Existing users affected? |
|---|---|---|---|---|---|
| A1 | `POST /api/events/:id/apply` — [:783](server/server.js:783) | Inserts `pending`. Blocks if any row exists for `(user, slot)`. | **Unchanged.** (Withdrawal semantics are Block 4.) | None | No |
| A2 | `PATCH /api/applications/:id` — student withdraw — [:883](server/server.js:883) | Sets own application to `rejected`. | **Unchanged status logic.** Now explicitly documented as *not* affecting attendance: a volunteer who withdraws after being marked present keeps their hours. | None | **No — but this is the constraint-3 fix.** Today a later attendance save would erase them (L1). |
| A3 | `PATCH /api/applications/:id` — organizer decide — [:959](server/server.js:959) | Sets `accepted`/`waitlisted`/`rejected`. | **Unchanged status logic.** Un-accepting no longer risks the volunteer's hours on the next attendance save. | None | No |
| A4 | `handleWaitlistPromotion()` — [:342](server/server.js:342), [:373](server/server.js:373) | Promotes `waitlisted`→`accepted`, re-ranks the queue. Gated on `auto_approve = 1`. | **Unchanged** (removing the gate is Block 4, item 1.12). | None | No |
| A5 | `POST /api/events/:id/auto-approve` (Equalizer) — [:1181](server/server.js:1181) | Bulk `pending`→`accepted` by fewest hours. | **Unchanged** (retirement is Phase 2, item 2.3). | None | No |
| A6 | `POST /api/events/:id/auto-select/confirm` — [:2685](server/server.js:2685), [:2713](server/server.js:2713) | Applies `accepted`/`waitlisted`, sets `selection_summary`, event → `closed`. | **Unchanged**, except it must refuse on a `completed` event (§4, D-guard). | None | No |
| A7 | `processEventSelection()` — [:2850-2891](server/server.js:2850) | **Unreachable.** `setSelectionTrigger(fn) {}` discards the callback; it can never fire. | **Deleted**, along with the `scheduler.js` stubs. Removing 128 lines of dead code that duplicates A6 with different seeding. | None | No — proven unreachable |
| A8 | `PUT /api/events/:id` — slot removal — [:1114](server/server.js:1114) | `DELETE FROM applications WHERE slot_id = ?` | **Refused** when the slot has any attendance row (§3, C2). | None (nothing changes) | **Yes — behaviour change.** An organizer who could previously delete a shift with credited hours now gets a 409 naming the affected volunteers. |
| A9 | `PUT /api/events/:id` — no persisted slot ids — [:1120](server/server.js:1120) | `DELETE FROM applications WHERE event_id = ?` — wipes **every** application for the event. | **Branch removed entirely.** An edit that names no existing slots is a malformed payload, not an instruction to delete everything. | None | **Yes — behaviour change**, removing the single most destructive path in the codebase. |
| A10 | `DELETE /api/events/:id` — [:1358](server/server.js:1358) | Deletes all applications. | **Refused** when the event has any attendance row (§4, D5). | None | **Yes — behaviour change.** |
| A11 | FK `CASCADE` from `users` | Deleting a user removes their applications. | **Unchanged.** Block 1 scoped the only admin route into this. | None | No |

---

## 2. Attendance row mutations

This is the entire hours pipeline. **One writer today; one writer after.**

| # | Path | Current behaviour | New behaviour | Ledger entry | Existing users affected? |
|---|---|---|---|---|---|
| B1 | `POST /api/events/:id/attendance` — [:992](server/server.js:992) | `DELETE FROM attendance WHERE event_id = ?` then re-`INSERT` for **every currently-`accepted`** application. Absent from the map ⇒ `present = 0`. Hours recomputed from current slot duration. Not transactional. Sets event → `completed`. | **Complete rewrite.** See §2a. Transactional upsert; touches only rows explicitly named in the request; never implicitly deletes; preserves stored hours on existing rows; refuses shifts that have not ended; completion becomes conditional. | **Yes** — one per row whose credited value actually changes. `credited` / `revoked` / `adjusted`. No-op saves write nothing. | **No change to existing totals.** Rows are only rewritten when an organizer saves that event, and then only as instructed. |
| B2 | `PUT /api/events/:id` — [:1113](server/server.js:1113) | `DELETE FROM attendance WHERE slot_id = ?` for removed slots. | **Refused** if the slot has attendance (§3, C2). | None | **Yes — behaviour change.** Closes L3. |
| B3 | `PUT /api/events/:id` — [:1119](server/server.js:1119) | `DELETE FROM attendance WHERE event_id = ?` | **Branch removed.** | None | **Yes — behaviour change.** |
| B4 | `DELETE /api/events/:id` — [:1357](server/server.js:1357) | Deletes all attendance for the event. | **Refused** if any attendance row exists (§4, D5). | None | **Yes — behaviour change.** Closes L7. |
| B5 | FK `CASCADE` from `users` / `events` / `slots` | Verified live: `foreign_keys = 1`. Deleting a user destroys their attendance. | **Unchanged at the schema level** — the guards above remove every application route into it. Documented as the residual risk (§6). | None | No |
| B6 | `seedDatabase()` — [db.js:301](server/db.js:301) | Inserts seed attendance. | **Unchanged.** Backfill covers it on boot. | `migrated`, via existing backfill | No |
| B7 | `POST /api/auth/reset` — [:1493](server/server.js:1493) | Drops all tables including `attendance` and `hours_ledger`. | **Unchanged.** Demo-only since Block 1; not registered in production. | Rebuilt by backfill | No |

### 2a. The new attendance endpoint, precisely

**Request contract — unchanged.** `{ attendanceMap: { [applicationId]: boolean } }`.

Keeping application id as the key is deliberate. §1 of the analysis flagged that the map key (application id) and the attendance PK (`slot_id, user_id`) are different identity spaces — but every status transition (A2, A3, A4, A5, A6) *updates* the application row rather than deleting it, so the id stays resolvable. The only paths that delete application rows are A8/A9/A10, all of which Step 2 blocks. Changing the contract would be churn without benefit.

**Algorithm:**

```
BEGIN
  event = load(:id); assert organizer owns it (or admin)
  REFUSE if event.status == 'cancelled'
  for each [applicationId, present] in attendanceMap:
      app = load application
      REFUSE  if app.event_id != event.id
      SKIP    if app has neither status 'accepted' nor an existing attendance row
              -- lets an organizer correct someone since un-accepted (constraint 3)
              -- while refusing to invent attendance for someone never selected
      REFUSE  if slot.end_datetime > now  AND no existing row
              -- cannot credit a shift that has not happened (L5)
      prior = SELECT attendance WHERE slot_id, user_id

      hours = prior ? prior.hours_awarded          -- snapshot; never re-priced (decision 3)
                    : durationOf(slot)             -- new credits price at current duration

      CONTINUE if prior AND prior.present == present   -- no-op, no ledger noise

      UPSERT attendance (event_id, slot_id, user_id, present, hours)
      recordHoursChange(action, present_before, present_after,
                        hours_before, hours_after,
                        actor = req.user, source = 'attendance_screen')

  maybeCompleteEvent(event)     -- see §4, D3
COMMIT
```

**Properties this gives us, mapped to the constraints:**

| Constraint | How it is satisfied |
|---|---|
| Totals must not change | No row is written unless named in the request. Today's 12 rows are inert until an organizer saves that event. |
| No silent disappearance | The implicit `DELETE` is gone. A credit can only be revoked by an explicit `present: false`, which writes a ledger row naming the actor. |
| Attendance ≠ application status | Rows are never removed because a status changed. Un-accepted volunteers with a record remain correctable. |
| Corrections are ledgered | Every credited-value change writes an entry. No-ops write nothing, so the ledger stays signal. |

**Action selection:**

| Prior row | New `present` | Action | Delta |
|---|---|---|---|
| none | `true` | `credited` | `+hours` |
| none | `false` | `credited` | `0` (value retained in `hours_after`) |
| `present=0` | `true` | `credited` | `+hours` |
| `present=1` | `false` | `revoked` | `−hours` |
| exists | unchanged | *none* | — |

`adjusted` is reserved for an explicit hours correction, which has no UI today (§6).

---

## 3. Event slot mutations

| # | Path | Current behaviour | New behaviour | Ledger entry | Existing users affected? |
|---|---|---|---|---|---|
| C1 | `POST /api/events` — [:623](server/server.js:623) | Inserts slots. | **Unchanged.** | None | No |
| C2 | `PUT /api/events/:id` — delete removed slots — [:1115](server/server.js:1115) | Deletes slot + its applications + its attendance. | **Refused with 409** if the slot has any attendance row, listing the affected volunteers by name. Deleting a slot with applications but no attendance stays allowed. | None | **Yes — behaviour change.** |
| C3 | `PUT /api/events/:id` — update slot — [:1128](server/server.js:1128) | Updates name, description, times, `max_spots`. Existing attendance keeps its stored `hours_awarded`, but a later re-save re-prices it (L4). | **Unchanged write**, but L4 closes because B1 no longer re-prices. Times remain editable; historical credits do not follow. | None | **No.** This is the fix for decision 3. |
| C4 | `PUT /api/events/:id` — insert new slot — [:1135](server/server.js:1135) | Inserts. | **Unchanged.** | None | No |
| C5 | `POST /api/events/:id/duplicate` — [:2417](server/server.js:2417) | Clones slots +7 days onto a new event. | **Unchanged.** Never touches the source event's attendance. | None | No |
| C6 | `DELETE /api/events/:id` — [:1362](server/server.js:1362) | Deletes all slots. | **Refused** when attendance exists (§4, D5). | None | **Yes — behaviour change.** |

**All of C1–C6 additionally refused when `event.status = 'completed'`** — see §4.

---

## 4. Event status mutations

| # | Path | Current behaviour | New behaviour | Ledger entry | Existing users affected? |
|---|---|---|---|---|---|
| D1 | `POST /api/events` — [:602](server/server.js:602) | New event `open`. | **Unchanged.** | None | No |
| D2 | `PATCH /api/events/:id/status` — [:1395](server/server.js:1395) | Sets `open`/`closed`/`cancelled`. No check on `completed`. | **Refused when the event is `completed`.** A completed event cannot be reopened, closed, or cancelled. | None | **Yes — behaviour change.** |
| D3 | `POST /api/events/:id/attendance` — [:1045](server/server.js:1045) | **Unconditionally** sets `completed`. | **Conditional:** completed only when *every* slot has ended **and** every accepted application on every slot has an attendance row. Otherwise the status is left alone. | None | **Yes — see §7.** This is the scope question. |
| D4 | `POST .../auto-select/confirm` — [:2740](server/server.js:2740) | Sets `closed`. | **Unchanged**, plus refusal on `completed`. | None | No |
| D5 | `DELETE /api/events/:id` — [:1344](server/server.js:1344) | Organizer or admin deletes the event and everything under it. | **Refused with 409 when the event has any attendance row**, regardless of `present`. Message directs to cancellation. Events with no attendance remain deletable. | None | **Yes — behaviour change**, and admins lose a capability. Accepted trade per decision 1. |
| D6 | `PATCH /api/events/:id` (settings) — [:1230](server/server.js:1230) | Changes `auto_approve`, `attendee_visibility`. No completed check. | **Refused when `completed`.** | None | **Yes — behaviour change.** |
| D7 | `PUT /api/events/:id` (full edit) — [:1055](server/server.js:1055) | No completed check. | **Refused when `completed`.** | None | **Yes — behaviour change.** |

### 4a. What "immutable" means — interpretation requiring confirmation

Taken literally, "completed events must become immutable" would also freeze attendance, making it impossible to correct an error — which contradicts constraint 5 ("all hour corrections must produce ledger entries" presupposes corrections remain possible) and removes the re-editable attendance the product deliberately has today.

**Proposed reading:** immutability freezes the **event definition and lifecycle** — title, description, category, location, deadline, selection method, visibility, slots, and status. It does **not** freeze the attendance record, because attendance correction *is* the adjustment workflow decision 1 points at, and every correction is now ledgered with an actor and a reason.

So on a completed event: `PUT`, `PATCH`, `PATCH /status`, `DELETE` all refuse; `POST /attendance` still works and writes ledger entries.

---

## 5. Credited hours mutations

Credited hours are derived, never stored — `SUM(hours_awarded) WHERE present = 1` across 24 read sites. So this section is exactly the set of paths that change `attendance`.

| Cause | Today | After Step 2 |
|---|---|---|
| Organizer marks present/absent | B1, destructively | B1, as an explicit ledgered upsert |
| Application status changes | **B1 erases on next save (L1)** | **Impossible — decoupled** |
| Organizer removes a shift | **B2 destroys silently (L3)** | **Refused (C2)** |
| Malformed edit payload | **B3 destroys everything** | **Impossible — branch removed** |
| Event deleted | **B4 destroys silently (L7)** | **Refused (D5)** |
| Slot times corrected, attendance re-saved | **L4 re-prices history** | **Impossible — hours are snapshots** |
| Attendance saved before the shift | **L5 credits the future** | **Refused** |
| Partial/stale request map | **L6 marks the rest absent** | **Impossible — unnamed rows untouched** |
| User/event row deleted | B5 cascade | B5 cascade — residual, §6 |

**No path in this table changes an existing total on deploy.** Every change is to future behaviour.

---

## 6. Residual risks after Step 2

1. **FK `CASCADE` remains at the schema level (B5).** Every application route into it is blocked, but a direct `DELETE FROM users` in a SQL console still destroys attendance. Fixing properly means soft-delete — larger, and deferred.
2. **No explicit hours-adjustment UI.** The `adjusted` action and the schema support it; nothing exposes it. An organizer who credited the wrong *duration* can currently only toggle present/absent. Deferred, and worth its own decision.
3. **Certificates remain mutable (L8).** The code hashes ids only, so a corrected credit changes what an issued certificate verifies to. Scoped to Phase 2 item 2.2.
4. **Ledger append-only by convention.** No trigger rejecting `UPDATE`/`DELETE` yet. Worth adding now that writes are wired.
5. **Blocked deletion has no escape hatch.** An event created in error that has attendance can no longer be removed by anyone. Correct per decision 1, but it means test/junk events will accumulate. Cancellation is the intended path.

---

## 7. The one scope question

**Making completed events immutable requires fixing premature completion (roadmap 1.14) in the same change.**

These interact and cannot be separated:

- Today `POST /attendance` sets `completed` unconditionally (D3).
- A five-Saturday event has all five Saturdays' volunteers `accepted` from day one.
- The organizer takes attendance after Saturday 1 → event becomes `completed`.
- With D2/D6/D7 refusing on `completed`, that event is now **permanently frozen after its first day** — it cannot be edited, reopened, or cancelled, and volunteers for Saturdays 2–5 can never be credited.

Immutability without conditional completion makes multi-day events unusable. There is no coherent version of constraint 4 that leaves D3 as it is.

**Recommendation: pull 1.14 into Step 2** — complete only when every slot has ended and every accepted application on every slot has an attendance row. This is a small change (one predicate) but it is scope beyond what was approved, so I am flagging rather than assuming.

The alternative — ship immutability now and 1.14 in Block 4 — would knowingly break multi-day events in between. I do not recommend it.

Related, and included in the recommendation: the client's attendance screen must stop defaulting everyone to present (loss path L2) and show only shifts that have ended, or conditional completion will rarely be reached and organizers will still over-credit. Without this the server guard is correct but the UI keeps steering people into it.

---

## 8. Implementation order, once §7 is settled

1. `server/attendance.js` — extract and rewrite B1 as a transactional ledgered upsert
2. Guards: C2 slot-delete refusal, A9/B3 branch removal, D5 delete refusal, D2/D6/D7 completed refusal
3. Conditional completion (D3) — pending §7
4. Delete dead code A7 + `scheduler.js` stubs
5. Client: attendance screen shows only ended shifts, no default-present, surfaces recorded-but-no-longer-accepted volunteers
6. Tests: one per loss path L1–L7 and L10, each written to fail against today's code first
7. Re-run the Tier 0 golden snapshot — the 10 baseline totals must be unchanged

---

**Map complete.** Awaiting a decision on §7 before writing code.
