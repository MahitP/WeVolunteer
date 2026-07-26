# SBVolunteers — Product Quality Roadmap (Milestone 4)

**Date:** 2026-07-25
**Baseline:** `v1.0.0-pilot` (`7fc79cd`) — 241 tests, clean build, Phases 1–3 merged.
**Nature of this milestone:** This is *not* a continuation of security hardening. That programme is complete. This milestone is about whether real students and organizers can actually *use* the thing — accessibility, mobile, clarity, and the rough edges the hardening work itself introduced.

**Method:** every finding below was re-derived by reading the current code at `7fc79cd`, not carried over from earlier audit notes. Where an old backlog item no longer applies, it is listed as closed with the reason.

---

## Framing: what changed about the risk profile

The first audit asked "can this platform be trusted with minors' data?" That question is answered. The remaining risk is different in kind: **the platform is now correct but not yet comfortable.** Nothing below can leak a student's address or destroy credited hours. What these issues do is make people give up, ask for help, or quietly mis-use a feature — which for a volunteer programme is its own kind of failure, just a slower one.

Two consequences shape the prioritisation:

1. **Accessibility is the one category with a legal and ethical floor**, not just a UX preference. A public school district in New Jersey is subject to Section 504/ADA expectations. An organizer or student using a screen reader is not an edge case here.
2. **The hardening work introduced its own paper cuts.** Three items below (P2-1, P2-2, P2-9) exist *because of* Phases 1–3. Those deserve priority precisely because we created them.

---

## Closed from the original backlog (verified, no longer applicable)

| Original item | Status at `7fc79cd` |
|---|---|
| `--brand-shade` undefined | **Closed** (Task 12) — and 9 further undefined tokens fixed, with a guard test preventing recurrence |
| `/health` returns SPA HTML in production | **Closed** (Task 11) |
| SQLite not production-tuned | **Closed** (Task 13) — WAL + 5s busy_timeout |
| Malformed input → 500 with driver internals | **Closed** (Task 13) — 400s on the three affected routes |
| Test isolation an undeclared default | **Closed** (Task 13) — pinned, and verified load-bearing |
| Certificate verify full-table scan | **Closed** (Task 10) — indexed single-row lookup |
| Check-in roster includes withdrawn/rejected | **Verified still open** — carried below as P3-4 |

---

# P2 — Recommended before wider rollout

Ordered by the sequence I recommend implementing them, not by raw severity.

### P2-1 · Bulk applicant actions report a count the server did not perform
**Category:** usability / correctness-of-communication · **Introduced by:** Phase 2 (Task 9's sibling, the bulk endpoint)
**Evidence:** `src/components/EventModal.jsx:349` — `addToast(\`${appIds.length} volunteer(s) ${verb}.\`)`. The server returns `{ updated, applied, skipped }` and legitimately skips applicants when a slot hits capacity. An organizer selecting 40 for a 30-spot shift is told "40 volunteers accepted" when 30 were.
**Impact:** The organizer believes ten students are confirmed who are not. They will not discover it until someone doesn't show up. This is the single most consequential *non-security* defect remaining.
**Fix:** Use the server's `updated` count, and surface `skipped` with its reason ("30 accepted — 10 skipped, shift full").
**Difficulty:** Trivial (one file). **Impact:** High.

### P2-2 · The leaderboard is now invisible with no explanation
**Category:** usability · **Introduced by:** Phase 1 (Task 5, opt-in default-off — correct privacy call, incomplete product follow-through)
**Evidence:** `src/views/VolunteerDashboard.jsx:327` renders the block only `{leaderboard.length > 0 && …}`. Since every student defaults to `leaderboard_opt_in = 0`, the section silently does not exist. The only way to opt in is a checkbox inside the profile-edit modal (`ProfileEditModal.jsx:133`) that a student has no reason to open.
**Impact:** A feature that exists in the code is functionally dead for every user. Either it should be discoverable or it should be removed — the current state is the worst of both.
**Fix:** Render the section with an explanatory empty state and an inline opt-in ("Community leaderboard is opt-in — show my name?"). Keep default-off.
**Difficulty:** Small. **Impact:** Medium-high.

### P2-3 · No error boundary — a render error blanks the entire app
**Category:** production readiness
**Evidence:** `grep -rln "componentDidCatch\|ErrorBoundary\|getDerivedStateFromError" src` → no matches. `EventModal.jsx` is 1,521 lines and handles view/edit/attendance/Auto Select; any throw inside it white-screens the whole application with no recovery path.
**Impact:** A single unhandled render error becomes "the website is broken" for that user, with no way back short of a manual reload. On a phone, mid-event, that is the organizer losing their check-in tool.
**Fix:** One error boundary around the shell with a "something went wrong — reload" panel; optionally a second around `EventModal`.
**Difficulty:** Small. **Impact:** High.

### P2-4 · Incomplete ARIA tab pattern (worse than no ARIA at all)
**Category:** accessibility
**Evidence:** `EventModal.jsx:915-931` uses `role="tablist"` / `role="tab"` / `role="tabpanel"`, but there are **zero** `aria-controls` in the codebase and no arrow-key handler on the tablist. A partial tab pattern tells assistive tech "this is a tab widget", then fails to honour the contract: no panel association, no roving focus.
**Impact:** A screen-reader user is told to expect tab semantics and gets broken ones. This is the case where half-implemented ARIA is actively worse than plain buttons.
**Fix:** Add `id`/`aria-controls`/`aria-selected` pairing and arrow-key navigation, or drop the roles and use buttons honestly.
**Difficulty:** Small. **Impact:** High (accessibility floor).

### P2-5 · Hours meter has no accessible value
**Category:** accessibility
**Evidence:** `role="progressbar"` appears **0 times**; the meter is styled divs (`.meter-fill`, `index.css:695`). The single most important number in the product — a student's progress toward the 25-hour Silver Award — is invisible to a screen reader except as loose text.
**Fix:** `role="progressbar"` with `aria-valuenow/valuemin/valuemax` and an accessible label.
**Difficulty:** Trivial. **Impact:** Medium-high.

### P2-6 · Touch targets below the 44px guideline
**Category:** mobile
**Evidence:** `.btn` is `padding: 0.5rem 0.875rem` at `0.875rem` font (~33px tall); `.btn-sm` is `0.3125rem 0.625rem` (~26px). `index.css:490,548`. These are the accept/waitlist/decline controls in applicant review and the check-in toggles — the exact things used one-handed on a phone at an event.
**Fix:** `min-height: 44px` on interactive controls at touch breakpoints.
**Difficulty:** Small. **Impact:** Medium-high (organizer day-of experience).

### P2-7 · Eight `window.confirm` dialogs for destructive actions
**Category:** usability / accessibility
**Evidence:** 8 occurrences across `EventComments`, `OrganizerDashboard`, `AdminDashboard`, `EventAnnouncements`, `EventModal`, `VolunteerDashboard`.
**Impact:** Native dialogs cannot be styled, read poorly on mobile, are inconsistent with the Field Notes system, and give no room to explain consequences ("this will remove 12 sign-ups").
**Fix:** Use the existing `Modal.jsx` (already provides focus containment, Escape, scroll lock).
**Difficulty:** Small-medium (8 sites, mechanical). **Impact:** Medium.

### P2-8 · Charts are unreadable to assistive tech
**Category:** accessibility
**Evidence:** `BarChart.jsx` renders SVG; admin stats and the volunteer dashboard rely on it for hours-by-month and participation.
**Fix:** A visually-hidden table or summary sentence alongside each chart.
**Difficulty:** Small. **Impact:** Medium.

### P2-9 · Check-in roster includes non-attending applicants
**Category:** organizer workflow
**Evidence:** `GET /api/events/:id` (added in Task 9) returns *all* applications; `CheckInView.jsx:36` filters to `accepted` client-side, but the payload still ships withdrawn/rejected/waitlisted applicants to the device.
**Impact:** Minor today (client filters correctly) but it sends more student data to the phone than the screen needs — and a future consumer of that endpoint could display the wrong roster.
**Fix:** Filter server-side to accepted, or make the status filter an explicit query parameter.
**Difficulty:** Trivial. **Impact:** Low-medium (data minimisation).

---

# P3 — Nice to have

### P3-1 · `/api/applications` scans the whole attendance table per request
`applicationRoutes.js:51` loads every attendance row into a Map on every call, even for a student with two applications. Fine at pilot scale (hundreds of rows); quadratic-feeling at district scale. **Small; measure before optimising.**

### P3-2 · Full refetch on every mutation
`App.jsx:139,158` — any `onStateChange()` refetches *all* events and *all* applications. Simple and correct; wasteful once there are thousands of rows. **Medium.**

### P3-3 · `EventModal.jsx` is 1,521 lines
Handles view, edit, attendance, applicant review, and the whole Auto Select flow. It is the file every future change lands in and the reason P2-3 (error boundary) matters so much. **Medium; do it after the P2 work, not before — refactoring under a deadline is how bugs ship.**

### P3-4 · Organizer mobile navigation crowding, tables don't collapse
Six nav items on the organizer bottom bar; 4 `<table>` elements that scroll horizontally below the tablet breakpoint. **Medium.**

### P3-5 · Bundle is 465 kB (130 kB gzipped), unsplit
No route-level code splitting. Acceptable, but the certificate/verification page — the one a school office loads cold — pulls the entire app. **Small (lazy-load routes).**

### P3-6 · Deep-link and back-button polish
Routing exists (Task 11-era work), but modals are URL-driven via query params; some flows still don't restore cleanly. **Medium.**

### P3-7 · No `--success`-style status token audit
The token guard now prevents *undefined* tokens, but the palette has near-duplicates (`--ok`/`--brand`, `--warn`/`--accent`) whose distinct meanings are documented only in comments. **Small; documentation-level.**

---

## Recommended implementation order

**Block A — the paper cuts we created (half a day)**
P2-1 → P2-2 → P2-9. These exist because of Phases 1–3. Fixing them first is both cheapest and most honest: we should not ship a milestone that degraded organizer clarity in the name of security.

**Block B — accessibility floor (2–3 days)**
P2-4 → P2-5 → P2-8. Grouped because they share a mental context and should be validated in one screen-reader pass rather than three. This is the block with an external standard attached.

**Block C — resilience and touch (1–2 days)**
P2-3 → P2-6 → P2-7. The error boundary first, since it protects everything else; then the physical-interaction fixes, verified on a real 375px viewport.

**Then reassess.** P3 items should be re-prioritised *after* the pilot produces evidence. Specifically: do not do P3-1/P3-2 (performance) until real usage shows a problem — at pilot scale they are invisible, and optimising without measurement is how the original `EventModal` got to 1,521 lines.

**Explicitly not recommended now:** the `EventModal` split (P3-3). It is the right eventual move, but it touches every organizer surface and should follow the P2 work, with the test suite grown first.

---

## What would make me change this order

- **If the pilot surfaces a screen-reader user**, Block B moves ahead of Block A immediately.
- **If an organizer reports a wrong roster**, P2-1 becomes P0 for that cohort.
- **If the district asks for a public launch date**, P3-5 (bundle splitting) and P3-4 (mobile tables) rise, because first-load and phone use dominate public traffic in a way they don't in a controlled pilot.

## Success criteria for this milestone

1. An organizer can run an event end-to-end on a phone without hitting a sub-44px control or a native dialog.
2. A keyboard-only pass through apply → accept → check-in → certificate completes without a trap.
3. No toast tells a user something the server did not do.
4. A thrown render error shows a recovery panel, not a blank page.
5. Test count grows with each fix — every item above is testable, and the P2 items should not merge without one.
