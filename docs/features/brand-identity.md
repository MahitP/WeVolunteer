# Brand identity: the checkmark-W and the wordmark

What the WeVolunteer logo is, where each form of it is used, how it was derived
from the Identity Proposal (September 2026), and where the implementation departs
from that document on purpose. Written for whoever changes the logo next.

## 1. One source

Every drawing of the logo in the product comes from
`src/components/common/logoGeometry.js`:

| Export | What it is |
|---|---|
| `MARK_PATH` / `MARK_POINTS` | `M16 26 L33 78 L50 34 L67 78 L86 4`, stroked, bevel joins, butt caps |
| `MARK_STROKE` / `MARK_STROKE_SMALL` | 12.5, and 15.5 when the mark renders under 32px tall |
| `MARK_VIEWBOX` | `8 -3 86 89` |
| `TILE_RADIUS_RATIO` / `TILE_MARK_RATIO` | 0.2236 and 0.58 of the tile's side |
| `WORDMARK_*` | the wordmark: the mark's path as its W, plus the outlined letters |

Two components render it: `BrandMark` (the tile) and `Wordmark`. The recovery-code
image draws the tile on a canvas from the same exports.

Four static files cannot import JavaScript and carry copies: `public/favicon.svg`,
`public/app-icon.svg`, `public/app-icon-maskable.svg` and `public/mark.svg`. The
brand colour is also written literally in `server/email.js` and
`src/utils/recoveryCodeExport.js`. **`src/logoAssets.test.jsx` reads every copy
back and fails if any point, weight, join, placement or hex has drifted.** Change
the source and the copies together, or the build goes red.

## 2. How the geometry was taken from the proposal

The proposal's text is outlined, so nothing was read off a screenshot. Its vector
content was extracted and measured:

- **The mark.** Every rendering of it in the document — cover, lockups,
  construction plate, colour tiles, scale ladder — is a single stroked four-segment
  path. Normalised by its stroke weight, all of them land on the five published
  points exactly, with bevel joins and butt caps.
- **The letters.** The Typography plate's "WeVolunteer" (Familjen Grotesk SemiBold,
  -0.038em) was extracted as outlines and converted into the mark's coordinate
  space. The product loads no Familjen Grotesk: the letters are paths. Re-rendered
  from the committed string, they differ from the plate's own glyphs by 0.03% of
  their pixels, all on anti-aliased edges.
- **The tile.** Corner radius measured 0.208–0.234 of the side across the
  proposal's tiles, which agrees with its `WvTile` value of 0.2236 once Quartz's
  curve approximation is allowed for.

## 3. The wordmark

The proposal sets the name in type and says plainly that there is no custom
lettering yet. It names the next step as redrawing the wordmark's W "to the
symbol's skeleton". The product uses that redrawn wordmark, because a tile
beside the typeset name would print the W twice.

- **The W is `MARK_PATH`, unchanged.** Same five points, same numbers.
- **Its weight is the typeface's, not the symbol's: 10 units.** The plate's W has
  a 4.554pt stem at a 23.87pt cap height, which is 9.92 units at the mark's
  52-unit cap. At 12.5 the W is visibly heavier than every letter after it and
  reads as a logo stuck on the front of a word.
- **The spacing is the typeface's.** The narrowest gap between the W and the "e",
  across the e's height, is held at the plate's 2.73pt (5.95 units). The
  overshooting stroke rises over the e, as it must.

## 4. Where each form is used

| Surface | Form | Why |
|---|---|---|
| App sidebar, desktop | Wordmark, 18px | There is room for the name |
| App sidebar, tablet rail (701–1024px) | Tile, 32px | A 68px rail cannot hold the name; the wordmark stays in the link, visually hidden, as its accessible name |
| App shell, phone | none | The shell has no brand slot under 701px, and none was added |
| Certificate verification topbar | Wordmark, 18px | |
| Invitation / public organization topbar | Wordmark, 18px | |
| Error experience | Wordmark, 20px | Often the only thing on screen that says whose page it is |
| Welcome | Tile, 64px | The proposal's sign-up screen: tile above the headline |
| Appeal screens | Tile, 32px | Decorative, above a form that names the product |
| Browser tab | `favicon.svg`, 15.5 stroke | Rasterised at 16–48px |
| Manifest | `app-icon.svg`, `app-icon-maskable.svg` | Full weight; the maskable one is full-bleed and inside the 0.4 safe zone (0.365) |
| Safari pinned tab | `mark.svg` | A mask icon is a silhouette; the tiled favicon would pin as a square |
| Recovery-code image | Tile, drawn on canvas | Must work offline |
| Email header | The name as bold text, Forest | See `docs/EMAIL_BRANDING.md`: an email cannot reliably carry a drawing |

## 5. Colour

- **Forest `#0f5a3a`** is the mark, the tile and the wordmark on light surfaces:
  `--brand-forest`. White on it, and it on white, are both 8.26:1.
- **The wordmark goes white in dark mode** (17.26:1 on the dark surface). Forest
  there is 2.09–2.32:1. The proposal's dark-mode green, Signal `#3FA46E`, is "for
  text and links only. Never the mark", so the mark goes monochrome, not a lighter
  green.
- **The tile does not change with the theme.** Its edge against the dark surface is
  2.09:1, as in the proposal's own dark sidebar. The white mark inside it is 8.26:1.
- **Buttons and links are unchanged.** They still read `--brand` (`#0f6b45`). The
  proposal also moves primary buttons to Forest. That is an interface change, not a
  logo change, and it has not been made.

## 6. Deliberate departures from the proposal

1. **`MARK_VIEWBOX` is `8 -3 86 89`, not the drop-in's `8 -3 85 89`.** At the
   small-size weight the overshooting terminal reaches x = 93.51. The drop-in box
   would have clipped half a unit off the tip.
2. **Small-size weight follows the rule, not the illustrations.** The text and the
   drop-in code both say 15.5 below 32px. The Scale plate's drawings instead grade
   the weight (13.5 at a 40px tile, 14.5 at 24px, 15.5 at 16px). The written rule
   is implemented.
3. **Mark size in the tile follows the drop-in code (0.58), not the illustrations.**
   The Scale plate draws the mark at about 0.605 of the tile.
4. **The wordmark W is redrawn** (§3). The proposal defers that to a second phase.
5. **No Familjen Grotesk is loaded.** The letters are outlines. The interface keeps
   Bricolage Grotesque and Public Sans.

## 7. What is not done

- **The horizontal lockup** (tile beside the typeset name), which the proposal lists
  as primary for the sidebar, login, email header and certificates. It is replaced
  by the wordmark wherever the name is shown.
- The certificate seal, Welly's second-V mark, the flat-cut icon set and the
  draw-on animation.
- No raster icons: no `apple-touch-icon`, no PNG manifest icons, no Open Graph
  image (see the note in `index.html`).
- A trademark search. The proposal asks for one before anything is printed.
