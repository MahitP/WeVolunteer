# Accessibility audit and measurement harness

**Date:** 2026-08-21
**Status:** design approved, plan not yet written
**Scope:** workstream 1 of an accessibility initiative. Diagnosis, measurement
infrastructure, and P0 blocker fixes. Everything else is deferred by design —
see [Out of scope](#out-of-scope).

---

## Why this exists

WeVolunteer already has an accessibility layer. A prior push — the branch the
engineering guide names as `v1.1-security-accessibility-ux` — shipped a shared
dialog shell, a skip link, landmarks, a purpose-built accessible date picker,
and nine static guard tests. So the useful question is not "how do we make this
accessible", it is **"what is still broken, and how would we know?"**

The second half of that question is the problem. Every existing accessibility
guard is *static text analysis of source*, and the guards themselves say why.
From `src/touchTargets.test.js`:

> jsdom has no layout engine: every `getBoundingClientRect()` is zero, so a
> rendered assertion would be vacuous in exactly the way that looks convincing.

That is an honest limitation, correctly reasoned, and it leaves a specific hole:
**reflow, real contrast, real target geometry, real focus order, and forced-colors
behaviour have never been verified by a machine on this codebase.** Those are
precisely the criteria where a defect is invisible in review.

Four findings from a source-level pass, before any measurement, show the hole is
not theoretical:

1. `:focus-visible { outline: none; box-shadow: var(--focus) }` at
   `src/index.css:598`, with **no `forced-colors` block anywhere in 12,381 lines
   of CSS**. Windows High Contrast Mode strips `box-shadow`, so focus is
   invisible across the entire application for the users most likely to need it.
2. `src/index.css:4545` — `.composer-input:focus, .composer-input:focus-visible
   { outline: none; box-shadow: none }`. The message composer has no focus
   indicator at all.
3. `src/components/location/LocationThumbnail.jsx:13` — `<span onClick>`.
   Keyboard-unreachable.
4. `src/components/location/LocationDisplay.jsx:32` — `<div onClick>` whose only
   accessible name is a `title` attribute.

If a half-hour of grep finds four, a real harness will find more. Building the
harness is the deliverable that makes every later fix spec evidence-based
instead of speculative.

---

## Objective

Produce a prioritised, evidence-backed inventory of WeVolunteer's remaining
accessibility defects against **WCAG 2.2 Level AA**, together with the
infrastructure that keeps them from recurring, and fix the blockers.

**Non-objective:** this spec does not assert legal ADA compliance, and no
deliverable it produces may. WCAG conformance is a technical target; whether the
ADA applies to WeVolunteer, and on what terms, depends on its legal structure,
users, and jurisdiction. Where legal certainty matters, qualified legal advice
is the answer, not a test suite.

---

## Approach

Three were considered.

**A — Playwright plus a ratcheted baseline (chosen).** A real browser drives the
real server against a scratch database, signs in per role, and sweeps the route
table. Known violations live in a committed baseline; CI fails on anything new
and on any increase in count. This is an idiom the repository already speaks:
`bin/migration-baseline.mjs` with `POSTGRES_MIGRATION_BASELINE.json`,
`bin/scale-probe.mjs`, and the "fixture ratchet" in the commit history. Cost:
two test runners in one repo, and a browser download in CI.

**B — Vitest browser mode as a third project.** One runner, and it slots into
`vitest.config.js`'s existing project split. Rejected because browser mode is
component-oriented: it cannot orchestrate a server with a seeded database,
cannot sign in as a role, and cannot observe cross-route focus behaviour. The
findings most likely to remain are whole-page ones — tab order through the
shell, the sidebar's reflow at 320px — so this option aims away from the target.

**C — A one-off probe script, nothing in CI.** Smallest permanent surface, and it
would produce the audit document. Rejected because this repository's quality
culture is regression guards written *because a bug came back*, three times in
the case of `pageTitleCoverage`. An accessibility audit with no ratchet regresses
inside one release, and then the audit document is worse than nothing: it reads
as a statement of current fact while describing the past.

---

## Safety boundary

This is the part with the worst failure mode, so it is specified first.

`server/db.js` reads `WEV_DB_PATH`, and `.env` resolves it to `../pilot.db` for
`npm run dev:server`. **`pilot.db` holds real minors' personal data.** A browser
harness that boots the server the ordinary way would drive a real browser through
real students' records, and axe reports would capture their names into committed
artefacts.

The refusal is **not newly invented.** `bin/lib/db-safety.mjs` already exports
`resolveDbPath()` — which resolves exactly the way `server/db.js` does, so a tool
can never operate on a different file from the one the application opens — and
`refuseProductionLikePath({ tool, dbPath })`, which hard-exits with a named
reason. `bin/reset-dev-db.mjs` already calls both. The harness calls the same
two, for the same reason: a second implementation of this check is a second
implementation that can disagree.

On top of those, the harness adds one constraint the existing helpers do not
express, because they are written for a human at a terminal and this runs
unattended:

1. `WEV_DB_PATH` must be set, must be **absolute**, and must resolve inside
   `scratch/` — already git-ignored, already the throwaway location vitest uses.
   Unset is a refusal, not a fallback: the default is `server/wevolunteer.db`,
   and defaulting is how a harness silently audits the wrong database.
2. `DATABASE_ENGINE=sqlite` is pinned **explicitly**, so a `DATABASE_URL` present
   in the environment cannot redirect the run. This is the failure
   `bin/resolveDb.mjs` documents at length.
3. The check runs on the **realpath**, after resolution, so a symlink into
   `scratch/` cannot defeat it.

The database is rebuilt fresh by `bin/reset-dev-db.mjs` at the start of every
run, which is safe precisely because that script deletes the *file* and lets
`initDatabase()` rebuild the schema rather than enumerating tables.

A guard test asserts the harness config contains all three checks — same species
as the existing `src/serverModuleBoundary.test.js`. The refusal must be a hard
exit with a named reason, not a warning.

**Report hygiene.** Even against seeded data, axe output and ARIA snapshots
contain rendered text. Seed data is synthetic, so this is safe; the constraint
worth writing down is that the harness must never be pointed at production and
must never commit an artefact produced from a non-`scratch/` database. The
baseline file records selectors, rules, and counts — not page text — so it is
safe to commit regardless.

---

## Architecture

```
playwright.config.js          webServer orchestration, projects, forced-colors
                              and reduced-motion emulation profiles
a11y/
  harness/
    guard.js                  the three safety checks; hard-exits on failure
    routes.js                 route inventory DERIVED from src/routes/index.jsx
    roles.js                  role matrix from GET /api/auth/demo-accounts
    signIn.js                 per-role storageState fixtures
    axe.js                    axe-core injection, WCAG 2.2 tag set
    measure.js                target-size, focus-walk, reflow primitives
  sweep.spec.js               every route x role, all machine checks
  workflows/                  12 deep keyboard journeys (see below)
  A11Y_BASELINE.json          ratcheted known violations
bin/a11y-report.mjs           baseline + run output -> the audit markdown
```

**Route inventory is derived, never listed.** `src/pageTitleCoverage.test.js`
already parses `{ path: '...' }` literals out of `src/routes/index.jsx`; the
harness reuses that parse. A route added tomorrow is swept the day it is added
and not the day somebody remembers this directory. The 12 parameterised paths — `/events/:id/edit`,
`/checkin/:eventId`, `/users/id/:id`, `/users/:handle`, `/users/:handle/badges`,
`/users/:handle/certificates`, `/users/:handle/hours`, `/organizations/:key`,
`/organizations/:key/edit`, `/verify/:code`, `/legal/:slug`, `/appeal/:token` —
are resolved against seed fixtures, and a parameterised route with no fixture is
a **failure**, not a skip. A silent skip is how a route escapes coverage forever,
and `/appeal/:token` and `/verify/:code` are exactly the routes whose fixtures are
awkward enough to be the ones somebody skips.

**Roles come from the server, not a literal.** `GET /api/auth/demo-accounts`
already filters tombstones and internal actors, and `src/components/DemoBar.jsx`
records what happens when a client hardcodes the seed instead: a login that fails
with "No account found with that email address". Sign-in uses the seeded
shortcut path with `password123`, captured once per role into a Playwright
`storageState` so the sweep does not re-authenticate per route.

---

## What the sweep measures

Per route x role:

| Check | Criteria | Why the existing guards cannot |
| --- | --- | --- |
| axe-core, tags `wcag2a wcag2aa wcag21a wcag21aa wcag22aa` | names, roles, contrast, labels, landmarks | needs computed styles and the real AT tree |
| ARIA snapshot (`toMatchAriaSnapshot`) | accessible name/role/state of every control; heading tree | needs the browser's accessible-name computation |
| Sequential focus walk | 2.1.1, 2.1.2, 2.4.3, 2.4.7 — traps, reachability, whether `:focus-visible` actually paints | needs a focus model |
| `getBoundingClientRect` on every control | 2.5.8 (24x24 AA floor) and the house 44px coarse-pointer rule | jsdom returns zero — the guard's own docstring says so |
| Sticky-overlay intersection with the focused element | **2.4.11 Focus Not Obscured (Minimum)** — new at AA in 2.2 | needs layout; `header.topbar` is sticky, which is the classic cause |
| 320 CSS px width, and 1280 at 400% zoom | 1.4.10 Reflow — no two-axis scroll, no clipping | needs layout |
| Text-spacing injection (1.5 line-height, 0.12em letter, 0.16em word, 2em paragraph) | 1.4.12 Text Spacing — no clipping in fixed-height containers | needs layout |
| `forced-colors: active` emulation | 2.4.7 + 1.4.11 — focus still visible when `box-shadow` is stripped | not expressible statically |
| `prefers-reduced-motion: reduce` emulation | 2.3.3 — animation actually suppressed, not merely shortened | needs a compositor |

### Deep workflow specs

Twelve files under `a11y/workflows/`, each a keyboard-only journey with the
error, loading, and empty states exercised, and each custom widget checked
against the ARIA Authoring Practices pattern it claims to implement:

`auth` (sign up, sign in, reset, second factor, session expiry) ·
`discover` · `search-filter` · `signup` (apply, withdraw, waitlist) ·
`schedule` (the `DatePicker` and `CalendarView`) · `attendance` (check-in,
scanner, codes) · `hours` (log external, logged hours) · `profile` ·
`notifications` (bell, popover, list, toasts) · `messages` (`RecipientPicker`
combobox, `ConversationPane`) · `settings` · `welly`.

### Welly is tagged `@local` and excluded from CI

Auditing Welly's streaming announcements requires the wllama model to actually
download and run in the browser. `VITE_LOCAL_AI=false` — which CI must use —
renders the engine-unavailable state, so a CI run would audit a placeholder and
prove nothing while appearing to pass. The Welly workflow spec therefore runs
locally with `VITE_LOCAL_AI=true`, and the audit document states plainly that it
was verified locally and is not gated in CI.

Welly's live-region strategy gets specific attention: per the architecture
invariant that streamed text is committed text with no post-hoc repair, a naive
`aria-live="polite"` around the streaming bubble would re-announce the growing
string on every chunk. What the audit must establish is whether the existing
wiring announces *completion* or *accumulation*.

---

## WCAG 2.2 corrections carried into this spec

Three places the initial brief or the existing code is slightly wrong. Recording
them here so the audit does not inherit the errors.

**Target size.** `src/touchTargets.test.js` cites "WCAG 2.1 §2.5.5" and enforces
a 44px floor. 2.5.5 Target Size (Enhanced) is **Level AAA**. The AA criterion,
new in 2.2, is **2.5.8 Target Size (Minimum)** at **24x24 CSS px**. The existing
guard is therefore *stricter than AA requires*, which is a good thing and is not
being loosened. The audit reports conformance against 2.5.8 and keeps 44px as a
documented house rule above the requirement.

**Focus Appearance (2.4.13) is Level AAA**, not AA. The forced-colors focus
failure is correctly cited under **2.4.7 Focus Visible (A)** and **1.4.11
Non-text Contrast (AA)**. Separately, **2.4.11 Focus Not Obscured (Minimum)** is
genuinely new at AA and genuinely live here, because `header.topbar` is sticky.

**Already satisfied, recorded as such rather than re-litigated:**
no paste blocking anywhere in the codebase, so **3.3.8 Accessible
Authentication (Minimum)** is clean and password managers work; no drag
interactions at all, so **2.5.7 Dragging Movements** is not applicable; and
**4.1.1 Parsing** is obsolete in WCAG 2.2 and is dropped from the matrix.

**The real form gap is 1.3.5 Identify Input Purpose.** 129 `<input>` elements
across the client, 30 carrying `autoComplete`. 1.3.5 applies only where a field
collects information about the user and the purpose appears in the defined list,
so the true shortfall is smaller than 99 — quantifying it is an audit task, not
an assumption.

**Two criteria new in 2.2 that need a deliberate look**, because neither is
detectable by any scanner:

- **3.2.6 Consistent Help (A).** Help exists in more than one place — the
  Settings "Help & Support" section, `/report-issue`, and Welly. If a help
  mechanism appears on multiple pages it must occur in the same relative order.
- **3.3.7 Redundant Entry (A).** Signup, second-factor enrolment, and the appeal
  flow are the candidates for asking twice for something already provided.

---

## P0 fixes in scope

Blockers only — defects that make a workflow impossible rather than unpleasant.
The four already evidenced:

**P0-1 — Forced-colors focus system.** `src/index.css:597-602` sets `:focus {
outline: none }` globally and replaces the ring with `box-shadow: var(--focus)`.
Windows High Contrast strips `box-shadow`, so focus vanishes application-wide.
The fix is a `@media (forced-colors: active)` block restoring a real `outline`
plus `outline-offset`, at the token layer — not an edit across 12,000 lines.
Guard: a CSS parse asserting that every rule which zeroes `outline` is matched by
a forced-colors restoration.

**P0-2 — `.composer-input` has no focus indicator.** `src/index.css:4545` zeroes
both `outline` and `box-shadow` on `:focus` and `:focus-visible`. Fix restores a
ring consistent with the rest of the application. Guard: extend P0-1's parse —
no selector may zero both properties without a restoration.

**P0-3 — the location cluster.** Reclassified during implementation recon; see
[Recon corrections](#recon-corrections). The work is a single task covering three
related defects in `src/components/location/`, none of which is individually a
blocker.

### Recon corrections

Two of the four defects named above did not survive verification. Recording the
correction here rather than quietly implementing something different, because a
spec that keeps a disproven claim is the failure this document's evidence-class
discipline exists to prevent.

**`LocationThumbnail.jsx:13` is real but is not a blocker — P2, not P0.** Its
`onClick` is `onViewDetails`, which is *the same action* as the card's footer
button at `src/components/EventCard.jsx:133`. So the span is a duplicate pointer
affordance beside a real, keyboard-reachable control, and no workflow is blocked
by it. It is also probably broken on its own terms: the button calls
`onViewDetails(event)` while the span calls `onViewDetails(clickEvent)`, and the
handler `App.jsx` passes is named `openEventById`. The fix is to make the fact
non-interactive — which removes a mislabelled affordance rather than removing
functionality, since the properly-named control stays.

**`LocationDisplay.jsx:32` is not reachable at all.** Nothing outside
`src/components/location/` imports it; the barrel re-exports it and no consumer
takes it. The live event-details path renders `LocationCard` instead
(`EventDetailsExperience.jsx:12`). So this is dead code, not a user-facing
defect, and the honest resolution is deletion rather than a fix that implies
somebody was affected.

**The live defect the recon found instead is `LocationCard`.** It is materially
better than the dead component — it has a real `<button>` with visible "Get
Directions" text — but it opens an external URL with `window.open`, so
cmd-click and middle-click do not work, a popup blocker can silently eat it, and
nothing announces that a new tab opened. Meanwhile
`src/components/location/DirectionsButton.jsx` **already solves this correctly
and is unused**: a real `<a>`, `mapsDirectionsUrl` with a `geo:` app handoff,
`aria-label`, `aria-hidden` on the icon, and an `sr-only` "(opens in a new tab)".
Its own docstring records having been fixed once already. So the fix is adoption
of an existing component, not new code — the shared-component-first principle
applying to a component that already exists.

`LocationCard` also passes `onClick={openDirections}` into `MapPreview`, making
the map a clickable non-interactive region. Not a blocker, for the same reason as
the thumbnail: the real button is right there.

**Net effect on scope.** Two genuine P0s remain (P0-1 and P0-2, both focus
indicators, both application-wide). The location work stays in scope because it
is cheap and adjacent, but it is recorded at its true severity. Whether any
further P0 exists is now a question for the harness rather than for grep — which
is the entire argument for building the harness first.

**Whatever the sweep promotes to P0** — a keyboard trap, an unreachable dialog,
essential information conveyed by colour alone, or a workflow that cannot be
completed from the keyboard. Given that two of four grep-found P0s were
downgraded on inspection, the expectation should be that the harness both
promotes and demotes. Findings at P1 through P3 are inventoried and left
for the follow-up specs; fixing them here is what produces an unreviewable
branch, which the engineering guide records having already happened once on a
branch with "accessibility" in its name.

---

## CI

A **separate `accessibility` job**, not an addition to `validate`. The existing
pipeline is build plus vitest plus oxlint and takes minutes; a Playwright browser
download must not be able to break it. The job:

1. installs, and installs the Chromium browser only
2. resets a scratch database at an absolute path under `scratch/`
3. starts the **development** topology (below) with `VITE_LOCAL_AI=false`
4. runs `a11y/` excluding `@local`
5. compares against `A11Y_BASELINE.json` and fails on any new rule violation, or
   any increase in an existing one

### Why the harness runs the development topology, not a production build

The obvious choice — `vite build` then serve it — is wrong here, twice.

`vite.config.js` configures a proxy under `server`, and has **no `preview`
block at all**, so `vite preview` would serve the SPA with `/api` unproxied and
every request would 404 against the SPA fallback. The production topology is
different again: `server/app.js:1113` serves `../dist` and the SPA fallback
**inside `if (IS_PRODUCTION)`**, so serving the built client means turning
production mode on — which also turns on secure cookies. Playwright drives
`http://localhost`, secure cookies are not sent over http, and **sign-in would
fail for every role**, silently, as an authentication problem rather than a
configuration one. `server/db.js` additionally FATALs on a relative
`WEV_DB_PATH` in production, so the same flag arms a second tripwire.

So Playwright's `webServer` starts the pair `npm run dev` starts: Vite on a
`PORT` it assigns, and the API server it proxies to. `vite.config.js:79` already
anticipates this — its comment says honouring `PORT` "lets the dev harness
assign a free port instead."

The trade is that a dev bundle is not the shipped bundle. For this purpose that
is acceptable and worth stating: chunking, minification, and asset hashing differ,
and **none of them affect the DOM, the accessible tree, the CSS cascade, or
layout**, which is the entire subject of this audit. What a dev build cannot
catch is a defect introduced *by* the production build itself, and no accessibility
defect of that shape is known here. Recorded as a limitation rather than papered
over.

The ratchet direction is one-way: the baseline may shrink without ceremony and
may only grow through an explicit, reviewed commit that says why.

The goal is not zero warnings. It is that a **known** critical regression cannot
reach production.

---

## Deliverables

1. `playwright.config.js`, `a11y/` (harness, sweep, 12 workflow specs),
   `A11Y_BASELINE.json`, `bin/a11y-report.mjs`
2. The `accessibility` CI job
3. `docs/audits/2026-08-21-accessibility-audit.md` — the P0–P3 inventory, one row
   per finding: problem, WCAG criterion **and level**, severity, route and
   component, affected users, recommended fix, status
4. `docs/audits/2026-08-21-voiceover-test-script.md` — the script the owner runs
   on macOS: exact routes, exact gestures, expected announcements, with Welly
   streaming and toast interruption called out as the highest-risk cases
5. The four P0 fixes, each with a regression guard
6. A confidence assessment that **separates machine-verified from human-verified**
   and claims nothing untested

### The honesty constraint on deliverables 3 and 6

A criterion is not "passing" because axe did not flag it. Every row in the
inventory carries its evidence class:

- **measured** — a harness check asserts it
- **inspected** — read in source or in the accessible tree, no automated guard
- **human-verified** — confirmed by the VoiceOver pass
- **unverified** — nothing checked it; named as such, never omitted

Screen-reader announcement behaviour cannot be machine-verified in this
environment. The harness verifies what the browser *computes* — names, roles,
states, live-region wiring — which catches most screen-reader defects but cannot
hear verbosity, interruption, or announcement order. Those criteria are
`unverified` until the VoiceOver pass returns, and the audit says so.

---

## Out of scope

Deferred to a follow-up spec, deliberately, so that it is informed by real
findings rather than by guesses:

- **Settings → Accessibility preferences** (text size, contrast, reduce motion,
  larger controls, link underlines). `src/hooks/useTheme.js` is the precedent to
  follow — `localStorage`, a `system` default, a `data-*` attribute on the root —
  and Settings already has the section structure to slot into.
- **The Accessibility Statement page.** Note for the follow-up: legal documents
  here are database-backed with enforced hashes, and stale rows crash boot, so a
  statement should be a static route rather than a new legal-document type.
- **The "report an accessibility issue" entry point.** Cheaper than it looks —
  `server/issueReports.js:58` already defines an `accessibility` category routed
  to support, so this is a deep link into `/report-issue`, not a new feature.
- **P1–P3 remediation**, which is the bulk of the eventual work and needs the
  inventory first.

---

## Risks

**The harness is slow enough that people stop running it.** `src/routes/index.jsx`
declares 47 route entries — 35 concrete and 12 parameterised — times several
roles, times nine check families. Mitigation: `storageState`
reuse rather than per-route sign-in, sweep sharded by role, and the deep workflow
specs kept separate so the fast sweep can run alone.

**The baseline becomes a place defects go to be forgotten.** Mitigation: every
baseline entry carries the audit-document finding ID that explains it, and an
entry with no ID fails the guard.

**A route escapes coverage.** The exact failure `pageTitleCoverage` was written
for, three times. Mitigation: the inventory is derived from the route table, and
an unfixtured parameterised route fails rather than skips.

**Welly's exclusion from CI quietly becomes permanent.** Mitigation: stated in
the audit document as a known limitation with its reason, not buried in config.
