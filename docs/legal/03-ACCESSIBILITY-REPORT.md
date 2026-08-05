# Accessibility audit — the legal surface

**Standard:** WCAG 2.1 Level AA · **Date:** 2026-08-05
**Scope:** `PrivacyNotice.jsx` as built, plus the six page designs in
[`02-DESIGN-SYSTEM.md`](02-DESIGN-SYSTEM.md)

**Why this is not optional.** In Posture A, ADA Title II obliges public entities to conform web
content and mobile apps to WCAG 2.1 AA. DOJ extended the deadlines on 2026-04-17 to
**2027-04-26** (entities serving ≥50,000 people) and **2028-04-26** (smaller entities and
special districts). A district cannot adopt software that would put it out of conformance.

**Method.** Contrast ratios below are **computed from the actual token values in
`src/index.css`**, not estimated — including alpha-compositing the dark-mode translucent tints
over their real surfaces. Everything else is a design/code review; **this does not replace
testing with VoiceOver and NVDA**, which will find things static review cannot.

---

## Summary

**Issues found: 11** — Critical 1 · Major 4 · Minor 6

The colour system is in genuinely good shape: **every text pair passes, most of them
comfortably**, in both themes. The `--neutral-500` comment in `index.css` shows someone already
did this exercise once and retuned a token to clear 4.5:1. That work holds up.

The one critical finding is not about text.

---

## Colour contrast — computed

### Text (WCAG 1.4.3 — 4.5:1 normal, 3:1 large)

| Element | Foreground | Background | Ratio | Pass |
|---|---|---|---|---|
| Body text on card | `--ink` `#122019` | `--surface` `#fbfcfd` | **16.40:1** | ✅ |
| Body text on page | `--ink` `#122019` | `--bg-primary` `#f1f3f6` | **15.16:1** | ✅ |
| Secondary text | `--ink-2` `#4f5f56` | `#f1f3f6` | **6.09:1** | ✅ |
| Muted text on page | `--ink-3` `#637269` | `#f1f3f6` | **4.56:1** | ✅ (tight) |
| Muted text on card | `--ink-3` `#637269` | `#fbfcfd` | **4.94:1** | ✅ |
| Link | `--brand` `#0f6b45` | `#fbfcfd` | **6.37:1** | ✅ |
| Caution callout text | `--warn-ink` `#93370d` | `--warn-tint` `#fffaeb` | **7.21:1** | ✅ |
| Critical callout text | `--danger-ink` `#912018` | `--danger-tint` `#fef3f2` | **7.97:1** | ✅ |
| Important callout text | `--info-ink` `#194185` | `--info-tint` `#eff4ff` | **8.92:1** | ✅ |
| Safe callout text | `--brand-ink` `#08462f` | `--green-50` `#edf8f2` | **10.02:1** | ✅ |
| Primary button label | `#ffffff` | `--primary` `#0f6b45` | **6.54:1** | ✅ |
| Danger button label | `#ffffff` | `--danger` `#b42318` | **6.57:1** | ✅ |

### Text — dark mode (tints alpha-composited over `--surface` `#171c19`)

| Element | Foreground | Background | Ratio | Pass |
|---|---|---|---|---|
| Body text | `#eff3f0` | `#171c19` | **15.41:1** | ✅ |
| Secondary | `#c7d0cb` | `#171c19` | **10.94:1** | ✅ |
| Muted | `#98a49e` | `#171c19` | **6.69:1** | ✅ |
| Muted on page bg | `#98a49e` | `#0d100f` | **7.41:1** | ✅ |
| Caution text | `#fde68a` | composited `#2e2c1a` | **11.31:1** | ✅ |
| Critical text | `#fca5a5` | composited `#2e2522` | **7.88:1** | ✅ |
| Important text | `#bfdbfe` | composited `#1e2a30` | **10.34:1** | ✅ |
| Safe text | `#7de2b8` | `#171c19` | **11.05:1** | ✅ |

**No text contrast failures in either theme.**

### Non-text (WCAG 1.4.11 — 3:1)

| Element | Ratio | Required | Verdict |
|---|---|---|---|
| Focus ring `--brand` on surface | **6.37:1** | 3:1 | ✅ |
| Focus ring `--brand` on page bg | **5.89:1** | 3:1 | ✅ |
| Focus ring dark `#2fbf83` on surface | **7.32:1** | 3:1 | ✅ |
| Callout icons using `--warn` / `--danger` / `--info` | 5.20 / 6.05 / 5.43:1 | 3:1 | ✅ |
| **Input border light** `--rule-strong` `#bdc2cd` on `#fbfcfd` | **1.74:1** | 3:1 | ❌ **FAIL** |
| **Input border light** on page bg `#f1f3f6` | **1.61:1** | 3:1 | ❌ **FAIL** |
| **Input border dark** (`rgba(199,208,203,.13)` ≈ `#222824`) on `#171c19` | **1.15:1** | 3:1 | ❌ **FAIL** |
| Callout borders (warn/info/danger) | 1.25–1.55:1 | — | ⚠️ Permissible — see below |
| Section rules `--rule` on surface | 1.42:1 | — | ⚠️ Permissible — decorative |

**On the callout and section borders.** These sit below 3:1, and that is **acceptable under
1.4.11** because they are decorative: the callout's meaning is carried redundantly by an icon
(which passes at 5.2–6.1:1) *and* a visible text label ("Be careful", "Read this"). 1.4.11
applies to graphics "required to understand the content" — with icon and label present, the
border is not. **This holds only as long as the design system's rule that colour never carries
meaning alone is followed.** If a future variant drops the label, these become real failures.

Section rules are purely decorative separators and are exempt on the same basis.

---

## Findings

### 🔴 Critical

**A11Y-1 · Input borders fail non-text contrast — WCAG 1.4.11**

`--input-border: var(--rule-strong)` resolves to `#bdc2cd`, giving **1.74:1** on a card and
**1.61:1** on the page — against a required 3:1. Dark mode is worse at **1.15:1**.

This is an **app-wide** issue, not a legal-surface one, but the legal surface has four inputs
that matter: the certificate verification code field, the `DELETE` confirmation field, the
report form, and the step-up password field. A low-vision user cannot reliably see where the
field is.

**Fix.** Darken the input border only — not `--rule`, which is correctly subtle for decorative
separators:

```css
/* light */ --input-border: #8c95a1;   /* ≈3.1:1 on --surface  */
/* dark   */ --input-border: rgba(199, 208, 203, 0.42);  /* ≈3.1:1 on --surface */
```

Introduce as a distinct token rather than by changing `--rule-strong`, which has other
consumers whose subtlety is intentional. **Verify the ratio after any change** — the numbers
above are targets, and the compositing in dark mode makes them easy to get slightly wrong.

> This finding should be filed against the design system generally, not just this work. It
> affects every form in the product.

### 🟡 Major

**A11Y-2 · `role="status"` on the incompleteness warning — WCAG 4.1.2**
`PrivacyNotice.jsx:82`. `status` is a polite live region intended for *dynamic* updates. This
content is static and present at page load, where live-region semantics are unreliable — some
screen readers announce it out of document order, others not at all.

**Fix.** Remove the role. It is a `<section>` with a heading; that is already correct semantics.
If it must be emphasised, use `<section aria-labelledby="notice-incomplete-title">` and let the
heading do the work.

**A11Y-3 · Heading hierarchy is visually inverted — WCAG 1.3.1**
`h3` (`0.9375rem`) renders *smaller* than body text (`~1rem`). In `DistrictFact`, the label
"How long records are kept" appears less important than its own value. Structure that is
correct in the DOM but contradicted visually fails the intent of 1.3.1 for sighted users.

**Fix.** The reading scale in the design system (`--legal-fs-h3: 1.125rem`) resolves this.

**A11Y-4 · Tables will scroll horizontally without keyboard access — WCAG 2.1.1**
The retention and rights tables exceed narrow viewports. An `overflow-x: auto` container is not
keyboard-focusable by default, so a keyboard-only user cannot scroll it.

**Fix.** Every `PolicyTable` wrapper carries `tabindex="0"`, `role="region"`, and an
`aria-label` naming the table. Already specified in the design system; called out here because
it is easy to drop in implementation.

**A11Y-5 · Youth-safety audience tabs must not remove content from the DOM — WCAG 1.3.1 / 2.1.1**
If the student/parent/organizer tabs unmount inactive panels, browser find-in-page fails, the
print stylesheet loses two-thirds of the page, and deep links break.

**Fix.** Render all panels; hide inactive ones with `hidden`. Implement as a proper tablist
(`role="tablist"` / `role="tab"` / `role="tabpanel"`, arrow-key navigation, roving tabindex),
or as linked routes with all content present. **Emergency contacts stay outside the tabs
entirely** — they must never be one interaction away.

### 🟢 Minor

**A11Y-6 · Anchor targets hidden under the sticky topbar — WCAG 2.4.3.** Add
`scroll-margin-top: var(--legal-anchor-offset)` to every `h2[id]`.

**A11Y-7 · `<em>` for emphasis in the warning — WCAG 1.4.8 (AAA, but cheap).** Italics at small
sizes measurably reduce legibility for dyslexic readers. Use `<strong>` — it is also the more
accurate semantic here.

**A11Y-8 · Reading time and version need programmatic association — WCAG 1.3.1.** Wrap
`PolicyMeta` in `<div role="contentinfo">`… no — simpler and correct: mark up the date as
`<time dateTime="2026-08-05">` so it is machine-readable.

**A11Y-9 · Anchor-link icons appear on hover only — WCAG 2.4.7.** They must appear on
`:focus-visible` too, or keyboard users never discover them. `.legal-anchor:focus-visible`
alongside `:hover`.

**A11Y-10 · Skip link.** The legal pages need "Skip to content" that bypasses the TOC rail.
Verify one exists in `App.jsx`'s shell and that it targets the article, not the layout wrapper.

**A11Y-11 · Touch targets in the TOC — WCAG 2.5.5.** TOC entries at `--legal-fs-small` with
tight spacing will fall under 44×44px. Set `min-height: 44px` and vertical padding on
`.legal-toc a`. Same for `tel:` links in the crisis banner, which are the highest-stakes touch
targets in the product.

---

## Keyboard navigation

| Element | Tab | Enter/Space | Escape | Arrows |
|---|---|---|---|---|
| Skip link | First, visible on focus | Jumps to article | — | — |
| TOC entries | In order, before article | Scrolls + moves focus to the heading | — | — |
| Anchor icons | After their heading | Copies/navigates to the URL | — | — |
| Table scroll region | Focusable | — | — | ←→ scroll |
| Mobile TOC disclosure | Focusable | Toggles | Closes | — |
| Safety tabs | One stop (roving tabindex) | Activates | — | ←→ switch |
| Verify form | Input → button | Submits | — | — |
| Report dialog | Trapped | Submits | Closes, returns focus | Radio group |

**Focus must move to the target heading on anchor navigation**, not merely scroll. A screen
reader user who activates a TOC link and only scrolls hears nothing change.

---

## Screen reader expectations

| Element | Should be announced as |
|---|---|
| Page | "Privacy at WeVolunteer, heading level 1" |
| Callout | "Be careful. This notice isn't finished yet…" — the visible label read first |
| `DecisionCard` | "How long records are kept, heading level 3. Not yet provided…" |
| Incomplete warning | Static region, announced in document order — **not** as a live update |
| Verify success | Result region receives focus; announced as a group |
| Verify failure | "We couldn't find a certificate with that code" — via `role="alert"` |
| Delete confirmation input | "To continue, type DELETE, edit text" |

The delete modal already gets several of these right — `role="alert"` on the error and a
properly associated label, both added after a screen-reader user pressed the button and heard
nothing. That pattern should be the template for the new components.

---

## Zoom and reflow — WCAG 1.4.10

At 200% zoom and at 320px width:

- The TOC rail collapses to a disclosure below 1024px — **no horizontal scrolling**.
- `--legal-measure: 68ch` is a relative unit, so it reflows rather than overflowing.
- Tables scroll inside their own container; **the page body never scrolls horizontally**.
- The crisis banner stacks and stays pinned.

**Requires testing at 400% zoom**, where reflow requirements are strictest and where the sticky
elements are most likely to consume the viewport. The crisis banner is the specific risk: a
pinned banner at 400% can occupy the whole screen. It should become static (scrolls away) below
a threshold height — but must remain the first thing in the document.

---

## Readability

Not a WCAG AA requirement (3.1.5 is AAA), but the governing constraint for a teenage audience.

| Document | Target | Method |
|---|---|---|
| In-product copy | Grade 6–7 | |
| Privacy, Deletion, Youth Safety | Grade 8 | |
| Terms of Service | Grade 9–10 | |

Structural techniques used throughout, which help more than word choice alone: sentences under
20 words, one idea per paragraph, tables instead of prose for anything enumerable, a "short
version" before every long document, and the consequence stated before the mechanism.

---

## Priority

1. **A11Y-1 (input borders)** — a real AA failure, affects the whole product, one token change.
2. **A11Y-5 (tabs keep content in DOM)** — an architectural decision that is expensive to
   reverse after implementation.
3. **A11Y-3 (heading scale)** — resolved by adopting the reading scale.
4. **A11Y-2, A11Y-4** — small, mechanical.
5. The minors — a single pass during implementation.

## What this audit cannot tell you

Static review catches roughly 30% of accessibility defects. Before claiming WCAG 2.1 AA
conformance to a district, you need: VoiceOver (Safari/iOS) and NVDA (Firefox) passes on all
six pages; keyboard-only navigation of every flow; 400% zoom; and testing with an actual
student who uses assistive technology. **Do not publish a conformance statement based on this
document alone** — an inaccurate VPAT is its own liability.
