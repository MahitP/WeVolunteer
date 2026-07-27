# Block 2 — Stabilization Report

**Date:** 2026-07-21
**Scope:** Review of Step 1 (ledger) and Step 2 (attendance rewrite). No new roadmap features.
**Result:** 82 tests passing · 0 lint errors · hours parity `PASS` · `integrity_check ok` · `foreign_key_check` clean.

---

## 1. UI consistency with the new server restrictions

### What was wrong

Step 2 added five `event_completed` guards and an `attendance_exists` guard, all returning 409. The client had not been brought in line, so it offered actions that were guaranteed to fail:

| Surface | Offered | Server response |
|---|---|---|
| Organizer dashboard | **Delete** on every event, always | 409 once attendance exists |
| Admin dashboard | **Delete** on every event, always | 409 — admins are not exempt |
| Event modal | **Edit event** on completed events | 409 `event_completed` |

Edit and Close were already hidden on completed events; deletion was not, on either dashboard.

### What changed

A single `eventPermissions(event)` helper in [helpers.js](src/utils/helpers.js) now describes the rules, and all three surfaces read from it. Duplicating the conditions inline was how they drifted in the first place.

The client could not previously *know* whether an event had attendance, so `GET /api/events` now returns `hasAttendance`. That is the minimum fact needed to stop presenting an action that cannot succeed.

**Verified in the browser.** A completed event with attendance now exposes only Open / Duplicate / Download roster, with an accessible locked indicator carrying the server's own reason. The admin table shows "Protected" in place of the delete button. An open event with no attendance is unchanged.

Duplicate stays available on completed events deliberately — it reads the original and writes a new one, which the server permits.

---

## 2. Re-audit of attendance and ledger mutation paths

Re-derived by grep, not from the Step 2 summary.

### Every write to `attendance`

| Site | Path | Ledger entry |
|---|---|---|
| [attendance.js:245](server/attendance.js:245) | `finalizeAttendance` upsert — the only application write | **Yes**, one per changed record |
| [db.js:343](server/db.js:343) | Seed | Covered by migration backfill |
| [server.js:1604](server/server.js:1604) | `DROP TABLE` in demo reset | Rebuilt by backfill; demo-only, unregistered in production |

`finalizeAttendance` has exactly one caller ([server.js:1071](server/server.js:1071)), inside `inTransaction`. Ledger writes happen in the same transaction as the attendance write, so the two cannot diverge.

**Confirmed: no endpoint can silently modify credited hours.** Every route that previously could is now either refused or ledgered.

### One defect found and fixed

`DELETE /api/events/:id` still contained `DELETE FROM attendance WHERE event_id = ?`. It was unreachable — the 409 guard above it means the statement could only ever match zero rows, and the FK cascade would handle it regardless. Removed. A destructive statement that is only safe because of a guard several lines above it is an invitation to move the guard.

### Check-in remains hours-free

`recordCheckins` writes only to `attendance_checkin` and imports nothing from the ledger. Asserted by test: a check-in produces zero ledger rows and zero attendance rows.

---

## 3. Tests added

**82 total, up from 57.**

| File | Covers |
|---|---|
| [src/utils/helpers.test.js](src/utils/helpers.test.js) | Completed-event UI restrictions via `eventPermissions` — 15 assertions across locking, attendance protection, and fail-safe behaviour on malformed input |
| [server/dataIntegrity.test.js](server/dataIntegrity.test.js) | Hours-adjustment readiness, soft-delete characterisation, production schema invariants |

**On testing the UI restrictions without a DOM.** Rather than add `@testing-library/react` and jsdom, the rules were extracted into a pure function that both the UI and the tests consume. That tests the actual decision rather than its rendering, and it removes the duplication that caused the drift.

**Hours-adjustment readiness.** There is no UI for correcting the *number* of hours on a credit — only present/absent. The tests prove the data layer already carries it: upward and downward `adjusted` entries compute correct deltas, keep parity, and record actor, source, and reason. Building that workflow is a UI and endpoint job, not a schema migration.

**Soft-delete characterisation.** Three tests marked `DOCUMENTS:` pin down what the schema does *today* rather than what it should do — deleting a user still destroys their attendance via CASCADE; the ledger survives with its denormalised snapshots; and parity verification detects the loss. They put the residual risk in the suite instead of only in prose, and they will fail deliberately when soft-delete lands.

---

## 4. Database schema audit

Live checks: `integrity_check` **ok**, `foreign_key_check` **empty**, `foreign_keys` **ON**.

### Indexes — four missing, now added

A query-plan audit found four hot filters running full table scans:

| Query | Before | After |
|---|---|---|
| `slots WHERE event_id` | `SCAN slots` | `SEARCH … idx_slots_event` |
| `applications WHERE slot_id AND status` | `SCAN applications` | `SEARCH … COVERING INDEX idx_applications_slot` |
| `events WHERE organizer_id` | `SCAN events` | `SEARCH … idx_events_organizer` |
| `attendance WHERE event_id` | `SCAN attendance` | `SEARCH … COVERING INDEX idx_attendance_event` |

All four are on paths the app hits constantly — every event render, every per-slot capacity count inside a loop, every organizer dashboard, and the deletion guard. They would have degraded together rather than one at a time.

`applications WHERE user_id` was already covered by the `UNIQUE(user_id, slot_id)` index as a leftmost prefix, so it is deliberately not duplicated.

### A performance defect I introduced in Step 1

`backfillHoursLedger` ran `SELECT 1 FROM hours_ledger WHERE id = ?` **per attendance row, on every boot**, re-preparing the statement each iteration. At 12 rows it is invisible; at a year of district records it is tens of thousands of round-trips at startup. Replaced with a single query into a `Set`. My own defect, found by this audit rather than by a test.

### Constraints — gaps that need a table rebuild

SQLite cannot `ALTER TABLE … ADD CONSTRAINT`, so these need a rebuild and are **not** done here:

| Table | Missing | Risk |
|---|---|---|
| `attendance` | `CHECK(hours_awarded >= 0)` | Negative hours are storable |
| `slots` | `CHECK(max_spots > 0)`, `CHECK(end_datetime > start_datetime)` | Enforced in application code only |
| `events` | `CHECK(attendee_visibility IN ('accepted','private'))` | Added by `addColumnIfMissing`, so it never got a CHECK; server normalises the value |
| `applications` | `'withdrawn'` in the status CHECK | Blocks roadmap 1.11 until the rebuild happens |

Present and correct: `attendance.present`, `events.status`, `applications.status`, `users.role`, `users.grade`, and both `hours_ledger` CHECKs.

**Recommendation:** do one table-rebuild migration that adds all of these together, alongside 1.11's `withdrawn` status. One rebuild, one backup, one verification — rather than four.

### Migration safety

`addColumnIfMissing` plus `CREATE TABLE IF NOT EXISTS` is adequate for additive changes and has worked. Its limits, now that they matter:

- **No schema version.** Nothing records which migrations have run. Two deployments with different code produce silently different schemas.
- **No down migrations.** The ledger is reversible only because it happens to be a standalone table.
- **Cannot alter existing constraints** — hence the rebuild above.
- **Runs automatically at boot.** Convenient, and correct while every migration is additive and idempotent. A destructive migration must never be run this way.

### Backup

**This remains the single largest unmitigated risk.** There is still no backup of any kind.

- `journal_mode = delete`, so `cp` during a write is not guaranteed consistent. Use `sqlite3 .backup` or the online backup API.
- **Recommend switching to WAL** (`PRAGMA journal_mode = WAL`, persistent) — better concurrent reads and safer online backups. Not flipped here: it changes runtime behaviour and file layout (`-wal`/`-shm` must travel with the database), so it belongs with the 1.18 deployment work rather than a stabilization pass.
- Needs: scheduled off-box copies, retention, and **a rehearsed restore**. An unrehearsed backup is a hope.

---

## 5. Report

### Remaining blockers before production

Ordered by severity.

1. **No backups.** Every other protection added in Blocks 1 and 2 is defeated by one disk failure. *(roadmap 1.18)*
2. **No production serving path.** The client still only reaches the API through Vite's dev proxy. *(1.18)*
3. **No email.** Selection results, cancellations, and location changes reach nobody who is not already looking at the app. Also blocks password reset. *(1.6)*
4. **No password reset.** A forgotten password is a permanently lost service record. *(1.5)*
5. **Unverified student identity.** Anyone can register with any email and accrue hours a school will act on. *(1.4)*
6. **Auto Select never runs on its own.** Applicants can wait indefinitely; nothing tells the organizer the deadline passed. *(1.9)*
7. **Auto Select can still be re-rolled** until the organizer likes the roster. *(1.10)*
8. **Constraint rebuild outstanding** — negative hours and zero-spot slots are storable, and 1.11 is blocked on it.

### Remaining security risks

| Risk | Status |
|---|---|
| Minors' data broadly readable — any organizer can pull any student's email and history; the leaderboard is a directory of student names, grades, schools | **Open.** Highest remaining security item *(1.15)* |
| No CSP | Open — belongs with 1.18, when something serves the HTML |
| FK CASCADE can still destroy hours via direct database access | Open, characterised by test. All API routes blocked |
| Rate limiting is in-memory, per-process | Accepted for single-instance; needs a shared store if scaled |
| Ledger is append-only by convention, not by trigger | Open — worth adding now that writes are live |
| No hours-adjustment workflow | Open. Data layer proven ready |
| Certificates remain mutable; the code hashes ids, not hours | Open *(2.2)* |
| Reset endpoint, demo credentials, JWT fallback, open CORS, unscoped deny | **Closed in Block 1** |
| Silent hours loss (L1–L7, L10, L11) | **Closed in Block 2** |

### Recommended order

**Next — Block 3, identity and reach (2–3 weeks).**
1.6 email → 1.4 domain restriction + confirmation → 1.5 password reset.
Email first: the other two depend on it. This is what makes the platform usable by someone not already staring at it.

**Then — Block 4, workflow correctness (1–2 weeks).**
Constraint rebuild (adding `withdrawn` at the same time) → 1.11 withdrawal → 1.12 waitlist promotion → 1.13 cancelled events → 1.9 deadline escalation → 1.10 single-draw Auto Select.

Two changes from the original roadmap order, both consequences of what Block 2 established:

- **The constraint rebuild moves to the front of Block 4.** 1.11 needs `withdrawn` in the CHECK constraint, which needs the rebuild. Doing it first means one migration instead of two.
- **1.14 multi-day completion is already done** — it was pulled into Step 2 because immutability required it.

**Then — Block 5, close the gate (days).**
1.15 minors' data → 1.17 server-side validation → 1.18 deployment, backups, CSP.

**Then pilot.** One organizer, one real event, one full cycle. Ship nothing else until those hours reach a certificate.

**Deferred deliberately:** soft-delete, the hours-adjustment UI, and the ledger append-only trigger. All three are real, none blocks a pilot, and each is cheaper once the workflows above have settled.

---

## Files changed in this pass

| File | Change |
|---|---|
| [src/utils/helpers.js](src/utils/helpers.js) | `eventPermissions` — one description of the rules |
| [src/views/OrganizerDashboard.jsx](src/views/OrganizerDashboard.jsx) | Edit / Close / Delete gated; locked indicator |
| [src/views/AdminDashboard.jsx](src/views/AdminDashboard.jsx) | Delete gated; "Protected" state |
| [src/components/EventModal.jsx](src/components/EventModal.jsx) | Edit gated on completed events |
| [server/server.js](server/server.js) | `hasAttendance` on `GET /api/events`; removed unreachable attendance delete |
| [server/db.js](server/db.js) | Four indexes |
| [server/hoursLedger.js](server/hoursLedger.js) | Backfill N+1 fixed |
| [src/utils/helpers.test.js](src/utils/helpers.test.js) | **New** — 15 tests |
| [server/dataIntegrity.test.js](server/dataIntegrity.test.js) | **New** — 10 tests |

No behaviour change to any hours calculation. Parity `PASS`; the volunteer totals are the same before and after this pass.
