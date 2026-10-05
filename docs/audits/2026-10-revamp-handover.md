# Revamp hand-over

Phase 7 of the final requirements audit
(`docs/audits/2026-10-final-requirements-audit.md`). The owner decided on
2026-09-30 that the frontend revamp is a separate engagement, run in Claude
Design with his colour-scale photos and the "Launching a Vibe-Coded App"
checklist. This document is what that engagement starts from: where the design
stands, what has been asked for and not yet given a visual answer, and the rules
a revamp has to keep because each one was paid for.

It is a hand-over, not a design. Nothing here has been decided for the revamp.

---

## 1. Where the design stands

### Tokens

Everything visual comes from custom properties at the top of `src/index.css`
(324 of them). The ones a revamp will touch first:

| Group | Tokens | Notes |
|---|---|---|
| Type | `--font-display` (Bricolage Grotesque), `--font-body` (Public Sans), `--font-doc` (Iowan Old Style → Palatino → Georgia, certificates and transcript), `--font-mono` | Google Fonts are the one external stylesheet the CSP allows |
| Palette | `--green-50 … --green-800`, `--green-dark-*`, `--neutral-*`, status primitives | Primitives; components should not read them directly |
| Roles | `--brand`, `--brand-ink`, `--brand-tint`, `--accent` (amber), `--ok`, `--warn`, `--danger`, `--info`, `--surface`, `--surface-2/3`, `--ink`, `--ink-2/3`, `--rule` | What components read. Light and dark are two assignments of these |
| Brand | `--brand-forest` (#0f5a3a), `--brand-mark-bg`, `--brand-mark-ink`, `--brand-wordmark` | The tile and the lockup |
| Space | `--s1` … `--s16` (0.25rem steps to 4rem) | |
| Radius | `--r-sm` 6px, `--r-md` 10px, `--r-lg` 14px, `--r-full` | |

The rule in the stylesheet's own header is the one to keep or deliberately
replace: **colour carries meaning and nothing else** — green is the platform
and any action, **amber is hours and credit, exclusively**, status colours only
on status objects. Ruling 24 (2026-10-04) made a volunteer's hours figure
always amber; it had been red under a third of the 25-hour target.

`src/tokens.test.js` and `src/noDanglingClasses.test.js` fail the build when a
component names a token or class with no rule, so a renamed token is caught.

### Motion

Two systems, kept apart on purpose:

- **Brand motion** (`src/components/common/wvMotion.css`, `brandMotion.js`):
  the mark's draw and its signature. Values are frozen. See
  `docs/features/brand-motion.md`.
- **Interface motion** (the "Interface motion" section at the end of
  `src/index.css`, shipped in `98b3f63`): dialog enter and exit, the success
  beat, view transitions. See `docs/features/interface-motion.md`. Every
  animated selector there must also appear in **both** reduced-motion blocks;
  `src/interfaceMotion.test.js` enforces it.

### The brand lockup

`BrandLockup` (`src/components/common/BrandLockup.jsx`) is the tile plus the
name as set text, on every page the product signs: the shell, the error
screens, `/verify` and a club's public page (N10, `c16a584`). This **overrides**
the older rule that the mark and the wordmark are never paired (memory "Logo
lockup override"): the owner decided the drawn wordmark alone read as plain
text. `Wordmark.jsx` is now rendered nowhere and is kept only in case the
revamp wants it back; remove it if not. The email header uses the same lockup
as a table cell (ruling 12 kept its plain "W").

### Two sites

`www.wevolunteers.org` is the info site, static pages in `site/` on Cloudflare
Workers, live since 2026-10-04 (`docs/operations/info-site.md`). The app is
`app.wevolunteers.org`. The info site's tests read the app's tokens, icons and
logo geometry, so **a revamp of the app's brand will fail `site/tests` until
the site follows**: that is intended; follow the app, do not loosen the tests.

---

## 2. Visual requests not yet given a visual answer

Each was handled for behaviour or wording in the audit; the look is the
revamp's.

| Where | What | Source |
|---|---|---|
| Organizer's "Your volunteers" row, on a phone | The name gets about a third of the width; it wraps rather than truncating, but the hours pill and Profile would read better on a line of their own | Fix-pass item 11 |
| Event form | One heading, "Selection Method", is title case among sentence-case headings | Phase 5 walk |
| Settings | "Your Data", "Manage Export", "Danger Zone", "Delete Account" are title case; the rest of Settings is sentence case | Phase 6 walk |
| Event details | "About This Opportunity" is title case | Phase 6 walk |
| Organization page | Redesign of the page asked for alongside the join modes; the modes shipped, the redesign did not | SC-07 (ruling 12 kept request-to-join) |
| Signup, sign-in method step | Validation hints now always hold a line so the button stays put (ruling 25); the step would still benefit from a calmer layout | Phase 5 walk |
| The analytics consent card | It is the first thing on every page until answered, above the page's own content | Phase 5 walk |
| Demo bar | At 320px the "Viewing as" select runs off the right edge. Demo builds only | Phase 6, 320px check |

The owner's own visual complaints from the request history (FX-11 the
next-shift green, FX-38 the map theme, FX-49 avatars on a colour, FX-62 the date
chip, LG-13 the tag spacing) are fixed and verified; the ledger cites each.

---

## 3. Rules a revamp has to keep

Each of these is enforced by a test or recorded with the incident that produced
it. Changing one is a decision, not a restyle.

1. **No new items in the navigation rail** (the owner: "TRY NOT TO ADD ICONS TO
   THE MENU BAR"). New entry points go into existing surfaces. The phone bar
   fits six entries from 360px (`mobileNavFit.test.js`, ruling 2).
2. **44px touch targets on phones** (`index.css`, "Touch-target floors"), scoped
   to the mobile breakpoint on purpose.
3. **Reduced motion**: both reduced-motion blocks, every animated selector
   (`interfaceMotion.test.js`). The Browser preview pane reports
   `document.hidden`, which suppresses exits; verify motion in a real window.
4. **No horizontal scroll at 320px** on any route (`a11y/sweep.geometry.spec.js`,
   WCAG 1.4.10). The calendar toolbar was the last offender (`66aab75`).
5. **The a11y walker's loading contract**: it waits out `.skeleton` and
   `.full-page-wait` only, so a new loading state must use one of them or join
   the contract (`a11y/harness/walk.mjs`, memory "a11y walker loading contract").
6. **Amber for hours only**; green for the platform and actions.
7. **Print**: the certificate keeps its look; the transcript prints plain white
   (ruling 15); light and dark print identical PDFs (`printIsolation.test.js`).
8. **Every page has one `h1` and ordered headings** (`headingLevels.test.js`),
   and a refusal or not-found renders a marked state the sweeps can recognise
   (`notFoundMarker.guard.test.js`).
9. **Nothing claims the platform is run for or by a school or district**
   (Posture B): `schoolStaffClaims.test.js`, `Welcome.privacyClaim.test.jsx`,
   and the info site's `site.copy.test.js`. A redesign that reintroduces copy
   must keep to what the code and the published policies say.
10. **Profiles are private by default**, a published promise since `aed176c`;
    a design that surfaces more of a profile by default would break it.
11. **"Event" in every organizer tool, "opportunity" only where a student
    browses** (ruling 23, `labelDestinations.test.jsx`).

---

## 4. What the revamp needs from the owner

- The colour-scale photos and the "Launching a Vibe-Coded App" checklist he
  named on 2026-09-30.
- Whether `Wordmark` comes back or is deleted.
- Whether the info site is restyled in the same pass, since its tests will
  require it the moment the app's tokens move.
