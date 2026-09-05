import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Static guards on the notice slot: the two properties that are invisible in
 * review and obvious on screen.
 *
 * ── 1. The slot owns the spacing ──
 *
 * The location banner used to carry `margin-bottom: var(--s5)` itself. That
 * works while there is exactly one banner and fails the moment there are two
 * (their margins stack) or the moment anything wraps them (the wrapper keeps
 * the margin after the banner inside it has gone — the awkward empty strip
 * above the dashboard).
 *
 * `AppNotices.test.jsx` asserts the runtime half: no notice, no node. This
 * asserts the half a runtime test cannot see, because a stray `margin-bottom`
 * on `.app-notice` would leave every assertion there passing while putting the
 * spacing back on the conditional element.
 *
 * ── 2. There is one notice treatment, not two ──
 *
 * The whole point of the feature is that the legal notice and the location
 * offer look like the same product. A second component hand-rolling the strip
 * — its own padding, its own border radius, its own `X` — is how that stops
 * being true, and it stops being true gradually, which is why it needs a guard
 * rather than a reviewer.
 */

const SRC = path.join(process.cwd(), 'src');
const CSS_FILE = path.join(SRC, 'components', 'notifications', 'NoticeBanner.css');
const CSS = readFileSync(CSS_FILE, 'utf8');

/** The declarations inside one rule, by selector. */
function ruleBody(selector) {
  const at = CSS.indexOf(`${selector} {`);
  if (at === -1) return null;
  return CSS.slice(at, CSS.indexOf('}', at));
}

describe('the notice slot owns the spacing', () => {
  it('puts a bottom margin on the slot', () => {
    const slot = ruleBody('.app-notices');
    expect(slot, '.app-notices has no rule').toBeTruthy();
    expect(slot).toMatch(/margin-bottom:/);
  });

  it('does not put one on the banner', () => {
    /* If this ever fails, the empty strip is back: a margin on the banner is a
       margin that survives inside any wrapper the banner is removed from. */
    const banner = ruleBody('.app-notice');
    expect(banner, '.app-notice has no rule').toBeTruthy();
    expect(
      banner,
      'spacing belongs to the slot, which is removed entirely when empty — '
      + 'a margin here comes back as a gap above the dashboard'
    ).not.toMatch(/margin-bottom:|margin:/);
  });

  it('spaces two notices from each other with a gap on the slot', () => {
    /* Not with margins on the children, for the same reason: a gap collapses
       to nothing when there is one child, and cannot be left behind. */
    const slot = ruleBody('.app-notices');
    expect(slot).toMatch(/display:\s*flex/);
    expect(slot).toMatch(/gap:/);
  });
});

describe('there is one notice treatment', () => {
  /** Every non-test component under src/. */
  function components() {
    const out = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.jsx$/.test(entry.name) || /\.test\.jsx$/.test(entry.name)) continue;
        out.push(full);
      }
    };
    walk(SRC);
    return out;
  }

  it('is used by both notices rather than copied into either', () => {
    for (const file of [
      path.join(SRC, 'components', 'location', 'LocationPrompt.jsx'),
      path.join(SRC, 'components', 'legal', 'LegalUpdateNotice.jsx'),
    ]) {
      const src = readFileSync(file, 'utf8');
      expect(src, `${path.basename(file)} must render through the shared primitive`)
        .toMatch(/NoticeBanner/);
    }
  });

  it('is the only place the banner markup lives', () => {
    /**
     * `.app-notice` is the shell's strip. Only the primitive may build one; a
     * component that writes the class itself has taken a copy of the treatment
     * and will drift from it.
     *
     * `.app-notices` — the slot — is exempt, because `AppNotices` is what
     * renders the slot.
     */
    const offenders = components()
      .filter(f => !/NoticeBanner\.jsx$/.test(f))
      .filter(f => !/AppNotices\.jsx$/.test(f))
      .filter(f => /className=["'`][^"'`]*\bapp-notice\b/.test(readFileSync(f, 'utf8')))
      .map(f => path.relative(SRC, f));

    expect(
      offenders,
      'render a NoticeBanner instead of rebuilding the strip'
    ).toEqual([]);
  });

  it('leaves no second copy of the rules behind in the location stylesheet', () => {
    /* The declarations moved out of `location/LocationDisplay.css`. A copy left
       there is a second answer to "what does a notice look like". */
    const locationCss = readFileSync(
      path.join(SRC, 'components', 'location', 'LocationDisplay.css'), 'utf8'
    );
    expect(locationCss).not.toMatch(/^\.location-prompt\b/m);
  });
});
