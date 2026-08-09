import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';

/**
 * Guards against a class name that no rule defines.
 *
 * A previous inline-style migration replaced every `style={{…}}` in twelve
 * components with a generated, content-hashed class name — and never emitted the
 * CSS. The markup kept asking for a class; the class did nothing. 78 of them had
 * accumulated by the time this was found, and the failures were silent: elements
 * simply lost their width, gap, colour or padding.
 *
 * One visible consequence was the capacity meter collapsing to 0px wide, which
 * made its two labels render as "0 signed up15 of 15 left". The applicant table's
 * column widths, the calendar's controls, the date-chip remove button and the
 * selection checkboxes were all losing their styling the same way.
 *
 * This test makes that class of regression impossible to land quietly: a
 * generated class with no rule fails the build.
 *
 * It also flags the reverse — a rule kept for a class nothing references any
 * more — so the stylesheet does not silently accumulate dead weight.
 */

const SRC = path.join(process.cwd(), 'src');
const CSS = readFileSync(path.join(SRC, 'index.css'), 'utf8');

/** Every generated class referenced from JS/JSX under src/. */
function referencedGeneratedClasses() {
  const found = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.jsx?$/.test(entry.name)) continue;
      if (/\.test\.jsx?$/.test(entry.name)) continue;
      const src = readFileSync(full, 'utf8');
      for (const m of src.matchAll(/\bs-[0-9a-f]{6}\b/g)) {
        if (!found.has(m[0])) found.set(m[0], new Set());
        found.get(m[0]).add(path.relative(process.cwd(), full));
      }
    }
  };
  walk(SRC);
  return found;
}

/** Every generated class that index.css defines a rule for. */
function definedGeneratedClasses() {
  return new Set([...CSS.matchAll(/\.(s-[0-9a-f]{6})\b/g)].map(m => m[1]));
}

describe('generated class names', () => {
  const referenced = referencedGeneratedClasses();
  const defined = definedGeneratedClasses();

  it('every generated class referenced in JSX has a rule in index.css', () => {
    const dangling = [...referenced]
      .filter(([cls]) => !defined.has(cls))
      .map(([cls, files]) => `${cls} (${[...files].join(', ')})`);
    expect(dangling, 'these class names style nothing').toEqual([]);
  });

  it('every generated rule in index.css is still referenced somewhere', () => {
    const unused = [...defined].filter(cls => !referenced.has(cls));
    expect(unused, 'dead rules — remove them or the reference that was dropped').toEqual([]);
  });

  it('finds the classes at all, so the scan itself cannot silently pass', () => {
    // If the regex or the walk breaks, both assertions above pass vacuously.
    expect(referenced.size).toBeGreaterThan(50);
    expect(defined.size).toBeGreaterThan(50);
  });
});

describe('utility classes used across the app are defined', () => {
  /**
   * The same migration also left `.stack-md` referenced by ten files with no
   * rule anywhere, so those columns rendered with no gap. These are the shared
   * utilities whose absence is invisible in review but obvious on screen.
   */
  const REQUIRED = [
    'stack-xs', 'stack-sm', 'stack-md', 'stack-lg', 'stack',
    'row', 'row-between', 'seats-meter', 'seats-row',
    'modal-overlay', 'modal-overlay-stacked', 'modal', 'modal-head', 'modal-body', 'modal-foot',
    'auth-actions', 'auth-providers', 'field', 'alert', 'alert-danger'
  ];

  for (const cls of REQUIRED) {
    it(`.${cls} has a rule`, () => {
      expect(new RegExp(`\\.${cls}\\s*[,{]`).test(CSS), `.${cls} is referenced but never defined`).toBe(true);
    });
  }
});

describe('class names referenced in JSX that look like utilities exist in CSS', () => {
  /**
   * Catches the `.modal-footer` / `.btn-error` / `.modal-content` class of
   * mistake: markup asking for a class that the stylesheet spells differently.
   * Scoped to the prefixes where a typo means "renders unstyled" rather than
   * "renders slightly differently", so it stays a signal rather than noise.
   *
   * ── `tag` and `status` were added after this guard missed one ──
   *
   * `AdminDashboard.jsx` asked for `tag-error` in two places. The family is
   * spelled `tag-danger`, so the "N waiting" counter and every OPEN badge in the
   * moderation queue rendered as the neutral base `.tag` — grey on grey. The
   * only urgency signal on the only screen where a safety report is triaged was
   * invisible, and had been since it was written.
   *
   * That is exactly the defect in this docstring's first sentence, in a family
   * the regex did not list. Both families carry meaning through colour alone, so
   * a missing rule there is not a cosmetic difference — it is a lost signal.
   */
  const WATCHED = /^(modal|btn|stack|seats|auth|field|alert|tag|status)-[a-z-]+$/;

  /**
   * Marker classes that intentionally have no rule.
   *
   * The three provider buttons carry their brand styling inline, because a
   * provider's palette has to be exact — Google's #ffffff/#8c8c8c, Apple's
   * #000000 — and `noHardcodedColors.test.js` exempts `components/auth/` for
   * precisely that reason. These class names are identification hooks, not style
   * carriers, so they are not the "lost rule" defect this file guards against.
   */
  const INTENTIONAL_MARKERS = new Set(['btn-google', 'btn-microsoft', 'btn-apple']);

  it('no watched-prefix class is referenced without a rule', () => {
    /**
     * Every quoted run in the file, not only the literal head of a `className=`.
     *
     * The previous scanner matched `className=` and then took `[^`"']*`, which
     * stops at the first quote INSIDE a template literal. So in
     *
     *     className={`tag ${status === 'open' ? 'tag-danger' : 'tag-ok'}`}
     *
     * it captured `tag ${status === ` and the two class names in the ternary —
     * the interesting part, and the half that actually varies — were never
     * looked at. That is how the second `tag-error` survived: even once `tag`
     * was a watched prefix, the scanner could not see it.
     *
     * Reading every quoted run instead is both simpler and strictly wider. It
     * can in principle pick up a watched-looking string that is not a class
     * name, but the watched prefixes are specific enough that a bare
     * `'tag-error'` in a `.jsx` file is a class name or a bug either way — and
     * a false positive here fails loudly at build time rather than rendering
     * grey on grey forever.
     */
    const referenced = new Set();
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.jsx$/.test(entry.name) || /\.test\.jsx$/.test(entry.name)) continue;
        const src = readFileSync(full, 'utf8');
        for (const m of src.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`/g)) {
          const blob = (m[1] ?? m[2] ?? m[3] ?? '').replace(/\$\{[^}]*\}/g, ' ');
          for (const token of blob.split(/\s+/)) {
            if (WATCHED.test(token)) referenced.add(token);
          }
        }
      }
    };
    walk(SRC);

    /**
     * Definedness is checked against EVERY stylesheet under src/, not just
     * index.css.
     *
     * Seven components carry their own scoped `.css` file. Checking only
     * index.css reported `status-success` and `status-text` as dangling when
     * both are defined in `components/EventActionPanel.css` — a false positive,
     * and the kind that gets a guard weakened or deleted rather than fixed.
     *
     * This is only about where a rule may LIVE. `noHardcodedColors.test.js`
     * still restricts where a colour may live, and that restriction is
     * unaffected.
     */
    const allCss = (() => {
      let text = '';
      const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.name.endsWith('.css')) text += readFileSync(full, 'utf8');
        }
      };
      walk(SRC);
      return text;
    })();

    const missing = [...referenced]
      .filter(cls => !INTENTIONAL_MARKERS.has(cls))
      .filter(cls => !new RegExp(`\\.${cls}\\s*[,{:.]`).test(allCss))
      .sort();
    expect(missing, 'referenced in JSX but defined in no stylesheet under src/').toEqual([]);
  });
});

/**
 * The same question, asked of EVERY class name rather than only generated ones.
 *
 * ── Why this was added ──
 *
 * The guard above matches `s-[0-9a-f]{6}` — the shape the inline-style migration
 * emitted — so it only ever saw classes from that one incident. Everything
 * hand-written was invisible to it, and 24 dead class names had accumulated
 * behind that blind spot.
 *
 * `AdminRoster.jsx` is how it was found. The whole screen was built on `.view`,
 * `.view-head`, `.title-block`, `.view-title` and `.view-body`, none of which
 * exist in any stylesheet, so the page rendered with no padding, no header
 * rhythm and no spacing between its title, its primary action and its table. It
 * looked like a slightly broken version of the rest of the product, and nothing
 * failed.
 *
 * ── Why there is an allowlist rather than a clean sweep ──
 *
 * The remaining entries are dead too, and each needs its own judgement: some
 * want a rule written, some want the attribute removed, and a few are
 * third-party hooks. Deleting them blind is how a class that WAS load-bearing
 * disappears. So they are listed, visible, and — most importantly — closed: this
 * fails on a twenty-fourth name, so the count can only go down.
 *
 * Removing an entry is the fix. Adding one needs a reason in the diff.
 */
describe('no hand-written class dangles either', () => {
  const KNOWN_DEAD = new Set([
    // Utility names borrowed from other design systems; this product has none.
    'capitalize', 'mx-auto', 'p-4', 'large', 'surface',
    // Colour/state helpers that were never written. `.muted` and `.text-danger`
    // are the real ones; these three read as if they were.
    'text-brand', 'text-ok', 'text-warn',
    // Badge variants with no rules.
    'badge-brand', 'badge-subtle',
    // Provider buttons — they render on `.btn` alone today.
    'btn-apple', 'btn-google', 'btn-microsoft',
    // Component-local names whose rules were never added.
    'action-panel-apply', 'back-btn', 'data-export-modal', 'empty-state',
    'event-detail-hero-main', 'location-card-distance', 'notif-trigger',
    'settings-section', 'settings-section-content', 'tabpanel-content',
  ]);

  it('has no class in JSX that no stylesheet defines', () => {
    let css = '';
    const walkCss = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walkCss(full);
        else if (entry.name.endsWith('.css')) css += readFileSync(full, 'utf8');
      }
    };
    walkCss(SRC);
    const defined = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(m => m[1]));

    const used = new Map();
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.jsx?$/.test(entry.name) || /\.test\.jsx?$/.test(entry.name)) continue;
        const src = readFileSync(full, 'utf8');
        /* Only static string literals. A template literal or a ternary is a
           computed name this cannot resolve, and guessing at one would produce
           the false positives that get a guard deleted. */
        for (const m of src.matchAll(/className=["']([^"'{}]+)["']/g)) {
          for (const cls of m[1].split(/\s+/).filter(Boolean)) {
            if (!used.has(cls)) used.set(cls, new Set());
            used.get(cls).add(path.relative(SRC, full));
          }
        }
      }
    };
    walk(SRC);

    const dangling = [...used.keys()]
      .filter(c => !defined.has(c) && !KNOWN_DEAD.has(c))
      .sort()
      .map(c => `${c} — used in ${[...used.get(c)].slice(0, 2).join(', ')}`);

    expect(
      dangling,
      'these class names style nothing. Write the rule, or drop the attribute — '
      + 'and if it is deliberately unstyled, add it to KNOWN_DEAD with a reason'
    ).toEqual([]);
  });

  /** A ratchet only ratchets if it cannot be loosened by accident. */
  it('does not carry an allowlist entry that has since been fixed', () => {
    let css = '';
    const walkCss = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walkCss(full);
        else if (entry.name.endsWith('.css')) css += readFileSync(full, 'utf8');
      }
    };
    walkCss(SRC);
    const defined = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(m => m[1]));

    const stale = [...KNOWN_DEAD].filter(c => defined.has(c)).sort();
    expect(stale, 'now defined in CSS — remove from KNOWN_DEAD').toEqual([]);
  });
});
