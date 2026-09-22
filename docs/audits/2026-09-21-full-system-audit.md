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
