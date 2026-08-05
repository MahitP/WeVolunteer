# Implementation log — 2026-08-05

What was actually built, what was found while building it, and what is still open.
Test suite at the end: **154 files, 2489 tests, all passing.** Lint clean, build clean,
migration checksums clean. Baseline before this work: 152 files, 2441 tests.

---

## Shipped

### A11Y-1 — input contrast (Phase H) ✅

`--input-border` split from `--rule-strong`, which it used to alias. Light `#828b99`
(3.35:1 on `--surface`), dark `rgba(199,208,203,0.46)` (3.28:1 over the composited input
background). `--rule-strong` is untouched — its other consumers are decorative separators
where the subtlety is correct.

**The value in my own earlier spec was wrong.** `#8c95a1` measures **2.95:1** — just under
the 3:1 bar. Caught only by computing it. `src/inputContrast.test.js` now recomputes the
ratios from the token values, composites the translucent dark-mode ones over their real
backdrop, and fails the build on regression — including a guard that fails if anyone
"simplifies" `--input-border` back to the alias.

### Messaging scope (Phase E) ✅ — and a correction

**My previous finding R-03 was wrong.** I reported that the organizer path "never checks
that the student applied." It does, at `relationship.length === 0` in
`eligibleRelationship()`. I read the capability cascade and stopped before the check that
follows it. The rule was correct all along and merely **untested**.

What re-verification *did* find, and fixed: the path answered `404 'Volunteer not found'`
for an unknown id and `403 'Messaging unlocks…'` for a real student who had not applied.
No conversation opened either way, but the pair was an **existence oracle** — an organizer
could walk arbitrary ids against an event they host and read off which belong to students.
Both now return the same 403 for non-staff. Staff keep the precise 404, since
`event.moderate` already grants a full user view.

`server/messaging.applicantScope.test.js` — 8 tests covering the applicant rule, ownership,
withdrawal, the student path, the admin exception, and enumeration.

### Suspension (Phase F3) ✅

The gap that made every other safety control theoretical: `user.suspend` was a registered
capability with no route, and `account_status = 'suspended'` was a value sign-in refused
but nothing wrote.

- `POST /api/admin/users/:id/suspend` and `/unsuspend`, `requireCap('user.suspend')`
- Mandatory reason (≥10 chars) — the user is told why, and it is what an appeal is
  reviewed against
- **`token_version` bump**, which is the half that matters: setting the status alone would
  block the next sign-in and leave every issued cookie working for up to seven days
- Audit rows both ways; suspension record survives reinstatement
- Privilege guard expressed as capabilities, never role strings (guard 1 caught my first
  attempt): nobody may suspend a super admin; only a super admin may suspend an admin
- Organizers are **suspended, never deleted** — `ON DELETE CASCADE` would take their
  events and their volunteers' attendance rows with them
- Active events are **reported, not auto-cancelled**: cancelling as a side effect of
  moderation would strand accepted volunteers

`server/routes.suspension.test.js` — 21 tests, including that a session issued *before*
suspension stops working.

### Consent (Phase A) ✅ — server-enforced, both paths, and a third

**The starting position:** `Signup.jsx` rendered and validated a privacy checkbox, and
`baseFields()` — the object actually POSTed — did not include it. It never left the
browser. The control was also wrapped in `{PRIVACY_URL && …}` with an empty default, so a
stock build rendered nothing. WeVolunteer held no evidence any user had agreed to anything.

Built:

- **Migration 007** — `legal_documents` (catalogue, immutable per version) and
  `legal_acceptances`. `content_hash` is denormalised onto the acceptance row so the record
  is self-proving if the catalogue is later edited. `ON DELETE RESTRICT`.
- **`server/legalDocuments.js`** — registry with pinned sha256 per document, verified
  against the published files by a build-failing test. `bin/legal-hashes.mjs` refreshes
  them, mirroring `bin/migration-checksums.mjs`.
- **`server/consent.js`** — `assertConsent` (`=== true`, not truthiness: `"false"` is
  truthy), `recordAcceptances` (called **inside the caller's transaction**), `ipPrefix`
  (/24, /48 — never a full address), `uaFamily` (family string — never the raw header),
  `syncLegalDocuments` (throws if a published version's hash changed).
- **Two checkboxes, not one or four.** Terms = *agree* (a contract). Privacy =
  *acknowledge* (a disclosure — you cannot "agree" to a privacy notice). Community
  Guidelines share the Terms box but get their own acceptance row.
- **`PRIVACY_URL` now defaults to `/privacy`.**

**A third account-creation path was found while wiring this up.** Beyond the password form
and `POST /api/auth/signup` with a `signupToken`, `oauthRoutes.js:547` INSERTs into `users`
directly from a pending `signupData` blob. It had no consent gate and no acceptance
recording — an ungated door that would have made the whole record worthless. Now gated at
the point `signupData` is accepted (before the provider redirect, so a refusal costs the
user nothing) and recorded in the same transaction as the account.

`server/consent.test.js` — 25 tests, including that a failed signup leaves **no orphan
acceptance rows** and that the OAuth path records too.

### Age gate (Phase D) ✅

`grade` accepted `'9'`–`'12'`, `'Adult'`, `'N/A'`, and nothing else about age was collected.
Under-13 accounts were not merely possible — nothing could have noticed one.

- **Migration 008** — `users.date_of_birth`, nullable (existing accounts are grandfathered,
  not guessed at)
- `validateDateOfBirth` + `ageOn` in `accountValidation.js`. **Calendar comparison, never
  divided days** — `(now - dob) / 365.25` is wrong around leap years, which on a hard
  13-year boundary admits or refuses a child depending on which February they were born in
- Refuses a **missing** date rather than defaulting: "probably an adult" is not a finding
- **Never echoes the computed age back.** A message like "you must be 13, you are 12"
  teaches the child which year to retype
- Enforced on all three creation paths; `grade: 'Adult'`/`'N/A'` cannot bypass it

`server/ageGate.test.js` — 18 tests including leap-year and birthday boundaries.

**This is coupled to a product decision.** The amended COPPA Rule forbids retaining a
child's data indefinitely; certificates and hours are retained indefinitely by design.
"No child is here" is the premise that makes that retention lawful — the age gate is not a
separate compliance item, it is what licenses the retention decision.

---

## Not built — honest status

| Phase | Status |
|---|---|
| **B — Legal Center** | **Not built.** Documents exist in `docs/legal/policies/`; no `/legal` routes, no hub, no search, no version display. Design and handoff specs are complete (docs 02, 04, 07) |
| **C — Policy update system** | **Partially.** Versioning, hashing, and immutability are enforced; the re-consent middleware, interstitial, and 14-day read-only grace are **not** built |
| **F1 — Reporting** | Pre-existing conversation reports + admin queue only. No reporting of users, organizers, or events |
| **F2 — Blocking** | **Not built.** Still a P0 |
| **F4 — Appeals** | **Not built** (documented inbox procedure only) |
| **F5 — Evidence preservation** | Partial: `RESTRICT` protects consent rows; no message redaction or tombstones |
| **G — Organizer accountability** | **Not built.** `organizer_agreements` table and gating on `organizer.approve` remain P0 |
| **I — Retention enforcement** | **Not built.** No purge jobs for messages (3y), audit logs (1y), or anonymised shells (3y). The published retention table is therefore aspirational |

---

## Risks remaining

1. **Guardian consent (R-27) is not built.** With no district, it is the only mechanism that
   makes a minor's assent enforceable. Highest-value remaining item after blocking.
2. **Blocking (R-21) is not built.** A student who feels unsafe still has no control they
   hold themselves.
3. **Organizer Agreement is not recorded (R-04).** Adults still receive minors' contact
   details under no written undertaking.
4. **Retention is published but not enforced (I).** Documents now state periods that no job
   implements — a §5 exposure created by writing the policy ahead of the code. Either build
   the jobs or mark those rows as target-state before publishing.
5. **Documents remain unpublishable.** The ⚠️ blocks in `policies/` still describe
   capabilities that do not exist — though suspension and the applicant rule can now be
   un-flagged.
6. **`legal_acceptances` has no retention rule.** Specified as account life + 6 years;
   nothing enforces it.
7. **Existing accounts have no `date_of_birth` and no acceptance rows.** They are
   grandfathered. A backfill campaign (re-consent at next login) is the Phase C work.

---

## Follow-ups, in the order I would do them

1. **Blocking** (~2–3d) — the missing student-held control
2. **Guardian email capture + verification** (~3–5d) — restores enforceability
3. **`organizer_agreements` + gate `organizer.approve`** (~1–2d) — closes R-04
4. **Retention purge jobs** (~2–3d) — makes the published table true
5. **Re-consent middleware + interstitial** (~3d) — makes versioning operational
6. **Legal Center `/legal`** (~1w) — makes any of it discoverable
7. **Un-flag the ⚠️ blocks** for suspension and the applicant rule, which are now real

---

## Notes for the next person

- **Line-anchored guard exceptions are brittle.** `authz.completeness.test.js` anchors
  reviewed exceptions to `file:line`, and three separate edits shifted them. The guard
  catches it every time, which is the design working — but expect to re-anchor after any
  edit to `authRoutes.js`, `oauthRoutes.js`, or `Signup.jsx`.
- **Order matters in `initDatabase()`.** `runMigrations` runs last, so a column added by
  `addColumnIfMissing` exists *before* migration 001 rebuilds `users` — and 001's
  unknown-column guard correctly refuses it. New `users` columns go in a versioned
  migration ordered after 001. Both 006 and 008 record this.
- **`TEST_SIGNUP_DEFAULTS`** (`server/testConsent.js`) is what a valid signup payload needs
  beyond its own fields. It lives in a module that never reaches `db.js`, so suites which
  must control the database path can import it statically. `call()` deliberately does
  **not** inject it — a harness that quietly supplied consent would make a future test of
  the consent gate pass while testing nothing.

---

# Session 2 — 2026-08-05 (later)

**Suite: 156 files, 2517 tests, all passing.** Lint, build, migration checksums, and document
hashes all clean. Previous session ended at 154 / 2489.

## Shipped

### Blocking ✅ — migration 009, `server/blocking.js`, 16 tests

The only safety control a student holds themselves; everything else required trusting a human
to respond.

- `POST/DELETE /api/blocks/:userId`, `GET /api/blocks`
- **Closes existing conversations, not just new ones.** `eligibleRelationship` guards only the
  opening of a conversation — a block that stopped there would do nothing for the thread the
  student is already in, which is the only one they care about. Enforced separately on the send
  path.
- **Deliberately asymmetric.** Students block; organizers cannot. An organizer able to block
  could sever the channel a student would use to complain about them. Gated by capability
  (`event.apply`), never a role string.
- **Costs the student nothing.** Does not withdraw them from the event or touch credited hours,
  both asserted. A safety control that cost a student their service record would force them to
  weigh feeling unsafe against graduation.
- Refusals are phrased identically to the ordinary no-relationship refusal, so a block is never
  announced back to the blocked party.
- Raises a moderation signal (`USER_BLOCKED` audit row) — students block far more often than
  they report, and several students blocking one organizer is a pattern nobody would otherwise
  see.

### Retention enforcement ✅ — `server/workers/retentionWorker.js`, 12 tests

Closes the §5 exposure created last session by publishing periods nothing implemented.

- Messages 3y, audit logs 1y, anonymised shells 3y. Daily sweep, wired into `server.js` startup
  and drained in `shutdown.js`.
- **`sweep()` takes `now`**, so every boundary is an ordinary unit test rather than something
  that reproduces in production three years from now.
- **Reported messages are exempt.** An investigation opened at two years and eleven months
  would otherwise find its evidence deleted underneath it.
- **Shells with a service record are never purged** — the FK would cascade attendance away.
- `assertPreservedTablesUntouched` makes "certificates and hours are kept for ever" an
  assertion rather than a convention. It runs after every sweep and has its own test.

### Documents reconciled ✅

All four ⚠️ blocks removed — three described suspension as unbuilt (false since last session),
one described blocking (false as of this one). The under-13 section of the Privacy Policy is
published, since the age gate it was waiting on exists. Youth Safety gained a student-facing
blocking section.

**Documents bumped to v1.1, classified MINOR** (notice only, no re-consent): nothing was taken
away and nothing new is collected. The content-hash guard caught the drift and forced the
classification, which is the system working as intended.

## Still not built

Reporting beyond conversations · moderator dashboard · appeals workflow · message redaction ·
organizer agreement acceptance · Legal Center · re-consent middleware and read-only mode ·
privacy request workflow · guardian consent.
