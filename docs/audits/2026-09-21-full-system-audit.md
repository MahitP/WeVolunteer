# WeVolunteer — Full-System Audit and Product Reconstruction

**Started:** 2026-09-21
**Baseline commit:** `45a2230` (local `main`)
**Purpose:** answer one question — *is the current WeVolunteer the product it was
intended to be?* — and fix what is not.

This document is the master ledger. It is maintained across the whole
engagement; phases append to it rather than replacing it.

---

## Phase 0 — State reconstruction

Everything in this section was established by inspecting the repository and by
running commands, not by reading a previous audit's conclusions.

### 0.1 Git state

| Fact | Value |
|---|---|
| Branch | `main` |
| Commit | `45a2230` |
| Working tree | clean |
| Total commits | 927 |
| Local `main` vs `origin/main` | **53 ahead, 0 behind** |
| Other local branches | none |
| Remote | `github.com/MahitP/WeVolunteer.git` |

**Note, not a finding:** 53 commits exist only on this machine. That is the
stated working policy (autonomous runs commit locally and never push), so it is
recorded rather than acted on — but it does mean the only copy of roughly two
weeks of work is this laptop.

### 0.2 Actual current architecture

Determined from the repository. **The old roadmap's stack is not the current
stack.** Specifically: there is no Vercel, no Clerk, no Stripe.

| Layer | What is actually there |
|---|---|
| Client | React 19 + React Router 7, built by Vite 8. SPA. |
| Server | Express on Node ≥24 <25, single process, `API_PORT` (default 5050, *not* `PORT`) |
| Database | **Dual-engine.** SQLite (`node:sqlite`) by default; PostgreSQL implemented, boot-tested and `POSTGRES_READY`, selected by `DATABASE_ENGINE=postgres`. **Not cut over** — that is an owner decision. |
| Migrations | 68 files in `server/migrations/`, plus additive idempotent guards at init |
| Realtime | Socket.IO |
| Hosting | **Self-hosted on an Oracle VM**: systemd unit + nginx + Cloudflare in front (`deploy/`). Provisioned by `deploy/provision.sh`. Releases are deployed as tags. |
| Postgres host | Supabase (`deploy/certs/supabase-root-2021.crt`, `supabase/migrations/`) |
| Background work | in-process workers + scheduler (`server/workers/`) |
| AI | on-device via `@wllama/wllama` |
| CI | one workflow, `.github/workflows/ci.yml` |

### 0.3 External services actually wired

All have credentials present in the development `.env`.

| Service | Purpose | Code |
|---|---|---|
| Resend | transactional email (+ signed webhook) | `server/integrations/`, `webhookRoutes.js` |
| Google OAuth | sign-in | `server/oauth/providers/` |
| Apple Sign-In | **deliberately not implemented**, labelled "coming soon" | `server/oauth/providers/apple.js` |
| Amplitude | analytics, opt-in, off by default | `server/integrations/amplitude.js` |
| Better Stack | logs + uptime + heartbeats | `server/integrations/betterstack.js` |
| Pinecone | discovery/recommendation vectors | `server/search/` |
| Upstash Redis | distributed rate limiting, caches, leader leases | `server/redis/` |
| OpenTelemetry | tracing | `server/observability/` |
| CARTO / OpenStreetMap | map tiles, **proxied server-side** at `/tiles` | `tileRoutes.js` |

### 0.4 Scale

| Measure | Value |
|---|---|
| Client files (js/jsx) | 495 (116,895 lines) |
| Server files (js) | 672 (199,991 lines) |
| Test files | 634 |
| Client routes declared | ~60 in `src/routes/index.jsx` |
| Server route modules | 34 in `server/routes/` |
| Migrations | 68 |

### 0.5 Baseline verification — run, not quoted

```
npm test   →  633 test files passed, 10 skipped
              10,742 tests passed, 0 failed, 176 skipped
              205.93s, exit 0
```

This is the regression baseline for the whole engagement. Any later run that
does not reach these numbers is a regression introduced by this work.

### 0.6 Unfinished-work scan

Searched `src/` and `server/` (excluding tests and `node_modules`) for `TODO`,
`FIXME`, `HACK`, `XXX`, "coming soon", "not implemented", "stub",
"placeholder", "temporarily", "for now".

**Result: effectively clean.** One `TODO` in the entire product codebase, and it
is a documentation example inside `src/utils/policyMarkdown.js` describing how a
policy placeholder is rendered. Every "stub", "coming soon" and "not
implemented" hit is an explanatory comment recording a past decision, not
outstanding work. The single genuine unimplemented feature — Apple Sign-In — is
explicit, isolated behind a provider module, and labelled in the UI.

### 0.7 Repository hygiene

- No `.db` file and no populated `.env` is tracked. `.gitignore` covers `*.db`,
  `.env` and `scratch/`. Only `.example` templates and `.env.development` are
  tracked, and `.env.development` contains one public Vite flag with a comment
  explaining why nothing secret may go in it.
- `scratch/` no longer holds project copies (6 MB of accessibility test
  databases, 0 test files), so the `vitest` exclusion is no longer load-bearing
  for the reason it was written — but it costs nothing and the reasoning is
  recorded, so it stays.

### 0.8 Findings from Phase 0

#### P0-1 · The knowledge graph is stale and covers 2% of the codebase — **severity: process**

`CLAUDE.md` instructs that the knowledge graph be queried before reading files.
The graph in `graphify-out/` was last built **2026-07-27** and its cost record
shows it indexed **28 files**. The repository has **1,167** source files, and
since that build there have been **859 commits changing 1,473 files
(+434,923 / −8,914 lines)**.

Relying on it would produce confidently wrong architecture. **Decision: it is
not used as an authority for this audit**; the repository itself is the
evidence, which is also what the engagement brief asks for. Rebuilding it is
recorded as optional work rather than done automatically, because a rebuild over
1,167 files is a large operation whose payoff for this audit is unproven.

#### P0-2 · The referenced historical product material was not supplied — **severity: blocking for one deliverable**

The brief's §57 says "the following material is the complete historical context I
am providing" and refers to "numerous highly specific historical UI/UX
requirements in the supplied product history". **No such material follows** —
§57 contains only a list of topic headings.

This does not block the audit. The repository carries its own extensive
historical record — `docs/history/`, `docs/spec/`, `docs/specs/`,
`docs/audits/`, `docs/legal/`, `CHANGELOG.md` — and that record is stronger
evidence than a recollection would be, so the requirements ledger is being built
from it.

It does mean the ledger cannot be *complete* with respect to the specific
sentence-level UI requests the brief describes. Those are the one input that
cannot be recovered from the repository.

**Status: UNRESOLVED.** Still outstanding as of the notification fix
(`ece14c6`). No requirement in this ledger has been reconstructed from
recollection to fill the gap, and none will be: a remembered requirement is
indistinguishable from an invented one, and this document's whole value is that
its claims are traceable. Every entry here cites the repository or a command
that was run. If the material arrives it will be folded in as a new source; if
it does not, the gap stays recorded as a gap.

---

## Phase 1 — Product and feature completeness audit

In progress. Findings are appended as each area is examined.

### How to read a finding here

Every finding carries one of two evidence grades, and the difference is not
cosmetic:

- **Verified** — I read the code paths myself and can name the file and line
  that makes the claim true. Where a fix has landed it was additionally
  mutation-checked: the fix was reverted and the new test watched to fail.
- **Reported** — surfaced by a parallel investigation and recorded with its
  evidence, but **not yet independently confirmed**. No `Reported` finding is
  acted on until it is promoted to `Verified`.

Nothing in this document is graded on whether a previous audit, comment or test
name asserted it.

---

### 1.1 Welly — an event title could become a live link in the assistant's voice

**Grade: Verified. Severity: High. Category: B (missing implementation).
Status: FIXED — `02480a6`.**

`src/components/ai/WellyMessage.jsx` rendered `[text](https://…)` and bare URLs
as anchors. Welly has no legitimate link to emit, so every anchor it could draw
came from user-authored content interpolated into one of its own deterministic
sentences.

**The reachable payload.** An organizer names an event:

```
Food Drive [claim your hours here](https://evil.example/phish)
```

62 characters; `validateEventPayload` allows free text to 200 with **no
character rules** (`server/validation.js:120`). A student asks Welly about that
event; `summarise('event_details')` speaks the title
(`src/ai/assistant.js:174`); the transcript renders a live external anchor
inside the assistant the product tells minors to trust. The same reaches
`next_shift`, `waitlists`, `certificate`, `event_created` and `recent_audit`.

**Why the existing defence did not catch it — the part worth keeping.** This was
not a missing guard. It was a *delegation to a guard that does not run there*.
`plainValue` deliberately does not sanitise and says so in terms: "`containsLink`
in `prompts/welly.js` is what stops the model turning any of it into somewhere
to go" (`src/ai/assistant.js:449-450`). But `containsLink` is called only from
`isUsableReply`, and `isUsableReply` is called only on **model output**
(`src/ai/assistant.js:598`). A deterministic sentence passes through neither.
`src/ai/indirectInjection.test.js` tested the link defence against the model
path only, so the suite was green over an unprotected path.

The threat model was already written down correctly in
`src/ai/prompts/welly.js:279-282` — "a link is the single most valuable thing an
attacker can get Welly to say ... because it moves the reader somewhere the
platform no longer protects them." The guard was simply on the wrong side of it.

**Fix.** The link patterns are removed rather than escaped, because there is
nothing legitimate to escape. Established three ways before removing: no
answer-producing source in `src/ai/` contains an `https://` literal; a model
reply containing a link is *already* disqualified; and the component has exactly
one consumer. Link syntax now renders as the literal characters typed — inert
and visible, where an anchor was a friendly label over a hidden destination.

**Verification.** `src/components/ai/WellyMessage.test.jsx` gains two cases, one
carrying the reachable payload. Mutation-checked: reverting the component fails
both on `expected <a> to be null`. All 40 Welly-related client suites (992
tests) pass.

---

### 1.2 Certificates — the holder cannot open a certificate the world can verify

**Grade: Verified. Severity: High. Category: C (product inconsistency).
Status: FIXED — `d3175e3`.**

`getCertificateForOwner` excludes a cancelled event
(`server/certificates.js:334`, `AND e.status <> 'cancelled'`), so both
`GET /api/certificates/:code` and its PDF answer **404**
(`server/routes/certificateRoutes.js:117`, `:178`). The public verification
endpoint carries no such exclusion (`server/routes/attendanceRoutes.js:602`) and
answers `{valid: true}` with the hours.

**Reachable, with a concrete path.** Cancellation is refused once an event is
`completed` (`server/routes/eventRoutes.js:1733`), so the door is an event that
has credited attendance but has not reached `completed` — one volunteer
finalized, others outstanding, status still `open`. Viewing the certificates
list mints the code; the organizer then cancels; the certificate now exists,
verifies publicly, and is unreachable by the student holding it.

**Which side is the defect is not a judgement call here.** The repository states
the rule twice, in a hash-pinned policy and in a test written to pin it:
`docs/legal/policies/06-certificate-verification-policy.md` states "There is no
option to void a certificate", and
`server/certificates.cancelled.test.js` is titled *"a certificate already issued
is never taken away"* with a case named *"keeps returning the same code, so a
printout keeps verifying"*. The public endpoint is therefore correct. The
owner-side exclusion is the defect: it revokes the certificate from the one
person who holds it while the platform keeps vouching for it to everyone else.

The certificate **list** excluding cancelled events is separately reasoned and
correct — the list mirrors the transcript. The viewer is a different surface,
reached with a code already in hand.

**Fix.** The viewer's exclusion is removed. Showing the document silently would
have traded one contradiction for the opposite one — 6 hours on the paper, 0 on
the profile, no explanation — so the route returns `eventCancelled` and the
viewer says the hours are not counted in the service totals, `no-print`, because
the certificate is not void. Mutation-checked: restoring the clause fails the
three owner-facing cases while the public-verify and list-exclusion cases keep
passing, which is exactly the scoping claimed.

---

### 1.3 Cancelled events — the hours rule is stated everywhere and enforced in six places

**Grade: Verified. Severity: High. Category: C. Status: FIXED — `df4e815`,
with two questions referred to the owner (below).**

The platform's documented rule is explicit: a called-off event counts as zero
hours and stays off the transcript (`server/certificates.js:110-115`). Six
derivations enforce it — `volunteerStats.js:113`, `certificates.js:333`,
`volunteerInsights.js:130`, `eventRoutes.js:1515`, `userRoutes.js:175`,
`attendanceRoutes.js:446`.

**Roughly thirty do not.** Enumerated by reading every non-test query matching
`present = 1`. The consequential ones: `volunteerInsights.js:156`
(`milestoneInputs` — the profile's headline hours and every milestone),
`volunteerInsights.js:185` (the monthly chart), `services/badgeService.js:99`
(hour badges — a badge earnable on voided hours), `userRoutes.js:201`
(transcript hours-by-category), `contentRoutes.js:608` (public leaderboard),
`adminRoutes.js:241-245` (platform statistics), `workers/exportWorker.js:305`
(the GDPR export), and the whole of `impact.js` — which contains **no occurrence
of `cancelled` at all**.

The user-visible result is a single response that contradicts itself: the
profile route emits `stats.hours` from the unfiltered query while `completed` on
the same payload is filtered, so a student can be shown hours alongside an empty
list of the events that produced them.

`server/routes.volunteerInsights.test.js` asserts the dashboard and the profile
agree **with each other**, which both wrong in the same way satisfies.

**Not yet fixed, deliberately.** This changes user-visible numbers across the
platform and the correct treatment differs per call site — `hoursLedger.js:273`,
for instance, *must* stay unfiltered because it reconciles against raw
attendance by design. The rule belongs in one shared place rather than
re-pasted thirty times, which is the fix this repository's own conventions
imply. Scheduled as its own piece of work with its own tests.

---

### 1.4 Reliable Volunteer — the badge promises a threshold it can never award

**Grade: Verified (by algebra over the implemented formula). Severity: High.
Category: C. Status: FIXED — `c2f5fff`.**

The badge reads *"Turned up for at least 90% of the shifts you signed up for"*
(`server/scripts/seed_badges.js:159`). It is awarded on
`stats.reliability.score * 100 > threshold` (`server/services/badgeService.js:219`),
where `score` is recency-weighted and shrunk toward a prior of `0.85` with
weight `5` (`server/weighting.js:68,71`).

A volunteer whose weighted attendance is exactly 90% can **never** earn it, at
any history length. The smoothing gives `(0.9n + 4.25) / (n + 5)`, and that is
below `0.9` for every `n`, because `4.25 < 4.5`. The gap closes as `n` grows but
never reaches zero.

Three mismatches sit in one sentence: "at least" against a strict `>`; a raw
ratio against a smoothed, recency-weighted score; and "shifts" against a model
whose unit is the **event** (`server/reliability.js:263-278`). The decision
code's own comment says *'the badge says "over 90%"'* — quoting a description
the repository does not contain.

**The algorithm itself matches the intended product and should not change.** It
weights recent behaviour, decays old no-shows, permits recovery, and refuses to
judge below four commitments (`MIN_EVIDENCE`, `server/reliability.js:79`) — every
property the brief asks for. It is the promise printed next to it that is wrong.

**Fix.** The number goes rather than the algorithm; the description now carries
none, because any figure would have to describe a smoothed, recency-weighted
score and a number needing a paragraph to be true is worse on a badge card than
no number. `reconcileBadgeCatalogue` matches by name and rewrites descriptions
on boot, so existing databases converge. A guard refuses a percentage on any
active `attendance_rate` badge; mutation-checked.

---

### 1.5 Check-in — a finished feature refused to the role it was built for

**Grade: Verified. Severity: Critical. Category: A. Status: FIXED — `b4a1e11`.**

Three gates guard check-in. The route table was the strictest of them, and the
only one a Student Organizer failed:

| Gate | Condition |
|---|---|
| Button — `src/components/EventModal.jsx:72-74` | `attendance.mark` **OR** `organization.event.manage.own` |
| Server — `server/routes/attendanceRoutes.js:25`, `:76` | `requireCapAny` over the same pair |
| Route — `src/routes/index.jsx:206` | `attendance.mark` **alone** |

`STUDENT_ORGANIZER_CAPABILITIES` (`server/organizationRoles.js:48-54`) grants
`organization.event.manage.own` and not `attendance.mark`. A student running
their own club's event opened their own event, was shown the Check-in button —
gated on the pair — pressed it, and received the **full-screen 403 takeover**,
because `deniedRoute` refuses before the shell is built. The API behind that
screen would have accepted them.

Nothing about the feature was unfinished. One declaration kept the role it was
built for out of it. `deniedRoute` (`src/App.jsx:952`) already honoured
`requiredCapAny`, so the fix is that declaration, and the gate is narrowed
rather than dropped so a plain student is still refused. Mutation-checked.

---

### 1.6 Navigation and cross-feature coherence — reported, awaiting verification

A full reachability sweep of the route table was run. Two results are worth
recording before the individual findings:

- **The server-destination guard added by the 2026-09-05 audit works.**
  `server/serverLinks.test.js` scans `link:` literals and `${APP_URL}`
  templates against `server/clientRoutes.js`, and every declared client path is
  allowlisted. The failures that remain are ones the guard is *structurally*
  unable to see — it strips fragments, skips non-literals, and reads one line
  at a time.
- **The prior "badge administration has no UI" finding is fixed.**
  `/admin/badges` now has a hub tile (`src/views/ModerationCenter.jsx:183-190`)
  over all four endpoints.

The reported findings, **none yet independently verified or acted on**:

| # | Claim | Severity | Cat |
|---|---|---|---|
| N-1 | Every notification **email** CTA is `/?event=` and resolves against a `mine=true` index, so from a cold inbox load nothing renders and nothing is said | High | B |
| N-2 | `FRIEND_SIGNED_UP` and `ORGANIZATION_EVENT_POSTED` — the two notifications whose entire purpose is discovery — answer "That event is no longer available." for a live, open event | High | B |
| N-3 | `ORGANIZATION_JOIN_REQUEST_RECEIVED` links to `#requests`; no hash effect and no such id exists, so "Review the request" lands at the top of the page | High | B |
| N-4 | `/calendar`'s nav entry requires `event.apply\|event.create`; the route requires `event.view`. `admin` and `partner` hold the latter only, so a built, correctly-titled page is invisible to two roles | High | A |
| N-5 | A `partner` has no dashboard: `/` renders an `EmptyState` with no action, and the brand mark navigates there unconditionally | High | A |
| N-6 | Three destructive admin actions (delete event, deny organizer, remove event) still use `window.confirm`, which the shared `ConfirmDialog` was written to replace and which silently returns `false` when suppressed | High | C |
| N-7 | Two different member-profile screens (`PublicProfile` at a URL, `VolunteerProfile` as a state overlay) differ in content, addressability and back behaviour | High | C |
| N-8 | Hub tiles `/#reports` and `/#organizer-requests` target anchors that exist only on the staff dashboard, so a grant-holding non-staff account lands on their own volunteer dashboard | Medium | C |
| N-9 | Grantable capabilities (`analytics.impact`, `appeal.review`, `event.moderate`) reach pages only via a hub gated on `report.resolve` | Medium | C |
| N-10 | `PublicProfile` links hours and certificates but not badges, though `/users/:handle/badges` exists and works | Medium | B |
| N-11 | Welly's `applications` destination emits `/discover?find=applications`; `applications` is not a scope, so it silently falls back to `all` | Medium | B |
| N-12 | Archive-organization and Cancel-create both navigate to `/directory`, a redirect to a **people** search | Medium | C |
| N-13 | Terminology: four labels for `/events/new` against a page titled "New opportunity"; "Browse organizations" points at two different pages; application/sign-up split along the role line; five names for the service-hours record | Medium | C |
| N-14 | `/organizations` is a first-class page with no menu presence for any role, while `/welly` is a primary rail entry | Medium | C |
| N-15 | The service record has five destinations and no hub — the shape `/admin/moderation` was built to solve for the admin pages | Medium | C |
| N-16 | Four raw `<input type="date">` remain against the shared `DatePicker`; eight hand-rolled empty states remain against `EmptyState`, and the missing `action` slot is the direct cause of a dead end | Medium | C |
| N-17 | `serverLinks.test.js` cannot read multi-line ternaries, so it reports coverage it does not have on exactly the links carrying query strings and fragments | Medium | B |

---

### 1.7 Findings reported and awaiting verification

Recorded with their evidence; **none acted on yet**. Each is promoted to
`Verified` or dismissed before any change is made.

| # | Area | Claim | Severity |
|---|---|---|---|
| R-1 | Hours | Cancelling an event silently zeroes credited hours with no ledger row, no audit row, and is reversible — while `hours_ledger` already carries unused `voided` / `event_edit` values | High |
| R-2 | Hours | A closed-out event still accepts **new** credited records (the lock at `attendance.js:526` applies only when a prior row exists), which are then permanently uncorrectable | High |
| R-3 | Hours | The close-out/finalize race is closed in one direction only; on PostgreSQL a correction can commit after close-out (no `FOR UPDATE` on the re-read) | Medium |
| R-4 | Hours | `getLedgerForUser` has no caller — the hours ledger is write-only, so nobody can see why a total changed | Medium |
| R-5 | Badges | `evaluateBadges` is called only from attendance finalisation, so `Organizer` and `Community Builder` are effectively unearnable, and `Early Supporter` arrives only on a first attendance (and dates it wrongly) | High |
| R-6 | Badges | An admin-created `early_adopter` badge is silently unearnable: the form declares it takes no threshold, the evaluator requires `threshold > 0` | Medium |
| R-7 | Badges | Badge loss and re-gain are both silent; the award dedupe key is permanent so a re-earned badge never notifies | High |
| R-8 | Badges | The organizer applicant row still hardcodes a three-commitment floor against the model's four | Medium |
| R-9 | Welly | `identity_self` tells the user "nothing you type here is sent anywhere", but a search question is posted to `/api/events` and embedded server-side by Pinecone | Medium |
| R-10 | Welly | Welly-created events carry no coordinates, so they are second-class in the distance features Welly itself offers | Medium |
| R-11 | Welly | The transcript UI is built for token streaming that no longer happens; the runtime calls `onToken` once with the whole reply | Low |
| R-12 | Welly | `send`'s dependency array omits `prefs`, so a mode switch on an empty conversation can be answered by the wrong engine | Low |

---

### 1.8 Corrected while establishing state

**`server/db.js`** stated in the present tense that `.env` carries
`WEV_DB_PATH=../pilot.db`. It does not, and the reason it no longer does is the
larger of the two hazards: every `bin/` script reads the same file, so the
relative path made the real pilot database — minors' service records — the
default target of every privileged command. The comment was describing the
opposite of the current, safer arrangement on the most dangerous object in the
repository. Corrected, with the removal's reasoning preserved.


---

## Phase 1 — verification status

### Regression baseline

| Run | Result |
|---|---|
| Phase 0 baseline | 633 files, **10,742 passed**, 0 failed, 176 skipped |
| After the five fixes | 633 files, **10,753 passed**, 0 failed, 176 skipped |
| After the notification fix | 636 files, **10,781 passed**, 0 failed, 176 skipped |

The delta is exactly the net new tests: +2 renderer (one replaced, so +1 net),
+1 route, +5 certificate viewer (server), +3 certificate viewer (client),
+1 badge guard — eleven. `npm run lint` is clean.

**One flake observed, not yet identified.** An intermediate full run reported
`1 failed | 10,743 passed` and the immediately following run was clean at the
expected count. The output was truncated before the failing name was captured,
so the test is unknown. This is recorded rather than dismissed: the known
mechanism in this repository is `db.js` opening its connection at module scope,
which makes suites that do not set `WEV_DB_PATH` share a real file. Every future
run in this engagement captures full output.

### Fixed so far

| Commit | Finding |
|---|---|
| `02480a6` | Welly could speak a phishing link in its own voice |
| `b4a1e11` | A Student Organizer was shown check-in and then refused it |
| `d3175e3` | The holder could not open a certificate the world could verify |
| `c2f5fff` | Reliable Volunteer promised a threshold it can never award |
| `ece14c6` | An event link answered "no longer available" for a live event |
| `3346317` | The ledger, and a stale comment on the development database path |

### Promoted to Verified, fix designed but not yet written

**N-1 and N-2 share one root cause.** Confirmed by reading the chain:
`FRIEND_SIGNED_UP` and `ORGANIZATION_EVENT_POSTED`
(`server/services/notificationContent.js:1204-1218`) emit `link: event:<id>`;
`src/views/Notifications.jsx:93` routes that to `openEventById`
(`src/App.jsx:1299`), which resolves a **string** id only against `events` or
`seenEvents`. `events` is fetched with `{mine: 'true'}` for anybody without
`event.moderate` (`src/session/SessionProvider.jsx:100`). Both notifications are
*by definition* about an event the recipient is not part of — "There may still
be places", "is open for applications" — so from a cold load the answer is
**"That event is no longer available."** for a live, open event. The email CTA
`${APP_URL}/?event=<id>` (`server/workers/notificationWorker.js:396`) hits the
same resolution and renders nothing at all.

The fix is not a one-liner, which is why it is scoped rather than rushed:

- `GET /api/events/:id` **cannot** be used. It is staff-only and answers 403 to
  a student (`server/routes/eventRoutes.js:751-755`).
- `parseEventFilters` (`server/eventQuery.js:76`) has no `id` filter, so the
  browse list cannot be narrowed to one event either.

So the shape is: add an `id` filter to the browse query — which keeps the
existing server-side visibility filtering, including withholding arrival
instructions from non-attendees — and have `openEventById` ask the server before
it says an event is gone. That repairs the in-app path and the email path
together.

### N-1 / N-2 — FIXED, `ece14c6`

**Grade: Verified. Severity: High. Category: B. Status: FIXED.**

**Scope correction made while implementing.** The earlier note said "every
notification email CTA" dead-ends. That was too broad, and the narrower claim is
the true one: **23** kinds emit `link: event:<id>`, but only **two** are
addressed to somebody who is not involved —

| Kind | Body |
|---|---|
| `FRIEND_SIGNED_UP` | "… signed up for X. There may still be places." |
| `ORGANIZATION_EVENT_POSTED` | "X is open for applications." |

For the other 21 the recipient has an application, attendance, a favourite, or
hosts the event, so `mine=true` already returns it. `REMOVED_FROM_EVENT` was
checked specifically: removal writes `applications.status` and never deletes the
row (`DELETE FROM applications` appears only in slot deletion, event deletion
and retention), so the event stays in the index.

**Authorization and visibility — what actually changed.**

- `?id=` is an ordinary bound clause in `buildEventWhere`, pushed alongside the
  others so it **ANDs** with every predicate. Naming an id can only remove rows.
- Nothing about disclosure changed. The same serialiser runs, and
  `canSeeInstructions` (`event.moderate || host || accepted`) still blanks
  arrival instructions. Pinned from both directions: blank for a non-attendee
  resolving by id, present for the host.
- **No read is granted that paging the list did not already grant.** Established
  by reading the query builder: there is no audience-based row exclusion in
  `buildEventWhere`, so an ordinary `event.view` holder could already page to
  any event's browse card. The filter narrows a set, it does not widen one.
- `GET /api/events` keeps `authenticateToken`; an unauthenticated `?id=` is 401.
- **The endpoint used to FAIL OPEN.** `?id=` was an unknown parameter and was
  ignored, so a mistyped link returned the first row of the whole table. It now
  matches nothing.
- No staff-only bypass was created, and `GET /api/events/:id` was left alone.

**Files changed**

| File | Change |
|---|---|
| `server/eventQuery.js` | `id` default, parsing (trimmed; empty means "not asked"), and the AND-ed clause |
| `src/utils/resolveEvent.js` | **new** — caches first, then server, null on failure |
| `src/utils/api.js` | `fetchEventById` — browse query narrowed, `scope=all` so a cancelled or completed event still resolves |
| `src/App.jsx` | `openEventById` consults the server before refusing; a deep-link effect backfills an unresolved `?event=`, once per id via a ref |

**Tests added — 28.** `server/routes.eventsById.test.js` (11):
resolution for an uninvolved student, a control proving the event is absent from
that student's index, modal-shaped fields, instructions withheld, instructions
present for the host, fail-closed on an unknown id, 401 unauthenticated, AND-ing
with other filters, and both notification kinds plus the email CTA id.
`src/utils/resolveEvent.test.js` (12) and `src/App.eventDeepLink.test.jsx` (5),
the latter mounting the real shell at `/?event=<id>` with an empty index — the
cold-load shape exactly.

**Mutation-checked in three places**, each failing only its own cases: removing
the SQL clause (4 server cases, including the fail-open one); making the seam
skip the network (6); disabling the deep-link backfill (5). All restored.

**Verification.** Focused: 13 server suites / 492 passed; 6 client suites / 97
passed. Full: **636 files, 10,781 passed, 0 failed, 176 skipped**, exit 0,
output preserved at `/tmp/wev-fullrun-20260921-205958.txt`. Lint, `npm run
build` and `npm run scan:bundle` all clean.

**Coverage gap found, not closed.** There are no client test files for
`src/views/Notifications.jsx` or `src/components/NotificationsBell.jsx` — the
two components that dispatch `event:` links. Recorded rather than fixed, to keep
this change to one concern.

---

## The cancelled-hours invariant, established 2026-09-21

### The rule, and where it comes from

> **Attendance is a record; credited service is a presentation of it.**
> Cancelling an event never alters the stored row. It removes that row from
> every figure the platform *presents as credited service*.

Evidence, in the order it settles the question:

| Source | What it establishes |
|---|---|
| `server/volunteerStats.js` — `creditedHoursFor` header | "the canonical definition behind every total in the product"; the function joins `events` and excludes `cancelled` |
| Commit `b8cfb09` | Names the scope: "the platform-wide 'cancelled events count for nothing' rule was applied everywhere hours are presented as **credited service**" |
| Commit `b8cfb09` | Settles that this is not a policy choice: "The code disagreed with published policy rather than implementing a different intent, so no policy text changes" |
| `docs/legal/policies/07-volunteer-record-policy.md` | Publishes Auto Select's input as "total credited hours" and states the principle for the neighbouring term — "neither is an event that was **cancelled**" |
| `server/certificates.js` | "The platform now counts that event as zero hours and keeps it off the transcript" |
| `server/routes/userRoutes.js` — `completed[]` | "A cancelled event is not completed service … Same rule as `volunteerStats.hoursCredited` and every figure in `organizationHours.js`" |

**INV-001 does not cover this.** `docs/spec/01-engineering-foundation.md:388`
is about hours being *derived rather than stored*; it says nothing about
cancellation. `impact.js`'s header citing "the same rule as credited hours
(INV-001)" is therefore citing the derivation property, not the exclusion — it
is not self-contradicting, it simply never addressed cancellation.

**The snapshot promise is not in tension with this.** "Credited hours are a
snapshot" (policy §79) is about an hours value not being *re-priced* when a slot
is edited. The stored `attendance.hours_awarded` is untouched by cancellation.
Only the read-time presentation changes.

### Call-site inventory

Every non-test query in `server/` matching `present = 1` was read and
classified. Categorised rather than listed row by row.

**A · Presents credited service — must exclude. Now does.**

| Location | Consumer | Before |
|---|---|---|
| `volunteerStats.js` `creditedHoursFor` | dashboard `volunteeredHours`, `record.hoursCredited` | already correct |
| `volunteerStats.js` `participationCountsFor` | profile counts | already correct |
| `userRoutes.js` `completed[]` | transcript list | already correct |
| `attendanceRoutes.js:446` | own certificates list | already correct |
| `eventRoutes.js:1515` | event-scoped hours | already correct |
| `volunteerInsights.js:130` | `eventsAttended` | already correct |
| `certificates.js:333` | certificate viewer | fixed earlier, `d3175e3` |
| `organizationHours.js` ×4 | per-club hours | already correct |
| `autoSelect.js` ×3 | draw weighting | already correct (`b8cfb09`) |
| **`volunteerInsights.js` `creditedTotalsFor`** | **profile `stats.hours`/`eventsCompleted`/`shiftsCompleted`, `record.shiftsWorked`** | **NEW — was unfiltered** |
| **`volunteerInsights.js` `monthlyHours`** | **the chart under the credited total** | **fixed** |
| **`volunteerInsights.js` `firstVolunteeredAt`** | **"volunteering since"** | **fixed** |
| **`volunteerInsights.js` `kindsOfService`** | **`record.kindsOfService`** | **fixed** |
| **`volunteerStats.js` `lastVolunteeredAt`** | **public "still active" signal** | **fixed** |
| **`userRoutes.js` `byCategory`** | **hours breakdown, must sum to `stats.hours`** | **fixed** |
| **`badgeService.js` `collectStats`** | **hours/events/shifts behind every automatic badge** | **fixed** |

**B · Intentionally unfiltered — verified, not assumed.**

| Location | Why it must stay raw |
|---|---|
| `hoursLedger.js:273` `verifyLedgerParity` | Compares `SUM(hours_ledger.delta)` to raw attendance. Cancelling writes **no ledger row**, so filtering the attendance side would report a false mismatch for every user with a cancelled event, on every boot. Read and confirmed. |
| `hoursLedger.js:358` backfill | Same reconciliation, same reason. |
| `verifyHours.js:99-104` | The operator CLI twin of the parity check; labels itself "source of truth — attendance". |
| `attendanceRoutes.js:602` public verify | An issued certificate is never voided — a hash-pinned policy, pinned by `certificates.cancelled.test.js`. |
| `accountRoutes.js:109-118` | The certificate snapshot frozen at account deletion, tied to the same never-void rule. |
| `db.js:303` | A one-time duplicate-email repair heuristic choosing which account has more real activity. Not a presentation. |
| `volunteerInsights.js` `milestoneInputs` | A recorded decision — see the open question below. |

**C · Not decided here — referred to the owner.** See below.

### Open question 1 — milestones

`milestoneInputs` deliberately counts a cancelled event.
`volunteerInsights.test.js`: *"counts a cancelled event, because the service
still happened"*, explicitly *"deliberately different from
`volunteerStats().eventsAttended`"*. Commit `93756e4` made the same choice
knowingly.

**Left exactly as it was**, and the existing test still passes. It is raised
rather than resolved because the reasoning that protects it does not obviously
hold: a milestone is **recomputed on every read**, so unlike a streak badge
(awarded on the *longest* run, never withdrawn) or an issued certificate (never
voided), it is not actually protected from changing — revoking attendance
already removes a tier. So a student can now see a milestone tier beside an
hours total that no longer supports it.

Either answer is defensible and both are one-line changes. **This is a product
decision about recognition, not an implementation one.**

### Open question 2 — the public certificates list

Newly verified while building the inventory, **not acted on**:
`GET /api/users/:id/certificates` (`attendanceRoutes.js:540`, the public
profile) has **no** cancelled filter, while `GET /api/certificates`
(`:446`, the student's own list) has one. So a cancelled event's certificate is
hidden from the student's own list and shown on their public profile.

Genuinely ambiguous rather than simply wrong: the list comment says a called-off
event "has no certificate to list" because the list mirrors the transcript,
while the never-void policy says an issued certificate is a credential the
holder keeps. Which rule owns the *public* list is an owner call.

### Verification

| Check | Result |
|---|---|
| Focused | 12 suites, 220 passed |
| Full suite | **637 files, 10,796 passed, 0 failed, 176 skipped**, exit 0 |
| Output preserved | `/tmp/wev-cancelled-hours-20260921-223659.txt` |
| Lint / build / bundle scan | clean |
| Mutation checks | **7**, each failing only its own case, all restored |

New tests: `server/hours.cancelledEvent.test.js`, 15 cases. It credits a
controlled event, records every figure while it is live, cancels it, and asserts
each figure moves by exactly the credited amount — relative comparisons
throughout, so the seed's own history cannot make a case pass for the wrong
reason. Three cases pin behaviour that was already correct (the dashboard,
`record.hoursCredited`, and the non-vacuity guard), and one pins the milestone
decision as-is.

---

## Pass 5 — notification coverage, and Welly

### Re-verification of the cancelled-hours fix (requested)

`df4e815` touched five files, none of them a protected module. Every changed
function was traced to its consumers: `monthlyHours` in `adminRoutes.js` is a
separate local query, not the shared one. Behaviourally, 17 protected suites
pass — ledger parity, backfill, certificates (×4), audit log, admin audit
explorer, moderation audit coverage, transaction audit, retention, deleted
account visibility, export durability and download, admin stats.

Parity was additionally proven at runtime on a synthetic `:memory:` database,
because reading is weaker evidence than running:

```
before cancellation : {"ok":true,"mismatches":[],"usersChecked":1}
after  cancellation : {"ok":true,"mismatches":[],"usersChecked":1}
counterfactual      : ledger=11 filteredAttendance=4 -> would MISMATCH
```

The counterfactual is the point: filtering the attendance side *would* break
parity, which is why `verifyLedgerParity` stays raw. **No regression; no change
made.**

### 5.1 Welly sent the exact device position — **Verified defect. High. FIXED `5f5d369`**

`views/BrowseEvents.jsx` rounded every coordinate to ~1.1 km before it reached
`GET /api/events`. Welly reached the same endpoint with none:
`WellyView.jsx:219` built `{lat, lng}` from `LocationContext`, which stores
`position.coords` verbatim, and `assistant.js:1383` copied them into the tool
arguments, which `tools.js:389` sends.

Three authorities agree this was wrong, none of them a matter of taste:

- **Privacy Policy**, "Your device location": coordinates "do reach our
  servers, **blurred** … rounded to about a kilometre to sort a list by
  distance".
- **`EventModal.jsx:120`**: "the volunteer's exact position never leaves the
  device. The browse filter sends a coordinate coarsened to about a kilometre."
- **`api.js` on `fetchRecommendations`**: "the same 2-decimal-place centre the
  browse filter sends — enough for 'is this nearby', not enough to place
  somebody."

`coarsen` now lives in `utils/coarsePosition.js` and is applied at the boundary.
The exact position still never leaves the device and is still used there.

### 5.2 Two privacy claims that overstated — **Verified defect. Medium. FIXED `5f5d369`**

The location offer said "It stays on your device" **at the consent moment** —
the exact sentence `WellyView.disclaimer.test.jsx` already forbids in the
composer footer, for the reason it records: it "is the exact sentence a future
edit would reach for".

`identity_self` and `identityAnswer` said "nothing you type here is sent
anywhere". True of inference, false of the feature: `searchTopic` keeps the
residual words of a typed question and `tools.js` sends them as `q`.
`WellyView.jsx:1376-1388` had already reasoned this out about this very
sentence. The on-device claim is kept; the absolute one is gone.

### 5.3 Notification dispatch — **Coverage gap, not a defect. Closed `c4b7de9`**

Read both components rather than assuming. The existing `resolveEvent` and
App-level tests do **not** protect the dispatch itself, and both components
carry it byte-for-byte. `groupNotifications` had no tests at all and routes the
grouped object — it preserves `link` via `{...item}`, verified.

**Verified negative worth keeping:** every link the server can emit is
`event:<id>` or `/`-prefixed. The three kinds passing `payload.link` through
supply `/messages?conversation=…` and `/settings…`; the default arm falls back
to `/settings`. No shape is silently ignored.

### 5.4 Welly items classified, not changed

| Item | Classification | Evidence |
|---|---|---|
| On-device inference | **Intentional, true** | No server AI route; `@wllama/wllama` in a worker behind `VITE_LOCAL_AI` |
| Placeholder events ("Community Service Event", "Community Center", 10 spots) | **Verified fixed** | No production default; every hit is a comment, a fixture or history. `tools.js` returns `failed('missing_event_fields')` rather than inventing values |
| Link rendering in the transcript | **Verified still fixed** (`02480a6`) | No link/url pattern, no `SafeLink` |
| Location: never asks in chat | **Intentional, correct** | `needsLocation` states a limitation; the remedy is a permission button; `asksForPersonalInfo` rejects model replies asking for an address |
| iOS `isIOS` reason branch | **Verified defect, Low — not fixed** | `fitsDevice` rejects non-conversational models; `fast` (105 MB) is the only one under `IOS_MAX_MODEL_BYTES` (200 MB) and is non-conversational, so `fits` is always empty and the branch is unreachable. Harm is to the next reader, not a user |
| `summarise('profile')` omits `plainValue` | **Verified defect, Low — not fixed** | Self-targeting only (`resourceScope: 'own'`, `api.getMe`); name validation is `trim()` + length only, so a control character could reach replayed history |
| Cold-load location race | **Harmless limitation** | `maximumAge: 300000` makes the window sub-second; the permission button is present |
| Model switch leaves old weights | **Reported — not verified** | |
| Welly-created events lack coordinates | **Reported — not verified** | |
| `explainInvalidEvent(null)` latent throw | **Reported — not verified** | |
| Streaming UI for a non-streaming runtime | **Reported — not verified** | |
| `prefs` missing from `send` deps | **Reported — not verified** | |

### Verification

| Check | Result |
|---|---|
| Focused | 102 client suites / 1,887 passed |
| Full suite | **639 files, 10,813 passed, 0 failed, 176 skipped**, exit 0 |
| Output preserved | `/tmp/wev-pass5-20260921-232458.txt` |
| Lint / build / bundle scan | clean |
| Mutation checks | **8** across three fixes, each failing only its own case |

One mutation check earned its keep: restoring the old claim in
`FIXED.identity_self` left the suite **green**, because the first version of the
case used a loaded runtime and exercised only the dynamic string. The no-model
fallback is now covered. A regression test is not protection until the mutation
proves it.

---

## Pass 6 — the close-out invariant (R-2, R-3)

### The invariant, reconstructed

> **Close-out makes existing credited records final. It does not close the
> roster.**

`events.hours_closed_out_at` is the authority, and migration 058 argues at
length for why it is not `events.status`: `completed` "is not a decision" —
`computeEventCompletion` writes it the instant the last accepted volunteer has
a record — and `PUT /api/events/:id` already promises "*Attendance can still be
corrected*" after completion. NULL means "still correctable". The column is set
once, by a one-way CAS, and **nothing in the codebase ever clears it**.

### Lifecycle

```
open ──finalise──▶ (computeEventCompletion) ──▶ completed ──close-out──▶ frozen
  │                     corrections allowed, with a reason
  └──cancel──▶ cancelled     (refuses finalisation; hours stop counting)
```

`finalizeAttendance` is the **only production writer to `attendance`** —
verified by enumerating every `INSERT/UPDATE/DELETE` against the table: the
remaining hits are the demo seed, `bin/` tooling, and tests. Its own comment
claims this ("a guard in the route is a guard on one caller. This is the
floor"), and the claim holds.

### R-2 — **DISPROVEN as a defect**

The report was that a closed-out event "still accepts brand-new credited
records, unbounded, with no reason required". The behaviour is real. It is also
**deliberate, documented and already tested**:

- `attendance.js`, the note below the loop: "A volunteer with NO record is
  deliberately still creditable. Completion is computed from the accepted roster
  at the moment it was reached, so somebody accepted afterwards has never been
  finalised at all; refusing them would mean a student who worked the shift can
  never be credited for it by anyone. **Awarding them nothing is not 'no
  takebacksies', it is a different loss.**"
- `attendance.closedOut.test.js` already asserts it: *"still lets a volunteer
  with no record at all be credited"*.
- No reason is required because `corrections = planned.filter(p => p.prior !==
  null)` — a first credit is not a change, and the reason exists to justify a
  change.

**No code was added.** The earlier report was misleading because it read the
lock's condition (`eventClosedOut && prior`) without the note that explains the
second half of it.

### R-2's second half — **CONFIRMED, and an owner decision**

Reproduced on synthetic data through the real HTTP route:

```
first credit  : 200  {"present":1,"hours_awarded":6}   ← no reason required
organizer fix : 409  hours_locked
admin fix     : 409  hours_locked
stored after  : {"present":1,"hours_awarded":6}        ← permanent
ledger rows   : 2, both "credited", reason: null
```

A volunteer credited after close-out gets **one irreversible shot**: the second
save has a `prior`, so the record-level lock fires and nobody — organizer or
administrator — can correct it. `admin_correction` exists in the ledger enum
with **no production writer**, and `hours_closed_out_at` is never cleared, so
there is no override and no un-close-out.

This is the acknowledged consequence of two deliberate decisions, and
`attendance.js` says so: the refusal "deliberately does not promise a way round
it. There is no administrator override path today … a refusal that names a
remedy which does not exist sends an organizer to ask for something nobody can
do."

**Open question for the owner.** Should a post-close-out credit be correctable —
by an administrator override, or by a short window — or is one-shot-final
acceptable? The design intent ("somebody accepted afterwards has never been
finalised at all") reads as though they should get the same correctable
treatment as anyone before close-out; what they actually get is a single
permanent write that requires no justification. Nothing in the repository
settles it, so it is not settled here.

### R-3 — **CONFIRMED, independently reproduced, FIXED `593f281`**

A separate defect from R-2, and real. Measured on real PostgreSQL with two
connections issuing this application's own statements:

| Re-read | Close-out timing | Commit order | Verdict |
|---|---|---|---|
| plain `SELECT` (as written) | during the window | close-out → correction | **VIOLATED** |
| `FOR UPDATE` | during the window | correction → close-out | held — close-out blocked until the finalisation committed |
| `FOR UPDATE` | already committed | — | held — the read returns the timestamp and the submission is refused |

The in-transaction re-read narrowed the window but did not close it: a
statement's snapshot says nothing about what commits afterwards, and the
transaction held no lock on `events`. `forUpdate(db)` is empty on SQLite, where
the engine serialises writers, so the fix changes nothing there — production is
on SQLite today, which makes this **latent rather than live, and exactly the
class of defect that appears at cutover**.

The regression test (`attendance.closeOutRace.postgres.test.js`,
`skipIf(!RUNNING_ON_POSTGRES)`) asserts the mechanism — that a concurrent
close-out cannot commit while a finalisation is open — because the race needs a
commit inside a window no test can open. Mutation-checked: without `FOR UPDATE`
it reports "committed" instead of "blocked".

### Verification

| Check | Result |
|---|---|
| Focused, SQLite | 5 files passed, 1 skipped; 120 passed |
| Focused, PostgreSQL | 4 files, 94 passed |
| **Full suite, SQLite** | **639 files, 10,813 passed, 0 failed**, 178 skipped, exit 0 |
| **Full suite, PostgreSQL** | **412 files, 7,197 passed, 0 failed**, 41 skipped, exit 0 |
| Output preserved | `/tmp/wev-r3-sqlite-20260922-002241.txt`, `/tmp/wev-r3-postgres-20260922-002459.txt` |
| Lint / build / bundle scan | clean |
| Mutation checks | 1, failing on the intended assertion |

Scratch databases were created and dropped; no production database was touched.

---

## Pass 7 — the ledger model (R-1, R-4)

Investigated together, and they are **not** the same invariant: R-1 is about
cancellation semantics, R-4 about ledger consumers. They touch only at the
parity contract. **Both are disproven, and no code was changed.**

### The ledger's documented model

Stated in its own header and in the contract on its only write function:

> "Hours Ledger — **append-only history of every change to credited service
> hours**." · "`attendance` remains the single source of truth … **nothing here
> is read by any hours calculation**." · "This table records *what changed,
> when, and who changed it*."

and the invariant, written where it is enforced:

> "`delta` is always computed here rather than accepted from the caller, so the
> invariant **`SUM(delta) per user == credited hours per user`** cannot be
> broken by a call site doing its own arithmetic."

`credited()` keys on `attendance.present` and `hours_awarded` **only** — it has
no reference to event status. So the ledger tracks *mutations of attendance
rows*, which is model **B**, not a financial-style ledger of the derived
presentation.

### R-1 — **DISPROVEN**

Reproduced through the real API on synthetic data. The reachable window is
narrower than the report implied: an event auto-completes as soon as every
accepted volunteer is accounted for — **including as absent** — and a completed
event cannot be cancelled. So cancelling an event that has credited hours
requires at least one accepted volunteer still *unrecorded*.

| Scenario | Before | After cancellation | Uncancelled |
|---|---|---|---|
| attended + credited (one volunteer unrecorded) | row `present=1 hours=4`; ledger `delta=4`; credited 4, raw 4 | **rows unchanged, ledger unchanged**; credited **0**, raw 4 | credited **4** again |
| attended + absent (all accounted) | event auto-completes | cancellation **refused**, 409 | — |
| no attendance record | — | cancelled, 200, no rows | — |
| closed out | status `completed` | cancellation **refused**, 409 `event_completed` | — |
| ledger parity throughout | — | **`ok: true`, 0 mismatches** | — |

Each element of the report is explained by the documented model:

- **No ledger row.** Required by the invariant above. Cancellation changes
  neither `present` nor `hours_awarded`, so `delta` would be 0 by construction;
  a row carrying a *meaningful* delta would break parity — measured in pass 6 at
  ledger 11 vs filtered attendance 4.
- **Attendance untouched.** The record/presentation distinction, exactly.
- **Reversible.** Correct under that distinction. Nothing was destroyed, so
  nothing has to be reconstructed; uncancelling restores a presentation, not
  data.
- **No audit row** — verified with a positive control (close-out writes
  `EVENT_HOURS_CLOSED_OUT`; cancellation writes nothing, by the same query).
  Consistent with **both** stated audit principles: an organizer's own listing
  act is deliberately not audited ("not an exercise of power over another
  person … would bury the rows that matter"), and the act that *is* audited is
  audited because "this is the one action on the platform that makes a
  student's service record **unchangeable**" — which a reversible act is not.

### R-1 / close-out interaction — no contradiction, established from code

Close-out requires `status === 'completed'`; `PATCH /api/events/:id/status`
refuses a completed event. So a closed-out event **cannot** be cancelled, and
the close-out route says it relies on exactly that: "There is no reopen route
and no `DELETE` … `PATCH /api/events/:id/status` already refuses a completed
event, so the precondition cannot be unwound either." Confirmed empirically:
409 `event_completed`.

### R-4 — **DISPROVEN**

The ledger is not write-only. Complete production inventory:

| Operation | Location | R/W | Production? | Purpose |
|---|---|---|---|---|
| `createHoursLedgerTable` | `db.js` | schema | yes | boot |
| `recordHoursChange` | `attendance.js` | **write** | yes | the only writer — every attendance mutation |
| `backfillHoursLedger` | `db.js` boot, migration 053 | write | yes | history for pre-ledger rows |
| `verifyLedgerParity` | `db.js` boot, `verifyHours.js` | **read** | yes | integrity gate; exits non-zero in the CLI |
| `hoursLedgerStatus` | `adminRoutes.js`, `ownerRoutes.js` | **read** | yes | surfaced in the Owner Center as "Diverged — N volunteers do not reconcile" (`OwnerCenter.jsx:592`) |
| `getLedgerForUser` | — | read | **no caller** | per-user itemised history |

So it is **audit and integrity infrastructure with live readers**, one of which
an owner looks at. Only the per-user history is unwired, and that is documented
rather than overlooked — the function's own header says "no route calls
`getLedgerForUser`", explains that wiring it would require a monotonic column
plus a backfill ("a schema change and a cutover decision"), and says it is
tracked. **Verified: `POSTGRES_MIGRATION_STATUS.md:2268` records it**, with the
same caveat for `moderation_actions`.

Nothing was deleted. Removing it would remove the only reader of the history
the table exists to hold, at the moment the migration it is blocked on lands.

### One observation, not a defect

`EVENT_CANCELLED` is CRITICAL priority and says only "The organizer has
cancelled this event." A volunteer who had already been credited for it is not
told that those hours have stopped counting toward their total. Whether it
should say so — and only for recipients who actually hold credited hours, since
most cancellations precede any attendance — is a copy decision, so it is
recorded rather than made.

### Verification

No code changed, so there is nothing to regress. The matrix above was produced
by temporary probes through the real API against synthetic events and the
seeded demo accounts; both probes were removed and the tree is clean. No
production database was touched.

---

## Pass 8 — badge triggers and floors (R-5 … R-8)

Four findings, investigated and committed separately because they are four
different questions that happen to live near `badgeService`.

### The trigger graph, as it was

| Trigger | Caller | Badges it could affect | Production? |
|---|---|---|---|
| attendance finalised → credited | `attendanceRoutes.js:176`, for `c.userId` | all, for the VOLUNTEER only | yes |
| attendance finalised → revoked | `attendanceRoutes.js:205`, for `r.userId` | all, for the VOLUNTEER only | yes |
| QA seed script | `bin/seed-qa-profile.mjs` | all | no |

Nothing else on the platform asked. Manual award (`POST /api/admin/badges/award`)
bypasses evaluation entirely and is audited.

### R-5 — **DEFECT. FIXED `e57a2bb`**

Two criteria do not depend on attendance: `events_created` (Organizer ≥ 1,
Community Builder ≥ 10) and `early_adopter` (Early Supporter, by `joinRank`).
Neither was ever evaluated by the act that satisfies it.

Reproduced on synthetic data through the real API:

| Scenario | Result |
|---|---|
| organizer, **12** non-cancelled events, never volunteered | **zero badges** |
| the same account then credited as a volunteer elsewhere | Organizer, Community Builder **and** Early Supporter arrive at once |
| student at `joinRank` 17, never volunteered | **no** Early Supporter |
| Early Supporter `earned_at` | the evaluation timestamp, not the account's `created_at` |

So not unearnable in the abstract — reachable only through an unrelated action,
and unreachable for anybody who never performs it. `badgeService` already
describes that state as a defect it fixed once: the `early_adopter` branch used
to be empty, leaving the badge "unearnable by every code path in the
application — it sat in the catalogue looking like something to aim for". The
evaluator was fixed and the trigger was not.

**Four explicit triggers**, each tied to its eligibility event rather than a
run-badges-everywhere hook: event create, event duplicate, event status change
(the mirror — evaluated for the event's *organizer*, since an admin cancelling
somebody else's event changes that organizer's count), and signup.

Creation rather than completion, because `collectStats` says why it counts
`status != 'cancelled'`: requiring completion would withhold the badge "until
that opportunity had already finished — which is not what it says, and is not
when the recognition is worth anything."

Repeat evaluation verified safe rather than assumed: awards insert only when no
row exists, `user_badges` carries `UNIQUE(user_id, badge_id)`, the announcement
dedupe key is permanent, and `evaluateBadges` catches its own errors so none of
these can fail the request it hangs off. `df4e815` is respected — `collectStats`
still excludes cancelled events.

### R-5 · Early Supporter dating — resolved by the criterion, not chosen

`collectStats` explains that eligibility is a **rank** and not a date precisely
because "the number of accounts created before yours never changes". The answer
is therefore final the instant the row exists, which makes signup the only
moment at which the stored date and the eligibility date can agree. No owner
decision was needed: the repository settles it.

### R-6 — **DEFECT. FIXED `0b8030e`**

`BADGE_CRITERIA_META` marked `early_adopter` `threshold: false`, so
`AdminBadges` omits the input and the definition saves with `criteria_value` 0
— while `meetsCriteria` requires `threshold > 0`, deliberately, so an
un-reconciled database fails closed. An administrator defining a new
early-adopter badge therefore got one that validated, saved, appeared in the
catalogue and could never be earned.

The metadata's reading — "decided by when somebody joined rather than by how
much they have done" — is true of the question and false of the definition: the
threshold **is** the cohort size, and the seeded badge carries 250.
`badgeCriteria.js` names the outcome in its own header: a wrong unit "produces a
badge that is either trivial or unearnable, and the symptom of both is silence."

`manual` remains the only `threshold: false` type, correctly — `meetsCriteria`
answers `null` for it. The guard is written against the metadata, so any future
type hiding a threshold must answer the same question.

### R-7 — **Half intentional, half an owner decision. No change.**

- **Permanent dedupe on re-earning: intentional and documented.** `announce`
  keys on `badge:${badge.id}` so that "re-earning one after a revocation does
  not produce a second copy of the same congratulation … the right trade for a
  message whose entire content is 'you have this badge'."
- **Silence on automatic withdrawal: no mechanism exists.** There is no
  `BADGE_LOST` notification kind anywhere; `BADGE_REVOKED` exists only as an
  *audit* action on the manual admin revoke path. So automatic withdrawal is
  neither notified nor audited.

Whether losing a badge should be announced is a product decision, and there is
a reasonable case for silence: the withdrawal is a consequence of an attendance
correction the volunteer is already told about through `HOURS_ADJUSTED`, and a
second message naming the loss is the unkinder of the two. **Recorded, not
decided.**

### R-8 — **DEFECT. FIXED `74f8a38`**

Two discrepancies, not one. `reliability.js` abolished the applicant row's
floor by name — "three numbers answering one question, in three files,
disagreeing. `MIN_EVIDENCE` is the one that remains, **and every surface reads
it**" — and `ApplicantReview` kept a hardcoded 3. That claim was simply false.

The quantity was the worse half: the gate read `eventsSignedUp`, which counts
every commitment whose shift has **ended** whether or not anybody confirmed it.
So four shifts nobody had recorded read as four shifts missed, and the row told
an organizer "0 of 4 attended" about a volunteer with no record either way —
while `eventsAwaitingRecord` sits in the same payload specifically to keep those
apart, "because reading the second as the first is the specific unfairness this
whole set of definitions exists to prevent."

Now `attended + absent` against `MIN_EVIDENCE`, mirrored client-side the way
four other shared vocabularies already are.

**A test was changed rather than preserved, deliberately.** The case asserting
counts appear "once there are three completed commitments" encoded the
superseded number, not a product rule. A neighbouring case needed a new fixture
instead: it covers a volunteer with commitments but no confirmed *attendance*,
and its four unconfirmed commitments now legitimately read "New volunteer", so
it uses four recorded **absences** — past the floor, still nothing attended,
which is what the case is named for.

### Verification

| Check | Result |
|---|---|
| Focused | 9 server suites / 173 passed; client applicant + boundary / 27 passed |
| Full suite (R-5) | 640 files, **10,821 passed**, 0 failed, exit 0 |
| Full suite (R-6) | 640 files, **10,822 passed**, 0 failed, exit 0 |
| Full suite (R-8) | 640 files, **10,824 passed**, 0 failed, exit 0 |
| Output preserved | `/tmp/wev-r5-20260922-010301.txt`, `/tmp/wev-r6-20260922-010748.txt`, `/tmp/wev-r8-20260922-011155.txt` |
| Lint / build / bundle scan | clean |
| Mutation checks | **7** — four triggers, the metadata, and both halves of the applicant gate |

Reliable Volunteer's algorithm and wording (`c2f5fff`) were not revisited; no
evidence in this pass bore on them.

---

## Pass 9 — N-3, the join-request fragment

**Finding: N-3. Classification: Confirmed defect. FIXED `23988c5`.**

### Evidence

| Source | What it says |
|---|---|
| `server/services/notificationContent.js:694` | `ORGANIZATION_JOIN_REQUEST_RECEIVED` emits `/organizations/@${slug}#requests`, `ctaText: 'Review the request'` |
| `docs/superpowers/specs/2026-09-03-organization-share-links-design.md:353` | the intended destination, stated: "every manager … → **the requests section**" |
| `src/components/organizations/JoinRequestInbox.jsx:87-89` | the section's only id was its heading, `org-requests-heading` |
| `src/views/OrganizationPage.jsx:105` | `location` was read for `pathname` only — never `hash` |
| grep across `src/` | the only hash consumers were `LegalDocument` and `AdminDashboard`; no `id="requests"` existed anywhere |

No conflicting evidence: the spec, the CTA label and the notification body all
name the same destination.

### Failure mechanism — three independent causes

1. **No anchor.** Nothing carried `id="requests"`.
2. **No consumer.** The page never read the fragment, and the browser cannot
   substitute: this is an SPA, so when the fragment is resolved the club has not
   been fetched and the section does not exist. That is the same timing failure
   `LegalDocument.fragment.test.jsx` exists for.
3. **The redirect discarded it.** Canonicalisation rebuilt the URL from the
   pathname alone, so a non-canonical link — an id or a bare handle, both of
   which still resolve so that older notification rows keep working — was tidied
   into one carrying no fragment.

### Affected roles and path

Organization **managers and owners** (`viewer.canManage`) receiving
`ORGANIZATION_JOIN_REQUEST_RECEIVED`, in-app and by email — the email CTA is
`${APP_URL}${content.link}` and preserves the fragment. They arrived at the top
of a 1,100-line page with the queue inside a `canManage` band well below.

### Reproduction

`src/views/OrganizationPage.requestsFragment.test.jsx`, through the real page
with the real router: rendered at `/organizations/@chess-club#requests` as a
manager with one pending request. Before the fix, four cases failed — no
`#requests` element, no scroll, no focus, and none in the no-`scrollIntoView`
environment.

### Fix

One effect on the page that owns the destination, mirroring the two that already
exist — no new navigation architecture for one link. `id="requests"` and
`tabIndex={-1}` on the inbox section; the redirect carries the hash across.
Focus moves as well as scrolling, per the convention `LegalDocument` set: "the
deep link either works for everybody or it is decoration."

### Regression tests — 8

Non-vacuity (the section renders at all), the anchor exists, scroll, focus, a
no-fragment control (nothing scrolls, nothing steals focus), an unknown
fragment, a missing `scrollIntoView`, and the canonicalisation case.

### Mutation results

| Mutation | Result |
|---|---|
| remove `id`/`tabIndex` | 5 cases fail |
| remove the hash effect | 4 cases fail |
| redirect drops the fragment | 1 case fails |

The third earned its keep twice. Asserting **focus** in that case passed with
the fix reverted — both effects run in one commit, so the hash effect reads the
pre-redirect location and lands regardless. It now asserts the **settled URL**,
which is what Back returns to and what the reader copies.

### Verification

| Check | Result |
|---|---|
| Focused | 6 client suites / 76 passed; 2 server suites / 325 passed |
| Full suite | **641 files, 10,832 passed, 0 failed**, 178 skipped, exit 0 |
| Output preserved | `/tmp/wev-n3-20260922-012409.txt` |
| Lint / build / bundle scan | clean, exit 0 |

### Observation, not acted on

The hash-and-focus pattern now exists in three places (`LegalDocument`,
`AdminDashboard`, `OrganizationPage`) as three local copies. Extracting it would
mean touching two working call sites for a defect that needed one — recorded
rather than done.

**No new owner decision.** The five already open are unchanged.

---

## Pass 10 — N-4, the calendar and the admin/partner rails

**Finding: N-4. Classification: the admin half is an OWNER DECISION, not a
defect. The partner half is a separate, smaller confirmed inconsistency.
No code changed.**

### The claim investigated

That `/calendar` is "invisible/inaccessible to admin and partner accounts".

### The five questions, answered separately

| | Question | Answer |
|---|---|---|
| A | Does the route exist? | Yes — `CalendarView`, `requiredCap: 'event.view'` (`routes/index.jsx:234`) |
| B | Can admin and partner reach it? | **Yes, both.** Verified by rendering the real shell at `/calendar`: all four roles render the calendar, no 403 |
| C | Does either see a nav link? | **Neither.** The entry is `requiredCapAny: ['event.apply','event.create']` (`App.jsx:331`); measured with `navSectionsFor`, admin's primary is `[Dashboard, Discover, Messages, Welly, Admin]` and partner's is `[Discover]` |
| D | Is the data right if it loads? | **admin: yes** — holding `event.moderate`, their session index is fetched unfiltered, so theirs is the only district-wide calendar. **partner: empty** — `{mine: 'true'}`, and a partner hosts nothing and applies to nothing |
| E | Is the absence intentional? | **admin: unresolved — see below. partner: no title exists at all** |

Capabilities, measured rather than read: `event.view` is held by student,
organizer, admin **and** partner; `event.apply` by student only; `event.create`
by organizer only; `event.moderate` by admin and super_admin.

### Why the admin half is not a defect — and the correction that got me there

The tempting reading is that `PAGE_META.staff.calendar` — "Events across the
district and when they close" — is copy written for an administrator, which
together with their unfiltered index would make the missing rail entry an
oversight. **That reading does not survive checking what `staff` means.**

`PERSONAS` (`App.jsx:97`) keys `staff` on `event.moderate` and the comment says
so outright: "`staff` covers admin AND super_admin". A super_admin **already
has** the Calendar entry, via `*`. So the staff copy is fully explained without
any claim about administrators, and it singles out nobody.

Against that, two exact pins encode the current admin rail:

- `App.shellByRole.test.jsx:210` — `['admin', ['Dashboard','Discover','Messages','Welly','Admin','Notifications','Profile']]`, under the name "admin nav is what its capabilities justify"
- `App.shellByRole.test.jsx:324` — the same list through the rendered shell

Their commentary is meticulous about every other inclusion and exclusion — why
`Messages` was gained (migration 018 made the inbox non-empty), why
`Audit Explorer` and `Admin Roster` are withheld (`audit.read` moved to
SUPER_ONLY) — and says **nothing** about Calendar. That silence cuts both ways
and is not evidence either direction.

So the repository holds two coherent readings of one rule and settles neither:

1. **The calendar is for people who have shifts or run them** — `event.apply ||
   event.create`. An administrator does neither, so excluding them is
   consistent, and the pins record it.
2. **The calendar is for people who oversee events** — which is what
   `event.moderate` means and what the unfiltered index delivers.

Nothing in the specs, docs, changelog or commit history chooses. **This is a
product decision about who the calendar is for, so it is reported rather than
made.**

I initially implemented reading 2 — adding `event.moderate` to the gate, with
tests that bracketed it in both directions — and reverted it on finding the
persona comment. Recorded because the reasoning is the useful part: a
purpose-written page title is not intent evidence for a role when the persona it
belongs to covers two roles and the other one already has the entry.

### The partner half — a different, verified finding

Not "inaccessible". A partner **can** reach `/calendar`, and when they do the
page renders under the title **"WeVolunteer"** — measured, not inferred — because
`PAGE_META.partner` has no `calendar` entry and the shell falls through to
`{ title: APP_NAME, sub: '' }`.

That is the exact defect the partner block's own comment describes for
`profile`, and its stated convention argues for the entry: the other partner
entries are there "for completeness rather than because a partner reaches them
today … they cost nothing and mean that granting either capability later does
not reintroduce an untitled page." `calendar` is the one page a partner
genuinely reaches today, and it is the one with no title.

**Left alone deliberately.** A title would frame a page that is structurally
empty for that role, and deciding what a partner's calendar should contain is
the same unanswered question as above. Fixing the copy without answering it
would be decoration.

### Verification

No code changed. Full suite re-run to confirm the tree is exactly as the pass
found it: **641 files, 10,832 passed, 0 failed, 178 skipped**, exit 0, output at
`/tmp/wev-n4-20260922-014135.txt`. Lint, build and bundle scan clean.

### New owner decision

**Who is the calendar for?** If overseeing events counts, `event.moderate`
belongs in the nav gate and two pins in `App.shellByRole.test.jsx` need updating
deliberately. If it is for people with shifts, the current gate is right and a
partner should arguably be kept off the route rather than left on an untitled
one. The partner title follows from whichever answer is given.

---

## Pass 11 — N-5, the partner dashboard "dead end"

**Finding: N-5. Classification: DISPROVEN as a defect — an intentional terminal
informational state for a role the repository documents as unfinished. No code
changed.**

### The claim investigated

That a partner has no dashboard: `/` renders an `EmptyState` with no action, and
the brand mark navigates there unconditionally.

### Both structural facts are true

- `DASHBOARD_NAV` (`App.jsx:143-147`) has no `partner` key, so `navItemsFor`
  emits no `/` entry for them.
- `App.jsx:2015` renders `<EmptyState title="No dashboard for this account">`
  with **no `action` prop**.
- The brand mark (`App.jsx:1845-1852`) is `href="/"` with
  `onClick → navigate('/')`, unconditionally and with no role check.

### Why it is not a dead end

The empty state's copy names two exits — "Browse opportunities from the
navigation, or change your account settings" — and **both were measured to
work**, by mounting the real shell at `/` as a partner:

```
rail/sidebar controls = ["WeVolunteer Community", "Discover", "🏢Pat Partner…"]
account menu items    = ["Profile", "Notifications", "Settings", "Sign Out"]
controls INSIDE the empty state = []
```

So the reader has a meaningful next action, a route to perform it, and a valid
destination. The original report treated Settings as not counting because it is
"not in their rail either (it is in ProfileMenu)" — but the copy attaches "from
the navigation" to browsing, not to settings, and `ACCOUNT_MENU_ITEMS` gates
Settings on nothing at all.

### The state is documented as unfinished, in three independent places

| Source | What it says |
|---|---|
| `PAGE_META.partner.dashboard` (`App.jsx`) | "Partner accounts do not have a dashboard yet" |
| the empty state itself | "This account type does not have a dashboard yet." |
| `server/authz.js:471-474` | `analytics.public` "stays registered and still reads nothing: it is the name for figures chosen FOR an outside reader, and **that surface has not been designed**. A partner who should see a figure is the argument for building it, not for reusing the administrators' page." |

The third is the decisive one: it is not silence, it is a recorded decision not
to reuse an existing screen, with the condition under which the real one gets
built.

### Partner states — there is only one, and that was established rather than assumed

The brief asked for partner-with-events, partner-with-applications and so on to
be tested separately. They are unreachable by construction. The partner
capability set is `['analytics.public', 'event.view', 'geocode.use',
'persona.preview.exit']`, so a partner holds:

- no `event.create` → cannot create or host an event
- no `event.apply` → cannot apply to one
- no `organization.join` → cannot be a club member, so cannot hold
  `manager`/`student_organizer`, which is the only other route to events
  (`organizationRoles.js:81` reads `organization_members.member_role`)

One reachable data state, and it is the one exercised above.

### Observation, not a defect

The two exits are named in prose and have no button: `EmptyState` supports an
`action` and none is passed. A "Browse opportunities" control would be a small
improvement — and it belongs to the same undesigned surface, so it is recorded
rather than added. Putting a CTA on a page whose entire message is "this does
not exist yet" is a product decision about what a partner's home should be, not
a navigation fix.

### Verification

No code changed. Both temporary probes removed and the tree confirmed clean.
Full suite re-run: **641 files, 10,832 passed, 0 failed, 178 skipped**, exit 0,
output at `/tmp/wev-n5-20260922-015633.txt`. Lint, build and bundle scan clean.

### New owner decisions

**None.** The partner product being unfinished is already recorded as a decision
in `authz.js`, and the N-4 question ("who is the calendar for?") remains the
open one that touches this role.
