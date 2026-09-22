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

### 1.6 Navigation and cross-feature coherence — reported, since adjudicated

*Heading corrected at closeout: every N-item below was adjudicated in passes
5 and 9–12. The pointer under the table names the pass for each, and pass 16
carries the reconciled status.*

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

*The table is the intake record, written before any of it was checked. Every row
is adjudicated later in this document: N-1/N-2 in pass 5, N-3 in pass 9, N-4 in
pass 10, N-5 in pass 11, and N-6 … N-17 in pass 12. Six of the seventeen did not
survive verification.*

---

### 1.7 Findings reported and awaiting verification

Recorded with their evidence; **none acted on yet**. Each is promoted to
`Verified` or dismissed before any change is made.

*Corrected at closeout: that was true when written and is not true now.
R-1 … R-8 were all adjudicated — see passes 6–8 and the reconciliation in pass
16. **R-9 … R-12 were never investigated in this run** and remain exactly as
reported: intake claims, unverified, not acted on. They are carried forward as
open items rather than closed, because nothing in this audit examined them.*

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

### Open question 1 — milestones — **ANSWERED at closeout: owner decision 3 (3C), `83c9f68`**


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

### Open question 2 — the public certificates list — **ANSWERED at closeout: owner decision 2 (2D), `7fce206`**


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

**Open question for the owner** *(answered at closeout: owner decision 1 chose
1A, the permanent lock; no correction path was added, and the policies were
corrected instead — `d776b72`)*. Should a post-close-out credit be correctable —
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

### R-7 — **Half intentional, half an owner decision. No change at the time.**

*Closeout: the owner-decision half is answered. Owner decision 5B chose audit
without notifying, implemented in `7c01dfe`; automatic withdrawal now writes
`BADGE_WITHDRAWN` with the actor. The permanent re-earn dedupe is unchanged and
remains intentional. R-7 is therefore OWNER-DECIDED rather than open.*


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
| E | Is the absence intentional? | **admin: unresolved at the time — answered at closeout by owner decision 6A. partner: no title exists at all — fixed by 6B, `dfd0eb0`** |

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

---

## Pass 12 — N-6 … N-17, and the two low-severity items

Worked in one unattended run. Each item was reconfirmed against the repository
before anything was changed, and six of the twelve turned out not to be defects.
Every fix is its own commit, so the item that caused it is identifiable from
`git log` alone.

### N-6 — **DEFECT. High. FIXED `e18a010`**

Three actions that destroy other people's records were gated on
`window.confirm`: denying an organizer (which removes their account), and
removing an event from either dashboard (which removes every sign-up under it).

The intent was documented rather than inferred. The stabilization report lists
it at P2 — "`window.confirm` remains in 7 non-auth places; `ConfirmDialog`
exists to replace them" — and the deployment runbook records the cost at L5,
roadmap P2-7: "Unstyled, poor on mobile, and with no room to explain
consequences ('this will remove 12 sign-ups')."

That last clause was the substance of it. `OrganizerDashboard` had **already
computed the count** and pushed `${signups} volunteer sign-ups will be removed
with it` through a `\n\n` that the browser typeset. The number now reads as a
sentence, emphasised, in the place the decision is taken.

Scoped to those three. `ConfirmDialog`'s own header scopes its argument to the
two security actions it was written for, so this is not a claim that every
`window.confirm` must go — the six remaining (comments, announcements, Welly's
local history, a volunteer withdrawing their own application) are left alone.

Each dialog is rendered at the component root rather than beside its button:
both admin controls sit inside tables that re-render on every `loadData`, and a
dialog mounted in a row unmounts underneath the reader when the queue refreshes.
Authorization is untouched — `eventPermissions().canDelete` still gates the
control, the server still refuses an event with attendance, and the 409
evidence-hold explanation still lands on both dashboards.

Mutation-checked four ways: each control wired straight back to its action, and
the sign-up count removed. Every case failed only its own assertions.

### N-7 — **DISPROVEN in two of three parts; the third is intentional**

The claim was that `PublicProfile` and `VolunteerProfile` differ in content,
**addressability** and **back behaviour**.

- *Addressability* — **false**. `VolunteerProfile` is not a state overlay. It is
  backed by search params: `profileId`/`profileType` are read from the URL
  (`src/App.jsx:1167-1169`) and `setViewingProfileState` writes and clears
  `?profile=&type=` through `setSearchParams` (`src/App.jsx:1295-1307`). So it
  survives a reload and a copied link, exactly as the event modal does.
- *Back behaviour* — follows from the above: the browser Back button dismisses
  it, and the view draws its own back control besides.
- *Content* — true, and deliberate. The two answer different questions, each
  stated in its own header: `PublicProfile.jsx:1-25` is "who somebody is … not
  an information dump about an account", `VolunteerProfile.jsx:13-19` is "a
  volunteer's record of service". `/profile` picks between them by
  `selfProfileFor` (`src/App.jsx:215-218`) for a reason recorded above it — the
  cascade used to send an account that both runs the platform and volunteers to
  a page that showed a total and nothing else.

No privacy difference, which was the one thing that would have made this a
defect rather than a shape: both routes gate on `directory.read`
(`server/routes/userRoutes.js:52`, `server/routes/directoryRoutes.js:128`), both
put PII behind `canSeeContact`, and both honour the subject's service-visibility
setting (`canSeeHours` on one, `visibilityState` via `profileSerializer.js:328`
on the other).

**Observation, not acted on.** Two reachable views of the same person, with no
link between them. Adding one is a product decision about which is "the" member
page, not a navigation fix.

### N-8, N-9 — **Latent, not live. No change.**

Both depend on a non-staff account holding `analytics.impact`, `appeal.review`
or `event.moderate`. None can:

- `capability.grant` is registered (`server/authz.js:327`) and **no route
  requires it** — the grep over `server/routes` returns nothing.
- The only caller of `grantCapability` outside its own module is
  `syncOrganizerCapabilities` (`server/organizationRoles.js:107`), which writes
  exactly `STUDENT_ORGANIZER_CAPABILITIES` (`server/organizationRoles.js:48-53`):
  four organization-scoped capabilities, none of the three above.
- The only other writer of `user_capabilities` outside that path is a `DELETE`
  in the admin reset (`server/routes/adminRoutes.js:2401`).

`analytics.impact`'s own comment does contemplate an administrator extending the
figures "to one account through `capability.grant`" (`server/authz.js:417`), so
the design intends this to become reachable. Until a route exists, the hub
gating is not reachable-and-wrong; it is unbuilt. Recorded so that whoever adds
the grant route knows these two tiles are waiting behind it.

### N-10 — **DEFECT. Medium. FIXED `e84957d`**

`/users/:handle/badges` exists, is gated on `directory.read`, and its route
comment gives the reason it is a profile route: "reading somebody's badges is
reading their profile." The profile linked service history and certificates and
not badges, so the one page whose whole subject is this person's recognitions
was reachable only by typing the URL.

The link is **unconditional**, unlike the certificates link beside it. That one
is conditional because a student can set `serviceVisibility.certificates =
'private'`, and the note there says a link to a page that will refuse "is an
invitation to discover the setting". Badges carry no such setting —
`GET /api/users/:userId/badges` gates on `directory.read` alone, which any
reader of this page already holds — so the link cannot lead to a refusal, and
making it conditional would withhold it for nothing. That distinction is
asserted rather than assumed: one case sets certificates private and checks that
badges survive while certificates go. Mutation-checked by removing the link.

### N-11 — **DEFECT. Medium. FIXED `503c3c8`**

Welly's `applications` destination emitted `/discover?find=applications`. `find`
is a **scope**: `BrowseEvents` accepts `all | events | people | organizations`
and falls back to `all` for anything else, in silence. So Welly announced
"Navigating to Your Applications" and delivered the generic Discover page.

Reachable through any explicit phrasing — measured, all five of "take me to my
applications", "open my sign-ups", "go to the applications page" and two others
resolved to that path. It survived because the ordinary phrasing "show my
applications" routes to the `my_applications` **tool** and answers with data,
never consulting the destination table at all; the common case was always fine.
(I initially had this backwards mid-investigation and corrected it by probing
the router rather than reading it.)

There is no applications page to point at. A student's pending and confirmed
applications are sections of the volunteer dashboard — "Waiting on a reply" and
"Confirmed shifts" — so the dashboard is the honest destination, and the label
still describes what they asked for.

The existing pin asserted the old path under the name "canonical app routes",
which is the one thing it was not, so it was updated deliberately rather than
relaxed. The new guard is written over the **whole** destination table: every
path must be one `server/clientRoutes.js` serves, and any `find` it carries must
be a scope Discover accepts. Two false positives were found and corrected while
writing it — `/profile` and `/` are served but absent from `APP_ROUTES`, and
`?section=` is a key Settings genuinely reads — so it validates `find` alone
rather than re-implementing other pages' parsing.

### N-12 — **DEFECT. Medium. FIXED `d3402f9`**

Archiving a club, and cancelling its creation, both exited to `/directory` — a
redirect to `/discover?find=people`. So archiving a club left the manager in a
search for students, and pressing Cancel on "create organization" answered a
question about clubs with a list of people.

`/organizations` is right for both: it lists "You manage" and "You belong to",
and it is where `OrganizationsHome` links to the create form from. It cannot
refuse them either — checked rather than assumed: `organization.create` is held
by organizer and admin, and both also hold `organization.join`, which is what
`/organizations` requires. Cancel while **editing** already returned to the club
and is untouched; that distinction is asserted, and mutation-checked by
flattening both exits into one, which fails the editing case alone.

### N-13 — **One part a defect (FIXED `0fe739d`); the rest is terminology, deliberately not touched**

The item bundled four claims. Only one is a wrong destination:

1. **"Browse organizations" pointed at two different pages — FIXED.** The
   not-found screen's button went to `/organizations`, the clubs the reader is
   already in, while `OrganizationsHome` uses the same phrase for the
   platform-wide search — and Discover's action row calls `/organizations`
   "Your organizations" (`src/views/BrowseEvents.jsx:679-683`). One label, two
   pages; one page, two labels. Repointed at `/discover?find=organizations`,
   which is also better on its own terms: somebody whose club link no longer
   resolves is trying to find a club. Same capability either way — both require
   `directory.read`. Added `src/labelDestinations.test.jsx`, a source-level
   guard that a label naming a destination resolves to exactly one route.
2. **Four labels for `/events/new`** — left alone. "Create event", "New event",
   "Post an opportunity" and "New opportunity" are a copy decision across four
   surfaces with different readers, not a broken link, and the page title is
   already the canonical one.
3. **application / sign-up along the role line** — left alone. The split is
   consistent and intentional: a volunteer *applies*, an organizer reads
   *sign-ups*. Collapsing it is a vocabulary decision with no defect behind it.
4. **Five names for the service-hours record** — see N-15, where the same five
   destinations already carry a recorded decision.

Items 2-4 are (D) optional, and under the standing rule only A/B/C become work.

### N-14 — **Not a defect. No change.**

`/organizations` has no menu entry, and that is a structure rather than an
omission. It sits one click behind the rail's first destination: Discover
carries a labelled "Your organizations" action (`src/views/BrowseEvents.jsx:679-683`),
whose gate is `can(currentUser, 'organization.join')` (`:599`) — **exactly** the
capability the route requires (`src/routes/index.jsx:282`). So no role holds the
page without a path to it, and none is shown a link that would refuse. The
primary tier is capped at six on purpose, which `src/accountMenu.js:61-63`
records in the course of declining the rail for `/hours` for the same reason.

The comparison with `/welly` does not survive contact either: the rail entry for
Discover exists partly *because* clubs live behind it — "a reader who wanted a
club had no way to tell from the rail that this was where clubs live"
(`src/App.jsx:306-315`).

### N-15 — **DISPROVEN. A recorded decision, not a missing hub.**

The five destinations are named exactly, in `src/accountMenu.js:43-69`, and one
of them is promoted into the account menu with the reasoning stated: "`/hours`
is the right one of the five to promote: it is the whole record, WeVolunteer and
self-reported together, and the other four are linked from it or from the
profile beside it. **Promoting all five would move the problem into the menu.**"
The same comment declines the rail for it, and gates the entry on
`portfolio.write` so three roles are not offered a page that answers 403.

That is the hub question asked and answered. A reader who wants their record has
a menu entry; the other four hang off it.

### N-16 — **Half a defect (FIXED `883f06d`); half polish, declined**

Two empty states named an action and offered nothing to take it with: the
unverified-organizer screen — the *whole dashboard* for every organizer between
registering and being approved — said "You can browse opportunities in the
meantime" and carried no control, and the calendar's empty day said "Pick
another date, or browse opportunities to fill it" and carried none either. Both
are recoverable, since Discover is in the rail for everybody who can reach
either screen, which is what makes this a broken promise rather than a trap.

Scoped to those two. The other four hand-rolled empty states state a condition
and name no action — "No confirmed volunteers yet", "Nothing scheduled", "No
pending applications", "No past shifts yet" — and an empty state is not required
to offer an action, only not to promise one it withholds.

Not converted to `EmptyState`: swapping either card wholesale would move custom
content (the organizer card carries the demo-bar notice inside it) for a styling
gain this finding did not ask for. The item's other half — four raw
`<input type="date">` against the shared `DatePicker` — is declined for a
stronger reason: all are correctly bounded, `LegalEditor` documents its native
input as deliberate, and `LogExternalHours` is additionally refused a future
date server-side. That is polish, not correctness. Mutation-checked by removing
each control in turn.

### N-17 — **DEFECT in the guard itself. Medium. FIXED `af08856`**

`serverLinks.test.js` reads one line at a time, so a `link:` ternary spanning
three lines matched nothing — neither arm sits on the `link:` line. Two links
are written that way, and they are exactly the two carrying a query string and a
fragment, which is to say the two most likely to be wrong.

One of them was. `ORGANIZATION_JOIN_REQUEST_RECEIVED` pointed at `#requests`, an
id that existed nowhere (that is N-3, fixed at `23988c5`), and the guard whose
entire job is to catch a destination that goes nowhere reported coverage it did
not have.

A second whole-file pass rather than widening the per-line loop: those patterns
use `$` anchors and per-line `continue`s that mean what they say only on one
line, and widening them would change what every existing case matches in order
to fix a case none was written for. The line number is derived from the match
offset, so a failure still points at the `link:`.

Proven two ways: removing the pass fails the new case, and with the pass in
place a planted dead multi-line link is caught and reported at
`notificationContent.js:693` — which is the behaviour that was missing, not just
the absence of a false pass.

### Low item 1 — iOS capability reason — **Unreachable, annotated not deleted. `a521eb9`**

`detectCapability`'s `if (isIOS)` branch explains that only the smallest model is
offered on iPhone and iPad. No iOS reader sees it: reaching it needs `fits`
non-empty, `fitsDevice` rejects a model that is not `conversational`, and the
only model under the 200 MB `IOS_MAX_MODEL_BYTES` is the 105 MB `fast` tier,
which is withheld from conversation. Every iOS device takes the
`fits.length === 0` return above and is told the assistant is unavailable here.

Left in place — it is defensive, not dead, and becomes both reachable and
correct the day the ceiling rises or a small conversational model is added.
Annotated so nobody reads it as a description of what iOS shows today. Comment
only; no behaviour change, and therefore no regression test.

### Low item 2 — `summarise('profile')` — **DEFECT. Low. FIXED `7729f70`**

`summarise()` flattens every user-authored value it interpolates through
`plainValue`, so a value cannot forge a turn boundary in the history
`sanitizeHistory` replays into the next prompt. `case 'profile'` was the one
exception: it took `name` and `role` from `api.getMe()` unflattened.

Self-targeting — the only name it can carry is the reader's own — so this was a
hole in a defence, not a route to anyone else's data. Closed anyway, because
`accountValidation` checks a name for length and trims it and nothing else,
which leaves exactly the control characters `plainValue` exists to remove.
Applying a defence in six of seven branches is how the seventh gets forgotten.

The regression goes through `ask()` rather than the unexported `summarise`, and
holds both halves: no line structure survives, and the words do — this flattens,
it does not censor. Reverting either `plainValue` call fails both hostile cases
and leaves the ordinary-profile case green.

### Verification

Full suite: **648 files, 10,866 passed, 0 failed, 178 skipped**, exit 0.
Complete untruncated output at
`…/scratchpad/wev-full-20260922-final.txt`. `npm run lint` clean, `npm run
build` exit 0, and a bundle scan over all 164 emitted chunks for eight
server-only strings (`pilot.db`, `WEV_DB_PATH`, `node:sqlite`, `JWT_SECRET`,
`process.env.DATABASE`, `SUPER_ONLY`, `hours_ledger`, `bcrypt`) returned zero
hits. Working tree clean.

No production database was opened, no production deployment was made, and no
real service-hour data entered a fixture or a log at any point in this pass.

### New owner decisions

**None.** N-8/N-9 record a dependency on unbuilt work rather than a question,
and the N-13 terminology items are (D) optional by the standing classification.

---

## Pass 13 — Priority 6: the three destructive confirmations, one at a time

N-6 was fixed as a single commit because the three share one mechanism. Priority
6 asks a different question of each — *is the existing confirmation actually
inadequate **in this context**, what is the intended behaviour, and can it be
made safer without touching authorization or product semantics* — so each is
answered separately here.

### Is `window.confirm` inadequate at all? — three reasons, not a preference

1. **It can be suppressed.** A browser that has had "prevent this page from
   creating additional dialogs" ticked returns `false` without drawing
   anything. For a destructive action that is the safe direction — the action
   does not happen — but the reader is given no indication why their click did
   nothing, and the same suppression applies to every later confirm on the page.
2. **It cannot carry structure.** The consequence sentence is the whole point of
   a destructive confirmation, and a `confirm` string can only be plain text
   with `\n\n` for a paragraph. `OrganizerDashboard` was already pushing a
   computed sign-up count through one.
3. **It is recorded as intended work, twice.** The stabilization report lists it
   at P2 — "`window.confirm` remains in 7 non-auth places; `ConfirmDialog`
   exists to replace them" — and the deployment runbook at L5, roadmap P2-7,
   names the cost: "Unstyled, poor on mobile, and with no room to explain
   consequences ('this will remove 12 sign-ups')."

So the intended behaviour is not inferred. It is written down, and the component
it names already exists.

### Finding 6a — deny an organizer (`AdminDashboard`)

**What it destroys:** the applicant's account, not merely their request. The
old string did not say so.

**Now:** "Deny this organizer?" over "<name>'s account will be removed, and they
will have to register again to ask a second time. This cannot be undone."
(`src/views/AdminDashboard.jsx:718-732`). The name is the row's own, so the
dialog cannot describe the wrong person.

**Authorization untouched.** The control's gate and the endpoint are unchanged;
this action carries `busy={busyId === denying.id}` so the confirm cannot be
double-fired while the request is in flight.

### Finding 6b — remove an event (`AdminDashboard`)

**What it destroys:** the event and every sign-up under it.

**Now:** "Remove this event?" over "'<title>' and all of its sign-ups will be
deleted. This cannot be undone." (`src/views/AdminDashboard.jsx:734-747`).

**Authorization untouched**, and deliberately so: the server still refuses an
event that has attendance recorded against it, and the 409 evidence-hold
explanation still lands on the dashboard. The dialog is a second chance to stop,
not a second gate — moving any part of the refusal into the client would have
weakened the real check.

### Finding 6c — delete an event (`OrganizerDashboard`)

**What it destroys:** the same thing, from the owner's side.

**Now:** "Delete this event?" over "'<title>' will be deleted. **N volunteer
sign-ups** will be removed with it. This cannot be undone."
(`src/views/OrganizerDashboard.jsx:819-833`). The count was *already computed*
for the old string; it now reads as a sentence with the number emphasised,
which is exactly the sentence roadmap P2-7 used as its example. The clause is
omitted rather than printed as zero when there are none.

**Authorization untouched:** `eventPermissions().canDelete` still gates the
control.

### One structural decision shared by all three

Each dialog is rendered at the **component root**, not beside its button. Both
admin controls sit inside tables that re-render on every `loadData`, and a
dialog mounted inside a row unmounts underneath the reader when the queue
refreshes behind it. The pending row is held in state (`denying`,
`removingEvent`, `deletingEvent`) rather than an id, because the dialog has to
name it.

### What was deliberately left on `window.confirm` — six sites

`ConfirmDialog`'s own header scopes its argument to the two security actions it
was written for, so this is not a finding that every `window.confirm` must go.
The remaining six destroy nothing of anyone else's:

- `EventComments.jsx:52`, `EventAnnouncements.jsx:71`,
  `OrganizationAnnouncements.jsx:72` — the author deleting their own post.
- `VolunteerDashboard.jsx:117` and `EventModal.jsx:267` — a volunteer
  withdrawing or releasing **their own** application. Re-checked in this pass:
  both are self-affecting, and both already phrase the accepted case
  differently from the pending one.
- `WellyView.jsx:594` — clearing conversation history on this device.

A reader who suppresses dialogs and then cannot delete their own comment has a
recoverable problem. One who cannot tell why an account was not removed does
not.

### Verification

Covered by `AdminDashboard.destructiveConfirm.test.jsx` (160 lines) and
`OrganizerDashboard.deleteConfirm.test.jsx` (124 lines), added with the fix.
Mutation-checked four ways — each of the three controls wired straight back to
its action, and the sign-up count removed — and every case failed only its own
assertions. No authorization behaviour is asserted by these tests, because none
of it changed.

### New owner decisions

**None.** The intended behaviour was already recorded in two places, and the
scoping question (which confirmations must move) is answered by what each action
destroys rather than by preference.

---

## Pass 14 — §57 revisited, and the owner-decision register

Revisited last, as instructed, using only repository evidence.

### Status: still **UNRESOLVED**, and now resolved *as far as the repository can*

The brief's §57 said "the following material is the complete historical context
I am providing" and referred to "numerous highly specific historical UI/UX
requirements in the supplied product history". Only topic headings followed.
That is unchanged.

What this pass adds is a measured answer to the question P0-2 left open — *can
the repository stand in for it?* — instead of restating that it cannot.

### What the repository actually holds

| Source | Extent |
|---|---|
| `docs/history/` | 9 documents (launch blockers, production hardening, product-quality roadmap, v1.1 audit and design, the BLOCK2 hours-pipeline/stabilization/mutation set, launch-readiness roadmap) |
| `docs/spec/` | 13 files including six numbered chapters, five appendices and a `reviews/` directory |
| `docs/specs/` | 7 dated design and audit reports |
| `docs/audits/` | 14, this document included |
| `docs/features/` | 5, one per feature area |
| `docs/operations/` | 27 runbooks |
| `CHANGELOG.md` | 1,750 lines |

That is a substantial historical record, and it is the record this audit was
built from. But it is uniformly **downstream** material: it documents work done
and assumptions taken, authored after the requirement it serves. It answers
"what was built and why" and not "what was asked for".

The one file whose shape is close — `docs/audits/questions-for-owner.md` — makes
the distinction exactly. Its own header reads: *"Raised during the 2026-08-07
recovery audit. Work continued past every one of these under the stated
assumption; none blocked implementation."* It is a record of where intent was
**missing**, and of what was assumed in its absence. That is the opposite of a
requirements record, and it is the strongest evidence in the repository that the
§57 class of material was never written down here.

**Conclusion.** The specific, sentence-level UI/UX requests the brief describes
have no repository counterpart, and cannot be derived from one. The gap is not
narrowable by more reading.

### What the gap actually cost — measured, not estimated

Nothing in this audit was blocked by it. All twenty-five reported findings
(N-1 … N-17, R-1 … R-8) were adjudicated on repository and runtime evidence, and
seven of them were **disproven** on that evidence alone — which is the stronger
demonstration that the missing material was not load-bearing for the
verification work.

The residue of the gap is precise and enumerable: it is the set of questions
where the repository establishes *what the code does* but not *which behaviour
was wanted*. Those are the open owner decisions, and there are six.

### Owner-decision register — the six questions, open when written

*All six were answered in pass 15 and are reconciled in pass 16. Left in place
because the register is the record of what was open at that moment, and the
reasoning under each entry is what the decision was made against.*

Collected here because they were recorded pass by pass and never in one place.
Each is a product question the repository genuinely cannot answer; none has been
answered by assumption in the code.

1. **PostgreSQL cutover.** Both engines work; PostgreSQL is implemented,
   boot-tested and `POSTGRES_READY`, selected by `DATABASE_ENGINE=postgres`.
   Whether to cut over is a decision, not a defect (§ Stack, above).
2. **Hours are locked at close-out, permanently.** Reproduced on synthetic data
   through the real route: the first credit succeeds with no reason required,
   and every later correction — organizer *and* administrator — answers `409
   hours_locked`. So a mistake in the first entry is unfixable by anyone. Is an
   audited administrator correction wanted, or is permanence the point?
   (Pass 6, R-2's second half.)
3. **Losing a badge is silent.** Permanent dedupe on re-earning is intentional
   and documented; automatic withdrawal has no notification kind at all and is
   not audited either. There is a reasonable case for silence — the volunteer
   already hears about the attendance correction through `HOURS_ADJUSTED` — and
   a reasonable case against. (Pass 8, R-7.)
4. **Who is the calendar for?** If overseeing events counts, `event.moderate`
   belongs in the nav gate and two pins need updating deliberately; if it is for
   people with shifts, the present gate is right and a partner should be kept
   off the route rather than left on an untitled one. The partner page title
   follows from the answer. (Pass 10, N-4.)
5. **Milestones count a cancelled event.** `milestoneInputs` does so
   deliberately — "the service still happened" — and is explicitly different
   from `volunteerStats().eventsAttended`. Frozen as-is during the
   cancelled-hours work; recorded because it is a presentation choice a reader
   could reasonably expect to go the other way. (Pass 4, open question 1.)
6. **A cancelled event's certificate is hidden from the student's own list and
   shown on their public profile.** `GET /api/users/:id/certificates` has no
   cancelled filter; `GET /api/certificates` has one. Verified and deliberately
   not acted on, because which list is right is the product question.
   (Pass 4, open question 2.)

Separately, the **partner product being unfinished** is already a recorded
decision in `authz.js` rather than an open question — noted so it is not
mistaken for a seventh.

### The standing refusal, restated

No requirement in this ledger has been reconstructed from recollection, and
none will be. A remembered requirement is indistinguishable from an invented
one, and every claim in this document cites a file, a line, or a command that
was run. If the §57 material arrives it folds in as a new source and may
reopen items recorded here as intentional; if it does not, this gap stays
recorded as a gap.

---

## Pass 15 — the six owner decisions, answered and implemented

Answered on repository evidence during this audit, not deferred. Each is
recorded here with the option chosen, the evidence that chose it, and the commit
that implemented it. Where two principles conflicted, the conflict is named.

| # | Decision | Chosen | Commit |
|---|---|---|---|
| 1 | Post-close-out corrections | **Permanent lock (1A)** | `d776b72` (docs only) |
| 2 | Cancelled-event certificate visibility | **Separate document from record (2D)** | `7fce206` |
| 3 | Cancelled events and milestones | **Separate the dimensions (3C)** | `83c9f68` |
| 4A | Cancellation notice mandatory? | **Category-controlled (4A-1)** | `adfe591` (no behaviour change) |
| 4B | What cancellation communicates | **Impact only where credit exists (4B-3)** | `a905997` |
| 5A | Attendee badge re-evaluation | **Immediate, on any status change** | `7c01dfe` |
| 5B | Automatic badge-loss notification | **Audit without notifying** | `7c01dfe` |
| 6A | Calendar audience — admin | **Direct-access, not promoted (6A-2)** | `dfd0eb0` (no gate change) |
| 6B | Calendar audience — partner | **Reachable, unpromoted, titled (6B-3)** | `dfd0eb0` |

### 1 — Permanent lock

The one document that appeared to contradict the lock — "Administrators |
Correct records, with every action written to an audit log" — **predates
close-out by three weeks** (`d79a984`, 2026-08-05; close-out in `32e6880`,
2026-08-26) and was last touched 2026-08-14. It is silent on close-out, not
opposed to it. Everything that does speak to close-out agrees: "No takebacksies"
is named as the product requirement, the module header says an existing record
"can no longer be changed at all — by anyone, including an administrator", and
the administrator refusal is test-enforced with its reasoning.

So no `hours.correct` capability and no override route. An override is a reopen
endpoint for one record, which the close-out route names as "the hole through
which every bypass of it would go" — and it would have to sit with the owner
rather than administrators anyway, since `audit.read` is SUPER_ONLY and an
administrator cannot review another's corrections. The documents were corrected
instead, including the half that protects the student: somebody with no record
on the event can still be credited.

### 2 — The document and the record are different things

Voiding was never available ("There is no option to void a certificate", a
hash-pinned sentence), so only visibility was open. The owner's list excluded a
cancelled event while the public list showed it and `/verify/:code` answered
`valid: true` — the owner was the one person hidden from their own document,
which is the fault `getCertificateForOwner` had already been corrected for one
level down. Both lists now enumerate certificates that exist; the transcript
(`/hours`, the portfolio) still excludes the event entirely, asserted directly
rather than by proxy. The public list's mirror fault — listing a cancelled event
that never had a certificate — is fixed by the same predicate.

### 3 — Split by metric, not by surface

`record.hoursCredited: 21` and a reached 25-hour Silver Award in one payload,
while the "25 Hours" badge went unawarded to the same student. Hours tiers now
read credited hours; events tiers keep counting participation, so
`milestoneInputs`'s recorded decision ("because the service still happened")
stands for the metric it was made about.

**Conflict named:** the published no-penalty principle ("penalising them for
somebody else's cancellation") is scoped to the Auto Select draw and cannot be
generalised past the frozen decision that credited hours exclude cancelled
events — the transcript already drops those hours, so a tier showing more than
the transcript is not protecting the student.

### 4A — The preference was accurately described

The comment asserting that every confirmed volunteer "must hear about" a
cancellation described a requirement the delivery model does not meet. The
comment moved, not the behaviour: the switch is labelled "Event Updates &
Reminders — When an event you applied to changes, or to remind you of a shift",
defaults to on, and a cancellation is inside those words. The eleven mandatory
notices are notices about the reader's own standing and rights. The set's
membership is now pinned so widening it forces the argument to be revisited.

### 4B — Told to the people it happened to

Scoped by the rule this product already applies to hour-impact messages:
`HOURS_ADJUSTED` goes only past a `wasCredited` guard. The recipient set was
wrong in both directions — an accepted no-show was told nothing had changed
correctly but a credited volunteer who later withdrew was told nothing at all —
and both are fixed. One kind, two bodies, chosen by a payload flag, following
`HOURS_APPROVED`, because `dispatchMany` renders content once per fan-out. The
rule the sentence asserts is now published, under "If an event is cancelled".

### 5A / 5B — Deterministic, and never silent

Cancelling applied the badge rule to nobody but the organizer, so an attendee
kept a badge until some unrelated action of their own re-evaluated it — next
week, or never. That is not grandfathering; it is the outcome depending on
timing nobody chose. The repository already makes this argument for the
organizer half of the same route. Paired with an audit row carrying the actor,
following the manual revoke, which audits and does not notify.

### 6 — Neither gate changed

Nothing in the repository designs a district calendar, and a route working is
not evidence it was meant to be promoted; the evidence on both sides is recorded
at the nav entry so it is not rediscovered as a bug. The partner half is a
titling defect of a class already fixed once, and the new derived guard found
two more instances of it on `/report-issue`.

### Verification

Full suite **652 files, 10,917 passed, 0 failed, 178 skipped, exit 0**; lint,
build and a bundle scan over 164 chunks clean; `bin/legal-hashes.mjs` reports 13
ok and 0 drift. Every changed path was additionally run against real PostgreSQL
on a scratch database created and dropped for the purpose — 561 tests across
thirteen files, including the two certificate aggregates whose `GROUP BY` the
engine is strict about. No production database was opened and no production data
was read.

### Remaining owner decisions

**None from the matrix.** §57 remains unresolved and is unchanged by this pass:
it is a gap in supplied material, not a question the repository can answer.

---

## Pass 16 — closeout: the ledger reconciled against the code

Written last, against the repository at `a0a8ac2` rather than against the
earlier passes' prose. Where a pass and the final code disagree, the code wins
and the disagreement is named here rather than quietly overwritten.

Every commit named below was checked to exist in `git log`. One identifier
circulated in a shortened form that does not resolve on its own —
`a521eb` — and the commit is `a521eb9`.

### 16.1 What pass 15 got wrong about D5A

**Pass 15 records owner decision 5A as implemented by `7c01dfe`. That
implementation was defective and the pass says nothing about it.**

`7c01dfe` re-evaluated `attendance WHERE event_id = ? AND present = 1`. That is
the right set for the hours and events criteria and the wrong set for
reliability: `reliabilityOf` builds commitments from **accepted applications**
left-joined to attendance and excludes cancelled events
(`server/reliability.js:280`), so cancelling removes the commitment for everyone
accepted — including somebody marked absent, whose rate therefore *rises*. A
volunteer held under the Reliable Volunteer threshold by one absence at an event
that was then called off stayed under it until something unrelated re-evaluated
them.

Fixed in `57b7e18`, which selects the union of attendance rows at the event and
accepted applications. The corrected statement of D5A is: **immediate
re-evaluation of everyone the status change affects**, which is not the same set
as everyone who turned up.

Pass 15's table is otherwise accurate.

### 16.2 The reported findings, reconciled

`R-1 … R-8` were adjudicated; **`R-9 … R-12` were never investigated in this
run** and are carried forward unchanged. §1.7's "none acted on yet" has been
corrected in place to say so.

Four intake rows each carried two claims that resolved differently, so they are
split here rather than given a compound label. A row reading "fixed in part" is
a row whose other part nobody can look up: each half now carries exactly one
status and its own evidence. The original identifiers stay valid as the pair.

| ID | Final status | Evidence |
|---|---|---|
| R-1 | **DISPROVEN** | Pass 7 — the ledger model, cancellation writes no ledger row because it removes nothing |
| R-2a | **DISPROVEN** | Pass 6 — the central claim, that close-out leaves credited records mutable |
| R-2b | **OWNER-DECIDED** | The second half, that a late credit is then uncorrectable → D1 (1A); `d776b72` |
| R-3 | **FIXED** | `593f281` — `FOR UPDATE` on the close-out re-read, reproduced on PostgreSQL first |
| R-4 | **DISPROVEN** | Pass 7 |
| R-5 | **FIXED** | `e57a2bb` — four trigger sites added |
| R-6 | **FIXED** | `0b8030e` — `early_adopter` declared `threshold: true` |
| R-7 | **OWNER-DECIDED** | Pass 8 for the intentional half; D5B (`7c01dfe`) for the rest |
| R-8 | **FIXED** | `74f8a38` — the applicant row's floor and count |
| R-9 … R-12 | **UNRESOLVED — never investigated** | Intake only (§1.7). Carried forward |

| ID | Final status | Evidence |
|---|---|---|
| N-1, N-2 | **FIXED** | `ece14c6`, with `c4b7de9` pinning the destination |
| N-3 | **FIXED** | `23988c5`; the guard that should have caught it, `af08856` |
| N-4a | **OWNER-DECIDED** | The admin half — who the calendar is for → D6A (6A-2); no gate changed, `dfd0eb0` |
| N-4b | **FIXED** | The partner half — an untitled page → D6B (6B-3), `dfd0eb0` |
| N-5 | **DISPROVEN** | `922bd23` — a documented unfinished role, not a dead end |
| N-6 | **FIXED** | `e18a010` |
| N-7 | **DISPROVEN** | Pass 12 — the overlay is URL-backed; no privacy difference |
| N-8, N-9 | **DISPROVEN as live** | Pass 12 — latent; no route requires `capability.grant` |
| N-10 | **FIXED** | `e84957d` |
| N-11 | **FIXED** | `503c3c8` |
| N-12 | **FIXED** | `d3402f9` |
| N-13a | **FIXED** | "Browse organizations" named two pages, and one page had two labels; `0fe739d` |
| N-13b | **DISPROVEN as a defect** | The other three terminology claims — four labels for `/events/new`, the application/sign-up split, five names for the record — classified (D) optional under the standing rule, so not work. Pass 12 |
| N-14 | **DISPROVEN** | Pass 12 — one click behind Discover, gated on the route's own capability |
| N-15 | **DISPROVEN** | Pass 12 — a recorded decision in `accountMenu.js` |
| N-16a | **FIXED** | Two empty states named an action and offered no control; `883f06d` |
| N-16b | **DISPROVEN as a defect** | The four raw date inputs — all correctly bounded, one documented as deliberate, one additionally refused a future date server-side. Polish, not correctness. Pass 12 |
| N-17 | **FIXED** | `af08856` |

Findings surfaced and fixed outside the two intake tables: the Welly link
injection (`02480a6`), the Student Organizer check-in refusal (`b4a1e11`), the
certificate the holder could not open (`d3175e3`), the Reliable Volunteer
threshold (`c2f5fff`), the cancelled-hours totals (`df4e815`), the exact device
position (`5f5d369`, recorded in `0b4328d`), and the two low items (`7729f70`
fixed, `a521eb9` documentation-only).

### 16.3 The owner decisions, as implemented

| Decision | Final choice | Implemented by | Kind |
|---|---|---|---|
| D1 post-close-out corrections | **1A — permanent lock** | `d776b72` | DOCUMENTATION-ONLY (no behaviour changed) |
| D2 cancelled-event certificates | **2D — document separate from record** | `7fce206`, `652f5be` | FIXED |
| D3 cancelled events and milestones | **3C — separate dimensions** | `83c9f68` | FIXED |
| D4A cancellation notice | **4A-1 — category-controlled** | `adfe591` | DOCUMENTATION-ONLY |
| D4B cancellation content | **4B-3 — impact only where credit exists** | `a905997` | FIXED |
| D5A attendee badge re-evaluation | **immediate, on affected status change** | `7c01dfe`, corrected by `57b7e18` | FIXED |
| D5B automatic badge-loss notification | **audit without notifying** | `7c01dfe` | FIXED |
| D6A admin calendar | **6A-2 — direct/Welly, unpromoted** | `dfd0eb0` | DOCUMENTATION-ONLY (no gate changed) |
| D6B partner calendar | **6B-3 — reachable, unpromoted, titled** | `dfd0eb0` | FIXED |

**The additional attendee-badge-evidence decision** — raised in pass 14 as
depending on D3 and D5B — is answered by D5A and D5B together and has no
separate identifier. Its dependencies resolved as follows: D3 (3C) makes the
hours milestones derived and immediate, so a badge that did not follow would
contradict a milestone on the same profile; D5B supplies the audit row that
stops the withdrawal being silent. Without both, immediate re-evaluation would
have been either incoherent or undocumented.

### 16.4 The post-decision verification pass

Six commits, and what each was:

| Commit | Kind | What it established |
|---|---|---|
| `ee53fe9` | Test hardening | The late-credit half of D1 and the lock-before-`reason_required` ordering had nothing behind them. `eventClosedOut && prior && reason` passed all 28 cases |
| `652f5be` | **FIXED** | D2 reached three surfaces and missed two: `VolunteerProfile`'s preview, which sits opposite the service record, and Welly's certificates card |
| `469d113` | Test hardening + DOCUMENTATION-ONLY | The participation half of D3 could regress unseen; three stale comments in `milestones.js`, including "nothing about it can be lost", now false for hours tiers |
| `57b7e18` | **FIXED** | The D5A affected-set defect (16.1) |
| `663cf77` | Test hardening | Three D4B/D5 edges: zero-hour attendance, repeated status changes, manual vs automatic distinguishability |
| `a0a8ac2` | Characterised, not a defect | The D4B recipient filter is not independently mutation-sensitive, because the shared dedupe key makes its removal behaviourally neutral. Removing it **and** reversing the two dispatches loses the hour impact, so its role is to make content independent of call order. Recorded at the code |

### 16.5 §57

Unchanged, and deliberately so. The historical UI/UX material the brief said it
supplied was never supplied; pass 14 established that the repository's own
record — 9 history documents, 13 spec files, 7 design reports, 14 audits, 27
runbooks, a 1,750-line changelog — is uniformly downstream material describing
what was built, and that `questions-for-owner.md` is a record of where intent
was *missing*.

The audit continued under assumptions stated at each point rather than stopping,
and every finding that did not depend on §57 was resolved on repository
evidence: twenty-five reported findings adjudicated, seven disproven on code
alone. **§57 is a bounded historical-evidence gap, not an unresolved runtime
defect, and it is not an owner decision.** Nothing in this ledger was
reconstructed from recollection.

### 16.6 Future follow-up

| ID | Status | Claim | Evidence |
|---|---|---|---|
| F-1 | Open, **outside this audit's scope** | `EVENT_UPDATED` uses the same accepted-application recipient query the cancellation path used before D4B, so a volunteer with credited attendance who later withdrew is not told when the event's details change | Verified in code at closeout: `server/routes/eventRoutes.js:1495` is now the ONLY caller of `notifyConfirmedVolunteers`, whose query is `applications WHERE status = 'accepted'` (`server/utils.js:1285-1288`) |
| R-9 … R-12 | Open, never investigated | Four Welly claims from the 1.7 intake table | §1.7; no pass in this document examines them |

**F-1 is recorded as a shared query, not as a demonstrated harm**, and the
distinction is the reason it is not being fixed here. For a cancellation the
withdrawn-but-credited volunteer is affected because their credited hours stop
counting. For `EVENT_UPDATED` no hour consequence exists: `PUT /api/events/:id`
refuses a completed event — "its details can no longer be changed. Attendance
can still be corrected" (`eventRoutes.js:1220-1224`) — and an existing credit
keeps its stored `hours_awarded` whatever happens to the slot. So the update
concerns a future shift the person is no longer signed up for, and excluding
them may well be right. It was not caused by the nine decisions, was not needed
to resolve them, and deciding it is a product question in its own right.

### 16.7 What was stale, and what was corrected

| Where | Was | Now |
|---|---|---|
| §1.6 heading | "reported, awaiting verification" | "reported, since adjudicated", with the passes named |
| §1.7 | "none acted on yet" | Corrected in place; R-1 … R-8 adjudicated, R-9 … R-12 explicitly still unexamined |
| Pass 4, open questions 1 and 2 | Open | Answered — D3 and D2, with commits |
| Pass 6, "Open question for the owner" | Open | Answered — D1, `d776b72` |
| Pass 8, R-7 | "Half an owner decision. No change." | Owner-decided — D5B, `7c01dfe` |
| Pass 10, question E | "admin: unresolved" | Answered — D6A; partner half fixed by D6B |
| Pass 14 register | "the six open questions" | Relabelled as the state at that moment; all six answered in pass 15 |
| Pass 15, D5A | Implemented by `7c01dfe` | Corrected: that implementation was defective; `57b7e18` is the fix (16.1) |

Nothing was closed that remains genuinely open. R-9 … R-12 stay open because
this audit never looked at them; F-1 stays open because it is out of scope; §57
stays unresolved because the material does not exist.

### Verification

This pass changes documentation only. The repository has no artifact generated
from these files, so the full suite was not re-run for it; the state it records
is the verified state at `a0a8ac2` — 664 files, 10,933 passed, 0 failed, 178
skipped, lint and build clean, 164 bundle chunks with 0 server-only-string hits,
561 PostgreSQL tests across 14 files on a scratch database created and dropped.
`bin/legal-hashes.mjs` reports 13 ok and 0 drift; no legal document was touched
by this pass.

---

## Pass 17 — the last four intake claims, F-1, and §57

Pass 16 carried `R-9 … R-12` forward as never investigated. They are
investigated here, from the intake claims rather than from any prior
classification. One was a live defect; the other three were not, and two of
those describe behaviour the repository had already decided deliberately.

### R-9 — **FIXED, before this audit began**

The claim: `identity_self` tells the reader "nothing you type here is sent
anywhere" while a search question reaches `/api/events` and may be embedded
server-side.

The claim was true of the code when the intake table was written and is not
true of the code now. `FIXED.identity_self` was corrected in **`083b7d1`**
(2026-08-30), an ancestor of HEAD, and the reasoning sits above the string: the
absolute half was replaced with the narrower keepable claim — the model runs on
your device, and *"Looking something up … is answered by WeVolunteer's server,
the same as the rest of the app."*

Regression coverage exists for both branches, and the second one exists
*because* of a mutation check: `identity.test.js` records that the first version
used a loaded runtime only, so restoring the old claim in the no-model fallback
left the suite green. Both are asserted now.

So this is a stale intake row against already-corrected code, not an open
finding. Nothing to do.

### R-10 — **DISPROVEN**

The claim: Welly-created events carry no coordinates, so they are second-class
in the distance features Welly offers.

Both halves check out and the conclusion does not. The `create_event` payload
(`src/ai/tools.js:1089-1108`) carries no `latitude`/`longitude`, and an event
without them is excluded by a distance filter — `eventQuery.js:692`, with the
reason stated: *"An event with no coordinates has no distance, so it cannot
satisfy a distance filter."*

But this is **not Welly-specific**. `CreateEvent.jsx` validates only that the
location *text* is non-empty (`:258-259`), so an organizer who types a place and
never opens the picker publishes exactly the same event. There is no
server-side geocoding on create by design, and the property is recorded as
intentional in `server/db.js:1805`:

> "An event with no pin is an ordinary thing — an organizer typed a place name
> and never opened the picker — and every location surface has to degrade for
> it: no map, no distance, no forecast … That path is the one most likely to
> regress, and a seed where every event has a pin is a seed where nobody ever
> sees it."

`eventQuery.js:17` lists the exclusion among the client behaviours it
deliberately mirrors. A decision already recorded is not an owner decision
still owed, so this is disproven rather than escalated.

### R-11 — **DISPROVEN**

The claim: the transcript UI is built for token streaming that no longer
happens.

The single-call `onToken` is deliberate, measured and documented
(`WllamaRuntime.js:352-377`): streaming dropped the final chunk, which also
lost `finish_reason`, so the non-streaming call is what makes the text right
and the "ran out of room" notice possible. The contract is explicitly kept —
*"`onToken` is still honoured, once, with the finished text … and `MockRuntime`
still emits word by word, so every test that pins fragment reassembly keeps
exercising it."*

And the consumer is arity-agnostic: `WellyView.jsx:695` accumulates
`m.text + token`, which is correct whether called once or fifty times. No
visible artefact, no dead path — a retained interface with a live test double.

### R-12 — **CONFIRMED, reproduced, FIXED `0b6e0f3`**

The claim named `send`'s dependency array. The reachable consequence is worse
than a stale value, and it was reproduced through the real component before
anything changed.

`send` is `useCallback(…, [busy, messages, position, currentUser, navigate])`
and reads `prefs.enabled` to decide whether to wait for a loading model.
`prefs` is not in that array, and **on an empty conversation nothing else in it
changes when the mode control is used** — `messages` is still empty, `busy` is
still false. So a reader who switched from Welly Chat to Welly AI and typed
before the model arrived was served by a closure that still said Welly AI was
off: the wait was skipped, `ask` got a null runtime, and the transcript carried
Chat's refusal — *"I can't help with that one. I can look up opportunities…"* —
under a pill reading "Welly AI · Running on this device".

That is the defect `WellyView.engineWait.test.jsx` exists to prevent,
reintroduced through the mode-switch path. Both of its existing cases start
with `enabled: true` already in storage, so the closure is correct at mount and
neither could see it.

Fixed by reading `readPreferences()` at the decision point rather than adding a
dependency: it is the source of truth `prefs` mirrors, `selectMode` already
reads it that way, and it is also correct across tabs where the `storage`
listener has not run yet.

**Mutation results.** Restoring the closure fails the new case. Dropping the
`enabled` half of the guard **survives**, and is characterised rather than
papered over: `loadRuntime` returns early when Welly AI is off, so
`loadingRef.current` is already settled and awaiting it costs a microtask. The
check stays because it states what the wait is for. The neighbouring case was
also strengthened — it cleared `modelId`, so `enabled` was never under test;
switching to Welly Chat keeps the chosen model, and the fixture now matches
that.

### F-1 — **Characterised. Not a defect. Remains a follow-up.**

Re-verified rather than inherited. `notifyConfirmedVolunteers` now has exactly
one caller — `EVENT_UPDATED` at `eventRoutes.js:1495` — and its recipient query
is `applications WHERE status = 'accepted'` (`utils.js:1285-1288`), which is the
query owner decision 4B corrected for cancellation.

The correction does not transfer, and the reason is specific rather than
general. For a cancellation the withdrawn-but-credited volunteer is affected
because their credited hours stop counting. For `EVENT_UPDATED` no hour
consequence exists: `PUT /api/events/:id` refuses a completed event — *"its
details can no longer be changed. Attendance can still be corrected."*
(`eventRoutes.js:1220-1224`) — and an existing credit keeps its stored
`hours_awarded` whatever happens to the slot afterwards. So the notice concerns
a future shift the person has withdrawn from, and not sending it is defensible
on its face.

Kept open as a follow-up rather than closed, because *whether* a withdrawn
volunteer should hear that an event they once held a place at has changed is a
product question nobody has answered. It was not caused by the nine decisions
and was not needed to resolve them.

### §57 — **UNRESOLVED, and the search is now exhaustive**

Two avenues pass 14 did not try were tried here, and both are dead ends worth
recording so nobody repeats them:

- **Deleted files.** `git log --diff-filter=D --name-only` across the whole
  history turns up one deleted file matching any requirements-like name
  (`tests/e2e/core-flow.spec.js`, a test). No requirements document was ever
  committed and later removed.
- **The initial commit.** `ed2dea1` (2026-07-20) contains one prose document,
  `README.md`, and it is the only artefact in the repository that is *upstream*
  of the work rather than a description of it. It yields a product thesis — "a
  SignUpGenius-style app", "confirmed attendance turns into certified
  community-service hours" — and a feature inventory, including the original
  name for Auto Select ("Equalizer") and the original position that the
  attendance ledger is "re-editable", which close-out later bounded rather than
  contradicted.

That is the whole of it. A thesis and a feature list are not "numerous highly
specific historical UI/UX requirements", so **§57 is narrowed but not
resolved**: the repository contains one upstream artefact, it has now been
read, and it does not contain the material. Nothing was reconstructed from
recollection, and §57 remains a bounded historical-evidence gap rather than an
unresolved runtime defect or an owner decision.

### Cross-surface finding — the published hours definition (`10aa55f`)

Found by sweeping for stale statements of the policies this audit settled.
`creditedHoursFor` is `SUM(hours_awarded) WHERE present = 1 AND e.status <>
'cancelled'`, and four places that state it for a reader stopped at the first
half.

The README is the worst of them: it prints the incomplete formula in a fenced
SQL block and then says *"that single constraint is why the figure can be
trusted everywhere it appears"* — a trust claim resting on a definition the code
does not use. Its corrections section also stopped short of close-out. Both are
corrected, along with three live source comments in `seed_badges.js`,
`badges.test.js` and `hoursLedger.js` — the first two matter most now that owner
decision 3 made the hours milestones depend on that definition.

Dated records were left alone: `docs/2026-08-06-production-readiness-audit.md`,
`docs/questions-for-owner.md` and `docs/plans/2026-08-02-v1.4-meaning.md` say
what was true when they were written, and rewriting a snapshot is not
reconciliation.

### Sweeps that found nothing, recorded so they are not repeated

- **Hash destinations.** Two client links carry one, both `#welly-ai`, and the
  id exists (`AISettingsCard.jsx:161`) with a ref that consumes it. The N-3
  class is clean on the client; `serverLinks.test.js` covers the server side.
- **Navigation wider than its route.** Every `NAV` entry's gate is identical to
  its route's or narrower — `/calendar` is the only one that is narrower, which
  is owner decision 6A. No role is shown an entry that would refuse it.
- **Client-state-dependent destinations.** `?profile=&type=` resolves from the
  server on a cold load, as `?event=` now does.

### Status after this pass

| ID | Final status | Evidence |
|---|---|---|
| R-9 | **FIXED** (before this run) | `083b7d1`; `identity.test.js`, both branches |
| R-10 | **DISPROVEN** | `db.js:1805`, `eventQuery.js:17`; not Welly-specific |
| R-11 | **DISPROVEN** | `WllamaRuntime.js:352-377`; consumer is arity-agnostic |
| R-12 | **FIXED** | `0b6e0f3`, reproduced then mutation-checked |
| F-1 | **Future follow-up** | No hour consequence; product question unanswered |
| §57 | **UNRESOLVED** | Search exhausted: no deleted requirements file, initial commit read |
