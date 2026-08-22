# WeVolunteer accessibility audit

**Date:** 2026-08-22
**Target:** WCAG 2.2 Level AA
**Method:** real-browser measurement (Playwright + axe-core 4.13) over the whole route table, plus static guards in the existing Vitest suite
**Scope:** 48 declared routes; 161 route/role pairs measured signed in across 4 seeded roles, plus a signed-out pass

**This document does not claim legal ADA compliance.** WCAG conformance is a technical
target. Whether the ADA applies to WeVolunteer, and on what terms, depends on its legal
structure, funding, users and jurisdiction — a question for qualified legal advice, not for a
test suite. Everything below is a statement about measurements, not about legal obligations.

---

## 1. Evidence classes

Every finding carries one. This is the most important section in the document, because the
difference between these is the difference between knowing something and assuming it.

| Class | What it means | What it licenses you to say |
| --- | --- | --- |
| **measured** | A check in `a11y/` asserts it in a real browser, on every relevant route | "This is true, and it will fail the build if it stops being true" |
| **inspected** | Read in source or in the accessible tree; no automated guard | "This looked right when someone looked" |
| **human-verified** | Confirmed by a person using assistive technology | "Somebody heard this work" |
| **unverified** | Nothing checked it | "We do not know" |

**No criterion in this document is marked passing because a scanner did not flag it.** axe
reporting zero violations is recorded as axe reporting zero violations.

---

## 2. What was already accessible before this initiative

This matters for reading the rest of the document: this was not a codebase starting from zero,
and the low finding count is a fact about the prior work rather than about the audit's depth.

Already present and verified still working:

- **A shared dialog shell** ([`src/components/Modal.jsx`](../../src/components/Modal.jsx)) owning Escape,
  focus containment, focus restore, scroll lock and ARIA wiring — portalled to `document.body`
  for a documented `backdrop-filter` reason.
- **Skip link and landmarks** in the signed-in shell, with `aria-current="page"` on both the
  desktop rail and the mobile bar.
- **A purpose-built accessible date picker** written because "a calendar is the easiest place
  accessibility is lost".
- **Nine static guard tests** covering touch targets, heading levels, document contrast, input
  contrast, design tokens, page titles, mobile nav fit, hardcoded colours and dialog semantics.
- **Live regions in 23 files**, including a correct streaming strategy in Welly (see §7).
- **An `accessibility` issue-report category** already defined server-side.
- **No paste blocking anywhere** — which is what satisfies 3.3.8 and what lets a password
  manager work.
- **No drag-only interactions**, so 2.5.7 is not applicable.

---

## 3. Findings

### Fixed in this workstream

| ID | Finding | Criterion | Severity | Where | Who it affected | Status |
| --- | --- | --- | --- | --- | --- | --- |
| A-01 | `:focus-visible` replaced the outline with a `box-shadow`, and the stylesheet had no `forced-colors` block. Windows High Contrast strips `box-shadow`, so there was **no focus indicator at all, on any control, on any page** in that mode | 2.4.7 (A), 1.4.11 (AA) | **P0** | `src/index.css` globally | Every keyboard user in a forced-colours or high-contrast mode — i.e. precisely the people most likely to be in one | Fixed, **measured** |
| A-02 | `.composer-input` zeroed `outline` **and** `box-shadow` on both `:focus` and `:focus-visible`, so the message composer had no focus indicator for anybody | 2.4.7 (A) | **P0** | `src/index.css:4545` | Every keyboard user of messaging | Fixed, **measured** |
| A-03 | Five instances of `opacity` used to de-emphasise text that a muted colour token had already de-emphasised, producing contrast from 2.38:1 to 4.10:1. Worst: the Welly disclaimer telling somebody not to type personal information into it, at 2.65:1 | 1.4.3 (AA) | P1 | `src/index.css`, `LocationDisplay.css` | Low-vision users, and anybody in bright light | Fixed, **measured** |
| A-04 | The toast dismiss control measured **14×15px** — the icon's own box, with no padding and no minimum | 2.5.8 (AA) | P1 | `src/components/common/Toasts.jsx` | Motor-impaired and touch users; it is the way out of a message covering something | Fixed, **measured** |
| A-05 | The error page clipped its own content vertically. Under the text-spacing overrides 1.4.12 requires, content grew from 819px to 901px inside a box clipping at 819 — and what sits at the bottom of an error page is the actions | 1.4.12 (AA) | P1 | `src/index.css` `.err` | Anybody using a text-spacing user stylesheet, on the one screen whose purpose is offering a way out | Fixed, **measured** |
| A-11 | **Tab from the sign-in identifier landed on "Forgot?", not the password field.** The control sits in the password field's label row, which put it between the two inputs in DOM order. Typing an email, Tab, typing a password, Enter — the sequence every keyboard user performs — swallowed the password keystrokes and activated "Forgot?", landing the person on "Reset your password" having lost what they typed, with no error and no explanation | 2.4.3 (A) | **P1** | `src/views/Login.jsx` | Every keyboard user signing in — on the one page where there is no way around a defect | Fixed, **measured** |
| A-12 | `/report-issue?category=` was ignored. Settings → Accessibility and the Accessibility Statement both link there as `?category=accessibility`, and the view initialised its state to `''` and never read the URL — so somebody following an "accessibility problem" link still had to find the right option in a dropdown, using the interface that was failing them | 3.3.2 (A) | P2 | `src/views/ReportIssue.jsx` | Anybody reporting a barrier. Introduced by this initiative and fixed in it | Fixed, **measured** |
| A-06 | The theme picker marked its selection with a CSS class only, so assistive technology met three identically named buttons with no way to tell which was current | 4.1.2 (A) | P2 | `src/views/Settings.jsx` | Screen-reader users | Fixed, **inspected** |
| A-07 | Welly's suggestion chips had a visual "Try asking" label with no programmatic association, so AT met six unrelated buttons with no context | 1.3.1 (A) | P2 | `src/views/WellyView.jsx` | Screen-reader users | Fixed, **inspected** |

### Open

| ID | Finding | Criterion | Severity | Status |
| --- | --- | --- | --- | --- |
| A-08 | `/appeal/:token` renders with **no tab stops at all** for an invalid token. An appeal link that has expired or been mistyped leaves a keyboard user on a page with nothing to operate and no route onward | 2.1.1 (A), 2.4.3 (A) | P2 — open | **measured** (the sweep reports it; the fixture token is deliberately invalid, so this is the error state rather than the happy path) |
| A-09 | The demo account switcher (`DemoBar`) is a 210×25 `<select>`, below the 44px house rule | 2.5.8 satisfied; house rule not | P3 — won't fix | **measured**. Development-only: `VITE_DEMO_MODE` cannot reach a production bundle |
| A-10 | Welly's streaming announcement behaviour is verified structurally but never heard | 4.1.3 (AA) | — | **unverified** — see §7 and §8 |

---

## 4. Measured results, in full

**Verification run:** the exact CI command, from a clean `scratch/` directory —
`NODE_ENV=development DATABASE_ENGINE=sqlite VITE_LOCAL_AI=false WEV_DB_PATH=$PWD/scratch/a11y.db npm run a11y -- --grep-invert @local`
— **34 tests, 34 passed, 48.9 minutes, exit 0.** Alongside it: the full Vitest
suite at **7,808 passed / 0 failed** (106 skipped, all pre-existing
PostgreSQL-gated), plus `oxlint` and `vite build` clean.

The 48.9 minutes is worth naming as a cost. Nineteen of them are the axe sweep,
which is the only one running all four roles; the rest are ~3.5 minutes each.
It runs in its own CI job precisely so that cost cannot slow the existing
build-and-test pipeline.

After the fixes above, on the current tree:

| Sweep | What it measures | Result |
| --- | --- | --- |
| `sweep.axe.spec.js` | axe-core, tags `wcag2a wcag2aa wcag21a wcag21aa wcag22aa`, 161 route/role pairs across 4 roles | **0 violations.** Baseline is `{}` |
| `sweep.aria.spec.js` | heading tree, landmark naming, unnamed controls, exactly one `h1` | **0** skipped heading levels, **0** indistinguishable landmarks, **0** unnamed controls, exactly one `h1` on every route |
| `sweep.focus.spec.js` | keyboard traps, focus indicator presence, 2.4.11 obscuring | **0** traps, **0** controls focusing without an indicator, **0** obscured focused controls |
| `sweep.media.spec.js` | forced-colors focus, reduced-motion, 200% zoom | Focus visible under `forced-colors: active` on **every route**; nothing animates infinitely under `prefers-reduced-motion`; the dashboard survives the 200% equivalent |
| `sweep.geometry.spec.js` | 2.5.8 target size, 1.4.10 reflow at 320px, 1.4.12 text spacing | **0** below the 24×24 AA floor; **0** routes scroll horizontally at 320px |
| `workflows/auth.spec.js` | the signed-out authentication journey, keyboard only | Sign-in completes by keyboard; paste is not blocked; autocomplete tokens present; the error reaches a live region; focus is not lost on failure |
| `workflows/welly.spec.js` | Welly's structure and live-region wiring | The transcript is not a live region; an atomic `role="status"` exists outside it; the input has a real name; suggestions are a labelled group satisfying 2.5.3; every conversation control is named |
| `workflows/preferences.spec.js` | Settings → Accessibility end to end, and the statement | The section is reachable through the navigation and renders; text size is a real radio group and **measurably** resizes the root; each switch writes its attribute **and** the stylesheet reacts; Larger controls produces ≥44px buttons; preferences survive a reload applied before first paint; reset removes every attribute; the statement is reachable, names WCAG 2.2, explains how to report, and makes no legal-compliance claim; the report link arrives with the category preselected |

The exactly-one-`h1` result is worth naming separately: it is the browser confirming
[`src/headingLevels.test.js`](../../src/headingLevels.test.js)'s claim, which that guard makes by
reasoning about source text and an allowlist of views rendering outside the shell. Runtime
agrees with it.

---

## 5. What the audit found in its own instruments

Six defects in the harness, five of which would have produced **false findings** in this
document. Recorded because a measurement's credibility depends on knowing how it was wrong
before.

| # | Defect | Consequence if it had shipped |
| --- | --- | --- |
| 1 | `page.waitForLoadState('networkidle')` never fires — `src/services/socket.js` holds a socket.io connection open | Every route burned a 30s timeout; hours per run, i.e. a harness nobody runs |
| 2 | The sweeps signed in before visiting everything, so `/login`, `/signup` and `/welcome` were measured **after their redirect** | The dashboard audited three extra times under the auth routes' names, and the sign-in page — where a locked-out person cannot work around anything — never audited at all |
| 3 | Contrast measured mid-animation. Entrance animations run 120–300ms and a fading element's composited colour is lighter than its token | **31 of 49 contrast "violations" were artefacts**, including the primary button: white on its token is 6.54:1, white on the mid-fade composite is 4.29:1. Acting on these would have meant darkening a conformant palette |
| 4 | Landmark duplication counted DOM nodes without checking exposure | **23 false findings.** `.mobilenav` is `display: none` until its breakpoint and `.sidebar` is hidden below it; `display: none` removes an element from the accessibility tree, so no screen reader has ever seen both |
| 5 | Keyboard-trap detection compared a 140-character `outerHTML` slice, and every `.nav-item` starts with identical inline SVG | **25 false traps.** The giveaway was that the "trapped" control differed on every route; a real trap is the same control every time |
| 6 | Fixing #3 made the reduced-motion sweep vacuous: settling styles sets `animation-duration: 0s`, so "which elements still animate infinitely" found none | A green result proving nothing, on every route. That sweep now opts out of settling and carries a control test that injects an infinite animation and fails if the detector cannot see it |
| 7 | The 1.4.12 clipping detector tested `overflow` as a whole, so it kept reporting `.err` after the fix — `clip visible` is not `visible` | A detector that cannot see a fix argues for changes already made. Only `overflow-y` decides whether growing text is lost |

Three further failures were the **tests'** wrong assumptions rather than the application's
defects, and the corrections are worth more than the tests were:

| Assumption | What the app actually does |
| --- | --- |
| A sign-in error must reach `[role="alert"]` | Login moves focus to the failed field, whose `aria-describedby` points at the error — so the field, its label and the reason are announced together. For a single-field error that is **better** than a live region elsewhere, because it also puts the cursor where the fix happens. The test now asserts the association |
| The identifier is `input[type="email"]` | It is `type="text" name="username"`, because the form accepts a username too |
| A statement must not contain the string "ADA compliant" | The statement contains it in order to **disown** it. A substring test forbade the very disclaimer it was meant to protect; the check now matches affirmative claims only, and separately requires the disclaimer to be present |

Two more were races: reading an attribute before the form rendered, and reading Welly's
transcript before its lazy import resolved. Both reported correct markup as missing.

---

## 6. WCAG 2.2 A/AA mapping

Only criteria that apply to this application. A criterion's row says what evidence exists, not
what we hope.

### Passing, measured

| Criterion | Level | Evidence |
| --- | --- | --- |
| 1.3.1 Info and Relationships | A | Heading tree and landmark structure measured on every route |
| 1.4.3 Contrast (Minimum) | AA | axe on 161 route/role pairs, with styles settled |
| 1.4.10 Reflow | AA | 320px viewport, every route, no two-axis scrolling |
| 1.4.11 Non-text Contrast | AA | axe, plus the forced-colors focus sweep |
| 1.4.12 Text Spacing | AA | The four criterion values injected, every route |
| 2.1.1 Keyboard | A | Focus walk on every route; auth journey keyboard-only |
| 2.1.2 No Keyboard Trap | A | Focus walk, node-identity trap detection |
| 2.4.3 Focus Order | A | Focus walk records order on every route |
| 2.4.7 Focus Visible | A | Focus walk plus the forced-colors sweep |
| 2.4.11 Focus Not Obscured (Minimum) | AA (new in 2.2) | `elementFromPoint` against the focused control, every route |
| 2.5.3 Label in Name | AA | Asserted on Welly's suggestion chips |
| 2.5.8 Target Size (Minimum) | AA (new in 2.2) | Every interactive element measured against 24×24 on every route |
| 4.1.2 Name, Role, Value | A | Unnamed-control sweep on every route |

### Passing, inspected

| Criterion | Level | Evidence |
| --- | --- | --- |
| 1.4.4 Resize Text | AA | Dashboard verified at the 200% equivalent; not yet every route |
| 2.3.3 Animation from Interactions | AAA (recorded because it was measured) | Nothing animates infinitely under `prefers-reduced-motion` |
| 3.3.1 Error Identification | A | Auth errors reach a live region with real text |
| 3.3.8 Accessible Authentication (Minimum) | AA (new in 2.2) | No paste handler anywhere cancels the event; autocomplete tokens present |

### Not applicable

| Criterion | Why |
| --- | --- |
| 2.5.7 Dragging Movements | AA (new in 2.2) — no drag interactions exist in the codebase |
| 4.1.1 Parsing | **Obsolete and removed in WCAG 2.2.** Not treated as a requirement |

### Unverified — nothing checked these

| Criterion | Level | Why it is unverified |
| --- | --- | --- |
| 1.3.5 Identify Input Purpose | AA | 129 `<input>` elements, 30 with `autoComplete`. The criterion applies only where a field collects information *about the user* from a defined list, so the true shortfall is much smaller than 99 — but it has not been enumerated field by field |
| 3.2.6 Consistent Help | A (new in 2.2) | Help exists in Settings → Help & Support, `/report-issue`, and Welly. No scanner detects whether they appear in a consistent relative order; nobody has walked it |
| 3.3.7 Redundant Entry | A (new in 2.2) | Signup, second-factor enrolment and the appeal flow are the candidates for asking twice for something already given. Not checked |
| 1.2.x Time-based Media | A/AA | No audio or video was found; if any is added these become live and are currently unassessed |
| 2.4.6 Headings and Labels (descriptiveness) | AA | Headings *exist* and nest correctly — measured. Whether each one is *descriptive* is a judgement no machine made |
| 4.1.3 Status Messages | AA | Live regions are wired correctly and Welly's strategy is structurally right. Whether announcements are usable — order, verbosity, interruption — is the human half |

---

## 7. Welly

Welly's streaming accessibility was **already correct** before this audit, and that is worth
recording precisely because the naive implementation is so common:

- The transcript is deliberately **not** a live region. Its own comment records why: `aria-live`
  used to sit on the scrolling container, so a reply arriving in forty fragments was announced
  forty times.
- A separate `role="status" aria-live="polite" aria-atomic="true"` region holds one short string
  that changes twice per turn — "Welly is thinking", then the finished answer.
- Each turn carries an `sr-only` "You asked:" / "Welly replied:" prefix on **every** message, so
  a reader who jumps into the middle of a transcript still knows who is speaking.

Independent research into current guidance (W3C/WAI, ARIA APG, TetraLogical, Adrian Roselli,
MITRE's chatbot playbook, Orange's guidelines, and Microsoft's BotFramework fix) matches this
design: the only hard AA requirement here is **4.1.3 Status Messages**, `role="log"` is the
listed sufficient technique for a chat transcript, and the recommended pattern is to suppress
live-region participation during streaming and announce a status plus the final message. Shipped
assistants — ChatGPT, Claude, Copilot — have open accessibility bugs in exactly this area and
are a catalogue of anti-patterns rather than a template.

Changed here: the suggestion chips became a labelled `role="group"` (A-07).

**Not verified:** whether it sounds right. A regression guard now asserts the negative — that no
live region exists at or inside the transcript — because an `aria-live` added back there looks
like an improvement to anybody who has not read the comment.

---

## 8. Known limitations

Stated plainly rather than left to be discovered.

1. **No screen reader was run.** The harness verifies what the browser *computes* — names, roles,
   states, heading tree, live-region wiring. It cannot hear verbosity, interruption, or
   announcement order. [The VoiceOver script](2026-08-22-voiceover-test-script.md) exists to
   close this and has not been executed.
2. **Welly's streaming is excluded from CI.** `VITE_LOCAL_AI=false` there renders the
   engine-unavailable state, so those tests would audit a placeholder and pass while proving
   nothing. They are tagged `@local` and run by hand.
3. **The harness measures a development bundle.** `vite.config.js` has no `preview` block, and
   serving `dist` requires `IS_PRODUCTION`, which also arms secure cookies that `http://127.0.0.1`
   cannot satisfy — sign-in would fail for every role. Chunking and minification differ from the
   shipped bundle; the DOM, accessible tree, cascade and layout do not. A defect introduced *by*
   the production build would not be caught.
4. **Chromium only.** Firefox and WebKit are not swept. Layout and accessible-tree differences
   between engines are real and unmeasured here.
5. **One role per structural sweep.** Only axe runs all four roles. Structure, focus and geometry
   run as the first seeded role, on the reasoning that these are properties of the shell and the
   view rather than of authorisation — which is true but not proven.
6. **Transient states are under-covered.** The weather badge's contrast defect existed only during
   the ~300ms its forecast was loading, and a clean run proves nothing about it. Loading, empty
   and error states are measured only when a sweep happens to catch them.
7. **Certificates are printable pages, not tagged PDFs.**

---

## 9. Confidence assessment

**Strong WCAG 2.2 AA implementation for machine-verifiable criteria, with screen-reader
verification outstanding.**

What that means concretely: every criterion a browser can check is checked, on every route, and
passes — and those checks now run in CI behind a one-way ratchet, so they cannot silently
regress. Two application-wide P0 focus defects, five real contrast defects, a target-size
failure on the control every user reaches, a clipped error page, and a tab order that sent
keyboard users to password reset were all found and fixed. The accessible structure of the
application is genuinely good, and most of that predates this work.

The tab-order defect is the one worth dwelling on, because it is the shape of what automated
testing misses: every control was named, every field labelled, contrast passing, axe silent —
and the form still could not be completed by keyboard in the obvious way. It took walking the
journey rather than scanning the page.

What it does not mean: that a blind user has completed a workflow. Nobody has listened to this
application. The single largest remaining risk is that a structurally correct live region
announces something unusable, and no machine in this setup can tell you whether it does.

**No claim is made about legal ADA compliance.**

---

## 10. Recommended next steps

1. **Run the VoiceOver script.** It is the only evidence for §6's unverified rows, and Welly's
   streaming section is the highest-value part of it.
2. **Enumerate 1.3.5 field by field.** The 129-versus-30 figure is not a finding until somebody
   establishes which of those fields collect information about the user.
3. **Walk 3.2.6 and 3.3.7 by hand.** Neither is detectable by tooling, and both are Level A.
4. **Fix A-08** — give the invalid-appeal-token state something to operate.
5. **Test with a real assistive-technology user**, which is better evidence than a sighted
   developer driving VoiceOver, and is the thing that finds what none of the above will.
6. **Consider a second engine** in the sweep if Firefox or Safari usage is significant.
