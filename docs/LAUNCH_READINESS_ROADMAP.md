# WeVolunteer — Launch Readiness Roadmap

**Date:** 2026-07-21
**Scope:** Full codebase audit (client + server) and a phased plan to take WeVolunteer from a working demo to a platform South Brunswick students, organizers, and school administrators can actually depend on.
**Constraint:** Preserve existing product decisions. Auto Select stays weighted-random. The application → approval → attendance → hours workflow stays. Volunteers stay individuals. Field Notes stays. Nothing is added because other apps have it.

---

## Part 0 — System as built

### Frontend architecture

React 19 + Vite, no router, no state library, no UI framework. `App.jsx` (495 lines) is the whole shell: it holds `currentUser`, `events`, `applications`, `favorites`, and a `refreshKey` counter. Every mutation anywhere in the tree calls `onStateChange()`, which increments `refreshKey`, which re-runs one effect that re-fetches `/api/auth/me`, `/api/events`, and `/api/applications` in full. Navigation is `activeTab` state; the event detail view is a modal (`EventModal`, 1230 lines) rather than a page.

Twelve views, thirteen components, one 2254-line hand-rolled stylesheet implementing the Field Notes system (paper `#F7F7F5`, service green `#0F6B45`, amber `#B45309` reserved for hours, Bricolage Grotesque + Public Sans, the `▪▪▪▫▫` seats motif). The design system is genuinely good and internally consistent — it is the strongest part of the codebase.

### Backend architecture

Express 4 + `node:sqlite` (`DatabaseSync`) + JWT + bcryptjs. One file, `server.js`, 2824 lines, ~40 endpoints, no router modules, no service layer, no validation library. `db.js` owns schema, `addColumnIfMissing()` migrations, and the demo seed. `weighting.js` is the one well-isolated module. `scheduler.js` is a stub — every function is empty.

### Database schema

`users`, `events`, `slots`, `applications`, `attendance`, plus V2 tables `notifications`, `event_comments`, `event_announcements`, `user_favorites`, `auto_select_runs`. Foreign keys declared with `ON DELETE CASCADE`; `applications` has `UNIQUE(user_id, slot_id)`; `attendance` is keyed `(slot_id, user_id)`. Five indexes plus the notification dedupe unique index.

The central invariant is right: **hours are never stored on the user row.** They are always `SUM(hours_awarded) FROM attendance WHERE present = 1`. That single decision is why the hours figure is trustworthy everywhere it appears.

### Authentication

Email + bcrypt password, JWT with 7-day expiry, token in `localStorage`. `authenticateToken` middleware decodes the token into `req.user` — and `req.user.role` is trusted from the token payload for every authorization decision. No refresh tokens, no logout server-side, no password reset, no email verification, no rate limiting, no lockout.

### Roles and permissions

Three roles enforced per-endpoint with inline `if (req.user.role !== 'x')` checks. `student` and `organizer` self-register; `admin` is seed-only. Organizers start `verified = 0` and cannot create events until an admin approves. Ownership is checked per-resource (`event.organizer_id !== req.user.id`). Attendee visibility is correctly enforced server-side, not in the client — a good instinct that is not applied consistently elsewhere.

### Event workflow

Organizer builds a sign-up sheet: event metadata + N dates × M shift templates → `slots` rows, each with `max_spots`. Selection method is chosen at creation (`auto_approve` — legacy name for Auto Select). Event status moves `open → closed → completed`, or `cancelled`.

### Application workflow

Student picks one or more slots and applies. Every application enters as `pending`. Organizer moves it to `accepted` / `waitlisted` / `rejected`, or Auto Select does it after the deadline. Students "withdraw" by setting their own application to `rejected`.

### Attendance workflow

Organizer opens the attendance screen, ticks who showed up, saves. The endpoint deletes every attendance row for the event and re-inserts one per currently-accepted application, with hours computed from slot duration. The event is then marked `completed`.

### Notification system

Fourteen closed-set `kind` values, mapped client-side to icon/tone/filter. Written synchronously on user actions, plus `runNotificationSweep()` at boot and every 15 minutes for deadline (48h) and shift (24h) reminders, deduped by a unique `(user_id, dedupe_key)` index. Bell polls every 60 seconds. **In-app only — there is no email or SMS path.**

### Certificate system

One certificate per completed event, generated from attendance. Verification code is deterministic: `certificateCode(userId, eventId)` FNV-style hash → `WEV-XXXX-XXXX`. Public verification endpoint exists. Printed certificate says *"Verify at wevolunteer.org/verify/CODE"*.

### Auto Select system

Run-and-confirm: after the deadline the organizer clicks **Run Auto Select** → a draft `auto_select_runs` row is written with `selected_ids` / `waitlist_ids`, seeded `${eventId}:${slotId}:run-${n}` so the draw is reproducible. The organizer reviews a preview, may **Run Again**, then **Confirm Results**, which applies statuses, notifies everyone, writes a `selection_summary`, and closes the event. Weight is `W(h) = 1.5 + 8.5 / (1 + 0.005h)` — a new volunteer gets 10.0, a 500-hour volunteer ~1.7, nobody ever hits zero.

### Organizer workflows

Create / edit / duplicate (+7 days) / open-close / cancel / delete events; review applicants with volunteer history inline; "Fill fairly" (the Equalizer — deterministic lowest-hours auto-accept, separate from Auto Select); waitlist management; announcements; take and re-edit attendance; export roster CSV; per-event stats.

### Admin workflows

Approve or deny pending organizers; delete any event; delete any comment; platform stats with show-up rate, completion rate, participation rate, monthly charts, and top organizers.

### Design system

Field Notes, as described. Skip link, `aria-modal` dialogs with focus containment via `useModal`, `aria-current` navigation, live-region toasts, `:focus-visible`, `prefers-reduced-motion`, tabular figures. Genuinely above average for a project this size.

### Existing limitations and technical debt

- `server.js` at 2824 lines and `EventModal.jsx` at 1230 lines are both past the point where they can be held in working memory.
- `scheduler.js` is dead. `processEventSelection()` (128 lines) is dead code bound to a trigger that never fires.
- Two overlapping fairness mechanisms: Auto Select (weighted random) and Equalizer (deterministic lowest-hours).
- Zero tests, including for `weighting.js` — the module whose comment says it exists so it *can* be tested.
- No pagination, no caching; the whole app refetches all events and all applications on every mutation.
- No routing means no URLs, no back button, no shareable links, no deep links from email.
- No production serving story: Vite's dev proxy is the only thing connecting client to API.

---

## Part 1 — Student experience

| Can a student… | Verdict |
|---|---|
| Create an account | Yes — but anyone on the internet can, with any email |
| Discover opportunities | Yes — search, category, sort, hours, place, favorites |
| Understand how events work | Partly — the "how hours are credited" panel is excellent, the rest is uneven |
| Apply for events | Yes — multi-slot selection is a genuinely good interaction |
| Understand Auto Select | Explained before applying, not at all when the result arrives |
| Receive selection results | Only if they open the app. No email. |
| Attend events | Yes — arrival instructions gated to confirmed volunteers is a nice touch |
| Receive verified hours | Yes — and the derivation is trustworthy |
| View history | Yes — dashboard timeline, profile, charts |
| Access certificates | Yes — but the verify URL printed on them does not exist |
| Manage profile | Yes — name, avatar, bio, school, grade, skills. No password change, no email change, no deletion. |

**What is missing, confusing, or broken**

1. **A withdrawn application can never be re-submitted.** Withdrawing sets `status = 'rejected'`; the apply endpoint blocks on *any* existing row for that `(user, slot)`. A student who withdraws by accident is permanently locked out of that shift.
2. **Withdrawal and rejection are the same value.** The student's own view renders "Not selected" for a shift they chose to leave.
3. **No password reset.** A forgotten password is a permanently lost account and a permanently lost service record.
4. **Cancelled events still appear as confirmed upcoming shifts.** The dashboard filters on application status and end time, never on `event.status`.
5. **No sense of competition.** A student applying to a 1-spot slot with 40 other applicants sees "0 of 1 filled" and nothing else.
6. **Auto Select results arrive without explanation.** "Waitlisted (Rank #4)" with no restatement of how the draw worked or why it is fair.
7. **No email.** Applications, selections, waitlist promotions, cancellations, and location changes are all in-app only.
8. **Certificates promise verification at a URL that 404s.** The one artifact that leaves the platform and goes to a college or an office is the one that makes a promise the platform does not keep.
9. **No way for a student to see or export their own full record** outside the per-event certificates.
10. **Every student's name, grade, school and hours are visible to every signed-in user** via the leaderboard and `/api/users/:id/profile`. These are minors.

---

## Part 2 — Organizer experience

| Can an organizer… | Verdict |
|---|---|
| Create and manage events | Yes — the multi-date shift builder with live preview is the strongest screen in the app |
| Set application deadlines | Yes — validated client-side only |
| Choose Manual Review or Auto Select | Yes, at creation and in edit |
| Review applicants | Yes, with volunteer history inline |
| Understand volunteer history | Yes — hours, events completed, last served, bio, skills |
| Manage accepted volunteers | Partly — no bulk actions, no per-shift roster view |
| Manage waitlists | Only on Auto Select events |
| Send announcements | Yes — one-way, correctly scoped to confirmed volunteers |
| Track attendance | Yes — and re-editable, which is correct |
| Confirm hours | Yes — and only from that one screen, which is correct |
| View analytics | Basic counts only |

**Missing tools, workflow problems, and mistakes organizers can make**

1. **Nothing tells the organizer the deadline has passed.** Auto Select is manual-trigger-only and the scheduler is stubbed. If the organizer forgets, applicants sit in `pending` indefinitely and never learn they were not chosen. This is the single largest workflow hole in the product.
2. **Auto Select can be re-rolled without limit until the organizer likes the result.** Every draft is stored, so an auditor *could* reconstruct it, but nothing surfaces re-rolls to students or admins. A fairness mechanism that can be shopped is not a fairness mechanism.
3. **Attendance can silently erase credited hours.** Saving attendance deletes every row for the event and re-inserts only for *currently accepted* applications, treating any application missing from the map as absent. Change a status after taking attendance, or save a partial map, and hours a student already earned disappear with no warning and no audit trail.
4. **Attendance can be taken before the shift has happened.** No check that the slot has ended.
5. **Taking attendance marks the whole event `completed`,** even a five-Saturday event after the first Saturday. The event then leaves the Active tab and loses its edit and close controls.
6. **Removing a shift in the edit screen deletes its applications and attendance,** including credited hours, with only generic form validation in front of it. If the payload contains no persisted slot ids, *every* application and attendance row for the event is deleted.
7. **Manual Review events have no waitlist promotion.** `handleWaitlistPromotion` is gated on `auto_approve === 1`. A released spot on a manual event notifies nobody and promotes nobody.
8. **Manually waitlisted applicants have no order.** `waitlist_order` is only set by Auto Select; manual waitlists sort by a fallback of 999.
9. **"Fill fairly" (Equalizer) sits next to Auto Select and does something different.** One is deterministic lowest-hours; the other is weighted random. Both are described as fair. It is offered on Auto Select events too, where it can pre-fill spots that a pending draw was about to allocate.
10. **No per-shift roster view or day-of check-in sheet.** On the day, an organizer at a park needs "who is on the 9:30 grill shift" on a phone. The CSV export is the closest thing and it is a download.
11. **No bulk accept/reject.** Thirty applicants is thirty clicks.
12. **Duplicate loses `instructions` and `attendeeVisibility`,** and is not transactional.
13. **No server-side temporal validation.** The server will accept a deadline in the past, an end time before a start time, or 10,000 spots.

---

## Part 3 — Administrator experience

| Can an administrator… | Verdict |
|---|---|
| Approve organizers | Yes |
| Moderate content | Barely |
| View platform usage | Yes — the health rates are well chosen |
| Handle issues | No mechanism exists |
| Maintain trust and safety | No |
| Verify volunteer records | Only by reading the events table |

**Missing controls, security concerns, moderation needs**

1. **`POST /api/auth/reset` requires no authentication and drops every table.** One unauthenticated request destroys the entire district's data. This is the most serious defect in the codebase.
2. **`JWT_SECRET` falls back to a hardcoded literal** committed to the repository.
3. **The demo bar ships inside the application shell** and lets anyone log into any seed account with a known password and reset the database. The login page prints the demo password.
4. **`cors()` is fully open.** No allowlist.
5. **No rate limiting on login or signup.** Unlimited password guessing; unlimited account creation.
6. **Anyone can register as a student with any email address.** No school-domain restriction, no email verification, no roster reconciliation. Volunteer hours that a school will act on are attached to unverified identities.
7. **Deny deletes a user by id with no check that the target is a pending organizer.** An admin can delete any account — including a student, cascading away their entire attendance record.
8. **An approved organizer cannot be un-approved.** Only delete, which cascades their events, applications, and every hour credited through them.
9. **No reporting.** Every event carries an open discussion thread visible to all signed-in users. There is no report button, no moderation queue, no filtering. On a platform for minors this is the largest trust-and-safety gap after account verification.
10. **No audit log.** Nothing records who changed an hours record, who deleted an event, who re-ran a selection.
11. **No way to correct an hours record** outside asking the organizer to redo attendance.
12. **No data retention, export, or deletion policy** for minors' records.
13. **`/api/auth/reset` does not drop `auto_select_runs`.** Because seed ids are fixed strings, stale runs survive a reset and attach to freshly-seeded events, which can make a demo event refuse to run selection.

---

# The Roadmap

## Phase 1 — Critical before launch

*Only what a real school deployment cannot go live without.*

---

### 1.1 Remove or authenticate the database reset endpoint
**Why it matters** — One unauthenticated POST erases every student's service record, permanently, with no backup.
**Current state** — `POST /api/auth/reset` at `server.js:1364`, no middleware, drops nine tables.
**Recommended** — Delete it from the production build. Guard it behind `NODE_ENV !== 'production'` and an admin token for demo builds. Add `auto_select_runs` to the drop list while you are in there.
**Difficulty** — Trivial · **Priority** — P0

### 1.2 Remove demo scaffolding from production
**Why it matters** — `DemoBar` renders in the app shell for every user and hard-codes `password123`. The login page lists five accounts and prints the password.
**Current state** — `App.jsx:406`, `DemoBar.jsx`, `Login.jsx:5-11`.
**Recommended** — Gate both behind `import.meta.env.DEV` or a `VITE_DEMO_MODE` flag. Remove the seed accounts from the production database entirely.
**Difficulty** — Trivial · **Priority** — P0

### 1.3 Harden the auth surface
**Why it matters** — Unlimited login attempts against six-character passwords, on accounts holding minors' records.
**Current state** — No rate limiting, no lockout, `JWT_SECRET` has a committed fallback, `cors()` is unrestricted, no security headers.
**Recommended** — Fail to boot if `JWT_SECRET` is unset in production. `express-rate-limit` on `/api/auth/*` (and a looser global limit). `helmet`. CORS allowlist from an env var. Raise the password minimum to 8 and reject the top-1000 list.
**Difficulty** — Small · **Priority** — P0

### 1.4 Verified identity for students
**Why it matters** — Hours from this platform will be used for the Silver Award and college applications. Right now anyone anywhere can create "Leo Chen, Grade 10, South Brunswick HS" and start accruing them.
**Current state** — `POST /api/auth/signup` accepts any email; students are `verified = 1` on creation.
**Recommended** — Restrict student signup to the district email domain (env-configurable allowlist) **plus** email confirmation before the account can apply to anything. Do not build SSO yet — a domain check plus a confirmation link solves the real problem at a fraction of the cost. Keep the existing admin-approval flow for organizers unchanged.
**Difficulty** — Medium · **Priority** — P0

### 1.5 Password reset
**Why it matters** — Without it, a forgotten password is a permanently lost account and a permanently lost service record. It is also the single most common support request any school system generates.
**Current state** — Does not exist.
**Recommended** — Standard signed, single-use, expiring token by email. Requires 1.6.
**Difficulty** — Small · **Priority** — P0

### 1.6 Email delivery
**Why it matters** — Selection results, waitlist promotions, cancellations, and location changes are currently in-app only. A student who applies and does not reopen the app never learns they were chosen. An event moved to a different park reaches nobody who is not looking at their phone.
**Current state** — `createNotification()` writes a row and nothing else.
**Recommended** — A transactional provider behind a small `sendEmail()` adapter, called from the existing `createNotification()` so there is exactly one notification pipeline. Email only the kinds that carry consequence: `accepted`, `declined`, `waitlisted`, `promoted`, `cancelled`, `location`, `hours`, plus password reset and email confirmation. Per-user opt-out in profile settings. Do not email `comment` or `info`.
**Difficulty** — Medium · **Priority** — P0

### 1.7 Make attendance non-destructive
**Why it matters** — This endpoint can silently erase hours a student has already earned and that a school may already have counted. It is the one place in the product where data loss is invisible.
**Current state** — `server.js:895` deletes all attendance for the event, re-inserts only for currently-accepted applications, and treats absence from `attendanceMap` as absent.
**Recommended** — Replace delete-and-reinsert with an upsert keyed on `(slot_id, user_id)`, touching only applications explicitly present in the submitted map. Never delete a row with `present = 1` implicitly. Add an `hours_ledger` append-only table recording every change with actor, timestamp, before/after — this is what makes the record defensible when a parent or a college asks. Reject attendance for slots that have not ended yet.
**Difficulty** — Medium · **Priority** — P0

### 1.8 Stop event edits from destroying sign-ups and hours
**Why it matters** — Removing a shift deletes its applications *and* its attendance rows. If the payload contains no persisted slot ids, every application and every attendance row for the event is deleted.
**Current state** — `server.js:1006-1025`.
**Recommended** — Refuse to delete any slot that has an attendance row; require the organizer to cancel it explicitly. Refuse to delete a slot with accepted applications without an explicit `confirmDestructive` flag, and show those volunteers by name in the client before the destructive save. Remove the "delete everything" `else` branch entirely.
**Difficulty** — Medium · **Priority** — P0

### 1.9 Close the Auto Select deadline gap
**Why it matters** — Selection only happens if the organizer remembers to click a button. Applicants have no ceiling on how long they wait, and no path to an answer if the organizer never returns.
**Current state** — `scheduler.js` is entirely stubbed; `processEventSelection()` is dead code.
**Recommended** — Keep run-and-confirm — the organizer reviewing before committing is the right design. Add to the existing 15-minute sweep: when a deadline passes on an Auto Select event with pending applications, notify the organizer ("applications closed, run selection") and re-notify at 24h and 72h; flag it in the dashboard's "Needs your decision" panel; escalate to the admin queue at 7 days. Also flip `status` to `closed` when the deadline passes, so server-side data stops claiming the event is open. Delete `processEventSelection()` and the scheduler stubs.
**Difficulty** — Medium · **Priority** — P0

### 1.10 Make Auto Select non-shoppable
**Why it matters** — An organizer can re-roll until they get a roster they prefer. That defeats the entire purpose of weighted random selection, and if a student ever discovers it, the fairness claim collapses.
**Current state** — Unlimited `Run Again`; drafts are stored but re-rolls are invisible outside the organizer's own audit panel.
**Recommended** — One draw per event. Preserve the preview-then-confirm step, but replace **Run Again** with **Discard and re-draw**, which requires a typed reason, is recorded on the event, is shown to the admin, and is capped. Surface the run count and any re-draw reason in the confirmed selection summary that students can see. Do not change the weighting curve or the algorithm.
**Difficulty** — Small · **Priority** — P0

### 1.11 Separate withdrawal from rejection
**Why it matters** — A student who withdraws by mistake can never re-apply to that shift, and their own dashboard tells them they were "Not selected".
**Current state** — Withdrawal writes `status = 'rejected'`; the apply endpoint blocks on any existing row.
**Recommended** — Add a `withdrawn` status to the `applications` CHECK constraint. Allow re-application when the existing row is `withdrawn` and the deadline has not passed (update the row rather than inserting, to respect the unique constraint). Label it "Withdrawn" everywhere, and exclude it from organizer decline counts.
**Difficulty** — Small · **Priority** — P0

### 1.12 Waitlist promotion on Manual Review events
**Why it matters** — Half the events on the platform have a waitlist that never moves. A released spot goes unfilled and nobody is told.
**Current state** — Gated on `auto_approve === 1` at `server.js:809` and `:867`.
**Recommended** — Remove the gate; promote from the waitlist whenever an accepted spot is released, on any event. Assign `waitlist_order` when an organizer manually waitlists someone (append to the end of that slot's queue) so manual waitlists have a defined order.
**Difficulty** — Small · **Priority** — P0

### 1.13 Cancelled events must stop looking confirmed
**Why it matters** — A student sees "Confirmed — Saturday 9:30 AM" for an event that was called off, and turns up.
**Current state** — `VolunteerDashboard.jsx:44-47` filters on application status and end time only.
**Recommended** — Exclude `cancelled` events from upcoming shifts, the next-shift banner, and the calendar; show them in a distinct "Cancelled" state. Also set accepted applications on a cancelled event to a terminal state so they stop counting anywhere.
**Difficulty** — Small · **Priority** — P0

### 1.14 Multi-day events must not complete after day one
**Why it matters** — A five-Saturday event vanishes from the Active tab and loses its controls after the first attendance take.
**Current state** — `server.js:948` sets `status = 'completed'` unconditionally.
**Recommended** — Mark completed only when every slot's end time has passed *and* attendance has been recorded for each. Otherwise leave it open or closed. Show per-shift attendance state in the organizer view.
**Difficulty** — Small · **Priority** — P0

### 1.15 Lock down minors' data
**Why it matters** — Any signed-in user can read any student's name, grade, school, and full service history. Any organizer can read any student's email address, including for students who never applied to their events.
**Current state** — `/api/users/:id/profile` grants full access to `isStaff` (any organizer) and partial access to everyone else; `/api/leaderboard` returns every student's name, school, grade, and hours to any authenticated caller.
**Recommended** — An organizer may see a student's profile and email **only** if that student has applied to one of their events. Students may see only their own. Make the leaderboard opt-in per student, defaulting to off, and drop school and grade from it. This preserves the community-recognition intent without publishing a directory of minors.
**Difficulty** — Small · **Priority** — P0

### 1.16 Fix `deny` so it cannot delete arbitrary users
**Why it matters** — A mistyped id deletes a student and cascades away every hour they have earned.
**Current state** — `DELETE FROM users WHERE id = ?`, no role or state check.
**Recommended** — Scope the delete to `role = 'organizer' AND verified = 0`. Add an admin ability to *revoke* an approved organizer (set `verified = 0`) that leaves their events and every credited hour intact.
**Difficulty** — Trivial · **Priority** — P0

### 1.17 Server-side validation
**Why it matters** — The server currently accepts a deadline in the past, an end time before a start time, negative or absurd spot counts, and unbounded strings. Every guard is in the client, where it can be bypassed.
**Current state** — Only category, grade, role, and comment/announcement length are validated.
**Recommended** — One shared validation layer for event create and update: deadline in the future and before the first shift; every slot's end after its start; `1 ≤ maxSpots ≤ 100`; length caps on title, description, location, instructions, and slot fields.
**Difficulty** — Small · **Priority** — P0

### 1.18 Production deployment path
**Why it matters** — Right now the client only reaches the API through Vite's dev proxy. There is no way to run this in production at all.
**Current state** — No static serving, no process manager, no backups, no migration tooling; `node:sqlite` is flagged experimental.
**Recommended** — Serve the built client from Express (or a reverse proxy) with a configurable API base URL. Add health checks, structured logging, and a scheduled off-box backup of the SQLite file with a documented restore drill. Decide explicitly whether `node:sqlite` is acceptable for production; `better-sqlite3` is the low-risk swap and would also restore real transactions. Keep SQLite — at district scale it is the right choice — but back it up like it holds student records, because it does.
**Difficulty** — Medium · **Priority** — P0

### 1.19 Tests for the fairness algorithm and the hours pipeline
**Why it matters** — Auto Select decides who gets opportunities and attendance decides what goes on a college application. Neither has a single test.
**Current state** — No test framework.
**Recommended** — Vitest. Cover: weight monotonicity and bounds; selection determinism for a fixed seed; distribution over 10,000 runs showing low-hours applicants are favoured but nobody is excluded; spot counts respected; hours derivation across attendance edits; the full apply → accept → attend → hours path. This is a small number of tests guarding the two things the platform's credibility rests on.
**Difficulty** — Medium · **Priority** — P0

---

## Phase 2 — Launch quality

*What makes it feel like a real product rather than a working one.*

### 2.1 URLs and routing
**Why** — No shareable event links, no deep links from email, and on mobile the back button exits the app. 1.6 makes this urgent: an email that says "you were selected" needs somewhere to point.
**Current** — `activeTab` state; events are modals.
**Recommended** — React Router. `/events/:id`, `/dashboard`, `/profile`, `/verify/:code`. Keep the modal presentation over the event route.
**Difficulty** — Medium · **Priority** — P1

### 2.2 The certificate verification page
**Why** — Every printed certificate says "Verify at wevolunteer.org/verify/CODE" and that page does not exist. This is the one artifact that leaves the platform.
**Current** — API exists; no UI.
**Recommended** — A public `/verify/:code` page: volunteer name, event, organizer, hours, date, confirmation. Rate-limit it. Also make the printed URL match the real deployed domain.
**Difficulty** — Small · **Priority** — P1

### 2.3 Retire the Equalizer or make the distinction explicit
**Why** — Two fairness mechanisms with different semantics, both described as fair, one offered on events using the other.
**Current** — `POST /api/events/:id/auto-approve`, surfaced as "Fill fairly".
**Recommended** — Remove it from Auto Select events at minimum. Better: retire it entirely and let Manual Review organizers sort the applicant list by hours ascending — the same fairness signal, with the organizer still making the decision, and one fewer mechanism to explain.
**Difficulty** — Small · **Priority** — P1

### 2.4 Explain Auto Select at the moment of the result
**Why** — Students are told how it works before applying and told nothing when the answer arrives. That is exactly backwards: the explanation matters most when the news is bad.
**Current** — "You were placed on the waitlist (Rank #4)."
**Recommended** — Attach a short plain-language explanation to the selection result: how many applied, how many spots, that selection was random and weighted toward students with fewer hours, and what the waitlist rank actually means. Publish the confirmed selection summary (applicants, accepted, waitlisted) on the event so it is checkable.
**Difficulty** — Small · **Priority** — P1

### 2.5 Show applicant counts to students
**Why** — Students cannot tell a shift nobody wants from one with forty applicants, so they cannot spread their applications sensibly.
**Current** — Only `spotsRemaining` (accepted only) is exposed.
**Recommended** — Show applicant count per slot before the deadline. It fits the seats motif without adding a second capacity device.
**Difficulty** — Small · **Priority** — P1

### 2.6 Day-of check-in view
**Why** — On the day, the organizer is on a phone at a park. Today's options are a desktop modal or a CSV download.
**Current** — Attendance is one flat list across the whole event.
**Recommended** — A per-shift, mobile-first check-in list filtered to the current day, with contact details and a large tap target per volunteer. Feeds the same attendance endpoint.
**Difficulty** — Medium · **Priority** — P1

### 2.7 Bulk applicant actions
**Why** — Thirty applicants is thirty clicks and thirty notifications.
**Current** — One `PATCH` per application.
**Recommended** — Multi-select with accept / waitlist / decline, one batched request, one grouped confirmation.
**Difficulty** — Small · **Priority** — P1

### 2.8 Report and moderate
**Why** — Every event carries an open discussion thread for minors, with no report button and no queue. Admins can only remove what they happen to see.
**Current** — Admins can delete individual comments.
**Recommended** — A report action on comments and events, a moderation queue in the admin dashboard, and the ability to lock an event's discussion. Keep it small and human — the volume will be low; the point is that a path exists.
**Difficulty** — Medium · **Priority** — P1

### 2.9 Onboarding for each role
**Why** — A new student lands on an empty dashboard. A new organizer lands on an empty events table. Neither is told what to do first.
**Current** — Empty states are decent; there is no first-run guidance.
**Recommended** — A dismissible first-run panel per role: three steps, in Field Notes voice, linked to the actual next action. For students, lead with how hours are earned — the panel on the dashboard is already the best copy in the product; surface it earlier.
**Difficulty** — Small · **Priority** — P1

### 2.10 Error handling that survives a bad network
**Why** — `apiFetch` throws strings into toasts; a failed refetch leaves the UI showing stale data with no indication.
**Current** — Ad-hoc `try/catch` in every component.
**Recommended** — A React error boundary around the shell, an offline/failed-refresh banner, retry on transient failures, and human-readable messages replacing raw server strings.
**Difficulty** — Small · **Priority** — P1

### 2.11 Accessibility completion
**Why** — The foundations are good; the gaps are concentrated in the highest-traffic controls.
**Current** — Tabs lack `aria-controls` / `id` pairing and arrow-key navigation; the hours meter is an unlabelled `div`; `BarChart` is `aria-hidden` with no text equivalent; `window.confirm` handles destructive actions; forms do not move focus to the first error on submit.
**Recommended** — Fix each of those. Then run axe on every screen and complete one keyboard-only pass of apply → accept → attend → certificate.
**Difficulty** — Medium · **Priority** — P1

### 2.12 Mobile pass
**Why** — Students are on phones. The organizer bottom bar carries six items; the primary organizer surface is a horizontally scrolling table; `EventModal` is a large desktop dialog.
**Current** — Responsive but not designed mobile-first.
**Recommended** — Collapse the organizer nav to five items with an overflow. Give the events table a card layout below the tablet breakpoint. Make `EventModal` full-screen on mobile.
**Difficulty** — Medium · **Priority** — P1

### 2.13 Split the two files nobody can hold in their head
**Why** — `server.js` (2824) and `EventModal.jsx` (1230) are where every remaining change has to land, and both are past the point of safe editing.
**Current** — One Express file; one modal handling view, edit, attendance, five tabs, and the full Auto Select flow.
**Recommended** — Split `server.js` into routers by domain (auth, events, applications, attendance, notifications, admin, selection) with a shared validation module. Split `EventModal` into `EventView`, `EventEdit`, `EventAttendance`, and `AutoSelectPanel`. Do this *after* Phase 1 lands — refactoring under a deadline is how bugs get shipped — but before Phase 3 starts.
**Difficulty** — Medium · **Priority** — P1

---

## Phase 3 — Post-launch

### 3.1 Targeted data fetching
**Why** — Every mutation refetches every event and every application. At district scale that is thousands of rows per click.
**Recommended** — Endpoint-level pagination and filtering; refetch only what changed. Measure before optimising further.
**Difficulty** — Medium · **Priority** — P2

### 3.2 Organizer analytics
**Why** — Organizers currently get counts. Repeat-volunteer rate, no-show rate by shift, and fill time would change how they schedule.
**Difficulty** — Medium · **Priority** — P2

### 3.3 District-level reporting
**Why** — School administrators will eventually need hours by grade, by school, and by student for award tracking — as an export, not a dashboard.
**Difficulty** — Medium · **Priority** — P2

### 3.4 Calendar export
**Why** — An `.ics` feed of confirmed shifts puts the commitment where students already look. Small, genuinely useful, no new concepts.
**Difficulty** — Small · **Priority** — P2

### 3.5 Recurring events
**Why** — Duplicate +7 days is a workaround for a real pattern (a weekly pantry shift). Only worth building once the demand is observed.
**Difficulty** — Medium · **Priority** — P3

### 3.6 Better recommendations
**Why** — Current matching is substring search of skills against title and description. Category and time-of-day affinity would be a real improvement.
**Difficulty** — Small · **Priority** — P3

### 3.7 District SSO
**Why** — Only if the district asks. Domain restriction plus email confirmation (1.4) solves the identity problem; SSO solves a convenience problem.
**Difficulty** — Large · **Priority** — P3

---

# WeVolunteer Launch Checklist

### Functionality
- [ ] Apply → accept → attend → hours → certificate verified end-to-end for both selection methods
- [ ] Withdraw, then successfully re-apply to the same shift
- [ ] Waitlist promotion fires on both Manual Review and Auto Select events
- [ ] Auto Select runs once and cannot be shopped; re-draws require a recorded reason
- [ ] Deadline passing notifies the organizer and escalates if ignored
- [ ] Multi-day event stays active until every shift has been attended
- [ ] Cancelled event disappears from every "upcoming" surface
- [ ] Attendance can be re-edited without erasing previously credited hours
- [ ] Editing an event cannot delete a shift that has attendance
- [ ] Certificate verification page resolves the code printed on the certificate
- [ ] Password reset works end-to-end
- [ ] Every notification kind that carries consequence also sends email

### Security
- [ ] Reset endpoint removed or admin-gated in production
- [ ] Demo bar and demo credentials absent from the production build
- [ ] Server refuses to boot without `JWT_SECRET`
- [ ] Rate limiting on auth endpoints; global limit in place
- [ ] `helmet` and a CORS allowlist configured
- [ ] Student signup restricted to district domain and email-confirmed
- [ ] Organizers can only view profiles and emails of their own applicants
- [ ] Leaderboard is opt-in and omits school and grade
- [ ] `deny` cannot delete anything but a pending organizer
- [ ] Admin can revoke an approved organizer without cascading deletes
- [ ] Dependency audit clean; HTTPS enforced

### Database
- [ ] Automated off-box backups running, with a completed restore drill
- [ ] `hours_ledger` audit table recording every attendance change
- [ ] `withdrawn` added to the application status constraint
- [ ] `auto_select_runs` included in any reset path
- [ ] Indexes verified against real query patterns under seeded load
- [ ] Migration path documented beyond `addColumnIfMissing`
- [ ] `node:sqlite` vs `better-sqlite3` decision made and recorded

### Backend
- [ ] Validation layer covering all event and slot temporal and numeric rules
- [ ] Attendance is an upsert; no implicit deletion of `present = 1` rows
- [ ] Attendance rejected for shifts that have not ended
- [ ] Dead code removed (`scheduler.js`, `processEventSelection`)
- [ ] `server.js` split into domain routers
- [ ] Structured logging and a health check endpoint
- [ ] Vitest suite covering weighting, selection, and the hours pipeline

### Frontend
- [ ] Routing with real URLs for events, dashboard, profile, and verification
- [ ] Error boundary and offline/stale-data handling
- [ ] `EventModal` split into focused components
- [ ] Loading and empty states on every async surface
- [ ] Destructive actions use in-app confirmation, not `window.confirm`
- [ ] Field Notes rules verified: amber only for hours, one capacity device, correct terminology throughout

### Accessibility
- [ ] Keyboard-only pass through apply → accept → attend → certificate
- [ ] Screen reader pass on dashboard, event detail, and attendance
- [ ] Tabs expose `aria-controls` and support arrow-key navigation
- [ ] Hours meter exposes `role="progressbar"` with value and label
- [ ] Charts have a text equivalent
- [ ] Focus moves to the first error on failed form submission
- [ ] axe clean on every screen; contrast re-verified against the paper background

### Mobile
- [ ] Full student journey completed on a phone
- [ ] Organizer check-in completed on a phone at an event
- [ ] Organizer navigation fits without crowding
- [ ] Tables become cards below the tablet breakpoint
- [ ] Modals are full-screen on mobile
- [ ] Tap targets ≥ 44px; no horizontal page scroll

### User testing
- [ ] 5+ students complete signup → discovery → apply unaided
- [ ] 3+ organizers create an event and take attendance unaided
- [ ] 1+ administrator completes approval and moderation unaided
- [ ] One full pilot event run end to end with real volunteers
- [ ] Students can explain, in their own words, how Auto Select chose them
- [ ] Organizers can explain what happens when they take attendance

### Documentation
- [ ] Student guide: applying, Auto Select, hours, certificates
- [ ] Organizer guide: building a sheet, choosing a selection method, taking attendance
- [ ] Administrator guide: approvals, moderation, corrections, escalation
- [ ] Auto Select fairness explained publicly, in plain language
- [ ] Privacy notice covering what is collected about minors, who sees it, and retention
- [ ] Runbook: deploy, restore from backup, rotate secrets, correct an hours record
- [ ] `README.md` and `CLAUDE.md` updated to reflect the launch architecture

### Deployment
- [ ] Production build serves the client and API together
- [ ] Environment variables documented; no secrets in the repository
- [ ] Staging environment mirroring production
- [ ] Backups verified by an actual restore
- [ ] Uptime and error monitoring with alerting
- [ ] Rollback procedure tested
- [ ] Domain, HTTPS, and the certificate verification URL all consistent

---

# Recommended implementation order

Ordered so that each block leaves the app in a shippable state, and so that nothing is built on top of something that is about to change underneath it.

**Block 1 — Stop the bleeding (days)**
1.1 reset endpoint → 1.2 demo scaffolding → 1.3 auth hardening → 1.16 deny scoping.
Four small changes that remove every way to destroy or trivially compromise the system. Do these before anything else touches the code.

**Block 2 — Protect the record (1–2 weeks)**
1.7 non-destructive attendance and the hours ledger → 1.8 safe event edits → 1.19 tests for weighting and the hours pipeline.
Hours are the product. Make them impossible to lose, then write the tests that keep them that way. Tests come here, not later, because everything after this changes code that touches hours.

**Block 3 — Identity and reach (2–3 weeks)**
1.6 email → 1.4 domain restriction and confirmation → 1.5 password reset.
Email first because 1.4 and 1.5 both depend on it. This block is what makes the platform usable by someone who is not already looking at it.

**Block 4 — Fix the workflows (1–2 weeks)**
1.11 withdrawal → 1.12 waitlist promotion → 1.13 cancelled events → 1.14 multi-day completion → 1.9 deadline escalation → 1.10 single-draw Auto Select.
The application lifecycle, made correct end to end. 1.9 and 1.10 last because both touch the selection code and both benefit from the lifecycle being settled first.

**Block 5 — Close the gate (days)**
1.15 minors' data → 1.17 server-side validation → 1.18 deployment path.
The last three things standing between the code and a real environment.

→ **Pilot here.** One organizer, one real event, one full cycle, with an admin watching. Ship nothing else until that event's hours are on a certificate.

**Block 6 — Launch quality (2–3 weeks)**
2.1 routing → 2.2 verification page → 2.4 Auto Select explanation → 2.3 retire the Equalizer → 2.11 accessibility → 2.12 mobile → 2.9 onboarding → 2.10 error handling.
Routing first because 2.2 needs it and email links need it. Accessibility and mobile before onboarding, so onboarding is written against the final layout.

**Block 7 — Organizer tooling (1–2 weeks)**
2.6 day-of check-in → 2.7 bulk actions → 2.5 applicant counts → 2.8 reporting and moderation.

**Block 8 — Pay down the debt (1 week)**
2.13 split `server.js` and `EventModal.jsx`.
After the launch surface is settled and the tests exist to catch what the split breaks.

**Then** Phase 3, in the order the pilot's evidence justifies — not in the order written here.

---

## Open decisions

Three questions change the plan and only you can answer them:

1. **Is there a district email domain and a way to send mail from it?** 1.4 and 1.6 both assume yes. If not, identity verification needs a different design — most likely admin-issued invitations.
2. **Who is the real administrator?** The admin role currently assumes an engaged staff member who checks a queue. If that person does not exist, approvals and moderation need to route somewhere that does.
3. **What is the pilot event?** Everything in Block 1–5 should be validated against one real event with real students before a district-wide launch. Choosing it now shapes what gets tested.
