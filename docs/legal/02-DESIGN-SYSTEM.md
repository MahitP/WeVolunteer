# The legal surface — design system and page designs

## Part 1 — Critique of the current privacy notice

`src/views/PrivacyNotice.jsx` is **conceptually excellent and visually unconsidered.** The
information architecture — facts first, district-specific unknowns quarantined and labelled,
an incompleteness warning placed above the reassuring content — is better than almost every
privacy page on the web. It is then rendered with the product's dashboard components, which
undoes much of the benefit.

### What is right, and must be preserved

- **The incompleteness warning is above the fold and above anything reassuring.** A reader who
  stops after one screen still learns the page is unfinished. Almost nobody gets this ordering
  right.
- **`DistrictFact` renders missing values as visible admissions**, not omissions. The comment
  explains why: an absent section reads as "does not apply." Correct, and rare.
- **Two factual sections are hard-coded** because they are engineering facts, while three
  policy facts arrive as configuration. That boundary is exactly right and the whole design
  should be built around preserving it.
- Reachable signed-out, so it can be read before signing up.

### What is wrong

| # | Finding | Severity | Evidence |
|---|---|---|---|
| 1 | **No reading measure.** `.content` inherits `--content-max: 1180px`. At default text size that is ~150 characters per line — roughly double the readable maximum | **High** | `index.css:295` |
| 2 | **Headings barely outrank body text.** `h2` is `1.0625rem` (17px), body ~15px. A 2px difference is not a hierarchy; on a 2,000-word document the reader cannot see the structure | **High** | `index.css:460` |
| 3 | **No navigation.** Nine sections, no table of contents, no in-page anchors, no way to link a colleague to one clause. A parent looking for "how do I delete this" must read everything | **High** | — |
| 4 | **No sense of place.** The page is a `<main>` of stacked `<section>`s. Nothing says "you are in the part of the product that answers questions about you" | Medium | — |
| 5 | **`role="status"` on the incompleteness warning is the wrong role.** `status` is a polite live region for *changes*. This is static content present at load — a screen reader may announce it out of order, or not at all | Medium | `PrivacyNotice.jsx:82` |
| 6 | **No date and no version.** A privacy notice with no "last updated" cannot be relied on, cited, or compared | Medium | — |
| 7 | **Dense lists.** Four to six items with `--s2` (8px) gaps, at 15px. Correct for a dashboard, punishing for prose | Medium | `.stack-sm` |
| 8 | **No contact affordance.** The one thing a distressed reader wants is a person. `PRIVACY_CONTACT` renders as a paragraph inside a subsection | Medium | — |
| 9 | **Emphasis via `<em>`** in the warning. Italic serif-less text at small sizes is measurably harder for dyslexic readers | Low | `PrivacyNotice.jsx:88-90` |
| 10 | **`<h3>` inside `DistrictFact` under an `<h2>`** is structurally fine, but visually `h3` (0.9375rem) is *smaller* than body — the label reads as less important than its own value | Low | `index.css:461` |

### The diagnosis

Findings 1, 2, and 7 share a cause: **the type scale is tuned for a dense product UI and is
being asked to render documents.** A dashboard optimises for scanning many small things at
once; a policy optimises for reading one long thing carefully. Those want opposite settings.

The fix is not to change the global scale — that would degrade every other screen. It is to
define a **reading scale** scoped to the legal surface.

---

## Part 2 — Design system

### Constraints this must satisfy

Three build-failing guards in `src/` constrain everything below, and they are the reason this
is a token extension rather than a stylesheet:

- **`noHardcodedColors.test.js`** — no colour literal or colour function outside `index.css`.
  **Every colour here is an existing token or a new alias defined in `index.css`.** Zero new
  hex values are introduced.
- **`tokens.test.js`** — every `var(--x)` used must be defined in `index.css`. No allowlist.
- **`noDanglingClasses.test.js`** — no class without a rule, no rule without a reference. Every
  class named below must be both defined and used.

### 2.1 New tokens

All added to `:root` in `index.css`, with dark-mode counterparts where they resolve to a
colour. **Nothing here is a new colour** — the palette additions are aliases onto existing
primitives.

```css
/* ── Legal surface: reading scale ──────────────────────────────────────────
   The product type scale is tuned for dense dashboards: h1 1.5rem, h2
   1.0625rem, body ~0.9375rem. That is correct for scanning a roster and wrong
   for reading two thousand words of policy, where the reader needs structure
   they can see from across the page.

   These are scoped to `.legal` and never override the global scale. */
--legal-measure: 68ch;        /* optimal reading width; ~66-75ch is the range */
--legal-measure-wide: 82ch;   /* tables and code that need the extra room */

--legal-fs-body: 1.0625rem;   /* 17px — up from the product's ~15px */
--legal-fs-lead: 1.25rem;     /* the summary paragraph under an h1 */
--legal-fs-h1: 2.25rem;
--legal-fs-h2: 1.5rem;
--legal-fs-h3: 1.125rem;
--legal-fs-small: 0.875rem;

--legal-lh-body: 1.7;         /* generous; these are read, not scanned */
--legal-lh-heading: 1.25;

/* Vertical rhythm. Prose needs bigger gaps than the product's --s2/--s3. */
--legal-gap-para: var(--s4);      /* between paragraphs */
--legal-gap-item: var(--s3);      /* between list items */
--legal-gap-section: var(--s10);  /* between top-level sections */
--legal-gap-block: var(--s6);     /* around callouts and cards */

/* Callout tones — aliases onto the existing status palette, no new colour. */
--legal-note-bg: var(--surface-2);
--legal-note-border: var(--rule);
--legal-note-ink: var(--ink-2);

--legal-important-bg: var(--info-tint);
--legal-important-border: var(--info-border);
--legal-important-ink: var(--info-ink);

--legal-caution-bg: var(--warn-tint);
--legal-caution-border: var(--warn-border);
--legal-caution-ink: var(--warn-ink);

--legal-critical-bg: var(--danger-tint);
--legal-critical-border: var(--danger-soft-border);
--legal-critical-ink: var(--danger-ink);

--legal-safe-bg: var(--brand-tint);
--legal-safe-border: var(--brand-tint-2);
--legal-safe-ink: var(--brand-ink);

/* Structure */
--legal-rule: var(--rule);
--legal-toc-w: 232px;
--legal-anchor-offset: 96px;   /* sticky topbar clearance for #anchors */
```

**Dark mode — verified, no work required.** Every semantic the aliases above resolve through is
already overridden in the `[data-theme='dark']` block (`index.css:298–416`):

| Token | Light | Dark | Line |
|---|---|---|---|
| `--info-tint` | `#eff4ff` | `rgba(96,165,250,0.1)` | 409 |
| `--warn-tint` | `#fffaeb` | `rgba(251,191,36,0.1)` | 405 |
| `--danger-tint` | `#fef3f2` | `rgba(248,113,113,0.1)` | 407 |
| `--info-border` / `--info-ink` | `#b2ccff` / `#194185` | `#1e3a8a` / `#bfdbfe` | 383–384 |
| `--warn-border` / `--warn-ink` | `#fedf89` / `#93370d` | `#78350f` / `#fde68a` | 381–382 |
| `--danger-border` / `--danger-ink` | `#fecdca` / `#912018` | `#7f1d1d` / `#fca5a5` | 379–380 |
| `--danger-soft-border` | `rgba(180,35,24,0.2)` | `rgba(248,113,113,0.24)` | 363 |
| `--brand-ink` | `--green-800` | `--green-dark-300` | 337 |

The dark tints are translucent rather than opaque pastels, with a comment explaining why —
opaque light-mode tints "produce bright rectangles with the wrong contrast" on a dark surface.
So the callouts theme correctly with no additional work, **provided every tone is built from
these aliases and never from a primitive.**

### 2.2 Colour usage rules

| Purpose | Token | Never |
|---|---|---|
| Body text | `--ink` | A lighter grey "for elegance." This is the one surface where every word must be legible |
| Secondary / meta | `--ink-2` | For anything load-bearing |
| Timestamps, captions | `--ink-3` | For any sentence a reader must act on |
| Links | `--brand` | Colour alone — links are always underlined here |
| Warnings | `--legal-caution-*` | For anything that is merely informative |
| Danger | `--legal-critical-*` | For emphasis. Reserved for irreversible actions and safety |
| Section rules | `--legal-rule` | Heavier than 1px |

**Rule: colour never carries meaning alone.** Every callout has an icon *and* a visible label
("Important", "Be careful"), so it survives greyscale, colour-blindness, and a printed copy.

### 2.3 Typography hierarchy

| Level | Token | Weight | Font | Use |
|---|---|---|---|---|
| Page title | `--legal-fs-h1` | 700 | `--font-display` | One per page |
| Lead | `--legal-fs-lead` | 400, `--ink-2` | `--font-body` | One paragraph under the title |
| Section | `--legal-fs-h2` | 700 | `--font-display` | Anchored, appears in the TOC |
| Subsection | `--legal-fs-h3` | 600 | `--font-body` | Not in the TOC |
| Body | `--legal-fs-body` / `1.7` | 400 | `--font-body` | |
| Meta | `--legal-fs-small` | 400, `--ink-3` | `--font-body` | Dates, versions |

**`--font-doc` (the serif) is deliberately not used.** It belongs to certificates, where it
signals "this is a formal artefact." Using it for policies would signal "this is a legal
document to be endured" — the exact impression this work exists to avoid.

**Heading ratio.** `2.25 / 1.5 / 1.125 / 1.0625rem` gives a clear step at every level.
Compare the product scale's `1.5 / 1.0625 / 0.9375`, where `h3` is *smaller than body text*.

### 2.4 Components

#### `<LegalLayout>`

Two-column at ≥1024px: sticky TOC rail (`--legal-toc-w`) and a `--legal-measure` article.
Single column below, TOC collapsing to a disclosure.

```
┌──────────────────────────────────────────────────────┐
│  ← Privacy & Safety            [ ⌘K Search ]         │  breadcrumb
├──────────────┬───────────────────────────────────────┤
│ On this page │  Privacy at WeVolunteer               │
│              │  How we handle information about you  │
│ ▸ Short ver. │  Updated 5 Aug 2026 · v1.2 · 6 min    │
│ ▸ What we…   │  ───────────────────────────────────  │
│ ▸ Who can…   │                                       │
│ ▸ How long…  │  ┌─ The short version ─────────────┐  │
│              │  │ • We store your name, email…    │  │
│ ─────────    │  └─────────────────────────────────┘  │
│ Questions?   │                                       │
│ [Contact]    │  ## What we collect                   │
└──────────────┴───────────────────────────────────────┘
```

#### `<Callout tone icon title>`

Five tones. The workhorse of the surface.

| Tone | Icon | Label | Use | Example |
|---|---|---|---|---|
| `note` | `Info` | — | Neutral aside | "Old versions are kept at…" |
| `important` | `Info` | Important | Must not be missed | "Your profile is private by default" |
| `caution` | `AlertTriangle` | Be careful | Consequence follows | The incomplete-notice warning |
| `critical` | `AlertOctagon` | Read this | Irreversible or safety | "Your certificates keep your full name" |
| `safe` | `ShieldCheck` | Good to know | Reassurance | "Codes can't be guessed" |

Left border 3px, tinted background, 1px border, `--r-md`, `--s4` padding. Icon
`aria-hidden`; the visible text label carries the meaning.

#### `<SummaryCard>`

The "short version" block. Always immediately after the lead, before the first `h2`. Brand
tint, four to six bullets, each one sentence.

**This is the most important component on the surface.** Most readers stop after one screen.
It is the difference between a notice that was published and one that was given.

#### `<PolicyMeta>`

`Updated 5 August 2026 · Version 1.2 · 6 min read · [Previous versions]`

The reading time is not decoration — it is a commitment device. "6 min read" measurably
increases completion versus an unmarked wall of text.

#### `<TableOfContents>`

Sticky, `h2`-only, scroll-spy highlighting the current section. Below 1024px it becomes a
`<details>` disclosure pinned under the header, collapsed by default.

#### `<DecisionCard>`

For the `[[BRACKETED]]` values. Renders the honesty principle as a component:

```
┌────────────────────────────────────────────┐
│ ⚠ How long records are kept                │
│                                            │
│ Not yet provided.                          │
│ Bay Ridge Schools hasn't stated a          │
│ retention period.                          │
│                                            │
│ [ Ask about this → ]                       │
└────────────────────────────────────────────┘
```

Generalises the existing `DistrictFact`, adding the one thing it lacks: **an action**. A
reader who hits an unanswered question currently has nowhere to go.

#### `<ContactCard>`

Persistent in the TOC rail, and repeated at the foot of every document. Name, address,
response time. Never a bare `mailto:` — always "we reply within 10 business days."

#### `<PolicyTable>`

Wrapped in `overflow-x: auto` with a focusable scroll container (`tabindex="0"`,
`role="region"`, `aria-label`) so keyboard users can reach horizontally-scrolling content.
Below 700px, two-column tables collapse to definition-list stacks.

#### `<AnchorHeading>`

Every `h2` gets an `id` and a link affordance appearing on hover/focus. Being able to send
someone a link to one clause is what makes a policy usable in an argument.

### 2.5 Spacing

| Between | Token |
|---|---|
| Paragraphs | `--legal-gap-para` (16px) |
| List items | `--legal-gap-item` (12px) |
| `h2` and its first paragraph | `--s4` |
| Section and next `h2` | `--legal-gap-section` (40px) |
| Callouts and surrounding text | `--legal-gap-block` (24px) |
| Article top / bottom | `--s12` / `--s16` |

The asymmetry around headings is deliberate: **more space above a heading than below it**, so
the heading binds to the content it introduces rather than floating between two blocks.

### 2.6 Icons

`lucide-react`, already a dependency. Fixed set, one meaning each, always `aria-hidden="true"`
with adjacent text:

`Shield` privacy · `AlertTriangle` caution · `AlertOctagon` critical · `Info` note ·
`ShieldCheck` safe · `Trash2` deletion · `Download` export · `Award` certificates ·
`Users` youth safety · `FileText` terms · `Cookie` tracking · `Clock` retention ·
`Mail` contact · `Link` anchor · `ChevronRight` navigation

16px inline, 20px in callouts, 24px on hub cards. Never larger — a decorative icon on a legal
page reads as an attempt to soften something.

### 2.7 Motion

| Element | Motion | Duration |
|---|---|---|
| TOC active item | Background/colour fade | `--t-fast` |
| Anchor jump | `scroll-behavior: smooth` + `scroll-margin-top: --legal-anchor-offset` | — |
| Hub card hover | `translateY(-2px)` + `--sh-1` → `--sh-2` | `--t-fast` |
| Disclosure expand | Height + opacity | `--t-mid` |
| Anchor link icon | Opacity 0 → 1 on hover/focus | `--t-fast` |

**No entrance animations. No scroll-triggered reveals. No parallax.** Content that animates in
on a legal page implies it is being performed rather than stated. The one exception is the
mobile TOC disclosure, where the motion explains the spatial change.

All of it inside:

```css
@media (prefers-reduced-motion: reduce) {
  * { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
}
```

### 2.8 Responsive

| Breakpoint | Layout |
|---|---|
| ≥1180px | TOC rail + article, centred within `--content-max` |
| 1024–1180px | TOC rail + article, article shrinks first |
| 700–1024px | Single column, TOC as collapsed disclosure |
| <700px | Single column, `--s4` gutters, tables → stacked, sticky "On this page" button |

The existing stylesheet uses eight different breakpoint values. **The legal surface uses only
`700px`, `1024px`, and `1180px`**, all of which already exist, so no new media-query values
enter the system.

---

## Part 3 — Page designs

### 3.1 Legal hub — `/legal`

**Purpose.** One place that answers "what do you do with my information?" and routes to the
document that answers the specific question.

**Layout.** Single column, `--legal-measure-wide`, no TOC.

```
┌────────────────────────────────────────────────────────┐
│  🛡  Privacy & Safety                                  │
│  Everything about how WeVolunteer handles information  │
│  about you — and how to get answers.                   │
│                                                        │
│  ┌──────────────────────────────────────────────────┐  │
│  │ ⚠ Some of this isn't finished yet                │  │  ← only when
│  │ Bay Ridge Schools hasn't supplied 2 of 3 details.│  │    incomplete
│  │ [See what's missing →]                           │  │
│  └──────────────────────────────────────────────────┘  │
│                                                        │
│  Start here                                            │
│  ┌────────────────────┐ ┌────────────────────┐        │
│  │ 🛡 Privacy         │ │ 👥 Staying safe    │        │
│  │ What we collect,   │ │ The rules, and how │        │
│  │ who sees it.       │ │ to report a problem│        │
│  │ 6 min →            │ │ 4 min →            │        │
│  └────────────────────┘ └────────────────────┘        │
│                                                        │
│  Your choices                                          │
│  ⬇ Get a copy of my data          →                   │
│  🗑 Delete my account              →                   │
│  👁 Who can see my profile         →                   │
│                                                        │
│  The details                                           │
│  📄 Terms  ·  🍪 Cookies  ·  🏅 Certificates          │
│  ⏱ How hours work  ·  💬 Community Guidelines         │
│                                                        │
│  ┌──────────────────────────────────────────────────┐  │
│  │ ✉ Still have a question?                         │  │
│  │ privacy@… — we reply within 10 business days.    │  │
│  │ Emergency? Call 911. NJ: 1-877-NJ-ABUSE.         │  │
│  └──────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────┘
```

**Section order, and why.** *Start here* (the two documents most people need) → *Your choices*
(**actions, not reading** — most visitors arrive wanting to *do* something) → *The details*
(reference) → *Contact*.

Putting actions second is the key decision. A conventional legal index lists documents; a
person arriving here usually wants to delete their account or download their data, and making
them find that inside a policy is a hostile pattern.

**States.** *Loading* — skeleton cards, no spinner. *Incomplete* — the banner, only when
`privacyNoticeComplete()` is false. *Error* — the hub is static; it cannot fail.

---

### 3.2 Privacy Policy — `/privacy`

**Layout.** `LegalLayout` with TOC.

**Section order:**
1. Title + lead + `PolicyMeta`
2. `Callout caution` — incompleteness, **when incomplete, above everything else**
3. `SummaryCard` — the short version
4. Who is responsible
5. What we collect (*given by you* / *created as you use it* / *deliberately not collected*)
6. Who can see it — by role
7. How events choose volunteers (Auto Select)
8. What we don't do
9. How long we keep things — `PolicyTable`
10. Your choices — `PolicyTable`, action-oriented
11. For parents and guardians
12. Students under 13
13. Other companies involved
14. Security
15. If there's a breach
16. Changes
17. `ContactCard`

**Two ordering decisions worth defending.** "Deliberately not collected" sits inside *What we
collect*, not in *What we don't do* — a reader worried about their home address should find
the answer where they are already looking. And *Your choices* precedes *For parents*, because
the student is the primary reader and their own agency should not come after someone else's.

**Interaction.** Scroll-spy TOC · anchor links on `h2` hover/focus · `Download as PDF` in the
meta row (districts file these) · every internal reference is a real link.

**States.** *Loading* — skeleton matching the final layout, so nothing shifts. *Incomplete* —
`DecisionCard` per missing value, plus the top callout. *Print* — TOC hidden, callouts flatten
to bordered blocks, link URLs printed after their text via `content: attr(href)`, page breaks
avoided inside callouts.

---

### 3.3 Terms of Service — `/legal/terms`

Same layout. The design problem is different: this is the longest document and the least
voluntarily read.

**Devices used:**
- **Numbered sections** (1, 2, 3…). Terms get cited; citation needs numbers.
- **A plain-language line under each heading**, `--ink-2`, e.g. under *5. Volunteer hours are a
  record, not a promise* → "What our hours do and don't guarantee."
- **`Callout important` on the three sections that actually matter to a student:** hours are
  not guaranteed, events happen in the real world, account termination.
- **A `SummaryCard` that is honest about its own status**: "This summary isn't the agreement —
  the numbered sections are. It's here so you know what's in them."

That last disclaimer prevents the summary from becoming a misrepresentation, which is a real
risk with plain-language summaries of binding terms.

---

### 3.4 Data deletion — `/legal/deletion`

**The most consequential page in the set.** Read by someone about to do something irreversible,
usually while upset.

**Layout.** Single column, no TOC — this page is read start to finish, and a TOC invites
skipping to the button.

**Section order:**
1. Title: **What happens when you delete your account**
2. `Callout critical` — "This can't be undone. Please read what stays."
3. **What gets deleted** — green check list
4. **What stays, and why** — each item a `Callout` with its reason
5. **Your certificates keep your full name** — its own `Callout critical`, its own heading
6. **Download your data first** — `Callout important` with an inline action button
7. Timing
8. Organizers
9. Guardians
10. `ContactCard` — "Ask before you delete, not after"
11. *Then, last:* `[ Go to delete account ]`

**The action is at the bottom, and that is the whole design.** The reader must pass every
consequence to reach the button. Not a dark pattern — a proportionate one, since the action is
irreversible and the alternative (button at top) means nobody reads any of it.

**Interaction.** The final button is a `btn-danger-solid` link to Settings, not the deletion
itself — this page informs, Settings acts. No confirmation on this page at all.

---

### 3.5 Youth safety — `/legal/safety`

**The one page that may be opened in a crisis.** Everything follows from that.

**Layout.** Single column. **Emergency contacts are pinned at the top and repeated at the
bottom** — not in a TOC, not behind a link.

```
┌────────────────────────────────────────────────┐
│  ┌──────────────────────────────────────────┐  │
│  │ 🚨 In danger right now? Call 911         │  │
│  │ NJ child abuse: 1-877-NJ-ABUSE           │  │
│  │ Crisis: call or text 988                 │  │
│  └──────────────────────────────────────────┘  │
│                                                │
│  Staying safe on WeVolunteer                   │
│                                                │
│  [ I'm a student ] [ Parent ] [ Organizer ]    │  ← tabs
└────────────────────────────────────────────────┘
```

**Audience tabs, not one long document.** A student in trouble must not scroll past the
organizer rules. Tabs are real routes (`?for=student`) so they are linkable and
back-button-correct, and **all content stays in the DOM** so browser find-in-page works and
the print stylesheet renders everything.

**The crisis banner is `--legal-critical-*` and never dismissible.** Phone numbers are `tel:`
links, minimum 44×44px touch targets.

**Interaction.** A persistent `Report a problem` button, bottom-right, above the mobile nav.

---

### 3.6 Certificate verification — `/verify` and `/legal/certificates`

Two surfaces, split deliberately.

**`/verify` — the tool.** Someone in a school office with a code in their hand. Nothing but the
job:

```
┌────────────────────────────────────────┐
│         🏅 Check a certificate         │
│                                        │
│   ┌──────────────────────────────┐     │
│   │  WEV-____-____               │     │
│   └──────────────────────────────┘     │
│         [ Check certificate ]          │
│                                        │
│   No account needed.                   │
│   [ What does this check prove? → ]    │
└────────────────────────────────────────┘
```

Auto-uppercasing, auto-hyphenating input, `inputmode="text"`, `autocomplete="off"`.

**States — all four designed, because this page is mostly its states:**

- *Valid* — `Callout safe`, name / event / organizer / hours / date, and **the disclaimer
  directly beneath**: "This confirms WeVolunteer's records. It doesn't mean we witnessed the
  volunteering — attendance was recorded by the organizer."
- *Not found* — `Callout caution`, and it must **not** say "invalid." It says: "We couldn't find
  a certificate with that code," then the three possible reasons (typo, expired, not genuine),
  then how to report a suspected forgery. A verifier being told "invalid" will accuse a student.
- *Rate limited* — the existing message is already right: "Too many certificate checks from
  this device. **This is not a verdict on the certificate.**" Keep that second sentence
  verbatim; it prevents a rate limit being read as a fraud signal.
- *Server error* — "Something went wrong on our end. The certificate is probably fine — try
  again shortly."

**`/legal/certificates` — the explainer.** Standard `LegalLayout`, dual audience, with the
verifier's section first.

---

## Part 4 — What this must not become

Recorded so the intent survives the first redesign:

- **No hero illustration.** A cartoon padlock on a page about a minor's data is the visual
  equivalent of "your call is important to us."
- **No trust badges.** They are decoration unless they represent a real audit.
- **No accordions on the privacy policy.** Collapsing disclosure by default is the oldest dark
  pattern in privacy design. Everything is visible; the TOC provides the navigation.
- **No cookie banner.** There is nothing to consent to (see policy #5), and a fake one teaches
  people to click through real ones.
- **No marketing voice.** "We take your privacy seriously" is what organisations say instead of
  saying what they do.
- **No progressive disclosure of bad news.** If deletion keeps your name on a certificate, that
  sentence is at full size, in the flow, not behind "Learn more."
