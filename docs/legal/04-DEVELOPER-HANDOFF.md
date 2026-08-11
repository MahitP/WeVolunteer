# Developer handoff — the legal surface

**Stack:** React 19 · `react-router-dom` 7 · plain CSS with custom properties in
`src/index.css` · `lucide-react` icons · vitest (`client` project, jsdom)

**Read first:** [`02-DESIGN-SYSTEM.md`](02-DESIGN-SYSTEM.md) for tokens and page designs,
[`03-ACCESSIBILITY-REPORT.md`](03-ACCESSIBILITY-REPORT.md) for the fixes folded in below.

---

## 0. Before you write a component

Three build-failing guards in `src/` will reject work that ignores them. They are not lint
warnings; they fail `npm test`.

| Guard | Rule | Consequence here |
|---|---|---|
| `noHardcodedColors.test.js` | No colour literal or colour function outside `index.css` | Every colour comes from a token. **Add tokens to `index.css` first**, then use them |
| `tokens.test.js` | Every `var(--x)` must be defined in `index.css`. No allowlist | Adding `--legal-*` to a component before defining it fails the build |
| `noDanglingClasses.test.js` | No class without a rule, no rule without a reference | Do not add speculative classes; do not leave `.legal-*` rules unused |

**Order of work: tokens → CSS rules → components.** Any other order fails the suite mid-way.

Two more from `docs/ENGINEERING_GUIDE.md` that apply:
- Every `NAV` entry must declare `requiredCap` or a non-empty `requiredCapAny` — a boot-time
  loop throws otherwise. The legal routes are **public**, so they go in `PUBLIC_ROUTES`, not
  `NAV`.
- `PUBLIC_ROUTES` is the source of truth for the signed-out route test, which is *derived* from
  it. Adding a route there without rendering it leaves it unreachable — see the comment at
  `App.jsx:576`.

---

## 1. Tokens to add

Append to `:root` in `src/index.css`. Full list in
[`02-DESIGN-SYSTEM.md` §2.1](02-DESIGN-SYSTEM.md). No dark-mode additions are required for the
callout tones — verified in §2.1.

**One token change that is not additive**, from finding A11Y-1:

```css
:root {
  /* Was var(--rule-strong) (#bdc2cd) = 1.74:1 on --surface, failing WCAG 1.4.11's
     3:1 for UI component boundaries. Split from --rule-strong deliberately: that
     token's subtlety is correct for decorative separators and has other consumers.
     A field boundary is a UI component and has to be seeable. */
  --input-border: #8c95a1;
}
[data-theme='dark'] {
  --input-border: rgba(199, 208, 203, 0.42);
}
```

**Verify the resulting ratios rather than trusting these values** — dark-mode compositing makes
them easy to get slightly wrong. Target ≥3:1 against `--surface` in both themes.

---

## 2. Routes

Add to `SIGNED_OUT_ROUTES` / `PUBLIC_ROUTES` in `src/routes/index.jsx`, lazy-loaded to match
every other view.

| Path | Component | Notes |
|---|---|---|
| `/legal` | `LegalHub` | New |
| `/privacy` | `PrivacyNotice` | **Exists.** Refactor onto `LegalLayout`; do not rewrite the content logic |
| `/legal/terms` | `LegalDocument` | |
| `/legal/deletion` | `LegalDocument` | No TOC |
| `/legal/safety` | `YouthSafety` | Tabs |
| `/legal/certificates` | `LegalDocument` | |
| `/legal/cookies` | `LegalDocument` | |
| `/legal/community` | `LegalDocument` | |
| `/legal/records` | `LegalDocument` | Anchor `#auto-select` is linked from the application form |
| `/verify` | `CertificateVerification` | **Exists.** Restyle only |

All public — reachable signed out, for the same reason `/privacy` already is: someone deciding
whether to sign up has to read them first, which is exactly when they have no account.

**Redirects to keep old links alive:** `/legal/privacy` → `/privacy`.

---

## 3. Components

### `<LegalLayout>`

```jsx
LegalLayout.propTypes = {
  title:       string.isRequired,
  lead:        string,
  updated:     string.isRequired,   // ISO date
  version:     string.isRequired,
  readingTime: number,              // minutes; omit to compute from children
  toc:         bool,                // default true
  children:    node.isRequired,
}
```

Renders breadcrumb → `<h1>` → lead → `<PolicyMeta>` → optional `<TableOfContents>` rail →
`<article className="legal-prose">`.

- The TOC is built by walking rendered `h2[id]` nodes in an effect, **not** from a prop. A
  hand-maintained TOC drifts from the document within two edits.
- `<article>` gets `max-width: var(--legal-measure)`.
- Skip link targets the `<article>`, not the layout wrapper (A11Y-10).

### `<Callout>`

```jsx
Callout.propTypes = {
  tone:     oneOf(['note','important','caution','critical','safe']),  // default 'note'
  title:    string,     // omit to use the tone's default label
  children: node.isRequired,
}
```

| tone | icon | default title | tokens |
|---|---|---|---|
| `note` | `Info` | *(none)* | `--legal-note-*` |
| `important` | `Info` | Important | `--legal-important-*` |
| `caution` | `AlertTriangle` | Be careful | `--legal-caution-*` |
| `critical` | `AlertOctagon` | Read this | `--legal-critical-*` |
| `safe` | `ShieldCheck` | Good to know | `--legal-safe-*` |

**Rules that are load-bearing, not stylistic:**
- Icon is always `aria-hidden="true"`. The **visible text title carries the meaning.**
- **No `role="alert"` or `role="status"`** on static content (A11Y-2). These are `<section>`s
  with headings. Live-region roles are only for content that appears *after* load.
- Icon colour uses `--warn` / `--danger` / `--info` (5.2–6.1:1), never the border token.
- Dropping the visible title turns the decorative border into a 1.4.11 failure. Do not add a
  title-less variant.

### `<SummaryCard>`

```jsx
{ title: string /* default "The short version" */, children: node /* <ul> */ }
```
Brand tint, `--r-lg`, `--s5` padding. Placed immediately after `PolicyMeta`, before the first
`h2`. 4–6 items, one sentence each.

### `<TableOfContents>`

```jsx
{ headings: [{ id, text }], activeId: string }
```
- Scroll-spy via `IntersectionObserver` with `rootMargin: '-96px 0px -70% 0px'` so the active
  item changes at the right moment rather than at the viewport edge.
- Activating an entry **moves focus to the target heading** — give each `h2[id]`
  `tabIndex={-1}` and call `.focus()`. Scrolling alone tells a screen-reader user nothing
  changed (A11Y).
- `min-height: 44px` per entry (A11Y-11).
- Below 1024px, renders as `<details>` collapsed by default.

### `<PolicyTable>`

```jsx
{ caption: string.isRequired, stackBelow: number /* default 700 */, children: node }
```
Wrapper is `<div role="region" aria-label={caption} tabIndex={0} className="legal-table-scroll">`
— the `tabIndex` is what makes horizontal scrolling keyboard-reachable (A11Y-4). Below
`stackBelow`, two-column tables render as a definition list.

### `<DecisionCard>`

```jsx
{ label: string.isRequired, value: string, missingHint: string.isRequired, contactHref: string }
```
Generalises the existing `DistrictFact` in `PrivacyNotice.jsx`. **Keep its behaviour exactly** —
render the value when present, and a visible "Not yet provided" admission when absent. The
addition is `contactHref`, rendering an "Ask about this →" action, because a reader who hits an
unanswered question currently has nowhere to go.

### `<PolicyMeta>` · `<ContactCard>` · `<AnchorHeading>`

```jsx
PolicyMeta:    { updated: string, version: string, readingTime: number, archiveHref: string }
ContactCard:   { email: string, responseTime: string, emergency: bool }
AnchorHeading: { id: string, level: 2|3, children: node }
```
- `PolicyMeta` renders the date as `<time dateTime={updated}>` (A11Y-8).
- `AnchorHeading` shows its link icon on `:hover` **and `:focus-visible`** (A11Y-9), and sets
  `scroll-margin-top: var(--legal-anchor-offset)` (A11Y-6).
- `ContactCard` never renders a bare `mailto:` — always with the response-time commitment.

### `<YouthSafetyTabs>`

```jsx
{ audience: oneOf(['student','parent','organizer']) }  // from ?for= query param
```

**All three panels stay in the DOM**; inactive ones get `hidden` (A11Y-5). Unmounting breaks
find-in-page, the print stylesheet, and deep links.

Full tablist semantics: `role="tablist"` / `role="tab"` / `role="tabpanel"`, roving `tabindex`,
`←→` to switch, `aria-selected`, `aria-controls`.

**The crisis banner renders outside the tabs**, above them, always. It is never hidden, never
dismissible, and its `tel:` links are ≥44×44px.

---

## 4. Responsive

| Breakpoint | Behaviour |
|---|---|
| ≥1180px | TOC rail + article, centred in `--content-max` |
| 1024–1180px | Same; article shrinks first |
| 700–1024px | Single column; TOC → `<details>` |
| <700px | `--s4` gutters; tables stack; sticky "On this page" button |

Only `700px`, `1024px`, and `1180px` — all already present in `index.css`. **Do not introduce a
new breakpoint value**; the stylesheet already carries eight and does not need a ninth.

At 400% zoom the crisis banner must become static rather than sticky, or it consumes the
viewport. It stays first in the document.

---

## 5. Motion

| Element | Trigger | Animation | Duration | Easing |
|---|---|---|---|---|
| TOC active item | Scroll | Background + colour | `--t-fast` | token |
| Anchor jump | Activate | `scroll-behavior: smooth` | — | — |
| Hub card | Hover/focus | `translateY(-2px)`, `--sh-1`→`--sh-2` | `--t-fast` | token |
| Mobile TOC | Toggle | Height + opacity | `--t-mid` | token |
| Anchor icon | Hover/focus | Opacity 0→1 | `--t-fast` | token |

**No entrance animations, scroll reveals, or parallax.** Content that animates in on a legal
page implies it is being performed rather than stated.

Wrap everything in `@media (prefers-reduced-motion: reduce)` disabling `animation`,
`transition`, and `scroll-behavior`.

---

## 6. States

| State | Behaviour |
|---|---|
| **Loading** | Skeleton matching final layout so nothing shifts. Reuse `LoadingSkeleton` — it is eager in `App.jsx` and is what the Suspense fallbacks are made of |
| **Incomplete notice** | `privacyNoticeComplete()` false → `Callout caution` at top + a `DecisionCard` per missing value. **Already implemented; preserve the ordering** |
| **Error** | Legal pages are static and cannot fail. `/verify` is the only one with error states — see below |
| **Print** | TOC hidden; callouts flatten to bordered blocks; `a[href^="http"]::after { content: " (" attr(href) ")" }`; `break-inside: avoid` on callouts |
| **Offline** | Static content; no special handling |

### `/verify` states — the page is mostly its states

| State | Treatment |
|---|---|
| Idle | Code input, `autocomplete="off"`, auto-uppercase, auto-hyphenate `WEV-XXXX-XXXX` |
| Loading | Button → "Checking…", disabled, `aria-busy` |
| Valid | `Callout safe` + fields + **the disclaimer directly beneath** |
| Not found | `Callout caution`, `role="alert"`. **Never the word "invalid"** — see below |
| Rate limited | Keep the existing message verbatim, including "This is not a verdict on the certificate" |
| Server error | "Something went wrong on our end. The certificate is probably fine — try again shortly." |

**On "not found":** a verifier told a certificate is *invalid* will accuse a student of forgery.
The endpoint genuinely cannot distinguish a typo from an expired code from a forgery, so the
copy must not imply it can. Give the three possible reasons and a route to report a suspected
forgery.

---

## 7. Edge cases

| Case | Handling |
|---|---|
| `PRIVACY_CONTACT` unset | `DecisionCard` renders the visible admission. **Never** fall back to a plausible-looking default — see the reasoning in `src/config.js` |
| All config unset | Page renders, warning at top, three `DecisionCard`s. This is the default state and must stay coherent |
| Very long `[[DISTRICT_NAME]]` | Wraps; no truncation. Truncating the responsible party's name is not acceptable |
| Document with no `h2` | TOC hides itself rather than rendering empty |
| JS disabled | Content is server-rendered static markup; TOC and tabs degrade to anchor links |
| Deep link to a hidden tab panel | `?for=` selects the panel; all content present regardless |
| Certificate code pasted with spaces/lowercase | Normalise client-side before submit; server already uppercases |
| Screen reader on the incomplete warning | Announced in document order as a section — **not** as a live region |

---

## 8. Tests required

`docs/ENGINEERING_GUIDE.md` requires tests for any new endpoint, any auth/authz change, any boot guard, and any
security fix. These follow from that policy plus the guards.

**Client (`--project=client`)**
1. `tokens.test.js` and `noHardcodedColors.test.js` pass with the new tokens *(automatic —
   just do not break them)*
2. Every `legal-*` class has a rule and a reference *(`noDanglingClasses.test.js`)*
3. `PUBLIC_ROUTES` renders every legal route signed out — **derive from the constant**, do not
   restate the list (`App.jsx:576`)
4. `Callout` renders its visible title for every tone *(the accessibility guarantee)*
5. `TableOfContents` builds from rendered `h2[id]` and moves focus on activation
6. `YouthSafetyTabs` keeps all three panels in the DOM when one is selected
7. `DecisionCard` renders the missing-value admission when `value` is empty
8. `/verify` renders the correct copy for all five states, and **never the word "invalid"**

**Server**
9. Error-report redaction still strips emails/tokens and hashes the user *(closes R-14 — the
   privacy notice turns these into FTC §5 representations, so they need a regression test)*
10. Only event locations, never user coordinates, reach the geocoder *(R-08)*

**Suggested new guard**
11. A build-time assertion that the client bundle contains no third-party origin except the
    known allowlist. This is what would have caught the CARTO tile CDN (R-18) automatically.

---

## 9. Implementation order

1. **Tokens** into `index.css`, including the `--input-border` fix (A11Y-1)
2. **CSS rules** for `.legal-*`
3. **Primitives**: `Callout`, `PolicyMeta`, `AnchorHeading`, `ContactCard`
4. **`LegalLayout`** + `TableOfContents`
5. **Refactor `/privacy`** onto the layout — content logic unchanged. This is the proof the
   system works; if it fights the existing page, the system is wrong
6. **`LegalHub`**
7. Remaining documents as `LegalDocument` instances
8. **`/legal/safety`** with tabs
9. **Restyle `/verify`**
10. Tests throughout, not at the end

Steps 1–5 are one PR. Do not batch further — this touches `index.css`, which every screen reads.

---

## 10. Out of scope for this handoff, but required before launch

These are **code changes the legal analysis depends on**, not design work. Tracked in
[`00-COMPLIANCE-AND-RISK.md`](00-COMPLIANCE-AND-RISK.md).

| Change | Finding | Why the documents can't ship without it |
|---|---|---|
| Age gate at signup | R-01 | The Privacy Policy's under-13 section makes a claim the code must enforce |
| Certificate choice at deletion | R-02 | The Deletion Policy's "choose what happens" section describes it |
| Record organizer-agreement acceptance | R-04 | An unaccepted agreement has no legal effect |
| Constrain organizer→student messaging | R-03 | Youth Safety Rule 1 for adults describes a constraint the code does not enforce |
| Auto Select disclosure in the app | R-06 | |
| `PRIVACY_URL` default to `/privacy` | UX §1 | Consent currently does not render at all by default |
| Small-cell suppression in analytics | R-13 | |
| Click-to-load maps, then proxy tiles | R-18 | |
