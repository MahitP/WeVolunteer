# Brand motion: the mark's own gesture

What shipped of the WeVolunteer Motion System (frozen, September 2026), where it
is attached, what was deliberately left alone, and which numbers changed when the
frozen design met the real wordmark. The design itself is not restated here — it
lives in the identity project's `WEVOLUNTEER_MOTION_SYSTEM.md`, with
`MOTION-GUIDE.md` (intent) and `MOTION-HANDOFF.md` (integration detail).

Companion: [`brand-identity.md`](brand-identity.md), which owns the geometry this
animates.

## 1. What the motion is

One idea: **the mark is a single unbroken stroke, and the motion is that stroke
given a tempo.** The pen falls fast, climbs gathered, rests briefly at each foot
of the W, takes the overreach slowest, and as that last arm climbs it tugs the
whole mark 1.7 units along its own axis before settling. Nothing assembles,
nothing bounces, nothing is added to the drawing.

Seven behaviours, three curves, seven durations, one 80ms touchdown constant.
**Every one rests as the complete locked logo**, so a cancelled, blocked or
disabled animation degrades to the static brand rather than to nothing.

## 2. Files

| File | What it is |
| --- | --- |
| `src/components/common/wvMotion.css` | The canonical stylesheet: every keyframe, curve, duration and class. Imported once, in `src/main.jsx`, after `index.css`. |
| `src/components/common/brandMotion.js` | The `motion` vocabulary, the normalised path lengths, the success path split, and the 32px floor. No animation lives here. |
| `src/components/common/BrandMark.jsx` | The tile, with `motion`. |
| `src/components/common/Wordmark.jsx` | The lockup, with `motion`, its per-instance clip and the reveal rect. |
| `src/wvMotionStyles.test.js` | Guards reduced motion and the frozen inventory. |
| `src/logoAssets.test.jsx` | Extended with the animated-geometry guards. |

Deliberately **not** in `index.css`: that file is the application's styling
layer; this is the mark's, and it travels with the geometry it animates.

## 3. The `motion` prop

`'signature' | 'lockup' | 'loader' | 'micro' | 'success' | 'none'`, default
`'none'`. It selects class names and path structure. It never changes geometry,
colour or size.

| Value | `BrandMark` | `Wordmark` |
| --- | --- | --- |
| `signature` | mark draws, pulls, releases; loops (3600ms) | → `none` |
| `lockup` | the lockup's W draw, one shot (4000ms) | the full entrance: W draws, then the angled edge reveals the lettering |
| `loader` | ghost mark + one travelling segment, loops (2200ms) | → `none` |
| `micro` | one 560ms pass on the parent's hover/focus | same, over the wordmark's W |
| `success` | body + tick split; the overreach completes (900ms) | → `none` |
| `none` | the static locked mark | the static locked lockup |

Three rules the components enforce rather than document:

- **Nothing animates below 32px of rendered mark.** `markStrokeFor()` thickens the
  stroke to 15.5 below that, so a smaller animated mark would animate *different
  geometry* than the frozen 12.5 the dash values were solved against. The default
  32px tile draws an 18.6px mark and therefore never animates; only `size="lg"`
  does. A refused behaviour renders the static mark.
- **The rename branch is a no-op.** `Wordmark` renders text when `APP_NAME` is not
  "WeVolunteer"; `motion` cannot animate a `<span>` and does not try.
- **Every animated lockup gets its own `clipPath` id** (`useId`). Ids are
  document-global; sharing one makes instances animate in lockstep. Static
  lockups use no clip at all.

`motion="micro"` additionally needs the interactive ancestor to carry `.wv-micro`
— the pass is a gap painted in the surface colour, and only that ancestor knows
which surface it sits on.

### The micro-pass is fired, not held

**A defect found in integration, and the one change made on the surface side.**
The stylesheet offers three triggers: `:hover`, `:focus-visible` and
`[data-wv-fire]`. The first two are *states*, and the pass is a 560ms one-shot.
A pointer that rests on the link — or a keyboard focus that stays put, which is
the normal case — outlives its own animation, and when the animation ends the
comet keeps `opacity: 1` while its dash offset returns to 0. That paints a
static 52-unit gap across the first arm of the W: a bite out of the mark for as
long as the reader hovers or stays focused. Observed in the running application
and present in the reference lab's own demo.

It contradicts the system's own rule — the mark is always full strength, and
every behaviour rests as the complete mark — so it is an implementation defect,
not a design question. `useBrandMicroPass` fixes it without changing anything
frozen: no keyframe, curve, duration, dash value or colour. The element carries
`.wv-micro` and `[data-wv-fire]` **for the length of one pass** and then stops,
so its resting state is the complete mark again. Verified on the real sidebar
link: the class is added and removed 561ms apart, and the link rests as plain
`brand` while still focused.

## 4. Where it is attached

| Surface | Behaviour | Trigger |
| --- | --- | --- |
| App shell sidebar brand link (`src/App.jsx`) | micro-pass | hover / `:focus-visible` |
| Welcome (`src/views/Welcome.jsx`) | signature, on the tile it already showed | first visit per browser session |
| OAuth callback (`src/views/OAuthCallback.jsx`) | loader, replacing `.auth-spinner` | while the provider round-trip completes |

Welcome's guard is `sessionStorage`, not the app's session model: the front door
is signed out, so there is no account to hang a preference on, and a new tab is
correctly a new first impression. Where storage is unavailable the mark renders
static rather than animating on every mount.

## 5. What was deliberately not done

- **Empty states keep their icons.** `EmptyState`'s lucide icons say something
  about the empty thing — a calendar, a roster, a shield. Replacing that with the
  brand mark would swap meaning for branding. Behaviour G (idle) stays available
  in the stylesheet and unapplied. This is a product decision, not an omission.
- **The success beat is not attached to anything yet**, and that is a finding
  rather than a preference. Of the three approved categories:
  - *hours credited* — the real transitions (`EventAttendance`'s save and
    close-out) confirm with a **toast**, and the frozen system excludes toasts
    ("the system is for the mark, not for UI chrome"). The inline banner beside
    them is a persistent state, not a completion, so animating it would replay
    the beat on every visit to a closed-out event.
  - *shift joined* — a volunteer **applies**; acceptance is the organizer's act
    and reaches the volunteer as status or a notification. There is no moment in
    the volunteer's own flow that the UI treats as "you joined".
  - *certificate earned* — `CertificateView` is a viewer of an existing
    certificate. There is no "just earned" transition to fire on.
  **Prerequisite for any of them:** an inline, transition-scoped confirmation
  element, plus a tile-less inline mark (today `BrandMark` always draws its tile,
  and the 32px floor makes that tile 64px — too large for a two-line alert).
  Both are product/component decisions, not motion ones.
- **The return (behaviour C) ships unused.** `.wv-ret-*` is in the stylesheet so
  that the first real overlay dismissal uses the frozen sequencing — wordmark
  out, a 120ms dead stop, then the W — instead of inventing one. No surface
  exists; none was invented to justify it.
- **The public organization page stays static.** It renders the wordmark in an
  18px topbar beside a sub-label. That is chrome, not a hero; a four-second
  entrance there would be a small performance on a page whose subject is the
  club, not us.
- **The ~60 `LoadingSkeleton` sites are untouched**, as are the inline
  location/weather spinners. Shape-preserving skeletons are better than a brand
  spinner for those waits.

## 6. Reduced motion

The application already has both layers, and the stylesheet uses both rather than
introducing a third preference:

| Trigger | Source |
| --- | --- |
| `@media (prefers-reduced-motion: reduce)` | the operating system |
| `:root[data-motion='reduce']` | the reader's own setting, written pre-paint by `public/a11y-prefs.js`, owned by `src/hooks/useAccessibilityPreferences.js` |

`motion: 'system'` needs no rule of its own: it means "whatever the OS says", and
the media query is what the OS says.

Both resolve every behaviour to its **completed** state — never a partial paint.
That is not the same as stopping the animation: `index.css` already crushes
animations to 0.001ms under the attribute, and the signature's final keyframe is
zero-length and transparent, so an instantly-finished loop would rest on nothing
and the logo would disappear for exactly the reader who asked for less movement.
`src/wvMotionStyles.test.js` fails the build if an animated `.wv-*` selector is
missing from either block.

One honest difference between the two triggers: under the OS query the signature
gets the frozen 240ms opacity rise (`wv-rm-in`); under the attribute it simply
appears complete, because `index.css`'s blanket `[data-motion='reduce']` rule
crushes every animation to 0.001ms anyway. Both satisfy the rule that matters —
no geometry moves and the mark rests complete.

## 7. The wipe, re-measured against the real wordmark

The frozen lab solved the reveal against a Bricolage Grotesque stand-in. The real
wordmark is outlined paths (`WORDMARK_LETTERS_PATH`), in a wider viewBox, with a
lighter W. **Two values changed, and nothing else.**

| Quantity | Lab (stand-in) | Shipped (real) |
| --- | --- | --- |
| Lockup viewBox | `8 -3 378 89` | `11 2.5 421.5 77.5` |
| W stroke in the lockup | 12.5 | **10** (`WORDMARK_W_STROKE`) |
| Reveal edge at rest | 76 | **86** |
| Run (`--wv-wipe-run`) | 348 | **365** |
| Rect | `x=-524 width=600` | `x=-514 width=600` |

Unchanged: the −14.4° tilt, every duration, every dash value, the pull, the
touchdown, the sequencing and the dead-stop beat. `pathLength` normalisation is
independent of stroke width, so the gait transfers verbatim.

**Why 76 does not transplant, and why the audit's proposed 92.5 is wrong.** The
edge is skewed about the viewBox origin, so its position varies with height:

```
X(y) = R + travel + tan(14.4°)·minY − tan(14.4°)·y      (minY = 2.5)
```

Only the wordmark is clipped — the W is outside the clip — so the resting edge is
bounded by the letters alone. Before the reveal the word is **held at
translateX(−9)**, which puts the "e"'s leftmost ink at (85.17, 50.48) minus nine
units. Hiding it requires **R < 88.49**. The proposed 92.5 fails that by four
units: it would park a sliver of the "e" beside the W for the first 1.9 seconds
of the entrance — the same defect the original 93.5 produced in the lab. R = 86
keeps 2.49 units of clearance and still starts the edge inside the arm. The run
must clear the letters' right extent (432.16 at y 46.6), which needs > 357.48;
365 is used, with 7.5 units of margin.

Both numbers are checked by `logoAssets.test.jsx` and scrubbed in the running
application (§9).

## 8. Raster assets the team still needs to produce

Not motion work. The audit surfaced it: `site.webmanifest` ships **SVG only**, and
several consumers cannot use SVG. **None of these files exist today** — this is a
request, not an inventory. The canonical geometry must not be altered to make
them; every one is a render of an existing source file.

| # | File | Source | Size | Background | Transparency | Light/dark | Destination |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `icon-192.png` | `public/app-icon.svg` | 192×192 | Forest `#0f5a3a` tile, radius 0.2236 of the side | No | One file, both | `site.webmanifest`, `purpose: any` |
| 2 | `icon-512.png` | `public/app-icon.svg` | 512×512 | as above | No | One file, both | `site.webmanifest`, `purpose: any` |
| 3 | `icon-512-maskable.png` | `public/app-icon-maskable.svg` | 512×512 | Forest, **full bleed, no radius** | No | One file, both | `site.webmanifest`, `purpose: maskable`. Mark stays inside the 0.4-radius safe circle (it currently reaches 0.37). |
| 4 | `apple-touch-icon.png` | `public/app-icon.svg` | 180×180 | Forest, **no transparency and no radius** — iOS masks and composites its own | No | One file, both | `<link rel="apple-touch-icon">` in `index.html` |
| 5 | `favicon-32.png` | `public/favicon.svg` | 32×32 | Forest tile | No | One file, both | `.ico` member, legacy browsers |
| 6 | `favicon-16.png` | `public/favicon.svg` | 16×16 | Forest tile | No | One file, both | `.ico` member |
| 7 | `favicon.ico` | 5 + 6 | 16 + 32 in one file | Forest tile | No | One file, both | `/favicon.ico`, requested by browsers that ignore the SVG |
| 8 | `email-mark-96.png` | `public/mark.svg` | 96×96 (2× for a 48px slot) | **White**, flattened — email clients do not composite reliably | No | **Two files**: Forest mark on white, and white mark on Forest for dark-mode clients | `server/email.js`, only if the team decides to host it; see `docs/EMAIL_BRANDING.md` for why the header is text today |

Every one of 1–7 must preserve the locked geometry exactly: path
`M16 26 L33 78 L50 34 L67 78 L86 4`, bevel joins, butt caps, miter limit 1, mark
box 0.58 of the tile, and the small-size stroke rule (15.5 below 32px, which is
why 5 and 6 come from `favicon.svg` and not from `app-icon.svg`).

**Do not animate any of them.** The favicon and app icon are static, always.

## 9. Verification

Observed in the running application unless stated otherwise. Full matrix in the
session report.

**Verified (runtime):** sidebar micro-pass firing once on keyboard focus and
resting complete; Welcome's signature (`wv-hero` 3600ms + `wv-pull`, stroke 12.5,
`pathLength` normalised) and its once-per-session guard; the OAuth loader on its
real route (`wv-travel` 2200ms, ghost 0.16, beside "Completing sign-in…" and its
live region); the entrance scrubbed against the real wordmark — nothing painted at
t=0, opacity 1 at exactly 80ms, **zero letter ink through the whole hold to
1899ms**, reveal complete at 2520ms, word settled at 2600ms; the pull peaking at
exactly (0.423, −1.647) at 1550ms and home by 1770ms; the return's dead stop
(620/680/739ms identical, W whole, `dashoffset` never leaving 0); two lockups with
unique clip ids scrubbing independently; frozen paint after cancelling every
animation; the reader's `data-motion='reduce'` setting holding the mark complete
with zero animations; both themes and a theme switch mid-animation; 375/390/430/
768/1280 with no overflow, no clipping and no console errors.

**Verified (OS reduced motion, infinite behaviours):** `npm run a11y` passes 64/64,
and `a11y/sweep.media.spec.js`'s "nothing animates forever under
prefers-reduced-motion" launches Chromium with `reducedMotion: 'reduce'`, walks
every route **the route table declares** and asserts no element animates
infinitely. That exercises the signature on its real route.

**It does NOT exercise the loader on its real route**, and an earlier revision of
this paragraph said it did. `a11y/harness/routes.mjs` derives the walk from
`src/routes/index.jsx` — deliberately, so a route added tomorrow is swept the day
it is added rather than the day somebody remembers the harness. `/oauth/callback`
is **not in that table and must never be**: it is handled above the session gate
with `/reset-password` so it still works while a stale session is in memory,
which is what keeps account recovery working for the people who need it. A manual
entry in the harness would reintroduce exactly the hand-maintained second list
the derivation exists to avoid.

So the loader's reduced-motion behaviour is source-verified like the one-shots,
not swept. The route's own logic has nine passing cases in
`src/App.authRoutes.test.jsx`; what is unswept is the rendered accessibility of
that one transient screen.

**Source-verified:** the OS block's effect on the *one-shot* behaviours (the lockup
entrance and success), since that sweep only fails on infinite animations; its 11
rules were read back from the live CSSOM, so they survive the bundler. Also the
return and idle behaviours, and the success wiring, which no product surface
renders.

**Not verified:** browsers other than the Chromium used here; real devices;
performance profiling.

### One observed minification effect

The CSS minifier rewrites the dash literals `225.4484` → `225.448` and
`173.4484` → `173.448` in the built stylesheet — 0.0004 mark units, 0.0002% of
the path. The `pathLength="225.4484"` and `76.4003` attributes are markup, not
CSS, and survive exactly. All 15 keyframes, all three curves, both reduced-motion
blocks (10 attribute rules, 8 media blocks across the app) and `--wv-wipe-run:
365px` are present in `dist/assets/index-*.css`.
