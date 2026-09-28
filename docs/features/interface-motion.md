# Interface motion: what moves in the application, and why so little

The application's own motion: dialogs, toasts, buttons waiting on the server,
loading states, lists that filter, status changes and totals. The brand's motion
(the mark's own gesture) is a separate, frozen system; see
[`brand-motion.md`](brand-motion.md). This layer reuses it and never edits it.

The research behind the numbers (NN/g timing, WCAG 2.3.3, compositor-only
properties, the weak evidence for skeletons, and reward crowding-out) is the
design reference `App Motion Research` of 28 September 2026.

## 1. The rule: existing motion first

Where the app already had a motion for a kind of surface, that motion is reused
unchanged: `fade`, `rise`, `pop-up`, `fade-in`, `slide-up`, `spin`, `toastin` and
the `--t-fast` / `--t-mid` tokens in `index.css`, and `BrandMark`'s `loader` and
`success` behaviours. A new keyframe exists only where nothing did: the dialog
exit, the toast exit and the value tint. No new timing token was needed, so
`--t-slow` was not added.

Three limits hold everywhere:

- **Only `transform` and `opacity` move**, plus colour changes of 150ms or less.
  Never `backdrop-filter`, `box-shadow`, layout properties or custom
  properties, because those repaint on every frame.
- **Reduced motion stops everything.** Both triggers are honoured: the operating
  system (`prefers-reduced-motion`) and the reader's own setting
  (`data-motion='reduce'`). There is no value that animates against either.
- **Hours are a record, not a score.** No count-ups, confetti or streaks, and no
  suspense before a draw result.

## 2. Files

| File | What it is |
| --- | --- |
| `src/index.css`, section "Interface motion" (at the end) | Every new animated selector, and both reduced-motion blocks for them. |
| `src/utils/motion.js` | `prefersReducedMotion`, `useDelayedFlag`, `withViewTransition`, `rowTransitionStyle`, `useReplayClass`, `playDialogExit`, `installPageVisibilityFlag`. |
| `src/utils/confirmationBeat.js` | Decides when the success beat may play (§4). |
| `src/components/common/InlineConfirmation.jsx` | The inline confirmation the beat plays in. |
| `src/components/common/BusyButton.jsx` | A button waiting on the server. |
| `src/components/common/FullPageWait.jsx` | App start, session restore and route chunks. |
| `src/components/common/TintOnChange.jsx` | A number that changes in place. |
| `src/interfaceMotion.test.js` | Fails the build if an animated selector in the section is missing from either reduced-motion block. |

## 3. What moves, where

| Surface | Motion | Timing |
| --- | --- | --- |
| Floating menus, date picker, Welly mode panel | existing `rise` | `--t-fast` |
| Location results listbox | existing `pop-up` | `--t-fast` |
| Welly history drawer and backdrop | existing `fade` (a side drawer, so not `slide-up`) | `--t-mid` |
| Tab panels (event modal, organizer dashboard) | existing `.tabpanel` fade, now replayed on every switch (`key`) | `--t-fast` |
| Revealed inline content (audit record, Discover filters, draw result) | existing `fade-in` via `.reveal-in` / `.audit-full` | `--t-mid` |
| App start, session restore, route chunk | nothing for 1s, then `BrandMark motion="loader"` | loader 2200ms |
| Data export being generated | `BrandMark motion="loader"` (replaces a spinning clock) | loader 2200ms |
| `LoadingSkeleton` | laid out at once, invisible for the first 300ms | — |
| Buttons waiting on the server | label + `aria-busy` + disabled; `.spin` only after 300ms | 300ms threshold |
| Dialog exit | opacity only, on an inert copy after unmount | 160ms, `cubic-bezier(0.3,0,1,1)` |
| Toast exit | opacity only | 150ms |
| Discover, applicant order, notification filters | view transition: rows move, leavers fade, root still | 220ms / 150ms |
| Status pill change | colour | `--t-fast` |
| Hours totals, places left | colour tint on change, never on arrival | 150ms |
| Route change | existing `fade` on `<main>`; sidebar and header still | 160ms |
| Hours credited, application accepted, certificate issued | `BrandMark variant="inline" motion="success"`, once | 900ms (frozen) |

Looping animations (skeleton shimmer, spinners, the brand loader) pause while
the tab is hidden: `data-page-hidden` is set on the root.

## 4. The success beat, and why "first time" is decided in the browser

`brand-motion.md` §5 recorded the success beat as unattached because its three
moments had nowhere to attach to. Hours reached the volunteer as a toast, which
the brand system excludes, or as persistent status text, which would replay the
beat on every visit. `InlineConfirmation` is the missing element. It shows the
confirmation text every time, and it plays the mark beside the text only on the
first view of that confirmation.

"First view" cannot come from the data. `attendance` and `applications` store
only the state, with no decided-at timestamp. It is recorded per browser instead,
in `localStorage` under `wev-confirmations:<userId>`:

- An item plays the first time it is seen in its confirmed state, and is then
  marked seen.
- **The first page load of each kind plays nothing.** Everything already
  confirmed at that point is history, from before this shipped or from another
  device. Playing it all would fire a beat on every row of a volunteer's record
  at once.
- If storage is unavailable, nothing plays. Static is always correct.

The attach points are `LoggedHours` (a credited shift's hours pill),
`EventShiftsTab` (the "You're confirmed" pill) and `CertificateView` (an "Issued
…" line in the `no-print` header). The toast is unchanged and never carries the
beat.

`BrandMark variant="inline"` is the tile-less mark the doc named as the
prerequisite. It draws at exactly the 32px floor, so it animates the frozen
12.5 stroke, and it uses `currentColor` in the theme's brand green.

## 5. Deliberately not done

- **The 600ms mark draw and the "Full motion" switch** in the research
  specimens. The shipped beat is the frozen 900ms `success`. The switch would
  animate against a reader's setting.
- **The signature on first launch after sign-up.** No surface after sign-up
  shows a mark at 32px or larger, and inventing one to host the signature is
  the thing `brand-motion.md` §5 refuses to do.
- **The lockup on Welcome**, which shows the tile, not the lockup; **the return
  on sign-out**, since signing out has no screen of its own; and **the
  micro-pass beyond the sidebar**, since no other link shows the mark at 32px or
  larger.
- **Replaying a draw.** The draw result fades in, but there is no replay of a
  draw to link to. "Run Again" is a new draw, not a replay.
- **The shimmer → opacity pulse (B8)** is optional and conditional on a
  throttled-CPU profile showing paint on every frame. It has not been profiled,
  so the existing shimmer stays.
- **Rosters** have no filtering or reordering, so there is nothing for a view
  transition to animate.
- **The Welly model download** already has a native `<progress>` driven by the
  real bytes. A `transform: scaleX` bar would lose its semantics.

## 6. Verification

- `npm test`: the suite, including `interfaceMotion.test.js`, `motion.test.jsx`,
  `InlineConfirmation.test.jsx`, `BusyButton.test.jsx` and the toast clock in
  `Toasts.test.jsx`.
- `npm run a11y`: `a11y/harness/walk.mjs` treats `.full-page-wait` as a loading
  state, like a skeleton. Without that, the sweep measured the wait itself.
- In the running application: the route fade on `<main>` (160ms, sidebar
  still); the dialog exit (160ms `dialog-out` on an inert, `aria-hidden`, id-free
  copy, removed afterwards; none under `data-motion='reduce'`, with no transform
  animations running); the hours beat (no beat on the baseline visit, one beat
  for a newly confirmed row at 32px and stroke 12.5, none on revisit); the
  certificate line at 375px with no overflow.
- **Not verified:** the view-transition moves and the toast exit fade in a
  visible tab. The preview pane was hidden, so `document.hidden` suppressed
  both, which is the intended behaviour. Also unverified: browsers other than
  Chromium, real devices and performance profiling.
